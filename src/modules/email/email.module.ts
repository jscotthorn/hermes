import { Module } from '@nestjs/common';
import { EmailProcessorService } from './email-processor.service';
import { EmailTemplateService } from './email-templates.service';
import { ThreadExtractorService } from '../message-processor/thread-extractor.service';
import { QueueManagerService } from '../sqs/queue-manager.service';
import { SqsMessageService } from '../sqs/sqs-message.service';
import { ContainerManagerService } from '../container/container-manager.service';

@Module({
  providers: [
    EmailProcessorService,
    EmailTemplateService,
    ThreadExtractorService,
    QueueManagerService,
    SqsMessageService,
    ContainerManagerService,
  ],
  exports: [
    EmailProcessorService,
    EmailTemplateService,
  ],
})
export class EmailModule {}