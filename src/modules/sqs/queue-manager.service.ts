import { Injectable, Logger } from '@nestjs/common';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  ListQueuesCommand,
  TagQueueCommand,
} from '@aws-sdk/client-sqs';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

export interface ContainerQueues {
  containerId: string;
  inputUrl: string;
  outputUrl: string;
  dlqUrl: string;
  inputArn?: string;
  outputArn?: string;
  dlqArn?: string;
}

export interface QueueTrackingRecord {
  containerId: string;
  clientId: string;
  projectId: string;
  userId: string;
  inputQueueUrl: string;
  outputQueueUrl: string;
  dlqQueueUrl: string;
  createdAt: number;
  lastActivity: number;
  status: 'active' | 'idle' | 'terminating';
}

@Injectable()
export class QueueManagerService {
  private readonly logger = new Logger(QueueManagerService.name);
  private readonly sqs: SQSClient;
  private readonly dynamodb: DynamoDBClient;
  private readonly region: string;
  private readonly tableName: string;

  constructor() {
    this.region = process.env.AWS_REGION || 'us-west-2';
    this.tableName = process.env.QUEUE_TRACKING_TABLE || 'webordinary-queue-tracking';
    
    this.sqs = new SQSClient({ region: this.region });
    this.dynamodb = new DynamoDBClient({ region: this.region });
  }

  /**
   * Creates all three queues for a container (input, output, DLQ)
   */
  async createContainerQueues(
    clientId: string,
    projectId: string,
    userId: string,
  ): Promise<ContainerQueues> {
    const containerId = `${clientId}-${projectId}-${userId}`;
    this.logger.log(`Creating queues for container: ${containerId}`);

    try {
      // Check if queues already exist
      const existing = await this.getContainerQueues(clientId, projectId, userId);
      if (existing) {
        this.logger.log(`Queues already exist for container: ${containerId}`);
        return existing;
      }

      // Create all three queues in parallel
      const [inputQueue, outputQueue, dlqQueue] = await Promise.all([
        this.createQueue(`webordinary-input-${containerId}`),
        this.createQueue(`webordinary-output-${containerId}`),
        this.createQueue(`webordinary-dlq-${containerId}`, true),
      ]);

      // Configure DLQ redrive policy on input queue
      await this.setRedrivePolicy(inputQueue.QueueUrl, dlqQueue.QueueArn);

      // Tag queues for cost tracking
      await Promise.all([
        this.tagQueue(inputQueue.QueueUrl, { clientId, projectId, userId }),
        this.tagQueue(outputQueue.QueueUrl, { clientId, projectId, userId }),
        this.tagQueue(dlqQueue.QueueUrl, { clientId, projectId, userId, type: 'dlq' }),
      ]);

      // Save queue information to DynamoDB
      await this.saveQueueTracking({
        containerId,
        clientId,
        projectId,
        userId,
        inputQueueUrl: inputQueue.QueueUrl,
        outputQueueUrl: outputQueue.QueueUrl,
        dlqQueueUrl: dlqQueue.QueueUrl,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        status: 'active',
      });

      this.logger.log(`Successfully created queues for container: ${containerId}`);

      return {
        containerId,
        inputUrl: inputQueue.QueueUrl,
        outputUrl: outputQueue.QueueUrl,
        dlqUrl: dlqQueue.QueueUrl,
        inputArn: inputQueue.QueueArn,
        outputArn: outputQueue.QueueArn,
        dlqArn: dlqQueue.QueueArn,
      };
    } catch (error) {
      this.logger.error(`Failed to create queues for container ${containerId}:`, error);
      throw error;
    }
  }

