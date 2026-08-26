# Capítulo 15 — Observabilidad para devs

> **Focus:** Los tres pilares (logs, métricas, traces), structured logging, correlation IDs, RED / USE / Golden Signals, OpenTelemetry como capa universal, Prometheus 3.x para métricas, distributed tracing con Jaeger/Tempo, error tracking con Sentry, y cómo escribir alertas y SLOs que no te despierten sin motivo.
> **Áreas:** Observabilidad · Logging · Métricas · Tracing · Alerting · SRE
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior

## 0. Antes de empezar

**Pre-requisitos:**
- Un servicio HTTP propio (Node, Python, Go, Java o similar) que puedas modificar.
- Familiaridad con Docker y `docker-compose` (ver [cap 13 — Docker y contenedores](./13-docker-y-contenedores.md)).
- Familiaridad con Linux, `journalctl`, `strace` y logs (ver [cap 14 — Linux y shell](./14-linux-y-shell.md)).
- Conceptos básicos de HTTP (status codes, request/response) y JSON.
- Idealmente un stack local para experimentar: Grafana + Prometheus + Tempo + Loki (Grafana LGTM) o Signoz, o cuenta gratuita en Grafana Cloud / Honeycomb / Datadog / New Relic.

**Glosario mínimo:**
- **Los tres pilares**: **logs** (eventos discretos y textuales), **métricas** (series temporales agregadas y numéricas), **traces** (grafo causal de spans a través de servicios). En 2024-2026 la industria añade **continuous profiling** como cuarto pilar.
- **Structured logging**: emitir logs como objetos (JSON u otro formato parseable) con campos consistentes en lugar de texto libre.
- **Correlation ID / trace ID / request ID**: identificador único que atraviesa toda una request para poder correlacionar logs, métricas y traces.
- **Cardinalidad**: número de series únicas que produce una métrica (combinación de todos sus label values). Alta cardinalidad = caro y lento.
- **RED**: Rate, Errors, Duration — método orientado a servicios de request-response (Tom Wilkie, 2018).
- **USE**: Utilization, Saturation, Errors — método orientado a recursos físicos (Brendan Gregg).
- **Golden Signals**: latency, traffic, errors, saturation — método del SRE Book de Google.
- **Span**: unidad básica de un trace: nombre, timestamps, atributos, parent span. Un trace es un DAG de spans.
- **SLI (Service Level Indicator)**: métrica objetiva del servicio (p95 latency, success rate).
- **SLO (Service Level Objective)**: umbral pactado del SLI (`99.9% de requests OK en 30 días`).
- **Error budget**: `1 - SLO` (con 99.9% SLO tienes 0.1% de tiempo/eventos para "gastar" en fallos).
- **OpenTelemetry (OTel)**: proyecto CNCF (fusión de OpenTracing + OpenCensus, 2019). En 2026, traces y metrics son GA/stable; logs se estabilizaron durante 2024-2025.

**Setup mínimo — stack Grafana LGTM local:**

```bash
mkdir -p ~/obs-lab && cd ~/obs-lab

cat > docker-compose.yml <<'YAML'
name: obs
services:
  grafana:
    image: grafana/grafana:11.4.0
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
      GF_FEATURE_TOGGLES_ENABLE: traceqlEditor,exemplars
    ports: ["3000:3000"]

  prometheus:
    image: prom/prometheus:v3.1.0
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --enable-feature=exemplar-storage
      - --enable-feature=otlp-write-receiver
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports: ["9090:9090"]

  tempo:
    image: grafana/tempo:2.6.1
    command: ["-config.file=/etc/tempo.yaml"]
    volumes:
      - ./tempo.yaml:/etc/tempo.yaml:ro
    ports: ["3200:3200", "4317:4317", "4318:4318"]

  loki:
    image: grafana/loki:3.3.0
    command: ["-config.file=/etc/loki/local-config.yaml"]
    ports: ["3100:3100"]

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.116.0
    command: ["--config=/etc/otel-collector.yaml"]
    volumes:
      - ./otel-collector.yaml:/etc/otel-collector.yaml:ro
    ports: ["4319:4317", "4320:4318"]
    depends_on: [tempo, prometheus, loki]
YAML

cat > prometheus.yml <<'YAML'
global:
  scrape_interval: 15s
  evaluation_interval: 15s
scrape_configs:
  - job_name: 'my-app'
    static_configs:
      - targets: ['host.docker.internal:9464']
YAML

# tempo.yaml, otel-collector.yaml: minimal configs (ver docs oficiales)
docker compose up -d
```

Abre `http://localhost:3000` (Grafana), añade datasource Prometheus (`http://prometheus:9090`), Tempo (`http://tempo:3200`), Loki (`http://loki:3100`). Estás listo.

---

## 1. El gran cuadro

Hasta ~2018, "monitorizar" significaba encender Nagios, mirar dashboards vacíos hasta que algo se pusiera rojo, y luego bucear por 47 pestañas de logs plano `grep`eando "error". La observabilidad moderna es otro deporte: los tres pilares (logs, métricas, traces) se **complementan** —métricas te dicen *qué* pasa y *cuándo*, traces te dicen *dónde* en el grafo de servicios, logs te dan el *por qué* y el detalle contextual—, y todos comparten al menos un identificador (**trace ID / correlation ID**) que permite saltar de uno a otro sin adivinar. Un incidente bien instrumentado se resuelve en minutos: dashboard alerta 5xx → clic en el trace ejemplo (exemplar) → span que falla → logs de ese trace filtrados por trace ID → causa clara.

