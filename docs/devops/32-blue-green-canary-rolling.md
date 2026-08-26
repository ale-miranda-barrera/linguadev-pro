# Capítulo 32 — Blue/Green, Canary y Rolling Updates

> **Focus:** Estrategias fundamentales de deployment: rolling update (default Kubernetes), blue/green (duplicado + cutover instantáneo), canary release (5%→25%→50%→100%), traffic shifting (weighted, header-based, cookie-based), automated rollback triggers, deployment gates, Argo Rollouts 1.9+ vs Flagger 1.44+, feature flags como canary alternativo, dark launches, shadow traffic, expand-contract para DB migrations, cost tradeoffs y decisiones cutover (DNS vs LB vs Service Mesh).
> **Áreas:** Deployment · SRE · CI/CD
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Kubernetes Deployments, ReplicaSet, readinessProbe/livenessProbe (cap [07](./07-fundamentos-kubernetes.md), [08](./08-kubernetes-workloads.md)).
- Ingress y Gateway API ([cap 09](./09-kubernetes-networking-y-storage.md)).
- Service Mesh ([cap 29](./29-service-mesh-istio-linkerd.md)) para traffic splitting.
- CI/CD fundamentals ([cap 02](./02-fundamentos-de-continuous-delivery.md)).
- SLOs y métricas RED (Rate/Errors/Duration).

**Glosario mínimo:**
- **Rolling update:** reemplaza replicas de la versión vieja por la nueva gradualmente, respetando `maxUnavailable` y `maxSurge`. Default en K8s Deployment.
- **Blue/green:** dos ambientes idénticos (blue = actual, green = nuevo). Cutover instantáneo, rollback trivial.
- **Canary:** deployment gradual por porcentaje del tráfico (5→25→50→100). Blast radius reducido.
- **Traffic shifting:** movimiento del tráfico entre versiones por peso, header, cookie o región.
- **Progressive delivery:** canary + análisis automatizado de métricas + rollback automático.
- **Argo Rollouts:** operador K8s con CRD `Rollout` que reemplaza `Deployment` con estrategias avanzadas (canary, blue/green).
- **Flagger:** operador CNCF que automatiza canary encima de `Deployment` estándar sin reemplazarlo.
- **Kayenta:** Netflix Automated Canary Analysis con Mann-Whitney U test.
- **Feature flag:** toggle en config o código para activar/desactivar features sin redeploy.
- **Dark launch:** deployar código nuevo sin exponerlo a usuarios (feature flag OFF).
- **Shadow traffic (mirror):** copia del tráfico real enviada a v2 sin bloquear respuesta al usuario.
- **Expand-contract:** patrón para migrar DB schema backward-compatible en múltiples deploys.

**Setup mínimo:**

```bash
# 1) Cluster con Istio (para traffic splitting)
kind create cluster --name delivery-lab --image kindest/node:v1.32.0
istioctl install --set profile=demo -y

# 2) Argo Rollouts 1.9+
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/download/v1.9.1/install.yaml

# CLI plugin
curl -LO https://github.com/argoproj/argo-rollouts/releases/download/v1.9.1/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
sudo mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# 3) Flagger 1.44+ (alternativa)
helm repo add flagger https://flagger.app
helm install flagger flagger/flagger \
  --namespace istio-system \
  --set meshProvider=istio \
  --set metricsServer=http://prometheus.istio-system:9090

# 4) Prometheus para métricas (analysis)
kubectl apply -f https://github.com/prometheus-operator/kube-prometheus/releases/latest/download/bundle.yaml

# 5) hey/fortio para generar carga
go install github.com/rakyll/hey@latest
```

---

## 1. El gran cuadro

En 2026, deployar código a producción no es "apagar el binario viejo y arrancar el nuevo": es una **estrategia** con trade-offs medibles de costo de infraestructura, riesgo de outage, tiempo de rollback, complejidad operacional y granularidad de traffic control. Las tres estrategias fundamentales son **rolling update**, **blue/green** y **canary release**. Cada una responde a una pregunta distinta: rolling responde "¿cómo actualizo N replicas gradualmente sin duplicar infra?", blue/green responde "¿cómo hago cutover instantáneo con rollback trivial?", y canary responde "¿cómo minimizo blast radius si v2 tiene un bug?". Sobre estas tres se construyen variantes: **A/B testing** (canary con foco en métricas de negocio), **dark launch** (deploy sin exposición), **shadow traffic** (mirror para validar sin impactar) y **progressive delivery** (canary + análisis automatizado + rollback).

