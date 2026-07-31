import { extractJson } from '@linguadev/shared';
import type { AIProvider, ChatTurn } from './provider.js';

const API = 'https://api.anthropic.com/v1/messages';

export class AnthropicProvider implements AIProvider {
  name = 'anthropic';
  constructor(private apiKey: string) {}

  model() {
    return process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
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
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model(),
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const raw = body.content?.map((b) => b.text ?? '').join('') ?? '';
    return {
      raw,
      parsed: extractJson<T>(raw),
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
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
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model(),
        max_tokens: maxTokens,
        stream: true,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok || !res.body) throw new Error(`anthropic stream ${res.status}`);
    return await consumeAnthropicStream(res.body, onToken);
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
    // Anthropic requiere que los mensajes alternen user/assistant y no acepta 'system' en el array.
    const res = await fetch(API, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model(),
        max_tokens: maxTokens,
        stream: true,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok || !res.body) {
      const detail = res.body ? await res.text().catch(() => '') : '';
      throw new Error(`anthropic stream ${res.status}: ${detail.slice(0, 200)}`);
    }
    return await consumeAnthropicStream(res.body, onToken);
  }
}

async function consumeAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onToken: (chunk: string) => void,
): Promise<{ usage: { inputTokens?: number; outputTokens?: number } }> {
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
          type?: string;
          delta?: { text?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        };
        if (evt.type === 'content_block_delta' && evt.delta?.text) onToken(evt.delta.text);
        if (evt.usage) {
          inputTokens = evt.usage.input_tokens ?? inputTokens;
          outputTokens = evt.usage.output_tokens ?? outputTokens;
        }
        if (evt.message?.usage) {
          inputTokens = evt.message.usage.input_tokens ?? inputTokens;
          outputTokens = evt.message.usage.output_tokens ?? outputTokens;
        }
      } catch {
        // línea corrupta — ignorar
      }
    }
  }
  return { usage: { inputTokens, outputTokens } };
}
