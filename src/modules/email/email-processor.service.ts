import { Injectable, Logger } from '@nestjs/common';
import { ParsedMail } from 'mailparser';
import { ThreadExtractorService } from '../message-processor/thread-extractor.service';
import { QueueManagerService } from '../sqs/queue-manager.service';
import { SqsMessageService } from '../sqs/sqs-message.service';
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { EmailTemplateService } from './email-templates.service';

interface ProcessedEmail {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  inReplyTo?: string;
  references?: string | string[];
  threadIndex?: string;
  text?: string;
  html?: string;
  instruction: string;
  clientId: string;
  projectId: string;
  userId: string;
}

@Injectable()
export class EmailProcessorService {
  private readonly logger = new Logger(EmailProcessorService.name);
  private readonly ses: SESClient;

  constructor(
    private readonly threadExtractor: ThreadExtractorService,
    private readonly queueManager: QueueManagerService,
    private readonly messageService: SqsMessageService,
    private readonly emailTemplateService: EmailTemplateService,
  ) {
    this.ses = new SESClient({ region: process.env.AWS_REGION || 'us-west-2' });
  }

  /**
   * Processes an incoming email and routes it to the appropriate container
   */
  async processEmail(email: ParsedMail): Promise<void> {
    this.logger.log(`Processing email from ${email.from?.text} with subject: ${email.subject}`);

    try {
      // Extract identifiers from email
      const processedEmail = this.extractEmailData(email);

      // Extract thread ID from email headers
      const chatThreadId = this.threadExtractor.extractThreadId({
        source: 'email',
        data: email,
        clientId: processedEmail.clientId,
        projectId: processedEmail.projectId,
        userId: processedEmail.userId,
      });

      this.logger.log(`Extracted thread ID: ${chatThreadId} for ${processedEmail.clientId}-${processedEmail.projectId}`);

      // Get or create session for this thread
      const session = await this.threadExtractor.getOrCreateSession(
        processedEmail.clientId,
        processedEmail.projectId,
        processedEmail.userId,
        chatThreadId,
        'email',
      );

      this.logger.log(`Using session: ${session.sessionId} on branch: ${session.gitBranch}`);

      // Get or create container queues (one set per user+project)
      const queues = await this.queueManager.createContainerQueues(
        processedEmail.clientId,
        processedEmail.projectId,
        processedEmail.userId,
      );

      // Send command to container's input queue
      const commandId = await this.messageService.sendEditCommand(
        queues.inputUrl,
        {
          sessionId: session.sessionId,
          type: 'edit',
          instruction: processedEmail.instruction,
          userEmail: processedEmail.from,
          chatThreadId,
          context: {
            branch: session.gitBranch,
            clientId: processedEmail.clientId,
            projectId: processedEmail.projectId,
            userId: processedEmail.userId,
          },
        },
      );

      this.logger.log(`Sent command ${commandId} to session ${session.sessionId} on branch ${session.gitBranch}`);

      // Wait for response from output queue
      try {
        const response = await this.messageService.waitForResponse(
          queues.outputUrl,
          commandId,
          60, // 60 second timeout
        );

        if (response) {
          this.logger.log(`Received response for command ${commandId}: ${response.success ? 'success' : 'failed'}`);

          // Send response email
          await this.sendResponseEmail(
            processedEmail.from,
            processedEmail.subject,
            email.messageId,
            response,
          );
        }
      } catch (error) {
        if (error.message.includes('timeout')) {
          this.logger.warn(`Response timeout for command ${commandId}`);
          await this.sendTimeoutEmail(
            processedEmail.from,
            processedEmail.subject,
            email.messageId,
            commandId,
          );
        } else {
          throw error;
        }
      }
    } catch (error) {
      this.logger.error(`Failed to process email:`, error);

      // Send error email to user
      await this.sendErrorEmail(
        email.from?.text || 'unknown',
        email.subject || 'Edit Request',
        email.messageId,
        error.message,
      );
    }
  }

  /**
   * Extracts relevant data from parsed email
   */
  private extractEmailData(email: ParsedMail): ProcessedEmail {
    // Extract client ID and project ID from email address or subject
    // Example: edit@ameliastamps-website.webordinary.com
    const toAddress = email.to?.text || email.to?.value?.[0]?.address || '';
    const match = toAddress.match(/edit@([^-]+)-([^.]+)\.webordinary\.com/);

    let clientId = 'default';
    let projectId = 'project';

    if (match) {
      clientId = match[1];
      projectId = match[2];
    } else {
      // Try to extract from subject line
      // Example: [ameliastamps/website] Edit request
      const subjectMatch = email.subject?.match(/\[([^\/]+)\/([^\]]+)\]/);
      if (subjectMatch) {
        clientId = subjectMatch[1];
        projectId = subjectMatch[2];
      }
    }

