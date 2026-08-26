# Capítulo 33 — Progressive Delivery: Flagger y Argo Rollouts

> **Focus:** Cómo pasar de "canary manual con pausas" a **progressive delivery real**: rollouts declarativos, análisis automatizado de métricas, promoción o rollback sin humano, integración con service mesh e ingress, webhooks para load-tests y notificaciones.
> **Áreas:** Deployment strategies · Automated canary analysis · Kubernetes controllers
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Estrategias base de deploy: blue/green, canary, rolling (ver [cap 32](./32-blue-green-canary-rolling.md)).
- Kubernetes fundamentals: Deployment, ReplicaSet, Service (cap 07/08).
- Networking en K8s: Ingress y Gateway API (cap 09).
- Observability: Prometheus + PromQL (cap 17), Grafana (cap 18).
- GitOps: ArgoCD y Flux (cap 15) — el contexto natural donde vive progressive delivery.
- Service mesh conceptual: Istio o Linkerd, VirtualService, DestinationRule.

**Glosario mínimo:**
- **Progressive delivery**: evolución de continuous delivery donde el rollout es **gradual y automatizado con analysis de métricas**. Término acuñado por James Governor (RedMonk) en 2018.
- **Canary release**: exponer una nueva versión a un subset pequeño de tráfico antes de promoverla al 100%.
- **Argo Rollouts**: controller K8s (Argoproj/CNCF) que reemplaza `Deployment` con un CRD `Rollout` con canary, blue-green y `AnalysisTemplate`. En 2026 v1.9.x estable y v1.10 en RC.
- **Flagger**: operator K8s (originalmente Weaveworks, ahora Flux/CNCF sandbox) que orquesta progressive delivery **encima** de `Deployment` nativos usando un CRD `Canary`. En 2026 v1.44+.
- **AnalysisTemplate / MetricTemplate**: recurso declarativo que define queries (Prometheus/Datadog/NewRelic/CloudWatch/webhook) con `successCondition` y `failureCondition`.
- **Kayenta**: motor OSS de Netflix para automated canary analysis basado en Mann-Whitney U test (comparación estadística entre canary y baseline).
- **Traffic router**: componente que hace el weight-based split. Puede ser Istio (`VirtualService`), Linkerd (SMI `TrafficSplit`), NGINX Ingress, AWS ALB, Gateway API `HTTPRoute`, Envoy Gateway.
- **Webhook analysis**: hook HTTP que Flagger/Argo llaman durante el rollout para ejecutar smoke tests, load tests (k6, Gatling, Locust) o validaciones custom.
- **KEDA**: Kubernetes Event-Driven Autoscaler. Se integra con canary para escalar la nueva versión según eventos (Kafka lag, SQS depth), útil para workloads asincrónicos.

**Setup mínimo:**

```bash
# 1. Cluster local con kind
kind create cluster --name delivery

# 2. Istio 1.24+ (o Linkerd) para traffic splitting
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.24.1 sh -
./istio-1.24.1/bin/istioctl install --set profile=demo -y
kubectl label namespace default istio-injection=enabled

# 3. Argo Rollouts 1.9.x
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f \
  https://github.com/argoproj/argo-rollouts/releases/download/v1.9.1/install.yaml

# 4. Plugin kubectl argo rollouts
curl -LO https://github.com/argoproj/argo-rollouts/releases/download/v1.9.1/kubectl-argo-rollouts-linux-amd64
chmod +x kubectl-argo-rollouts-linux-amd64
sudo mv kubectl-argo-rollouts-linux-amd64 /usr/local/bin/kubectl-argo-rollouts

# 5. Alternativa: Flagger 1.44 con Flux
helm repo add flagger https://flagger.app
helm upgrade -i flagger flagger/flagger \
  --namespace flagger-system --create-namespace \
  --set meshProvider=istio \
  --set metricsServer=http://prometheus.istio-system:9090 \
  --version 1.44.0

# 6. Prometheus (viene con Istio demo) + Grafana
kubectl apply -f ./istio-1.24.1/samples/addons/prometheus.yaml
kubectl apply -f ./istio-1.24.1/samples/addons/grafana.yaml
```

---

## 1. El gran cuadro

Continuous delivery clásico termina la conversación en "el pipeline llegó a producción". Progressive delivery reinicia la conversación ahí: el hecho de que un binario haya aterrizado en el cluster no significa que los usuarios lo vean, ni que la organización haya aceptado el riesgo asociado. **Deploy y release son dos eventos distintos**. Progressive delivery formaliza esa distinción con cinco pilares: (1) **feature flags** para desacoplar rollout de release —tema del cap 34—; (2) **progressive rollout** con canary o blue-green gradual; (3) **observability** de primera clase para saber qué está pasando; (4) **experimentation** capabilities para A/B tests; y (5) **automated analysis** que decide promoción o rollback sin humano en el loop.

