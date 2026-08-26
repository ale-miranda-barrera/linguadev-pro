# Capítulo 19 — Logging: ELK y Loki

> **Focus:** Ciclo de vida del log (produce → ship → store → query → retain), shippers (Filebeat, Fluent Bit 3.2+, Fluentd, Vector 0.45+), Elasticsearch/OpenSearch vs Loki 3.3, log formats estructurados, correlación con traces, sampling, ILM y LogQL vs KQL vs Lucene.
> **Áreas:** Observabilidad · Logs · SRE
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Docker/Docker Compose.
- Fundamentos de Prometheus ([cap 17](./17-prometheus-y-metrics.md)) y Grafana ([cap 18](./18-grafana-y-dashboards.md)) — se reusa el data source de Loki y la correlación con métricas.
- Nociones de JSON, YAML y regex.
- Un idioma de instrumentación (Node.js, Go, Python, JVM) para emitir logs estructurados.

**Glosario mínimo:**
- **Log**: evento discreto con timestamp, nivel, mensaje y opcionalmente atributos estructurados.
- **Log level**: severidad. Convención estándar (RFC 5424 + practical): `trace, debug, info, warn, error, fatal`.
- **Structured log**: log emitido como JSON (o similar) con campos parseables, no texto libre.
- **Shipper**: proceso que lee logs del origen (file, stdout, journald, syslog) y los envía a un backend.
- **Ingest pipeline**: pasos de transformación cuando el backend recibe (parse, enrich, drop, route).
- **Index**: estructura de búsqueda invertida (Elasticsearch/OpenSearch) que permite full-text.
- **Label**: metadata indexada (Loki) para filtrar streams; **NO** para full-text.
- **Correlation ID**: identificador único que propagas por todo el request (trace_id de W3C, o UUID custom).
- **LogQL**: lenguaje de queries de Loki, sintaxis inspirada en PromQL.
- **KQL** (Kibana Query Language): DSL de Kibana/OpenSearch, más simple que Lucene.
- **Lucene**: sintaxis original de Elasticsearch, más potente pero verbosa.
- **ILM** (Index Lifecycle Management): políticas de hot/warm/cold/delete para índices.
- **Sampling**: emitir solo N% de logs cuando el volumen sube.
- **OTLP logs**: formato OpenTelemetry para logs, adoptado por Loki 3.0+ y colectores modernos.

**Setup mínimo:**

```yaml
# docker-compose.yml (añade al de cap 17 + 18)
services:
  loki:
    image: grafana/loki:3.3.2
    command: -config.file=/etc/loki/config.yaml
    volumes:
      - ./loki-config.yaml:/etc/loki/config.yaml:ro
      - loki-data:/loki
    ports: ["3100:3100"]

  fluent-bit:
    image: fluent/fluent-bit:3.2
    volumes:
      - ./fluent-bit.conf:/fluent-bit/etc/fluent-bit.conf:ro
      - ./parsers.conf:/fluent-bit/etc/parsers.conf:ro
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
    depends_on: [loki]

  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.16.1
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
    ports: ["9200:9200"]

  kibana:
    image: docker.elastic.co/kibana/kibana:8.16.1
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
    ports: ["5601:5601"]

  vector:
    image: timberio/vector:0.45.0-alpine
    volumes:
      - ./vector.toml:/etc/vector/vector.toml:ro
    depends_on: [loki, elasticsearch]

volumes:
  loki-data: {}
```

```bash
docker compose up -d loki fluent-bit
open http://localhost:3000    # Grafana → Explore → Loki
```

---

## 1. El gran cuadro

Los logs son el pilar de observabilidad más antiguo (syslog nació en los 80s con Sendmail) y sigue siendo insustituible: cuando algo falla de manera **inexplicable**, los logs son el único lugar donde encuentras el `panic`, el stack trace o la línea exacta que explica el "por qué". Métricas te dicen **qué** y **cuánto**; traces te dicen **dónde**; logs te dicen **por qué**. Los tres se complementan y en 2026 se enlazan mediante **correlation IDs** (trace_id) y campos comunes.

El ecosistema tiene dos grandes escuelas: **Elasticsearch/OpenSearch** (indexa todo el contenido del log para full-text search, con storage caro pero query poderoso), y **Loki** (indexa solo labels y guarda el cuerpo comprimido, storage barato pero requiere filtros por label + grep-style). En 2026 la balanza se ha inclinado hacia Loki para muchos casos por dos razones: **coste de storage 10-100× menor** (blocks en S3) y **modelo mental idéntico a Prometheus** (mismos labels, mismas rules, misma Grafana). Elasticsearch/OpenSearch sigue siendo relevante para **búsqueda ad-hoc** en logs de auditoría, seguridad (SIEM) y contenido no estructurado donde full-text es imprescindible.

