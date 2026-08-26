# Capítulo 05 — Observabilidad y escala

> **Focus:** Cómo instrumentar, alertar y escalar sistemas modernos. RED vs USE vs Golden Signals, SLI/SLO/error budget, cardinality control, tracing sampling, hot partitions, N+1, connection pooling y auto-scaling correcto.
> **Áreas:** Observability · Scalability
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Conceptos básicos de logs, métricas y trazas.
- Familiaridad con al menos una stack de observabilidad: Prometheus + Grafana, CloudWatch, Datadog, New Relic o Honeycomb.
- Nociones de PromQL o de la lengua de queries de tu vendor.
- Kubernetes básico (Deployments, HPA, Metrics Server).
- Recomendable haber leído [Capítulo 04 — patrones de resiliencia](./04-patrones-de-resiliencia.md): observabilidad y resilience se complementan.

**Glosario mínimo:**
- **SLI (Service Level Indicator)**: métrica cuantitativa de calidad (p99 latency, error rate, availability).
- **SLO (Service Level Objective)**: objetivo numérico de un SLI (p99 < 200 ms, error rate < 0.1%).
- **SLA (Service Level Agreement)**: contrato externo con penalidad si se rompe el SLO. SLO más estricto que SLA.
- **Error budget**: 1 − SLO. Si SLO es 99.9%, budget es 0.1% de tiempo/mes para degradación.
- **RED (Rate, Errors, Duration)**: mnemónico de Tom Wilkie para servicios request/response.
- **USE (Utilization, Saturation, Errors)**: mnemónico de Brendan Gregg para recursos (CPU, disk, network).
- **Golden Signals**: latency, traffic, errors, saturation (Google SRE Book).
- **Cardinality**: número de series únicas de una métrica (combinaciones de labels).
- **Head/Tail sampling**: decidir muestreo de trazas al inicio (barato, pierde errores raros) o al final (caro, captura todo lo interesante).
- **Hot partition**: partición con carga desproporcionada en sistemas particionados (DynamoDB, Kafka).
- **N+1**: bug ORM donde 1 query lista + N queries por cada resultado.
- **Backpressure**: mecanismo para comunicar saturación upstream.
- **HPA (Horizontal Pod Autoscaler)**: recurso de Kubernetes que escala pods según métricas.

**Setup mínimo:**

```bash
# Prometheus 3.13 LTS (2026-07)
docker run -d --name prometheus -p 9090:9090 \
  -v $(pwd)/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus:v3.13.0 --web.enable-remote-write-receiver

# Grafana 12.x
docker run -d --name grafana -p 3000:3000 grafana/grafana:12.2.0

# OpenTelemetry Collector 0.116+
docker run -d --name otel-col -p 4317:4317 -p 4318:4318 \
  -v $(pwd)/otel-config.yaml:/etc/otelcol/config.yaml \
  otel/opentelemetry-collector-contrib:0.116.0

# Jaeger all-in-one 2.x (2026 estable)
docker run -d --name jaeger -p 16686:16686 -p 4317:4317 \
  jaegertracing/jaeger:2.3.0

# OpenTelemetry SDK auto-instrumentation
npm i @opentelemetry/api @opentelemetry/sdk-node \
      @opentelemetry/auto-instrumentations-node \
      @opentelemetry/exporter-trace-otlp-http

# k6 para carga
brew install k6   # o descargar de https://k6.io
```

---

## 1. El gran cuadro

Un sistema en producción tiene tres audiencias que hacen preguntas diferentes: **negocio** ("¿está caído?"), **ingenieros de guardia** ("¿por qué está lento?") y **desarrolladores del feature** ("¿qué está haciendo el código?"). La disciplina moderna de **observabilidad** distingue las **tres señales primarias** —métricas, logs y trazas— y cada una responde una clase de preguntas específica. Métricas son numéricas y agregadas: baratas, óptimas para "cuánto/cuántos" y para alertar. Logs son textuales: caros por byte, óptimos para "qué exactamente pasó en este momento". Trazas siguen una request a través de servicios: caras a escala, óptimas para "dónde se fue el tiempo". La confusión común —querer resolver todo con logs y `grep`— se rompe cuando el sistema pasa de miles a millones de requests por día.

El segundo eje es **SLO-driven engineering**. Sin objetivos numéricos, cada incidente se debate ad-hoc: "¿era grave?", "¿deberíamos escalar?", "¿podemos deployar la feature?". Con SLO explícito (99.9% de requests en < 200 ms) y **error budget** (0.1% del tiempo/mes), la decisión es data-driven: si consumiste el budget del trimestre, congelas features y trabajas reliability. Si te sobra, puedes tomar más riesgos. Este framework —Google SRE Book, Cap. 4— alinea a producto, ingeniería y ops en un mismo idioma. Los patrones derivados —**burn rate alerts**, **multi-window multi-burn-rate**, **error budget freezes**— son técnicas prácticas que hacen SLO operacional, no aspiracional.

El tercer eje es **escala consciente del bottleneck real**. Un sistema no "escala" en abstracto: escala en la dimensión donde está saturado. Un servicio I/O-bound no se beneficia de más CPU. Una DB con hot partition no se beneficia de más RCUs globales. Una app con N+1 no se beneficia de un connection pool más grande. Los patrones de este capítulo —**diagnóstico del bottleneck**, **scaling horizontal vs vertical**, **auto-scaling por métrica correcta**, **caching layers**, **connection pooling con límites reales**, **sharding sin hotspots**— constituyen el toolkit para escalar sin colapsar. Y todos ellos requieren observabilidad previa: sin métricas por partición, no ves hot partitions; sin trazas, no ves el waterfall del N+1; sin RED por endpoint, no sabes qué escalar.

