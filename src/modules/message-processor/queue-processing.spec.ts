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
    const module: TestingModule = await Test.createTestingModule({
      providers: [MessageRouterService],
    }).compile();

    service = module.get<MessageRouterService>(MessageRouterService);
    
    // Get the mocked clients
    mockSqsClient = (service as any).sqs as jest.Mocked<SQSClient>;
    mockDynamoClient = (service as any).dynamodb as jest.Mocked<DynamoDBClient>;
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
        instruction: 'Update homepage',
        projectId: 'amelia', // Note: 'amelia' not 'ameliastamps'
        userId: 'scott',
      });

      expect(result.projectId).toBe('amelia');
      expect(result.userId).toBe('scott');
      expect(result.needsUnclaimed).toBe(true); // No active claim
      
      // Verify message sent to unclaimed queue
      const sendCalls = mockSqsClient.send.mock.calls;
      expect(sendCalls.length).toBeGreaterThan(0);
      
      const unclaimedCall = sendCalls.find(call => {
        const command = call[0] as SendMessageCommand;
        return command.input.QueueUrl?.includes('unclaimed');
      });
      expect(unclaimedCall).toBeDefined();
    });

    it('should handle active container claim', async () => {
      // Mock DynamoDB response - active claim exists
      mockDynamoClient.send = jest.fn().mockResolvedValue({
        Item: {
          projectKey: { S: 'amelia#scott' },
          containerId: { S: 'container-123' },
          status: { S: 'active' },
          claimedAt: { N: String(Date.now()) },
        },
      });

      // Mock SQS send
      mockSqsClient.send = jest.fn().mockResolvedValue({
        MessageId: 'test-message-id',
      });

      const result = await service.routeMessage({
        sessionId: 'test-session',
        threadId: 'thread-123',
        userEmail: 'escottster@gmail.com',
        instruction: 'Update homepage',
        projectId: 'amelia',
        userId: 'scott',
      });

      expect(result.needsUnclaimed).toBe(false); // Active claim exists
      
      // Verify message sent to project+user queue only
      const sendCalls = mockSqsClient.send.mock.calls;
      const projectQueueCall = sendCalls.find(call => {
        const command = call[0] as SendMessageCommand;
        return command.input.QueueUrl?.includes('input-amelia-scott');
      });
      expect(projectQueueCall).toBeDefined();
      
      // Should NOT send to unclaimed queue
      const unclaimedCall = sendCalls.find(call => {
        const command = call[0] as SendMessageCommand;
        return command.input.QueueUrl?.includes('unclaimed');
      });
      expect(unclaimedCall).toBeUndefined();
    });
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
        instruction: 'Deploy to S3',
        projectId: 'amelia',
        userId: 'scott',
        repoUrl: 'https://github.com/webordinary/amelia-site.git',
      });

      // Check the message format sent to queue
      const sendCall = mockSqsClient.send.mock.calls[0];
      const command = sendCall[0] as SendMessageCommand;
      const messageBody = JSON.parse(command.input.MessageBody || '{}');

      expect(messageBody).toMatchObject({
        sessionId: 'test-session',
        threadId: 'thread-123',
        instruction: 'Deploy to S3',
        projectId: 'amelia',
        userId: 'scott',
        repoUrl: 'https://github.com/webordinary/amelia-site.git',
        timestamp: expect.any(Number),
      });

      // Should NOT have HTTP-related fields
      expect(messageBody).not.toHaveProperty('httpEndpoint');
      expect(messageBody).not.toHaveProperty('port');
      expect(messageBody).not.toHaveProperty('albTargetGroup');
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

      const inputQueueUrl = service.getInputQueueUrl(projectId, userId);
      
      // Should sanitize special characters
      expect(inputQueueUrl).not.toContain('@');
      expect(inputQueueUrl).not.toContain('.');
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
        instruction: 'Update homepage',
        projectId: 'amelia',
        userId: 'scott',
      });

      expect(result.needsUnclaimed).toBe(true);
      
      // Verify message sent to unclaimed queue despite DB error
      const sendCalls = mockSqsClient.send.mock.calls;
      const unclaimedCall = sendCalls.find(call => {
        const command = call[0] as SendMessageCommand;
        return command.input.QueueUrl?.includes('unclaimed');
      });
      expect(unclaimedCall).toBeDefined();
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
          instruction: 'Update homepage',
          projectId: 'amelia',
          userId: 'scott',
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
        content: 'From: user@example.com\nTo: edit@webordinary.com\n\nInstruction here',
      };

      const result = await service.validateMessageFormat(validMessage);
      expect(result).toBe(true);
    });
  });
});