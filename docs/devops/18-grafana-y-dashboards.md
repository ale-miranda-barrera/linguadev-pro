# Capítulo 18 — Grafana y dashboards

> **Focus:** Diseño de dashboards útiles, variables/templates, transformaciones, data sources (Prometheus, Loki, Tempo, PostgreSQL, Elasticsearch), unified alerting v12, dashboard-as-code (Grafonnet, JSON), OnCall, hygiene y anti-patrones.
> **Áreas:** Observabilidad · Visualización · Incidentes
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Prometheus funcionando ([cap 17](./17-prometheus-y-metrics.md)) y una app instrumentada.
- Docker / Docker Compose para levantar Grafana local.
- Conocimiento básico de SQL (para explotar PostgreSQL como data source).
- Nociones de LogQL (se cubre en [cap 19](./19-logging-elk-loki.md)) y TraceQL ([cap 20](./20-distributed-tracing.md)) — no obligatorio para este capítulo pero útil.

**Glosario mínimo:**
- **Data source**: conector a un backend (Prometheus, Loki, Tempo, PostgreSQL, Elasticsearch, Datadog, CloudWatch...).
- **Panel**: unidad visual (time series, stat, gauge, bar chart, heatmap, table, logs, traces, node graph).
- **Row**: agrupación colapsable de paneles.
- **Variable**: placeholder `$var` que puebla dropdowns y se sustituye en queries.
- **Transformation**: operación cliente-side sobre el resultado de la query (join, calc, group by, rename).
- **Threshold**: color/línea que segmenta valores (bueno/warning/crítico).
- **Annotation**: marcador vertical en gráficas (deploys, incidentes).
- **Unified Alerting**: sistema unificado de alertas desde Grafana 9, cubre Prometheus + Loki + otras data sources.
- **Dashboard-as-code**: dashboards definidos en JSON/Grafonnet/Jsonnet en git en vez de UI-only.
- **Grafana OnCall**: producto de OSS para on-call scheduling + escalation policies (alternativa a PagerDuty).
- **RED / USE / Four Golden Signals**: métricas canónicas por servicio, recurso y latencia+tráfico+errores+saturación.

**Setup mínimo:**

```yaml
# docker-compose.yml (añade al de cap 17)
services:
  grafana:
    image: grafana/grafana:12.1.0
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_FEATURE_TOGGLES_ENABLE: dashgpt,dashboardScene
      GF_UNIFIED_ALERTING_ENABLED: "true"
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      - ./grafana/dashboards:/etc/grafana/dashboards:ro
    ports: ["3000:3000"]
volumes: { grafana-data: {} }
```

```yaml
# grafana/provisioning/datasources/all.yml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    jsonData:
      timeInterval: 15s
      httpMethod: POST
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    jsonData:
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: 'trace_id=(\w+)'
          name: TraceID
          url: '$${__value.raw}'
  - name: Tempo
    type: tempo
    uid: tempo
    access: proxy
    url: http://tempo:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
      tracesToMetrics:
        datasourceUid: Prometheus
      serviceMap:
        datasourceUid: Prometheus
      nodeGraph:
        enabled: true
```

```bash
docker compose up -d grafana
open http://localhost:3000    # admin / admin
```

---

## 1. El gran cuadro

Grafana nació en 2014 como **fork de Kibana 3** por Torkel Ödegaard para visualizar métricas de Graphite. Doce años después es la **capa de visualización universal de la observabilidad**: 150+ data sources oficiales, un ecosistema propio (Loki para logs, Tempo para traces, Pyroscope para profiling, Mimir para métricas long-term, Beyla para eBPF auto-instrumentation, OnCall para incident management), y una comunidad enorme de dashboards compartidos. Grafana Labs monetiza vía **Grafana Cloud** y **Grafana Enterprise**, pero la versión **OSS (AGPLv3)** cubre el 90% de necesidades y es lo que este capítulo asume.

En 2026 el estándar es **Grafana 12** (mayo 2025), con tres cambios grandes: **Dynamic Dashboards** (nueva Scene-based architecture que permite dashboards que cambian layout según variables), **Observability as Code** (git-native workflows, importación bidireccional entre UI y JSON/Jsonnet), y **Unified Alerting** completamente redesignado. **Grafana 12.1** (jul 2025) añadió paginación en la Alert Rule list e importación de reglas Mimir/Loki nativa; **actualizaciones de dic 2025** rediseñaron por completo la Alert Rule Page con vista Grouped y List. La versión que usaremos en los ejemplos es **12.1.0** o superior.