**Rolling update** es el default de Kubernetes Deployment. La estrategia respeta dos parámetros: `maxUnavailable` (cuántas pods pueden estar down durante el rollout) y `maxSurge` (cuántas pods extra puede crear). Con defaults 25% + 25%, K8s crea 25% más pods v2, espera `readinessProbe` OK, mata 25% de pods v1, repite. Coste mínimo de infra (~25% surge temporal); riesgo si `readinessProbe` está mal configurada (K8s cree que el pod está ready antes de tiempo y rutea tráfico a algo roto). Rollback lento: `kubectl rollout undo` desencadena otro rolling update en sentido inverso (minutos). Durante el rollout conviven v1 y v2 sirviendo tráfico, así que la app **debe** ser backward-compatible.

**Blue/green** mantiene dos ambientes de producción idénticos: blue (v1 actual, sirviendo tráfico) y green (v2 nuevo, sin tráfico). Cuando green está sano, se hace **cutover instantáneo** (típicamente en 1 segundo) cambiando el target del load balancer, del Service, del Gateway o del DNS (peor opción por caching). Rollback es flip inverso, también instantáneo. Coste: **duplica infra** durante el solapamiento (100% overhead), lo cual en cloud significa pagar 2× EC2/RDS/ELB por horas o días. Popularizado por Netflix con Spinnaker (heredero de Asgard) y AWS CodeDeploy tiene modo blue/green nativo. En 2026 sigue siendo elección de banking, healthcare y sistemas donde el rollback instantáneo justifica el coste.

**Canary release** despliega v2 al lado de v1 con un porcentaje pequeño del tráfico (5-10% típicamente), monitoriza métricas por T minutos y progresa (25%, 50%, 100%) o hace rollback si algo degrada. Su fortaleza es **blast radius controlado**: un bug en v2 solo impacta al N% de usuarios hasta que la promoción se aborta. En 2026 lo natural es **progressive delivery**: **Argo Rollouts 1.9+** (con CRD `Rollout` que reemplaza `Deployment`) o **Flagger 1.44+** (con `Canary` CRD que orquesta encima de `Deployment` estándar) automatizan la progresión. Analizan métricas de Prometheus/Datadog/CloudWatch, cambian pesos en `VirtualService` (Istio), `HTTPRoute` (Gateway API) o `TargetGroup` (ALB), y disparan rollback si error rate, p99 o business KPIs se degradan. Netflix Kayenta (open source desde 2017) usa Mann-Whitney U test para scoring estadístico. En julio 2026 ambos operadores publicaron nuevas versiones (Flagger v1.44.0 el 14 jul, Argo Rollouts v1.9.1 el 17 jul) confirmando el momentum del ecosistema. El impacto en LinguaDev Pro es concreto: rolling para servicios internos low-risk, canary automatizado para el API BFF, blue/green para migraciones de infra críticas (DB primary swap, upgrade K8s major).

---

## 2. Rolling update en Kubernetes (nivel básico)

### 2.1 Mecánica

Un Deployment con 10 réplicas y `strategy.type: RollingUpdate` (default):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: linguadev
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 25%     # hasta 25% (2) pueden estar down
      maxSurge: 25%           # crea hasta 25% (2) extra
  minReadySeconds: 15         # espera 15s tras Ready antes de considerar pod OK
  progressDeadlineSeconds: 600
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.1.0
          ports: [{ containerPort: 8080 }]
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                command: [/bin/sh, -c, "sleep 15"]     # drain graceful
          terminationGracePeriodSeconds: 30
