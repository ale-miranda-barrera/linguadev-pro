# Capítulo 14 — Latencia y routing: streaming, model routing, fallbacks

> **Focus:** TTFT vs total latency, streaming SSE vs polling, Lambda Response Streaming, model routing barato→caro, fallbacks entre providers, timeouts, retries con exponential backoff + jitter, circuit breakers, degradación gradual, provisioned vs on-demand, edge deployment.
> **Áreas:** Economía + inferencia + AI infra
> **Preguntas:** 20 · **Tiempo:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

### Pre-requisitos

- **Capítulo 07** — Timeouts, retries, circuit breakers, agent loops [→](./07-agent-loops-orchestration.md)
- **Capítulo 10** — Observability y tracing [→](./10-llm-observability-tracing.md)
- **Capítulo 13** — Prompt caching (afecta TTFT) [→](./13-inference-cost-prompt-caching.md)

### Glosario mínimo

| Término | Significado |
|---|---|
| **TTFT** | Time To First Token — latencia hasta el primer token del stream. Dominante en UX de chat. |
| **TPOT** | Time Per Output Token — velocidad de generación tras el TTFT. |
| **Total latency** | TTFT + `output_tokens · TPOT`. Dominante en batch/API. |
| **SSE** | Server-Sent Events — protocolo HTTP unidireccional para streaming. |
| **p50 / p95 / p99** | Percentiles de latencia. p99 revela el peor 1%. |
| **Circuit breaker** | Deja de intentar tras N failures; recovery test periódico. |
| **Fallback** | Provider secundario si el primario falla. |
| **Cold vs warm** | Cold: modelo debe cargarse (30s-5min). Warm: sub-second TTFT. |

### Setup

```bash
# TypeScript / Node (Vercel AI SDK 5)
pnpm add ai@^5 @ai-sdk/anthropic @ai-sdk/openai zod

# Python
pip install "anthropic>=0.40.0" "openai>=1.60.0" "tenacity>=9.0" "pybreaker>=1.2"

# CLI para medir p50/p95/p99
brew install hey  # macOS
# o: go install github.com/rakyll/hey@latest
```

---

## 1. El gran cuadro

En una app LLM en producción de 2026, **la latencia mata más UX que la calidad marginal**. Un chat que tarda 8 segundos en empezar a responder pierde al usuario aunque la respuesta sea excelente. Nielsen (1993) sigue vigente: <100ms se percibe instantáneo, <1s mantiene el flujo, >10s el usuario abandona. Los benchmarks de Artificial Analysis en 2026 muestran TTFT medianos de 300-800ms en Claude/GPT/Gemini y hasta 100-200ms en Groq/Cerebras — pero p99 puede llegar a 4-8s en spikes de tráfico si no diseñas para ello.

La primera decisión es separar **TTFT vs total latency**. TTFT es lo que domina en chat con streaming: en cuanto el usuario ve texto apareciendo, siente que el sistema "está pensando". La total latency (TTFT + generación completa) importa en APIs internas, tools de agente, o cualquier consumidor que necesite la respuesta entera antes de proceder. Optimizar TTFT (streaming, prompt caching que reduce prefill, model routing) tiene el mayor ROI de UX en chat.

**Streaming vía SSE** es el mecanismo estándar. Es HTTP unidireccional (server → cliente) con `text/event-stream`; encaja perfectamente con LLMs (solo el server emite tokens), sobrevive detrás de proxies, tiene reconexión automática por spec del `EventSource`. OpenAI, Anthropic, Google y Bedrock exponen streaming SSE nativamente. Detalles críticos: **Lambda tradicional no soporta streaming** (buffea la respuesta hasta terminar), necesitas **Lambda Response Streaming** (AWS, 2023) con `awslambda.streamifyResponse` y `RESPONSE_STREAM` invocation mode. **NGINX/Cloudflare/CDNs** buferan por default → SSE roto silencioso; configura `proxy_buffering off` y headers `X-Accel-Buffering: no`.

**Model routing** es la palanca de latencia paralela al cost routing del cap 13. Un router pequeño (Haiku 4.5, Gemini Flash-Lite, GPT-5 nano) clasifica la query, decide tier apropiado, y solo escala a Sonnet/Opus si la complejidad lo justifica. Reducciones típicas: latencia media -50-70%, coste -60-80%, sin caída perceptible de calidad. Existen routers managed: **OpenRouter** (marketplace + auto-routing), **NotDiamond** (predictor de mejor modelo por query), **Martian** (LLM router optimizado), **RouteLLM** (LMSYS, académico).

**Fallbacks entre providers** son requisito de disponibilidad en 2026. Anthropic ha tenido incidents visibles varias veces en 2024-2025; sin fallback, tu app cae con ellos. Con **Vercel AI SDK 5** (SSE estándar, provider registry, fallback trivial) o **LiteLLM** (proxy unified con retries + fallback), pasar de Claude Sonnet a GPT-5.4 en un 503 es una línea de config. **Circuit breakers** (resilience4j Java, pybreaker Python, opossum Node) evitan bombardear un provider caído y permiten fail-fast al fallback.

Y encima: **timeouts explícitos** en cada call (30s chat, 60-120s no-stream, 5-30min agentes con checkpoint), **retries idempotentes con exponential backoff + jitter** (respeta `Retry-After` en 429), **rate-limit headers**, **Bedrock cross-region inference profiles** (routing automático entre regiones), **speculative decoding** (interno del provider — Groq, vLLM 0.6+ lo usan; sube TPS 2-3x), **degradación gradual** (respuesta parcial + link a soporte > HTTP 500), **provisioned throughput** para SLO estricto, **edge deployment** (Cloudflare Workers AI, Vercel Edge) para users lejanos, y **métricas p50/p95/p99** — la media es una mentira útil, el p99 es lo que perciben tus power users.

---

## 2. Fundamentos (básico)

### 2.1. TTFT vs TPOT vs Total latency

```
Total latency = TTFT + (output_tokens · TPOT)

TTFT   (Time To First Token)   — prefill del prompt + primer token
TPOT   (Time Per Output Token) — velocidad de generación tras el primero
```

Ejemplo Sonnet 4.6 típico (agosto 2026, no-cache):
- Prompt 5k tokens → TTFT ~800ms.
- TPOT ~15ms/token → 300 tokens = 4.5s.
- Total = 5.3s. Pero con streaming el usuario ve el primer token en 0.8s.

Con prompt caching sobre 4.5k del prompt: TTFT baja a ~200-400ms (menos prefill), TPOT igual. UX percibida mejora significativamente.

**Regla:** en chat, TTFT es la métrica. En agente sin UI intermedio, total es la métrica. Mide ambas separadas.

### 2.2. SSE — el protocolo estándar

Cada evento del stream es:
```
data: {"delta": "Hola"}

data: {"delta": " mundo"}

data: [DONE]
```

