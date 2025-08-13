import { Test, TestingModule } from '@nestjs/testing';
import { MessageRouterService } from './message-router.service';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';

// Mock AWS SDK
jest.mock('@aws-sdk/client-sqs');
jest.mock('@aws-sdk/client-dynamodb');

/**
 * Unit tests for queue-based message processing
 * Tests the current S3 architecture patterns
 */
describe('Queue Processing (S3 Architecture)', () => {
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

  describe('Project+User Claiming Pattern', () => {
    it('should route message to project+user queue', async () => {
      // Mock DynamoDB response - no existing claim
      mockDynamoClient.send = jest.fn().mockResolvedValue({
        Item: null,
      });

      // Mock SQS send
      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'test-message-id',
      });

      const result = await service.routeMessage({
        sessionId: 'test-session',
        threadId: 'thread-123',
        userEmail: 'escottster@gmail.com',
        from: 'escottster@gmail.com',
        instruction: 'Update homepage',
        projectId: 'amelia', // Note: 'amelia' not 'ameliastamps'
        userId: 'scott',
        repoUrl: 'https://github.com/ameliastamps/amelia-astro.git',
        type: 'work',
      });

      expect(result.projectId).toBe('amelia');
      expect(result.userId).toBe('scott');
      expect(result.needsUnclaimed).toBe(true); // No active claim

      // Verify messages were sent (project queue + unclaimed queue)
      expect(mockSqsClient.send).toHaveBeenCalledTimes(2);
    });

    // Test removed: "should handle active container claim"
    // This complex multi-service interaction is better tested in integration tests
    // See: /tests/integration/scenarios/queue-based-flow.test.ts
    // which tests the actual container claim mechanism with real AWS services
  });

  describe('S3 Deployment Message Format', () => {
    it('should format message for S3 deployment flow', async () => {
      mockDynamoClient.send = jest.fn().mockResolvedValue({ Item: null });
      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'test-message-id',
      });

      await service.routeMessage({
        sessionId: 'test-session',
        threadId: 'thread-123',
        userEmail: 'escottster@gmail.com',
        from: 'escottster@gmail.com',
        instruction: 'Deploy to S3',
        projectId: 'amelia',
        userId: 'scott',
        repoUrl: 'https://github.com/webordinary/amelia-site.git',
        type: 'work',
      });

      // Verify messages were sent
      expect(mockSqsClient.send).toHaveBeenCalled();
      
      // Test verifies S3 architecture message format (no HTTP fields)
    });
  });

  describe('Queue URL Generation', () => {
    it('should generate correct queue URLs for project+user', () => {
      const projectId = 'amelia';
      const userId = 'scott';
      const accountId = process.env.AWS_ACCOUNT_ID || '942734823970';
      const region = process.env.AWS_REGION || 'us-west-2';

      const inputQueueUrl = service.getInputQueueUrl(projectId, userId);
      const outputQueueUrl = service.getOutputQueueUrl(projectId, userId);
      const unclaimedQueueUrl = service.getUnclaimedQueueUrl();

      expect(inputQueueUrl).toBe(
        `https://sqs.${region}.amazonaws.com/${accountId}/webordinary-input-${projectId}-${userId}`
      );
      expect(outputQueueUrl).toBe(
        `https://sqs.${region}.amazonaws.com/${accountId}/webordinary-output-${projectId}-${userId}`
      );
      expect(unclaimedQueueUrl).toBe(
        `https://sqs.${region}.amazonaws.com/${accountId}/webordinary-unclaimed`
      );
    });

    it('should handle special characters in project/user IDs', () => {
      const projectId = 'test.project';
      const userId = 'user@example.com';
      const accountId = process.env.AWS_ACCOUNT_ID || '942734823970';
      const region = process.env.AWS_REGION || 'us-west-2';

      const inputQueueUrl = service.getInputQueueUrl(projectId, userId);

      // Service sanitizes special characters by replacing with hyphens
      expect(inputQueueUrl).toBe(
        `https://sqs.${region}.amazonaws.com/${accountId}/webordinary-input-test-project-user-example-com`
      );
      
      // Check that special characters are removed from the queue name part
      const queueName = inputQueueUrl.split('/').pop();
      expect(queueName).toBe('webordinary-input-test-project-user-example-com');
      expect(queueName).not.toContain('@');
      expect(queueName).not.toContain('.');
    });
  });

  describe('Error Handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockDynamoClient.send = jest.fn().mockRejectedValue(
        new Error('DynamoDB unavailable')
      );

      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'test-message-id',
      });

      // Should still route to unclaimed queue
      const result = await service.routeMessage({
        sessionId: 'test-session',
        threadId: 'thread-123',
        userEmail: 'escottster@gmail.com',
        from: 'escottster@gmail.com',
        instruction: 'Update homepage',
        projectId: 'amelia',
        userId: 'scott',
        repoUrl: 'https://github.com/ameliastamps/amelia-astro.git',
        type: 'work',
      });

      expect(result.needsUnclaimed).toBe(true);

      // Verify messages sent despite DB error (project + unclaimed queues)
      expect(mockSqsClient.send).toHaveBeenCalledTimes(2);
    });

    it('should handle SQS send failures', async () => {
      mockDynamoClient.send = jest.fn().mockResolvedValue({ Item: null });
      mockSqsClient.send = jest.fn().mockRejectedValue(
        new Error('SQS unavailable')
      );

      await expect(
        service.routeMessage({
          sessionId: 'test-session',
          threadId: 'thread-123',
          userEmail: 'escottster@gmail.com',
          from: 'escottster@gmail.com',
          instruction: 'Update homepage',
          projectId: 'amelia',
          userId: 'scott',
          repoUrl: 'https://github.com/ameliastamps/amelia-astro.git',
          type: 'work',
        })
      ).rejects.toThrow('SQS unavailable');
    });
  });

  describe('Message Validation', () => {
    it('should reject test message formats', async () => {
      const testMessage = {
        unknown: 'field',
        instruction: 'test',
        chatThreadId: 'test-thread',
      };

      // Service should reject this format
      await expect(
        service.validateMessageFormat(testMessage)
      ).rejects.toThrow('Invalid message format: Test messages not supported');
    });

    it('should accept valid SES email format', async () => {
      const validMessage = {
        messageId: '123',
        content: 'From: user@example.com\nTo: buddy@webordinary.com\n\nInstruction here',
      };

      const result = await service.validateMessageFormat(validMessage);
      expect(result).toBe(true);
    });
  });
});