```

Flujo cuando cambiás la imagen a `2.2.0`:

1. K8s crea 2 pods v2 (maxSurge).
2. Espera hasta que 2 estén `Ready` (readinessProbe + minReadySeconds).
3. Mata 2 pods v1 (maxUnavailable), con `SIGTERM`, `preStop` sleep 15s, `terminationGracePeriodSeconds` 30s.
4. Repite hasta que las 10 réplicas son v2.

**Tuning:** `maxUnavailable: 0 + maxSurge: 1` = **lento pero cero degradation** (bueno para servicios críticos). `maxUnavailable: 50% + maxSurge: 50%` = rápido pero degradation temporal.

### 2.2 Comandos esenciales

```bash
# Cambiar imagen
kubectl set image deploy/api api=ghcr.io/linguadev/api:2.2.0 -n linguadev

# Status del rollout
kubectl rollout status deploy/api -n linguadev
kubectl rollout history deploy/api -n linguadev

# Pause y resume
kubectl rollout pause deploy/api -n linguadev
kubectl rollout resume deploy/api -n linguadev

# Rollback
kubectl rollout undo deploy/api -n linguadev
kubectl rollout undo deploy/api --to-revision=3 -n linguadev
```

### 2.3 Trampas comunes

- **`readinessProbe` mal configurada**: K8s considera Ready antes de que app esté lista → tráfico a pod roto → 5xx.
- **Sin `preStop` hook**: `SIGTERM` cuando aún hay conexiones activas → 502.
- **Rollback lento**: `undo` es otro rolling update; para rollback rápido, usá blue/green o Argo Rollouts.
- **Sin backward-compatibility**: v1 y v2 conviven; si v2 requiere una migración destructiva, todo rompe.

---

## 3. Blue/green deployment (nivel medio)

### 3.1 Requisitos

1. Infra que podés duplicar (cloud es lo natural).
2. Stateful concerns resueltos: DB compartida con schema backward-compatible, o migración expand-contract.
3. Sesiones que sobrevivan al switch: sesiones **stateless** (JWT o Redis externo), no en pod memory.
4. Load balancer o DNS que puedas cambiar programáticamente.

### 3.2 Blue/green con Service selector

Truco simple usando K8s Service `selector`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-blue
  namespace: linguadev
spec:
  replicas: 10
  selector: { matchLabels: { app: api, color: blue } }
  template:
    metadata: { labels: { app: api, color: blue } }
    spec:
      containers:
        - { name: api, image: ghcr.io/linguadev/api:2.1.0 }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-green
  namespace: linguadev
spec:
  replicas: 10
  selector: { matchLabels: { app: api, color: green } }
  template:
    metadata: { labels: { app: api, color: green } }
    spec:
      containers:
        - { name: api, image: ghcr.io/linguadev/api:2.2.0 }
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: linguadev
spec:
  selector: { app: api, color: blue }     # cutover: cambiar a green
  ports: [{ port: 80, targetPort: 8080 }]
```

Cutover:

```bash
kubectl patch svc api -n linguadev \
  -p '{"spec":{"selector":{"app":"api","color":"green"}}}'
```

Rollback: patch inverso.

### 3.3 Blue/green con Argo Rollouts

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api
  namespace: linguadev
spec:
  replicas: 10
  strategy:
    blueGreen:
      activeService: api-active
      previewService: api-preview
      autoPromotionEnabled: false            # promoción manual
      scaleDownDelaySeconds: 300             # blue vive 5 min tras cutover
      prePromotionAnalysis:
        templates:
          - templateName: success-rate
        args:
          - name: service-name
            value: api-preview.linguadev.svc.cluster.local
      postPromotionAnalysis:
        templates:
          - templateName: success-rate
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.2.0
          ports: [{ containerPort: 8080 }]
