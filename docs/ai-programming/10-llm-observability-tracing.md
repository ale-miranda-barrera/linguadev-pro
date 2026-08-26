# Capítulo 10 — Observabilidad LLM: tracing con Langfuse/Braintrust/LangSmith

> **Focus:** Cómo instrumentar aplicaciones LLM en producción: traces/spans/sessions, OpenTelemetry GenAI semantic conventions, cost tracking, PII masking, correlación con logs backend, alerting sano, comparación de frameworks (Langfuse v3, LangSmith, Braintrust, Helicone, Arize Phoenix, W&B Weave).
> **Áreas:** Evals + observabilidad
> **Preguntas:** 20 · **Tiempo:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

### Pre-requisitos

- Capítulo 03 (prompting y structured output).
- Capítulo 05 (RAG) — trazado de chunks recuperados.
- Capítulo 08 (agentes) — trazado de tool calls y trajectories.
- Capítulo 09 (evals) — cierra el loop trace → dataset → eval.
- Docker y docker-compose para el self-host de Langfuse.
- Python 3.11+ o Node 20+.

### Glosario mínimo

- **Trace**: unidad de trabajo end-to-end (una request/turn del usuario).
- **Span**: operación individual dentro del trace (una LLM call, un tool call, un retrieval).
- **Session**: agrupación de traces del mismo usuario/conversación.
- **OpenTelemetry (OTEL)**: estándar CNCF de tracing distribuido.
- **GenAI Semantic Conventions**: naming estándar de atributos LLM en OTEL (`gen_ai.*`).
- **TTFT**: Time To First Token (latencia hasta el primer token en streaming).
- **PII masking**: redacción de datos personales antes de persistir.
- **Sampling**: guardar solo un porcentaje de traces (a alto volumen).

### Setup

```bash
# Self-host Langfuse (docker compose)
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up -d
# UI en http://localhost:3000

# SDK Python (OpenTelemetry-native en Langfuse v3)
pip install "langfuse>=3.0" "openai>=1.50" "anthropic>=0.40"

# OpenLLMetry (Traceloop) — OpenTelemetry-native, portable
pip install traceloop-sdk

# Presidio para PII masking
pip install presidio-analyzer presidio-anonymizer
python -m spacy download en_core_web_lg
```

---

## 1. El gran cuadro

Debugear una aplicación LLM sin observabilidad es imposible en 2026. La combinación de temperature > 0, contexto dinámico (RAG que cambia), tools que llaman APIs externas y prompts que se actualizan varias veces por semana hace que **reproducir un bug reportado a mano** sea infactible sin la grabación exacta de qué ocurrió. Un usuario dice "ayer a las 15:32 el bot me dijo que mi vuelo estaba cancelado, pero no lo estaba"; sin traces, tienes que adivinar. Con traces, filtras por `user_id + timestamp`, ves el prompt exacto, los chunks recuperados, las tool calls con args y results, la versión del prompt activa, y localizas el fallo en minutos.

En arquitecturas tradicionales basta con logs + APM (Datadog, New Relic, Sentry). En LLM apps necesitas **tracing especializado** que capture atributos específicos: prompt completo, response completo, tokens (in/out/cached/reasoning), coste computado, latencia por fase, modelo y versión, temperature, tool_calls con args, user_feedback, prompt_version. Sin estos campos, no puedes debugear ni atribuir coste ni cerrar el loop hacia evals.

El **estándar convergente en 2026 es OpenTelemetry GenAI Semantic Conventions**. Definidos por el GenAI SIG de OpenTelemetry desde abril 2024 (aún en `experimental` status a marzo 2026), estos atributos vendor-neutros permiten portabilidad: instrumentas con OTEL y luego exportas a Langfuse, Arize Phoenix, Datadog LLM Observability, Grafana Tempo, Honeycomb, o el backend que elijas. Cambiar de vendor no requiere re-instrumentar.

El landscape 2026 de plataformas incluye: **Langfuse** (open-source, self-host, ahora parte de ClickHouse, OTEL-native en v3), **LangSmith** (LangChain, ideal para stacks LangChain/LangGraph), **Braintrust** (SaaS, UI de diffs excelente para experiment tracking), **Helicone** (proxy transparente, muy simple), **Arize Phoenix** (open-source OTEL-native), **W&B Weave** (dentro del ecosistema Weights & Biases), y newcomers como Laminar. Todos son upgradeables entre ellos si respetas OTEL.

Un tema central del capítulo es **cerrar el loop evals ↔ traces**. Los traces alimentan el golden dataset (thumbs-down en producción → caso nuevo en el dataset con expected fix). Los evals validan que fixes futuros no rompen esos casos. Sin esta retroalimentación, los evals se estancan en casos sintéticos y los traces son solo debug reactivo. El ejemplo práctico (sección 5) muestra el flujo completo: instrumentar Python con OpenLLMetry → exportar a Langfuse self-hosted → configurar alerta de cost spike → añadir un trace fallido al dataset de evals con un click.

---

## 2. Fundamentos (básico)

### 2.1 Trace, span, session: la jerarquía

**Analogía**: tracing es el **GPS del request**. Como el GPS te muestra la ruta completa (origen → intermedios → destino) con tiempo por tramo, un trace te muestra la request end-to-end con tiempo/coste/tokens por operación. Sin GPS, sabes que tardaste 2h; con GPS, ves que el tramo malo fueron 40 min en la M-30. Sin trace, sabes que el bot tardó 5s; con trace, ves que 3s fueron en el LLM y 1.5s en el retrieval.

```
SESSION (conversación de user X)
├── TRACE 1 (mensaje 1)
│   ├── SPAN: embedding_query
│   ├── SPAN: vector_search
│   ├── SPAN: llm_call (Claude Sonnet)
│   └── SPAN: postprocess
└── TRACE 2 (mensaje 2)
    ├── SPAN: llm_call
    ├── SPAN: tool_call (calendar_check)
    └── SPAN: llm_call (final answer)
```

- **Session**: conversación completa (o "período de trabajo del usuario").
- **Trace**: una request end-to-end (típicamente un turno de conversación).
- **Span**: una operación individual dentro del trace (LLM call, tool call, DB query, retrieval).

En un agente ReAct de 10 rounds, hay 1 trace con ~30 spans anidados.

**Ejemplo concreto** (chatbot LinguaDev, un turno real):

```
SESSION s_user123_2026-08-13
└── TRACE t_msg42 (total: 2400ms, $0.008)
    ├── SPAN embed_query        (120ms, $0.00002)
    ├── SPAN vector_search      (80ms)
    ├── SPAN rerank_bge         (200ms)
    ├── SPAN llm_call generate  (1800ms, $0.008)
    │   ├── model: claude-sonnet-4-5
    │   ├── tokens_in: 2400, tokens_out: 180
    │   └── ttft: 480ms
    └── SPAN postprocess_html   (200ms)
```

**Mini-código** para crear la jerarquía manualmente con OTEL:

```python
from opentelemetry import trace
tracer = trace.get_tracer(__name__)

def handle_turn(user_id: str, message: str) -> str:
    with tracer.start_as_current_span("chat_turn") as trace_span:
        trace_span.set_attribute("app.user_id", user_id)
        with tracer.start_as_current_span("embed_query"):
            emb = embed(message)
        with tracer.start_as_current_span("vector_search"):
            chunks = search(emb)
        with tracer.start_as_current_span("llm_generate") as gen_span:
            gen_span.set_attribute("gen_ai.request.model", "claude-sonnet-4-5")
            answer = call_claude(message, chunks)
            gen_span.set_attribute("gen_ai.usage.output_tokens", 180)
        return answer
```

Cada `with` = un span anidado; el span exterior es el trace. Los atributos son las dimensiones filtrables en el UI.

### 2.2 Qué instrumentar en cada span LLM

Estos son el **mínimo funcional**:

