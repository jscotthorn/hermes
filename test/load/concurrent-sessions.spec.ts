import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import {
  SQSClient,
  ListQueuesCommand,
} from '@aws-sdk/client-sqs';
import {
  DynamoDBClient,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import { v4 as uuidv4 } from 'uuid';

import { QueueManagerService } from '../../src/modules/sqs/queue-manager.service';
import { SqsMessageService } from '../../src/modules/sqs/sqs-message.service';
import { CommandExecutorService } from '../../src/modules/sqs/command-executor.service';
import { ContainerManagerService } from '../../src/modules/container/container-manager.service';
import { ThreadExtractorService } from '../../src/modules/message-processor/thread-extractor.service';
import { EditSessionService } from '../../src/modules/edit-session/services/edit-session.service';
import { QueueLifecycleService } from '../../src/modules/sqs/queue-lifecycle.service';

interface SessionResult {
  sessionId: string;
  containerId: string;
  inputQueueUrl: string;
  outputQueueUrl: string;
  threadId: string;
  gitBranch: string;
  commandResults?: any[];
}

interface LoadTestMetrics {
  totalSessions: number;
  successfulSessions: number;
  failedSessions: number;
  averageResponseTime: number;
  maxResponseTime: number;
  minResponseTime: number;
  containersCreated: number;
  queueSetsCreated: number;
  interruptsHandled: number;
  totalDuration: number;
}

// Test client for load testing
class LoadTestClient {
  private metrics: LoadTestMetrics = {
    totalSessions: 0,
    successfulSessions: 0,
    failedSessions: 0,
    averageResponseTime: 0,
    maxResponseTime: 0,
    minResponseTime: Infinity,
    containersCreated: 0,
    queueSetsCreated: 0,
    interruptsHandled: 0,
    totalDuration: 0,
  };

  private responseTimes: number[] = [];

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
  }): Promise<SessionResult> {
    const startTime = Date.now();
    this.metrics.totalSessions++;

    try {
      const threadId = await this.threadExtractor.extractThreadId(
        { messageId: params.chatThreadId },
        'chat',
      );

      const session = await this.threadExtractor.getOrCreateSession(
        params.clientId,
        params.projectId,
        params.userId,
        threadId,
        'chat',
      );

      const container = await this.containerManager.ensureContainerRunning(
        params.clientId,
        params.projectId,
        params.userId,
        session.sessionId,
      );

      const responseTime = Date.now() - startTime;
      this.recordResponseTime(responseTime);
      this.metrics.successfulSessions++;

      return {
        sessionId: session.sessionId,
        containerId: container.containerId,
        inputQueueUrl: container.inputQueueUrl,
        outputQueueUrl: container.outputQueueUrl,
        threadId,
        gitBranch: session.gitBranch,
      };
    } catch (error) {
      this.metrics.failedSessions++;
      throw error;
    }
  }

  async sendCommand(
    session: SessionResult,
    instruction: string,
  ): Promise<any> {
    const startTime = Date.now();

    const sessionParts = session.sessionId.split('-');
    const clientId = sessionParts[0];
    const projectId = sessionParts[1];

    const result = await this.commandExecutor.executeCommand(
      {
        containerId: session.containerId,
        inputUrl: session.inputQueueUrl,
        outputUrl: session.outputQueueUrl,
      },
      {
        sessionId: session.sessionId,
        type: 'edit',
        instruction,
        userEmail: 'loadtest@example.com',
        chatThreadId: session.threadId,
        context: {
          branch: session.gitBranch,
          clientId,
          projectId,
          userId: 'loadtest-user',
        },
      },
      30000,
    );

    const responseTime = Date.now() - startTime;
    this.recordResponseTime(responseTime);

    if (result.interrupted) {
      this.metrics.interruptsHandled++;
    }

    return result;
  }

  private recordResponseTime(time: number) {
    this.responseTimes.push(time);
    this.metrics.maxResponseTime = Math.max(
      this.metrics.maxResponseTime,
      time,
    );
    this.metrics.minResponseTime = Math.min(
      this.metrics.minResponseTime,
      time,
    );
  }

  getMetrics(): LoadTestMetrics {
    if (this.responseTimes.length > 0) {
      const sum = this.responseTimes.reduce((a, b) => a + b, 0);
      this.metrics.averageResponseTime = sum / this.responseTimes.length;
    }
    return this.metrics;
  }

  resetMetrics() {
    this.metrics = {
      totalSessions: 0,
      successfulSessions: 0,
      failedSessions: 0,
      averageResponseTime: 0,
      maxResponseTime: 0,
      minResponseTime: Infinity,
      containersCreated: 0,
      queueSetsCreated: 0,
      interruptsHandled: 0,
      totalDuration: 0,
    };
    this.responseTimes = [];
  }
}