Los **shippers** son la capa que decide qué logs viajan y cómo. **Filebeat** (Elastic, 2015) es el histórico del stack ELK; **Fluentd** (2011) fue el standard CNCF durante años; **Fluent Bit** (2015, CNCF graduado 2019) reemplazó a Fluentd en Kubernetes por su footprint (<10 MB RAM); **Vector** (Timber.io → Datadog, 2019) es la nueva estrella por su Vector Remap Language (VRL) y su performance en Rust. En 2026 los cuatro conviven, pero **Fluent Bit 3.2+** (2024) y **Vector 0.45+** (2025) son las opciones default para nuevos deployments — ambos con soporte OpenTelemetry OTLP nativo.

Loki 3.0 (mayo 2024) añadió **soporte nativo OTLP** para logs; **Loki 3.3** (nov 2024) mejoró Bloom filters para acelerar queries sobre **structured metadata** (labels de alta cardinality como user_id, request_id, que ahora **sí** pueden vivir en Loki sin explotar índices porque son structured metadata, no labels indexados). En este capítulo cubrimos el stack completo con foco en **Loki 3.3 + Fluent Bit 3.2 + Vector 0.45** y comparativa con **OpenSearch 3.x** (fork de Elasticsearch 7 tras el cambio de licencia de Elastic en 2021, en 2026 la opción preferida para casos que requieren indexing full-text sin restricción de licencia).

El impacto operativo es directo: un pipeline de logs mal diseñado consume tanto o más presupuesto de infra que la app misma. Casos como Cloudflare (2019) o GitHub (2020) documentaron cómo un incidente puede multiplicar el volumen de logs por 100× en minutos y saturar el backend. Sin **sampling**, **structured logging** y **rate limiting** por servicio, tus logs son una bomba de tiempo.

---

## 2. Logs estructurados y niveles (nivel básico)

### 2.1 Por qué JSON, no strings

Un log como este es una pesadilla para parsear:

```text
2026-08-13 21:34:12 INFO User 12847 logged in from 10.0.1.42 (session=abc123, took 145ms)
```

El mismo evento como JSON es trivial:

```json
{
  "ts": "2026-08-13T21:34:12.483Z",
  "level": "info",
  "msg": "user logged in",
  "user_id": 12847,
  "ip": "10.0.1.42",
  "session_id": "abc123",
  "duration_ms": 145,
  "service": "auth",
  "env": "production",
  "trace_id": "5b8aa5a2d2c872e8321cf37308d69df2",
  "span_id": "051581bf3cb55c13"
}
```

Ventajas: parseable sin regex, filtrable por campo exacto, agregable, correlacionable con traces, exportable a cualquier backend.

### 2.2 Convenciones de campos (OTel Semantic Conventions)

OpenTelemetry publica **Semantic Conventions** para los nombres canónicos de campos. Adóptalos en 2026:

| Campo | Ejemplo |
|---|---|
| `service.name` | `auth-api` |
| `service.namespace` | `linguadev` |
| `service.version` | `1.4.7` |
| `deployment.environment` | `production` |
| `http.request.method` | `POST` |
| `http.response.status_code` | `500` |
| `http.route` | `/api/users/:id` |
| `trace_id` | (W3C traceparent) |
| `span_id` | |
| `error.type` | `TimeoutError` |
| `user.id` | (evita PII directa si aplica; hashea) |

### 2.3 Log levels: cuándo usar cada uno

- **trace**: instrumentación de máximo detalle. Off por defecto.
- **debug**: información útil para dev/staging. Off en producción.
- **info**: eventos de negocio significativos (login, order created, cache miss).
- **warn**: algo raro pero no fatal (retry, degraded mode, deprecation).
- **error**: fallo real que no se pudo manejar. Debería activar alertas si supera threshold.
- **fatal**: proceso a punto de morir. Emisión + exit(1).

**Anti-patrón #1**: usar `error` para eventos esperados (`user not found` no es error — es 404 legítimo). Contamina las alertas.

**Anti-patrón #2**: `info` para todo. En producción los logs `debug`/`trace` deben desactivarse por default y activarse **por request** con un feature flag o header `X-Debug-Level: debug`.

### 2.4 Instrumentación estructurada

**Node.js con Pino** (el logger más rápido del ecosistema):

