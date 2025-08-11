import { Injectable, Logger } from '@nestjs/common';
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ECSClient,
  DescribeTasksCommand,
  UpdateServiceCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { EditSession } from './edit-session.service';
import { FargateManagerService } from './fargate-manager.service';

export interface SessionInfo {
  sessionId: string;
  containerId: string;
  containerIp?: string;
  status: 'running' | 'idle' | 'stopped' | 'starting' | 'unknown';
  taskArn?: string;
}

export interface ContainerInfo {
  containerId: string;
  containerIp?: string;
  status: 'running' | 'idle' | 'stopped' | 'starting';
  taskArn?: string;
  lastActivity: number;
  managementQueueUrl?: string;
}

export interface IncomingMessage {
  threadId: string;
  clientId: string;
  userId: string;
  instruction: string;
  messageId: string;
}

@Injectable()
export class SessionResumptionService {
  private readonly logger = new Logger(SessionResumptionService.name);
  private readonly dynamoClient: DynamoDBClient;
  private readonly ecsClient: ECSClient;
  private readonly sqsClient: SQSClient;
  private readonly clusterName = 'webordinary-edit-cluster';
  private readonly serviceName = 'webordinary-edit-service';

  constructor(private readonly fargateManager: FargateManagerService) {
    this.dynamoClient = new DynamoDBClient({ region: 'us-west-2' });
    this.ecsClient = new ECSClient({ region: 'us-west-2' });
    this.sqsClient = new SQSClient({ region: 'us-west-2' });
  }

  /**
   * Resume or start a session for an incoming message
   */
  async resumeSession(
    sessionId: string,
    message: IncomingMessage,
  ): Promise<SessionInfo> {
    this.logger.log(`Resuming session ${sessionId} for message ${message.messageId}`);

    // Get session info
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Generate containerId if not present (for legacy sessions)
    const containerId = session.containerId || `${session.clientId}-${session.threadId}-${session.userId}`;
    
    // Check container state
    const container = await this.getContainer(containerId);

    switch (container?.status) {
      case 'running':
        this.logger.log(`Container ${container.containerId} already running`);
        await this.updateContainerActivity(container.containerId);
        return {
          sessionId,
          containerId,
          containerIp: container.containerIp,
          status: 'running',
          taskArn: container.taskArn,
        };

      case 'idle':
        this.logger.log(`Container ${container.containerId} is idle, sending wake signal`);
        await this.wakeIdleContainer(container);
        return {
          sessionId,
          containerId,
          containerIp: container.containerIp,
          status: 'running',
          taskArn: container.taskArn,
        };

      case 'stopped':
      case undefined:
        this.logger.log(`Starting container for ${containerId}`);
        const containerInfo = await this.startContainer(session);
        return {
          sessionId,
          containerId,
          containerIp: containerInfo.containerIp,
          status: 'running',
          taskArn: containerInfo.taskArn,
        };

      case 'starting':
        this.logger.log(`Container ${container.containerId} is starting, waiting...`);
        await this.waitForContainer(container.containerId);
        const updatedContainer = await this.getContainer(containerId);
        return {
          sessionId,
          containerId,
          containerIp: updatedContainer?.containerIp,
          status: updatedContainer?.status || 'unknown',
          taskArn: updatedContainer?.taskArn,
        };

      default:
        throw new Error(`Unknown container status: ${container?.status || 'null'}`);
    }
  }

  /**
   * Resume session for a preview URL request
   */
  async resumeSessionForPreview(chatThreadId: string, clientId: string): Promise<SessionInfo | null> {
    this.logger.log(`Resuming session for preview: ${chatThreadId}`);

    // Find session by thread ID
    const sessionMapping = await this.findSessionByThreadId(chatThreadId);
    if (!sessionMapping) {
      return null;
    }

    // Use the resumeSession logic
    const mockMessage: IncomingMessage = {
      threadId: chatThreadId,
      clientId,
      userId: 'preview-user',
      instruction: 'Preview URL access',
      messageId: `preview-${Date.now()}`,
    };

    return await this.resumeSession(sessionMapping.sessionId, mockMessage);
  }

  private async startContainer(session: EditSession): Promise<ContainerInfo> {
    const { clientId, userId } = this.parseContainerId(session.sessionId);

    // Update container status to 'starting'
    await this.updateContainerStatus(session.sessionId, 'starting');

    // Start Fargate task using existing fargate manager
    const { taskArn, containerIp } = await this.fargateManager.startTask({
      sessionId: session.sessionId,
      clientId: session.clientId,
      userId: session.userId,
      threadId: session.threadId,
    });

    // Wait for container to be ready
    await this.waitForContainerHealth(taskArn);

    // Update container info
    await this.dynamoClient.send(
      new UpdateItemCommand({
        TableName: 'webordinary-containers',
        Key: { containerId: { S: session.sessionId } },
        UpdateExpression: `
          SET taskArn = :taskArn,
              containerIp = :ip,
              #status = :status,
              lastActivity = :now,
              lastStarted = :now
        `,
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':taskArn': { S: taskArn },
          ':ip': { S: containerIp },
          ':status': { S: 'running' },
          ':now': { N: Date.now().toString() },
        },
      }),
    );