En 2026 la capa universal se llama **OpenTelemetry**. Un solo SDK en tu app genera traces, métricas y logs con **semantic conventions** compartidas (`http.request.method`, `db.system`, `service.name`, `deployment.environment`). Los emite en OTLP (gRPC o HTTP) a un **OTel Collector** que enruta cada señal al backend adecuado: traces a Tempo/Jaeger, métricas a Prometheus/Mimir, logs a Loki/Elastic. El vendor lock-in ha muerto en la capa de instrumentación —si cambias de Datadog a Grafana Cloud, cambias una URL en el Collector, no reescribes toda la app. Es un cambio silencioso pero enorme.

El otro cambio de era es la **cardinalidad como impuesto oculto**. Prometheus 3.0 (nov 2024, y ya 3.11+ en 2026) mejoró UTF-8 en label names y colaboración con OTel, pero la matemática no perdona: cada label extra en una métrica multiplica el número de series únicas, y cada serie ocupa memoria del TSDB. Añadir `user_id` como label a una métrica de una app con un millón de usuarios significa un millón de series; el proceso muere y los dashboards se congelan. Aprender qué va como **label** (baja cardinalidad, fija) vs **atributo de trace/log** (alta cardinalidad, contextual) es el skill que separa a los devs que rompen infraestructura de los que ayudan.

Cerrando el cuadro: **alertas y SLOs**. La regla número uno del SRE Book de Google sigue vigente: **alert on symptoms, not causes**. Alertar en "CPU > 80%" te despierta a las 3 AM sin que nadie note nada; alertar en "p95 latency > 500 ms durante 5 min con SLO al 99.9%" te levanta cuando los usuarios sufren. Los **SLOs con error budget** convierten discusiones subjetivas ("¿estamos rápidos?") en números pactados ("consumimos 60% del budget mensual este viernes tras el deploy — freeze de releases hasta el reset"). Este capítulo cubre cómo llegar ahí sin morir en el intento.

---

## 2. Logs: del `console.log` al JSON estructurado (nivel junior → mid)

### 2.1 Por qué structured logging siempre

Compara:

```
2026-08-13 14:32:07 INFO Usuario 12345 hizo login desde 82.31.4.1 en 342 ms
```

vs

```json
{"ts":"2026-08-13T14:32:07.123Z","level":"info","service":"api","env":"prod","event":"login_success","user_id":12345,"ip":"82.31.4.1","duration_ms":342,"trace_id":"7f2c9b1e8a4d3f6b0c5d9e8a4d3f6b0c"}
```

El primero requiere regex frágiles para extraer datos. El segundo se ingiere en cualquier stack (Loki con JSON parser, Elastic, Datadog) y permite queries de tipo `sum by (event) (count_over_time({service="api"} | json | duration_ms > 500))`. Todo campo relevante (user_id, request_id, trace_id, duration, status) va como **key/value**, no dentro de un mensaje interpolado.

### 2.2 Ejemplo Node.js con `pino`

`pino` es el logger estándar de Node moderno por velocidad y por ser JSON-first:

```javascript
// src/logger.js
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: () => ({}), // quita pid/hostname del default
  },
  base: {
    service: 'linguadev-api',
    env: process.env.NODE_ENV ?? 'development',
    version: process.env.APP_VERSION ?? 'dev',
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.creditCard',
    ],
    censor: '[REDACTED]',
  },
});
```

Uso con contexto por request:

```javascript
// src/middleware/log-context.js
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';

const als = new AsyncLocalStorage();

export function requestLogger(req, res, next) {
  const requestId = req.headers['x-request-id'] ?? randomUUID();
  const traceId = req.headers['traceparent']?.split('-')[1]; // W3C traceparent
  const child = logger.child({ request_id: requestId, trace_id: traceId });

  const start = process.hrtime.bigint();
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    child.info({
      event: 'http_request',
      method: req.method,
      path: req.route?.path ?? req.path,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      bytes: res.getHeader('content-length'),
    }, 'request completed');
  });

  als.run({ logger: child, requestId, traceId }, () => next());
}

export const getRequestLogger = () => als.getStore()?.logger ?? logger;
```

Cualquier código profundo en la request accede a `getRequestLogger()` y sus logs llevan automáticamente `request_id` y `trace_id`.

### 2.3 Log levels: cuándo cada uno

| Level | Cuándo |
|---|---|
| **TRACE** | Muy verboso; usualmente off. Debug de flujos internos. |
| **DEBUG** | Diagnóstico; off en prod salvo emergencia. |
| **INFO** | Eventos normales que quieres ver siempre (startup, request completed, job done). |
| **WARN** | Algo raro pero recuperable (rate limit soft hit, cache miss caro). No dispara alertas. |
| **ERROR** | Falló algo y afecta al usuario o al sistema. Dispara alertas. |
| **FATAL** | El proceso no puede continuar y va a salir. |

Anti-patrón: loguear todo en ERROR "por si acaso". Consecuencia: alerta ruido → fatiga → nadie mira. Loguea al nivel que refleje el impacto real.

### 2.4 Redacción de PII y compliance

Nunca loguees passwords, tokens, tarjetas, IDs nacionales, direcciones postales sin necesidad. Usa `redact` en pino, `secrets` en Serilog, `SafeString` en Java, o middleware que limpie antes. Ver [cap 19 — data pipelines + PII + EU AI Act](../ai-programming/19-data-pipelines-pii-eu-ai-act.md) si aplica GDPR.

