import { Injectable, Logger } from '@nestjs/common';
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  TaskDefinition,
} from '@aws-sdk/client-ecs';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { ContainerQueues } from '../sqs/queue-manager.service';

export interface ContainerInfo {
  containerId: string;
  taskArn: string;
  containerIp?: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped';
  clientId: string;
  projectId: string;
  userId: string;
  inputQueueUrl: string;
  outputQueueUrl: string;
  dlqUrl: string;
  createdAt: number;
  lastActivity: number;
  sessionCount: number;
}

export interface ContainerSession {
  sessionId: string;
  containerId: string;
  chatThreadId: string;
  inputQueueUrl: string;
  outputQueueUrl: string;
  createdAt: number;
  lastActivity: number;
  status: 'active' | 'idle' | 'terminated';
}

@Injectable()
export class ContainerManagerService {
  private readonly logger = new Logger(ContainerManagerService.name);
  private readonly ecs: ECSClient;
  private readonly dynamodb: DynamoDBClient;
  private readonly region: string;
  private readonly clusterArn: string;
  private readonly taskDefinitionArn: string;
  private readonly subnets: string[];
  private readonly securityGroups: string[];
  private readonly containerCache: Map<string, ContainerInfo> = new Map();

  constructor() {
    this.region = process.env.AWS_REGION || 'us-west-2';
    this.clusterArn = process.env.ECS_CLUSTER_ARN || 'arn:aws:ecs:us-west-2:942734823970:cluster/webordinary-edit-cluster';
    this.taskDefinitionArn = process.env.TASK_DEFINITION_ARN || 'webordinary-edit-task:latest';
    this.subnets = (process.env.SUBNETS || '').split(',').filter(Boolean);
    this.securityGroups = (process.env.SECURITY_GROUPS || '').split(',').filter(Boolean);
    
    this.ecs = new ECSClient({ region: this.region });
    this.dynamodb = new DynamoDBClient({ region: this.region });
  }

  /**
   * Ensures a container is running for the given user+project
   */
  async ensureContainerRunning(
    clientId: string,
    projectId: string,
    userId: string,
    queues: ContainerQueues,
  ): Promise<ContainerInfo> {
    const containerId = `${clientId}-${projectId}-${userId}`;
    
    this.logger.log(`Ensuring container ${containerId} is running`);

    // Check cache first
    if (this.containerCache.has(containerId)) {
      const cached = this.containerCache.get(containerId)!;
      if (cached.status === 'running') {
        this.logger.debug(`Container ${containerId} found in cache`);
        return cached;
      }
    }

    // Check DynamoDB for existing container
    const existing = await this.getContainerInfo(containerId);
    if (existing && existing.status === 'running') {
      // Verify container is actually running in ECS
      const isRunning = await this.verifyContainerRunning(existing.taskArn);
      if (isRunning) {
        this.logger.log(`Container ${containerId} is already running`);
        this.containerCache.set(containerId, existing);
        return existing;
      } else {
        this.logger.warn(`Container ${containerId} marked as running but not found in ECS`);
        await this.updateContainerStatus(containerId, 'stopped');
      }
    }

    // Start new container
    this.logger.log(`Starting new container ${containerId}`);
    const containerInfo = await this.startContainer(
      clientId,
      projectId,
      userId,
      queues,
    );

    // Cache the container info
    this.containerCache.set(containerId, containerInfo);

    return containerInfo;
  }

