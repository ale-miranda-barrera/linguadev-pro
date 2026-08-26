# Capítulo 20 — Distributed tracing

> **Focus:** Traces y spans como tercer pilar de observability. OpenTelemetry (SDK, Collector 0.116+, OTLP), W3C Trace Context, sampling head/tail/adaptive/probabilistic, auto vs manual instrumentation, backends Jaeger 2.0, Grafana Tempo 2.7 + TraceQL, Zipkin, span attributes con semantic conventions, log-to-trace correlation, service graph, RED metrics desde traces.
> **Áreas:** Observability · Monitoring · SRE · Debugging distributed systems
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de microservicios y HTTP/gRPC (ver [cap 05 — microservicios](./07-fundamentos-kubernetes.md)).
- Logging estructurado (ver [cap 19 — logging ELK/Loki](./19-logging-elk-loki.md)).
- Métricas Prometheus básicas (ver [cap 17 — Prometheus y metrics](./17-prometheus-y-metrics.md)).
- Docker y Kubernetes básicos (ver [cap 07](./07-fundamentos-kubernetes.md)) para desplegar collector y backends.
- Un servicio de ejemplo instrumentable (Node.js, Python, Go o Java).

**Glosario mínimo:**
- **Trace**: árbol jerárquico de spans que representa el recorrido de una petición cross-service.
- **Span**: unidad de trabajo (operación) con `start_time`, `end_time`, `span_id`, `parent_span_id`, `trace_id`, atributos y eventos.
- **Root span**: primer span del trace, sin `parent_span_id`.
- **Trace ID**: identificador de 128 bits (32 hex chars) que amarra spans de un mismo request. En W3C viaja como `traceparent` header.
- **W3C Trace Context**: standard (2020) que define `traceparent` y `tracestate` headers para propagación entre services.
- **OpenTelemetry (OTel)**: standard OSS CNCF que unifica traces, metrics y logs. Fusiona OpenTracing y OpenCensus (2019).
- **OTLP** (OpenTelemetry Protocol): wire protocol (gRPC o HTTP/protobuf) entre SDK → Collector → Backend.
- **Collector**: proxy/pipeline binary con arquitectura `receiver → processor → exporter`. Puede correr en modo agent (por nodo) o gateway (centralizado).
- **Sampling**: decisión de qué traces persistir (nunca se guarda 100% en escala). Estrategias: head (al empezar), tail (tras completar el trace), probabilistic, adaptive.
- **Exemplar**: link desde un data point de una métrica Prometheus hacia un `trace_id` concreto. Puente metrics ↔ traces.
- **Semantic conventions**: attributes estandarizados por OTel (`http.request.method`, `db.system`, `messaging.destination.name`) para permitir queries cross-service.
- **Jaeger**: backend de tracing de Uber (2016, CNCF graduated). V2 en 2024 rewrote sobre OTel Collector.
- **Tempo**: backend de tracing de Grafana Labs (2020). Almacena en object storage (S3/GCS). Query con **TraceQL**.
- **Zipkin**: backend clásico de Twitter (2012).
- **RED metrics**: Rate, Errors, Duration — derivables desde traces por span_metrics processor.

**Setup mínimo:**

```bash
# 1. Cluster local kind
kind create cluster --name trace-lab

# 2. OpenTelemetry Collector 0.116+
kubectl create namespace observability
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm install otel-collector open-telemetry/opentelemetry-collector \
  --namespace observability \
  --set image.repository=otel/opentelemetry-collector-contrib \
  --set image.tag=0.116.1 \
  --set mode=deployment

# 3. Grafana Tempo 2.7 (single binary para lab)
helm repo add grafana https://grafana.github.io/helm-charts
helm install tempo grafana/tempo \
  --namespace observability \
  --set tempo.repository=grafana/tempo \
  --set tempo.tag=2.7.0

# 4. Jaeger 2.0 (opcional, como comparación)
kubectl apply -f https://github.com/jaegertracing/jaeger-operator/releases/download/v2.0.0/jaeger-operator.yaml
kubectl apply -f - <<'YAML'
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-lab
  namespace: observability
spec:
  strategy: allInOne
  storage:
    type: memory
YAML

# 5. Grafana con datasource Tempo
helm install grafana grafana/grafana --namespace observability

# 6. SDKs de instrumentation
npm install --save \
  @opentelemetry/api \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http

pip install \
  opentelemetry-api \
  opentelemetry-sdk \
  opentelemetry-exporter-otlp \
  opentelemetry-instrumentation-fastapi \
  opentelemetry-instrumentation-requests
```

---

## 1. El gran cuadro

En un monolito, cuando algo va lento se agarra el debugger, se ponen prints y se sigue el flujo. En un sistema distribuido esa estrategia colapsa: **un request de `/checkout` que dura 3 segundos p99 atraviesa 8 microservicios**, cada uno con sus logs, cada equipo mirando su parte, y nadie ve el picture completo. **Distributed tracing** resuelve exactamente ese problema. Cada operación (HTTP call, DB query, message publish, function execution significativa) se registra como un **span** con `start_time`, `end_time`, y una relación `parent → child` que forma un árbol. Todos los spans de un mismo request comparten un `trace_id`. El resultado es una **visualización waterfall**: barras horizontales indentadas por jerarquía, longitud proporcional a duración. En segundos identificás que el culpable de esos 3s es `payment-service` que tomó 2.5s.

El concepto no es nuevo. **Google Dapper** (paper 2010) lo introdujo internamente; **Twitter Zipkin** (2012) fue el primer OSS; **Uber Jaeger** (2016) llegó a CNCF y se graduó; **Grafana Tempo** (2020) apostó por object storage. Lo que cambió alrededor de 2019 fue la unificación: **OpenTelemetry (OTel)** fusionó OpenTracing y OpenCensus, y en 2026 es el standard universal —CNCF graduated, adoptado por Datadog, New Relic, Splunk, Honeycomb como formato de ingest, y por vendors OSS como formato nativo—. La promesa: **instrumentás una vez con OTel API y exportás a cualquier backend**. Antes, cada vendor tenía SDK propio: si migrabas de Datadog a Honeycomb, reescribías toda la instrumentation.

