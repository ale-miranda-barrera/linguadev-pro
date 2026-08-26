# Capítulo 17 — Prometheus y métricas

> **Focus:** Arquitectura pull, TSDB, tipos de métricas, PromQL de básico a avanzado, recording/alerting rules, service discovery, native histograms, OTLP receiver y long-term storage (Mimir, Thanos, VictoriaMetrics).
> **Áreas:** Observabilidad · Métricas · SRE
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Docker/Docker Compose para levantar Prometheus local.
- Nociones de HTTP (`/metrics`, status codes, latencias).
- Fundamentos de Kubernetes ([cap 05 — orquestación](./07-fundamentos-kubernetes.md)) para service discovery, aunque no obligatorio.
- Familiaridad con YAML.
- Un lenguaje de instrumentación a elección: `prom-client` (Node), `client_golang` (Go), `prometheus_client` (Python), Micrometer (JVM).

**Glosario mínimo:**
- **TSDB** (Time-Series DataBase): base de datos optimizada para series temporales. Prometheus usa un TSDB local write-once en bloques de 2 h.
- **Time series**: combinación única `metric_name{label1=v1, label2=v2}` que produce un stream de `(timestamp, value)`.
- **Sample**: par `(timestamp, float64)` almacenado dentro de una serie.
- **Scrape**: HTTP GET periódico que Prometheus hace a un endpoint `/metrics` de un target.
- **Target**: proceso o exporter que expone métricas.
- **Exporter**: adaptador que traduce métricas de un sistema legacy (MySQL, Kafka, Linux) al formato Prometheus.
- **PromQL**: lenguaje de queries funcional-vectorial para consultar el TSDB.
- **Alertmanager**: componente separado que recibe alerts, agrupa, deduplica, rutea y silencia.
- **Recording rule**: query PromQL pre-calculada periódicamente y guardada como nueva serie.
- **Native histogram**: histograma exponencial de buckets dinámicos, estable desde Prometheus v3.8 (nov 2025).
- **Cardinality**: número total de series únicas en el TSDB. Alta cardinality = memoria consumida.
- **Federation**: modelo jerárquico donde un Prometheus global scrapea `/federate` de otros locales.

**Setup mínimo local:**

```bash
# 1. Levantar Prometheus 3.x + node_exporter + una app instrumentada
mkdir observability && cd observability
cat > docker-compose.yml <<'YAML'
services:
  prometheus:
    image: prom/prometheus:v3.13.0
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --web.enable-remote-write-receiver
      - --web.enable-otlp-receiver
      - --enable-feature=native-histograms
      - --storage.tsdb.retention.time=30d
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prom-data:/prometheus
    ports: ["9090:9090"]
  node-exporter:
    image: prom/node-exporter:v1.9.0
    ports: ["9100:9100"]
    pid: host
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - --path.procfs=/host/proc
      - --path.sysfs=/host/sys
      - --path.rootfs=/rootfs
  alertmanager:
    image: prom/alertmanager:v0.28.1
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
    ports: ["9093:9093"]
volumes: { prom-data: {} }
YAML

# 2. Config mínima
cat > prometheus.yml <<'YAML'
global:
  scrape_interval: 15s
  evaluation_interval: 15s
scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
  - job_name: node
    static_configs:
      - targets: ["node-exporter:9100"]
YAML

docker compose up -d
open http://localhost:9090
```

---

## 1. El gran cuadro

Prometheus nació en **SoundCloud (2012)** de la mano de Julius Volz y Matt Proud, dos ex-ingenieros de Google que se inspiraron en el sistema interno **Borgmon**. En 2016 fue el segundo proyecto de la CNCF en graduarse tras Kubernetes, y desde entonces es el **estándar de facto para métricas** en entornos cloud-native. Su filosofía se resume en tres decisiones que rompieron con StatsD/Graphite/InfluxDB: **modelo pull**, **modelo de datos multi-dimensional con labels**, y **lenguaje de query funcional** (PromQL). Estas tres decisiones explican tanto sus fortalezas (health check gratis, agregación flexible, exploración interactiva) como sus limitaciones (cardinality explosiva, no persistencia long-term nativa).

En 2026 el ecosistema alrededor de Prometheus incluye: **Alertmanager** (routing/dedup de alerts), **exporters** (~400+ oficiales y de terceros), **PushGateway** (para batch jobs efímeros), y una capa de **long-term storage** que puede ser **Grafana Mimir**, **Thanos**, **Cortex** o **VictoriaMetrics**. **Prometheus 3.0** (nov 2024) trajo cambios grandes: **UTF-8 en nombres de métricas y labels** por defecto, **OTLP receiver** nativo (opt-in) para ingesta de métricas OpenTelemetry, y una nueva UI. **Prometheus 3.8** (nov 2025) estabilizó las **native histograms**; **3.13** (jul 2026) añadió `smoothed rate` con anclaje y `__always_scrape_classic_histograms__` como label interna para overrides por target.

