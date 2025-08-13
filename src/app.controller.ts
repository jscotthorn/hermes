import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

/**
 * Main application controller
 * Minimal HTTP endpoints - most functionality via SQS
 */
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Removed root endpoint - not needed

  /**
   * Main health check endpoint for ALB/ECS
   * Path: /hermes/health (configured in ALB)
   */
  @Get('hermes/health')
  getHealth(): { status: string; timestamp: string; service: string } {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'hermes-message-router',
    };
  }
}
