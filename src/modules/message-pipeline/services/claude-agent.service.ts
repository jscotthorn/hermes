import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-code';
import { ParsedMail } from 'mailparser';
import { SESService } from './ses.service';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface Session {
  clientId: string;
  userId: string;
  threadId: string;
  email: ParsedMail;
  plan?: any;
  status: 'pending' | 'approved' | 'rejected' | 'completed';
  history: Array<{
    timestamp: Date;
    action: string;
    result: any;
  }>;
  branch?: string;
  workspacePath?: string;
  messages?: SDKMessage[];
}

@Injectable()
export class ClaudeAgentService {
  private memoryCache = new Map<string, Session>();
  private abortControllers = new Map<string, AbortController>();

  constructor(
    private configService: ConfigService,
    private sesService: SESService,
  ) {}

  async processEmail(email: ParsedMail): Promise<void> {
    const threadId = this.extractThreadId(email);
    const clientId = this.extractClientId(email);
    const userId = this.extractUserId(email);
    
    try {
      const session = await this.getSession(clientId, userId, threadId) || 
        await this.createSession(clientId, userId, threadId, email);
      
      const mode = this.determineMode(email.text || '');
      
      if (mode === 'plan') {
        const plan = await this.generatePlan(email.text || '', session);
        await this.requestApproval(email, plan, session);
      } else {
        const result = await this.executeDirectly(email.text || '', session);
        await this.sendCompletionEmail(email, result, session);
      }
    } catch (error) {
      await this.sendErrorEmail(email, error);
    }
  }

  private async generatePlan(instruction: string, session: Session): Promise<any> {
    const workspacePath = `/workspace/${session.clientId}/${session.userId}/project`;
    const abortController = new AbortController();
    this.abortControllers.set(session.threadId, abortController);

    const prompt = `
      You are planning a website update task for ameliastamps.com.
      The user has requested: ${instruction}
      
      Create a detailed plan of actions needed to fulfill this request.
      Consider:
      1. What files need to be created/updated/deleted?
      2. Does this require user confirmation (e.g., deletions)?
      3. Should we build a preview first before publishing?
      4. Are there any ambiguities that need clarification?
      
      Workspace: ${workspacePath}
      Current branch: ${session.branch || 'main'}
      
      Generate a clear, step-by-step plan.
    `;

    const messages: SDKMessage[] = [];
    
    const options: Options = {
      abortController,
      maxTurns: 1,
      cwd: workspacePath,
      permissionMode: 'plan',
    };
    
    try {
      for await (const message of query({ prompt, options })) {
        messages.push(message);
      }

      const plan = this.extractPlanFromMessages(messages);
      session.messages = messages;
      await this.saveSession(session);
      
      return plan;
    } finally {
      this.abortControllers.delete(session.threadId);
    }
  }

