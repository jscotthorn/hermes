import { Module } from '@nestjs/common';
import { ContainerManagerService } from './container-manager.service';

@Module({
  providers: [ContainerManagerService],
  exports: [ContainerManagerService],
})
export class ContainerModule {}