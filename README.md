# LinguaDev Pro

PWA + BFF serverless en AWS (always-free) para llegar a fluidez en inglés A2 → B2/C1 con SRS, ruta CEFR, IA opcional y práctica de las 4 habilidades. Costo objetivo de infraestructura: ~$0.

> **Estado:** Fase 0 (monorepo + infra + `/api/health`) y andamiaje tipado de Fases 1-2 (contenido, SRS, PWA shell, corrección de escritura). Fases 3-6 pendientes.

## Arquitectura (resumen 8-12 líneas)

- **Monorepo pnpm**: `apps/web` (React 18 PWA), `apps/api` (Hono en Node/Lambda), `packages/shared` (Zod + tipos + SRS), `packages/content` (packs JSON + validador + migradores), `infra` (AWS SAM).
- **Local-first**: fuente de verdad en IndexedDB (Dexie). SRS con `ts-fsrs`. TTS/voz vía Web Speech API.
- **BFF**: **Hono** corriendo en Node local (`pnpm dev`) y en **AWS Lambda + Function URL** con `RESPONSE_STREAM` (para el tutor SSE).
- **Datos**: **DynamoDB** single-table (`PK`/`SK`) con TTL para contadores de rate-limit y presupuesto de IA.
- **Secreto IA**: **SSM Parameter Store** (SecureString), cacheado en el contenedor Lambda. Nunca en el bundle.
- **Frontend en prod**: build estático a **S3 privado** servido por **CloudFront (OAC)**.
- **Guardrails**: **AWS Budgets** con alertas 20/80%, CI con **OIDC** (sin llaves largas), IAM mínimo privilegio.
- **IA opcional**: `AIProvider` con Anthropic/OpenAI (y hook para Bedrock). Rate-limit y presupuesto por sesión.

Ver `infra/README.md` y `ARQUITECTURA_AWS_free_tier.md` (proporcionado por el usuario) para detalles.

## Requisitos

- Node.js 20.11+ (usa `.nvmrc`).
- pnpm 9.x.
- Docker (para DynamoDB Local en dev).
- Opcional para deploy: AWS CLI + SAM CLI, y una API key de Anthropic u OpenAI en SSM.

## Arranque local

```bash
pnpm install

# 1. Levanta DynamoDB Local y crea la tabla
pnpm ddb:up
pnpm ddb:seed

# 2. En una terminal aparte, corre la API y el frontend en paralelo
cp .env.example .env
pnpm dev
```

- API: http://localhost:8787 → prueba `curl http://localhost:8787/api/health`
- Web: http://localhost:5173

## Comandos útiles

| Comando            | Qué hace                                                     |
|--------------------|--------------------------------------------------------------|
| `pnpm dev`         | Corre api + web en paralelo                                  |
| `pnpm build`       | Buildea packages, api (esbuild → `dist/lambda.mjs`) y web    |
| `pnpm typecheck`   | Typecheck en todos los paquetes                              |
| `pnpm lint`        | ESLint                                                       |
| `pnpm test`        | Vitest en todos los paquetes                                 |
| `pnpm ddb:up/down` | Enciende/apaga DynamoDB Local                                |
| `pnpm sam:deploy`  | Deploy guiado del stack SAM                                  |

## Estructura

```
linguadev-pro/
├─ apps/
│  ├─ web/        React 18 + Vite + Tailwind + PWA + Dexie + Zustand
│  └─ api/        Hono + adapter Lambda (streamifyResponse para SSE) + AWS SDK v3
├─ packages/
│  ├─ shared/     Zod schemas (packs, sync, ai, error) + ts-fsrs wrapper + utils
│  └─ content/    Packs JSON bundled + validator + migradores v1→v2
├─ infra/         SAM template (Lambda + Function URL + DynamoDB + SSM + S3 + CloudFront + Budgets)
├─ .github/       CI y deploy con OIDC
├─ docker/        docker-compose.yml para DynamoDB Local
└─ scripts/       seed-ddb.mjs
```

## Fases (según plan del prompt)

- [x] **Fase 0** — monorepo, infra SAM, `/api/health`, DynamoDB Local, CI/OIDC.
- [~] **Fase 1** — shell React responsive, Dexie con migraciones, Zustand, error boundaries, estados de UI, PWA update prompt, banner offline.
- [~] **Fase 2** — contenido (`fundamentos-a2.json`, `travel-b1.json`), validador con Zod, migradores v1→v2, SRS con ts-fsrs y límite diario.
- [ ] **Fase 3** — Learning path completo, Lesson Player, dashboard con animaciones/optimistic UI.
- [ ] **Fase 4** — Escucha (dictado/comprensión) y habla (shadowing, read-aloud con scoring, medidor de voz).
- [~] **Fase 5** — IA en Lambda (correct/evaluate/tutor SSE/generate) con Zod + rate-limit + presupuesto en DynamoDB. Tutor SSE listo por Function URL streaming.
- [ ] **Fase 6** — Sync + progreso + analytics + a11y + pulido final + repaso de casos límite.

## Seguridad

- Key IA solo en SSM Parameter Store (o `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` en `.env` para dev).
- CSP restrictiva en `index.html`.
- Salidas IA sanitizadas con DOMPurify antes de renderizar.
- Validación Zod en cliente y servidor de todo lo que cruza la red.
- Payload máximo 200KB en la API (2MB en `/api/sync`).
- Rate-limit 20 req/min/sesión + presupuesto diario en DynamoDB.
- IAM mínimo: la Lambda solo puede leer `/linguadev/ai/*` y CRUD sobre su tabla.

## Cómo continuar

Cada feature en `apps/web/src/features/` tiene comentario de qué falta en la fase correspondiente. Los tipos y contratos están fijos en `packages/shared`, así que ampliar el backend no rompe el frontend mientras se respete el esquema Zod.