En Kubernetes en 2026, dos proyectos dominan la implementación: **Argo Rollouts** (Intuit → Argoproj → CNCF Incubating) y **Flagger** (Weaveworks → Flux → CNCF Sandbox). Ambos hacen conceptualmente lo mismo —canary, blue/green, análisis automatizado, integración con service mesh— pero con filosofías opuestas. Argo Rollouts **reemplaza** el `Deployment` nativo con un CRD `Rollout`: te obliga a cambiar tus manifiestos pero te da control fino con un plugin CLI, dashboard propio, integración profunda con Argo CD, y `AnalysisTemplate` parametrizable. Flagger **no reemplaza nada**: pones un CRD `Canary` que referencia tu `Deployment` normal, y Flagger orquesta detrás copiando el Deployment, escalando el copy, ajustando pesos del `VirtualService`, corriendo `MetricTemplate` y promoviendo. Es más simple, menos invasivo y encaja natural con Flux GitOps.

El corazón compartido es el **automated canary analysis (ACA)**. En vez de "espera 30 minutos y sigue", los rollouts modernos preguntan cada 30 segundos-2 minutos: *¿el success rate del canary está por encima del 95%? ¿el p99 no degradó más de 1.5x? ¿el CPU no subió el 3x? ¿los pedidos por segundo se mantienen?* Si sí, promueve al siguiente step. Si no, aborta y hace rollback. Netflix elevó el estado del arte con **Kayenta**, que en lugar de thresholds fijos compara distribuciones enteras entre canary y baseline con el test estadístico de Mann-Whitney U, produciendo un score 0-100. Argo Rollouts y Flagger no incluyen Kayenta pero permiten arquitecturas equivalentes: ambos tienen `AnalysisTemplate`/`MetricTemplate` que consultan Prometheus, Datadog, NewRelic, CloudWatch, InfluxDB, Dynatrace, Graphite, y aceptan webhooks arbitrarios.

El resultado práctico en 2026 es que empresas como Adobe, IBM, Airbnb, GoDaddy, Intuit, Twilio, y Trend Micro han estandarizado uno de los dos para todos sus servicios productivos. La combinación típica es **GitOps tool + rollout controller + service mesh + Prometheus + notificaciones a Slack**: Argo CD + Argo Rollouts + Istio + Prometheus + Slack, o Flux + Flagger + Linkerd + Prometheus + Slack. Los pipelines de CI dejaron de contener lógica de deploy: solo empujan una nueva imagen y una nueva versión de manifiesto al repo, el resto sucede en el cluster de forma declarativa, con analysis, con rollback automático y con notificaciones humanas solo cuando algo falla. Este capítulo cubre ambos tools con YAML real, patrones de `AnalysisTemplate` con Prometheus, integración con service mesh, webhooks para load-tests, y ejercicios verificables sobre LinguaDev Pro.

---

## 2. Argo Rollouts: instalación, canary básico y CLI (nivel básico)

### 2.1 El CRD Rollout

Un `Rollout` es idéntico a un `Deployment` excepto por `spec.strategy`, que en lugar de `RollingUpdate` acepta `canary` o `blueGreen`. Todo lo demás —template, selector, replicas, resources, probes— funciona igual:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: linguadev-api
  namespace: prod
spec:
  replicas: 5
  revisionHistoryLimit: 3
  selector:
    matchLabels: { app: linguadev-api }
  template:
    metadata:
      labels: { app: linguadev-api }
    spec:
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.4.0
          ports: [{ containerPort: 8080 }]
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 5
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 512Mi }
  strategy:
    canary:
      steps:
        - setWeight: 10
        - pause: { duration: 2m }
        - setWeight: 25
        - pause: { duration: 5m }
        - setWeight: 50
        - pause: { duration: 5m }
        - setWeight: 100
```

Sin `trafficRouting`, Argo Rollouts hace **replica-based canary**: si `replicas: 5` y `setWeight: 20`, crea 1 pod del canary y mantiene 4 del stable. El K8s Service round-robin distribuye ~20% del tráfico al canary. Es aproximado (no exacto) pero funciona sin service mesh.

### 2.2 Verificación con el CLI plugin

```bash
# Ver estado en tiempo real
kubectl argo rollouts get rollout linguadev-api -n prod --watch

# Salida típica:
# Name:            linguadev-api
# Namespace:       prod
# Status:          Paused
# Message:         CanaryPauseStep
# Strategy:        Canary
#   Step:          1/7
#   SetWeight:     10
#   ActualWeight:  10
# Images:          ghcr.io/linguadev/api:2.3.0 (stable)
#                  ghcr.io/linguadev/api:2.4.0 (canary)
# Replicas:
#   Desired:       5
#   Current:       6
#   Updated:       1
#   Ready:         6
#   Available:     6

# Promover manualmente al siguiente step
kubectl argo rollouts promote linguadev-api -n prod

# Abortar y rollback
kubectl argo rollouts abort linguadev-api -n prod

# Deshacer aborto (retry)
kubectl argo rollouts retry rollout linguadev-api -n prod