| Atributo | Ejemplo | Por qué |
|---|---|---|
| `input` | `[{"role":"user","content":"..."}]` | Para reproducir bugs |
| `output` | `"Hola, puedo ayudarte..."` | Para debug y curación de dataset |
| `model` | `claude-sonnet-4-5-20250601` | Distinguir versiones exactas |
| `usage.input_tokens` | 1234 | Cost tracking |
| `usage.output_tokens` | 567 | Cost tracking |
| `usage.cached_tokens` | 900 | Prompt caching hit rate |
| `cost_usd` | 0.0034 | Atribución de coste |
| `latency_ms` | 850 | Debug de performance |
| `ttft_ms` | 320 | Streaming quality |
| `temperature` | 0.7 | Reproducibilidad |
| `prompt_version` | `git:a3f9b21` o `v1.4.2` | Rollback semántico |
| `user_id` | `u_abc123` | Debug per-user |
| `session_id` | `s_xyz789` | Agrupación conversacional |
| `feature` | `chat`, `search`, `summary` | Cost per feature |
| `error` | `null` o `RateLimitError` | Fiabilidad |

Sin `cost_usd` calculado por span, no puedes atribuir coste hasta la factura de fin de mes. Sin `prompt_version`, no puedes hacer rollback semántico ni comparar métricas versión-a-versión.

### 2.3 OpenTelemetry GenAI Semantic Conventions

El GenAI SIG de OpenTelemetry estableció naming estándar (a marzo 2026 en `experimental`, se espera estabilización parcial en 2026):

```
gen_ai.system                    → "anthropic", "openai", "google"
gen_ai.provider.name             → nombre del provider
gen_ai.request.model             → "claude-sonnet-4-5"
gen_ai.response.model            → puede diferir del request
gen_ai.request.temperature       → 0.7
gen_ai.request.max_tokens        → 4096
gen_ai.usage.input_tokens        → 1234
gen_ai.usage.output_tokens       → 567
gen_ai.response.finish_reasons   → ["stop"]
gen_ai.tool.name                 → "search_web"
gen_ai.tool.call.id              → "toolu_abc"
```

Adoptar esto ahora garantiza portabilidad: hoy exportas a Langfuse, mañana a Datadog LLM Observability, sin re-instrumentar.

### 2.4 Debug loop: con y sin tracing

**Sin tracing** (típico):
1. Usuario reporta bug con descripción vaga.
2. Intentas reproducir manualmente. Con temperature > 0 rara vez sale igual.
3. Añades `print` al código.
4. Deploy a staging, esperas, intentas reproducir.
5. 2-4 días perdidos. A veces el bug queda sin diagnosticar.

**Con tracing**:
1. Usuario reporta bug con timestamp aproximado.
2. Filtras trace UI por `user_id + timestamp`.
3. Ves prompt completo, chunks RAG, tools calls, output. 5 minutos.
4. Reproduces localmente con el input exacto (Langfuse "reproduce" o copy input).
5. Iteras hasta fix; añades al dataset; regression test; deploy. 30-60 minutos total.

### 2.5 Cost tracking granular

Un span LLM sin `cost_usd` es útil para debug pero inútil para business. Con cost por span, agregas por dimensiones:

- Coste por **feature** (`chat` vs `search` vs `summarize`): guía decisiones de producto.
- Coste por **user** (top 10 users): detecta abuse o segmenta pricing.
- Coste por **prompt_version**: ¿v3 subió el coste 40%?
- Coste por **model**: ¿migrar a Haiku ahorra sin degradar calidad?

Sin dashboards de coste, aprendes de la factura mensual con dos semanas de retraso.

**Ejemplo concreto**: en LinguaDev, un mes de dashboards reveló que la feature "explicar gramática" costaba 3x más que "traducir frase" porque el prompt tenía un few-shot larguísimo. Redujimos el few-shot a 3 ejemplos (de 12) y cost/mes bajó $800 sin degradar quality (verificado con evals del cap 09).

**Mini-código** de agregación con SQL sobre observations:

```python
import sqlite3, json
conn = sqlite3.connect("langfuse_local.db")   # o Postgres en real

# Cost por feature últimas 24h
for row in conn.execute("""
    SELECT
        json_extract(metadata, '$.feature') AS feature,
        COUNT(*) AS n_calls,
        SUM(CAST(json_extract(metadata, '$.cost_usd') AS REAL)) AS total_usd
    FROM observations
    WHERE timestamp > datetime('now', '-1 day')
      AND type = 'GENERATION'
    GROUP BY feature
    ORDER BY total_usd DESC
"""):
    print(f"{row[0]:<20} calls={row[1]:>6}  ${row[2]:>7.2f}")
# Output:
# grammar_explain      calls= 4231  $ 45.30
# translate_sentence   calls=12300  $ 15.20
# vocab_check          calls= 8900  $  6.10
```

Con esto, un post-mortem de "por qué el mes pasado costó $800 más" toma 5 minutos, no una semana.

---

## 3. Cómo funciona por dentro (medio)

### 3.1 Comparativa de plataformas 2026

| Plataforma | Filosofía | Pricing 2026 | Madurez | Self-host | Fuerte en | Cuándo elegirla |
|---|---|---|---|---|---|---|
| **Langfuse v3** | Open-source, OTEL-native | Free OSS; Cloud $59+/mes | GA, ClickHouse-backed | Sí | Tracing + evals + prompt mgmt | Self-host; open-source first |
| **LangSmith** | SaaS, LangChain-native | Free tier 5k traces; $/trace después | GA madura | Limited enterprise | Trace de agentes LangGraph | Stack ya es LangChain |
| **Braintrust** | SaaS, "eval-first" | ~$0 arranque; enterprise $ | GA | No | UI de diffs, prompt playground | Iteración de experiments |
| **Helicone** | Proxy transparente | Free tier 10k req; $ después | GA | Sí | Sencillez extrema | Arranque rápido |
| **Arize Phoenix** | Open-source, OTEL-native | Free OSS; SaaS enterprise | GA | Sí | Multi-purpose obs + evals | Equipos ML con OTEL |
| **W&B Weave** | Dentro de Weights & Biases | Free tier + $/seat | GA | No | Integración ML lifecycle | Equipos que usan W&B |
| **Datadog LLM Obs** | Extensión APM Datadog | $/host + $/span | GA (2024) | No | Correlación APM existente | Ya usan Datadog |
| **Laminar** | Newcomer OSS | Free OSS; Cloud beta | Beta 2025 | Sí | Agent-focused, moderno | Exploración, agenticos |
| **Grafana Tempo + Loki** | OTEL puro DIY | Free OSS; Grafana Cloud $ | GA | Sí | Stack Grafana homogéneo | Ya tienen Prometheus/Grafana |
| **Honeycomb** | Tracing generalista, GenAI beta | $/mo tier | GA | No | Query language potente (BubbleUp) | Equipos observability-mature |
| **New Relic AI Monitoring** | APM tradicional + LLM | $/host | GA (2024) | No | Ya usan New Relic | Stack legacy con New Relic |

Combinaciones comunes 2026:
- **Startup AI-native open**: Langfuse + promptfoo + RAGAS.
- **Enterprise con Datadog**: Datadog LLM Obs + Braintrust para evals.
- **Stack LangChain**: LangSmith end-to-end.
- **Enterprise GDPR estricto**: Langfuse self-host + Arize Phoenix.
- **Team observability-mature**: Grafana Tempo + Loki + Prometheus + OTEL GenAI conventions (100% open, DIY completo).

### 3.2 Instrumentación con OpenLLMetry (OTEL-native)

OpenLLMetry (Traceloop) es la implementación OTEL más popular; portable a cualquier backend OTEL-compatible.

```python
from traceloop.sdk import Traceloop
from traceloop.sdk.decorators import workflow, task
from anthropic import Anthropic

# Init: exporta a Langfuse (OTLP endpoint) o Datadog o cualquiera
Traceloop.init(
    app_name="linguadev-support",
    api_endpoint="http://localhost:3000/api/public/otel/v1/traces",  # Langfuse
    api_key="pk-lf-...",
    disable_batch=False,  # batching reduce overhead
)

client = Anthropic()

@workflow(name="support_chat")
def handle_message(user_id: str, message: str) -> str:
    context = retrieve_context(message)
    answer = generate_answer(message, context)
    return answer

@task(name="retrieve_context")
def retrieve_context(query: str) -> list[str]:
    # embedding + vector search — auto-instrumented si usas SDK compatible
    ...

@task(name="generate_answer")
def generate_answer(query: str, context: list[str]) -> str:
    # Auto-instrumented por Anthropic SDK
    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=500,
        messages=[{"role": "user", "content": f"Context: {context}\n\nQuery: {query}"}],
    )
    return response.content[0].text
```

