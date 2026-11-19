---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos.e2e-spec.ts
---

# Public Video Endpoints Test Plan

## Application Overview

The public video endpoints allow anonymous and authenticated users to retrieve video metadata, stream video content, and download video files. Access control follows the Authorization Matrix: anonymous and non-owner authenticated users see only `ready` videos (non-ready returns 404 to avoid disclosing existence); the channel owner sees videos in any status. Stream and download respond with 302 redirects to presigned MinIO/S3 URLs. An invalid or expired token always results in 401 (not silent fallback to anonymous), enforcing token refresh.

## Test Scenarios

### 1. Video Metadata (GET /videos/:publicId)

**Setup:** `cleanAllTables`; register, confirm and log in a user (channel created on registration). Create the `ready` video **without enqueuing a processing job**, so a running `video-worker` cannot race the arrange: insert the row through the `Video` repository with `status: ready`, `duration_seconds`, `metadata` and `storage_key`, and store `test/fixtures/sample.mp4` at that key with `StorageService.putObject`. Create a second video in `draft` for the same user via `POST /videos`.

#### 1.1. get-metadata-anonymous-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. GET /videos/:publicId (ready video) without Authorization header
    - expect: 200
    - expect: response body has `id`, `public_id`, `channel_id`, `title`, `status: "ready"`, `mime_type`, `size_in_bytes`, `duration_seconds`, `metadata`, `thumbnail_url`, `created_at`
    - expect: `error_message` is null (not exposed to non-owners)

#### 1.2. get-metadata-anonymous-draft-404

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. GET /videos/:publicId (draft video) without Authorization header
    - expect: 404
    - expect: response body `error: "VIDEO_NOT_FOUND"`

#### 1.3. get-metadata-owner-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. GET /videos/:publicId (draft video) with owner Bearer token
    - expect: 200
    - expect: response body has `status: "draft"`

#### 1.4. get-metadata-invalid-token-401

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. GET /videos/:publicId (ready video) with `Authorization: Bearer invalid-token`
    - expect: 401

### 2. Video Streaming (GET /videos/:publicId/stream)

**Setup:** Same as section 1; additionally, the `ready` video must have its object stored in MinIO (PUT via presigned URL in the arrange step).

#### 2.1. stream-anonymous-ready-302

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. GET /videos/:publicId/stream (ready video) without Authorization header, with `redirect: "manual"` (do not follow redirect)
    - expect: 302
    - expect: `Location` header is a presigned MinIO URL
  2. GET the Location URL with `Range: bytes=0-1023` header
    - expect: 206 Partial Content
    - expect: `Content-Range` header present

#### 2.2. stream-owner-draft-409

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. GET /videos/:publicId/stream (draft video) with owner Bearer token
    - expect: 409
    - expect: response body `error: "VIDEO_NOT_UPLOADED"`

### 3. Video Download (GET /videos/:publicId/download)

**Setup:** Same as section 2.

#### 3.1. download-anonymous-ready-302

**Covers AC:** #1
**Source:** manual
**Last sync:** 2026-11-18T12:27:24Z

**Steps:**
  1. GET /videos/:publicId/download (ready video) without Authorization header, with `redirect: "manual"`
    - expect: 302
    - expect: `Location` header contains `response-content-disposition` with `attachment`
  2. GET the Location URL
    - expect: 200
    - expect: `Content-Disposition` response header starts with `attachment`
