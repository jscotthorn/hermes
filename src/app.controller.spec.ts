import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health check', () => {
    it('should return health status', () => {
      const health = appController.getHealth();
      expect(health).toHaveProperty('status', 'healthy');
      expect(health).toHaveProperty('service', 'hermes-message-router');
      expect(health).toHaveProperty('timestamp');
      expect(new Date(health.timestamp).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  // Note: Main functionality is SQS-based message processing
  // HTTP endpoints are minimal (health check only)
});