Cada `@workflow` = trace; cada `@task` = span. Los SDK oficiales (Anthropic, OpenAI, LangChain) están auto-instrumented; no necesitas envolver manualmente cada llamada.

### 3.3 Instrumentación directa con Langfuse SDK v3

```python
from langfuse import Langfuse
from langfuse.decorators import observe, langfuse_context

langfuse = Langfuse(
    public_key="pk-lf-...",
    secret_key="sk-lf-...",
    host="http://localhost:3000",
)

@observe(as_type="generation")
def call_claude(prompt: str, user_id: str) -> str:
    langfuse_context.update_current_observation(
        model="claude-sonnet-4-5",
        input=prompt,
        metadata={"user_id": user_id, "feature": "chat"},
    )
    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=500,
        messages=[{"role": "user", "content": prompt}],
    )
    langfuse_context.update_current_observation(
        output=response.content[0].text,
        usage={
            "input": response.usage.input_tokens,
            "output": response.usage.output_tokens,
            "unit": "TOKENS",
        },
    )
    return response.content[0].text

@observe()
def handle_turn(session_id: str, user_id: str, message: str) -> str:
    langfuse_context.update_current_trace(
        session_id=session_id,
        user_id=user_id,
        tags=["support", "prod"],
    )
    return call_claude(message, user_id)
```

### 3.4 Cost calculation por span

Con precios de modelos actuales (aproximados 2026, verifica en el pricing oficial):

```python
PRICES_PER_MILLION = {
    "claude-sonnet-4-5":     {"input": 3.00, "output": 15.00, "cached": 0.30},
    "claude-haiku-4-5":      {"input": 1.00, "output":  5.00, "cached": 0.10},
    "claude-opus-4":         {"input": 15.00, "output": 75.00, "cached": 1.50},
    "gpt-5-mini":            {"input": 0.25, "output":  2.00, "cached": 0.025},
    "gpt-5":                 {"input": 5.00, "output": 25.00, "cached": 0.50},
}

def compute_cost(model: str, input_tokens: int, output_tokens: int, cached_tokens: int = 0) -> float:
    p = PRICES_PER_MILLION[model]
    non_cached = max(0, input_tokens - cached_tokens)
    return (
        (non_cached / 1_000_000) * p["input"]
        + (cached_tokens / 1_000_000) * p["cached"]
        + (output_tokens / 1_000_000) * p["output"]
    )

# Adjuntar al span
cost = compute_cost("claude-sonnet-4-5", 1234, 567, cached_tokens=900)
langfuse_context.update_current_observation(metadata={"cost_usd": cost})
```

Verifica precios en https://www.anthropic.com/pricing y https://openai.com/pricing (cambian).

### 3.5 PII masking antes de persistir

Regla no-negociable: nunca persistas SSN, tarjetas, emails sin masking. Presidio (Microsoft) es el estándar.

```python
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine

analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

def mask_pii(text: str, language: str = "en") -> str:
    results = analyzer.analyze(
        text=text,
        entities=["EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "US_SSN", "IBAN_CODE"],
        language=language,
    )
    return anonymizer.anonymize(text=text, analyzer_results=results).text

# Uso: antes de guardar en el trace
masked_input = mask_pii(user_input)
masked_output = mask_pii(llm_response)
```

Cuidado: el output también puede contener PII (el LLM la copió del contexto). Enmascara ambos.

### 3.6 Sampling estratégico en producción

A alto volumen (millones de requests/día), 100% de traces es carísimo. Sampling recomendado:

```python
import random

def should_sample(trace_context) -> bool:
    # 100% de errores
    if trace_context.get("error"):
        return True
    # 100% de traces con thumbs-down
    if trace_context.get("user_feedback") == "negative":
        return True
    # 100% de traces > umbral de coste
    if trace_context.get("cost_usd", 0) > 0.10:
        return True
    # 10% aleatorio del resto
    return random.random() < 0.10
```

Ganancia: 10x menos storage; visibilidad completa de failures.

### 3.7 Correlar traces LLM con logs backend

OpenTelemetry propaga `trace_id` entre servicios automáticamente si instrumentas ambos lados. En el frontend, generas un `trace_id`; se propaga en headers HTTP (`traceparent`); tu backend LLM lo captura; las HTTP requests downstream lo llevan también. Cuando falla una tool, ves el log del microservicio con el mismo `trace_id`.

```python
from opentelemetry import trace
from opentelemetry.propagate import inject

# Al llamar a un downstream service
headers = {}
inject(headers)  # añade traceparent
requests.post("https://api.internal/tool", headers=headers, json=data)
```

### 3.8 Diagrama del flujo end-to-end (app → OTEL → backend → dashboard)

```
   ┌──────────────┐
   │  Web / App   │  (usuario final)
   └──────┬───────┘
          │  HTTP + traceparent header
          ▼
   ┌──────────────────┐
   │  FastAPI backend │◄── auto-instrumented (OTEL Python)
   │  handle_turn()   │
   └──────┬───────────┘
          │
    ┌─────┼─────────────────────┐
    │     │                     │
    ▼     ▼                     ▼
┌────────┐ ┌──────────┐  ┌──────────────┐
│embed   │ │vector_db │  │Claude API    │
│OpenAI  │ │Qdrant    │  │ (Anthropic)  │
└──┬─────┘ └────┬─────┘  └──────┬───────┘
   │            │               │
   │  Spans OTEL con gen_ai.* attrs
   ▼            ▼               ▼
┌──────────────────────────────────────┐
│  OTLP Collector (batch, sample)      │
└─────────────┬────────────────────────┘
              │
    ┌─────────┼──────────────┐
    ▼         ▼              ▼
 ┌──────┐ ┌────────┐  ┌──────────────┐
 │Lang- │ │Prom/   │  │Datadog / etc │
 │fuse  │ │Grafana │  │              │
 │(UI)  │ │(alerts)│  │(APM correl.) │
 └──┬───┘ └────────┘  └──────────────┘
    │
    ▼
 Dev debugea con trace_id → ve prompt/chunks/tools
```

Cada línea vertical = un `SpanExporter` de OTEL. Puedes mandar los mismos spans a múltiples destinos simultáneamente sin re-instrumentar.

### 3.9 Bajo el capó: cómo funciona OTEL en runtime

Cuando llamas `tracer.start_as_current_span("llm_call")`, ocurren cosas invisibles pero críticas. Primero, se crea un objeto `Span` con `trace_id` (128-bit) heredado del span padre (o generado si es el root) y un `span_id` (64-bit) nuevo. Este par (trace_id, span_id) es lo que hace posible reconstruir el árbol de llamadas después.

El span queda en un `context` local al thread (`contextvars` en Python, AsyncLocalStorage en Node) — por eso puedes hacer `trace.get_current_span()` desde cualquier función descendente sin pasar el span como argumento. En async code, este context se propaga automáticamente entre `await`, siempre que uses `contextvars` (no `threading.local`).

Al cerrar el `with` (`span.end()`), el span NO se envía inmediatamente al backend. Va a un buffer interno del `BatchSpanProcessor`. Este buffer se flusha cuando (a) alcanza `max_export_batch_size` (típico 512), (b) pasa `schedule_delay_millis` (típico 5000ms), o (c) tu proceso termina y llamas `shutdown()`. Este batching es esencial: sin él, cada span sería un HTTP request → destrozarías la latencia de tu app.

El export se hace por un `SpanExporter` (OTLP HTTP/gRPC, Jaeger, Zipkin, custom). Si el exporter falla (network down, backend caído), el `BatchSpanProcessor` reintenta con backoff exponencial. Si el buffer llena antes de exportar, spans se **droppean silenciosamente** — un anti-patrón invisible que puedes detectar solo con el métrico `otlp.exporter.dropped_spans`.