El modelo mental correcto es: Prometheus es un **sistema de métricas agregadas de baja/media cardinality** para responder preguntas del tipo "¿cuál es la tasa de errores por región y servicio ahora mismo?" y "¿hemos violado el SLO en las últimas 4 horas?". No es un sistema de eventos (para eso, logs — [cap 19](./19-logging-elk-loki.md)) ni un sistema de trazas individuales (para eso, tracing — [cap 20](./20-distributed-tracing.md)). Los tres pilares se complementan y en 2026 se enlazan mediante **exemplars** (link desde un bucket de histograma a una traza concreta) y **service graphs** derivados de spans.

El impacto operativo también es claro: un equipo que no domina PromQL escribe alertas frágiles (basadas en `irate` o ventanas mal dimensionadas) que causan pager fatigue; un equipo que no controla **cardinality** termina con Prometheus OOMkilled en el peor momento; y un equipo que no separa **recording rules** de queries de dashboard sufre dashboards de 30 s de carga que nadie usa. Este capítulo cubre los cinco bloques que garantizan que operes Prometheus sin sorpresas: arquitectura, tipos de métricas, PromQL, rules y escala.

---

## 2. Arquitectura pull, TSDB y modelo de datos (nivel básico)

### 2.1 Pull vs push: la decisión filosófica

Prometheus **no** recibe métricas: las **pide**. Cada `scrape_interval` (default 15 s) hace un `HTTP GET /metrics` a cada target definido en `scrape_configs`. Las ventajas son cuatro:

1. **Health check implícito**: si el scrape falla, la serie `up{job="api",instance="..."} == 0` te lo dice. No necesitas un heartbeat aparte.
2. **Service discovery centralizado**: Prometheus decide qué scrapear (K8s SD, Consul, EC2, file_sd). La app no sabe nada de monitoring.
3. **Debug trivial**: cualquier dev puede abrir `curl http://app:8080/metrics` en local y ver exactamente lo que verá Prometheus.
4. **Rate limiting gratis**: Prometheus controla la frecuencia. No hay "storm" cuando reinicias 500 pods.

El **PushGateway** existe para el caso patológico: batch jobs que corren < 15 s y mueren antes del próximo scrape. La regla: **usa pull siempre que puedas**; PushGateway solo para jobs efímeros o funciones serverless que no pueden ser scrapeadas.

### 2.2 El formato de exposición

El endpoint `/metrics` devuelve texto plano en formato **Prometheus text exposition** (u **OpenMetrics**, evolución estándar):

```text
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",status="200",route="/health"} 12847
http_requests_total{method="POST",status="201",route="/users"} 3421
http_requests_total{method="POST",status="500",route="/users"} 17

# HELP process_resident_memory_bytes Resident memory in bytes
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes 1.34217728e+08

# HELP http_request_duration_seconds Request latency
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.005"} 3421
http_request_duration_seconds_bucket{le="0.01"} 8942
http_request_duration_seconds_bucket{le="0.025"} 12034
http_request_duration_seconds_bucket{le="0.05"} 12500
http_request_duration_seconds_bucket{le="+Inf"} 12600
http_request_duration_seconds_sum 84.72
http_request_duration_seconds_count 12600
```

Cada línea representa **una muestra** en **una serie**. El `# HELP` es documentación; el `# TYPE` indica cómo interpretar la métrica.

### 2.3 TSDB: cómo se guarda

El TSDB de Prometheus escribe **bloques inmutables de 2 h** en disco (`/prometheus/data/`), más un **WAL** (Write-Ahead Log) en el `head` para la ventana actual. Estructura de un bloque:

```text
01FZQ8V3D5.../
  chunks/       # samples comprimidos (Gorilla encoding, ~1.3 bytes/sample)
  index         # B-tree de labels → chunks
  meta.json     # min/max time, sources
  tombstones    # marcas de deletion
```

**Compaction** consolida bloques de 2 h en bloques más grandes (6 h, 24 h, 48 h) hasta `--storage.tsdb.retention.time` (default 15 d). Cada `Sample` ocupa ~1-3 bytes; el índice de labels ocupa ~1-3 KB por serie única — de ahí la importancia crítica de la cardinality.

### 2.4 OTLP receiver: el puente con OpenTelemetry