  /**
   * Starts a new Fargate container
   */
  private async startContainer(
    clientId: string,
    projectId: string,
    userId: string,
    queues: ContainerQueues,
  ): Promise<ContainerInfo> {
    const containerId = `${clientId}-${projectId}-${userId}`;

    try {
      // Get the GitHub repo URL for this client/project
      const repoUrl = this.getRepoUrl(clientId, projectId);

      // Run Fargate task with environment variables
      const taskResponse = await this.ecs.send(
        new RunTaskCommand({
          cluster: this.clusterArn,
          taskDefinition: this.taskDefinitionArn,
          launchType: 'FARGATE',
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: this.subnets,
              securityGroups: this.securityGroups,
              assignPublicIp: 'ENABLED',
            },
          },
          overrides: {
            containerOverrides: [
              {
                name: 'claude-code-astro',
                environment: [
                  { name: 'INPUT_QUEUE_URL', value: queues.inputUrl },
                  { name: 'OUTPUT_QUEUE_URL', value: queues.outputUrl },
                  { name: 'DLQ_URL', value: queues.dlqUrl },
                  { name: 'CLIENT_ID', value: clientId },
                  { name: 'PROJECT_ID', value: projectId },
                  { name: 'USER_ID', value: userId },
                  { name: 'CONTAINER_ID', value: containerId },
                  { name: 'WORKSPACE_PATH', value: `/workspace/${clientId}/${projectId}` },
                  { name: 'REPO_URL', value: repoUrl },
                  { name: 'AUTO_SHUTDOWN_MINUTES', value: '20' },
                  { name: 'AWS_REGION', value: this.region },
                ],
              },
            ],
          },
          tags: [
            { key: 'ContainerId', value: containerId },
            { key: 'ClientId', value: clientId },
            { key: 'ProjectId', value: projectId },
            { key: 'UserId', value: userId },
            { key: 'ManagedBy', value: 'Hermes' },
          ],
        }),
      );

      if (!taskResponse.tasks || taskResponse.tasks.length === 0) {
        throw new Error('Failed to start container task');
      }

      const task = taskResponse.tasks[0];
      const taskArn = task.taskArn!;

      this.logger.log(`Started container task ${taskArn} for ${containerId}`);

      // Wait for container to be running
      const containerIp = await this.waitForContainerReady(taskArn);

      // Create container info record
      const containerInfo: ContainerInfo = {
        containerId,
        taskArn,
        containerIp,
        status: 'running',
        clientId,
        projectId,
        userId,
        inputQueueUrl: queues.inputUrl,
        outputQueueUrl: queues.outputUrl,
        dlqUrl: queues.dlqUrl || '',
        createdAt: Date.now(),
        lastActivity: Date.now(),
        sessionCount: 0,
      };

      // Save to DynamoDB
      await this.saveContainerInfo(containerInfo);

