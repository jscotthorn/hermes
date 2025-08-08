import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentService } from './agent.service';
import { ParsedMail } from 'mailparser';

describe('AgentService', () => {
  let service: AgentService;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config = {
        'aws.bedrockRegion': 'us-west-2',
        'aws.accessKeyId': 'test-access-key',
        'aws.secretAccessKey': 'test-secret-key',
      };
      return config[key];
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<AgentService>(AgentService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('invokeApp', () => {
    it('should process a new email and return thread_id', async () => {
      const mockEmail: Partial<ParsedMail> = {
        from: { text: 'user@example.com', value: [{ address: 'user@example.com', name: 'User' }] },
        subject: 'Update homepage',
        text: 'Please update the homepage title to "Welcome to Our New Site"',
        messageId: '<123@example.com>',
      };

      // Mock the graph execution
      jest.spyOn(service as any, '#app').mockImplementation({
        invoke: jest.fn().mockResolvedValue({
          messages: [
            {
              content: 'I will update the homepage title for you.',
              name: 'assistant',
            },
          ],
          awaitingUser: false,
        }),
      });

      const result = await service.invokeApp(mockEmail as ParsedMail);

      expect(result).toHaveProperty('thread_id');
      expect(result).toHaveProperty('response');
      expect(result.response.content).toBe('I will update the homepage title for you.');
    });

    it('should resume an existing conversation', async () => {
      const existingThreadId = 'existing-thread-123';
      const mockEmail: Partial<ParsedMail> = {
        from: { text: 'user@example.com', value: [{ address: 'user@example.com', name: 'User' }] },
        subject: 'Re: Update homepage',
        text: 'Yes, please proceed with the update',
        messageId: '<456@example.com>',
      };

      // Mock checkpointer getTuple to return existing state
      const mockCheckpointer = {
        getTuple: jest.fn().mockResolvedValue({
          value: {
            messages: [
              { role: 'assistant', content: 'Are you sure you want to update the homepage?' },
            ],
            awaitingUser: true,
          },
        }),
      };
      (service as any).#checkpointer = mockCheckpointer;

      // Mock graph execution
      jest.spyOn(service as any, '#app').mockImplementation({
        invoke: jest.fn().mockResolvedValue({
          messages: [
            {
              content: 'Homepage updated successfully.',
              name: 'assistant',
            },
          ],
          awaitingUser: false,
        }),
      });

      const result = await service.invokeApp(mockEmail as ParsedMail, existingThreadId);

      expect(mockCheckpointer.getTuple).toHaveBeenCalled();
      expect(result.thread_id).toBe(existingThreadId);
      expect(result.response.content).toBe('Homepage updated successfully.');
    });
  });

  describe('getThreadState', () => {
    it('should retrieve thread state', async () => {
      const threadId = 'test-thread-123';
      const mockState = {
        messages: [
          { role: 'user', content: 'Test message' },
          { role: 'assistant', content: 'Test response' },
        ],
      };

      const mockCheckpointer = {
        getTuple: jest.fn().mockResolvedValue({ value: mockState }),
      };
      (service as any).#checkpointer = mockCheckpointer;

      const result = await service.getThreadState(threadId);

      expect(mockCheckpointer.getTuple).toHaveBeenCalledWith({
        configurable: { thread_id: threadId },
      });
      expect(result).toEqual(mockState);
    });
  });
});