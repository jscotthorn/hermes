import { Injectable, Logger } from '@nestjs/common';
import {
  SQSClient,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import {
  DynamoDBClient,
  DeleteItemCommand,
  ScanCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';

export interface QueueLifecycleEvent {
  type: 'created' | 'deleted' | 'orphaned' | 'cleaned';
  containerId: string;
  queueUrls?: {
    input?: string;
    output?: string;
    dlq?: string;
  };
  timestamp: number;
  reason?: string;
}

export interface OrphanedQueue {
  queueUrl: string;
  queueName: string;
  containerId: string;
  createdTimestamp: number;
  ageHours: number;
  messageCount: number;
}

@Injectable()
export class QueueLifecycleService {
  private readonly logger = new Logger(QueueLifecycleService.name);
  private readonly sqs: SQSClient;
  private readonly dynamodb: DynamoDBClient;
  private readonly region: string;
  private readonly queueTable: string;
  private readonly containerTable: string;

  constructor(private readonly eventEmitter: EventEmitter2) {
    this.region = process.env.AWS_REGION || 'us-west-2';
    this.queueTable = process.env.QUEUE_TRACKING_TABLE || 'webordinary-queue-tracking';
    this.containerTable = process.env.CONTAINER_TABLE || 'webordinary-containers';

    this.sqs = new SQSClient({ region: this.region });
    this.dynamodb = new DynamoDBClient({ region: this.region });
  }

  /**
   * Cleans up queues when a container terminates
   */
  async cleanupContainerQueues(
    clientId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const containerId = `${clientId}-${projectId}-${userId}`;

    this.logger.log(`Cleaning up queues for container: ${containerId}`);

    try {
      // Get queue URLs from DynamoDB
      const queueInfo = await this.getQueueInfo(containerId);

      if (!queueInfo) {
        this.logger.warn(`No queue info found for container: ${containerId}`);
        return;
      }

      // Delete all queues in parallel
      const deletionResults = await Promise.allSettled([
        this.deleteQueueSafely(queueInfo.inputQueueUrl, 'input'),
        this.deleteQueueSafely(queueInfo.outputQueueUrl, 'output'),
        this.deleteQueueSafely(queueInfo.dlqUrl, 'dlq'),
      ]);

      // Log any failures
      deletionResults.forEach((result, index) => {
        const queueType = ['input', 'output', 'dlq'][index];
        if (result.status === 'rejected') {
          this.logger.error(`Failed to delete ${queueType} queue: ${result.reason}`);
        }
      });

      // Remove queue info from DynamoDB
      await this.deleteQueueInfo(containerId);

      // Emit lifecycle event
      this.eventEmitter.emit('queue.lifecycle', {
        type: 'deleted',
        containerId,
        queueUrls: {
          input: queueInfo.inputQueueUrl,
          output: queueInfo.outputQueueUrl,
          dlq: queueInfo.dlqUrl,
        },
        timestamp: Date.now(),
        reason: 'Container terminated',
      } as QueueLifecycleEvent);

      this.logger.log(`Queue cleanup complete for container: ${containerId}`);
    } catch (error) {
      this.logger.error(`Failed to cleanup queues for ${containerId}:`, error);
      throw error;
    }
  }

  /**
   * Safely deletes a queue with error handling
   */
  private async deleteQueueSafely(
    queueUrl: string | undefined,
    queueType: string,
  ): Promise<void> {
    if (!queueUrl) {
      this.logger.debug(`No ${queueType} queue URL provided`);
      return;
    }

    try {
      // Check if queue has messages before deleting
      const attributes = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
          ],
        }),
      );

      const messagesInQueue =
        parseInt(attributes.Attributes?.ApproximateNumberOfMessages || '0') +
        parseInt(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible || '0');

      if (messagesInQueue > 0) {
        this.logger.warn(
          `${queueType} queue has ${messagesInQueue} messages, archiving before deletion`,
        );
        // Could implement message archiving here if needed
      }

      // Delete the queue
      await this.sqs.send(
        new DeleteQueueCommand({
          QueueUrl: queueUrl,
        }),
      );

      this.logger.debug(`Deleted ${queueType} queue: ${queueUrl}`);
    } catch (error: any) {
      if (error.name === 'QueueDoesNotExist') {
        this.logger.debug(`${queueType} queue already deleted: ${queueUrl}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Finds orphaned queues (queues without active containers)
   */
  async findOrphanedQueues(): Promise<OrphanedQueue[]> {
    const orphanedQueues: OrphanedQueue[] = [];

    try {
      // List all Webordinary queues
      const listResult = await this.sqs.send(
        new ListQueuesCommand({
          QueueNamePrefix: 'webordinary-',
        }),
      );

      if (!listResult.QueueUrls || listResult.QueueUrls.length === 0) {
        return orphanedQueues;
      }

      // Get all active containers from DynamoDB
      const activeContainers = await this.getActiveContainers();
      const activeContainerIds = new Set(activeContainers.map((c) => c.containerId));

      // Check each queue
      for (const queueUrl of listResult.QueueUrls) {
        const queueName = queueUrl.split('/').pop()!;

        // Extract container ID from queue name
        // Format: webordinary-{type}-{clientId}-{projectId}-{userId}
        const match = queueName.match(/^webordinary-(?:input|output|dlq)-(.+)$/);

        if (match) {
          const containerId = match[1];

          if (!activeContainerIds.has(containerId)) {
            // Get queue age and message count
            try {
              const attrs = await this.sqs.send(
                new GetQueueAttributesCommand({
                  QueueUrl: queueUrl,
                  AttributeNames: [
                    'CreatedTimestamp',
                    'ApproximateNumberOfMessages',
                  ],
                }),
              );

              const createdAt = parseInt(attrs.Attributes?.CreatedTimestamp || '0') * 1000;
              const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);
              const messageCount = parseInt(
                attrs.Attributes?.ApproximateNumberOfMessages || '0',
              );

              // Only consider queues older than 1 hour as orphaned
              if (ageHours > 1) {
                orphanedQueues.push({
                  queueUrl,
                  queueName,
                  containerId,
                  createdTimestamp: createdAt,
                  ageHours,
                  messageCount,
                });

                this.logger.warn(
                  `Found orphaned queue: ${queueName} (${ageHours.toFixed(1)}h old, ${messageCount} messages)`,
                );
              }
            } catch (error) {
              this.logger.error(`Failed to get attributes for queue ${queueUrl}:`, error);
            }
          }
        }
      }

      return orphanedQueues;
    } catch (error) {
      this.logger.error('Failed to find orphaned queues:', error);
      return orphanedQueues;
    }
  }

  /**
   * Cleans up orphaned queues
   */
  async cleanupOrphanedQueues(
    maxAgeHours: number = 24,
  ): Promise<{ deleted: number; failed: number }> {
    const orphanedQueues = await this.findOrphanedQueues();
    let deleted = 0;
    let failed = 0;

    for (const orphan of orphanedQueues) {
      if (orphan.ageHours > maxAgeHours) {
        try {
          // Archive messages if needed
          if (orphan.messageCount > 0) {
            this.logger.warn(
              `Archiving ${orphan.messageCount} messages from orphaned queue ${orphan.queueName}`,
            );
            // Could implement S3 archiving here
          }

          // Delete the queue
          await this.sqs.send(
            new DeleteQueueCommand({
              QueueUrl: orphan.queueUrl,
            }),
          );

          deleted++;
          this.logger.log(
            `Deleted orphaned queue: ${orphan.queueName} (${orphan.ageHours.toFixed(1)}h old)`,
          );

          // Emit lifecycle event
          this.eventEmitter.emit('queue.lifecycle', {
            type: 'cleaned',
            containerId: orphan.containerId,
            timestamp: Date.now(),
            reason: `Orphaned for ${orphan.ageHours.toFixed(1)} hours`,
          } as QueueLifecycleEvent);
        } catch (error) {
          failed++;
          this.logger.error(`Failed to delete orphaned queue ${orphan.queueUrl}:`, error);
        }
      }
    }

    this.logger.log(
      `Orphaned queue cleanup complete: ${deleted} deleted, ${failed} failed`,
    );

    return { deleted, failed };
  }

  /**
   * Scheduled cleanup task (runs every 6 hours)
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async scheduledCleanup(): Promise<void> {
    this.logger.log('Starting scheduled queue cleanup...');

    try {
      const result = await this.cleanupOrphanedQueues(24);

      if (result.deleted > 0 || result.failed > 0) {
        this.logger.log(
          `Scheduled cleanup: ${result.deleted} queues deleted, ${result.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error('Scheduled cleanup failed:', error);
    }
  }

  /**
   * Handles container termination events
   */
  async handleContainerTermination(event: {
    containerId: string;
    reason?: string;
  }): Promise<void> {
    this.logger.log(`Handling container termination: ${event.containerId}`);

    // Parse container ID to get components
    const parts = event.containerId.split('-');
    if (parts.length >= 3) {
      const userId = parts.pop()!;
      const projectId = parts.pop()!;
      const clientId = parts.join('-');

      await this.cleanupContainerQueues(clientId, projectId, userId);
    }
  }

  /**
   * Purges all messages from container queues (for testing/debugging)
   */
  async purgeContainerQueues(
    clientId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const containerId = `${clientId}-${projectId}-${userId}`;

    this.logger.warn(`Purging all messages from queues for container: ${containerId}`);

    const queueInfo = await this.getQueueInfo(containerId);
    if (!queueInfo) {
      this.logger.warn(`No queue info found for container: ${containerId}`);
      return;
    }

    const purgeResults = await Promise.allSettled([
      queueInfo.inputQueueUrl && this.purgeQueue(queueInfo.inputQueueUrl),
      queueInfo.outputQueueUrl && this.purgeQueue(queueInfo.outputQueueUrl),
      // Don't purge DLQ - keep for debugging
    ]);

    purgeResults.forEach((result, index) => {
      const queueType = ['input', 'output'][index];
      if (result.status === 'rejected') {
        this.logger.error(`Failed to purge ${queueType} queue: ${result.reason}`);
      }
    });
  }

  /**
   * Purges a single queue
   */
  private async purgeQueue(queueUrl: string): Promise<void> {
    try {
      await this.sqs.send(
        new PurgeQueueCommand({
          QueueUrl: queueUrl,
        }),
      );
      this.logger.debug(`Purged queue: ${queueUrl}`);
    } catch (error: any) {
      // Purge has a 60-second cooldown
      if (error.name === 'PurgeQueueInProgress') {
        this.logger.warn(`Queue purge already in progress: ${queueUrl}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Gets queue info from DynamoDB
   */
  private async getQueueInfo(containerId: string): Promise<any> {
    try {
      const result = await this.dynamodb.send(
        new GetItemCommand({
          TableName: this.queueTable,
          Key: {
            containerId: { S: containerId },
          },
        }),
      );

      if (!result.Item) {
        return null;
      }

      return {
        containerId: result.Item.containerId.S,
        inputQueueUrl: result.Item.inputQueueUrl?.S,
        outputQueueUrl: result.Item.outputQueueUrl?.S,
        dlqUrl: result.Item.dlqUrl?.S,
        createdAt: parseInt(result.Item.createdAt?.N || '0'),
      };
    } catch (error) {
      this.logger.error(`Failed to get queue info for ${containerId}:`, error);
      return null;
    }
  }

  /**
   * Deletes queue info from DynamoDB
   */
  private async deleteQueueInfo(containerId: string): Promise<void> {
    try {
      await this.dynamodb.send(
        new DeleteItemCommand({
          TableName: this.queueTable,
          Key: {
            containerId: { S: containerId },
          },
        }),
      );
      this.logger.debug(`Deleted queue info for container: ${containerId}`);
    } catch (error) {
      this.logger.error(`Failed to delete queue info for ${containerId}:`, error);
    }
  }

  /**
   * Gets active containers from DynamoDB
   */
  private async getActiveContainers(): Promise<any[]> {
    try {
      const result = await this.dynamodb.send(
        new ScanCommand({
          TableName: this.containerTable,
          FilterExpression: '#status IN (:running, :starting)',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':running': { S: 'running' },
            ':starting': { S: 'starting' },
          },
          ProjectionExpression: 'containerId',
        }),
      );

      return (result.Items || []).map((item) => ({
        containerId: item.containerId.S!,
      }));
    } catch (error) {
      this.logger.error('Failed to get active containers:', error);
      return [];
    }
  }

  /**
   * Gets queue metrics for monitoring
   */
  async getQueueMetrics(containerId: string): Promise<{
    input: { messages: number; age: number };
    output: { messages: number; age: number };
    dlq: { messages: number; age: number };
  } | null> {
    const queueInfo = await this.getQueueInfo(containerId);
    if (!queueInfo) {
      return null;
    }

    const metrics = {
      input: { messages: 0, age: 0 },
      output: { messages: 0, age: 0 },
      dlq: { messages: 0, age: 0 },
    };

    const queueTypes: Array<{ url: string; type: 'input' | 'output' | 'dlq' }> = [
      { url: queueInfo.inputQueueUrl, type: 'input' },
      { url: queueInfo.outputQueueUrl, type: 'output' },
      { url: queueInfo.dlqUrl, type: 'dlq' },
    ];

    for (const { url, type } of queueTypes) {
      if (url) {
        try {
          const attrs = await this.sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: url,
              AttributeNames: [
                'ApproximateNumberOfMessages',
                'CreatedTimestamp',
              ],
            }),
          );

          metrics[type].messages = parseInt(
            attrs.Attributes?.ApproximateNumberOfMessages || '0',
          );
          metrics[type].age =
            Date.now() - parseInt(attrs.Attributes?.CreatedTimestamp || '0') * 1000;
        } catch (error) {
          this.logger.error(`Failed to get metrics for ${type} queue:`, error);
        }
      }
    }

    return metrics;
  }

  /**
   * Lists all active queues with their metrics
   */
  async listActiveQueues(): Promise<
    Array<{
      containerId: string;
      queueType: string;
      messageCount: number;
      ageHours: number;
    }>
  > {
    const activeQueues: Array<{
      containerId: string;
      queueType: string;
      messageCount: number;
      ageHours: number;
    }> = [];

    try {
      const listResult = await this.sqs.send(
        new ListQueuesCommand({
          QueueNamePrefix: 'webordinary-',
        }),
      );

      if (!listResult.QueueUrls) {
        return activeQueues;
      }

      for (const queueUrl of listResult.QueueUrls) {
        const queueName = queueUrl.split('/').pop()!;
        const match = queueName.match(/^webordinary-(input|output|dlq)-(.+)$/);

        if (match) {
          const [, queueType, containerId] = match;

          try {
            const attrs = await this.sqs.send(
              new GetQueueAttributesCommand({
                QueueUrl: queueUrl,
                AttributeNames: [
                  'ApproximateNumberOfMessages',
                  'CreatedTimestamp',
                ],
              }),
            );

            const messageCount = parseInt(
              attrs.Attributes?.ApproximateNumberOfMessages || '0',
            );
            const createdAt = parseInt(attrs.Attributes?.CreatedTimestamp || '0') * 1000;
            const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);

            activeQueues.push({
              containerId,
              queueType,
              messageCount,
              ageHours,
            });
          } catch (error) {
            this.logger.error(`Failed to get attributes for ${queueUrl}:`, error);
          }
        }
      }

      return activeQueues;
    } catch (error) {
      this.logger.error('Failed to list active queues:', error);
      return activeQueues;
    }
  }
}