---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-17T22:58:36"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-17T23:23:06"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-13T12:26:58"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload funcional de vídeos de até 10GB via presigned multipart upload direto ao MinIO/S3, processamento automático em segundo plano (extração de duração, metadados e geração de thumbnail via FFmpeg em worker dedicado), streaming e download via presigned URLs, e URLs únicas por vídeo — tudo orquestrado pelo backend NestJS com BullMQ/Redis como fila e infraestrutura completa em Docker Compose.

---

## Step Implementations

### SI-03.1 — Dependências, infraestrutura (Redis, MinIO) e configuração

**Description:** Instalar as bibliotecas fixadas em `library-refs.md`, provisionar `redis`, `minio` e `minio-init` no Compose, instalar FFmpeg na imagem, criar as configs `storage`/`queue` com validação Joi, registrar o BullMQ no `AppModule` e preparar o ambiente de testes para alcançar as URLs pré-assinadas dentro do container.

**Technical actions:**

1. Instalar no container `nestjs-api`: `bullmq@^6.7.7`, `@nestjs/bullmq@^11.0.5` (linha compatível com NestJS 11; peer `bullmq ^6`), `@aws-sdk/client-s3@^3.1171.0`, `@aws-sdk/s3-request-presigner@^3.1171.0` (per `library-refs.md`; `phase-03-videos/TD-01`, `phase-03-videos/TD-03`).
2. `Dockerfile.dev`: instalar `ffmpeg` (fornece `ffmpeg` e `ffprobe`) via `apt` — a mesma imagem serve `nestjs-api` e `video-worker` (per `phase-03-videos/TD-04` + revisão).
3. `compose.yaml`: adicionar `redis` (`redis-server --appendonly yes`, healthcheck `redis-cli ping`) (per `phase-03-videos/TD-01`); `minio` (porta 9000 API / 9001 console, healthcheck); `minio-init` (imagem do MinIO client, roda uma vez após `minio` healthy) que cria o bucket de `S3_BUCKET` (per `phase-03-videos/TD-09` revisão). Configurar CORS conforme a documentação do MinIO (consultar via context7: configuração por bucket ou `MINIO_API_CORS_ALLOW_ORIGIN`) permitindo `PUT`/`GET`/`HEAD` e expondo `ETag` (per `phase-03-videos/TD-02` revisão). `nestjs-api` passa a depender de `redis` (healthy) e `minio-init` (concluído).
4. Criar `src/config/storage.config.ts` — `registerAs('storage')` com `S3_ENDPOINT` (interno, `http://minio:9000`), `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PRESIGNED_GET_TTL_SECONDS` (default 14400 = 4 h) (per `phase-03-videos/TD-02` revisão, `phase-03-videos/TD-07` revisão). Criar `src/config/queue.config.ts` — `registerAs('queue')` com `REDIS_HOST` (default `redis`, nunca `localhost`) e `REDIS_PORT` (per `phase-03-videos/TD-01`).
5. `src/config/env.validation.ts`: adicionar as novas variáveis ao schema Joi (convenção herdada `phase-01-configuracao-base/TD-02`). Atualizar `.env.example` (e o `.env` local): `S3_PUBLIC_ENDPOINT=http://localhost:9000` para clientes no host; demais hosts = nomes de serviço do Compose.
6. Registrar `BullModule.forRootAsync` no `AppModule` injetando `queue.config` (per `@nestjs/bullmq` — `BullModule.forRoot`).
7. Ambiente de testes: adicionar um setup de Jest (unit/integration e e2e) que carrega o `.env` e sobrescreve `S3_PUBLIC_ENDPOINT` com `S3_ENDPOINT`, porque os testes rodam dentro do container `nestjs-api` e precisam alcançar as URLs pré-assinadas (per `phase-03-videos/TD-02` revisão).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storage.config.ts` | Unit: factory lê as variáveis e aplica o default do TTL | `src/config/storage.config.spec.ts` |
| `queue.config.ts` | Unit: factory lê host/porta e aplica o default `redis` | `src/config/queue.config.spec.ts` |
| `env.validation.ts` | Integration: schema rejeita ausência das novas variáveis obrigatórias | `src/config/env.validation.integration-spec.ts` (estender) |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `redis` e `minio` healthy e `minio-init` termina com sucesso, criando o bucket.
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` funcionam.
- `AppModule` compila com o `BullModule` conectado ao `redis`.
- A suíte existente (Fases 01–02) continua verde.

