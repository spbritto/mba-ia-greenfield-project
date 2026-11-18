# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/9 completed

### SI-03.1 — Dependências, infraestrutura (Redis, MinIO) e configuração
- **Status:** done
- **Tests:** storage.config.spec (3), queue.config.spec (3), env.validation.integration-spec (+8)
- **Observations:** Official minio/minio Docker image removed (Sep 2026); using cgr.dev/chainguard/minio. Bucket-level CORS not supported in OSS MinIO; using MINIO_API_CORS_ALLOW_ORIGIN env var. mc binary download URL also gone (410); minio-init uses Chainguard minio image which bundles mc.

### SI-03.2 — Entidade Video, migração e módulo
- **Status:** done
- **Tests:** public-id.spec (3), video.entity.integration-spec (7), videos.module.spec (1), migrations.integration-spec (updated: 3 migrations)
- **Observations:** Installed `ioredis` (required by BullMQ at runtime). E2E `auth.e2e-spec.ts` beforeAll timeout increased to 30s due to BullMQ Redis connection time. Migration test switched from parallel to sequential DROP to avoid FK deadlocks. `VideosModule.spec` uses `synchronize: false` since compilation test doesn't need actual DB sync.

### SI-03.3 — StorageModule (cliente S3/MinIO)
- **Status:** done
- **Tests:** storage.service.integration-spec (8: multipart create/presign/complete, getObjectSize, presignClientGet Range→206, presignClientGet Content-Disposition, putObject/deleteObject, abortMultipartUpload, presignInternalGet)
- **Observations:** StorageService with two S3Client instances (internal/public) and `onModuleDestroy` for cleanup. `import type { ConfigType }` required for `isolatedModules` + `emitDecoratorMetadata`. StorageModule registered in AppModule and exported for consumer modules.

### SI-03.4 — Lookup de canal, exceções de domínio e VideosService
- **Status:** pending
- **Tests:**
- **Observations:**

### SI-03.5 — Endpoints de upload (VideosController)
- **Status:** pending
- **Tests:**
- **Observations:**

### SI-03.6 — Autenticação opcional e endpoints públicos (metadados, stream, download)
- **Status:** pending
- **Tests:**
- **Observations:**

### SI-03.7 — Worker de processamento (FFmpeg) e serviço `video-worker`
- **Status:** pending
- **Tests:**
- **Observations:**

### SI-03.8 — E2E do ciclo completo com o worker
- **Status:** pending
- **Tests:**
- **Observations:**

### SI-03.9 — Documentação e contrato OpenAPI
- **Status:** pending
- **Tests:**
- **Observations:**
