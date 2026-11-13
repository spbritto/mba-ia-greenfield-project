---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-11T22:46:19"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-13T12:26:58"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-11T22:46:19"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-11T22:46:19"
  docs/phases/phase-02-auth/context.md: "2026-11-11T22:46:19"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-11T22:46:19"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-11T22:46:19"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Categorias de vídeo; edição de título, descrição, categoria e thumbnail customizada; visibilidade (público/unlisted); fluxo de rascunho para publicação; painel de gerenciamento de vídeos do canal; edição de informações do canal; página pública do canal — all deferred to Phase 04. Frontend video interface — Phase 03 is explicitly a backend-only deliverable per `objetivo_desafio.md`.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — no frontend video interface in this phase.

**Sequencing notes:** Depends on Fase 01 (Configuração Base do Projeto) and Fase 02 (Cadastro, Login e Gerenciamento de Conta).

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Job Queue Technology | decided | B | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy for Large Files (up to 10GB) | decided | A | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | S3 Client Library | decided | A | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Processing — Worker Architecture and FFmpeg Integration | decided | B | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Upload Protocol — Simple Presigned PUT vs. S3 Multipart Upload | decided | A | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Streaming Strategy | decided | A | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Failure Handling | decided | B | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Storage Key Organization (Bucket and Object Key Structure) | decided | A | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-09 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-05 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ on Redis is the most battle-tested Node.js queue, with first-class NestJS integration via `@nestjs/bullmq` (`BullModule.forRoot()`, `@Processor()`, `@InjectQueue()`) and the broadest official documentation. Redis runs as a dedicated `redis` service in `compose.yaml` (with `appendonly yes` so queued jobs survive a container restart), which makes the queue an explicit infrastructure component — the Phase 03 acceptance criteria require object storage, queue and worker to come up via Docker Compose alongside the backend. Option A was set aside because the BullMQ 6 PostgreSQL backend is very recent (`bullmq` 6.0.0 published on npm on 2026-07-30), its `@nestjs/bullmq` `backendFactory` integration could not be confirmed in official documentation, and it would leave no dedicated queue service in Compose. Option C's NestJS integration is a low-adoption community package.

**Libraries:** bullmq, @nestjs/bullmq

### phase-03-videos/TD-02

**Recommendation:** The API generates lightweight presigned URLs; the actual 10GB transfer goes directly from the client to MinIO/S3, leaving the NestJS process completely unloaded. For files >5GB, the API orchestrates the S3 multipart upload flow (generate upload ID + presigned URLs per part), and the client uploads parts in parallel directly to storage. This is the standard pattern used by YouTube, Vimeo, and every production video platform. Option B (tus) adds infrastructure complexity that is not justified when the storage already supports resumable multipart uploads natively. Option C is explicitly disqualified by the project requirements.

**Libraries:** —

**Revisions:**
- 2026-11-13 — Presigned URLs handed to clients are signed against a separate public storage endpoint (`S3_PUBLIC_ENDPOINT`, e.g. `http://localhost:9000` in local dev), while server-side S3 calls (API and worker) use the internal Compose endpoint (`S3_ENDPOINT=http://minio:9000`). Tests that run inside the `nestjs-api` container set `S3_PUBLIC_ENDPOINT` to the internal endpoint so they can reach the URLs. Rationale: the S3 signature covers the host, so a URL signed for `minio:9000` is unusable outside the Docker network; this is the only place a non-service host appears and it is never used for container-to-container traffic (root `CLAUDE.md` → Docker Networking).
- 2026-11-13 — The bucket CORS policy allows `PUT`/`GET`/`HEAD` from the client origin and exposes the `ETag` response header. Rationale: the client must read each part's `ETag` to complete the multipart upload.

### phase-03-videos/TD-03

**Recommendation:** The project runs MinIO in dev and targets S3 in production. AWS SDK v3 is the canonical S3 client, with the broadest documentation, TypeScript support, and feature coverage, and is MinIO-compatible via `endpoint` + `forcePathStyle`. Only two packages are adopted: `@aws-sdk/client-s3` (multipart commands `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` / `AbortMultipartUpload`, plus `HeadObject`, `PutObject`, `GetObject`) and `@aws-sdk/s3-request-presigner` (`getSignedUrl()` for part uploads, streaming and download). _Adjusted during review (2026-11-12):_ `@aws-sdk/lib-storage` is not adopted — the client uploads multipart parts directly through presigned URLs and the worker only writes a small thumbnail with `PutObjectCommand`, so a managed server-side upload helper has no use. Option B locks the project into a MinIO-specific client that may lack features when deploying to AWS. Option C lacks multipart upload support critical for 10GB files.

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-04

