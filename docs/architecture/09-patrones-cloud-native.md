# Capítulo 09 — Patrones cloud-native

> **Focus:** Kubernetes, service mesh, GitOps, operators y la pregunta incómoda de cuándo NO usar Kubernetes.
> **Áreas:** serverless · microservices · scalability · resilience
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 28 min · **Pass:** 75%
> **Nivel:** Medio → Avanzado (senior/staff)

## 0. Antes de empezar

**Pre-requisitos:**
- Nociones de Kubernetes: Pod, Deployment, Service, Ingress, PVC.
- Familiaridad con al menos un cloud (AWS, GCP, Azure) y con contenedores Docker.
- Idealmente haber leído [Cap 08 — consenso y coordinación](./08-consenso-y-coordinacion.md); etcd es el store del control plane de K8s y muchos patrones aquí dependen de coordinación.

**Glosario mínimo:**
- **12-factor app:** manifiesto de Heroku (2011) con 12 principios para apps cloud-native (config en env vars, procesos stateless, port binding, disposability, etc.).
- **Sidecar:** container adicional en el mismo Pod que comparte network namespace con el principal; añade cross-cutting concerns sin tocar el código.
- **Init container:** container que corre secuencialmente antes del principal (bootstrap, migraciones, wait-for-dependency).
- **Ambassador:** sidecar especializado en proxying outbound (service discovery, adaptation).
- **Adapter:** sidecar especializado en normalizar output (métricas, logs) para consumo externo.
- **Service mesh:** capa de infraestructura que gestiona service-to-service comms (mTLS, retries, tracing) via sidecar o node-level proxy (ambient).
- **Ambient mesh:** modo sidecar-less de Istio (GA en v1.24, nov 2024; multicluster beta en KubeCon EU 2026) que usa ztunnel per-node + waypoints per-servicio.
- **GitOps:** paradigma donde Git es la fuente de verdad del estado deseado; un controller (Argo CD, Flux) reconcilia continuamente el cluster.
- **Operator:** controller custom que watchea CRDs (Custom Resource Definitions) y ejecuta lógica operacional (failover, backup, upgrade) automáticamente.
- **Kustomize:** herramienta de overlays sobre YAML plano; parte de kubectl desde 1.14.
- **Helm:** package manager de Kubernetes (chart = plantilla + values); v4.x actual (nov 2025), v3.x mantenido hasta feb 2027.
- **Readiness vs liveness:** readiness = "listo para tráfico"; liveness = "vivo, no reiniciar". Confundirlas causa cascadas de reinicio.
- **HPA / VPA / KEDA:** autoscalers (Horizontal / Vertical / Event-driven).
- **KRM (Kubernetes Resource Model):** el patrón declarativo de manifests que hace posible GitOps.

**Setup mínimo:**

```bash
# Cluster local: kind (Kubernetes IN Docker) — más simple y CI-friendly que Minikube
brew install kind
kind create cluster --name linguadev --config - <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
- role: worker
- role: worker
- role: worker
EOF

# kubectl y helm 4
brew install kubectl helm
helm version --short   # v4.1.4 (o superior)

# Istio 1.30+ con ambient mode
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.30.0 sh -
./istio-1.30.0/bin/istioctl install --set profile=ambient -y

# Argo CD 3.x
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.0.0/manifests/install.yaml

# Flux 2.x
brew install fluxcd/tap/flux
flux install
```

---

## 1. El gran cuadro

Kubernetes cumplió 10 años en 2024 y en 2026 es infraestructura fundacional: casi cualquier empresa de tecnología con más de 30 ingenieros lo usa en algún nivel (managed EKS/GKE/AKS, self-managed, o edge). El acierto conceptual del proyecto fue estandarizar el **Kubernetes Resource Model (KRM)** — manifests declarativos que describen *estado deseado* — y un reconciliation loop que continuamente lo compara con el estado real y actúa para converger. Ese patrón único subyace a todo: Deployments, StatefulSets, Ingress, cert-manager, Argo CD, cualquier operator. Aprender KRM es aprender Kubernetes; aprender YAML es cosmética.

Sobre ese sustrato han crecido tres olas de patrones. La primera son los **workload patterns** clásicos formalizados por Bilgin Ibryam en *Kubernetes Patterns*: init containers para bootstrap, sidecars para cross-cutting, ambassadors para adaptación de I/O, adapters para normalizar output, operators para stateful services. Estos patrones son lenguaje común de cualquier equipo cloud-native serio. La segunda ola es el **service mesh**: Istio, Linkerd y Cilium resolvieron cómo aplicar mTLS, retries, timeouts, observabilidad y traffic routing sin tocar el código de las aplicaciones. Istio 1.24 (nov 2024) llevó **ambient mode** a GA, eliminando la necesidad de sidecar por pod y reduciendo overhead en clusters grandes; KubeCon Europe 2026 vio la beta de multicluster ambient y la Gateway API Inference Extension. La tercera ola es **GitOps**: Argo CD (ahora 3.3) y Flux (ahora 2.8) hicieron obsoleto el `kubectl apply` manual y convirtieron a Git en la fuente de verdad reconciliada por controllers.

El segundo bloque del capítulo son las **decisiones de configuración y operations** que constantemente aparecen en producción y en entrevistas. Requests vs limits (spoiler: memory sí, CPU típicamente no en 2024-2026), readiness vs liveness (confusion de estas dos causa cascades de reinicio en incidentes), HPA reactivo vs KEDA event-driven, StatefulSet vs Deployment para stateful, node affinity + topology spread para HA multi-AZ, taints + tolerations para dedicated nodes. Cada una parece detalle YAML pero cada una es un multiplicador operacional: mal configurada implica outages, over-provisioning masivo o vulnerabilidades. La comunidad SIG-Node de Kubernetes (Tim Hockin y otros) llevó la conversación pública: hoy la best practice es dejar CPU sin limit y setear solo requests + memory limits, contra la sabiduría convencional de "siempre limits".

El tercer bloque es la pregunta ingenieril honesta: **cuándo NO usar Kubernetes**. El proyecto ha crecido tanto y su ecosystem es tan seductor que ha aparecido "K8s por defecto" como equivalente a "Rails por defecto" en 2010. Para startups pequeñas, para batch jobs esporádicos, para workloads con pocos servicios, para equipos sin SRE dedicado, la overhead operacional puede exceder el value. Alternativas legítimas en 2026: **serverless** (AWS Lambda, Cloud Run, Vercel, Fly.io), **managed container runtimes** (ECS Fargate, App Runner), **PaaS clásicos** (Heroku, Railway, Render). Kubernetes brilla cuando tienes muchos servicios (>15-20), portabilidad multi-cloud, control granular, hardware especializado (GPUs para ML) o cumplimiento estricto. Fuera de eso, es sobreingeniería. El impacto acumulado del capítulo: dominar los patterns, saber elegir GitOps tool, saber diseñar workloads (stateless vs stateful) y ejecutar la decisión honesta de cuándo K8s aporta más de lo que cuesta.