---

## 2. Fundamentos: logs, métricas, trazas y correlación

### 2.1 La trinidad de observabilidad

Cindy Sridharan popularizó la formulación moderna: **metrics, logs, traces**. En 2026 se añade una cuarta señal en muchas stacks (Grafana, Datadog): **continuous profiling** — sampling ligero de perfiles de CPU/memoria en producción. Cada señal tiene coste y valor distintos:

| Señal | Cardinalidad | Coste | Óptima para |
|---|---|---|---|
| Métricas | Baja (docenas de labels) | Bajo | Alertar, agregar, SLI |
| Logs | Alta (any field) | Medio | Contexto exacto |
| Trazas | Muy alta (per-request) | Alto | Latencia distribuida |
| Profiles | Media | Bajo con eBPF | Hot spots CPU/mem |

**Regla:** métricas siempre (barato, esencial), logs con retención decreciente (7 días caliente, 30 tibio, S3 Glacier frío), trazas con sampling agresivo (1% base + 100% errores).

### 2.2 Structured logging con JSON

En 2026 el estándar es **structured logging con JSON**: cada línea es un objeto parseable con campos tipados. Herramientas modernas (Loki, ELK, CloudWatch Logs Insights, Datadog Logs) indexan por field, no por regex.

```ts
// src/logger.ts (Node + pino 9.x)
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: ['req.headers.authorization', 'req.body.password', '*.email', '*.ssn'],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Uso: SIEMPRE con campos, nunca string interpolation
logger.info({ userId, endpoint, durationMs, status }, 'request_completed');
logger.error({ err, retryCount, dependency: 'llm' }, 'llm_call_failed');
```

Regla de log levels (RFC 5424 syslog levels):

| Level | Cuándo | Ejemplo |
|---|---|---|
| ERROR | Necesita intervención (pager) | DB unreachable después de retries |
| WARN | Anomalía manejable | Retry usado, fallback activado |
| INFO | Evento de negocio | User logged in, order placed |
| DEBUG | Detalle interno (dev) | Query SQL con parámetros |
| TRACE | Ultra-verbose | Cada paso del algoritmo |

**Prueba mental:** "si escribo ERROR, ¿pagearía a alguien a las 3 AM por esto?". Si no, no es ERROR.

### 2.3 Correlation IDs y W3C Trace Context

Sin un identificador que atraviese todos los servicios, unir logs de una request específica es imposible. El estándar en 2026 es **W3C Trace Context** (2020, adoptado por OpenTelemetry como default). Dos headers:

- `traceparent: 00-<trace-id-32-hex>-<span-id-16-hex>-<flags>`
- `tracestate: <vendor-specific-list>`

El edge (API Gateway, load balancer, primer middleware) genera el `trace-id` si no existe; cada servicio downstream lo lee, lo incluye en **todos** sus logs, y lo propaga en llamadas subsiguientes. Esto convierte los logs en algo consultable por request:

```
{ "ts": "...", "level": "info", "trace_id": "4bf92f...", "service": "api", "msg": "start" }
{ "ts": "...", "level": "info", "trace_id": "4bf92f...", "service": "eval", "msg": "llm_call" }
{ "ts": "...", "level": "error", "trace_id": "4bf92f...", "service": "eval", "msg": "timeout" }
```

Un `grep '4bf92f'` reconstruye la vida completa de la request.

Middleware Fastify que gestiona el `traceparent`:

```ts
// src/middleware/trace-context.ts
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export const traceContext: FastifyPluginAsync = async (app) => {
  app.decorateRequest('traceId', '');
  app.decorateRequest('spanId', '');

  app.addHook('onRequest', async (req, reply) => {
    const parent = req.headers['traceparent'] as string | undefined;
    const match = parent && TRACEPARENT_RE.exec(parent);
    const traceId = match?.[1] ?? randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');

    (req as any).traceId = traceId;
    (req as any).spanId = spanId;
    reply.header('traceparent', `00-${traceId}-${spanId}-01`);

    req.log = req.log.child({ trace_id: traceId, span_id: spanId });
  });
};
```

### 2.4 OpenTelemetry como estándar 2026

**OpenTelemetry** (CNCF, fusión de OpenTracing + OpenCensus, 2019) es el estándar de facto: instrumenta una vez, exporta a cualquier backend. En 2026, la especificación de **Semantic Conventions** va por la versión **1.44.0**, con conventions específicas para GenAI (span names, attributes de token usage) que muchas empresas adoptan para instrumentar apps LLM.

Setup mínimo Node:

```ts
// src/otel.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'linguadev-api',
    [ATTR_SERVICE_VERSION]: process.env.SERVICE_VERSION ?? '0.0.0',
    'deployment.environment': process.env.NODE_ENV ?? 'dev',
  }),
  traceExporter: new OTLPTraceExporter({ url: 'http://otel-col:4318/v1/traces' }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: 'http://otel-col:4318/v1/metrics' }),
    exportIntervalMillis: 15_000,
  }),
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },   // demasiado ruido
  })],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown());
```

Con esto obtienes automáticamente spans para HTTP server/client, DB queries (pg, mysql2, redis), y muchas librerías populares — todo exportado al OTel Collector que decide dónde va (Jaeger, Tempo, Datadog…).

---

## 3. SLI/SLO/SLA y error budget

### 3.1 La distinción que importa

- **SLI** es la **medida** ("% de requests con status 2xx y latencia < 200 ms en ventana de 5 min").
- **SLO** es el **objetivo interno** ("99.9% de las peticiones cumplen el SLI en ventana móvil de 28 días").
- **SLA** es el **contrato externo** con cliente y penalidad ("99.5% mensual; si se rompe, reembolso 10%").