Un dashboard **útil** no es un dashboard **bonito**. Un dashboard útil responde una pregunta clara: "¿el servicio X está sano?" (RED/USE), "¿hay algo raro comparado con la semana pasada?" (comparativo), "¿qué está causando la degradación actual?" (drilldown). Un dashboard **inútil** tiene 40 paneles con nombres genéricos, tarda 20 s en cargar, y nadie lo abre en un incidente porque no sabe qué mirar. Este capítulo se centra en construir los **primeros**: RED por servicio, USE por host, overview global con drilldown, y un dashboard-as-code que vive en git.

El impacto operativo es tangible: cada minuto de MTTR (mean time to recover) tiene un coste en dinero y en confianza. Un dashboard bien diseñado reduce el MTTR en incidentes conocidos de horas a minutos. Un mal dashboard hace que el on-call abra Kibana, Datadog y AWS Console en paralelo, mientras el problema se agrava.

---

## 2. Data sources y modelo mental (nivel básico)

### 2.1 Los data sources que importan en 2026

| Data source | Tipo | Use case |
|---|---|---|
| **Prometheus** | Métricas time-series | Métricas de infra + app (RED, USE) |
| **Loki** | Logs indexados por labels | Logs, correlación con traces via exemplars |
| **Tempo** | Distributed traces | Traces, service graph, RED derivadas |
| **Mimir** | Prometheus-compatible LTS | Long-term storage de métricas |
| **Elasticsearch / OpenSearch** | Logs full-text search | Búsqueda ad-hoc en logs pesados |
| **PostgreSQL / MySQL** | Relacional | Métricas de negocio, dashboards de producto |
| **CloudWatch** | AWS nativo | Servicios AWS (Lambda, RDS, ALB) |
| **Datadog / New Relic** | SaaS APM | Migraciones o entornos mixtos |
| **Pyroscope** | Continuous profiling | Flame graphs on-demand |
| **Testdata** | Mocks | Prototipos y demos |

### 2.2 Query editors y unificación

Cada data source expone su editor de queries: **PromQL** (Prometheus/Mimir), **LogQL** (Loki), **TraceQL** (Tempo), **SQL** (PostgreSQL, MySQL, ClickHouse), **Lucene/KQL** (Elasticsearch/OpenSearch). Un mismo panel puede combinar N queries y usar **Transformations** para join/merge/rename cliente-side. Un panel con 2 queries A (Prometheus) y B (Loki) permite superponer métricas y volumen de logs en el mismo tiempo.

### 2.3 Provisioning: data sources desde YAML

Nunca configures data sources manualmente en producción. Provisiona:

```yaml
# grafana/provisioning/datasources/prod.yml
apiVersion: 1
datasources:
  - name: Prometheus-Prod
    type: prometheus
    access: proxy
    url: https://mimir.internal:9090/prometheus
    jsonData:
      timeInterval: 30s
      manageAlerts: true
      alertmanagerUid: alertmanager-prod
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo-prod
    secureJsonData:
      httpHeaderValue1: 'Bearer $__file{/etc/secrets/mimir-token}'
    jsonData:
      httpHeaderName1: 'Authorization'
```

Y el mismo patrón para `dashboards/` con `providers`:

```yaml
# grafana/provisioning/dashboards/providers.yml
apiVersion: 1
providers:
  - name: 'default'
    orgId: 1
    folder: 'RED SLOs'
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: false     # dashboard as code: no ediciones desde UI
    options:
      path: /etc/grafana/dashboards
      foldersFromFilesStructure: true
```

---

## 3. Diseño de dashboards útiles (nivel medio)

### 3.1 Los tres arquetipos

**Overview**: 1 dashboard por servicio con 5-10 paneles clave (RED: Rate, Errors, Duration). Objetivo: responder "¿está sano el servicio X?" en 5 segundos.

**Drilldown**: 1 dashboard por dominio (base de datos, cache, cola). Se navega desde Overview vía **Data Links**.

**Executive/Business**: 1 dashboard por métrica de negocio (revenue, signups, conversion). Vista para product/managers, no on-call.