# Dashboard local
kubectl argo rollouts dashboard
# abre http://localhost:3100
```

### 2.3 Trigger de un nuevo rollout

Igual que con `Deployment`: cambio en `spec.template` (nueva imagen). Argo Rollouts detecta el hash del PodTemplate, crea un ReplicaSet nuevo (canary) y aplica el `strategy.canary.steps`:

```bash
kubectl argo rollouts set image linguadev-api api=ghcr.io/linguadev/api:2.5.0 -n prod
# el rollout pausa en el primer step automáticamente
```

### 2.4 Trampas frecuentes en canary básico

- **`revisionHistoryLimit` muy bajo (default 10; recomendado 3)** deja demasiados ReplicaSets viejos y confunde debugging.
- **Sin `readinessProbe`**, los pods "listos" incluso rotos reciben tráfico → el canary parece bueno cuando no lo es.
- **`replicas: 3` con `setWeight: 10`** no puede crear 0.3 pods: Argo Rollouts redondea. Con pocos replicas usá pesos "gruesos" (25, 50) o pasá a traffic routing con service mesh.
- **Sin `analysis` ni `pause`**, `setWeight: 100` de inmediato → esto no es progressive delivery.

---

## 3. Flagger: la alternativa opinionated (nivel medio)

### 3.1 Filosofía y CRD Canary

Flagger no toca tu `Deployment`. Creás un `Canary` que lo referencia, y Flagger:

1. Crea un `Deployment` copy (`-primary`).
2. Crea `Services` (`-canary` y `-primary`) y un `VirtualService` (Istio) o `TrafficSplit` (SMI).
3. Cuando detecta cambio en el `Deployment` original, escala el original (ahora canary) y avanza pesos según `analysis.stepWeight`.
4. En cada intervalo ejecuta las `MetricTemplate` y decide.
5. Si passes, promueve (copia el spec al `-primary`, escala canary a 0, resetea pesos).

Manifest completo Flagger:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: linguadev-api
  namespace: prod
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: linguadev-api
  progressDeadlineSeconds: 600
  service:
    port: 80
    targetPort: 8080
    gateways: [istio-system/public-gateway]
    hosts: [api.linguadev.app]
  analysis:
    interval: 30s
    threshold: 5       # nº de checks fallidos antes de abort
    maxWeight: 50      # tope de canary weight
    stepWeight: 10     # incremento por iteración
    metrics:
      - name: request-success-rate
        thresholdRange: { min: 99 }
        interval: 1m
      - name: request-duration
        thresholdRange: { max: 500 }
        interval: 1m
    webhooks:
      - name: acceptance-test
        type: pre-rollout
        url: http://flagger-loadtester.test/
        timeout: 30s
        metadata:
          type: bash
          cmd: "curl -sd 'test' http://linguadev-api-canary.prod/token | grep token"
      - name: load-test
        type: rollout
        url: http://flagger-loadtester.test/
        timeout: 5s
        metadata:
          cmd: "hey -z 1m -q 10 -c 2 http://linguadev-api-canary.prod/"
      - name: slack-notify
        type: event
        url: http://slack-webhook-relay.prod/canary
```

`request-success-rate` y `request-duration` son **built-in metrics** de Flagger: consultan Prometheus con queries que Flagger provee. Podés añadir custom vía `MetricTemplate` (siguiente sección).

### 3.2 MetricTemplate custom

Para métricas específicas del negocio o de infra:

```yaml
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: not-found-percentage
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.istio-system:9090
  query: |
    100 - sum(
      rate(
        istio_requests_total{
          reporter="destination",
          destination_workload_namespace="{{ namespace }}",
          destination_workload=~"{{ target }}",
          response_code!="404"
        }[{{ interval }}]
      )
    )
    /
    sum(
      rate(
        istio_requests_total{
          reporter="destination",
          destination_workload_namespace="{{ namespace }}",
          destination_workload=~"{{ target }}"
        }[{{ interval }}]
      )
    ) * 100
```

Referenciada desde el Canary:

```yaml
    metrics:
      - name: not-found-percentage
        templateRef:
          name: not-found-percentage
          namespace: flagger-system
        thresholdRange: { max: 5 }
        interval: 1m
```

### 3.3 Estrategias soportadas en Flagger

| Estrategia | Semántica | Cuándo usarla |
|---|---|---|
| **Canary** | Weight-based progressive rollout | Default para servicios web |
| **A/B testing** | Header-based (`x-canary: insider`) | Beta users, dogfooding |
| **Blue/Green** | Full flip via Service selector | High-SLO services con capacity extra |
| **Blue/Green mirroring** | Copia real de tráfico al canary sin usar respuestas | Debug pre-release con tráfico real, latency-sensitive |

Ejemplo A/B con header:

```yaml
  analysis:
    interval: 1m
    threshold: 5
    iterations: 10
    match:
      - headers:
          x-canary: { exact: "insider" }
      - sourceLabels:
          user-agent: { regex: ".*BetaClient.*" }
    metrics:
      - name: request-success-rate
        thresholdRange: { min: 99 }
        interval: 1m
```

### 3.4 Argo Rollouts vs Flagger: tabla de decisión

| Criterio | Argo Rollouts | Flagger |
|---|---|---|
| Cambia tu `Deployment` | Sí (a `Rollout` CRD) | No |
| GitOps recomendado | Argo CD | Flux |
| CLI dedicado | `kubectl argo rollouts` | `kubectl flagger` (limited) |
| Dashboard oficial | Sí | Grafana templates |
| Estrategias | Canary, Blue/Green | Canary, A/B, Blue/Green, Mirror |
| Traffic providers | Istio, Linkerd, SMI, NGINX, ALB, Gateway API, Ambient, App Mesh | Istio, Linkerd, App Mesh, NGINX, Gloo, Contour, Traefik, Skipper, Kuma, Gateway API |
| Metric providers | Prometheus, Datadog, NewRelic, Wavefront, CloudWatch, Web, Job, Kubernetes, InfluxDB, Graphite, SkyWalking, Google Cloud | Prometheus, Datadog, NewRelic, InfluxDB, Dynatrace, CloudWatch, Stackdriver, Graphite, custom webhook |
| Análisis reutilizable | `AnalysisTemplate` + `ClusterAnalysisTemplate` con `args` | `MetricTemplate` (menos parametrizable) |
| Complejidad de adopción | Media (cambios en manifests) | Baja (solo añadir Canary CRD) |
| Community 2026 | Mayor (CNCF Incubating, más contributors) | Menor pero muy sólida (CNCF Sandbox) |

