---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-17T22:58:36"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-17T22:58:21"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-13T12:26:58"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload funcional de vídeos de até 10GB via presigned multipart upload direto ao MinIO/S3, processamento automático em segundo plano (extração de duração, metadados e geração de thumbnail via FFmpeg em worker dedicado), streaming e download via presigned URLs, e URLs únicas por vídeo — tudo orquestrado pelo backend NestJS com BullMQ/Redis como fila e infraestrutura completa em Docker Compose.

---

## Step Implementations

<!-- SIs will be written in Phase B -->

---

## Technical Specifications

> **Naming convention:** entity properties, columns and HTTP request/response fields use `snake_case`, matching the existing code (`Channel.user_id`, `created_at`; `RefreshTokenDto.refresh_token`, `ResetPasswordDto.new_password`).

### Data Model

#### Video

Table `videos`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(12) | unique, not null — 12-char base64url identifier generated with `node:crypto` (`randomBytes(9).toString('base64url')`); regenerate-and-retry on unique violation *(per `phase-03-videos/TD-06`)* |
| channel_id | uuid | FK → `channels(id)`, not null — owner of the video |
| title | varchar(255) | not null — initialized at upload initiation from `file_name` without its extension (truncated to 255); editable in Phase 04 |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` *(per `phase-03-videos/TD-08`)* |
| mime_type | varchar(100) | not null — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` *(per `phase-03-videos/TD-05` revision)* |
| size_in_bytes | bigint | not null — declared at initiation (≤ 10 GiB); mapped to `number` with a column transformer because `pg` returns `bigint` as string (10 GiB < 2^53) *(per `phase-03-videos/TD-05` revision)* |
| storage_key | varchar(500) | not null — `videos/{id}/original.{ext}`, `{id}` = this UUID, `{ext}` from `mime_type` (`mp4`, `webm`, `mov`, `mkv`) *(per `phase-03-videos/TD-09` + revision)* |
| upload_id | varchar(500) | nullable — S3 multipart upload ID while `draft`; set to null when the upload is completed *(per `phase-03-videos/TD-05`)* |
| duration_seconds | numeric(10,3) | nullable — from `ffprobe` `format.duration`; mapped to `number` with a column transformer *(per `phase-03-videos/TD-04`)* |
| metadata | jsonb | nullable — technical metadata from `ffprobe`: `{ width, height, video_codec, audio_codec, bit_rate, format_name }` (fields absent from the probe are `null`) *(capability "extração de duração e metadados"; `phase-03-videos/TD-04`)* |
| thumbnail_key | varchar(500) | nullable — `videos/{id}/thumbnail.jpg` once generated *(per `phase-03-videos/TD-09`)* |
| error_message | text | nullable — set only when the final processing attempt fails *(per `phase-03-videos/TD-08` revision)* |
| created_at | timestamp | `@CreateDateColumn` |
| updated_at | timestamp | `@UpdateDateColumn` |

**Relations:** `Video` many-to-one `Channel` (`@JoinColumn({ name: 'channel_id' })`); `Channel` one-to-many `Video`.
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status`.

**Status transitions** *(per `phase-03-videos/TD-08` + revision)*:

| From | To | Trigger |
|------|----|---------|
| — | `draft` | `POST /videos` (upload initiated) |
| `draft` | `processing` | `POST /videos/:videoId/upload/complete` succeeds and the job is enqueued |
| `processing` | `ready` | worker finishes metadata + thumbnail |
| `processing` | `failed` | final processing attempt fails (`error_message` stored) |
| `draft` | _(row deleted)_ | upload aborted (`DELETE /videos/:videoId/upload`) or completed object fails the size check (`SIZE_MISMATCH`) |

### API Contracts

Owner-side upload endpoints address the video by its internal `id` (UUID); public read endpoints address it by `public_id`. All upload endpoints require a valid access token (global `JwtAuthGuard`).

#### POST /videos

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- file_name: string, required — original file name; used to initialize `title`
- mime_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` *(per `phase-03-videos/TD-05` revision)*
- size_in_bytes: integer, required — declared file size, 1 … 10737418240 (10 GiB) *(per `phase-03-videos/TD-05` revision)*

