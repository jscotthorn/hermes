import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { BedrockService } from 'src/modules/bedrock/services/bedrock.service';
import * as _ from 'lodash-es';
import { SqsConsumerEventHandler, SqsMessageHandler } from '@ssut/nestjs-sqs';
import { Message } from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { simpleParser, ParsedMail } from 'mailparser';
import * as EmailReplyParser from 'email-reply-parser';
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { AgentService } from './agent.service';
import { ClaudeAgentService } from './claude-agent.service';
const mjml2html = require("mjml");

const SOURCE_EMAIL = "buddy@webordinary.com";

const responseTemplate = (response: string, uuid: string) => `
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>
          ${response}
        </mj-text>
      </mj-column>
    </mj-section>
    <mj-section>
      <mj-column>
        <mj-text font-size="10px" color="#333333">
          Conversation ID: ${uuid}
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
`;

@Injectable()
export class PipelineService {
    #sesClient: SESClient;
    #useClaudeCode: boolean;
    
    constructor(
        private bedrockService: BedrockService, 
        private configService: ConfigService, 
        private agentService: AgentService,
        private claudeAgentService: ClaudeAgentService,
    ) {
        this.#sesClient = new SESClient({
            region: 'us-east-2',
            credentials: {
                accessKeyId: this.configService.get<string>('aws.accessKeyId') ?? '',
                secretAccessKey: this.configService.get<string>('aws.secretAccessKey') ?? '',
            },
        });
        
        // Check feature flag
        this.#useClaudeCode = this.configService.get<boolean>('featureFlags.useClaudeCode') ?? false;
        console.log(`Using ${this.#useClaudeCode ? 'Claude Code SDK' : 'LangGraph'} for agent processing`);
    }

    async startNewChat(text: string) {
        const routerResponse = await this.bedrockService.runConfiguredPrompt('prompts.firstLevelRouter', text);
        // Validate routerResponse is numeric.
        if (isNaN(Number(routerResponse))) {
            // @todo: better error handling, retry maybe
            console.error('routerResponse of firstLevelRouter is not a number', { routerResponse, text });
            throw new InternalServerErrorException('Problem while processing routerResponse');
        }

        switch (Number(routerResponse)) {
            case 1:
                const createResponse = await this.bedrockService.runConfiguredPrompt('prompts.createContent', text);
                console.log(createResponse);
                return createResponse;
            default:
            // @todo
        }
    }

    @SqsMessageHandler(/** name: */ "buddy-email-consumer", /** batch: */ false)
    public async handleMessage(message: Message) {
        try {
            const body = JSON.parse(message.Body ?? '{}');

            const base64Raw = body.content;
            const rawBuffer = Buffer.from(base64Raw, 'base64');
            await this.handleInboundEmail(rawBuffer);

            const parsed = await simpleParser(rawBuffer);

            console.log('Subject:', parsed.subject);
            console.log('From:', parsed.from?.text);
            //console.log('Text body:', parsed.text);
            //console.log('HTML body:', parsed.html);
            console.log('Attachments:', parsed.attachments.length);

            const reply = new EmailReplyParser().parseReply(parsed.text);
            console.log('reply', reply);

            // These are now handled by the agent
            // const replied = new EmailReplyParser().parseReplied(parsed.text);
            // const email = new EmailReplyParser().read(parsed.text);

            for (const attachment of parsed.attachments) {
                console.log(`Attachment filename: ${attachment.filename}`);
            }
            if (body?.Records) {
                // SQS batch message
                for (const record of body.Records) {
                    //await this.startNewChat(record.body);
                }
            } else {
                // Single message
                //await this.startNewChat(message.Body ?? '');
            }
        } catch (error) {
            console.error('Error processing message', { error, message });
        }
    }

    @SqsConsumerEventHandler(
        /** name: */ "buddy-email-consumer",
        /** eventName: */ "processing_error",
    )
    public onProcessingError(error: Error, message: Message) {
        console.error('Error processing message', { error, message });
    }

    renderMjml(mjml: string): string {
        const { html, errors } = mjml2html(mjml, { validationLevel: "strict" });
        if (errors.length) {
            console.error("MJML validation errors", errors);
        }
        return html;
    }

    buildMime({
        from,
        to,
        subject,
        plainText,
        html,
        inReplyTo,
        references,
    }: {
        from: string;
        to: string;
        subject: string;
        plainText: string;
        html: string;
        inReplyTo: string;
        references: string;
    }): string {
        const boundary = `mime_boundary_${Date.now()}`;

        return [
            `From: ${from}`,
            `To: ${to}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `In-Reply-To: ${inReplyTo}`,
            `References: ${references}`,
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            `Content-Type: text/plain; charset=UTF-8`,
            "",
            plainText,
            "",
            `--${boundary}`,
            `Content-Type: text/html; charset=UTF-8`,
            "",
            html,
            "",
            `--${boundary}--`,
            "",
        ].join("\r\n");
    }

    async handleInboundEmail(rawInbound: Buffer | string) {
        // 1️⃣  Parse the inbound message
        const parsed = await simpleParser(rawInbound);
        const originalMessageId = parsed.messageId; // <abcdefg@domain>
        const originalSubject = parsed.subject || "";
        const originalSender = parsed.from?.value[0]?.address || "";
        
        // Skip processing if there's no text content (e.g., system notifications)
        if (!parsed.text) {
            console.log('Skipping email without text content', { subject: originalSubject, sender: originalSender });
            return;
        }

        // Check for a UUID from a previous reply to continue conversation
        const rx = /Conversation ID:\s*([A-Za-z0-9-]+)/i;
        const match = rx.exec(parsed.text || parsed.html || '');
        const threadId = match?.[1];

        try {
            // Use feature flag to determine which agent to use
            if (this.#useClaudeCode) {
                // Use new Claude Code SDK agent
                await this.claudeAgentService.processEmail(parsed);
                // Claude agent handles its own email responses
                return;
            }
            
            // Use existing LangGraph agent
            const response = await this.agentService.invokeApp(parsed, threadId);
            console.log("Agent response", { response });

            // Check if agent is awaiting user input (interrupted)
            if (response.state?.awaitingUser) {
                // Agent has paused for user input - send email with questions
                const interrupt = response.state.interrupt;
                const questions = interrupt?.questions || [];
                const draftPlan = interrupt?.draftPlan;
                
                let emailContent = questions.join("\n\n");
                
                if (draftPlan && draftPlan.length > 0) {
                    emailContent += "\n\n**Planned Actions:**\n";
                    draftPlan.forEach((step, idx) => {
                        emailContent += `${idx + 1}. ${step.description || step.tool}\n`;
                    });
                }
                
                emailContent += `\n\nPlease reply to this email to continue.\n\nConversation ID: ${response.thread_id}`;
                
                await this.sendEmail({
                    to: originalSender,
                    subject: originalSubject.startsWith("Re:") ? originalSubject : `Re: ${originalSubject}`,
                    content: emailContent,
                    inReplyTo: originalMessageId,
                    references: originalMessageId,
                });
            } else {
                // Normal completion - send results
                const lastMessage = response.response;
                const content = typeof lastMessage.content === 'string' 
                    ? lastMessage.content 
                    : JSON.stringify(lastMessage.content);
                
                await this.sendEmail({
                    to: originalSender,
                    subject: originalSubject.startsWith("Re:") ? originalSubject : `Re: ${originalSubject}`,
                    content: content + `\n\nConversation ID: ${response.thread_id}`,
                    inReplyTo: originalMessageId,
                    references: originalMessageId,
                });
            }
        } catch (error) {
            console.error("Error processing email:", error);
            
            // Send error notification
            await this.sendEmail({
                to: originalSender,
                subject: originalSubject.startsWith("Re:") ? originalSubject : `Re: ${originalSubject}`,
                content: `I encountered an error processing your request. Please try again or contact support.\n\nError: ${error.message}`,
                inReplyTo: originalMessageId,
                references: originalMessageId,
            });
        }
    }

    async sendEmail(params: {
        to: string;
        subject: string;
        content: string;
        inReplyTo?: string;
        references?: string;
    }) {
        const { to, subject, content, inReplyTo, references } = params;
        
        // Create HTML version
        const htmlBody = this.renderMjml(responseTemplate(content, ''));
        
        // Build MIME
        const mime = this.buildMime({
            from: SOURCE_EMAIL,
            to,
            subject,
            plainText: content,
            html: htmlBody,
            inReplyTo: inReplyTo || '',
            references: references || '',
        });

        // Send via SES
        const cmd = new SendRawEmailCommand({
            RawMessage: { Data: Buffer.from(mime) },
            Source: SOURCE_EMAIL,
        });

        const result = await this.#sesClient.send(cmd);
        console.log("Email sent, SES MessageId:", result.MessageId);
    }
}