---

### SI-03.2 — Entidade Video, migração e módulo

**Description:** Criar a entidade `Video`, o gerador de `public_id`, a migração `CreateVideos`, o `VideosModule` registrado no `AppModule`, e ajustar os helpers e testes existentes que conhecem o schema completo.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme `### Data Model` (snake_case, enum `videos_status_enum`, transformers de `bigint`/`numeric` → `number`, `jsonb` para `metadata`, `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`, índices) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-08`, `phase-03-videos/TD-09`).
2. Criar `src/videos/utils/public-id.ts` — `generatePublicId()` = `randomBytes(9).toString('base64url')` (per `phase-03-videos/TD-06`).
3. Gerar a migração via CLI (`npm run migration:generate`) → `src/database/migrations/<timestamp>-CreateVideos.ts`; rodar contra o banco limpo (`.claude/rules/typeorm-migrations.md`).
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e `BullModule.registerQueue({ name: 'video-processing' })`; importar `VideosModule` no `AppModule`. Constantes de fila/job (`video-processing`, `process-video`) em `src/videos/videos.constants.ts` (`nestjs-common-conventions.md`).
5. Atualizar `src/test/create-test-data-source.ts` → `cleanAllTables` apaga `videos` antes de `channels` (FK), para não quebrar as suítes das Fases 01–02.
6. Atualizar `src/database/migrations.integration-spec.ts`: incluir `CreateVideos` na lista de migrações, `videos` em `MANAGED_TABLES` e `videos_status_enum` em `MANAGED_ENUM_TYPES`; esperar 3 migrações; o teste de revert passa a verificar a remoção de `videos`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: default `draft`, unique `public_id`, FK `channel_id`, transformers retornam `number`, `metadata` jsonb | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId()` | Unit: 12 caracteres do alfabeto `[A-Za-z0-9_-]` | `src/videos/utils/public-id.spec.ts` |
| `VideosModule` | Unit: compilação do módulo (TypeORM + fila) | `src/videos/videos.module.spec.ts` |
| Migrações | Integration: aplica 3 migrações, cria `videos`, revert remove `videos` | `src/database/migrations.integration-spec.ts` (atualizar) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A migração cria `videos` com enum, índices e FK para `channels`; o revert remove tabela e enum.
- `public_id` duplicado viola a constraint única.
- `size_in_bytes` e `duration_seconds` voltam como `number`.
- A suíte completa existente continua verde com o novo `cleanAllTables`.

---

### SI-03.3 — StorageModule (cliente S3/MinIO)