describe('Load Testing - Concurrent Sessions', () => {
  let module: TestingModule;
  let loadTestClient: LoadTestClient;
  let sqs: SQSClient;
  let dynamodb: DynamoDBClient;
  let ecs: ECSClient;

  beforeAll(async () => {
    // Initialize AWS clients
    sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-west-2' });
    dynamodb = new DynamoDBClient({
      region: process.env.AWS_REGION || 'us-west-2',
    });
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
            createSession: jest
              .fn()
              .mockImplementation((sessionId, params) => ({
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

    loadTestClient = new LoadTestClient(
      module.get<ContainerManagerService>(ContainerManagerService),
      module.get<CommandExecutorService>(CommandExecutorService),
      module.get<ThreadExtractorService>(ThreadExtractorService),
      module.get<QueueManagerService>(QueueManagerService),
    );
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(() => {
    loadTestClient.resetMetrics();
  });

  describe('Concurrent Session Creation', () => {
    it('should handle 10 concurrent sessions across 3 projects', async () => {
      const testId = uuidv4().substring(0, 8);
      const startTime = Date.now();
      const sessions: SessionResult[] = [];

      // Create 10 sessions across 3 projects
      const sessionPromises = [];
      for (let i = 0; i < 10; i++) {
        const projectId = `project-${i % 3}`;
        const userId = `user${Math.floor(i / 3)}@example.com`;

        sessionPromises.push(
          loadTestClient.createSession({
            clientId: `load-${testId}`,
            projectId,
            userId,
            chatThreadId: `thread-${i}`,
          }),
        );
      }

      // Wait for all sessions to be created
      const results = await Promise.allSettled(sessionPromises);
      
      // Collect successful sessions
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          sessions.push(result.value);
        }
      });

      const metrics = loadTestClient.getMetrics();
      metrics.totalDuration = Date.now() - startTime;

      // Assertions
      expect(metrics.successfulSessions).toBeGreaterThanOrEqual(8); // Allow some failures
      expect(metrics.failedSessions).toBeLessThanOrEqual(2);
      expect(metrics.averageResponseTime).toBeLessThan(5000); // Average under 5 seconds

      // Verify container count
      const containerIds = new Set(sessions.map((s) => s.containerId));
      expect(containerIds.size).toBeLessThanOrEqual(6); // Should share containers

      // Log metrics for analysis
      console.log('Load Test Metrics (10 sessions):', {
        ...metrics,
        uniqueContainers: containerIds.size,
      });

      // Cleanup
      await Promise.all(
        sessions.map((s) =>
          module
            .get<ContainerManagerService>(ContainerManagerService)
            .releaseSession(s.sessionId),
        ),
      );
    }, 120000); // 2 minute timeout

    it('should handle 25 concurrent sessions with mixed operations', async () => {
      const testId = uuidv4().substring(0, 8);
      const startTime = Date.now();
      const sessions: SessionResult[] = [];

      // Create 25 sessions across 5 projects
      const sessionPromises = [];
      for (let i = 0; i < 25; i++) {
        const projectId = `project-${i % 5}`;
        const userId = `user${Math.floor(i / 5)}@example.com`;

        sessionPromises.push(
          loadTestClient.createSession({
            clientId: `load-${testId}`,
            projectId,
            userId,
            chatThreadId: `thread-${i}`,
          }),
        );
      }

      // Wait for all sessions to be created
      const results = await Promise.allSettled(sessionPromises);
      
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          sessions.push(result.value);
        }
      });

      // Send commands to half of the sessions
      const commandPromises = [];
      for (let i = 0; i < Math.min(sessions.length, 12); i++) {
        commandPromises.push(
          loadTestClient.sendCommand(
            sessions[i],
            `Load test command ${i}`,
          ),
        );
      }

      const commandResults = await Promise.allSettled(commandPromises);
      const successfulCommands = commandResults.filter(
        (r) => r.status === 'fulfilled',
      ).length;

      const metrics = loadTestClient.getMetrics();
      metrics.totalDuration = Date.now() - startTime;

      // Assertions
      expect(metrics.successfulSessions).toBeGreaterThanOrEqual(20);
      expect(successfulCommands).toBeGreaterThanOrEqual(8);
      expect(metrics.averageResponseTime).toBeLessThan(10000); // Average under 10 seconds

      // Log metrics
      console.log('Load Test Metrics (25 sessions with commands):', {
        ...metrics,
        successfulCommands,
      });

      // Cleanup
      await Promise.all(
        sessions.map((s) =>
          module
            .get<ContainerManagerService>(ContainerManagerService)
            .releaseSession(s.sessionId),
        ),
      );
    }, 180000); // 3 minute timeout
  });

  describe('Burst Load Testing', () => {
    it('should handle burst of 15 sessions in rapid succession', async () => {
      const testId = uuidv4().substring(0, 8);
      const sessions: SessionResult[] = [];

      // Create sessions in rapid succession (no delay)
      for (let i = 0; i < 15; i++) {
        try {
          const session = await loadTestClient.createSession({
            clientId: `burst-${testId}`,
            projectId: `project-${i % 3}`,
            userId: `user${i % 5}@example.com`,
            chatThreadId: `thread-${i}`,
          });
          sessions.push(session);
        } catch (error) {
          console.error(`Failed to create session ${i}:`, error.message);
        }
      }

      const metrics = loadTestClient.getMetrics();

      // Assertions
      expect(metrics.successfulSessions).toBeGreaterThanOrEqual(12);
      expect(metrics.maxResponseTime).toBeLessThan(15000); // Max under 15 seconds

      // Log metrics
      console.log('Burst Load Test Metrics:', metrics);

      // Cleanup
      await Promise.all(
        sessions.map((s) =>
          module
            .get<ContainerManagerService>(ContainerManagerService)
            .releaseSession(s.sessionId),
        ),
      );
    }, 180000);
  });

  describe('Sustained Load Testing', () => {
    it('should maintain performance under sustained load', async () => {
      const testId = uuidv4().substring(0, 8);
      const duration = 60000; // 1 minute
      const sessionsPerSecond = 2;
      const startTime = Date.now();
      const sessions: SessionResult[] = [];

      while (Date.now() - startTime < duration) {
        const batchPromises = [];
        
        // Create batch of sessions
        for (let i = 0; i < sessionsPerSecond; i++) {
          batchPromises.push(
            loadTestClient.createSession({
              clientId: `sustained-${testId}`,
              projectId: `project-${i % 3}`,
              userId: `user${i % 5}@example.com`,
              chatThreadId: `thread-${Date.now()}-${i}`,
            }),
          );
        }

        const results = await Promise.allSettled(batchPromises);
        results.forEach((result) => {
          if (result.status === 'fulfilled') {
            sessions.push(result.value);
          }
        });

        // Wait before next batch
        await sleep(1000);
      }

      const metrics = loadTestClient.getMetrics();
      metrics.totalDuration = Date.now() - startTime;

      // Calculate success rate
      const successRate =
        (metrics.successfulSessions / metrics.totalSessions) * 100;

      // Assertions
      expect(successRate).toBeGreaterThan(90); // 90% success rate
      expect(metrics.averageResponseTime).toBeLessThan(5000);

      // Log metrics
      console.log('Sustained Load Test Metrics:', {
        ...metrics,
        successRate: `${successRate.toFixed(2)}%`,
        sessionsPerMinute: metrics.totalSessions,
      });

      // Cleanup
      await Promise.all(
        sessions.map((s) =>
          module
            .get<ContainerManagerService>(ContainerManagerService)
            .releaseSession(s.sessionId),
        ),
      );
    }, 120000); // 2 minute timeout for 1 minute test
  });

  describe('Resource Monitoring', () => {
    it('should track resource usage during load', async () => {
      const testId = uuidv4().substring(0, 8);
      const startTime = Date.now();

      // Get initial resource state
      const initialQueues = await countQueues(sqs);
      const initialContainers = await countContainers(ecs);

      // Create load
      const sessions: SessionResult[] = [];
      for (let i = 0; i < 10; i++) {
        try {
          const session = await loadTestClient.createSession({
            clientId: `monitor-${testId}`,
            projectId: `project-${i % 2}`,
            userId: `user${i % 3}@example.com`,
            chatThreadId: `thread-${i}`,
          });
          sessions.push(session);
        } catch (error) {
          console.error(`Failed to create session ${i}:`, error.message);
        }
      }

      // Get resource state after load
      const finalQueues = await countQueues(sqs);
      const finalContainers = await countContainers(ecs);

      const resourceMetrics = {
        queuesCreated: finalQueues - initialQueues,
        containersCreated: finalContainers - initialContainers,
        sessionsCreated: sessions.length,
        duration: Date.now() - startTime,
      };

      // Log resource metrics
      console.log('Resource Usage Metrics:', resourceMetrics);

      // Assertions
      expect(resourceMetrics.queuesCreated).toBeGreaterThanOrEqual(0);
      expect(resourceMetrics.containersCreated).toBeGreaterThanOrEqual(0);
      expect(resourceMetrics.containersCreated).toBeLessThanOrEqual(6); // Should share

      // Cleanup
      await Promise.all(
        sessions.map((s) =>
          module
            .get<ContainerManagerService>(ContainerManagerService)
            .releaseSession(s.sessionId),
        ),
      );
    }, 120000);
  });
});

// Helper functions
async function countQueues(sqs: SQSClient): Promise<number> {
  try {
    const result = await sqs.send(
      new ListQueuesCommand({
        QueueNamePrefix: 'webordinary-',
      }),
    );
    return result.QueueUrls?.length || 0;
  } catch (error) {
    console.error('Error counting queues:', error);
    return 0;
  }
}

async function countContainers(ecs: ECSClient): Promise<number> {
  try {
    const clusterArn =
      process.env.ECS_CLUSTER_ARN ||
      'arn:aws:ecs:us-west-2:942734823970:cluster/webordinary-edit-cluster';

    const tasks = await ecs.send(
      new ListTasksCommand({
        cluster: clusterArn,
        desiredStatus: 'RUNNING',
      }),
    );

    return tasks.taskArns?.length || 0;
  } catch (error) {
    console.error('Error counting containers:', error);
    return 0;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}