### 3.2 RED, USE, Four Golden Signals

**RED** (Weave, Tom Wilkie, 2015) para **servicios**:
- **R**ate: requests/segundo por endpoint.
- **E**rrors: ratio de errores (5xx / total).
- **D**uration: p50/p95/p99 de latencia.

**USE** (Brendan Gregg) para **recursos**:
- **U**tilization: % del recurso ocupado (CPU, disk IO).
- **S**aturation: cola de trabajos esperando (load avg, queue).
- **E**rrors: contadores de error del recurso.

**Four Golden Signals** (Google SRE Book):
- Latency, Traffic, Errors, Saturation.

Cada servicio en producción **debe** tener un dashboard RED. Cada host debe tener un dashboard USE (node_exporter dashboard 1860 en `grafana.com/dashboards` es un buen punto de partida).

### 3.3 Reglas de layout

- **Top-left importa más**. Coloca ahí lo primero que el on-call debe ver.
- **Alto contraste con thresholds**: paneles Stat con background rojo cuando `error_ratio > 0.05`.
- **Ejes con unidad correcta**: `seconds`, `bytes`, `percent`, `req/s`. Grafana lo hace visible con `unit` en fieldConfig.
- **Legend limitada**: si tienes 40 series, colapsa la leyenda o usa `Top N` en query.
- **Time range razonable**: default 3 h para overview, 30 d para trending.

### 3.4 Un dashboard RED completo en JSON

```json
{
  "uid": "red-http-api",
  "title": "API — RED",
  "tags": ["red", "api", "http"],
  "timezone": "browser",
  "schemaVersion": 41,
  "time": { "from": "now-3h", "to": "now" },
  "refresh": "30s",
  "templating": {
    "list": [
      {
        "name": "job",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "prometheus" },
        "query": "label_values(http_requests_total, job)",
        "refresh": 2,
        "includeAll": false,
        "current": { "text": "api", "value": "api" }
      },
      {
        "name": "route",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "prometheus" },
        "query": "label_values(http_requests_total{job=\"$job\"}, route)",
        "includeAll": true,
        "multi": true
      }
    ]
  },
  "panels": [
    {
      "id": 1,
      "type": "stat",
      "title": "RPS",
      "gridPos": { "x": 0, "y": 0, "w": 6, "h": 4 },
      "targets": [
        { "expr": "sum(rate(http_requests_total{job=\"$job\", route=~\"$route\"}[5m]))",
          "refId": "A" }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "reqps",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 500 },
              { "color": "red", "value": 2000 }
            ]
          }
        }
      }
    },
    {
      "id": 2,
      "type": "stat",
      "title": "Error ratio",
      "gridPos": { "x": 6, "y": 0, "w": 6, "h": 4 },
      "targets": [
        { "expr": "sum(rate(http_requests_total{job=\"$job\", status=~\"5..\"}[5m])) / sum(rate(http_requests_total{job=\"$job\"}[5m]))",
          "refId": "A" }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.01 },
              { "color": "red", "value": 0.05 }
            ]
          }
        }
      }
    },
    {
      "id": 3,
      "type": "stat",
      "title": "p99 latency",
      "gridPos": { "x": 12, "y": 0, "w": 6, "h": 4 },
      "targets": [
        { "expr": "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job=\"$job\"}[5m])))",
          "refId": "A" }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.2 },
              { "color": "red", "value": 0.5 }
            ]
          }
        }
      }
    },
    {
      "id": 10,
      "type": "timeseries",
      "title": "Requests per route",
      "gridPos": { "x": 0, "y": 4, "w": 12, "h": 8 },
      "targets": [
        { "expr": "sum by (route) (rate(http_requests_total{job=\"$job\", route=~\"$route\"}[5m]))",
          "legendFormat": "{{route}}", "refId": "A" }
      ],
      "fieldConfig": { "defaults": { "unit": "reqps" } }
    },
    {
      "id": 11,
      "type": "timeseries",
      "title": "Latency percentiles",
      "gridPos": { "x": 12, "y": 4, "w": 12, "h": 8 },
      "targets": [
        { "expr": "histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{job=\"$job\"}[5m])))",
          "legendFormat": "p50", "refId": "A" },
        { "expr": "histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job=\"$job\"}[5m])))",
          "legendFormat": "p95", "refId": "B" },
        { "expr": "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job=\"$job\"}[5m])))",
          "legendFormat": "p99", "refId": "C" }
      ],
      "fieldConfig": { "defaults": { "unit": "s" } }
    }
  ]
}
```

