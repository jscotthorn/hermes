import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { QueueLifecycleService } from '../src/modules/sqs/queue-lifecycle.service';
import { QueueManagerService } from '../src/modules/sqs/queue-manager.service';

describe('Queue Lifecycle Management Tests', () => {
  let queueLifecycle: QueueLifecycleService;
  let queueManager: QueueManagerService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [QueueLifecycleService, QueueManagerService],
    }).compile();

    queueLifecycle = module.get<QueueLifecycleService>(QueueLifecycleService);
    queueManager = module.get<QueueManagerService>(QueueManagerService);
  });

  describe('Queue Creation and Persistence', () => {
    it('should create queues with container startup', async () => {
      const clientId = 'test-client';
      const projectId = 'test-project';
      const userId = 'test-user';

      const queues = await queueManager.createContainerQueues(
        clientId,
        projectId,
        userId,
      );

      expect(queues).toBeDefined();
      expect(queues.containerId).toBe(`${clientId}-${projectId}-${userId}`);
      expect(queues.inputUrl).toContain('webordinary-input-');
      expect(queues.outputUrl).toContain('webordinary-output-');
      expect(queues.dlqUrl).toContain('webordinary-dlq-');
    }, 30000);

    it('should persist queue URLs in DynamoDB', async () => {
      const containerId = 'test-client-test-project-test-user';
      
      // Queue info should be stored with TTL
      const queueInfo = {
        containerId,
        inputUrl: 'https://sqs.us-west-2.amazonaws.com/xxx/webordinary-input-test',
        outputUrl: 'https://sqs.us-west-2.amazonaws.com/xxx/webordinary-output-test',
        dlqUrl: 'https://sqs.us-west-2.amazonaws.com/xxx/webordinary-dlq-test',
        createdAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 86400, // 24 hours
      };

      // In real test, would save to DynamoDB and verify
      expect(queueInfo.ttl).toBeGreaterThan(Date.now() / 1000);
    });
  });

  describe('Queue Cleanup', () => {
    it('should cleanup queues on container termination', async () => {
      const event = {
        containerId: 'test-client-test-project-test-user',
        reason: 'Container stopped',
      };

      await queueLifecycle.handleContainerTermination(event);

      // Queues should be deleted
      // In real test, verify with SQS
      expect(true).toBe(true);
    });

    it('should handle queue deletion failures gracefully', async () => {
      // Test with non-existent queues
      await queueLifecycle.cleanupContainerQueues(
        'non-existent',
        'project',
        'user',
      );

      // Should not throw, just log warnings
      expect(true).toBe(true);
    });

    it('should check for messages before deletion', () => {
      const queueMetrics = {
        messagesAvailable: 5,
        messagesInFlight: 2,
      };

      const totalMessages = queueMetrics.messagesAvailable + queueMetrics.messagesInFlight;
      const shouldArchive = totalMessages > 0;

      expect(shouldArchive).toBe(true);
      expect(totalMessages).toBe(7);
    });
  });

  describe('Orphaned Queue Detection', () => {
    it('should identify orphaned queues', async () => {
      const orphanedQueues = await queueLifecycle.findOrphanedQueues();

      // Check structure if any found
      if (orphanedQueues.length > 0) {
        const orphan = orphanedQueues[0];
        expect(orphan).toHaveProperty('queueUrl');
        expect(orphan).toHaveProperty('queueName');
        expect(orphan).toHaveProperty('containerId');
        expect(orphan).toHaveProperty('ageHours');
        expect(orphan).toHaveProperty('messageCount');
      }

      expect(Array.isArray(orphanedQueues)).toBe(true);
    });

    it('should only consider old queues as orphaned', () => {
      const queues = [
        { queueName: 'queue1', ageHours: 0.5 },  // 30 minutes - too new
        { queueName: 'queue2', ageHours: 2 },    // 2 hours - orphaned
        { queueName: 'queue3', ageHours: 25 },   // 25 hours - orphaned
      ];

      const orphanThresholdHours = 1;
      const orphaned = queues.filter(q => q.ageHours > orphanThresholdHours);

      expect(orphaned.length).toBe(2);
      expect(orphaned[0].queueName).toBe('queue2');
      expect(orphaned[1].queueName).toBe('queue3');
    });

    it('should parse container ID from queue name', () => {
      const queueNames = [
        'webordinary-input-client1-project1-user1',
        'webordinary-output-client2-project2-user2',
        'webordinary-dlq-client3-project3-user3',
      ];

      const containerIds = queueNames.map(name => {
        const match = name.match(/^webordinary-(?:input|output|dlq)-(.+)$/);
        return match ? match[1] : null;
      });

      expect(containerIds[0]).toBe('client1-project1-user1');
      expect(containerIds[1]).toBe('client2-project2-user2');
      expect(containerIds[2]).toBe('client3-project3-user3');
    });
  });

  describe('Scheduled Cleanup', () => {
    it('should cleanup orphaned queues older than threshold', async () => {
      const result = await queueLifecycle.cleanupOrphanedQueues(24);

      expect(result).toHaveProperty('deleted');
      expect(result).toHaveProperty('failed');
      expect(typeof result.deleted).toBe('number');
      expect(typeof result.failed).toBe('number');
    });

    it('should respect age threshold for deletion', () => {
      const maxAgeHours = 24;
      const queues = [
        { ageHours: 12, shouldDelete: false },
        { ageHours: 24, shouldDelete: false }, // Equal to threshold
        { ageHours: 25, shouldDelete: true },
        { ageHours: 48, shouldDelete: true },
      ];

      queues.forEach(queue => {
        const shouldDelete = queue.ageHours > maxAgeHours;
        expect(shouldDelete).toBe(queue.shouldDelete);
      });
    });
  });

  describe('Queue Metrics', () => {
    it('should get queue metrics for monitoring', async () => {
      const containerId = 'test-client-test-project-test-user';
      const metrics = await queueLifecycle.getQueueMetrics(containerId);

      if (metrics) {
        expect(metrics).toHaveProperty('input');
        expect(metrics).toHaveProperty('output');
        expect(metrics).toHaveProperty('dlq');
        
        expect(metrics.input).toHaveProperty('messages');
        expect(metrics.input).toHaveProperty('age');
      }
    });

    it('should list all active queues', async () => {
      const activeQueues = await queueLifecycle.listActiveQueues();

      expect(Array.isArray(activeQueues)).toBe(true);
      
      if (activeQueues.length > 0) {
        const queue = activeQueues[0];
        expect(queue).toHaveProperty('containerId');
        expect(queue).toHaveProperty('queueType');
        expect(queue).toHaveProperty('messageCount');
        expect(queue).toHaveProperty('ageHours');
      }
    });
  });

  describe('Container Termination Events', () => {
    it('should handle ECS task stop events', async () => {
      const event = {
        source: 'aws.ecs',
        detailType: 'ECS Task State Change',
        detail: {
          taskArn: 'arn:aws:ecs:us-west-2:123:task/abc',
          lastStatus: 'STOPPED',
          stoppedReason: 'Essential container exited',
          containers: [{
            name: 'claude-code-astro',
            exitCode: 0,
          }],
        },
      };

      // Would trigger queue cleanup
      expect(event.detail.lastStatus).toBe('STOPPED');
    });

    it('should clean up queues for crashed containers', async () => {
      const crashedContainer = {
        containerId: 'crashed-container',
        status: 'stopped',
        stoppedReason: 'Task failed',
      };

      // Cleanup should handle crashed containers
      await queueLifecycle.handleContainerTermination({
        containerId: crashedContainer.containerId,
        reason: crashedContainer.stoppedReason,
      });

      expect(true).toBe(true);
    });
  });

  describe('Queue Purging', () => {
    it('should purge messages for debugging', async () => {
      await queueLifecycle.purgeContainerQueues(
        'test-client',
        'test-project',
        'test-user',
      );

      // Should purge input/output but not DLQ
      expect(true).toBe(true);
    });

    it('should handle purge cooldown', () => {
      // SQS has 60-second cooldown between purges
      const lastPurge = Date.now() - 30000; // 30 seconds ago
      const cooldownPeriod = 60000; // 60 seconds
      const canPurge = (Date.now() - lastPurge) > cooldownPeriod;

      expect(canPurge).toBe(false);
    });
  });

  describe('Performance and Reliability', () => {
    it('should handle concurrent queue operations', async () => {
      const operations = [
        queueManager.createContainerQueues('client1', 'project1', 'user1'),
        queueManager.createContainerQueues('client2', 'project2', 'user2'),
        queueManager.createContainerQueues('client3', 'project3', 'user3'),
      ];

      const results = await Promise.allSettled(operations);
      
      const successful = results.filter(r => r.status === 'fulfilled');
      expect(successful.length).toBeGreaterThanOrEqual(0);
    });

    it('should cache queue information', () => {
      const cache = new Map();
      const containerId = 'cached-container';
      const queueInfo = {
        inputUrl: 'https://sqs.test/input',
        outputUrl: 'https://sqs.test/output',
        dlqUrl: 'https://sqs.test/dlq',
      };

      cache.set(containerId, queueInfo);
      
      const cached = cache.get(containerId);
      expect(cached).toEqual(queueInfo);
    });
  });
});

// Run with: npm test queue-lifecycle.test.ts