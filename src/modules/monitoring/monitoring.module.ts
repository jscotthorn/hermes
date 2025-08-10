import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { HealthController } from './health.controller';

@Module({
  providers: [MetricsService],
  controllers: [HealthController],
  exports: [MetricsService]
})
export class MonitoringModule {}