Regla: **SLO más estricto que SLA**, para tener margen antes de romper el contrato. Ejemplo: SLA 99.5%, SLO 99.9%. Si el SLO se rompe, activas medidas correctivas antes de que caiga el SLA.

### 3.2 Error budget: la moneda de la reliability

`Error budget = 1 − SLO`. Si SLO es 99.9%, el budget es **0.1%** del tiempo/mes = **43.2 min de degradación permitidos**.

- Si tienes budget disponible: puedes tomar riesgos (deployar features arriesgadas, chaos engineering agresivo).
- Si consumiste el budget: congela features, foco en reliability (bugfix, load testing, monitoring).

Este framework alinea producto e ingeniería: producto entiende que hay un presupuesto compartido; ingeniería tiene poder de negociación para bloquear features cuando el sistema está frágil.

### 3.3 Multi-window multi-burn-rate alerts

Google SRE Workbook (Cap. 5) publicó la técnica canónica para alertar sobre SLOs sin ruido. Un solo umbral falla en dos direcciones:

- Alertar rápido (ventana corta) = falsos positivos por picos transitorios.
- Alertar tarde (ventana larga) = descubrir la infra rota horas después.

La solución es combinar **dos ventanas** que deben superar el umbral **simultáneamente**:

```yaml
# prometheus/rules/slo-burn.yml — Prometheus 3.13
groups:
  - name: linguadev-api-slo
    interval: 30s
    rules:
      # SLI: fraction of successful requests
      - record: job:linguadev_api:sli_error_rate:5m
        expr: |
          sum(rate(http_requests_total{job="linguadev-api",status=~"5.."}[5m]))
          /
          sum(rate(http_requests_total{job="linguadev-api"}[5m]))

      - record: job:linguadev_api:sli_error_rate:1h
        expr: |
          sum(rate(http_requests_total{job="linguadev-api",status=~"5.."}[1h]))
          /
          sum(rate(http_requests_total{job="linguadev-api"}[1h]))

      # Fast burn: consume 2% of budget in 1h (SLO 99.9% → burn rate = 14.4)
      - alert: LinguaDevApiFastBurn
        expr: |
          job:linguadev_api:sli_error_rate:5m > (14.4 * 0.001)
          and
          job:linguadev_api:sli_error_rate:1h > (14.4 * 0.001)
        for: 2m
        labels: { severity: page }
        annotations:
          summary: "SLO burn rate x14.4 (fast) — action needed now"
          runbook_url: "https://runbooks.linguadev.internal/slo-fast-burn"

      # Slow burn: consume 10% of budget in 6h (burn rate ~= 6)
      - alert: LinguaDevApiSlowBurn
        expr: |
          job:linguadev_api:sli_error_rate:1h > (6 * 0.001)
          and
          job:linguadev_api:sli_error_rate:6h > (6 * 0.001)
        for: 15m
        labels: { severity: ticket }
        annotations:
          summary: "SLO burn rate x6 (slow) — investigate today"
```

- **Fast burn (x14.4)**: consumiría todo el budget en ~2 h → **page** al on-call.
- **Slow burn (x6)**: consumiría 30% en un día → **ticket** para investigar en horario laboral.

Esto elimina el 90% del ruido de alertas y filtra por severidad real.

---

## 4. RED, USE, Golden Signals y cardinality

### 4.1 Los tres mnemónicos que importan

- **RED** (Tom Wilkie, Weaveworks): **Rate, Errors, Duration**. Para servicios request/response (HTTP, RPC). Vista del cliente.
- **USE** (Brendan Gregg, Netflix): **Utilization, Saturation, Errors**. Para recursos (CPU, memoria, disk, network). Vista del sistema.
- **Golden Signals** (Google SRE Book): **Latency, Traffic, Errors, Saturation**. Superset combinado.

RED responde "qué experimenta el usuario"; USE responde "por qué está pasando".

### 4.2 Instrumentación mínima con Prometheus

```ts
// src/metrics.ts
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });   // USE de Node.js

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const inFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'HTTP requests currently being processed',
  labelNames: ['route'] as const,
  registers: [registry],
});
```

Hook Fastify para instrumentar todas las rutas:

```ts
app.addHook('onRequest', async (req) => {
  (req as any).startNs = process.hrtime.bigint();
  inFlight.inc({ route: req.routerPath ?? 'unknown' });
});

app.addHook('onResponse', async (req, reply) => {
  const durationSec = Number(process.hrtime.bigint() - (req as any).startNs) / 1e9;
  const labels = {
    method: req.method,
    route: req.routerPath ?? 'unknown',
    status: String(reply.statusCode),
  };
  httpRequests.inc(labels);
  httpDuration.observe(labels, durationSec);
  inFlight.dec({ route: req.routerPath ?? 'unknown' });
});
```

Queries PromQL útiles:

```promql
# Rate: requests per second by route
sum(rate(http_requests_total{job="linguadev-api"}[5m])) by (route)

# Errors: error rate por endpoint
sum(rate(http_requests_total{status=~"5.."}[5m])) by (route)
  / sum(rate(http_requests_total[5m])) by (route)

# Duration: p50, p95, p99 por endpoint (classic histograms)
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))

# Native histograms (Prometheus 3.x): histogram_quantile funciona directo
histogram_quantile(0.99, sum(rate(http_request_duration_seconds[5m])))

# USE: CPU saturation (load average / cores)
node_load1 / on() count(node_cpu_seconds_total{mode="user"}) without ()

# USE: disk saturation (IO time)
rate(node_disk_io_time_seconds_total[5m])
```

