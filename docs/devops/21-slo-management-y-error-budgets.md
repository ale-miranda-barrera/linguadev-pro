# Capítulo 21 — SLO Management y Error Budgets

> **Focus:** Cómo definir SLIs útiles, calcular SLOs realistas, presupuestar error budgets, disparar alertas por burn rate multi-ventana y convertir la conversación producto-vs-ingeniería en una decisión matemática. Del pizarrón al código: OpenSLO, Sloth, Nobl9, Prometheus recording rules y políticas de error budget que sí se ejecutan.
> **Áreas:** Reliability engineering · Observability · SRE culture · Product engineering
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Prometheus, PromQL y recording rules (ver [cap 17 — prometheus y metrics](./17-prometheus-y-metrics.md)).
- Grafana y dashboards con paneles de latencia y ratios (ver [cap 18 — grafana y dashboards](./18-grafana-y-dashboards.md)).
- Distributed tracing y correlación de errores (ver [cap 20 — distributed tracing](./20-distributed-tracing.md)).
- Fundamentos matemáticos: percentiles, histogramas, ratios sobre ventanas móviles.
- Kubernetes CRDs y Operators (para OpenSLO / Sloth).

**Glosario mínimo:**
- **SLI** (Service Level Indicator): medición cuantitativa de un aspecto del servicio (ej. `successful_requests / total_requests`).
- **SLO** (Service Level Objective): target numérico sobre un SLI en una ventana (ej. `99.9% durante 30 días`). Es un compromiso interno.
- **SLA** (Service Level Agreement): compromiso contractual externo con consecuencias financieras si se incumple. Suele ser más laxo que el SLO interno para dejar buffer.
- **Error budget**: cantidad de "unreliability" permitida por el SLO. `budget = 1 - SLO`. Para 99.9% mensual, son 43.2 minutos.
- **Burn rate**: velocidad a la que se consume el error budget. `burn_rate = observed_error_rate / target_error_rate`. Un burn rate de 14.4x quema el 100% del budget mensual en 2 horas.
- **Multi-window multi-burn**: técnica del SRE Workbook (cap 5) que combina ventana larga (page) con ventana corta (confirmación) para reducir falsos positivos.
- **Error budget policy**: documento firmado por producto + ingeniería que define qué pasa cuando el budget se agota (feature freeze, priorización, escalado).
- **SLO-as-code**: definir SLOs en YAML versionado, deployado y observado (OpenSLO, Sloth, Nobl9).
- **Recording rule**: agregación pre-calculada en Prometheus. Base para todo SLI (evita recomputar percentiles en cada scrape del dashboard).
- **Nines table**: `99% = 3.65 días/año`, `99.9% = 8.76 h/año`, `99.99% = 52.6 min/año`, `99.999% = 5.26 min/año`.

**Setup mínimo:**

```bash
# 1. Prometheus 3.0+ (agosto 2026) con recording rules habilitadas
prometheus --version
# prometheus, version 3.0.x

# 2. Sloth CLI (generador de SLOs para Prometheus)
brew install slok/tap/sloth
sloth version
# release/v0.11.x

# 3. OpenSLO CLI (validación del spec 1.0)
go install github.com/OpenSLO/oslo@latest
oslo version

# 4. Node exporter + kube-state-metrics para SLIs de infraestructura (opcional)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install kube-prom prometheus-community/kube-prometheus-stack \
  --version 65.x.x \
  --namespace monitoring --create-namespace

# 5. Grafana 11+ con plugin SLO panel
helm install grafana grafana/grafana --version 8.x.x --namespace monitoring

# 6. (Opcional SaaS) Nobl9 CLI para gestión declarativa de SLOs enterprise
brew install nobl9/nobl9-cli/sloctl
sloctl version
```

---

## 1. El gran cuadro

En 2026 la palabra **"SLO"** ya no vive en la pizarra del líder de SRE: vive en YAML versionado, se aplica con `kubectl apply -f`, se calcula con recording rules pre-agregadas y dispara alertas sofisticadas basadas en burn rate multi-ventana. Es la infraestructura que traduce la conversación política **"¿podemos deployar hoy?"** en una decisión matemática **"tenemos 63% de error budget restante para el mes, sí"**. El movimiento de SLOs comenzó en Google con el SRE Book (2016) y el SRE Workbook (2018), maduró con las especificaciones abiertas (**OpenSLO 1.0** en 2022) y hoy es un pilar de la práctica DevOps moderna junto a las cuatro métricas DORA.