```javascript
import pino from 'pino';
import { trace } from '@opentelemetry/api';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: () => ({
      service: 'auth-api',
      env: process.env.NODE_ENV,
      version: process.env.APP_VERSION,
    }),
    log: (obj) => {
      const span = trace.getActiveSpan();
      if (span) {
        obj.trace_id = span.spanContext().traceId;
        obj.span_id = span.spanContext().spanId;
      }
      return obj;
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.authorization', 'req.body.password', '*.credit_card'],
    censor: '[REDACTED]',
  },
});

logger.info({ user_id: 12847, ip: '10.0.1.42', duration_ms: 145 }, 'user logged in');
```

**Go con slog** (estándar library desde Go 1.21):

```go
import "log/slog"

logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
    AddSource: false,
}))
logger = logger.With(
    slog.String("service", "auth-api"),
    slog.String("env", os.Getenv("APP_ENV")),
)

logger.Info("user logged in",
    slog.Int("user_id", 12847),
    slog.String("ip", "10.0.1.42"),
    slog.Duration("duration", 145*time.Millisecond),
)
```

### 2.5 PII y compliance

Nunca loguees passwords, tokens, tarjetas, direcciones exactas. El GDPR/CCPA/EU AI Act exigen minimización. Aplica **redaction** en el logger (como el `redact` de Pino) y en el shipper como defensa en profundidad:

```conf
# Fluent Bit — parser de redaction
[FILTER]
    Name       modify
    Match      *
    Remove_wildcard password
    Remove_wildcard token
    Remove_wildcard authorization
```

---

## 3. Shippers: Filebeat, Fluent Bit, Fluentd, Vector (nivel medio)

### 3.1 Comparativa 2026

| Shipper | Lenguaje | RAM típico | Fortalezas | Debilidades |
|---|---|---|---|---|
| **Filebeat** | Go | 30-100 MB | Integración perfecta con Elastic Stack, módulos pre-configurados | Solo push a Elastic Stack por design |
| **Fluentd** | Ruby + C | 100-200 MB | Ecosistema masivo (>1000 plugins), maduro | Ruby GC, más lento que alternativas |
| **Fluent Bit** | C | 5-10 MB | Ultra-ligero, OTLP nativo, K8s auto-enrichment | Menos plugins que Fluentd |
| **Vector** | Rust | 30-80 MB | VRL (transform lang), unified logs+metrics+traces, performance top | Curva de aprendizaje VRL |
| **OTel Collector** | Go | 50-150 MB | Standard OTel, unified signals | Menos maduro en logs que en traces |

En 2026 la elección típica:
- **Kubernetes DaemonSet ligero**: Fluent Bit 3.2.
- **Edge/data plane con transforms complejos**: Vector 0.45.
- **Ecosistema Elastic legacy**: Filebeat.
- **Migración a OTel**: OTel Collector con `filelog` receiver.

### 3.2 Fluent Bit 3.2 para Kubernetes

```conf
# fluent-bit.conf
[SERVICE]
    Flush          1
    Log_Level      info
    Parsers_File   parsers.conf
    HTTP_Server    On
    HTTP_Listen    0.0.0.0
    HTTP_Port      2020
    storage.path              /var/log/flb-storage/
    storage.sync              normal
    storage.checksum          off
    storage.backlog.mem_limit 5M

[INPUT]
    Name              tail
    Path              /var/log/containers/*.log
    multiline.parser  docker, cri
    Tag               kube.*
    Refresh_Interval  5
    Mem_Buf_Limit     50MB
    Skip_Long_Lines   On
    storage.type      filesystem

[FILTER]
    Name                kubernetes
    Match               kube.*
    Kube_URL            https://kubernetes.default.svc:443
    Kube_CA_File        /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    Kube_Token_File     /var/run/secrets/kubernetes.io/serviceaccount/token
    Kube_Tag_Prefix     kube.var.log.containers.
    Merge_Log           On
    Merge_Log_Key       log_processed
    K8S-Logging.Parser  On
    K8S-Logging.Exclude On
    Buffer_Size         64k
    Labels              On
    Annotations         Off

[FILTER]
    Name    grep
    Match   kube.*
    Exclude $kubernetes['namespace_name'] ^(kube-system|kube-public)$

[FILTER]
    Name    modify
    Match   *
    Remove_wildcard password
    Remove_wildcard authorization
    Remove_wildcard credit_card

[OUTPUT]
    Name           loki
    Match          kube.*
    Host           loki
    Port           3100
    Labels         job=fluent-bit, cluster=prod, $kubernetes['namespace_name'], $kubernetes['pod_name'], $kubernetes['container_name']
    Label_keys     $level,$service,$env
    line_format    json
    remove_keys    kubernetes,stream,_p
    workers        4
```

