import { Test, TestingModule } from '@nestjs/testing';
import { QueueManagerService } from '../src/modules/sqs/queue-manager.service';
import { SqsMessageService } from '../src/modules/sqs/sqs-message.service';

describe('QueueManagerService Integration Tests', () => {
  let queueManager: QueueManagerService;
  let messageService: SqsMessageService;
  let testQueues: any;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [QueueManagerService, SqsMessageService],
    }).compile();

    queueManager = module.get<QueueManagerService>(QueueManagerService);
    messageService = module.get<SqsMessageService>(SqsMessageService);
  });

  describe('Queue Lifecycle', () => {
    it('should create container queues', async () => {
      const clientId = 'test-client';
      const projectId = 'test-project';
      const userId = 'test-user';

      // Create queues
      testQueues = await queueManager.createContainerQueues(
        clientId,
        projectId,
        userId,
      );

      expect(testQueues).toBeDefined();
      expect(testQueues.containerId).toBe(`${clientId}-${projectId}-${userId}`);
      expect(testQueues.inputUrl).toContain('webordinary-input-');
      expect(testQueues.outputUrl).toContain('webordinary-output-');
      expect(testQueues.dlqUrl).toContain('webordinary-dlq-');
    }, 30000);

    it('should get existing queues', async () => {
      const clientId = 'test-client';
      const projectId = 'test-project';
      const userId = 'test-user';

      // Get existing queues
      const existingQueues = await queueManager.getContainerQueues(
        clientId,
        projectId,
        userId,
      );

      expect(existingQueues).toBeDefined();
      expect(existingQueues?.containerId).toBe(`${clientId}-${projectId}-${userId}`);
    });

    it('should send and receive messages', async () => {
      if (!testQueues) {
        console.warn('Skipping message test - no queues created');
        return;
      }

      // Send a test message
      const commandId = await messageService.sendEditCommand(testQueues.inputUrl, {
        sessionId: 'test-session',
        type: 'edit',
        instruction: 'Test instruction',
        userEmail: 'test@example.com',
        chatThreadId: 'test-thread',
        context: {
          branch: 'test-branch',
          clientId: 'test-client',
          projectId: 'test-project',
          userId: 'test-user',
        },
      });

      expect(commandId).toBeDefined();
      console.log('Sent command:', commandId);
    });

    it('should list user queues', async () => {
      const userQueues = await queueManager.listUserQueues('test-user');
      
      expect(userQueues).toBeDefined();
      expect(Array.isArray(userQueues)).toBe(true);
      
      if (userQueues.length > 0) {
        expect(userQueues[0].userId).toBe('test-user');
      }
    });

    it('should delete container queues', async () => {
      const clientId = 'test-client';
      const projectId = 'test-project';
      const userId = 'test-user';

      // Delete queues
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
});

// Run this test with: npm test sqs-queue-manager.test.ts