La estructura fundamental es una jerarquía de tres letras. El **SLI** es la medición cruda: `sum(rate(http_requests_total{status=~"2..|3.."}[5m])) / sum(rate(http_requests_total[5m]))`. El **SLO** es el objetivo interno sobre ese SLI: **99.9% durante 30 días rolling**. El **SLA** es el contrato externo con consecuencias financieras (**99.5% mensual, refund 10% si menos**). Regla de oro: **SLO más estricto que SLA**, dejando buffer. Si el SLO se rompe, alertás; si el SLA se rompe, pagás. Confundir los tres es la fuente número uno de discusiones estériles en reviews de arquitectura.

Sobre esa jerarquía se apila el concepto de **error budget**: si tu SLO es 99.9%, el budget es 0.1%, que en un mes de 30 días equivale a **43.2 minutos de "downtime autorizado"**. Ese budget no es un lujo: es un instrumento de gobernanza. Mientras haya budget disponible, el equipo tiene **derecho** a asumir riesgo (deployar features nuevas, migraciones, experimentos). Cuando se agota, tiene **obligación** de invertir en confiabilidad (feature freeze, hardening, post-mortems). Esta simetría fue la innovación más importante del SRE original, porque alineó incentivos: dev quiere shippear, ops quiere estabilidad, el error budget balancea automáticamente. El compromiso se materializa en una **error budget policy** firmada por producto + ingeniería.

El estado del arte 2026 tiene tres avances concretos. Primero, **alertas multi-window multi-burn** (SRE Workbook cap 5) reemplazaron las viejas alertas de "5xx > 1% durante 5min" por combinaciones como **14.4x sobre 1h + 14.4x sobre 5min** (page urgente) y **6x sobre 6h + 6x sobre 30min** (ticket). Esto reduce falsos positivos y captura tanto burn rápido como slow burn. Segundo, **SLO-as-code** con **Sloth** genera recording rules y alertas Prometheus desde un YAML de 20 líneas; **OpenSLO 1.0** provee spec neutral vendor; **Nobl9** ofrece plataforma SaaS con composite SLOs y data replay. Tercero, la **cultura del error budget** salió del silo SRE y entró a los OKRs de producto: en 2026 no es raro ver PMs revisando burn rate junto a métricas de engagement. Este capítulo cubre la teoría, las trampas comunes y ejercicios verificables sobre **LinguaDev Pro** para instrumentar SLOs reales.

---

## 2. SLI, SLO, SLA: definiciones precisas

### 2.1 La distinción foundational

Un **SLI** (Service Level Indicator) es una **medición** cuantitativa. No es un target. No es un contrato. Es un número que puede calcularse desde datos observables. Ejemplos válidos:

- Availability SLI: `successful_requests / total_requests`.
- Latency SLI: `p99_response_time_ms` sobre una ventana de 5 minutos.
- Freshness SLI: `age_of_latest_data_seconds` para un pipeline batch.
- Correctness SLI: `records_passing_validation / total_records`.
- Throughput SLI: `requests_per_second` (para SLIs de capacidad).

El **SLO** es un target sobre el SLI en una ventana temporal. La formulación canónica es:

> "El 99.9% de las solicitudes HTTP a `/api/lessons` devolverán 2xx/3xx en menos de 500ms, medido sobre una ventana móvil de 30 días."

Notá cómo el SLO fija **cuatro cosas**: el SLI (`successful ratio`), el target (`99.9%`), la condición (`status 2xx/3xx y latencia < 500ms`) y la ventana (`30 días rolling`). Sin los cuatro, el SLO es ambiguo.

El **SLA** es un contrato externo. Suele incluir cláusulas de exclusión (mantenimiento programado, force majeure, DDoS) y refunds escalonados. Ejemplo típico de un SaaS:

| Availability mensual | Service credit |
|----------------------|----------------|
| < 99.9% | 10% |
| < 99.5% | 25% |
| < 99% | 50% |