**Response 201:**
- id: string (uuid)
- public_id: string (12 chars)
- status: "draft"
- upload_id: string — S3 multipart upload ID
- part_size: number — 104857600 (100 MiB) *(per `phase-03-videos/TD-05` revision)*
- total_parts: number — `ceil(size_in_bytes / part_size)`
- part_urls: `{ part_number: number, url: string }[]` — presigned `UploadPart` URLs for every part, signed against `S3_PUBLIC_ENDPOINT` *(per `phase-03-videos/TD-02` revision)*, expiring after 1 hour *(per `phase-03-videos/TD-05` revision)*

**Error responses:**
- 400 VALIDATION_ERROR: missing fields, unsupported `mime_type`, or `size_in_bytes` out of range
- 401: missing or invalid access token

---

#### POST /videos/:videoId/upload/part-urls

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- part_numbers: integer[], required — 1 … `total_parts`, no duplicates

**Response 200:**
- part_urls: `{ part_number: number, url: string }[]` — fresh presigned URLs, signed against `S3_PUBLIC_ENDPOINT`, expiring after 1 hour *(per `phase-03-videos/TD-05` revision)*

**Error responses:**
- 400 VALIDATION_ERROR: empty list, non-integer or out-of-range part numbers
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: caller is not the owner of the video's channel
- 404 VIDEO_NOT_FOUND: no video with this id
- 409 VIDEO_NOT_IN_DRAFT: the video is no longer `draft`

---

#### POST /videos/:videoId/upload/complete

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: `{ part_number: integer, etag: string }[]`, required — the `ETag` returned by storage for each part *(readable by the client because CORS exposes `ETag`, per `phase-03-videos/TD-02` revision)*

**Behavior:**
1. Calls `CompleteMultipartUpload`. If the part list does not contain exactly `total_parts` entries, or storage rejects it (`InvalidPart` / `InvalidPartOrder`), responds `UPLOAD_INCOMPLETE` and the video stays `draft` (the multipart upload is still open; the client may retry).
2. Reads the stored size with `HeadObject`. If `ContentLength` differs from the declared `size_in_bytes`, deletes the object, deletes the video row and responds `SIZE_MISMATCH` *(per `phase-03-videos/TD-05` revision — declared size is ≤ 10 GiB, so this also enforces the limit)*.
3. Otherwise sets `upload_id = null`, `status = processing` and enqueues the `video-processing` job (see Events/Messages) after the status update is committed.

**Response 200:**
- id: string (uuid)
- public_id: string (12 chars)
- status: "processing"

**Error responses:**
- 400 VALIDATION_ERROR: malformed `parts`
- 400 UPLOAD_INCOMPLETE: wrong number of parts or storage rejected the part list
- 400 SIZE_MISMATCH: stored object size differs from the declared size
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: caller is not the owner
- 404 VIDEO_NOT_FOUND: no video with this id
- 409 VIDEO_NOT_IN_DRAFT: the video is no longer `draft` (e.g., completed twice)

---

#### DELETE /videos/:videoId/upload

**Request headers:**
- Authorization: Bearer {access_token}

**Behavior:** calls `AbortMultipartUpload` and deletes the draft video row *(per `phase-03-videos/TD-05` revision; automatic cleanup of abandoned drafts is out of scope per `phase-03-videos/TD-08` revision)*.

**Response 204:** no body.

**Error responses:**
- 401: missing or invalid access token
- 403 VIDEO_ACCESS_DENIED: caller is not the owner
- 404 VIDEO_NOT_FOUND: no video with this id
- 409 VIDEO_NOT_IN_DRAFT: the video is no longer `draft`

---

#### GET /videos/:publicId

**Request headers:**
- Authorization: Bearer {access_token} — optional (see Authorization Matrix → optional authentication)

**Response 200:**
- id: string (uuid)
- public_id: string (12 chars)
- channel_id: string (uuid)
- title: string
- status: `draft` | `processing` | `ready` | `failed`
- mime_type: string
- size_in_bytes: number
- duration_seconds: number | null
- metadata: `{ width, height, video_codec, audio_codec, bit_rate, format_name }` | null
- thumbnail_url: string | null — presigned GET URL (signed against `S3_PUBLIC_ENDPOINT`) when `thumbnail_key` is set
- error_message: string | null — returned to the owner only
- created_at: string (ISO-8601)