- Bloque `data:` seguido de dos `\n\n`.
- Content-Type: `text/event-stream`.
- Cliente estándar: `EventSource` (navegador) o `fetch` con `ReadableStream` (Node/Bun/Deno).

Anthropic usa formato `event:` + `data:`:
```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hola"}}
```

OpenAI usa formato más simple:
```
data: {"choices":[{"delta":{"content":"Hola"}}]}
```

**Vercel AI SDK 5** (2026) migró a SSE estándar (breaking change desde v4); output uniforme independientemente del provider — su gran valor.

### 2.3. Timeouts básicos

| Uso | Timeout recomendado |
|---|---:|
| Chat individual streaming | 60 s |
| Chat non-streaming | 120 s |
| Tool call individual | 10-30 s |
| Agente completo (multi-step) | 5-30 min con checkpoint |
| Embedding batch | 60 s por llamada |

Sin timeouts: request cuelga forever, thread pool agotado, cascada de fallos.

### 2.4. Retries — solo idempotentes, con backoff+jitter

```python
# Ejemplo mínimo con tenacity (Python)
from tenacity import retry, stop_after_attempt, wait_exponential_jitter, retry_if_exception_type
from anthropic import APIStatusError

@retry(
    stop=stop_after_attempt(4),
    wait=wait_exponential_jitter(initial=1, max=30, jitter=2),
    retry=retry_if_exception_type((APIStatusError,)),  # solo transitorios
)
def call_llm(prompt: str) -> str:
    return client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=500,
        messages=[{"role": "user", "content": prompt}],
    ).content[0].text
```

**Retry sí para:** 429 (respeta `Retry-After`), 5xx, timeout de red.
**Retry NO para:** 4xx (400/401/403 — bug del cliente), content policy violation.

Sin **jitter**, un cluster entero reintenta en el mismo instante = thundering herd al provider en recovery.

### 2.5. Fallback simple entre providers

```typescript
// Vercel AI SDK 5 — fallback Claude → GPT
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';

async function askWithFallback(prompt: string) {
  try {
    return await streamText({
      model: anthropic('claude-sonnet-4-6'),
      prompt,
      abortSignal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.warn('Anthropic falló, fallback a GPT-5.4:', err);
    return await streamText({
      model: openai('gpt-5.4'),
      prompt,
      abortSignal: AbortSignal.timeout(60_000),
    });
  }
}
```

### 2.6. Analogías mentales

- **Streaming SSE = ver la película mientras se descarga (progresivo) vs esperar a que baje entera.** El usuario percibe respuesta desde el primer token; sin streaming, la pantalla queda en "..." 5-8 segundos.
- **Model routing = load balancer para modelos.** Igual que un LB distribuye HTTP requests entre backends (round-robin, weighted, latency-based), un router LLM distribuye queries entre modelos (por complejidad, latency SLO, cost budget).
- **Circuit breaker = fusible eléctrico de tu casa.** Cuando detecta sobrecarga (5 fallos), abre el circuito para proteger downstream; tras un tiempo (60s), permite un "half-open probe" para ver si el problema pasó.
- **Fallback = plan B del piloto.** No es "por si acaso"; es requisito operacional. Cada aerolínea tiene protocolo de fallback ante fallo de motor; cada app LLM debe tener fallback ante 503 del provider.
- **TTFT vs total latency = respuesta del camarero vs traer la comida.** El usuario tolera espera a la comida si el camarero ya reconoció el pedido; sin streaming, ambos parecen el mismo silencio.

### 2.7. Desglose paso a paso: qué pasa en un request streaming detrás del telón

1. **Cliente envía POST /api/chat** con `{"prompt": "..."}` sobre HTTPS keep-alive.
2. **Server recibe**, valida, prepara la llamada al provider.
3. **Server llama al provider en streaming mode** (`stream=True` o `client.messages.stream`).
4. **Provider ejecuta prefill** (procesa el prompt entero). Duración: 200-1500ms según longitud (menos con cache hit).
5. **Provider genera el primer token** y lo emite. **TTFT termina aquí.**
6. **Server recibe el primer chunk**, lo transforma a formato SSE (`data: {"text": "H"}\n\n`), lo escribe al `responseStream`.
7. **Cliente `EventSource` recibe** y renderiza. Usuario ve la primera letra.
8. **Loop:** provider emite tokens (uno cada ~10-30ms según TPOT); server los transforma y forward; cliente los pinta.
9. **Provider emite `stop_reason: end_turn`;** server escribe `data: [DONE]\n\n` y cierra el stream.
10. **Cliente cierra** `EventSource`.

Puntos frágiles: (a) si un proxy entre server y cliente bufferea, el usuario ve todo al final (streaming roto silencioso); (b) si el server no propaga backpressure, requests lentos acumulan memoria; (c) si el `abortSignal` no está conectado a la desconexión del cliente, el server sigue quemando tokens de un stream que nadie escucha.

### 2.8. Mini-código: medir TTFT desde `curl`

```bash
# ttft.sh — mide TTFT y total latency de un endpoint streaming
curl -N -X POST https://api.tu-app.com/api/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt":"cuenta hasta 5"}' \
  --max-time 30 \
  --trace-time 2>&1 | awk '
    /data:/ && !first { first = $1; print "TTFT@" first }
    END              { print "END@"  $1 }
  '
```

Para p50/p95/p99, envuelve en un loop:

```bash
for i in {1..100}; do
  ttft_ms=$( { time curl -sN ... > /dev/null; } 2>&1 | grep real )
  echo "$i,$ttft_ms" >> ttft.csv
done
# Luego: sort ttft.csv | percentiles (p50, p95, p99)
```

---

## 3. Cómo funciona por dentro (medio)

### 3.1. Streaming SSE en Lambda — el trap más común

**Lambda tradicional buferea la respuesta entera antes de devolverla al cliente.** Consecuencia: `text/event-stream` no funciona — el cliente ve todo al final o timeout.

Solución (2023+): **Lambda Response Streaming** con `awslambda.streamifyResponse` y `Function URL` en `RESPONSE_STREAM` mode.

```javascript
// index.mjs — Lambda con Response Streaming (Node 20+)
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export const handler = awslambda.streamifyResponse(
  async (event, responseStream, _context) => {
    const { prompt } = JSON.parse(event.body);

    // Metadata: content-type SSE, sin buffering
    const metadata = {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);

    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        responseStream.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }
    responseStream.write('data: [DONE]\n\n');
    responseStream.end();
  }
);
```

Configuración adicional:
- Function URL con `Invoke Mode: RESPONSE_STREAM`.
- IAM: `lambda:InvokeFunctionUrl` con `FunctionUrlAuthType: NONE` (o `AWS_IAM` con SigV4).
- CloudFront/ALB frontends: verificar streaming enabled y `Origin Response Timeout` > 60s.