---

## 2. Fundamentos cloud-native (nivel medio)

### 2.1 Doce factores revisitados

El manifiesto **12-Factor** (Heroku 2011) sigue siendo la línea base:

1. **Codebase:** un repo por app, muchos deploys.
2. **Dependencies:** declaradas explícitamente y aisladas (npm/pip/go modules).
3. **Config:** en env vars, nunca en código.
4. **Backing services:** DBs, colas tratadas como recursos attach/detach.
5. **Build, release, run:** fases separadas.
6. **Processes:** stateless, share nothing.
7. **Port binding:** la app expone HTTP por puerto, sin webserver externo.
8. **Concurrency:** escala horizontal con más procesos.
9. **Disposability:** startup rápido, shutdown graceful.
10. **Dev/prod parity:** minimizar diferencias.
11. **Logs:** stdout/stderr como event streams.
12. **Admin processes:** one-off como procesos separados.

Actualizaciones 2024-2026 relevantes (Beyond-the-12): **observability** (los tres pillars: metrics, logs, traces), **API-first** (contratos OpenAPI/gRPC antes que UI), **security by default** (least privilege, secretless architectures con Workload Identity), **telemetry uniforme** (OpenTelemetry). Cualquier app que rompe factores 3 (`.env` en git), 6 (session state en filesystem local) o 11 (logs a archivos que un sidecar debe tail) es inmigrant a Kubernetes.

### 2.2 Sidecar pattern

Cuando necesitas añadir mTLS, retries, tracing, logging estructurado a 50 microservicios en 4 lenguajes distintos, la respuesta cloud-native no es escribir librería en cada lenguaje. Es el **sidecar**: un container adicional en el mismo Pod que maneja los cross-cutting concerns transparentemente. La app habla `localhost:<port>` al sidecar; el sidecar habla al mundo.

Casos canónicos:
- **Service mesh proxy** (Envoy en Istio, `linkerd-proxy` en Linkerd).
- **Log shipping** (Fluent Bit tailing app logs).
- **Config reload** (`consul-template` watching, reload nginx).
- **TLS termination**.
- **Metrics export** (Envoy stats, node_exporter para métricas de host).
- **Secret injection** (Vault Agent).

Ventajas: language-agnostic, ops team owns el sidecar, updates sin tocar código. Coste: ~50-100 MB memoria por Envoy sidecar en cluster de 1000 pods = 50-100 GB. Startup ordering (init container → sidecar → main). Debugging más complejo.

**Native sidecar support** (Kubernetes 1.29 GA, restartPolicy=Always en initContainers) formaliza el patrón y garantiza que el sidecar arranque antes que el main y sobreviva a él en shutdown.

```yaml
apiVersion: v1
kind: Pod
metadata: { name: linguadev-review-api }
spec:
  initContainers:
  - name: envoy   # sidecar nativo (K8s 1.29+): restartPolicy=Always
    image: envoyproxy/envoy:v1.32-latest
    restartPolicy: Always     # lo convierte en sidecar
    ports: [{ containerPort: 15001 }]
    volumeMounts:
    - { name: envoy-config, mountPath: /etc/envoy }
  - name: db-migrate           # init container clásico
    image: linguadev/review-api:1.4.0
    command: ["/app/migrate", "up"]
    env:
    - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: db, key: url } } }
  containers:
  - name: app
    image: linguadev/review-api:1.4.0
    env:
    - { name: HTTP_PROXY, value: "http://127.0.0.1:15001" }
  volumes:
  - { name: envoy-config, configMap: { name: envoy-cfg } }
```

### 2.3 Init containers para bootstrap

Init containers corren **secuencialmente** antes que los main containers. Cada uno debe complete successfully. Usos canónicos:

- **Wait for dependency:** `until pg_isready -h db; do sleep 1; done`.
- **DB migrations:** `rails db:migrate`, `flyway migrate`, `atlas migrate apply`.
- **Secret fetching:** Vault agent init → escribe a shared volume.
- **Config templating:** `envsubst < template > /shared/config.yaml`.
- **Permissions setup:** `chown -R app:app /data`.
- **Model download:** para ML pods, descargar weights antes de arrancar.

```yaml
initContainers:
- name: wait-for-db
  image: postgres:16-alpine
  command: ['sh', '-c', 'until pg_isready -h postgres -U app; do echo "waiting for db"; sleep 2; done']
- name: migrate
  image: linguadev/review-api:1.4.0
  command: ['/app/migrate', 'up']
  env:
  - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: db, key: url } } }
```

Diferencia clave con `postStart` hook: `postStart` corre en background, no bloquea, no garantiza ordering. Init containers **bloquean** hasta success.

### 2.4 Readiness vs liveness (la confusión que causa outages)

Estas dos probes son distintas y confundirlas es fuente frecuente de incidentes:

| Probe | Pregunta | Fallo → efecto |
|---|---|---|
| **liveness** | ¿El proceso está vivo? | Kubelet **reinicia** el container. |
| **readiness** | ¿El proceso está listo para tráfico? | Kubernetes **retira del Service endpoint** (no reinicia). |
| **startup** | ¿Terminó de arrancar? | Retrasa liveness/readiness hasta que success. |

Anti-patrón clásico: usar el mismo endpoint (`/health` que chequea DB) para ambas. Bajo DB slowdown, todas las réplicas fallan liveness → todas reinician → cascade → downtime total. La DB solo debe influir en readiness; liveness debe ser "el proceso responde", nada más.

```yaml
containers:
- name: api
  image: linguadev/review-api:1.4.0
  startupProbe:                         # arranque lento OK
    httpGet: { path: /health, port: 8080 }
    failureThreshold: 30
    periodSeconds: 5                    # hasta 150 s para arrancar
  readinessProbe:                       # chequea deps externas
    httpGet: { path: /ready, port: 8080 }
    initialDelaySeconds: 0
    periodSeconds: 5
    timeoutSeconds: 2
    failureThreshold: 3
  livenessProbe:                        # solo "estoy vivo"
    httpGet: { path: /live, port: 8080 }
    initialDelaySeconds: 60
    periodSeconds: 20
    timeoutSeconds: 3
    failureThreshold: 5
```

