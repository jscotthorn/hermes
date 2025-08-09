import { Controller, Post, Body, Get, Param, Logger } from '@nestjs/common';
import { EmailProcessorService } from './email-processor.service';
import { ClaudeExecutorService } from '../claude-executor/claude-executor.service';
import { SQSEvent } from 'aws-lambda';

@Controller('email')
export class EmailProcessorController {
  private readonly logger = new Logger(EmailProcessorController.name);

  constructor(
    private readonly emailProcessor: EmailProcessorService,
    private readonly claudeExecutor: ClaudeExecutorService,
  ) {}

  /**
   * Process SQS events containing emails
   * This endpoint is called by AWS Lambda or direct SQS integration
   */
  @Post('process')
  async processSQSEvent(@Body() event: SQSEvent) {
    this.logger.log(`Received SQS event with ${event.Records?.length || 0} records`);
    
    if (!event.Records || event.Records.length === 0) {
      return { message: 'No records to process' };
    }
    
    await this.emailProcessor.processSQSEvent(event);
    
    return {
      message: `Processed ${event.Records.length} messages`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Approve a plan that requires confirmation
   */
  @Get('approve/:sessionId/:token')
  async approvePlan(
    @Param('sessionId') sessionId: string,
    @Param('token') token: string,
  ) {
    this.logger.log(`Approving plan for session ${sessionId}`);
    
    const result = await this.claudeExecutor.executeApprovedPlan(sessionId, token);
    
    // Return HTML response for browser
    if (result.success) {
      return `
        <html>
          <head><title>Plan Approved</title></head>
          <body>
            <h1>✅ Plan Approved</h1>
            <p>${result.message}</p>
            ${result.previewUrl ? `<p><a href="${result.previewUrl}">View your changes</a></p>` : ''}
            <p>You can close this window.</p>
          </body>
        </html>
      `;
    } else {
      return `
        <html>
          <head><title>Error</title></head>
          <body>
            <h1>❌ Error</h1>
            <p>${result.message}</p>
            <p>Please try again or contact support.</p>
          </body>
        </html>
      `;
    }
  }

  /**
   * Reject a plan
   */
  @Get('reject/:sessionId/:token')
  async rejectPlan(
    @Param('sessionId') sessionId: string,
    @Param('token') token: string,
  ) {
    this.logger.log(`Rejecting plan for session ${sessionId}`);
    
    const result = await this.claudeExecutor.rejectPlan(sessionId, token);
    
    // Return HTML response for browser
    return `
      <html>
        <head><title>Plan Rejected</title></head>
        <body>
          <h1>❌ Plan Rejected</h1>
          <p>${result.message}</p>
          <p>You can close this window.</p>
        </body>
      </html>
    `;
  }

  /**
   * Health check endpoint
   */
  @Get('health')
  health() {
    return {
      status: 'healthy',
      service: 'email-processor',
      timestamp: new Date().toISOString(),
    };
  }
}