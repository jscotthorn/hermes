import { Test, TestingModule } from '@nestjs/testing';
import { ThreadExtractorService } from '../src/modules/message-processor/thread-extractor.service';
import { EditSessionService } from '../src/modules/edit-session/services/edit-session.service';

describe('ThreadExtractorService', () => {
  let service: ThreadExtractorService;
  let mockEditSessionService: Partial<EditSessionService>;

  beforeEach(async () => {
    mockEditSessionService = {
      createSession: jest.fn().mockResolvedValue({
        sessionId: 'test-session',
        clientId: 'test-client',
        projectId: 'test-project',
        userId: 'test-user',
        gitBranch: 'thread-abc123',
        source: 'email',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadExtractorService,
        {
          provide: EditSessionService,
          useValue: mockEditSessionService,
        },
      ],
    }).compile();

    service = module.get<ThreadExtractorService>(ThreadExtractorService);
  });

  describe('Email Thread ID Extraction', () => {
    it('should extract thread ID from References header', () => {
      const email = {
        messageId: '<current@example.com>',
        inReplyTo: '<previous@example.com>',
        references: ['<original@example.com>', '<previous@example.com>'],
        from: { text: 'user@example.com' },
        subject: 'Re: Test Thread',
      };

      const threadId = service.extractThreadId({
        source: 'email',
        data: email as any,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      // Should use first reference (original message)
      expect(threadId).toBeDefined();
      expect(threadId).toHaveLength(8); // Short hash
      
      // Same original reference should produce same thread ID
      const threadId2 = service.extractThreadId({
        source: 'email',
        data: {
          ...email,
          messageId: '<another@example.com>',
          references: ['<original@example.com>', '<another@example.com>'],
        } as any,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      expect(threadId2).toBe(threadId);
    });

    it('should extract thread ID from In-Reply-To when no References', () => {
      const email = {
        messageId: '<current@example.com>',
        inReplyTo: '<previous@example.com>',
        from: { text: 'user@example.com' },
        subject: 'Re: Test Thread',
      };

      const threadId = service.extractThreadId({
        source: 'email',
        data: email as any,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      expect(threadId).toBeDefined();
      expect(threadId).toHaveLength(8);
    });

    it('should use Message-ID for new threads', () => {
      const email = {
        messageId: '<new-thread@example.com>',
        from: { text: 'user@example.com' },
        subject: 'New Request',
      };

      const threadId = service.extractThreadId({
        source: 'email',
        data: email as any,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      expect(threadId).toBeDefined();
      expect(threadId).toHaveLength(8);
    });

    it('should handle angle brackets in Message-IDs', () => {
      const email1 = {
        messageId: '<test@example.com>',
      };
      const email2 = {
        messageId: 'test@example.com',
      };

      const threadId1 = service.extractThreadId({
        source: 'email',
        data: email1 as any,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      const threadId2 = service.extractThreadId({
        source: 'email',
        data: email2 as any,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      expect(threadId1).toBe(threadId2);
    });
  });

  describe('SMS Thread ID Extraction', () => {
    it('should use conversation ID when available', () => {
      const sms = {
        from: '+1234567890',
        to: '+0987654321',
        body: 'Test message',
        messageId: 'sms-123',
        conversationId: 'conv-456',
      };

      const threadId = service.extractThreadId({
        source: 'sms',
        data: sms,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      expect(threadId).toBeDefined();
      expect(threadId).toHaveLength(8);
    });

    it('should create consistent thread ID from phone numbers', () => {
      const sms1 = {
        from: '+1234567890',
        to: '+0987654321',
        body: 'Message 1',
        messageId: 'sms-123',
      };

      const sms2 = {
        from: '+0987654321', // Reversed
        to: '+1234567890',
        body: 'Message 2',
        messageId: 'sms-456',
      };

      const threadId1 = service.extractThreadId({
        source: 'sms',
        data: sms1,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      const threadId2 = service.extractThreadId({
        source: 'sms',
        data: sms2,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      // Should produce same thread ID regardless of direction
      expect(threadId1).toBe(threadId2);
    });
  });

  describe('Chat Thread ID Extraction', () => {
    it('should use explicit thread ID from chat', () => {
      const chat = {
        messageId: 'msg-123',
        threadId: 'thread-456',
        userId: 'user-789',
        content: 'Test message',
      };

      const threadId = service.extractThreadId({
        source: 'chat',
        data: chat,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      expect(threadId).toBeDefined();
      expect(threadId).toHaveLength(8);
    });

    it('should fallback to message ID when no thread ID', () => {
      const chat = {
        messageId: 'msg-123',
        userId: 'user-789',
        content: 'Test message',
      };

      const threadId = service.extractThreadId({
        source: 'chat',
        data: chat,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      expect(threadId).toBeDefined();
      expect(threadId).toHaveLength(8);
    });
  });

  describe('Cross-Channel Thread Continuity', () => {
    it('should maintain session across different sources', async () => {
      const clientId = 'test-client';
      const projectId = 'test-project';
      const userId = 'test-user';
      const threadId = 'abc12345';

      // First message via email
      const session1 = await service.getOrCreateSession(
        clientId,
        projectId,
        userId,
        threadId,
        'email',
      );

      expect(session1.sessionId).toBe(`${clientId}-${projectId}-${threadId}`);
      expect(session1.gitBranch).toBe(`thread-${threadId}`);
      expect(session1.source).toBe('email');

      // Second message via SMS (same thread)
      const session2 = await service.getOrCreateSession(
        clientId,
        projectId,
        userId,
        threadId,
        'sms',
      );

      // Should get same session but with updated source
      expect(session2.sessionId).toBe(session1.sessionId);
      expect(session2.gitBranch).toBe(session1.gitBranch);
    });
  });

  describe('Thread ID Consistency', () => {
    it('should generate consistent thread IDs', () => {
      const testCases = [
        {
          messageId: '<CAHXm1BCPaciB+4+NqL5aCK1234567890@mail.gmail.com>',
          expected: 8,
        },
        {
          messageId: 'DB6PR10MB2461234567890@DB6PR10MB246.EURPRD10.PROD.OUTLOOK.COM',
          expected: 8,
        },
        {
          messageId: '123456789.1234567890.JavaMail.user@example',
          expected: 8,
        },
      ];

      testCases.forEach(({ messageId }) => {
        const email = { messageId };
        
        const threadId = service.extractThreadId({
          source: 'email',
          data: email as any,
          clientId: 'test',
          projectId: 'project',
          userId: 'user',
        });

        expect(threadId).toHaveLength(8);
        expect(threadId).toMatch(/^[a-zA-Z0-9_-]+$/); // URL-safe characters
      });
    });

    it('should handle missing headers gracefully', () => {
      const email = {
        from: { text: 'user@example.com' },
        subject: 'Test',
      };

      const threadId = service.extractThreadId({
        source: 'email',
        data: email as any,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      expect(threadId).toBeDefined();
      expect(threadId).toMatch(/^[a-z0-9]+$/); // Generated ID format
    });
  });
});

// Run tests with: npm test thread-extractor.test.ts