En el código de la app:

```ts
// GET /live — solo confirma que el proceso responde
app.get('/live', (_req, res) => res.status(200).send('ok'));

// GET /ready — chequea que estamos listos para tráfico
app.get('/ready', async (_req, res) => {
  try {
    await pg.query('SELECT 1');
    await redis.ping();
    res.status(200).send('ready');
  } catch (e) {
    res.status(503).send('not-ready');
  }
});
```

### 2.5 StatefulSet vs Deployment

| Aspecto | Deployment | StatefulSet |
|---|---|---|
| Naming pods | Random hash | Ordenado: `<sts>-0`, `<sts>-1` |
| DNS estable | No | Sí (via headless Service) |
| PVC | Compartido (o único) | Uno por pod (VolumeClaimTemplates) |
| Rollout | Paralelo | Secuencial (0 → 1 → 2, reverse en scale-down) |
| Uso | Stateless (web, API) | Stateful (DBs, queues, Kafka, etcd) |

Para Postgres primary + 2 replicas necesitas StatefulSet: cada réplica necesita identidad estable para saber su rol (primary/replica), PVC persistente (los datos no se pueden regenerar), rollout ordenado (primero primary, luego replicas). Deployment con volume mount compartido corrompe datos. En la práctica, para stateful workloads en Kubernetes se prefiere un **operator** (CloudNativePG, Zalando Postgres Operator) que envuelva el StatefulSet con lógica de failover, backup y upgrade.

---

## 3. Service mesh, discovery y traffic (nivel senior)

### 3.1 ¿Necesitas service mesh?

Value:
- **mTLS everywhere** sin cambiar código.
- **Retries, circuit breakers, timeouts** uniformes.
- **Traffic routing**: canary, A/B, mirror, splitting por header/percentage.
- **Observability**: distributed tracing (Jaeger, Tempo) + metrics (Prometheus) + access logs uniformes.
- **AuthZ policies** finas por servicio.

Coste:
- Complejidad operacional del control plane.
- Overhead de recursos por sidecar (~50-100 MB Envoy/pod).
- Latencia extra (usualmente <1 ms).
- Curva de aprendizaje: `VirtualService`, `DestinationRule`, `PeerAuthentication`, `AuthorizationPolicy`.

**Regla operativa 2026:** para <20 servicios en un solo lenguaje, biblioteca nativa (Resilience4j, Polly, opossum) es más simple. Para >20 servicios heterogéneos, mesh justifica. Con **ambient mesh** (Istio 1.24 GA, multicluster beta 2026), la overhead del sidecar se reduce significativamente cambiando la ROI.

Opciones en 2026:
- **Istio 1.30+** con ambient: full-featured, CNCF graduate.
- **Linkerd 2.16+**: más simple, más liviano, sidecar-only, CNCF graduate.
- **Cilium Service Mesh**: eBPF-based, sidecar-less, integra networking + observability.
- **Consul Connect**: HashiCorp stack, útil si ya usas Consul.
- **AWS App Mesh** / **Anthos Service Mesh**: managed, cloud-specific.

### 3.2 Istio ambient mode

Ambient rompe el modelo "sidecar por pod" en dos capas:

- **ztunnel** (per-node): daemonset ligero (Rust, mucho menos overhead que Envoy) que maneja L4 mTLS entre pods.
- **waypoint proxies** (per-servicio, opcional): Envoy compartido que maneja L7 (routing, authz, telemetry) para servicios que lo necesiten.

Beneficios: pods sin sidecar, menor overhead, upgrades del data plane sin reiniciar pods. Trade-offs: nueva mental model, herramientas de debug menos maduras que sidecar mode.

Ejemplo config con Gateway API (estándar sucesor de Istio VirtualService, soportado en Istio 1.30+):

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: linguadev-gateway, namespace: linguadev }
spec:
  gatewayClassName: istio
  listeners:
  - name: https
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs: [{ name: linguadev-tls }]
    hostname: "app.linguadev.pro"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: review-api-route, namespace: linguadev }
spec:
  parentRefs: [{ name: linguadev-gateway }]
  hostnames: ["app.linguadev.pro"]
  rules:
  - matches: [{ path: { type: PathPrefix, value: /api/reviews } }]
    backendRefs:
    - { name: review-api, port: 8080, weight: 90 }         # stable
    - { name: review-api-canary, port: 8080, weight: 10 }  # canary 10%
```

Habilitar ambient para un namespace:

```bash
kubectl label namespace linguadev istio.io/dataplane-mode=ambient
# Todos los pods del ns ahora tienen mTLS via ztunnel, sin sidecar
```

### 3.3 Blue-green vs canary

**Blue-green:** dos entornos completos (blue=current, green=new). Deploy green, valida, cambia el traffic al 100%. Rollback = cambio inverso, instantáneo. Coste: 2x recursos durante la transición.

**Canary:** deploy incremental (1% → 5% → 25% → 50% → 100%) validando SLIs entre pasos. Automatización con Flagger o Argo Rollouts. Rollback = revertir el porcentaje.

Recomendación 2026:
- **Blue-green** para releases con schema DB changes irreversibles, o cuando el traffic pattern hace difícil validar con % pequeño.
- **Canary** por defecto para stateless APIs, con auto-rollback basado en métricas.

Ejemplo con Argo Rollouts:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: review-api, namespace: linguadev }
spec:
  replicas: 10
  strategy:
    canary:
      steps:
      - setWeight: 10
      - pause: { duration: 5m }
      - analysis:
          templates: [{ templateName: success-rate }]
          args:
          - { name: service-name, value: review-api }
      - setWeight: 25
      - pause: { duration: 10m }
      - setWeight: 50
      - pause: { duration: 15m }
      - setWeight: 100
  selector: { matchLabels: { app: review-api } }
  template:
    metadata: { labels: { app: review-api } }
    spec:
      containers:
      - name: api
        image: linguadev/review-api:1.4.0
        # readiness/liveness/startup probes...
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: { name: success-rate, namespace: linguadev }
spec:
  args: [{ name: service-name }]
  metrics:
  - name: success-rate
    interval: 60s
    successCondition: result[0] >= 0.99
    failureLimit: 2
    provider:
      prometheus:
        address: http://prometheus.monitoring:9090
        query: |
          sum(rate(http_requests_total{app="{{args.service-name}}",code!~"5.."}[2m]))
          /
          sum(rate(http_requests_total{app="{{args.service-name}}"}[2m]))
```