Desde Prometheus 3.0 (nov 2024) puedes activar un receiver OTLP nativo en `/api/v1/otlp/v1/metrics`:

```yaml
# prometheus.yml
otlp:
  translation_strategy: NoUTF8EscapingWithSuffixes
storage:
  tsdb:
    out_of_order_time_window: 10m   # OTLP puede llegar tarde
```

Y arrancas con:

```bash
prometheus --web.enable-otlp-receiver --config.file=prometheus.yml
```

El collector OTel puede exportar directamente a Prometheus:

```yaml
# otel-collector.yaml
exporters:
  otlphttp/prom:
    endpoint: http://prometheus:9090/api/v1/otlp
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [otlphttp/prom]
```

Este puente hace que la vieja "guerra" Prometheus vs OpenTelemetry sea, en 2026, obsoleta: ambos ecosistemas interoperan bidireccionalmente (OTLP push a Prometheus; `prometheus_receiver` en el Collector para scrape).

---

## 3. Tipos de métricas (nivel básico → medio)

Prometheus define **cuatro tipos** en el modelo original y **native histograms** como el quinto tipo estable desde v3.8.

### 3.1 Counter

Monotónico creciente. Resetea a 0 en restart. **Convención**: sufijo `_total`.

```javascript
// Node.js con prom-client
import { Counter } from 'prom-client';

const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
});

app.use((req, res, next) => {
  res.on('finish', () => {
    httpRequests.inc({
      method: req.method,
      route: req.route?.path ?? 'unknown',
      status: res.statusCode.toString(),
    });
  });
  next();
});
```

**Regla clave**: **expón el total, no el rate**. Prometheus calcula el rate con `rate()`. Si expones el rate pre-calculado, pierdes la habilidad de re-agregar en ventanas distintas.

### 3.2 Gauge

Sube y baja libremente. Ejemplos: temperatura, memoria en uso, longitud de cola, número de conexiones abiertas.

```javascript
import { Gauge } from 'prom-client';

const queueDepth = new Gauge({
  name: 'jobs_queue_depth',
  help: 'Pending jobs in the queue',
  labelNames: ['queue'],
});

setInterval(async () => {
  const n = await redis.llen('jobs:default');
  queueDepth.set({ queue: 'default' }, n);
}, 5000);
```

Funciones aplicables: `delta()`, `deriv()`, `predict_linear()`. **Nunca** apliques `rate()` a un gauge (undefined behavior).

### 3.3 Histogram (clásico)

Distribuciones (latencias, tamaños). Expone **buckets acumulativos** (`_bucket{le=...}`), `_sum` y `_count`.

```javascript
import { Histogram } from 'prom-client';

const httpLatency = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route'],
  // Buckets diseñados para SLO p99 < 200ms
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2, 5],
});

app.use((req, res, next) => {
  const end = httpLatency.startTimer({ method: req.method, route: req.route?.path ?? 'unknown' });
  res.on('finish', end);
  next();
});
```

**Query de percentil**:

```promql
histogram_quantile(
  0.99,
  sum by (le, route) (rate(http_request_duration_seconds_bucket[5m]))
)
```

Los buckets **deben cubrir tu SLO**: si tu SLO es p99 < 200 ms, necesitas buckets alrededor de 200 ms (0.1, 0.15, 0.2, 0.3). Los defaults de las libs suelen ser malos para APIs web.

### 3.4 Summary

Calcula quantiles **client-side** (streaming quantiles con algoritmo de Cormode-Korn). Expone `metric{quantile="0.99"}` directo.

**Anti-patrón en microservicios**: no puedes agregar summaries entre instancias. Un `p99 = 100 ms` en la instancia A y `p99 = 500 ms` en la B **no** dan `p99 = 300 ms` en agregado. Usa Histogram siempre que necesites agregar.

### 3.5 Native histograms (estable en v3.8, nov 2025)

Buckets **exponenciales dinámicos** en vez de estáticos. Cada scrape envía la distribución completa comprimida. Ventajas:

- **Cardinality drástica menor**: 1 serie por métrica+labels (vs N series por bucket).
- **Precisión adaptativa**: `schema=8` da ~0.3% de error relativo en cualquier rango.
- **Mismas funciones**: `histogram_quantile()`, `rate()` funcionan.

```javascript
// prom-client 15+ con native histograms
const httpLatency = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Latency',
  labelNames: ['method', 'route'],
  enableExemplars: true,
  buckets: [], // vacío = native histogram
  nativeHistogramBucketFactor: 1.1,       // ~10% de error
  nativeHistogramMaxBucketNumber: 100,
});
```

Requiere activar el opt-in en Prometheus:

