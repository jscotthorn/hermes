import { Injectable, Logger } from '@nestjs/common';
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { v4 as uuidv4 } from 'uuid';

export interface EditMessage {
  sessionId: string;
  commandId: string;
  timestamp: number;
  type: 'edit' | 'build' | 'commit' | 'push' | 'preview' | 'interrupt';
  instruction: string;
  userEmail: string;
  chatThreadId: string;
  context: {
    branch: string;
    lastCommit?: string;
    filesModified?: string[];
    clientId: string;
    projectId: string;
    userId: string;
  };
}

export interface ResponseMessage {
  sessionId: string;
  commandId: string;
  timestamp: number;
  success: boolean;
  summary: string;
  filesChanged?: string[];
  error?: string;
  previewUrl?: string;
  interrupted?: boolean;
  completedAt: number;
}

@Injectable()
export class SqsMessageService {
  private readonly logger = new Logger(SqsMessageService.name);
  private readonly sqs: SQSClient;
  private readonly region: string;

  constructor() {
    this.region = process.env.AWS_REGION || 'us-west-2';
    this.sqs = new SQSClient({ region: this.region });
  }

  /**
   * Sends an edit command to the container's input queue
   */
  async sendEditCommand(
    queueUrl: string,
    message: Omit<EditMessage, 'commandId' | 'timestamp'>,
  ): Promise<string> {
    const commandId = uuidv4();
    const fullMessage: EditMessage = {
      ...message,
      commandId,
      timestamp: Date.now(),
    };

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(fullMessage),
          MessageAttributes: {
            Type: {
              DataType: 'String',
              StringValue: message.type,
            },
            SessionId: {
              DataType: 'String',
              StringValue: message.sessionId,
            },
            ChatThreadId: {
              DataType: 'String',
              StringValue: message.chatThreadId,
            },
          },
        }),
      );

      this.logger.log(`Sent ${message.type} command ${commandId} to queue`);
      return commandId;
    } catch (error) {
      this.logger.error(`Failed to send message to queue ${queueUrl}:`, error);
      throw error;
    }
  }

  /**
   * Sends an interrupt signal to stop current work
   */
  async sendInterrupt(
    queueUrl: string,
    sessionId: string,
    chatThreadId: string,
  ): Promise<string> {
    const commandId = uuidv4();
    const message = {
      sessionId,
      commandId,
      timestamp: Date.now(),
      type: 'interrupt' as const,
      instruction: 'INTERRUPT: Stop current work and prepare for new instruction',
      userEmail: 'system@webordinary.com',
      chatThreadId,
      context: {
        branch: `thread-${chatThreadId}`,
        clientId: '',
        projectId: '',
        userId: '',
      },
    };

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            Type: {
              DataType: 'String',
              StringValue: 'interrupt',
            },
            Priority: {
              DataType: 'String',
              StringValue: 'high',
            },
            SessionId: {
              DataType: 'String',
              StringValue: sessionId,
            },
          },
          // Use delay of 0 for immediate delivery of interrupts
          DelaySeconds: 0,
        }),
      );

      this.logger.log(`Sent interrupt signal ${commandId} to queue`);
      return commandId;
    } catch (error) {
      this.logger.error(`Failed to send interrupt:`, error);
      throw error;
    }
  }

  /**
   * Polls for response messages from the output queue
   */
  async receiveResponse(
    queueUrl: string,
    waitTimeSeconds: number = 5,
  ): Promise<ResponseMessage | null> {
    try {
      const result = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: waitTimeSeconds,
          MessageAttributeNames: ['All'],
        }),
      );

      if (!result.Messages || result.Messages.length === 0) {
        return null;
      }

      const message = result.Messages[0];
      const response = JSON.parse(message.Body!) as ResponseMessage;

      // Delete the message after processing
      await this.deleteMessage(queueUrl, message.ReceiptHandle!);

      return response;
    } catch (error) {
      this.logger.error(`Failed to receive message from queue ${queueUrl}:`, error);
      return null;
    }
  }

  /**
   * Deletes a message from the queue
   */
  private async deleteMessage(
    queueUrl: string,
    receiptHandle: string,
  ): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (error) {
      this.logger.error(`Failed to delete message from queue:`, error);
    }
  }

  /**
   * Batch sends multiple messages
   */
  async sendBatch(
    queueUrl: string,
    messages: Array<Omit<EditMessage, 'commandId' | 'timestamp'>>,
  ): Promise<string[]> {
    const commandIds: string[] = [];

    // SQS batch is limited to 10 messages
    for (let i = 0; i < messages.length; i += 10) {
      const batch = messages.slice(i, i + 10);
      const batchIds = await Promise.all(
        batch.map((msg) => this.sendEditCommand(queueUrl, msg)),
      );
      commandIds.push(...batchIds);
    }

    return commandIds;
  }

  /**
   * Waits for a specific command response
   */
  async waitForResponse(
    queueUrl: string,
    commandId: string,
    timeoutSeconds: number = 300,
  ): Promise<ResponseMessage | null> {
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const response = await this.receiveResponse(queueUrl, 5);
      
      if (response && response.commandId === commandId) {
        return response;
      }

      // If we got a different response, log it but continue waiting
      if (response) {
        this.logger.debug(
          `Received response for different command: ${response.commandId}`,
        );
      }

      // Brief pause before next poll
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.logger.warn(`Timeout waiting for response to command ${commandId}`);
    return null;
  }

  /**
   * Purges all messages from a queue (useful for cleanup)
   */
  async purgeQueue(queueUrl: string): Promise<void> {
    try {
      // Note: PurgeQueue has a 60-second limit between calls
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ type: 'purge', timestamp: Date.now() }),
        }),
      );
      this.logger.log(`Purged queue: ${queueUrl}`);
    } catch (error) {
      this.logger.error(`Failed to purge queue ${queueUrl}:`, error);
      throw error;
    }
  }
}