La arquitectura moderna se compone de tres capas. **SDK en la app** genera spans (auto-instrumentation para frameworks conocidos + manual para business logic). Los spans se emiten en formato **OTLP** hacia un **Collector** que corre en el cluster (típicamente como DaemonSet + gateway centralizado). El Collector tiene pipeline `receiver → processor → exporter`: recibe OTLP, procesa (batch, sampling, filter, tail sampling, span metrics), y exporta a uno o varios backends (Jaeger, Tempo, Zipkin, Datadog, Honeycomb). En 2026, **Jaeger 2.0** (octubre 2024) reescribió su arquitectura sobre OTel Collector; **Tempo 2.7** trae mejoras en TraceQL (query language dedicado a traces); **OTel Collector 0.116** endurece defaults de seguridad y unifica semantic conventions estables.

La decisión más importante en producción es **sampling**. Persistir el 100% de traces en un sistema con 100 req/s es caro y ruidoso; persistir 0.1% deja huecos justo cuando pasa un incidente raro. Las estrategias van desde `head sampling` simple (decidí al empezar con probabilidad P), pasando por `tail sampling` (decidí tras ver el trace completo — persistí todos los errors + traces lentos + 1% del resto), hasta `adaptive sampling` (ajustá P por endpoint según volumen). Este capítulo cubre spans y contexto W3C, OpenTelemetry end-to-end, sampling, backends comparados, log-trace correlation, RED metrics derivadas de spans, y termina con ejercicios sobre **LinguaDev Pro** que instrumentan los servicios reales del proyecto.

---

## 2. Spans, contexto y OpenTelemetry (nivel básico)

### 2.1 Anatomía de un span

Un span tiene una lista fija de campos:

| Campo | Descripción |
|---|---|
| `name` | Categoría corta, low-cardinality (`process_order`, no `process_order_12345`). |
| `trace_id` | 128 bits hex, compartido por todos los spans del trace. |
| `span_id` | 64 bits hex, único del span. |
| `parent_span_id` | 64 bits hex, o vacío si es root. |
| `start_time`, `end_time` | Nanosegundos desde epoch. |
| `kind` | `INTERNAL`, `SERVER`, `CLIENT`, `PRODUCER`, `CONSUMER`. |
| `status` | `UNSET`, `OK`, `ERROR`. |
| `attributes` | Map key-value de metadata (`http.request.method=GET`, `db.system=postgresql`). |
| `events` | Timestamped "structured logs" dentro del span. |
| `links` | Referencias a otros spans (útil para batch processing). |
| `resource` | Metadata del proceso emisor (`service.name`, `service.version`, `k8s.pod.name`). |

Un ejemplo JSON serializado (formato OTLP):

```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "parentSpanId": "b7ad6b7169203331",
  "name": "GET /api/lessons/:id",
  "kind": "SPAN_KIND_SERVER",
  "startTimeUnixNano": "1730000000000000000",
  "endTimeUnixNano": "1730000000450000000",
  "attributes": [
    { "key": "http.request.method",    "value": { "stringValue": "GET" } },
    { "key": "http.route",             "value": { "stringValue": "/api/lessons/:id" } },
    { "key": "http.response.status_code", "value": { "intValue": 200 } },
    { "key": "user.id",                "value": { "stringValue": "u_42" } },
    { "key": "lesson.id",              "value": { "stringValue": "lesson_a2_present_simple" } }
  ],
  "status": { "code": "STATUS_CODE_OK" }
}
```

### 2.2 W3C Trace Context: propagación entre services

Cuando Service A llama a Service B por HTTP, B debe conocer el `trace_id` para que su span sea hijo del de A. El standard **W3C Trace Context** (2020) define dos headers:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
tracestate:  linguadev=abc,vendor=xyz
```

Formato de `traceparent`: `<version>-<trace_id>-<parent_id>-<flags>`.

- `version` = `00` (única definida).
- `trace_id` = 32 hex chars (128 bits).
- `parent_id` = 16 hex chars (64 bits) — el `span_id` del emisor, que será `parent_span_id` del receptor.
- `flags` = 1 byte hex; bit 0 = `sampled` (si 1, el trace se muestreó).

Flujo:

```
    ┌────────────┐    HTTP + traceparent    ┌────────────┐
    │  Client    │───────────────────────>  │  API GW    │
    └────────────┘                          └─────┬──────┘
                                                  │
                                          extract traceparent
                                          crea span SERVER
                                                  │
                                  HTTP + traceparent (nuevo span_id)
                                                  ▼
                                            ┌────────────┐
                                            │  Lessons   │
                                            └─────┬──────┘
                                                  │
                                          PG query span (CLIENT)
                                                  ▼
                                            ┌────────────┐
                                            │ Postgres   │
                                            └────────────┘
```

**Legacy alternatives (aún encontrarás en 2026):** `b3` (Zipkin), `uber-trace-id` (Jaeger nativo), `x-datadog-*`. OTel SDK maneja múltiples propagators simultáneamente con `TraceContextPropagator + B3Propagator + JaegerPropagator`.

### 2.3 OpenTelemetry: componentes

```
                ┌──────────────────────────┐
   App code ─── │  OTel SDK (per language) │──── OTLP ────┐
                └──────────────────────────┘              │
                                                          ▼
                    ┌───────────────────────────────────────────┐
                    │        OTel Collector 0.116+              │
                    │                                           │
                    │  receivers ─> processors ─> exporters     │
                    │  (otlp)      (batch,        (otlphttp,    │
                    │              tail_sampling,  jaeger,      │
                    │              span_metrics)   prometheus)  │
                    └────────────────┬───┬──────────────────────┘
                                     │   │
                              ┌──────┘   └────────┐
                              ▼                   ▼
                        ┌──────────┐         ┌──────────┐
                        │  Tempo   │         │  Jaeger  │
                        └──────────┘         └──────────┘
