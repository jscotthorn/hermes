import { Injectable, Logger } from '@nestjs/common';
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ContainerQueues } from './queue-manager.service';

export interface EditCommand {
  sessionId: string;
  commandId: string;
  timestamp: number;
  type: 'edit' | 'build' | 'commit' | 'push' | 'preview' | 'interrupt';
  instruction: string;
  userEmail: string;
  chatThreadId: string;
  context: {
    branch: string;
    clientId: string;
    projectId: string;
    userId: string;
    lastCommit?: string;
    filesModified?: string[];
    previousCommands?: string[];
  };
  priority?: 'normal' | 'high';
}

export interface CommandResponse {
  sessionId: string;
  commandId: string;
  timestamp: number;
  completedAt: number;
  success: boolean;
  summary?: string;
  filesChanged?: string[];
  error?: string;
  previewUrl?: string;
  interrupted?: boolean;
  interruptedBy?: string;
  gitCommit?: string;
  branch?: string;
}

interface ActiveCommand {
  commandId: string;
  sessionId: string;
  chatThreadId: string;
  startTime: number;
  queueUrl: string;
  resolve: (response: CommandResponse) => void;
  reject: (error: Error) => void;
}

@Injectable()
export class CommandExecutorService {
  private readonly logger = new Logger(CommandExecutorService.name);
  private readonly sqs: SQSClient;
  private readonly activeCommands: Map<string, ActiveCommand> = new Map();
  private readonly sessionCommands: Map<string, string[]> = new Map();

  constructor(private readonly eventEmitter: EventEmitter2) {
    this.sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-west-2' });

    // Listen for interrupt events
    this.eventEmitter.on('session.interrupt', this.handleInterruptEvent.bind(this));
  }

  /**
   * Sends an edit command and waits for response
   */
  async executeCommand(
    queues: ContainerQueues,
    command: Omit<EditCommand, 'commandId' | 'timestamp'>,
    timeoutSeconds: number = 300,
  ): Promise<CommandResponse> {
    const commandId = uuidv4();
    const fullCommand: EditCommand = {
      ...command,
      commandId,
      timestamp: Date.now(),
      priority: command.type === 'interrupt' ? 'high' : 'normal',
    };

    this.logger.log(
      `Executing ${command.type} command ${commandId} for session ${command.sessionId}`,
    );

    // Check if there's an active command for this session that needs interrupting
    const existingCommands = this.sessionCommands.get(command.sessionId) || [];
    if (existingCommands.length > 0 && command.type !== 'interrupt') {
      this.logger.log(`Interrupting ${existingCommands.length} active commands for session ${command.sessionId}`);
      
      // Send interrupt signal first
      await this.sendInterrupt(
        queues.inputUrl,
        command.sessionId,
        command.chatThreadId,
      );
      
      // Mark existing commands as interrupted
      for (const existingCmdId of existingCommands) {
        const activeCmd = this.activeCommands.get(existingCmdId);
        if (activeCmd) {
          activeCmd.resolve({
            sessionId: command.sessionId,
            commandId: existingCmdId,
            timestamp: activeCmd.startTime,
            completedAt: Date.now(),
            success: false,
            interrupted: true,
            interruptedBy: commandId,
            summary: 'Command interrupted by newer request',
          });
          this.activeCommands.delete(existingCmdId);
        }
      }
      this.sessionCommands.delete(command.sessionId);
    }

    // Send the command
    await this.sendCommand(queues.inputUrl, fullCommand);

    // Start polling for response
    return new Promise<CommandResponse>((resolve, reject) => {
      // Track active command
      const activeCommand: ActiveCommand = {
        commandId,
        sessionId: command.sessionId,
        chatThreadId: command.chatThreadId,
        startTime: Date.now(),
        queueUrl: queues.outputUrl,
        resolve,
        reject,
      };

      this.activeCommands.set(commandId, activeCommand);
      
      // Track by session
      const sessionCmds = this.sessionCommands.get(command.sessionId) || [];
      sessionCmds.push(commandId);
      this.sessionCommands.set(command.sessionId, sessionCmds);

      // Start polling
      this.pollForResponse(commandId, queues.outputUrl, timeoutSeconds);
    });
  }

