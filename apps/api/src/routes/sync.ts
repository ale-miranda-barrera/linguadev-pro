import { Hono } from 'hono';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SyncStateSchema } from '@linguadev/shared';
import { ddb, TABLE } from '../lib/ddb.js';
import { apiError } from '../lib/errors.js';

export const syncRouter = new Hono();

// GET /api/sync?userId=... — recupera el snapshot local-first.
syncRouter.get('/api/sync', async (c) => {
  const userId = c.req.query('userId');
  if (!userId) return apiError(c, 'VALIDATION_ERROR', 'userId required', 400);
  const out = await ddb().send(
    new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: 'PROFILE' } }),
  );
  if (!out.Item) return c.json({ state: null }, 200);
  return c.json({ state: out.Item.state });
});

// PUT /api/sync — respalda el snapshot local con last-write-wins por `version`.
syncRouter.put('/api/sync', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.userId !== 'string') {
    return apiError(c, 'VALIDATION_ERROR', 'userId + state required', 400);
  }
  const parsed = SyncStateSchema.safeParse(body.state);
  if (!parsed.success) {
    return apiError(c, 'VALIDATION_ERROR', 'invalid state', 400, parsed.error.flatten());
  }
  const client = ddb();
  const existing = await client.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `USER#${body.userId}`, SK: 'PROFILE' } }),
  );
  const currentVersion = (existing.Item?.state as { version?: number } | undefined)?.version ?? 0;
  if (parsed.data.version < currentVersion) {
    return c.json({ ok: false, reason: 'stale', currentVersion }, 409);
  }
  await client.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `USER#${body.userId}`, SK: 'PROFILE', state: parsed.data },
    }),
  );
  return c.json({ ok: true, version: parsed.data.version });
});