**Error responses:**
- 401: an `Authorization` header is present but the token is invalid or expired
- 404 VIDEO_NOT_FOUND: no video with this `public_id`, or caller is not the owner and the video is not `ready` *(per `phase-03-videos/TD-07` revision — existence not disclosed)*

---

#### GET /videos/:publicId/stream

**Request headers:**
- Authorization: Bearer {access_token} — optional
- (the redirected request to storage may carry `Range`)

**Response 302:** `Location` = presigned GET URL for `storage_key`, signed against `S3_PUBLIC_ENDPOINT`, TTL from configuration (default 4 hours) *(per `phase-03-videos/TD-07` revision)*. Storage answers `Range` requests with `206 Partial Content` *(per `phase-03-videos/TD-07`)*.

**Error responses:**
- 401: an `Authorization` header is present but the token is invalid or expired
- 404 VIDEO_NOT_FOUND: same rule as `GET /videos/:publicId`
- 409 VIDEO_NOT_UPLOADED: owner request for a `draft` video (the original object does not exist yet)

---

#### GET /videos/:publicId/download

**Request headers:**
- Authorization: Bearer {access_token} — optional

**Response 302:** `Location` = presigned GET URL for `storage_key` with `ResponseContentDisposition: attachment; filename="{public_id}.{ext}"`, signed against `S3_PUBLIC_ENDPOINT`, same TTL as streaming *(per `phase-03-videos/TD-07` revision)*.

**Error responses:**
- 401: an `Authorization` header is present but the token is invalid or expired
- 404 VIDEO_NOT_FOUND: same rule as `GET /videos/:publicId`
- 409 VIDEO_NOT_UPLOADED: owner request for a `draft` video

#### Validation Rules

- `file_name`: required, non-empty string, max 255 characters
- `mime_type`: required, one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- `size_in_bytes`: required, integer, min 1, max 10737418240
- `part_numbers`: required, non-empty array of unique integers ≥ 1 (upper bound `total_parts` checked in the service)
- `parts`: required, non-empty array of `{ part_number: integer ≥ 1, etag: non-empty string }`
- `:videoId`: UUID (`ParseUUIDPipe`); `:publicId`: exactly 12 characters from `[A-Za-z0-9_-]`

### Authorization Matrix

| Endpoint | Anonymous | Authenticated, not owner | Channel owner |
|----------|-----------|--------------------------|---------------|
| POST /videos | ✗ 401 | ✓ creates the video in the caller's own channel | ✓ |
| POST /videos/:videoId/upload/part-urls | ✗ 401 | ✗ 403 | ✓ (`draft` only, else 409) |
| POST /videos/:videoId/upload/complete | ✗ 401 | ✗ 403 | ✓ (`draft` only, else 409) |
| DELETE /videos/:videoId/upload | ✗ 401 | ✗ 403 | ✓ (`draft` only, else 409) |
| GET /videos/:publicId | ✓ `ready` only (else 404) | ✓ `ready` only (else 404) | ✓ any status |
| GET /videos/:publicId/stream | ✓ `ready` only (else 404) | ✓ `ready` only (else 404) | ✓ `processing`/`ready`/`failed`; `draft` → 409 |
| GET /videos/:publicId/download | ✓ `ready` only (else 404) | ✓ `ready` only (else 404) | ✓ `processing`/`ready`/`failed`; `draft` → 409 |

*(per `phase-03-videos/TD-07` revision — owner in any status; others only `ready`; non-owner request for a non-`ready` video returns 404)*

**Ownership:** the caller owns a video when `video.channel_id` equals the id of the channel whose `user_id` is the token's `sub`. The channel lookup belongs to `ChannelsModule` (inherited Single Responsibility principle) — `VideosService` consumes it, it does not query `channels` directly.

**Optional authentication (public read endpoints):** the three `GET` endpoints must be reachable anonymously but still recognize the owner. Today `JwtAuthGuard` returns `true` on `@Public()` routes without reading the token, so `request.user` is never set there. The global guard is extended (it stays global — `nestjs-controllers.md`) with an optional-auth marker: on such routes, no `Authorization` header → anonymous; a valid Bearer token → `request.user` is populated; an invalid or expired token → 401, so clients refresh instead of silently losing owner access.

