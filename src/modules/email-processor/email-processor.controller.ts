import { Controller, Get } from '@nestjs/common';

/**
 * Email processor controller - minimal HTTP endpoints
 * All email processing happens via SQS consumers, not HTTP
 */
@Controller('email')
export class EmailProcessorController {
  // Removed POST /email/process endpoint - using SQS consumers instead
  
  /**
   * Health check endpoint for monitoring
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