      return containerInfo;
    } catch (error) {
      this.logger.error(`Failed to start container ${containerId}:`, error);
      throw error;
    }
  }

  /**
   * Waits for container to be ready
   */
  private async waitForContainerReady(
    taskArn: string,
    maxWaitTime: number = 60000,
  ): Promise<string | undefined> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        const response = await this.ecs.send(
          new DescribeTasksCommand({
            cluster: this.clusterArn,
            tasks: [taskArn],
          }),
        );

        if (response.tasks && response.tasks.length > 0) {
          const task = response.tasks[0];
          
          if (task.lastStatus === 'RUNNING') {
            // Get container IP from network interface
            const attachment = task.attachments?.find(
              (a) => a.type === 'ElasticNetworkInterface',
            );
            
            const privateIp = attachment?.details?.find(
              (d) => d.name === 'privateIPv4Address',
            )?.value;

            this.logger.log(`Container task ${taskArn} is running with IP ${privateIp}`);
            return privateIp;
          } else if (task.lastStatus === 'STOPPED') {
            throw new Error(`Container task stopped: ${task.stoppedReason}`);
          }
        }

        // Wait before checking again
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        this.logger.error(`Error checking container status:`, error);
        throw error;
      }
    }

    throw new Error(`Container did not start within ${maxWaitTime}ms`);
  }

  /**
   * Verifies if a container is actually running in ECS
   */
  private async verifyContainerRunning(taskArn: string): Promise<boolean> {
    try {
      const response = await this.ecs.send(
        new DescribeTasksCommand({
          cluster: this.clusterArn,
          tasks: [taskArn],
        }),
      );

      if (response.tasks && response.tasks.length > 0) {
        const task = response.tasks[0];
        return task.lastStatus === 'RUNNING';
      }

      return false;
    } catch (error) {
      this.logger.error(`Failed to verify container status:`, error);
      return false;
    }
  }

  /**
   * Stops a container
   */
  async stopContainer(
    clientId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const containerId = `${clientId}-${projectId}-${userId}`;
    
    this.logger.log(`Stopping container ${containerId}`);

    // Get container info
    const containerInfo = await this.getContainerInfo(containerId);
    if (!containerInfo) {
      this.logger.warn(`Container ${containerId} not found`);
      return;
    }

    try {
      // Stop the ECS task
      await this.ecs.send(
        new StopTaskCommand({
          cluster: this.clusterArn,
          task: containerInfo.taskArn,
          reason: 'Container stopped by Hermes',
        }),
      );

      // Update status in DynamoDB
      await this.updateContainerStatus(containerId, 'stopped');

      // Remove from cache
      this.containerCache.delete(containerId);

      this.logger.log(`Container ${containerId} stopped successfully`);
    } catch (error) {
      this.logger.error(`Failed to stop container ${containerId}:`, error);
      throw error;
    }
  }

  /**
   * Assigns a session to a container
   */
  async assignSessionToContainer(
    sessionId: string,
    containerId: string,
    chatThreadId: string,
    queueUrls: { inputUrl: string; outputUrl: string },
  ): Promise<void> {
    this.logger.debug(`Assigning session ${sessionId} to container ${containerId}`);

    // Save session-to-container mapping
    await this.dynamodb.send(
      new PutItemCommand({
        TableName: 'webordinary-edit-sessions',
        Item: {
          sessionId: { S: sessionId },
          containerId: { S: containerId },
          chatThreadId: { S: chatThreadId },
          inputQueueUrl: { S: queueUrls.inputUrl },
          outputQueueUrl: { S: queueUrls.outputUrl },
          createdAt: { N: Date.now().toString() },
          lastActivity: { N: Date.now().toString() },
          status: { S: 'active' },
        },
      }),
    );

    // Increment session count on container
    await this.dynamodb.send(
      new UpdateItemCommand({
        TableName: 'webordinary-containers',
        Key: {
          containerId: { S: containerId },
        },
        UpdateExpression: 'ADD sessionCount :inc SET lastActivity = :now',
        ExpressionAttributeValues: {
          ':inc': { N: '1' },
          ':now': { N: Date.now().toString() },
        },
      }),
    );

    this.logger.debug(`Session ${sessionId} assigned to container ${containerId}`);
  }

  /**
   * Releases a session from its container
   */
  async releaseSession(sessionId: string): Promise<void> {
    this.logger.debug(`Releasing session ${sessionId}`);

    // Get session info
    const result = await this.dynamodb.send(
      new GetItemCommand({
        TableName: 'webordinary-edit-sessions',
        Key: {
          sessionId: { S: sessionId },
        },
      }),
    );

    if (result.Item?.containerId) {
      const containerId = result.Item.containerId.S!;

      // Decrement session count
      const updateResult = await this.dynamodb.send(
        new UpdateItemCommand({
          TableName: 'webordinary-containers',
          Key: {
            containerId: { S: containerId },
          },
          UpdateExpression: 'ADD sessionCount :dec SET lastActivity = :now',
          ExpressionAttributeValues: {
            ':dec': { N: '-1' },
            ':now': { N: Date.now().toString() },
          },
          ReturnValues: 'ALL_NEW',
        }),
      );

      const newSessionCount = parseInt(updateResult.Attributes?.sessionCount?.N || '0');
      
      if (newSessionCount === 0) {
        this.logger.log(`Container ${containerId} has no active sessions, will auto-shutdown`);
      }
    }

    // Delete session record
    await this.dynamodb.send(
      new DeleteItemCommand({
        TableName: 'webordinary-edit-sessions',
        Key: {
          sessionId: { S: sessionId },
        },
      }),
    );

    this.logger.debug(`Session ${sessionId} released`);
  }

  /**
   * Gets container info from DynamoDB
   */
  private async getContainerInfo(containerId: string): Promise<ContainerInfo | null> {
    try {
      const result = await this.dynamodb.send(
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
        taskArn: result.Item.taskArn.S!,
        containerIp: result.Item.containerIp?.S,
        status: result.Item.status.S as any,
        clientId: result.Item.clientId.S!,
        projectId: result.Item.projectId.S!,
        userId: result.Item.userId.S!,
        inputQueueUrl: result.Item.inputQueueUrl.S!,
        outputQueueUrl: result.Item.outputQueueUrl.S!,
        dlqUrl: result.Item.dlqUrl?.S || '',
        createdAt: parseInt(result.Item.createdAt.N!),
        lastActivity: parseInt(result.Item.lastActivity.N!),
        sessionCount: parseInt(result.Item.sessionCount?.N || '0'),
      };
    } catch (error) {
      this.logger.error(`Failed to get container info for ${containerId}:`, error);
      return null;
    }
  }

  /**
   * Saves container info to DynamoDB
   */
  private async saveContainerInfo(containerInfo: ContainerInfo): Promise<void> {
    await this.dynamodb.send(
      new PutItemCommand({
        TableName: 'webordinary-containers',
        Item: {
          containerId: { S: containerInfo.containerId },
          taskArn: { S: containerInfo.taskArn },
          ...(containerInfo.containerIp && { containerIp: { S: containerInfo.containerIp } }),
          status: { S: containerInfo.status },
          clientId: { S: containerInfo.clientId },
          projectId: { S: containerInfo.projectId },
          userId: { S: containerInfo.userId },
          inputQueueUrl: { S: containerInfo.inputQueueUrl },
          outputQueueUrl: { S: containerInfo.outputQueueUrl },
          ...(containerInfo.dlqUrl && { dlqUrl: { S: containerInfo.dlqUrl } }),
          createdAt: { N: containerInfo.createdAt.toString() },
          lastActivity: { N: containerInfo.lastActivity.toString() },
          sessionCount: { N: containerInfo.sessionCount.toString() },
          ttl: { N: (Math.floor(Date.now() / 1000) + 86400).toString() }, // 24 hour TTL
        },
      }),
    );
  }

  /**
   * Updates container status in DynamoDB
   */
  private async updateContainerStatus(
    containerId: string,
    status: string,
  ): Promise<void> {
    await this.dynamodb.send(
      new UpdateItemCommand({
        TableName: 'webordinary-containers',
        Key: {
          containerId: { S: containerId },
        },
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

  /**
   * Gets the GitHub repo URL for a client/project
   */
  private getRepoUrl(clientId: string, projectId: string): string {
    // This could be looked up from a config table
    // For now, using a simple mapping
    const repoMap: Record<string, string> = {
      'ameliastamps-website': 'https://github.com/ameliastamps/amelia-astro.git',
      // Add more mappings as needed
    };

    return repoMap[`${clientId}-${projectId}`] || '';
  }

  /**
   * Lists all active containers
   */
  async listActiveContainers(): Promise<ContainerInfo[]> {
    try {
      const response = await this.ecs.send(
        new ListTasksCommand({
          cluster: this.clusterArn,
          desiredStatus: 'RUNNING',
        }),
      );

      if (!response.taskArns || response.taskArns.length === 0) {
        return [];
      }

      const tasksResponse = await this.ecs.send(
        new DescribeTasksCommand({
          cluster: this.clusterArn,
          tasks: response.taskArns,
        }),
      );

      const containers: ContainerInfo[] = [];

      for (const task of tasksResponse.tasks || []) {
        const containerIdTag = task.tags?.find((t) => t.key === 'ContainerId');
        if (containerIdTag) {
          const containerInfo = await this.getContainerInfo(containerIdTag.value!);
          if (containerInfo) {
            containers.push(containerInfo);
          }
        }
      }

      return containers;
    } catch (error) {
      this.logger.error('Failed to list active containers:', error);
      return [];
    }
  }
}