Regla de dedo 2026: **si ya usás Argo CD → Argo Rollouts**; **si ya usás Flux → Flagger**. En greenfield sin preferencia, Argo Rollouts tiene más momentum, ecosistema y features avanzadas (ephemeral labels, plugin API, experiment CRD).

---

## 4. Automated Canary Analysis con Prometheus (nivel avanzado)

### 4.1 AnalysisTemplate parametrizable en Argo Rollouts

Un template central reutilizado por N Rollouts:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ClusterAnalysisTemplate
metadata:
  name: web-service-canary
spec:
  args:
    - name: service-name
    - name: prometheus-url
      value: http://prometheus.monitoring:9090
    - name: success-rate-threshold
      value: "0.95"
    - name: p99-threshold-ms
      value: "500"
  metrics:
    - name: success-rate
      interval: 30s
      count: 10
      successCondition: result[0] >= {{args.success-rate-threshold}}
      failureLimit: 2
      provider:
        prometheus:
          address: "{{args.prometheus-url}}"
          query: |
            sum(rate(
              http_requests_total{
                service="{{args.service-name}}",
                code!~"5.."
              }[2m]
            ))
            /
            sum(rate(
              http_requests_total{
                service="{{args.service-name}}"
              }[2m]
            ))
    - name: p99-latency
      interval: 30s
      count: 10
      successCondition: result[0] <= {{args.p99-threshold-ms}}
      failureLimit: 2
      provider:
        prometheus:
          address: "{{args.prometheus-url}}"
          query: |
            histogram_quantile(0.99,
              sum(rate(
                http_request_duration_ms_bucket{
                  service="{{args.service-name}}"
                }[2m]
              )) by (le)
            )
    - name: cpu-usage-ratio
      interval: 1m
      count: 5
      successCondition: result[0] <= 1.5
      failureLimit: 1
      provider:
        prometheus:
          address: "{{args.prometheus-url}}"
          query: |
            (
              sum(rate(container_cpu_usage_seconds_total{pod=~"{{args.service-name}}-.*",container!=""}[2m]))
              by (pod)
            )
            /
            avg_over_time(
              (sum(rate(container_cpu_usage_seconds_total{pod=~"{{args.service-name}}-primary-.*",container!=""}[2m])))[10m:]
            )
```

Uso desde un `Rollout`:

```yaml
spec:
  strategy:
    canary:
      steps:
        - setWeight: 10
        - pause: { duration: 2m }
        - analysis:
            templates:
              - templateName: web-service-canary
                clusterScope: true
            args:
              - name: service-name
                value: linguadev-api
              - name: success-rate-threshold
                value: "0.98"
        - setWeight: 50
        - pause: { duration: 5m }
        - analysis:
            templates:
              - templateName: web-service-canary
                clusterScope: true
            args:
              - name: service-name
                value: linguadev-api
        - setWeight: 100
```

### 4.2 Background analysis vs inline analysis

Dos modos de correr `AnalysisRun`:

- **Inline** (dentro de `steps`): solo evalúa entre steps, corre un tiempo fijo.
- **Background**: paralelo al rollout entero, corre desde inicio hasta promoción. Aborta inmediato si falla en cualquier momento.

```yaml
spec:
  strategy:
    canary:
      analysis:                          # <-- background (fuera de steps)
        templates:
          - templateName: web-service-canary
            clusterScope: true
        startingStep: 2                  # empieza tras alcanzar step 2
        args:
          - name: service-name
            value: linguadev-api
      steps:
        - setWeight: 5
        - pause: { duration: 2m }
        - setWeight: 25
        - pause: { duration: 5m }
        - setWeight: 100
```

### 4.3 Analysis providers "más allá de Prometheus"

**Datadog:**

```yaml
    - name: dd-error-rate
      provider:
        datadog:
          apiVersion: v2
          interval: 5m
          query: |
            sum:trace.http.request.errors{service:linguadev-api,version:{{args.canary-hash}}}.as_rate()
      successCondition: result <= 0.01
```

**Web (endpoint arbitrario):**

```yaml
    - name: bakerystack-check
      provider:
        web:
          url: https://validator.internal/api/canary-ready/{{args.rollout-name}}
          jsonPath: "{$.status}"
      successCondition: result == "healthy"
```

**Job (ejecuta un Job de K8s que retorna exit code):**

```yaml
    - name: smoke-tests
      provider:
        job:
          spec:
            template:
              spec:
                restartPolicy: Never
                containers:
                  - name: smoke
                    image: ghcr.io/linguadev/e2e-runner:1.4
                    args: ["--target", "https://canary.api.linguadev.app"]
