import { Hono } from 'hono';
import { validatePack } from '@linguadev/content';

export const contentRouter = new Hono();

contentRouter.post('/api/content/validate', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'invalid JSON body' } }, 400);
  }
  const r = validatePack(body);
  if (!r.ok) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: r.error, details: r.issues } }, 400);
  }
  return c.json({ ok: true, pack: r.pack });
});