### 3.4 Ambassador y adapter

**Ambassador:** sidecar que proxya *outbound* traffic para adaptar la app a un mundo dinámico. Uso: app legacy con hostnames hardcoded, protocolo mismatch (app HTTP, backend gRPC), multi-region routing, cross-cluster bridging. Ejemplo original: Netflix Prana bridging Java a Eureka.

**Adapter:** sidecar que normaliza *output* de la app para consumo externo. Uso: log format transformation (app escribe custom → adapter emite Fluentd JSON), métricas standard (app expone `/metrics` custom → adapter traduce a Prometheus), health check exposure para load balancers legacy.

Ambos son casos específicos del sidecar; los distingue el punto de aplicación (outbound vs output).

### 3.5 Service discovery y health checks

**Service** en Kubernetes es abstracción de discovery: label selector + IP virtual (ClusterIP) + kube-proxy load balancing. DNS a través de CoreDNS: `review-api.linguadev.svc.cluster.local` resuelve al ClusterIP.

Health checks a dos niveles:
- **Kubernetes readiness** determina qué pods están en el endpoint del Service.
- **Service mesh** (Istio, Linkerd) puede añadir health-aware LB con outlier detection: el sidecar retira automáticamente endpoints que fallan repetidamente, incluso si K8s aún los considera ready.

Ejemplo `DestinationRule` con outlier detection:

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata: { name: review-api-dr, namespace: linguadev }
spec:
  host: review-api
  trafficPolicy:
    connectionPool:
      tcp: { maxConnections: 100 }
      http: { http2MaxRequests: 1000, maxRequestsPerConnection: 10 }
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
```

### 3.6 HPA, VPA y KEDA

- **HPA (Horizontal Pod Autoscaler):** escala réplicas por métricas (CPU, memoria, métricas custom). Reactivo, lag de 15-90 s.
- **VPA (Vertical Pod Autoscaler):** ajusta requests/limits automáticamente basándose en uso histórico. Bueno para right-sizing; conflictúa con HPA en la misma dimensión.
- **KEDA:** autoscaling event-driven. Escala 0→N basado en eventos externos (Kafka lag, SQS depth, Redis stream length, cron). Ideal para workers de background y para spike patterns.

Ejemplo KEDA para scaler basado en Kafka lag:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: outbox-worker-scaler, namespace: linguadev }
spec:
  scaleTargetRef: { name: outbox-worker }
  minReplicaCount: 1
  maxReplicaCount: 20
  pollingInterval: 15
  cooldownPeriod: 120
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka:9092
      consumerGroup: outbox-worker
      topic: card-events
      lagThreshold: "1000"
```

---

## 4. GitOps, operators y decisiones de config (nivel staff)

### 4.1 GitOps: Argo CD vs Flux

**Argo CD 3.x (2026):** control plane centralizado, RBAC propio, UI rica, multi-cluster hub-and-spoke. En 3.0 (2025) redujo el drift detection de 12 min a ~800 ms con la nueva real-time k8s watch API. 3.3 (2026) es el estado del arte para orgs con muchos clusters gestionados centralmente.

**Flux 2.8 (2026):** decentralizado (un controller por cluster), Kustomize-first, más ligero, integra HelmRelease, Notification Controller, Image Automation. En 2.8 añadió CEL-based health check expressions (paridad con Argo CD) y cancelación de health checks en curso con re-reconciliation instantánea al detectar fix en Git.

Elección práctica:
- **Argo CD** si necesitas UI potente para múltiples equipos, single pane of glass, ApplicationSets para escalar a cientos de apps.
- **Flux** si prefieres approach modular con controllers independientes, Kustomize-first, y menor superficie.

Ambos son CNCF graduate y ambos son válidos. Elige por operational fit, no por "mejor".

Ejemplo Argo CD Application:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: linguadev-review-api
  namespace: argocd
spec:
  project: linguadev
  source:
    repoURL: https://github.com/linguadev/gitops
    targetRevision: main
    path: apps/review-api/overlays/production
  destination:
    server: https://kubernetes.default.svc
    namespace: linguadev
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ApplyOutOfSyncOnly=true
    retry:
      limit: 5
      backoff: { duration: 5s, factor: 2, maxDuration: 3m }
```

Ejemplo Flux Kustomization + HelmRelease:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata: { name: linguadev-gitops, namespace: flux-system }
spec:
  interval: 1m
  url: https://github.com/linguadev/gitops
  ref: { branch: main }
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: { name: review-api, namespace: flux-system }
spec:
  interval: 5m
  path: ./apps/review-api/overlays/production
  prune: true
  sourceRef: { kind: GitRepository, name: linguadev-gitops }
  healthChecks:
  - { apiVersion: apps/v1, kind: Deployment, name: review-api, namespace: linguadev }
  timeout: 3m
```

### 4.2 Helm vs Kustomize

**Helm 4 (nov 2025):** primer major en 6 años. Server-side apply nativo, plugin system WASM-based, mejor UX. Charts como paquete distribuible en OCI registries. v3 sigue con security fixes hasta feb 2027. v3.22.0+ es el último de la línea 3.

**Kustomize (v5.8.1 en 2026):** overlays sobre YAML plano, sin templating. Base + overlays per environment. Mejor interop con Helm 4, fixes de propagación de namespaces. Nativo en kubectl desde 1.14.

Diferencia mental: Helm es **templating** (parametrizar antes de aplicar); Kustomize es **overlay** (parchear después de tener base). Ambos pueden combinarse: Argo CD y Flux permiten `helm template | kustomize build` para lo mejor de los dos mundos.

Recomendación 2026:
- **Charts públicos / distribuibles:** Helm (industria standard, muchos charts en Artifact Hub).
- **Configuración interna por environment:** Kustomize (más simple, menos golem de templating).
- **Mixto:** Helm chart genérico + Kustomize overlay per environment para tweaks específicos.

Ejemplo Kustomize base + overlay:

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
- service.yaml
- hpa.yaml
commonLabels:
  app: review-api

# overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../../base
namespace: linguadev-prod
replicas:
- name: review-api
  count: 10
images:
- name: linguadev/review-api
  newTag: 1.4.0
patches:
- path: resources-prod.yaml
  target: { kind: Deployment, name: review-api }
- path: hpa-prod.yaml
  target: { kind: HorizontalPodAutoscaler, name: review-api }
configMapGenerator:
- name: app-config
  literals:
  - LOG_LEVEL=info
  - FEATURE_FLAG_X=true
