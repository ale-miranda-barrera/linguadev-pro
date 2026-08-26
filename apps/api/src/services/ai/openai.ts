import { extractJson } from '@linguadev/shared';
import type { AIProvider, ChatTurn } from './provider.js';

const API = 'https://api.openai.com/v1/chat/completions';

export class OpenAIProvider implements AIProvider {
  name = 'openai';
  constructor(private apiKey: string) {}
  model() {
    return process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  }
  async isConfigured() {
    return !!this.apiKey;
  }

  async completeJson<T>({
    system,
    user,
    maxTokens = 1024,
    signal,
  }: {
    system: string;
    user: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }) {
    const res = await fetch(API, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model(),
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = body.choices?.[0]?.message?.content ?? '';
    return {
      raw,
      parsed: extractJson<T>(raw),
      usage: {
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
      },
    };
  }

  async streamText({
    system,
    user,
    maxTokens = 1024,
    signal,
    onToken,
  }: {
    system: string;
    user: string;
    maxTokens?: number;
    signal?: AbortSignal;
    onToken: (chunk: string) => void;
  }) {
    const res = await fetch(API, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model(),
        max_tokens: maxTokens,
        stream: true,
        // Sin include_usage el final chunk no trae prompt_tokens/completion_tokens
        // → budget guard no descuenta y el user puede exceder su presupuesto diario.
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok || !res.body) throw new Error(`openai stream ${res.status}`);
    return await consumeOpenAiStream(res.body, onToken);
  }

  async streamMessages({
    system,
    messages,
    maxTokens = 1024,
    signal,
    onToken,
  }: {
    system: string;
    messages: ChatTurn[];
    maxTokens?: number;
    signal?: AbortSignal;
    onToken: (chunk: string) => void;
  }) {
    const res = await fetch(API, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model(),
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: system },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
    });
    if (!res.ok || !res.body) {
      const detail = res.body ? await res.text().catch(() => '') : '';
      throw new Error(`openai stream ${res.status}: ${detail.slice(0, 200)}`);
    }
    return await consumeOpenAiStream(res.body, onToken);
  }
}

// Parser SSE compartido para Chat Completions. Extrae deltas y usage final.
async function consumeOpenAiStream(
  body: ReadableStream<Uint8Array>,
  onToken: (chunk: string) => void,
): Promise<{ usage?: { inputTokens?: number; outputTokens?: number } }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const t = evt.choices?.[0]?.delta?.content;
        if (t) onToken(t);
        if (evt.usage) {
          inputTokens = evt.usage.prompt_tokens ?? inputTokens;
          outputTokens = evt.usage.completion_tokens ?? outputTokens;
        }
      } catch {
        // línea corrupta — ignorar
      }
    }
  }
  return { usage: { inputTokens, outputTokens } };
}
