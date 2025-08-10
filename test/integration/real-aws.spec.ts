import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import {
  SQSClient,
  GetQueueAttributesCommand,
  ListQueuesCommand,
} from '@aws-sdk/client-sqs';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';

import { QueueManagerService } from '../../src/modules/sqs/queue-manager.service';
import { SqsMessageService } from '../../src/modules/sqs/sqs-message.service';
import { ThreadExtractorService } from '../../src/modules/message-processor/thread-extractor.service';
import { EditSessionService } from '../../src/modules/edit-session/services/edit-session.service';
import { FargateManagerService } from '../../src/modules/edit-session/services/fargate-manager.service';

describe('Real AWS Infrastructure Integration Tests', () => {
  let module: TestingModule;
  let queueManager: QueueManagerService;
  let messageService: SqsMessageService;
  let threadExtractor: ThreadExtractorService;
  let sqs: SQSClient;
  let dynamodb: DynamoDBClient;
  
  beforeAll(async () => {
    // Set up AWS clients with real credentials
    sqs = new SQSClient({ 
      region: process.env.AWS_REGION || 'us-west-2'
    });
    dynamodb = new DynamoDBClient({ 
      region: process.env.AWS_REGION || 'us-west-2' 
    });

    // Create test module with real services
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        QueueManagerService,
        SqsMessageService,
        ThreadExtractorService,
        EditSessionService,
        FargateManagerService,
      ],
    }).compile();

    queueManager = module.get<QueueManagerService>(QueueManagerService);
    messageService = module.get<SqsMessageService>(SqsMessageService);
    threadExtractor = module.get<ThreadExtractorService>(ThreadExtractorService);
  });

  afterAll(async () => {
    await module?.close();
  });

  describe('DynamoDB Tables', () => {
    it('should have queue tracking table available', async () => {
      const testItem = {
        containerId: { S: `test-${uuidv4().substring(0, 8)}` },
        createdAt: { N: Date.now().toString() },
        inputQueueUrl: { S: 'https://test-queue-url' },
        outputQueueUrl: { S: 'https://test-output-url' },
        dlqUrl: { S: 'https://test-dlq-url' },
        ttl: { N: Math.floor(Date.now() / 1000 + 3600).toString() }, // 1 hour TTL
      };

      // Test write
      await dynamodb.send(
        new PutItemCommand({
          TableName: process.env.QUEUE_TRACKING_TABLE,
          Item: testItem,
        })
      );

      // Test read using Query since table has composite key
      const result = await dynamodb.send(
        new QueryCommand({
          TableName: process.env.QUEUE_TRACKING_TABLE,
          KeyConditionExpression: 'containerId = :containerId',
          ExpressionAttributeValues: {
            ':containerId': testItem.containerId,
          },
          Limit: 1,
        })
      );

      expect(result.Items).toBeDefined();
      expect(result.Items?.length).toBeGreaterThan(0);
      expect(result.Items?.[0]?.containerId?.S).toBe(testItem.containerId.S);

      // Cleanup using the retrieved record's complete key
      if (result.Items?.[0]) {
        await dynamodb.send(
          new DeleteItemCommand({
            TableName: process.env.QUEUE_TRACKING_TABLE,
            Key: {
              containerId: testItem.containerId,
              createdAt: result.Items[0].createdAt,
            },
          })
        );
      }
    }, 30000);

    it('should have thread mappings table available', async () => {
      const testItem = {
        threadId: { S: `thread-${uuidv4().substring(0, 8)}` },
        messageId: { S: `msg-${uuidv4()}` },
        sessionId: { S: 'test-session' },
        clientId: { S: 'test-client' },
        projectId: { S: 'test-project' },
        userId: { S: 'test-user' },
        source: { S: 'test' },
        lastSource: { S: 'test' },
        firstSeen: { N: Date.now().toString() },
        lastActivity: { N: Date.now().toString() },
        messageCount: { N: '1' },
        ttl: { N: Math.floor(Date.now() / 1000 + 3600).toString() },
      };

      // Test write
      await dynamodb.send(
        new PutItemCommand({
          TableName: process.env.THREAD_MAPPING_TABLE,
          Item: testItem,
        })
      );

      // Test read
      const result = await dynamodb.send(
        new GetItemCommand({
          TableName: process.env.THREAD_MAPPING_TABLE,
          Key: {
            threadId: testItem.threadId,
          },
        })
      );

      expect(result.Item).toBeDefined();
      expect(result.Item?.threadId?.S).toBe(testItem.threadId.S);

      // Cleanup
      await dynamodb.send(
        new DeleteItemCommand({
          TableName: process.env.THREAD_MAPPING_TABLE,
          Key: {
            threadId: testItem.threadId,
          },
        })
      );
    }, 30000);
  });

  describe('Queue Management', () => {
    let testQueues: any;

    afterEach(async () => {
      // Cleanup test queues
      if (testQueues) {
        try {
          // Extract IDs from the containerId
          const parts = testQueues.containerId.split('-');
          if (parts.length >= 3) {
            await queueManager.deleteContainerQueues(
              parts[0] + '-' + parts[1],
              parts[2],
              parts[3]
            );
          }
        } catch (error) {
          console.warn('Failed to cleanup test queues:', error.message);
        }
      }
    });

    it('should create container queues successfully', async () => {
      const testId = `test-${uuidv4().substring(0, 8)}`;
      testQueues = await queueManager.createContainerQueues(
        testId,
        'project',
        'user'
      );

      expect(testQueues).toBeDefined();
      expect(testQueues.containerId).toBe(`${testId}-project-user`);
      expect(testQueues.inputUrl).toMatch(/webordinary-input-/);
      expect(testQueues.outputUrl).toMatch(/webordinary-output-/);
      expect(testQueues.dlqUrl).toMatch(/webordinary-dlq-/);

      // Verify queues exist in AWS
      const inputExists = await queueExists(sqs, testQueues.inputUrl);
      const outputExists = await queueExists(sqs, testQueues.outputUrl);
      const dlqExists = await queueExists(sqs, testQueues.dlqUrl);

      expect(inputExists).toBe(true);
      expect(outputExists).toBe(true);
      expect(dlqExists).toBe(true);
    }, 60000);

    it('should store queue info in DynamoDB', async () => {
      const testId = `test-${uuidv4().substring(0, 8)}`;
      testQueues = await queueManager.createContainerQueues(
        testId,
        'project',
        'user'
      );

      // Check DynamoDB record using Query since table has composite key
      const result = await dynamodb.send(
        new QueryCommand({
          TableName: process.env.QUEUE_TRACKING_TABLE,
          KeyConditionExpression: 'containerId = :containerId',
          ExpressionAttributeValues: {
            ':containerId': { S: testQueues.containerId },
          },
          Limit: 1,
        })
      );

      expect(result.Items).toBeDefined();
      expect(result.Items?.length).toBeGreaterThan(0);
      const item = result.Items![0];
      expect(item.inputQueueUrl?.S).toBe(testQueues.inputUrl);
      expect(item.outputQueueUrl?.S).toBe(testQueues.outputUrl);
      expect(item.dlqQueueUrl?.S).toBe(testQueues.dlqUrl);
    }, 60000);
  });

  describe('Message Service', () => {
    let testQueues: any;
    let currentTestId: string;

    beforeEach(async () => {
      currentTestId = `test-${uuidv4().substring(0, 8)}`;
      testQueues = await queueManager.createContainerQueues(
        currentTestId,
        'project',
        'user'
      );
    });

    afterEach(async () => {
      if (testQueues && currentTestId) {
        try {
          await queueManager.deleteContainerQueues(
            currentTestId,
            'project',
            'user'
          );
        } catch (error) {
          console.warn('Failed to cleanup test queues:', error.message);
        }
      }
    });

    it('should send messages to SQS queue', async () => {
      const commandId = await messageService.sendEditCommand(
        testQueues.inputUrl,
        {
          sessionId: `test-session-${currentTestId.substring(5)}`,
          type: 'edit',
          instruction: 'Test instruction',
          userEmail: 'test@example.com',
          chatThreadId: 'thread-test',
          context: {
            branch: 'test-branch',
            clientId: currentTestId,
            projectId: 'project',
            userId: 'user',
          },
        }
      );

      expect(commandId).toBeDefined();
      expect(typeof commandId).toBe('string');
      expect(commandId.length).toBeGreaterThan(0);
    }, 30000);

    it('should handle different message types', async () => {
      const messageTypes = ['edit', 'build', 'commit', 'push', 'preview'];
      
      for (const type of messageTypes) {
        const commandId = await messageService.sendEditCommand(
          testQueues.inputUrl,
          {
            sessionId: `test-session-${currentTestId.substring(5)}`,
            type: type as any,
            instruction: `Test ${type} instruction`,
            userEmail: 'test@example.com',
            chatThreadId: 'thread-test',
            context: {
              branch: 'test-branch',
              clientId: currentTestId,
              projectId: 'project',
              userId: 'user',
            },
          }
        );

        expect(commandId).toBeDefined();
      }
    }, 60000);
  });

  describe('Thread Extractor', () => {
    it('should extract thread IDs from email messages', async () => {
      const emailMessage = {
        source: 'email' as const,
        data: {
          messageId: `<test-${uuidv4()}@example.com>`,
          subject: 'Test email',
          from: { text: 'test@example.com' },
          text: 'Test content',
        },
        clientId: 'test-client',
        projectId: 'test-project',
        userId: 'test-user',
      };

      const threadId = await threadExtractor.extractThreadId(
        emailMessage
      );

      expect(threadId).toBeDefined();
      expect(typeof threadId).toBe('string');
      expect(threadId.length).toBe(8); // Should be 8-character hash
    });

    it('should extract thread IDs from SMS messages', async () => {
      const smsMessage = {
        source: 'sms' as const,
        data: {
          from: '+1234567890',
          to: '+1987654321',
          body: 'Test SMS',
          messageId: `sms-${uuidv4()}`,
        },
        clientId: 'test-client',
        projectId: 'test-project',
        userId: 'test-user',
      };

      const threadId = await threadExtractor.extractThreadId(
        smsMessage
      );

      expect(threadId).toBeDefined();
      expect(typeof threadId).toBe('string');
      expect(threadId.length).toBe(8);
    });

    it('should handle chat messages', async () => {
      const chatMessage = {
        source: 'chat' as const,
        data: {
          messageId: `chat-${uuidv4()}`,
          threadId: 'test-thread-123',
          from: 'test-user',
          text: 'Test chat message',
        },
        clientId: 'test-client',
        projectId: 'test-project',
        userId: 'test-user',
      };

      const threadId = await threadExtractor.extractThreadId(
        chatMessage
      );

      expect(threadId).toBeDefined();
      expect(typeof threadId).toBe('string');
      expect(threadId.length).toBe(8);
    });
  });

  describe('AWS Resource Connectivity', () => {
    it('should list webordinary SQS queues', async () => {
      const result = await sqs.send(
        new ListQueuesCommand({
          QueueNamePrefix: 'webordinary-',
        })
      );

      // Should find at least some queues (may be empty if no queues exist)
      expect(result.QueueUrls).toBeDefined();
      expect(Array.isArray(result.QueueUrls)).toBe(true);
    });

    it('should have access to DynamoDB tables', async () => {
      // Test queue tracking table
      const queueTrackingTest = dynamodb.send(
        new PutItemCommand({
          TableName: process.env.QUEUE_TRACKING_TABLE,
          Item: {
            containerId: { S: 'connectivity-test' },
            createdAt: { N: Date.now().toString() },
            inputQueueUrl: { S: 'test-url' },
            outputQueueUrl: { S: 'test-url' },
            dlqUrl: { S: 'test-url' },
            ttl: { N: Math.floor(Date.now() / 1000 + 300).toString() }, // 5 min TTL
          },
        })
      );

      // Test thread mappings table  
      const threadMappingTest = dynamodb.send(
        new PutItemCommand({
          TableName: process.env.THREAD_MAPPING_TABLE,
          Item: {
            threadId: { S: 'connectivity-test' },
            messageId: { S: 'test-msg' },
            sessionId: { S: 'test-session' },
            clientId: { S: 'test' },
            projectId: { S: 'test' },
            userId: { S: 'test' },
            source: { S: 'test' },
            lastSource: { S: 'test' },
            firstSeen: { N: Date.now().toString() },
            lastActivity: { N: Date.now().toString() },
            messageCount: { N: '1' },
            ttl: { N: Math.floor(Date.now() / 1000 + 300).toString() },
          },
        })
      );

      await expect(queueTrackingTest).resolves.not.toThrow();
      await expect(threadMappingTest).resolves.not.toThrow();

      // Cleanup - need to provide full keys for composite key tables
      
      // For queue tracking table (has sort key), need to query first to get createdAt
      const queueQueryResult = await dynamodb.send(
        new QueryCommand({
          TableName: process.env.QUEUE_TRACKING_TABLE,
          KeyConditionExpression: 'containerId = :containerId',
          ExpressionAttributeValues: {
            ':containerId': { S: 'connectivity-test' },
          },
          Limit: 1,
        })
      );
      
      if (queueQueryResult.Items?.[0]) {
        await dynamodb.send(
          new DeleteItemCommand({
            TableName: process.env.QUEUE_TRACKING_TABLE,
            Key: { 
              containerId: { S: 'connectivity-test' },
              createdAt: queueQueryResult.Items[0].createdAt,
            },
          })
        );
      }
      
      // Thread mapping table has single key
      await dynamodb.send(
        new DeleteItemCommand({
          TableName: process.env.THREAD_MAPPING_TABLE,
          Key: { threadId: { S: 'connectivity-test' } },
        })
      );
    }, 30000);
  });
});

// Helper function to check if queue exists
async function queueExists(sqs: SQSClient, queueUrl: string): Promise<boolean> {
  try {
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['CreatedTimestamp'],
      })
    );
    return true;
  } catch (error) {
    if (error.name === 'QueueDoesNotExist') {
      return false;
    }
    throw error;
  }
}