  private async executeDirectly(instruction: string, session: Session): Promise<any> {
    const workspacePath = `/workspace/${session.clientId}/${session.userId}/project`;
    const abortController = new AbortController();
    this.abortControllers.set(session.threadId, abortController);

    const prompt = `
      Execute the following website update task for ameliastamps.com:
      ${instruction}
      
      Workspace: ${workspacePath}
      Current branch: ${session.branch || 'main'}
      
      You have full access to edit files, run commands, and make changes.
      After making changes, commit them to git with a descriptive message.
    `;

    const messages: SDKMessage[] = [];
    
    const options: Options = {
      abortController,
      maxTurns: 10, // Allow multiple turns for complex tasks
      cwd: workspacePath,
      permissionMode: 'bypassPermissions', // Allow full execution
    };
    
    try {
      for await (const message of query({ prompt, options })) {
        messages.push(message);
        
        // Track progress for assistant messages with tool use
        if (message.type === 'assistant' && message.message.content) {
          // Extract tool use information from assistant messages
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && 'type' in block && block.type === 'tool_use') {
                session.history.push({
                  timestamp: new Date(),
                  action: `Tool: ${block.name}`,
                  result: 'executed',
                });
              }
            }
          }
        }
      }

      session.messages = messages;
      session.status = 'completed';
      await this.saveSession(session);
      
      return {
        success: true,
        messages,
        summary: this.generateSummaryFromMessages(messages),
      };
    } catch (error) {
      console.error('Execution error:', error);
      throw error;
    } finally {
      this.abortControllers.delete(session.threadId);
    }
  }

  async approveAndExecute(clientId: string, userId: string, threadId: string): Promise<void> {
    const session = await this.getSession(clientId, userId, threadId);
    if (!session || session.status !== 'pending') {
      throw new Error('No pending approval found for this thread');
    }

    session.status = 'approved';
    await this.saveSession(session);

    // Execute the approved plan
    const result = await this.executeDirectly(
      `Execute the previously generated plan for thread ${threadId}`,
      session
    );
    
    await this.sendCompletionEmail(session.email, result, session);
  }

  async rejectPlan(clientId: string, userId: string, threadId: string): Promise<void> {
    const session = await this.getSession(clientId, userId, threadId);
    if (!session || session.status !== 'pending') {
      throw new Error('No pending approval found for this thread');
    }

    session.status = 'rejected';
    await this.saveSession(session);

    await this.sesService.sendEmail({
      to: session.email.from?.text,
      subject: `Re: ${session.email.subject} - Plan Rejected`,
      html: `
        <h2>Your plan has been rejected</h2>
        <p>Please provide more specific instructions or clarifications for your request.</p>
      `,
    });
  }

  private determineMode(text: string): 'plan' | 'execute' {
    const complexKeywords = ['redesign', 'refactor', 'delete', 'remove', 'multiple', 'major'];
    const needsPlan = complexKeywords.some(keyword => 
      text.toLowerCase().includes(keyword)
    );
    return needsPlan ? 'plan' : 'execute';
  }

  private extractPlanFromMessages(messages: SDKMessage[]): any {
    // Extract plan from Claude's assistant responses
    const assistantMessages = messages.filter(m => m.type === 'assistant');
    if (assistantMessages.length === 0) return null;

    let planText = '';
    for (const msg of assistantMessages) {
      const content = msg.message.content;
      if (typeof content === 'string') {
        planText += content + '\n';
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && 'type' in block && block.type === 'text') {
            planText += block.text + '\n';
          }
        }
      }
    }
    
    // Try to parse structured plan if Claude provided JSON
    try {
      const jsonMatch = planText.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
    } catch (e) {
      // Fall back to text plan
    }

    return {
      type: 'text',
      content: planText,
      steps: this.extractStepsFromText(planText),
    };
  }

  private extractStepsFromText(text: string): string[] {
    const lines = text.split('\n');
    const steps: string[] = [];
    
    for (const line of lines) {
      // Look for numbered lists or bullet points
      if (/^\d+\.|^[-*•]/.test(line.trim())) {
        steps.push(line.trim());
      }
    }
    
    return steps;
  }

  private generateSummaryFromMessages(messages: SDKMessage[]): string {
    const assistantMessages = messages.filter(m => m.type === 'assistant');
    const resultMessages = messages.filter(m => m.type === 'result');
    
    let summary = 'Task completed successfully.\n\n';
    
    // Check if there's a result message
    if (resultMessages.length > 0) {
      const result = resultMessages[0];
      if (result.type === 'result' && result.subtype === 'success') {
        summary += `Result: ${result.result}\n`;
        summary += `Duration: ${result.duration_ms}ms\n`;
        summary += `Turns: ${result.num_turns}\n`;
      }
    }
    
    // Extract tool uses from assistant messages
    const toolUses: string[] = [];
    for (const msg of assistantMessages) {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && 'type' in block && block.type === 'tool_use') {
            toolUses.push(`- ${block.name}`);
          }
        }
      }
    }
    
    if (toolUses.length > 0) {
      summary += `\nActions performed:\n${toolUses.join('\n')}\n`;
    }
    
    // Add any text content
    let textContent = '';
    for (const msg of assistantMessages) {
      const content = msg.message.content;
      if (typeof content === 'string') {
        textContent += content + '\n';
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && 'type' in block && block.type === 'text') {
            textContent += block.text + '\n';
          }
        }
      }
    }
    
    if (textContent) {
      summary += '\nDetails:\n' + textContent.substring(0, 500);
    }
    
    return summary;
  }

  private extractThreadId(email: ParsedMail): string {
    return email.messageId || `thread-${Date.now()}`;
  }

  private extractClientId(email: ParsedMail): string {
    // Extract from email domain or use default
    const fromEmail = email.from?.value?.[0]?.address || '';
    const domain = fromEmail.split('@')[1] || 'default';
    return domain.replace(/\./g, '-');
  }

  private extractUserId(email: ParsedMail): string {
    // Extract from email address
    const fromEmail = email.from?.value?.[0]?.address || 'unknown';
    return fromEmail.split('@')[0];
  }

  private async createSession(
    clientId: string, 
    userId: string, 
    threadId: string, 
    email: ParsedMail
  ): Promise<Session> {
    const session: Session = {
      clientId,
      userId,
      threadId,
      email,
      status: 'pending',
      history: [],
      branch: `thread-${threadId}`,
      workspacePath: `/workspace/${clientId}/${userId}/project`,
    };

    await this.saveSession(session);
    return session;
  }

  private async getSession(
    clientId: string, 
    userId: string, 
    threadId: string
  ): Promise<Session | null> {
    const key = `${clientId}/${userId}/${threadId}`;
    
    // Check memory cache first
    if (this.memoryCache.has(key)) {
      return this.memoryCache.get(key)!;
    }
    
    // Check EFS for persisted session
    const efsPath = `/workspace/${clientId}/${userId}/.claude/threads/${threadId}.json`;
    
    try {
      const data = await fs.readFile(efsPath, 'utf-8');
      const session = JSON.parse(data) as Session;
      this.memoryCache.set(key, session);
      return session;
    } catch (error) {
      return null;
    }
  }

  private async saveSession(session: Session): Promise<void> {
    const key = `${session.clientId}/${session.userId}/${session.threadId}`;
    
    // Update memory cache
    this.memoryCache.set(key, session);
    
    // Persist to EFS
    const efsPath = `/workspace/${session.clientId}/${session.userId}/.claude/threads/${session.threadId}.json`;
    const dir = path.dirname(efsPath);
    
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(efsPath, JSON.stringify(session, null, 2));
  }

  private async requestApproval(email: ParsedMail, plan: any, session: Session): Promise<void> {
    const approvalUrl = `https://edit.ameliastamps.com/api/approve/${session.clientId}/${session.userId}/${session.threadId}`;
    const rejectUrl = `https://edit.ameliastamps.com/api/reject/${session.clientId}/${session.userId}/${session.threadId}`;
    
    const planHtml = typeof plan === 'string' 
      ? `<pre>${plan}</pre>`
      : `<pre>${JSON.stringify(plan, null, 2)}</pre>`;
    
    const htmlContent = `
      <h2>Plan for your request:</h2>
      ${planHtml}
      <p>
        <a href="${approvalUrl}" style="background: green; color: white; padding: 10px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px;">
          Approve Plan
        </a>
        <a href="${rejectUrl}" style="background: red; color: white; padding: 10px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px;">
          Reject Plan
        </a>
      </p>
    `;
    
    await this.sesService.sendEmail({
      to: email.from?.text,
      subject: `Re: ${email.subject} - Approval Required`,
      html: htmlContent,
    });
    
    session.plan = plan;
    session.status = 'pending';
    await this.saveSession(session);
  }

  private async sendCompletionEmail(email: ParsedMail, result: any, session: Session): Promise<void> {
    const htmlContent = `
      <h2>Task Completed</h2>
      <p>${result.summary || 'Your request has been completed successfully.'}</p>
      <p>View your updated site at: <a href="https://ameliastamps.com">ameliastamps.com</a></p>
      <hr>
      <p><small>Thread ID: ${session.threadId}</small></p>
    `;
    
    await this.sesService.sendEmail({
      to: email.from?.text,
      subject: `Re: ${email.subject} - Completed`,
      html: htmlContent,
    });
  }

  private async sendErrorEmail(email: ParsedMail, error: any): Promise<void> {
    const htmlContent = `
      <h2>Error Processing Request</h2>
      <p>We encountered an error while processing your request:</p>
      <pre>${error.message || 'Unknown error'}</pre>
      <p>Please try rephrasing your request or contact support if the issue persists.</p>
    `;
    
    await this.sesService.sendEmail({
      to: email.from?.text,
      subject: `Re: ${email.subject} - Error`,
      html: htmlContent,
    });
  }

  // Utility method to cancel ongoing operations
  async cancelOperation(threadId: string): Promise<void> {
    const controller = this.abortControllers.get(threadId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(threadId);
    }
  }
}