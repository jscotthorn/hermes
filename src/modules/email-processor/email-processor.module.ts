import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { EmailProcessorService } from './email-processor.service';
import { EmailProcessorController } from './email-processor.controller';
import { MessageProcessorModule } from '../message-processor/message-processor.module';

@Module({
  imports: [
    HttpModule,
    MessageProcessorModule,  // For MessageRouterService
  ],
  providers: [EmailProcessorService],
  controllers: [EmailProcessorController],
  exports: [EmailProcessorService],
})
export class EmailProcessorModule {}