```

`autoPromotionEnabled: false` bloquea el cutover hasta `kubectl argo rollouts promote api`. `prePromotionAnalysis` corre métricas contra el preview service **antes** del cutover.

### 3.4 Cost trade-offs

- Duplicás EC2 durante la ventana (100% overhead temporal).
- Si compartís DB/caché/ELB, no los duplicás pero necesitás backward-compat.
- Si duplicás también DB (Aurora clone), coste sube significativamente.
- Netflix depreció blue/green interno en favor de canary por coste a scale.

---

## 4. Canary + progressive delivery (nivel avanzado)

### 4.1 Canary con Istio + Argo Rollouts

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api-canary
  namespace: linguadev
spec:
  replicas: 10
  strategy:
    canary:
      canaryService: api-canary
      stableService: api-stable
      trafficRouting:
        istio:
          virtualServices:
            - name: api-vs
              routes: [primary]
          destinationRule:
            name: api-dr
            canarySubsetName: canary
            stableSubsetName: stable
      steps:
        - setWeight: 5
        - pause: { duration: 10m }
        - analysis:
            templates:
              - templateName: success-rate
              - templateName: latency-p99
            args:
              - { name: service-name, value: api-canary }
        - setWeight: 25
        - pause: { duration: 10m }
        - setWeight: 50
        - pause: { duration: 10m }
        - setWeight: 100
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.2.0
          ports: [{ containerPort: 8080 }]
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
  namespace: linguadev
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate
      interval: 1m
      count: 5
      successCondition: result[0] >= 0.99
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.istio-system:9090
          query: |
            sum(rate(istio_requests_total{
              destination_service_name="{{args.service-name}}",
              response_code!~"5.."
            }[1m])) /
            sum(rate(istio_requests_total{
              destination_service_name="{{args.service-name}}"
            }[1m]))
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: latency-p99
  namespace: linguadev
spec:
  args:
    - name: service-name
  metrics:
    - name: p99
      interval: 1m
      count: 5
      successCondition: result[0] < 500
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.istio-system:9090
          query: |
            histogram_quantile(0.99,
              sum(rate(istio_request_duration_milliseconds_bucket{
                destination_service_name="{{args.service-name}}"
              }[1m])) by (le)
            )
```

Si algún analysis falla → rollback automático a stable.

### 4.2 Canary con Flagger

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: api
  namespace: linguadev
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api                            # NO reemplaza Deployment
  service:
    port: 80
    targetPort: 8080
    gateways: [linguadev-gw.gateway-system.svc]
    hosts: [api.linguadev.app]
  analysis:
    interval: 1m
    threshold: 5                         # fallos consecutivos para abort
    maxWeight: 50
    stepWeight: 10
    metrics:
      - name: request-success-rate
        thresholdRange: { min: 99 }
        interval: 1m
      - name: request-duration
        thresholdRange: { max: 500 }
        interval: 1m
    webhooks:
      - name: load-test
        url: http://flagger-loadtester.test/
        timeout: 5s
        metadata:
          cmd: "hey -z 1m -q 20 -c 4 http://api-canary.linguadev/v1/health"
