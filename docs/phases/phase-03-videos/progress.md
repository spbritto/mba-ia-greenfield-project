# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 8/9 completed

### SI-03.1 — Dependências, infraestrutura (Redis, MinIO) e configuração
- **Status:** completed
- **Tests:** storage.config.spec (3), queue.config.spec (3), env.validation.integration-spec (+8)
- **Observations:** Official minio/minio Docker image removed (Sep 2026); using cgr.dev/chainguard/minio. Bucket-level CORS not supported in OSS MinIO; using MINIO_API_CORS_ALLOW_ORIGIN env var. mc binary download URL also gone (410); minio-init uses Chainguard minio image which bundles mc.

### SI-03.2 — Entidade Video, migração e módulo
- **Status:** completed
- **Tests:** public-id.spec (3), video.entity.integration-spec (7), videos.module.spec (1), migrations.integration-spec (updated: 3 migrations)
- **Observations:** Installed `ioredis` (required by BullMQ at runtime). E2E `auth.e2e-spec.ts` beforeAll timeout increased to 30s due to BullMQ Redis connection time. Migration test switched from parallel to sequential DROP to avoid FK deadlocks. `VideosModule.spec` uses `synchronize: false` since compilation test doesn't need actual DB sync.

### SI-03.3 — StorageModule (cliente S3/MinIO)
- **Status:** completed
- **Tests:** storage.service.integration-spec (8: multipart create/presign/complete, getObjectSize, presignClientGet Range→206, presignClientGet Content-Disposition, putObject/deleteObject, abortMultipartUpload, presignInternalGet)
- **Observations:** StorageService with two S3Client instances (internal/public) and `onModuleDestroy` for cleanup. `import type { ConfigType }` required for `isolatedModules` + `emitDecoratorMetadata`. StorageModule registered in AppModule and exported for consumer modules.

### SI-03.4 — Lookup de canal, exceções de domínio e VideosService
- **Status:** completed
- **Tests:** channels.service.integration-spec (+2 findByUserId), videos.service.spec (25 unit: initiateUpload 4, refreshPartUrls 3, completeUpload 5, abortUpload 1, findByPublicId 5, getStreamUrl 4, getDownloadUrl 3), videos.service.integration-spec (4: initiateUpload persists draft, compensation on insert failure, completeUpload enqueues job, abortUpload removes row), videos.module.spec (updated: added ConfigModule+storageConfig)
- **Observations:** Added ChannelsService.findByUserId for ownership lookup (single responsibility). 6 domain exceptions created. VideosService with full upload lifecycle (initiate → refresh → complete/abort), public read (findByPublicId, getStreamUrl, getDownloadUrl), public_id retry with compensation pattern. BullMQ integration tests use queue prefix for isolation. PART_SIZE = 100 MiB.

### SI-03.5 — Endpoints de upload (VideosController)
- **Status:** completed
- **Tests:** videos.e2e-spec (13: initiate 201 + validation 400×4 + 401; refresh 200 + 403; complete 200 + 409 + UPLOAD_INCOMPLETE 400 + SIZE_MISMATCH 400; abort 204)
- **Observations:**
  - DTOs created in `src/videos/dto/` with request DTOs (class-validator only, no @ApiProperty per nestjs-dtos rule) and response DTOs (@ApiProperty for OpenAPI).
  - `@SkipThrottle()` applied at controller class level to bypass the global 10 req/min throttle (upload polling exceeds it).
  - `VideosController` registered in `VideosModule` via `controllers` array.
  - E2E tests use a minimal synthetic MP4 buffer (ftyp+mdat boxes) for real multipart upload to MinIO via presigned URLs.

### SI-03.6 — Autenticação opcional e endpoints públicos (metadados, stream, download)
- **Status:** completed
- **Tests:** jwt-auth.guard.spec (9: existing 5 + new 3 @OptionalAuth + 1 non-optional regression), videos.e2e-spec (+7: metadata anon-ready 200, metadata anon-draft 404, metadata owner-draft 200, metadata invalid-token 401, stream anon-ready 302+206, stream owner-draft 409, download anon-ready 302+attachment)
- **Observations:**
  - `@OptionalAuth()` decorator + `IS_OPTIONAL_AUTH_KEY` metadata key; guard checks optional-auth after public, before rejecting missing header.
  - `ParsePublicIdPipe` validates 12-char `[A-Za-z0-9_-]` publicId.
  - `@Redirect()` decorator on stream/download endpoints; handler returns `{ url }` for NestJS to redirect 302.
  - `VideoMetadataResponseDto` with full `@ApiProperty` annotations for OpenAPI (response DTO, not validated input).
  - E2E tests seed a "ready" video directly via repository + `StorageService.putObject` to avoid enqueuing a processing job.

### SI-03.7 — Worker de processamento (FFmpeg) e serviço `video-worker`
- **Status:** completed
- **Tests:** ffmpeg.service.integration-spec (7: probe duration/codecs/dimensions/format/invalid-file, extractFrame jpeg-bytes/invalid-file), video.processor.spec (8 unit: success ready+thumbnailTime-short+thumbnailTime-null, skip not-found+not-processing+draft, failure intermediate+final), video.processor.integration-spec (1: fixture→ready with duration/metadata/thumbnail), worker.module.spec (1: compilation)
- **Observations:**
  - `FfmpegService` uses raw `spawn` of `ffprobe`/`ffmpeg` (no `fluent-ffmpeg`); typed `FfprobeOutput` interface avoids `any` from `JSON.parse`.
  - `VideoProcessor` extends `WorkerHost`; idempotent — skips if video not found or not `processing`; final-attempt detection uses `job.attemptsMade >= (job.opts.attempts ?? 1) - 1`.
  - `WorkerModule` standalone context (no HTTP): requires `Video`, `Channel`, and `User` entities in `forFeature` due to relation chain `Video → Channel → User`.
  - `worker.ts` signal handler uses `void app.close().then(…)` to satisfy `no-misused-promises` lint rule.
  - Test fixture `test/fixtures/sample.mp4` generated with `ffmpeg -f lavfi` (2s, 320×240, H.264+AAC, ~60KB).

### SI-03.8 — E2E do ciclo completo com o worker
- **Status:** completed
- **Tests:** videos-processing.e2e-spec (2: success cycle draft→processing→ready with duration/metadata/thumbnail + stream 302→206 + download 302→attachment; failure cycle invalid-bytes→processing→failed with error_message after 3 retries)
- **Observations:**
  - Test uses the real `test/fixtures/sample.mp4` fixture (~62KB) for the success scenario; random invalid bytes for the failure scenario.
  - `pollUntilStatus` helper polls `GET /videos/:publicId` every 2s until the expected status or timeout. Success timeout 60s; failure timeout 120s (attempts=3 → two backoff waits, 5s + 10s ≈ 15s real).
  - Asserts `draft` on initiate and `processing` on complete, and that `error_message` never contains the presigned URL (`X-Amz-`).
  - Jest per-test timeouts set to 90s (success) and 150s (failure) to accommodate worker processing + retries.

### SI-03.9 — Documentação e contrato OpenAPI
- **Status:** pending
- **Tests:**
- **Observations:**
