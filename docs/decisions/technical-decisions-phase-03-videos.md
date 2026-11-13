---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-12
scope_description: "Technical decisions for video upload, background processing, object storage integration, streaming/download, unique URL generation, and video status lifecycle — the core engineering challenges of Phase 03."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend API: video module (entity, controller, service, repository), storage service (S3/MinIO client), queue producer, upload endpoint (presigned URL generation), streaming/download endpoints, video processing worker (FFmpeg), compose infrastructure (MinIO, Redis/queue backend, worker service), migrations, config files, and tests.
- `next-frontend/` — **no open decision in this document.** Phase 03 is explicitly a backend-only deliverable per `objetivo_desafio.md`: "Este é um desafio de backend: a entrega é a API, o worker, a infraestrutura e os artefatos do processo." The frontend video interface is deferred to future phases. No frontend TD in this document.

---

## TD-01: Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram marks the message queue as "TBD" — this is the primary open stack decision for Phase 03. After a video is uploaded to object storage, a job must be enqueued for background processing (metadata extraction, thumbnail generation). The queue must support: job persistence (no loss on crash), retry with backoff on failure, job status tracking, and a dead-letter mechanism for permanently failed jobs. The project already runs PostgreSQL 17 and has no Redis in the stack.

**Options:**

### Option A: BullMQ 6 with PostgreSQL backend + @nestjs/bullmq

BullMQ v6 (released mid-2026) introduced pluggable backends, including `createPostgresBackend` — same `Queue`/`Worker`/`QueueEvents` API but backed by PostgreSQL instead of Redis. `@nestjs/bullmq` supports this via the `backendFactory` option at root or queue level. The project's existing `pg` package is the only runtime dependency needed.

- **Pros:** No new infrastructure — uses the existing PostgreSQL 17 already in the stack. No Redis to add to `compose.yaml`, monitor, or manage. First-class NestJS integration via `@nestjs/bullmq` (`BullModule.forRoot()`, `@Processor()` decorator, `@InjectQueue()` DI). Same BullMQ API as the Redis variant — all documentation, patterns, and community examples apply. Features: priorities, delayed jobs, retries with backoff, job events, rate limiting, repeatable jobs. The `@nestjs/bullmq` `backendFactory` propagates automatically to Queue, Worker, QueueEvents, and `@Processor()` hosts. Benchmark: ~7,000 jobs/s on PostgreSQL (more than sufficient for a video processing queue where jobs take minutes).
- **Cons:** BullMQ PostgreSQL backend is newer (mid-2026) — less battle-tested than the Redis backend. PostgreSQL handles both application queries AND job queue load on the same instance (mitigated: video processing throughput is low — tens to hundreds of jobs/day, not thousands/second). BullMQ v6 requires `bullmq` v6+; must verify `@nestjs/bullmq` peerDependency compatibility (current `@nestjs/bullmq` supports `^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0`). The Postgres backend option is less documented than the Redis path in community tutorials.

### Option B: BullMQ with Redis + @nestjs/bullmq

Classic BullMQ backed by Redis. Add Redis as a new service in `compose.yaml`. `@nestjs/bullmq` with standard `connection: { host: 'redis', port: 6379 }` configuration.

- **Pros:** Most battle-tested Node.js queue. ~27,000 jobs/s on Redis. Massive community and ecosystem (dashboards like Bull Board, Arena). Full NestJS integration via `@nestjs/bullmq`. Isolates queue load from the application database. Extensive documentation and tutorials.
- **Cons:** Adds Redis as new infrastructure — one more service in `compose.yaml` to configure, monitor, and maintain. Redis is a single point of failure unless clustered (overkill for this project). Memory-based by default — requires `appendonly: yes` for persistence on restart. Cannot transactionally enqueue a job with a database write (separate systems). For a video platform with low job throughput (10GB uploads are infrequent), Redis's raw throughput advantage is irrelevant.

### Option C: pg-boss (PostgreSQL-native queue)

Dedicated PostgreSQL-based job queue library. Uses `SKIP LOCKED` for safe concurrent fetching. Stores jobs, state, retry config, and dead letters entirely in PostgreSQL tables managed by pg-boss. Has a NestJS community integration (`@wavezync/nestjs-pgboss`).

- **Pros:** No Redis — same PostgreSQL benefit as Option A. ACID guarantees — can enqueue a job in the same transaction as a DB write (e.g., create video row + enqueue processing in one transaction). Built-in queue policies (singleton, stately, exclusive), dead-letter queues, heartbeat monitoring. Benchmark: ~29,000 jobs/s with batching — faster than BullMQ on Redis in some configurations. Mature library (~5 years, actively maintained).
- **Cons:** NestJS integration is via a community package (`@wavezync/nestjs-pgboss`) with low adoption (~21 code snippets, small user base) — not official NestJS support. Different API from BullMQ — team must learn pg-boss idioms. No `@Processor()` decorator pattern — job handlers must be wired manually or through the community wrapper. Smaller ecosystem (no Bull Board equivalent for monitoring). If the project later needs Redis-backed queues (e.g., for real-time features), a second queue system would need to be introduced.

