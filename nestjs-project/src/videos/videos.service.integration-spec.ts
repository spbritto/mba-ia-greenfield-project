import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import { VIDEOS_QUEUE } from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEST_QUEUE_PREFIX = 'test-si34';

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let videoQueue: Queue;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES).options,
        }),
        TypeOrmModule.forFeature([Video]),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          prefix: TEST_QUEUE_PREFIX,
        }),
        BullModule.registerQueue({ name: VIDEOS_QUEUE }),
        ChannelsModule,
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();

    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    channelsService = module.get(ChannelsService);
    storageService = module.get(StorageService);
    videoQueue = module.get(`BullQueue_${VIDEOS_QUEUE}`);
  }, 30000);

  afterAll(async () => {
    // Clean up any test queue data
    await videoQueue.obliterate({ force: true });
    await module.close();
  }, 30000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    // Drain any leftover jobs from prior test
    await videoQueue.drain();

    // Create a user + channel for testing
    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.save(
      userRepo.create({ email: 'vid_svc@example.com', password: 'hashed' }),
    );
    userId = user.id;

    const channel = await channelsService.createChannel(
      userId,
      'vid_svc@example.com',
    );
    channelId = channel.id;
  });

  describe('initiateUpload', () => {
    it('persists a draft video and returns presigned part URLs', async () => {
      const result = await service.initiateUpload(userId, {
        file_name: 'test-video.mp4',
        mime_type: 'video/mp4',
        size_in_bytes: 209_715_200, // 200 MiB → 2 parts
      });

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.total_parts).toBe(2);
      expect(result.part_urls).toHaveLength(2);
      expect(result.upload_id).toBeTruthy();

      // Verify persisted in DB
      const videoRepo = dataSource.getRepository(Video);
      const video = await videoRepo.findOneByOrFail({ id: result.id });
      expect(video.channel_id).toBe(channelId);
      expect(video.title).toBe('test-video');
      expect(video.storage_key).toContain('videos/');
      expect(video.storage_key).toContain('/original.mp4');
    });
  });

  describe('initiateUpload compensation', () => {
    it('aborts multipart upload if video insert fails', async () => {
      const abortSpy = jest.spyOn(storageService, 'abortMultipartUpload');
      const videoRepo = dataSource.getRepository(Video);

      // Make save throw after the first call in the retry loop
      jest.spyOn(videoRepo, 'save').mockRejectedValue(new Error('DB boom'));

      await expect(
        service.initiateUpload(userId, {
          file_name: 'fail.mp4',
          mime_type: 'video/mp4',
          size_in_bytes: 1024,
        }),
      ).rejects.toThrow('DB boom');

      expect(abortSpy).toHaveBeenCalled();

      // Restore
      jest.restoreAllMocks();
    });
  });

  describe('completeUpload', () => {
    it('transitions to processing and enqueues a job', async () => {
      // Create a small upload (1 part at minimum 5 MiB for S3)
      const partSize = 5 * 1024 * 1024;
      const result = await service.initiateUpload(userId, {
        file_name: 'small.mp4',
        mime_type: 'video/mp4',
        size_in_bytes: partSize,
      });

      // Upload the part via presigned URL
      const partData = Buffer.alloc(partSize, 'x');
      const putRes = await fetch(result.part_urls[0].url, {
        method: 'PUT',
        body: partData,
        headers: { 'Content-Length': String(partData.length) },
      });
      const etag = putRes.headers.get('etag')!;

      // Complete
      const completed = await service.completeUpload(userId, result.id, [
        { part_number: 1, etag },
      ]);

      expect(completed.status).toBe(VideoStatus.PROCESSING);

      // Verify the job was enqueued
      const job = await videoQueue.getJob(result.id);
      expect(job).not.toBeNull();
      const jobData = job!.data as { video_id: string; storage_key: string };
      expect(jobData.video_id).toBe(result.id);
      expect(jobData.storage_key).toMatch(/^videos\//);

      // Clean up: delete the object from storage
      const videoRepo = dataSource.getRepository(Video);
      const video = await videoRepo.findOneByOrFail({ id: result.id });
      await storageService.deleteObject(video.storage_key);
    }, 30000);
  });

  describe('abortUpload', () => {
    it('removes the video row after aborting', async () => {
      const result = await service.initiateUpload(userId, {
        file_name: 'abort-me.mp4',
        mime_type: 'video/mp4',
        size_in_bytes: 1024,
      });

      await service.abortUpload(userId, result.id);

      const videoRepo = dataSource.getRepository(Video);
      const video = await videoRepo.findOneBy({ id: result.id });
      expect(video).toBeNull();
    });
  });
});