```

Combinar N providers en un solo template da **defense in depth**: Prometheus para telemetría, Job para tests de aceptación, Web para validación externa (feature flags service, dependencias).

### 4.4 Estilo Kayenta con Argo/Flagger

Kayenta (Netflix, OSS) compara distribuciones canary vs baseline con Mann-Whitney U y produce un score. Ni Argo Rollouts ni Flagger incluyen Kayenta por default en 2026, pero podés replicar los principios:

1. **Baseline paralelo**: en vez de comparar canary contra "producción histórica", corré un tercer ReplicaSet **baseline** con la versión estable pero recibiendo el mismo tráfico del canary (headers de shadow, o traffic mirroring).
2. **Query normalizada por baseline**:

```promql
# canary p99 relativo al baseline
histogram_quantile(0.99, sum(rate(http_duration_bucket{version="canary"}[2m])) by (le))
/
histogram_quantile(0.99, sum(rate(http_duration_bucket{version="baseline"}[2m])) by (le))
```

3. **Múltiples métricas con weights**: cada `metric` en `AnalysisTemplate` es un check independiente. Que "todo pase" es AND lógico.
4. **Statistical significance externa**: si necesitás Mann-Whitney real, un `Job` provider puede correr un script Python con `scipy.stats.mannwhitneyu` y retornar exit code.

En 2026 Google Cloud Deploy tiene ACA integrado. AWS CodeDeploy tiene canary limitado. Spinnaker sigue siendo el único con Kayenta first-class.

---

## 5. Ejemplo práctico: LinguaDev Pro API con Argo Rollouts + Istio + Slack

Despliegue end-to-end del API en `prod` con canary 10→25→50→100, análisis Prometheus, webhook a Slack.

### Paso 1: namespace, Service, DestinationRule, VirtualService

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: prod
  labels: { istio-injection: enabled }
---
apiVersion: v1
kind: Service
metadata:
  name: linguadev-api
  namespace: prod
spec:
  selector: { app: linguadev-api }
  ports: [{ port: 80, targetPort: 8080, name: http }]
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: linguadev-api
  namespace: prod
spec:
  host: linguadev-api
  subsets:
    - name: stable
      labels: { app: linguadev-api }
    - name: canary
      labels: { app: linguadev-api }
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: linguadev-api
  namespace: prod
spec:
  hosts: [linguadev-api]
  http:
    - route:
        - destination:
            host: linguadev-api
            subset: stable
          weight: 100
        - destination:
            host: linguadev-api
            subset: canary
          weight: 0
```

### Paso 2: Rollout con trafficRouting + analysis + notifications

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: linguadev-api
  namespace: prod
spec:
  replicas: 6
  strategy:
    canary:
      canaryService: linguadev-api-canary
      stableService: linguadev-api-stable
      trafficRouting:
        istio:
          virtualService:
            name: linguadev-api
            routes: [primary]
          destinationRule:
            name: linguadev-api
            canarySubsetName: canary
            stableSubsetName: stable
      steps:
        - setWeight: 10
        - pause: { duration: 2m }
        - analysis:
            templates:
              - templateName: web-service-canary
                clusterScope: true
            args:
              - name: service-name
                value: linguadev-api
        - setWeight: 25
        - pause: { duration: 3m }
        - analysis:
            templates:
              - templateName: web-service-canary
                clusterScope: true
            args:
              - name: service-name
                value: linguadev-api
        - setWeight: 50
        - pause: { duration: 5m }
        - setWeight: 100
  selector:
    matchLabels: { app: linguadev-api }
  template:
    metadata:
      labels: { app: linguadev-api }
    spec:
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.4.0
          ports: [{ containerPort: 8080 }]
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
```

### Paso 3: notificaciones a Slack (argo-rollouts-notifications)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-rollouts-notification-configmap
  namespace: argo-rollouts
data:
  service.slack: |
    token: $slack-token
  template.rollout-aborted: |
    message: |
      [Rollout] {{.rollout.metadata.name}} in {{.rollout.metadata.namespace}} ABORTED
      Revision: {{.rollout.status.currentPodHash}}
      Failure step: {{.rollout.status.currentStepIndex}}
      Reason: {{.rollout.status.abort}}
    slack:
      attachments: |
        [{
          "color": "#E96D76",
          "fields": [{"title": "Rollout", "value": "{{.rollout.metadata.name}}"}]
        }]
  trigger.on-rollout-aborted: |
    - when: rollout.status.abort == true
      send: [rollout-aborted]
---
apiVersion: v1
kind: Secret
metadata:
  name: argo-rollouts-notification-secret
  namespace: argo-rollouts
stringData:
  slack-token: xoxb-your-slack-bot-token
```

Y el Rollout suscribe:

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-rollout-aborted.slack: "canary-alerts"
    notifications.argoproj.io/subscribe.on-rollout-completed.slack: "deploys"
```

### Paso 4: KEDA + Rollout para workload event-driven

Un consumer Kafka con canary basado en lag:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: linguadev-consumer
  namespace: prod
spec:
  scaleTargetRef:
    apiVersion: argoproj.io/v1alpha1
    kind: Rollout
    name: linguadev-consumer
  minReplicaCount: 2
  maxReplicaCount: 20
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.prod:9092
        consumerGroup: linguadev
        topic: user.events
        lagThreshold: "50"
```

KEDA escala el `Rollout` según lag de Kafka, y Argo Rollouts hace el canary paralelo con analysis sobre `kafka_consumergroup_lag`.