Este JSON vive en `grafana/dashboards/red-http-api.json` y se provisiona automáticamente al arrancar.

---

## 4. Variables, transformations y valores derivados (nivel medio)

### 4.1 Tipos de variables

| Tipo | Uso |
|---|---|
| **Query** | `label_values(metric, label)` de Prometheus |
| **Custom** | Lista fija: `production,staging,dev` |
| **Data source** | Selector entre múltiples data sources |
| **Interval** | `1m,5m,15m,1h` para binning dinámico |
| **Text box** | Free-form input |
| **Constant** | Valor fijo referenciable |
| **Ad hoc filters** | Filtros dinámicos aplicados a todas las queries |

Sintaxis:

```
Nombre: cluster
Tipo: Query
Data source: Prometheus
Query: label_values(up, cluster)
Regex: /^prod-.*/
Multi-value: true
Include all: true
Refresh: On time range change
```

Uso en query: `sum by (job) (up{cluster=~"$cluster"})`

### 4.2 Variables encadenadas (chained)

```
$env    -> label_values(up, env)
$cluster -> label_values(up{env="$env"}, cluster)
$service -> label_values(up{env="$env", cluster="$cluster"}, service)
```

Cambiar `$env` invalida `$cluster` y `$service` automáticamente.

### 4.3 Transformations

Aplicadas cliente-side sobre el resultado de las queries. Útil para:

- **Merge**: unir varias series en tabla.
- **Add field from calculation**: derivar campo (por ejemplo, error_ratio = errors / requests).
- **Organize fields**: renombrar, reordenar, ocultar.
- **Group by**: colapsar por dimensión.
- **Join by field**: SQL-like join entre queries de data sources distintos.
- **Filter data by values**: dropear filas.

Ejemplo JSON:

```json
"transformations": [
  {
    "id": "joinByField",
    "options": { "byField": "route", "mode": "outer" }
  },
  {
    "id": "calculateField",
    "options": {
      "mode": "binary",
      "binary": {
        "left": "errors_rate",
        "operator": "/",
        "right": "total_rate"
      },
      "alias": "error_ratio"
    }
  },
  {
    "id": "organize",
    "options": {
      "excludeByName": { "Time": true },
      "renameByName": { "route": "Endpoint" }
    }
  }
]
```

### 4.4 Value mapping y overrides

```json
"fieldConfig": {
  "defaults": {
    "mappings": [
      { "type": "value", "options": {
          "1": { "text": "Healthy", "color": "green" },
          "0": { "text": "Down",    "color": "red" }
      }}
    ]
  },
  "overrides": [
    {
      "matcher": { "id": "byRegexp", "options": "^p99.*" },
      "properties": [{ "id": "custom.lineWidth", "value": 3 }]
    }
  ]
}
```

---

## 5. Unified Alerting v12 (nivel medio → senior)

### 5.1 El modelo unificado

Antes de Grafana 8, las alertas vivían solo en dashboards ("dashboard alerting"). Desde Grafana 9 se unificó: un **motor único** evalúa alertas contra cualquier data source (Prometheus, Loki, Elasticsearch, PostgreSQL), y las rutea a **Contact Points** (Slack, PagerDuty, webhook, email, OnCall) vía **Notification Policies** (equivalente al route tree de Alertmanager).

Componentes:

- **Alert rule**: query + condición + interval + `for` duration.
- **Alert group**: agrupación de alerts que se evalúan juntas.
- **Contact point**: destino de notificación (Slack, PagerDuty, webhook).
- **Notification policy**: árbol de routing por labels.
- **Mute timing**: silencio por horario (mantenimiento, fin de semana).
- **Silence**: silencio ad-hoc por labels durante N tiempo.

### 5.2 Alert rule provisionada