```

Componentes:

1. **Specification** — data model + semantic conventions.
2. **API** — interfaces mínimas para que la instrumentation sea SDK-agnóstica.
3. **SDK per lenguaje** — Go, Java, Python, .NET, JS/TS, Ruby, Rust, C++, PHP.
4. **Auto-instrumentation libraries** — packages que hookean frameworks conocidos (Express, Flask, gRPC, PG driver) sin código.
5. **Manual instrumentation** — spans custom para business logic.
6. **Collector** — pipeline binary.
7. **OTLP** — wire protocol universal.

### 2.4 Auto-instrumentation en Node.js

Instalación una vez:

```bash
npm install --save \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

```javascript
// telemetry.js — cargar antes que el resto de la app
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { Resource } = require("@opentelemetry/resources");
const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");

const sdk = new NodeSDK({
    resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]: "linguadev-api",
        [SEMRESATTRS_SERVICE_VERSION]: "2.1.0",
        "deployment.environment": process.env.ENV ?? "dev",
    }),
    traceExporter: new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://otel-collector:4318/v1/traces",
    }),
    instrumentations: [getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },   // ruido en Node
    })],
});

sdk.start();

process.on("SIGTERM", () => sdk.shutdown());
```

```bash
node --require ./telemetry.js src/server.js
```

Con solo eso, Express, HTTP client, PG, Redis, gRPC, Kafka... generan spans automáticamente.

---

## 3. Instrumentación manual, semantic conventions y Collector (nivel medio)

### 3.1 Spans custom para business logic

Cuando la auto-instrumentation no basta (envolver una función de negocio, medir latencia de un LLM call):

```typescript
import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";

const tracer = trace.getTracer("linguadev-api", "2.1.0");

export async function processLessonSubmission(userId: string, lessonId: string, answers: unknown) {
    return tracer.startActiveSpan(
        "process_lesson_submission",
        {
            kind: SpanKind.INTERNAL,
            attributes: {
                "user.id": userId,
                "lesson.id": lessonId,
                "lesson.answers_count": Array.isArray(answers) ? answers.length : 0,
            },
        },
        async (span) => {
            try {
                span.addEvent("validation_start");
                const validated = validate(answers);
                span.addEvent("validation_done", { valid_count: validated.length });

                const scored = await tracer.startActiveSpan("score_answers", async (sub) => {
                    const result = await scoreEngine.score(validated);
                    sub.setAttribute("score.correct", result.correct);
                    sub.setAttribute("score.total", result.total);
                    sub.end();
                    return result;
                });

                await persistProgress(userId, lessonId, scored);
                span.setStatus({ code: SpanStatusCode.OK });
                return scored;
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
                throw err;
            } finally {
                span.end();
            }
        }
    );
}
```

**Reglas:**
- `name` es low-cardinality (`process_lesson_submission`, no `process_lesson_lesson_a2_present_simple`).
- IDs específicos van como attributes.
- Usa `SpanKind.SERVER` en handlers HTTP, `SpanKind.CLIENT` en llamadas out, `SpanKind.PRODUCER/CONSUMER` en messaging.
- Sí llamás `startSpan` en vez de `startActiveSpan`, tienes que propagar el context manualmente.
- Nunca crees un span por línea de código; unidad = "operación significativa".

### 3.2 Semantic conventions

OTel define nombres estándar de attributes para que queries cross-service funcionen. Sin estos, un span de "call HTTP" en Go se llama `http.method=GET` y en Python `HTTP_METHOD=GET` — imposible correlacionar.

| Dominio | Attributes clave |
|---|---|
| HTTP client | `http.request.method`, `server.address`, `url.path`, `http.response.status_code` |
| HTTP server | `http.request.method`, `http.route`, `http.response.status_code`, `server.address` |
| Database | `db.system`, `db.name`, `db.operation`, `db.statement` (⚠️ sensible: sanitizá) |
| Messaging | `messaging.system`, `messaging.destination.name`, `messaging.operation` |
| RPC | `rpc.system`, `rpc.service`, `rpc.method` |
| Faas | `faas.name`, `faas.trigger`, `cloud.provider` |
| Exception | evento `exception` con `exception.type`, `exception.message`, `exception.stacktrace` |

Business attributes (fuera de spec, pero recomendables) con prefijo propio: `linguadev.tenant.id`, `linguadev.feature_flag.new_scoring`.

### 3.3 OTel Collector: pipeline configurable

El Collector es el "swiss army knife" que recibe, procesa y exporta. Config en YAML:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }

processors:
  batch:
    timeout: 5s
    send_batch_size: 512

  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 15

  resource:
    attributes:
      - key: deployment.environment
        value: production
        action: upsert

  tail_sampling:
    decision_wait: 30s
    num_traces: 100000
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 500 }
      - name: probabilistic
        type: probabilistic
        probabilistic: { sampling_percentage: 1 }

  spanmetrics:
    metrics_exporter: prometheus
    dimensions:
      - name: http.route
      - name: http.request.method
      - name: http.response.status_code

exporters:
  otlphttp/tempo:
    endpoint: http://tempo:4318

  jaeger:
    endpoint: jaeger-collector:14250
    tls: { insecure: true }

  prometheus:
    endpoint: 0.0.0.0:8889

service:
  pipelines:
    traces:
      receivers:  [otlp]
      processors: [memory_limiter, resource, tail_sampling, batch, spanmetrics]
      exporters:  [otlphttp/tempo, jaeger]

    metrics:
      receivers:  [otlp]
      processors: [memory_limiter, batch]
      exporters:  [prometheus]
