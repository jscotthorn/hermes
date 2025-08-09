import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ClaudeExecutorService } from './claude-executor.service';

@Module({
  imports: [HttpModule],
  providers: [ClaudeExecutorService],
  exports: [ClaudeExecutorService],
})
export class ClaudeExecutorModule {}