**Recommendation:** The worker runs as a dedicated `video-worker` service in `compose.yaml`, matching the architecture diagram (Video Worker as its own container) and the Phase 03 acceptance criteria, which require the worker to come up via Docker Compose alongside the backend. The shared-code concern is resolved without duplication: both services are built from the same `nestjs-project/` codebase, and the worker has its own entrypoint that boots a NestJS application context (no HTTP server) registering only what it needs — the `@Processor()` for the video-processing queue, the storage service and video persistence — while the API process does not register the processor. The image used by the worker includes the FFmpeg binaries (`ffmpeg`, `ffprobe`). FFmpeg is invoked directly through `node:child_process` (`spawn` of `ffprobe` to read duration and stream metadata as JSON, and of `ffmpeg` to extract a single frame as the JPEG thumbnail); `fluent-ffmpeg` is not used because the package is deprecated on npm ("Package no longer supported"). The worker reads the source video from storage through a presigned GET URL (FFmpeg reads HTTP inputs using range requests), avoiding a full local copy of files up to 10GB. Options A and C were set aside because they leave no worker service in Compose.

**Libraries:** —

**Revisions:**
- 2026-11-13 — The thumbnail is the frame at 10% of the extracted duration (first frame when the duration is unknown or under 1 second), saved as JPEG. Rationale: the opening frames of videos are often black or title cards; validation flagged the frame-selection strategy as unspecified.
- 2026-11-13 — The FFmpeg binaries (`ffmpeg`, `ffprobe`) are also installed in the `nestjs-api` image, not only in the `video-worker` image. Rationale: every test runs inside the `nestjs-api` container (`nestjs-project/CLAUDE.md` → Commands), and processor integration tests execute real FFmpeg.

### phase-03-videos/TD-05

**Recommendation:** A single, universal code path eliminates branching and ensures 10GB support from day one. The multipart flow with parallel part uploads is strictly superior in throughput and resilience for any file over ~100MB, which is the typical video file range. The client-side complexity is bounded and well-documented (S3 multipart presigned is a standard pattern). Option B's dual path adds maintenance cost for a marginal simplicity win on small files that is rarely exercised (video files are typically >100MB).

**Libraries:** —

**Revisions:**
- 2026-11-13 — Upload limits and contract: fixed part size of 100 MiB (last part may be smaller); maximum file size of 10 GiB (10 × 1024³ bytes), validated at initiation against the declared size and again at completion against the stored object size (`HeadObject` `ContentLength`); accepted content types `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`. Part URLs expire after 1 hour and the owner can request fresh URLs for specific part numbers while the video is `draft`; the owner can abort an in-progress upload (`AbortMultipartUpload`). Rationale: the 10GB limit comes from the project plan, and the S3 limits (5 MiB minimum part, 10,000 parts maximum) are satisfied with ~103 parts at 10 GiB; validation found these parameters unspecified.

### phase-03-videos/TD-06

**Recommendation:** The use case is a YouTube-like URL identifier: short, URL-safe, shareable, non-sequential. _Adjusted during review (2026-11-12):_ the identifier uses the NanoID URL-safe alphabet (`A-Za-z0-9_-`) with a fixed length of **12 characters**, generated with Node's built-in `node:crypto` (`randomBytes(9).toString('base64url')`, 72 bits of entropy, no padding) instead of the `nanoid` package — current `nanoid` releases are ESM-only (`"type": "module"`), while the backend compiles to CommonJS and runs tests under ts-jest. This also removes a dependency. Uniqueness is guaranteed by a `UNIQUE` constraint on the column plus regenerate-and-retry on collision. YouTube uses an 11-character base64 identifier, so 12 characters keeps the same aesthetic. The internal primary key stays a UUID; the short ID is only the public URL identifier. CUID2's distributed anti-collision guarantees add unnecessary complexity for a single-Postgres deployment. UUID is too long for user-facing URLs.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Same architectural principle as TD-02: offload byte transfer from the API. S3/MinIO handle range requests natively, so HTTP streaming "just works" when the `<video>` element points at the presigned URL. Access control is enforced at URL generation time (API checks auth + video status before issuing the URL). For Phase 03, all videos are viewable (draft status videos are only viewable by the owner, enforced at the URL generation endpoint). Option B reintroduces the problem TD-02 solved (passing large files through the API). Option C is premature — Phase 04's visibility feature doesn't require a proxy; short-lived presigned URLs with DB checks suffice.

