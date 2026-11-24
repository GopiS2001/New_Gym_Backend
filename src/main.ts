import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { LiveService } from './common/live/live.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({
    origin: process.env.NODE_ENV === 'production' ? origins : true,
    credentials: true,
  });

  // Every API route lives under /api/v1 — uploads and docs are excluded.
  app.setGlobalPrefix('api/v1', { exclude: ['uploads/(.*)'] });

  const swagger = new DocumentBuilder()
    .setTitle('Premium Fitness & Gym API')
    .setDescription('Member app and admin dashboard REST API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger), {
    swaggerOptions: { persistAuthorization: true },
  });

  // Live sign-out notices for the app (WebSocket on the same port).
  app.get(LiveService).attach(app.getHttpServer());

  const port = Number(process.env.PORT ?? 4100);
  await app.listen(port);
  Logger.log(`API ready on http://localhost:${port}/api/v1  ·  docs: http://localhost:${port}/api/docs`, 'Bootstrap');
}

bootstrap();