### 4.3 Cardinality explosion: el enemigo silencioso

Cada combinación única de labels es una **serie temporal** que Prometheus guarda en memoria. Si añades `user_id` como label a `http_requests_total` con 10 M de usuarios, tienes potencialmente 10 M × 20 endpoints × 5 status = **1000 M de series**. Cada serie consume RAM. Prometheus muere.

**Reglas duras:**

- Labels con cardinalidad **acotada**: endpoint (~docenas), status (~5), region (~decenas), tenantId (~cientos).
- Labels **prohibidos**: `user_id`, `session_id`, `request_id`, IP, timestamp exacto, `email`.
- Para analítica per-usuario: usa **logs** o **traces** (que sí toleran alta cardinalidad, con coste distinto).
- Máximo ~15 buckets por histogram tradicional. Con **native histograms** (Prometheus 3.x GA desde 3.8), la resolución se ajusta dinámicamente y una sola serie contiene lo que antes eran ~20.

Herramienta para auditar cardinalidad:

```promql
# Top 20 métricas por cardinalidad
topk(20, count by (__name__)({__name__=~".+"}))
```

Con Prometheus 3.x también puedes usar `label_replace` para reducir cardinalidad manteniendo información esencial, o alternativas como **VictoriaMetrics** o **Grafana Mimir** que están optimizadas para alta cardinalidad.

### 4.4 Native histograms (Prometheus 3.x)

Diferencia clave con histograms clásicos: en vez de definir buckets fijos (`0.005, 0.01, …`), Prometheus 3.x genera buckets exponenciales automáticamente con resolución configurable, dentro de **una sola serie** por métrica. Ventajas:

- Alta precisión (miles de buckets efectivos) con coste de una serie.
- Sin necesidad de ajustar buckets para nuevos rangos.
- Compatible con `histogram_quantile` sin cambios de query.

Configuración en client library (Node):

```ts
export const httpDurationNative = new Histogram({
  name: 'http_request_duration_seconds_native',
  help: 'HTTP request latency (native)',
  labelNames: ['method', 'route', 'status'] as const,
  // Native histogram config (Prometheus 3.8+)
  enableExemplars: true,
  buckets: [],   // vacío + config nativo enable
  registers: [registry],
});
```

Adopción 2026: Grafana Cloud, Prometheus 3.13 LTS (2026-07). El upgrade rompe compatibilidad con clientes viejos — validar antes de migrar producción.

---

## 5. Distributed tracing y sampling

### 5.1 Estructura de una traza

Una **trace** es un DAG de **spans**. Cada span representa una operación (HTTP handler, DB query, LLM call) con:

- `trace_id` (compartido entre todos los spans de la request).
- `span_id` (único del span).
- `parent_span_id` (para reconstruir el árbol).
- `name`, `start`, `end`.
- `attributes` (atributos semánticos: `http.method`, `db.system`, `llm.model`, etc.).
- `events` (logs dentro del span).
- `status` (OK / ERROR).

Visualización típica en Jaeger/Tempo: **waterfall** con cada span como una barra horizontal proporcional a su duración. Un vistazo te dice dónde se fue el tiempo.

### 5.2 Custom spans en OTel

```ts
// src/eval-answer.ts
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('linguadev-eval', '1.0.0');

export async function evaluateAnswer(userId: string, answer: string) {
  return tracer.startActiveSpan('eval.answer', async (span) => {
    span.setAttributes({
      'user.id': userId,           // OK en traces (alta cardinalidad tolerada)
      'answer.length': answer.length,
      'eval.model': 'claude-opus-4-7',
    });

    try {
      const rubric = await tracer.startActiveSpan('eval.load_rubric', async (s) => {
        try { return await loadRubric(); } finally { s.end(); }
      });

      const result = await tracer.startActiveSpan('eval.llm_call', async (s) => {
        s.setAttribute('gen_ai.request.model', 'claude-opus-4-7');
        try {
          const r = await callLLM(rubric, answer);
          s.setAttribute('gen_ai.usage.input_tokens', r.usage.inputTokens);
          s.setAttribute('gen_ai.usage.output_tokens', r.usage.outputTokens);
          return r;
        } finally { s.end(); }
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

Atributos con prefijo `gen_ai.*` siguen las **OpenTelemetry GenAI Semantic Conventions** (2026), diseñadas específicamente para instrumentar apps LLM.

### 5.3 Sampling: head vs tail vs adaptive

Guardar 100% de las trazas a escala es prohibitivamente caro (100k traces/s × 30 spans/trace × 1 KB/span = 3 GB/s de storage). Estrategias:

- **Head sampling**: decide en el edge si guardar la trace (probabilidad fija). Simple, barato, pero pierde errores raros (con 1% sampling, ves 1% de errores).
- **Tail sampling**: el OTel Collector bufferea todos los spans; al final decide guardar la trace basándose en el resultado (error, latencia > p99). Captura 100% de errores. Coste: memoria del buffer + latencia en el collector.
- **Adaptive**: ajusta la tasa según carga. Datadog y Honeycomb implementan variantes.

Configuración de tail sampling en OTel Collector:

```yaml
# otel-config.yaml
receivers:
  otlp:
    protocols: { http: {}, grpc: {} }

processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    expected_new_traces_per_sec: 1000
    policies:
      # Guardar 100% de errores
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      # Guardar 100% de trazas lentas (> 1s)
      - name: slow
        type: latency
        latency: { threshold_ms: 1000 }
      # Guardar 1% del resto (baseline)
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 1 }

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls: { insecure: true }

service:
  pipelines:
    traces:
      receivers:  [otlp]
      processors: [tail_sampling]
      exporters:  [otlp/jaeger]