    // Extract user email
    const userEmail = email.from?.text || email.from?.value?.[0]?.address || 'unknown@email.com';
    const userId = userEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');

    // Extract instruction from email body
    const instruction = email.text || email.html || 'No instruction provided';

    return {
      from: userEmail,
      to: toAddress,
      subject: email.subject || 'Edit Request',
      messageId: email.messageId || '',
      inReplyTo: email.inReplyTo,
      references: email.references,
      threadIndex: email.headers?.get('thread-index'),
      text: email.text,
      html: email.html,
      instruction,
      clientId,
      projectId,
      userId,
    };
  }

  /**
   * Sends a response email back to the user
   */
  private async sendResponseEmail(
    to: string,
    originalSubject: string,
    messageId: string,
    response: any,
  ): Promise<void> {
    const subject = `Re: ${originalSubject}`;

    // Build content for template
    let content = `Your edit request has been ${response.success ? 'completed successfully' : 'processed with errors'}.`;

    if (response.summary) {
      content += `\n\n${response.summary}`;
    }

    if (response.interrupted) {
      content += `\n\nNote: This task was interrupted by a newer request.`;
    }

    // Extract thread ID from sessionId or generate new one
    const threadMatch = response.sessionId?.match(/([a-zA-Z0-9]+-[a-zA-Z0-9]+)$/);
    const threadId = threadMatch ? threadMatch[1] : response.sessionId || this.generateNewThreadId();

    // Create MJML template
    const mjmlTemplate = this.emailTemplateService.createResponseTemplate({
      content,
      threadId,
      projectId: response.projectId,
      previewUrl: response.previewUrl,
      filesChanged: response.filesChanged,
      error: response.error,
      isError: !response.success,
    });

    // Render to HTML and text
    const { html, text } = this.emailTemplateService.renderMjml(mjmlTemplate);

    // Build MIME message for proper threading
    const mimeMessage = this.emailTemplateService.buildMimeMessage({
      from: 'WebOrdinary <noreply@webordinary.com>',
      to,
      subject,
      html,
      text: `${content}\n\n---\nConversation ID: ${threadId}\nPlease keep this ID in your reply to continue the same session.`,
      inReplyTo: messageId,
      references: messageId,
    });

    try {
      // Use SendRawEmailCommand for MIME messages
      await this.ses.send(
        new SendRawEmailCommand({
          RawMessage: {
            Data: Buffer.from(mimeMessage),
          },
          Source: 'noreply@webordinary.com',
        }),
      );

      this.logger.log(`Sent response email to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send response email:`, error);
    }
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
   * Sends a timeout notification email
   */
  private async sendTimeoutEmail(
    to: string,
    originalSubject: string,
    inReplyTo: string,
    commandId: string,
  ): Promise<void> {
    const subject = `Re: ${originalSubject} - Processing Timeout`;
    const body = `Your edit request is taking longer than expected to process.

Command ID: ${commandId}

The task is still running in the background. You will receive another email when it completes.

If you need immediate assistance, please reply to this email or contact support@webordinary.com.

---
Webordinary Edit Service`;

    try {
      await this.ses.send(
        new SendEmailCommand({
          Destination: {
            ToAddresses: [to],
          },
          Message: {
            Body: {
              Text: {
                Data: body,
              },
            },
            Subject: {
              Data: subject,
            },
          },
          Source: 'noreply@webordinary.com',
          ReplyToAddresses: ['support@webordinary.com'],
        }),
      );

      this.logger.log(`Sent timeout notification to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send timeout email:`, error);
    }
  }

  /**
   * Sends an error notification email
   */
  private async sendErrorEmail(
    to: string,
    originalSubject: string,
    inReplyTo: string,
    errorMessage: string,
  ): Promise<void> {
    const subject = `Re: ${originalSubject} - Processing Error`;
    const body = `An error occurred while processing your edit request:

${errorMessage}

Please check your request and try again. If the problem persists, contact support@webordinary.com.

---
Webordinary Edit Service`;

    try {
      await this.ses.send(
        new SendEmailCommand({
          Destination: {
            ToAddresses: [to],
          },
          Message: {
            Body: {
              Text: {
                Data: body,
              },
            },
            Subject: {
              Data: subject,
            },
          },
          Source: 'noreply@webordinary.com',
          ReplyToAddresses: ['support@webordinary.com'],
        }),
      );

      this.logger.log(`Sent error notification to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send error email:`, error);
    }
  }
}