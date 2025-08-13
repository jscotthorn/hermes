import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { SqsModule } from '../sqs/sqs.module';

@Module({
  imports: [SqsModule],
  providers: [MetricsService],
  controllers: [], // No HTTP controllers - pure SQS message processor
  exports: [MetricsService]
})
export class MonitoringModule {}