### 2.5 Correlation IDs con W3C `traceparent`

El standard **W3C Trace Context** define el header `traceparent`:

```
traceparent: 00-7f2c9b1e8a4d3f6b0c5d9e8a4d3f6b0c-1a2b3c4d5e6f7a8b-01
             │  └── trace-id (16 bytes hex) ─┘ └── span-id ──┘ └flags
             version
```

Todos los frameworks OTel-aware lo propagan automáticamente entre servicios HTTP y gRPC. Con eso, un solo `trace_id` sigue a la request desde el edge (Cloudflare, API gateway) → tu monolito → cache → DB → colas → workers, y correlaciona logs, métricas (via exemplars) y traces.

---

## 3. Métricas: Prometheus 3, RED, USE, Golden Signals (nivel mid)

### 3.1 Los tres tipos básicos de métrica

- **Counter**: solo sube (o resetea al reiniciar). Ideal para contar eventos. `http_requests_total`.
- **Gauge**: sube y baja. Ideal para instantáneas. `queue_depth`, `memory_bytes`, `active_connections`.
- **Histogram**: distribuye valores en buckets predefinidos y ofrece `_count`, `_sum`, y `_bucket`. Ideal para latencias. `http_request_duration_seconds`.
- **Summary**: como histogram pero calcula quantiles client-side. Casi siempre prefiere histogram (agregable server-side).

Ejemplo Node con `prom-client`:

```javascript
// src/metrics.js
import client from 'prom-client';

client.collectDefaultMetrics({ prefix: 'nodejs_' });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const dbConnectionsActive = new client.Gauge({
  name: 'db_connections_active',
  help: 'Active DB connections in pool',
});

export const registry = client.register;
```

Endpoint `/metrics`:

```javascript
// src/routes/metrics.js
import { registry } from '../metrics.js';

export function metricsHandler(_, res) {
  res.setHeader('Content-Type', registry.contentType);
  registry.metrics().then(m => res.end(m));
}
```

Middleware para poblarlas:

```javascript
export function metricsMiddleware(req, res, next) {
  const end = httpRequestDurationSeconds.startTimer();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: req.route?.path ?? 'unknown',
      status: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    end(labels);
  });
  next();
}
```

**Regla dura sobre labels**: el `route` debe ser el **template** (`/users/:id`), NO el path resuelto (`/users/12345`). Si loguearas 1M paths distintos, tendrías 1M series. Usa `req.route?.path`, no `req.path`.

### 3.2 Cardinalidad: el error caro

Cada combinación única de valores de labels produce una **serie temporal** que Prometheus debe mantener en memoria (~3 KB por serie activa). Malas ideas típicas:

- Label `user_id` en apps con >1000 usuarios.
- Label `request_id` (¡infinito!).
- Label `path` con IDs (`/orders/12345`) en lugar de template.
- Label `email` o cualquier PII.

Regla mental: **si el label puede tener > 100 valores distintos, no debería ser un label**. Va como atributo de trace o campo de log.

### 3.3 Los tres métodos

**RED (Rate, Errors, Duration)** — para servicios de request/response:

```promql
# Rate: requests por segundo
sum by (route) (rate(http_requests_total[5m]))

# Errors: fracción de errores 5xx
sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))
/
sum by (route) (rate(http_requests_total[5m]))

# Duration: p95 en 5 min
histogram_quantile(0.95,
  sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))
```

**USE (Utilization, Saturation, Errors)** — para recursos (CPU, RAM, disco, red):

```promql
# CPU utilization
1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))

# Memory saturation (swap usage / paging)
rate(node_vmstat_pgmajfault[5m])
```

**Golden Signals (Google SRE)** — latency, traffic, errors, saturation. Superconjunto pragmático que sirve para casi todo.

### 3.4 Prometheus 3.x en 2026

Prometheus 3.0 (nov 2024) fue el primer major desde 2.0 (2017). Puntos clave:

- **UTF-8 nativo** en nombres de métrica y labels (ideal para semconv de OTel).
- **OTLP receiver** built-in (`--enable-feature=otlp-write-receiver`): apps envían OTLP directamente, sin adaptador.
- **Nuevo formato de PromQL** para range selectors: `[5m:1m]` explícito, deprecación del comportamiento implícito.
- **Exemplars**: valores puntuales de métricas con `trace_id` asociado — permiten saltar de un dashboard de p99 latency a un trace ejemplar en un clic.

En 2026 la versión estable ronda **v3.11+**. Grafana Cloud/Mimir y VictoriaMetrics son alternativas escalables horizontalmente compatibles con PromQL.

### 3.5 Pull vs push

Prometheus es **pull**: raspa `/metrics` de tus servicios cada 15 s. Ventajas: descubrimiento (K8s, Consul), fácil detectar targets muertos (última muestra), instrumentación no bloqueante. Cuando pull no encaja (jobs efímeros, cron), usa **Pushgateway** (para batch jobs cortos que emiten métricas al terminar) o **OTLP push** desde el Collector.

---

## 4. Distributed tracing y OpenTelemetry (nivel senior)

### 4.1 Anatomía de un trace

Un **trace** representa una operación end-to-end (una request HTTP, un job de Kafka). Se compone de **spans**: cada span tiene `trace_id`, `span_id`, `parent_span_id`, `name`, `start`, `end`, `attributes`, `events`, `status`. El grafo es un **DAG**: hijos, sibilings, joins.