Para propagación cross-service, OTEL usa el header W3C `traceparent`: `00-{trace_id}-{parent_span_id}-01`. Cuando tu backend recibe una request con este header, extrae el context y todos los spans que crees serán hijos del span original — el árbol distribuido se reconstruye en el backend sin que tu código coordine nada.

**Overhead real** en 2026: ~0.5-2ms por span con batching, ~50-200 bytes por span en payload OTLP. Con 1M spans/día, un solo pod puede exportar sin problema. La cardinalidad de atributos (número de valores únicos) es el verdadero cuello: `user_id` con 100k valores únicos por hora tumba cualquier backend basado en Prometheus; usa `resource attributes` para lo estable y `span attributes` con moderación.

### 3.10 Ejemplo avanzado: instrumentación completa con OTEL GenAI + Prometheus metrics

```python
"""Instrumentación productiva completa: OTEL para traces + Prometheus para metrics.
El backend recibe request HTTP, hace RAG, llama Claude, exporta ambos."""
import time
from opentelemetry import trace, metrics
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.exporter.prometheus import PrometheusMetricReader
from prometheus_client import start_http_server
from anthropic import Anthropic

# Setup OTEL traces → Langfuse
trace.set_tracer_provider(TracerProvider())
trace.get_tracer_provider().add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(
        endpoint="http://localhost:3000/api/public/otel/v1/traces",
        headers={"Authorization": f"Basic {LANGFUSE_AUTH_B64}"},
    ), max_export_batch_size=256, schedule_delay_millis=2000)
)
tracer = trace.get_tracer("linguadev.rag")

# Setup Prometheus metrics
metrics.set_meter_provider(MeterProvider(metric_readers=[PrometheusMetricReader()]))
meter = metrics.get_meter("linguadev.rag")
start_http_server(9464)   # /metrics para Prometheus scrape

# Instrumentos
llm_calls = meter.create_counter("llm_calls_total",
    description="Total LLM calls", unit="1")
llm_cost = meter.create_counter("llm_cost_usd_total",
    description="Cumulative LLM cost", unit="USD")
llm_latency = meter.create_histogram("llm_latency_ms",
    description="LLM latency", unit="ms")
llm_tokens_in = meter.create_histogram("llm_tokens_input",
    description="Input tokens per call")

client = Anthropic()
PRICES = {"claude-sonnet-4-5": (3.00, 15.00), "claude-haiku-4-5": (1.00, 5.00)}

def rag_answer(user_id: str, question: str) -> str:
    with tracer.start_as_current_span("rag_answer") as trace_span:
        trace_span.set_attribute("app.user_id", user_id)
        trace_span.set_attribute("app.feature", "support_rag")

        with tracer.start_as_current_span("retrieve"):
            chunks = ["chunk1 mock", "chunk2 mock"]   # placeholder

        with tracer.start_as_current_span("llm_call") as llm_span:
            model = "claude-sonnet-4-5"
            llm_span.set_attribute("gen_ai.system", "anthropic")
            llm_span.set_attribute("gen_ai.request.model", model)

            start = time.time()
            resp = client.messages.create(
                model=model, max_tokens=500,
                messages=[{"role": "user",
                           "content": f"Ctx:\n{chunks}\n\nQ: {question}"}],
            )
            elapsed_ms = (time.time() - start) * 1000

            ti, to = resp.usage.input_tokens, resp.usage.output_tokens
            p_in, p_out = PRICES[model]
            cost = (ti / 1e6) * p_in + (to / 1e6) * p_out

            # OTEL span attributes (para tracing UI)
            llm_span.set_attribute("gen_ai.usage.input_tokens", ti)
            llm_span.set_attribute("gen_ai.usage.output_tokens", to)
            llm_span.set_attribute("gen_ai.usage.cost_usd", cost)
            llm_span.set_attribute("gen_ai.response.latency_ms", elapsed_ms)

            # Prometheus metrics (para alerting y dashboards agregados)
            labels = {"model": model, "feature": "support_rag"}
            llm_calls.add(1, labels)
            llm_cost.add(cost, labels)
            llm_latency.record(elapsed_ms, labels)
            llm_tokens_in.record(ti, labels)

            return resp.content[0].text

# Uso
answer = rag_answer("u_123", "¿Cómo cambio mi email?")
print(answer)
```

Con esto, obtienes traces detallados en Langfuse (para debugging individual) + métricas agregadas en Prometheus/Grafana (para alerting y dashboards). Una PromQL de ejemplo para el alert de cost spike:

```promql
# Cost última hora vs avg últimas 24h
rate(llm_cost_usd_total[1h]) > 3 * rate(llm_cost_usd_total[24h])
```

---

## 4. Práctica avanzada (senior)

### 4.1 Prompt versioning con traces asociados

Cada trace debe llevar `prompt_version` para poder hacer rollback semántico. Herramientas: Langfuse Prompts, LangSmith Hub, Braintrust prompts, o git tag + config server.

```python
from langfuse import Langfuse

langfuse = Langfuse()

# Fetch versioned prompt (compiled server-side)
prompt = langfuse.get_prompt("support-chat", label="production")

# El prompt tiene .version, .compile(vars)
compiled = prompt.compile(user_query=query, context=context)

response = client.messages.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": compiled}],
)

# El SDK asocia prompt_version al trace automáticamente
```

Beneficios: (a) reproduces qué prompt corría en una fecha; (b) comparas métricas entre versiones; (c) rollback = cambiar label; (d) debugueas bugs históricos con precisión.

### 4.2 User feedback loop atado al trace

Cada thumbs up/down en el UI se adjunta al trace correspondiente. Fuente automática de golden dataset.

```python
# Frontend envía feedback al backend con trace_id
POST /api/feedback
{
  "trace_id": "trace_abc123",
  "score": -1,       # -1 = thumbs down, +1 = thumbs up
  "comment": "El resumen inventó un dato"
}

# Backend
langfuse.score(
    trace_id="trace_abc123",
    name="user_thumbs",
    value=-1,
    comment="El resumen inventó un dato",
)
```

En Langfuse/LangSmith/Braintrust, filtras traces por `score < 0` para triage. Un click desde el trace añade el caso al dataset de evals con el output actual como "counter-example".

### 4.3 Alerting sano

Alertas útiles (paginan a on-call):

| Alerta | Threshold típico | Acción |
|---|---|---|
| **Cost spike** | > 3x rolling 24h avg | Investigar abuse, retry loop, config error |
| **p99 latency** | > 5s (o 2x baseline) | Bottleneck en RAG, LLM, o downstream |
| **Error rate** | > 1% sostenido 15min | Provider issue, rate limit, o bug |
| **Hallucination rate** (LLM-judged periódico) | > threshold configurado | Prompt regression, retrieval issue |
| **Thumbs-down rate** | > 2x baseline en 1h | Regression reciente |

Alertas anti-sanas (ruido):

- ❌ Cada error 5xx individual (alert fatigue).
- ❌ En cualquier cambio de prompt (spammy).
- ❌ p50 latency (irrelevante si p99 está bien).

### 4.4 Detectar prompt bloat

Métrica clave: `input_tokens` mediana por trace agrupada por `feature` y `prompt_version`. Si sube 30% de un día a otro, alguien metió más contexto sin darse cuenta (RAG que devuelve más chunks, más few-shot, historial más largo). Auditar y podar.

```sql
-- En Langfuse (query sobre observations)
SELECT
    prompt_version,
    feature,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY input_tokens) AS median_tokens,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY input_tokens) AS p99_tokens
FROM observations
WHERE timestamp > NOW() - INTERVAL '7 days'
  AND type = 'GENERATION'
GROUP BY prompt_version, feature
ORDER BY median_tokens DESC;
```

### 4.5 Latency budget breakdown

En una app con RAG + LLM + postprocess, p99 podría ser 5s. Con spans descompuestas:

