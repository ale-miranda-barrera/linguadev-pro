import { Hono } from 'hono';

export const healthRouter = new Hono();

healthRouter.get('/api/health', (c) => {
  return c.json({
    ok: true,
    service: 'linguadev-api',
    time: new Date().toISOString(),
    runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'node',
    node: process.version,
  });
});
