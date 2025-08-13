import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { ParsedMail } from 'mailparser';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

export interface ThreadMapping {
  messageId: string;      // PK (source-specific ID)
  threadId: string;       // Canonical thread ID
  sessionId: string;      // Full session ID
  clientId: string;       // GSI
  projectId: string;      // Project identifier
  userId: string;         // User identifier (email, phone, etc)
  source: 'email' | 'sms' | 'chat';
  lastSource: string;     // Most recent message source
  firstSeen: number;      // Unix timestamp
  lastActivity: number;   // Unix timestamp
  messageCount: number;
  ttl?: number;          // Unix timestamp for expiry (30 days)
}

export interface EditSession {
  sessionId: string;
  clientId: string;
  projectId: string;
  userId: string;
  chatThreadId: string;
  gitBranch: string;
  source: string;
  createdAt: number;
  lastActivity: number;
  status: 'active' | 'idle' | 'terminated';
}

interface IncomingMessage {
  source: 'email' | 'sms' | 'chat';
  data: ParsedMail | SmsMessage | ChatMessage;
  clientId: string;
  projectId: string;
  userId: string;
}

interface SmsMessage {
  from: string;
  to: string;
  body: string;
  messageId: string;
  conversationId?: string;
}

interface ChatMessage {
  messageId: string;
  threadId: string;
  userId: string;
  content: string;
}