```yaml
# grafana/provisioning/alerting/http-alerts.yml
apiVersion: 1
groups:
  - orgId: 1
    name: http-red
    folder: SLOs
    interval: 30s
    rules:
      - uid: high-error-rate-api
        title: HighErrorRate
        condition: C
        data:
          - refId: A
            relativeTimeRange: { from: 300, to: 0 }
            datasourceUid: prometheus
            model:
              expr: sum(rate(http_requests_total{job="api",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="api"}[5m]))
              instant: true
              refId: A
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              conditions:
                - evaluator: { type: gt, params: [0.05] }
                  operator: { type: and }
                  query: { params: [A] }
                  reducer: { type: last, params: [] }
                  type: query
              refId: C
        noDataState: NoData
        execErrState: Error
        for: 5m
        labels:
          severity: critical
          team: backend
        annotations:
          summary: "Error rate > 5% en API"
          runbook_url: "https://wiki.example.com/runbooks/high-error-rate"
```

### 5.3 Notification policies

```yaml
# grafana/provisioning/alerting/policies.yml
apiVersion: 1
policies:
  - orgId: 1
    receiver: default-slack
    group_by: [alertname, cluster]
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 12h
    routes:
      - receiver: pagerduty
        matchers:
          - severity = critical
        continue: true
      - receiver: db-slack
        matchers:
          - team = db
        mute_time_intervals:
          - weekends
```

### 5.4 Contact points

```yaml
# grafana/provisioning/alerting/contactpoints.yml
apiVersion: 1
contactPoints:
  - orgId: 1
    name: default-slack
    receivers:
      - uid: slack-1
        type: slack
        settings:
          url: https://hooks.slack.com/services/T00/B00/XXX
          title: '{{ template "slack.default.title" . }}'
          text: '{{ template "slack.default.text" . }}'
  - orgId: 1
    name: pagerduty
    receivers:
      - uid: pd-1
        type: pagerduty
        settings:
          integrationKey: 'YOUR_INTEGRATION_KEY'
          severity: '{{ .CommonLabels.severity }}'
  - orgId: 1
    name: db-slack
    receivers:
      - uid: slack-db
        type: slack
        settings:
          url: https://hooks.slack.com/services/T00/B01/XXX
          recipient: '#db-oncall'
```

### 5.5 Import de reglas Mimir/Prometheus

Grafana 12.1 (jul 2025) permite **importar reglas gestionadas por data source** (Mimir, Loki) al motor de Grafana. La UI ofrece un wizard; también hay endpoints API compatibles con `mimirtool`. Útil para consolidar reglas dispersas.

---

## 6. Dashboards-as-code con Grafonnet y JSON (nivel senior)

### 6.1 Grafonnet: dashboards en Jsonnet

Jsonnet es un lenguaje de configuración que compila a JSON con funciones, imports, herencia. **Grafonnet** es la biblioteca oficial (Grafana Labs) para generar dashboards.

```jsonnet
// dashboards/red.libsonnet
local g = import 'g.libsonnet';

{
  new(service):: g.dashboard.new('%s — RED' % service)
    + g.dashboard.withUid('red-' + service)
    + g.dashboard.withTags(['red', service])
    + g.dashboard.withTimezone('browser')
    + g.dashboard.time.withFrom('now-3h')
    + g.dashboard.withVariables([
        g.dashboard.variable.query.new('route')
        + g.dashboard.variable.query.withDatasource('prometheus', 'prometheus')
        + g.dashboard.variable.query.queryTypes.withLabelValues('route', 'http_requests_total{job="%s"}' % service)
        + g.dashboard.variable.query.selectionOptions.withMulti(true)
        + g.dashboard.variable.query.selectionOptions.withIncludeAll(true),
      ])
    + g.dashboard.withPanels(
        g.util.grid.wrapPanels([
          $.stat.rps(service),
          $.stat.errorRatio(service),
          $.stat.p99(service),
          $.timeseries.rpsByRoute(service),
          $.timeseries.latencyPercentiles(service),
        ])
      ),

  stat: {
    rps(service):: g.panel.stat.new('RPS')
      + g.panel.stat.queryOptions.withTargets([
          g.query.prometheus.new('prometheus',
            'sum(rate(http_requests_total{job="%s",route=~"$route"}[5m]))' % service)
        ])
      + g.panel.stat.standardOptions.withUnit('reqps'),

    errorRatio(service):: g.panel.stat.new('Error ratio')
      + g.panel.stat.queryOptions.withTargets([
          g.query.prometheus.new('prometheus',
            'sum(rate(http_requests_total{job="%s",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="%s"}[5m]))' % [service, service])
        ])
      + g.panel.stat.standardOptions.withUnit('percentunit')
      + g.panel.stat.standardOptions.thresholds.withSteps([
          g.panel.stat.thresholdStep.withColor('green'),
          g.panel.stat.thresholdStep.withColor('yellow') + g.panel.stat.thresholdStep.withValue(0.01),
          g.panel.stat.thresholdStep.withColor('red')    + g.panel.stat.thresholdStep.withValue(0.05),
        ]),

    p99(service):: g.panel.stat.new('p99 latency')
      + g.panel.stat.queryOptions.withTargets([
          g.query.prometheus.new('prometheus',
            'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job="%s"}[5m])))' % service)
        ])
      + g.panel.stat.standardOptions.withUnit('s'),
  },

  timeseries: {
    rpsByRoute(service):: g.panel.timeSeries.new('Requests per route')
      + g.panel.timeSeries.queryOptions.withTargets([
          g.query.prometheus.new('prometheus',
            'sum by (route) (rate(http_requests_total{job="%s",route=~"$route"}[5m]))' % service)
          + g.query.prometheus.withLegendFormat('{{route}}')
        ]),

    latencyPercentiles(service):: g.panel.timeSeries.new('Latency')
      + g.panel.timeSeries.queryOptions.withTargets([
          g.query.prometheus.new('prometheus',
            'histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{job="%s"}[5m])))' % service)
          + g.query.prometheus.withLegendFormat('p50'),
          g.query.prometheus.new('prometheus',
            'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="%s"}[5m])))' % service)
          + g.query.prometheus.withLegendFormat('p95'),
          g.query.prometheus.new('prometheus',
            'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job="%s"}[5m])))' % service)
          + g.query.prometheus.withLegendFormat('p99'),
        ]),
  },
}
```

