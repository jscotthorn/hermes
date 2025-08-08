import { Injectable, Logger } from '@nestjs/common';
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';

interface StartTaskParams {
  sessionId: string;
  clientId: string;
  userId: string;
  threadId: string;
}

interface TaskResult {
  taskArn: string;
  containerIp: string;
}

@Injectable()
export class FargateManagerService {
  private readonly logger = new Logger(FargateManagerService.name);
  private readonly ecsClient: ECSClient;
  private readonly ec2Client: EC2Client;
  private readonly clusterName = 'webordinary-edit-cluster';
  private readonly serviceName = 'webordinary-edit-service';
  private readonly taskDefinition = 'webordinary-edit-task';
  private readonly subnets = [
    'subnet-0dd1b1e8ebcbb0e23',
    'subnet-0e87b3f11c9e67abc',
  ]; // Default VPC subnets

  constructor() {
    this.ecsClient = new ECSClient({ region: 'us-west-2' });
    this.ec2Client = new EC2Client({ region: 'us-west-2' });
  }

  async startTask(params: StartTaskParams): Promise<TaskResult> {
    this.logger.log(`Starting Fargate task for session ${params.sessionId}`);

    // First, scale up the service if needed
    await this.scaleService(1);

    // Wait for task to be running
    const taskArn = await this.waitForRunningTask();
    
    // Get container IP
    const containerIp = await this.getTaskIp(taskArn);

    // Wait for container to be healthy
    await this.waitForHealthy(containerIp);

    return {
      taskArn,
      containerIp,
    };
  }

  async stopTask(taskArn: string): Promise<void> {
    this.logger.log(`Stopping Fargate task ${taskArn}`);

    try {
      await this.ecsClient.send(
        new StopTaskCommand({
          cluster: this.clusterName,
          task: taskArn,
          reason: 'Session expired',
        }),
      );

      // Scale service back to 0 if no other active sessions
      // This would be determined by checking DynamoDB
      await this.scaleService(0);
    } catch (error) {
      this.logger.error(`Failed to stop task ${taskArn}`, error);
      throw error;
    }
  }

  private async scaleService(desiredCount: number): Promise<void> {
    this.logger.log(`Scaling service to ${desiredCount} tasks`);

    await this.ecsClient.send(
      new UpdateServiceCommand({
        cluster: this.clusterName,
        service: this.serviceName,
        desiredCount,
      }),
    );
  }

  private async waitForRunningTask(maxAttempts = 30): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      const tasks = await this.ecsClient.send(
        new DescribeTasksCommand({
          cluster: this.clusterName,
          tasks: [], // Get all tasks in cluster
        }),
      );

      const runningTask = tasks.tasks?.find(
        (task) => task.lastStatus === 'RUNNING',
      );

      if (runningTask) {
        this.logger.log(`Task ${runningTask.taskArn} is running`);
        return runningTask.taskArn!;
      }

      this.logger.debug(`Waiting for task to start... (${i + 1}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error('Timeout waiting for Fargate task to start');
  }

  private async getTaskIp(taskArn: string): Promise<string> {
    const taskDetails = await this.ecsClient.send(
      new DescribeTasksCommand({
        cluster: this.clusterName,
        tasks: [taskArn],
      }),
    );

    const task = taskDetails.tasks?.[0];
    if (!task) {
      throw new Error(`Task ${taskArn} not found`);
    }

    // Get the ENI (Elastic Network Interface) ID
    const eniId = task.attachments?.[0]?.details?.find(
      (d) => d.name === 'networkInterfaceId',
    )?.value;

    if (!eniId) {
      throw new Error(`No network interface found for task ${taskArn}`);
    }

    // Get IP from ENI
    const eniDetails = await this.ec2Client.send(
      new DescribeNetworkInterfacesCommand({
        NetworkInterfaceIds: [eniId],
      }),
    );

    const privateIp = eniDetails.NetworkInterfaces?.[0]?.PrivateIpAddress;
    if (!privateIp) {
      throw new Error(`No IP address found for ENI ${eniId}`);
    }

    this.logger.log(`Task ${taskArn} has IP ${privateIp}`);
    return privateIp;
  }

  private async waitForHealthy(containerIp: string, maxAttempts = 15): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`http://${containerIp}:8080/health`, {
          signal: AbortSignal.timeout(2000),
        });

        if (response.ok) {
          this.logger.log(`Container at ${containerIp} is healthy`);
          return;
        }
      } catch (error) {
        // Expected during startup
      }

      this.logger.debug(`Waiting for container health... (${i + 1}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(`Container at ${containerIp} failed health check`);
  }
}