```

Flagger no reemplaza `Deployment`: crea shadow deployment y switchea gradualmente.

### 4.3 Kayenta / Automated Canary Analysis

Netflix Kayenta usa Mann-Whitney U test para comparar distribuciones canary vs baseline y producir un **score 0-100**. Threshold decide promote/rollback. Detecta regresiones sutiles que un threshold absoluto no captura (ej: p99 similar pero p99.9 degradado). Integración típica: Spinnaker + Kayenta + Prometheus/Atlas.

### 4.4 SLO burn rate como trigger

Google SRE Workbook capítulo 5: alertas basadas en **burn rate del error budget**. Si el canary está quemando error budget más rápido que sustainable:

- **Fast burn** (`>14.4x`): alerta en minutos → rollback inmediato.
- **Slow burn** (`>1x`): alerta en horas → investigar.

Integrable con Argo Rollouts y Flagger via Prometheus queries.

### 4.5 A/B testing vs canary

Misma tecnología (traffic splitting) pero **propósito distinto**:

| Aspecto | Canary | A/B Testing |
|---|---|---|
| Duración | Minutos-horas | Días-semanas |
| Métricas | Técnicas (SLI: latency, errors) | Negocio (conversion, revenue) |
| Assignment | % random | Cohort estable por user_id |
| Endpoint | Full rollout o rollback | Selección de variante ganadora |
| Herramientas | Argo Rollouts, Flagger | Optimizely, Split, LaunchDarkly |

### 4.6 Feature flags, dark launches, shadow traffic

- **Feature flag**: `if config.get('new_checkout_flow') { ... }`. Rollout por usuario, geo, plan. LaunchDarkly, Unleash, GrowthBook, Flipt.
- **Dark launch**: deploy con flag OFF. Código productivo sin exposición → validar warm caches, mediciones sin usuarios.
- **Shadow traffic (mirror)**: copia del tráfico real enviada a v2 sin bloquear al usuario. Istio `mirror` o `Duplicator` filter Envoy. Ideal para validar comportamiento con carga real sin riesgo.

### 4.7 Automated rollback triggers

Combinables:

1. **Error rate spike**: >3× baseline en ventana rolling.
2. **Latency degradation**: p99 canary >1.5× p99 baseline durante ventana sostenida.
3. **SLO burn rate**: fast burn >14x.
4. **Business metrics**: conversion, revenue rate.
5. **Custom Prometheus queries**: cualquier métrica que expongas.

**Anti-patrón:** rollback si cualquier alerta firing (false correlation). Solo triggers **del canary vs baseline**.

---

## 5. Ejemplo práctico: LinguaDev Pro con Argo Rollouts canary + expand-contract DB

Escenario: desplegar `api:2.2.0` que renombra columna `user_name` → `username` en DB. Canary 5→25→50→100% con analysis. Migración DB con expand-contract en 4 deploys previos.

### Paso 1: expand DB schema

```sql
-- Deploy 1 (v2.0.0): añadir columna sin remover vieja
ALTER TABLE users ADD COLUMN username VARCHAR(255);
CREATE INDEX CONCURRENTLY idx_users_username ON users(username);
```

### Paso 2: v2.0.0 escribe a ambas columnas

```python
# app.py v2.0.0
def create_user(name):
    db.execute("INSERT INTO users (user_name, username) VALUES (%s, %s)", (name, name))
```

Rollout con rolling update estándar. Sin cambios visibles.

### Paso 3: backfill

```sql
UPDATE users SET username = user_name WHERE username IS NULL;
```

Ejecutar con `pg_batch` en background (chunks de 10 000).

### Paso 4: v2.1.0 lee de nueva columna, sigue escribiendo a ambas

Rollout con canary Argo Rollouts:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api
  namespace: linguadev
spec:
  replicas: 10
  strategy:
    canary:
      canaryService: api-canary
      stableService: api-stable
      trafficRouting:
        istio:
          virtualServices: [{ name: api-vs, routes: [primary] }]
          destinationRule: { name: api-dr, canarySubsetName: canary, stableSubsetName: stable }
      steps:
        - setWeight: 5
        - pause: { duration: 5m }
        - analysis:
            templates: [{ templateName: success-rate }, { templateName: latency-p99 }]
        - setWeight: 25
        - pause: { duration: 10m }
        - analysis:
            templates: [{ templateName: success-rate }, { templateName: latency-p99 }]
        - setWeight: 50
        - pause: { duration: 10m }
        - setWeight: 100
      abortScaleDownDelaySeconds: 30
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.1.0
          ports: [{ containerPort: 8080 }]
```

### Paso 5: v2.2.0 ignora columna vieja

Rollout canary. Ahora `user_name` no se lee ni escribe.

### Paso 6: contract DB schema

```sql
-- Solo después de validar v2.2.0 en 100% durante días
ALTER TABLE users DROP COLUMN user_name;
```

### Paso 7: verificación durante el rollout

```bash
kubectl argo rollouts get rollout api -n linguadev --watch
# Muestra progresión, weights actuales, analysis results

# Métricas Prometheus
istioctl dashboard prometheus
# Query: sum(rate(istio_requests_total{destination_service_name="api-canary",response_code=~"5.."}[1m]))

# Rollback manual si detectás algo
kubectl argo rollouts abort api -n linguadev
kubectl argo rollouts undo api -n linguadev

# Promoción manual (si `pause: {}` sin duration)
kubectl argo rollouts promote api -n linguadev
```

### Paso 8: shadow traffic para v2.3.0 experimental

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: api-vs
  namespace: linguadev