```conf
# parsers.conf
[PARSER]
    Name        json
    Format      json
    Time_Key    ts
    Time_Format %Y-%m-%dT%H:%M:%S.%LZ
    Time_Keep   On

[MULTILINE_PARSER]
    name          docker
    type          regex
    flush_timeout 1000
    rule          "start_state"   "/^\{.*\}$/"    "cont"
    rule          "cont"          "/^\{.*\}$/"    "cont"
```

Fluent Bit 3.2 añade OTLP output y mejora en performance del filtro `kubernetes`.

### 3.3 Vector 0.45 con Vector Remap Language (VRL)

Vector destaca por VRL: un lenguaje puro para transform en el pipeline. Un mismo Vector puede leer logs, parsear, enriquecer, samplear y enviar a múltiples sinks.

```toml
# vector.toml
[sources.docker_logs]
type = "docker_logs"
docker_host = "unix:///var/run/docker.sock"

[sources.otlp_logs]
type = "opentelemetry"
mode = "grpc"
address = "0.0.0.0:4317"

[transforms.parse_json]
type = "remap"
inputs = ["docker_logs"]
source = '''
. |= parse_json!(.message)
.service = .container_name
.env = get_env_var("APP_ENV") ?? "unknown"
if exists(.trace_id) {
  .trace_id = downcase!(.trace_id)
}
'''

[transforms.redact_pii]
type = "remap"
inputs = ["parse_json"]
source = '''
if exists(.password) { del(.password) }
if exists(.authorization) { del(.authorization) }
if exists(.email) { .email = redact(.email, filters: [r'\S+@\S+']) }
'''

[transforms.sample_debug]
type = "sample"
inputs = ["redact_pii"]
rate = 100                              # 1 de cada 100 logs debug
key_field = "level"
exclude.type = "vrl"
exclude.source = '.level != "debug"'    # samplea solo debug, no info/warn/error

[transforms.route_by_level]
type = "route"
inputs = ["sample_debug"]
route.errors  = '.level == "error" || .level == "fatal"'
route.warnings = '.level == "warn"'
route.rest    = 'true'

[sinks.loki_all]
type = "loki"
inputs = ["route_by_level.rest", "route_by_level.warnings", "route_by_level.errors"]
endpoint = "http://loki:3100"
compression = "snappy"
encoding.codec = "json"
labels.service = "{{ service }}"
labels.env = "{{ env }}"
labels.level = "{{ level }}"

[sinks.pagerduty_critical]
type = "http"
inputs = ["route_by_level.errors"]
uri = "https://events.pagerduty.com/v2/enqueue"
method = "post"
encoding.codec = "json"
```

Vector VRL permite transformaciones complejas (filtering, enrichment con GeoIP, hashing PII, sampling adaptativo) que en Fluent Bit requerirían múltiples filtros encadenados.

### 3.4 Enrichment con Kubernetes metadata

En K8s cada log debe llevar `namespace`, `pod`, `container`, `node`, `labels.app`. Ambos Fluent Bit y Vector lo hacen automáticamente vía la API. Este enrichment es crítico para queries como "logs de todos los pods de `auth-api` en `production`".

---

## 4. Elasticsearch/OpenSearch vs Loki (nivel medio → senior)

### 4.1 Modelo de indexing

**Elasticsearch/OpenSearch**: cada log se parsea, sus campos se indexan (índice invertido Lucene), y el documento completo se guarda. Query `"error" AND service:auth-api AND @timestamp:[now-1h TO now]` es full-text sub-segundo. Storage: 2-5× el tamaño raw por overhead de índices.

**Loki**: solo los **labels** (job, service, level, pod, ...) se indexan. El cuerpo del log se guarda comprimido en chunks en S3. Query filtra primero por labels (baja cardinality) y luego hace grep sobre los chunks matching. Storage: comparable al raw (compresión gzip/snappy). Coste: 10-100× menor que Elasticsearch.

Trade-off:
- Elasticsearch/OpenSearch: query full-text arbitraria rápida; storage caro; index management complejo (ILM).
- Loki: query full-text lenta (necesita grep en chunks); storage barato; simple.

### 4.2 Coste real 2026

Para 1 TB/día de logs con 30d de retención:
- **Elasticsearch Cloud**: ~$8-15K/mes.
- **OpenSearch en AWS r6g.2xlarge cluster**: ~$5-10K/mes.
- **Loki en S3**: ~$500-1500/mes (S3 + ingester + querier en spot).

Este es **el** motivo por el que Loki gana share. Pero cuando necesitas búsqueda ad-hoc frecuente sobre logs no estructurados (auditoría, security, forensics), Elasticsearch/OpenSearch sigue siendo mejor.

