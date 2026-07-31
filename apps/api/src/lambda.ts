// Adaptador Lambda para Function URL. Rutas normales: handler estándar.
// Ruta /api/ai/tutor: usa awslambda.streamifyResponse (SSE) para streaming real.

import { buildApp } from './app.js';

const app = buildApp();

// Tipos mínimos para no depender de @types en el bundle.
type FnUrlEvent = {
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
};

function eventToRequest(evt: FnUrlEvent): Request {
  const method = evt.requestContext?.http?.method ?? 'GET';
  const path = evt.rawPath ?? evt.requestContext?.http?.path ?? '/';
  const qs = evt.rawQueryString ? `?${evt.rawQueryString}` : '';
  const url = `https://lambda.local${path}${qs}`;
  const headers = new Headers(evt.headers ?? {});
  let body: BodyInit | undefined;
  if (evt.body && method !== 'GET' && method !== 'HEAD') {
    body = evt.isBase64Encoded ? Buffer.from(evt.body, 'base64') : evt.body;
  }
  return new Request(url, { method, headers, body });
}

async function toApiGwResponse(res: Response) {
  const buf = Buffer.from(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return {
    statusCode: res.status,
    headers,
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
}

// @ts-expect-error awslambda es un global inyectado por el runtime de Lambda.
const streamifyResponse: undefined | ((h: unknown) => unknown) =
  typeof globalThis !== 'undefined' && (globalThis as { awslambda?: { streamifyResponse?: (h: unknown) => unknown } }).awslambda?.streamifyResponse;

async function handleStandard(event: FnUrlEvent) {
  const req = eventToRequest(event);
  const res = await app.fetch(req);
  return toApiGwResponse(res);
}

async function handleStream(event: FnUrlEvent, responseStream: NodeJS.WritableStream) {
  const req = eventToRequest(event);
  const res = await app.fetch(req);
  // Envuelve el stream con encabezados SSE.
  const httpMeta = {
    statusCode: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
    },
  };
  // @ts-expect-error awslambda.HttpResponseStream global
  const streamWithHeaders = globalThis.awslambda.HttpResponseStream.from(responseStream, httpMeta);
  if (!res.body) {
    streamWithHeaders.end();
    return;
  }
  const reader = res.body.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    streamWithHeaders.write(value);
  }
  streamWithHeaders.end();
}

// Handler unificado: si la ruta es del tutor, streamifica; si no, respuesta normal.
export const handler = streamifyResponse
  ? streamifyResponse(async (event: FnUrlEvent, responseStream: NodeJS.WritableStream) => {
      if ((event.rawPath ?? '').includes('/api/ai/tutor')) {
        await handleStream(event, responseStream);
        return;
      }
      const std = await handleStandard(event);
      const headers = std.headers;
      // @ts-expect-error awslambda.HttpResponseStream global
      const s = globalThis.awslambda.HttpResponseStream.from(responseStream, {
        statusCode: std.statusCode,
        headers,
      });
      s.write(Buffer.from(std.body, 'base64'));
      s.end();
    })
  : async (event: FnUrlEvent) => handleStandard(event);
