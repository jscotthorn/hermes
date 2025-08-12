/**
 * Shared message types for queue communication between Hermes and Claude Container
 */

/**
 * Base message structure for all queue messages
 */
export interface BaseQueueMessage {
  /**
   * Type of message - determines how it should be processed
   */
  type?: 'claim_request' | 'work' | 'response';
  
  /**
   * Unique session identifier
   */
  sessionId: string;
  
  /**
   * Project identifier (e.g., 'ameliastamps')
   */
  projectId: string;
  
  /**
   * User identifier (e.g., 'scott')
   */
  userId: string;
  
  /**
   * Timestamp when message was created
   */
  timestamp: string;
  
  /**
   * Source of the message (email, api, etc.)
   */
  source?: string;
}

/**
 * Claim request message sent to unclaimed queue
 */
export interface ClaimRequestMessage extends BaseQueueMessage {
  type: 'claim_request';
}

/**
 * Work message sent to project input queue
 */
export interface WorkMessage extends BaseQueueMessage {
  type: 'work';
  
  /**
   * Repository URL for the project
   */
  repoUrl: string;
  
  /**
   * Instruction to execute
   */
  instruction: string;
  
  /**
   * Original email/request details
   */
  from?: string;
  subject?: string;
  body?: string;
  
  /**
   * Thread identifiers for conversation continuity
   */
  threadId?: string;
  chatThreadId?: string;
  
  /**
   * Command identifier for tracking
   */
  commandId?: string;
  
  /**
   * Additional context for the instruction
   */
  context?: {
    requiresPlanning?: boolean;
    [key: string]: any;
  };
}

/**
 * Response message sent to output queue
 */
export interface ResponseMessage extends BaseQueueMessage {
  type: 'response';
  
  /**
   * Command ID this response is for
   */
  commandId: string;
  
  /**
   * Whether the operation was successful
   */
  success: boolean;
  
  /**
   * Summary of what was done
   */
  summary?: string;
  
  /**
   * List of files that were changed
   */
  filesChanged?: string[];
  
  /**
   * Preview URL for the deployed site
   */
  previewUrl?: string;
  
  /**
   * Build success status
   */
  buildSuccess?: boolean;
  
  /**
   * Deploy success status
   */
  deploySuccess?: boolean;
  
  /**
   * Error message if operation failed
   */
  error?: string;
  
  /**
   * Error code for categorization
   */
  errorCode?: string;
  
  /**
   * Whether the process was interrupted
   */
  interrupted?: boolean;
}

/**
 * Type guard to check if message is a claim request
 */
export function isClaimRequest(message: BaseQueueMessage): message is ClaimRequestMessage {
  return message.type === 'claim_request';
}

/**
 * Type guard to check if message is a work message
 */
export function isWorkMessage(message: BaseQueueMessage): message is WorkMessage {
  return message.type === 'work' && 'instruction' in message && 'repoUrl' in message;
}

/**
 * Type guard to check if message is a response message
 */
export function isResponseMessage(message: BaseQueueMessage): message is ResponseMessage {
  return message.type === 'response' && 'commandId' in message && 'success' in message;
}