```jsonnet
// dashboards/main.jsonnet
local red = import 'red.libsonnet';
{
  'api.json': red.new('api'),
  'worker.json': red.new('worker'),
  'ingester.json': red.new('ingester'),
}
```

```bash
# Generar los JSON con jsonnet-bundler + jsonnet
jb install github.com/grafana/grafonnet/gen/grafonnet-latest@main
jsonnet -J vendor -m out/ dashboards/main.jsonnet
# out/api.json, out/worker.json, out/ingester.json listos para provisionar
```

### 6.2 Git workflow

- Cambio de dashboard → PR → CI ejecuta `jsonnet` + `promtool check rules` + `grafanactl validate`.
- Merge → GitOps (ArgoCD/Flux) sincroniza a los ConfigMaps de Kubernetes o al bucket S3 provisionado.
- Grafana lee de `provisioning.path` → cambios en <1 min.
- **allowUiUpdates: false** en el provider → nadie puede modificar desde UI.

### 6.3 Observability as Code (Grafana 12)

Grafana 12 introdujo `grafanactl` (CLI) y un flujo bidireccional: puedes editar en UI, hacer `grafanactl pull dashboards -o dashboards/`, y commit-ear el JSON generado. Esto elimina el falso dilema entre "UI para prototipar" y "código para producción".

---

## 7. Correlación entre métricas, logs y traces (nivel senior)

### 7.1 Exemplars

Un **exemplar** es un sample especial de Prometheus que además del valor y timestamp incluye labels arbitrarios (típicamente `trace_id`). Prometheus almacena exemplars por bucket de histograma. Grafana los muestra como puntos sobre la gráfica de latencia; click → salto directo al trace en Tempo.

```javascript
// prom-client 15+ con exemplars OTel
import { trace } from '@opentelemetry/api';

app.use((req, res, next) => {
  const end = httpLatency.startTimer({ method: req.method, route: req.path });
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  res.on('finish', () => end({ method: req.method, route: req.path }, { trace_id: traceId }));
  next();
});
```

### 7.2 Trace to logs (Tempo → Loki)

En Tempo data source:

```json
"tracesToLogsV2": {
  "datasourceUid": "loki",
  "tags": [
    { "key": "service.name", "value": "job" },
    { "key": "k8s.pod.name", "value": "pod" }
  ],
  "filterByTraceID": true,
  "filterBySpanID": false,
  "query": "{$__tags} |= \"$__trace.traceId\""
}
```

Click en un span → logs de ese trace en Loki filtrados por tags derivados.

### 7.3 Logs to trace (Loki → Tempo)

