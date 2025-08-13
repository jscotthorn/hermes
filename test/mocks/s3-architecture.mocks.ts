/**
 * Mock services and utilities for S3 architecture unit tests
 * 
 * These mocks reflect the current architecture:
 * - No HTTP servers in containers
 * - S3 for static site hosting  
 * - SQS for all inter-service communication
 * - Project+User claiming pattern (not session-based)
 */

import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';

/**
 * Mock SQS Client for queue-based testing
 */
export const createMockSqsClient = () => {
  const mockSend = jest.fn();
  
  // Default successful responses
  mockSend.mockImplementation((command) => {
    if (command instanceof SendMessageCommand) {
      return Promise.resolve({
        MessageId: `mock-message-${Date.now()}`,
        MD5OfMessageBody: 'mock-md5',
      });
    }
    if (command instanceof ReceiveMessageCommand) {
      return Promise.resolve({
        Messages: [{
          MessageId: 'mock-message-id',
          Body: JSON.stringify({
            sessionId: 'test-session',
            instruction: 'Test instruction',
            projectId: 'amelia',
            userId: 'scott',
            threadId: 'thread-123',
          }),
          ReceiptHandle: 'mock-receipt',
        }],
      });
    }
    return Promise.resolve({});
  });

  return {
    send: mockSend,
    destroy: jest.fn(),
  } as unknown as SQSClient;
};

/**
 * Mock S3 Client for deployment testing
 */
export const createMockS3Client = () => {
  const mockSend = jest.fn();
  
  mockSend.mockImplementation((command) => {
    if (command instanceof PutObjectCommand) {
      return Promise.resolve({
        ETag: '"mock-etag"',
        VersionId: 'mock-version',
      });
    }
    if (command instanceof HeadObjectCommand) {
      return Promise.resolve({
        ContentLength: 1024,
        LastModified: new Date(),
        ETag: '"mock-etag"',
      });
    }
    return Promise.resolve({});
  });

  return {
    send: mockSend,
    destroy: jest.fn(),
  } as unknown as S3Client;
};

/**
 * Mock DynamoDB Client for state management testing
 */
export const createMockDynamoClient = () => {
  const mockSend = jest.fn();
  
  mockSend.mockImplementation((command) => {
    if (command instanceof GetItemCommand) {
      // Mock container ownership check
      if (command.input.Key?.projectKey) {
        return Promise.resolve({
          Item: {
            projectKey: { S: 'amelia#scott' },
            containerId: { S: 'container-123' },
            status: { S: 'active' },
            claimedAt: { N: String(Date.now()) },
          },
        });
      }
      // Mock session lookup
      return Promise.resolve({
        Item: {
          sessionId: { S: 'test-session' },
          threadId: { S: 'thread-123' },
          projectId: { S: 'amelia' },
          userId: { S: 'scott' },
        },
      });
    }
    if (command instanceof PutItemCommand) {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });

  return {
    send: mockSend,
    destroy: jest.fn(),
  } as unknown as DynamoDBClient;
};

/**
 * Mock message formats for testing
 */
export const mockMessages = {
  // Valid SES email message
  validEmail: {
    messageId: 'ses-message-id',
    content: `From: escottster@gmail.com
To: edit@webordinary.com
Subject: Update homepage
Message-ID: <thread-123@webordinary.com>

Please update the homepage with new content`,
  },

  // Valid queue message
  validQueueMessage: {
    sessionId: 'test-session',
    threadId: 'thread-123',
    projectId: 'amelia',
    userId: 'scott',
    instruction: 'Update homepage',
    repoUrl: 'https://github.com/webordinary/amelia-site.git',
    timestamp: Date.now(),
  },

  // Invalid test message (should be rejected)
  invalidTestMessage: {
    unknown: 'field',
    instruction: 'test',
    chatThreadId: 'test-thread',
  },

  // Container response message
  containerResponse: {
    commandId: 'cmd-123',
    sessionId: 'test-session',
    success: true,
    summary: 'Updated homepage successfully',
    filesChanged: ['src/pages/index.astro'],
    s3Bucket: 'edit.amelia.webordinary.com',
    deploymentTime: Date.now(),
  },
};

/**
 * Mock queue URLs
 */
export const mockQueueUrls = {
  email: 'https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-queue',
  unclaimed: 'https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-unclaimed',
  inputAmelia: 'https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-input-amelia-scott',
  outputAmelia: 'https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-output-amelia-scott',
  dlq: 'https://sqs.us-west-2.amazonaws.com/942734823970/webordinary-email-dlq',
};

/**
 * Mock S3 bucket names
 */
export const mockS3Buckets = {
  amelia: 'edit.amelia.webordinary.com',
  test: 'edit.test.webordinary.com',
  efs: 'webordinary-efs-backup',
};

/**
 * Mock container state
 */
export const mockContainerState = {
  warm: {
    containerId: 'container-warm',
    status: 'ready',
    projectKey: null,
    lastActivity: Date.now(),
  },
  claimed: {
    containerId: 'container-claimed',
    status: 'processing',
    projectKey: 'amelia#scott',
    lastActivity: Date.now(),
  },
  idle: {
    containerId: 'container-idle',
    status: 'idle',
    projectKey: 'amelia#scott',
    lastActivity: Date.now() - 1200000, // 20 minutes ago
  },
};

/**
 * Helper to create a complete mock environment
 */
export const createMockEnvironment = () => {
  return {
    sqs: createMockSqsClient(),
    s3: createMockS3Client(),
    dynamodb: createMockDynamoClient(),
    queueUrls: mockQueueUrls,
    buckets: mockS3Buckets,
    messages: mockMessages,
    containerState: mockContainerState,
  };
};

/**
 * Helper to assert S3 deployment occurred
 */
export const assertS3Deployment = (s3Client: any, bucketName: string) => {
  const putCalls = s3Client.send.mock.calls.filter(
    (call: any) => call[0] instanceof PutObjectCommand
  );
  
  expect(putCalls.length).toBeGreaterThan(0);
  
  const deploymentCall = putCalls.find((call: any) => 
    call[0].input.Bucket === bucketName
  );
  
  expect(deploymentCall).toBeDefined();
};

/**
 * Helper to assert message sent to queue
 */
export const assertMessageSentToQueue = (sqsClient: any, queueUrl: string) => {
  const sendCalls = sqsClient.send.mock.calls.filter(
    (call: any) => call[0] instanceof SendMessageCommand
  );
  
  const queueCall = sendCalls.find((call: any) => 
    call[0].input.QueueUrl === queueUrl
  );
  
  expect(queueCall).toBeDefined();
  return queueCall ? JSON.parse(queueCall[0].input.MessageBody) : null;
};

export default {
  createMockEnvironment,
  createMockSqsClient,
  createMockS3Client,
  createMockDynamoClient,
  mockMessages,
  mockQueueUrls,
  mockS3Buckets,
  mockContainerState,
  assertS3Deployment,
  assertMessageSentToQueue,
};