```yaml
scrape_configs:
  - job_name: api
    scrape_native_histograms: true   # v3.9+
    static_configs:
      - targets: ["api:8080"]
```

Puedes exponer **ambos** (classic + native) durante migraciones con `__always_scrape_classic_histograms__` (v3.13, jul 2026).

---

## 4. PromQL de básico a avanzado (nivel medio → senior)

### 4.1 Selectores y matchers

```promql
# Serie exacta
http_requests_total{job="api",method="GET"}

# Regex (=~) y regex negado (!~)
http_requests_total{route=~"/api/.*",status!~"2.."}

# Ventana de tiempo (range vector) — necesaria para rate/increase
http_requests_total{job="api"}[5m]

# Offset (mover N tiempo atrás)
http_requests_total offset 1w                  # una semana atrás
rate(http_requests_total[5m] offset 1h)        # rate hace 1h

# @ modifier — evaluar en timestamp fijo (útil para queries deterministas)
http_requests_total @ 1735689600
```

### 4.2 Rate, irate, increase

```promql
# rate: per-second promediado en la ventana. USO: alerts y dashboards estables.
rate(http_requests_total[5m])

# irate: últimos 2 samples. USO: gráficas volátiles de debug. NUNCA para alerts.
irate(http_requests_total[5m])

# increase: total en la ventana = rate * window_seconds. USO: totales humanos.
increase(http_requests_total[1h])
```

**Regla**: `window >= 4 * scrape_interval`. Con scrape de 15 s, `rate(x[1m])` solo tiene 4 samples (frágil); usa `[5m]` mínimo para alertas.

### 4.3 Agregación: by / without

```promql
# Suma por status code — colapsa el resto
sum by (status) (rate(http_requests_total[5m]))

# Suma por todo excepto instance — dropea la dimensión instance
sum without (instance) (rate(http_requests_total[5m]))

# Top 10 rutas por rate
topk(10, sum by (route) (rate(http_requests_total[5m])))

# Bottom 5, cuantile 0.9 sobre valores, count no-cero
bottomk(5, sum by (route) (rate(http_requests_total[5m])))
quantile(0.9, sum by (instance) (rate(http_requests_total[5m])))
count(rate(http_requests_total[5m]) > 0)
```

### 4.4 histogram_quantile y buckets

```promql
# p99 de latencia por ruta
histogram_quantile(
  0.99,
  sum by (le, route) (rate(http_request_duration_seconds_bucket[5m]))
)

# Ratio de error (SLI RED)
sum(rate(http_requests_total{status=~"5.."}[5m]))
  /
sum(rate(http_requests_total[5m]))
```

**Trampa**: si olvidas incluir `le` en el `by`, `histogram_quantile` devuelve `NaN`.

### 4.5 Vector matching y binary operators

```promql
# Ratio con join implícito sobre labels compartidos
sum by (service) (rate(http_errors_total[5m]))
  /
sum by (service) (rate(http_requests_total[5m]))

# on() ignoring() para joins explícitos
rate(http_requests_total[5m])
  * on(instance) group_left(version) app_info

# Aritmética con scalars
sum(rate(http_requests_total[5m])) * 60   # RPS -> RPM
```

### 4.6 Subqueries y funciones avanzadas

```promql
# Subquery — calcula rate cada 1min y toma el max en la última hora
max_over_time(
  rate(http_requests_total[5m])[1h:1m]
)

# Predicción de disco lleno en 4 horas
predict_linear(node_filesystem_avail_bytes{mountpoint="/"}[6h], 4*3600) < 0

# Absent — detectar métricas que dejaron de reportarse (kill switch)
absent(up{job="critical-service"} == 1)

# clamp_min / clamp_max
clamp_max(rate(http_requests_total[5m]), 1000)

# smoothed rate (Prometheus 3.13, jul 2026) — rate anclado, suaviza jitter
smoothed_rate(http_requests_total[5m])
```

---

## 5. Recording rules y alerting rules (nivel medio)

### 5.1 Recording rules: pre-cálculo

Cuando un dashboard con 10 paneles tarda 30 s en cargar porque cada query hace `sum by (le) (rate(...[5m]))` sobre millones de series, la solución es **pre-calcular** en background:

```yaml
# rules/http.yml
groups:
  - name: http_recording
    interval: 30s
    rules:
      - record: job:http_requests:rate5m
        expr: sum by (job, route, status) (rate(http_requests_total[5m]))

      - record: job:http_errors:rate5m
        expr: sum by (job, route) (rate(http_requests_total{status=~"5.."}[5m]))

      - record: job:http_requests:ratio_errors_5m
        expr: |
          job:http_errors:rate5m
            /
          sum by (job, route) (rate(http_requests_total[5m]))

      - record: job:http_latency_p99:5m
        expr: |
          histogram_quantile(
            0.99,
            sum by (le, job, route) (rate(http_request_duration_seconds_bucket[5m]))
          )
```