```

### 4.3 Operators para stateful workloads

Un **operator** codifica el conocimiento operacional de un servicio complejo como controller que watchea CRDs. Ejemplo canónico: Postgres HA cluster requiere init primary, add replicas, monitor, failover, backups, PITR, PVC management, rolling upgrades. Helm chart no cubre day-2 ops. Operator sí.

Operators de referencia en 2026:
- **cert-manager:** TLS certs (Let's Encrypt, private CAs).
- **Strimzi:** Kafka.
- **CloudNativePG (CNPG):** Postgres HA, backup, PITR, rolling upgrades.
- **Zalando Postgres Operator:** alternativa madura.
- **Elastic Cloud on Kubernetes (ECK):** Elasticsearch, Kibana, APM.
- **Prometheus Operator:** Prometheus + Alertmanager + Grafana.
- **Kyverno / OPA Gatekeeper:** policy enforcement.
- **External Secrets Operator:** secrets desde AWS Secrets Manager / Vault / GCP.

Ejemplo CNPG cluster de Postgres HA con backup a S3:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: linguadev-db, namespace: linguadev }
spec:
  instances: 3           # 1 primary + 2 replicas
  primaryUpdateStrategy: unsupervised
  storage:
    size: 100Gi
    storageClass: gp3
  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "512MB"
      effective_cache_size: "1536MB"
  backup:
    barmanObjectStore:
      destinationPath: s3://linguadev-backups/postgres
      s3Credentials:
        accessKeyId:      { name: aws-creds, key: ACCESS_KEY_ID }
        secretAccessKey:  { name: aws-creds, key: SECRET_ACCESS_KEY }
      wal: { compression: gzip }
      data: { compression: gzip }
    retentionPolicy: "30d"
  monitoring:
    enablePodMonitor: true
```

Este manifest declara intent; CNPG operator hace todo el resto: crea StatefulSet, PVCs, configura replicación streaming, promociona nuevo primary si el actual falla, ejecuta backups programados, monitoriza replication lag y expone métricas Prometheus.

### 4.4 Requests, limits y el debate 2024-2026

**Consenso moderno** (Tim Hockin, SIG-Node, Datadog, Grafana Labs, Zalando):
- **Memory limit:** **obligatorio**. Sin él, un pod con memory leak OOM-killea el node entero, afectando a todos los pods vecinos.
- **CPU limit:** **típicamente no**. Los CPU limits activan CFS throttling incluso cuando el node tiene CPU libre — spikes de latencia p99 evitables. Setea requests correctos (garantía de scheduling) y deja al pod burstear.
- **Requests:** siempre precisos. Definen scheduling y QoS class.

QoS classes:
- **Guaranteed** (requests == limits para todos los recursos): última en ser evicted; puede ejecutar en cores exclusivos con CPU Manager.
- **Burstable** (requests < limits, o solo requests): media prioridad.
- **BestEffort** (sin requests ni limits): primera en ser evicted.

Excepciones donde CPU limits sí tienen sentido:
- Clusters multi-tenant con SLA per tenant y noisy neighbor concern.
- Batch jobs con budget de CPU-hours estricto.
- Testing local donde quieres emular constraint.

```yaml
resources:
  requests:
    cpu: "200m"
    memory: "256Mi"
  limits:
    memory: "512Mi"    # sin CPU limit
```

Métrica a monitorear si mantienes CPU limits: `container_cpu_cfs_throttled_periods_total`. Si es alta consistentemente, el limit está causando daño.

### 4.5 Node affinity, anti-affinity, topology spread

Para HA multi-AZ y placement inteligente:

```yaml
spec:
  affinity:
    # Solo nodos con SSD
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - { key: disktype, operator: In, values: [ssd] }
    # No dos replicas en el mismo node
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels: { app: review-api }
        topologyKey: kubernetes.io/hostname
  # Distribuir uniformemente entre zonas
  topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels: { app: review-api }
```

TopologySpreadConstraints (K8s 1.18+ estable) es preferible a AntiAffinity para "distribuir uniformemente"; AntiAffinity con `hostname` sigue siendo útil para "nunca dos en el mismo node".

Taints y tolerations complementan: dedicar nodos GPU a workloads ML, dedicar spot instances a batch, aislar workloads sensibles.

### 4.6 Cost-aware architecture

En 2026 la conversación FinOps es mainstream. Kubernetes cost tools maduros: **OpenCost** (CNCF), **Kubecost** (comercial), **CAST AI**, **Karpenter** (auto-provisioning inteligente). Patrones cost-aware:

- **Right-sizing:** VPA para pods (recomendaciones), Cluster Autoscaler o Karpenter para nodes.
- **Spot / preemptible instances** para stateless y batch; on-demand para stateful y críticos.
- **Karpenter** (AWS/Azure/GCP): provisiona nodos a demanda con el tipo instance más cost-effective para los pods pendientes, consolida cuando puede.
- **Bin-packing:** requests precisos permiten al scheduler densificar; requests inflados desperdician capacity.
- **Sleep/dev environments:** apagar clusters non-prod fuera de horario laboral con KEDA o CronJob.

Ejemplo Karpenter NodePool para batch en spot:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata: { name: batch-spot }
spec:
  template:
    spec:
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: [spot]
      - key: kubernetes.io/arch
        operator: In
        values: [amd64, arm64]
      taints:
      - key: workload
        value: batch
        effect: NoSchedule
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
  limits: { cpu: 1000, memory: 4000Gi }
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
```

### 4.7 Cuándo NO usar Kubernetes

Kubernetes brilla cuando: >15-20 servicios con necesidad de orquestación uniforme, portabilidad multi-cloud, control granular (scheduling policies, addons custom, hardware específico), SRE dedicado con presupuesto operacional, cumplimiento estricto (workload isolation, network policies, admission controllers).

Es sobreingeniería cuando: startup de <10 servicios (Fly.io, Railway, Render, Vercel, Cloud Run, App Runner cubren el 90%); batch jobs esporádicos (AWS Batch, Cloud Run Jobs, Lambda); sitios estáticos + BFF (Vercel, Netlify, Cloudflare); monolito único (Beanstalk, App Service, Heroku); equipo sin SRE (managed reduce pero no elimina el coste humano).

Patrón sano 2026: empezar con **serverless / managed containers** y migrar a K8s cuando los requisitos lo justifiquen. Migrar *de* K8s a serverless también es válido. LinguaDev Pro: BFF en Lambda + API Gateway + DynamoDB; solo los workers batch FSRS con GPU (embeddings, LLM eval) justifican EKS. **Híbrido intencional** > K8s por defecto.

---

## 5. Ejemplo práctico completo: LinguaDev Pro sobre EKS con GitOps

### Paso 1: bootstrap del cluster con Terraform + eksctl

```bash
# Cluster EKS con Karpenter para autoscaling inteligente
eksctl create cluster --name linguadev-prod --version 1.32 \
  --region eu-west-1 --nodegroup-name system --nodes 2 --node-type m6i.large \
  --with-oidc --managed

