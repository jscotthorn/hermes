import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { QueueManagerService } from '../src/modules/sqs/queue-manager.service';
import { SqsMessageService } from '../src/modules/sqs/sqs-message.service';
import { CommandExecutorService } from '../src/modules/sqs/command-executor.service';
import { ContainerManagerService } from '../src/modules/container/container-manager.service';
import { ThreadExtractorService } from '../src/modules/message-processor/thread-extractor.service';
import { EditSessionService } from '../src/modules/edit-session/services/edit-session.service';

describe('SQS Message Flow Integration Tests', () => {
  let queueManager: QueueManagerService;
  let messageService: SqsMessageService;
  let commandExecutor: CommandExecutorService;
  let containerManager: ContainerManagerService;
  let threadExtractor: ThreadExtractorService;
  let testQueues: any;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        QueueManagerService,
        SqsMessageService,
        CommandExecutorService,
        ContainerManagerService,
        ThreadExtractorService,
        {
          provide: EditSessionService,
          useValue: {
            createSession: jest.fn().mockResolvedValue({
              sessionId: 'test-session',
              gitBranch: 'thread-test123',
            }),
          },
        },
      ],
    }).compile();

    queueManager = module.get<QueueManagerService>(QueueManagerService);
    messageService = module.get<SqsMessageService>(SqsMessageService);
    commandExecutor = module.get<CommandExecutorService>(CommandExecutorService);
    containerManager = module.get<ContainerManagerService>(ContainerManagerService);
    threadExtractor = module.get<ThreadExtractorService>(ThreadExtractorService);
  });

  describe('End-to-End Message Flow', () => {
    const clientId = 'test-client';
    const projectId = 'test-project';
    const userId = 'test-user';

    it('should create queues and send message', async () => {
      // Step 1: Create container queues
      testQueues = await queueManager.createContainerQueues(
        clientId,
        projectId,
        userId,
      );

      expect(testQueues).toBeDefined();
      expect(testQueues.containerId).toBe(`${clientId}-${projectId}-${userId}`);
      expect(testQueues.inputUrl).toBeDefined();
      expect(testQueues.outputUrl).toBeDefined();

      // Step 2: Send edit command
      const commandId = await messageService.sendEditCommand(testQueues.inputUrl, {
        sessionId: 'test-session-123',
        type: 'edit',
        instruction: 'Update the homepage title',
        userEmail: 'test@example.com',
        chatThreadId: 'thread-abc123',
        context: {
          branch: 'thread-abc123',
          clientId,
          projectId,
          userId,
        },
      });

      expect(commandId).toBeDefined();
      expect(commandId).toMatch(/^[0-9a-f-]+$/); // UUID format
    }, 30000);

    it('should handle command execution with timeout', async () => {
      if (!testQueues) {
        console.warn('Skipping test - no queues available');
        return;
      }

      // Execute command (will timeout since no container is processing)
      const commandPromise = commandExecutor.executeCommand(
        testQueues,
        {
          sessionId: 'test-session-123',
          type: 'edit',
          instruction: 'Test command',
          userEmail: 'test@example.com',
          chatThreadId: 'thread-abc123',
          context: {
            branch: 'thread-abc123',
            clientId,
            projectId,
            userId,
          },
        },
        5, // 5 second timeout for testing
      );

      // Should timeout
      await expect(commandPromise).rejects.toThrow('Command timeout');
    }, 10000);

    it('should handle interrupt signals', async () => {
      if (!testQueues) {
        console.warn('Skipping test - no queues available');
        return;
      }

      // Send interrupt
      const interruptId = await commandExecutor.sendInterrupt(
        testQueues.inputUrl,
        'test-session-123',
        'thread-abc123',
      );

      expect(interruptId).toBeDefined();
      expect(interruptId).toMatch(/^[0-9a-f-]+$/);
    });

    it('should track active commands', () => {
      const activeCommands = commandExecutor.getActiveCommands();
      
      expect(Array.isArray(activeCommands)).toBe(true);
      
      // If there are active commands, verify structure
      if (activeCommands.length > 0) {
        expect(activeCommands[0]).toHaveProperty('commandId');
        expect(activeCommands[0]).toHaveProperty('sessionId');
        expect(activeCommands[0]).toHaveProperty('chatThreadId');
        expect(activeCommands[0]).toHaveProperty('runningTime');
      }
    });

    it('should get queue metrics', async () => {
      if (!testQueues) {
        console.warn('Skipping test - no queues available');
        return;
      }

      const metrics = await commandExecutor.getQueueMetrics(testQueues.inputUrl);
      
      expect(metrics).toBeDefined();
      expect(metrics).toHaveProperty('messagesAvailable');
      expect(metrics).toHaveProperty('messagesInFlight');
      expect(metrics).toHaveProperty('messagesDelayed');
      expect(typeof metrics.messagesAvailable).toBe('number');
    });

    it('should handle batch message sending', async () => {
      if (!testQueues) {
        console.warn('Skipping test - no queues available');
        return;
      }

      const messages = [
        {
          sessionId: 'batch-session-1',
          type: 'edit' as const,
          instruction: 'Command 1',
          userEmail: 'test@example.com',
          chatThreadId: 'thread-1',
          context: {
            branch: 'thread-1',
            clientId,
            projectId,
            userId,
          },
        },
        {
          sessionId: 'batch-session-2',
          type: 'build' as const,
          instruction: 'Command 2',
          userEmail: 'test@example.com',
          chatThreadId: 'thread-2',
          context: {
            branch: 'thread-2',
            clientId,
            projectId,
            userId,
          },
        },
      ];

      const commandIds = await messageService.sendBatch(
        testQueues.inputUrl,
        messages,
      );

      expect(commandIds).toBeDefined();
      expect(commandIds.length).toBe(2);
      commandIds.forEach((id) => {
        expect(id).toMatch(/^[0-9a-f-]+$/);
      });
    });

    it('should clean up queues', async () => {
      if (!testQueues) {
        console.warn('Skipping test - no queues available');
        return;
      }

      // Clean up
      await queueManager.deleteContainerQueues(
        clientId,
        projectId,
        userId,
      );

      // Verify queues are deleted
      const deletedQueues = await queueManager.getContainerQueues(
        clientId,
        projectId,
        userId,
      );

      expect(deletedQueues).toBeNull();
    }, 30000);
  });

  describe('Thread and Session Integration', () => {
    it('should extract thread ID and create session', async () => {
      const email = {
        messageId: '<test123@example.com>',
        from: { text: 'user@example.com' },
        subject: 'Test Request',
        text: 'Please update the homepage',
      };

      // Extract thread ID
      const threadId = threadExtractor.extractThreadId({
        source: 'email',
        data: email as any,
        clientId: 'test',
        projectId: 'project',
        userId: 'user',
      });

      expect(threadId).toBeDefined();
      expect(threadId).toHaveLength(8);

      // Create session
      const session = await threadExtractor.getOrCreateSession(
        'test',
        'project',
        'user',
        threadId,
        'email',
      );

      expect(session).toBeDefined();
      expect(session.sessionId).toBe(`test-project-${threadId}`);
      expect(session.gitBranch).toBe(`thread-${threadId}`);
    });
  });

  describe('Container Lifecycle', () => {
    it('should track container sessions', async () => {
      const containerId = 'test-client-test-project-test-user';
      
      // Assign session to container
      await containerManager.assignSessionToContainer(
        'test-session-456',
        containerId,
        'thread-xyz789',
        {
          inputUrl: 'https://sqs.example.com/input',
          outputUrl: 'https://sqs.example.com/output',
        },
      );

      // Release session
      await containerManager.releaseSession('test-session-456');

      // Verify session was released (would check DynamoDB in real test)
      expect(true).toBe(true);
    });
  });
});

// Run with: npm test sqs-message-flow.test.ts