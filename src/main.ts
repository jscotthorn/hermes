import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env.local for local development
if (process.env.NODE_ENV === 'development') {
  config({ path: resolve(__dirname, '../.env.local') });
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  
  // Hermes is a pure SQS message processor - no HTTP server needed
  console.log('Hermes SQS message processor started');
  console.log('Processing messages from:', process.env.SQS_QUEUE_URL || 'webordinary-email-queue');
  
  if (process.env.NODE_ENV === 'development') {
    console.log(`Development mode: Using AWS profile '${process.env.AWS_PROFILE}'`);
  }
  
  // Keep the process running
  // The SQS consumers will process messages in the background
}
bootstrap();
