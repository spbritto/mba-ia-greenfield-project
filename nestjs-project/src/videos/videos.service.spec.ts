import { Queue } from 'bullmq';
import { Repository, QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoNotFoundException,
  VideoAccessDeniedException,
  VideoNotInDraftException,
  VideoNotUploadedException,
  UploadIncompleteException,
  SizeMismatchException,
} from './exceptions/video.exceptions';
import { VideosService } from './videos.service';

// ── Mock factories ───────────────────────────────────────────

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'channel-1',
    name: 'Test',
    nickname: 'test',
    description: null,
    user_id: 'user-1',
    created_at: new Date(),
    updated_at: new Date(),
    user: {} as any,
    ...overrides,
  } as Channel;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    public_id: 'abc123def456',
    channel_id: 'channel-1',
    title: 'Test Video',
    status: VideoStatus.DRAFT,
    mime_type: 'video/mp4',
    size_in_bytes: 209_715_200, // 200 MiB → 2 parts
    storage_key: 'videos/video-1/original.mp4',
    upload_id: 'upload-id-1',
    duration_seconds: null,
    metadata: null,
    thumbnail_key: null,
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: {} as any,
    ...overrides,
  } as Video;
}

function createMocks() {
  const videoRepository = {
    findOneBy: jest.fn(),
    save: jest.fn(),
    create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
    remove: jest.fn(),
  } as unknown as jest.Mocked<Repository<Video>>;

  const channelsService = {
    findByUserId: jest.fn(),
  } as unknown as jest.Mocked<ChannelsService>;

  const storageService = {
    createMultipartUpload: jest.fn(),
    presignUploadParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    getObjectSize: jest.fn(),
    deleteObject: jest.fn(),
    presignClientGet: jest.fn(),
  } as unknown as jest.Mocked<StorageService>;

  const videoQueue = {
    add: jest.fn(),
  } as unknown as jest.Mocked<Queue>;

  const service = new VideosService(
    videoRepository,
    channelsService,
    storageService,
    videoQueue,
  );

  return {
    service,
    videoRepository,
    channelsService,
    storageService,
    videoQueue,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('VideosService', () => {
  describe('initiateUpload', () => {
    it('creates a multipart upload and inserts the video', async () => {
      const { service, channelsService, storageService, videoRepository } =
        createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      storageService.createMultipartUpload.mockResolvedValue('upload-id');
      storageService.presignUploadParts.mockResolvedValue(['url-1', 'url-2']);
      videoRepository.save.mockImplementation(async (v) => ({
        ...makeVideo(),
        ...(v as any),
      }));

      const result = await service.initiateUpload('user-1', {
        file_name: 'my-video.mp4',
        mime_type: 'video/mp4',
        size_in_bytes: 209_715_200,
      });

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.upload_id).toBe('upload-id');
      expect(result.total_parts).toBe(2);
      expect(result.part_size).toBe(104_857_600);
      expect(result.part_urls).toHaveLength(2);
      expect(storageService.createMultipartUpload).toHaveBeenCalled();
    });

    it('throws VideoAccessDeniedException if user has no channel', async () => {
      const { service, channelsService } = createMocks();
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload('user-no-channel', {
          file_name: 'video.mp4',
          mime_type: 'video/mp4',
          size_in_bytes: 1024,
        }),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('aborts multipart upload if DB insert fails', async () => {
      const { service, channelsService, storageService, videoRepository } =
        createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      storageService.createMultipartUpload.mockResolvedValue('upload-id');
      videoRepository.save.mockRejectedValue(new Error('DB error'));

      await expect(
        service.initiateUpload('user-1', {
          file_name: 'video.mp4',
          mime_type: 'video/mp4',
          size_in_bytes: 1024,
        }),
      ).rejects.toThrow('DB error');

      expect(storageService.abortMultipartUpload).toHaveBeenCalled();
    });

    it('retries on public_id unique violation', async () => {
      const { service, channelsService, storageService, videoRepository } =
        createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      storageService.createMultipartUpload.mockResolvedValue('upload-id');
      storageService.presignUploadParts.mockResolvedValue(['url-1']);

      const uniqueViolation = new QueryFailedError('', [], new Error());
      Object.assign(uniqueViolation, {
        code: '23505',
        detail: 'Key (public_id)=(...) already exists.',
      });

      videoRepository.save
        .mockRejectedValueOnce(uniqueViolation)
        .mockImplementation(async (v) => ({
          ...makeVideo(),
          ...(v as any),
        }));

      const result = await service.initiateUpload('user-1', {
        file_name: 'tiny.mp4',
        mime_type: 'video/mp4',
        size_in_bytes: 104_857_600, // 1 part
      });

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      expect(result.id).toBeDefined();
    });
  });

  describe('refreshPartUrls', () => {
    it('returns fresh presigned URLs for the given parts', async () => {
      const { service, channelsService, videoRepository, storageService } =
        createMocks();
      const video = makeVideo();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(video);
      storageService.presignUploadParts.mockResolvedValue([
        'new-url-1',
        'new-url-3',
      ]);

      const result = await service.refreshPartUrls('user-1', 'video-1', [1, 3]);

      expect(result).toEqual([
        { part_number: 1, url: 'new-url-1' },
        { part_number: 3, url: 'new-url-3' },
      ]);
    });

    it('throws 403 if caller is not the owner', async () => {
      const { service, channelsService, videoRepository } = createMocks();

      channelsService.findByUserId.mockResolvedValue(
        makeChannel({ id: 'other-channel' }),
      );
      videoRepository.findOneBy.mockResolvedValue(makeVideo());

      await expect(
        service.refreshPartUrls('user-2', 'video-1', [1]),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws 409 if video is not draft', async () => {
      const { service, channelsService, videoRepository } = createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.refreshPartUrls('user-1', 'video-1', [1]),
      ).rejects.toThrow(VideoNotInDraftException);
    });
  });

  describe('completeUpload', () => {
    it('completes upload and enqueues processing job', async () => {
      const {
        service,
        channelsService,
        videoRepository,
        storageService,
        videoQueue,
      } = createMocks();
      const video = makeVideo();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(video);
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.getObjectSize.mockResolvedValue(209_715_200);
      videoRepository.save.mockImplementation(async (v) => v as Video);
      videoQueue.add.mockResolvedValue({} as any);

      const result = await service.completeUpload('user-1', 'video-1', [
        { part_number: 1, etag: '"etag1"' },
        { part_number: 2, etag: '"etag2"' },
      ]);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(videoQueue.add).toHaveBeenCalledWith(
        'process-video',
        { video_id: 'video-1', storage_key: video.storage_key },
        expect.objectContaining({ jobId: 'video-1', attempts: 3 }),
      );
    });

    it('throws UPLOAD_INCOMPLETE if part count mismatches', async () => {
      const { service, channelsService, videoRepository } = createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(makeVideo());

      await expect(
        service.completeUpload('user-1', 'video-1', [
          { part_number: 1, etag: '"etag1"' },
          // Missing part 2
        ]),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('throws UPLOAD_INCOMPLETE if storage rejects the parts', async () => {
      const { service, channelsService, videoRepository, storageService } =
        createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(makeVideo());
      storageService.completeMultipartUpload.mockRejectedValue(
        new Error('InvalidPart'),
      );

      await expect(
        service.completeUpload('user-1', 'video-1', [
          { part_number: 1, etag: '"etag1"' },
          { part_number: 2, etag: '"etag2"' },
        ]),
      ).rejects.toThrow(UploadIncompleteException);
    });

    it('throws SIZE_MISMATCH and cleans up when stored size differs', async () => {
      const { service, channelsService, videoRepository, storageService } =
        createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(makeVideo());
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.getObjectSize.mockResolvedValue(999); // Wrong size

      await expect(
        service.completeUpload('user-1', 'video-1', [
          { part_number: 1, etag: '"etag1"' },
          { part_number: 2, etag: '"etag2"' },
        ]),
      ).rejects.toThrow(SizeMismatchException);

      expect(storageService.deleteObject).toHaveBeenCalled();
      expect(videoRepository.remove).toHaveBeenCalled();
    });

    it('sets status to failed if job enqueue fails', async () => {
      const {
        service,
        channelsService,
        videoRepository,
        storageService,
        videoQueue,
      } = createMocks();
      const video = makeVideo();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(video);
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.getObjectSize.mockResolvedValue(209_715_200);
      videoRepository.save.mockImplementation(async (v) => v as Video);
      videoQueue.add.mockRejectedValue(new Error('Redis down'));

      await expect(
        service.completeUpload('user-1', 'video-1', [
          { part_number: 1, etag: '"etag1"' },
          { part_number: 2, etag: '"etag2"' },
        ]),
      ).rejects.toThrow('Redis down');

      // The second save call should set status to FAILED
      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      expect(video.status).toBe(VideoStatus.FAILED);
      expect(video.error_message).toBe('Failed to enqueue processing job');
    });

    it('throws 409 if video is already processing (complete twice)', async () => {
      const { service, channelsService, videoRepository } = createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload('user-1', 'video-1', []),
      ).rejects.toThrow(VideoNotInDraftException);
    });
  });

  describe('abortUpload', () => {
    it('aborts multipart and removes the video', async () => {
      const { service, channelsService, videoRepository, storageService } =
        createMocks();
      const video = makeVideo();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(video);

      await service.abortUpload('user-1', 'video-1');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        video.storage_key,
        video.upload_id,
      );
      expect(videoRepository.remove).toHaveBeenCalledWith(video);
    });
  });

  describe('findByPublicId', () => {
    it('returns video details for the owner regardless of status', async () => {
      const { service, channelsService, videoRepository, storageService } =
        createMocks();
      const video = makeVideo({
        status: VideoStatus.FAILED,
        error_message: 'ffmpeg error',
      });

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(video);

      const result = await service.findByPublicId('abc123def456', 'user-1');

      expect(result.status).toBe(VideoStatus.FAILED);
      expect(result.error_message).toBe('ffmpeg error');
      expect(storageService.presignClientGet).not.toHaveBeenCalled(); // no thumbnail
    });

    it('hides non-ready video from non-owner (throws 404)', async () => {
      const { service, channelsService, videoRepository } = createMocks();

      channelsService.findByUserId.mockResolvedValue(
        makeChannel({ id: 'other-channel' }),
      );
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.findByPublicId('abc123def456', 'other-user'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('returns ready video to anonymous user', async () => {
      const { service, videoRepository } = createMocks();

      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );

      const result = await service.findByPublicId('abc123def456');

      expect(result.status).toBe(VideoStatus.READY);
      expect(result.error_message).toBeNull(); // non-owner sees null
    });

    it('hides error_message from non-owner', async () => {
      const { service, channelsService, videoRepository } = createMocks();

      channelsService.findByUserId.mockResolvedValue(
        makeChannel({ id: 'other-channel' }),
      );
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY, error_message: 'secret' }),
      );

      const result = await service.findByPublicId('abc123def456', 'user-2');
      expect(result.error_message).toBeNull();
    });

    it('includes presigned thumbnail_url when thumbnail_key exists', async () => {
      const { service, channelsService, videoRepository, storageService } =
        createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({
          status: VideoStatus.READY,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
        }),
      );
      storageService.presignClientGet.mockResolvedValue('https://thumb-url');

      const result = await service.findByPublicId('abc123def456', 'user-1');
      expect(result.thumbnail_url).toBe('https://thumb-url');
    });
  });

  describe('getStreamUrl', () => {
    it('returns presigned URL for ready video (anonymous)', async () => {
      const { service, videoRepository, storageService } = createMocks();

      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );
      storageService.presignClientGet.mockResolvedValue('https://stream-url');

      const url = await service.getStreamUrl('abc123def456');
      expect(url).toBe('https://stream-url');
    });

    it('throws 404 for non-ready video when anonymous', async () => {
      const { service, videoRepository } = createMocks();

      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.DRAFT }),
      );

      await expect(service.getStreamUrl('abc123def456')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws 409 VIDEO_NOT_UPLOADED for owner streaming a draft', async () => {
      const { service, channelsService, videoRepository } = createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.DRAFT }),
      );

      await expect(
        service.getStreamUrl('abc123def456', 'user-1'),
      ).rejects.toThrow(VideoNotUploadedException);
    });

    it('allows owner to stream a processing video', async () => {
      const { service, channelsService, videoRepository, storageService } =
        createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );
      storageService.presignClientGet.mockResolvedValue('https://stream-url');

      const url = await service.getStreamUrl('abc123def456', 'user-1');
      expect(url).toBe('https://stream-url');
    });
  });

  describe('getDownloadUrl', () => {
    it('returns presigned URL with Content-Disposition for ready video', async () => {
      const { service, videoRepository, storageService } = createMocks();

      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );
      storageService.presignClientGet.mockResolvedValue('https://download-url');

      const url = await service.getDownloadUrl('abc123def456');
      expect(url).toBe('https://download-url');
      expect(storageService.presignClientGet).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        { downloadFileName: 'abc123def456.mp4' },
      );
    });

    it('throws 409 VIDEO_NOT_UPLOADED for owner downloading a draft', async () => {
      const { service, channelsService, videoRepository } = createMocks();

      channelsService.findByUserId.mockResolvedValue(makeChannel());
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.DRAFT }),
      );

      await expect(
        service.getDownloadUrl('abc123def456', 'user-1'),
      ).rejects.toThrow(VideoNotUploadedException);
    });
  });
});