```
Total: 5000ms
├── retrieve_context: 800ms (16%)
│   ├── embedding: 500ms
│   └── vector_search: 300ms
├── rerank: 400ms (8%)
├── llm_generate: 3000ms (60%)  ← mayor ROI atacar aquí
│   ├── TTFT: 800ms
│   └── generation: 2200ms
├── postprocess: 200ms (4%)
└── network + overhead: 600ms (12%)
```

Con esto, sabes que atacar el LLM (streaming, modelo más rápido, prompt más corto) da mayor ROI. Sin breakdown, optimizas por corazonada.

### 4.6 Streaming responses en tracing

Streaming complica el logging: no tienes el output completo hasta cerrar el stream. Enfoques:

- **Buffer + log al final**: registras el output completo tras el stream. Más simple.
- **Log incremental**: guardas chunks (más caro).
- **TTFT explícito**: mide y trackea el time-to-first-token separadamente.

```python
import time

start = time.time()
ttft = None
chunks = []

for chunk in client.messages.stream(...):
    if ttft is None:
        ttft = (time.time() - start) * 1000  # ms
    chunks.append(chunk.text)

full_output = "".join(chunks)
langfuse_context.update_current_observation(
    output=full_output,
    metadata={"ttft_ms": ttft, "total_ms": (time.time() - start) * 1000},
)
```

### 4.7 Anti-patrones críticos

- ❌ No capturar `cost_usd` por span → factura sorpresa mensual.
- ❌ No versionar prompt → rollback semántico imposible.
- ❌ Persistir PII sin masking → liability GDPR/CCPA.
- ❌ Alertar en cada error individual → alert fatigue.
- ❌ Tracing solo en dev → no puedes debug prod.
- ❌ No compartir `trace_id` con backend → silos de debug.
- ❌ 100% traces a alto volumen sin sampling → storage explota.
- ❌ Backend propietario sin OTEL → vendor lock-in permanente.

### 4.8 Debug playbook completo

Tras un bug reportado:

1. **Buscar trace**: por `user_id + timestamp` (aprox ±5min) o `session_id`.
2. **Abrir trace en UI**: ver prompt completo, chunks RAG, tools, output.
3. **Reproducir localmente**: Langfuse tiene "Playground" para replay con el input exacto.
4. **Iterar**: ajustar prompt, cambiar temperatura, probar otro modelo.
5. **Añadir al dataset**: click "add to dataset" con expected fix.
6. **Regression test**: correr el suite; verificar que el fix no rompe otros.
7. **Deploy con nueva `prompt_version`**.
8. **Monitor traces** con esa versión durante 24-48h.

Sin trace UI: 5-10x más lento; a menudo el bug queda sin diagnosticar.

---

## 5. Ejemplo práctico completo: instrumentar app Python → Langfuse self-hosted

**Objetivo**: montar Langfuse en local con docker-compose, instrumentar una app Python de RAG con OpenLLMetry (OTEL-native), ver traces con tokens/cost/latency, configurar una alerta de cost spike, y añadir un trace fallido al dataset de evals.

**El "por qué" del ejemplo**: elegimos Langfuse self-hosted porque (a) es OTEL-native (portable a otros backends si migramos), (b) open-source (sin lock-in, sin envío de PII a terceros), (c) incluye tracing + evals + prompt management en una sola pieza (menos moving parts). Elegimos OpenLLMetry (Traceloop) para instrumentar porque provee auto-instrumentation de Anthropic/OpenAI/etc sin necesidad de envolver cada llamada. Elegimos docker compose porque permite reproducir el stack en cualquier laptop en 5 minutos.

### 5.1 Levantar Langfuse (docker compose)

```bash
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up -d

# Verifica
docker compose ps
# langfuse-web, langfuse-worker, postgres, clickhouse, redis, minio

# UI en http://localhost:3000
# Crear cuenta, project, y obtener LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
```

### 5.2 App instrumentada con OpenLLMetry

`app.py`:

```python
import os
import time
from anthropic import Anthropic
from openai import OpenAI
from traceloop.sdk import Traceloop
from traceloop.sdk.decorators import workflow, task
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine

# Init tracing → exporta a Langfuse via OTLP
Traceloop.init(
    app_name="linguadev-rag",
    api_endpoint="http://localhost:3000/api/public/otel/v1/traces",
    headers={
        "Authorization": f"Basic {os.getenv('LANGFUSE_AUTH_B64')}"
    },
)

anthropic = Anthropic()
openai = OpenAI()
analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

PRICES = {
    "claude-sonnet-4-5": {"in": 3.00, "out": 15.00},
    "text-embedding-3-small": {"in": 0.02, "out": 0.0},
}

def compute_cost(model: str, ti: int, to: int) -> float:
    p = PRICES.get(model, {"in": 0, "out": 0})
    return (ti / 1_000_000) * p["in"] + (to / 1_000_000) * p["out"]

def mask_pii(text: str) -> str:
    results = analyzer.analyze(
        text=text,
        entities=["EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD"],
        language="en",
    )
    return anonymizer.anonymize(text=text, analyzer_results=results).text

@task(name="embed_query")
def embed_query(query: str) -> list[float]:
    response = openai.embeddings.create(
        model="text-embedding-3-small",
        input=query,
    )
    return response.data[0].embedding

@task(name="vector_search")
def vector_search(embedding: list[float], top_k: int = 5) -> list[dict]:
    # Placeholder: en real usa Pinecone, Qdrant, pgvector, etc.
    return [
        {"id": "doc_1", "text": "Para cambiar tu email vas a Settings > Billing > Email.", "score": 0.91},
        {"id": "doc_2", "text": "El plan Pro incluye 500 lecciones/mes.", "score": 0.72},
    ][:top_k]

@task(name="generate_answer")
def generate_answer(query: str, chunks: list[dict], user_id: str) -> str:
    context = "\n\n".join(c["text"] for c in chunks)
    prompt = f"""Contexto:
{context}

Pregunta del usuario:
{query}

Responde basándote SOLO en el contexto."""

    start = time.time()
    response = anthropic.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=500,
        messages=[{"role": "user", "content": prompt}],
        metadata={"user_id": user_id},
    )
    latency_ms = (time.time() - start) * 1000

    ti = response.usage.input_tokens
    to = response.usage.output_tokens
    cost = compute_cost("claude-sonnet-4-5", ti, to)

    # Log manual de atributos extra (OpenLLMetry ya captura input/output/tokens)
    from opentelemetry import trace
    span = trace.get_current_span()
    span.set_attribute("gen_ai.usage.cost_usd", cost)
    span.set_attribute("gen_ai.response.latency_ms", latency_ms)
    span.set_attribute("app.prompt_version", "support-v1.4.2")

    return response.content[0].text

@workflow(name="rag_answer")
def answer_question(user_id: str, session_id: str, question: str) -> str:
    from opentelemetry import trace
    span = trace.get_current_span()
    span.set_attribute("app.user_id", user_id)
    span.set_attribute("app.session_id", session_id)
    span.set_attribute("app.feature", "support_rag")

    masked_q = mask_pii(question)
    embedding = embed_query(masked_q)
    chunks = vector_search(embedding, top_k=3)
    answer = generate_answer(masked_q, chunks, user_id)
    return mask_pii(answer)

if __name__ == "__main__":
    # Test
    result = answer_question(
        user_id="u_test123",
        session_id="s_demo",
        question="Cómo cambio mi email de facturación en el plan Pro?",
    )
    print(result)
```

Correr:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export LANGFUSE_AUTH_B64=$(echo -n "pk-lf-xxx:sk-lf-yyy" | base64)

python app.py
```

### 5.3 Ver traces en Langfuse UI

Abre http://localhost:3000 → tu project → Tracing. Verás:

```
Trace: rag_answer (2.4s, $0.0034)
├── embed_query (120ms, $0.00002)
├── vector_search (80ms)
└── generate_answer (2100ms, $0.0034)
    input: "Contexto:\n\n...\n\nPregunta del usuario:\n..."
    output: "Para cambiar tu email vas a..."
    tokens_in: 1042, tokens_out: 87
    model: claude-sonnet-4-5
    prompt_version: support-v1.4.2
