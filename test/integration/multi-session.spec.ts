import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ECSClient,
  DescribeTasksCommand,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import { v4 as uuidv4 } from 'uuid';

import { QueueManagerService } from '../../src/modules/sqs/queue-manager.service';
import { SqsMessageService } from '../../src/modules/sqs/sqs-message.service';
import { CommandExecutorService } from '../../src/modules/sqs/command-executor.service';
import { ContainerManagerService } from '../../src/modules/container/container-manager.service';
import { ThreadExtractorService } from '../../src/modules/message-processor/thread-extractor.service';
import { EditSessionService } from '../../src/modules/edit-session/services/edit-session.service';
import { QueueLifecycleService } from '../../src/modules/sqs/queue-lifecycle.service';

// Test client for Hermes operations
class HermesTestClient {
  constructor(
    private containerManager: ContainerManagerService,
    private commandExecutor: CommandExecutorService,
    private threadExtractor: ThreadExtractorService,
    private queueManager: QueueManagerService,
  ) {}

  async createSession(params: {
    clientId: string;
    projectId: string;
    userId: string;
    chatThreadId: string;
    instruction?: string;
  }) {
    // Extract thread ID
    const threadId = await this.threadExtractor.extractThreadId(
      { messageId: params.chatThreadId },
      'chat',
    );

    // Get or create session
    const session = await this.threadExtractor.getOrCreateSession(
      params.clientId,
      params.projectId,
      params.userId,
      threadId,
      'chat',
    );

    // Ensure container is running
    const container = await this.containerManager.ensureContainerRunning(
      params.clientId,
      params.projectId,
      params.userId,
      session.sessionId,
    );

    return {
      sessionId: session.sessionId,
      containerId: container.containerId,
      inputQueueUrl: container.inputQueueUrl,
      outputQueueUrl: container.outputQueueUrl,
      threadId,
      gitBranch: session.gitBranch,
    };
  }

  async sendCommand(params: {
    sessionId: string;
    instruction: string;
  }) {
    // Get session info
    const sessionParts = params.sessionId.split('-');
    const clientId = sessionParts[0];
    const projectId = sessionParts[1];
    const threadId = sessionParts.slice(2).join('-');

    // Get container for session
    const container = await this.containerManager.getContainerForSession(
      params.sessionId,
    );

    if (!container) {
      throw new Error(`No container found for session ${params.sessionId}`);
    }

    // Execute command
    const result = await this.commandExecutor.executeCommand(
      {
        containerId: container.containerId,
        inputUrl: container.inputQueueUrl,
        outputUrl: container.outputQueueUrl,
      },
      {
        sessionId: params.sessionId,
        type: 'edit',
        instruction: params.instruction,
        userEmail: 'test@example.com',
        chatThreadId: threadId,
        context: {
          branch: `thread-${threadId}`,
          clientId,
          projectId,
          userId: container.userId || 'test-user',
        },
      },
      30000, // 30 second timeout
    );

    return {
      commandId: result.commandId,
      success: result.success,
      summary: result.summary,
      interrupted: result.interrupted,
    };
  }

  async closeSession(sessionId: string) {
    await this.containerManager.releaseSession(sessionId);
  }
}