### 3.2. Proxies y SSE — configuración necesaria

| Componente | Config para SSE |
|---|---|
| **NGINX** | `proxy_buffering off; proxy_cache off; proxy_read_timeout 600s; chunked_transfer_encoding on;` |
| **Cloudflare** | Response Buffering: off; usar Workers en vez de rules; timeout upstream ≥100s |
| **AWS ALB** | Idle timeout ≥300s; HTTP/2 enabled; no buffering (default OK) |
| **CloudFront** | Streaming distributions; response timeout hasta 60s (soft limit; contactar support para más) |
| **API Gateway REST** | NO soporta streaming — usa Function URL o WebSocket API |
| **API Gateway HTTP** | Buffering; considera Lambda Function URL directo |

**Header universal:** `X-Accel-Buffering: no` desactiva buffering en NGINX y varios CDNs.

### 3.3. Model routing — patrón cheap-first

```python
# router.py — clasificador barato decide tier
from openai import OpenAI

client = OpenAI()

CLASSIFIER_MODEL = "gpt-5-nano"
CHEAP_MODEL      = "gpt-5.4"     # ~$2.50/M input
EXPENSIVE_MODEL  = "gpt-5.5"     # ~$5.00/M input, reasoning

def classify_complexity(query: str) -> str:
    """Devuelve 'simple' | 'complex'."""
    r = client.responses.create(
        model=CLASSIFIER_MODEL,
        input=[
            {"role": "system", "content": "Clasifica la query como 'simple' (FAQ, factual) o 'complex' (razonamiento, multi-step, análisis)."},
            {"role": "user", "content": query},
        ],
        max_output_tokens=10,
    )
    return "complex" if "complex" in r.output_text.lower() else "simple"

def route_and_answer(query: str) -> str:
    tier = classify_complexity(query)
    model = EXPENSIVE_MODEL if tier == "complex" else CHEAP_MODEL
    r = client.responses.create(model=model, input=query)
    return r.output_text
```

Métricas a trackear: `router.classification.time`, `router.hit_rate_cheap`, `router.calidad_score_by_tier`. Si el clasificador se equivoca demasiado, ajusta el prompt o usa un fine-tuned classifier.

**Alternativa managed**: OpenRouter, NotDiamond, Martian gestionan la lógica de routing.

### 3.4. Fallback entre providers con adapter unified

**LiteLLM** en Python actúa como proxy que traduce entre APIs y gestiona fallback:

```python
from litellm import completion

response = completion(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Explica RAG."}],
    fallbacks=["gpt-5.4", "gemini/gemini-3.6-flash"],
    timeout=60,
    num_retries=2,
)
```

LiteLLM traduce el request al formato correcto de cada provider, aplica retries con backoff, y cae al siguiente si el actual falla ≥N veces.

### 3.5. Circuit breaker

```python
import pybreaker
import anthropic

anthropic_breaker = pybreaker.CircuitBreaker(
    fail_max=5,               # tras 5 fallos consecutivos, abre
    reset_timeout=60,         # tras 60s, half-open (permite 1 prueba)
    exclude=[ValueError],     # errores del cliente no cuentan como fallo del provider
)

client = anthropic.Anthropic()

@anthropic_breaker
def ask_anthropic(prompt: str) -> str:
    r = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=500,
        messages=[{"role": "user", "content": prompt}],
    )
    return r.content[0].text

# Uso
try:
    ans = ask_anthropic("¿Qué es SSE?")
except pybreaker.CircuitBreakerError:
    # Circuit abierto: pasa directo a fallback sin llamar
    ans = ask_openai_fallback("¿Qué es SSE?")
```

Beneficios: no bombardeas provider caído, latencia percibida no explota, fallback rápido.

### 3.6. Bedrock cross-region inference profiles

AWS Bedrock (2024, GA 2025) permite inference profiles que sirven requests desde múltiples regiones automáticamente. Ejemplo: profile `us.anthropic.claude-sonnet-4-6-*` puede routear entre `us-east-1`, `us-west-2`, `us-east-2`. Cuando una región está congestionada, la request se sirve desde otra transparente.

```python
import boto3

bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")

response = bedrock.invoke_model(
    modelId="us.anthropic.claude-sonnet-4-6",  # el "us." indica inference profile
    body=json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 500,
        "messages": [{"role": "user", "content": "Hola"}],
    }),
)
```

Habilitarlo baja p99 y sube availability sin código extra. Regiones típicas para inference profiles: `us.*`, `eu.*`, `apac.*`, `global.*`.

### 3.7. Métricas p50/p95/p99 — la media es una mentira

```python
import numpy as np

latencies_ms = [...]  # medidas de N requests
p50 = np.percentile(latencies_ms, 50)   # mediana — UX típica
p95 = np.percentile(latencies_ms, 95)   # "malos días" — 1 de cada 20 users
p99 = np.percentile(latencies_ms, 99)   # 1 de cada 100 — power users
```

SLO típico chat 2026: `TTFT p95 < 1500ms`, `TTFT p99 < 3000ms`, `Total p95 < 8000ms`.

Sin p99, tu "average is 800ms" oculta que el 1% peor tiene 15s.

### 3.8. Diagrama ASCII: flujo de request con fallback + circuit breaker

```
                  ┌─────────────┐
                  │   Cliente   │
                  └──────┬──────┘
                         │  POST /api/chat  (SSE)
                         ▼
                  ┌─────────────┐
                  │   Edge/CDN  │  (buffering OFF)
                  └──────┬──────┘
                         ▼
                  ┌─────────────┐
                  │   API       │
                  │   Gateway   │  (timeout 60s, HTTP/2)
                  └──────┬──────┘
                         ▼
                  ┌──────────────────────────┐
                  │  Server / Lambda         │
                  │  (streamifyResponse)     │
                  └──────┬───────────────────┘
                         │
                         ▼
              ┌──────────────────┐
              │ Circuit Breaker  │
              │   Anthropic      │
              └────┬─────────────┘
                   │ closed?  ──── yes ─► [Anthropic API]  ✅  primary
                   │
                   │ open?    ──── yes ─► [OpenAI API]     ⚠  fallback L2
                                              │
                                              │ 5xx?      ─► [Local Llama]  ⚠  fallback L3
                                                                 │
                                                                 │ 5xx?     ─► "Estamos con
                                                                                problemas. Prueba
                                                                                de nuevo."  ✅
```

Cada nivel de fallback debe ser más simple y más disponible que el anterior. La última capa nunca es otro LLM — es respuesta pre-canned o mensaje humano.

### 3.9. Ejemplo avanzado — streaming SSE + fallback cascada + timeout + circuit breaker

Combinando todo con AI SDK 4+ (2026):