```

**Regla:** la decisión de sampling debe ser **consistente cross-service**. Si el servicio A decide "no samplear" y B decide "sí", pierdes spans. El bit de `sampled` en el `traceparent` header (W3C Trace Context) propaga la decisión.

---

## 6. Escalabilidad: hot partitions, N+1, connection pools

### 6.1 Horizontal vs vertical

- **Vertical (scale up)**: más CPU/RAM en la misma máquina. Simple. Límite físico. No añade tolerancia a fallos.
- **Horizontal (scale out)**: más máquinas. Requiere código **stateless** (12-factor). Escala casi lineal.

Regla moderna: **stateless siempre que sea posible**. Estado va en DB persistente, Redis/cache compartido, o cliente (localStorage, JWT). Nunca en memoria del pod. Sticky sessions son un parche que rompe cuando el pod muere.

### 6.2 Hot partition: el enemigo del particionamiento

En sistemas particionados (DynamoDB, Cassandra, Kafka, sharded SQL), cada partición tiene un límite de throughput (~1000 WCU en DynamoDB). Si todos los writes van a la **misma** partition key, el resto del capacity es inútil.

Causas típicas:
- Partition key temporal (`created_at`, `date`): todos los writes al mes actual.
- Autoincrement PK: todos al último rango.
- Usuario "celebrity" con 10x el tráfico del promedio.

Soluciones:

1. **Write sharding con sufijo aleatorio**: `userId#0..9`. Distribuye a 10 sub-particiones. Reads hacen scatter-gather en las 10.
2. **Partition key más granular**: `(channel_id, hour_bucket)` en vez de `channel_id`.
3. **Mover el hot user a otra tabla / cache**.
4. **DynamoDB Adaptive Capacity** (default 2018+): mitiga automáticamente hasta cierto punto.

Ejemplo Cassandra:

```sql
-- Antes: hot partition por channel
CREATE TABLE messages (
    channel_id UUID,
    ts TIMESTAMP,
    msg_id UUID,
    body TEXT,
    PRIMARY KEY (channel_id, ts, msg_id)
);

-- Después: bucketing por hora
CREATE TABLE messages (
    channel_id UUID,
    bucket TEXT,     -- 'YYYYMMDDHH'
    ts TIMESTAMP,
    msg_id UUID,
    body TEXT,
    PRIMARY KEY ((channel_id, bucket), ts, msg_id)
);
```

Discord migró de MongoDB a Cassandra/ScyllaDB con exactamente este esquema para billones de mensajes.

### 6.3 N+1 queries: el bug de ORM más común

Anti-patrón: iterar sobre una lista y hacer 1 query por elemento.

```python
# app/api.py — ANTI-PATRÓN
orders = Order.query.all()                    # 1 query
for o in orders:
    user = o.user                              # N queries
    for item in o.items:                       # N * M queries
        ...
```

En una request que devuelve 100 orders con 10 items cada uno: 1 + 100 + 1000 = **1101 queries**. Latencia crece linealmente.

Soluciones:

- **Eager loading**: preload asociaciones. SQLAlchemy: `selectinload`, `joinedload`. Rails: `.includes(:user, :items)`. Django: `select_related`, `prefetch_related`. Prisma: `.include({ user: true, items: true })`.
- **DataLoader** (GraphQL, Facebook): batch de queries dentro del mismo tick del event loop. 100 `user.load(id)` → 1 `SELECT users WHERE id IN (...)`.
- **Query manual con JOIN**: SQL crudo o QueryBuilder.

Detección automática:

- **Rails**: gem `bullet` alerta N+1 en dev.
- **Django**: `django-debug-toolbar` cuenta queries.
- **SQLAlchemy**: `sqlalchemy.echo=True` + assertions en tests.
- **Prisma**: logs de queries + `PRISMA_ENGINE_PROTOCOL=json` en dev.
- **APM (Datadog, New Relic)**: dashboards muestran "N+1 anti-pattern detected".

Test unitario que cuenta queries:

```python
# tests/test_no_n_plus_1.py
def test_list_orders_uses_few_queries(client, db_session):
    with count_queries(db_session) as q:
        client.get('/orders')
    assert q.count <= 3, f"expected <=3 queries, got {q.count}"
```

### 6.4 Connection pooling: los límites reales

Cada instancia de tu app abre un pool a la DB. Si escalas a 100 pods con pool_size=20 → **2000 conexiones abiertas** a Postgres. Postgres default `max_connections=100`. Boom.

Reglas:

- Calcula: `total_connections = pods × pool_size` y compara con `max_connections` de la DB.
- Añade **PgBouncer** (transaction mode) para multiplexar: los pods hablan con PgBouncer, PgBouncer mantiene un pool pequeño real contra Postgres.
- Configura **statement timeout** y **idle_in_transaction_session_timeout** en Postgres para matar queries colgadas.
- En serverless (Lambda, Cloud Run), usa **RDS Proxy** (AWS) o **Cloud SQL Auth Proxy**.

Postgres config recomendada:

```conf
# postgresql.conf
max_connections = 200
statement_timeout = '30s'
idle_in_transaction_session_timeout = '60s'
tcp_keepalives_idle = 60
tcp_keepalives_interval = 10
tcp_keepalives_count = 3
```

### 6.5 Caching layers

Jerarquía típica de caches (más rápido → más lento):

1. **Browser / CDN edge** (Cloudflare, CloudFront) — global, muy barato, invalidation difícil.
2. **App-local (memoria)** — LRU en proceso. Cero red. Sin cross-pod invalidation.
3. **Distributed cache** (Redis, Memcached) — compartido. Red interna.
4. **DB query cache** (read replica, materialized views).

