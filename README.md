# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.
- [FC Tube sem padrão.fig](./FC%20Tube%20sem%20padrao.fig) — arquivo-fonte puro, sem tokens, cores, tipografia e espaçamento.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails e acesso ao banco.
- **Database** (PostgreSQL 17) — usuários, canais, tokens de autenticação e vídeos.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Video Worker** (FFmpeg) — processo separado (container `video-worker`) que consome a fila, extrai duração e metadados com `ffprobe` e gera a thumbnail.
- **Object Storage** (S3/MinIO) — arquivos de vídeo e thumbnails. Localmente roda MinIO, com a mesma API do S3.
- **Message Queue** (BullMQ + Redis) — fila de processamento de vídeos, com 3 tentativas e backoff exponencial.

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Mailpit + Redis + MinIO + Video Worker)

```bash
cd nestjs-project

# Crie o .env a partir do exemplo (apenas na primeira vez)
cp .env.example .env

# Sobe API, banco, Mailpit, Redis, MinIO (+ criação do bucket) e o worker de vídeo
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (db/user/senha: `streamtube`) |
| Mailpit (UI de e-mails) | http://localhost:8025 |
| Redis (fila BullMQ) | `localhost:6379` |
| MinIO — API S3 | http://localhost:9000 |
| MinIO — console | http://localhost:9001 (usuário/senha: `minioadmin`) |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

O `video-worker` não expõe porta. Ele leva cerca de 2 minutos para iniciar (compila com `ts-node`) e está pronto quando o log mostra `Video worker started`:

```bash
docker compose logs video-worker | grep "Video worker started"
```

> O worker **não recarrega o código automaticamente**. Depois de alterar código que ele usa, rode `docker compose restart video-worker`.

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test               # unitários + integração
docker compose exec nestjs-api npm run test:e2e       # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov       # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco real), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`.

Os testes de vídeo usam a infraestrutura real do Compose (MinIO, Redis e FFmpeg). A e2e `test/videos-processing.e2e-spec.ts` exercita o ciclo completo com o worker real, então o container `video-worker` precisa estar no ar.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base** e **Fase 02 — Autenticação** estão concluídas (backend + frontend). A **Fase 03 — Upload e Processamento de Vídeos** está concluída no backend; a interface de vídeo fica para as próximas fases.

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

### Upload e processamento de vídeos (Fase 03 — backend)

Fluxo **upload direto ao storage → processamento em fila → streaming e download**:

1. **Upload de até 10 GB sem passar pela API.** Ao iniciar, o vídeo é pré-cadastrado como rascunho (`draft`) e a API devolve URLs pré-assinadas para um upload multipart (partes de 100 MiB). O cliente envia as partes direto ao MinIO/S3.
2. **Processamento automático.** Ao concluir o upload, o vídeo passa a `processing` e um job entra na fila. O `video-worker` extrai duração e metadados (codecs, resolução, bitrate) com `ffprobe`, gera a thumbnail a partir de um frame com `ffmpeg` e marca o vídeo como `ready`. Se as 3 tentativas falharem, o status vira `failed`, com uma `error_message` visível ao dono.
3. **URL única.** Cada vídeo tem um `public_id` aleatório de 12 caracteres, garantido como único no banco.
4. **Streaming e download.** Os endpoints redirecionam (302) para URLs pré-assinadas do storage. O streaming aceita `Range` (206 Partial Content), sem exigir o download completo; o download vem com `Content-Disposition: attachment`.

Ciclo de status: `draft → processing → ready | failed`. Vídeos que ainda não estão prontos só ficam visíveis para o dono.

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /videos` | Inicia o upload multipart e cria o vídeo como rascunho (autenticado) |
| `POST /videos/:videoId/upload/part-urls` | Renova as URLs pré-assinadas das partes (autenticado, dono) |
| `POST /videos/:videoId/upload/complete` | Conclui o upload e enfileira o processamento (autenticado, dono) |
| `DELETE /videos/:videoId/upload` | Aborta o upload e remove o rascunho (autenticado, dono) |
| `GET /videos/:publicId` | Metadados do vídeo (público; autenticação opcional) |
| `GET /videos/:publicId/stream` | Redireciona para a URL de streaming (público; autenticação opcional) |
| `GET /videos/:publicId/download` | Redireciona para a URL de download (público; autenticação opcional) |

O contrato completo está em `nestjs-project/openapi.json`. Decisões técnicas da fase: `docs/decisions/technical-decisions-phase-03-videos.md`.

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-videos/             # Upload e processamento de vídeos (backend)
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── videos/                      # Upload, metadados, streaming/download, processor e FFmpeg
│   │   ├── storage/                     # Cliente S3/MinIO (multipart e URLs pré-assinadas)
│   │   ├── worker/                      # WorkerModule (DI do worker de vídeo)
│   │   ├── worker.ts                    # Entry point do video-worker
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── common/                      # Filtros, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced (Joi)
│   │   └── database/                    # data-source, migrations e seeds
│   ├── test/                            # Testes e2e (+ fixtures/sample.mp4)
│   ├── openapi.json                     # Contrato OpenAPI exportado
│   ├── compose.yaml                     # Docker Compose (API, PostgreSQL, Mailpit, Redis, MinIO, video-worker)
│   └── Dockerfile.dev
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída (backend) |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars) |
| Banco de Dados | PostgreSQL 17 |
| Fila | BullMQ 6 (`@nestjs/bullmq`) + Redis 7 |
| Object Storage | MinIO (local) / S3, via AWS SDK v3 (`client-s3` + `s3-request-presigner`) |
| Processamento de vídeo | FFmpeg / ffprobe (worker separado) |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
