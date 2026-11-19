import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { VIDEOS_QUEUE } from '../videos.constants';

export interface ProcessVideoPayload {
  video_id: string;
  storage_key: string;
}

@Processor(VIDEOS_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoPayload>): Promise<void> {
    const { video_id, storage_key } = job.data;
    this.logger.log(`Processing video ${video_id}`);

    const video = await this.videoRepository.findOneBy({ id: video_id });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Skipping video ${video_id}: ${!video ? 'not found' : `status is ${video.status}`}`,
      );
      return;
    }

    try {
      const presignedUrl =
        await this.storageService.presignInternalGet(storage_key);

      const probeResult = await this.ffmpegService.probe(presignedUrl);

      const thumbnailTime = this.computeThumbnailTime(
        probeResult.duration_seconds,
      );
      const thumbnailBytes = await this.ffmpegService.extractFrame(
        presignedUrl,
        thumbnailTime,
      );

      const thumbnailKey = `videos/${video_id}/thumbnail.jpg`;
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBytes,
        'image/jpeg',
      );

      await this.videoRepository.update(video_id, {
        duration_seconds: probeResult.duration_seconds,
        metadata: {
          width: probeResult.width,
          height: probeResult.height,
          video_codec: probeResult.video_codec,
          audio_codec: probeResult.audio_codec,
          bit_rate: probeResult.bit_rate,
          format_name: probeResult.format_name,
        },
        thumbnail_key: thumbnailKey,
        status: VideoStatus.READY,
      });

      this.logger.log(`Video ${video_id} processed successfully`);
    } catch (error) {
      const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1) - 1;

      if (isFinalAttempt) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Video ${video_id} failed on final attempt: ${errorMessage}`,
        );

        await this.videoRepository.update(video_id, {
          status: VideoStatus.FAILED,
          error_message: errorMessage,
        });
      } else {
        this.logger.warn(
          `Video ${video_id} failed on attempt ${job.attemptsMade + 1}, will retry`,
        );
      }

      throw error;
    }
  }

  private computeThumbnailTime(durationSeconds: number | null): number {
    if (durationSeconds === null || durationSeconds < 1) {
      return 0;
    }
    return durationSeconds * 0.1;
  }
}