Estrategias de invalidación:

- **TTL**: expira tras X segundos. Simple, permite staleness bounded.
- **Write-through**: escribir a cache y DB simultáneamente.
- **Write-behind**: escribir a cache, DB actualiza async.
- **Cache-aside** (lazy loading): app pregunta cache; miss → carga de DB y llena cache.
- **Stale-while-revalidate** (SWR): sirve stale + refresca async.

Anti-patrón: **cache stampede** (cache miss simultáneo → N requests a la DB). Solución: **single-flight** (una request llena el cache, otras esperan) o **probabilistic early expiration**.

---

## 7. Auto-scaling: por métrica correcta

### 7.1 CPU no siempre es el bottleneck

Configurar HPA en Kubernetes al 70% CPU es el default más común y falla con servicios I/O-bound. Un pod bloqueado esperando DB tiene bajo CPU pero está saturado desde la perspectiva del usuario. HPA por CPU nunca escala en ese caso.

Métricas alternativas mejores:

- **RPS (requests per second)** por pod.
- **Latency p95/p99** sostenida > umbral.
- **In-flight requests** (concurrency).
- **Queue depth** en workers.
- **Custom app metrics** (business KPIs).

### 7.2 HPA con métricas custom (Prometheus Adapter)

```yaml
# k8s/hpa-eval.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: linguadev-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: linguadev-api
  minReplicas: 3
  maxReplicas: 50
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Percent
          value: 100
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300   # 5 min de margen antes de bajar
      policies:
        - type: Percent
          value: 25
          periodSeconds: 60
  metrics:
    # RPS por pod: objetivo 200 rps/pod
    - type: Pods
      pods:
        metric: { name: http_requests_per_second }
        target:
          type: AverageValue
          averageValue: "200"
    # p95 latency objetivo <500ms
    - type: Pods
      pods:
        metric: { name: http_p95_latency_ms }
        target:
          type: AverageValue
          averageValue: "500"
```

Requiere **Prometheus Adapter** o **KEDA** para exponer métricas Prometheus al API metrics de Kubernetes.

### 7.3 KEDA: autoscaling event-driven

KEDA (Kubernetes Event-Driven Autoscaling, CNCF) permite escalar por:

- Kafka lag
- SQS depth
- Redis Streams pending
- Prometheus query
- Cloud events (Azure Event Hubs, Google PubSub)

Ejemplo: escalar workers por profundidad de cola SQS:

```yaml
# k8s/keda-worker.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: eval-worker
spec:
  scaleTargetRef:
    name: eval-worker
  minReplicaCount: 1
  maxReplicaCount: 30
  pollingInterval: 15
  cooldownPeriod: 300
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.eu-west-1.amazonaws.com/123456789012/EvalQueue
        queueLength: "10"     # 1 pod por cada 10 mensajes
        awsRegion: eu-west-1
      authenticationRef:
        name: keda-aws-creds
```

Cuando la cola tiene 300 mensajes, KEDA escala a 30 pods. Cuando queda vacía, tras el cooldown baja a 1.

### 7.4 Serverless escala 1:1

Lambda, Cloud Run, Azure Functions escalan por request automáticamente: cada request llega → si no hay instancia caliente, spawn (cold start). Latencia añadida en Lambda cold start: ~200 ms - 2 s según runtime.

Mitigaciones:
- **Provisioned concurrency** (Lambda): mantener N instancias calientes.
- **SnapStart** (Java Lambda): snapshot del JVM inicializado.
- **Runtime ligero** (Node, Go, Rust) tiene cold starts menores.
- **Cloud Run**: min-instances > 0 para eliminar cold starts.

---

## 8. Casos reales industria (2015-2026)

**Uber cardinality outage (2018)**: añadir `hostname` como label en métricas Prometheus con miles de hosts causó explosión de cardinalidad y crash del sistema de monitoring. Lección viral en la comunidad: labels acotados o alta cardinalidad va a logs/traces.

**GitHub search outage (2021)**: hot partition en Elasticsearch por un tenant "celebrity" tumbó el índice. Migración a sharding más granular.

**Shopify N+1 (2019 publicación)**: blog post "De-N+1-ing" mostró mejoras 10x de latency en endpoints críticos usando `preload` de Rails de forma sistemática.

**Grafana Cloud native histograms (2024-2025)**: adopción temprana; blog publicando cómo reduce coste de storage 5-10x manteniendo precisión.

**Cloudflare Argo (2016+)**: usan tail sampling agresivo para tracing global; su blog "How Cloudflare's networks does distributed tracing" detalla la arquitectura con OpenTelemetry Collector.