# Instalar Karpenter
helm install karpenter oci://public.ecr.aws/karpenter/karpenter --version 1.1.0 \
  --namespace kube-system --create-namespace \
  --set settings.clusterName=linguadev-prod

# Argo CD
kubectl create ns argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.3.0/manifests/install.yaml
```

### Paso 2: repo GitOps con estructura de apps

```
gitops/
├── apps/
│   ├── review-api/
│   │   ├── base/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   └── kustomization.yaml
│   │   └── overlays/production/
│   │       ├── kustomization.yaml
│   │       ├── hpa.yaml
│   │       └── resources.yaml
│   ├── outbox-worker/       # con KEDA scaling
│   ├── fsrs-scheduler/      # singleton con etcd leader election (Cap 08 §5)
│   └── postgres-cnpg/       # cluster HA managed por CNPG
├── platform/
│   ├── cert-manager/
│   ├── external-secrets/
│   ├── prometheus/
│   ├── argo-rollouts/
│   ├── karpenter-nodepools/
│   └── istio-ambient/
└── argocd-apps/
    └── app-of-apps.yaml    # bootstrap único
```

### Paso 3: App-of-apps con ApplicationSet

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata: { name: linguadev-apps, namespace: argocd }
spec:
  generators:
  - git:
      repoURL: https://github.com/linguadev/gitops
      revision: main
      directories:
      - path: apps/*
  template:
    metadata: { name: '{{path.basename}}' }
    spec:
      project: linguadev
      source:
        repoURL: https://github.com/linguadev/gitops
        targetRevision: main
        path: '{{path}}/overlays/production'
      destination:
        server: https://kubernetes.default.svc
        namespace: linguadev
      syncPolicy:
        automated: { prune: true, selfHeal: true }
```

### Paso 4: review-api con canary rollout

```yaml
# apps/review-api/base/rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: review-api }
spec:
  replicas: 6
  strategy:
    canary:
      steps:
      - setWeight: 10
      - pause: { duration: 3m }
      - analysis: { templates: [{ templateName: success-rate }] }
      - setWeight: 30
      - pause: { duration: 5m }
      - setWeight: 60
      - pause: { duration: 5m }
      - setWeight: 100
  selector: { matchLabels: { app: review-api } }
  template:
    metadata: { labels: { app: review-api } }
    spec:
      containers:
      - name: api
        image: linguadev/review-api:1.4.0
        ports: [{ containerPort: 8080 }]
        readinessProbe: { httpGet: { path: /ready, port: 8080 }, periodSeconds: 5 }
        livenessProbe:  { httpGet: { path: /live,  port: 8080 }, periodSeconds: 20 }
        resources:
          requests: { cpu: "200m", memory: "256Mi" }
          limits:   { memory: "512Mi" }
```

### Paso 5: Postgres HA con CNPG y backup a S3

Reutiliza el manifest del §4.3.

### Paso 6: Istio ambient mode habilitado

```bash
istioctl install --set profile=ambient -y
kubectl label namespace linguadev istio.io/dataplane-mode=ambient
# mTLS automático entre todos los pods del namespace, sin sidecars
```

### Paso 7: observabilidad

```bash
# kube-prometheus-stack chart
helm install kube-prom prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --version 66.x

# Loki para logs
helm install loki grafana/loki-stack --namespace monitoring

# Tempo para traces (integra con Istio ambient)
helm install tempo grafana/tempo --namespace monitoring
```

### Paso 8: validar

```bash
# Argo CD sync status
argocd app list

# Rollout status
kubectl argo rollouts get rollout review-api -n linguadev --watch

# Chaos: kill del primary de Postgres
kubectl delete pod -n linguadev linguadev-db-1
kubectl get pods -n linguadev -w    # CNPG promueve nueva primary en <30 s

# Cost: OpenCost dashboard
kubectl port-forward -n opencost svc/opencost 9090
open http://localhost:9090
```

Con este stack: cada commit al repo GitOps se reconcilia automáticamente, cada deploy pasa por canary con auto-rollback, la DB es HA con backup a S3, mTLS everywhere via ambient, observabilidad completa, y cost visible per servicio.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **12-Factor** + observability + API-first + security by default.
- ✅ Memory limits **siempre**; CPU limits **típicamente no**.
- ✅ Readiness ≠ liveness. Nunca uses el mismo endpoint.
- ✅ Init containers para bootstrap; sidecars para cross-cutting.
- ✅ StatefulSet + Operator para stateful; Deployment para stateless.
- ✅ HPA para reactive scaling; KEDA para event-driven scaling.
- ✅ GitOps (Argo CD 3.x o Flux 2.x) como fuente de verdad.
- ✅ Kustomize para overlays internos; Helm para charts distribuibles.
- ✅ Canary con auto-rollback para releases; blue-green cuando el schema cambia.
- ✅ Ambient mesh si tu cluster tiene muchos pods; sidecar mesh si son pocos y quieres L7 uniforme.
- ✅ Karpenter para right-sizing dinámico + spot para batch/stateless.
- ✅ Topology spread constraints para HA multi-AZ.
- ✅ OpenCost / Kubecost para observabilidad de gasto.
- ✅ Empezar con serverless/managed y migrar a K8s cuando lo justifique.

### Anti-patrones

- ❌ CPU limits agresivos causando throttling p99.
- ❌ Un solo endpoint `/health` para readiness y liveness.
- ❌ Sin memory limits — un pod OOM-killea todo el node.
- ❌ Postgres en Deployment con PVC compartido.
- ❌ `kubectl apply` manual en producción.
- ❌ Values.yaml duplicado 20 veces por environment (usa Helm hierarchical o Kustomize).
- ❌ Sidecar por pod cuando ambient mode ya está disponible en tu cluster.
- ❌ Blue-green sin script de rollback probado.
- ❌ Coordination service (etcd/Consul) como base de datos general.
- ❌ Kubernetes para 3 microservicios en una startup de 5 personas.
- ❌ Bloquear todos los crawlers en `robots.txt` bajo la excusa de "seguridad" (sin distinguir search vs training).