**Convención de nombres**: `level:metric:operation`. Ej.: `job:http_requests:rate5m` significa "métrica `http_requests` agregada a nivel `job` con operación `rate` en ventana 5m".

### 5.2 Alerting rules: condiciones evaluadas

```yaml
# rules/alerts.yml
groups:
  - name: http_alerts
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: job:http_requests:ratio_errors_5m > 0.05
        for: 5m       # debe ser cierto 5min antes de firear (previene flap)
        labels:
          severity: critical
          team: backend
        annotations:
          summary: "Error rate en {{ $labels.job }}/{{ $labels.route }} > 5%"
          description: |
            Ratio actual: {{ $value | humanizePercentage }}
            Runbook: https://wiki.example.com/runbooks/high-error-rate
          dashboard: https://grafana.example.com/d/http-overview

      - alert: SLOBurnFast
        # Multi-window multi-burn-rate (Google SRE Book)
        expr: |
          (
            job:http_requests:ratio_errors_5m > (14.4 * 0.001)
            and
            job:http_requests:ratio_errors:rate1h > (14.4 * 0.001)
          )
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "Consumiendo error budget 14.4x más rápido"

      - alert: ServiceDown
        expr: up{job=~"api|worker"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.instance }} caído"
```

Las alerting rules **reutilizan recording rules** — evaluación rápida y consistencia entre alerta y dashboard.

### 5.3 Alertmanager: routing y silencing

Prometheus solo evalúa la condición y **notifica al Alertmanager**, que hace routing, grouping, inhibition y silence:

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m
  slack_api_url: 'https://hooks.slack.com/services/T00/B00/XXX'

route:
  group_by: ['alertname', 'cluster']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: default-slack
  routes:
    - match: { severity: critical }
      receiver: pagerduty
      continue: true
    - match: { team: db }
      receiver: db-slack

receivers:
  - name: default-slack
    slack_configs:
      - channel: '#alerts'
        title: '{{ .GroupLabels.alertname }} — {{ .Status }}'
        text: |
          {{ range .Alerts }}
          *{{ .Labels.severity }}* — {{ .Annotations.summary }}
          {{ .Annotations.description }}
          {{ end }}
  - name: pagerduty
    pagerduty_configs:
      - service_key: 'YOUR_INTEGRATION_KEY'
  - name: db-slack
    slack_configs:
      - channel: '#db-oncall'

inhibit_rules:
  - source_matchers: [ 'alertname="ClusterDown"' ]
    target_matchers: [ 'severity=~"warning|critical"' ]
    equal: ['cluster']
```

**Grouping** convierte 50 pages en 1 email con la lista consolidada. **Inhibition** silencia derivadas cuando la causa raíz dispara. **Silence** vía UI/API para mantenimiento planificado (`amtool silence add alertname=HighLatency --duration=2h`).

---

## 6. Service discovery y federation (nivel medio → senior)

### 6.1 Kubernetes SD

Prometheus descubre pods, services, endpoints, nodes e ingresses vía la API de Kubernetes:

```yaml
scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      # Solo scrapea pods con annotation prometheus.io/scrape=true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"
      # Sobrescribe el path si la annotation lo define
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      # Sobrescribe el puerto
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
        target_label: __address__
      # Copia labels K8s como namespace, pod, node
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
```

### 6.2 EC2, Consul, DNS, file_sd

```yaml
scrape_configs:
  - job_name: ec2-nodes
    ec2_sd_configs:
      - region: us-east-1
        port: 9100
    relabel_configs:
      - source_labels: [__meta_ec2_tag_Environment]
        action: keep
        regex: production
      - source_labels: [__meta_ec2_tag_Name]
        target_label: instance

  - job_name: consul-services
    consul_sd_configs:
      - server: 'consul:8500'
    relabel_configs:
      - source_labels: [__meta_consul_service]
        target_label: service

  - job_name: file-sd
    file_sd_configs:
      - files: ['/etc/prometheus/targets/*.json']
        refresh_interval: 30s
```

### 6.3 Federation

Un Prometheus "global" scrapea `/federate` de Prometheus locales, trayendo **solo** métricas ya agregadas (nunca datos raw):

```yaml
scrape_configs:
  - job_name: federate-clusters
    scrape_interval: 30s
    honor_labels: true      # preserva labels originales (crítico)
    metrics_path: /federate
    params:
      'match[]':
        - '{__name__=~"job:.+"}'          # solo recording rules
        - 'up{job=~"api|worker"}'
    static_configs:
      - targets:
          - prom-us-east.example.com:9090
          - prom-eu-west.example.com:9090
          - prom-ap-south.example.com:9090
