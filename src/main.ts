import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestFastifyApplication } from '@nestjs/platform-fastify/interfaces';
import { FastifyAdapter } from '@nestjs/platform-fastify';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  const listenHost = process.env.LISTEN_HOST || '0.0.0.0';
  const listenPort = Number.parseInt(process.env.LISTEN_PORT || '8080', 10) || 8080;
  await app.listen(listenPort, listenHost);
}

bootstrap();
