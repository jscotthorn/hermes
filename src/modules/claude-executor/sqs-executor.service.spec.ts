import { Test, TestingModule } from '@nestjs/testing';
import { SqsExecutorService } from './sqs-executor.service';
import { MessageRouterService } from '../message-processor/message-router.service';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

// Mock AWS SDK
jest.mock('@aws-sdk/client-sqs');

describe('SqsExecutorService', () => {
  let service: SqsExecutorService;
  let messageRouter: MessageRouterService;
  let mockSqsClient: jest.Mocked<SQSClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SqsExecutorService,
        {
          provide: MessageRouterService,
          useValue: {
            routeMessage: jest.fn().mockResolvedValue({
              projectId: 'ameliastamps',
              userId: 'scott',
              inputQueueUrl: 'https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-input-ameliastamps-scott',
              outputQueueUrl: 'https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-output-ameliastamps-scott',
              needsUnclaimed: false,
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SqsExecutorService>(SqsExecutorService);
    messageRouter = module.get<MessageRouterService>(MessageRouterService);
    
    // Get the mocked SQS client
    mockSqsClient = (service as any).sqs as jest.Mocked<SQSClient>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should execute instruction successfully', async () => {
    // Mock successful response from container
    const mockResponse = {
      commandId: 'test-command-id',
      success: true,
      summary: 'Changes completed',
      filesChanged: ['file1.ts', 'file2.ts'],
    };

    // Mock waitForResponse to return immediately
    jest.spyOn(service as any, 'waitForResponse').mockResolvedValue(mockResponse);

    const result = await service.executeInstruction(
      'test-session',
      'Update the homepage',
      'user@example.com',
      'thread-123',
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Changes completed');
    expect(result.changes).toHaveLength(2);
    expect(result.previewUrl).toContain('ameliastamps');
    expect(messageRouter.routeMessage).toHaveBeenCalled();
  }, 10000);

  it('should handle timeout when no response received', async () => {
    // Mock no response from container
    mockSqsClient.send = jest.fn()
      .mockResolvedValueOnce({}) // Send to input queue
      .mockResolvedValue({ Messages: [] }); // No messages in output queue

    // Override timeout for testing
    jest.spyOn(service as any, 'waitForResponse').mockResolvedValue(null);

    const result = await service.executeInstruction(
      'test-session',
      'Update the homepage',
      'user@example.com',
      'thread-123',
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('TIMEOUT');
    expect(result.message).toContain('timed out');
  });

  it('should indicate container starting when unclaimed', async () => {
    // Mock routing to indicate unclaimed needed
    (messageRouter.routeMessage as jest.Mock).mockResolvedValue({
      projectId: 'ameliastamps',
      userId: 'scott',
      inputQueueUrl: 'https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-input-ameliastamps-scott',
      outputQueueUrl: 'https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-output-ameliastamps-scott',
      needsUnclaimed: true,
    });

    // Mock no response (container starting)
    jest.spyOn(service as any, 'waitForResponse').mockResolvedValue(null);

    const result = await service.executeInstruction(
      'test-session',
      'Update the homepage',
      'user@example.com',
      'thread-123',
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('CONTAINER_STARTING');
    expect(result.message).toContain('Starting editing environment');
  });

  it('should detect planning requirements', () => {
    expect((service as any).requiresPlanning('Please refactor the entire codebase')).toBe(true);
    expect((service as any).requiresPlanning('Update the title')).toBe(false);
    expect((service as any).requiresPlanning('Restructure the project')).toBe(true);
    expect((service as any).requiresPlanning('Add a new button')).toBe(false);
  });

  it('should handle container response errors', async () => {
    const mockResponse = {
      commandId: 'test-command-id',
      success: false,
      error: 'Build failed',
      errorCode: 'BUILD_ERROR',
    };

    // Mock waitForResponse to return error response immediately
    jest.spyOn(service as any, 'waitForResponse').mockResolvedValue(mockResponse);

    const result = await service.executeInstruction(
      'test-session',
      'Update the homepage',
      'user@example.com',
      'thread-123',
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('BUILD_ERROR');
    expect(result.message).toContain('Build failed');
  }, 10000);
});