**Regla de oro**: el SLO interno debe ser más estricto que el SLA externo. Si tu SLA promete 99.5%, tu SLO debe ser 99.9% para que las alertas internas te salven antes de pagar refunds.

### 2.2 Anti-patrones frecuentes

- **SLO = 100%**: matemáticamente imposible en sistemas distribuidos y desincentiva innovación (cualquier deploy consume budget).
- **SLO copiado de otra empresa**: Netflix tiene contexto muy distinto al de una fintech local.
- **SLI mal seleccionado**: usar "uptime del proceso" cuando lo que importa es "requests exitosos de usuarios reales".
- **SLA más estricto que SLO**: garantía externa sin buffer interno; el primer incidente causa refunds.

### 2.3 Ejemplo aplicado a LinguaDev Pro

Para el módulo de tutor GPT (streaming SSE) definimos:

- **SLI availability**: `sum(rate(tutor_requests_total{status=~"2..|3.."}[5m])) / sum(rate(tutor_requests_total[5m]))`.
- **SLI latency (TTFB)**: `histogram_quantile(0.95, sum(rate(tutor_ttfb_seconds_bucket[5m])) by (le))`.
- **SLO availability**: 99.5% sobre 30 días (streaming permite más flexibilidad que APIs sincrónicas).
- **SLO TTFB**: p95 < 1.5s sobre 30 días.
- **SLA público**: 99% mensual con credit 10%.

---

## 3. Availability calculations: la tabla de nueves

La tabla siguiente es de memorización obligatoria. Multiplicar downtime tolerado por escala del negocio pone en perspectiva la diferencia de "una más nueve":

| SLO | Downtime/año | Downtime/mes (30d) | Downtime/semana | Downtime/día |
|-----|--------------|--------------------|-----------------|--------------|
| 99% | 3 días 15 h | 7 h 12 m | 1 h 40 m | 14 m 24 s |
| 99.5% | 1 día 19 h | 3 h 36 m | 50 m 24 s | 7 m 12 s |
| 99.9% | 8 h 45 m | 43 m 12 s | 10 m 4 s | 1 m 26 s |
| 99.95% | 4 h 22 m | 21 m 36 s | 5 m 2 s | 43 s |
| 99.99% | 52 m 33 s | 4 m 19 s | 1 m 0 s | 8.6 s |
| 99.999% | 5 m 15 s | 25.9 s | 6 s | 0.86 s |

### 3.1 Cómo elegir el número de nueves

Elegir el SLO **no es un ejercicio matemático puro**: es negociación producto + ingeniería basada en:

1. **Baseline actual**: mide tu availability histórica antes de fijar target. Si estás en 99.2% real, un SLO de 99.99% es fantasía.
2. **Costo de la reliability marginal**: pasar de 99.9% → 99.99% suele requerir **10x el costo de infra** (multi-region active-active, chaos engineering constante, on-call 24/7, celdas de aislamiento).
3. **Tolerancia del usuario**: LinguaDev Pro es una PWA de aprendizaje. Un error cada 1000 requests durante clase no rompe el producto. Un broker de bolsa es otra historia.
4. **Dependencias upstream**: si dependés de OpenAI y ellos publican SLA 99.9%, tu SLO combinado no puede exceder eso (más los otros componentes).

### 3.2 La regla de compounding

Para un servicio con N dependencias serial independientes: `SLO_total = SLO_1 * SLO_2 * ... * SLO_N`. Si tenés 5 dependencias a 99.9% cada una, tu SLO máximo agregado es `0.999^5 ≈ 99.5%`. Diseñar para más de eso exige circuit breakers, retries con backoff, fallback caches y celdas independientes.

---

## 4. Error budgets: la matemática y la política

### 4.1 Cálculo del budget

```
error_budget = (1 - SLO) * total_requests_in_window
```

Para un servicio que procesa **10 millones de requests/mes** con SLO 99.9%:

```
error_budget = 0.001 * 10_000_000 = 10_000 errores tolerados/mes
```

Traducido a tiempo (para SLIs time-based):

```
downtime_budget = (1 - SLO) * total_time_in_window
                = 0.001 * (30 * 24 * 60) minutos
                = 43.2 minutos/mes
```

### 4.2 Error budget policy: el documento que sí se respeta