  /**
   * Gets existing container queues if they exist
   */
  async getContainerQueues(
    clientId: string,
    projectId: string,
    userId: string,
  ): Promise<ContainerQueues | null> {
    const containerId = `${clientId}-${projectId}-${userId}`;

    try {
      // Check DynamoDB for existing queues using Query since we have a composite key
      const result = await this.dynamodb.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'containerId = :containerId',
          ExpressionAttributeValues: {
            ':containerId': { S: containerId },
          },
          ScanIndexForward: false, // Get most recent first
          Limit: 1, // Only need the most recent record
        }),
      );

      if (!result.Items || result.Items.length === 0) {
        return null;
      }

      const item = result.Items[0];
      return {
        containerId,
        inputUrl: item.inputQueueUrl.S!,
        outputUrl: item.outputQueueUrl.S!,
        dlqUrl: item.dlqQueueUrl.S!,
      };
    } catch (error) {
      this.logger.error(`Failed to get queues for container ${containerId}:`, error);
      return null;
    }
  }

  /**
   * Deletes all queues for a container
   */
  async deleteContainerQueues(
    clientId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const containerId = `${clientId}-${projectId}-${userId}`;
    this.logger.log(`Deleting queues for container: ${containerId}`);

    try {
      // Get queue URLs from DynamoDB
      const queues = await this.getContainerQueues(clientId, projectId, userId);
      if (!queues) {
        this.logger.warn(`No queues found for container: ${containerId}`);
        return;
      }

      // Update status to terminating
      await this.updateQueueStatus(containerId, 'terminating');

      // Delete all queues in parallel
      await Promise.all([
        this.deleteQueue(queues.inputUrl),
        this.deleteQueue(queues.outputUrl),
        this.deleteQueue(queues.dlqUrl),
      ]);

      // Remove from DynamoDB
      await this.deleteQueueTracking(containerId);

      this.logger.log(`Successfully deleted queues for container: ${containerId}`);
    } catch (error) {
      this.logger.error(`Failed to delete queues for container ${containerId}:`, error);
      throw error;
    }
  }

  /**
   * Creates a single SQS queue
   */
  private async createQueue(
    queueName: string,
    isDlq: boolean = false,
  ): Promise<{ QueueUrl: string; QueueArn: string }> {
    try {
      const result = await this.sqs.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: {
            MessageRetentionPeriod: '345600', // 4 days
            ReceiveMessageWaitTimeSeconds: '20', // Long polling
            VisibilityTimeout: isDlq ? '60' : '300', // 1 minute for DLQ, 5 minutes for regular
          },
          tags: {
            Project: 'Webordinary',
            ManagedBy: 'Hermes',
            Type: isDlq ? 'DLQ' : 'Standard',
          },
        }),
      );

      // Get queue ARN
      const attrs = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: result.QueueUrl!,
          AttributeNames: ['QueueArn'],
        }),
      );

      return {
        QueueUrl: result.QueueUrl!,
        QueueArn: attrs.Attributes!.QueueArn!,
      };
    } catch (error: any) {
      // If queue already exists, get its URL
      if (error.name === 'QueueAlreadyExists') {
        const urlResult = await this.sqs.send(
          new GetQueueUrlCommand({ QueueName: queueName }),
        );
        
        const attrs = await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: urlResult.QueueUrl!,
            AttributeNames: ['QueueArn'],
          }),
        );

        return {
          QueueUrl: urlResult.QueueUrl!,
          QueueArn: attrs.Attributes!.QueueArn!,
        };
      }
      throw error;
    }
  }

  /**
   * Deletes a single SQS queue
   */
  private async deleteQueue(queueUrl: string): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteQueueCommand({
          QueueUrl: queueUrl,
        }),
      );
    } catch (error: any) {
      // Queue might not exist
      if (error.name !== 'AWS.SimpleQueueService.NonExistentQueue') {
        throw error;
      }
    }
  }

  /**
   * Sets up DLQ redrive policy
   */
  private async setRedrivePolicy(
    queueUrl: string,
    dlqArn: string,
  ): Promise<void> {
    await this.sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: 3,
          }),
        },
      }),
    );
  }

  /**
   * Tags a queue for cost tracking
   */
  private async tagQueue(
    queueUrl: string,
    tags: Record<string, string>,
  ): Promise<void> {
    await this.sqs.send(
      new TagQueueCommand({
        QueueUrl: queueUrl,
        Tags: {
          ...tags,
          Project: 'Webordinary',
          ManagedBy: 'Hermes',
        },
      }),
    );
  }

  /**
   * Saves queue tracking information to DynamoDB
   */
  private async saveQueueTracking(record: QueueTrackingRecord): Promise<void> {
    await this.dynamodb.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          containerId: { S: record.containerId },
          clientId: { S: record.clientId },
          projectId: { S: record.projectId },
          userId: { S: record.userId },
          clientProjectId: { S: `${record.clientId}-${record.projectId}` },
          inputQueueUrl: { S: record.inputQueueUrl },
          outputQueueUrl: { S: record.outputQueueUrl },
          dlqQueueUrl: { S: record.dlqQueueUrl },
          createdAt: { N: record.createdAt.toString() },
          lastActivity: { N: record.lastActivity.toString() },
          status: { S: record.status },
        },
      }),
    );
  }

  /**
   * Deletes queue tracking from DynamoDB
   */
  private async deleteQueueTracking(containerId: string): Promise<void> {
    // First query to get the item with the complete key
    const queryResult = await this.dynamodb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'containerId = :containerId',
        ExpressionAttributeValues: {
          ':containerId': { S: containerId },
        },
        Limit: 1,
      }),
    );

    if (queryResult.Items && queryResult.Items.length > 0) {
      const item = queryResult.Items[0];
      await this.dynamodb.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: {
            containerId: { S: containerId },
            createdAt: { N: item.createdAt.N! },
          },
        }),
      );
    }
  }

  /**
   * Updates queue status in DynamoDB
   */
  private async updateQueueStatus(
    containerId: string,
    status: 'active' | 'idle' | 'terminating',
  ): Promise<void> {
    // First get the record to obtain the complete key
    const queryResult = await this.dynamodb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'containerId = :containerId',
        ExpressionAttributeValues: {
          ':containerId': { S: containerId },
        },
        Limit: 1,
      }),
    );

    if (!queryResult.Items || queryResult.Items.length === 0) {
      this.logger.warn(`No record found to update status for container: ${containerId}`);
      return;
    }

    const item = queryResult.Items[0];
    
    await this.dynamodb.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: {
          containerId: { S: containerId },
          createdAt: { N: item.createdAt.N! },
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
   * Lists all active queues for a user
   */
  async listUserQueues(userId: string): Promise<QueueTrackingRecord[]> {
    const result = await this.dynamodb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': { S: userId },
        },
      }),
    );

    return (result.Items || []).map((item) => ({
      containerId: item.containerId.S!,
      clientId: item.clientId.S!,
      projectId: item.projectId.S!,
      userId: item.userId.S!,
      inputQueueUrl: item.inputQueueUrl.S!,
      outputQueueUrl: item.outputQueueUrl.S!,
      dlqQueueUrl: item.dlqQueueUrl.S!,
      createdAt: parseInt(item.createdAt.N!),
      lastActivity: parseInt(item.lastActivity.N!),
      status: item.status.S as 'active' | 'idle' | 'terminating',
    }));
  }

  /**
   * Cleanup idle queues (for scheduled tasks)
   */
  async cleanupIdleQueues(idleThresholdMinutes: number = 30): Promise<void> {
    const cutoffTime = Date.now() - idleThresholdMinutes * 60 * 1000;

    // List all queues
    const result = await this.sqs.send(
      new ListQueuesCommand({
        QueueNamePrefix: 'webordinary-',
      }),
    );

    if (!result.QueueUrls) {
      return;
    }

    for (const queueUrl of result.QueueUrls) {
      try {
        // Get queue attributes
        const attrs = await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ['LastModifiedTimestamp', 'ApproximateNumberOfMessages'],
          }),
        );

        const lastModified = parseInt(attrs.Attributes!.LastModifiedTimestamp!) * 1000;
        const messageCount = parseInt(attrs.Attributes!.ApproximateNumberOfMessages!);

        // Delete if idle and empty
        if (lastModified < cutoffTime && messageCount === 0) {
          this.logger.log(`Cleaning up idle queue: ${queueUrl}`);
          await this.deleteQueue(queueUrl);
        }
      } catch (error) {
        this.logger.error(`Failed to check queue ${queueUrl}:`, error);
      }
    }
  }
}