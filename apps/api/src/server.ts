// Carga .env buscando primero en cwd, luego en la raíz del repo (dos niveles arriba).
// pnpm --filter cambia el cwd al package, así que sin esto no encontraría la .env del root.
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  if (existsSync(p)) {
    loadEnv({ path: p });
    break;
  }
}

import { serve } from '@hono/node-server';
import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const app = buildApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[linguadev-api] listening on http://localhost:${info.port}`);
  console.log(`[linguadev-api] AI_PROVIDER=${process.env.AI_PROVIDER ?? '(unset)'}`);
  console.log(`[linguadev-api] DDB_ENDPOINT=${process.env.DDB_ENDPOINT ?? '(prod AWS)'}`);
});
