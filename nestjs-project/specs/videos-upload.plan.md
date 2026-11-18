---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos.e2e-spec.ts
---

# Upload Endpoints Test Plan

## Application Overview

The upload endpoints allow authenticated users to initiate multipart uploads to MinIO/S3, refresh presigned part URLs, complete uploads (triggering video processing), and abort in-progress uploads. The API never receives video bytes directly — parts are uploaded by the client straight to object storage via presigned URLs. All upload operations require a valid JWT and are restricted to the video's channel owner.

## Test Scenarios

### 1. Initiate Upload (POST /videos)

**Setup:** `cleanAllTables` (deletes `videos` before `channels`/`users`); register, confirm and log in a user (registration creates the channel) to obtain a valid access token — same pattern as `test/auth.e2e-spec.ts`. Use the fixture `test/fixtures/sample.mp4` as upload content.

#### 1.1. initiate-upload-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. POST /videos with valid body `{ file_name: "test.mp4", mime_type: "video/mp4", size_in_bytes: 10485760 }` and Bearer token
    - expect: 201
    - expect: response body has `id` (uuid), `public_id` (12 chars), `status: "draft"`, `upload_id` (string), `part_size: 104857600`, `total_parts` (integer), `part_urls` (array of `{ part_number, url }`)
    - expect: `part_urls` length equals `total_parts`

#### 1.2. initiate-upload-validation-error

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. POST /videos with missing `file_name` and Bearer token
    - expect: 400
    - expect: response body matches `{ statusCode: 400, error: "VALIDATION_ERROR", message: ... }`
  2. POST /videos with `mime_type: "text/plain"` and Bearer token
    - expect: 400
    - expect: response body `error: "VALIDATION_ERROR"`
  3. POST /videos with `size_in_bytes: 0` and Bearer token
    - expect: 400
  4. POST /videos with `size_in_bytes: 10737418241` (exceeds 10 GiB) and Bearer token
    - expect: 400

#### 1.3. initiate-upload-unauthorized

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. POST /videos with valid body but no Authorization header
    - expect: 401

### 2. Refresh Part URLs (POST /videos/:videoId/upload/part-urls)

**Setup:** Seed a user with a channel; initiate an upload to obtain a draft video.

#### 2.1. refresh-part-urls-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. POST /videos/:videoId/upload/part-urls with `{ part_numbers: [1] }` and owner Bearer token
    - expect: 200
    - expect: response body has `part_urls` array with `{ part_number: 1, url: <string> }`

#### 2.2. refresh-part-urls-not-owner

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. Create a second user with a channel and obtain their token
  2. POST /videos/:videoId/upload/part-urls with second user's token (not the video owner)
    - expect: 403
    - expect: response body `error: "VIDEO_ACCESS_DENIED"`

### 3. Complete Upload (POST /videos/:videoId/upload/complete)

**Setup:** Seed a user with a channel; initiate an upload declaring `size_in_bytes` equal to the fixture's byte length (a single part, since the part size is 100 MiB); PUT the part to its presigned URL collecting the `ETag`.

#### 3.1. complete-upload-success

**Covers AC:** #1, #2
**Source:** manual
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. PUT the fixture bytes directly to the presigned URL from the initiate response, collecting the ETag from the response
    - expect: each PUT returns 200 with an ETag header
  2. POST /videos/:videoId/upload/complete with `{ parts: [{ part_number: 1, etag: "<collected>" }] }` and owner Bearer token
    - expect: 200
    - expect: response body has `id`, `public_id`, `status: "processing"`
  3. Query the database for the video row
    - expect: `status = "processing"` and `upload_id IS NULL`

#### 3.2. complete-upload-duplicate-409

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. After a successful complete, POST /videos/:videoId/upload/complete again with the same parts
    - expect: 409
    - expect: response body `error: "VIDEO_NOT_IN_DRAFT"`

#### 3.3. complete-upload-incomplete-400

**Covers AC:** #1
**Source:** manual
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. Initiate an upload and PUT its part, then POST /videos/:videoId/upload/complete with `{ parts: [{ part_number: 1, etag: "\"not-the-real-etag\"" }] }`
    - expect: 400
    - expect: response body `error: "UPLOAD_INCOMPLETE"`
  2. Query the database for the video row
    - expect: `status = "draft"` and `upload_id` unchanged (the multipart upload is still open for a retry)

#### 3.4. complete-upload-size-mismatch-400

**Covers AC:** #1
**Source:** manual
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. Initiate an upload declaring `size_in_bytes` = fixture length + 1, PUT the fixture bytes, collect the ETag
  2. POST /videos/:videoId/upload/complete with the collected part
    - expect: 400
    - expect: response body `error: "SIZE_MISMATCH"`
  3. Query the database and storage
    - expect: the video row no longer exists and the object at its `storage_key` was deleted

### 4. Abort Upload (DELETE /videos/:videoId/upload)

**Setup:** Seed a user with a channel; initiate an upload.

#### 4.1. abort-upload-success

**Covers AC:** #1
**Source:** manual
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. DELETE /videos/:videoId/upload with owner Bearer token
    - expect: 204 with no body
  2. Query the database for the video row (there is no `GET` by internal id — public reads use `public_id`)
    - expect: the row no longer exists
