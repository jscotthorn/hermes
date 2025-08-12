import { Test, TestingModule } from '@nestjs/testing';
import { EmailProcessorService } from './email-processor.service';
import { SqsExecutorService } from '../claude-executor/sqs-executor.service';
import { EditSessionService } from '../edit-session/services/edit-session.service';
import { MessageRouterService } from '../message-processor/message-router.service';

// Mock email-reply-parser
jest.mock('email-reply-parser', () => {
  return jest.fn().mockImplementation(() => ({
    parse: jest.fn().mockReturnValue({
      getFragments: jest.fn().mockReturnValue([
        {
          isQuoted: jest.fn().mockReturnValue(false),
          isSignature: jest.fn().mockReturnValue(false),
          getContent: jest.fn().mockReturnValue('This is the instruction'),
        },
      ]),
    }),
  }));
});

// Mock mailparser
jest.mock('mailparser', () => ({
  simpleParser: jest.fn().mockResolvedValue({
    from: { text: 'test@example.com' },
    to: { text: 'bot@webordinary.com' },
    subject: 'Test',
    text: 'Test instruction',
    html: '<p>Test instruction</p>',
    messageId: 'test-message-id',
    inReplyTo: undefined,
    references: [],
  }),
}));

describe('EmailProcessorService', () => {
  let service: EmailProcessorService;
  let sqsExecutor: SqsExecutorService;
  let sessionService: EditSessionService;
  let messageRouter: MessageRouterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailProcessorService,
        {
          provide: SqsExecutorService,
          useValue: {
            executeInstruction: jest.fn().mockResolvedValue({
              success: true,
              message: 'Test completed',
              changes: [],
              previewUrl: 'https://test.com/preview',
            }),
          },
        },
        {
          provide: MessageRouterService,
          useValue: {
            identifyProjectUser: jest.fn().mockResolvedValue({
              projectId: 'ameliastamps',
              userId: 'scott',
            }),
          },
        },
        {
          provide: EditSessionService,
          useValue: {
            getActiveSessions: jest.fn().mockResolvedValue([]),
            createSession: jest.fn().mockResolvedValue({
              sessionId: 'test-session-id',
              clientId: 'test-client',
              userId: 'test-user',
              threadId: 'test-thread',
              status: 'active',
            }),
            updateSessionActivity: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<EmailProcessorService>(EmailProcessorService);
    sqsExecutor = module.get<SqsExecutorService>(SqsExecutorService);
    sessionService = module.get<EditSessionService>(EditSessionService);
    messageRouter = module.get<MessageRouterService>(MessageRouterService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should process an email successfully', async () => {
    const mockRecord = {
      messageId: 'test-message-id',
      receiptHandle: 'test-receipt',
      body: JSON.stringify({
        content: 'From: test@example.com\r\nTo: bot@webordinary.com\r\nSubject: Test\r\n\r\nTest instruction',
      }),
    };

    // Mock AWS SDK
    (service as any).ses = {
      sendEmail: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      }),
    };
    (service as any).sqs = {
      deleteMessage: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      }),
    };

    await service.processEmail(mockRecord as any);

    expect(messageRouter.identifyProjectUser).toHaveBeenCalled();
    expect(sessionService.createSession).toHaveBeenCalled();
    expect(sessionService.updateSessionActivity).toHaveBeenCalled();
    expect(sqsExecutor.executeInstruction).toHaveBeenCalled();
  });

  it('should extract instruction from email', () => {
    const email = {
      textBody: 'This is the instruction',
      htmlBody: '<p>HTML version</p>',
    };

    const instruction = (service as any).extractInstruction(email);
    expect(instruction).toBe('This is the instruction');
  });

  it('should extract thread ID from email headers', () => {
    const parsed = {
      inReplyTo: '<thread-abc123@webordinary.com>',
      references: [],
    };

    const threadId = (service as any).extractThreadId(parsed);
    expect(threadId).toBe('abc123');
  });
});