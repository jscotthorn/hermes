import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // No global prefix needed - ALB forwards /hermes/* paths as-is
  // Routes should handle /hermes prefix directly
  
  const port = process.env.PORT ?? 3000;
  // Listen on all interfaces (0.0.0.0) instead of just localhost
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on 0.0.0.0:${port} - routes handle /hermes prefix`);
}
bootstrap();