```

**Anti-patrón**: `match[]={job="api"}` trae todas las series raw de `api` — no escala. Para query cross-cluster de datos raw, usa Thanos, Mimir o VictoriaMetrics (§8).

---

## 7. Exporters y cardinality (nivel medio → senior)

### 7.1 Exporters oficiales imprescindibles

| Exporter | Métricas | Uso típico |
|---|---|---|
| `node_exporter` | CPU, mem, disk, network, filesystem | Hosts Linux (USE method) |
| `windows_exporter` | Equivalente para Windows | Fleet mixto |
| `blackbox_exporter` | HTTP/DNS/TCP/ICMP probes | Uptime externo, SSL expiry |
| `mysqld_exporter` | Métricas MySQL/MariaDB | DBs relacionales |
| `postgres_exporter` | Bloat, locks, replication lag | PostgreSQL |
| `redis_exporter` | Memoria, keyspace, replicación | Redis/Valkey |
| `kafka_exporter` | Lag por consumer group | Kafka clusters |
| `cAdvisor` | Métricas de containers | Kubernetes |
| `kube-state-metrics` | Estado del cluster K8s | Health de deployments |

Blackbox ejemplo:

```yaml
# blackbox.yml
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      valid_status_codes: [200, 201, 204]
      fail_if_ssl: false
      fail_if_not_ssl: true
      preferred_ip_protocol: ip4
```

```yaml
# prometheus.yml — usar el blackbox como target
- job_name: blackbox
  metrics_path: /probe
  params: { module: [http_2xx] }
  static_configs:
    - targets:
        - https://api.linguadev.app/health
        - https://linguadev.app/
  relabel_configs:
    - source_labels: [__address__]
      target_label: __param_target
    - source_labels: [__param_target]
      target_label: instance
    - target_label: __address__
      replacement: blackbox-exporter:9115
```

### 7.2 Cardinality: el enemigo #1

Cada combinación única de labels crea una serie. Con `user_id` en 500 K usuarios × 5 métodos × 20 status = **50 M series**. Prometheus consume ~1-3 KB de RAM por serie en el índice — 50 M × 2 KB = **100 GB de RAM**. OOM.

**Reglas duras**:

- ✅ Labels aceptables: `status`, `method`, `region`, `env`, `version`, `route` (si es pattern `/users/:id`, no `/users/123`).
- ❌ Labels prohibidos: `user_id`, `session_id`, `request_id`, `email`, `ip`, `full_url_con_querystring`, `timestamp`, `uuid`.

**Detección**:

```promql
# Top 20 métricas por número de series
topk(20, count by (__name__) ({__name__=~".+"}))

# Series totales en el head
prometheus_tsdb_head_series

# Series creadas por segundo
rate(prometheus_tsdb_head_series_created_total[5m])
```

**Herramientas**:

```bash
# Análisis del último bloque
promtool tsdb analyze /prometheus/data/

# Ejemplo output relevante:
# Highest cardinality labels:
#   1234567 __name__
#   987654  user_id      <-- SOSPECHOSO
#   234    route
```

**Mitigación**: dropear labels via `metric_relabel_configs`:

```yaml
scrape_configs:
  - job_name: legacy-app
    static_configs: [{ targets: ['legacy:8080'] }]
    metric_relabel_configs:
      # Dropear el label user_id de una métrica ya explotada
      - source_labels: [__name__]
        regex: 'http_requests_total'
        action: labeldrop
        target_label: user_id
      # Dropear métricas completas que no usamos
      - source_labels: [__name__]
        regex: 'go_gc_duration_seconds.*'
        action: drop