spec:
  hosts: [api]
  http:
    - route:
        - destination: { host: api, subset: stable }
          weight: 100
      mirror: { host: api, subset: shadow }
      mirrorPercentage: { value: 100 }
```

100% del tráfico real se copia a `api-shadow` (v2.3.0) sin afectar al usuario. Comparás métricas offline.

---

## 6. Cheatsheet, reglas mentales, anti-patrones

### Reglas de oro

- ✅ Rolling update por default en K8s si el servicio es low-risk.
- ✅ Blue/green cuando el rollback instantáneo justifica el coste (banking, healthcare).
- ✅ **Canary con progressive delivery** (Argo Rollouts o Flagger) para high-risk.
- ✅ `readinessProbe` correcta es requisito para cualquier estrategia sin downtime.
- ✅ `preStop` hook + `terminationGracePeriodSeconds` para graceful shutdown.
- ✅ Sesiones **stateless** (JWT o Redis externo) o `terminationGracePeriodSeconds` largo.
- ✅ DB migrations con **expand-contract** en múltiples deploys.
- ✅ Cutover con **LB o Service Mesh** (<1 s); nunca solo DNS (TTL caching).
- ✅ Analysis con métricas técnicas + business (no solo error rate).
- ✅ SLO burn rate como trigger avanzado.
- ✅ Rollback **automático** por default; promotion manual con approval.
- ✅ Feature flags para desacoplar deploy de release.
- ✅ Shadow traffic para validar comportamiento sin riesgo.
- ✅ Post-mortems de rollouts fallidos alimentan analysis templates.

### Anti-patrones

- ❌ Rolling update sin `readinessProbe` → tráfico a pods rotos.
- ❌ Blue/green olvidando duplicar DB o caches y expect backward-compat.
- ❌ Canary de "1 semana" — eso es A/B testing, no canary.
- ❌ Rollback **manual** siempre (`Ops` tiene que despertar a las 3 AM).
- ❌ Migrations destructivas mid-deploy (`ALTER TABLE ... DROP`).
- ❌ Cutover con DNS solo (TTL caching prolonga la transición).
- ❌ Sticky sessions con state en pod memory (usuarios pierden sesión en cada deploy).
- ❌ Single-metric threshold sin baseline (false positives constantes).
- ❌ Rollback trigger por cualquier alerta firing (false correlation).
- ❌ Argo Rollouts + Flagger simultáneamente (elegí uno).
- ❌ Ignorar `abortScaleDownDelaySeconds` (pods v2 desaparecen antes de que Prom vea las métricas del error).

### Tabla decisión

| Necesidad | Estrategia 2026 |
|---|---|
| Servicio interno low-risk | Rolling update K8s |
| API pública high-risk con métricas | Canary + Argo Rollouts/Flagger |
| Rollback instantáneo obligatorio | Blue/green (con Argo Rollouts) |
| Cambio incremental UI | Feature flags (LaunchDarkly, Unleash) |
| Validar v2 sin exponer | Dark launch (flag OFF) o shadow traffic |
| Comparar KPIs de negocio | A/B testing (Optimizely, Split) |
| Migración DB backward-incompat | Expand-contract multi-deploy |
| Cutover blue/green | LB target group o Service selector patch |

---

## 7. Casos reales industria 2023-2026

**Netflix Spinnaker + Kayenta:** desde 2017 orquesta canary automatizado multi-cloud con análisis estadístico Mann-Whitney U. **Lección:** el analysis científico supera thresholds hardcoded.

**Amazon con blue/green y canary:** AWS CodeDeploy tiene ambos modos nativos. Amazon.com hace rollback automático si order success rate degrada. **Lección:** business metrics como trigger de rollback.

**Google Borg schedules canary tasks separadamente:** Google usa canary extensivamente en Borg (padre de K8s). **Lección:** el patrón nace de decadas de experiencia SRE.

**Facebook Gatekeeper:** feature flags + canary por cohort de users. Gatekeeper es el sistema interno de rollout gradual. **Lección:** cohortes estables (mismo user siempre ve la misma variante) son requisito de A/B testing serio.

**GitHub gh-ost:** herramienta de online schema changes que evita locks largos. Publicada open source. **Lección:** DB migrations en producción sin downtime son un arte específico.

**Argo Rollouts v1.9.1 (17 jul 2026) y Flagger v1.44.0 (14 jul 2026):** las dos herramientas maduras publicaron releases con tres días de diferencia; Argo Rollouts v1.10.0-rc1 (3 jul 2026) introduce RolloutPlugin CRD para extender a StatefulSets y DaemonSets. **Lección:** ecosistema progressive delivery está vivo y competitivo.

**Reddit outage 2019 por DNS TTL:** cutover blue/green con DNS TTL de 5 min → users vieron old version 30 minutos por resolvers agresivos. **Lección:** DNS es la peor opción de cutover; usá LB o mesh.

**Ericsson 2018:** cert expirado tumbó redes 4G — no es blue/green pero muestra por qué la ejecución operacional importa tanto como la estrategia. **Lección:** deployment strategy no salva de operational failures.

**Airbnb A/B testing riguroso (ERF, Experimentation Reporting Framework):** semanas de duración, statistical significance real. **Lección:** A/B testing sin statistical power = teatro de datos.

**Stripe expand-contract discipline:** cada schema change es 3+ PRs planeadas semanas antes. **Lección:** disciplina schema-migration paga en años sin outages.

**Cloudflare rolling out edge software a scale:** cambios progresivos por PoP con analytics real-time. **Lección:** rollout a scale requiere observability first-class.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Rolling update con readinessProbe correcta

**Objetivo:** desplegar `httpbin` con 6 réplicas, actualizar imagen con rolling y verificar cero downtime.

**Pasos:**
1. Deployment con `maxUnavailable: 1`, `maxSurge: 2`, `readinessProbe` HTTP + `preStop` sleep 15s.
2. Ejecutar `hey -z 60s -c 10 http://httpbin/get` en background.
3. `kubectl set image` a la nueva versión durante el load test.
4. Medir: 0 respuestas 5xx.