```

Modos de deployment:
- **Agent** (DaemonSet en K8s, sidecar en VMs): recibe local, agrega y envía.
- **Gateway** (Deployment central): recibe de agents, aplica tail sampling que necesita ver el trace completo, exporta a backends.
- Patrón típico: **agent + gateway** en paralelo. Agent en cada nodo hace batch simple; gateway hace tail sampling y policies globales.

### 3.4 Sampling strategies

| Estrategia | Cuándo se decide | Ventajas | Desventajas |
|---|---|---|---|
| **Head, probabilistic** | Al crear el trace | Simple, low overhead, decisión propagada por `traceparent` sampled bit | Pierde eventos raros; misma prob para OK y errors |
| **Head, rate-limited** | Al crear el trace | Predecible costo (N traces/s) | No prioriza traces valiosos |
| **Tail** | Tras completar el trace en un buffer del gateway | Puede persistir "todos los errors + slow" | Buffer memoria; latencia extra; requiere gateway con state |
| **Adaptive** | Ajuste continuo por endpoint | Compensa desbalances (endpoint de bajo volumen mantiene visibilidad) | Complejidad, requiere control loop |
| **Always on** | Todo | Máxima visibilidad | Costo prohibitivo en escala |
| **Always off** | Nada | Costo cero | Sin traces |

**Combinación típica producción:**
- Head sampling `10%` como base — decisión en el borde del sistema.
- Tail sampling en gateway: **siempre** mantener errors + traces > p95 latency + probabilistic 1% del resto.
- Ajustar por endpoint con `spanmetrics` processor que expone counts.

---

## 4. Backends, correlación y patrones avanzados (nivel senior)

### 4.1 Jaeger vs Tempo vs Zipkin en 2026

| Feature | Jaeger 2.0 | Grafana Tempo 2.7 | Zipkin |
|---|---|---|---|
| Storage | Cassandra, ES, OpenSearch, Badger | Object storage (S3, GCS, Azure Blob) | ES, Cassandra, in-memory |
| Query language | Simple (traceID, service, operation, tags) | **TraceQL** (SQL-like potente) | Filter simple |
| Retention económica | Alta (necesita ES cluster) | Muy baja (S3 barato) | Media |
| UI | Nativa | Grafana Explore | Nativa (más simple) |
| OTel-native | Sí (v2 built on Collector) | Sí (OTLP nativo) | Sí (con Collector) |
| Integración logs↔traces | Vía tags | **Nativa con Loki + traceID** | Manual |
| Curva aprendizaje | Baja | Media (TraceQL) | Baja |
| Sweet spot 2026 | Existing Jaeger users, on-prem | Grafana shops, cost-sensitive | Legacy Zipkin |

**Jaeger 2.0** (octubre 2024) reescribió su collector como distribution del OTel Collector. Mismo binario, misma UI, mejor mantenibilidad.

**Tempo 2.7** trae mejoras en TraceQL (query language dedicado a traces, inspirado en LogQL de Loki):

```traceql
{ .service.name = "linguadev-api" && duration > 500ms && status = error }

{ .http.route = "/checkout" } | select(.user.id, .payment.method)

{ .db.system = "postgresql" } | avg(duration) by (.http.route)

{ .service.name = "linguadev-api" } &&> { .service.name = "payment-service" && duration > 1s }
```

El último ejemplo (`&&>`) es "structural" — matchea traces donde un span de `linguadev-api` es ancestro de un span slow en `payment-service`.

### 4.2 Correlación logs ↔ traces ↔ metrics

Los tres pilares se refuerzan mutuamente. La clave es propagar `trace_id` en cada log line y como exemplar en cada métrica.

**Logs con trace_id (winston + otel):**

```typescript
import winston from "winston";
import { context, trace } from "@opentelemetry/api";

const logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp, ...rest }) => {
            const span = trace.getSpan(context.active());
            const spanCtx = span?.spanContext();
            return JSON.stringify({
                ts: timestamp, level, msg: message,
                trace_id: spanCtx?.traceId,
                span_id:  spanCtx?.spanId,
                ...rest,
            });
        })
    ),
    transports: [new winston.transports.Console()],
});
```

Con esto, cada log line lleva `trace_id`. En Grafana Explore, click en `trace_id` de un log Loki abre el trace en Tempo.

**Exemplars en Prometheus:** cuando el histograma `http_request_duration_seconds` recibe una observación, se adjunta un exemplar con el `trace_id` correspondiente. En Grafana, al hacer zoom en el bucket lento, aparece un punto clickable que abre el trace específico.

**Service graph** desde traces: el processor `servicegraph` del OTel Collector deriva un DAG de dependencias service-to-service en tiempo real, exportable como métricas Prometheus (`traces_service_graph_request_total{client="frontend", server="api"}`).

### 4.3 RED metrics desde traces

R.E.D. = **R**ate, **E**rrors, **D**uration. El processor `spanmetrics` deriva estas métricas de los spans automáticamente:

```yaml
processors:
  spanmetrics:
    metrics_exporter: prometheus
    latency_histogram_buckets: [2ms, 6ms, 10ms, 100ms, 250ms, 500ms, 1s, 3s]
    dimensions:
      - name: service.name
      - name: http.route
      - name: http.response.status_code
```

Genera métricas Prometheus:

```
calls_total{service_name="linguadev-api", http_route="/checkout", http_response_status_code="200"}
latency_bucket{service_name="linguadev-api", http_route="/checkout", le="0.5"}
```

Beneficio: **no dependés de que cada dev instrumente Prometheus a mano**; si hay traces, hay RED metrics.

### 4.4 Errors, exceptions y baggage

Errores en spans: `span.setStatus(StatusCode.ERROR)` + `span.recordException(err)`. El SDK crea automáticamente un evento `exception` con `exception.type`, `exception.message`, `exception.stacktrace`.

**Baggage** = key-values que viajan con el context pero NO se guardan como attributes de span. Útil para propagar `tenant_id` sin tener que setearlo en cada span:

```typescript
import { propagation, context } from "@opentelemetry/api";

