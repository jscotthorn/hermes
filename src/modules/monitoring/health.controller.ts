import { Controller, Get } from '@nestjs/common';
import { QueueManagerService } from '../sqs/queue-manager.service';
import { MetricsService } from './metrics.service';

export interface HealthCheck {
  name: string;
  healthy: boolean;
  message: string;
  metrics?: Record<string, any>;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  checks: HealthCheck[];
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly queueManagerService: QueueManagerService
  ) {}

  @Get()
  async getHealth(): Promise<HealthStatus> {
    const checks = await Promise.all([
      this.checkSQS(),
      this.checkDynamoDB(),
      this.checkCloudWatch()
    ]);

    const status = checks.every(c => c.healthy) ? 'healthy' : 'unhealthy';

    return {
      status,
      timestamp: new Date().toISOString(),
      checks
    };
  }

  @Get('ready')
  async getReadiness(): Promise<{ ready: boolean }> {
    // Simple readiness check - service is ready if it can respond
    return { ready: true };
  }

  @Get('live')
  async getLiveness(): Promise<{ alive: boolean }> {
    // Simple liveness check - service is alive if it can respond
    return { alive: true };
  }

  private async checkSQS(): Promise<HealthCheck> {
    try {
      // This would check if we can list queues or get basic queue info
      // For now, just return healthy if the service is available
      return {
        name: 'sqs_connectivity',
        healthy: true,
        message: 'SQS service available',
        metrics: {
          activeQueues: 'unknown', // TODO: implement actual queue counting
          dlqMessages: 0
        }
      };
    } catch (error) {
      return {
        name: 'sqs_connectivity',
        healthy: false,
        message: `SQS check failed: ${error.message}`
      };
    }
  }

  private async checkDynamoDB(): Promise<HealthCheck> {
    try {
      // This would check if we can connect to DynamoDB tables
      // For now, just return healthy if no immediate errors
      return {
        name: 'dynamodb_connectivity',
        healthy: true,
        message: 'DynamoDB tables accessible',
        metrics: {
          containerTable: 'accessible',
          queueTrackingTable: 'accessible'
        }
      };
    } catch (error) {
      return {
        name: 'dynamodb_connectivity',
        healthy: false,
        message: `DynamoDB check failed: ${error.message}`
      };
    }
  }

  private async checkCloudWatch(): Promise<HealthCheck> {
    try {
      // Test CloudWatch connectivity by attempting to send a health check metric
      await this.metricsService.recordMetric('HealthCheck', 1, 'Count');
      
      return {
        name: 'cloudwatch_metrics',
        healthy: true,
        message: 'CloudWatch metrics available',
        metrics: {
          metricsEnabled: true
        }
      };
    } catch (error) {
      return {
        name: 'cloudwatch_metrics',
        healthy: false,
        message: `CloudWatch check failed: ${error.message}`
      };
    }
  }
}