```typescript
// route.ts — Next.js 15 App Router, edge runtime
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai }    from '@ai-sdk/openai';
import { ollama }    from 'ollama-ai-provider';
import CircuitBreaker from 'opossum';

export const runtime = 'edge';
export const maxDuration = 60;

const anthropicBreaker = new CircuitBreaker(
  async (prompt: string, signal: AbortSignal) =>
    streamText({ model: anthropic('claude-sonnet-4-6'), prompt, abortSignal: signal }),
  { timeout: 8_000, errorThresholdPercentage: 50, resetTimeout: 60_000 },
);

const openaiBreaker = new CircuitBreaker(
  async (prompt: string, signal: AbortSignal) =>
    streamText({ model: openai('gpt-5.4'), prompt, abortSignal: signal }),
  { timeout: 12_000, errorThresholdPercentage: 50, resetTimeout: 60_000 },
);

// Cascada: Anthropic → OpenAI → Local Llama → pre-canned
async function callCascade(prompt: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  const strategies = [
    () => anthropicBreaker.fire(prompt, controller.signal),
    () => openaiBreaker.fire(prompt, controller.signal),
    () => streamText({ model: ollama('llama-3.3-70b'), prompt, abortSignal: controller.signal }),
  ];

  for (const [i, strategy] of strategies.entries()) {
    try {
      const result = await strategy();
      clearTimeout(timer);
      return new Response(result.toDataStream(), {
        headers: {
          'Content-Type': 'text/event-stream',
          'X-Accel-Buffering': 'no',
          'X-LLM-Provider': ['anthropic', 'openai', 'ollama'][i],
        },
      });
    } catch (err) {
      console.warn(`[cascade] level ${i} failed:`, err);
    }
  }

  clearTimeout(timer);
  // Última capa: nunca devolvemos 500 seco
  return new Response(
    'data: {"text":"Estamos con problemas técnicos. Prueba en unos minutos o escribe a soporte@acme.com."}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

export async function POST(req: Request) {
  const { prompt } = await req.json();
  return callCascade(prompt);
}
```

**Bajo el capó — qué garantías da este código:**
- **Timeout global de 25s** (via AbortController): incluso si los 3 providers se cuelgan, no bloqueas más de 25s la conexión del cliente.
- **Timeout individual por provider** (via `CircuitBreaker`): 8s para Anthropic, 12s para OpenAI. Un provider lento no consume todo el budget.
- **Circuit breaker por provider**: si Anthropic falla 50% de las últimas requests, el breaker abre 60s y salta directo a OpenAI sin siquiera intentar.
- **Header `X-LLM-Provider`**: trazabilidad — sabes en logs qué provider sirvió cada respuesta.
- **Nunca HTTP 500 seco**: siempre devolvemos algo utilizable al cliente.

### 3.10. Bajo el capó — cómo funciona SSE en el kernel

Server-Sent Events es HTTP/1.1 con `Transfer-Encoding: chunked` (o HTTP/2 con framing). Cuando el server escribe `data: {"text":"H"}\n\n` al socket:

1. **Kernel socket buffer** acumula bytes.
2. Al llegar `\n\n` (delimitador SSE) o al llenarse un chunk, el kernel emite un TCP segment.
3. **TCP** (o QUIC en HTTP/3) transporta al cliente.
4. **Kernel del cliente** entrega al userspace via `read()`.
5. **Runtime del browser / Node** parsea el evento y dispatcha a `onmessage`.

Los proxies intermedios (NGINX, Envoy, Cloudflare) por default acumulan chunks en un buffer interno hasta llenarlo o hasta ver `EOF`. Ese buffering rompe SSE silenciosamente: el usuario ve toda la respuesta al final (o timeout). Configuración correcta:

- **NGINX:** `proxy_buffering off; proxy_cache off; chunked_transfer_encoding on; proxy_read_timeout 600s;`.
- **Envoy:** `stream_idle_timeout: 600s; per_request_config.buffer.disabled: true;`.
- **Cloudflare:** Response Buffering OFF en Page Rules, o mejor usa Workers (siempre streaming).
- **Header universal:** `X-Accel-Buffering: no` — NGINX y varios CDNs lo respetan.

Otro trap: **HTTP/2 multiplexing** ayuda porque no bloquea, pero si el server tarda >30s sin enviar bytes, el proxy asume conexión colgada y cierra. Envía `keep-alive` events cada 15-20s: `event: ping\ndata: keepalive\n\n`.

**Lambda Response Streaming** (2023) resuelve el trap de Lambda clásico que buffea la respuesta entera. `awslambda.streamifyResponse` expone un `writeableStream` que va emitiendo al `Function URL` de forma incremental. Requisitos: Node 20+, `Invoke Mode: RESPONSE_STREAM`, IAM correcto (`lambda:InvokeFunctionUrl`).

### 3.11. Tabla comparativa exhaustiva — latencia y throughput por provider (agosto 2026)

| Provider / Modelo | TTFT p50 | TTFT p95 | TTFT p99 | TPS medio | TPS peak | Ctx | Streaming |
|---|---:|---:|---:|---:|---:|---:|:---:|
| Anthropic Sonnet 4.6 | 500 ms | 1200 ms | 3500 ms | 80-120 | 140 | 1M | ✅ SSE |
| Anthropic Haiku 4.5 | 300 ms | 700 ms | 2000 ms | 130-180 | 220 | 400K | ✅ SSE |
| Anthropic Opus 4.8 | 750 ms | 1800 ms | 5000 ms | 55-80 | 110 | 1M | ✅ SSE |
| OpenAI GPT-5.4 | 500 ms | 1400 ms | 4000 ms | 90-140 | 180 | 400K | ✅ SSE |
| OpenAI GPT-5 nano | 200 ms | 500 ms | 1200 ms | 200-300 | 380 | 200K | ✅ SSE |
| Google Gemini 3.6 Flash | 350 ms | 900 ms | 2500 ms | 150-200 | 280 | 2M | ✅ SSE |
| Google Gemini Flash-Lite | 200 ms | 500 ms | 1400 ms | 250-350 | 420 | 1M | ✅ SSE |
| Groq Llama 3.3-70B | 250 ms | 500 ms | 900 ms | 500-800 | 950 | 128K | ✅ SSE |
| Cerebras Llama 3.3-70B | 200 ms | 400 ms | 700 ms | 1500-2200 | 2500 | 128K | ✅ SSE |
| Bedrock (any) cross-region | +50-100 ms | +100-200 ms | +200-500 ms | ≈ upstream | ≈ | ≈ | ✅ SSE |
| Cloudflare Workers AI (edge) | 100-300 ms | 400-600 ms | 800-1200 ms | 40-80 | 120 | 8-128K | ✅ SSE |

*Números de Artificial Analysis 2026 en carga moderada. En spikes puede degradarse 3-8×.*

---

## 4. Práctica avanzada (senior)

### 4.1. Speculative decoding — sube TPS 2-3x