const withTenant = propagation.setBaggage(
    context.active(),
    propagation.createBaggage({ "tenant_id": { value: "acme_corp" } })
);

context.with(withTenant, async () => {
    await callDownstream();  // el HTTP client propaga 'baggage: tenant_id=acme_corp'
});
```

**Cuidado:** baggage viaja en headers a todos los downstreams. No metas PII ni tokens.

### 4.5 Costos y patrones de retención

Los traces explotan en volumen. Cuentas gruesas: 1 request → 20 spans → 1KB cada uno = 20KB/req. 100 req/s = 2MB/s = 172GB/día = 5TB/mes. Multiplicado por N environments.

**Patrones para controlar costos:**
1. **Tail sampling agresivo**: persistir 1-5% del total, siempre errors + slow.
2. **Retención escalonada**: hot (7 días en SSD), warm (30 días en object storage), cold (auditoría, solo errors).
3. **Attributes limits** en SDK: `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT=1024`, `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT=128`.
4. **Drop noisy spans**: filter processor bota `GET /healthz` y polling loops.
5. **Grafana Tempo con S3** es la opción más barata en 2026 (~$0.023/GB/mes).

---

## 5. Ejemplo práctico: LinguaDev Pro con OTel Collector + Tempo + Grafana

Vamos a instrumentar el servicio `api` de LinguaDev Pro, desplegar el Collector con tail sampling, Tempo como backend y Grafana como UI.

### Paso 1: instrumentar el servicio API (Node.js/Express)

```typescript
// packages/api/src/telemetry.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
    SEMRESATTRS_SERVICE_NAME,
    SEMRESATTRS_SERVICE_VERSION,
    SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";

export function initTelemetry() {
    const sdk = new NodeSDK({
        resource: new Resource({
            [SEMRESATTRS_SERVICE_NAME]:    "linguadev-api",
            [SEMRESATTRS_SERVICE_VERSION]: process.env.APP_VERSION ?? "dev",
            [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.ENV ?? "dev",
        }),
        traceExporter: new OTLPTraceExporter({
            url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://otel-collector.observability:4318/v1/traces",
        }),
        instrumentations: [getNodeAutoInstrumentations({
            "@opentelemetry/instrumentation-fs":         { enabled: false },
            "@opentelemetry/instrumentation-express":    { enabled: true },
            "@opentelemetry/instrumentation-http":       { enabled: true },
            "@opentelemetry/instrumentation-pg":         { enabled: true },
            "@opentelemetry/instrumentation-ioredis":    { enabled: true },
        })],
    });
    sdk.start();
    process.on("SIGTERM", () => sdk.shutdown());
}
```

```typescript
// packages/api/src/server.ts
import "./telemetry";   // DEBE ir antes de todo
import express from "express";
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { pool } from "./db";

const app = express();
const tracer = trace.getTracer("linguadev-api");

app.get("/api/lessons/:id", async (req, res) => {
    const span = trace.getActiveSpan();
    span?.setAttribute("lesson.id", req.params.id);
    span?.setAttribute("user.id", req.user?.id ?? "anon");

    const rows = await pool.query("SELECT * FROM lessons WHERE id = $1", [req.params.id]);
    if (rows.rowCount === 0) {
        span?.setStatus({ code: SpanStatusCode.ERROR, message: "not found" });
        return res.status(404).end();
    }
    res.json(rows.rows[0]);
});

app.post("/api/lessons/:id/submit", async (req, res) => {
    await tracer.startActiveSpan(
        "process_lesson_submission",
        { kind: SpanKind.INTERNAL, attributes: {
            "lesson.id": req.params.id,
            "user.id":   req.user?.id ?? "anon",
        } },
        async (span) => {
            try {
                const result = await scoreSubmission(req.body);
                span.setAttribute("score.correct", result.correct);
                span.setAttribute("score.total",   result.total);
                res.json(result);
                span.setStatus({ code: SpanStatusCode.OK });
            } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
            } finally {
                span.end();
            }
        }
    );
});

app.listen(8080, () => console.log("api on 8080"));
```

### Paso 2: OTel Collector en el cluster

```yaml
# otel-collector.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc: { endpoint: 0.0.0.0:4317 }
          http: { endpoint: 0.0.0.0:4318 }

    processors:
      batch:
        timeout: 5s
        send_batch_size: 512
      memory_limiter:
        check_interval: 1s
        limit_percentage: 75
      resource:
        attributes:
          - key: k8s.cluster.name
            value: linguadev-lab
            action: upsert
      tail_sampling:
        decision_wait: 20s
        num_traces: 50000
        expected_new_traces_per_sec: 1000
        policies:
          - { name: errors, type: status_code, status_code: { status_codes: [ERROR] } }
          - { name: slow,   type: latency, latency: { threshold_ms: 300 } }
          - { name: sample, type: probabilistic, probabilistic: { sampling_percentage: 5 } }
      spanmetrics:
        metrics_exporter: prometheus
        dimensions:
          - { name: service.name }
          - { name: http.route }
          - { name: http.response.status_code }

    exporters:
      otlphttp/tempo:
        endpoint: http://tempo.observability:4318
      prometheus:
        endpoint: 0.0.0.0:8889

    service:
      pipelines:
        traces:
          receivers:  [otlp]
          processors: [memory_limiter, resource, tail_sampling, batch, spanmetrics]
          exporters:  [otlphttp/tempo]
        metrics:
          receivers:  [otlp]
          processors: [memory_limiter, batch]
          exporters:  [prometheus]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  namespace: observability
