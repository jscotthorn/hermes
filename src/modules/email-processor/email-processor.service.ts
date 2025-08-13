import { Injectable, Logger } from '@nestjs/common';
import { SQSEvent } from 'aws-lambda';
import { SES, SQS, DynamoDB } from 'aws-sdk';
import * as simpleParser from 'mailparser';
import * as EmailReplyParser from 'email-reply-parser';
import mjml2html from 'mjml';
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
      this.logger.log('[EMAIL] Processing new email message from SQS');
      
      // The message can be either a raw message or an SQSRecord
      const body = message.Body || message.body || message;
      
      // Parse the email
      const email = await this.parseEmail(body);
      this.logger.log(`[EMAIL] Parsed email from: ${email.from}, subject: ${email.subject}`);
      
      // Extract instruction from email body
      const instruction = this.extractInstruction(email);
      this.logger.debug(`[EMAIL] Extracted instruction: ${instruction?.substring(0, 100)}...`);
      
      // Identify project and user, then route message
      const { projectId, userId, repoUrl } = await this.messageRouter.identifyProjectUser({
        userEmail: email.from,
        threadId: email.threadId,
        from: email.from,
      });
      this.logger.log(`[EMAIL] Identified project+user: ${projectId}+${userId}`);
      
      // Generate session and thread IDs
      const sessionId = this.generateSessionId(projectId, userId, email.threadId);
      const chatThreadId = email.threadId || `thread-${sessionId}`;
      this.logger.debug(`[EMAIL] Thread ID: ${chatThreadId}, Session ID: ${sessionId}`);
      
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
      
      this.logger.log(`[EMAIL] ✅ Successfully routed to ${routing.needsUnclaimed ? 'unclaimed queue' : 'project queue'} for ${projectId}+${userId}`);
    } catch (error) {
      this.logger.error('[EMAIL] ❌ Failed to process email:', error);
      this.logger.error(`[EMAIL] Error details: ${error.message}`);
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
        
        // Handle SNS notification from SES
        if (messageBody.Type === 'Notification' && messageBody.Message) {
          try {
            const sesMessage = JSON.parse(messageBody.Message);
            if (sesMessage.content) {
              rawEmail = sesMessage.content;
              this.logger.debug('Parsed SES message from SNS notification');
            } else {
              rawEmail = messageBody.Message;
            }
          } catch {
            rawEmail = messageBody.Message;
          }
        }
        // Handle direct SES format
        else if (messageBody.content) {
          rawEmail = messageBody.content;
          this.logger.debug('Parsed direct SES message');
        }
        // Reject test/malformed messages that were polluting DLQ
        else if (messageBody.instruction || messageBody.chatThreadId || messageBody.unknown) {
          this.logger.warn('[EMAIL] Rejecting malformed test message - invalid format');
          throw new Error('Invalid message format: Test messages not supported. Use real email via SES.');
        }
        else {
          rawEmail = body;
        }
      } catch {
        // If parsing fails, assume it's the raw email content
        rawEmail = body;
      }
    } else if (typeof body === 'object') {
      // Reject object format test messages
      if (body.instruction || body.chatThreadId || body.unknown) {
        this.logger.warn('[EMAIL] Rejecting malformed test message object');
        throw new Error('Invalid message format: Test messages not supported');
      }
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
   * Extract thread ID from email headers or body
   */
  private extractThreadId(parsed: any): string | undefined {
    // First try to extract from email body (most reliable for replies)
    const bodyText = parsed.text || parsed.html || '';
    const bodyMatch = bodyText.match(/Conversation ID:\s*([a-zA-Z0-9-]+)/i);
    if (bodyMatch) {
      this.logger.debug(`Found thread ID in body: ${bodyMatch[1]}`);
      return bodyMatch[1];
    }
    
    // Fallback to headers (may not survive email clients)
    if (parsed.inReplyTo) {
      const match = parsed.inReplyTo.match(/thread-([a-zA-Z0-9-]+)@/);
      if (match) {
        this.logger.debug(`Found thread ID in In-Reply-To header: ${match[1]}`);
        return match[1];
      }
    }
    
    if (parsed.references && Array.isArray(parsed.references)) {
      for (const ref of parsed.references) {
        const match = ref.match(/thread-([a-zA-Z0-9-]+)@/);
        if (match) {
          this.logger.debug(`Found thread ID in References header: ${match[1]}`);
          return match[1];
        }
      }
    }
    
    this.logger.debug('No existing thread ID found - will create new thread');
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
   * Generate a new thread ID
   */
  private generateNewThreadId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${timestamp}-${random}`;
  }

  /**
   * Send acknowledgment email for received request
   */
  private async sendAcknowledgmentEmail(
    email: any,
    projectId: string,
    needsUnclaimed: boolean,
  ): Promise<void> {
    const threadId = email.threadId || this.generateNewThreadId();
    
    let content = 'Your request has been received and queued for processing.';
    
    if (needsUnclaimed) {
      content += '\n\nA development environment is being prepared for your project.';
      content += '\nThis may take a minute. You will receive another email once your changes are ready.';
    } else {
      content += '\n\nYour request is being processed by the development environment.';
      content += '\nYou will receive another email once your changes are ready.';
    }
    
    // Create MJML template
    const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Request Received - WebOrdinary</mj-title>
    <mj-attributes>
      <mj-text font-family="Arial, sans-serif" color="#333333" />
      <mj-section background-color="#ffffff" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f4f4f4">
    <!-- Header -->
    <mj-section background-color="#3498db" padding="20px">
      <mj-column>
        <mj-text color="#ffffff" font-size="24px" align="center" font-weight="bold">
          Request Received
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Status Icon -->
    <mj-section padding="30px 20px 20px 20px">
      <mj-column>
        <mj-text align="center" font-size="48px">
          ${needsUnclaimed ? '⏳' : '✅'}
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Main Content -->
    <mj-section padding="0 20px 20px 20px">
      <mj-column>
        <mj-text font-size="16px" line-height="1.6" align="center">
          ${content.split('\n').map(line => line.trim()).filter(Boolean).join('<br/>')}
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Project Info -->
    <mj-section padding="0 20px 20px 20px">
      <mj-column>
        <mj-text font-size="14px" align="center">
          <strong>Project:</strong> ${projectId}
        </mj-text>
        <mj-text font-size="14px" align="center">
          <strong>Preview URL:</strong> <a href="https://edit.${projectId}.webordinary.com">https://edit.${projectId}.webordinary.com</a>
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Thread ID Footer -->
    <mj-section background-color="#ecf0f1" padding="15px">
      <mj-column>
        <mj-divider border-color="#bdc3c7" />
        <mj-text font-size="12px" color="#7f8c8d" align="center" padding-top="10px">
          Conversation ID: ${threadId}
        </mj-text>
        <mj-text font-size="11px" color="#95a5a6" align="center">
          Please keep this ID in your reply to continue the same session
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Footer -->
    <mj-section padding="10px">
      <mj-column>
        <mj-text font-size="10px" color="#7f8c8d" align="center">
          © ${new Date().getFullYear()} WebOrdinary. All rights reserved.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

    // Render MJML to HTML
    const { html, errors } = mjml2html(mjmlTemplate, { validationLevel: 'soft' });
    if (errors && errors.length > 0) {
      this.logger.warn('MJML validation warnings:', errors);
    }

    // Build plain text version
    const plainText = `${content}

Project: ${projectId}
Preview URL: https://edit.${projectId}.webordinary.com

---
Conversation ID: ${threadId}
Please keep this ID in your reply to continue the same session.`;

    // Build MIME message for raw sending
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const mime = [
      `From: WebOrdinary <noreply@webordinary.com>`,
      `To: ${email.from}`,
      `Subject: Re: ${email.subject}`,
      `MIME-Version: 1.0`,
      `In-Reply-To: ${email.messageId}`,
      `References: ${email.messageId}`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      plainText,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      html,
      '',
      `--${boundary}--`,
    ].join('\r\n');
    
    // Send raw email for better control over headers
    await this.ses.sendRawEmail({
      RawMessage: {
        Data: Buffer.from(mime),
      },
      Source: 'noreply@webordinary.com',
    }).promise();
    
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