Técnica interna del provider: un modelo pequeño (draft) propone k tokens; el grande (target) verifica en batch. Los aceptados se emiten, los rechazados se descartan. Sube TPS 2-3x sin cambio de calidad.

Providers que lo usan: **Groq LPU** (hardware acelerado), **vLLM 0.6+** con `--speculative-model`, **TensorRT-LLM**, y algunos servidores de OpenAI/Anthropic internamente.

No requiere config tuya salvo cuando self-hosteas. Sabe que existe cuando comparas TPS entre providers.

### 4.2. Groq / Cerebras — hardware especializado

- **Groq LPU** (Language Processing Unit): sirve Llama 3.3-70B a 500-1000 TPS (vs 30-100 típico). TTFT <300ms.
- **Cerebras WSE** (Wafer Scale Engine): 2000+ TPS en modelos suportados.
- **SambaNova RDU**: alternativa comparable.

Trade-offs: catálogo limitado (no todos los modelos), function calling en algunos casos limitado, streaming caveats. Ideal cuando TTFT/TPS es el KPI crítico y aceptas el modelo disponible.

### 4.3. Degradación gradual (graceful degradation)

Ante fallo cascada:

```python
def robust_answer(query: str) -> str:
    for strategy in [
        lambda: ask_primary_provider(query, timeout=10),
        lambda: ask_secondary_provider(query, timeout=10),
        lambda: ask_cached_similar(query),         # cache semántico
        lambda: retrieve_pre_canned_answer(query), # FAQs estáticos
    ]:
        try:
            return strategy()
        except Exception as e:
            log.warning(f"Strategy failed: {e}")
            continue
    return "Estoy con problemas técnicos. Prueba de nuevo en unos minutos o escribe a soporte@acme.com."
```

Nunca devuelvas HTTP 500 seco. Un fallback amable + link a soporte mantiene NPS mucho mejor.

### 4.4. Provisioned vs on-demand

| Modo | Cuándo |
|---|---|
| **On-demand** | Prototipo, tráfico variable/bursty, sin SLO estricto |
| **Provisioned** (Bedrock Provisioned Throughput, Anthropic Enterprise, OpenAI Reserved) | Tráfico predecible, SLO estricto, volumen alto sostenido |

Break-even típico: si utilización > 60-70% del baseline sostenido durante ≥1 mes, provisioned sale más barato y da latencia constante. Si bursty (10x picos), on-demand + cross-region es mejor.

### 4.5. Rate limits — respeta headers

```python
# En 429, respeta Retry-After
import requests, time

def call_with_ratelimit_respect(url, payload):
    for attempt in range(5):
        r = requests.post(url, json=payload)
        if r.status_code == 429:
            retry_after = int(r.headers.get("Retry-After", "1"))
            time.sleep(retry_after)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("Rate limited too long")
```

Providers exponen:
- `Retry-After: <seconds>` — cuánto esperar (respeta esto, no tu backoff).
- `X-RateLimit-Limit-Requests`, `X-RateLimit-Remaining-Requests`.
- `X-RateLimit-Limit-Tokens`, `X-RateLimit-Remaining-Tokens`.
- `X-RateLimit-Reset-Requests`, `X-RateLimit-Reset-Tokens`.

Ignorarlos = throttle sostenido y bill anómalo por retries.

### 4.6. Edge deployment y latencia geográfica

Bedrock/OpenAI/Anthropic tienen POPs en US/EU/AP. Users en Australia, Sudamérica o África sufren 200-400ms extra por network. Options:

- **Cloudflare Workers AI**: modelos edge en 300+ POPs (Llama, Mistral, Whisper, etc). TTFT <100ms geográficamente.
- **Vercel Edge Functions + Vercel AI SDK**: streaming en edge.
- **Bedrock regional**: elige la región AWS más cercana al user.
- **Self-host en edge**: modelos pequeños en CDN edge.

### 4.7. Anti-patrones

- ❌ SSE detrás de proxy con buffering on → streaming roto silencioso.
- ❌ Lambda clásico sin Response Streaming → no streaming; timeout risk.
- ❌ Single provider sin fallback → incident del provider = tu app down.
- ❌ Retry con delay fijo → thundering herd al recovery.
- ❌ No respetar `Retry-After` → throttle sostenido.
- ❌ Métrica solo "average latency" → p99 disaster invisible.
- ❌ Circuit breaker sin half-open → nunca recuperas del outage.
- ❌ `abortSignal` sin timeout → request cuelga hasta cierre TCP.

---

## 5. Ejemplo práctico completo step-by-step

**Objetivo:** función serverless con Vercel AI SDK 5 que hace streaming con Claude Sonnet 4.6, con fallback automático a GPT-5.4, timeout de 30s, circuit breaker, y métricas p50/p95/p99 medibles via `hey`.

### 5.1. Código de la función

```typescript
// app/api/chat/route.ts — Next.js 15 App Router, edge runtime
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import CircuitBreaker from 'opossum';

export const runtime = 'edge';
export const maxDuration = 60; // segundos

// Circuit breaker Anthropic: 5 fails → abre 60s
const anthropicBreaker = new CircuitBreaker(
  async (prompt: string) => {
    return streamText({
      model: anthropic('claude-sonnet-4-6'),
      prompt,
      abortSignal: AbortSignal.timeout(30_000),
    });
  },
  { timeout: 30_000, errorThresholdPercentage: 50, resetTimeout: 60_000 },
);

async function callWithFallback(prompt: string) {
  try {
    return await anthropicBreaker.fire(prompt);
  } catch (err) {
    console.warn('[fallback] Anthropic breaker open or failed:', err);
    return streamText({
      model: openai('gpt-5.4'),
      prompt,
      abortSignal: AbortSignal.timeout(30_000),
    });
  }
}

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const t0 = performance.now();

  const result = await callWithFallback(prompt);

  // Inject TTFT header con timing del primer chunk
  const stream = result.toDataStream({
    onStart: () => console.log('TTFT_ms', performance.now() - t0),
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Server-Timing': `ttft;dur=${(performance.now() - t0).toFixed(0)}`,
    },
  });
}
```

### 5.2. Cliente que consume el stream

```typescript
// app/chat/page.tsx
'use client';
import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
  });
  return (
    <div>
      {messages.map(m => (
        <div key={m.id}><b>{m.role}:</b> {m.content}</div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} disabled={isLoading} />
        <button type="submit">Enviar</button>
      </form>
    </div>
  );
}
```

### 5.3. Medir p50/p95/p99 con `hey`

```bash
# 500 requests, 20 concurrentes, midiendo TTFT via Server-Timing header
hey -n 500 -c 20 -m POST \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explica RAG en 2 frases"}' \
  https://tu-app.vercel.app/api/chat

# Output esperado:
#   50% in 0.7 s
#   95% in 1.9 s
#   99% in 3.4 s
```

