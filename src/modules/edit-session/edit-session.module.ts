import { Module } from '@nestjs/common';
import { EditSessionService } from './services/edit-session.service';
import { FargateManagerService } from './services/fargate-manager.service';
import { EditSessionController } from './controllers/edit-session.controller';

@Module({
  providers: [EditSessionService, FargateManagerService],
  controllers: [EditSessionController],
  exports: [EditSessionService],
})
export class EditSessionModule {}