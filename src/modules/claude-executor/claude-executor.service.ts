import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

export interface ExecutionResult {
  success: boolean;
  message: string;
  changes?: string[];
  previewUrl?: string;
  requiresApproval?: boolean;
  plan?: any;
  approvalToken?: string;
  error?: string;
}

@Injectable()
export class ClaudeExecutorService {
  private readonly logger = new Logger(ClaudeExecutorService.name);
  private readonly baseUrl: string;

  constructor(private readonly httpService: HttpService) {
    this.baseUrl = process.env.ALB_URL || 'https://webordinary-edit-alb-916355172.us-west-2.elb.amazonaws.com';
  }

  /**
   * Execute an instruction using Claude Code in the Fargate container
   */
  async executeInstruction(
    sessionId: string,
    instruction: string,
    userEmail: string,
  ): Promise<ExecutionResult> {
    try {
      this.logger.log(`Executing instruction for session ${sessionId}`);
      
      // Prepare the request to Claude Code container
      const requestData = {
        instruction,
        userEmail,
        sessionId,
        capabilities: ['read', 'write', 'git', 'terminal', 'astro'],
        autoCommit: true,
        planningMode: this.requiresPlanning(instruction),
      };
      
      // Call Claude Code API in container
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/api/claude/${sessionId}/execute`,
          requestData,
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 300000, // 5 minute timeout for complex operations
          }
        )
      );
      
      const result = response.data;
      
      // Handle different response types
      if (result.requiresApproval) {
        return this.createApprovalRequest(result, sessionId);
      }
      
      // Build preview URL
      const previewUrl = this.buildPreviewUrl(sessionId);
      
      return {
        success: result.success !== false,
        message: result.summary || result.message || 'Changes completed successfully.',
        changes: this.formatChanges(result),
        previewUrl,
        requiresApproval: false,
      };
    } catch (error) {
      this.logger.error(`Failed to execute instruction for session ${sessionId}`, error);
      
      // Handle specific error cases
      if (error.response?.status === 404) {
        return {
          success: false,
          message: 'Session not found. The editing environment may have timed out.',
          error: 'SESSION_NOT_FOUND',
        };
      }
      
      if (error.code === 'ECONNREFUSED') {
        return {
          success: false,
          message: 'The editing environment is starting up. Please try again in a moment.',
          error: 'CONTAINER_STARTING',
        };
      }
      
      return {
        success: false,
        message: 'An error occurred while processing your request. Please try again.',
        error: error.message,
      };
    }
  }

  /**
   * Check if an instruction requires planning/approval
   */
  private requiresPlanning(instruction: string): boolean {
    const planningKeywords = [
      'delete',
      'remove',
      'drop',
      'destroy',
      'reset',
      'clear all',
      'wipe',
      'major change',
      'restructure',
      'refactor everything',
      'rebuild',
      'migrate',
    ];
    
    const instructionLower = instruction.toLowerCase();
    return planningKeywords.some(keyword => instructionLower.includes(keyword));
  }

  /**
   * Create an approval request for changes that need confirmation
   */
  private createApprovalRequest(result: any, sessionId: string): ExecutionResult {
    const approvalToken = uuidv4();
    
    // Store approval data (would normally go to DynamoDB)
    // For now, we'll include it in the response
    
    return {
      success: true,
      requiresApproval: true,
      plan: result.plan,
      approvalToken,
      message: this.formatPlanMessage(result.plan),
      previewUrl: this.buildPreviewUrl(sessionId),
    };
  }

  /**
   * Format plan for email message
   */
  private formatPlanMessage(plan: any): string {
    if (!plan) {
      return 'This change requires your approval before proceeding.';
    }
    
    let message = 'I\'ve prepared a plan for your request:\n\n';
    
    if (Array.isArray(plan)) {
      plan.forEach((step: any, index: number) => {
        message += `${index + 1}. ${step.description || step}\n`;
      });
    } else if (typeof plan === 'object') {
      message += `${plan.description || JSON.stringify(plan, null, 2)}\n`;
    } else {
      message += `${plan}\n`;
    }
    
    message += '\nPlease approve or reject this plan using the links below.';
    return message;
  }

  /**
   * Format changes for email message
   */
  private formatChanges(result: any): string[] {
    const changes: string[] = [];
    
    if (result.filesChanged && Array.isArray(result.filesChanged)) {
      result.filesChanged.forEach((file: any) => {
        if (typeof file === 'string') {
          changes.push(`Modified: ${file}`);
        } else if (file.path) {
          changes.push(`${file.action || 'Modified'}: ${file.path}`);
        }
      });
    }
    
    if (result.changes && Array.isArray(result.changes)) {
      changes.push(...result.changes);
    }
    
    if (result.gitCommit) {
      changes.push(`Git commit: ${result.gitCommit}`);
    }
    
    return changes;
  }

  /**
   * Build preview URL for the session
   */
  private buildPreviewUrl(sessionId: string): string {
    const domain = process.env.PREVIEW_DOMAIN || 'edit.amelia.webordinary.com';
    return `https://${domain}/session/${sessionId}/`;
  }

  /**
   * Execute an approved plan
   */
  async executeApprovedPlan(
    sessionId: string,
    approvalToken: string,
  ): Promise<ExecutionResult> {
    try {
      this.logger.log(`Executing approved plan for session ${sessionId}`);
      
      // Call the container API to execute the approved plan
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/api/claude/${sessionId}/execute-approved`,
          { approvalToken },
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 300000,
          }
        )
      );
      
      const result = response.data;
      
      return {
        success: true,
        message: 'The approved changes have been applied successfully.',
        changes: this.formatChanges(result),
        previewUrl: this.buildPreviewUrl(sessionId),
      };
    } catch (error) {
      this.logger.error(`Failed to execute approved plan`, error);
      
      return {
        success: false,
        message: 'Failed to execute the approved plan. Please try again.',
        error: error.message,
      };
    }
  }

  /**
   * Reject a plan
   */
  async rejectPlan(
    sessionId: string,
    approvalToken: string,
  ): Promise<ExecutionResult> {
    this.logger.log(`Plan rejected for session ${sessionId}`);
    
    // Notify the container that the plan was rejected
    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/api/claude/${sessionId}/reject-plan`,
          { approvalToken },
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      );
    } catch (error) {
      // Log but don't fail
      this.logger.warn('Failed to notify container of plan rejection', error);
    }
    
    return {
      success: true,
      message: 'The plan has been rejected. Please send a new email with updated instructions if needed.',
    };
  }
}