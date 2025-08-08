import { Module } from '@nestjs/common';
import { PipelineService } from './services/pipeline.service';
import { BedrockModule } from '../bedrock/bedrock.module';
import { ConverseController } from './controllers/converse.controller';
import { ApprovalController } from './controllers/approval.controller';
import { AgentService } from './services/agent.service';
import { ClaudeAgentService } from './services/claude-agent.service';
import { SESService } from './services/ses.service';

@Module({
  imports: [BedrockModule],
  providers: [
    PipelineService, 
    AgentService,
    ClaudeAgentService,
    SESService,
  ],
  controllers: [ConverseController, ApprovalController],
  exports: [ClaudeAgentService, SESService],
})
export class MessagePipelineModule { }
