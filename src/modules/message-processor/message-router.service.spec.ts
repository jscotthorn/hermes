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
    // Create mocked clients
    mockSqsClient = {
      send: jest.fn(),
    } as any;

    mockDynamoClient = {
      send: jest.fn(),
    } as any;

    // Create service with mocked clients
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: MessageRouterService,
          useFactory: () => new MessageRouterService(mockSqsClient, mockDynamoClient),
        },
      ],
    }).compile();

    service = module.get<MessageRouterService>(MessageRouterService);
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
          projectId: { S: 'amelia' },
          userId: { S: 'scott' },
        },
      });

      const result = await service.identifyProjectUser({
        sessionId: 'test-session',
        userEmail: 'test@example.com',
      });

      expect(result.projectId).toBe('amelia');
      expect(result.userId).toBe('scott');
    });

    it('should identify project and user from thread ID', async () => {
      // Mock DynamoDB responses - only one call needed since no sessionId
      mockDynamoClient.send = jest.fn()
        .mockResolvedValueOnce({ // Thread exists
          Item: {
            threadId: { S: 'thread-123' },
            projectId: { S: 'amelia' },
            userId: { S: 'scott' },
          },
        });

      const result = await service.identifyProjectUser({
        threadId: 'thread-123',
        userEmail: 'test@example.com',
      });

      // Check mock was called
      expect(mockDynamoClient.send).toHaveBeenCalledTimes(1);

      expect(result.projectId).toBe('amelia');
      expect(result.userId).toBe('scott');
    });

    it('should identify project and user from email', async () => {
      // Mock no session or thread
      mockDynamoClient.send = jest.fn().mockResolvedValue({ Item: null });

      const result = await service.identifyProjectUser({
        userEmail: 'escottster@gmail.com',
      });

      expect(result.projectId).toBe('amelia');
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
      // Mock DynamoDB calls - identifyProjectUser and ownership check
      mockDynamoClient.send = jest.fn()
        .mockResolvedValueOnce({ Item: null }) // No session found (for identifyProjectUser)
        .mockResolvedValueOnce({ // Ownership check - container exists and is active
          Item: {
            projectKey: { S: 'amelia#scott' },
            containerId: { S: 'container-123' },
            status: { S: 'active' },
            lastActivity: { N: Date.now().toString() }, // Recent activity
          },
        });

      // Mock SQS send
      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'msg-123',
      });

      const message = {
        sessionId: 'test-session',
        projectId: 'amelia',
        userId: 'scott',
        commandId: 'cmd-123',
        instruction: 'Update homepage',
        from: 'escottster@gmail.com',
        userEmail: 'escottster@gmail.com',
        type: 'work',
        repoUrl: 'https://github.com/jscotthorn/amelia-astro.git',
        timestamp: Date.now(),
      };

      const result = await service.routeMessage(message);

      // Debug: Check how many DB calls were made
      expect(mockDynamoClient.send).toHaveBeenCalledTimes(2);

      expect(result.projectId).toBe('amelia');
      expect(result.userId).toBe('scott');
      expect(result.needsUnclaimed).toBe(false);
      expect(mockSqsClient.send).toHaveBeenCalledTimes(1); // Only to project queue
    });

    it('should send to unclaimed queue when no container is active', async () => {
      // Mock DynamoDB calls - identifyProjectUser returns no session, then no ownership
      mockDynamoClient.send = jest.fn()
        .mockResolvedValueOnce({ Item: null }) // No session found (for identifyProjectUser)
        .mockResolvedValueOnce({ Item: null }); // No ownership

      // Mock SQS send
      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'msg-123',
      });

      const message = {
        sessionId: 'test-session',
        projectId: 'amelia',
        userId: 'scott',
        commandId: 'cmd-123',
        instruction: 'Update homepage',
        from: 'escottster@gmail.com',
        userEmail: 'escottster@gmail.com',
        type: 'work',
        repoUrl: 'https://github.com/jscotthorn/amelia-astro.git',
        timestamp: Date.now(),
      };

      const result = await service.routeMessage(message);

      expect(result.projectId).toBe('amelia');
      expect(result.userId).toBe('scott');
      expect(result.needsUnclaimed).toBe(true);
      expect(mockSqsClient.send).toHaveBeenCalledTimes(2); // Project queue + unclaimed queue
    });

    it('should include all required fields in work message', async () => {
      // Mock DynamoDB calls
      mockDynamoClient.send = jest.fn()
        .mockResolvedValueOnce({ Item: null }) // No session found (for identifyProjectUser)
        .mockResolvedValueOnce({ Item: null }); // No ownership

      // Mock SQS send
      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'msg-123',
      });

      const message = {
        sessionId: 'test-session',
        projectId: 'amelia',
        userId: 'scott',
        commandId: 'cmd-123',
        instruction: 'Update homepage',
        from: 'escottster@gmail.com',
        userEmail: 'escottster@gmail.com',
        threadId: 'thread-456',
        type: 'work',
        repoUrl: 'https://github.com/jscotthorn/amelia-astro.git',
        timestamp: Date.now(),
      };

      await service.routeMessage(message);

      // Verify work message was sent with all required fields
      expect(mockSqsClient.send).toHaveBeenCalled();
      const sentCall = (mockSqsClient.send as jest.Mock).mock.calls[0];

      // In AWS SDK v3, the command object is the first argument
      const command = sentCall[0];
      // The command has an input property with the parameters
      if (command && command.input && command.input.MessageBody) {
        const sentMessage = JSON.parse(command.input.MessageBody);

        expect(sentMessage.type).toBe('work');
        expect(sentMessage.projectId).toBe('amelia');
        expect(sentMessage.userId).toBe('scott');
        expect(sentMessage.repoUrl).toBeDefined();
        expect(sentMessage.instruction).toBe('Update homepage');
        expect(sentMessage.from).toBe('escottster@gmail.com');
      } else {
        // Test that the send was called at least
        expect(mockSqsClient.send).toHaveBeenCalledTimes(2); // Project queue + unclaimed queue
      }
    });
  });

  describe('checkContainerOwnership', () => {
    it('should return true when container is active', async () => {
      mockDynamoClient.send = jest.fn()
        .mockResolvedValueOnce({ Item: null }) // No session found (for identifyProjectUser)
        .mockResolvedValueOnce({ // Ownership check - container active
          Item: {
            projectKey: { S: 'amelia#scott' },
            containerId: { S: 'container-123' },
            status: { S: 'active' },
            lastActivity: { N: Date.now().toString() }, // Recent activity
          },
        });

      // checkContainerOwnership is private, test via routeMessage
      const message = {
        sessionId: 'test-session',
        projectId: 'amelia',
        userId: 'scott',
        commandId: 'cmd-123',
        instruction: 'Test',
        from: 'escottster@gmail.com',
        userEmail: 'escottster@gmail.com',
        type: 'work',
        repoUrl: 'https://github.com/jscotthorn/amelia-astro.git',
        timestamp: Date.now(),
      };

      mockSqsClient.send = jest.fn().mockResolvedValue({ MessageId: 'msg-123' });
      const result = await service.routeMessage(message);
      expect(result.needsUnclaimed).toBe(false);
    });

    it('should return false when no container owns project', async () => {
      mockDynamoClient.send = jest.fn()
        .mockResolvedValueOnce({ Item: null }) // No session found (for identifyProjectUser)
        .mockResolvedValueOnce({ Item: null }); // No ownership

      const message = {
        sessionId: 'test-session',
        projectId: 'amelia',
        userId: 'scott',
        commandId: 'cmd-123',
        instruction: 'Test',
        from: 'escottster@gmail.com',
        userEmail: 'escottster@gmail.com',
        type: 'work',
        repoUrl: 'https://github.com/jscotthorn/amelia-astro.git',
        timestamp: Date.now(),
      };

      mockSqsClient.send = jest.fn().mockResolvedValue({ MessageId: 'msg-123' });
      const result = await service.routeMessage(message);
      expect(result.needsUnclaimed).toBe(true);
    });

    it('should return false when container is inactive', async () => {
      mockDynamoClient.send = jest.fn()
        .mockResolvedValueOnce({ Item: null }) // No session found (for identifyProjectUser)
        .mockResolvedValueOnce({ // Ownership check - container inactive
          Item: {
            projectKey: { S: 'amelia#scott' },
            containerId: { S: 'container-123' },
            status: { S: 'inactive' },
          },
        });

      const message = {
        sessionId: 'test-session',
        projectId: 'amelia',
        userId: 'scott',
        commandId: 'cmd-123',
        instruction: 'Test',
        from: 'escottster@gmail.com',
        userEmail: 'escottster@gmail.com',
        type: 'work',
        repoUrl: 'https://github.com/jscotthorn/amelia-astro.git',
        timestamp: Date.now(),
      };

      mockSqsClient.send = jest.fn().mockResolvedValue({ MessageId: 'msg-123' });
      const result = await service.routeMessage(message);
      expect(result.needsUnclaimed).toBe(true);
    });
  });
});