**Recommendation:** **Option B (BullMQ with Redis)** — _Revised during review (2026-11-12): the research draft recommended Option A; changed to Option B for the reasons below._ BullMQ on Redis is the most battle-tested Node.js queue, with first-class NestJS integration via `@nestjs/bullmq` (`BullModule.forRoot()`, `@Processor()`, `@InjectQueue()`) and the broadest official documentation. Redis runs as a dedicated `redis` service in `compose.yaml` (with `appendonly yes` so queued jobs survive a container restart), which makes the queue an explicit infrastructure component — the Phase 03 acceptance criteria require object storage, queue and worker to come up via Docker Compose alongside the backend. Option A was set aside because the BullMQ 6 PostgreSQL backend is very recent (`bullmq` 6.0.0 published on npm on 2026-07-30), its `@nestjs/bullmq` `backendFactory` integration could not be confirmed in official documentation, and it would leave no dedicated queue service in Compose. Option C's NestJS integration is a low-adoption community package.

**Decision:** B (BullMQ + Redis)

---

## TD-02: Upload Strategy for Large Files (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The project requires uploading files up to 10GB "without blocking the system." Passing a 10GB file through the NestJS API (multipart upload via Express/Multer) would saturate the API server's memory and event loop for the duration of the transfer — effectively DoS-ing the API for other users. The architecture must offload the actual file transfer away from the API process. The project uses S3-compatible storage (MinIO in dev, S3 in production).

**Options:**

### Option A: Presigned URL — direct browser-to-storage upload via S3 presigned PUT

The API generates a presigned PUT URL (using `@aws-sdk/s3-request-presigner` + `PutObjectCommand`) with a time-limited signature. The client uploads the file directly to MinIO/S3 using this URL — the file never touches the NestJS process. Flow: (1) client calls `POST /videos/upload-url` with filename and content type; (2) API creates a draft video record, generates a presigned PUT URL, returns both; (3) client PUTs the file directly to storage; (4) client calls `POST /videos/:id/complete-upload` to signal completion; (5) API enqueues processing job.

- **Pros:** Zero API load during the actual file transfer — the 10GB stream goes directly from client to MinIO/S3, not through NestJS. Scales naturally: adding users doesn't increase API memory/CPU. Simple implementation — `@aws-sdk/s3-request-presigner` + `getSignedUrl()` is ~10 lines. S3 PUT supports up to 5GB per single request; for files >5GB, S3 multipart presigned upload extends to 5TB. MinIO fully supports presigned URLs with the same S3 API. The API only handles lightweight JSON requests (URL generation, completion notification).
- **Cons:** Single PUT presigned URL has a 5GB limit — files >5GB require the S3 multipart upload flow (CreateMultipartUpload → presigned URL per part → CompleteMultipartUpload), which adds client-side complexity. No built-in resumability — a network interruption restarts the upload (or the failed part in multipart). Client must be aware of the two-step flow (get URL, then upload). Upload progress tracking requires client-side implementation. CORS configuration needed on MinIO/S3 for browser-to-storage direct access.

### Option B: tus protocol — resumable upload via tus-node-server with S3 store

Deploy `@tus/server` as middleware (or a sidecar) with `@tus/s3-store` for storage. The tus protocol provides built-in chunked, resumable uploads: if the connection drops, the client resumes from the last byte. The client uses `tus-js-client`. Flow: (1) client sends `POST /uploads` (tus creation); (2) client sends `PATCH /uploads/:id` chunks; (3) on completion, tus-node-server signals the API via a hook; (4) API enqueues processing.

- **Pros:** True resumability — a laptop closing mid-upload resumes exactly where it left off. Open protocol with multiple client implementations (browser, mobile, CLI). Handles chunking, offset tracking, and retries transparently. `@tus/s3-store` writes directly to S3/MinIO. No 5GB single-PUT limit — chunks are configurable.
- **Cons:** Adds a new server component (tus-node-server) or middleware that must be deployed, scaled, and monitored. The tus server is stateful — it tracks upload offsets, requiring either persistence or the S3 store adapter to reconstruct state. More complex infrastructure: a new service in `compose.yaml`, or embedded as Express middleware competing for the NestJS event loop. The tus protocol is not natively supported by S3/MinIO — the tus server acts as a proxy, which means the file MAY pass through the tus server's memory/disk before reaching storage (depends on store adapter implementation). Adds dependencies: `@tus/server`, `@tus/s3-store`, and client-side `tus-js-client`. Overkill for a project where the primary consumer is a first-party frontend that can implement S3 multipart upload directly.

