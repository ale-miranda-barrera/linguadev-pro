import type { MiddlewareHandler } from 'hono';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/ddb.js';
import { env } from '../lib/env.js';
import { apiError } from '../lib/errors.js';

// Fallback in-memory para dev cuando DDB no está disponible.
// En Lambda (stateless) esto no serviría, pero en dev evita bloquear la app.
const memoryCounters = new Map<string, { count: number; expiresAt: number }>();

function memoryLimit(key: string, limit: number, windowMs: number): { blocked: boolean; retryAfterMs: number } {
  const now = Date.now();
  const cur = memoryCounters.get(key);
  if (!cur || cur.expiresAt < now) {
    memoryCounters.set(key, { count: 1, expiresAt: now + windowMs });
    return { blocked: false, retryAfterMs: 0 };
  }
  cur.count += 1;
  if (cur.count > limit) return { blocked: true, retryAfterMs: cur.expiresAt - now };
  return { blocked: false, retryAfterMs: 0 };
}

export const rateLimitAI: MiddlewareHandler = async (c, next) => {
  const sessionId = c.req.header('x-session-id') ?? 'anon';
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const PK = `RL#${sessionId}`;
  const SK = `MIN#${minute}`;

  try {
    const client = ddb();
    const cur = await client.send(new GetCommand({ TableName: TABLE, Key: { PK, SK } }));
    const count = ((cur.Item?.count as number | undefined) ?? 0) + 1;
    if (count > env.aiRateLimitPerMin) {
      return apiError(c, 'RATE_LIMITED', 'Too many requests, slow down.', 429, {
        retryAfterMs: 60_000 - (now % 60_000),
      });
    }
    await client.send(
      new PutCommand({
        TableName: TABLE,
        Item: { PK, SK, count, ttl: Math.floor(now / 1000) + 120 },
      }),
    );
    await next();
  } catch (err) {
    // DDB inaccesible (dev sin Docker, red caída, creds AWS erróneas...).
    // Fallback: contador en memoria. NO reventamos el request — un rate-limit degradado es mejor que 500.
    if (!isDdbUnavailable(err)) throw err;
    if (env.isDev) {
      console.warn('[rate-limit] DDB no disponible, usando contador en memoria');
    }
    const key = `${sessionId}#${minute}`;
    const r = memoryLimit(key, env.aiRateLimitPerMin, 60_000);
    if (r.blocked) {
      return apiError(c, 'RATE_LIMITED', 'Too many requests (memory limiter).', 429, {
        retryAfterMs: r.retryAfterMs,
      });
    }
    await next();
  }
};

// Detecta si un error del SDK de AWS es "DDB no disponible" para hacer fallback silencioso.
// Cubre: ECONNREFUSED (Docker apagado), problemas de red, credenciales inválidas
// (UnrecognizedClientException/InvalidSignatureException), tabla inexistente, o AccessDenied.
// El nombre viene en `err.name`, el message rara vez contiene el código.
function isDdbUnavailable(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string; __type?: string };
  const code = e?.code ?? '';
  const name = e?.name ?? '';
  const type = e?.__type ?? '';
  const msg = e?.message ?? '';
  const marker = `${code} ${name} ${type} ${msg}`;
  return /ECONNREFUSED|NetworkingError|UnrecognizedClient|InvalidSignature|CredentialsProviderError|ResourceNotFoundException|AccessDenied|TimeoutError/i.test(
    marker,
  );
}