**Netflix Adaptive Concurrency Limits (2018)**: open source de librería que ajusta límites de concurrencia por servicio basándose en latencia observada (Little's Law + Gradient2). Hoy integrada en Envoy.

**Prometheus 3.0 launch (nov 2024)** y **Prometheus 3.13 LTS (jul 2026)**: OTLP ingestion nativa, UTF-8 en labels, remote-write 2.0, native histograms estables desde 3.8. Impacto: menor necesidad de collectors intermediarios; mejor integración multi-vendor.

**OpenTelemetry GA de logs (2023) + Semantic Conventions 1.44.0 (2026)**: OTel completa las 3 señales; conventions GenAI (`gen_ai.request.model`, `gen_ai.usage.tokens`) permiten dashboards estándar de LLMs.

**AWS reInvent 2025 — Fault Injection Service integrado con CloudWatch**: chaos engineering managed, con templates para escenarios comunes (AZ failure, throttling, latency).

**Meta on-call transformation (2024-2025)**: publicado internamente, redujeron pages/shift de ~5 a ~1.5 mediante aplicación estricta de multi-window burn-rate y eliminación de alertas no accionables.

**Slack canary regression (2023)**: un rollout que pasó todos los tests unitarios y de integración causó saturación de connection pool en producción a las 2 h de despliegue por un patrón de acceso no previsto. Post-mortem público extensivo; ahora usan "shadow traffic" (mirror del tráfico prod al canary) además de gradual rollout.

**Discord 5-billion messages migration (2022+)**: publicaron cómo particionaron Cassandra con `(channel_id, bucket)` para evitar hot partitions y sostener billones de mensajes con latencia p99 estable.

---

## 9. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Structured logging JSON** con levels respetados y redaction de PII.
- ✅ **Correlation ID** propagado con W3C Trace Context.
- ✅ **RED** en cada servicio, **USE** en cada recurso.
- ✅ **SLI/SLO** definidos numéricamente, no aspiracionalmente.
- ✅ **Multi-window burn-rate** para alertar sin ruido.
- ✅ **Error budget** para gobernar releases vs reliability.
- ✅ **Cardinality acotada** en labels; per-usuario a logs/traces.
- ✅ **Sampling head + tail** para captura de errores sin coste prohibitivo.
- ✅ **OpenTelemetry** como estándar de instrumentación.
- ✅ **Stateless services** que escalan horizontal.
- ✅ **Shard key** por entidad de negocio, nunca por tiempo o autoincrement.
- ✅ **Detección N+1** en dev + tests.
- ✅ **Connection pool** dimensionado; RDS Proxy / PgBouncer en serverless.
- ✅ **HPA por métrica correcta** (RPS, latency, queue depth), no siempre CPU.
- ✅ **KEDA** para autoscaling event-driven.
- ✅ **Cache-aside + TTL** con protección contra stampede.
- ✅ **Continuous profiling** como 4a señal.

### Anti-patrones

- ❌ `console.log` con string interpolation en producción.
- ❌ Loguear todo como ERROR (fatigue).
- ❌ `user_id` o `request_id` como label de métrica.
- ❌ SLA sin SLI/SLO detrás.
- ❌ Alertar por CPU/memoria sin contexto (page el on-call por un spike).
- ❌ Sample uniforme al 1% (pierdes errores raros).
- ❌ HPA por CPU en app I/O-bound.
- ❌ Sharding por `created_at` (hot partition asegurada).
- ❌ Pool sin límite → agotar `max_connections` de la DB.
- ❌ Cache sin protección de stampede.
- ❌ SPA con N+1 en GraphQL sin DataLoader.
- ❌ Retention infinita de logs (coste explosivo).
- ❌ Métricas custom sin cardinality budget documentado.

### Tabla de decisión: bottleneck → acción

| Síntoma | Bottleneck probable | Acción |
|---|---|---|
| CPU 90% en app | CPU bound | Scale up o out; optimizar hot paths |
| CPU bajo, latency alta | I/O wait | Custom metric HPA (RPS o latency) |
| Un pod overloaded, otros idle | Sticky sessions o hash bad | Stateless + rebalance |
| DynamoDB throttle con capacity alta | Hot partition | Write sharding o partition key change |
| DB CPU 100% | Query pesada o N+1 | EXPLAIN, index, eager loading |
| Latency crece con dataset | N+1 o full scan | Detección + eager loading + index |
| Prometheus OOM | Cardinality explosion | Auditar labels, mover a logs |
| DB pool exhausted | Under-dimensioned | PgBouncer / RDS Proxy |
| Cache hit rate <70% | TTL malo o thundering herd | SWR, single-flight |
| Cold starts Lambda | Runtime pesado | Provisioned concurrency o SnapStart |

---

## 10. Ejercicios prácticos

### Ejercicio 1: instrumentar LinguaDev Pro con OpenTelemetry

**Objetivo:** habilitar traces + métricas OTel en la Lambda `eval-answer` y visualizar el waterfall.

**Setup:**
- OTel Collector local (`otel-config.yaml` con exporter a Jaeger).
- Jaeger UI en http://localhost:16686.

**Pasos:**
1. Añade `@opentelemetry/sdk-node` y auto-instrumentations a la Lambda.
2. Configura `OTEL_EXPORTER_OTLP_ENDPOINT` como env var apuntando al collector.
3. Añade spans custom en `evaluateAnswer`: `eval.load_rubric`, `eval.llm_call`, `eval.persist`.
4. Marca atributos `gen_ai.request.model`, `gen_ai.usage.input_tokens`.
5. Genera 20 requests y visualiza en Jaeger.
6. Identifica cuál span consume más tiempo (probablemente `llm_call`).

**Criterios de éxito:**
- [ ] `trace_id` visible en logs y en Jaeger.
- [ ] Waterfall muestra jerarquía padre/hijo correcta.
- [ ] Atributos `gen_ai.*` visibles en Jaeger.
- [ ] p95 de `eval.llm_call` visible como métrica en Prometheus.
- [ ] Sampling 100% en dev, configurable a 10% en prod.

**Bonus:** exportar también métricas al mismo Collector y crear dashboard Grafana con RED del endpoint.

---

### Ejercicio 2: definir SLO y alertas multi-window para el endpoint de reviews

**Objetivo:** SLO 99.5% de `POST /reviews` con latencia < 300 ms; alertas fast/slow burn.

**Setup:**
- Prometheus 3.x recibiendo métricas de la app.
- Alertmanager con integración Slack.

**Pasos:**
1. Define el SLI: fracción de requests `2xx` con `duration < 0.3s`.
2. Documenta el SLO en `docs/slo/reviews.md` con contexto de negocio.
3. Crea reglas de recording en `prometheus/rules/reviews-slo.yml`.
4. Añade alertas `ReviewsFastBurn` (x14.4 → page) y `ReviewsSlowBurn` (x6 → ticket).
5. Simula degradación con Toxiproxy inyectando latencia y verifica que dispara.
6. Documenta el runbook en `docs/runbooks/reviews-slo-burn.md`.

**Criterios de éxito:**
- [ ] SLO documentado con owner y fecha de revisión.
- [ ] Reglas Prometheus validadas con `promtool check rules`.
- [ ] Alerta fast burn dispara < 2 min de simulación.
- [ ] Alerta slow burn dispara sólo tras 15 min sostenidos.
- [ ] Runbook con pasos concretos y link a dashboard.

**Bonus:** dashboard Grafana con panel de "budget remaining %" calculado sobre 28 días móviles.

---

### Ejercicio 3: detectar y arreglar N+1 en un endpoint

**Objetivo:** identificar un N+1 en `GET /users/:id/reviews` y demostrar la mejora de latencia.

**Setup:**
- Endpoint con Prisma/SQLAlchemy que devuelve reviews del usuario con sus tarjetas asociadas.
- Base con al menos 500 reviews por usuario.

**Pasos:**
1. Habilita `PRISMA_LOG=query` (o `sqlalchemy.echo=True`).
2. Ejecuta un `curl` al endpoint y cuenta las queries en el log.
3. Documenta el count (probablemente 501+).
4. Aplica `include: { card: true }` (Prisma) o `selectinload` (SQLAlchemy).
5. Vuelve a contar queries — debe bajar a 1-2.
6. Añade test `test_no_n_plus_1` que cuenta queries y falla si > 3.
7. Mide p95 antes/después con `k6`.

**Criterios de éxito:**
- [ ] Queries reducidas de N+1 a ≤3.
- [ ] p95 mejorado ≥50%.
- [ ] Test unitario que falla ante regresión.
- [ ] Documentado el fix en el PR.

**Bonus:** añade CI check que ejecute el test en cada PR.

---

### Ejercicio 4: auditar cardinality en Prometheus

**Objetivo:** identificar métricas problemáticas y proponer fixes.

**Setup:**
- Prometheus con al menos 1 semana de datos.
- Acceso a la UI de Prometheus.

**Pasos:**
1. Ejecuta `topk(20, count by (__name__)({__name__=~".+"}))` en la UI.
2. Identifica las 5 métricas con más series.
3. Para cada una, investiga qué labels tienen alta cardinalidad: `count(count by (label_name) (metric_name))`.
4. Documenta cuáles labels son legítimos (endpoint, status) y cuáles no (user_id, request_id).
5. Propón migración: quitar labels problemáticos y mover analítica a logs/traces.
6. Aplica los cambios y verifica reducción de series.

**Criterios de éxito:**
- [ ] Report con top 20 métricas y sus labels problemáticos.
- [ ] Al menos una métrica migrada a labels acotados.
- [ ] Verificación de reducción (`prometheus_tsdb_head_series`).
- [ ] Documentar "cardinality budget" por métrica en un YAML.

**Bonus:** integrar `promtool` en CI para fallar si una PR añade nueva métrica sin justificar cardinality.

---

### Ejercicio 5: HPA por métrica custom con KEDA

**Objetivo:** el worker `eval-batch` debe escalar por depth de la cola SQS, no por CPU.

**Setup:**
- Kubernetes cluster con KEDA instalado (`helm install keda kedacore/keda -n keda`).
- Cola SQS `EvalQueue`.
- Deployment `eval-batch` corriendo.

**Pasos:**
1. Crear IAM role con permiso `sqs:GetQueueAttributes` (o usar IRSA en EKS).
2. Crear el `TriggerAuthentication` para KEDA.
3. Crear `ScaledObject` con `queueLength: 10` (1 pod por cada 10 msgs).
4. Enviar 200 mensajes de prueba a la cola.
5. Observar `kubectl get hpa` → debe escalar a 20 pods.
6. Vaciar la cola y observar que baja tras el cooldown de 5 min.

**Criterios de éxito:**
- [ ] Escala automática de 1 → 20 pods bajo carga.
- [ ] Baja a `minReplicaCount` tras cooldown.
- [ ] Dashboard Grafana con overlay de `queue_depth` y `pod_count`.
- [ ] Documentación del ratio elegido (1:10) con justificación.

**Bonus:** añadir alerta si `pod_count == maxReplicaCount` durante > 15 min (indica que el max está mal dimensionado).

---

## 11. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades junior → staff. Cubren: trinidad de observabilidad (metrics/logs/traces), SLI/SLO/SLA + error budget, hot partition + sharding, structured logging JSON, correlation IDs y W3C Trace Context, cardinality explosion, log levels sanos, alerting sin fatigue (burn-rate), sampling de trazas (head/tail/adaptive), health checks liveness/readiness/startup, RED vs USE, bimodal distribution y percentiles, stateless design y 12-factor, HPA con custom metrics vs CPU, backpressure y load shedding, rate limiting (token bucket, sliding window), OpenTelemetry, PII redaction en logs, N+1 queries y DataLoader, y continuous profiling como cuarta señal.

- **Fuente:** [`packages/content/src/tech/architecture/sim-05-observability-and-scale.json`](../../packages/content/src/tech/architecture/sim-05-observability-and-scale.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-05-observability-and-scale`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 04 — patrones de resiliencia](./04-patrones-de-resiliencia.md) · [Capítulo 06 — CAP y consistencia →](./06-cap-y-consistencia.md) · [Índice](./README.md)