spec:
  replicas: 2
  selector: { matchLabels: { app: otel-collector } }
  template:
    metadata:
      labels: { app: otel-collector }
    spec:
      containers:
        - name: otel
          image: otel/opentelemetry-collector-contrib:0.116.1
          args: ["--config=/etc/otel/config.yaml"]
          ports:
            - { containerPort: 4317, name: otlp-grpc }
            - { containerPort: 4318, name: otlp-http }
            - { containerPort: 8889, name: metrics }
          volumeMounts:
            - { name: cfg, mountPath: /etc/otel }
      volumes:
        - name: cfg
          configMap: { name: otel-collector-config }
---
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
  namespace: observability
spec:
  selector: { app: otel-collector }
  ports:
    - { name: otlp-grpc, port: 4317 }
    - { name: otlp-http, port: 4318 }
    - { name: metrics,   port: 8889 }
```

### Paso 3: Grafana con datasource Tempo + query TraceQL

En Grafana → Configuration → Data Sources → Add → Tempo → URL `http://tempo.observability:3200`.

Query typical en Explore (TraceQL):

```traceql
# Todos los checkouts lentos con error de la última hora
{ .service.name = "linguadev-api" && .http.route = "/api/lessons/:id/submit" && duration > 500ms && status = error }

# Traces donde api llamó a un payment lento
{ .service.name = "linguadev-api" } &&> { .service.name = "payment-service" && duration > 1s }
```

### Paso 4: correlación logs ↔ traces

Loki con `trace_id` en el log line + Tempo datasource con `derivedFields` que extrae el trace_id del log:

```yaml
# grafana-datasources.yaml (parcial)
apiVersion: 1
datasources:
  - name: Loki
    type: loki
    url: http://loki.observability:3100
    jsonData:
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: '"trace_id":"([a-f0-9]{32})"'
          name: TraceID
          url: "$${__value.raw}"
```

Ahora clicks en `trace_id` de un log line abren el trace en Tempo.

### Paso 5: dashboard RED

Panel Grafana con métricas derivadas de `spanmetrics`:

```
# Rate
sum(rate(calls_total{service_name="linguadev-api"}[5m])) by (http_route)

# Error rate
sum(rate(calls_total{service_name="linguadev-api", status_code="STATUS_CODE_ERROR"}[5m])) by (http_route)
/
sum(rate(calls_total{service_name="linguadev-api"}[5m])) by (http_route)

# p95 latency
histogram_quantile(0.95,
  sum(rate(latency_bucket{service_name="linguadev-api"}[5m])) by (http_route, le))
```

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **OpenTelemetry es el standard 2026**; instrumentá en OTel API, no en SDK vendor.
- ✅ **Span name = categoría low-cardinality**; IDs específicos son attributes.
- ✅ **Usa semantic conventions** para cross-service queries.
- ✅ **W3C Trace Context** como propagator default; añade B3/Jaeger legacy solo si necesitás compat.
- ✅ **Tail sampling** en gateway para producción: siempre errors + slow + N% del resto.
- ✅ **Correlá logs ↔ traces** inyectando `trace_id` en cada log line.
- ✅ **Correlá metrics ↔ traces** con exemplars Prometheus.
- ✅ **RED metrics** desde el `spanmetrics` processor (no reinventes con Prometheus manual).
- ✅ **`SpanKind` correcto** (SERVER en handlers, CLIENT en outbound, PRODUCER/CONSUMER en messaging).
- ✅ **`recordException` + `setStatus(ERROR)`** en catch blocks.
- ✅ **Attribute value length limits** en SDK para prevenir explosion.
- ✅ **Collector en modo agent + gateway** para tail sampling correcto.
- ✅ **Retención escalonada** en Tempo con S3 buckets tiered.
- ✅ **Baggage solo para valores no sensibles** (viaja en headers a todos los downstreams).

### Anti-patrones

- ❌ Span name con IDs (`process_order_12345`) → altísima cardinality, imposible aggregate.
- ❌ Un span por línea de código → overhead prohibitivo.
- ❌ 100% sampling en producción → costos explosivos.
- ❌ Ignorar propagation → cada service genera trace_id propio, traces fragmentados.
- ❌ PII en attributes (email, IP, credit card) sin scrubbing.
- ❌ `db.statement` sin sanitizar → PII y queries gigantes.
- ❌ Instrumentation manual sin auto-instrumentation base (te falta cobertura básica).
- ❌ Cerrar spans en el flujo error sin `setStatus(ERROR)` → dashboards mienten.
- ❌ Baggage con secrets → viajan en headers HTTP.
- ❌ Tempo sin S3 lifecycle → factura AWS explota.
- ❌ Confundir traces con logs → traces son la forma, no el reemplazo.

### Tabla decisión: backend de tracing

| Situación | Elección |
|---|---|
| Grafana shop, cost sensitive | **Tempo 2.7 + S3** |
| On-prem, existing Jaeger, ES/Cassandra ya running | **Jaeger 2.0** |
| Empresa small con Zipkin legacy que funciona | **Zipkin** |
| Ya en Datadog/New Relic/Honeycomb | Enviar OTLP al vendor |
| Multi-tenant SaaS observability | **Tempo con multi-tenancy** |

### Tabla decisión: estrategia de sampling

| Situación | Estrategia |
|---|---|
| Cluster pequeño, dev/staging | Head 100% o head 50% |
| Producción baja escala (<100 req/s) | Head 10% |
| Producción media (100-1000 req/s) | Head 10% + tail (all errors + slow) |
| Producción alta (>1000 req/s) | Head 5% + tail agresivo + drop de healthchecks |
| Endpoints críticos (payments) | Always on por endpoint |
| Endpoints noisy (metrics scrapes) | Always off por endpoint |

---

## 7. Casos reales industria 2023-2026

**Uber Jaeger (2016+, CNCF Graduated 2019):** Uber open-sourced Jaeger tras experiencia con miles de microservicios. Publicaron paper sobre adaptive sampling. Jaeger 2.0 (oct 2024) reescribió su collector sobre OTel Collector como distribution. **Lección:** consolidación en OTel es tendencia unánime.