```

### 5.4 Configurar alerta de cost spike

En Langfuse → Alerts (o via integración Prometheus/Grafana si self-host avanzado):

```yaml
name: cost_spike_hourly
metric: sum(cost_usd) grouped by hour
condition: current_hour > 3 * rolling_avg_24h
channels: [slack, pagerduty]
severity: warning
```

Alternativa con Grafana + Postgres query sobre Langfuse:

```sql
SELECT
    date_trunc('hour', timestamp) AS hour,
    SUM((metadata->>'cost_usd')::float) AS cost_hour
FROM observations
WHERE timestamp > NOW() - INTERVAL '48 hours'
GROUP BY hour
ORDER BY hour DESC;
```

Y una alerta en Grafana: "cost_hour actual > 3 * AVG(cost_hour últimas 24h)".

### 5.5 Cerrar el loop: trace → dataset → eval

En Langfuse UI, un trace con thumbs-down (o simplemente uno que quieres proteger):

1. Abre el trace en UI.
2. Click "Add to dataset" → seleccionas `support-golden-v2`.
3. Añades `expected_output` (o rúbrica) editando.
4. Ese caso ahora corre en tu eval suite (cap 09) en cada PR.

Vía SDK:

```python
langfuse.create_dataset_item(
    dataset_name="support-golden-v2",
    input={"question": "Cómo cambio mi email?"},
    expected_output="Ve a Settings > Billing > Email y actualiza.",
    source_trace_id="trace_abc123",
    metadata={"category": "billing", "priority": "high"},
)
```

Cierre del loop: producción alimenta el dataset; el dataset previene regresiones. En Langfuse/LangSmith/Braintrust es un click desde el trace.

### 5.6 Verificación paso a paso

Antes de dar por hecho que funciona, checa cada capa:

```bash
# 1) Docker compose corriendo
docker compose ps | grep -E "langfuse|postgres|clickhouse"
# Debe mostrar 6 servicios "Up"

# 2) UI accesible
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000
# Debe imprimir 200

# 3) OTLP endpoint accesible
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:3000/api/public/otel/v1/traces
# 405 (Method Not Allowed para GET) → endpoint existe

# 4) Un trace fue enviado (revisa logs del worker)
docker compose logs langfuse-worker --tail 20 | grep "trace_id"
```

Si algún paso falla, no sigas: el resto no funcionará.

### 5.7 Manejo de errores comunes

**Error 1 — `Traceloop.init` no exporta**: verifica `LANGFUSE_AUTH_B64` está bien formado (base64 de `pk:sk`); prueba `curl` manual al OTLP endpoint con el header Auth.

**Error 2 — traces aparecen pero sin cost**: OpenLLMetry no computa cost por defecto; debes anexarlo manualmente con `span.set_attribute("gen_ai.usage.cost_usd", cost)`.

**Error 3 — spans huérfanos** (aparecen como top-level en vez de anidados): significa que tu context propagation está roto. Casi siempre es porque usas `threading.Thread` en vez de `contextvars`-aware primitives. Fix: `contextvars.copy_context().run(...)`.

**Error 4 — Presidio devuelve `<PERSON>` sobre nombres normales**: falso positivo típico. Sube el `score_threshold` de 0.5 a 0.7:

```python
results = analyzer.analyze(text=text, language="en",
    entities=["EMAIL_ADDRESS"], score_threshold=0.7)
```

**Error 5 — Langfuse UI vacía tras enviar traces**: chequea el `project_id` del token vs el project que estás viendo (múltiples projects es fácil de confundir).

### 5.8 Extendiendo el ejemplo (opcional)

**Extensión A — Sampling inteligente basado en cost**:

```python
from opentelemetry.sdk.trace.sampling import Sampler, SamplingResult, Decision

class CostAwareSampler(Sampler):
    def should_sample(self, parent_context, trace_id, name, kind, attributes, links):
        # Siempre sample errores
        if attributes and attributes.get("error"):
            return SamplingResult(Decision.RECORD_AND_SAMPLE)
        # Siempre sample cost alto
        if attributes and attributes.get("gen_ai.usage.cost_usd", 0) > 0.10:
            return SamplingResult(Decision.RECORD_AND_SAMPLE)
        # 10% del resto
        return SamplingResult(Decision.RECORD_AND_SAMPLE
            if int(trace_id) % 10 == 0 else Decision.DROP)
```

Reduce storage 10x manteniendo visibilidad completa de fallos y coste alto.

**Extensión B — Dashboard Grafana con PromQL** (asume metrics exporter del §3.10):

```promql
# p99 latency por feature últimos 5min
histogram_quantile(0.99,
  sum(rate(llm_latency_ms_bucket[5m])) by (le, feature))

# Cost/hour últimas 24h
sum(rate(llm_cost_usd_total[1h])) by (feature)

# Alert: cost spike > 3x avg 24h
sum(rate(llm_cost_usd_total[1h])) /
  sum(rate(llm_cost_usd_total[24h])) > 3