**Libraries:** —

**Revisions:**
- 2026-11-13 — HTTP contract: `GET /videos/:publicId/stream` and `GET /videos/:publicId/download` respond `302 Found` with `Location` set to a presigned GET URL; the download URL sets `ResponseContentDisposition: attachment`. Presigned GET URLs expire after a configurable TTL (default 4 hours). Rationale: a redirect lets a `<video src>` or download link point at the API while the bytes (including `Range` requests answered with `206 Partial Content`) flow directly from storage.
- 2026-11-13 — Access rules: the owner of the video's channel can read metadata, stream and download in any status; anyone else, including anonymous users, only when the status is `ready`. A non-owner request for a video that is not `ready` returns 404 (existence is not disclosed). Rationale: anonymous viewing is a platform rule (project overview; Phase 05), while visibility controls are Phase 04 scope.

### phase-03-videos/TD-08

**Recommendation:** The presigned URL upload model (TD-02/TD-05) means the API has no visibility into upload progress — it only knows when the upload is initiated (draft created) and when the client confirms completion. An `uploading` state would require polling storage to verify progress, adding unnecessary complexity. Four states (including `failed`) are sufficient: `draft` covers the entire upload period, `processing` covers job execution, `ready` is the terminal success state, and `failed` enables retry. Stale drafts (abandoned uploads) can be cleaned by a periodic job that deletes `draft` videos older than a configurable TTL (e.g., 24h).

**Libraries:** —

**Revisions:**
- 2026-11-13 — Failure policy: a processing job is attempted up to 3 times with exponential backoff (initial delay 5 seconds); the job id is the video id so completing an upload twice cannot enqueue duplicates. Only when the final attempt fails does the worker set the status to `failed` and store the error message; intermediate failures keep the status `processing`. Rationale: validation found the retry policy unspecified, and transient storage/FFmpeg errors should not fail a video on the first attempt.
- 2026-11-13 — Automatic cleanup of stale drafts (the periodic TTL job mentioned in the recommendation) is **out of scope** for Phase 03; abandoned multipart uploads can be aborted through the upload abort operation (TD-05). Rationale: it is not a Phase 03 capability in `docs/project-plan.md` and would add a scheduler dependency; it is recorded as a future task.

### phase-03-videos/TD-09

**Recommendation:** Simplest infrastructure (one bucket) with clean logical grouping via prefix. `videos/{videoId}/` as a prefix enables listing and bulk-deleting all artifacts for a video. Phase 03 has no differentiated access policies between videos and thumbnails (both use presigned URLs), so separate buckets (Option B) add infrastructure cost without benefit. The prefix structure naturally extends for future artifacts (e.g., `videos/{videoId}/720p.mp4`, `videos/{videoId}/360p.mp4` for transcoded versions).

**Libraries:** —