**Description:** Encapsular o acesso ao object storage em `StorageService`, com um cliente para operações internas (endpoint `S3_ENDPOINT`) e assinatura de URLs para clientes externos (endpoint `S3_PUBLIC_ENDPOINT`).

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` (exporta `StorageService`); dois `S3Client` configurados a partir de `storage.config` com `forcePathStyle: true`: interno (`S3_ENDPOINT`) para comandos e URLs usadas pelo worker; público (`S3_PUBLIC_ENDPOINT`) apenas para assinar URLs entregues a clientes (per `phase-03-videos/TD-02` revisão, `phase-03-videos/TD-03`; `library-refs.md` → `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).
2. Métodos de multipart: `createMultipartUpload(key, contentType)`, `presignUploadParts(key, uploadId, partNumbers)` (URLs públicas, 1 h), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-05` + revisão).
3. `getObjectSize(key)` (`HeadObject` → `ContentLength`), `putObject(key, body, contentType)`, `deleteObject(key)`.
4. `presignClientGet(key, { downloadFileName? })` — URL pública com TTL `S3_PRESIGNED_GET_TTL_SECONDS` e, quando `downloadFileName` vier, `ResponseContentDisposition: attachment; filename="…"`; `presignInternalGet(key)` — URL assinada no endpoint interno, para o FFmpeg do worker (per `phase-03-videos/TD-07` revisão, `phase-03-videos/TD-04`).
5. Importar `StorageModule` no `AppModule` (e no worker, SI-03.7).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): multipart com 2 partes de 5 MiB via URLs pré-assinadas (PUT com `fetch`, captura do `ETag`) → complete → `getObjectSize`; GET pré-assinado com `Range` → 206; download com `Content-Disposition: attachment`; put/delete; abort | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- O fluxo multipart completo funciona contra o MinIO real, inclusive a leitura do `ETag` das respostas.
- A URL de stream responde `206 Partial Content` a uma requisição com `Range`.
- A URL de download responde com `Content-Disposition: attachment`.

---

### SI-03.4 — Lookup de canal, exceções de domínio e VideosService

**Description:** Implementar a regra de negócio de upload e leitura (`VideosService`), com ownership resolvido via `ChannelsModule` e erros como exceções de domínio.

**Technical actions:**

1. `ChannelsService.findByUserId(userId): Promise<Channel | null>` — o lookup de canal pertence ao `ChannelsModule` (princípio de responsabilidade única do `CLAUDE.md`); `VideosModule` importa `ChannelsModule`.
2. Criar `src/videos/exceptions/video.exceptions.ts` estendendo `DomainException`: `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `VideoAccessDeniedException` (403 `VIDEO_ACCESS_DENIED`), `VideoNotInDraftException` (409 `VIDEO_NOT_IN_DRAFT`), `VideoNotUploadedException` (409 `VIDEO_NOT_UPLOADED`), `UploadIncompleteException` (400 `UPLOAD_INCOMPLETE`), `SizeMismatchException` (400 `SIZE_MISMATCH`) (per `### Error Catalog`; `phase-02-auth/TD-07`).
3. `initiateUpload(userId, dto)`: gera `id` (`randomUUID`) e `storage_key` = `videos/{id}/original.{ext}`; `createMultipartUpload`; insere o `Video` (`draft`, `title` derivado de `file_name`) com retry de `public_id` em violação de unicidade; se a inserção falhar de vez, compensa com `abortMultipartUpload` e relança; responde com `part_urls` de todas as partes (per `### API Contracts` → `POST /videos`; `phase-03-videos/TD-05` revisão).
4. `refreshPartUrls`, `completeUpload`, `abortUpload` conforme os comportamentos de `### API Contracts` (ownership → 403; não-`draft` → 409; `UPLOAD_INCOMPLETE`; `SIZE_MISMATCH` apaga objeto + linha). Em `completeUpload`, o status `processing` é persistido antes de enfileirar `process-video` com as opções de `### Events/Messages`; se o enfileiramento falhar, o vídeo vai para `failed` com `error_message` e o erro é relançado (`nestjs-services.md` — nunca engolir erros).
5. `findByPublicId(publicId, userId?)`, `getStreamUrl(...)`, `getDownloadUrl(...)` aplicando a `### Authorization Matrix` (não-owner e não-`ready` → 404; owner com `draft` → 409 em stream/download); `thumbnail_url` via `presignClientGet`; `error_message` só para o owner.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário / `null` | `src/channels/channels.service.integration-spec.ts` (estender) |
| `VideosService` | Unit: ramos de ownership, status, `UPLOAD_INCOMPLETE`, `SIZE_MISMATCH`, retry de `public_id`, matriz de acesso por status | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration (DB + MinIO + Redis reais): initiate persiste o draft; complete enfileira o job (`queue.getJob(videoId)` com `video_id`/`storage_key`); compensação do initiate (`jest.spyOn` na inserção → `abortMultipartUpload` executado); abort remove a linha | `src/videos/videos.service.integration-spec.ts` |

