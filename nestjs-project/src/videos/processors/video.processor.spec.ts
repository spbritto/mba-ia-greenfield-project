import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import { FfmpegService, ProbeResult } from '../ffmpeg/ffmpeg.service';
import { VideoProcessor, ProcessVideoPayload } from './video.processor';

describe('VideoProcessor (unit)', () => {
  let processor: VideoProcessor;
  let videoRepository: Record<string, jest.Mock>;
  let storageService: Record<string, jest.Mock>;
  let ffmpegService: Record<string, jest.Mock>;

  const videoId = '550e8400-e29b-41d4-a716-446655440000';
  const storageKey = `videos/${videoId}/original.mp4`;

  const probeResult: ProbeResult = {
    duration_seconds: 2.0,
    width: 320,
    height: 240,
    video_codec: 'h264',
    audio_codec: 'aac',
    bit_rate: 245000,
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  };

  const processingVideo: Partial<Video> = {
    id: videoId,
    status: VideoStatus.PROCESSING,
  };

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest.fn(),
      update: jest.fn(),
    };

    storageService = {
      presignInternalGet: jest
        .fn()
        .mockResolvedValue('http://minio:9000/presigned'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };

    ffmpegService = {
      probe: jest.fn().mockResolvedValue(probeResult),
      extractFrame: jest
        .fn()
        .mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff])),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: FfmpegService, useValue: ffmpegService },
      ],
    }).compile();

    processor = module.get(VideoProcessor);
  });

  function createJob(
    overrides: Partial<Job<ProcessVideoPayload>> = {},
  ): Job<ProcessVideoPayload> {
    return {
      data: { video_id: videoId, storage_key: storageKey },
      attemptsMade: 0,
      opts: { attempts: 3 },
      ...overrides,
    } as unknown as Job<ProcessVideoPayload>;
  }

  describe('success path', () => {
    it('should process video and set status to ready', async () => {
      videoRepository.findOneBy.mockResolvedValue(processingVideo);

      await processor.process(createJob());

      expect(storageService.presignInternalGet).toHaveBeenCalledWith(
        storageKey,
      );
      expect(ffmpegService.probe).toHaveBeenCalledWith(
        'http://minio:9000/presigned',
      );
      expect(ffmpegService.extractFrame).toHaveBeenCalledWith(
        'http://minio:9000/presigned',
        0.2, // 2.0 * 0.1
      );
      expect(storageService.putObject).toHaveBeenCalledWith(
        `videos/${videoId}/thumbnail.jpg`,
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(videoId, {
        duration_seconds: 2.0,
        metadata: {
          width: 320,
          height: 240,
          video_codec: 'h264',
          audio_codec: 'aac',
          bit_rate: 245000,
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        },
        thumbnail_key: `videos/${videoId}/thumbnail.jpg`,
        status: VideoStatus.READY,
      });
    });

    it('should use thumbnailTime=0 when duration < 1', async () => {
      videoRepository.findOneBy.mockResolvedValue(processingVideo);
      ffmpegService.probe.mockResolvedValue({
        ...probeResult,
        duration_seconds: 0.5,
      });

      await processor.process(createJob());

      expect(ffmpegService.extractFrame).toHaveBeenCalledWith(
        'http://minio:9000/presigned',
        0,
      );
    });

    it('should use thumbnailTime=0 when duration is null', async () => {
      videoRepository.findOneBy.mockResolvedValue(processingVideo);
      ffmpegService.probe.mockResolvedValue({
        ...probeResult,
        duration_seconds: null,
      });

      await processor.process(createJob());

      expect(ffmpegService.extractFrame).toHaveBeenCalledWith(
        'http://minio:9000/presigned',
        0,
      );
    });
  });

  describe('skip conditions', () => {
    it('should skip if video not found', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await processor.process(createJob());

      expect(storageService.presignInternalGet).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should skip if video is not in processing status', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        ...processingVideo,
        status: VideoStatus.READY,
      });

      await processor.process(createJob());

      expect(storageService.presignInternalGet).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should skip draft videos', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        ...processingVideo,
        status: VideoStatus.DRAFT,
      });

      await processor.process(createJob());

      expect(storageService.presignInternalGet).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('failure handling', () => {
    it('should rethrow on intermediate failure without marking failed', async () => {
      videoRepository.findOneBy.mockResolvedValue(processingVideo);
      ffmpegService.probe.mockRejectedValue(new Error('ffprobe failed'));

      const job = createJob({ attemptsMade: 0 });

      await expect(processor.process(job)).rejects.toThrow('ffprobe failed');

      expect(videoRepository.update).not.toHaveBeenCalledWith(
        videoId,
        expect.objectContaining({ status: VideoStatus.FAILED }),
      );
    });

    it('should mark failed on final attempt and rethrow', async () => {
      videoRepository.findOneBy.mockResolvedValue(processingVideo);
      ffmpegService.probe.mockRejectedValue(new Error('ffprobe crashed'));

      const job = createJob({ attemptsMade: 2, opts: { attempts: 3 } });

      await expect(processor.process(job)).rejects.toThrow('ffprobe crashed');

      expect(videoRepository.update).toHaveBeenCalledWith(videoId, {
        status: VideoStatus.FAILED,
        error_message: 'ffprobe crashed',
      });
    });
  });
});