Parsea `Server-Timing: ttft;dur=800` para separar TTFT del total.

### 5.4. Simular outage y verificar fallback

```bash
# Bloquea anthropic con /etc/hosts o firewall local:
echo "127.0.0.1 api.anthropic.com" | sudo tee -a /etc/hosts

# Corre hey — debe seguir funcionando via GPT fallback
hey -n 100 -c 10 -m POST -d '{"prompt":"hola"}' https://tu-app.vercel.app/api/chat

# Espera: latencia p50 sube (fallback más lento), pero errores = 0
# Verifica logs: "[fallback] Anthropic breaker open..."
```

### 5.5. Comprobar streaming realmente

```bash
# Sin buffering, chunks llegan progresivamente
curl -N -X POST https://tu-app.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Cuenta hasta 10 lentamente"}'

# Deberías ver:
# data: {"text":"1"}
# data: {"text":" "}
# data: {"text":"2"}
# ...  (llegando cada ~100ms, no todos de golpe)
```

Si llegan todos al final: proxy/CDN está buffeando; revisa `X-Accel-Buffering: no` y config del proxy.

### 5.6. Por qué cada decisión — la narrativa detrás del código

- **Por qué edge runtime y no Node runtime en Vercel:** edge tiene TTFT-to-user más bajo (POPs en 100+ ciudades), y el streaming SSE funciona nativamente. Node runtime funciona pero añade 50-150ms de latencia geográfica.
- **Por qué `maxDuration = 60`:** Vercel edge limita funciones a 25s (hobby), 60s (pro), 300s (enterprise). Sobrepasar cierra el stream mid-response.
- **Por qué CircuitBreaker con `errorThresholdPercentage: 50`:** más agresivo (30%) genera falsos abre por picos temporales; más laxo (70%) tarda demasiado en detectar outage real. 50% es el sweet spot documentado por Netflix Hystrix.
- **Por qué `resetTimeout: 60_000`:** un outage típico de provider dura 5-30 min. 60s de recovery test es rápido para no perder el momento en que vuelve, sin bombardear si sigue caído.

### 5.7. Verificación intermedia — checks que confirman que funciona

Antes de dar por buena la implementación, verifica cada capa:

```bash
# 1. TTFT del primary bajo condiciones normales
hey -n 100 -c 5 -m POST -d '{"prompt":"hola"}' https://tu-app.vercel.app/api/chat
# Espera: p50 <1s, p95 <2s, p99 <4s

# 2. Fallback funciona cuando primary cae
# Bloquea Anthropic (o desconecta API key)
export ANTHROPIC_API_KEY="sk-invalid"
hey -n 20 -c 2 -m POST -d '{"prompt":"hola"}' https://tu-app.vercel.app/api/chat
# Espera: 100% success, header X-LLM-Provider: openai, latency p50 sube ~50%

# 3. Cascada llega a nivel 3 cuando 2 caen
# Bloquea Anthropic Y OpenAI
export OPENAI_API_KEY="sk-invalid"
curl -N -X POST ... /api/chat
# Espera: X-LLM-Provider: ollama

# 4. Última capa: nunca 500 seco
# Bloquea todo (ollama down también)
curl -N -X POST ... /api/chat
# Espera: 200 OK, body con mensaje "Estamos con problemas técnicos..."
```

Sin estos 4 checks, la resiliencia es teoría.

### 5.8. Extendiendo el ejemplo — 3 mejoras para producción

**Mejora 1: métricas por Server-Timing y Datadog LLM Obs.** Cada request emite headers `Server-Timing: ttft;dur=800, total;dur=3500, provider;desc=anthropic`. El browser (o un Datadog RUM) los parsea automáticamente y agrega dashboards p50/p95/p99 por provider sin código extra.

```typescript
result.on('start', () => {
  const ttft = performance.now() - t0;
  ddTrace.tags({ 'llm.provider': 'anthropic', 'llm.ttft_ms': ttft });
});
```

**Mejora 2: model routing por complejidad de query en el mismo endpoint.** Antes de llamar al primary, un clasificador Haiku (~200ms) decide tier:

```typescript
async function routeByComplexity(prompt: string): Promise<'nano' | 'sonnet' | 'opus'> {
  const r = await generateText({
    model: openai('gpt-5-nano'),
    prompt: `Clasifica en {simple|medium|complex}: "${prompt.slice(0, 200)}"`,
    maxTokens: 5,
  });
  return { simple: 'nano', medium: 'sonnet', complex: 'opus' }[r.text.trim()] || 'sonnet';
}
```

Combinado con la cascada anterior, obtienes: routing por complejidad + fallback por disponibilidad + circuit breaker. Es el patrón que operan Cursor y Perplexity en 2026.

**Mejora 3: streaming resumable (recovery si el usuario refresca).** Guarda cada chunk emitido en Redis con TTL corto (30s). Si el usuario refresca, el cliente re-conecta con `Last-Event-ID` header y el server resume desde ese punto. Requiere que el provider soporte prompt caching (para no re-generar los tokens ya emitidos). Este es el patrón que usa ChatGPT en su app móvil.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Cheatsheet

| Necesitas... | Solución |
|---|---|
| Streaming en Lambda | ✅ Response Streaming + Function URL RESPONSE_STREAM |
| Streaming detrás de NGINX | ✅ `proxy_buffering off; X-Accel-Buffering: no` |
| Reducir TTFT | ✅ Prompt caching + streaming + modelo tier menor |
| Alta disponibilidad | ✅ Fallback provider + circuit breaker + cross-region |
| Bajar coste + latencia media | ✅ Model routing cheap-first |
| Latencia predecible | ✅ Provisioned throughput |
| Users lejanos | ✅ Edge deployment (Cloudflare Workers AI, Vercel Edge) |
| Rate limit hit | ✅ Respeta `Retry-After`, backoff+jitter |

### Reglas mentales

1. **Streaming por default en chat.** TTFT es la métrica que percibe el usuario.
2. **Model routing cheap-first.** Clasifica intent, escala solo si necesario.
3. **Fallback entre providers.** Vercel AI SDK 5 o LiteLLM lo hacen trivial.
4. **Timeout explícito en cada call.** 30s streaming, 60s no-stream, 5min agente.
5. **Retries con exponential backoff + jitter.** Nunca delay fijo.
6. **Circuit breaker.** 5 fails → 60s abierto → half-open probe.
7. **Degradación gradual > HTTP 500.**
8. **Proxy buffering off** para SSE.
9. **Mide p99, no promedio.**
10. **Cross-region inference profiles** en Bedrock: default.

### Anti-patrones

