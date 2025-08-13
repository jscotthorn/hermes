import { Injectable, Logger } from '@nestjs/common';
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  UpdateServiceCommand,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';

interface StartTaskParams {
  sessionId: string;
  clientId: string;
  userId: string;
  threadId: string;
  repoUrl?: string;
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
  private readonly taskDefinition = 'FargateStackEditTaskDef7F513F8D:5';
  private readonly subnets = [
    'subnet-10edb63b',
    'subnet-74913229',
    'subnet-448c5c3c',
    'subnet-e916e4a3',
  ]; // Default VPC subnets
  private readonly securityGroups = ['sg-005bfe79fea3c5d1a']; // Edit service security group

  constructor() {
    this.ecsClient = new ECSClient({ region: 'us-west-2' });
    this.ec2Client = new EC2Client({ region: 'us-west-2' });
  }

  async startTask(params: StartTaskParams): Promise<TaskResult> {
    this.logger.log(`Starting Fargate task for session ${params.sessionId}`);

    // Use RunTask to start a new task with environment overrides
    const runTaskCommand = new RunTaskCommand({
      cluster: this.clusterName,
      taskDefinition: this.taskDefinition,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: this.subnets,
          assignPublicIp: 'ENABLED',
          securityGroups: this.securityGroups,
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'claude-code-astro',
            environment: [
              // Only pass session/thread tracking - everything else comes from messages
              { name: 'THREAD_ID', value: params.sessionId },
              { name: 'SESSION_ID', value: params.sessionId },
              // REMOVED: CLIENT_ID, USER_ID, REPO_URL - these come from work messages
            ],
          },
        ],
      },
    });

    try {
      const runTaskResponse = await this.ecsClient.send(runTaskCommand);
      
      if (!runTaskResponse.tasks || runTaskResponse.tasks.length === 0) {
        throw new Error('Failed to start task');
      }

      const taskArn = runTaskResponse.tasks[0].taskArn!;
      this.logger.log(`Started task ${taskArn}`);

      // Wait for task to be running
      await this.waitForTaskRunning(taskArn);
      
      // Get container IP
      const containerIp = await this.getTaskIp(taskArn);

      // Wait for container to be healthy
      await this.waitForHealthy(containerIp);

      return {
        taskArn,
        containerIp,
      };
    } catch (error) {
      this.logger.error('Failed to start task', error);
      // Fall back to scaling service approach
      await this.scaleService(1);
      const taskArn = await this.waitForRunningTask();
      const containerIp = await this.getTaskIp(taskArn);
      await this.waitForHealthy(containerIp);
      return { taskArn, containerIp };
    }
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

  private async waitForTaskRunning(taskArn: string): Promise<void> {
    const maxAttempts = 30;
    
    for (let i = 1; i <= maxAttempts; i++) {
      const describeResponse = await this.ecsClient.send(
        new DescribeTasksCommand({
          cluster: this.clusterName,
          tasks: [taskArn],
        }),
      );

      if (describeResponse.tasks && describeResponse.tasks.length > 0) {
        const task = describeResponse.tasks[0];
        if (task.lastStatus === 'RUNNING') {
          this.logger.log(`Task ${taskArn} is running`);
          return;
        }
      }

      this.logger.debug(`Waiting for task to start... (${i}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error('Timeout waiting for task to start');
  }

  private async waitForRunningTask(maxAttempts = 30): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      // First list all tasks for the service
      const listTasksResponse = await this.ecsClient.send(
        new ListTasksCommand({
          cluster: this.clusterName,
          serviceName: this.serviceName,
          desiredStatus: 'RUNNING',
        }),
      );

      if (listTasksResponse.taskArns && listTasksResponse.taskArns.length > 0) {
        // Now describe those tasks to get their status
        const tasks = await this.ecsClient.send(
          new DescribeTasksCommand({
            cluster: this.clusterName,
            tasks: listTasksResponse.taskArns,
          }),
        );

        const runningTask = tasks.tasks?.find(
          (task) => task.lastStatus === 'RUNNING',
        );

        if (runningTask) {
          this.logger.log(`Task ${runningTask.taskArn} is running`);
          return runningTask.taskArn!;
        }
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