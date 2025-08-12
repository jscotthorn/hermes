import { Injectable, Logger } from '@nestjs/common';
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { v4 as uuidv4 } from 'uuid';
import { MessageRouterService } from '../message-processor/message-router.service';

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
export class SqsExecutorService {
  private readonly logger = new Logger(SqsExecutorService.name);
  private readonly sqs: SQSClient;
  private readonly accountId: string;
  private readonly region: string;

  constructor(
    private readonly messageRouter: MessageRouterService,
  ) {
    this.sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-west-2' });
    this.accountId = process.env.AWS_ACCOUNT_ID || '942734823970';
    this.region = process.env.AWS_REGION || 'us-west-2';
  }

  /**
   * Execute an instruction by sending to container via SQS
   */
  async executeInstruction(
    sessionId: string,
    instruction: string,
    userEmail: string,
    threadId?: string,
  ): Promise<ExecutionResult> {
    try {
      this.logger.log(`Executing instruction for session ${sessionId} via SQS`);
      
      const commandId = uuidv4();
      
      // Route message to appropriate queue
      const routing = await this.messageRouter.routeMessage({
        sessionId,
        commandId,
        instruction,
        userEmail,
        threadId,
        type: 'execute',
        timestamp: Date.now(),
        source: 'email',
        context: {
          sessionId,
          requiresPlanning: this.requiresPlanning(instruction),
        },
      });
      
      this.logger.log(`Routed to ${routing.projectId}/${routing.userId} queues`);
      
      // Wait for response from output queue (with timeout)
      const response = await this.waitForResponse(
        routing.outputQueueUrl,
        commandId,
        60000, // 1 minute timeout for now, can increase
      );
      
      if (response) {
        return this.processContainerResponse(response, routing.projectId);
      }
      
      // If no response, check if container needs to be started
      if (routing.needsUnclaimed) {
        return {
          success: false,
          message: 'Starting editing environment. Please try again in a moment.',
          error: 'CONTAINER_STARTING',
        };
      }
      
      return {
        success: false,
        message: 'Request timed out. The editing environment may be busy.',
        error: 'TIMEOUT',
      };
    } catch (error) {
      this.logger.error(`Failed to execute instruction for session ${sessionId}`, error);
      
      return {
        success: false,
        message: 'An error occurred while processing your request. Please try again.',
        error: error.message,
      };
    }
  }

  /**
   * Wait for response from container via output queue
   */
  private async waitForResponse(
    outputQueueUrl: string,
    commandId: string,
    timeoutMs: number,
  ): Promise<any> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const result = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: outputQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 5,
          MessageAttributeNames: ['All'],
        }));
        
        if (result.Messages) {
          for (const message of result.Messages) {
            const body = JSON.parse(message.Body || '{}');
            
            // Check if this is the response we're waiting for
            if (body.commandId === commandId) {
              // Delete message from queue
              await this.sqs.send(new DeleteMessageCommand({
                QueueUrl: outputQueueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }));
              
              return body;
            }
          }
        }
      } catch (error) {
        this.logger.warn(`Error polling output queue: ${error.message}`);
      }
      
      // Wait a bit before polling again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return null; // Timeout
  }

  /**
   * Process response from container
   */
  private processContainerResponse(response: any, projectId: string): ExecutionResult {
    // Build preview URL for S3-hosted site
    const previewUrl = `https://edit.${projectId}.webordinary.com`;
    
    if (response.success) {
      return {
        success: true,
        message: response.summary || 'Changes completed successfully.',
        changes: response.filesChanged || [],
        previewUrl,
        requiresApproval: false,
      };
    }
    
    return {
      success: false,
      message: response.error || 'Failed to process request.',
      error: response.errorCode || 'PROCESSING_ERROR',
    };
  }

  /**
   * Check if instruction requires planning mode
   */
  private requiresPlanning(instruction: string): boolean {
    const planningKeywords = [
      'refactor',
      'restructure',
      'redesign',
      'architecture',
      'plan',
      'organize',
      'multiple',
      'complex',
      'migrate',
    ];
    
    const lowerInstruction = instruction.toLowerCase();
    return planningKeywords.some(keyword => lowerInstruction.includes(keyword));
  }
}