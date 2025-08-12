import { Injectable, Logger } from '@nestjs/common';
import {
  SQSClient,
  SendMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';

export interface ProjectConfig {
  projectId: string;
  userId: string;
  email: string;
  defaultInstruction?: string;
}

export interface RoutingDecision {
  projectId: string;
  userId: string;
  inputQueueUrl: string;
  outputQueueUrl: string;
  needsUnclaimed: boolean;
}

@Injectable()
export class MessageRouterService {
  private readonly logger = new Logger(MessageRouterService.name);
  private readonly sqs: SQSClient;
  private readonly dynamodb: DynamoDBClient;
  private readonly accountId: string;
  private readonly region: string;
  
  // Hardcoded project config for MVP - will move to DynamoDB later
  private readonly projectConfigs: Map<string, ProjectConfig> = new Map([
    ['escottster@gmail.com', {
      projectId: 'ameliastamps',
      userId: 'scott',
      email: 'escottster@gmail.com',
      defaultInstruction: 'Help with Amelia Stamps website'
    }],
  ]);

  constructor() {
    this.sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-west-2' });
    this.dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' });
    this.accountId = process.env.AWS_ACCOUNT_ID || '942734823970';
    this.region = process.env.AWS_REGION || 'us-west-2';
  }

  /**
   * Determines project and user from message context
   */
  async identifyProjectUser(message: any): Promise<{ projectId: string; userId: string }> {
    this.logger.debug('Identifying project and user from message');
    
    // Priority 1: Check if we have a sessionId to look up
    if (message.sessionId) {
      try {
        const session = await this.getSessionFromDynamoDB(message.sessionId);
        if (session) {
          return {
            projectId: session.projectId,
            userId: session.userId,
          };
        }
      } catch (error) {
        this.logger.warn(`Failed to lookup session ${message.sessionId}:`, error);
      }
    }
    
    // Priority 2: Check if we have threadId to look up
    if (message.threadId) {
      try {
        const thread = await this.getThreadFromDynamoDB(message.threadId);
        if (thread) {
          return {
            projectId: thread.projectId,
            userId: thread.userId,
          };
        }
      } catch (error) {
        this.logger.warn(`Failed to lookup thread ${message.threadId}:`, error);
      }
    }
    
    // Priority 3: Look up by email
    const email = this.extractEmail(message);
    if (email) {
      const config = this.projectConfigs.get(email.toLowerCase());
      if (config) {
        this.logger.log(`Found project config for email ${email}: ${config.projectId}/${config.userId}`);
        return {
          projectId: config.projectId,
          userId: config.userId,
        };
      }
    }
    
    // Fallback: Use defaults (will be removed once we have proper onboarding)
    this.logger.warn('Using fallback project/user identification');
    return {
      projectId: 'default',
      userId: 'unknown',
    };
  }

  /**
   * Routes message to appropriate queue
   */
  async routeMessage(message: any): Promise<RoutingDecision> {
    const { projectId, userId } = await this.identifyProjectUser(message);
    
    this.logger.log(`Routing message for project=${projectId}, user=${userId}`);
    
    // Construct queue URLs
    const inputQueueUrl = this.buildQueueUrl('input', projectId, userId);
    const outputQueueUrl = this.buildQueueUrl('output', projectId, userId);
    
    // Send to project-specific input queue
    await this.sendToQueue(inputQueueUrl, {
      ...message,
      projectId,
      userId,
      routedAt: new Date().toISOString(),
    });
    
    // Check if container is assigned to this project+user
    const needsUnclaimed = await this.checkNeedsUnclaimed(projectId, userId);
    
    if (needsUnclaimed) {
      this.logger.log(`No container assigned to ${projectId}/${userId}, sending to unclaimed queue`);
      await this.sendToUnclaimedQueue(projectId, userId);
    }
    
    return {
      projectId,
      userId,
      inputQueueUrl,
      outputQueueUrl,
      needsUnclaimed,
    };
  }

  /**
   * Builds SQS queue URL
   */
  private buildQueueUrl(type: 'input' | 'output' | 'dlq', projectId: string, userId: string): string {
    const queueName = `webordinary-${type}-${projectId}-${userId}`;
    return `https://sqs.${this.region}.amazonaws.com/${this.accountId}/${queueName}`;
  }

  /**
   * Sends message to specific queue
   */
  private async sendToQueue(queueUrl: string, message: any): Promise<void> {
    try {
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          projectId: {
            DataType: 'String',
            StringValue: message.projectId,
          },
          userId: {
            DataType: 'String',
            StringValue: message.userId,
          },
          source: {
            DataType: 'String',
            StringValue: message.source || 'email',
          },
        },
      }));
      
      this.logger.debug(`Sent message to queue: ${queueUrl}`);
    } catch (error) {
      this.logger.error(`Failed to send message to queue ${queueUrl}:`, error);
      throw error;
    }
  }

  /**
   * Sends claim request to unclaimed queue
   */
  private async sendToUnclaimedQueue(projectId: string, userId: string): Promise<void> {
    const unclaimedQueueUrl = `https://sqs.${this.region}.amazonaws.com/${this.accountId}/webordinary-unclaimed`;
    
    await this.sendToQueue(unclaimedQueueUrl, {
      type: 'claim_request',
      projectId,
      userId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Checks if a container is assigned to project+user
   */
  private async checkNeedsUnclaimed(projectId: string, userId: string): Promise<boolean> {
    try {
      // Check container ownership table
      const result = await this.dynamodb.send(new GetItemCommand({
        TableName: 'webordinary-container-ownership',
        Key: {
          projectKey: { S: `${projectId}#${userId}` },
        },
      }));
      
      if (result.Item && result.Item.status?.S === 'active') {
        const lastActivity = parseInt(result.Item.lastActivity?.N || '0');
        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        
        // Container is active if it checked in within last 5 minutes
        return lastActivity < fiveMinutesAgo;
      }
      
      return true; // No active container found
    } catch (error) {
      this.logger.warn(`Failed to check container ownership for ${projectId}/${userId}:`, error);
      return true; // Assume needs unclaimed on error
    }
  }

  /**
   * Extracts email from message
   */
  private extractEmail(message: any): string | null {
    // Try various fields where email might be
    return message.userEmail || 
           message.from || 
           message.email || 
           message.sender ||
           null;
  }

  /**
   * Gets session from DynamoDB
   */
  private async getSessionFromDynamoDB(sessionId: string): Promise<any> {
    const result = await this.dynamodb.send(new GetItemCommand({
      TableName: 'webordinary-edit-sessions',
      Key: {
        sessionId: { S: sessionId },
      },
    }));
    
    if (result.Item) {
      return {
        projectId: result.Item.projectId?.S,
        userId: result.Item.userId?.S,
      };
    }
    
    return null;
  }

  /**
   * Gets thread from DynamoDB
   */
  private async getThreadFromDynamoDB(threadId: string): Promise<any> {
    const result = await this.dynamodb.send(new GetItemCommand({
      TableName: 'webordinary-thread-mappings',
      Key: {
        threadId: { S: threadId },
      },
    }));
    
    if (result.Item) {
      return {
        projectId: result.Item.projectId?.S,
        userId: result.Item.userId?.S,
      };
    }
    
    return null;
  }

  /**
   * Updates project configuration (for future use)
   */
  async updateProjectConfig(email: string, config: ProjectConfig): Promise<void> {
    this.projectConfigs.set(email.toLowerCase(), config);
    this.logger.log(`Updated project config for ${email}: ${config.projectId}/${config.userId}`);
    
    // TODO: Store in DynamoDB for persistence
  }
}