**Revisions:**
- 2026-11-13 — The `{videoId}` segment in storage keys is the video's internal UUID primary key, not the public 12-character identifier (TD-06). Rationale: storage layout stays independent of the public URL identifier.
- 2026-11-13 — The bucket (name from configuration) and its CORS policy (TD-02 revision) are created by a one-shot `minio-init` service in `compose.yaml` (MinIO client) that runs after `minio` is healthy. Rationale: `docker compose up` must yield a ready-to-use storage without manual steps.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** @nestjs/config — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Namespaced/grouped with registerAs — Clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Shared registerAs factory — Natural outcome of choosing `@nestjs/config` with `registerAs`. `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended. Native build dependency is a one-time Docker setup cost.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with @nestjs/jwt only — kept the dependency surface smaller than @nestjs/passport; social login is not on the near-term roadmap.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation — Strongest security model with automatic theft detection. DB write overhead is acceptable.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random Opaque Tokens in DB — Revocability is important; the DB table is trivial to implement.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** @nestjs-modules/mailer — Best NestJS integration, SMTP-based, works with Mailpit for local dev.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — Documented NestJS approach, decorator-based, aligns with TypeORM entities.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — Machine-readable error codes, `{ statusCode, error, message }` format with domain codes.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** @nestjs/throttler — Native NestJS guard integration, module-level `APP_GUARD`, in-memory storage sufficient.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** JWT for refresh tokens (diverged from opaque recommendation) — reuses access-token signing/verification infrastructure.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** `[a-z0-9_]` + `user_<random>` fallback — strict allowlist, no extra dependencies, `user_<random>` fallback for extreme prefixes.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** @nestjs/swagger — official NestJS integration, decorator-based, generates OpenAPI 3.x spec from code. CLI plugin with `classValidatorShim: true` leverages existing `class-validator` decorators. Phase 03 endpoints must use `@ApiTags()`, `@ApiOperation()`, `@ApiResponse()`, and DTO decorators for video resources.

**Libraries:** `@nestjs/swagger@^11.x`

**Revisions:**
- 2026-05-12 — CLI plugin (`classValidatorShim: true`) covers only DTO schema inference; documentation of operations, typed status-code responses, error contracts (aligned to phase-02-auth/TD-07 envelope), and examples requires explicit decorators (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`).

### openapi-docs-nestjs/TD-02

**Recommendation:** Runtime UI + exported openapi.json — Swagger UI served at `/api/docs` (dev/staging), `openapi.json` exported as a build artifact for downstream consumers (frontend codegen).

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Dev/staging only — Swagger UI and spec endpoint disabled in production via environment flag.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. Phase 03 adds `src/config/storage.config.ts` and `src/config/queue.config.ts`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. Phase 03 adds storage (S3 endpoint, bucket, credentials) and Redis (host, port) env vars to the schema. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters sourced from a single `databaseConfig` factory — never duplicated. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Auth uses custom guards with `@nestjs/jwt` (no @nestjs/passport). Phase 03 upload endpoints require authentication (user must be logged in to upload); use the existing JWT guard. _(from phase 02)_
- Domain exceptions mapped to HTTP responses by a custom exception filter. Phase 03 introduces new domain exceptions (e.g., `VideoNotFound`, `UploadNotCompleted`, `ProcessingFailed`). _(from phase 02)_
- Request validation via `class-validator` + `class-transformer` with `ValidationPipe`. Phase 03 DTOs for upload initiation follow the same pattern. _(from phase 02)_
- Rate limiting via `@nestjs/throttler`. Upload endpoints may need custom throttle configuration. _(from phase 02)_
- All endpoints documented with `@nestjs/swagger` decorators (`@ApiTags()`, `@ApiOperation()`, `@ApiResponse()`). Phase 03 video endpoints must follow this convention. _(from openapi-docs-nestjs)_

## Inherited Deferred Capabilities

