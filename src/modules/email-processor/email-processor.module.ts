import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { EmailProcessorService } from './email-processor.service';
import { MessageProcessorModule } from '../message-processor/message-processor.module';

@Module({
  imports: [
    HttpModule,
    MessageProcessorModule,  // For MessageRouterService
  ],
  providers: [EmailProcessorService],
  controllers: [], // No HTTP controllers - pure SQS message processor
  exports: [EmailProcessorService],
})
export class EmailProcessorModule {}