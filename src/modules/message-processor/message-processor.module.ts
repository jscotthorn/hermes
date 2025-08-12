import { Module } from '@nestjs/common';
import { MessageRouterService } from './message-router.service';

@Module({
  providers: [MessageRouterService],
  exports: [MessageRouterService],
})
export class MessageProcessorModule {}