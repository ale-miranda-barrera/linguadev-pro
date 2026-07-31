import type { MiddlewareHandler } from 'hono';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/ddb.js';
import { env, type HonoEnv } from '../lib/env.js';
import { apiError } from '../lib/errors.js';

// Fallback in-memory para dev sin DDB. En prod (Lambda) DDB siempre debe estar.
const memorySpend = new Map<string, number>();

// Presupuesto de IA por sesión/día. Fail-open si DDB no está: no cobra pero no bloquea.
export const budgetGuard: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const sessionId = c.req.header('x-session-id') ?? 'anon';
  const today = new Date().toISOString().slice(0, 10);
  const PK = `BUDGET#${sessionId}`;
  const SK = `DAY#${today}`;
  const memKey = `${sessionId}#${today}`;

  let ddbAvailable = true;
  try {
    const client = ddb();
    const cur = await client.send(new GetCommand({ TableName: TABLE, Key: { PK, SK } }));
    const spent = (cur.Item?.spentUsd as number | undefined) ?? 0;
    if (spent >= env.aiDailyBudgetUsd) {
      return apiError(c, 'BUDGET_EXCEEDED', 'AI daily budget exceeded for this session.', 402, {
        spentUsd: spent,
        limitUsd: env.aiDailyBudgetUsd,
      });
    }
    c.set('budgetKey', { PK, SK });
  } catch (err) {
    if (!isDdbUnavailable(err)) throw err;
    ddbAvailable = false;
    if (env.isDev) console.warn('[budget] DDB no disponible, usando memoria');
    const spent = memorySpend.get(memKey) ?? 0;
    if (spent >= env.aiDailyBudgetUsd) {
      return apiError(c, 'BUDGET_EXCEEDED', 'AI daily budget exceeded (memory).', 402, {
        spentUsd: spent,
        limitUsd: env.aiDailyBudgetUsd,
      });
    }
    c.set('budgetKey', { PK, SK });
  }

  await next();

  const spend = c.get('aiSpendUsd');
  if (typeof spend === 'number' && spend > 0) {
    if (ddbAvailable) {
      try {
        await ddb().send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK, SK },
            UpdateExpression: 'ADD spentUsd :s SET #ttl = :ttl',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':s': spend,
              ':ttl': Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3,
            },
          }),
        );
      } catch {
        memorySpend.set(memKey, (memorySpend.get(memKey) ?? 0) + spend);
      }
    } else {
      memorySpend.set(memKey, (memorySpend.get(memKey) ?? 0) + spend);
    }
  }
};

// Igual que en rate-limit.ts — detecta si el error del SDK AWS es "DDB no disponible".
// El nombre del error viene en `err.name`, no siempre en el message.
function isDdbUnavailable(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string; __type?: string };
  const marker = `${e?.code ?? ''} ${e?.name ?? ''} ${e?.__type ?? ''} ${e?.message ?? ''}`;
  return /ECONNREFUSED|NetworkingError|UnrecognizedClient|InvalidSignature|CredentialsProviderError|ResourceNotFoundException|AccessDenied|TimeoutError/i.test(
    marker,
  );
}