### Paso 5: trigger del rollout

```bash
kubectl argo rollouts set image linguadev-api api=ghcr.io/linguadev/api:2.5.0 -n prod
kubectl argo rollouts get rollout linguadev-api -n prod --watch
```

Observás en Grafana los weights subiendo, en Slack las notificaciones, y en Prometheus los checks pasando o fallando.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Deploy ≠ release**. Progressive delivery es la implementación técnica del principio.
- ✅ Elegí una herramienta y estandarizala en toda la org: **Argo Rollouts** (Argo CD) o **Flagger** (Flux).
- ✅ Usá `AnalysisTemplate`/`MetricTemplate` **parametrizado** con `args`, no uno por servicio.
- ✅ Definí `ClusterAnalysisTemplate` centrales owned por platform team.
- ✅ Composición de métricas: success rate **AND** latency **AND** business KPI.
- ✅ `interval: 30s-2m`, `count: 5-10`, `failureLimit: 1-2` para tolerar spikes transitorios.
- ✅ Rate/ratio SIEMPRE, nunca counters absolutos (canary tiene menos tráfico).
- ✅ Compará canary contra stable/baseline paralelo, no contra histórico.
- ✅ Webhook `pre-rollout` para smoke tests, `rollout` para load-tests (k6, hey, vegeta).
- ✅ Notificaciones a Slack para `on-rollout-aborted` y `on-rollout-completed`.
- ✅ `revisionHistoryLimit: 3` (default 10 es excesivo).
- ✅ Steps más pequeños y más análisis en servicios críticos; más rápido en internos/staging.
- ✅ Traffic routing con Istio/Linkerd/Gateway API si necesitás pesos exactos; replica-based si no.
- ✅ `progressDeadlineSeconds`/`progressDeadline` para timeouts globales.
- ✅ Post-mortem cada rollback automatizado: ¿fue false positive del análisis o bug real?

### Anti-patrones

- ❌ Canary sin `analysis`, solo `pause`: es "canary manual con más pasos".
- ❌ `AnalysisTemplate` con threshold fijo copiado de otro servicio sin baseline.
- ❌ Comparar canary con métricas absolutas (`sum(errors)`) sin normalizar por tráfico.
- ❌ Metric queries sin filtro `code!~"5.."` que cuentan 4xx como fallo del servidor.
- ❌ `failureLimit: 0` (aborta al primer spike) → toneladas de false positives.
- ❌ `interval: 5m` en un servicio con deploys de 5 minutos → un check total, sin poder de detección.
- ❌ Notification spam a canales productivos (usá canales dedicados).
- ❌ Tener Argo Rollouts pero seguir usando `kubectl set image deployment/x`: no aplica strategy.
- ❌ Mezclar Argo Rollouts + `Deployment` para el mismo workload (conflicto de owner).
- ❌ Ignorar el `Rollout.status.abort`: si aborta, el rollout queda paused hasta `retry`.
- ❌ Analysis solo con Prometheus mientras las alertas críticas viven en Datadog.

### Tabla mental "elijo qué"

| Situación | Recomendación |
|---|---|
| Argo CD ya en producción | Argo Rollouts |
| Flux ya en producción | Flagger |
| Multi-tenant PaaS reconciled | Flagger (headless) |
| Servicios muy heterogéneos con analysis complejo | Argo Rollouts + AnalysisTemplate |
| Header-based A/B con beta users | Flagger (más simple) |
| Blue/Green con instant flip | Ambos, Argo Rollouts `blueGreen` strategy es más clásico |
| Workloads Kafka/SQS con canary | Argo Rollouts + KEDA `ScaledObject` |
| Sin service mesh | Argo Rollouts replica-based o Flagger + NGINX Ingress |

---

## 7. Casos reales industria 2023-2026

**Adobe (Argo Rollouts + Istio, 2022-2026):** Adobe estandarizó Argo Rollouts para sus micro-servicios en Kubernetes multi-región. Usan `ClusterAnalysisTemplate` centrales owned por platform team, con métricas de Prometheus + business KPIs de sus servicios de Creative Cloud. **Lección:** governance central + self-service templates escala.

**Intuit (creador de Argo Rollouts, 2019-2026):** Intuit open-sourceó Argo Rollouts. Documentan que redujeron incidents relacionados con deploys ~60% en servicios que adoptaron el pattern. Usan Argo CD + Argo Rollouts + Prometheus como stack default. **Lección:** progressive delivery bien implementado es un multiplicador de MTTR/DORA metrics.

**Airbnb (Istio + Argo Rollouts):** Airbnb usa canary con weight-based via Istio en sus servicios críticos (booking, payments). Steps conservadores (1%→5%→25%→50%→100% con análisis largo). **Lección:** para servicios críticos, tiempo de rollout no es coste — es aseguramiento.

**Flagger + Flux en Trend Micro, Twilio, WooCommerce (2022-2026):** empresas que ya tenían Flux estandarizaron Flagger. Reportan que la instalación "invisible" (sin cambiar `Deployment`) redujo fricción con equipos que ya tenían pipelines maduros. **Lección:** el modelo no-invasivo de Flagger es su killer feature para brownfield.