```

---

## 8. Long-term storage: Mimir, Thanos, VictoriaMetrics (nivel senior → staff)

Prometheus TSDB local está diseñado para **retención corta** (15-60 d práctico). Para SLO reports anuales, trend analysis o compliance, necesitas storage en object storage (S3, GCS, Azure Blob).

### 8.1 Comparativa 2026

| Sistema | Modelo | Multi-tenant | Escala probada | Notas |
|---|---|---|---|---|
| **Grafana Mimir** | remote_write ingest, blocks en S3, microservicios | ✅ nativo | 1 B+ series | Fork de Cortex (Grafana Labs 2022). Best para SaaS |
| **Thanos** | Sidecar sube blocks a S3, Querier hace fan-out | Parcial | 100 M+ | Menos overhead operativo. Ideal para Prometheus existentes |
| **Cortex** | Similar a Mimir (original) | ✅ | 100 M+ | Mantenimiento reducido tras el fork |
| **VictoriaMetrics** | Ingest propio (vminsert), TSDB propio | ✅ (VictoriaMetrics Cluster) | 1 B+ | Más eficiente en CPU/RAM. Compat PromQL parcial |

### 8.2 Ejemplo: Prometheus → Mimir con remote_write

```yaml
# prometheus.yml
remote_write:
  - url: https://mimir.example.com/api/v1/push
    basic_auth:
      username: tenant-1
      password_file: /etc/prometheus/mimir-token
    queue_config:
      capacity: 10000
      max_shards: 200
      min_shards: 1
      max_samples_per_send: 2000
    metadata_config:
      send: true
      send_interval: 1m
    write_relabel_configs:
      # Solo enviar recording rules al long-term
      - source_labels: [__name__]
        regex: 'job:.+|node_.+|up'
        action: keep
```

### 8.3 Ejemplo: Thanos sidecar

```yaml
# k8s deployment de Prometheus con sidecar Thanos
containers:
  - name: prometheus
    image: prom/prometheus:v3.13.0
    args:
      - --storage.tsdb.retention.time=6h    # solo local corto
      - --storage.tsdb.min-block-duration=2h
      - --storage.tsdb.max-block-duration=2h  # obligatorio para Thanos
  - name: thanos-sidecar
    image: thanosio/thanos:v0.38.0
    args:
      - sidecar
      - --tsdb.path=/prometheus
      - --prometheus.url=http://localhost:9090
      - --objstore.config-file=/etc/thanos/objstore.yml
    volumeMounts:
      - name: tsdb
        mountPath: /prometheus
      - name: thanos-config
        mountPath: /etc/thanos
```

```yaml
# objstore.yml
type: S3
config:
  bucket: prometheus-lts
  endpoint: s3.us-east-1.amazonaws.com
  region: us-east-1
  aws_sdk_auth: true
```

### 8.4 HA de Prometheus

**Simple pattern**: correr **2 Prometheus idénticos** scrapeando los mismos targets. En Grafana, usar una data source con failover. Thanos Querier dedupe automáticamente con `--query.replica-label=replica`.

---

## 9. Ejercicios verificables

Todos los ejercicios asumen el `docker-compose.yml` de §0. Cada uno debe pasar el check indicado.

### Ejercicio 1 — Instrumenta una API Node.js

Crea una app Express que exponga `/metrics` con: counter `http_requests_total`, histogram `http_request_duration_seconds` (buckets adecuados para SLO p99 < 300 ms), gauge `nodejs_active_handles`.

```javascript
// app.mjs
import express from 'express';
import { register, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

collectDefaultMetrics({ prefix: 'lingua_' });

const httpRequests = new Counter({
  name: 'http_requests_total', help: 'Total requests',
  labelNames: ['method', 'route', 'status'],
});
const httpLatency = new Histogram({
  name: 'http_request_duration_seconds', help: 'Latency',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2],
});
const activeHandles = new Gauge({
  name: 'nodejs_active_handles', help: 'Active handles',
});