### 4.3 Loki 3.3: structured metadata + Bloom filters

Loki 3.3 (nov 2024) resolvió el gran problema de Loki con datos de alta cardinality: los **structured metadata** (feature de Loki 2.9). Ahora puedes adjuntar campos como `user_id`, `request_id`, `trace_id` como metadata **no indexada** pero **queryable** con aceleración por **Bloom filters**.

```yaml
# loki-config.yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-04-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  allow_structured_metadata: true
  retention_period: 30d
  max_query_parallelism: 32
  ingestion_rate_mb: 20
  ingestion_burst_size_mb: 40

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  delete_request_store: filesystem

bloom_build:
  enabled: true
bloom_gateway:
  enabled: true

query_scheduler:
  max_outstanding_requests_per_tenant: 32768

frontend:
  log_queries_longer_than: 5s
  compress_responses: true

ruler:
  storage:
    type: local
    local:
      directory: /loki/rules
  rule_path: /loki/rules-tmp
```

### 4.4 OpenSearch en producción

**OpenSearch 3.x** (fork Elastic 7 mantenido por AWS + comunidad tras el cambio de licencia SSPL/Elastic License de Elastic en 2021) es API-compatible con Elasticsearch 7 y añade features propias (SQL, alerting, anomaly detection, PPL).

```yaml
# opensearch/index-template.json
{
  "index_patterns": ["logs-*"],
  "template": {
    "settings": {
      "index.number_of_shards": 3,
      "index.number_of_replicas": 1,
      "index.refresh_interval": "30s",
      "index.codec": "best_compression",
      "index.lifecycle.name": "logs-policy",
      "index.lifecycle.rollover_alias": "logs"
    },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "level":      { "type": "keyword" },
        "service":    { "type": "keyword" },
        "env":        { "type": "keyword" },
        "trace_id":   { "type": "keyword" },
        "message":    { "type": "text", "norms": false },
        "user_id":    { "type": "keyword", "doc_values": false }
      }
    }
  }
}
```

### 4.5 ILM (Index Lifecycle Management)

Fases estándar:
1. **Hot**: nuevo, alto write, SSD, replica 1. Días 0-7.
2. **Warm**: menos write, HDD-cheap, replica 0. Días 8-30.
3. **Cold**: read-only, searchable snapshots en S3. Días 31-90.
4. **Frozen**: object storage con partial mount. Días 91-365.
5. **Delete**: eliminar.

```json
{
  "policy": {
    "phases": {
      "hot":    { "actions": { "rollover": { "max_age": "7d", "max_primary_shard_size": "50gb" } } },
      "warm":   { "min_age": "7d",  "actions": { "shrink": { "number_of_shards": 1 }, "forcemerge": { "max_num_segments": 1 } } },
      "cold":   { "min_age": "30d", "actions": { "searchable_snapshot": { "snapshot_repository": "logs-s3" } } },
      "frozen": { "min_age": "90d", "actions": { "searchable_snapshot": { "snapshot_repository": "logs-s3" } } },
      "delete": { "min_age": "365d", "actions": { "delete": {} } }
    }
  }
}
```

En Loki el equivalente es `retention_period` en `limits_config` + `compactor.retention_enabled: true`.

---

## 5. Query languages: LogQL vs KQL vs Lucene (nivel medio → senior)

### 5.1 LogQL (Loki)

Sintaxis inspirada en PromQL. Dos partes: **log stream selector** (labels) y **filter expressions** (grep + parse).

```logql
# Selección básica por labels
{service="auth-api", env="production"}

# Filtrado de texto (grep-style)
{service="auth-api"} |= "error"
{service="auth-api"} != "healthcheck"
{service="auth-api"} |~ "timeout|deadline"    # regex

# Parseo JSON y filtrado por campo
{service="auth-api"} | json | level="error" | duration_ms > 1000

# Extracción con regex
{service="nginx"} | regexp `(?P<status>\d{3})` | status="500"

# Métricas derivadas de logs
sum by (level) (rate({service="auth-api"}[5m]))
sum by (route) (count_over_time({service="auth-api"} | json | line_format "{{.route}}" [1h]))

# Bytes por servicio
sum by (service) (rate({env="production"}[5m]))

# Top de errores por tipo
topk(10, sum by (error_type) (count_over_time({service="auth-api"} | json | level="error" [1h])))

# Latencia extraída del log
quantile_over_time(0.99,
  {service="auth-api"} | json | unwrap duration_ms [5m]
) by (route)
```

Structured metadata (Loki 2.9+) se filtra con la misma sintaxis:

