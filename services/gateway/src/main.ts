import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const document = createOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document);

  const port = Number(process.env.GATEWAY_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