### Option C: API-proxied multipart upload (Multer/Busboy through NestJS)

Standard Express/NestJS file upload: client sends the file as `multipart/form-data` to a NestJS endpoint. The API receives the stream via Multer, pipes it to S3 using `@aws-sdk/lib-storage` `Upload` class (handles S3 multipart internally).

- **Pros:** Simplest client-side implementation — standard HTML form or `fetch` with `FormData`. Single endpoint, single request. Server controls the entire upload pipeline.
- **Cons:** **The 10GB file passes through the NestJS process.** Even with streaming (Multer → pipe → S3), the API holds the connection for the entire transfer duration (minutes to hours for 10GB on typical connections). Express's default body parser limits and Multer's memory/disk modes add complexity. The API's event loop is occupied serving one large upload, degrading response times for all other users. This is explicitly the wrong approach per `objetivo_desafio.md`: "Upload de 10GB é decisão de arquitetura, não de força bruta. Pesquise a estratégia certa antes de codar; passar o arquivo inteiro pela API é o caminho errado." **Disqualified.**

**Recommendation:** **Option A (Presigned URL — direct browser-to-storage)** — The API generates lightweight presigned URLs; the actual 10GB transfer goes directly from the client to MinIO/S3, leaving the NestJS process completely unloaded. For files >5GB, the API orchestrates the S3 multipart upload flow (generate upload ID + presigned URLs per part), and the client uploads parts in parallel directly to storage. This is the standard pattern used by YouTube, Vimeo, and every production video platform. Option B (tus) adds infrastructure complexity that is not justified when the storage already supports resumable multipart uploads natively. Option C is explicitly disqualified by the project requirements.

**Decision:** A (Presigned URL — direct client-to-storage upload)

---

## TD-03: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project needs an S3-compatible client to interact with MinIO (dev) and S3 (production) for: generating presigned URLs (TD-02), uploading thumbnails from the worker, reading/streaming video files, and managing buckets/objects. The choice must be MinIO-compatible and work with Node.js/TypeScript.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`)

Official AWS SDK for JavaScript v3. Modular — import only the clients and commands needed. `@aws-sdk/client-s3` for CRUD, `@aws-sdk/s3-request-presigner` for presigned URLs, `@aws-sdk/lib-storage` for managed multipart uploads. MinIO is fully compatible (configure `endpoint` + `forcePathStyle`).

