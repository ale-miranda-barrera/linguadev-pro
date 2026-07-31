// Cliente SSE para /api/ai/chat. Fetch + ReadableStream + parser de eventos SSE.
// EventSource no sirve porque no acepta POST ni headers custom (x-session-id).

import { apiFetch, apiJson } from './api.js';
import type {
  ChatRequest,
  ChatMessage as ChatMessageSchema,
  AiStatusResponse,
  ChatPreset,
} from '@linguadev/shared';

export interface ChatStreamCallbacks {
  onToken: (chunk: string) => void;
  onDone?: (meta: { inputTokens: number | null; outputTokens: number | null; costUsd: number }) => void;
  onError?: (err: Error) => void;
}

export interface ChatStreamHandle {
  abort: () => void;
  promise: Promise<void>;
}

export function streamChat(
  payload: {
    conversationId: string;
    preset: ChatPreset;
    systemOverride?: string;
    messages: ChatMessageSchema[];
  },
  cb: ChatStreamCallbacks,
): ChatStreamHandle {
  const controller = new AbortController();

  const promise = (async () => {
    let res: Response;
    try {
      const body: ChatRequest = {
        conversationId: payload.conversationId,
        preset: payload.preset,
        systemOverride: payload.systemOverride,
        messages: payload.messages,
      };
      res = await apiFetch('/api/ai/chat', {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      cb.onError?.(err as Error);
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: { message?: string; code?: string } };
        if (j.error?.message) msg = `${j.error.code ?? 'ERR'}: ${j.error.message}`;
      } catch {
        if (text) msg = `${msg}: ${text.slice(0, 200)}`;
      }
      cb.onError?.(new Error(msg));
      return;
    }
    if (!res.body) {
      cb.onError?.(new Error('empty stream'));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneFired = false;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let ev = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            // Spec SSE: primer espacio tras "data:" es separador y se elimina;
            // los demás son contenido y no deben trimmearse (perdería tokens de un solo espacio).
            else if (line.startsWith('data: ')) data += line.slice(6);
            else if (line.startsWith('data:')) data += line.slice(5);
          }
          if (ev === 'token') cb.onToken(data);
          else if (ev === 'error') cb.onError?.(new Error(data));
          else if (ev === 'done') {
            doneFired = true;
            try {
              const meta = JSON.parse(data || '{}') as {
                inputTokens?: number | null;
                outputTokens?: number | null;
                costUsd?: number;
              };
              cb.onDone?.({
                inputTokens: meta.inputTokens ?? null,
                outputTokens: meta.outputTokens ?? null,
                costUsd: meta.costUsd ?? 0,
              });
            } catch {
              cb.onDone?.({ inputTokens: null, outputTokens: null, costUsd: 0 });
            }
          }
        }
      }
      if (!doneFired) cb.onDone?.({ inputTokens: null, outputTokens: null, costUsd: 0 });
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') cb.onError?.(err as Error);
    }
  })();

  return { abort: () => controller.abort(), promise };
}

export async function fetchAiStatus(): Promise<AiStatusResponse> {
  return apiJson<AiStatusResponse>('/api/ai/status');
}

export async function generateChatTitle(messages: ChatMessageSchema[]): Promise<string> {
  const r = await apiJson<{ title: string }>('/api/ai/chat/title', {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
  return r.title;
}
