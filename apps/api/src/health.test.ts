import { describe, it, expect } from 'vitest';
import { buildApp } from './app.js';

describe('GET /api/health', () => {
  it('responde ok con timestamp', async () => {
    const app = buildApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; time: string };
    expect(body.ok).toBe(true);
    expect(new Date(body.time).toString()).not.toBe('Invalid Date');
  });

  it('404 uniforme en ruta desconocida', async () => {
    const app = buildApp();
    const res = await app.request('/api/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
