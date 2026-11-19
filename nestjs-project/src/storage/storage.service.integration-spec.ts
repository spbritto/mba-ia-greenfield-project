import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService, CompletedPart } from './storage.service';

const PART_SIZE = 5 * 1024 * 1024; // 5 MiB — S3 minimum part size

function randomKey(): string {
  return `test/${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('StorageService (integration — MinIO)', () => {
  let module: TestingModule;
  let service: StorageService;
  const keysToClean: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);
  });

  afterAll(async () => {
    // Best-effort cleanup of test objects
    for (const key of keysToClean) {
      try {
        await service.deleteObject(key);
      } catch {
        // ignore — object may already be deleted
      }
    }
    await module.close();
  }, 30000);

  describe('multipart upload flow', () => {
    const key = `test/multipart-${Date.now()}`;
    let uploadId: string;
    let completedParts: CompletedPart[];
    const part1Data = Buffer.alloc(PART_SIZE, 'a');
    const part2Data = Buffer.alloc(PART_SIZE, 'b');
    const totalSize = part1Data.length + part2Data.length;

    beforeAll(() => {
      keysToClean.push(key);
    });

    it('should create a multipart upload', async () => {
      uploadId = await service.createMultipartUpload(
        key,
        'application/octet-stream',
      );
      expect(typeof uploadId).toBe('string');
      expect(uploadId.length).toBeGreaterThan(0);
    });

    it('should presign upload part URLs, upload parts, and complete', async () => {
      const urls = await service.presignUploadParts(key, uploadId, [1, 2]);
      expect(urls).toHaveLength(2);

      // Upload part 1
      const res1 = await fetch(urls[0], {
        method: 'PUT',
        body: part1Data,
        headers: { 'Content-Length': String(part1Data.length) },
      });
      expect(res1.ok).toBe(true);
      expect(res1.headers.get('etag')).toBeTruthy();

      // Upload part 2
      const res2 = await fetch(urls[1], {
        method: 'PUT',
        body: part2Data,
        headers: { 'Content-Length': String(part2Data.length) },
      });
      expect(res2.ok).toBe(true);
      expect(res2.headers.get('etag')).toBeTruthy();

      completedParts = [
        { ETag: res1.headers.get('etag')!, PartNumber: 1 },
        { ETag: res2.headers.get('etag')!, PartNumber: 2 },
      ];

      // Complete the multipart upload
      await expect(
        service.completeMultipartUpload(key, uploadId, completedParts),
      ).resolves.toBeUndefined();
    }, 30000);

    it('should return correct object size after complete', async () => {
      const size = await service.getObjectSize(key);
      expect(size).toBe(totalSize);
    });

    it('should presign a GET URL that responds 206 to a Range request', async () => {
      const url = await service.presignClientGet(key);

      const res = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(res.status).toBe(206);
      const body = await res.arrayBuffer();
      expect(body.byteLength).toBe(1024);
    });

    it('should presign a download URL with Content-Disposition attachment', async () => {
      const url = await service.presignClientGet(key, {
        downloadFileName: 'test-video.mp4',
      });

      const res = await fetch(url);
      expect(res.ok).toBe(true);

      const disposition = res.headers.get('content-disposition');
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('test-video.mp4');
    });
  });

  describe('putObject / deleteObject', () => {
    it('should put and then delete an object', async () => {
      const key = randomKey();

      const data = Buffer.from('hello storage');
      await service.putObject(key, data, 'text/plain');

      const size = await service.getObjectSize(key);
      expect(size).toBe(data.length);

      await service.deleteObject(key);

      // After delete, HeadObject should throw
      await expect(service.getObjectSize(key)).rejects.toThrow();
    });
  });

  describe('abortMultipartUpload', () => {
    it('should abort a multipart upload without error', async () => {
      const key = randomKey();

      const uploadId = await service.createMultipartUpload(
        key,
        'application/octet-stream',
      );

      await expect(
        service.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
    });
  });

  describe('presignInternalGet', () => {
    it('should return a presigned URL using the internal endpoint', async () => {
      const key = randomKey();
      keysToClean.push(key);

      await service.putObject(key, Buffer.from('internal test'), 'text/plain');

      const url = await service.presignInternalGet(key);
      expect(typeof url).toBe('string');

      // The URL should be reachable from inside the container
      const res = await fetch(url);
      expect(res.ok).toBe(true);
      const text = await res.text();
      expect(text).toBe('internal test');
    });
  });
});