```
[HTTP POST /login]                          trace_id=abc123
├── [auth.verify_credentials]               parent=root
│   └── [db.query users]                    parent=verify
├── [session.create]
│   └── [redis.set session:xyz]
└── [audit.log_login_event]
    └── [kafka.publish events]
```

Cada span lleva atributos (`http.status_code=200`, `db.statement="SELECT ..."`, `messaging.destination=events`). Al fallar, `status=ERROR` y opcionalmente un evento `exception`.

### 4.2 OpenTelemetry SDK (Node.js)

```javascript
// src/tracing.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

const OTLP = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

export const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'linguadev-api',
    [ATTR_SERVICE_VERSION]: process.env.APP_VERSION ?? 'dev',
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV ?? 'development',
  }),
  traceExporter: new OTLPTraceExporter({ url: `${OTLP}/v1/traces` }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${OTLP}/v1/metrics` }),
    exportIntervalMillis: 10_000,
  }),
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false }, // ruidoso
  })],
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
```

`getNodeAutoInstrumentations` instrumenta automáticamente HTTP/HTTPS, Express/Fastify, Postgres/MySQL/MongoDB, Redis, AWS SDK, GraphQL y muchos más. Con eso solo, ya tienes traces distribuidos completos.

Spans custom donde necesitas granularidad extra:

```javascript
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('linguadev-api');