  /**
   * Sends a command to the input queue
   */
  private async sendCommand(queueUrl: string, command: EditCommand): Promise<void> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(command),
          MessageAttributes: {
            CommandId: {
              DataType: 'String',
              StringValue: command.commandId,
            },
            SessionId: {
              DataType: 'String',
              StringValue: command.sessionId,
            },
            Type: {
              DataType: 'String',
              StringValue: command.type,
            },
            Priority: {
              DataType: 'String',
              StringValue: command.priority || 'normal',
            },
          },
          // High priority messages get no delay
          DelaySeconds: command.priority === 'high' ? 0 : undefined,
        }),
      );

      this.logger.debug(`Sent ${command.type} command ${command.commandId}`);
    } catch (error) {
      this.logger.error(`Failed to send command:`, error);
      throw error;
    }
  }

  /**
   * Sends an interrupt signal
   */
  async sendInterrupt(
    queueUrl: string,
    sessionId: string,
    chatThreadId: string,
  ): Promise<string> {
    const commandId = uuidv4();
    const interruptCommand: EditCommand = {
      sessionId,
      commandId,
      timestamp: Date.now(),
      type: 'interrupt',
      instruction: 'INTERRUPT: Stop current work immediately',
      userEmail: 'system@webordinary.com',
      chatThreadId,
      context: {
        branch: `thread-${chatThreadId}`,
        clientId: '',
        projectId: '',
        userId: '',
      },
      priority: 'high',
    };

    await this.sendCommand(queueUrl, interruptCommand);
    this.logger.log(`Sent interrupt ${commandId} for session ${sessionId}`);
    
    return commandId;
  }

  /**
   * Polls for command response
   */
  private async pollForResponse(
    commandId: string,
    queueUrl: string,
    timeoutSeconds: number,
  ): Promise<void> {
    const activeCommand = this.activeCommands.get(commandId);
    if (!activeCommand) {
      return;
    }

    const endTime = Date.now() + timeoutSeconds * 1000;
    const pollInterval = 2000; // 2 seconds between polls

    while (Date.now() < endTime) {
      // Check if command was interrupted
      if (!this.activeCommands.has(commandId)) {
        this.logger.debug(`Command ${commandId} was interrupted, stopping poll`);
        return;
      }

      try {
        const result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 5, // Long polling
            MessageAttributeNames: ['All'],
          }),
        );

        if (result.Messages) {
          for (const message of result.Messages) {
            const response = JSON.parse(message.Body!) as CommandResponse;
            
            // Check if this is our response
            if (response.commandId === commandId) {
              this.logger.log(
                `Received response for command ${commandId}: ${
                  response.success ? 'success' : 'failed'
                }`,
              );

              // Delete message from queue
              await this.sqs.send(
                new DeleteMessageCommand({
                  QueueUrl: queueUrl,
                  ReceiptHandle: message.ReceiptHandle!,
                }),
              );

              // Resolve promise
              activeCommand.resolve(response);
              
              // Cleanup
              this.activeCommands.delete(commandId);
              this.removeCommandFromSession(activeCommand.sessionId, commandId);
              
              return;
            } else {
              // Check if this is a response for another active command
              const otherCommand = this.activeCommands.get(response.commandId);
              if (otherCommand) {
                this.logger.debug(
                  `Received response for different command ${response.commandId}`,
                );
                
                // Delete message and resolve the other command
                await this.sqs.send(
                  new DeleteMessageCommand({
                    QueueUrl: queueUrl,
                    ReceiptHandle: message.ReceiptHandle!,
                  }),
                );
                
                otherCommand.resolve(response);
                this.activeCommands.delete(response.commandId);
                this.removeCommandFromSession(otherCommand.sessionId, response.commandId);
              }
            }
          }
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        this.logger.error(`Error polling for response:`, error);
        
        // Don't immediately fail, continue polling
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    // Timeout reached
    this.logger.warn(`Command ${commandId} timed out after ${timeoutSeconds} seconds`);
    
    activeCommand.reject(new Error(`Command timeout after ${timeoutSeconds} seconds`));
    this.activeCommands.delete(commandId);
    this.removeCommandFromSession(activeCommand.sessionId, commandId);
  }

  /**
   * Handles interrupt events from other services
   */
  private async handleInterruptEvent(payload: {
    sessionId: string;
    reason: string;
  }): Promise<void> {
    this.logger.log(`Handling interrupt event for session ${payload.sessionId}: ${payload.reason}`);
    
    const commands = this.sessionCommands.get(payload.sessionId) || [];
    
    for (const commandId of commands) {
      const activeCommand = this.activeCommands.get(commandId);
      if (activeCommand) {
        activeCommand.resolve({
          sessionId: payload.sessionId,
          commandId,
          timestamp: activeCommand.startTime,
          completedAt: Date.now(),
          success: false,
          interrupted: true,
          summary: `Interrupted: ${payload.reason}`,
        });
        
        this.activeCommands.delete(commandId);
      }
    }
    
    this.sessionCommands.delete(payload.sessionId);
  }

  /**
   * Removes a command from session tracking
   */
  private removeCommandFromSession(sessionId: string, commandId: string): void {
    const commands = this.sessionCommands.get(sessionId);
    if (commands) {
      const filtered = commands.filter((id) => id !== commandId);
      if (filtered.length > 0) {
        this.sessionCommands.set(sessionId, filtered);
      } else {
        this.sessionCommands.delete(sessionId);
      }
    }
  }

  /**
   * Gets queue metrics
   */
  async getQueueMetrics(queueUrl: string): Promise<{
    messagesAvailable: number;
    messagesInFlight: number;
    messagesDelayed: number;
  }> {
    try {
      const result = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed',
          ],
        }),
      );

      return {
        messagesAvailable: parseInt(
          result.Attributes?.ApproximateNumberOfMessages || '0',
        ),
        messagesInFlight: parseInt(
          result.Attributes?.ApproximateNumberOfMessagesNotVisible || '0',
        ),
        messagesDelayed: parseInt(
          result.Attributes?.ApproximateNumberOfMessagesDelayed || '0',
        ),
      };
    } catch (error) {
      this.logger.error(`Failed to get queue metrics:`, error);
      return {
        messagesAvailable: 0,
        messagesInFlight: 0,
        messagesDelayed: 0,
      };
    }
  }

  /**
   * Cancels all active commands for a session
   */
  async cancelSessionCommands(sessionId: string): Promise<void> {
    const commands = this.sessionCommands.get(sessionId) || [];
    
    this.logger.log(`Cancelling ${commands.length} commands for session ${sessionId}`);
    
    for (const commandId of commands) {
      const activeCommand = this.activeCommands.get(commandId);
      if (activeCommand) {
        activeCommand.reject(new Error('Session cancelled'));
        this.activeCommands.delete(commandId);
      }
    }
    
    this.sessionCommands.delete(sessionId);
  }

  /**
   * Gets active command status
   */
  getActiveCommands(): Array<{
    commandId: string;
    sessionId: string;
    chatThreadId: string;
    runningTime: number;
  }> {
    const now = Date.now();
    
    return Array.from(this.activeCommands.values()).map((cmd) => ({
      commandId: cmd.commandId,
      sessionId: cmd.sessionId,
      chatThreadId: cmd.chatThreadId,
      runningTime: now - cmd.startTime,
    }));
  }
}