Para não competir com o `video-worker` em execução, a fila dos testes de integração usa um `prefix` próprio do BullMQ.

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- Todas as transições e erros de `### API Contracts` são cobertos por teste.
- `completeUpload` duas vezes no mesmo vídeo → 409 no segundo (o `jobId` = `video_id` também impede job duplicado).
- Nenhuma consulta direta à tabela `channels` dentro de `VideosModule`.

---

### SI-03.5 — Endpoints de upload (VideosController)

**Route:** POST /videos
**Route:** POST /videos/:videoId/upload/part-urls
**Route:** POST /videos/:videoId/upload/complete
**Route:** DELETE /videos/:videoId/upload
**Test Specs:** _pending /plan-test-specs_
**Authorization:** JwtAuthGuard global (todas exigem token válido)

**Description:** Expor o fluxo de upload via HTTP com DTOs validados, OpenAPI e sem o rate limit dos endpoints de autenticação.

**Technical actions:**

1. DTOs em `src/videos/dto/`: `InitiateUploadDto`, `RefreshPartUrlsDto`, `CompleteUploadDto` (+ DTOs de resposta para OpenAPI) com as regras de `### API Contracts` → Validation Rules (`phase-02-auth/TD-06`).
2. `src/videos/videos.controller.ts`: `@ApiTags('videos')` + `@Controller('videos')` (`nestjs-controllers.md`); `POST /videos` (201), `POST /videos/:videoId/upload/part-urls` (200), `POST /videos/:videoId/upload/complete` (200), `DELETE /videos/:videoId/upload` (204, `@HttpCode(204)`); `ParseUUIDPipe` em `:videoId`; `userId` do token.
3. `@SkipThrottle()` no controller: o `ThrottlerGuard` global (10 req/min) é a proteção de autenticação da Fase 02 (`phase-02-auth/TD-08`), e o fluxo de upload/polling legítimo excede esse limite.
4. Decorators OpenAPI (`@ApiOperation`, `@ApiBearerAuth`, `@ApiResponse` para cada status do `### Error Catalog`) (per `openapi-docs-nestjs/TD-01` + revisão).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Endpoints de upload + DTOs | E2E: 201 do initiate e validações 400; 401 sem token; PUT da parte na URL pré-assinada; complete 200 → `processing` no banco; complete repetido → 409; `UPLOAD_INCOMPLETE`; `SIZE_MISMATCH` (tamanho declarado ≠ enviado) com linha removida; part-urls 200 e 403 para não-owner; abort 204 com linha removida | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- Respostas e erros batem com `### API Contracts` (corpo de erro `{ statusCode, error, message }`, ex.: `error: "VALIDATION_ERROR"`).
- A API nunca recebe os bytes do vídeo: as partes vão direto ao MinIO.

---

### SI-03.6 — Autenticação opcional e endpoints públicos (metadados, stream, download)

**Route:** GET /videos/:publicId
**Route:** GET /videos/:publicId/stream
**Route:** GET /videos/:publicId/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Opcional — anônimo ou autenticado (`### Authorization Matrix`)

**Description:** Permitir leitura anônima de vídeos `ready` reconhecendo o owner quando há token, e entregar stream/download por redirecionamento 302.

**Technical actions:**