### Tabla de decisión: sidecar vs ambient vs sin mesh

| Situación | Recomendación |
|---|---|
| <20 servicios, un solo lenguaje | Sin mesh (biblioteca nativa: Resilience4j, Polly) |
| 20-100 servicios, heterogéneo | Linkerd (más simple) |
| >100 servicios, necesitas L7 avanzado | Istio ambient (menor overhead que sidecar) |
| Necesitas eBPF / networking + observability integrado | Cilium Service Mesh |
| Solo AWS y quieres managed | AWS App Mesh (aunque va perdiendo momentum) |
| Multi-cluster + federation | Istio ambient multicluster (beta 2026) o Consul federation |

### Tabla de decisión: cuándo NO usar Kubernetes

| Situación | Alternativa recomendada |
|---|---|
| Sitio estático + BFF | Vercel, Netlify, Cloudflare Pages/Workers |
| Monolito pequeño | Fly.io, Railway, Render, Heroku |
| Serverless functions | AWS Lambda, Cloud Run, Cloud Functions |
| Batch jobs esporádicos | AWS Batch, Cloud Run Jobs |
| Containers sin orquestación fina | ECS Fargate, App Runner, Cloud Run |
| ML training GPU on-demand | SageMaker, Vertex AI, Modal.com |

---

## 7. Casos reales industria 2020-2026

**Istio ambient GA (nov 2024) y multicluster beta (KubeCon EU 2026):** Istio 1.24 promovió ambient mode a Stable (ztunnel + waypoints). En KubeCon Europe 2026 anunció Gateway API Inference Extension, ambient multicluster beta y experimental agentgateway. Overhead de mesh baja significativamente en clusters grandes.

**Kubernetes 1.32 (dic 2024) y 1.33 (2025):** 1.32 estabilizó native sidecar containers (`restartPolicy: Always` en initContainers), dynamic resource allocation para GPUs, structured authentication. En 2026 la versión soportada activa cubre 1.32 a 1.36.

**Argo CD 3.0/3.3 y Flux 2.8:** Argo CD 3.0 (2025) redujo drift detection de 12 min a 800 ms con real-time watch API; 3.3 (2026) madura ApplicationSets y multi-cluster. Flux 2.8 añadió CEL-based health checks y re-reconciliation instantánea.

**Helm 4 (nov 2025) y etcd 3.6 (may 2025):** Helm 4 trae server-side apply nativo y plugin WASM; Helm 3.22.0+ con security fixes hasta feb 2027. etcd 3.6 (primer minor desde 3.5) añade feature gates y downgrade support; patches 3.6.12 (jun 2026). Ver [Cap 08](./08-consenso-y-coordinacion.md).

**Karpenter GA (2023) y evolución:** provisioning inteligente de nodos AWS/Azure/GCP; en 2026 es de facto en EKS y ganando terreno en GKE/AKS.

**CloudNativePG (2023-2026):** operator Postgres CNCF con backup a S3 (Barman), PITR, replicación streaming, rolling upgrades. Alternativa moderna al Zalando Postgres Operator.

**KubeCon EU 2026:** GenAI workloads en K8s (Gateway API Inference Extension, KServe), FinOps y OpenCost graduate, WASM con containerd shims, supply chain (Sigstore, SLSA).

**Fly.io y Railway (2023-2026):** startups eligiendo estas plataformas para evitar K8s overhead. Válidas hasta ciertas escalas.

---

## 8. Ejercicios prácticos

### Ejercicio 1: cluster local con kind + workload básico

**Objetivo:** montar entorno funcional para experimentar patrones sin cloud cost.

**Setup:**
- Docker Desktop.
- `kind`, `kubectl`, `helm 4`.

**Pasos:**
1. Crea cluster de 3 workers con el config del §0.
2. Instala metrics-server: `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`.
3. Despliega una app de prueba con Deployment + Service + HPA.
4. Genera load con `hey` o `k6` y observa el HPA escalando.
5. Añade readiness y liveness probes correctamente separadas.
6. Simula fallo de DB dependency (readiness rojo, liveness verde) y observa que K8s retira del endpoint pero no reinicia.

**Criterios de éxito:**
- [ ] Cluster kind healthy (`kubectl get nodes` con 4 nodos Ready).
- [ ] HPA escala de 1 → 5 réplicas bajo load.
- [ ] Al simular DB down, readiness pasa a false pero pods NO reinician.
- [ ] Al restaurar DB, pods vuelven a endpoint sin reinicio.

**Bonus:** añade Prometheus y visualiza métricas del HPA en Grafana.

---

### Ejercicio 2: GitOps con Argo CD

**Objetivo:** deploy declarativo via commit.

**Setup:**
- Cluster kind del Ejercicio 1.
- Repo Git con estructura del §5 (puede ser GitHub privado o gitea local).

**Pasos:**
1. Instala Argo CD (`kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.3.0/manifests/install.yaml`).
2. Port-forward la UI: `kubectl port-forward -n argocd svc/argocd-server 8080:443`.
3. Crea Application apuntando a `apps/review-api/overlays/local`.
4. Commit un cambio (bump imagen a 1.4.1). Observa el sync automático.
5. Testea `selfHeal`: `kubectl edit deployment review-api` manualmente. Argo CD debe revertirlo.
6. Configura webhook GitHub para sync inmediato en cada push.

**Criterios de éxito:**
- [ ] Cada commit se aplica al cluster en <2 min sin webhook, <10 s con webhook.
- [ ] Manual `kubectl edit` es revertido por selfHeal.
- [ ] UI muestra sync status y diff en tiempo real.
- [ ] Rollback vía Git revert produce rollback en cluster.

**Bonus:** configura ApplicationSet para desplegar 5 apps distintas con un solo manifest.

---

### Ejercicio 3: canary rollout con Argo Rollouts y análisis de métricas

**Objetivo:** canary automático con rollback basado en success rate.

**Setup:**
- Cluster kind del Ejercicio 1.
- Prometheus + Argo Rollouts instalados.

**Pasos:**
1. Instala Argo Rollouts controller.
2. Convierte tu Deployment de review-api en Rollout (mismo spec + `strategy.canary`).
3. Define AnalysisTemplate con query Prometheus para success rate ≥ 99%.
4. Deploy version buena (v1.4.0) que responde 200s.
5. Deploy version mala (v1.5.0-broken) que responde 500 en 30% de requests.
6. Observa que el canary se pausa en 10%, la analysis falla y auto-rollback ocurre.

