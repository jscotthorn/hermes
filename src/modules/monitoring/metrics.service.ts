import { Injectable, Logger } from '@nestjs/common';
import { 
  CloudWatchClient, 
  PutMetricDataCommand, 
  PutMetricDataCommandInput,
  StandardUnit 
} from '@aws-sdk/client-cloudwatch';

export interface MetricDimensions {
  [key: string]: string;
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly cloudWatch: CloudWatchClient;
  
  constructor() {
    this.cloudWatch = new CloudWatchClient({ 
      region: process.env.AWS_REGION || 'us-west-2' 
    });
  }
  
  /**
   * Record a custom metric to CloudWatch
   */
  async recordMetric(
    metricName: string,
    value: number,
    unit: StandardUnit = StandardUnit.Count,
    dimensions?: MetricDimensions
  ): Promise<void> {
    try {
      const params: PutMetricDataCommandInput = {
        Namespace: 'Webordinary/EditSessions',
        MetricData: [{
          MetricName: metricName,
          Value: value,
          Unit: unit,
          Timestamp: new Date(),
          Dimensions: dimensions ? Object.entries(dimensions).map(([Name, Value]) => ({
            Name,
            Value
          })) : undefined
        }]
      };
      
      await this.cloudWatch.send(new PutMetricDataCommand(params));
      this.logger.debug(`Recorded metric: ${metricName} = ${value} ${unit}`);
    } catch (error) {
      this.logger.error(`Failed to record metric ${metricName}:`, error);
      // Don't throw - metrics failures shouldn't break business logic
    }
  }
  
  /**
   * Record session creation metrics
   */
  async recordSessionCreated(
    clientId: string, 
    projectId: string,
    userId: string,
    source: 'email' | 'sms' | 'chat'
  ): Promise<void> {
    await this.recordMetric('SessionsCreated', 1, StandardUnit.Count, {
      ClientId: clientId,
      ProjectId: projectId,
      Source: source
    });
  }
  
  /**
   * Record session termination metrics
   */
  async recordSessionClosed(
    sessionId: string,
    durationMs: number,
    reason: 'completed' | 'timeout' | 'error' | 'interrupted'
  ): Promise<void> {
    await this.recordMetric('SessionsClosed', 1, StandardUnit.Count, {
      SessionId: sessionId,
      Reason: reason
    });
    
    await this.recordMetric('SessionDuration', durationMs, StandardUnit.Milliseconds, {
      SessionId: sessionId
    });
  }
  
  /**
   * Record command processing metrics
   */
  async recordCommandProcessed(
    sessionId: string,
    commandType: string,
    duration: number,
    success: boolean
  ): Promise<void> {
    await this.recordMetric(
      'CommandDuration',
      duration,
      StandardUnit.Milliseconds,
      { SessionId: sessionId, CommandType: commandType }
    );
    
    await this.recordMetric(
      success ? 'CommandSuccess' : 'CommandFailure',
      1,
      StandardUnit.Count,
      { SessionId: sessionId, CommandType: commandType }
    );
  }
  
  /**
   * Record session interruption metrics
   */
  async recordSessionInterrupt(
    fromSessionId: string,
    toSessionId: string,
    containerId: string
  ): Promise<void> {
    await this.recordMetric('SessionInterrupts', 1, StandardUnit.Count, {
      FromSession: fromSessionId,
      ToSession: toSessionId,
      ContainerId: containerId
    });
  }
  
  /**
   * Record container lifecycle metrics
   */
  async recordContainerStartup(
    containerId: string,
    startupTime: number
  ): Promise<void> {
    await this.recordMetric(
      'ContainerStartupTime',
      startupTime,
      StandardUnit.Milliseconds,
      { ContainerId: containerId }
    );
  }
  
  /**
   * Record container shutdown metrics
   */
  async recordContainerShutdown(
    containerId: string,
    reason: 'idle' | 'error' | 'manual',
    sessionCount: number,
    uptime: number
  ): Promise<void> {
    await this.recordMetric('ContainerShutdowns', 1, StandardUnit.Count, {
      ContainerId: containerId,
      Reason: reason
    });
    
    await this.recordMetric('ContainerUptime', uptime, StandardUnit.Milliseconds, {
      ContainerId: containerId
    });
    
    await this.recordMetric('ContainerSessionCount', sessionCount, StandardUnit.Count, {
      ContainerId: containerId
    });
  }
  
  /**
   * Record queue operation metrics
   */
  async recordQueueOperation(
    operation: 'create' | 'delete' | 'send' | 'receive',
    queueType: 'input' | 'output' | 'dlq',
    duration: number,
    success: boolean
  ): Promise<void> {
    await this.recordMetric('QueueOperations', 1, StandardUnit.Count, {
      Operation: operation,
      QueueType: queueType,
      Result: success ? 'success' : 'failure'
    });
    
    await this.recordMetric('QueueOperationDuration', duration, StandardUnit.Milliseconds, {
      Operation: operation,
      QueueType: queueType
    });
  }
  
  /**
   * Record DynamoDB operation metrics
   */
  async recordDynamoDBOperation(
    table: string,
    operation: 'put' | 'get' | 'update' | 'delete' | 'query',
    duration: number,
    success: boolean
  ): Promise<void> {
    await this.recordMetric('DynamoDBOperations', 1, StandardUnit.Count, {
      TableName: table,
      Operation: operation,
      Result: success ? 'success' : 'failure'
    });
    
    await this.recordMetric('DynamoDBOperationDuration', duration, StandardUnit.Milliseconds, {
      TableName: table,
      Operation: operation
    });
  }
  
  /**
   * Record business metrics
   */
  async recordBusinessMetric(
    metric: 'user_active' | 'project_edited' | 'git_commit' | 'preview_generated',
    clientId: string,
    additionalDimensions?: MetricDimensions
  ): Promise<void> {
    const dimensions = {
      ClientId: clientId,
      ...(additionalDimensions || {})
    };
    
    await this.recordMetric('BusinessMetrics', 1, StandardUnit.Count, {
      MetricType: metric,
      ...dimensions
    });
  }
}