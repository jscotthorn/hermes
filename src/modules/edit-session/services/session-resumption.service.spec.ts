import { Test, TestingModule } from '@nestjs/testing';
import { SessionResumptionService, SessionInfo, ContainerInfo, IncomingMessage } from './session-resumption.service';
import { FargateManagerService } from './fargate-manager.service';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECSClient } from '@aws-sdk/client-ecs';
import { SQSClient } from '@aws-sdk/client-sqs';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/client-ecs');
jest.mock('@aws-sdk/client-sqs');

describe('SessionResumptionService Integration Tests', () => {
  let service: SessionResumptionService;
  let fargateManager: jest.Mocked<FargateManagerService>;
  let dynamoClient: jest.Mocked<DynamoDBClient>;
  let ecsClient: jest.Mocked<ECSClient>;
  let sqsClient: jest.Mocked<SQSClient>;

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

  const mockContainerRunning: ContainerInfo = {
    containerId: 'test-session-123',
    containerIp: '10.0.1.100',
    status: 'running',
    taskArn: 'arn:aws:ecs:us-west-2:123:task/test-task',
    lastActivity: Date.now(),
    managementQueueUrl: 'https://sqs.us-west-2.amazonaws.com/123/test-queue'
  };

  const mockContainerStopped: ContainerInfo = {
    containerId: 'test-session-123',
    containerIp: undefined,
    status: 'stopped',
    taskArn: undefined,
    lastActivity: Date.now() - 30 * 60 * 1000, // 30 minutes ago
  };

  const mockMessage: IncomingMessage = {
    threadId: 'thread-abc',
    clientId: 'ameliastamps',
    userId: 'scott',
    instruction: 'Test instruction',
    messageId: 'msg-123'
  };

  beforeEach(async () => {
    const mockFargateManager = {
      startTask: jest.fn(),
      stopTask: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionResumptionService,
        {
          provide: FargateManagerService,
          useValue: mockFargateManager,
        },
      ],
    }).compile();

    service = module.get<SessionResumptionService>(SessionResumptionService);
    fargateManager = module.get(FargateManagerService);
    
    // Get mocked clients from service
    dynamoClient = (service as any).dynamoClient;
    ecsClient = (service as any).ecsClient;
    sqsClient = (service as any).sqsClient;

    // Setup default mocks
    dynamoClient.send = jest.fn();
    ecsClient.send = jest.fn();
    sqsClient.send = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('resumeSession', () => {
    it('should return existing running container without changes', async () => {
      // Mock session lookup
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          sessionId: { S: mockSession.sessionId },
          userId: { S: mockSession.userId },
          clientId: { S: mockSession.clientId },
          threadId: { S: mockSession.threadId },
          status: { S: mockSession.status },
          lastActivity: { N: mockSession.lastActivity.toString() },
          ttl: { N: mockSession.ttl.toString() },
          editBranch: { S: mockSession.editBranch },
          createdAt: { S: mockSession.createdAt },
          fargateTaskArn: { S: mockSession.fargateTaskArn },
          containerIp: { S: mockSession.containerIp },
          previewUrl: { S: mockSession.previewUrl }
        }
      }));

      // Mock container lookup - running container
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          containerId: { S: mockContainerRunning.containerId },
          containerIp: { S: mockContainerRunning.containerIp },
          status: { S: mockContainerRunning.status },
          taskArn: { S: mockContainerRunning.taskArn },
          lastActivity: { N: mockContainerRunning.lastActivity.toString() },
          managementQueueUrl: { S: mockContainerRunning.managementQueueUrl }
        }
      }));

      // Mock activity update
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({}));

      const result = await service.resumeSession(mockSession.sessionId, mockMessage);

      expect(result).toEqual({
        sessionId: mockSession.sessionId,
        containerId: mockSession.sessionId,
        containerIp: mockContainerRunning.containerIp,
        status: 'running',
        taskArn: mockContainerRunning.taskArn,
      });

      // Should update container activity
      expect(dynamoClient.send).toHaveBeenCalledTimes(3);
      expect(fargateManager.startTask).not.toHaveBeenCalled();
    });

    it('should wake idle container', async () => {
      const mockContainerIdle: ContainerInfo = {
        ...mockContainerRunning,
        status: 'idle'
      };

      // Mock session lookup
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          sessionId: { S: mockSession.sessionId },
          userId: { S: mockSession.userId },
          clientId: { S: mockSession.clientId },
          threadId: { S: mockSession.threadId },
          status: { S: mockSession.status },
          lastActivity: { N: mockSession.lastActivity.toString() },
          ttl: { N: mockSession.ttl.toString() },
          editBranch: { S: mockSession.editBranch },
          createdAt: { S: mockSession.createdAt }
        }
      }));

      // Mock container lookup - idle container
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          containerId: { S: mockContainerIdle.containerId },
          containerIp: { S: mockContainerIdle.containerIp },
          status: { S: 'idle' },
          taskArn: { S: mockContainerIdle.taskArn },
          lastActivity: { N: mockContainerIdle.lastActivity.toString() },
          managementQueueUrl: { S: mockContainerIdle.managementQueueUrl }
        }
      }));

      // Mock SQS wake message
      (sqsClient.send as jest.Mock).mockImplementationOnce(() => ({}));

      // Mock container status update
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({}));

      const result = await service.resumeSession(mockSession.sessionId, mockMessage);

      expect(result.status).toBe('running');
      expect(sqsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            QueueUrl: mockContainerIdle.managementQueueUrl,
            MessageBody: expect.stringContaining('"type":"wake"')
          })
        })
      );

      // Should send wake message and update status
      expect(dynamoClient.send).toHaveBeenCalledTimes(3);
    });

    it('should start stopped container', async () => {
      // Mock session lookup
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          sessionId: { S: mockSession.sessionId },
          userId: { S: mockSession.userId },
          clientId: { S: mockSession.clientId },
          threadId: { S: mockSession.threadId },
          status: { S: mockSession.status },
          lastActivity: { N: mockSession.lastActivity.toString() },
          ttl: { N: mockSession.ttl.toString() },
          editBranch: { S: mockSession.editBranch },
          createdAt: { S: mockSession.createdAt }
        }
      }));

      // Mock container lookup - stopped container
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          containerId: { S: mockContainerStopped.containerId },
          status: { S: 'stopped' },
          lastActivity: { N: mockContainerStopped.lastActivity.toString() }
        }
      }));

      // Mock container status update to 'starting'
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({}));

      // Mock fargate start task
      fargateManager.startTask.mockResolvedValueOnce({
        taskArn: 'arn:aws:ecs:us-west-2:123:task/new-task',
        containerIp: '10.0.1.101'
      });

      // Mock ECS task health check
      (ecsClient.send as jest.Mock).mockImplementation(() => ({
        tasks: [{
          taskArn: 'arn:aws:ecs:us-west-2:123:task/new-task',
          lastStatus: 'RUNNING',
          healthStatus: 'HEALTHY'
        }]
      }));

      // Mock container info update
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({}));

      const result = await service.resumeSession(mockSession.sessionId, mockMessage);

      expect(result.status).toBe('running');
      expect(result.containerIp).toBe('10.0.1.101');
      expect(fargateManager.startTask).toHaveBeenCalledWith({
        sessionId: mockSession.sessionId,
        clientId: mockSession.clientId,
        userId: mockSession.userId,
        threadId: mockSession.threadId,
      });

      // Should update status to starting, then to running
      expect(dynamoClient.send).toHaveBeenCalledTimes(4);
    });

    it('should handle session not found', async () => {
      // Mock session lookup - not found
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({ Item: undefined }));

      await expect(
        service.resumeSession('nonexistent-session', mockMessage)
      ).rejects.toThrow('Session nonexistent-session not found');
    });

    it('should handle container startup timeout', async () => {
      // Mock session lookup
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          sessionId: { S: mockSession.sessionId },
          userId: { S: mockSession.userId },
          clientId: { S: mockSession.clientId },
          threadId: { S: mockSession.threadId },
          status: { S: mockSession.status },
          lastActivity: { N: mockSession.lastActivity.toString() },
          ttl: { N: mockSession.ttl.toString() },
          editBranch: { S: mockSession.editBranch },
          createdAt: { S: mockSession.createdAt }
        }
      }));

      // Mock container lookup - stopped
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({ Item: undefined }));

      // Mock container status update to 'starting'
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({}));

      // Mock fargate start task
      fargateManager.startTask.mockResolvedValueOnce({
        taskArn: 'arn:aws:ecs:us-west-2:123:task/slow-task',
        containerIp: '10.0.1.102'
      });

      // Mock ECS task health check - never becomes healthy
      (ecsClient.send as jest.Mock).mockImplementation(() => ({
        tasks: [{
          taskArn: 'arn:aws:ecs:us-west-2:123:task/slow-task',
          lastStatus: 'PENDING',
          healthStatus: 'UNHEALTHY'
        }]
      }));

      // Should timeout after 120 seconds (mocked)
      await expect(
        service.resumeSession(mockSession.sessionId, mockMessage)
      ).rejects.toThrow(/failed to become healthy within/);
    });
  });

  describe('resumeSessionForPreview', () => {
    it('should resume session for preview URL', async () => {
      // Mock thread mapping lookup
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Items: [{
          threadId: { S: 'thread-abc' },
          sessionId: { S: 'test-session-123' }
        }]
      }));

      // Mock session lookup
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          sessionId: { S: mockSession.sessionId },
          userId: { S: mockSession.userId },
          clientId: { S: mockSession.clientId },
          threadId: { S: mockSession.threadId },
          status: { S: mockSession.status },
          lastActivity: { N: mockSession.lastActivity.toString() },
          ttl: { N: mockSession.ttl.toString() },
          editBranch: { S: mockSession.editBranch },
          createdAt: { S: mockSession.createdAt }
        }
      }));

      // Mock container lookup - running
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          containerId: { S: mockContainerRunning.containerId },
          containerIp: { S: mockContainerRunning.containerIp },
          status: { S: mockContainerRunning.status },
          taskArn: { S: mockContainerRunning.taskArn },
          lastActivity: { N: mockContainerRunning.lastActivity.toString() }
        }
      }));

      // Mock activity update
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({}));

      const result = await service.resumeSessionForPreview('thread-abc', 'ameliastamps');

      expect(result).toEqual({
        sessionId: mockSession.sessionId,
        containerId: mockSession.sessionId,
        containerIp: mockContainerRunning.containerIp,
        status: 'running',
        taskArn: mockContainerRunning.taskArn,
      });
    });

    it('should return null for unknown thread', async () => {
      // Mock thread mapping lookup - not found
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({ Items: [] }));

      const result = await service.resumeSessionForPreview('unknown-thread', 'ameliastamps');

      expect(result).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      (dynamoClient.send as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB unavailable'));

      await expect(
        service.resumeSession(mockSession.sessionId, mockMessage)
      ).rejects.toThrow('DynamoDB unavailable');
    });

    it('should handle Fargate startup errors', async () => {
      // Mock successful session and container lookup
      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({
        Item: {
          sessionId: { S: mockSession.sessionId },
          userId: { S: mockSession.userId },
          clientId: { S: mockSession.clientId },
          threadId: { S: mockSession.threadId },
          status: { S: mockSession.status },
          lastActivity: { N: mockSession.lastActivity.toString() },
          ttl: { N: mockSession.ttl.toString() },
          editBranch: { S: mockSession.editBranch },
          createdAt: { S: mockSession.createdAt }
        }
      }));

      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({ Item: undefined })); // No container

      (dynamoClient.send as jest.Mock).mockImplementationOnce(() => ({})); // Status update

      // Mock fargate start task failure
      fargateManager.startTask.mockRejectedValueOnce(new Error('ECS cluster unavailable'));

      await expect(
        service.resumeSession(mockSession.sessionId, mockMessage)
      ).rejects.toThrow('ECS cluster unavailable');
    });
  });
});