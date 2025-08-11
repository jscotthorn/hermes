import { Injectable, Logger } from '@nestjs/common';
import { SQSEvent, SQSRecord } from 'aws-lambda';
import { SES, SQS, DynamoDB } from 'aws-sdk';
import * as simpleParser from 'mailparser';
const EmailReplyParser = require('email-reply-parser');
import { ClaudeExecutorService } from '../claude-executor/claude-executor.service';
import { EditSessionService } from '../edit-session/services/edit-session.service';
import { SqsConsumerEventHandler, SqsMessageHandler } from '@ssut/nestjs-sqs';

@Injectable()
export class EmailProcessorService {
  private readonly logger = new Logger(EmailProcessorService.name);
  private readonly ses = new SES({ region: 'us-west-2' });
  private readonly sqs = new SQS({ region: 'us-west-2' });
  private readonly dynamodb = new DynamoDB({ region: 'us-west-2' });

  constructor(
    private readonly claudeExecutor: ClaudeExecutorService,
    private readonly sessionService: EditSessionService,
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
      
      // Get or create session for this user/thread
      const session = await this.getOrCreateSession(email);
      
      // Update session activity to keep it alive
      await this.sessionService.updateSessionActivity(session.sessionId);
      
      // Forward instruction to Claude Code in container
      const result = await this.claudeExecutor.executeInstruction(
        session.sessionId,
        instruction,
        email.from,
      );
      
      // Send email response with results
      await this.sendEmailResponse(email, result, session.sessionId);
      
      this.logger.log(`Successfully processed email for session ${session.sessionId}`);
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
   * Get or create session for email sender
   */
  private async getOrCreateSession(email: any): Promise<any> {
    // Extract client ID from email address
    let clientId = 'amelia'; // Default to amelia for MVP
    try {
      const emailUser = email.from.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
      if (emailUser && emailUser.length > 0) {
        clientId = emailUser.substring(0, 20); // Limit length and ensure not empty
      }
    } catch (error) {
      this.logger.warn('Failed to extract client ID from email, using default', error);
    }
    
    const userId = 'email-user'; // Default user for email sessions
    
    // Try to find existing session by thread ID
    if (email.threadId) {
      const existingSessions = await this.sessionService.getActiveSessions(clientId);
      const threadSession = existingSessions.find(
        s => s.threadId === email.threadId && s.status === 'active'
      );
      
      if (threadSession) {
        return threadSession;
      }
    }
    
    // Create new session with instruction from email
    const instruction = `Email from ${email.from}: ${email.subject || 'No subject'}`;
    const session = await this.sessionService.createSession(
      clientId,
      userId,
      instruction
    );
    
    // Create thread mapping for session router
    // This is needed for the Lambda session router to find the container
    await this.createThreadMapping(session.threadId, session.sessionId, clientId);
    
    return session;
  }

  /**
   * Send email response with results
   */
  private async sendEmailResponse(
    email: any,
    result: any,
    sessionId: string,
  ): Promise<void> {
    const threadId = email.threadId || `thread-${sessionId}`;
    
    let body = result.message || 'Your request has been processed.';
    
    if (result.changes && result.changes.length > 0) {
      body += '\n\nChanges made:\n';
      result.changes.forEach((change: any) => {
        body += `- ${change}\n`;
      });
    }
    
    if (result.previewUrl) {
      body += `\n\nPreview your changes: ${result.previewUrl}\n`;
    }
    
    if (result.requiresApproval) {
      body += '\n\n⚠️ This change requires your approval.\n';
      body += `Approve: ${process.env.ALB_URL}/approve/${result.approvalToken}\n`;
      body += `Reject: ${process.env.ALB_URL}/reject/${result.approvalToken}\n`;
    }
    
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
    this.logger.log(`Email response sent to ${email.from}`);
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