1. `src/auth/decorators/optional-auth.decorator.ts` (`@OptionalAuth()`) e extensão do `JwtAuthGuard` global: em rotas marcadas, sem header → anônimo; token válido → `request.user`; token inválido/expirado → 401 (per `### Authorization Matrix` → optional authentication). O guard continua global (`nestjs-controllers.md`).
2. Validação de `:publicId` (12 caracteres `[A-Za-z0-9_-]`) por pipe.
3. `GET /videos/:publicId` (200), `GET /videos/:publicId/stream` e `/download` (302 com `Location` vindo do service) com `@OptionalAuth()` (per `phase-03-videos/TD-07` + revisões).
4. Decorators OpenAPI, incluindo o 302 e os 409/404.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `JwtAuthGuard` + `@OptionalAuth()` | Unit: sem header → anônimo; token válido → user; token inválido → 401; rotas não marcadas inalteradas | `src/auth/guards/jwt-auth.guard.spec.ts` (estender) |
| Endpoints públicos | E2E: anônimo em `draft` → 404; owner em `draft` → 200 e stream 409; token inválido → 401; vídeo `ready` (objeto enviado e status ajustado no arrange) → 200 sem `error_message`, stream 302 cujo `Location` responde 206 a `Range`, download 302 com `attachment` | `test/videos.e2e-spec.ts` (estender) |

**Dependencies:** SI-03.4 (SI-03.5 para o arquivo e2e)

**Acceptance criteria:**

- Matriz de acesso cumprida em todos os status.
- Streaming comprovado por teste: `206 Partial Content` a partir da URL redirecionada.

---

### SI-03.7 — Worker de processamento (FFmpeg) e serviço `video-worker`

**Description:** Processar os jobs em um container dedicado: extrair duração e metadados, gerar o thumbnail e atualizar o status.

**Technical actions:**

1. `src/videos/ffmpeg/ffmpeg.service.ts` — `probe(url)` e `extractFrame(url, seconds)` via `spawn` de `ffprobe`/`ffmpeg` com os argumentos de `### Events/Messages` (per `phase-03-videos/TD-04`; `fluent-ffmpeg` não é usado). Erros de exit code ≠ 0 viram exceção com o stderr.
2. `src/videos/processors/video.processor.ts` — `@Processor('video-processing')` (`WorkerHost`): ignora se o vídeo não existe ou não está `processing`; executa os passos 2–7 de `### Events/Messages` usando `presignInternalGet`; na falha da última tentativa marca `failed` com `error_message` e relança; nas intermediárias apenas relança (per `phase-03-videos/TD-08` revisão).
3. `src/worker/worker.module.ts` (Config + validação, TypeORM, `BullModule.forRootAsync`, `registerQueue`, `StorageModule`, `TypeOrmModule.forFeature([Video])`, `FfmpegService`, `VideoProcessor`) e `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)` — sem servidor HTTP. O `VideoProcessor` é provido **somente** no `WorkerModule` (per `phase-03-videos/TD-04`).
4. Scripts `start:worker` / `start:worker:dev` no `package.json`; serviço `video-worker` no `compose.yaml` (mesmo build e volume do `nestjs-api`, comando `npm run start:worker:dev`, `depends_on` `db`/`redis` healthy e `minio-init` concluído).
5. Fixture `test/fixtures/sample.mp4` (~2 s, 320x240, H.264 + AAC, < 1 MB) gerada com `ffmpeg -f lavfi` e versionada.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Integration (FFmpeg real): `probe` da fixture retorna duração ≈ 2 s e codecs; `extractFrame` retorna bytes JPEG; arquivo inválido → exceção | `src/videos/ffmpeg/ffmpeg.service.integration-spec.ts` |
| `VideoProcessor` | Unit (mocks): sucesso → `ready` com metadados; falha intermediária mantém `processing`; falha final → `failed`; vídeo inexistente ou não-`processing` → sem alterações | `src/videos/processors/video.processor.spec.ts` |
| `VideoProcessor` | Integration (DB + MinIO + FFmpeg reais, `process()` chamado direto): fixture → `ready`, `duration_seconds`, `metadata`, thumbnail `image/jpeg` em `videos/{id}/thumbnail.jpg` | `src/videos/processors/video.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do módulo | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker`, que conecta ao Redis e consome a fila `video-processing`.
- A API não registra o processor (nenhum consumidor da fila no processo HTTP).
- Status, duração, metadados e thumbnail ficam refletidos no banco e no storage.

---

### SI-03.8 — E2E do ciclo completo com o worker

**Test Specs:** _pending /plan-test-specs_