**Criterios de éxito:**
- [ ] `hey` reporta 0 fallos.
- [ ] `kubectl rollout status` OK sin timeout.
- [ ] `kubectl rollout undo` funciona.

**Bonus:** repetir con `maxUnavailable: 0 + maxSurge: 1` y comparar tiempo.

---

### Ejercicio 2: Blue/green con Service selector patch

**Objetivo:** dos Deployments (blue v1, green v2) + un Service. Cutover con `kubectl patch` en <1s.

**Pasos:**
1. Deploy `api-blue` y `api-green`.
2. Service con `selector: color=blue`.
3. Load test continuo.
4. `kubectl patch svc api -p '{"spec":{"selector":{"color":"green"}}}'`.
5. Medir tiempo y errores.

**Criterios de éxito:**
- [ ] Cutover <1s.
- [ ] Cero 5xx en load test.
- [ ] Rollback con patch inverso instantáneo.

**Bonus:** hacerlo con Argo Rollouts `Rollout` blueGreen strategy.

---

### Ejercicio 3: Canary Argo Rollouts + Istio + analysis Prometheus

**Objetivo:** desplegar canary con steps 5→25→50→100%, analysis por success-rate y p99, y verificar rollback automático cuando se inyecta un pod que responde 500s.

**Pasos:**
1. `Rollout` con `trafficRouting.istio` y `AnalysisTemplate`s.
2. Deploy v2 saludable, ver progresión completa hasta 100%.
3. Deploy v2 defectuoso (responde 500 en 20% de requests).
4. Ver que analysis dispara `Degraded` y hace rollback automático.

**Criterios de éxito:**
- [ ] `kubectl argo rollouts get rollout` muestra progresión step-by-step.
- [ ] Rollout defectuoso aborta en el primer analysis fallido.
- [ ] Prometheus query devuelve métricas correctas.

**Bonus:** añadí un `webhook` que dispare Slack en cada step.

---

### Ejercicio 4: Feature flag + dark launch con Unleash

**Objetivo:** deployar `api:3.0.0` con nueva feature `new_checkout_flow` OFF por default, activar gradualmente por user segment.

