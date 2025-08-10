import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { QueueManagerService } from './queue-manager.service';
import { SqsMessageService } from './sqs-message.service';
import { CommandExecutorService } from './command-executor.service';

@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [
    QueueManagerService, 
    SqsMessageService,
    CommandExecutorService,
  ],
  exports: [
    QueueManagerService, 
    SqsMessageService,
    CommandExecutorService,
  ],
})
export class SqsModule {}