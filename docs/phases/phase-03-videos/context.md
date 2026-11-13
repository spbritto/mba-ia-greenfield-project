---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-11T22:46:19"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-12T23:51:16"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-11-11T22:46:19"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-11T22:46:19"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-11T22:46:19"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-11T22:46:19"
  docs/phases/phase-02-auth/context.md: "2026-11-11T22:46:19"
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

**Out of scope:** Edição de informações do vídeo (título, descrição, categoria), visibilidade (público/unlisted), fluxo de rascunho → publicação, painel de gerenciamento do canal, página pública do canal — all deferred to Phase 04. Frontend video interface — Phase 03 is explicitly a backend-only deliverable per `objetivo_desafio.md`.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — no frontend video interface in this phase.

**Sequencing notes:** Depends on Fase 01 (Configuração Base do Projeto) and Fase 02 (Cadastro, Login e Gerenciamento de Conta).

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Job Queue Technology | decided | B (BullMQ + Redis) | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy for Large Files | decided | A (Presigned URL — direct client-to-storage) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | S3 Client Library | decided | A (AWS SDK v3 — client-s3 + s3-request-presigner) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Processing — Worker Architecture | decided | B (Separate worker container) | — (FFmpeg via node:child_process) |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Upload Protocol (PUT vs Multipart) | decided | A (S3 Multipart Upload only) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A (NanoID-format 12-char ID via node:crypto) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Streaming Strategy | decided | A (Direct-from-storage via presigned GET URL) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | B (draft → processing → ready \| failed) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Storage Key Organization | decided | A (Single bucket, type-prefixed keys) | — |

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

**Recommendation:** Option B (BullMQ + Redis) — BullMQ on Redis is the most battle-tested Node.js queue, with first-class NestJS integration via `@nestjs/bullmq` (`BullModule.forRoot()`, `@Processor()`, `@InjectQueue()`). Redis runs as a dedicated `redis` service in `compose.yaml` with `appendonly yes` for persistence. Option A (BullMQ 6 PostgreSQL backend) was set aside because it is very recent (mid-2026), its `@nestjs/bullmq` `backendFactory` integration could not be confirmed, and it would leave no dedicated queue service in Compose. Option C (pg-boss) has a low-adoption NestJS community package.

**Libraries:** `bullmq`, `@nestjs/bullmq`

### phase-03-videos/TD-02

**Recommendation:** Option A (Presigned URL — direct client-to-storage) — The API generates lightweight presigned URLs; the actual 10GB transfer goes directly from the client to MinIO/S3, leaving the NestJS process unloaded. For files >5GB, the API orchestrates the S3 multipart upload flow. Option B (tus) adds infrastructure complexity not justified when storage supports resumable multipart natively. Option C is disqualified by project requirements.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Option A (AWS SDK v3) — `@aws-sdk/client-s3` for S3 commands and `@aws-sdk/s3-request-presigner` for presigned URLs. MinIO-compatible via `endpoint` + `forcePathStyle`. `@aws-sdk/lib-storage` is not adopted — the client uploads multipart parts directly through presigned URLs and the worker only writes a small thumbnail with `PutObjectCommand`.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-04

**Recommendation:** Option B (Separate worker container) — The worker runs as a dedicated `video-worker` service in `compose.yaml`. Both services are built from the same `nestjs-project/` codebase; the worker has its own entrypoint that boots a NestJS application context (no HTTP server). FFmpeg is invoked via `node:child_process` (`spawn` of `ffprobe` for metadata JSON and `ffmpeg` for thumbnail extraction); `fluent-ffmpeg` is not used (deprecated on npm). The worker reads the source video from storage through a presigned GET URL (FFmpeg reads HTTP inputs with range requests).

**Libraries:** — (FFmpeg via `node:child_process`)

### phase-03-videos/TD-05

**Recommendation:** Option A (S3 Multipart Upload only) — A single, universal code path: API calls `CreateMultipartUpload`, returns `uploadId` + presigned URLs per part, client uploads parts in parallel directly to storage, reports ETags, API calls `CompleteMultipartUpload`. Eliminates branching between simple PUT and multipart. Supports the full 0–10GB range.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Option A (NanoID-format 12-char ID via node:crypto) — `randomBytes(9).toString('base64url')` produces a 12-character URL-safe identifier (72 bits of entropy, no padding). The `nanoid` package is not used because current releases are ESM-only while the backend is CommonJS. Uniqueness guaranteed by `UNIQUE` DB constraint + regenerate-and-retry on collision. The internal PK stays UUID; this short ID is only the public URL identifier.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Option A (Direct-from-storage via presigned GET URL) — The API generates a time-limited presigned GET URL. The `<video>` element or download link points directly to MinIO/S3, which natively handles `Range` requests and `206 Partial Content`. Zero API load during streaming/download. Access control is enforced at URL generation time.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Option B (draft → processing → ready | failed) — The presigned URL upload model means the API has no visibility into upload progress, so an `uploading` state is not meaningful. Four states: `draft` (upload period), `processing` (job executing), `ready` (terminal success), `failed` (enables retry). Stale drafts cleaned by a periodic job with configurable TTL.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Option A (Single bucket, type-prefixed keys) — One bucket (e.g., `streamtube`). Keys: `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg`. Prefix-based listing and bulk deletion. Naturally extends for future transcoded versions.

**Libraries:** —

## Correlated Ad-Hoc Decisions

The following ad-hoc decision documents (not scoped to a specific phase) are relevant to Phase 03 implementation:

| Document | Relevance | Rationale |
|----------|-----------|-----------|
| `technical-decisions-openapi-docs-nestjs.md` | HIGH | Phase 03 adds new video endpoints (upload initiation, upload completion, streaming URL generation, video detail). These endpoints must be documented with `@nestjs/swagger` decorators following the patterns established in this TD. The exported `openapi.json` artifact will include the new video resource schema. |
| `technical-decisions-next-frontend-openapi-typing.md` | MEDIUM-HIGH | The OpenAPI codegen pipeline established in this TD will consume the video endpoint schemas added in Phase 03. While the frontend is not in Phase 03 scope, the API response DTOs and endpoint decorators must be compatible with downstream codegen. |

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended. Native build dependency is a one-time Docker setup cost.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with @nestjs/jwt only — kept the dependency surface smaller than @nestjs/passport; social login is not on the near-term roadmap.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Strongest security model with automatic theft detection. DB write overhead is acceptable.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important; the DB table is trivial to implement.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration, SMTP-based, works with Mailpit for local dev.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — Documented NestJS approach, decorator-based, aligns with TypeORM entities.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Machine-readable error codes, `{ statusCode, error, message }` format with domain codes.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS guard integration, module-level `APP_GUARD`, in-memory storage sufficient.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** JWT for refresh tokens (diverged from opaque recommendation) — reuses access-token signing/verification infrastructure.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A (`[a-z0-9_]` + `user_<random>` fallback) — strict allowlist, no extra dependencies, `user_<random>` fallback for extreme prefixes.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** @nestjs/swagger — official NestJS integration, decorator-based, generates OpenAPI 3.x spec from code. Phase 03 endpoints must use `@ApiTags()`, `@ApiOperation()`, `@ApiResponse()`, and DTO decorators for video resources.

**Libraries:** `@nestjs/swagger@^11.x`

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
| Telas de cadastro, login, confirmação de conta e recuperação de senha | phase-02-auth | deferred | `next-frontend/` was not initialized in phase 02; UI surfaces start in a later phase. |

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
