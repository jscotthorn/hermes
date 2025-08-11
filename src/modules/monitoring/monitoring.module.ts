import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { HealthController } from './health.controller';
import { SqsModule } from '../sqs/sqs.module';

@Module({
  imports: [SqsModule],
  providers: [MetricsService],
  controllers: [HealthController],
  exports: [MetricsService]
})
export class MonitoringModule {}