- ❌ SSE con NGINX default → streaming aparente pero roto.
- ❌ Lambda clásico + streaming → no funciona, silent fail.
- ❌ Single provider en app crítica → outage = tu app down.
- ❌ Retry con delay fijo → thundering herd.
- ❌ Ignorar `Retry-After` → throttle sostenido.
- ❌ SLO en promedio → p99 disaster oculto.
- ❌ Circuit sin recovery test → nunca vuelves online.
- ❌ Timeout Lambda 3s con LLM 8s → cortas mid-stream.

### Tabla de decisión

| Escenario | Decisión |
|---|---|
| App chat MVP | Streaming SSE + Vercel AI SDK + 1 provider |
| App producción SaaS | + Fallback + circuit breaker + cross-region |
| App enterprise con SLO | + Provisioned + observability p50/p95/p99 |
| App global (usuarios Sydney/SP) | + Edge deployment (Workers AI) |
| App con volumen predecible | + Provisioned throughput, negociar commit |
| App con budget variable | + Model routing agresivo, on-demand |

---

## 7. Casos reales industria 2026

### 7.1. Anthropic outage julio 2024 — impacto en Cursor y ecosistema
- **Qué pasó:** el 30 julio 2024, Anthropic API sufrió degradación regional de ~2h en `us-east-1`. Rate de 5xx pasó de 0.1% a 40% durante el peak.
- **Cómo se detectó:** apps que solo usaban Anthropic sin fallback vieron su chat pasar a `500 Internal Server Error` en segundos. Status page se actualizó a los 15 min.
- **Cómo se arregló:** apps con Vercel AI SDK 5 o LiteLLM configurado con fallback OpenAI mantuvieron 100% availability aunque con latencia +30-50%. Cursor (que ya operaba multi-provider) reportó impacto <5% de sus usuarios. Apps single-provider perdieron 2h de tráfico completo.
- **Aprendizaje industrial:** post-mortem público de Anthropic recomendó fallback como práctica estándar. LiteLLM y AI SDK vieron 3-5× adopción en las 2 semanas siguientes.

### 7.2. Perplexity + Groq para latencia sub-500ms (2024-2026)
- **Qué pasó:** Perplexity buscaba TTFT <500ms para su producto de search-answer (Sonar); Anthropic/OpenAI daban 800-1500ms p50.
- **Cómo se detectó:** A/B test mostró que reducir TTFT de 1200ms a 400ms subía retención de sesión ~15%.
- **Cómo se arregló:** integraron Groq LPU para servir Llama 3.3-70B (fine-tuned) como backend principal de Sonar. Fallback a Anthropic para queries complejas donde el modelo destilado no cumplía. Groq da 500-800 TPS y TTFT ~250ms p50.
- **Aprendizaje:** hardware especializado (Groq LPU, Cerebras WSE) ha cambiado la economía de latency-critical apps (voice, code completion, search).

### 7.3. AWS Lambda Response Streaming (GA abril 2023) — el arreglo del bug histórico
- **Qué pasó:** Lambda clásico buffeaba respuestas hasta 6MB antes de devolver; SSE simplemente no funcionaba. Chatbots serverless requerían workarounds con WebSockets o polling.
- **Cómo se detectó:** feedback masivo de builders 2023 tras GA de GPT-4 API con streaming.
- **Cómo se arregló:** AWS lanzó `awslambda.streamifyResponse` + `Function URL` con `RESPONSE_STREAM` mode. Bytes salen incremental.
- **Aprendizaje:** el patrón dominante 2026 para chatbots serverless en AWS es Lambda Function URL + Response Streaming (no API Gateway REST, que no soporta streaming).

### 7.4. Bedrock Cross-region Inference profiles (2024-2026)
- **Qué pasó:** users de Bedrock reportaban `ThrottlingException` frecuentes en `us-east-1` (región saturada por Anthropic post-Claude 3.5 launch).
- **Cómo se arregló:** AWS lanzó inference profiles (`us.*`, `eu.*`, `apac.*`, `global.*` — Sept 2025) que enrutan entre regiones transparente. Trade-off explícito: data residency vs disponibilidad.
- **Aprendizaje:** default en la mayoría de deployments enterprise. Profiles `us.*` suman cuotas de us-east-1 + us-west-2 + us-east-2.

### 7.5. Cloudflare Workers AI y edge deployment (2024-2026)
- **Qué pasó:** users lejanos (Sydney, São Paulo, Johannesburg) sufrían +300-500ms de network latency hacia US-East.
- **Cómo se arregló:** Cloudflare Workers AI expone Llama, Mistral, Whisper en 300+ POPs. TTFT <100ms geográficamente. Precio ~$0.011/1k neurons.
- **Aprendizaje:** para chat global masivo, edge deployment con modelo pequeño (Llama 3.2-3B, Mistral 7B) supera a Anthropic Sonnet en US para users no-US, aunque el modelo sea menos capaz.

### 7.6. Vercel AI SDK 5 breaking change a SSE estándar (2026)
- **Qué pasó:** hasta v4, Vercel AI SDK usaba formato propio (custom stream protocol). En 2026, v5 migró a SSE estándar compatible con cualquier cliente `EventSource`.
- **Aprendizaje:** rompió apps existentes, pero unificó ecosistema. Ahora AI SDK 5 sirve como facade sobre 13+ providers manteniendo la misma API.

### 7.7. LiteLLM en Netflix, Rocket Money, Airbnb (2023-2026)
- **Qué pasó:** empresas con múltiples providers necesitaban una capa unificada para pricing, fallback, cost tracking cross-vendor.
- **Cómo se arregló:** LiteLLM se posicionó como el "OpenAI-compatible proxy" para todos los providers. Netflix documentó su uso para ML platform interna; Rocket Money y Airbnb aparecen como referencias públicas.
- **Aprendizaje:** proxy unified reduce lock-in y facilita comparar providers en runtime. Trade-off: adds hop de latencia (~10-30ms).

---

## 8. Ejercicios prácticos

### Ejercicio 1 — Medir TTFT real de tres providers

**Objetivo:** entender la latencia real que verá tu usuario.

**Setup:** cuentas API en Anthropic, OpenAI, Google. `curl` o script con timer.

**Pasos:**
1. Escribe un script que envíe el mismo prompt (~500 tokens) 100 veces a cada provider con streaming.
2. Mide el tiempo desde el `send` hasta el primer chunk recibido.
3. Guarda TTFT en un CSV con columnas `provider,ttft_ms,total_ms,region`.
4. Calcula p50/p95/p99 por provider.
5. Grafica (matplotlib, gnuplot).

**Criterios:**
- [ ] CSV con ≥300 filas (100 por provider).
- [ ] Tabla con p50/p95/p99 de TTFT y total por provider.
- [ ] Un párrafo con la observación clave (¿quién es mejor para tu use case?).

**Bonus:** repite con Groq API y compara TPS.

**Hints:**
- Mide TTFT desde `t0 = performance.now()` justo antes del `fetch`, hasta el primer chunk recibido en el `ReadableStream`.
- No confundas TTFT del provider con TTFT-to-user. Este último incluye network + tu server.
- Ejecuta desde 3 regiones distintas (US, EU, APAC) para separar network de compute.

