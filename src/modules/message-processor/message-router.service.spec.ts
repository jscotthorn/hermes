import { Test, TestingModule } from '@nestjs/testing';
import { MessageRouterService } from './message-router.service';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';

// Mock AWS SDK
jest.mock('@aws-sdk/client-sqs');
jest.mock('@aws-sdk/client-dynamodb');

describe('MessageRouterService', () => {
  let service: MessageRouterService;
  let mockSqsClient: jest.Mocked<SQSClient>;
  let mockDynamoClient: jest.Mocked<DynamoDBClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MessageRouterService],
    }).compile();

    service = module.get<MessageRouterService>(MessageRouterService);
    
    // Get the mocked clients
    mockSqsClient = (service as any).sqs as jest.Mocked<SQSClient>;
    mockDynamoClient = (service as any).dynamodb as jest.Mocked<DynamoDBClient>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('identifyProjectUser', () => {
    it('should identify project and user from session ID', async () => {
      // Mock DynamoDB response for session lookup
      mockDynamoClient.send = jest.fn().mockResolvedValue({
        Item: {
          sessionId: { S: 'test-session' },
          projectId: { S: 'ameliastamps' },
          userId: { S: 'scott' },
        },
      });

      const result = await service.identifyProjectUser({
        sessionId: 'test-session',
        userEmail: 'test@example.com',
      });

      expect(result.projectId).toBe('ameliastamps');
      expect(result.userId).toBe('scott');
    });

    it('should identify project and user from thread ID', async () => {
      // Mock no session, but thread exists
      mockDynamoClient.send = jest.fn()
        .mockResolvedValueOnce({ Item: null }) // No session
        .mockResolvedValueOnce({ // Thread exists
          Item: {
            threadId: { S: 'thread-123' },
            projectId: { S: 'ameliastamps' },
            userId: { S: 'scott' },
          },
        });

      const result = await service.identifyProjectUser({
        threadId: 'thread-123',
        userEmail: 'test@example.com',
      });

      expect(result.projectId).toBe('ameliastamps');
      expect(result.userId).toBe('scott');
    });

    it('should identify project and user from email', async () => {
      // Mock no session or thread
      mockDynamoClient.send = jest.fn().mockResolvedValue({ Item: null });

      const result = await service.identifyProjectUser({
        userEmail: 'escottster@gmail.com',
      });

      expect(result.projectId).toBe('ameliastamps');
      expect(result.userId).toBe('scott');
    });

    it('should use default for unknown email', async () => {
      // Mock no session or thread
      mockDynamoClient.send = jest.fn().mockResolvedValue({ Item: null });

      const result = await service.identifyProjectUser({
        userEmail: 'unknown@example.com',
      });

      expect(result.projectId).toBe('default');
      expect(result.userId).toBe('unknown');
    });
  });

  describe('routeMessage', () => {
    it('should route message to project queue when container is active', async () => {
      // Mock ownership check - container exists
      mockDynamoClient.send = jest.fn().mockResolvedValue({
        Item: {
          projectKey: { S: 'ameliastamps#scott' },
          containerId: { S: 'container-123' },
          status: { S: 'active' },
        },
      });

      // Mock SQS send
      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'msg-123',
      });

      const message = {
        sessionId: 'test-session',
        commandId: 'cmd-123',
        instruction: 'Update homepage',
        userEmail: 'escottster@gmail.com',
        type: 'execute',
        timestamp: Date.now(),
      };

      const result = await service.routeMessage(message);

      expect(result.projectId).toBe('ameliastamps');
      expect(result.userId).toBe('scott');
      expect(result.needsUnclaimed).toBe(false);
      expect(mockSqsClient.send).toHaveBeenCalledTimes(1); // Only to project queue
    });

    it('should send to unclaimed queue when no container is active', async () => {
      // Mock no ownership
      mockDynamoClient.send = jest.fn().mockResolvedValue({ Item: null });

      // Mock SQS send
      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'msg-123',
      });

      const message = {
        sessionId: 'test-session',
        commandId: 'cmd-123',
        instruction: 'Update homepage',
        userEmail: 'escottster@gmail.com',
        type: 'execute',
        timestamp: Date.now(),
      };

      const result = await service.routeMessage(message);

      expect(result.projectId).toBe('ameliastamps');
      expect(result.userId).toBe('scott');
      expect(result.needsUnclaimed).toBe(true);
      expect(mockSqsClient.send).toHaveBeenCalledTimes(2); // Project queue + unclaimed queue
    });

    it('should create thread mapping for new sessions', async () => {
      // Mock no ownership
      mockDynamoClient.send = jest.fn()
        .mockResolvedValueOnce({ Item: null }) // No ownership
        .mockResolvedValueOnce({}); // Put thread mapping succeeds

      // Mock SQS send
      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'msg-123',
      });

      const message = {
        sessionId: 'test-session',
        commandId: 'cmd-123',
        instruction: 'Update homepage',
        userEmail: 'escottster@gmail.com',
        threadId: 'thread-456',
        type: 'execute',
        timestamp: Date.now(),
      };

      await service.routeMessage(message);

      // Verify thread mapping was created
      const putCalls = (mockDynamoClient.send as jest.Mock).mock.calls
        .filter(call => call[0] instanceof Object && call[0].constructor.name === 'PutItemCommand');
      
      expect(putCalls).toHaveLength(1);
    });
  });

  describe('checkContainerOwnership', () => {
    it('should return true when container is active', async () => {
      mockDynamoClient.send = jest.fn().mockResolvedValue({
        Item: {
          projectKey: { S: 'ameliastamps#scott' },
          containerId: { S: 'container-123' },
          status: { S: 'active' },
          lastActivity: { N: Date.now().toString() },
        },
      });

      // checkContainerOwnership is private, test via routeMessage
      const message = {
        sessionId: 'test-session',
        commandId: 'cmd-123',
        instruction: 'Test',
        userEmail: 'escottster@gmail.com',
        type: 'execute',
        timestamp: Date.now(),
      };

      mockSqsClient.send = jest.fn().mockResolvedValue({ MessageId: 'msg-123' });
      const result = await service.routeMessage(message);
      expect(result.needsUnclaimed).toBe(false);
    });

    it('should return false when no container owns project', async () => {
      mockDynamoClient.send = jest.fn().mockResolvedValue({ Item: null });

      const message = {
        sessionId: 'test-session',
        commandId: 'cmd-123',
        instruction: 'Test',
        userEmail: 'escottster@gmail.com',
        type: 'execute',
        timestamp: Date.now(),
      };

      mockSqsClient.send = jest.fn().mockResolvedValue({ MessageId: 'msg-123' });
      const result = await service.routeMessage(message);
      expect(result.needsUnclaimed).toBe(true);
    });

    it('should return false when container is inactive', async () => {
      mockDynamoClient.send = jest.fn().mockResolvedValue({
        Item: {
          projectKey: { S: 'ameliastamps#scott' },
          containerId: { S: 'container-123' },
          status: { S: 'inactive' },
        },
      });

      const message = {
        sessionId: 'test-session',
        commandId: 'cmd-123',
        instruction: 'Test',
        userEmail: 'escottster@gmail.com',
        type: 'execute',
        timestamp: Date.now(),
      };

      mockSqsClient.send = jest.fn().mockResolvedValue({ MessageId: 'msg-123' });
      const result = await service.routeMessage(message);
      expect(result.needsUnclaimed).toBe(true);
    });
  });
});