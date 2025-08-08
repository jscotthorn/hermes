import { Controller, Get, Param, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ClaudeAgentService } from '../services/claude-agent.service';

@Controller('api')
export class ApprovalController {
  constructor(private claudeAgentService: ClaudeAgentService) {}

  @Get('approve/:clientId/:userId/:threadId')
  async approvePlan(
    @Param('clientId') clientId: string,
    @Param('userId') userId: string,
    @Param('threadId') threadId: string,
    @Res() res: Response,
  ) {
    try {
      await this.claudeAgentService.approveAndExecute(clientId, userId, threadId);
      
      // Return HTML response for browser
      res.status(HttpStatus.OK).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Plan Approved</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
            .success { color: green; }
            .message { margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1 class="success">✅ Plan Approved</h1>
          <div class="message">
            <p>Your plan has been approved and is now being executed.</p>
            <p>You will receive an email once the task is complete.</p>
          </div>
        </body>
        </html>
      `);
    } catch (error) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Error</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <h1 class="error">❌ Error</h1>
          <p>${error.message || 'An error occurred while approving the plan.'}</p>
        </body>
        </html>
      `);
    }
  }

  @Get('reject/:clientId/:userId/:threadId')
  async rejectPlan(
    @Param('clientId') clientId: string,
    @Param('userId') userId: string,
    @Param('threadId') threadId: string,
    @Res() res: Response,
  ) {
    try {
      await this.claudeAgentService.rejectPlan(clientId, userId, threadId);
      
      res.status(HttpStatus.OK).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Plan Rejected</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
            .warning { color: orange; }
            .message { margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1 class="warning">⚠️ Plan Rejected</h1>
          <div class="message">
            <p>The plan has been rejected.</p>
            <p>Please reply to the email with more specific instructions.</p>
          </div>
        </body>
        </html>
      `);
    } catch (error) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Error</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <h1 class="error">❌ Error</h1>
          <p>${error.message || 'An error occurred while rejecting the plan.'}</p>
        </body>
        </html>
      `);
    }
  }
}