Un buen policy tiene tres bloques y está firmado por **VP Product + VP Engineering**:

```markdown
# Error Budget Policy — LinguaDev Pro / Tutor GPT

## Scope
- SLO: 99.5% availability sobre 30 días rolling
- SLO: p95 TTFB < 1.5s sobre 30 días rolling
- Ownership: equipo Tutor + SRE de guardia

## Estados y acciones

| Budget restante | Estado | Acciones |
|-----------------|--------|----------|
| > 50% | GREEN | Deploys normales, features nuevas OK, experimentos permitidos |
| 25%-50% | YELLOW | Deploys diarios pero con canary obligatorio, review de cada PR risky |
| 10%-25% | ORANGE | Solo bugfixes y hardening. Nuevas features pausadas. Post-mortem por incidente |
| < 10% | RED | Feature freeze total. Todo el equipo prioriza reliability. Escalado a leadership |
| 0% (SLO breach) | BREACH | Blameless post-mortem obligatorio en 5 días laborales. Retrospectiva del policy |

## Exclusiones válidas del budget
- Mantenimiento programado anunciado con 7 días de antelación
- Downtime causado por dependencias upstream con SLA público más laxo (documentar en cada caso)

## Revisión
- Trimestral: producto + eng revisan SLO y policy juntos
```

### 4.3 Presupuestar deploys

Otra aplicación práctica: **cuánto downtime puede consumir un deploy**. Si el SLO permite 43 min/mes y hacés 20 deploys/mes, cada deploy debería consumir < 2 minutos. Esto informa decisiones de blue/green vs canary vs rolling.

---

## 5. Burn rate alerts: multi-window multi-burn

El SRE Workbook capítulo 5 introdujo la alerta más importante de la última década. Reemplaza el clásico **"5xx > 1% durante 5 minutos"** (que dispara con cualquier hiccup) por una construcción que combina **dos ventanas** y **dos umbrales de burn rate**.

### 5.1 Fórmula del burn rate

```
burn_rate = (1 - SLI_observed) / (1 - SLO_target)
```

Un burn rate de **1x** significa que estás quemando budget al ritmo exacto que el SLO permite (agotarías el mes justo al final). Un burn rate de **14.4x** quema el 100% del budget mensual en **2 horas**. Un burn rate de **1x** durante 30 días agota exactamente el budget.

### 5.2 Umbrales canónicos del SRE Workbook

Para SLO 99.9% (budget 0.1%) sobre ventana 30 días:

| Alerta | Long window | Short window | Burn rate | Consume | Time to page |
|--------|-------------|--------------|-----------|---------|--------------|
| Page urgente | 1 hora | 5 minutos | 14.4x | 2% del budget mensual en 1h | ~2 min |
| Page slow | 6 horas | 30 minutos | 6x | 5% del budget mensual en 6h | ~15 min |
| Ticket | 3 días | 6 horas | 1x | 10% del budget mensual en 3d | ~6 h |

La dupla **long + short** exige que **ambas** ventanas superen el umbral, lo que reduce dramáticamente falsos positivos de spikes transitorios.

### 5.3 Implementación con Prometheus recording rules