describe('Multi-Session SQS Architecture Integration Tests', () => {
  let module: TestingModule;
  let hermes: HermesTestClient;
  let sqs: SQSClient;
  let dynamodb: DynamoDBClient;
  let ecs: ECSClient;
  let containerManager: ContainerManagerService;
  let queueManager: QueueManagerService;

  beforeAll(async () => {
    // Initialize AWS clients
    sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-west-2' });
    dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' });
    ecs = new ECSClient({ region: process.env.AWS_REGION || 'us-west-2' });

    // Create test module
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        QueueManagerService,
        SqsMessageService,
        CommandExecutorService,
        ContainerManagerService,
        ThreadExtractorService,
        QueueLifecycleService,
        {
          provide: EditSessionService,
          useValue: {
            createSession: jest.fn().mockImplementation((sessionId, params) => ({
              sessionId,
              gitBranch: `thread-${params.chatThreadId}`,
              clientId: params.clientId,
              projectId: params.projectId,
              userId: params.userId,
            })),
            getSession: jest.fn(),
            updateSession: jest.fn(),
          },
        },
      ],
    }).compile();

    containerManager = module.get<ContainerManagerService>(ContainerManagerService);
    queueManager = module.get<QueueManagerService>(QueueManagerService);

    hermes = new HermesTestClient(
      containerManager,
      module.get<CommandExecutorService>(CommandExecutorService),
      module.get<ThreadExtractorService>(ThreadExtractorService),
      queueManager,
    );
  });

  afterAll(async () => {
    await module?.close();
  });

  describe('Container Sharing', () => {
    it('should reuse container for same user+project', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Start first session
      const session1 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-a',
        userId: 'user1@example.com',
        chatThreadId: 'thread-1',
        instruction: 'Add a hello world page',
      });

      // Get container info
      const container1 = await getContainerForSession(dynamodb, session1.sessionId);

      // Start second session for same user+project
      const session2 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-a',
        userId: 'user1@example.com',
        chatThreadId: 'thread-2',
        instruction: 'Add a contact page',
      });

      // Get container info
      const container2 = await getContainerForSession(dynamodb, session2.sessionId);

      // Should be same container
      expect(container1.containerId).toBe(container2.containerId);
      expect(session1.containerId).toBe(session2.containerId);
      
      // Different sessions should have different git branches
      expect(session1.gitBranch).toBe('thread-thread-1');
      expect(session2.gitBranch).toBe('thread-thread-2');

      // Cleanup
      await hermes.closeSession(session1.sessionId);
      await hermes.closeSession(session2.sessionId);
    }, 60000);

    it('should use different containers for different projects', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Start session for project A
      const sessionA = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-a',
        userId: 'user1@example.com',
        chatThreadId: 'thread-a',
      });

      // Start session for project B
      const sessionB = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-b',
        userId: 'user1@example.com',
        chatThreadId: 'thread-b',
      });

      // Should be different containers
      expect(sessionA.containerId).not.toBe(sessionB.containerId);
      expect(sessionA.containerId).toContain('project-a');
      expect(sessionB.containerId).toContain('project-b');

      // Cleanup
      await hermes.closeSession(sessionA.sessionId);
      await hermes.closeSession(sessionB.sessionId);
    }, 60000);

    it('should use different containers for different users', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Start session for user 1
      const session1 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-a',
        userId: 'user1@example.com',
        chatThreadId: 'thread-1',
      });

      // Start session for user 2
      const session2 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-a',
        userId: 'user2@example.com',
        chatThreadId: 'thread-2',
      });

      // Should be different containers
      expect(session1.containerId).not.toBe(session2.containerId);

      // Cleanup
      await hermes.closeSession(session1.sessionId);
      await hermes.closeSession(session2.sessionId);
    }, 60000);
  });

  describe('Interrupt Handling', () => {
    it('should interrupt current session when new message arrives', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Start long operation in session 1
      const session1 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-interrupt',
        userId: 'user1@example.com',
        chatThreadId: 'thread-1',
      });

      // Send long-running command (mock with sleep)
      const command1Promise = hermes.sendCommand({
        sessionId: session1.sessionId,
        instruction: 'Refactor all components to use TypeScript (this will take time)',
      });

      // Wait briefly for command to start processing
      await sleep(2000);

      // Send command to different session on same container
      const session2 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-interrupt',
        userId: 'user1@example.com',
        chatThreadId: 'thread-2',
      });

      const command2 = await hermes.sendCommand({
        sessionId: session2.sessionId,
        instruction: 'Add a simple header',
      });

      // Check session 1 was interrupted
      const response1 = await command1Promise;
      expect(response1.interrupted).toBe(true);
      expect(response1.summary).toContain('interrupted');

      // Check session 2 completed
      expect(command2.success).toBe(true);

      // Cleanup
      await hermes.closeSession(session1.sessionId);
      await hermes.closeSession(session2.sessionId);
    }, 60000);

    it('should handle multiple interrupts gracefully', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Create base session
      const session = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-multi-interrupt',
        userId: 'user1@example.com',
        chatThreadId: 'thread-base',
      });

      // Send multiple commands in rapid succession
      const commands = [];
      for (let i = 0; i < 3; i++) {
        commands.push(
          hermes.sendCommand({
            sessionId: session.sessionId,
            instruction: `Command ${i}`,
          }),
        );
        await sleep(500); // Small delay between commands
      }

      // Wait for all commands to resolve
      const results = await Promise.all(commands);

      // First two should be interrupted
      expect(results[0].interrupted).toBe(true);
      expect(results[1].interrupted).toBe(true);
      
      // Last one should succeed
      expect(results[2].success).toBe(true);
      expect(results[2].interrupted).toBeFalsy();

      // Cleanup
      await hermes.closeSession(session.sessionId);
    }, 60000);
  });

  describe('Queue Management', () => {
    it('should create one queue set per container', async () => {
      const testId = uuidv4().substring(0, 8);
      const containerId = `test-${testId}-project-user`;
      
      // Create session (which creates container and queues)
      const session = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project',
        userId: 'user',
        chatThreadId: 'thread-123',
      });

      // Verify queue names follow pattern
      expect(session.inputQueueUrl).toContain(`webordinary-input-${containerId}`);
      expect(session.outputQueueUrl).toContain(`webordinary-output-${containerId}`);

      // Verify queues exist in AWS
      const inputExists = await queueExists(sqs, session.inputQueueUrl);
      const outputExists = await queueExists(sqs, session.outputQueueUrl);
      
      expect(inputExists).toBe(true);
      expect(outputExists).toBe(true);

      // Cleanup
      await hermes.closeSession(session.sessionId);
      await queueManager.deleteContainerQueues(containerId);
    }, 60000);

    it('should persist queue URLs in DynamoDB', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Create session
      const session = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project',
        userId: 'user',
        chatThreadId: 'thread-456',
      });

      // Query DynamoDB for queue tracking
      const queueRecord = await dynamodb.send(
        new GetItemCommand({
          TableName: process.env.QUEUE_TRACKING_TABLE || 'webordinary-queue-tracking',
          Key: {
            containerId: { S: session.containerId },
          },
        }),
      );

      expect(queueRecord.Item).toBeDefined();
      expect(queueRecord.Item.inputQueueUrl.S).toBe(session.inputQueueUrl);
      expect(queueRecord.Item.outputQueueUrl.S).toBe(session.outputQueueUrl);

      // Cleanup
      await hermes.closeSession(session.sessionId);
    }, 60000);

    it('should handle queue lifecycle on container termination', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Create session
      const session = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project',
        userId: 'user',
        chatThreadId: 'thread-789',
      });

      const inputUrl = session.inputQueueUrl;
      const outputUrl = session.outputQueueUrl;

      // Verify queues exist
      expect(await queueExists(sqs, inputUrl)).toBe(true);
      expect(await queueExists(sqs, outputUrl)).toBe(true);

      // Simulate container termination
      await containerManager.handleContainerTermination(session.containerId);

      // Wait for cleanup
      await sleep(5000);

      // Verify queues deleted
      expect(await queueExists(sqs, inputUrl)).toBe(false);
      expect(await queueExists(sqs, outputUrl)).toBe(false);
    }, 60000);
  });

  describe('Message Processing', () => {
    it('should process messages in order within session', async () => {
      const testId = uuidv4().substring(0, 8);
      
      const session = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-ordered',
        userId: 'user1@example.com',
        chatThreadId: 'thread-1',
      });

      // Send multiple commands
      const commands = [];
      for (let i = 1; i <= 3; i++) {
        commands.push(
          await hermes.sendCommand({
            sessionId: session.sessionId,
            instruction: `Create file${i}.txt with content "${i}"`,
          }),
        );
        // Small delay to ensure ordering
        await sleep(1000);
      }

      // Verify all succeeded
      commands.forEach((cmd, index) => {
        expect(cmd.success).toBe(true);
        expect(cmd.summary).toContain(`file${index + 1}.txt`);
      });

      // Cleanup
      await hermes.closeSession(session.sessionId);
    }, 90000);

    it('should isolate messages between sessions', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Create two sessions on same container
      const session1 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-isolated',
        userId: 'user1@example.com',
        chatThreadId: 'thread-a',
      });

      const session2 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-isolated',
        userId: 'user1@example.com',
        chatThreadId: 'thread-b',
      });

      // Send commands to both sessions
      const [result1, result2] = await Promise.all([
        hermes.sendCommand({
          sessionId: session1.sessionId,
          instruction: 'Create session1.txt',
        }),
        hermes.sendCommand({
          sessionId: session2.sessionId,
          instruction: 'Create session2.txt',
        }),
      ]);

      // Both should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Results should be specific to each session
      expect(result1.summary).toContain('session1.txt');
      expect(result2.summary).toContain('session2.txt');

      // Cleanup
      await hermes.closeSession(session1.sessionId);
      await hermes.closeSession(session2.sessionId);
    }, 60000);
  });

  describe('Container Lifecycle', () => {
    it('should track session count correctly', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Start first session
      const session1 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-lifecycle',
        userId: 'user1@example.com',
        chatThreadId: 'thread-1',
      });

      // Check session count is 1
      let containerInfo = await getContainerInfo(dynamodb, session1.containerId);
      expect(containerInfo.sessionCount).toBe(1);

      // Add second session
      const session2 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-lifecycle',
        userId: 'user1@example.com',
        chatThreadId: 'thread-2',
      });

      // Check session count is 2
      containerInfo = await getContainerInfo(dynamodb, session2.containerId);
      expect(containerInfo.sessionCount).toBe(2);

      // Close first session
      await hermes.closeSession(session1.sessionId);

      // Check session count is 1
      containerInfo = await getContainerInfo(dynamodb, session2.containerId);
      expect(containerInfo.sessionCount).toBe(1);

      // Close second session
      await hermes.closeSession(session2.sessionId);

      // Check session count is 0
      containerInfo = await getContainerInfo(dynamodb, session2.containerId);
      expect(containerInfo.sessionCount).toBe(0);
    }, 60000);

    it('should handle container restart correctly', async () => {
      const testId = uuidv4().substring(0, 8);
      
      // Start session
      const session1 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-restart',
        userId: 'user1@example.com',
        chatThreadId: 'thread-1',
      });

      const originalContainerId = session1.containerId;

      // Simulate container stop
      await containerManager.handleContainerTermination(originalContainerId);

      // Wait for container to fully stop
      await sleep(5000);

      // Start new session for same user+project
      const session2 = await hermes.createSession({
        clientId: `test-${testId}`,
        projectId: 'project-restart',
        userId: 'user1@example.com',
        chatThreadId: 'thread-2',
      });

      // Should get same container ID (but new instance)
      expect(session2.containerId).toBe(originalContainerId);

      // Cleanup
      await hermes.closeSession(session2.sessionId);
    }, 60000);
  });
});