### Ejercicio 2 — Implementar fallback con circuit breaker

**Objetivo:** app resiliente ante outage de provider.

**Setup:** app o script que llame a Anthropic; instala `opossum` (Node) o `pybreaker` (Python).

**Pasos:**
1. Wrappea la llamada Anthropic con circuit breaker (5 fails, reset 60s).
2. Fallback a OpenAI si el breaker abre o si el call individual falla.
3. Simula outage: bloquea `api.anthropic.com` en `/etc/hosts` o con firewall.
4. Envía 20 requests durante el outage.
5. Restaura y verifica que el breaker cierra tras el primer success (half-open).

**Criterios:**
- [ ] 0 requests fallan durante el outage simulado.
- [ ] Logs muestran transición closed → open → half-open → closed.
- [ ] Latencia media sube durante el outage (fallback más lento) pero no hay error 500.

**Bonus:** exporta métricas del breaker a Prometheus.

**Hints:**
- `opossum` (Node) emite eventos: `.on('open', ...)`, `.on('halfOpen', ...)`, `.on('close', ...)`. Loguea los tres para debug.
- Simula outage con `iptables -A OUTPUT -d api.anthropic.com -j DROP` (Linux) o `/etc/hosts` para más portabilidad.
- El half-open probe permite 1 request; si succeeds cierra el breaker, si falla vuelve a open. No configures reset timeout <30s (thundering herd).

### Ejercicio 3 — Streaming SSE en Lambda Response Streaming

**Objetivo:** desplegar un endpoint LLM en AWS Lambda con streaming real.

**Setup:** cuenta AWS, AWS SAM o Serverless Framework, Node 20+.

**Pasos:**
1. Crea Lambda con `awslambda.streamifyResponse`.
2. Configura Function URL con `Invoke Mode: RESPONSE_STREAM`.
3. Añade headers SSE + `X-Accel-Buffering: no`.
4. Testea con `curl -N` y verifica chunks progresivos.
5. Añade delante CloudFront con streaming distribution y vuelve a testar.

**Criterios:**
- [ ] `curl -N` muestra chunks llegando cada ~100ms, no de golpe.
- [ ] Latencia visible del primer token <1s desde el request.
- [ ] CloudFront no rompe el streaming (chunks llegan igual).

**Bonus:** medir cost por 1000 requests vs Vercel Edge Function equivalente.

### Ejercicio 4 — Router cheap-first

**Objetivo:** reducir coste medio sin degradar calidad.

**Setup:** dataset de 100 queries reales de tu producto, juez (humano o LLM).

**Pasos:**
1. Escribe un clasificador con Haiku/Nano que clasifique "simple" | "complex".
2. Envía "simple" a Haiku 4.5 y "complex" a Sonnet 4.6.
3. Compara: (a) coste total vs enviar todo a Sonnet, (b) calidad juzgada 1-5 por eval.
4. Ajusta el clasificador si calidad baja >0.3 puntos.

**Criterios:**
- [ ] Coste bajó ≥40%.
- [ ] Calidad juzgada bajó <0.3 puntos.
- [ ] Falsos negativos (query complex → Haiku) documentados y <10%.

**Bonus:** usa OpenRouter y compara con tu router custom.

### Ejercicio 5 — RETO: p99 <2s bajo carga real

**Objetivo:** desplegar un endpoint de chat streaming que mantenga TTFT p99 <2000ms bajo 100 requests concurrentes sostenidos durante 5 min.

**Setup:** Vercel edge o Lambda Response Streaming; Anthropic Sonnet 4.6 + fallback GPT-5.4; herramienta `k6` o `hey`.

**Pasos:**
1. Implementa la cascada del §3.9 con circuit breaker + timeout + prompt caching (para acelerar TTFT).
2. Configura Bedrock cross-region inference profile (o equivalente OpenAI para reducir throttling).
3. Corre benchmark: `k6 run --vus 100 --duration 5m load.js` con prompt fijo de ~2k tokens system + 200 tokens user.
4. Mide p50/p95/p99 de TTFT y de total latency.
5. Optimiza hasta que p99 TTFT <2000ms y error rate <1%.

**Criterios:**
- [ ] TTFT p99 <2000ms sostenido.
- [ ] Error rate <1% (incluye retries + fallback silencioso).
- [ ] Sin `429` no gestionado; todos respetan `Retry-After`.
- [ ] Circuit breaker no abre bajo carga normal (solo si primary realmente cae).
- [ ] Documenta: qué optimización dio más ROI (caching, routing, edge, provisioned).

**Hints:** el 99º percentil está dominado por (1) cold starts, (2) throttling regional, (3) fallback cascada lento. Ataca las 3 en ese orden.

---

## 9. Recursos + siguientes pasos

### Referencias oficiales

- Anthropic — Streaming Messages: https://docs.anthropic.com/en/api/messages-streaming
- OpenAI — Streaming: https://platform.openai.com/docs/api-reference/streaming
- AWS — Lambda Response Streaming: https://aws.amazon.com/blogs/compute/introducing-aws-lambda-response-streaming/
- AWS — Bedrock Cross-region Inference: https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
- Vercel AI SDK: https://sdk.vercel.ai/
- Cloudflare Workers AI: https://developers.cloudflare.com/workers-ai/
- MDN — Server-Sent Events: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- AWS — Exponential Backoff and Jitter: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/

### Tools 2026

- **Vercel AI SDK 5** — TS/JS SDK unified streaming + provider registry.
- **LiteLLM** — proxy Python unified con fallback/retry.
- **OpenRouter** — marketplace + auto-routing managed.
- **NotDiamond** — router LLM predictor.
- **Portkey** — gateway con caching + routing + fallback.
- **Helicone** — proxy + observability + cache.
- **Artificial Analysis** — benchmarks públicos TTFT/TPS por provider.
- **opossum** (Node) / **pybreaker** (Python) / **resilience4j** (Java) — circuit breakers.

### Papers

- Leviathan et al. — Speculative Decoding (2023): https://arxiv.org/abs/2211.17192
- Nielsen — Response Times (1993): https://www.nngroup.com/articles/response-times-3-important-limits/

### Siguiente paso

Cap 15 — Cuándo NO entrenar: prompting vs RAG vs LoRA vs destilación.

---

## 10. Preguntas de práctica (20)

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-14-latency-streaming-model-routing.json`](../../packages/content/src/tech/ai-programming/sim-14-latency-streaming-model-routing.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-14-latency-streaming-model-routing`

---

## Navegación

[← Capítulo 13](./13-inference-cost-prompt-caching.md) · [Índice](./README.md) · [Capítulo 15 →](./15-prompting-vs-rag-vs-finetuning.md)
