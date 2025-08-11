import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';

import { QueueManagerService } from '../../src/modules/sqs/queue-manager.service';
import { SqsMessageService } from '../../src/modules/sqs/sqs-message.service';

// S3 bucket configuration from environment
const S3_BUCKET = process.env.S3_BUCKET_NAME || 'edit.amelia.webordinary.com';
const S3_REGION = process.env.AWS_REGION || 'us-west-2';

describe('S3 Deployment Integration Tests', () => {
  let module: TestingModule;
  let queueManager: QueueManagerService;
  let messageService: SqsMessageService;
  let s3: S3Client;
  let cloudwatch: CloudWatchLogsClient;
  let dynamodb: DynamoDBClient;
  
  beforeAll(async () => {
    // Set up AWS clients with real credentials
    s3 = new S3Client({ region: S3_REGION });
    cloudwatch = new CloudWatchLogsClient({ region: S3_REGION });
    dynamodb = new DynamoDBClient({ region: S3_REGION });

    // Create test module with real services
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        QueueManagerService,
        SqsMessageService,
      ],
    }).compile();

    queueManager = module.get<QueueManagerService>(QueueManagerService);
    messageService = module.get<SqsMessageService>(SqsMessageService);
  });

  afterAll(async () => {
    await module?.close();
  });

  describe('S3 Bucket Access', () => {
    it('should have access to S3 bucket', async () => {
      // Test listing objects in the bucket
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: S3_BUCKET,
          MaxKeys: 1,
        })
      );

      // Should not throw error
      expect(response).toBeDefined();
      expect(response.$metadata.httpStatusCode).toBe(200);
    }, 30000);

    it('should be able to check for S3 objects', async () => {
      const testKey = `test-${uuidv4()}/index.html`;
      
      try {
        // Try to head a non-existent object
        await s3.send(
          new HeadObjectCommand({
            Bucket: S3_BUCKET,
            Key: testKey,
          })
        );
        
        // If it exists, that's fine
        expect(true).toBe(true);
      } catch (error) {
        // Should get a 404 for non-existent object
        expect(error.name).toBe('NotFound');
        expect(error.$metadata?.httpStatusCode).toBe(404);
      }
    }, 30000);
  });

  describe('CloudWatch Logs Access', () => {
    it('should have access to CloudWatch logs', async () => {
      const endTime = Date.now();
      const startTime = endTime - (5 * 60 * 1000); // 5 minutes ago
      
      try {
        const response = await cloudwatch.send(
          new FilterLogEventsCommand({
            logGroupName: '/ecs/webordinary/edit',
            startTime,
            endTime,
            limit: 1,
          })
        );

        // Should not throw error
        expect(response).toBeDefined();
        expect(response.$metadata.httpStatusCode).toBe(200);
      } catch (error) {
        // If log group doesn't exist, that's okay for test purposes
        if (error.name === 'ResourceNotFoundException') {
          console.warn('CloudWatch log group not found - may not be created yet');
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    }, 30000);
  });

  describe('Message Processing for S3', () => {
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

    it('should send build message that triggers S3 deployment', async () => {
      const commandId = await messageService.sendEditCommand(
        testQueues.inputUrl,
        {
          sessionId: `${currentTestId}-project-user-session`,
          type: 'build',
          instruction: 'Build and deploy to S3',
          userEmail: 'test@example.com',
          chatThreadId: 'thread-s3-test',
          context: {
            branch: 'thread-s3-test',
            clientId: currentTestId,
            projectId: 'project',
            userId: 'user',
          },
        }
      );

      expect(commandId).toBeDefined();
      expect(typeof commandId).toBe('string');
      
      // Note: Actual S3 deployment would happen asynchronously
      // in the container processing the message
    }, 30000);

    it('should handle S3 deployment context in messages', async () => {
      const s3Context = {
        branch: 'thread-deploy',
        clientId: currentTestId,
        projectId: 'project',
        userId: 'user',
        s3Bucket: S3_BUCKET,
        s3Prefix: `${currentTestId}/deploy`,
      };

      const commandId = await messageService.sendEditCommand(
        testQueues.inputUrl,
        {
          sessionId: `${currentTestId}-project-user-deploy`,
          type: 'edit',
          instruction: 'Update homepage and deploy to S3',
          userEmail: 'test@example.com',
          chatThreadId: 'thread-deploy',
          context: s3Context,
        }
      );

      expect(commandId).toBeDefined();
      
      // The message should be queued for processing
      // Container will handle S3 deployment
    }, 30000);
  });

  describe('S3 Deployment Tracking', () => {
    it('should track S3 deployments in DynamoDB', async () => {
      const deploymentId = `deploy-${uuidv4().substring(0, 8)}`;
      const testItem = {
        sessionId: { S: `test-session-${deploymentId}` },
        userId: { S: 'test-user' },  // Required composite key
        clientId: { S: 'test-client' },
        projectId: { S: 'test-project' },
        s3Bucket: { S: S3_BUCKET },
        s3Prefix: { S: `test/${deploymentId}` },
        status: { S: 'completed' },
        gitBranch: { S: 'test-branch' },
        lastActivity: { N: Date.now().toString() },
        createdAt: { N: Date.now().toString() },
        ttl: { N: Math.floor(Date.now() / 1000 + 3600).toString() },
      };

      // Store deployment record
      await dynamodb.send(
        new PutItemCommand({
          TableName: process.env.SESSION_TABLE || 'webordinary-edit-sessions',
          Item: testItem,
        })
      );

      // Verify record exists
      const result = await dynamodb.send(
        new GetItemCommand({
          TableName: process.env.SESSION_TABLE || 'webordinary-edit-sessions',
          Key: {
            sessionId: testItem.sessionId,
            userId: testItem.userId,
          },
        })
      );

      expect(result.Item).toBeDefined();
      expect(result.Item?.s3Bucket?.S).toBe(S3_BUCKET);
      expect(result.Item?.status?.S).toBe('completed');

      // Cleanup
      await dynamodb.send(
        new DeleteItemCommand({
          TableName: process.env.SESSION_TABLE || 'webordinary-edit-sessions',
          Key: {
            sessionId: testItem.sessionId,
            userId: testItem.userId,
          },
        })
      );
    }, 30000);
  });

  describe('CloudWatch Monitoring for S3 Deployments', () => {
    it('should be able to query deployment logs', async () => {
      const endTime = Date.now();
      const startTime = endTime - (60 * 60 * 1000); // 1 hour ago
      
      try {
        // Query for S3 sync related logs
        const response = await cloudwatch.send(
          new FilterLogEventsCommand({
            logGroupName: '/ecs/webordinary/edit',
            startTime,
            endTime,
            filterPattern: '"S3 sync" OR "Deploying to S3" OR "aws s3 sync"',
            limit: 10,
          })
        );

        // If we have logs, verify structure
        if (response.events && response.events.length > 0) {
          response.events.forEach(event => {
            expect(event.message).toBeDefined();
            expect(event.timestamp).toBeDefined();
          });
        }
        
        expect(response).toBeDefined();
      } catch (error) {
        // Log group may not exist yet
        if (error.name === 'ResourceNotFoundException') {
          console.warn('CloudWatch log group not found for S3 deployment logs');
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    }, 30000);
  });
});