```yaml
# prometheus-slo-tutor.yaml
groups:
  - name: slo-tutor-availability
    interval: 30s
    rules:
      # SLI raw: ratio de requests exitosos sobre ventanas relevantes
      - record: sli:tutor:availability:ratio_rate5m
        expr: |
          sum(rate(tutor_requests_total{status=~"2..|3.."}[5m]))
          /
          sum(rate(tutor_requests_total[5m]))

      - record: sli:tutor:availability:ratio_rate30m
        expr: |
          sum(rate(tutor_requests_total{status=~"2..|3.."}[30m]))
          /
          sum(rate(tutor_requests_total[30m]))

      - record: sli:tutor:availability:ratio_rate1h
        expr: |
          sum(rate(tutor_requests_total{status=~"2..|3.."}[1h]))
          /
          sum(rate(tutor_requests_total[1h]))

      - record: sli:tutor:availability:ratio_rate6h
        expr: |
          sum(rate(tutor_requests_total{status=~"2..|3.."}[6h]))
          /
          sum(rate(tutor_requests_total[6h]))

  - name: slo-tutor-burnrate-alerts
    rules:
      # Fast burn: 14.4x sobre 1h AND 5m (page)
      - alert: TutorSLOFastBurnPage
        expr: |
          (1 - sli:tutor:availability:ratio_rate1h) > (14.4 * 0.001)
          AND
          (1 - sli:tutor:availability:ratio_rate5m) > (14.4 * 0.001)
        for: 2m
        labels:
          severity: page
          slo: tutor-availability
          window: 1h/5m
        annotations:
          summary: "Tutor GPT quema error budget a 14.4x (2h para agotar mes)"
          runbook_url: "https://runbooks.linguadev.dev/tutor-slo-burn"

      # Slow burn: 6x sobre 6h AND 30m (page)
      - alert: TutorSLOSlowBurnPage
        expr: |
          (1 - sli:tutor:availability:ratio_rate6h) > (6 * 0.001)
          AND
          (1 - sli:tutor:availability:ratio_rate30m) > (6 * 0.001)
        for: 15m
        labels:
          severity: page
          slo: tutor-availability
          window: 6h/30m
        annotations:
          summary: "Tutor GPT quema budget a 6x sostenido (agotará mes en 5 días)"
```

### 5.4 Por qué NO usar solo la ventana larga

Si alertaras solo con la ventana de 6h, un incidente severo que dura 20 min recién dispararía la alerta cuando ya está resuelto (o peor: nunca, porque el promedio se diluyó). La ventana corta (30m/5m) da la señal rápida; la ventana larga confirma que no es un blip transitorio.

---

## 6. SLO-as-code: Sloth, OpenSLO y Nobl9

El movimiento **SLO-as-code** consiste en definir SLOs en YAML versionado y generar recording rules + alertas automáticamente. Los tres actores principales en 2026 son **Sloth** (open source, Prometheus-native), **OpenSLO 1.0** (spec neutral vendor) y **Nobl9** (plataforma SaaS enterprise).

### 6.1 Sloth: el generador Prometheus-first

Sloth toma un SLO YAML de ~20 líneas y genera decenas de recording rules + alertas multi-window multi-burn:

```yaml
# sloth-tutor.yaml
version: prometheus/v1
service: tutor-gpt
labels:
  team: tutor
  tier: critical
slos:
  - name: tutor-availability
    objective: 99.5
    description: "Streaming SSE del tutor GPT — availability medida por 2xx/3xx"
    sli:
      events:
        error_query: |
          sum(rate(tutor_requests_total{status=~"5.."}[{{.window}}]))
        total_query: |
          sum(rate(tutor_requests_total[{{.window}}]))
    alerting:
      name: TutorAvailability
      page_alert:
        labels:
          severity: page
          runbook: https://runbooks.linguadev.dev/tutor
      ticket_alert:
        labels:
          severity: ticket

  - name: tutor-latency-ttfb
    objective: 95
    description: "p95 de TTFB streaming — 95% de sesiones < 1.5s"
    sli:
      events:
        error_query: |
          sum(rate(tutor_ttfb_seconds_bucket{le="1.5"}[{{.window}}]))
        total_query: |
          sum(rate(tutor_ttfb_seconds_count[{{.window}}]))
    alerting:
      name: TutorLatency
      page_alert:
        labels:
          severity: page
```

Generar reglas:

```bash
sloth generate -i sloth-tutor.yaml -o prometheus-rules-tutor.yaml
# Sloth genera: sli:*, slo:*, alertas fast burn + slow burn con umbrales calculados
# desde el objective. Para 99.5%, umbrales 14.4x y 6x sobre ventanas apropiadas.

# Deploy como ConfigMap y PrometheusRule del kube-prometheus-stack
kubectl create configmap sloth-tutor \
  --from-file=prometheus-rules-tutor.yaml \
  -n monitoring
```

### 6.2 OpenSLO: el spec neutro

**OpenSLO 1.0** (Apache 2.0) define un YAML vendor-neutral que Sloth y Nobl9 pueden ambos consumir. Ventaja: portabilidad entre backends.

