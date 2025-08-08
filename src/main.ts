import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Set global prefix to match ALB routing
  // ALB forwards /hermes/* and NestJS strips the prefix to match routes
  app.setGlobalPrefix('hermes');
  
  const port = process.env.PORT ?? 3000;
  // Listen on all interfaces (0.0.0.0) instead of just localhost
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on 0.0.0.0:${port} with global prefix /hermes`);
}
bootstrap();
