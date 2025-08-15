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
import { v4 as uuidv4 } from 'uuid';
import type { ClaimRequestMessage, WorkMessage } from '../../types/queue-messages';

export interface ProjectConfig {
  projectId: string;
  userId: string;
  email: string;
  repoUrl: string;
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
  
  // Project configurations - maps email to project+user
  // This determines which project+user combination a container should claim
  // TODO: Move to DynamoDB for dynamic configuration
  private readonly projectConfigs: Map<string, ProjectConfig> = new Map([
    ['escottster@gmail.com', {
      projectId: 'amelia',  // Project identifier (matches queue: webordinary-input-amelia-scott)
      userId: 'scott',            // User within project
      email: 'escottster@gmail.com',
      repoUrl: 'https://github.com/jscotthorn/amelia-astro.git',
      defaultInstruction: 'Help with Amelia Stamps website'
    }],
  ]);

  constructor() {
    // Initialize AWS SDK clients
    this.sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-west-2' });
    this.dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' });
    this.accountId = process.env.AWS_ACCOUNT_ID || '942734823970';
    this.region = process.env.AWS_REGION || 'us-west-2';
  }

  /**
   * Determines project, user, and repo URL from message context
   * This identifies WHICH project+user combination should handle this message
   * Containers will claim project+user combinations, not individual sessions
   */
  async identifyProjectUser(message: any): Promise<{ projectId: string; userId: string; repoUrl?: string }> {
    this.logger.debug('Identifying project+user for container claiming');
    
    // Priority 1: Check if we have a sessionId to look up
    if (message.sessionId) {
      try {
        const session = await this.getSessionFromDynamoDB(message.sessionId);
        if (session) {
          // Try to get repo URL from config
          const config = this.getProjectConfigById(session.projectId);
          return {
            projectId: session.projectId,
            userId: session.userId,
            repoUrl: config?.repoUrl,
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
          // Try to get repo URL from config
          const config = this.getProjectConfigById(thread.projectId);
          return {
            projectId: thread.projectId,
            userId: thread.userId,
            repoUrl: config?.repoUrl,
          };
        }
      } catch (error) {
        this.logger.warn(`Failed to lookup thread ${message.threadId}:`, error);
      }
    }
    
    // Priority 3: Look up by email
    const email = this.extractEmail(message);
    this.logger.debug(`Extracted email for project lookup: ${email}`);
    if (email) {
      const config = this.projectConfigs.get(email.toLowerCase());
      if (config) {
        this.logger.log(`Found project config for email ${email}: ${config.projectId}/${config.userId}`);
        return {
          projectId: config.projectId,
          userId: config.userId,
          repoUrl: config.repoUrl,
        };
      } else {
        this.logger.debug(`No config found for email: ${email}`);
        this.logger.debug(`Available configs: ${Array.from(this.projectConfigs.keys()).join(', ')}`);
      }
    }
    
    // Fallback: Use defaults (will be removed once we have proper onboarding)
    this.logger.warn('Using fallback project/user identification');
    return {
      projectId: 'default',
      userId: 'unknown',
      repoUrl: undefined,
    };
  }

  /**
   * Routes message to appropriate queue based on project+user ownership
   * Messages go to:
   * 1. Project+User input queue (for claimed containers)
   * 2. Unclaimed queue (for warm containers to claim work)
   */
  async routeMessage(message: any): Promise<RoutingDecision> {
    // If projectId and userId are already provided, use them directly
    let projectId = message.projectId;
    let userId = message.userId;
    let repoUrl = message.repoUrl;
    
    // Otherwise, identify them
    if (!projectId || !userId) {
      const identified = await this.identifyProjectUser(message);
      projectId = identified.projectId;
      userId = identified.userId;
      repoUrl = identified.repoUrl;
    }
    
    this.logger.log(`Routing message for project+user: ${projectId}+${userId}`);
    
    // Construct queue URLs
    const inputQueueUrl = this.buildQueueUrl('input', projectId, userId);
    const outputQueueUrl = this.buildQueueUrl('output', projectId, userId);
    
    // Create standardized work message
    const workMessage: WorkMessage = {
      type: 'work',
      sessionId: message.sessionId || `${projectId}-${userId}-${Date.now()}`,
      projectId,
      userId,
      repoUrl: repoUrl || '',
      instruction: message.instruction || '',
      timestamp: new Date().toISOString(),
      source: message.source || 'email',
      from: message.from,
      subject: message.subject,
      body: message.body,
      threadId: message.threadId,
      chatThreadId: message.chatThreadId,
      commandId: message.commandId || uuidv4(),
      context: message.context,
    };
    
    // Send to project-specific input queue
    await this.sendToQueue(inputQueueUrl, workMessage);
    
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
   * Validates message structure before sending to queue
   */
  private validateMessage(message: any): void {
    // Check for required base fields
    if (!message.sessionId) {
      throw new Error('Message validation failed: sessionId is required');
    }
    if (!message.projectId) {
      throw new Error('Message validation failed: projectId is required');
    }
    if (!message.userId) {
      throw new Error('Message validation failed: userId is required');
    }
    if (!message.timestamp) {
      throw new Error('Message validation failed: timestamp is required');
    }
    
    // Check for fields that indicate test/malformed messages from agents
    if ('unknown' in message) {
      throw new Error('Message validation failed: contains unknown field (test message)');
    }
    
    // Reject messages that look like direct test format (not from real emails)
    if (message.instruction && !message.from) {
      throw new Error('Message validation failed: instruction without from field (test message)');
    }
    
    // Reject messages with test patterns
    if (message.userId === 'test-user' || message.projectId === 'test-client') {
      throw new Error('Message validation failed: test user/project not allowed in production');
    }
    
    // Validate specific message types
    if (message.type === 'work') {
      if (!message.instruction) {
        throw new Error('Message validation failed: work message requires instruction');
      }
      if (!message.repoUrl) {
        throw new Error('Message validation failed: work message requires repoUrl');
      }
    }
    
    if (message.type === 'response') {
      if (!message.commandId) {
        throw new Error('Message validation failed: response message requires commandId');
      }
      if (typeof message.success !== 'boolean') {
        throw new Error('Message validation failed: response message requires success boolean');
      }
    }
  }

  /**
   * Sends message to specific queue
   */
  private async sendToQueue(queueUrl: string, message: any): Promise<void> {
    try {
      // Validate message before sending
      this.validateMessage(message);
      
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
    
    const claimRequest: ClaimRequestMessage = {
      type: 'claim_request',
      sessionId: `claim-${projectId}-${userId}-${Date.now()}`,
      projectId,
      userId,
      timestamp: new Date().toISOString(),
      source: 'hermes',
    };
    
    await this.sendToQueue(unclaimedQueueUrl, claimRequest);
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
        // Return false (doesn't need unclaimed) if container is active and recent
        return lastActivity <= fiveMinutesAgo; // true if stale (needs unclaimed)
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

  /**
   * Gets project config by project ID
   */
  private getProjectConfigById(projectId: string): ProjectConfig | undefined {
    // Look through all configs to find matching project ID
    for (const config of this.projectConfigs.values()) {
      if (config.projectId === projectId) {
        return config;
      }
    }
    return undefined;
  }

  /**
   * Helper method to get input queue URL for project+user
   */
  getInputQueueUrl(projectId: string, userId: string): string {
    // Sanitize IDs for queue names
    const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9-]/g, '-');
    const sanitizedUserId = userId.replace(/[^a-zA-Z0-9-]/g, '-');
    return `https://sqs.${this.region}.amazonaws.com/${this.accountId}/webordinary-input-${sanitizedProjectId}-${sanitizedUserId}`;
  }

  /**
   * Helper method to get output queue URL for project+user
   */
  getOutputQueueUrl(projectId: string, userId: string): string {
    // Sanitize IDs for queue names
    const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9-]/g, '-');
    const sanitizedUserId = userId.replace(/[^a-zA-Z0-9-]/g, '-');
    return `https://sqs.${this.region}.amazonaws.com/${this.accountId}/webordinary-output-${sanitizedProjectId}-${sanitizedUserId}`;
  }

  /**
   * Helper method to get unclaimed queue URL
   */
  getUnclaimedQueueUrl(): string {
    return `https://sqs.${this.region}.amazonaws.com/${this.accountId}/webordinary-unclaimed`;
  }

  /**
   * Validates message format
   */
  async validateMessageFormat(message: any): Promise<boolean> {
    // Check if it's a test message format (not supported in production)
    if (message.type === 'test' || message.unknown) {
      throw new Error('Invalid message format: Test messages not supported');
    }

    // Check required fields
    if (!message.messageId || !message.content) {
      throw new Error('Invalid message format: Missing required fields');
    }

    return true;
  }
}