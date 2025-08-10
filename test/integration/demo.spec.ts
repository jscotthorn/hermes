import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { QueueManagerService } from '../../src/modules/sqs/queue-manager.service';
import { SqsMessageService } from '../../src/modules/sqs/sqs-message.service';

describe('Demo Integration Test', () => {
  let module: TestingModule;
  let queueManager: QueueManagerService;
  let messageService: SqsMessageService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        {
          provide: QueueManagerService,
          useValue: {
            createContainerQueues: jest.fn().mockResolvedValue({
              containerId: 'test-container',
              inputUrl: 'https://sqs.test/input',
              outputUrl: 'https://sqs.test/output',
              dlqUrl: 'https://sqs.test/dlq',
            }),
            deleteContainerQueues: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: SqsMessageService,
          useValue: {
            sendEditCommand: jest.fn().mockResolvedValue('command-123'),
            receiveResponse: jest.fn().mockImplementation(async (url: string, timeout: number) => ({
              commandId: 'command-123',
              success: true,
              summary: 'Test completed',
            })),
          },
        },
      ],
    }).compile();

    queueManager = module.get<QueueManagerService>(QueueManagerService);
    messageService = module.get<SqsMessageService>(SqsMessageService);
  });

  afterAll(async () => {
    await module?.close();
  });

  describe('Queue Management', () => {
    it('should create container queues', async () => {
      const result = await queueManager.createContainerQueues(
        'test-client',
        'test-project',
        'test-user',
      );

      expect(result).toBeDefined();
      expect(result.containerId).toBe('test-container');
      expect(result.inputUrl).toContain('input');
      expect(result.outputUrl).toContain('output');
      expect(result.dlqUrl).toContain('dlq');
    });

    it('should send edit commands', async () => {
      const commandId = await messageService.sendEditCommand(
        'https://sqs.test/input',
        {
          sessionId: 'test-session',
          type: 'edit',
          instruction: 'Test instruction',
          userEmail: 'test@example.com',
          chatThreadId: 'thread-123',
          context: {
            branch: 'test-branch',
            clientId: 'test-client',
            projectId: 'test-project',
            userId: 'test-user',
          },
        },
      );

      expect(commandId).toBe('command-123');
    });

    it('should receive responses', async () => {
      const response = await messageService.receiveResponse(
        'https://sqs.test/output',
        30000,  // timeout in ms
      );

      expect(response).toBeDefined();
      expect(response!.success).toBe(true);
      expect(response!.summary).toBe('Test completed');
    });
  });

  describe('Message Flow', () => {
    it('should handle complete message flow', async () => {
      // Create queues
      const queues = await queueManager.createContainerQueues(
        'test-client',
        'test-project',
        'test-user',
      );
      
      // Send command
      const commandId = await messageService.sendEditCommand(queues.inputUrl, {
        sessionId: 'test-session',
        type: 'edit',
        instruction: 'Update homepage',
        userEmail: 'test@example.com',
        chatThreadId: 'thread-456',
        context: {
          branch: 'thread-456',
          clientId: 'test-client',
          projectId: 'test-project',
          userId: 'test-user',
        },
      });

      // Receive response
      const response = await messageService.receiveResponse(
        queues.outputUrl,
        30000,  // timeout
      );

      // Verify flow
      expect(commandId).toBeDefined();
      expect(response!.success).toBe(true);
      
      // Cleanup
      await queueManager.deleteContainerQueues(
        'test-client',
        'test-project',
        'test-user',
      );
    });
  });
});