En Loki data source `derivedFields`:

```json
"derivedFields": [
  {
    "name": "trace_id",
    "matcherRegex": "trace_id=(\\w+)",
    "url": "$${__value.raw}",
    "datasourceUid": "tempo"
  }
]
```

Cuando Grafana muestra logs con `trace_id=abc123`, el valor es clicable → abre el trace en Tempo.

### 7.4 Service graph

Tempo puede derivar un **service graph** (nodos = servicios, aristas = llamadas) a partir de spans y emitir métricas RED por servicio a Prometheus (`traces_service_graph_request_total`). Configuración en `tempo.yaml`:

```yaml
metrics_generator:
  registry:
    external_labels:
      source: tempo
  storage:
    path: /var/tempo/generator/wal
    remote_write:
      - url: http://prometheus:9090/api/v1/write
  processor:
    service_graphs:
      dimensions: [http.method, http.status_code]
    span_metrics:
      dimensions: [http.method, http.status_code, http.route]
overrides:
  defaults:
    metrics_generator:
      processors: [service-graphs, span-metrics]
```

En Grafana → Explore → Tempo → tab "Service graph" muestra el grafo interactivo.

---

## 8. OnCall, incidentes y hygiene (nivel senior)

### 8.1 Grafana OnCall

**Grafana OnCall** (open source AGPLv3, adquirido por Grafana Labs con Amixr en 2021) es un sistema de on-call scheduling + escalation policies. Reemplaza a PagerDuty para muchos equipos.

Componentes:
- **Integrations**: canales de entrada (Grafana Alerting webhook, Prometheus, custom).
- **Escalation Chains**: N pasos con timeouts (notify user → wait 5m → notify next user → wait 5m → notify entire team channel).
- **Schedules**: rotaciones (weekly, custom shifts) importadas desde Google Calendar o iCal.
- **Routes**: matchers por labels de la alerta → escalation chain distinto.

Integración con Grafana Alerting: contact point `webhook` con URL de OnCall:

```yaml
- name: oncall
  receivers:
    - uid: oncall-1
      type: webhook
      settings:
        url: 'https://oncall.example.com/integrations/v1/grafana/xxxxx/'
        httpMethod: POST
```

### 8.2 Incident management

Grafana **Incident** (parte de Grafana Cloud, GA 2023) automatiza el workflow durante un incident: crea Slack channel dedicado, timeline, war room bridge, runbook links, postmortem draft. Alternativas OSS: **Response** de Monzo, integraciones custom Slack + Notion.

### 8.3 Hygiene: los siete pecados capitales

1. **Dashboards de 40+ paneles**: nadie los usa. Split en overview + drilldowns.
2. **Sin `for` en alertas**: flapping constante.
3. **Umbrales duros mágicos**: `> 100` sin justificación. Usa percentiles históricos.
4. **Sin variables**: dashboard hardcoded por entorno.
5. **Sin runbook_url en annotations**: on-call ve la alerta y no sabe qué hacer.
6. **Sin links entre dashboards**: cada silo aislado.
7. **Editable en UI en producción**: cambios pierden con provisioning.

### 8.4 Dashboard review checklist

- [ ] ¿Responde una pregunta clara? (RED, health, business).
- [ ] ¿Carga en <5s? (usa recording rules).
- [ ] ¿Tiene ≤10 paneles core?
- [ ] ¿Cada panel tiene `unit`, `thresholds`, `description`?
- [ ] ¿Las variables cubren environments, clusters, servicios?
- [ ] ¿Está en git (Jsonnet o JSON provisionado)?
- [ ] ¿Tiene link a runbook y a dashboards relacionados?
- [ ] ¿Se abre efectivamente durante incidentes? (mide con Grafana usage insights).

---

## 9. Ejercicios verificables

### Ejercicio 1 — Provisiona el stack completo

Levanta Grafana 12.1 con Prometheus del cap 17 usando el `docker-compose.yml` y los YAML de provisioning de §0. Verifica que la data source aparece como `Default` y que un dashboard vacío se muestra sin errores.

**Check**: `curl -u admin:admin http://localhost:3000/api/datasources | jq '.[0].name'` devuelve `"Prometheus"`.

### Ejercicio 2 — Dashboard RED en JSON