const app = express();
app.use((req, res, next) => {
  const end = httpLatency.startTimer({ method: req.method, route: req.path });
  res.on('finish', () => {
    end({ method: req.method, route: req.path });
    httpRequests.inc({ method: req.method, route: req.path, status: res.statusCode });
  });
  next();
});
app.get('/hello', (_, res) => res.json({ ok: true }));
app.get('/slow', async (_, res) => { await new Promise(r => setTimeout(r, 400)); res.json({}); });
app.get('/metrics', async (_, res) => {
  activeHandles.set(process._getActiveHandles().length);
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
app.listen(8080);
```

**Check**: `curl http://localhost:8080/metrics | grep http_requests_total` devuelve el counter con labels. Genera tráfico con `for i in {1..50}; do curl http://localhost:8080/hello; done` y verifica que el counter crece.

### Ejercicio 2 — PromQL: SLI RED

Con la app del ejercicio 1 scrapeada, escribe queries para:

1. **Rate**: requests por segundo por ruta.
2. **Errors**: ratio de 5xx.
3. **Duration**: p95 y p99 por ruta.

```promql
# 1. Rate
sum by (route) (rate(http_requests_total[5m]))

# 2. Errors
sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))
  /
sum by (route) (rate(http_requests_total[5m]))

# 3. Duration
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
```

**Check**: las queries devuelven valores en el explorer de Prometheus (`localhost:9090/graph`).

### Ejercicio 3 — Recording rules

Convierte las 3 queries del ejercicio 2 en recording rules con nomenclatura `route:http_*:*`. Aplica en `rules/red.yml` y verifica con `promtool check rules rules/red.yml`.

```yaml
groups:
  - name: red-http
    interval: 30s
    rules:
      - record: route:http_requests:rate5m
        expr: sum by (route) (rate(http_requests_total[5m]))
      - record: route:http_errors:rate5m
        expr: sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))
      - record: route:http_error_ratio:5m
        expr: route:http_errors:rate5m / route:http_requests:rate5m
      - record: route:http_latency_p95:5m
        expr: histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
      - record: route:http_latency_p99:5m
        expr: histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
```

**Check**: `promtool check rules rules/red.yml` responde `SUCCESS`. Tras `curl -X POST http://localhost:9090/-/reload`, las nuevas series `route:http_*` aparecen en el explorer.

### Ejercicio 4 — Alerta multi-window burn-rate

Implementa una alerta que dispare cuando el error budget de un SLO 99.9% se consume 14.4× más rápido en 1 h **y** en 5 min simultáneamente.

```yaml
groups:
  - name: slo-alerts
    rules:
      - alert: SLOBurnFast
        expr: |
          (
            route:http_error_ratio:5m > 0.0144
            and
            route:http_error_ratio:1h > 0.0144
          )
        for: 2m
        labels: { severity: page }
        annotations:
          summary: "Burn rate 14.4x en {{ $labels.route }}"
```

**Check**: fuerza errores con una ruta que devuelva 500 (`app.get('/boom', (_,r) => r.status(500).end())`) y observa que la alerta pasa a `firing` en `localhost:9090/alerts`.

### Ejercicio 5 — Detección de cardinality

Añade una métrica maliciosa `bad_metric_total{user_id=<n>}` con 10.000 valores y observa el impacto en `prometheus_tsdb_head_series`. Escribe la query que detecta el problema y una relabel rule que lo mitiga.

```promql
# Detección
topk(5, count by (__name__) ({__name__=~".+"}))
```

```yaml
# Mitigación
metric_relabel_configs:
  - source_labels: [__name__]
    regex: 'bad_metric_total'
    action: drop
```

**Check**: tras el reload, la métrica desaparece y `prometheus_tsdb_head_series` cae.

### Ejercicio 6 — Native histogram

Migra `http_request_duration_seconds` a native histogram (`buckets: []`, `nativeHistogramBucketFactor: 1.1`) y compara la cardinality en `count by (__name__) ({__name__="http_request_duration_seconds"})` antes y después.

**Check**: series bajan drásticamente (de N por bucket a 1 por métrica+labels). `histogram_quantile(0.99, rate(http_request_duration_seconds[5m]))` sigue funcionando.

---

## 10. Simulacro y referencias

**Simulacro**: 20 preguntas, 30 min, pass 75%.
- Path: [`packages/content/src/tech/devops/sim-17-prometheus-and-metrics.json`](../../packages/content/src/tech/devops/sim-17-prometheus-and-metrics.json)
- ID: `devops-sim-17-prometheus-and-metrics`
- Áreas: monitoring
- Dificultad mixta: junior → mid → senior → staff

**Referencias canónicas**:
- [prometheus.io — Documentation](https://prometheus.io/docs/introduction/overview/)
- [prometheus.io — Best practices instrumentation](https://prometheus.io/docs/practices/instrumentation/)
- [Announcing Prometheus 3.0 (nov 2024)](https://prometheus.io/blog/2024/11/14/prometheus-3-0/)
- [Prometheus 3.13 release (jul 2026)](https://github.com/prometheus/prometheus/releases/tag/v3.13.0)
- [Native Histograms specification](https://prometheus.io/docs/specs/native_histograms/)
- [Robust Perception blog — Brian Brazil](https://www.robustperception.io/blog)
- [Grafana Labs — Cardinality is King](https://grafana.com/blog/2022/02/15/what-are-cardinality-spikes-and-why-do-they-matter/)
- [Google SRE Book — Ch. 4 Alerting philosophy](https://sre.google/sre-book/monitoring-distributed-systems/)
- [thanos.io](https://thanos.io/) · [grafana.com/oss/mimir](https://grafana.com/oss/mimir/) · [victoriametrics.com](https://victoriametrics.com/)

---

## Navegación

- Anterior: [Cap 16 — Pulumi, CDK y IaC moderna](./16-pulumi-cdk-y-iac-moderna.md)
- Siguiente: [Cap 18 — Grafana y dashboards →](./18-grafana-y-dashboards.md)
