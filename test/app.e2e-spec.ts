import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/hermes/health (GET) - health check endpoint', () => {
    return request(app.getHttpServer())
      .get('/hermes/health')
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty('status', 'healthy');
        expect(res.body).toHaveProperty('service', 'hermes-message-router');
        expect(res.body).toHaveProperty('timestamp');
      });
  });

  // Note: All other functionality is handled via SQS queues, not HTTP endpoints
  // See integration tests for queue-based message processing tests
});