Guarda el JSON de §3.4 como `grafana/dashboards/red-api.json`, recarga Grafana (`docker compose restart grafana`) y verifica que aparece en la carpeta "RED SLOs". Genera tráfico con `curl` para poblar los stats.

**Check**: navega a `http://localhost:3000/d/red-http-api` — los 5 paneles muestran datos.

### Ejercicio 3 — Variable encadenada

Añade dos variables al dashboard: `$env` (Custom: `production,staging`) y `$service` (Query: `label_values(up{env="$env"}, job)`). Verifica que cambiar `$env` refresca las opciones de `$service`.

**Check**: en la UI, al cambiar `$env` de `production` a `staging`, el dropdown de `$service` se actualiza sin recarga manual.

### Ejercicio 4 — Alert rule provisionada + Slack

Usa el YAML de §5.2 para provisionar la alerta `HighErrorRate`. Configura un contact point con un webhook (usa https://webhook.site para pruebas). Fuerza errores 500 con `for i in {1..200}; do curl http://localhost:8080/boom; done` y verifica que la alerta pasa a `Firing` en <5min.

**Check**: la request de webhook.site muestra el JSON del alert con `status: firing` y `annotations.summary: "Error rate > 5% en API"`.

### Ejercicio 5 — Dashboard-as-code con Grafonnet

Instala jsonnet + jsonnet-bundler, ejecuta el ejemplo de §6.1 para generar `out/api.json`, `out/worker.json`, `out/ingester.json`. Copia los tres a `grafana/dashboards/` y verifica que aparecen automáticamente.

**Check**: `ls out/*.json` muestra 3 archivos, `http://localhost:3000/dashboards` los lista, todos con estructura idéntica.

### Ejercicio 6 — Correlación exemplars

Instrumenta la app del cap 17 con OpenTelemetry SDK y añade `trace_id` como exemplar al histograma. Configura la data source de Tempo (aunque sea con `testdata://` mock). Verifica que en el panel de latencias aparecen puntos (exemplars) y que el click sugiere abrir el trace.

**Check**: la query `http_request_duration_seconds_bucket` en Explore muestra exemplars con badge azul.

### Ejercicio 7 — Notification policy con mute timing

Añade un `mute_time_intervals` que silencie warnings los fines de semana y valida con `curl -u admin:admin http://localhost:3000/api/v1/provisioning/policies` que existe.

```yaml
muteTimings:
  - orgId: 1
    name: weekends
    time_intervals:
      - weekdays: [saturday, sunday]
```

**Check**: la API devuelve el `mute_time_intervals: [weekends]` en la política.

---

## 10. Simulacro y referencias

**Simulacro**: 20 preguntas, 30 min, pass 75%.
- Path: [`packages/content/src/tech/devops/sim-18-grafana-and-dashboards.json`](../../packages/content/src/tech/devops/sim-18-grafana-and-dashboards.json)
- ID: `devops-sim-18-grafana-and-dashboards`
- Áreas: monitoring, visualización, alerting
- Dificultad: junior → mid → senior → staff

**Referencias canónicas**:
- [Grafana 12 release (mayo 2025)](https://grafana.com/blog/2025/05/07/grafana-12-release-all-the-new-features/)
- [Grafana 12.1 alerting features (jul 2025)](https://grafana.com/blog/2025/07/28/grafana-12.1-release-all-the-latest-features/)
- [Alert rule list redesign (dic 2025)](https://grafana.com/whats-new/2025-12-01-alert-rule-list-page-updates/)
- [Grafonnet documentation](https://grafana.github.io/grafonnet/)
- [Grafana dashboards library — 3000+ dashboards](https://grafana.com/grafana/dashboards/)
- [Grafana OnCall docs](https://grafana.com/docs/oncall/latest/)
- [Grafana Provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)
- [Tom Wilkie — The RED Method (2015)](https://www.weave.works/blog/the-red-method-key-metrics-for-microservices-architecture/)
- [Brendan Gregg — USE Method](https://www.brendangregg.com/usemethod.html)
- [Google SRE Book — Ch. 6 Monitoring](https://sre.google/sre-book/monitoring-distributed-systems/)

---

## Navegación

- Anterior: [Cap 17 — Prometheus y métricas](./17-prometheus-y-metrics.md)
- Siguiente: [Cap 19 — Logging: ELK y Loki →](./19-logging-elk-loki.md)