export async function scoreAnswer(question, answer) {
  return tracer.startActiveSpan('score_answer', {
    attributes: {
      'app.question_id': question.id,
      'app.answer_len': answer.length,
      'app.model': 'gpt-5.1-mini',
    },
  }, async (span) => {
    try {
      const result = await callLLM(question, answer);
      span.setAttribute('app.score', result.score);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

### 4.3 Semantic conventions

OTel define atributos estándar en `@opentelemetry/semantic-conventions`. En 2026 la spec ha estabilizado las áreas HTTP, database, messaging, RPC, GenAI y feature flags. Usa nombres canónicos (`http.request.method`, `db.system`, `messaging.system`, `gen_ai.request.model`) en lugar de inventar los tuyos — dashboards y correlaciones cross-service funcionan out of the box.

### 4.4 Sampling: no puedes trazar todo

En apps con miles de RPS, guardar 100% de traces es caro y a menudo inútil. Estrategias:

- **Head sampling**: decide al crear el trace (probabilidad fija: `TraceIdRatioBased(0.1)` = 10%). Simple, barato, ignora "traces interesantes que se decidieron ignorar".
- **Tail sampling**: recolectas todos los spans en el Collector, decides tras verlos completos (guarda todos los ERROR, muestrea 1% del resto). Requiere Collector con buffer.
- **Rate limiting per service**: cada servicio no supera N traces/s.
- **Force-keep para errores**: cualquier trace con span en ERROR se guarda al 100%.

Config típica de tail sampling en OTel Collector:

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow-requests
        type: latency
        latency: { threshold_ms: 500 }
      - name: probabilistic
        type: probabilistic
        probabilistic: { sampling_percentage: 5 }
```

### 4.5 Backends: Jaeger, Tempo, Honeycomb, Datadog

- **Jaeger 2.0** (2024, arquitectura basada en OTel Collector) — OSS, self-hosted, escala moderada.
- **Grafana Tempo 2.x** — OSS, storage barato en S3, integra excelente con Grafana y Loki (exemplars).
- **Honeycomb** — vendor especializado en tracing con queries de alta cardinalidad ("BubbleUp"). Cultura de ingeniería fuerte.
- **Datadog APM** — comercial, todo integrado, coste alto a escala.
- **Sentry Performance** — extensión del error tracker con tracing.

### 4.6 Continuous profiling: el "cuarto pilar"

En 2024-2026, herramientas como **Grafana Pyroscope**, **Parca**, **Polar Signals**, **Datadog Profiler** captan perfiles CPU/memoria en producción con overhead bajo (eBPF). Ver qué función se lleva la CPU cuando la latencia sube es literalmente un `zoom-in` visual, sin necesidad de reproducir en un lab.

---

## 5. Error tracking, alerting y SLOs (nivel senior)

### 5.1 Sentry para errores estructurados

Los logs con `level=ERROR` cuentan **cuántos** errores hay. Sentry (o Rollbar, Bugsnag, Datadog Error Tracking) los **agrupa por firma** (stack trace normalizado), muestra frecuencia, primer/último visto, users afectados, release en el que apareció, y te alerta cuando explota algo nuevo. Es una capa por encima de logs, no un reemplazo.

Setup Node:

```javascript
// src/sentry.js
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.APP_VERSION,
  tracesSampleRate: 0.1,
  profilesSampleRate: 0.1,
  integrations: [nodeProfilingIntegration()],
  beforeSend(event, hint) {
    // Nunca envíes PII
    if (event.request?.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
    }
    return event;
  },
});

export { Sentry };
```

Enriquece con contexto por request:

```javascript
Sentry.withScope(scope => {
  scope.setUser({ id: user.id });       // NO email/name/IP salvo consentimiento explícito
  scope.setTag('feature', 'evaluator');
  scope.setContext('question', { id: q.id, topic: q.topic });
  // ejecuta código
});
```

### 5.2 SLI / SLO / error budget

Un SLO se construye en cuatro pasos:

1. **Elige un SLI**: ej. `success_ratio = fraction of successful HTTP requests`.
2. **Fórmula**: `sum(rate(http_requests_total{status!~"5..",job="api"}[5m])) / sum(rate(http_requests_total{job="api"}[5m]))`.
3. **Objetivo**: 99.9% en ventana de 30 días.
4. **Consecuencia**: si consumes >100% del error budget, freeze de deploys nuevos hasta que se recupere.

Regla del pulgar del SRE Book:

| SLO | Downtime permitido/mes | Downtime/año |
|---|---|---|
| 99.0% ("dos nueves") | 7 h 12 min | 3 d 15 h |
| 99.9% | 43 min | 8 h 45 min |
| 99.95% | 22 min | 4 h 22 min |
| 99.99% | 4 min 22 s | 52 min |
| 99.999% ("cinco nueves") | 26 s | 5 min 15 s |

Cinco nueves es carísimo (redundancia geográfica, ingeniería obsesiva) y raramente lo necesitas fuera de infra de pagos o telecom. Elige el SLO más bajo que tus usuarios acepten.

### 5.3 Alerting: burn-rate en lugar de umbrales fijos

**Anti-patrón**: alertar en "p95 > 500 ms durante 1 min" — se dispara con picos triviales y no correlaciona con impacto real.

**Idiomático (Google SRE, multi-window multi-burn-rate)**: dispara si **consumes error budget demasiado rápido**.

```yaml
# Alerta rápida: 2% del budget mensual en 1h → page
- alert: APIErrorBudgetBurnFast
  expr: |
    (
      sum(rate(http_requests_total{job="api",status=~"5.."}[1h]))
      /
      sum(rate(http_requests_total{job="api"}[1h]))
    ) > (14.4 * 0.001)
    and
    (
      sum(rate(http_requests_total{job="api",status=~"5.."}[5m]))
      /
      sum(rate(http_requests_total{job="api"}[5m]))
    ) > (14.4 * 0.001)
  for: 2m
  labels: { severity: page }
  annotations:
    summary: "Quemando 2% del budget mensual en 1h"

# Alerta lenta: 10% del budget en 6h → ticket
- alert: APIErrorBudgetBurnSlow
  expr: |
    (
      sum(rate(http_requests_total{job="api",status=~"5.."}[6h]))
      /
      sum(rate(http_requests_total{job="api"}[6h]))
    ) > (6 * 0.001)
  for: 15m
  labels: { severity: ticket }
```

Los factores `14.4` y `6` derivan de la matemática del budget (30 días × 24 h). Grafana OnCall / PagerDuty / Opsgenie enrutan según severidad.

### 5.4 Alerting fatigue: reglas duras

- Toda alerta que despierta a alguien debe ser **actionable** y tener **runbook link**.
- Reviews trimestrales: alertas que no dispararon → ¿siguen siendo útiles? Alertas ruidosas (>3/semana) → tunear o eliminar.
- **Nunca** alerta sin owner (`labels: team=platform`).
- **No alerta sobre causas**: alerta sobre síntomas ("los usuarios ven 500s") no sobre "CPU 80%".

### 5.5 Health checks: liveness vs readiness

En Kubernetes (y equivalentes) son cosas distintas:

- **Liveness**: "¿tu proceso está vivo y hay que reiniciarlo si no?". Debe ser **simple** — un HTTP 200 desde el thread principal. Si dependes de DB en liveness, un blip de red mata todos tus pods.
- **Readiness**: "¿estás listo para aceptar tráfico?". Puede chequear dependencies (DB pool, cache, cola). Si falla, el service mesh te quita del load balancer temporalmente.
- **Startup** (K8s 1.16+): probe que corre solo al arranque; permite ventanas más largas de `initialDelaySeconds` sin bloquear liveness.

```javascript
// /healthz — liveness (siempre 200 si el process vive)
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// /readyz — readiness (chequea deps)
app.get('/readyz', async (_, res) => {
  try {
    await db.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ ready: true });
  } catch (err) {
    res.status(503).json({ ready: false, err: err.message });
  }
});
```

---

## 6. Ejemplo completo: instrumentar `linguadev-api`

Sumamos todo. Un microservicio Node de LinguaDev que devuelve un score con LLM y publica un evento a Kafka. Queremos: JSON logs con `trace_id`, métricas RED, tracing OTel, Sentry, `/healthz` + `/readyz`, y un SLO 99.9% con burn-rate alerts.

### 6.1 Bootstrap

```javascript
// src/index.js
import './tracing.js';       // side-effect: SDK started
import './sentry.js';        // side-effect: Sentry init
import express from 'express';
import { logger } from './logger.js';
import { requestLogger } from './middleware/log-context.js';
import { metricsMiddleware, metricsHandler } from './metrics.js';
import { scoreRouter } from './routes/score.js';
import { db, redis, kafka } from './deps.js';

const app = express();
app.use(express.json());
app.use(requestLogger);
app.use(metricsMiddleware);