| Capability | Source phase | Status | Rationale |
|------------|-------------|--------|-----------|
| Telas de frontend | phase-01-configuracao-base | deferred | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | phase-02-auth | deferred | `next-frontend/` was not initialized in phase 02; UI surfaces start in a later phase. |
| Confirmação de conta via e-mail com link de ativação (FE landing screen) | phase-02-auth-frontend | deferred | UI landing screen de-scoped; FE confirmation flow picked up by a future phase. BE side unchanged. |
| Logout (UI button in authenticated chrome) | phase-02-auth-frontend | deferred | Logout button lives inside authenticated chrome (typically Phase 04). POST `/api/auth/logout` BFF route handler + `session.destroy()` contract is ready. |
| Recuperação de senha (destination screen / set-new-password) | phase-02-auth-frontend | deferred | `/forgot-password` ships sending the e-mail; reset-password destination screen absent; link destination remains 404 until a later phase delivers the screen. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Frontend video interface (upload UI, player, progress) | deferred | Phase 03 is explicitly a backend-only deliverable per `objetivo_desafio.md`. Frontend video interface deferred to future phases. | — |
| Video title, description, category editing | deferred | Phase 04 scope — Gerenciamento de Vídeos e Canal. | — |
| Video visibility (público/unlisted) | deferred | Phase 04 scope. | — |
| Custom thumbnail upload | deferred | Phase 04 scope — thumbnail editing is part of video management. | — |
| Draft → publication workflow | deferred | Phase 04 scope — full publication flow. Phase 03 only creates drafts and transitions to ready/failed. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`.

Phase 03 introduces several new artifact categories with specific testing considerations:

**New artifact types and their test layers:**

| Artifact | Test layer | Notes |
|----------|------------|-------|
| Video entity (`video.entity.ts`) | Integration (real DB) | Constraints, defaults, `select: false` fields, unique index on short ID, status enum column |
| VideosService (upload orchestration, status transitions) | Unit (branch logic, mock repos) + Integration (DB contract) | Service has branching: multipart initiation, completion validation, status transitions |
| StorageService (S3/MinIO client wrapper) | Integration (real MinIO) | Test against MinIO container in compose; presigned URL generation, multipart orchestration |
| VideosController | E2E only | Upload initiation, upload completion, streaming URL, video detail endpoints |
| Video DTOs | E2E (validation wiring) | One test per endpoint proving `ValidationPipe` rejects bad input |
| VideosModule | Unit (compilation) | DI wiring with `BullModule.registerQueue()`, `TypeOrmModule.forFeature()`, storage config |
| Queue producer (enqueue job on upload complete) | Integration (real Redis) | Assert job enqueued with correct data via `queue.getJobs(['waiting'])` |
| Queue processor (`@Processor`, worker) | Unit (mock deps) + Integration (real DB/storage) | Test `process()` method directly; assert DB status update and thumbnail upload |
| Config files (`storage.config.ts`, `queue.config.ts`) | Unit (module compilation) | Module fails to compile with missing env vars |

**External system strategies for Phase 03:**

| System | Strategy | Service in compose |
|--------|----------|--------------------|
| PostgreSQL | Real (Docker) — same as prior phases | `db` |
| Object Storage (MinIO) | Real (Docker) — MinIO container added in Phase 03 | `minio` |
| Message Queue (Redis) | Real (Docker) — Redis container added in Phase 03 | `redis` |
| Email (Mailpit) | Real SMTP capture — same as prior phases | `mailpit` |

**Queue testing pattern (BullMQ + Redis):**
- Use `BullModule.forRoot({ connection: { host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379) } })` in test modules — the fallback is the Compose service name, never `localhost` (root `CLAUDE.md` → Docker Networking)
- Assert job enqueued: `queue.getJobs(['waiting'])` returns expected job data
- Test processor's `process()` method directly — do not test BullMQ's dispatch mechanism
- Clean queues between tests: `queue.obliterate({ force: true })` or `queue.drain()`

**Storage testing pattern (MinIO):**
- MinIO runs as a Docker service with S3-compatible API
- Integration tests use real MinIO — no filesystem fallback in tests
- Test presigned URL generation: assert URL is valid and accessible
- Test multipart flow: `CreateMultipartUpload` → `UploadPart` → `CompleteMultipartUpload`
- Clean test objects in `afterAll`

**Worker testing pattern (FFmpeg via child_process):**
- Unit tests: mock `child_process.spawn` to return controlled stdout/stderr
- Integration tests: use a small test video fixture (few seconds, <1MB) to run real `ffprobe`/`ffmpeg`
- Assert: duration extracted correctly, thumbnail JPEG created and uploaded to storage, video status updated to `ready`
- Assert failure path: invalid video → status updated to `failed`
- Tests run inside the `nestjs-api` container (`nestjs-project/CLAUDE.md` → Commands), so integration tests that execute real `ffprobe`/`ffmpeg` require the FFmpeg binaries in that container's image as well as in the `video-worker` image

**End-to-end flow (acceptance evidence):**
- `objetivo_desafio.md` requires queue, worker and storage to be exercised by tests against the real Compose infrastructure ("Fila, worker e storage precisam subir no Compose e ser exercitados pelos testes") and lists "Streaming funcionando (sem exigir download completo) e download do vídeo disponível" as an acceptance criterion
- At least one `*.e2e-spec.ts` covers the full cycle: initiate upload (draft) → upload parts to MinIO via presigned URLs → complete upload (processing) → poll until the worker sets `ready` → request the streaming URL with a `Range` header and assert `206 Partial Content` → request the download URL and assert an attachment response