```yaml
apiVersion: openslo/v1
kind: SLO
metadata:
  name: tutor-availability
  displayName: Tutor GPT Availability
spec:
  service: tutor-gpt
  description: 99.5% de requests exitosos sobre 30 días
  budgetingMethod: Occurrences
  indicator:
    metadata:
      name: tutor-availability-ratio
    spec:
      ratioMetric:
        counter: true
        good:
          metricSource:
            type: Prometheus
            spec:
              query: sum(rate(tutor_requests_total{status=~"2..|3.."}[1m]))
        total:
          metricSource:
            type: Prometheus
            spec:
              query: sum(rate(tutor_requests_total[1m]))
  objectives:
    - displayName: 99.5% mensual rolling
      target: 0.995
      op: gte
  timeWindow:
    - duration: 30d
      isRolling: true
```

### 6.3 Nobl9: la plataforma SaaS

**Nobl9** (fundada por co-autores del SRE Book) añade sobre OpenSLO: composite SLOs (combinar SLOs con AND/OR), anomaly detection, data replay (re-calcular SLOs sobre datos históricos al cambiar la definición), integraciones con Datadog/New Relic/Splunk y ejecución de error budget policies. Suele usarse en organizaciones con >100 SLOs donde gestionar manualmente los YAMLs se vuelve prohibitivo.

---

## 7. Recording rules y agregación correcta

### 7.1 Por qué siempre recording rules

Calcular percentiles con `histogram_quantile` sobre ventanas largas es **caro**. En cada refresh del dashboard, Prometheus re-evalúa. Con recording rules, la agregación se calcula **cada 30 segundos** y se guarda como serie nueva, que el dashboard consulta como un simple `sli:...`.

```yaml
groups:
  - name: latency-recording-rules
    interval: 30s
    rules:
      # Base: rate del bucket por endpoint y le
      - record: job:tutor_ttfb_seconds_bucket:rate5m
        expr: |
          sum by (le, endpoint) (
            rate(tutor_ttfb_seconds_bucket[5m])
          )

      # p95 usando la rate pre-agregada
      - record: job:tutor_ttfb_seconds:p95:5m
        expr: |
          histogram_quantile(
            0.95,
            job:tutor_ttfb_seconds_bucket:rate5m
          )

      # p99 usando la misma base
      - record: job:tutor_ttfb_seconds:p99:5m
        expr: |
          histogram_quantile(
            0.99,
            job:tutor_ttfb_seconds_bucket:rate5m
          )
```

### 7.2 Regla dura: percentiles NO se pueden promediar

Un error tristemente común: `avg(p99_por_pod)` **no es** p99 global. Los percentiles no son agregables lineales. Para calcular p99 correcto cross-pod:

1. Instrumentar con `histogram` (no `summary`, que agrega en el cliente).
2. En Prometheus, sumar buckets por `le`: `sum by (le) (rate(bucket[5m]))`.
3. Aplicar `histogram_quantile(0.99, ...)` sobre la suma.

### 7.3 SLIs para batch jobs

Los SLOs no son solo para servicios online. Un pipeline diario de sincronización de contenido en LinguaDev tiene SLIs distintos:

- **Freshness**: `time.now() - last_successful_run_timestamp`. SLO: < 25 horas.
- **Completeness**: `records_processed / records_expected`. SLO: > 99.9%.
- **Correctness**: `records_passing_validation / records_processed`. SLO: > 99.99%.

---

## 8. Cultura y organización: SLOs como conversación

### 8.1 El proceso de definición

1. **Semana 1**: SRE mide baseline de SLIs candidatos (availability, latency p95/p99, correctness) sobre 90 días históricos.
2. **Semana 2**: Workshop de 90 min con producto + ingeniería. Producto define **thresholds de user-acceptable experience** (¿cuántos errores tolera el usuario antes de churn?).
3. **Semana 3**: SRE propone SLO iniciales conservadores (ej. baseline - 0.2%). Producto valida coste vs beneficio.
4. **Semana 4**: Publish del **SLO catalog** en el service catalog interno. Cada servicio tiene SLI/SLO/policy documentados.
5. **Trimestral**: Review. Los SLOs que nunca burnearon son **demasiado laxos**; los que burnearon todo el trimestre son **demasiado estrictos**.

### 8.2 Service catalog