**Criterios de éxito:**
- [ ] Rollout con canary (10% → 30% → 60% → 100%) para versión buena.
- [ ] Auto-rollback para versión mala tras análisis fallar 2 veces.
- [ ] Historial de rollouts visible con `kubectl argo rollouts get rollout review-api`.
- [ ] Alerta configurada cuando un rollout entra en Degraded.

**Bonus:** añade traffic mirroring: 100% al stable + 10% mirror al canary sin devolver respuesta al cliente.

---

### Ejercicio 4: Postgres HA con CloudNativePG

**Objetivo:** desplegar cluster Postgres HA con failover automático, backup a S3 y observabilidad.

**Setup:**
- Cluster kind con storage class (`kind` incluye `standard`).
- MinIO local como S3 (`docker run -d -p 9000:9000 -p 9001:9001 minio/minio server /data`).

**Pasos:**
1. Instala CNPG operator: `kubectl apply -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.0.yaml`.
2. Crea Secret con credenciales MinIO/S3.
3. Aplica el manifest del §4.3 apuntando a MinIO.
4. Verifica: `kubectl get cluster -n linguadev` → status `Cluster in healthy state`.
5. Conecta con `kubectl port-forward svc/linguadev-db-rw 5432` y crea data.
6. Chaos: `kubectl delete pod linguadev-db-1` (el primary). Observa promoción automática en <30 s.
7. Verifica backup a MinIO tras el schedule.

**Criterios de éxito:**
- [ ] Cluster healthy 1 primary + 2 replicas.
- [ ] Kill del primary → nuevo primary elegido en <30 s.
- [ ] Backup incremental en MinIO cada N horas.
- [ ] PITR test: restaura a un punto de hace 10 min y verifica data correcta.
- [ ] Métricas Prometheus expuestas y visibles en Grafana.

**Bonus:** simula corruption borrando datos y usa PITR para recuperar.

---

### Ejercicio 5 (bonus): decisión "K8s vs serverless" documentada

**Objetivo:** ejercicio de análisis, no de código.

**Setup:**
- Un servicio real de LinguaDev Pro (por ejemplo, el BFF de reviews).

**Pasos:**
1. Documenta requirements: RPS esperado, latencia p99 objetivo, dependencias, patrones de tráfico (spiky vs constante), presupuesto operacional.
2. Compara opciones:
   - AWS Lambda + API Gateway + DynamoDB.
   - ECS Fargate + ALB + RDS.
   - EKS + Karpenter + CNPG.
   - Fly.io.
3. Estima coste mensual para cada opción con tráfico esperado.
4. Estima "operational cost" (horas/mes de SRE para mantener) para cada.
5. Justifica la elección en un doc de 1-2 páginas.

**Criterios de éxito:**
- [ ] Análisis cuantificado, no "creo que".
- [ ] Coste financial + coste operational.
- [ ] Decisión honesta (a veces K8s es la respuesta, a veces no).
- [ ] Trigger conditions: "migraremos a K8s cuando X" o "migraremos fuera de K8s si Y".

**Bonus:** presenta el análisis a un compañero y defiende la decisión con datos.

---

## 9. Recursos + siguientes pasos

**Libros:**
- Bilgin Ibryam & Roland Huss — *Kubernetes Patterns*, O'Reilly (edición actualizada 2023).
- Brendan Burns — *Designing Distributed Systems*.
- Marko Lukša — *Kubernetes in Action*.
- Alex Xu — *System Design Interview*, vol 1 y 2.

**Documentación oficial y proyectos:**
- [Kubernetes Docs](https://kubernetes.io/) — versión 1.32+.
- [Istio Docs](https://istio.io/) — ambient y sidecar.
- [Argo CD 3.x](https://argo-cd.readthedocs.io/) y [Argo Rollouts](https://argo-rollouts.readthedocs.io/).
- [Flux 2.x](https://fluxcd.io/).
- [Helm 4](https://helm.sh/) y [Kustomize](https://kustomize.io/).
- [CloudNativePG](https://cloudnative-pg.io/).
- [Karpenter](https://karpenter.sh/).
- [KEDA](https://keda.sh/).
- [OpenCost](https://opencost.io/) y [Kubecost](https://kubecost.com/).
- [Gateway API](https://gateway-api.sigs.k8s.io/) — sucesor de Ingress.
- [CNCF Landscape](https://landscape.cncf.io/) — mapa completo del ecosystem.

**Blogs y charlas:**
- Tim Hockin (SIG-Node) — sobre CPU limits, requests, QoS.
- William Morgan (Buoyant/Linkerd) — *Do you need a service mesh?*.
- Kelsey Hightower — múltiples charlas sobre Kubernetes fundamentals.
- Datadog Blog — "Kubernetes CPU limits and throttling".
- Grafana Labs Engineering — sobre observability y cost.

**Comunidad:**
- KubeCon + CloudNativeCon (2 al año, EU y NA).
- CNCF Slack.
- r/kubernetes.

**Siguientes pasos:**
- Aplica los 4 ejercicios sobre kind localmente.
- Migra un servicio real de LinguaDev Pro (fsrs-scheduler, ver [Cap 08 §5](./08-consenso-y-coordinacion.md)) a un cluster EKS pequeño y valida el patrón GitOps.
- Lee [Cap 10 — arquitectura de seguridad](./10-arquitectura-de-seguridad.md) para completar el ciclo: cloud-native sin security es una vulnerabilidad footprint enorme.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades mid → staff. Cubren: sidecar pattern y ambient mesh, init containers y bootstrap, ambassador y adapter, operator pattern para stateful workloads, StatefulSet vs Deployment, cuándo justificar service mesh, node affinity y topology spread, requests/limits y QoS, HPA/VPA/KEDA autoscaling, GitOps con Argo CD y Flux, Helm vs Kustomize, canary vs blue-green, readiness vs liveness y confusiones frecuentes, health checks y outlier detection, PodDisruptionBudget y draining, external secrets, cost-aware architecture con Karpenter, observabilidad cloud-native (metrics/logs/traces), decisiones sobre 12-factor y cloud-native storage, y la decisión honesta de cuándo NO usar Kubernetes.

- **Fuente:** [`packages/content/src/tech/architecture/sim-09-cloud-native-patterns.json`](../../packages/content/src/tech/architecture/sim-09-cloud-native-patterns.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-09-cloud-native-patterns`
- **Tiempo:** 28 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 08 — consenso y coordinación](./08-consenso-y-coordinacion.md) · [Índice](./README.md) · [Capítulo 10 — arquitectura de seguridad →](./10-arquitectura-de-seguridad.md)