```logql
{service="auth-api"} | user_id="12847"
{service="auth-api"} | trace_id="5b8aa5a2d2c872e8321cf37308d69df2"
```

### 5.2 KQL (Kibana Query Language) y Lucene

**KQL** (Kibana/OpenSearch, más simple):

```
service:auth-api and level:error
service:"auth-api" and duration_ms > 1000
NOT status:200
message:*timeout*
@timestamp >= "2026-08-13T00:00:00Z" and @timestamp <= "2026-08-13T23:59:59Z"
```

**Lucene** (más potente, compat):

```
service:auth\-api AND level:(error OR fatal) AND duration_ms:[1000 TO *]
message:/.*(timeout|deadline).*/
```

**OpenSearch PPL** (Piped Processing Language, similar a Splunk SPL):

```
source=logs-2026.08.13
| where service="auth-api" and level="error"
| stats count() by error_type
| sort -count()
| head 10
```

### 5.3 Cheat sheet cruzado

| Objetivo | LogQL | KQL |
|---|---|---|
| Filtrar campo exacto | `{service="api"}` | `service:api` |
| Excluir | `!= "healthcheck"` | `not message:healthcheck` |
| Regex | `|~ "timeout"` | `message:*timeout*` |
| Rango numérico | `| duration_ms > 1000` | `duration_ms > 1000` |
| Contar por dim | `sum by (X) (count_over_time({...}[5m]))` | agrupación en Kibana viz |
| p99 latencia | `quantile_over_time(0.99, ... unwrap ...)` | Kibana Lens con Percentile |

---

## 6. Correlación con métricas y traces (nivel senior)

### 6.1 Trace_id en logs

**Regla**: todo log emitido dentro de un span debe incluir `trace_id` y `span_id`. Con OpenTelemetry auto-instrumentation esto es automático; con Pino/slog se hace en el logger (ver §2.4).

```json
{
  "ts": "2026-08-13T21:34:12.483Z",
  "level": "error",
  "service": "auth-api",
  "msg": "database timeout",
  "duration_ms": 5017,
  "trace_id": "5b8aa5a2d2c872e8321cf37308d69df2",
  "span_id": "051581bf3cb55c13",
  "db.system": "postgresql",
  "db.statement": "SELECT * FROM users WHERE id=$1"
}
```

### 6.2 Derived fields en Grafana Loki

En la data source de Loki, definimos un `derivedField` que hace clicable el `trace_id`:

```json
"derivedFields": [
  {
    "name": "trace_id",
    "matcherRegex": "\"trace_id\":\"(\\w+)\"",
    "url": "$${__value.raw}",
    "datasourceUid": "tempo",
    "urlDisplayLabel": "View trace"
  }
]
```

### 6.3 Log-to-metrics con LogQL

Loki puede convertir logs en métricas en tiempo real, sin necesidad de Prometheus para casos ad-hoc:

```logql
# Rate de errores derivado de logs
sum by (service) (rate({env="production"} | json | level="error" [5m]))

# p99 latency derivado de logs
quantile_over_time(0.99, {service="auth-api"} | json | unwrap duration_ms [5m])
```

Y puedes crear **recording rules** en Loki (funcionalidad equivalente a Prometheus):

```yaml
# loki-rules/errors.yml
groups:
  - name: log-derived
    interval: 30s
    rules:
      - record: log_derived:errors:rate5m
        expr: sum by (service) (rate({env="production"} | json | level="error" [5m]))
      - alert: HighLogErrorRate
        expr: log_derived:errors:rate5m > 1
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Errores en {{ $labels.service }} > 1/s por 5min"
```

### 6.4 Exemplars bidireccionales

- **Métrica → trace**: exemplars en histogramas Prometheus (ver [cap 18 §7.1](./18-grafana-y-dashboards.md)).
- **Trace → log**: `tracesToLogsV2` en la data source de Tempo.
- **Log → trace**: `derivedFields` en Loki.
- **Log → metric**: LogQL con `count_over_time`, `rate`, `quantile_over_time`.

En 2026 el ideal es que un incidente se navegue así: recibes alerta (Grafana Alerting) → abres dashboard RED (Prometheus) → identificas ruta con p99 alto → click en exemplar → trace en Tempo → click en span con error → logs correlacionados en Loki → identificas la línea que causó el fallo. Todo en 3 minutos, sin cambiar de herramienta.

---

## 7. Sampling y rate limiting (nivel senior)

### 7.1 Por qué samplear

