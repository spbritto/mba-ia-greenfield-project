# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with three main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for auth, users, channels, videos, storage and mail, plus the standalone video worker (`src/worker.ts`). See `nestjs-project/CLAUDE.md`.
- `next-frontend/` — Frontend (Next.js 16, App Router), with the Phase 01–02 auth flows. See `next-frontend/CLAUDE.md`.
- `docs/` — Project documentation, architecture diagrams, and planning.

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (BullMQ + Redis) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos Module

Upload, processing, and delivery of video content. Key flow:

1. **Upload** — authenticated user calls `POST /videos` to initiate a presigned multipart upload to MinIO. The API returns presigned URLs for each part. After all parts are uploaded directly to MinIO, the client calls `POST /videos/:videoId/upload/complete` to finalize.
2. **Processing** — on completion, the API enqueues a BullMQ job (`video-processing` queue). The `video-worker` service (FFmpeg) picks up the job, extracts duration/codec metadata, generates a thumbnail, and sets the video status to `ready`.
3. **Delivery** — `GET /videos/:publicId` returns metadata; `GET /videos/:publicId/stream` and `/download` redirect to presigned MinIO URLs.

Key files:
- `nestjs-project/src/videos/` — `VideosModule`, `VideosService`, `VideosController`, `Video` entity, DTOs, domain exceptions
- `nestjs-project/src/videos/processors/video.processor.ts` — `VideoProcessor` (BullMQ consumer, runs only in the worker)
- `nestjs-project/src/videos/ffmpeg/ffmpeg.service.ts` — `FfmpegService` (ffprobe/ffmpeg via `child_process.spawn`)
- `nestjs-project/src/storage/` — `StorageModule`, `StorageService` (S3/MinIO client)
- `nestjs-project/src/worker/worker.module.ts` — `WorkerModule` (worker's standalone DI graph)
- `nestjs-project/src/worker.ts` — standalone worker entry point

Endpoints:
- `POST /videos` — initiate multipart upload (auth required)
- `POST /videos/:videoId/upload/part-urls` — refresh presigned part URLs (auth required)
- `POST /videos/:videoId/upload/complete` — complete upload (auth required)
- `DELETE /videos/:videoId/upload` — abort upload (auth required)
- `GET /videos/:publicId` — video metadata (public, optional auth)
- `GET /videos/:publicId/stream` — 302 redirect to presigned stream URL (public, optional auth)
- `GET /videos/:publicId/download` — 302 redirect to presigned download URL (public, optional auth)

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.