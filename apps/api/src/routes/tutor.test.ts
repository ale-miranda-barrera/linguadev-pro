import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../app.js';
import { setProviderForTests } from '../services/ai/provider.js';
import type { AIProvider } from '../services/ai/provider.js';

function fakeProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    name: 'fake',
    model: () => 'fake-model-1',
    isConfigured: async () => true,
    completeJson: async <T>() => ({ raw: '{}', parsed: {} as T, usage: {} }),
    streamText: async (opts: { onToken: (t: string) => void }) => {
      for (const chunk of ['Hello', ' ', 'from', ' ', 'tutor']) opts.onToken(chunk);
      return { usage: { inputTokens: 2, outputTokens: 3 } };
    },
    streamMessages: async () => ({ usage: {} }),
    ...overrides,
  };
}

async function readSse(res: Response): Promise<Array<{ event: string; data: string }>> {
  const text = await res.text();
  const events: Array<{ event: string; data: string }> = [];
  for (const raw of text.split('\n\n')) {
    if (!raw.trim()) continue;
    let event = 'message';
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      // Según la spec SSE, el primer espacio después de "data:" es separador y se elimina;
      // los espacios siguientes son contenido y NO se pueden hacer trim (perdería tokens como " ").
      else if (line.startsWith('data: ')) data += line.slice(6);
      else if (line.startsWith('data:')) data += line.slice(5);
    }
    events.push({ event, data });
  }
  return events;
}

describe('POST /api/ai/tutor (regresión SSE)', () => {
  beforeEach(() => setProviderForTests(fakeProvider()));
  afterEach(() => setProviderForTests(undefined));

  it('streamea via streamText y termina con evento done', async () => {
    const app = buildApp();
    const res = await app.request('/api/ai/tutor', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'tutor-t' },
      body: JSON.stringify({
        sessionId: 'sid-1',
        level: 'B1',
        scenario: 'Casual chat',
        turns: [{ role: 'user', text: 'hello' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = await readSse(res);
    const tokens = events.filter((e) => e.event === 'token').map((e) => e.data);
    expect(tokens.join('')).toBe('Hello from tutor');
    expect(events.some((e) => e.event === 'done')).toBe(true);
  });

  it('valida el request', async () => {
    const app = buildApp();
    const res = await app.request('/api/ai/tutor', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 't' },
      body: JSON.stringify({ level: 'X' }),
    });
    expect(res.status).toBe(400);
  });

  it('503 sin provider configurado', async () => {
    setProviderForTests(fakeProvider({ isConfigured: async () => false }));
    const app = buildApp();
    const res = await app.request('/api/ai/tutor', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 't' },
      body: JSON.stringify({
        sessionId: 'sid-1',
        level: 'B1',
        scenario: 'Casual chat',
        turns: [{ role: 'user', text: 'hello' }],
      }),
    });
    expect(res.status).toBe(503);
  });

  it('descuenta budget: segunda call rechazada si la primera excedió (regresión)', async () => {
    // Provider fake que reporta usage enorme para forzar exceso de budget en una sola call.
    // Antes del fix, tutor.ts descartaba el usage y este test no fallaba nunca.
    setProviderForTests(
      fakeProvider({
        streamText: async (opts: { onToken: (t: string) => void }) => {
          opts.onToken('Hi');
          // 1M tokens output * $15/M = $15, muy por encima del budget default de $1.
          return { usage: { inputTokens: 500_000, outputTokens: 1_000_000 } };
        },
      }),
    );
    process.env.AI_DAILY_BUDGET_USD = '1';
    const sessionId = `tut-budget-${Date.now()}`;
    const app = buildApp();
    const body = JSON.stringify({
      sessionId: 'sid-1',
      level: 'B1',
      scenario: 'chat',
      turns: [{ role: 'user', text: 'hi' }],
    });
    // 1ª call: pasa, gasta ~$16.5
    const first = await app.request('/api/ai/tutor', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
      body,
    });
    expect(first.status).toBe(200);
    await first.text();
    // 2ª call con la misma x-session-id: budget guard debe rechazar antes de streamear.
    const second = await app.request('/api/ai/tutor', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
      body,
    });
    expect(second.status).toBe(402);
    const json = (await second.json()) as { error: { code: string } };
    expect(json.error.code).toBe('BUDGET_EXCEEDED');
  });
});