Un endpoint con 100K rps que loguea 3 líneas por request produce 300K logs/s = ~30 GB/hora asumiendo 30 bytes/log. En un incidente puede triplicarse. Sin sampling, saturas el pipeline y pierdes precisamente los logs importantes por back-pressure.

### 7.2 Sampling strategies

- **Probabilistic**: sampler(0.1) → 10% aleatorio. Simple, pierde detalle.
- **Deterministic hash-based**: hash(trace_id) mod 100 < 10 → 10% pero **consistente por trace** (o sampleás todos los logs del trace, o ninguno).
- **Level-biased**: sample debug al 1%, info al 10%, warn 100%, error 100%. Preserva señal, tira ruido.
- **Adaptive**: reduce sampling en spike (tail-based).
- **Head-based**: decides en el edge (Fluent Bit/Vector). Barato.
- **Tail-based**: decides en el backend tras ver el trace completo (OTel Collector con `tailsamplingprocessor`). Mejor calidad, más caro.

### 7.3 Sampling en Vector

Ya visto en §3.3: `[transforms.sample_debug]` con `exclude` para preservar niveles altos.

### 7.4 Sampling en el logger (head-based)

```javascript
// Pino con hooks — samplear info al 10%, warn/error al 100%
const originalWrite = pino.destination().write;
const sampled = pino({
  hooks: {
    logMethod(args, method, level) {
      // level >= 40 (warn) siempre; 30 (info) al 10%; debug 1%
      if (level >= 40) return method.apply(this, args);
      if (level === 30 && Math.random() < 0.1) return method.apply(this, args);
      if (level === 20 && Math.random() < 0.01) return method.apply(this, args);
    },
  },
});
```

### 7.5 Rate limiting en Loki

```yaml
# loki-config.yaml
limits_config:
  ingestion_rate_mb: 20            # bytes/s por tenant
  ingestion_burst_size_mb: 40      # burst permitido
  per_stream_rate_limit: 5MB       # por stream (combinación de labels)
  per_stream_rate_limit_burst: 20MB
  max_streams_per_user: 10000      # cardinality guard
  max_line_size: 256KB
  reject_old_samples: true
  reject_old_samples_max_age: 168h
```

Cuando un servicio se vuelve loco, Loki rechaza el exceso con `429`. El shipper aplica back-off + buffer local.

---

## 8. Alertas basadas en logs y postmortems (nivel senior → staff)

### 8.1 Alertas en Loki

```yaml
# loki-rules/critical.yml
groups:
  - name: critical-logs
    interval: 30s
    rules:
      - alert: PaymentGatewayFailure
        expr: |
          sum by (service) (
            count_over_time({service="payments"} |= "gateway_error" [5m])
          ) > 5
        for: 2m
        labels: { severity: critical, team: payments }
        annotations:
          summary: "Payment gateway failing"
          runbook: "https://wiki.example.com/runbooks/payment-gateway"

      - alert: PIILeakDetected
        expr: |
          sum(count_over_time({env="production"} |~ "\\b\\d{16}\\b" [5m])) > 0
        labels: { severity: critical, team: security }
        annotations:
          summary: "Posible tarjeta de crédito en logs"
```

### 8.2 SIEM básico

Para casos de seguridad, se combinan logs de: auth, WAF, IDS, K8s audit, cloud audit (CloudTrail, GCP Audit Logs). OpenSearch **Security Analytics** o **Elastic Security** son opciones nativas; Loki funciona con reglas custom.

Ejemplo detección brute-force:

```logql
sum by (ip) (
  count_over_time({service="auth"} |= "login_failed" [5m])
) > 20
```

### 8.3 Postmortems: los logs como evidencia

Todo postmortem serio incluye una **timeline reconstruida** con logs. Prácticas:
- Filtrar por `trace_id` del request que disparó el incidente.
- Ampliar temporalmente a 15 min antes/después.
- Exportar `logcli query` (Loki) o `esdump` (Elastic) a un gist/wiki.
- Enlazar dashboards, traces y logs por URL con time-range fijo.

`logcli` de Loki:

```bash
logcli query \
  --from="2026-08-13T21:30:00Z" \
  --to="2026-08-13T22:00:00Z" \
  --output=jsonl \
  '{service="auth-api", env="production"} | json | level=~"error|fatal"' \
  > postmortem-2026-08-13-auth.jsonl
```

---

## 9. Ejercicios verificables

### Ejercicio 1 — Structured logging en Node

Instrumenta una app Express con Pino: loguea cada request con `service`, `env`, `trace_id`, `method`, `route`, `status`, `duration_ms`. Redacta `password` y `authorization`.