**GoDaddy (Argo Rollouts a escala):** más de 500 rollouts activos concurrentes. Publicaron blog posts sobre debugging de `AnalysisRun` fallidos en escala. **Lección:** observability de Argo Rollouts en sí (métricas del controller, colas de reconciliación) es tan importante como las métricas de negocio.

**Google Cloud Deploy con ACA (2023-2026):** Google integró canary analysis nativo en Cloud Deploy. Confirma que ACA es feature standard esperada en 2026, no experimento. **Lección:** hyperscalers están adoptando el pattern; los equipos que sigan haciendo canary manual quedan atrás.

**Netflix Spinnaker + Kayenta:** siguen siendo el estado del arte en statistical canary analysis. En 2026, con equipos que salen de Netflix a otras empresas, patterns Kayenta influencian implementaciones custom en Argo Rollouts. **Lección:** el techo del canary analysis es statistical significance, no thresholds.

**Ticketmaster (Flagger en eventos de alto tráfico):** durante lanzamientos de tours grandes usan canary con pesos muy chicos (1%) porque cualquier bug se amplifica. Flagger + Datadog + smoke tests via webhooks. **Lección:** en eventos de tráfico spike, "cero canary" es tentador pero peor — canary chiquito es mejor que ninguno.

**GitOps + Progressive Delivery combinados (industria 2024-2026):** patrón cada vez más común: PR merge → Argo CD sincroniza → Argo Rollouts hace canary → notification a Slack → PR auto-cierra con resultado. Full trazabilidad. **Lección:** progressive delivery + GitOps es la stack de referencia 2026.

**Fallo típico documentado: false positive de análisis por métricas ruidosas.** Numerosos post-mortems públicos (2023-2025) mencionan rollbacks automáticos por métricas con baseline ruidoso (spikes de latency por GC). Fix habitual: `failureLimit >= 2`, `interval` largo suficiente, comparar canary con baseline paralelo. **Lección:** analysis mal calibrado erosiona confianza en el sistema; validá los templates antes de meterlos en producción.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Instalar Argo Rollouts y hacer un canary básico

**Objetivo:** desplegar un servicio con `strategy.canary` de 4 steps y observar la promoción.

**Setup:** cluster kind, Argo Rollouts 1.9.x instalado, plugin `kubectl argo rollouts`.

**Pasos:**
1. Creá namespace `demo`.
2. Aplicá un `Rollout` con `nginx:1.27` como imagen y steps `[10, pause 30s, 25, pause 30s, 50, pause 30s, 100]`.
3. `kubectl argo rollouts get rollout ... --watch` en otra terminal.
4. `kubectl argo rollouts set image` con `nginx:1.28`.
5. Observá la progresión.

**Criterios de éxito:**
- [ ] El rollout pausa en cada step.
- [ ] `Status: Paused` visible en el CLI.
- [ ] `Actual weight` coincide con `SetWeight`.
- [ ] La promoción completa deja un solo ReplicaSet activo.
- [ ] `kubectl argo rollouts abort` deshace y vuelve a la imagen anterior.

**Bonus:** activá el dashboard local (`kubectl argo rollouts dashboard`) y verificá el histograma visual.

---

### Ejercicio 2: AnalysisTemplate parametrizado con Prometheus

**Objetivo:** crear un `ClusterAnalysisTemplate` reutilizable que checkee success rate y p99 latency.

**Setup:** Prometheus instalado, un `Rollout` corriendo con métricas expuestas (`http_requests_total`, `http_request_duration_ms_bucket`).

**Pasos:**
1. Crear `ClusterAnalysisTemplate` con args `service-name`, `success-threshold`, `p99-ms`.
2. Query success rate `sum(rate(http_requests_total{service='{{args.service-name}}',code!~"5.."}[2m])) / sum(rate(http_requests_total{service='{{args.service-name}}'}[2m]))`.
3. Query p99 con `histogram_quantile`.
4. `successCondition: result[0] >= {{args.success-threshold}}`.
5. Añadir el template al `Rollout.spec.strategy.canary.steps` entre setWeight 25 y 50.
6. Forzar un canary "malo" (imagen que retorna 500 al 20% de requests) y verificar rollback automático.

**Criterios de éxito:**
- [ ] `AnalysisRun` creado durante el step de analysis.
- [ ] `Status: Successful` en canary bueno.
- [ ] `Status: Failed` + rollout `Aborted` en canary malo.
- [ ] Los args aparecen resueltos en `kubectl describe analysisrun`.

**Bonus:** añadir tercer metric (CPU usage), y verificar que el rollout aborta si CPU sube 3x sobre baseline.

---

### Ejercicio 3: Flagger con Istio + webhook a k6

**Objetivo:** desplegar el mismo servicio con Flagger y ejecutar un load test durante el canary.

**Setup:** Flagger 1.44+ instalado, Istio, `flagger-loadtester` desplegado.

**Pasos:**
1. Crear `Deployment` normal `hello-world:v1`.
2. Crear `Canary` CRD referenciándolo, `stepWeight: 20`, `maxWeight: 60`.
3. Webhook `rollout` que corre `hey -z 1m -q 20 -c 4 http://hello-world-canary.demo/`.
4. Cambiar la imagen a `hello-world:v2` y observar `kubectl -n demo get canary hello-world -o yaml`.
5. Verificar que Flagger avanza pesos y ejecuta el webhook.

