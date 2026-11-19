import * as fs from 'node:fs';
import * as path from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { bodyOf } from './utils/response-body';

// Real MP4 fixture (~62KB, H.264+AAC, 2s, 320×240) — the worker will probe
// and extract a thumbnail from this file.
const SAMPLE_MP4 = fs.readFileSync(
  path.resolve(__dirname, 'fixtures/sample.mp4'),
);

// Random bytes that look like a file but are not a valid video — ffprobe will
// reject them, causing the worker to fail after all retry attempts.
const INVALID_VIDEO = Buffer.from('this is not a valid video file at all');

interface InitiateResponse {
  id: string;
  public_id: string;
  status: string;
  upload_id: string;
  part_size: number;
  total_parts: number;
  part_urls: { part_number: number; url: string }[];
}

interface MetadataResponse {
  id: string;
  public_id: string;
  channel_id: string;
  title: string;
  status: string;
  mime_type: string;
  size_in_bytes: number;
  duration_seconds: number | null;
  metadata: {
    width: number | null;
    height: number | null;
    video_codec: string | null;
    audio_codec: string | null;
    bit_rate: number | null;
    format_name: string | null;
  } | null;
  thumbnail_url: string | null;
  error_message: string | null;
  created_at: string;
}

function getMailService(authService: AuthService): MailService {
  return (authService as unknown as { mailService: MailService }).mailService;
}

/**
 * Polls GET /videos/:publicId until the status matches one of the expected
 * values or the timeout expires. Returns the last response body.
 */
async function pollUntilStatus(
  server: App,
  publicId: string,
  accessToken: string,
  expectedStatuses: string[],
  timeoutMs: number,
  intervalMs = 2000,
): Promise<MetadataResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastBody: MetadataResponse | undefined;

  while (Date.now() < deadline) {
    const res = await request(server)
      .get(`/videos/${publicId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    lastBody = bodyOf<MetadataResponse>(res);
    if (expectedStatuses.includes(lastBody.status)) {
      return lastBody;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for status [${expectedStatuses.join(', ')}]. Last status: ${lastBody?.status}`,
  );
}

describe('Videos Processing (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    let capturedToken = '';
    jest
      .spyOn(getMailService(authService), 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return bodyOf<{ access_token: string }>(loginRes).access_token;
  }

  async function initiateUpload(
    accessToken: string,
    fileBuffer: Buffer,
    fileName = 'test.mp4',
    mimeType = 'video/mp4',
  ): Promise<InitiateResponse> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        file_name: fileName,
        mime_type: mimeType,
        size_in_bytes: fileBuffer.length,
      })
      .expect(201);
    return bodyOf<InitiateResponse>(res);
  }

  async function putPartToPresignedUrl(
    url: string,
    body: Buffer,
  ): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(response.ok).toBe(true);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  }

  async function uploadAndComplete(
    accessToken: string,
    fileBuffer: Buffer,
    fileName?: string,
    mimeType?: string,
  ): Promise<{
    videoId: string;
    publicId: string;
    initialStatus: string;
    completedStatus: string;
  }> {
    const initBody = await initiateUpload(
      accessToken,
      fileBuffer,
      fileName,
      mimeType,
    );

    // Upload all parts (for small files, there's only 1 part)
    const etags: { part_number: number; etag: string }[] = [];
    for (const part of initBody.part_urls) {
      const start = (part.part_number - 1) * initBody.part_size;
      const end = Math.min(start + initBody.part_size, fileBuffer.length);
      const chunk = fileBuffer.subarray(start, end);
      const etag = await putPartToPresignedUrl(part.url, chunk);
      etags.push({ part_number: part.part_number, etag });
    }

    // Complete the multipart upload
    const completeRes = await request(app.getHttpServer())
      .post(`/videos/${initBody.id}/upload/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: etags })
      .expect(200);

    return {
      videoId: initBody.id,
      publicId: initBody.public_id,
      initialStatus: initBody.status,
      completedStatus: bodyOf<{ status: string }>(completeRes).status,
    };
  }

  // ---------------------------------------------------------------------------
  // 1. Success: draft → processing → ready
  // ---------------------------------------------------------------------------

  describe('Success cycle: upload → process → ready', () => {
    it('transitions to ready with duration, metadata, thumbnail, then streams (206) and downloads (attachment)', async () => {
      const token = await registerConfirmAndLogin('proc-success@test.com');
      const { publicId, initialStatus, completedStatus } =
        await uploadAndComplete(token, SAMPLE_MP4);

      expect(initialStatus).toBe('draft');
      expect(completedStatus).toBe('processing');

      // Poll until the worker processes the video (timeout 60s)
      const readyVideo = await pollUntilStatus(
        app.getHttpServer(),
        publicId,
        token,
        ['ready'],
        60_000,
      );

      // Verify processing results
      expect(readyVideo.status).toBe('ready');
      expect(readyVideo.duration_seconds).toBeGreaterThan(0);
      expect(readyVideo.metadata).not.toBeNull();
      expect(readyVideo.metadata!.width).toBeGreaterThan(0);
      expect(readyVideo.metadata!.height).toBeGreaterThan(0);
      expect(readyVideo.metadata!.video_codec).toBeTruthy();
      expect(readyVideo.thumbnail_url).toBeTruthy();
      expect(readyVideo.error_message).toBeNull();

      // Stream: 302 redirect → Range request returns 206
      const streamRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .redirects(0)
        .expect(302);

      const streamLocation = streamRes.headers.location;
      expect(streamLocation).toBeDefined();

      const rangeRes = await fetch(streamLocation, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBeTruthy();

      // Download: 302 redirect with attachment Content-Disposition
      const dlRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .set('Authorization', `Bearer ${token}`)
        .redirects(0)
        .expect(302);

      const dlLocation = dlRes.headers.location;
      expect(dlLocation).toBeDefined();
      expect(dlLocation).toContain('response-content-disposition');

      const fetchDlRes = await fetch(dlLocation);
      expect(fetchDlRes.ok).toBe(true);
      expect(fetchDlRes.headers.get('content-disposition')).toMatch(
        /^attachment/,
      );
    }, 90_000);
  });

  // ---------------------------------------------------------------------------
  // 2. Failure: upload invalid bytes → processing → failed
  // ---------------------------------------------------------------------------

  describe('Failure cycle: upload invalid bytes → process → failed', () => {
    it('transitions to failed with error_message after all retry attempts', async () => {
      const token = await registerConfirmAndLogin('proc-fail@test.com');
      const { publicId, completedStatus } = await uploadAndComplete(
        token,
        INVALID_VIDEO,
      );

      expect(completedStatus).toBe('processing');

      // Poll until the worker exhausts all retries and marks it failed.
      // attempts=3 with exponential backoff from 5s means two waits (5s + 10s),
      // so roughly 15–20 seconds end to end.
      const failedVideo = await pollUntilStatus(
        app.getHttpServer(),
        publicId,
        token,
        ['failed'],
        120_000,
      );

      expect(failedVideo.status).toBe('failed');
      expect(failedVideo.error_message).toBeTruthy();
      // The presigned input URL (with credentials) must never leak to clients.
      expect(failedVideo.error_message).not.toContain('X-Amz-');
      expect(failedVideo.duration_seconds).toBeNull();
      expect(failedVideo.metadata).toBeNull();
      expect(failedVideo.thumbnail_url).toBeNull();
    }, 150_000);
  });
});