**Check**: `curl -X POST -H 'Authorization: Bearer abc' http://localhost:8080/hello`; el log emitido en stdout debe contener `"authorization": "[REDACTED]"` y `"trace_id"` no vacío.

### Ejercicio 2 — Fluent Bit + Loki

Levanta Fluent Bit 3.2 y Loki 3.3 con el `docker-compose.yml` de §0. Configura Fluent Bit para leer stdout de los containers y enviar a Loki con labels `service`, `env`, `level`.

**Check**: en Grafana Explore → Loki, la query `{service="auth-api"}` devuelve los logs de la app en <30 s.

### Ejercicio 3 — LogQL para RED

Con los logs del ejercicio 2, escribe 3 queries LogQL:

1. RPS por servicio.
2. Error rate.
3. p99 latency extraído de `duration_ms`.

```logql
sum by (service) (rate({env="production"}[5m]))

sum by (service) (rate({env="production"} | json | level="error" [5m]))
  /
sum by (service) (rate({env="production"}[5m]))

quantile_over_time(0.99,
  {env="production"} | json | unwrap duration_ms [5m]
) by (service)
```

**Check**: las 3 queries devuelven resultados en Grafana Explore.

### Ejercicio 4 — Vector con VRL

Reemplaza Fluent Bit por Vector 0.45 con el `vector.toml` de §3.3. Añade una transformación VRL que enriquezca cada log con `geo_country` derivado del campo `ip` usando `parse_json` + una tabla estática mock. Verifica en Loki.

**Check**: los logs en Loki contienen el campo `geo_country`.

### Ejercicio 5 — Alerta LogQL

Crea una recording rule en Loki que exponga `log_derived:errors:rate5m` por servicio y una alerta `HighLogErrorRate` que dispare cuando el ratio supere 1/s por 5 min. Verifica con tráfico artificial (`app.get('/boom', ...)`).

**Check**: en Grafana Alerting, la regla aparece en `Firing` cuando se supera el umbral.

### Ejercicio 6 — Correlación logs ↔ trace

Añade `trace_id` a los logs con OTel SDK y configura `derivedFields` en la data source de Loki. En Grafana Explore, verifica que un click en `trace_id` de un log abre el trace en Tempo (aunque sea con testdata).

**Check**: en un log expandido, `trace_id` aparece como link `View trace`.

### Ejercicio 7 — Sampling adaptive

En Vector, añade un sampler que descarte el 90% de logs `debug` cuando el rate supere 1000/s, pero preserve todos los `warn`/`error`/`fatal`. Testea saturando la app.

**Check**: bajo carga, el volumen de logs `debug` en Loki es ~10% del emitido; `warn`/`error` = 100%.

### Ejercicio 8 — ILM en OpenSearch

Aplica la política ILM de §4.5 a un índice de logs en OpenSearch. Fuerza un rollover manual y verifica que el nuevo índice se crea con el mismo template.

**Check**: `curl http://localhost:9200/_cat/indices?v` muestra `logs-000001` y `logs-000002`, ambos con el mismo mapping.

---

## 10. Simulacro y referencias

**Simulacro**: 20 preguntas, 30 min, pass 75%.
- Path: [`packages/content/src/tech/devops/sim-19-logging-elk-loki.json`](../../packages/content/src/tech/devops/sim-19-logging-elk-loki.json)
- ID: `devops-sim-19-logging-elk-loki`
- Áreas: observability, logs, sre
- Dificultad: junior → mid → senior → staff

**Referencias canónicas**:
- [Grafana Loki 3.3 release notes (nov 2024)](https://grafana.com/blog/2024/11/21/grafana-loki-3.3-release-faster-query-results-via-blooms-for-structured-metadata/)
- [Loki 3.0 native OTLP support](https://grafana.com/blog/grafana-loki-3-0-release-all-the-new-features/)
- [Loki documentation](https://grafana.com/docs/loki/latest/)
- [Fluent Bit 3.2 docs](https://docs.fluentbit.io/manual/)
- [Vector 0.45 docs + VRL](https://vector.dev/docs/reference/vrl/)
- [OpenSearch documentation](https://opensearch.org/docs/latest/)
- [Elastic Filebeat reference](https://www.elastic.co/guide/en/beats/filebeat/current/index.html)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [Google SRE Workbook — Ch. 16 Overload](https://sre.google/workbook/managing-load/)
- [Fluent Bit vs Vector benchmark 2026](https://onidel.com/blog/log-shipping-benchmark-2025)

---

## Navegación

- Anterior: [Cap 18 — Grafana y dashboards](./18-grafana-y-dashboards.md)
- Siguiente: [Cap 20 — Distributed tracing →](./20-distributed-tracing.md)
