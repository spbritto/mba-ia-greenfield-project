import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Repository, QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
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
import { generatePublicId } from './utils/public-id';
import { VIDEOS_QUEUE, PROCESS_VIDEO_JOB } from './videos.constants';

const PART_SIZE = 104_857_600; // 100 MiB
const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_MAX_RETRIES = 3;

export interface InitiateUploadDto {
  file_name: string;
  mime_type: string;
  size_in_bytes: number;
}

export interface PartUrl {
  part_number: number;
  url: string;
}

export interface InitiateUploadResult {
  id: string;
  public_id: string;
  status: VideoStatus;
  upload_id: string;
  part_size: number;
  total_parts: number;
  part_urls: PartUrl[];
}

export interface CompleteUploadPart {
  part_number: number;
  etag: string;
}

export interface VideoDetails {
  id: string;
  public_id: string;
  channel_id: string;
  title: string;
  status: VideoStatus;
  mime_type: string;
  size_in_bytes: number;
  duration_seconds: number | null;
  metadata: Video['metadata'];
  thumbnail_url: string | null;
  error_message: string | null;
  created_at: Date;
}

function extractExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1) : 'bin';
}

function deriveTitle(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  const name = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
  return name.slice(0, 255);
}

function computeTotalParts(sizeInBytes: number): number {
  return Math.ceil(sizeInBytes / PART_SIZE);
}

function isPublicIdUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes('public_id')
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEOS_QUEUE) private readonly videoQueue: Queue,
  ) {}

  // ── Upload flow ────────────────────────────────────────────

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoAccessDeniedException();
    }

    const videoId = randomUUID();
    const ext = extractExtension(dto.file_name);
    const storageKey = `videos/${videoId}/original.${ext}`;

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.mime_type,
    );

    let video: Video;
    try {
      video = await this.insertVideoWithPublicIdRetry({
        id: videoId,
        channel_id: channel.id,
        title: deriveTitle(dto.file_name),
        mime_type: dto.mime_type,
        size_in_bytes: dto.size_in_bytes,
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (err) {
      // Compensate: abort the multipart upload if DB insert fails
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    const totalParts = computeTotalParts(dto.size_in_bytes);
    const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);
    const urls = await this.storageService.presignUploadParts(
      storageKey,
      uploadId,
      partNumbers,
    );

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
      upload_id: uploadId,
      part_size: PART_SIZE,
      total_parts: totalParts,
      part_urls: urls.map((url, i) => ({
        part_number: partNumbers[i],
        url,
      })),
    };
  }

  async refreshPartUrls(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<PartUrl[]> {
    const video = await this.findOwnedDraftVideo(userId, videoId);

    const urls = await this.storageService.presignUploadParts(
      video.storage_key,
      video.upload_id!,
      partNumbers,
    );

    return urls.map((url, i) => ({
      part_number: partNumbers[i],
      url,
    }));
  }

  async completeUpload(
    userId: string,
    videoId: string,
    parts: CompleteUploadPart[],
  ): Promise<{ id: string; public_id: string; status: VideoStatus }> {
    const video = await this.findOwnedDraftVideo(userId, videoId);
    const totalParts = computeTotalParts(video.size_in_bytes);

    // 1. Complete multipart upload
    if (parts.length !== totalParts) {
      throw new UploadIncompleteException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id!,
        parts.map((p) => ({ ETag: p.etag, PartNumber: p.part_number })),
      );
    } catch {
      throw new UploadIncompleteException();
    }

    // 2. Verify stored size
    const storedSize = await this.storageService.getObjectSize(
      video.storage_key,
    );
    if (storedSize !== video.size_in_bytes) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.remove(video);
      throw new SizeMismatchException();
    }

    // 3. Transition to processing and enqueue job
    video.upload_id = null;
    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    try {
      await this.videoQueue.add(
        PROCESS_VIDEO_JOB,
        {
          video_id: video.id,
          storage_key: video.storage_key,
        },
        {
          jobId: video.id,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
        },
      );
    } catch (err) {
      video.status = VideoStatus.FAILED;
      video.error_message = 'Failed to enqueue processing job';
      await this.videoRepository.save(video);
      throw err;
    }

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
    };
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedDraftVideo(userId, videoId);

    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id!,
    );
    await this.videoRepository.remove(video);
  }

  // ── Public read ────────────────────────────────────────────

  async findByPublicId(
    publicId: string,
    userId?: string,
  ): Promise<VideoDetails> {
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner = userId ? await this.isVideoOwner(video, userId) : false;

    // Non-owner can only see ready videos
    if (!isOwner && video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }

    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignClientGet(video.thumbnail_key)
      : null;

    return {
      id: video.id,
      public_id: video.public_id,
      channel_id: video.channel_id,
      title: video.title,
      status: video.status,
      mime_type: video.mime_type,
      size_in_bytes: video.size_in_bytes,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnail_url: thumbnailUrl,
      error_message: isOwner ? video.error_message : null,
      created_at: video.created_at,
    };
  }

  async getStreamUrl(publicId: string, userId?: string): Promise<string> {
    const video = await this.findVideoForAccess(publicId, userId);

    if (
      (await this.isVideoOwner(video, userId)) &&
      video.status === VideoStatus.DRAFT
    ) {
      throw new VideoNotUploadedException();
    }

    return this.storageService.presignClientGet(video.storage_key);
  }

  async getDownloadUrl(publicId: string, userId?: string): Promise<string> {
    const video = await this.findVideoForAccess(publicId, userId);

    if (
      (await this.isVideoOwner(video, userId)) &&
      video.status === VideoStatus.DRAFT
    ) {
      throw new VideoNotUploadedException();
    }

    const ext = extractExtension(video.storage_key);
    return this.storageService.presignClientGet(video.storage_key, {
      downloadFileName: `${video.public_id}.${ext}`,
    });
  }

  // ── Private helpers ────────────────────────────────────────

  private async insertVideoWithPublicIdRetry(
    data: Omit<
      Video,
      | 'public_id'
      | 'status'
      | 'duration_seconds'
      | 'metadata'
      | 'thumbnail_key'
      | 'error_message'
      | 'created_at'
      | 'updated_at'
      | 'channel'
    >,
  ): Promise<Video> {
    for (let attempt = 0; attempt <= PUBLIC_ID_MAX_RETRIES; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...data,
            public_id: generatePublicId(),
          }),
        );
      } catch (err) {
        if (isPublicIdUniqueViolation(err) && attempt < PUBLIC_ID_MAX_RETRIES) {
          continue;
        }
        throw err;
      }
    }

    // Unreachable, but satisfies TypeScript
    throw new Error('public_id conflict could not be resolved');
  }

  private async findOwnedDraftVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner = await this.isVideoOwner(video, userId);
    if (!isOwner) {
      throw new VideoAccessDeniedException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftException();
    }

    return video;
  }

  private async findVideoForAccess(
    publicId: string,
    userId?: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner = userId ? await this.isVideoOwner(video, userId) : false;

    // Non-owner: only ready videos are accessible
    if (!isOwner && video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  private async isVideoOwner(video: Video, userId?: string): Promise<boolean> {
    if (!userId) return false;
    const channel = await this.channelsService.findByUserId(userId);
    return channel !== null && channel.id === video.channel_id;
  }
}