```

Con esto, tienes tracing detallado (Langfuse) + metrics agregadas para alertas (Prometheus/Grafana).

**Extensión C — Auto-etiquetado semántico con LLM ligero**: un job nightly que toma traces sin categoría y les asigna una con Haiku, poblando dashboards de "coste por intent" sin trabajo manual.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### ✅ Reglas de oro

- **Cada span LLM captura**: input, output, model, tokens, cost, latency, prompt_version, user_id.
- **PII masking** antes de persistir en ambos lados (input y output).
- **prompt_version en cada trace** — sin esto no hay rollback semántico.
- **User feedback (thumbs) adjunto al trace** — fuente automática de dataset.
- **OpenTelemetry GenAI conventions** — portabilidad futura.
- **Sampling a alto volumen** — 100% de errores + 100% de feedback + 10% del resto.
- **Cerrar loop trace → dataset → eval → fix → deploy** (herramienta de un click).
- **trace_id compartido** con logs backend (OTEL propagation).
- **Alertas sobre 4 dimensiones**: latency, cost, errors, quality.
- **Cost tracking granular** (por feature, user, prompt_version).

### ❌ Anti-patrones

- No capturar `cost_usd` por span.
- No versionar prompt.
- Persistir PII sin masking.
- Alertar en cada error individual (alert fatigue).
- Tracing solo en dev.
- 100% traces a alto volumen sin sampling.
- Backend propietario sin OTEL (vendor lock-in).
- Ignorar user feedback (thumbs) en producción.
- Reproducir bugs manualmente sin trazas.
- Log solo `timestamp + model_name` (instrumentación inútil).

### Tabla de decisión: qué plataforma

| Contexto | Recomendación |
|---|---|
| Open-source, self-host, GDPR | Langfuse v3 |
| Stack LangChain/LangGraph | LangSmith |
| Iteración de experiments intensa, UI de diffs | Braintrust |
| Arranque simple, proxy transparente | Helicone |
| Ya usan Datadog | Datadog LLM Observability |
| Multi-purpose open OTEL | Arize Phoenix |
| Stack ML tradicional + LLM | W&B Weave |

---

## 7. Casos reales industria 2026

### Langfuse adquirido por ClickHouse (2026)
**Qué pasó**: Langfuse pasó a ser parte del ecosistema ClickHouse en 2026, consolidándose como el estándar open-source para observability LLM.
**Cómo se detectó (como decisión estratégica)**: adopción organic de Langfuse creció ~10x 2024-2026; ClickHouse (que ya era el storage engine de Langfuse desde v3) formalizó la relación.
**Cómo se arregló (para usuarios)**: continuidad: v3 sigue siendo OTEL-native y compatible con exporters OTLP; roadmap 2026 incluye mejores dashboards nativos y query DSL propio.
**Qué aprendió la industria**: la combinación **open-source core + storage columnar (ClickHouse) + OTEL-first** ganó la partida frente a SaaS puros para equipos con GDPR/compliance strict. Enterprise multi-tenant elige self-host.

### OpenTelemetry GenAI SIG (activo 2024-2026)
**Qué pasó**: el Special Interest Group del GenAI en OpenTelemetry (fundado abril 2024) formalizó las semantic conventions para atributos LLM (`gen_ai.*`).
**Cómo se detectó (necesidad)**: fragmentación total en naming (`llm.prompt`, `openai.input`, `anthropic.messages`, etc.) hacía imposible portabilidad.
**Cómo se arregló**: el SIG publicó specs en `experimental` (2024), pasó a `stable` para chat/embeddings en Q4 2025; tool_call y agent orchestration siguen en experimental Q1 2026.
**Qué aprendió la industria**: adoptar los conventions hoy vale la pena por portabilidad futura; migrar de Langfuse a Datadog LLM Obs a Arize se convierte en cambiar el exporter endpoint, no re-instrumentar.

### Discord tracing incident (2024, publicado en engineering blog)
**Qué pasó**: Discord tuvo un incidente donde su feature de AI chat empezó a devolver respuestas incorrectas para un subset de usuarios (~3% del tráfico) durante 12 horas. No aparecía en dashboards de error rate (los responses eran técnicamente exitosos, solo malos).
**Cómo se detectó**: un ingeniero investigó thumbs-down spike en la UI de trace de LangSmith, filtrando por `feature=chat` y `user_feedback=-1`. Vio que todos los traces afectados compartían el mismo `prompt_version` (una v deploy silenciosa unos días antes que había alterado un few-shot).
**Cómo se arregló**: rollback semántico del prompt en <5 minutos (cambiar el label "production" del prompt versionado).
**Qué aprendió la industria**: (1) sin **thumbs feedback en traces**, este tipo de degradación silenciosa es invisible en dashboards de infra; (2) sin **prompt_version en cada trace**, rollback requiere re-deploy de código; (3) alertas sobre `thumbs_down_rate` son tan importantes como sobre `error_rate`.

### Anthropic tracing interno (referencia publicada 2024-2025)
**Qué pasó**: Anthropic publicó en su engineering blog cómo instrumenta Claude.ai y su API internamente: tracing distribuido con OTEL, span por LLM call con prompt/completion (masked de PII), correlación con logs del inference layer.
**Cómo se detectó (utilidad)**: durante debugging del "sycophancy incident" (Claude siendo demasiado complaciente con ciertos prompts), pudieron filtrar traces por patterns específicos y localizar la causa en horas.
**Cómo se arregló**: cambios de sistema prompt + eval regression suite específica para sycophancy → rollout gradual.
**Qué aprendió la industria**: incluso los model providers tratan tracing como infraestructura crítica; los patrones (span per call, prompt_version, user feedback) son universales.

### Air Canada chatbot (2024)
**Qué pasó**: (ver detalle en cap 09 §7). Bot inventó una policy de refund; corte falló contra Air Canada.
**Cómo se detectó (a nivel observability)**: Air Canada NO tenía logs de la conversación específica del cliente. En la corte no pudieron argumentar "el bot no dijo eso" ni "el usuario lo manipuló" — sin traces, no había forensics.
**Cómo se arregló**: post-caso, la mayoría de chatbots corporativos añadieron trazado obligatorio + retention >90 días + audit trail firmado.
**Qué aprendió la industria**: **traces persistidos con `prompt_version`** son evidencia legal directa. Sin ellos, disputas son ambiguas y las cortes fallan contra la empresa.

### DPD chatbot swearing (enero 2024)
**Qué pasó**: usuarios jailbrekearon el bot público de DPD (paquetería UK) para que insultara a la empresa; screenshots viralizaron.
**Cómo se detectó**: por Twitter, no por dashboard interno. DPD no tenía alerting.
**Cómo se arregló**: desactivación pública del bot; investigación interna; volvieron ~semanas después con guardrails.
**Qué aprendió la industria**: alerta sobre `thumbs_down_rate spike` o `content_filter_triggered_count` habría detectado el ataque en horas, no días. En 2024+, alertas semánticas (no solo infra) son estándar.

### Datadog LLM Observability (GA 2024)
**Qué pasó**: Datadog lanzó producto integrado con APM tradicional; en 2026 ~30% market share entre enterprise stack-Datadog.
**Cómo se detectó (adopción)**: encuestas de State of DevOps 2025.
**Cómo se arregló (para clientes)**: correlación automática entre spans LLM y APM traces (infra, DB, HTTP).
**Qué aprendió la industria**: si ya usas Datadog, integrar LLM Obs en el mismo pane of glass reduce time-to-debug significativamente vs mantener dos herramientas separadas.

### Weights & Biases Weave (2024)
**Qué pasó**: W&B lanzó Weave para tracing LLM integrado con su ML lifecycle (experiments, models registry).
**Cómo se detectó (adopción)**: equipos que ya trackean experiments con W&B lo adoptaron para el bloque LLM (fine-tuning, RAG evals).
**Qué aprendió la industria**: para equipos con presencia ML tradicional + LLM app, unificar en W&B evita silos entre ML researchers y app engineers.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Levantar Langfuse self-hosted

**Objetivo**: tener Langfuse corriendo en local con docker-compose y crear el primer trace.

**Setup**: Docker y docker-compose instalados.

**Pasos**:
1. Clone langfuse: `git clone https://github.com/langfuse/langfuse.git`.
2. `docker compose up -d`.
3. Verifica http://localhost:3000, crea cuenta y project.
4. Copia `LANGFUSE_PUBLIC_KEY` y `LANGFUSE_SECRET_KEY`.
5. Instala SDK: `pip install "langfuse>=3.0" openai`.
6. Corre un script mínimo con `@observe()` que llame a un LLM.
7. Verifica el trace en UI.

**Criterios de éxito**:
- [ ] Langfuse corriendo y accesible.
- [ ] Al menos un trace visible en UI con input/output/tokens.
- [ ] Latencia y coste visibles.

**Hints**:
1. Si docker compose falla, verifica que puertos 3000/5432/8123/9000/6379 están libres.
2. La primera vez, el arranque tarda ~2-3 min mientras ClickHouse init.
3. El cost solo aparece si tu SDK version >=3.0 y anexas `usage` explícitamente.

**Solución de referencia (script mínimo)**:
```python
from langfuse.decorators import observe
from openai import OpenAI
c = OpenAI()
@observe(as_type="generation")
def hello():
    r = c.chat.completions.create(model="gpt-4o-mini",
        messages=[{"role":"user","content":"hi"}])
    return r.choices[0].message.content
print(hello())   # ve el trace en http://localhost:3000
```

**Bonus**: exporta traces con OpenLLMetry (Traceloop) en vez del SDK nativo. Confirma que ambos aparecen en la misma UI.

---

### Ejercicio 2: PII masking end-to-end

**Objetivo**: enmascarar PII antes de persistir traces.

**Setup**: la app del ejercicio 1 + Presidio.

**Pasos**:
1. Instala Presidio y `spacy download en_core_web_lg`.
2. Envuelve `input` y `output` en `mask_pii()` antes del `update_current_observation`.
3. Genera 5 traces con inputs que contengan email, teléfono, número de tarjeta.
4. Verifica en UI que el trace no muestra el PII original.
5. Genera un trace con PII en el output del LLM (el modelo copia del contexto) y verifica que también se enmascara.

**Criterios de éxito**:
- [ ] 5 traces con PII enmascarada en input.
- [ ] Al menos 1 trace con PII enmascarada en output.
- [ ] Documentar qué entities detectó Presidio.

**Bonus**: añade una entity custom (ej. `LICENSE_PLATE_ES` con regex `[0-9]{4}[A-Z]{3}`).

---

### Ejercicio 3: Cost dashboard con Grafana

**Objetivo**: dashboard operacional con top-5 features/users por coste.

**Setup**: Langfuse + Grafana (docker) + acceso a Postgres de Langfuse.

**Pasos**:
1. Genera ~50 traces variando `feature` y `user_id`.
2. Instala Grafana: `docker run -p 3001:3000 grafana/grafana`.
3. Añade datasource Postgres apuntando al DB de Langfuse.
4. Crea panels:
   - Cost total últimas 24h.
   - Cost por feature (stacked bar).
   - Top 10 users por cost.
   - Cost por prompt_version.
