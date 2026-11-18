import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

export interface CompletedPart {
  ETag: string;
  PartNumber: number;
}

const UPLOAD_PART_TTL_SECONDS = 3600; // 1 hour

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;
  private readonly presignedGetTtlSeconds: number;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    const credentials = {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    };

    this.internalClient = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials,
    });

    this.publicClient = new S3Client({
      endpoint: config.publicEndpoint,
      region: config.region,
      forcePathStyle: true,
      credentials,
    });

    this.bucket = config.bucket;
    this.presignedGetTtlSeconds = config.presignedGetTtlSeconds;
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  // ── Multipart ──────────────────────────────────────────────

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return UploadId!;
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<string[]> {
    return Promise.all(
      partNumbers.map((partNumber) =>
        getSignedUrl(
          this.publicClient,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: UPLOAD_PART_TTL_SECONDS },
        ),
      ),
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({
            ETag: p.ETag,
            PartNumber: p.PartNumber,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  // ── Object operations ──────────────────────────────────────

  async getObjectSize(key: string): Promise<number> {
    const { ContentLength } = await this.internalClient.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    return ContentLength!;
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  // ── Presigned GET URLs ─────────────────────────────────────

  async presignClientGet(
    key: string,
    options?: { downloadFileName?: string },
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options?.downloadFileName && {
        ResponseContentDisposition: `attachment; filename="${options.downloadFileName}"`,
      }),
    });

    return getSignedUrl(this.publicClient, command, {
      expiresIn: this.presignedGetTtlSeconds,
    });
  }

  async presignInternalGet(key: string): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { expiresIn: this.presignedGetTtlSeconds },
    );
  }
}
