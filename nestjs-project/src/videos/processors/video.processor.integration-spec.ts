import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { VideoProcessor, ProcessVideoPayload } from './video.processor';
import { Job } from 'bullmq';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let processor: VideoProcessor;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let storageService: StorageService;

  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES).options,
        }),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessor],
    }).compile();

    processor = module.get(VideoProcessor);
    dataSource = module.get(DataSource);
    videoRepo = dataSource.getRepository(Video);
    storageService = module.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await module.close();
  }, 30000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);

    const user = await userRepo.save(
      userRepo.create({
        email: 'worker-test@test.com',
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    userId = user.id;

    const channel = await channelRepo.save(
      channelRepo.create({
        user_id: userId,
        nickname: 'worker-test-ch',
        name: 'Worker Test Channel',
      }),
    );
    channelId = channel.id;
  });

  it('should process fixture video: set ready, duration, metadata, and thumbnail', async () => {
    const storageKey = `videos/integration-test/original.mp4`;

    // Upload the fixture file to MinIO
    const fixturePath = path.resolve(
      __dirname,
      '../../../test/fixtures/sample.mp4',
    );
    const fixtureBuffer = fs.readFileSync(fixturePath);
    await storageService.putObject(storageKey, fixtureBuffer, 'video/mp4');

    // Create a video row in processing status
    const video = await videoRepo.save(
      videoRepo.create({
        public_id: 'intgtest12ab',
        channel_id: channelId,
        title: 'Integration Test Video',
        status: VideoStatus.PROCESSING,
        mime_type: 'video/mp4',
        size_in_bytes: fixtureBuffer.length,
        storage_key: storageKey,
        upload_id: null,
      }),
    );

    const job = {
      data: { video_id: video.id, storage_key: storageKey },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<ProcessVideoPayload>;

    await processor.process(job);

    const updated = await videoRepo.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.duration_seconds).toBeGreaterThanOrEqual(1.5);
    expect(updated.duration_seconds).toBeLessThanOrEqual(2.5);
    expect(updated.metadata).toEqual(
      expect.objectContaining({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
      }),
    );
    expect(updated.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);

    // Verify thumbnail was actually uploaded to MinIO
    const thumbnailSize = await storageService.getObjectSize(
      `videos/${video.id}/thumbnail.jpg`,
    );
    expect(thumbnailSize).toBeGreaterThan(0);

    // Clean up storage
    await storageService.deleteObject(storageKey);
    await storageService.deleteObject(`videos/${video.id}/thumbnail.jpg`);
  }, 30000);
});