app.get('/healthz', (_, res) => res.status(200).send('ok'));
app.get('/readyz', async (_, res) => {
  try {
    await Promise.all([db.query('SELECT 1'), redis.ping(), kafka.admin().listTopics()]);
    res.status(200).json({ ready: true });
  } catch (err) {
    logger.warn({ err: err.message }, 'readiness failed');
    res.status(503).json({ ready: false });
  }
});
app.get('/metrics', metricsHandler);
app.use('/score', scoreRouter);

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => logger.info({ port }, 'API listening'));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    logger.info({ signal: sig }, 'shutdown');
    server.close(async () => {
      await Promise.allSettled([db.end(), redis.quit(), kafka.disconnect()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25_000);
  });
}
```

### 6.2 Dashboard Grafana (RED)

Panel de latencia p95 con **exemplars** de trace_id:

```promql
histogram_quantile(0.95,
  sum by (route, le) (
    rate(http_request_duration_seconds_bucket{service="linguadev-api"}[5m])
  )
)
```

Panel de error ratio:

```promql
100 *
  sum by (route) (rate(http_requests_total{service="linguadev-api",status=~"5.."}[5m]))
  /
  sum by (route) (rate(http_requests_total{service="linguadev-api"}[5m]))
```

Panel de throughput por route (RPS):

```promql
sum by (route) (rate(http_requests_total{service="linguadev-api"}[1m]))
```

En Grafana, click en un punto p95 alto → salta al trace via exemplar → ves los spans → click en un span → filtras logs de Loki por `{service="linguadev-api"} | json | trace_id="<...>"`. Todo desde un dashboard.

### 6.3 Query LogQL en Loki

```logql
{service="linguadev-api", env="prod"}
  | json
  | level="error"
  | line_format "{{.ts}} {{.route}} {{.status}} {{.err}}"
```

Top errores del último día:

```logql
topk(10,
  sum by (err) (
    count_over_time(
      {service="linguadev-api"} | json | level="error" [24h]
    )
  )
)
```

### 6.4 SLO recording rules

```yaml
# prometheus/rules/slo.yml
groups:
  - name: slo-api
    interval: 30s
    rules:
      - record: sli:http_requests_success:ratio_rate5m
        expr: |
          sum(rate(http_requests_total{job="api",status!~"5.."}[5m]))
          /
          sum(rate(http_requests_total{job="api"}[5m]))
      - record: sli:http_requests_success:ratio_rate1h
        expr: |
          sum(rate(http_requests_total{job="api",status!~"5.."}[1h]))
          /
          sum(rate(http_requests_total{job="api"}[1h]))
      - record: sli:http_requests_success:ratio_rate6h
        expr: |
          sum(rate(http_requests_total{job="api",status!~"5.."}[6h]))
          /
          sum(rate(http_requests_total{job="api"}[6h]))