- **Pros:** Official AWS package — highest adoption (~18M weekly DLs for client-s3), guaranteed S3 API coverage, and long-term maintenance. TypeScript-first with full type definitions. Modular tree-shaking. MinIO compatibility is documented and widely used. Presigned URL generation via `getSignedUrl()` is battle-tested. `Upload` class from `@aws-sdk/lib-storage` handles multipart upload with progress events. Full coverage of S3 API operations (HeadObject, GetObject, DeleteObject, CreateMultipartUpload, etc.).
- **Cons:** Multiple packages to install (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`). Larger bundle size than lightweight alternatives (~2MB total installed). SDK verbosity — command pattern (`new PutObjectCommand({...})` + `client.send()`) is more verbose than method-style APIs.

### Option B: MinIO JavaScript Client (`minio`)

Official MinIO client library. Method-based API (`minioClient.putObject()`, `minioClient.presignedPutObject()`). Designed for S3-compatible storage.

- **Pros:** Simpler API — `minioClient.presignedPutObject(bucket, key, expiry)` is one call. Single package. Designed specifically for MinIO with first-class support.
- **Cons:** Less commonly used with production AWS S3 — some S3-specific features (Transfer Acceleration, S3 Select, Object Lock) are not supported. Smaller community and fewer Stack Overflow examples. The project may deploy to AWS S3 in production, where `@aws-sdk/client-s3` is the canonical choice. TypeScript types are less comprehensive than AWS SDK v3.

### Option C: s3-lite-client

Lightweight, zero-dependency S3 client for JavaScript runtimes. ~78KB. Supports basic operations (put, get, delete, presigned URLs).

- **Pros:** Smallest footprint (~78KB). Zero dependencies. Clean API.
- **Cons:** Limited feature set — no managed multipart upload, no S3 Transfer Acceleration, no comprehensive error handling for edge cases. Low adoption (~232 code snippets). For a video platform handling 10GB files with multipart uploads, feature completeness matters more than bundle size.

**Recommendation:** **Option A (AWS SDK v3)** — The project runs MinIO in dev and targets S3 in production. AWS SDK v3 is the canonical S3 client, with the broadest documentation, TypeScript support, and feature coverage, and is MinIO-compatible via `endpoint` + `forcePathStyle`. Only two packages are adopted: `@aws-sdk/client-s3` (multipart commands `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` / `AbortMultipartUpload`, plus `HeadObject`, `PutObject`, `GetObject`) and `@aws-sdk/s3-request-presigner` (`getSignedUrl()` for part uploads, streaming and download). _Adjusted during review (2026-11-12):_ `@aws-sdk/lib-storage` is not adopted — the client uploads multipart parts directly through presigned URLs and the worker only writes a small thumbnail with `PutObjectCommand`, so a managed server-side upload helper has no use. Option B locks the project into a MinIO-specific client that may lack features when deploying to AWS. Option C lacks multipart upload support critical for 10GB files.

**Decision:** A (AWS SDK v3 — client-s3 + s3-request-presigner)

---

## TD-04: Video Processing — Worker Architecture and FFmpeg Integration

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** After upload, the video must be processed: extract duration and metadata (codec, resolution, bitrate), and generate a thumbnail image from a frame. The architecture diagram shows a "Video Worker (FFmpeg)" as a separate container consuming jobs from the queue. The decision is how the worker runs and how it invokes FFmpeg.

**Options:**

### Option A: In-process worker — NestJS `@Processor()` in the API process with `fluent-ffmpeg`

The video processing worker runs inside the NestJS API process. A `@Processor('video-processing')` class handles jobs using the `fluent-ffmpeg` Node.js library, which wraps the FFmpeg CLI. FFmpeg binary is installed in the API container's Docker image. The worker downloads the video from S3 to a temp directory, runs `ffprobe` for metadata and `ffmpeg` for thumbnail extraction, uploads results back to S3, and updates the DB.

- **Pros:** Simplest deployment — no additional container or service. Full NestJS DI access (repositories, config, services). `fluent-ffmpeg` provides a clean Node.js API over FFmpeg: `ffprobe()` for metadata, `.screenshots()` for thumbnails. Single codebase. Debugging is straightforward — same process, same logs. For Phase 03's scope (metadata + thumbnail only — no transcoding), the CPU load is minimal (ffprobe is nearly instant; one screenshot is <1s).
- **Cons:** FFmpeg binary must be in the API container image (~100MB+). Heavy processing (future transcoding) would block the API's event loop CPU time. Not horizontally scalable independently of the API. If the API restarts, in-flight processing jobs are interrupted (mitigated by BullMQ's job retry on worker disconnect).

### Option B: Separate worker container — dedicated Docker service consuming the same BullMQ queue

A separate Docker service (`video-worker`) in `compose.yaml` runs a minimal NestJS application (or plain Node.js script) that connects to the same BullMQ queue and processes jobs. The worker image includes FFmpeg. The API container stays lean (no FFmpeg).

- **Pros:** Clean separation of concerns — API serves HTTP, worker processes video. Worker can be scaled independently (multiple replicas). API container stays small. Worker crashes don't affect API availability. Aligns with the architecture diagram ("Video Worker" is a separate container). Future transcoding workloads are isolated.
- **Cons:** Additional Docker service to maintain, build, and configure. Shared code (entities, config, storage service) must be accessible from both API and worker — requires either a shared volume, a monorepo build that produces two images, or duplicated code. More complex compose.yaml. Debugging requires checking logs from multiple containers. For Phase 03's minimal processing (metadata + thumbnail), the overhead of a separate container is significant relative to the workload.

### Option C: Hybrid — in-process for Phase 03, extract to separate container later

Run the `@Processor()` in the API process for Phase 03 (where processing is lightweight: ffprobe + one screenshot). Document the architectural boundary so extraction to a separate container is straightforward when heavier processing (transcoding) is added in a future phase.

- **Pros:** Combines Option A's simplicity for the current scope with Option B's scalability path. No premature infrastructure complexity. The BullMQ `@Processor()` pattern is container-agnostic — the same processor class works in-process or in a separate NestJS app with zero code changes. Phase 03's processing load (ffprobe: ~1s, thumbnail: ~2s per video) does not justify a separate container.
- **Cons:** FFmpeg binary in the API image (~100MB). If future transcoding is added without extraction, the API suffers. Requires discipline to extract when the time comes.

**Recommendation:** **Option B (Separate worker container)** — _Revised during review (2026-11-12): the research draft recommended Option C; changed to Option B for the reasons below._ The worker runs as a dedicated `video-worker` service in `compose.yaml`, matching the architecture diagram (Video Worker as its own container) and the Phase 03 acceptance criteria, which require the worker to come up via Docker Compose alongside the backend. The shared-code concern is resolved without duplication: both services are built from the same `nestjs-project/` codebase, and the worker has its own entrypoint that boots a NestJS application context (no HTTP server) registering only what it needs — the `@Processor()` for the video-processing queue, the storage service and video persistence — while the API process does not register the processor. The image used by the worker includes the FFmpeg binaries (`ffmpeg`, `ffprobe`). FFmpeg is invoked directly through `node:child_process` (`spawn` of `ffprobe` to read duration and stream metadata as JSON, and of `ffmpeg` to extract a single frame as the JPEG thumbnail); `fluent-ffmpeg` is not used because the package is deprecated on npm ("Package no longer supported"). The worker reads the source video from storage through a presigned GET URL (FFmpeg reads HTTP inputs using range requests), avoiding a full local copy of files up to 10GB. Options A and C were set aside because they leave no worker service in Compose.

**Decision:** B (Separate worker container)

---

## TD-05: Upload Protocol — Simple Presigned PUT vs. S3 Multipart Upload

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** TD-02 decided the upload goes directly from client to storage via presigned URLs. This TD resolves the specific S3 upload mechanism. S3 presigned PUT has a hard 5GB limit per request. Files up to 10GB require the S3 multipart upload API. The question is whether the API should support both (simple PUT for small files, multipart for large) or use multipart universally.

**Options:**

### Option A: S3 Multipart Upload only (API-orchestrated, client-executed)

All uploads use the S3 multipart flow regardless of size: (1) API calls `CreateMultipartUpload`, returns `uploadId` + presigned URLs for each part; (2) client uploads parts in parallel directly to storage; (3) client reports ETags; (4) API calls `CompleteMultipartUpload`. Part size is fixed by the API (e.g., 100MB), and the number of parts is computed from the declared file size. The API stores `uploadId` in the video record for tracking.

- **Pros:** Single code path for all file sizes — no branching between PUT and multipart. Supports the full 0–10GB range without any 5GB ceiling. Parts can be uploaded in parallel, improving throughput on fast connections. Failed parts can be retried individually without restarting the entire upload. `AbortMultipartUpload` cleans up incomplete uploads. Future-proof for file sizes beyond 10GB.
- **Cons:** More complex API surface: the upload flow requires multiple endpoints (initiate, get part URLs, complete, abort). More complex client-side logic: the frontend must chunk the file, upload parts in parallel, collect ETags, and call complete. Overhead for small files (<100MB) where a single PUT would suffice. MinIO must be configured to allow multipart uploads (default: enabled).

### Option B: Simple presigned PUT for files ≤5GB, multipart for files >5GB

Two code paths: (1) for files ≤5GB, the API generates a single presigned PUT URL; (2) for files >5GB, the API initiates multipart upload with presigned part URLs. The API decides the path based on the declared file size.

- **Pros:** Simpler client flow for the common case (most videos are <5GB). Single PUT is the simplest possible upload — one URL, one request.
- **Cons:** Two code paths to implement, test, and maintain on both API and client. The boundary (5GB) is an S3 implementation detail leaking into the API contract. Client must implement both flows. Edge case: user declares ≤5GB but the file is actually larger → upload fails.

### Option C: Multipart with a high threshold — use PUT for ≤5GB, multipart above

Same as Option B but with cleaner API abstraction: the API always returns a uniform response, but internally chooses PUT vs multipart.

- **Pros:** Client always sees the same API surface. API hides the S3 mechanism.
- **Cons:** Still two code paths on the backend. Client-side must still handle both response shapes (single URL vs. multiple part URLs) — unless the API normalizes the response to always return an array of part URLs (even if just one for small files), which essentially converges back to Option A.

**Recommendation:** **Option A (Multipart only)** — A single, universal code path eliminates branching and ensures 10GB support from day one. The multipart flow with parallel part uploads is strictly superior in throughput and resilience for any file over ~100MB, which is the typical video file range. The client-side complexity is bounded and well-documented (S3 multipart presigned is a standard pattern). Option B's dual path adds maintenance cost for a marginal simplicity win on small files that is rarely exercised (video files are typically >100MB).

**Decision:** A (S3 Multipart Upload only)

---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique, URL-safe identifier that appears in the public video URL (e.g., `/watch/:videoId`). This identifier must be: unique (no collision), URL-safe (no encoding needed), opaque (not sequential — to prevent enumeration), and reasonably short for sharing. The database primary key (auto-increment or UUID) is separate from the public URL identifier.

**Options:**

### Option A: NanoID (21 characters, 126 bits entropy, URL-safe alphabet)

Generate a 21-character NanoID using `nanoid` package. Alphabet: `A-Za-z0-9_-` (64 characters). Store in a `unique_id` column (unique index). Example: `V1StGXR8_Z5jdHi6B-myT`.

- **Pros:** URL-safe by default — no percent-encoding needed. 126 bits of entropy with 21 chars (vs UUID's 122 bits in 36 chars). Short enough for sharing. ~2,400,000 ops/s generation speed. Cryptographically secure (`crypto.getRandomValues`). Zero configuration — `nanoid()` returns a ready-to-use ID. Widely used for URL identifiers (YouTube-like use case). Tiny dependency (~130 bytes).
- **Cons:** No timestamp component — cannot sort by creation time from the ID alone (not needed: `created_at` column exists). Collision probability is astronomically low but non-zero (mitigated by unique DB constraint + retry on insert). No built-in structure (purely random).

### Option B: CUID2 (24 characters, anti-collision guarantees)

Generate a 24-character CUID2 using `@paralleldrive/cuid2`. Lowercase characters only. Designed for distributed environments with anti-collision mechanisms.

- **Pros:** Stronger anti-collision guarantees than pure random — embeds host fingerprint and counter. Lowercase only — case-insensitive URL safety. Designed for database primary keys in distributed systems.
- **Cons:** Longer than NanoID (24 vs 21 chars). Slower generation (~950K ops/s vs ~2.4M). Lowercase-only may look less "clean" in URLs than mixed-case. The anti-collision mechanisms (host fingerprint, counter) add complexity that is unnecessary when using a single database with a unique constraint.

### Option C: UUID v4 (36 characters, standard format)

Standard UUID v4 via `crypto.randomUUID()`. No external dependency. Format: `550e8400-e29b-41d4-a716-446655440000`.

- **Pros:** Built-in to Node.js — zero dependency. Universally recognized format. 122 bits of entropy. Supported natively by PostgreSQL (`uuid` column type).
- **Cons:** 36 characters with hyphens — longest option, unwieldy in URLs. Hyphens require no encoding but make URLs verbose. Not designed for URL aesthetics. Hyphenated format looks "enterprise-y" rather than consumer-friendly for a video sharing platform.

**Recommendation:** **Option A (NanoID-format identifier)** — The use case is a YouTube-like URL identifier: short, URL-safe, shareable, non-sequential. _Adjusted during review (2026-11-12):_ the identifier uses the NanoID URL-safe alphabet (`A-Za-z0-9_-`) with a fixed length of **12 characters**, generated with Node's built-in `node:crypto` (`randomBytes(9).toString('base64url')`, 72 bits of entropy, no padding) instead of the `nanoid` package — current `nanoid` releases are ESM-only (`"type": "module"`), while the backend compiles to CommonJS and runs tests under ts-jest. This also removes a dependency. Uniqueness is guaranteed by a `UNIQUE` constraint on the column plus regenerate-and-retry on collision. YouTube uses an 11-character base64 identifier, so 12 characters keeps the same aesthetic. The internal primary key stays a UUID; the short ID is only the public URL identifier. CUID2's distributed anti-collision guarantees add unnecessary complexity for a single-Postgres deployment. UUID is too long for user-facing URLs.

**Decision:** A (NanoID-format 12-char ID generated with node:crypto)

---

## TD-07: Video Streaming Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** The video player in the browser requires streaming — the ability to start playback before the full file is downloaded, and to seek to arbitrary positions. The standard HTTP mechanism for this is Range Requests (RFC 7233): the client sends `Range: bytes=0-999999`, the server responds with `206 Partial Content` and the requested byte range. HTML5 `<video>` elements natively support this protocol. The question is where the range request is served from.

**Options:**

### Option A: Direct-from-storage via presigned GET URL

The API generates a time-limited presigned GET URL for the video file in MinIO/S3. The frontend's `<video src>` points directly to this URL. MinIO and S3 natively support `Range` headers on GET requests, returning `206 Partial Content` with the requested byte range. The API is not involved in the actual byte transfer.

- **Pros:** Zero API load during streaming — all byte transfer is between the browser and MinIO/S3. S3/MinIO natively handle `Range` requests, `206 Partial Content`, `Accept-Ranges: bytes`, and `Content-Range` headers — no implementation needed. Scales horizontally via storage layer (S3 scales to any number of concurrent readers). CDN-ready: in production, the presigned URL can point to a CloudFront distribution in front of S3. The API only generates the URL (one lightweight JSON call).
- **Cons:** Presigned URL has a time limit — if the user watches for longer than the expiry, the player may fail on seek. Mitigated by setting a generous expiry (e.g., 4-6 hours) or refreshing the URL client-side. MinIO must be accessible from the browser (CORS + network routing). The storage URL is temporarily exposed to the client (time-limited, scoped to one object). No server-side access logging through the API (storage logs serve this purpose).

### Option B: API-proxied streaming with Range support

The API serves a `GET /videos/:id/stream` endpoint that reads the `Range` header, fetches the corresponding byte range from S3 (`GetObjectCommand` with `Range` parameter), and pipes the response to the client with `206 Partial Content` headers.

- **Pros:** The storage URL is never exposed to the client — all access goes through the API. The API can enforce access control per-request (check auth, check video visibility). Single origin for the frontend — no CORS configuration for storage.
- **Cons:** **Every byte of video streaming passes through the NestJS process.** For a 10GB video with multiple concurrent viewers, the API becomes a bottleneck. The API holds open connections for the duration of playback/seeking. Defeats the purpose of offloading large transfers from the API (the same principle as TD-02). Adds latency (client → API → S3 → API → client vs. client → S3). For public/unlisted videos (the Phase 03 scope), access control at the API level adds cost without benefit.

### Option C: API-proxied streaming for private videos, presigned URL for public/unlisted

Hybrid: public and unlisted videos get presigned GET URLs (Option A). Private/restricted videos (future feature) get API-proxied streaming (Option B). Phase 03 only implements the presigned path.

- **Pros:** Correct access pattern per video visibility. API proxy only for the rare case that needs it.
- **Cons:** Two streaming paths to maintain. Phase 03 has no private videos (visibility is Phase 04). Over-engineering for the current scope. The "private video" case can be served by short-lived presigned URLs with a DB visibility check at URL generation time — no proxy needed.

**Recommendation:** **Option A (Direct-from-storage via presigned GET URL)** — Same architectural principle as TD-02: offload byte transfer from the API. S3/MinIO handle range requests natively, so HTTP streaming "just works" when the `<video>` element points at the presigned URL. Access control is enforced at URL generation time (API checks auth + video status before issuing the URL). For Phase 03, all videos are viewable (draft status videos are only viewable by the owner, enforced at the URL generation endpoint). Option B reintroduces the problem TD-02 solved (passing large files through the API). Option C is premature — Phase 04's visibility feature doesn't require a proxy; short-lived presigned URLs with DB checks suffice.

**Decision:** A (Direct-from-storage via presigned GET URL)

---

## TD-08: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** A video record goes through multiple states from upload initiation to playable state. The status model must support: pre-registration as draft, tracking upload completion, queuing for processing, processing success (metadata + thumbnail done), and processing failure with retry. The status transitions are driven by API calls and queue job outcomes.

**Options:**

### Option A: Linear state machine — `draft → uploading → processing → ready | failed`

Four primary states: (1) `draft` — created when upload is initiated, file not yet uploaded; (2) `uploading` — multipart upload in progress (parts being transferred); (3) `processing` — upload complete, job enqueued, worker processing; (4) `ready` — processing complete, video is playable; (5) `failed` — processing failed after all retries exhausted. Transitions are one-directional; `failed` can transition back to `processing` via manual retry.

- **Pros:** Clear, minimal state machine with well-defined transitions. Easy to query by status (`WHERE status = 'ready'` for public listing, `WHERE status = 'processing'` for dashboard). Status column is a simple `enum`. Maps directly to the user's mental model: "uploading → processing → ready." `failed` state enables UI feedback and manual retry.
- **Cons:** The `uploading` state requires the API to track multipart upload progress — adds complexity if the API only generates presigned URLs and doesn't observe the actual upload. Could be simplified by merging `draft` and `uploading` if the API doesn't distinguish between "upload initiated" and "upload in progress."

### Option B: Simplified — `draft → processing → ready | failed`

Three primary states: (1) `draft` — created at upload initiation; remains in `draft` until the client signals upload completion; (2) `processing` — client confirmed upload complete, job enqueued; (3) `ready` — processing done; (4) `failed` — processing failed. No `uploading` state — the API doesn't track upload progress (presigned URLs mean the upload happens outside the API's awareness).

- **Pros:** Simpler state machine — fewer transitions to manage. Aligned with the presigned URL model: the API doesn't observe the upload stream, so it cannot meaningfully distinguish "uploading" from "draft." Clear trigger for each transition: `draft → processing` is the explicit "complete upload" API call; `processing → ready/failed` is the job outcome. Easier to implement and test.
- **Cons:** No explicit "uploading" state for UI feedback — the client must track upload progress locally. If the user abandons the upload (closes tab mid-transfer), the video stays in `draft` indefinitely — requires a cleanup mechanism (TTL-based deletion of stale drafts).

### Option C: Extended — `draft → uploading → queued → processing → ready | failed`

Five states, splitting the queue-to-processing transition.

- **Pros:** Maximum granularity for dashboards and monitoring.
- **Cons:** Over-granular for Phase 03. `queued` vs `processing` distinction adds complexity with minimal UX benefit. BullMQ already tracks job states internally — duplicating queue state in the video status is redundant.

**Recommendation:** **Option B (Simplified — `draft → processing → ready | failed`)** — The presigned URL upload model (TD-02/TD-05) means the API has no visibility into upload progress — it only knows when the upload is initiated (draft created) and when the client confirms completion. An `uploading` state would require polling storage to verify progress, adding unnecessary complexity. Four states (including `failed`) are sufficient: `draft` covers the entire upload period, `processing` covers job execution, `ready` is the terminal success state, and `failed` enables retry. Stale drafts (abandoned uploads) can be cleaned by a periodic job that deletes `draft` videos older than a configurable TTL (e.g., 24h).

**Decision:** B (draft → processing → ready | failed)

---

## TD-09: Storage Key Organization (Bucket and Object Key Structure)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails must be stored in MinIO/S3 with a consistent, collision-free key structure. The key layout affects: listing objects per channel/video, generating presigned URLs, cleanup on video deletion, and future CDN caching. The project needs to store two types of objects per video: the original video file and the generated thumbnail.

**Options:**

### Option A: Single bucket, type-prefixed keys — `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg`

One bucket (e.g., `streamtube`). Objects keyed by video ID with type-separated paths: `videos/{videoId}/original.mp4`, `videos/{videoId}/thumbnail.jpg`. The video ID (NanoID from TD-06) is the directory separator.

- **Pros:** All objects for one video share a prefix — `ListObjects(prefix=videos/{videoId}/)` returns both the video and its thumbnail. Deletion is clean: delete by prefix removes all artifacts for a video. Single bucket simplifies CORS, IAM, and lifecycle rules. Key structure is self-documenting. Extension preserved from the original upload.
- **Cons:** Single bucket means shared access policies — cannot have different access rules for videos vs thumbnails without prefix-based IAM policies (which S3/MinIO supports). If the project grows to millions of videos, listing all objects under `videos/` is expensive (mitigated: `ListObjects` is always prefix-scoped in practice).

### Option B: Separate buckets — `streamtube-videos` and `streamtube-thumbnails`

Two buckets. Videos in one, thumbnails in the other. Keys: `{videoId}/original.{ext}` and `{videoId}/thumbnail.jpg` respectively.

- **Pros:** Clean access separation — thumbnails can be public (CDN-friendly), videos can require presigned URLs. Independent lifecycle policies (e.g., thumbnails cached indefinitely, video originals with different retention). IAM separation is natural (different bucket policies).
- **Cons:** Two buckets to create, configure, and manage in MinIO. CORS must be configured on both. Deletion requires operations on two buckets. More complex infrastructure setup in compose and environment config. For Phase 03, there is no difference in access policy between videos and thumbnails (both served via presigned URLs).

### Option C: Single bucket, flat keys — `{videoId}-video.{ext}` and `{videoId}-thumbnail.jpg`

One bucket, flat key structure without directory-like prefixes.

- **Pros:** Simplest possible keys.
- **Cons:** No prefix-based grouping — cannot list all objects for a video with a single prefix query. Deletion requires knowing all key patterns. Harder to extend with additional artifacts (e.g., transcoded versions).

**Recommendation:** **Option A (Single bucket, type-prefixed keys)** — Simplest infrastructure (one bucket) with clean logical grouping via prefix. `videos/{videoId}/` as a prefix enables listing and bulk-deleting all artifacts for a video. Phase 03 has no differentiated access policies between videos and thumbnails (both use presigned URLs), so separate buckets (Option B) add infrastructure cost without benefit. The prefix structure naturally extends for future artifacts (e.g., `videos/{videoId}/720p.mp4`, `videos/{videoId}/360p.mp4` for transcoded versions).

**Decision:** A (Single bucket, type-prefixed keys)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Job Queue Technology | BullMQ + Redis (revised on review; draft recommended BullMQ 6 + PostgreSQL backend) | B (BullMQ + Redis) |
| TD-02 | Backend | Upload Strategy for Large Files | Presigned URL — direct browser-to-storage | A (Presigned URL — direct client-to-storage upload) |
| TD-03 | Backend | S3 Client Library | AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`; no lib-storage) | A (AWS SDK v3 — client-s3 + s3-request-presigner) |
| TD-04 | Backend | Video Processing — Worker Architecture | Separate `video-worker` container, same codebase, FFmpeg via `child_process` (revised on review; draft recommended hybrid in-process) | B (Separate worker container) |
| TD-05 | Backend | Upload Protocol (PUT vs Multipart) | S3 Multipart Upload only | A (S3 Multipart Upload only) |
| TD-06 | Backend | Unique Video URL Identifier | NanoID-format 12-char URL-safe ID via `node:crypto` | A (NanoID-format 12-char ID generated with node:crypto) |
| TD-07 | Backend | Video Streaming Strategy | Direct-from-storage via presigned GET URL | A (Direct-from-storage via presigned GET URL) |
| TD-08 | Backend | Video Status Lifecycle | Simplified: `draft → processing → ready \| failed` | B (draft → processing → ready \| failed) |
| TD-09 | Backend | Storage Key Organization | Single bucket, type-prefixed keys | A (Single bucket, type-prefixed keys) |
