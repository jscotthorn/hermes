import { Injectable, Logger } from '@nestjs/common';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
  AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { v4 as uuidv4 } from 'uuid';
import { FargateManagerService } from './fargate-manager.service';

export interface EditSession {
  sessionId: string;
  userId: string;
  clientId: string;
  threadId: string;
  status: 'initializing' | 'active' | 'draining' | 'expired';
  fargateTaskArn?: string;
  containerIp?: string;
  lastActivity: number;
  ttl: number;
  editBranch: string;
  previewUrl?: string;
  createdAt: string;
}

@Injectable()
export class EditSessionService {
  private readonly logger = new Logger(EditSessionService.name);
  private readonly dynamoClient: DynamoDBClient;
  private readonly cloudWatchClient: CloudWatchClient;
  private readonly tableName = 'webordinary-edit-sessions';

  constructor(private readonly fargateManager: FargateManagerService) {
    this.dynamoClient = new DynamoDBClient({ region: 'us-west-2' });
    this.cloudWatchClient = new CloudWatchClient({ region: 'us-west-2' });
  }

  async createSession(
    clientId: string,
    userId: string,
    instruction: string,
  ): Promise<EditSession> {
    const sessionId = uuidv4();
    const threadId = `thread-${uuidv4().slice(0, 8)}`;
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + 1800; // 30 minutes from now

    const session: EditSession = {
      sessionId,
      userId,
      clientId,
      threadId,
      status: 'initializing',
      lastActivity: now,
      ttl,
      editBranch: threadId,
      createdAt: new Date(now).toISOString(),
    };

    // Store session in DynamoDB
    await this.dynamoClient.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: this.marshallSession(session),
      }),
    );

    this.logger.log(`Created session ${sessionId} for ${clientId}/${userId}`);

    // Trigger Fargate task startup
    try {
      const { taskArn, containerIp } = await this.fargateManager.startTask({
        sessionId,
        clientId,
        userId,
        threadId,
      });

      // Update session with Fargate details
      session.fargateTaskArn = taskArn;
      session.containerIp = containerIp;
      session.status = 'active';
      session.previewUrl = `https://edit.ameliastamps.com/session/${sessionId}`;

      await this.updateSession(session);

      // Update CloudWatch metric
      await this.updateActiveSessionMetric();

      // Execute initial instruction in container
      await this.executeInContainer(containerIp, instruction);

      this.logger.log(`Session ${sessionId} is now active at ${containerIp}`);
    } catch (error) {
      this.logger.error(`Failed to start Fargate task for session ${sessionId}`, error);
      session.status = 'expired';
      await this.updateSession(session);
      throw error;
    }

    return session;
  }

  async getSession(sessionId: string): Promise<EditSession | null> {
    const result = await this.dynamoClient.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: {
          sessionId: { S: sessionId },
          userId: { S: '*' }, // We'll need to handle this properly
        },
      }),
    );

    if (!result.Item) {
      return null;
    }

    return this.unmarshallSession(result.Item);
  }

  async updateSessionActivity(sessionId: string): Promise<void> {
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + 1800; // Reset to 30 minutes

    await this.dynamoClient.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: {
          sessionId: { S: sessionId },
          userId: { S: '*' },
        },
        UpdateExpression: 'SET lastActivity = :now, #ttl = :ttl',
        ExpressionAttributeNames: {
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':now': { N: now.toString() },
          ':ttl': { N: ttl.toString() },
        },
      }),
    );

    this.logger.debug(`Updated activity for session ${sessionId}`);
  }

  async deactivateSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      this.logger.warn(`Session ${sessionId} not found`);
      return;
    }

    // Update status to draining
    session.status = 'draining';
    await this.updateSession(session);

    // Stop Fargate task
    if (session.fargateTaskArn) {
      await this.fargateManager.stopTask(session.fargateTaskArn);
    }

    // Mark as expired
    session.status = 'expired';
    session.fargateTaskArn = undefined;
    session.containerIp = undefined;
    await this.updateSession(session);

    // Update CloudWatch metric
    await this.updateActiveSessionMetric();

    this.logger.log(`Deactivated session ${sessionId}`);
  }

  async getActiveSessions(clientId?: string): Promise<EditSession[]> {
    const params: any = {
      TableName: this.tableName,
      IndexName: 'StatusIndex',
      KeyConditionExpression: '#status = :active',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':active': { S: 'active' },
      },
    };

    if (clientId) {
      params.FilterExpression = 'clientId = :clientId';
      params.ExpressionAttributeValues[':clientId'] = { S: clientId };
    }

    const result = await this.dynamoClient.send(new QueryCommand(params));

    return (result.Items || []).map((item) => this.unmarshallSession(item));
  }

  private async updateSession(session: EditSession): Promise<void> {
    await this.dynamoClient.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: this.marshallSession(session),
      }),
    );
  }

  private async updateActiveSessionMetric(): Promise<void> {
    const activeSessions = await this.getActiveSessions();
    
    await this.cloudWatchClient.send(
      new PutMetricDataCommand({
        Namespace: 'Webordinary/EditSessions',
        MetricData: [
          {
            MetricName: 'ActiveSessionCount',
            Value: activeSessions.length,
            Unit: 'Count',
            Timestamp: new Date(),
            Dimensions: [
              {
                Name: 'Environment',
                Value: 'production',
              },
            ],
          },
        ],
      }),
    );

    this.logger.debug(`Updated active session count metric: ${activeSessions.length}`);
  }

  private async executeInContainer(
    containerIp: string,
    instruction: string,
  ): Promise<void> {
    // Call the container API to execute the instruction
    const response = await fetch(`http://${containerIp}:8080/api/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ instruction }),
    });

    if (!response.ok) {
      throw new Error(`Container execution failed: ${response.statusText}`);
    }

    this.logger.log(`Executed instruction in container at ${containerIp}`);
  }

  private marshallSession(session: EditSession): Record<string, AttributeValue> {
    return {
      sessionId: { S: session.sessionId },
      userId: { S: session.userId },
      clientId: { S: session.clientId },
      threadId: { S: session.threadId },
      status: { S: session.status },
      lastActivity: { N: session.lastActivity.toString() },
      ttl: { N: session.ttl.toString() },
      editBranch: { S: session.editBranch },
      createdAt: { S: session.createdAt },
      ...(session.fargateTaskArn && { fargateTaskArn: { S: session.fargateTaskArn } }),
      ...(session.containerIp && { containerIp: { S: session.containerIp } }),
      ...(session.previewUrl && { previewUrl: { S: session.previewUrl } }),
    };
  }

  private unmarshallSession(item: Record<string, AttributeValue>): EditSession {
    return {
      sessionId: item.sessionId.S!,
      userId: item.userId.S!,
      clientId: item.clientId.S!,
      threadId: item.threadId.S!,
      status: item.status.S as any,
      lastActivity: parseInt(item.lastActivity.N!),
      ttl: parseInt(item.ttl.N!),
      editBranch: item.editBranch.S!,
      createdAt: item.createdAt.S!,
      fargateTaskArn: item.fargateTaskArn?.S,
      containerIp: item.containerIp?.S,
      previewUrl: item.previewUrl?.S,
    };
  }
}