import { Module } from '@nestjs/common';
import { EditSessionService } from './services/edit-session.service';
import { FargateManagerService } from './services/fargate-manager.service';
import { SessionResumptionService } from './services/session-resumption.service';
import { EditSessionController } from './controllers/edit-session.controller';

@Module({
  providers: [EditSessionService, FargateManagerService, SessionResumptionService],
  controllers: [EditSessionController],
  exports: [EditSessionService, SessionResumptionService],
})
export class EditSessionModule {}