```

Y las burn-rate alerts encima. En Grafana, un panel "Error budget remaining" con un gauge visual reemplaza mil discusiones subjetivas.

---

## 7. Cheatsheet y anti-patrones

### Reglas de oro

- ✅ **Structured logs en JSON**, con campos `service`, `env`, `level`, `ts`, `trace_id`, `request_id`.
- ✅ **`traceparent` W3C** para correlation cross-service.
- ✅ **INFO al principio de una operación importante**, ERROR solo si afectó al usuario.
- ✅ **Redacta PII y secretos** en el logger antes de emitir.
- ✅ **Métricas: counter para eventos, gauge para instantáneas, histogram para latencias.**
- ✅ **Cardinalidad baja en labels**: nunca `user_id`, `request_id`, `path` con IDs.
- ✅ **RED para servicios, USE para recursos, Golden Signals de bolsillo.**
- ✅ **OTel SDK + auto-instrumentation** cubre 80% sin escribir spans a mano.
- ✅ **Exemplars** en histogramas para saltar de métrica a trace.
- ✅ **Sampling agresivo pero preserva errores** (tail sampling).
- ✅ **Sentry para agrupar y priorizar errores**, complementa logs.
- ✅ **SLOs con error budget** y alertas por burn-rate multi-window.
- ✅ **Runbook link en cada alerta** y owner por labels.
- ✅ **Liveness simple, readiness completa, startup para arranques lentos.**
- ✅ **Semantic conventions de OTel** para nombres consistentes.

### Anti-patrones

- ❌ `console.log("user " + userId + " did " + action + " in " + ms + "ms")`.
- ❌ Loguear passwords, tokens, tarjetas, direcciones.
- ❌ Alertas en "CPU > 80%" que despiertan por picos triviales.
- ❌ `path` como label de métrica con IDs en la URL.
- ❌ Ratio de sampling 100% en producción alta escala (Tempo/Jaeger revientan).
- ❌ Prometheus `/metrics` sin scrape de Grafana o alerts (ceguera con instrumentación).
- ❌ Un dashboard por servicio con 40 paneles y ningún KPI arriba.
- ❌ Alerta sin runbook link.
- ❌ Depender de DB en el liveness probe (blip de red = restart de todos los pods).
- ❌ Ignorar `beforeSend` en Sentry y enviar cabeceras `authorization` a un tercero.
- ❌ Confundir SLA (contrato) con SLO (objetivo interno). El SLO debe ser más estricto que el SLA.
- ❌ Cambiar el semver de una métrica sin advertir (rompes dashboards y alertas).
- ❌ `console.log(JSON.stringify(largeObject))` en hot paths (bloquea event loop en Node).

### Tabla de decisión: qué señal

| Pregunta operacional | Señal |
|---|---|
| ¿Cuánto tráfico y a qué velocidad de error? | Métricas (RED) |
| ¿Dónde en el grafo de servicios está el problema? | Traces |
| ¿Por qué falló esta request concreta? | Logs (con trace_id) |
| ¿Qué CPU/RAM/IO satura? | Métricas (USE) + profiling |
| ¿Qué error nuevo apareció en el último deploy? | Sentry |
| ¿Estamos cumpliendo el 99.9% del mes? | SLO dashboard con error budget |
| ¿Qué función se lleva 40% del CPU? | Continuous profiling (Pyroscope, Parca) |

---

## 8. Casos reales 2020-2026

**GitLab data loss (feb 2017, referencia histórica):** cascada de errores humanos borró la DB de producción. Post-mortem público, blameless, ejemplo canónico de cultura sana + lecciones sobre backups y observabilidad ("los backups no fallaban, la restauración sí"). Tres monitoring gaps: `du` no medía correctamente, alertas de replication lag ignoradas, sin verificación end-to-end del backup.

**Cloudflare regex CPU (jul 2019):** un regex con backtracking exponencial en un WAF rule consumió 100% CPU y tumbó el 40% de internet 27 min. Fue detectado por métricas de CPU + top rápido; post-mortem público explicó el patrón `.*(?:.*=.*)`.

**Log4Shell (dic 2021):** ver capítulos 13 y 14. Logs bien filtrados fueron clave para saber si tu app era vulnerable (grep de exfiltración DNS a `.dnslog.cn` y similares).

**Prometheus 3.0 (nov 2024):** primer major desde 2017. UTF-8 nativo, OTLP receiver, mejora de PromQL. Grafana Labs publicó guía práctica de OTel + Prometheus.

**OpenTelemetry logs stable (2024):** cierra la trilogía. Traces (2020), metrics (2023), logs (2024). En 2026 OTel está cerca del status "Graduated" en CNCF.

**Datadog outage (mar 2023):** upgrade de systemd en muchas VMs simultáneas causó su propio downtime multi-región. Post-mortem público. Recordatorio de que hasta los vendors de observability tienen incidentes.

**Sentry v9 y AI issue grouping (2024-2026):** SDK modernos incluyen profiling, sesiones, feedback widget, y agrupación de issues asistida por ML. En 2026 la versión estable soporta OTel out of the box.

**Grafana Labs consolidación (2020-2026):** stack "LGTM" (Loki + Grafana + Tempo + Mimir) OSS competitivo con Datadog en features (menos en polish). Grafana 11 (2024) introdujo Scenes framework, Grafana 12 (2025) mejoras de dashboard-as-code y navegación.

**Honeycomb + high-cardinality events (2018-2026):** popularizó la idea de "observability = tests en producción" y de eventos de alta cardinalidad como pilar central. Comunidad SRE convergió en su lenguaje.

**Post-mortem blameless (Google SRE Book, 2016+):** cultura consolidada. El sistema falló, no la persona. Los incidentes son oportunidad de aprender, no de castigar.

**xz-utils backdoor (mar 2024):** Andres Freund detectó anomalía de 500 ms en SSH con `strace`/`perf` — la observabilidad low-level sigue siendo indispensable, no todo se ve en dashboards.

---

## 9. Ejercicios prácticos

### Ejercicio 1 — Migra `console.log` a `pino` con contexto

**Objetivo:** convertir logs planos a JSON estructurado con `trace_id` propagado por request.

**Setup:** una Express/Fastify app con `console.log` diseminados.

**Pasos:**
1. Instala `pino` y crea `src/logger.js` con `service`, `env`, `version` como campos base y `redact` para `authorization`, `cookie`, `password`.
2. Reemplaza todos los `console.log` por `logger.info({...campos}, "mensaje")`.
3. Implementa middleware que cree un `child logger` por request con `request_id` (o `traceparent` si viene) usando `AsyncLocalStorage`.
4. En endpoints profundos, usa `getRequestLogger()` para que los logs lleven contexto automáticamente.
5. Envía una request y verifica en stdout que salen JSONs con `trace_id` consistente en todos los logs de esa request.

**Criterios de éxito:**
- [ ] Toda salida es JSON válido parseable por `jq`.
- [ ] Cada log lleva `ts`, `level`, `service`, `env`.
- [ ] Logs de una misma request tienen el mismo `request_id`.
- [ ] Headers `authorization` no aparecen en los logs.
- [ ] `LOG_LEVEL=debug` cambia el filtro sin reiniciar la app.

**Bonus:** añade rotación con `pino-roll` o envía a Loki con `pino-loki`.

---

### Ejercicio 2 — Instrumenta métricas RED y expón `/metrics`

**Objetivo:** producir métricas Prometheus RED por endpoint y visualizarlas en Grafana.

**Setup:** app HTTP + Prometheus local + Grafana local (usa el `docker-compose` del §0).

**Pasos:**
1. Instala `prom-client` y define `http_requests_total` (counter) y `http_request_duration_seconds` (histogram con buckets razonables).
2. Middleware que popule las métricas usando `req.route?.path` (template, NO path resuelto).
3. Endpoint `/metrics` que exponga el registry.
4. Configura Prometheus para scrapear tu `/metrics`.
5. En Grafana crea 3 paneles: rate por route, error ratio por route, p95 latency por route.
6. Genera tráfico con `hey -n 10000 -c 20 http://localhost:3000/api/x`.

**Criterios de éxito:**
- [ ] `curl http://localhost:3000/metrics` devuelve texto formato Prometheus válido.
- [ ] Prometheus lista tu target como `up=1`.
- [ ] Grafana muestra los 3 paneles poblados.
- [ ] Path con IDs (`/users/12345`) aparece como `/users/:id`, no como 12345 valores distintos.
- [ ] Histogram tiene al menos 8 buckets razonables (5ms → 10s).

