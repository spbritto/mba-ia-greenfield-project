import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(WorkerModule);

  logger.log('Video worker started, consuming video-processing queue');

  const shutdown = () => {
    logger.log('Shutting down video worker...');
    void app.close().then(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
