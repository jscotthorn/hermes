import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ClaudeExecutorService } from './claude-executor.service';
import { SqsExecutorService } from './sqs-executor.service';
import { MessageProcessorModule } from '../message-processor/message-processor.module';

@Module({
  imports: [
    HttpModule,
    MessageProcessorModule,  // For MessageRouterService dependency
  ],
  providers: [
    ClaudeExecutorService,  // Keep for backwards compatibility
    SqsExecutorService,      // New SQS-based executor
  ],
  exports: [
    ClaudeExecutorService,
    SqsExecutorService,
  ],
})
export class ClaudeExecutorModule {}