**Criterios de éxito:**
- [ ] `Canary.status.phase` pasa por `Progressing → Promoting → Succeeded`.
- [ ] El pod loadtester muestra logs de `hey` corriendo.
- [ ] `VirtualService` weights cambian en cada iteración.
- [ ] Al final, `-primary` Deployment tiene la nueva imagen.

**Bonus:** simular un canary "malo" (deployment con 10% error rate) y verificar que Flagger auto-rollback.

---

### Ejercicio 4: Notificaciones a Slack + Datadog en rollout aborted

**Objetivo:** conectar Argo Rollouts al canal `#canary-alerts` en Slack con `on-rollout-aborted` y a un dashboard Datadog con métricas del rollout.

**Setup:** workspace Slack + bot token, cuenta Datadog opcional.

**Pasos:**
1. Crear `ConfigMap` `argo-rollouts-notification-configmap` con template `rollout-aborted`.
2. Crear `Secret` con token de Slack.
3. Anotar el `Rollout` con `notifications.argoproj.io/subscribe.on-rollout-aborted.slack: "canary-alerts"`.
4. Forzar rollback (imagen con bug).
5. Confirmar mensaje en el canal.
6. Adicional: crear widget en Datadog con métrica `argo_rollouts_reconcile_duration_seconds` del controller.

**Criterios de éxito:**
- [ ] Mensaje llega a Slack con revisión + step + reason.
- [ ] `kubectl argo rollouts get rollout` muestra `Aborted`.
- [ ] Widget Datadog muestra reconciliaciones.

**Bonus:** template custom con campos de Datadog link + PR link.

---

### Ejercicio 5 (bonus): Migrar `Deployment` a `Rollout` sin downtime

**Objetivo:** convertir un `Deployment` existente a `Rollout` sin interrumpir tráfico.

**Setup:** un `Deployment` con 4 replicas expuesto por Service.

**Pasos:**
1. Crear un `Rollout` idéntico al `Deployment` con `strategy.canary` de dos steps `[50, pause, 100]` y `workloadRef` apuntando al `Deployment`.
2. Argo Rollouts asume ownership del `Deployment` sin recrear pods.
3. Aplicar y verificar que no hay churn.
4. Después, mover PodSpec al `Rollout.spec.template` y eliminar el `Deployment`.
5. Confirmar tráfico continuo.

**Criterios de éxito:**
- [ ] Sin restarts durante la migración.
- [ ] `Rollout.status.readyReplicas == 4`.
- [ ] `Deployment` eliminado, `Rollout` gestiona 100% de los pods.

**Bonus:** documentar el runbook interno para el equipo.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [argoproj.github.io/argo-rollouts](https://argoproj.github.io/argo-rollouts/) — Argo Rollouts 1.9+.
- [docs.flagger.app](https://docs.flagger.app) — Flagger 1.44+.
- [github.com/argoproj/argo-rollouts/releases](https://github.com/argoproj/argo-rollouts/releases) — release notes.
- [kayenta.io](https://spinnaker.io/docs/guides/user/canary/) — canary analysis en Spinnaker.

**Repos y ejemplos:**
- [argoproj/argo-rollouts — /examples](https://github.com/argoproj/argo-rollouts/tree/master/examples) — YAML samples oficiales.
- [fluxcd/flagger — /examples](https://github.com/fluxcd/flagger/tree/main/kustomize) — kustomize samples.

**Herramientas complementarias:**
- **Prometheus / Grafana** — métricas y dashboards.
- **flagger-loadtester** — pods listos para `hey`, `k6`, `ghz`.
- **k6 / Vegeta / Gatling** — load testing usados en webhooks.
- **argo-rollouts-notifications** — engine de notificaciones.
- **KEDA** — event-driven autoscaling integrado con `Rollout`.

**Referencias adicionales:**
- James Governor (RedMonk), "Towards Progressive Delivery" (2018).
- Netflix Tech Blog, "Automated Canary Analysis at Netflix with Kayenta".
- KubeCon EU/NA 2024-2025 sessions sobre Argo Rollouts y Flagger.

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Auditá tus deploys: ¿tenés `AnalysisTemplate` reales o solo `pause`?
- Estandarizá `ClusterAnalysisTemplate` central para toda la org.
- Continuá con [cap 34 — Feature Flags a escala](./34-feature-flags-at-scale.md) que completa el otro pilar de progressive delivery.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios de progressive delivery en producción. Cubren: definición y pillars, Argo Rollouts vs Flagger, Kayenta y statistical analysis, PromQL para canary analysis, `AnalysisTemplate` parametrizados, background vs inline analysis, integración con Istio (`VirtualService` + `DestinationRule`), blue/green con Argo Rollouts, providers alternativos (Datadog, Web, Job), webhooks para load-tests, KEDA + Rollouts, notificaciones a Slack, y trampas comunes.

- **Fuente:** [`packages/content/src/tech/devops/sim-33-progressive-delivery-flagger-argo-rollouts.json`](../../packages/content/src/tech/devops/sim-33-progressive-delivery-flagger-argo-rollouts.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-33-progressive-delivery-flagger-argo-rollouts`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 32 — Blue/Green, Canary, Rolling](./32-blue-green-canary-rolling.md) · [Índice](./README.md) · [Capítulo 34 — Feature Flags a escala →](./34-feature-flags-at-scale.md)