En 2026 el **service catalog** (Backstage, Cortex, OpsLevel) es el sitio donde vive el SLO junto al ownership, runbooks y dependencias. Ejemplo entrada Backstage:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: tutor-gpt
  annotations:
    sloth.io/slo-config: https://github.com/linguadev/slos/blob/main/tutor.yaml
    grafana/dashboard: https://grafana.linguadev.dev/d/tutor-slo
    pagerduty.com/service-id: PXXXX
    backstage.io/techdocs-ref: dir:docs
spec:
  type: service
  lifecycle: production
  owner: team-tutor
  dependsOn:
    - openai-gateway
    - cache-redis
    - auth-service
```

### 8.3 Error budget policies como contrato vivo

Las policies **firmadas y publicadas** son la diferencia entre "tenemos SLOs" y "somos una organización data-driven". Cuando el budget se agota, el policy determina automáticamente qué pasa. Sin policy previa, cada agotamiento genera batalla política ("¿pero es que necesitamos esta feature para el lanzamiento…?").

---

## 9. Anti-patrones frecuentes

### 9.1 SLOs "vanidosos"

**Síntoma**: SLO 99.999% para un servicio interno de reporting que corre una vez por hora.
**Problema**: Estás pagando 100x el costo en HA sin justificación de negocio.
**Fix**: Elegir SLO acorde al valor real del servicio. Reporting interno con 99% es más que suficiente.

### 9.2 SLIs desconectados del usuario

**Síntoma**: SLI = "kubelet reporta pod ready". SLO = 99.99%. Usuarios ven timeouts.
**Problema**: Medir liveness de infraestructura no mide user experience.
**Fix**: SLI basado en requests reales (con status codes o business events).

### 9.3 Alertas sin runbook

**Síntoma**: PagerDuty despierta al SRE con "TutorSLOFastBurnPage". SRE abre Grafana. No sabe qué hacer.
**Problema**: La alerta no tiene contexto ni playbook.
**Fix**: `annotations.runbook_url` obligatorio en cada alerta. Runbook incluye: qué medir, comandos de diagnóstico, mitigaciones probadas.

### 9.4 Ignorar el SLA en la ingeniería

**Síntoma**: SLO interno 99.5%, SLA público 99.9%. Cuando el SLO burnea, ingeniería relaja porque "aún estamos OK". A los 3 días el SLA se rompe y hay que pagar refunds.
**Problema**: El SLO debía ser más estricto que el SLA.
**Fix**: Recalcular SLO con buffer suficiente. Regla común: **SLO = SLA + 0.4%**.

### 9.5 Copiar SLOs de Google

**Síntoma**: Startup de 5 devs copia SLO 99.999% de Google Search.
**Problema**: Google tiene chaos engineering, cell-based architecture, 24/7 SREs, N+2 redundancy. Vos tenés dos EC2.
**Fix**: SLOs propios basados en tu baseline y tu tolerancia al costo.

### 9.6 Multi-window sin recording rules

**Síntoma**: Alertas burn rate se disparan tarde. Prometheus timeout en evaluación.
**Problema**: Calcular percentiles + ratios sobre ventanas largas cada 30s sin pre-agregación.
**Fix**: Sloth (o recording rules manuales) para todas las ventanas usadas por alertas.

---

## 10. Ejercicios prácticos sobre LinguaDev Pro

Estos ejercicios se resuelven en el monorepo real. Todos son verificables con comandos concretos.

### Ejercicio 1: Definir SLIs del servicio `tutor-gpt` (30 min)

**Objetivo**: catalogar los SLIs relevantes del tutor GPT streaming.

**Pasos**:
1. Inspecciona la instrumentación actual (métricas Prometheus) del servicio `apps/tutor-service`.
2. Documenta tres SLIs propuestos: availability, TTFB p95, correctness (ej. `stream_completed / stream_started`).
3. Para cada SLI, escribe la query PromQL exacta.

**Verificación**:

```bash
promtool query instant http://prometheus.local:9090 \
  'sum(rate(tutor_requests_total{status=~"2..|3.."}[5m])) / sum(rate(tutor_requests_total[5m]))'
