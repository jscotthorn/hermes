import { Injectable, Logger } from '@nestjs/common';
import { SQSEvent, SQSRecord } from 'aws-lambda';
import { SES, SQS, DynamoDB } from 'aws-sdk';
import * as simpleParser from 'mailparser';
const EmailReplyParser = require('email-reply-parser');
import { MessageRouterService } from '../message-processor/message-router.service';
import { SqsConsumerEventHandler, SqsMessageHandler } from '@ssut/nestjs-sqs';

@Injectable()
export class EmailProcessorService {
  private readonly logger = new Logger(EmailProcessorService.name);
  private readonly ses = new SES({ region: 'us-west-2' });
  private readonly sqs = new SQS({ region: 'us-west-2' });
  private readonly dynamodb = new DynamoDB({ region: 'us-west-2' });

  constructor(
    private readonly messageRouter: MessageRouterService,
  ) {}

  /**
   * Process an SQS message containing an email
   */
  @SqsMessageHandler('hermes-email-consumer', false)
  async processEmail(message: any): Promise<void> {
    try {
      this.logger.log('Processing email from SQS');
      
      // The message can be either a raw message or an SQSRecord
      const body = message.Body || message.body || message;
      
      // Parse the email
      const email = await this.parseEmail(body);
      
      // Extract instruction from email body
      const instruction = this.extractInstruction(email);
      
      // Identify project and user, then route message
      const { projectId, userId, repoUrl } = await this.messageRouter.identifyProjectUser({
        userEmail: email.from,
        threadId: email.threadId,
        from: email.from,
      });
      
      // Generate session and thread IDs
      const sessionId = this.generateSessionId(projectId, userId, email.threadId);
      const chatThreadId = email.threadId || `thread-${sessionId}`;
      
      // Route the message to appropriate queues
      const routing = await this.messageRouter.routeMessage({
        sessionId,
        projectId,
        userId,
        from: email.from,
        subject: email.subject,
        body: email.textBody || email.htmlBody,
        instruction,
        threadId: email.threadId,
        chatThreadId,
        repoUrl,
        timestamp: new Date().toISOString(),
        source: 'email',
      });
      
      // Create thread mapping for future reference
      await this.createThreadMapping(chatThreadId, sessionId, projectId);
      
      // Send basic acknowledgment email
      await this.sendAcknowledgmentEmail(email, projectId, routing.needsUnclaimed);
      
      this.logger.log(`Successfully routed email for project ${projectId}, user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to process email', error);
      throw error;
    }
  }

  /**
   * Process multiple SQS messages
   */
  @SqsConsumerEventHandler('hermes-email-consumer', 'batch')
  async processSQSEvent(event: SQSEvent): Promise<void> {
    this.logger.log(`Processing ${event.Records.length} SQS messages`);
    
    for (const record of event.Records) {
      try {
        await this.processEmail(record);
        
        // Delete message from queue on success
        if (process.env.SQS_QUEUE_URL) {
          await this.sqs.deleteMessage({
            QueueUrl: process.env.SQS_QUEUE_URL,
            ReceiptHandle: record.receiptHandle,
          }).promise();
        }
      } catch (error) {
        this.logger.error(`Failed to process message ${record.messageId}`, error);
        // Message will remain in queue for retry
      }
    }
  }

  /**
   * Parse raw email content
   */
  private async parseEmail(body: any): Promise<any> {
    let rawEmail: string;
    
    // Handle different message formats
    if (typeof body === 'string') {
      try {
        const messageBody = JSON.parse(body);
        rawEmail = messageBody.content || messageBody.Message || body;
      } catch {
        // If parsing fails, assume it's the raw email content
        rawEmail = body;
      }
    } else if (typeof body === 'object') {
      rawEmail = body.content || body.Message || JSON.stringify(body);
    } else {
      rawEmail = String(body);
    }
    
    const parsed = await simpleParser.simpleParser(rawEmail);
    
    return {
      from: parsed.from?.text || '',
      to: parsed.to?.text || '',
      subject: parsed.subject || '',
      textBody: parsed.text || '',
      htmlBody: parsed.html || '',
      messageId: parsed.messageId || '',
      inReplyTo: parsed.inReplyTo || '',
      references: parsed.references || [],
      threadId: this.extractThreadId(parsed),
    };
  }

  /**
   * Extract thread ID from email headers
   */
  private extractThreadId(parsed: any): string | undefined {
    // Try to extract from In-Reply-To or References headers
    if (parsed.inReplyTo) {
      const match = parsed.inReplyTo.match(/thread-([a-zA-Z0-9-]+)@/);
      if (match) return match[1];
    }
    
    if (parsed.references && Array.isArray(parsed.references)) {
      for (const ref of parsed.references) {
        const match = ref.match(/thread-([a-zA-Z0-9-]+)@/);
        if (match) return match[1];
      }
    }
    
    return undefined;
  }

  /**
   * Extract instruction from email body
   */
  private extractInstruction(email: any): string {
    try {
      // Use email-reply-parser to get just the new content
      const replyText = EmailReplyParser.parse(
        email.textBody || email.htmlBody || '',
      );
      
      // Get the visible text (removes quoted replies)
      const fragments = replyText.getFragments();
      const visibleText = fragments
        .filter((f: any) => !f.isQuoted() && !f.isSignature())
        .map((f: any) => f.getContent())
        .join('\n')
        .trim();
      
      return visibleText || email.textBody || email.htmlBody || '';
    } catch (error) {
      // If parsing fails, just return the raw text
      this.logger.warn('Failed to parse email reply, using raw text', error);
      return email.textBody || email.htmlBody || '';
    }
  }

  /**
   * Generate a session ID for the email
   */
  private generateSessionId(projectId: string, userId: string, threadId?: string): string {
    if (threadId) {
      // Use thread ID as basis for session ID for continuity
      return `${projectId}-${userId}-${threadId}`;
    }
    // Generate new session ID
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 7);
    return `${projectId}-${userId}-${timestamp}-${random}`;
  }

  /**
   * Send acknowledgment email for received request
   */
  private async sendAcknowledgmentEmail(
    email: any,
    projectId: string,
    needsUnclaimed: boolean,
  ): Promise<void> {
    const threadId = email.threadId || `thread-${projectId}`;
    
    let body = 'Your request has been received and queued for processing.\n\n';
    
    if (needsUnclaimed) {
      body += 'A development environment is being prepared for your project.\n';
      body += 'This may take a minute. You will receive another email once your changes are ready.\n';
    } else {
      body += 'Your request is being processed by the development environment.\n';
      body += 'You will receive another email once your changes are ready.\n';
    }
    
    body += `\nProject: ${projectId}\n`;
    body += `\nPreview URL: https://edit.${projectId}.webordinary.com\n`;
    
    const params = {
      Source: process.env.SES_FROM_EMAIL || 'noreply@webordinary.com',
      Destination: {
        ToAddresses: [email.from],
      },
      Message: {
        Subject: {
          Data: `Re: ${email.subject}`,
        },
        Body: {
          Text: {
            Data: body,
          },
        },
      },
      MessageAttributes: {
        'In-Reply-To': {
          DataType: 'String',
          StringValue: email.messageId,
        },
        'References': {
          DataType: 'String',
          StringValue: email.messageId,
        },
        'Thread-Id': {
          DataType: 'String',
          StringValue: threadId,
        },
      },
    };
    
    await this.ses.sendEmail(params).promise();
    this.logger.log(`Acknowledgment email sent to ${email.from}`);
  }

  /**
   * Create thread mapping for session router
   */
  private async createThreadMapping(
    threadId: string,
    sessionId: string,
    clientId: string,
  ): Promise<void> {
    try {
      const containerId = `${clientId}-email-user`; // Container ID format
      
      await this.dynamodb.putItem({
        TableName: 'webordinary-thread-mappings',
        Item: {
          threadId: { S: threadId },
          sessionId: { S: sessionId },
          containerId: { S: containerId },
          status: { S: 'active' },
          createdAt: { N: Date.now().toString() },
        },
      }).promise();
      
      this.logger.log(`Created thread mapping for ${threadId} -> ${sessionId}`);
    } catch (error) {
      this.logger.error('Failed to create thread mapping', error);
      // Don't fail the whole process if mapping creation fails
    }
  }
}