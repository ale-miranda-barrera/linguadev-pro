// Cliente SSE para /api/ai/tutor. Usa fetch + ReadableStream (EventSource no acepta POST).
// Parsea eventos "token" y "done" y "error" y los entrega al caller.

import { apiFetch } from './api.js';
import type { CEFRLevel } from '@linguadev/shared';

export interface TutorTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface StreamCallbacks {
  onToken: (chunk: string) => void;
  onDone?: () => void;
  onError?: (err: Error) => void;
}

export interface StreamHandle {
  abort: () => void;
  promise: Promise<void>;
}

export function streamTutor(
  payload: { sessionId: string; level: CEFRLevel; scenario: string; turns: TutorTurn[] },
  cb: StreamCallbacks,
): StreamHandle {
  const controller = new AbortController();

  const promise = (async () => {
    let res: Response;
    try {
      res = await apiFetch('/api/ai/tutor', {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      cb.onError?.(err as Error);
      return;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      cb.onError?.(new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`));
      return;
    }
    if (!res.body) {
      cb.onError?.(new Error('empty stream'));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // Cada evento SSE se separa por doble newline.
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          currentEvent = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
            // Spec SSE: el primer espacio tras "data:" es separador; el resto es contenido.
            // Con trim perdíamos tokens que son solo un espacio (bug de streaming visible en Voice Call).
            else if (line.startsWith('data: ')) data += line.slice(6);
            else if (line.startsWith('data:')) data += line.slice(5);
          }
          if (currentEvent === 'token') cb.onToken(data);
          else if (currentEvent === 'error') cb.onError?.(new Error(data));
          else if (currentEvent === 'done') cb.onDone?.();
        }
      }
      cb.onDone?.();
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') cb.onError?.(err as Error);
    }
  })();

  return { abort: () => controller.abort(), promise };
}