# Debe retornar valor entre 0 y 1 (ideal: > 0.99).
```

### Ejercicio 2: Escribir SLO YAML con Sloth (45 min)

**Objetivo**: definir SLO 99.5% availability + 95% latency TTFB < 1.5s con Sloth, y generar reglas Prometheus.

**Pasos**:
1. Crea `slos/tutor.sloth.yaml` con la spec Sloth (ver §6.1).
2. Corre `sloth generate -i slos/tutor.sloth.yaml -o rules/tutor.yaml`.
3. Inspecciona el output: debe contener ~15 recording rules + 4 alertas (page fast/slow, ticket fast/slow).
4. Deploy como `PrometheusRule` CRD.

**Verificación**:

```bash
kubectl get prometheusrule tutor-slo -n monitoring -o yaml | grep -c "alert:"
# Espera al menos 4 alertas.

promtool check rules rules/tutor.yaml
# SUCCESS: X rules found
```

### Ejercicio 3: Simular burn con carga sintética (60 min)

**Objetivo**: forzar burn del budget y observar la alerta multi-window disparar.

**Pasos**:
1. Con `k6` inyecta 20% de tráfico sintético con Authorization inválida (fuerza 401 en el servicio, que en tu instrumentación cuenta como error).
2. Corre por 10 min. Observa Grafana panel de burn rate.
3. Verifica que `TutorSLOFastBurnPage` dispara alrededor de 2-4 min.

**k6 script**:

```javascript
import http from 'k6/http';
export const options = { vus: 50, duration: '10m' };
export default function () {
  http.get('https://api.linguadev.dev/tutor/stream', {
    headers: { Authorization: 'Bearer INVALID_TOKEN' },
  });
}
```

**Verificación**:

```bash
kubectl exec -it prometheus-0 -n monitoring -- \
  promtool query instant http://localhost:9090 \
  'ALERTS{alertname="TutorSLOFastBurnPage",alertstate="firing"}'
# Debe retornar 1 serie tras ~2 min de burn sostenido.
```

### Ejercicio 4: Escribir error budget policy y firmarla (30 min)

**Objetivo**: producir el documento oficial que rige el comportamiento del equipo cuando el budget se agota.

**Pasos**:
1. Copia el template de §4.2 a `docs/policies/error-budget-tutor.md`.
2. Adapta thresholds y acciones al equipo real (canary obligatorio, feature freeze, etc.).
3. Añade firma de VP Product y VP Engineering (nombre + fecha).
4. Publica en el service catalog Backstage anotado desde `catalog-info.yaml`.

**Verificación**: el link `sloth.io/error-budget-policy` en Backstage abre el documento correcto.

### Ejercicio 5: Composite SLO con OpenSLO (avanzado, 90 min)

**Objetivo**: definir un SLO compuesto que exige **AND** entre availability del tutor + availability del cache Redis.

**Pasos**:
1. Instala `oslo` CLI y crea `slos/tutor-composite.oslo.yaml` con dos indicators (tutor + redis).
2. Define objetivo compuesto: 99.5% de requests exitosos **y** cache hit rate > 80%.
3. Convierte con `nobl9-openslo` a formato Nobl9 (si usas la SaaS) o a Sloth para Prometheus.

**Verificación**:

```bash
oslo validate slos/tutor-composite.oslo.yaml
# Output esperado: Valid.
```

### Ejercicio 6: Runbook y postmortem (60 min)

**Objetivo**: cerrar el ciclo con documentación operativa.

**Pasos**:
1. Escribe `runbooks/tutor-slo-burn.md` con: qué medir, comandos de diagnóstico, mitigaciones (rollback, scale-up, degradar features), escalado.
2. Añade el link como `annotations.runbook_url` en las alertas de Sloth output.
3. Simula un incidente en staging. Escribe post-mortem blameless siguiendo template (impacto, timeline, root cause, action items).

**Simulacro asociado**: [`packages/content/src/tech/devops/sim-21-slo-management-and-error-budgets.json`](../../packages/content/src/tech/devops/sim-21-slo-management-and-error-budgets.json) (id `devops-sim-21-slo-management-and-error-budgets`, 20 preguntas, 30 min, pass 75%).

---

## Navegación

- Anterior: [Capítulo 20 — Distributed Tracing](./20-distributed-tracing.md)
- Siguiente: [Capítulo 22 — Fundamentos DevSecOps →](./22-fundamentos-devsecops.md)
- Índice: [docs/devops](./)