**Grafana Labs Tempo (2020+):** Tempo apostó por object storage (S3/GCS) como backend primario en vez de Cassandra/ES, drásticamente más barato. TraceQL (2023) como query language dedicado, expandido en Tempo 2.7 (2026) con structural operators. **Lección:** el cost model de traces cambió; S3 hace viable retenciones largas.

**Shopify migración a OTel (2022-2024):** Shopify migró de vendor-specific SDKs a OTel para evitar lock-in. Reportaron 40% reducción en costo de traces con tail sampling agresivo. **Lección:** OTel + tail sampling es palanca clásica de ROI en observability.

**Netflix + adaptive sampling (2020+):** Netflix publicó sobre adaptive sampling per-endpoint. Endpoints de bajo volumen mantienen visibilidad (sampling 100%); endpoints hot (millones/s) sampleados agresivamente. **Lección:** sampling uniforme es antipatrón en escala.

**Slack + OTel (2023):** Slack migró tracing interno a OTel para unificar traces + metrics + logs. Integraron Honeycomb como backend. **Lección:** vendors mainstream soportan OTLP como ingest; podés cambiar backend sin tocar código.

**Datadog OTel support (2023-2024):** Datadog añadió OTLP ingestion como first-class. Antes, `dd-trace` era el SDK obligatorio (lock-in). **Lección:** los vendors se ven forzados a soportar OTel; el standard ganó.

**GitHub incidentes usando tracing (2020-2023):** GitHub post-mortems citan distributed tracing como herramienta principal para diagnosticar issues cross-service. Sin traces, incidentes complejos tomaban >1 hora localizar; con traces, minutos. **Lección:** MTTR se reduce 5-10x con traces bien instrumentados.

**Grafana Cloud Traces + exemplars (2022+):** Grafana Cloud integra exemplars end-to-end (Prometheus → Tempo). Un usuario ve p99 latency histograma, hace click en el bucket alto, y aterriza en el trace específico. **Lección:** UX cross-signal es diferencial competitivo.

**OpenTelemetry graduation en CNCF (2024):** OTel pasó de Incubating a Graduated en 2024. En 2026 es segundo proyecto CNCF más activo después de Kubernetes. **Lección:** la industria coincide en OTel como standard.

**LinkedIn Kafka tracing (2024):** LinkedIn compartió patrón de trazar mensajes Kafka con propagation headers, usando `messaging.destination.name` y `messaging.kafka.consumer.group` como attributes. **Lección:** tracing en messaging requiere disciplina de propagation manual.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Instrumentar el API de LinguaDev Pro con auto-instrumentation

**Objetivo:** ver spans reales generados desde requests a `/api/lessons/:id`.

**Setup:**
- Cluster kind con Tempo + Collector + Grafana (§5).
- Servicio `api` de LinguaDev Pro corriendo (o un Express con 2 endpoints).

**Pasos:**
1. Instalá los packages OTel (`@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`).
2. Creá `telemetry.ts` como en §5 Paso 1.
3. Arrancá con `node --require ./dist/telemetry.js dist/server.js`.
4. Envía 20 requests con `curl` a `/api/lessons/lesson_1`.
5. Abrí Grafana Explore → datasource Tempo → busca `service.name = "linguadev-api"`.
6. Verificá que ves waterfall con span padre (HTTP GET) y spans hijos (PG query).

**Criterios de éxito:**
- [ ] Cada request genera un trace con al menos 2 spans (HTTP + DB).
- [ ] `service.name`, `service.version`, `deployment.environment` visibles en resource.
- [ ] Los spans DB tienen `db.system = postgresql` y `db.statement`.
- [ ] HTTP spans tienen `http.route`, `http.request.method`, `http.response.status_code`.

**Bonus:** añadí `express` + `pg` custom middleware que agregue `user.id` como attribute a cada span raíz.

---

### Ejercicio 2: Propagación W3C entre 2 servicios

**Objetivo:** verificar que un request cruza dos services y comparte trace_id.

**Setup:**
- Dos servicios: `api` (Node) y `worker` (Python).
- OTel SDK instalado en ambos, exportando al mismo Collector.

**Pasos:**
1. `api` llama a `worker` via HTTP (`fetch("http://worker:8000/process")`).
2. Verificá que `api` envía header `traceparent` (log el header inbound en worker).
3. `worker` con `opentelemetry-instrumentation-fastapi` debe extraer el context automáticamente.
4. Envía 5 requests y verifica en Tempo que un solo trace muestra spans de ambos services.
5. Cambia `api` para omitir a propósito el propagation (usar librería HTTP no instrumentada).
6. Verifica que ahora `api` y `worker` generan traces separados (fragmentados).

**Criterios de éxito:**
- [ ] Header `traceparent` visible en logs del worker cuando propagation funciona.
- [ ] Tempo muestra un único trace con spans de ambos services.
- [ ] Al romper propagation, aparecen dos traces distintos.
- [ ] `trace_id` idéntico entre spans cross-service.

**Bonus:** añadí un `messaging.kafka` step entre api y worker, propagando manualmente el traceparent en el message header.

---

### Ejercicio 3: Tail sampling con "always errors + slow + 5% rest"

**Objetivo:** configurar el Collector para persistir solo traces valiosos.

**Setup:**
- Collector gateway con memoria suficiente para buffer de 30s.
- Servicio que genera 100 req/s, mezcla de 95% success y 5% errors.

**Pasos:**
1. Añade a `otel-collector-config.yaml` el processor `tail_sampling` con 3 policies (errors, latency, probabilistic 5%).
2. Aplicá el ConfigMap y restart del Collector.
3. Genera carga (`hey -z 5m -c 20 http://api/`).
4. Introduce fallos artificiales (endpoint que responde 500 con 5% probabilidad).
5. Verifica en Tempo:
   - Cantidad total de traces mucho menor a la generada (esperable ~10%).
   - Todos los errors están presentes.
   - Los traces > 300ms están presentes.
   - Un ~5% de traces OK están.