**Pasos:**
1. Instalar Unleash (open source).
2. Definir feature flag `new_checkout_flow` con estrategia `gradualRolloutUserId`.
3. Deploy `api:3.0.0` con `if unleash.isEnabled('new_checkout_flow', context)`.
4. Rollout con flag 0%.
5. Subir gradualmente a 10%, 50%, 100% desde el UI de Unleash sin redeploy.

**Criterios de éxito:**
- [ ] Deploy 3.0.0 no cambia comportamiento (flag OFF).
- [ ] Activación 10% impacta ~10% de user IDs consistentemente (mismo user siempre ve la misma variante).
- [ ] Rollback = flag OFF (<1s).

**Bonus:** añadir kill switch para desactivar todos los flags de un servicio a la vez.

---

### Ejercicio 5 (bonus): Expand-contract DB migration real

**Objetivo:** renombrar columna `email_addr` → `email` en Postgres sin downtime, en 5 deploys.

**Pasos:**
1. Deploy 1: `ALTER TABLE users ADD COLUMN email VARCHAR(255)`.
2. Deploy 2: app escribe a ambas columnas.
3. Backfill: `UPDATE users SET email = email_addr WHERE email IS NULL` con chunks.
4. Deploy 3: app lee de `email`, sigue escribiendo a ambas.
5. Deploy 4: app ignora `email_addr`.
6. Deploy 5: `ALTER TABLE users DROP COLUMN email_addr`.

**Criterios de éxito:**
- [ ] Cero errores en cada deploy.
- [ ] Rollback posible en cualquier paso previo al DROP.
- [ ] Métricas de latencia estables.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [argoproj.github.io/argo-rollouts](https://argoproj.github.io/argo-rollouts/) — Argo Rollouts 1.9+.
- [flagger.app/docs](https://flagger.app/docs/) — Flagger 1.44+.
- [kubernetes.io/docs/concepts/workloads/controllers/deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/) — rolling update.
- [martinfowler.com/bliki/BlueGreenDeployment.html](https://martinfowler.com/bliki/BlueGreenDeployment.html) — patrón original.
- [Netflix Kayenta](https://github.com/spinnaker/kayenta) — automated canary analysis.

**Herramientas:**
- **kubectl-argo-rollouts** plugin para status y control.
- **k6, hey, fortio** para load testing.
- **LaunchDarkly, Unleash, Flipt, GrowthBook** para feature flags.
- **Spinnaker** para orquestación multi-cloud con Kayenta.

**Referencias:**
- Martin Fowler — *BlueGreenDeployment*, *ParallelChange*.
- Google SRE Workbook cap. 5 — *Alerting on SLOs*.
- Netflix Tech Blog — *Kayenta*, *Automated Canary Analysis*.
- Nicole Forsgren et al. — *Accelerate* (DORA metrics: deployment frequency, lead time, MTTR, change failure rate).

**Siguientes pasos:**
- Completá los 5 ejercicios.
- Elegí un servicio de LinguaDev Pro y migralo a canary con Argo Rollouts.
- Definí SLO + burn rate alerting para triggers automáticos.
- Continuá con [Capítulo 33 — Progressive Delivery con Flagger y Argo Rollouts](./33-progressive-delivery-flagger-argo-rollouts.md) para profundizar.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades junior → staff. Cubren: definición de blue/green, rolling update K8s, canary release, cost tradeoffs, A/B testing vs canary, automated rollback triggers, cutover strategy (DNS/LB/Mesh), session/state durante cutover, DB schema expand-contract, feature flags, dark launches, shadow traffic, Argo Rollouts vs Flagger, Kayenta analysis.

- **Fuente:** [`packages/content/src/tech/devops/sim-32-blue-green-canary-rolling.json`](../../packages/content/src/tech/devops/sim-32-blue-green-canary-rolling.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-32-blue-green-canary-rolling`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 31 — mTLS, Zero Trust y seguridad de red](./31-network-security-mtls-zero-trust.md) · [Índice](./README.md) · [Capítulo 33 — Progressive Delivery: Flagger y Argo Rollouts →](./33-progressive-delivery-flagger-argo-rollouts.md)
