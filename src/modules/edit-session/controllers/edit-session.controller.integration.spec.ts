import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import * as request from 'supertest';
import { EditSessionController } from './edit-session.controller';
import { EditSessionService } from '../services/edit-session.service';
import { SessionResumptionService } from '../services/session-resumption.service';

describe('EditSessionController Integration Tests', () => {
  let app: INestApplication;
  let editSessionService: jest.Mocked<EditSessionService>;
  let sessionResumptionService: jest.Mocked<SessionResumptionService>;

  const mockSession = {
    sessionId: 'test-session-123',
    userId: 'scott',
    clientId: 'ameliastamps',
    threadId: 'thread-abc',
    status: 'active' as const,
    lastActivity: Date.now(),
    ttl: Math.floor(Date.now() / 1000) + 1800,
    editBranch: 'thread-abc',
    createdAt: new Date().toISOString(),
    fargateTaskArn: 'arn:aws:ecs:us-west-2:123:task/test-task',
    containerIp: '10.0.1.100',
    previewUrl: 'https://edit.ameliastamps.webordinary.com/session/test-session-123'
  };

  const mockSessionInfo = {
    sessionId: 'test-session-123',
    containerId: 'test-session-123',
    containerIp: '10.0.1.100',
    status: 'running' as const,
    taskArn: 'arn:aws:ecs:us-west-2:123:task/test-task'
  };

  beforeEach(async () => {
    const mockEditSessionService = {
      createSession: jest.fn(),
      getSession: jest.fn(),
      updateSessionActivity: jest.fn(),
      deactivateSession: jest.fn(),
      getActiveSessions: jest.fn(),
    };

    const mockSessionResumptionService = {
      resumeSessionForPreview: jest.fn(),
      resumeSession: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EditSessionController],
      providers: [
        {
          provide: EditSessionService,
          useValue: mockEditSessionService,
        },
        {
          provide: SessionResumptionService,
          useValue: mockSessionResumptionService,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    editSessionService = module.get(EditSessionService);
    sessionResumptionService = module.get(SessionResumptionService);
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  describe('POST /api/sessions/resume-preview', () => {
    it('should resume session for preview successfully', async () => {
      sessionResumptionService.resumeSessionForPreview.mockResolvedValueOnce(mockSessionInfo);

      const response = await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          chatThreadId: 'thread-abc',
          clientId: 'ameliastamps'
        })
        .expect(HttpStatus.CREATED);

      expect(response.body).toEqual({
        sessionId: mockSessionInfo.sessionId,
        containerId: mockSessionInfo.containerId,
        containerIp: mockSessionInfo.containerIp,
        status: mockSessionInfo.status,
        taskArn: mockSessionInfo.taskArn,
      });

      expect(sessionResumptionService.resumeSessionForPreview).toHaveBeenCalledWith(
        'thread-abc',
        'ameliastamps'
      );
    });

    it('should return 404 for unknown session', async () => {
      sessionResumptionService.resumeSessionForPreview.mockResolvedValueOnce(null);

      const response = await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          chatThreadId: 'unknown-thread',
          clientId: 'ameliastamps'
        })
        .expect(HttpStatus.NOT_FOUND);

      expect(response.body.message).toContain('Session for thread unknown-thread not found');
    });

    it('should return 500 for service errors', async () => {
      sessionResumptionService.resumeSessionForPreview.mockRejectedValueOnce(
        new Error('Container startup failed')
      );

      const response = await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          chatThreadId: 'thread-abc',
          clientId: 'ameliastamps'
        })
        .expect(HttpStatus.INTERNAL_SERVER_ERROR);

      expect(response.body.message).toContain('Failed to resume session: Container startup failed');
    });

    it('should validate request body', async () => {
      await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          // Missing required fields
        })
        .expect(HttpStatus.BAD_REQUEST);

      await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          chatThreadId: 'thread-abc'
          // Missing clientId
        })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('Session Flow Integration', () => {
    it('should handle complete session lifecycle', async () => {
      // 1. Create session
      editSessionService.createSession.mockResolvedValueOnce(mockSession);

      const createResponse = await request(app.getHttpServer())
        .post('/api/sessions/activate')
        .send({
          clientId: 'ameliastamps',
          userId: 'scott',
          instruction: 'Test instruction'
        })
        .expect(HttpStatus.CREATED);

      expect(createResponse.body).toEqual({
        sessionId: mockSession.sessionId,
        previewUrl: mockSession.previewUrl,
        status: mockSession.status,
      });

      // 2. Get session status
      editSessionService.getSession.mockResolvedValueOnce(mockSession);

      const statusResponse = await request(app.getHttpServer())
        .get(`/api/sessions/${mockSession.sessionId}/status`)
        .expect(HttpStatus.OK);

      expect(statusResponse.body).toEqual({
        status: mockSession.status,
        containerIp: mockSession.containerIp,
        lastActivity: new Date(mockSession.lastActivity).toISOString(),
        previewUrl: mockSession.previewUrl,
      });

      // 3. Resume for preview
      sessionResumptionService.resumeSessionForPreview.mockResolvedValueOnce(mockSessionInfo);

      const resumeResponse = await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          chatThreadId: mockSession.threadId,
          clientId: mockSession.clientId
        })
        .expect(HttpStatus.CREATED);

      expect(resumeResponse.body.status).toBe('running');

      // 4. Keep alive
      editSessionService.updateSessionActivity.mockResolvedValueOnce();
      editSessionService.getSession.mockResolvedValueOnce({
        ...mockSession,
        lastActivity: Date.now()
      });

      await request(app.getHttpServer())
        .post(`/api/sessions/${mockSession.sessionId}/keepalive`)
        .expect(HttpStatus.CREATED);

      // 5. Deactivate
      editSessionService.deactivateSession.mockResolvedValueOnce();

      const deactivateResponse = await request(app.getHttpServer())
        .post(`/api/sessions/${mockSession.sessionId}/deactivate`)
        .expect(HttpStatus.CREATED);

      expect(deactivateResponse.body).toEqual({
        status: 'draining',
        message: 'Session deactivation initiated',
      });
    });
  });

  describe('Error Scenarios', () => {
    it('should handle DynamoDB connection errors', async () => {
      sessionResumptionService.resumeSessionForPreview.mockRejectedValueOnce(
        new Error('Unable to connect to DynamoDB')
      );

      await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          chatThreadId: 'thread-abc',
          clientId: 'ameliastamps'
        })
        .expect(HttpStatus.INTERNAL_SERVER_ERROR);
    });

    it('should handle ECS service unavailable', async () => {
      sessionResumptionService.resumeSessionForPreview.mockRejectedValueOnce(
        new Error('ECS cluster not available')
      );

      await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          chatThreadId: 'thread-abc',
          clientId: 'ameliastamps'
        })
        .expect(HttpStatus.INTERNAL_SERVER_ERROR);
    });

    it('should handle container startup timeout', async () => {
      sessionResumptionService.resumeSessionForPreview.mockRejectedValueOnce(
        new Error('Container failed to start within timeout')
      );

      const response = await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          chatThreadId: 'thread-abc',
          clientId: 'ameliastamps'
        })
        .expect(HttpStatus.INTERNAL_SERVER_ERROR);

      expect(response.body.message).toContain('timeout');
    });
  });

  describe('Performance Tests', () => {
    it('should handle concurrent resume requests', async () => {
      sessionResumptionService.resumeSessionForPreview.mockResolvedValue(mockSessionInfo);

      const requests = Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post('/api/sessions/resume-preview')
          .send({
            chatThreadId: 'thread-abc',
            clientId: 'ameliastamps'
          })
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(HttpStatus.CREATED);
        expect(response.body.status).toBe('running');
      });

      // Should handle concurrent requests gracefully
      expect(sessionResumptionService.resumeSessionForPreview).toHaveBeenCalledTimes(5);
    });

    it('should respond within acceptable time limits', async () => {
      sessionResumptionService.resumeSessionForPreview.mockImplementation(
        () => new Promise(resolve => 
          setTimeout(() => resolve(mockSessionInfo), 100)
        )
      );

      const startTime = Date.now();

      await request(app.getHttpServer())
        .post('/api/sessions/resume-preview')
        .send({
          chatThreadId: 'thread-abc',
          clientId: 'ameliastamps'
        })
        .expect(HttpStatus.CREATED);

      const responseTime = Date.now() - startTime;
      
      // Should respond quickly for running containers
      expect(responseTime).toBeLessThan(500);
    });
  });
});