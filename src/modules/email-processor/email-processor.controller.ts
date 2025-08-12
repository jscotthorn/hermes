import { Controller, Post, Body, Get, Logger } from '@nestjs/common';
import { EmailProcessorService } from './email-processor.service';
import { SQSEvent } from 'aws-lambda';

@Controller('email')
export class EmailProcessorController {
  private readonly logger = new Logger(EmailProcessorController.name);

  constructor(
    private readonly emailProcessor: EmailProcessorService,
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