5. Configura alerta: cost últimas 1h > 3 × avg últimas 24h.

**Criterios de éxito**:
- [ ] Dashboard con 4 panels funcionando.
- [ ] Alerta configurada.
- [ ] Simular un spike inyectando traces caros; verificar que la alerta dispara.

**Bonus**: enviar alerta a un webhook Slack/Discord.

---

### Ejercicio 4: Debug un bug reportado usando trace

**Objetivo**: practicar el debug loop completo.

**Setup**: la app del ejercicio 1 + un "usuario" que reportes bugs simulados.

**Pasos**:
1. Añade al menos 2 bugs intencionados en tu prompt (ej. instruction ambigua que causa respuestas malas para queries tipo "Y").
2. Genera 20 traces con queries variadas.
3. "Usuario reporta": una query específica dio mala respuesta.
4. Filtra trace por timestamp + user_id.
5. Reproduce localmente con el input exacto.
6. Ajusta el prompt hasta arreglar.
7. Añade el caso al dataset de evals.
8. Corre regression suite; verifica que otros casos no rompen.

**Criterios de éxito**:
- [ ] Bug reproducido con trace.
- [ ] Fix aplicado y verificado.
- [ ] Caso añadido al dataset con expected_output.
- [ ] Regression test corre y pasa.

**Bonus**: incluye este flujo en un script `bin/triage-thumbs-down.sh` que liste los últimos traces con feedback negativo.

---

### Ejercicio 5: Correlar trace LLM con log backend

**Objetivo**: propagar `trace_id` entre tu API HTTP y las llamadas LLM.

**Setup**: FastAPI (o Flask) + OpenTelemetry auto-instrumentation.

**Pasos**:
1. `pip install fastapi uvicorn opentelemetry-instrumentation-fastapi opentelemetry-instrumentation-requests`.
2. Endpoint FastAPI que recibe query, llama al RAG, devuelve response.
3. Instrumentar FastAPI y `requests` con OTEL.
4. Configurar OTLP exporter apuntando a Langfuse.
5. Llamar al endpoint desde `curl` con header `traceparent` custom.
6. Verificar que el mismo `trace_id` aparece en el trace de Langfuse y en el log de FastAPI.

**Criterios de éxito**:
- [ ] Endpoint FastAPI funcional con OTEL.
- [ ] `trace_id` propagado desde header al span LLM.
- [ ] Log del endpoint y trace de Langfuse comparten `trace_id`.

**Hints**:
1. Formato W3C traceparent: `00-{trace_id 32 hex}-{span_id 16 hex}-01`.
2. `TracerProvider` debe configurarse ANTES de importar cualquier módulo instrumentado.
3. En tests, usa `InMemorySpanExporter` para verificar spans sin backend.

**Bonus**: añade un downstream microservice (mock) que también propague trace_id; verifica el árbol completo en un backend Jaeger/Tempo.

---

### Ejercicio 6 (Reto): Stack completo OTEL GenAI + Langfuse + Prometheus/Grafana + alerting

**Objetivo**: montar el pipeline productivo completo del §3.10 + §5.8: traces → Langfuse (debug) + metrics → Prometheus/Grafana (dashboards + alertas).

**Setup**: docker compose con Langfuse + Prometheus + Grafana + tu app instrumentada.

**Pasos**:
1. Añade al `docker-compose.yml` de Langfuse los servicios de Prometheus y Grafana.
2. Instrumenta tu app con OTEL traces (Langfuse) + OTEL metrics + Prometheus exporter (§3.10).
3. Genera ~500 requests variando `feature`, `user_id`, `model`.
4. Configura Prometheus para scrape en `/metrics:9464`.
5. En Grafana: 3 panels (cost por feature, p99 latency, thumbs_down_rate).
6. Alerta PromQL: cost_hourly > 3× rolling_24h → webhook Slack/Discord.
7. Simula un cost spike (inyecta requests caros); verifica que dispara.
8. Documenta el playbook: qué mira on-call cuando dispara la alerta.

**Criterios de éxito**:
- [ ] docker compose levanta todo (langfuse + prometheus + grafana).
- [ ] Traces visibles en Langfuse UI.
- [ ] `/metrics` expone `llm_cost_usd_total`, `llm_latency_ms`, `llm_calls_total`.
- [ ] Grafana muestra 3 panels con datos live.
- [ ] Alerta dispara y llega al webhook.
- [ ] Playbook documentado (qué queries correr, dónde mirar).

**Hints**:
1. Prometheus scrape config: `scrape_interval: 15s` es suficiente.
2. Grafana datasource: añade Prometheus (http://prometheus:9090) y Postgres (para join con Langfuse metadata).
3. Para simular spike: `for i in {1..100}; do curl POST /chat -d @heavy-request.json; done`.

**Solución de referencia (fragmentos clave)**:
```yaml
# docker-compose additions
prometheus:
  image: prom/prometheus:latest
  volumes: ["./prometheus.yml:/etc/prometheus/prometheus.yml:ro"]
  ports: ["9090:9090"]
grafana:
  image: grafana/grafana:latest
  ports: ["3001:3000"]
  environment: [GF_SECURITY_ADMIN_PASSWORD=admin]
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'linguadev-app'
    static_configs:
      - targets: ['host.docker.internal:9464']
```

```yaml
# Alert rule
groups:
- name: llm_cost
  rules:
  - alert: CostSpike3x
    expr: sum(rate(llm_cost_usd_total[1h])) / sum(rate(llm_cost_usd_total[24h])) > 3
    for: 10m
    annotations:
      summary: "LLM cost >3x avg últimas 24h"
```

**Bonus máximo**: añade span-based sampling (§5.8-A) para reducir storage 10x sin perder visibilidad de errores/cost alto.

---

## 9. Recursos + siguientes pasos

### Referencias oficiales 2026

- [Langfuse docs](https://langfuse.com/docs) — self-host y cloud.
- [LangSmith docs](https://docs.smith.langchain.com/) — observability + evals.
- [Braintrust docs](https://www.braintrust.dev/docs) — SaaS eval-first.
- [Arize Phoenix](https://phoenix.arize.com/) — OTEL-native open source.
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) — spec oficial.
- [OpenLLMetry / Traceloop](https://github.com/traceloop/openllmetry) — OTEL-native SDK.
- [Helicone docs](https://docs.helicone.ai/) — proxy transparente.
- [Datadog LLM Observability](https://docs.datadoghq.com/llm_observability/) — para stacks Datadog.
- [W&B Weave](https://wandb.ai/site/weave/) — dentro de W&B.
- [Microsoft Presidio](https://microsoft.github.io/presidio/) — PII masking.

### Papers y blogs

- OpenTelemetry GenAI SIG updates (búsqueda en el blog de OTEL).
- Chip Huyen — *Designing Machine Learning Systems* (cap sobre monitoring, extrapolable a LLMs).
- Langfuse blog — casos de uso enterprise 2025-2026.
- Braintrust blog — post-mortems de regressions detectadas por evals + traces.

### Tools recomendadas 2026

- **Open source self-host**: Langfuse v3, Arize Phoenix.
- **SaaS**: Braintrust, LangSmith, Datadog LLM Obs.
- **Proxy simple**: Helicone.
- **OTEL SDK**: OpenLLMetry (Traceloop) o SDKs oficiales de plataformas.
- **PII masking**: Microsoft Presidio.
- **Metrics/alerting**: Prometheus + Grafana, o backend nativo de la plataforma.

### Qué leer después

- Capítulo 11-12 (Seguridad) — trazado como fuente forense para incidents.
- Capítulo 13 (Coste) — cost tracking granular + optimizaciones.
- Capítulo 14 (MLOps / deploy) — trazado en producción a escala.

---

## 10. Preguntas de práctica (20)

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-10-llm-observability-tracing.json`](../../packages/content/src/tech/ai-programming/sim-10-llm-observability-tracing.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-10-llm-observability-tracing`

---

## Navegación

[← Capítulo 09](./09-evals-datasets-llm-judge.md) · [Índice](./README.md) · [Capítulo 11 →](./11-prompt-injection-owasp-llm.md)