    this.logger.log(`Container ${session.sessionId} started successfully`);
    return {
      containerId: session.sessionId,
      containerIp,
      status: 'running',
      taskArn,
      lastActivity: Date.now(),
    };
  }

  private async wakeIdleContainer(container: ContainerInfo): Promise<void> {
    // Send a wake message to the container's management queue if available
    if (container.managementQueueUrl) {
      const wakeMessage = {
        type: 'wake',
        timestamp: Date.now(),
        reason: 'session_resumed',
      };

      await this.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: container.managementQueueUrl,
          MessageBody: JSON.stringify(wakeMessage),
        }),
      );
    }

    // Update container status and activity
    await this.dynamoClient.send(
      new UpdateItemCommand({
        TableName: 'webordinary-containers',
        Key: { containerId: { S: container.containerId } },
        UpdateExpression: 'SET #status = :status, lastActivity = :now',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': { S: 'running' },
          ':now': { N: Date.now().toString() },
        },
      }),
    );

    this.logger.log(`Container ${container.containerId} woken from idle state`);
  }

  private async waitForContainer(
    containerId: string,
    timeout: number = 60000,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const container = await this.getContainer(containerId);

      if (container?.status === 'running') {
        this.logger.log(`Container ${containerId} is now running`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(`Container ${containerId} failed to start within ${timeout}ms`);
  }

  private async waitForContainerHealth(
    taskArn: string,
    timeout: number = 120000,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const task = await this.ecsClient.send(
        new DescribeTasksCommand({
          cluster: this.clusterName,
          tasks: [taskArn],
        }),
      );

      const taskStatus = task.tasks?.[0];
      if (!taskStatus) {
        throw new Error(`Task ${taskArn} not found`);
      }

      // Check if task is running and healthy
      if (taskStatus.lastStatus === 'RUNNING') {
        const healthStatus = taskStatus.healthStatus;
        if (healthStatus === 'HEALTHY' || !healthStatus) {
          // No health check or healthy
          this.logger.log(`Task ${taskArn} is healthy`);
          return;
        }
      } else if (taskStatus.lastStatus === 'STOPPED') {
        throw new Error(`Task ${taskArn} stopped unexpectedly: ${taskStatus.stoppedReason}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(`Task ${taskArn} failed to become healthy within ${timeout}ms`);
  }

  private async getSession(sessionId: string): Promise<EditSession | null> {
    try {
      const result = await this.dynamoClient.send(
        new GetItemCommand({
          TableName: 'webordinary-edit-sessions',
          Key: {
            sessionId: { S: sessionId },
            userId: { S: '*' }, // We'll need to handle this properly
          },
        }),
      );

      if (!result.Item) {
        return null;
      }

      return this.unmarshallSession(result.Item);
    } catch (error) {
      this.logger.error(`Error getting session ${sessionId}:`, error);
      return null;
    }
  }

  private async getContainer(containerId: string): Promise<ContainerInfo | null> {
    try {
      const result = await this.dynamoClient.send(
        new GetItemCommand({
          TableName: 'webordinary-containers',
          Key: {
            containerId: { S: containerId },
          },
        }),
      );

      if (!result.Item) {
        return null;
      }

      return {
        containerId: result.Item.containerId.S!,
        containerIp: result.Item.containerIp?.S,
        status: (result.Item.status?.S as any) || 'unknown',
        taskArn: result.Item.taskArn?.S,
        lastActivity: parseInt(result.Item.lastActivity?.N || '0'),
        managementQueueUrl: result.Item.managementQueueUrl?.S,
      };
    } catch (error) {
      this.logger.error(`Error getting container ${containerId}:`, error);
      return null;
    }
  }

  private async findSessionByThreadId(chatThreadId: string): Promise<{ sessionId: string } | null> {
    try {
      const result = await this.dynamoClient.send(
        new QueryCommand({
          TableName: 'webordinary-thread-mappings',
          KeyConditionExpression: 'threadId = :threadId',
          ExpressionAttributeValues: {
            ':threadId': { S: chatThreadId },
          },
          Limit: 1,
        }),
      );

      if (!result.Items || result.Items.length === 0) {
        return null;
      }

      const item = result.Items[0];
      return {
        sessionId: item.sessionId?.S || '',
      };
    } catch (error) {
      this.logger.error('Error finding session by thread ID:', error);
      return null;
    }
  }

  private async updateContainerStatus(containerId: string, status: string): Promise<void> {
    await this.dynamoClient.send(
      new UpdateItemCommand({
        TableName: 'webordinary-containers',
        Key: { containerId: { S: containerId } },
        UpdateExpression: 'SET #status = :status, lastActivity = :now',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': { S: status },
          ':now': { N: Date.now().toString() },
        },
      }),
    );
  }

  private async updateContainerActivity(containerId: string): Promise<void> {
    await this.dynamoClient.send(
      new UpdateItemCommand({
        TableName: 'webordinary-containers',
        Key: { containerId: { S: containerId } },
        UpdateExpression: 'SET lastActivity = :now',
        ExpressionAttributeValues: {
          ':now': { N: Date.now().toString() },
        },
      }),
    );
  }

  private parseContainerId(containerId: string): { clientId: string; userId: string } {
    // Assuming containerId format: sessionId or client-project-user format
    // For now, we'll extract from the containerId, but this might need adjustment
    return {
      clientId: 'ameliastamps', // Default for now
      userId: 'scott',
    };
  }

  private unmarshallSession(item: any): EditSession {
    return {
      sessionId: item.sessionId.S!,
      userId: item.userId.S!,
      clientId: item.clientId.S!,
      threadId: item.threadId.S!,
      status: item.status.S as any,
      lastActivity: parseInt(item.lastActivity.N!),
      ttl: parseInt(item.ttl.N!),
      editBranch: item.editBranch.S!,
      createdAt: item.createdAt.S!,
      fargateTaskArn: item.fargateTaskArn?.S,
      containerIp: item.containerIp?.S,
      previewUrl: item.previewUrl?.S,
    };
  }
}