// Helper functions
async function getContainerForSession(
  dynamodb: DynamoDBClient,
  sessionId: string,
) {
  const session = await dynamodb.send(
    new GetItemCommand({
      TableName: process.env.SESSION_TABLE || 'webordinary-edit-sessions',
      Key: { sessionId: { S: sessionId } },
    }),
  );

  if (!session.Item?.containerId?.S) {
    throw new Error(`No container found for session ${sessionId}`);
  }

  const container = await dynamodb.send(
    new GetItemCommand({
      TableName: process.env.CONTAINER_TABLE || 'webordinary-containers',
      Key: { containerId: { S: session.Item.containerId.S } },
    }),
  );

  return {
    containerId: container.Item?.containerId?.S || session.Item.containerId.S,
    taskArn: container.Item?.taskArn?.S,
  };
}

async function getContainerInfo(dynamodb: DynamoDBClient, containerId: string) {
  const result = await dynamodb.send(
    new GetItemCommand({
      TableName: process.env.CONTAINER_TABLE || 'webordinary-containers',
      Key: { containerId: { S: containerId } },
    }),
  );

  return {
    containerId: result.Item?.containerId?.S,
    sessionCount: Number(result.Item?.sessionCount?.N || 0),
    status: result.Item?.status?.S,
  };
}

async function queueExists(sqs: SQSClient, queueUrl: string): Promise<boolean> {
  try {
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['CreatedTimestamp'],
      }),
    );
    return true;
  } catch (error) {
    if (error.name === 'QueueDoesNotExist') {
      return false;
    }
    throw error;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}