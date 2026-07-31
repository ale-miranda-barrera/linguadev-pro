import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './lib/env.js';
import { healthRouter } from './routes/health.js';
import { contentRouter } from './routes/content.js';
import { syncRouter } from './routes/sync.js';
import { aiRouter } from './routes/ai.js';
import { tutorRouter } from './routes/tutor.js';
import { chatRouter } from './routes/chat.js';

export function buildApp() {
  const app = new Hono();

  app.use('*', cors({
    origin: env.corsAllowedOrigins.length && env.corsAllowedOrigins[0] === '*' ? '*' : env.corsAllowedOrigins,
    allowHeaders: ['content-type', 'x-session-id', 'x-request-id'],
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    maxAge: 3600,
  }));

  // Payload máximo (protección DoS): 200KB para todo excepto sync (más grande).
  app.use('*', async (c, next) => {
    const cl = Number(c.req.header('content-length') ?? 0);
    const isSync = c.req.path.startsWith('/api/sync');
    const cap = isSync ? 2_000_000 : 200_000;
    if (cl > cap) return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: `> ${cap} bytes` } }, 413);
    await next();
  });

  app.route('/', healthRouter);
  app.route('/', contentRouter);
  app.route('/', syncRouter);
  app.route('/', aiRouter);
  app.route('/', tutorRouter);
  app.route('/', chatRouter);

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'route not found' } }, 404));

  app.onError((err, c) => {
    console.error('[unhandled]', err);
    const message = env.isDev ? (err as Error).message || 'unexpected error' : 'unexpected error';
    return c.json({ error: { code: 'INTERNAL_ERROR', message } }, 500);
  });

  return app;
}