**Description:** Comprovar, contra a stack real do Compose, o ciclo upload → processamento → streaming → download, incluindo a falha de processamento.

**Technical actions:**

1. `test/videos-processing.e2e-spec.ts` (requer `video-worker` em execução): autenticar → `POST /videos` com a fixture → PUT da(s) parte(s) → complete → polling de `GET /videos/:publicId` até `ready` (timeout de 60 s) → conferir `duration_seconds`, `metadata` e `thumbnail_url` → stream 302 + `Range` → 206 → download 302 + `attachment`.
2. Cenário de falha: upload de bytes que não são vídeo com `mime_type` aceito → após as 3 tentativas o owner vê `failed` com `error_message` (per `phase-03-videos/TD-08` revisão).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Ciclo completo com worker | E2E: sucesso (`ready` + 206) e falha (`failed`) | `test/videos-processing.e2e-spec.ts` |

**Dependencies:** SI-03.5, SI-03.6, SI-03.7

**Acceptance criteria:**

- `draft → processing → ready` e `processing → failed` observados no banco pelo e2e.
- Streaming (206) e download (`attachment`) comprovados após o processamento real.

---

### SI-03.9 — Documentação e contrato OpenAPI

**Description:** Deixar a documentação de IA e o contrato coerentes com o código entregue.

**Technical actions:**

1. Regenerar `openapi.json` (`npm run openapi:export`) com os endpoints de vídeo.
2. `CLAUDE.md` (raiz): Message Queue = BullMQ + Redis; seção do módulo de vídeos (endpoints, fluxo de upload, worker, storage), citando apenas arquivos existentes.
3. `nestjs-project/CLAUDE.md`: serviços `redis`, `minio`, `minio-init`, `video-worker` (portas, verificações de prontidão `redis-cli ping` e healthcheck do MinIO, logs do worker); o worker é infraestrutura e sobe com `docker compose up -d`; variáveis novas; testes que dependem do worker.
4. `docs/diagrams/software-arch.mermaid`: fila "TBD" → "BullMQ / Redis".

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` | Integration: export continua válido e inclui os paths `/videos` | `src/openapi-export.integration-spec.ts` (estender) |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- Toda referência da documentação aponta para arquivos e comportamentos existentes.
- Definition of Done completa: `npm test`, `npm run test:e2e`, `npx tsc --noEmit` e `npm run lint` verdes.

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

```
SI-03.1 (root — dependências, Compose, configs)
├── SI-03.2 — entidade, migração, módulo
│   ├── SI-03.4 — também depende de SI-03.3
│   │   └── SI-03.5 — endpoints de upload
│   │       └── SI-03.6 — endpoints públicos (estende o e2e da SI-03.5)
│   └── SI-03.7 — worker (também depende de SI-03.3)
└── SI-03.3 — StorageModule

SI-03.8 — depende de SI-03.5, SI-03.6, SI-03.7
SI-03.9 — depende de SI-03.8
```

Ordem de execução: 03.1 → 03.2 → 03.3 → 03.4 → 03.5 → 03.6 → 03.7 → 03.8 → 03.9 (03.3 pode vir antes de 03.2; 03.7 pode vir logo após 03.4).

---

## Deliverables

- [ ] SI-03.1 — Dependências, infraestrutura (Redis, MinIO) e configuração
- [ ] SI-03.2 — Entidade Video, migração e módulo
- [ ] SI-03.3 — StorageModule (cliente S3/MinIO)
- [ ] SI-03.4 — Lookup de canal, exceções de domínio e VideosService
- [ ] SI-03.5 — Endpoints de upload (VideosController)
- [ ] SI-03.6 — Autenticação opcional e endpoints públicos (metadados, stream, download)
- [ ] SI-03.7 — Worker de processamento (FFmpeg) e serviço `video-worker`
- [ ] SI-03.8 — E2E do ciclo completo com o worker
- [ ] SI-03.9 — Documentação e contrato OpenAPI

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e -- --runInBand`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
