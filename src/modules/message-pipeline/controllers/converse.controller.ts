import { Body, Controller, Post } from '@nestjs/common';
import { PipelineService } from '../services/pipeline.service';
import { AgentService } from '../services/agent.service';

@Controller('converse')
export class ConverseController {
    constructor(private pipelineService: PipelineService, private agentService: AgentService) { }

    @Post()
    converse(@Body() body: { text: string, thread_id?: string }) {
        return this.agentService.invokeApp(body.text, body.thread_id);
        //return this.pipelineService.startNewChat(body.text);
    }
}