**Criterios de éxito:**
- [ ] Traces persistidos ≈ 10% del volumen generado.
- [ ] Todos los errors visibles con `status = error` en TraceQL.
- [ ] Traces > 300ms presentes con `duration > 300ms`.
- [ ] Volumen de storage significativamente menor (verifica `du` en Tempo storage).

**Bonus:** añadí un policy que **siempre** persista traces con `.user.id = "linguadev_admin"` para debug de sesiones de soporte.

---

### Ejercicio 4: Correlación logs → traces en Grafana

**Objetivo:** click desde una log line en Loki abre el trace en Tempo.

**Setup:**
- Loki instalado, Tempo instalado, Grafana con ambos datasources.
- `api` con logs estructurados incluyendo `trace_id`.

**Pasos:**
1. Modificá el logger de la app para inyectar `trace_id` como campo JSON (§4.2).
2. Configurá el datasource Tempo con `traceID` para linking.
3. Configurá el datasource Loki con `derivedFields` que extraiga `trace_id` y produzca link a Tempo.
4. Genera 10 requests con logs de error.
5. En Grafana Explore → Loki, filtra `{app="linguadev-api"} |= "ERROR"`.
6. Verifica que cada log line tiene un botón "TraceID" clickable que abre el trace correspondiente.

**Criterios de éxito:**
- [ ] Cada log line JSON contiene `trace_id` y `span_id`.
- [ ] Log en Grafana muestra icono "TraceID" al lado del `trace_id`.
- [ ] Click abre split-view con Tempo y muestra el trace correcto.
- [ ] El trace visualizado contiene un span con timing que coincide con el timestamp del log.

**Bonus:** setea derivedFields inverso en Tempo (span → filter Loki logs con ese trace_id).

---

### Ejercicio 5: RED dashboard derivado del `spanmetrics` processor

**Objetivo:** construir un panel Grafana con Rate, Errors y p95 Duration usando métricas generadas por el Collector, sin instrumentation Prometheus adicional.

**Setup:**
- Collector con `spanmetrics` processor exportando a Prometheus.
- Grafana con datasource Prometheus scrapeando el collector `:8889`.

**Pasos:**
1. Añade `spanmetrics` al pipeline traces del Collector.
2. Configura Prometheus para scrape `otel-collector:8889`.
3. Verifica en Prometheus: `calls_total{service_name="linguadev-api"}` retorna datos.
4. Creá un dashboard con 3 paneles:
   - **Rate**: `sum by (http_route) (rate(calls_total{service_name="linguadev-api"}[5m]))`.
   - **Errors**: divide errores por total, mostrado como %.
   - **p95 Duration**: `histogram_quantile(0.95, sum by (http_route, le) (rate(latency_bucket{service_name="linguadev-api"}[5m])))`.
5. Genera carga con `hey` y observa el dashboard actualizando.

**Criterios de éxito:**
- [ ] Métrica `calls_total` aparece en Prometheus con labels `service_name`, `http_route`, `status_code`.
- [ ] Dashboard muestra 3 paneles funcionando.
- [ ] Rate cambia proporcional al load.
- [ ] p95 responde a latencias inyectadas manualmente.

**Bonus:** añade alert rule `error_rate > 1%` durante 5m con notificación a Slack.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [opentelemetry.io](https://opentelemetry.io) — spec, SDKs, Collector.
- [github.com/open-telemetry/opentelemetry-collector-contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib) — 0.116+ releases.
- [jaegertracing.io](https://www.jaegertracing.io) — Jaeger 2.0.
- [grafana.com/docs/tempo](https://grafana.com/docs/tempo/latest/) — Tempo 2.7 + TraceQL.
- [w3.org/TR/trace-context](https://www.w3.org/TR/trace-context/) — standard W3C.

**Herramientas:**
- [otel-cli](https://github.com/equinix-labs/otel-cli) — enviar spans desde bash.
- [autoinstrumentation Operator](https://github.com/open-telemetry/opentelemetry-operator) — inyectar SDK en pods K8s.
- [k6](https://k6.io) con soporte OTel para load testing con traces.
- [Grafana Faro](https://grafana.com/oss/faro/) — RUM (real user monitoring) OTel.

**Libros y referencias:**
- Charity Majors, Liz Fong-Jones, George Miranda, "*Observability Engineering*" (O'Reilly, 2022).
- Ted Young, Austin Parker, "*Distributed Tracing in Practice*" (O'Reilly, 2020).
- Cindy Sridharan, "*Distributed Systems Observability*" (O'Reilly, 2018).
- Google Dapper paper (2010) — origen conceptual.

**Siguientes pasos:**
- Instrumentá los 5+ servicios de LinguaDev Pro con OTel.
- Añadí propagation cross-service verificable.
- Configurá tail sampling productivo.
- Correlá logs, metrics y traces con `trace_id` como pivote.
- Continuá con [cap 21 — SLO management y error budgets](./21-slo-management-y-error-budgets.md) para convertir métricas en SLOs.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre concepts (spans, traces, waterfall), OpenTelemetry (SDK, Collector, OTLP, semantic conventions), W3C Trace Context, sampling (head, tail, adaptive, probabilistic), backends (Jaeger, Tempo, Zipkin, TraceQL), correlación logs↔traces↔metrics con exemplars, RED metrics desde spanmetrics, y patrones avanzados (baggage, service graph, retención). Dificultad junior → staff.

- **Fuente:** [`packages/content/src/tech/devops/sim-20-distributed-tracing.json`](../../packages/content/src/tech/devops/sim-20-distributed-tracing.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-20-distributed-tracing`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 19 — Logging ELK/Loki](./19-logging-elk-loki.md) · [Índice](./README.md) · [Capítulo 21 — SLO management y error budgets →](./21-slo-management-y-error-budgets.md)
