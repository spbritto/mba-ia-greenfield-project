import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { generatePublicId } from '../src/videos/utils/public-id';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { bodyOf, type ErrorBody } from './utils/response-body';

// Minimal valid MP4 (ftyp + mdat boxes, ~24 bytes) — enough to exercise the
// upload flow without a real video file. The multipart upload flow only cares
// about bytes, not codec validity.
const SAMPLE_MP4 = Buffer.from(
  '0000001c667479706d703432000000006d7034326d703431' + '00000008' + '6d646174',
  'hex',
);

interface InitiateResponse {
  id: string;
  public_id: string;
  status: string;
  upload_id: string;
  part_size: number;
  total_parts: number;
  part_urls: { part_number: number; url: string }[];
}

interface CompleteResponse {
  id: string;
  public_id: string;
  status: string;
}

function getMailService(authService: AuthService): MailService {
  return (authService as unknown as { mailService: MailService }).mailService;
}

describe('Videos Upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let videoRepository: Repository<Video>;
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
    storageService = moduleFixture.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
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
    sizeOverride?: number,
  ): Promise<InitiateResponse> {
    const size = sizeOverride ?? SAMPLE_MP4.length;
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        file_name: 'test.mp4',
        mime_type: 'video/mp4',
        size_in_bytes: size,
      })
      .expect(201);
    return bodyOf<InitiateResponse>(res);
  }

  async function putPartToPresignedUrl(
    url: string,
    body: Buffer,
  ): Promise<string> {
    // The presigned URL points to MinIO (S3-compatible). We use native fetch
    // because supertest is bound to our app server.
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

  // ---------------------------------------------------------------------------
  // 1. Initiate Upload (POST /videos)
  // ---------------------------------------------------------------------------

  describe('POST /videos', () => {
    it('returns 201 with draft video and presigned URLs', async () => {
      const token = await registerConfirmAndLogin('uploader@test.com');
      const body = await initiateUpload(token);

      expect(body.id).toBeDefined();
      expect(body.public_id).toHaveLength(12);
      expect(body.status).toBe('draft');
      expect(body.upload_id).toBeDefined();
      expect(body.part_size).toBe(104857600);
      expect(typeof body.total_parts).toBe('number');
      expect(body.part_urls).toHaveLength(body.total_parts);
      for (const pu of body.part_urls) {
        expect(typeof pu.part_number).toBe('number');
        expect(typeof pu.url).toBe('string');
      }
    });

    it('returns 400 VALIDATION_ERROR on missing file_name', async () => {
      const token = await registerConfirmAndLogin('v1@test.com');
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ mime_type: 'video/mp4', size_in_bytes: 1024 })
        .expect(400);

      expect(bodyOf<ErrorBody>(res).error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR on unsupported mime_type', async () => {
      const token = await registerConfirmAndLogin('v2@test.com');
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          file_name: 'test.txt',
          mime_type: 'text/plain',
          size_in_bytes: 1024,
        })
        .expect(400);

      expect(bodyOf<ErrorBody>(res).error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR on size_in_bytes = 0', async () => {
      const token = await registerConfirmAndLogin('v3@test.com');
      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          file_name: 'test.mp4',
          mime_type: 'video/mp4',
          size_in_bytes: 0,
        })
        .expect(400);
    });

    it('returns 400 VALIDATION_ERROR on size_in_bytes exceeding 10 GiB', async () => {
      const token = await registerConfirmAndLogin('v4@test.com');
      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          file_name: 'test.mp4',
          mime_type: 'video/mp4',
          size_in_bytes: 10_737_418_241,
        })
        .expect(400);
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          file_name: 'test.mp4',
          mime_type: 'video/mp4',
          size_in_bytes: 1024,
        })
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Refresh Part URLs (POST /videos/:videoId/upload/part-urls)
  // ---------------------------------------------------------------------------

  describe('POST /videos/:videoId/upload/part-urls', () => {
    it('returns 200 with fresh presigned URLs', async () => {
      const token = await registerConfirmAndLogin('refresh@test.com');
      const { id } = await initiateUpload(token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1] })
        .expect(200);

      const body = bodyOf<{
        part_urls: { part_number: number; url: string }[];
      }>(res);
      expect(body.part_urls).toHaveLength(1);
      expect(body.part_urls[0].part_number).toBe(1);
      expect(typeof body.part_urls[0].url).toBe('string');
    });

    it('returns 403 VIDEO_ACCESS_DENIED for non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin('owner@test.com');
      const { id } = await initiateUpload(ownerToken);

      const otherToken = await registerConfirmAndLogin('other@test.com');
      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/upload/part-urls`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ part_numbers: [1] })
        .expect(403);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_ACCESS_DENIED');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Complete Upload (POST /videos/:videoId/upload/complete)
  // ---------------------------------------------------------------------------

  describe('POST /videos/:videoId/upload/complete', () => {
    it('returns 200 with status processing after valid complete', async () => {
      const token = await registerConfirmAndLogin('complete@test.com');
      const initBody = await initiateUpload(token);

      // PUT the part to the presigned URL
      const etag = await putPartToPresignedUrl(
        initBody.part_urls[0].url,
        SAMPLE_MP4,
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${initBody.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      const body = bodyOf<CompleteResponse>(res);
      expect(body.id).toBe(initBody.id);
      expect(body.public_id).toBe(initBody.public_id);
      expect(body.status).toBe('processing');

      // Verify in DB: status = processing, upload_id = null
      const row = await dataSource.query<
        { status: string; upload_id: string | null }[]
      >('SELECT status, upload_id FROM videos WHERE id = $1', [initBody.id]);
      expect(row[0].status).toBe('processing');
      expect(row[0].upload_id).toBeNull();
    });

    it('returns 409 VIDEO_NOT_IN_DRAFT on duplicate complete', async () => {
      const token = await registerConfirmAndLogin('dup-complete@test.com');
      const initBody = await initiateUpload(token);

      const etag = await putPartToPresignedUrl(
        initBody.part_urls[0].url,
        SAMPLE_MP4,
      );

      await request(app.getHttpServer())
        .post(`/videos/${initBody.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${initBody.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(409);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_IN_DRAFT');
    });

    it('returns 400 UPLOAD_INCOMPLETE on wrong etag', async () => {
      const token = await registerConfirmAndLogin('incomplete@test.com');
      const initBody = await initiateUpload(token);

      // PUT the real part so the multipart upload is valid
      await putPartToPresignedUrl(initBody.part_urls[0].url, SAMPLE_MP4);

      const res = await request(app.getHttpServer())
        .post(`/videos/${initBody.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag: '"not-the-real-etag"' }] })
        .expect(400);

      expect(bodyOf<ErrorBody>(res).error).toBe('UPLOAD_INCOMPLETE');

      // Verify: video stays draft and upload_id unchanged
      const row = await dataSource.query<
        { status: string; upload_id: string | null }[]
      >('SELECT status, upload_id FROM videos WHERE id = $1', [initBody.id]);
      expect(row[0].status).toBe('draft');
      expect(row[0].upload_id).not.toBeNull();
    });

    it('returns 400 SIZE_MISMATCH when declared size differs from stored', async () => {
      const token = await registerConfirmAndLogin('sizemismatch@test.com');
      // Declare size = actual + 1 so size verification fails
      const initBody = await initiateUpload(token, SAMPLE_MP4.length + 1);

      // Grab storage_key before the complete call deletes the row
      const [{ storage_key: storageKey }] = await dataSource.query<
        { storage_key: string }[]
      >('SELECT storage_key FROM videos WHERE id = $1', [initBody.id]);

      const etag = await putPartToPresignedUrl(
        initBody.part_urls[0].url,
        SAMPLE_MP4,
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${initBody.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(400);

      expect(bodyOf<ErrorBody>(res).error).toBe('SIZE_MISMATCH');

      // Verify: video row deleted and storage object removed
      const row = await dataSource.query<{ id: string }[]>(
        'SELECT id FROM videos WHERE id = $1',
        [initBody.id],
      );
      expect(row).toHaveLength(0);

      // Verify storage object is gone — getObjectSize should throw
      await expect(storageService.getObjectSize(storageKey)).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Abort Upload (DELETE /videos/:videoId/upload)
  // ---------------------------------------------------------------------------

  describe('DELETE /videos/:videoId/upload', () => {
    it('returns 204 and deletes the draft video', async () => {
      const token = await registerConfirmAndLogin('abort@test.com');
      const initBody = await initiateUpload(token);

      await request(app.getHttpServer())
        .delete(`/videos/${initBody.id}/upload`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      // Verify: video row is gone
      const row = await dataSource.query<{ id: string }[]>(
        'SELECT id FROM videos WHERE id = $1',
        [initBody.id],
      );
      expect(row).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers for public endpoint tests
  // ---------------------------------------------------------------------------

  /**
   * Seeds a "ready" video directly in the DB + storage, bypassing the upload
   * flow. This avoids enqueuing a processing job that a running worker could
   * pick up and race the test.
   */
  async function seedReadyVideo(
    channelId: string,
  ): Promise<{ publicId: string; storageKey: string }> {
    const publicId = generatePublicId();
    const storageKey = `videos/ready-test/original.mp4`;

    // Store the sample bytes in MinIO
    await storageService.putObject(storageKey, SAMPLE_MP4, 'video/mp4');

    await videoRepository.save({
      public_id: publicId,
      channel_id: channelId,
      title: 'Ready Video',
      status: VideoStatus.READY,
      mime_type: 'video/mp4',
      size_in_bytes: SAMPLE_MP4.length,
      storage_key: storageKey,
      upload_id: null,
      duration_seconds: 10.5,
      metadata: {
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        bit_rate: 5000000,
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      },
    });

    return { publicId, storageKey };
  }

  async function getChannelIdFromToken(accessToken: string): Promise<string> {
    // Decode JWT to get the user id (without verification — test only)
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString(),
    ) as { sub: string };
    const [row] = await dataSource.query<{ id: string }[]>(
      'SELECT id FROM channels WHERE user_id = $1',
      [payload.sub],
    );
    return row.id;
  }

  // ---------------------------------------------------------------------------
  // 5. Video Metadata (GET /videos/:publicId)
  // ---------------------------------------------------------------------------

  describe('GET /videos/:publicId', () => {
    it('returns 200 for anonymous user on a ready video', async () => {
      const token = await registerConfirmAndLogin('meta-anon@test.com');
      const channelId = await getChannelIdFromToken(token);
      const { publicId } = await seedReadyVideo(channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      const body = bodyOf<Record<string, unknown>>(res);
      expect(body.public_id).toBe(publicId);
      expect(body.status).toBe('ready');
      expect(body.duration_seconds).toBe(10.5);
      expect(body.metadata).toBeDefined();
      expect(body.created_at).toBeDefined();
      // error_message is null for non-owners
      expect(body.error_message).toBeNull();
    });

    it('returns 404 for anonymous user on a draft video', async () => {
      const token = await registerConfirmAndLogin('meta-draft@test.com');
      const initBody = await initiateUpload(token);

      // Get draft video's public_id from DB
      const [row] = await dataSource.query<{ public_id: string }[]>(
        'SELECT public_id FROM videos WHERE id = $1',
        [initBody.id],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${row.public_id}`)
        .expect(404);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 200 for owner on a draft video', async () => {
      const token = await registerConfirmAndLogin('meta-owner@test.com');
      const initBody = await initiateUpload(token);

      const [row] = await dataSource.query<{ public_id: string }[]>(
        'SELECT public_id FROM videos WHERE id = $1',
        [initBody.id],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${row.public_id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(bodyOf<Record<string, unknown>>(res).status).toBe('draft');
    });

    it('returns 401 when Authorization header has an invalid token', async () => {
      const token = await registerConfirmAndLogin('meta-401@test.com');
      const channelId = await getChannelIdFromToken(token);
      const { publicId } = await seedReadyVideo(channelId);

      await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Video Streaming (GET /videos/:publicId/stream)
  // ---------------------------------------------------------------------------

  describe('GET /videos/:publicId/stream', () => {
    it('returns 302 for anonymous on ready video, and Location responds 206 to Range', async () => {
      const token = await registerConfirmAndLogin('stream-anon@test.com');
      const channelId = await getChannelIdFromToken(token);
      const { publicId } = await seedReadyVideo(channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .redirects(0)
        .expect(302);

      const location = res.headers.location;
      expect(location).toBeDefined();

      // Fetch with Range header to prove 206
      const rangeRes = await fetch(location, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBeTruthy();
    });

    it('returns 409 VIDEO_NOT_UPLOADED for owner streaming a draft video', async () => {
      const token = await registerConfirmAndLogin('stream-draft@test.com');
      const initBody = await initiateUpload(token);

      const [row] = await dataSource.query<{ public_id: string }[]>(
        'SELECT public_id FROM videos WHERE id = $1',
        [initBody.id],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${row.public_id}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_UPLOADED');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Video Download (GET /videos/:publicId/download)
  // ---------------------------------------------------------------------------

  describe('GET /videos/:publicId/download', () => {
    it('returns 302 with attachment Content-Disposition for anonymous on ready video', async () => {
      const token = await registerConfirmAndLogin('dl-anon@test.com');
      const channelId = await getChannelIdFromToken(token);
      const { publicId } = await seedReadyVideo(channelId);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .redirects(0)
        .expect(302);

      const location = res.headers.location;
      expect(location).toBeDefined();
      // The presigned URL should include response-content-disposition with attachment
      expect(location).toContain('response-content-disposition');

      // Fetch the redirect target and verify Content-Disposition
      const dlRes = await fetch(location);
      expect(dlRes.ok).toBe(true);
      expect(dlRes.headers.get('content-disposition')).toMatch(/^attachment/);
    });
  });
});