### Error Catalog

New domain exceptions extend `DomainException` (`src/common/exceptions/domain.exception.ts`) and are rendered by `DomainExceptionFilter` with the Phase 02 envelope `{ statusCode, error, message }` *(per `phase-02-auth/TD-07`)*.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | No video with the given `id`/`public_id`, or a non-owner requests a non-`ready` video *(per `phase-03-videos/TD-07` revision)* |
| VIDEO_ACCESS_DENIED | 403 | Authenticated caller is not the owner on an owner-only upload endpoint |
| VIDEO_NOT_IN_DRAFT | 409 | Upload operation (part URLs, complete, abort) on a video that is no longer `draft` |
| VIDEO_NOT_UPLOADED | 409 | Owner requests stream/download of a `draft` video (original object not stored yet) |
| UPLOAD_INCOMPLETE | 400 | `parts` count differs from `total_parts`, or storage rejects `CompleteMultipartUpload` (`InvalidPart`/`InvalidPartOrder`) |
| SIZE_MISMATCH | 400 | Stored object size (`HeadObject` `ContentLength`) differs from the declared `size_in_bytes` *(per `phase-03-videos/TD-05` revision)* |
| VALIDATION_ERROR | 400 | Request fails `class-validator` rules — `ValidationExceptionFilter` *(inherited, `phase-02-auth/TD-06`)* |

Missing/invalid tokens keep the existing behavior: `JwtAuthGuard` throws Nest's `UnauthorizedException` (401) *(inherited, `phase-02-auth/TD-02`)*.

### Events/Messages

#### video-processing (BullMQ queue, job name `process-video`)

**Payload:**

```json
{
  "video_id": "uuid",
  "storage_key": "videos/{video_id}/original.{ext}"
}
```

**Producer:** `VideosService`, on successful `POST /videos/:videoId/upload/complete`, after the `processing` status is committed *(per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`)*
**Consumer:** `VideoProcessor` (`@Processor('video-processing')`), registered only in the `video-worker` entrypoint — the API process does not register it *(per `phase-03-videos/TD-04`)*
**Job options:** `jobId` = `video_id` (duplicate enqueue is a no-op); `attempts: 3`; `backoff: { type: 'exponential', delay: 5000 }`; `removeOnComplete: true`; failed jobs are kept for inspection *(per `phase-03-videos/TD-08` revision)*
**Delivery semantics:** at-least-once — the processor is idempotent: if the video is not `processing` when the job starts, it finishes without changes.

**Processing steps (worker):**
1. Load the video; skip if its status is not `processing`.
2. Generate a presigned GET URL for `storage_key` signed against the **internal** endpoint `S3_ENDPOINT` (the worker runs inside the Compose network; the public endpoint is only for clients) *(per `phase-03-videos/TD-02` revision, `phase-03-videos/TD-04`)*.
3. `ffprobe -v error -print_format json -show_format -show_streams {url}` → `duration_seconds` from `format.duration`; `metadata` from the first video stream (`width`, `height`, `codec_name` → `video_codec`), the first audio stream (`codec_name` → `audio_codec`) and `format` (`bit_rate`, `format_name`) *(per `phase-03-videos/TD-04`)*.
4. Thumbnail time = `duration_seconds × 0.1`; `0` when the duration is unknown or under 1 second *(per `phase-03-videos/TD-04` revision)*.
5. `ffmpeg -v error -ss {time} -i {url} -frames:v 1 -f image2pipe -c:v mjpeg pipe:1` → JPEG bytes on stdout.
6. `PutObject` to `videos/{video_id}/thumbnail.jpg` with `ContentType: image/jpeg` *(per `phase-03-videos/TD-09`)*.
7. Update the video: `duration_seconds`, `metadata`, `thumbnail_key`, `status = ready`.
8. On a thrown error the job fails and BullMQ retries; when the failure is the final attempt (`attemptsMade >= attempts`), the worker sets `status = failed` and `error_message` *(per `phase-03-videos/TD-08` revision)*. Errors are logged, never swallowed silently (`nestjs-services.md` → background tasks).

---

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
