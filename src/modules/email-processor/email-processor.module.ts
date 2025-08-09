import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { EmailProcessorService } from './email-processor.service';
import { EmailProcessorController } from './email-processor.controller';
import { ClaudeExecutorModule } from '../claude-executor/claude-executor.module';
import { EditSessionModule } from '../edit-session/edit-session.module';

@Module({
  imports: [
    HttpModule,
    ClaudeExecutorModule,
    EditSessionModule,
  ],
  providers: [EmailProcessorService],
  controllers: [EmailProcessorController],
  exports: [EmailProcessorService],
})
export class EmailProcessorModule {}