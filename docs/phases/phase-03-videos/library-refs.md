---
libs:
  bullmq:
    version: "latest"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-17T22:57:42"
  "@nestjs/bullmq":
    version: "latest"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-17T22:57:42"
  "@aws-sdk/client-s3":
    version: "latest"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-17T22:57:42"
  "@aws-sdk/s3-request-presigner":
    version: "latest"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-17T22:57:42"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-13T12:26:58"
---

# Library References — phase-03-videos

## bullmq

BullMQ is a Redis-based message queue for Node.js. Phase 03 uses it for video processing job dispatch.

### Connection

```typescript
import { Queue, Worker } from 'bullmq';

const myQueue = new Queue('myqueue', {
  connection: {
    host: 'myredis.taskforce.run',
    port: 32856,
  },
});

const myWorker = new Worker('myqueue', async job => {}, {
  connection: {
    host: 'myredis.taskforce.run',
    port: 32856,
  },
});
```

### QueueEvents (global listeners)

```typescript
import { QueueEvents } from 'bullmq';

const queueEvents = new QueueEvents('Paint', { connection });

queueEvents.on('completed', ({ jobId, returnvalue }) => {
  // Called every time a job is completed by any worker.
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  // Called whenever a job is moved to failed by any worker.
});

queueEvents.on('progress', ({ jobId, data }) => {
  // jobId received a progress event
});
```

### Job options (retries, backoff)

Jobs support `attempts` and `backoff` options:

```typescript
await myQueue.add('process-video', { videoId: '...' }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  jobId: videoId, // deduplication — same video cannot be enqueued twice
});
```

## @nestjs/bullmq

Official NestJS integration for BullMQ. Provides `BullModule`, `@Processor()`, `@InjectQueue()` decorators.

### Module registration

```typescript
// App-level (forRoot — shared Redis connection)
@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: 'localhost', port: 6379 },
    }),
  ],
})
export class AppModule {}

// Feature-level (registerQueue)
@Module({
  imports: [
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
})
export class VideosModule {}
```

### Queue injection

```typescript
@Injectable()
export class VideosService {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
}
```

### Processor registration

```typescript
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'video-processing',
      connection: { host: 'localhost', port: 6379 },
      processors: [
        async (job) => processVideo(job.data),
      ],
    }),
  ],
})
export class WorkerModule {}
```

### Deferred worker startup (manualRegistration)

```typescript
@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: 'localhost', port: 6379 },
      extraOptions: { manualRegistration: true },
    }),
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
  providers: [BootstrapService, VideoProcessor],
})
export class WorkerModule {}

@Injectable()
export class BootstrapService {
  constructor(private readonly bullRegistrar: BullRegistrar) {}

  async onApplicationBootstrap() {
    await this.ensureDependenciesReady();
    this.bullRegistrar.register();
  }
}
```

## @aws-sdk/client-s3

AWS SDK v3 S3 client. Phase 03 uses it for MinIO-compatible object storage (presigned uploads, multipart, streaming, thumbnails).

### S3Client configuration (MinIO-compatible)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  endpoint: 'http://minio:9000',    // MinIO endpoint (Compose service name)
  region: 'us-east-1',               // MinIO ignores this but SDK requires it
  forcePathStyle: true,               // Required for MinIO (v2 was s3ForcePathStyle)
  credentials: {
    accessKeyId: '...',
    secretAccessKey: '...',
  },
});
```

### PutObjectCommand

```typescript
import { PutObjectCommand } from '@aws-sdk/client-s3';

const command = new PutObjectCommand({
  Bucket: 'my-bucket',
  Key: 'videos/{videoId}/thumbnail.jpg',
  Body: thumbnailBuffer,              // StreamingBlobPayloadInputTypes (Buffer, Stream, etc.)
  ContentType: 'image/jpeg',
  ContentLength: thumbnailBuffer.length,
});
await s3Client.send(command);
```

### HeadObjectCommand

```typescript
import { HeadObjectCommand } from '@aws-sdk/client-s3';

const command = new HeadObjectCommand({
  Bucket: 'my-bucket',
  Key: 'videos/{videoId}/original',
});
const response = await s3Client.send(command);
// response.ContentLength — file size in bytes
// response.ETag — entity tag
```

### CreateMultipartUploadCommand

```typescript
import { CreateMultipartUploadCommand } from '@aws-sdk/client-s3';

const command = new CreateMultipartUploadCommand({
  Bucket: 'my-bucket',
  Key: 'videos/{videoId}/original',
  ContentType: 'video/mp4',
});
const { UploadId } = await s3Client.send(command);
```

### CompleteMultipartUploadCommand

```typescript
import { CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';

const command = new CompleteMultipartUploadCommand({
  Bucket: 'my-bucket',
  Key: 'videos/{videoId}/original',
  UploadId: uploadId,
  MultipartUpload: {
    Parts: [
      { ETag: '"etag1"', PartNumber: 1 },
      { ETag: '"etag2"', PartNumber: 2 },
      // ...
    ],
  },
});
await s3Client.send(command);
```

### AbortMultipartUploadCommand

```typescript
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';

const command = new AbortMultipartUploadCommand({
  Bucket: 'my-bucket',
  Key: 'videos/{videoId}/original',
  UploadId: uploadId,
});
await s3Client.send(command);
```

### GetObjectCommand

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';

const command = new GetObjectCommand({
  Bucket: 'my-bucket',
  Key: 'videos/{videoId}/original',
});
const response = await s3Client.send(command);
// response.Body — readable stream
```

### Custom endpoint (async function)

```typescript
new S3Client({
  endpoint: async () => ({
    hostname: 'localhost',
    path: '/',
    protocol: 'http',
    port: 9000,
  }),
});
```

## @aws-sdk/s3-request-presigner

Generates presigned URLs for S3 operations. Phase 03 uses it for upload part URLs, streaming URLs, and download URLs.

### getSignedUrl — basic usage

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const client = new S3Client(clientParams);
const command = new GetObjectCommand({ Bucket: 'bucket', Key: 'key' });
const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

`expiresIn` is in seconds. Default is 900 (15 minutes) if not set.

### Presigned PUT for upload

```typescript
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const command = new PutObjectCommand({
  Bucket: 'bucket',
  Key: 'videos/{videoId}/original',
  ContentType: 'video/mp4',
});
const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

### Presigned URL with signed Content-Type header

```typescript
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const command = new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  ContentType: contentType,
});

const presigned = await getSignedUrl(s3Client, command, {
  signableHeaders: new Set(['content-type']),
  expiresIn: 3600,
});
```

### Presigned URL with x-amz-* headers (unhoistableHeaders)

```typescript
const command = new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  ChecksumSHA256: sha,
});

const presigned = await getSignedUrl(s3Client, command, {
  expiresIn: 3600,
  unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
});
```

### Presigned GET for download with Content-Disposition

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';

const command = new GetObjectCommand({
  Bucket: 'bucket',
  Key: 'videos/{videoId}/original',
  ResponseContentDisposition: 'attachment; filename="video.mp4"',
});
const url = await getSignedUrl(client, command, { expiresIn: 14400 }); // 4 hours
```