**Bonus:** añade recording rules `sli:...` de §6.4 y una gauge de `db_connections_active`.

---

### Ejercicio 3 — Distributed tracing con OpenTelemetry

**Objetivo:** conectar dos servicios (API + worker) con traces distribuidos vía Tempo/Jaeger.

**Setup:** dos apps Node/Python + Tempo o Jaeger local (Docker).

**Pasos:**
1. Añade el SDK OTel a ambos servicios (`@opentelemetry/sdk-node` + `getNodeAutoInstrumentations`).
2. Configura exporter OTLP HTTP apuntando a tu Tempo/Jaeger local (`http://localhost:4318`).
3. Servicio A recibe HTTP y llama a Servicio B con `fetch` (headers `traceparent` automáticos).
4. Servicio B loguea el `trace_id` recibido; verifica que coincide con el de A.
5. Añade un span custom en B con `tracer.startActiveSpan('process_message', ...)`.
6. Abre el trace en Jaeger UI o Tempo/Grafana y ve la cascada de spans.

**Criterios de éxito:**
- [ ] El trace en el UI muestra spans de ambos servicios con nombres claros.
- [ ] `trace_id` es consistente entre spans de A y B.
- [ ] Atributos `http.request.method`, `http.response.status_code` aparecen.
- [ ] Un span custom (`process_message`) es visible con atributos propios.
- [ ] Sampling ratio configurable via env var `OTEL_TRACES_SAMPLER_ARG`.

**Bonus:** añade un span de DB (Postgres/Redis) que aparezca automáticamente por la instrumentación.

---

### Ejercicio 4 — Sentry con `beforeSend` y contexto por usuario

**Objetivo:** capturar errores en Sentry con contexto útil pero sin PII.

**Setup:** cuenta Sentry (free tier) + app que emita errores.

**Pasos:**
1. Instala `@sentry/node`, configura `Sentry.init` con `dsn`, `environment`, `release`.
2. Implementa `beforeSend` que elimine `authorization`, `cookie` y campos que empiecen por `email`.
3. En un middleware, tras autenticar, `Sentry.setUser({ id: req.user.id })` (NO email/name).
4. Provoca dos errores distintos: un `TypeError` y un `TimeoutError`.
5. En el dashboard Sentry, verifica que aparecen agrupados por fingerprint y con contexto.
6. Cierra el `issue`, provoca de nuevo, comprueba que reabre y notifica.

**Criterios de éxito:**
- [ ] Dos issues distintos en Sentry (uno por cada tipo de error).
- [ ] `event.request.headers.authorization` es `undefined` en el event JSON.
- [ ] `user.id` presente, `user.email` ausente.
- [ ] `release` visible → puedes ver "regressed in vX.Y.Z".
- [ ] Notification en Slack/email disparada.

**Bonus:** conecta con GitHub para "Suspect Commits" y prueba el widget de user feedback.

---

### Ejercicio 5 — Alerta multi-window burn-rate y SLO panel

**Objetivo:** implementar una alerta de burn-rate y un panel de error budget.

**Setup:** Prometheus + Alertmanager (docker-compose) + una app instrumentada con RED.

**Pasos:**
1. Define recording rules `sli:success_ratio:rate5m/1h/6h/1d` en Prometheus.
2. Escribe alerta rápida (`14.4x` en 1h y 5m) severidad `page` y lenta (`6x` en 6h) severidad `ticket`.
3. Configura Alertmanager para enrutar `severity=page` a un webhook (Slack incoming webhook basta).
4. Simula fallos con un endpoint que devuelve 500 el 5% de las veces; genera carga con `hey`.
5. Observa la alerta dispararse tras ~2 min; recibe notificación.
6. Añade en Grafana un panel gauge de `1 - (1 - sli:success_ratio:rate1d) / (1 - 0.999)` (budget remaining).

**Criterios de éxito:**
- [ ] Alerta `APIErrorBudgetBurnFast` dispara con `for: 2m` sostenido.
- [ ] Notificación llega a Slack/webhook con `summary` y `runbook_url`.
- [ ] Panel de budget remaining refleja el consumo (baja rápido con fallo alto, se recupera al bajar).
- [ ] Alerta lenta se dispara antes que la rápida si el problema es sostenido pero pequeño.
- [ ] Documento runbook con pasos concretos (verificar deploy reciente, ver traces, rollback).

**Bonus:** integra con Grafana OnCall / PagerDuty; añade suppress durante deploys programados vía Alertmanager silences.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales de dev a staff. Cubren: structured logging (por qué JSON), correlation IDs entre servicios, sampling (head vs tail), tipos de métricas (counter/gauge/histogram/summary), cardinalidad como error caro, RED / USE / Golden Signals, OpenTelemetry como unificación, log levels apropiados, liveness vs readiness vs startup, SLI / SLO / error budget, alerting actionable y anti-fatiga, PII y compliance en logs, anatomía de un distributed trace, cuándo cada señal (logs/metrics/traces), Prometheus pull vs push, exemplars como puente métrica→trace, continuous profiling como cuarto pilar, performance de librerías de logging, blackbox vs whitebox monitoring, y cultura de post-mortem blameless.

- **Fuente:** [`packages/content/src/tech/programmer/sim-15-observability-for-devs.json`](../../packages/content/src/tech/programmer/sim-15-observability-for-devs.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-15-observability-for-devs`
- **Tiempo:** 25 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 14 — Linux y shell](./14-linux-y-shell.md) · [Índice](./README.md)