@Injectable()
export class ThreadExtractorService {
  private readonly logger = new Logger(ThreadExtractorService.name);
  private readonly dynamodb: DynamoDBClient;
  private readonly tableName: string;

  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' });
    this.tableName = process.env.THREAD_MAPPING_TABLE || 'webordinary-thread-mappings';
  }

  /**
   * Extracts a consistent thread ID from any message source
   */
  extractThreadId(message: IncomingMessage): string {
    this.logger.debug(`Extracting thread ID from ${message.source} message`);

    switch (message.source) {
      case 'email':
        return this.extractEmailThreadId(message.data as ParsedMail);
      case 'sms':
        return this.extractSmsThreadId(message.data as SmsMessage);
      case 'chat':
        return this.extractChatThreadId(message.data as ChatMessage);
      default:
        return this.generateNewThreadId();
    }
  }

  /**
   * Extracts thread ID from email headers
   */
  private extractEmailThreadId(email: ParsedMail): string {
    // Try References header first (most reliable for email threads)
    if (email.references) {
      const refs = Array.isArray(email.references) 
        ? email.references 
        : [email.references];
      
      // Use the first reference (original message in thread)
      const originalMessageId = refs[0];
      this.logger.debug(`Using References header: ${originalMessageId}`);
      return this.hashMessageId(originalMessageId);
    }
    
    // Fall back to In-Reply-To header
    if (email.inReplyTo) {
      this.logger.debug(`Using In-Reply-To header: ${email.inReplyTo}`);
      return this.hashMessageId(email.inReplyTo);
    }
    
    // New thread - use current Message-ID
    if (email.messageId) {
      this.logger.debug(`Starting new thread with Message-ID: ${email.messageId}`);
      return this.hashMessageId(email.messageId);
    }

    // Fallback to generated ID
    return this.generateNewThreadId();
  }

  /**
   * Extracts thread ID from SMS conversation
   */
  private extractSmsThreadId(sms: SmsMessage): string {
    // Use conversation ID if available (Twilio provides this)
    if (sms.conversationId) {
      return this.hashMessageId(sms.conversationId);
    }

    // Create consistent thread ID from phone numbers
    const participants = [sms.from, sms.to].sort().join(':');
    return this.hashMessageId(`sms:${participants}`);
  }

  /**
   * Extracts thread ID from chat message
   */
  private extractChatThreadId(chat: ChatMessage): string {
    // Chat platforms usually provide explicit thread IDs
    if (chat.threadId) {
      return this.hashMessageId(chat.threadId);
    }

    // Fallback to message ID
    return this.hashMessageId(chat.messageId);
  }

  /**
   * Creates a short, URL-safe hash from a message ID
   */
  private hashMessageId(messageId: string): string {
    // Remove angle brackets if present (common in email Message-IDs)
    const cleanId = messageId.replace(/^<|>$/g, '');
    
    // Create short, URL-safe hash (8 characters)
    const hash = createHash('sha256')
      .update(cleanId)
      .digest('base64url')
      .substring(0, 8);
    
    this.logger.debug(`Hashed ${cleanId} to ${hash}`);
    return hash;
  }

  /**
   * Generates a new thread ID for messages without thread context
   */
  private generateNewThreadId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `${timestamp}${random}`;
  }

  /**
   * Gets or creates a session for the given thread
   */
  async getOrCreateSession(
    clientId: string,
    projectId: string,
    userId: string,
    chatThreadId: string,
    source: 'email' | 'sms' | 'chat',
  ): Promise<EditSession> {
    const sessionId = `${clientId}-${projectId}-${chatThreadId}`;
    
    this.logger.log(`Getting or creating session: ${sessionId}`);

    try {
      // Check for existing thread mapping
      const existingMapping = await this.getThreadMapping(chatThreadId);
      
      if (existingMapping) {
        // Update activity and source if different
        if (existingMapping.lastSource !== source) {
          await this.updateThreadMapping(chatThreadId, source);
        }
        
        // Return existing session
        return {
          sessionId: existingMapping.sessionId,
          clientId: existingMapping.clientId,
          projectId: existingMapping.projectId,
          userId: existingMapping.userId,
          chatThreadId,
          gitBranch: `thread-${chatThreadId}`,
          source: existingMapping.lastSource,
          createdAt: existingMapping.firstSeen,
          lastActivity: Date.now(),
          status: 'active',
        };
      }

      // Create new thread mapping
      await this.createThreadMapping({
        messageId: chatThreadId,
        threadId: chatThreadId,
        sessionId,
        clientId,
        projectId,
        userId,
        source,
        lastSource: source,
        firstSeen: Date.now(),
        lastActivity: Date.now(),
        messageCount: 1,
        ttl: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
      });

      // Return new session info directly
      return {
        sessionId,
        clientId,
        projectId,
        userId,
        chatThreadId,
        gitBranch: `thread-${chatThreadId}`,
        source,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        status: 'active',
      };
    } catch (error) {
      this.logger.error(`Failed to get or create session for thread ${chatThreadId}:`, error);
      throw error;
    }
  }

  /**
   * Gets thread mapping from DynamoDB
   */
  private async getThreadMapping(threadId: string): Promise<ThreadMapping | null> {
    try {
      const result = await this.dynamodb.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: {
            threadId: { S: threadId },
          },
        }),
      );

      if (!result.Item) {
        return null;
      }

      return {
        messageId: result.Item.messageId.S!,
        threadId: result.Item.threadId.S!,
        sessionId: result.Item.sessionId.S!,
        clientId: result.Item.clientId.S!,
        projectId: result.Item.projectId.S!,
        userId: result.Item.userId.S!,
        source: result.Item.source.S as 'email' | 'sms' | 'chat',
        lastSource: result.Item.lastSource.S!,
        firstSeen: parseInt(result.Item.firstSeen.N!),
        lastActivity: parseInt(result.Item.lastActivity.N!),
        messageCount: parseInt(result.Item.messageCount.N!),
        ttl: result.Item.ttl ? parseInt(result.Item.ttl.N!) : undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to get thread mapping for ${threadId}:`, error);
      return null;
    }
  }

  /**
   * Creates a new thread mapping in DynamoDB
   */
  private async createThreadMapping(mapping: ThreadMapping): Promise<void> {
    try {
      await this.dynamodb.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: {
            threadId: { S: mapping.threadId },
            messageId: { S: mapping.messageId },
            sessionId: { S: mapping.sessionId },
            clientId: { S: mapping.clientId },
            projectId: { S: mapping.projectId },
            userId: { S: mapping.userId },
            clientProjectId: { S: `${mapping.clientId}-${mapping.projectId}` },
            source: { S: mapping.source },
            lastSource: { S: mapping.lastSource },
            firstSeen: { N: mapping.firstSeen.toString() },
            lastActivity: { N: mapping.lastActivity.toString() },
            messageCount: { N: mapping.messageCount.toString() },
            ...(mapping.ttl && { ttl: { N: mapping.ttl.toString() } }),
          },
        }),
      );

      this.logger.log(`Created thread mapping for ${mapping.threadId}`);
    } catch (error) {
      this.logger.error(`Failed to create thread mapping:`, error);
      throw error;
    }
  }

  /**
   * Updates thread mapping with new activity
   */
  private async updateThreadMapping(
    threadId: string,
    newSource: string,
  ): Promise<void> {
    try {
      await this.dynamodb.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: {
            threadId: { S: threadId },
          },
          UpdateExpression: 'SET lastSource = :source, lastActivity = :now, messageCount = messageCount + :inc',
          ExpressionAttributeValues: {
            ':source': { S: newSource },
            ':now': { N: Date.now().toString() },
            ':inc': { N: '1' },
          },
        }),
      );

      this.logger.log(`Updated thread mapping for ${threadId} with source ${newSource}`);
    } catch (error) {
      this.logger.error(`Failed to update thread mapping:`, error);
      throw error;
    }
  }

  /**
   * Lists all threads for a user
   */
  async listUserThreads(userId: string): Promise<ThreadMapping[]> {
    try {
      const result = await this.dynamodb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'userId-index',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': { S: userId },
          },
          ScanIndexForward: false, // Most recent first
        }),
      );

      return (result.Items || []).map((item) => ({
        messageId: item.messageId.S!,
        threadId: item.threadId.S!,
        sessionId: item.sessionId.S!,
        clientId: item.clientId.S!,
        projectId: item.projectId.S!,
        userId: item.userId.S!,
        source: item.source.S as 'email' | 'sms' | 'chat',
        lastSource: item.lastSource.S!,
        firstSeen: parseInt(item.firstSeen.N!),
        lastActivity: parseInt(item.lastActivity.N!),
        messageCount: parseInt(item.messageCount.N!),
        ttl: item.ttl ? parseInt(item.ttl.N!) : undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to list threads for user ${userId}:`, error);
      return [];
    }
  }

  /**
   * Lists all threads for a client+project
   */
  async listProjectThreads(
    clientId: string,
    projectId: string,
  ): Promise<ThreadMapping[]> {
    try {
      const result = await this.dynamodb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'clientProject-index',
          KeyConditionExpression: 'clientProjectId = :cpId',
          ExpressionAttributeValues: {
            ':cpId': { S: `${clientId}-${projectId}` },
          },
          ScanIndexForward: false, // Most recent first
        }),
      );

      return (result.Items || []).map((item) => ({
        messageId: item.messageId.S!,
        threadId: item.threadId.S!,
        sessionId: item.sessionId.S!,
        clientId: item.clientId.S!,
        projectId: item.projectId.S!,
        userId: item.userId.S!,
        source: item.source.S as 'email' | 'sms' | 'chat',
        lastSource: item.lastSource.S!,
        firstSeen: parseInt(item.firstSeen.N!),
        lastActivity: parseInt(item.lastActivity.N!),
        messageCount: parseInt(item.messageCount.N!),
        ttl: item.ttl ? parseInt(item.ttl.N!) : undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to list threads for ${clientId}-${projectId}:`, error);
      return [];
    }
  }
}