# Capítulo 29 — Service Mesh (Istio, Linkerd, Cilium)

> **Focus:** Qué es un service mesh y cuándo introducirlo, sidecar vs ambient (Istio 1.24 GA de ambient, nov 2024), Envoy proxy y xDS, traffic management con VirtualService/DestinationRule, mTLS automático, AuthorizationPolicy, comparación Istio vs Linkerd vs Consul Connect vs Cilium Service Mesh, overhead real (166% sidecar vs ~8% ambient), observability out-of-the-box y canary automatizado.
> **Áreas:** Networking · Kubernetes · Seguridad · Observability
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de Kubernetes: Pod, Deployment, Service, ServiceAccount, Ingress (cap [07](./07-fundamentos-kubernetes.md), [08](./08-kubernetes-workloads.md), [09](./09-kubernetes-networking-y-storage.md)).
- TCP/HTTP/gRPC: sabés qué es un handshake TLS, HTTP/2 streams y códigos de status.
- Observabilidad básica: métricas Prometheus, traces distribuidos, formato W3C `traceparent`.
- CDN y Edge del capítulo previo ([28](./28-cdn-y-edge-computing.md)) para contrastar norte-sur vs este-oeste.
- Nociones de PKI y mTLS (se profundizan en el capítulo [31](./31-network-security-mtls-zero-trust.md)).

**Glosario mínimo:**
- **Service mesh:** capa de infraestructura dedicada a comunicación service-to-service, compuesta por *data plane* (proxies) + *control plane* (config, certificados, telemetría).
- **Sidecar:** contenedor extra inyectado en cada Pod que intercepta todo el tráfico entrante/saliente.
- **Ambient mesh:** modelo sin sidecar por Pod. Istio Ambient (GA en 1.24, nov 2024) usa `ztunnel` per-node y `waypoint` per-namespace.
- **Envoy:** proxy L7 en C++ creado por Lyft en 2016, estándar de facto para data plane.
- **linkerd2-proxy:** proxy en Rust, minimalista, usado por Linkerd 2.x.
- **xDS:** API gRPC (LDS/RDS/CDS/EDS) por la que el control plane empuja config en caliente al proxy.
- **VirtualService / DestinationRule / Gateway:** CRDs de Istio para routing L7, políticas de destino y entrypoints externos.
- **PeerAuthentication / AuthorizationPolicy:** CRDs de Istio para políticas de mTLS y autorización L7.
- **SPIFFE ID:** identidad de workload como URI `spiffe://<trust-domain>/ns/<ns>/sa/<sa>` firmada en el cert (SVID).
- **istiod:** binario único que consolida Pilot + Citadel + Galley + Sidecar Injector desde Istio 1.5.

**Setup mínimo:**

```bash
# 1) Cluster local con kind
kind create cluster --name mesh-lab --image kindest/node:v1.32.0

# 2) Instalar Istio 1.24+ (ambient GA)
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.24.2 sh -
cd istio-1.24.2 && export PATH=$PWD/bin:$PATH
istioctl install --set profile=ambient --skip-confirmation

# Alternativa: perfil sidecar clásico
# istioctl install --set profile=demo -y

# 3) Namespace habilitado para ambient
kubectl label namespace default istio.io/dataplane-mode=ambient

# 4) Linkerd 2.16+ (comparativa)
curl -sL run.linkerd.io/install-edge | sh
linkerd install --crds | kubectl apply -f -
linkerd install | kubectl apply -f -
linkerd viz install | kubectl apply -f -
linkerd check

# 5) Utilidades
kubectl krew install neat
istioctl analyze
```

---

## 1. El gran cuadro

Un **service mesh** es infraestructura dedicada de comunicación entre servicios. Su propuesta de valor es sacar del código de aplicación cinco preocupaciones transversales que en microservicios se repiten cientos de veces mal: **mTLS**, **retries/timeouts/circuit breakers**, **canary y traffic splitting**, **observability** (métricas RED, traces, access logs) y **autorización L7**. En vez de importar `resilience4j`, `opentelemetry-instrumentation` y un `oauth2-client` en cada microservicio Go/Node/Python/Java, se despliega un **proxy L7** (Envoy o linkerd2-proxy) que intercepta todo el tráfico del Pod y aplica políticas declarativas. La app sigue haciendo `http://payments:8080/api/orders` a localhost como siempre; el proxy hace mTLS, retries, splitting y emite métricas sin que el binario cambie una línea.

La arquitectura clásica —vigente desde Istio 1.0 (2018) hasta hoy— es el **sidecar pattern**: un container adicional por Pod (`istio-proxy` con Envoy, o `linkerd-proxy` con Rust), inyectado automáticamente por un mutating webhook cuando el namespace tiene `istio-injection=enabled` o `linkerd.io/inject=enabled`. Un initContainer (`istio-init`) programa iptables para redirigir todo el tráfico saliente al puerto 15001 del sidecar y el entrante al 15006. La app cree hablar con el destino real; realmente habla con Envoy en `localhost`, que consulta config del control plane y aplica policies. La transparencia es total pero el costo también: memoria (~50-100 MB por sidecar en Envoy, ~10-30 MB en Linkerd), latencia (+1-3 ms p50, +3-10 ms p99 por hop) y complejidad operacional (nueva capa que debuggear).

En 2024-2025 el panorama giró con la **GA de Istio Ambient mode en 1.24** (noviembre 2024). En vez de un sidecar por Pod se despliegan dos componentes compartidos: **`ztunnel`** (per-node DaemonSet, escrito en Rust) que hace L4 + mTLS con SPIFFE IDs, y **`waypoint` proxies** opcionales per-namespace (Envoy) para features L7 (VirtualService, AuthorizationPolicy). Los benchmarks públicos de Istio reportan un overhead de latencia p99 alrededor del **8% con ambient vs 166% con sidecar** en cargas típicas HTTP, además de eliminar 50-100 MB por Pod. Cilium Service Mesh sigue una filosofía similar desde antes: agent per-node + Envoy per-node opcional, todo apalancado sobre eBPF en el kernel. Ambos enfoques convergen en "por nodo, no por Pod" para 2026.

El impacto práctico en LinguaDev Pro es concreto. Con ~10 microservicios (API BFF, TTS worker, STT worker, content service, spaced-repetition scheduler, billing, notifications, admin, gateway, auth) el mesh introduce valor cuando: (a) compliance exige mTLS everywhere y audit de qué SA llama a qué endpoint; (b) queremos canary automatizado con métricas del propio proxy sin instrumentar cada microservicio; (c) se necesitan retries/timeouts/circuit breakers uniformes; (d) equipos de features publican `HTTPRoute` sin depender de infra. Con <5 servicios y equipo sin experiencia previa, el mesh suele ser **overkill**: cert-manager + OpenTelemetry directo + NetworkPolicy resuelven 80% del uso a fracción del costo. Este capítulo cubre cuándo sí, cuándo no, cómo funcionan Istio (sidecar y ambient), Linkerd 2.16+, Consul Connect y Cilium Service Mesh, con YAML real y ejercicios verificables.

---

## 2. Sidecar pattern y Envoy proxy (nivel básico)

### 2.1 Cómo intercepta el sidecar

Cuando el admission webhook detecta el label `istio.io/rev` o `istio-injection=enabled` en el namespace, muta el PodSpec agregando:

1. Un **initContainer `istio-init`** que ejecuta `iptables -t nat` para redirigir `PREROUTING` al puerto `15006` de Envoy y `OUTPUT` al `15001`.
2. Un container **`istio-proxy`** con Envoy escuchando en esos puertos.

El network namespace es compartido entre containers del Pod, así que la reprogramación de iptables afecta a la app aunque corra en otro container. Consecuencia práctica: `tcpdump` dentro del container de la app muestra `localhost`, no el destino real. Debugging con `istioctl proxy-config` o `linkerd tap` es indispensable.

```yaml
# istio-injection habilitado + un Deployment simple
apiVersion: v1
kind: Namespace
metadata:
  name: linguadev
  labels:
    istio-injection: enabled
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: linguadev
spec:
  replicas: 3
  selector: { matchLabels: { app: api, version: v1 } }
  template:
    metadata:
      labels: { app: api, version: v1 }
    spec:
      serviceAccountName: api
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.1.0
          ports: [{ containerPort: 8080 }]
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
```

Verificación:

```bash
kubectl -n linguadev get pod -l app=api -o jsonpath='{.items[0].spec.containers[*].name}{"\n"}'
# api istio-proxy

istioctl proxy-status                # ¿todos sincronizados con istiod?
istioctl proxy-config listener  api-abc-123.linguadev
istioctl proxy-config clusters  api-abc-123.linguadev --port 8080
```

### 2.2 Envoy y xDS

Envoy es un proxy L7 en C++ event-driven creado por Matt Klein en Lyft (2016). Cuatro capacidades lo hacen el estándar universal:

- **Config dinámica vía xDS**: Listener/Route/Cluster/Endpoint Discovery Service son streams gRPC hacia el control plane. Cero reload, cambios propagan en segundos incluso con 10.000 proxies.
- **Protocolos L7 nativos**: HTTP/1.1, HTTP/2, HTTP/3, gRPC, WebSocket, TCP, MongoDB, Redis, Kafka. Entiende el protocolo → retry por status code, circuit breaker por 5xx rate.
- **Observability first-class**: métricas Prometheus en `:15020`, traces W3C/B3, access logs estructurados sin configuración por servicio.
- **Extensibilidad WASM**: filtros custom en Rust/Go/C++ sin recompilar el binario.

xDS es tan estándar que Google Traffic Director, AWS App Mesh y Kuma lo consumen. Existe **Envoy Gateway 1.2+** que expone Kubernetes Gateway API sobre Envoy vanilla sin Istio.

### 2.3 istiod: control plane consolidado

Antes de Istio 1.5 (2020) el control plane eran cuatro pods: **Pilot** (xDS), **Citadel** (CA para mTLS), **Galley** (validación de config) y **Mixer** (policy checks en request path). Mixer era el peor bottleneck: cada request llamaba a Mixer, sumando 5-10 ms de latencia. Se eliminó y su funcionalidad se movió a filtros nativos de Envoy. Los otros tres se fusionaron en el binario **`istiod`**. Menos pods = upgrades más simples, HA con 2-3 réplicas, un único log stream.

`istiod` responsabilidades:

1. Lee CRDs (`VirtualService`, `DestinationRule`, `Gateway`, `PeerAuthentication`, `AuthorizationPolicy`).
2. Traduce a xDS y stream por gRPC a cada Envoy.
3. Actúa como CA emisora de certificados SPIFFE (rotación cada 24h por defecto, 1h con SPIRE).
4. Valida config con admission webhook (rechaza CRDs malformados).
5. Inyecta sidecars con mutating webhook.

Post-Mixer, el overhead cayó de 5-10 ms a 1-2 ms por request. Con ambient, baja aún más.

---

## 3. Traffic management: VirtualService, DestinationRule, Gateway (nivel medio)

### 3.1 VirtualService: reglas L7

`VirtualService` define **routing** por host: matching por path, header, method; splitting por peso; timeouts; retries; fault injection; mirror. Es análogo a un Ingress avanzado pero funciona para tráfico este-oeste (interno) y norte-sur (externo). Ejemplo canary 90/10 con override por header `x-user-tier: premium` y timeout aumentado en `/api/experimental/*`:

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: api-vs
  namespace: linguadev
spec:
  hosts: [api]                       # DNS interno del Service
  http:
    - name: premium-always-v2
      match:
        - headers:
            x-user-tier: { exact: premium }
      route:
        - destination: { host: api, subset: v2 }
    - name: experimental-long-timeout
      match:
        - uri: { prefix: /api/experimental/ }
      timeout: 30s
      retries:
        attempts: 3
        perTryTimeout: 10s
        retryOn: 5xx,gateway-error,connect-failure
      route:
        - destination: { host: api, subset: v1 }
    - name: canary-90-10
      route:
        - destination: { host: api, subset: v1 }
          weight: 90
        - destination: { host: api, subset: v2 }
          weight: 10
      mirror: { host: api, subset: v2-shadow }
      mirrorPercentage: { value: 100 }
```

Notas: (a) orden importa, la primera regla que matchea gana; (b) los `subset`s se declaran en `DestinationRule`; (c) `mirror` envía una copia (shadow traffic) a `v2-shadow` sin bloquear la respuesta al cliente.

### 3.2 DestinationRule: políticas del destino

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: api-dr
  namespace: linguadev
spec:
  host: api
  trafficPolicy:
    connectionPool:
      tcp: { maxConnections: 200 }
      http:
        http1MaxPendingRequests: 1024
        http2MaxRequests: 2048
        maxRequestsPerConnection: 100
    loadBalancer: { simple: LEAST_REQUEST }
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
  subsets:
    - name: v1
      labels: { version: v1 }
    - name: v2
      labels: { version: v2 }
    - name: v2-shadow
      labels: { version: v2-shadow }
```

`outlierDetection` es **circuit breaker automático por host**: si un Pod devuelve 5 x 5xx consecutivos, sale del pool 30 s. `maxEjectionPercent: 50` evita ejectar todos los pods (fallback catastrófico). LEAST_REQUEST balancea a la instancia con menos requests activas.

### 3.3 Gateway: tráfico norte-sur

```yaml
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: linguadev-gw
  namespace: linguadev
spec:
  selector: { istio: ingressgateway }   # el pod istio-ingressgateway
  servers:
    - port: { number: 443, name: https, protocol: HTTPS }
      hosts: [api.linguadev.app]
      tls:
        mode: SIMPLE
        credentialName: linguadev-tls   # Secret con cert/key
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: api-external
  namespace: linguadev
spec:
  hosts: [api.linguadev.app]
  gateways: [linguadev-gw]
  http:
    - route:
        - destination: { host: api, subset: v1 }
```

`Gateway` define listeners L4/L7 en el pod `istio-ingressgateway` (Envoy dedicado expuesto por un Service `LoadBalancer`). La `VirtualService` bindea ese Gateway a rutas concretas. La misma sintaxis funciona para tráfico interno omitiendo `gateways`.

---

## 4. Ambient mesh, Linkerd, Consul y Cilium (nivel avanzado)

### 4.1 Istio Ambient (GA 1.24, nov 2024)

Ambient elimina el sidecar por Pod y divide responsabilidades en dos capas:

- **Secure overlay (L4 + mTLS)**: `ztunnel` corre como DaemonSet, escrito en Rust. Intercepta tráfico con eBPF o iptables, hace mTLS con SPIFFE IDs. Coste ~50-100 MB por nodo, no por Pod.
- **Waypoint L7 (opcional)**: un pod Envoy per-namespace o per-service account que aplica VirtualService, AuthorizationPolicy L7, retries, timeouts. Solo se despliega donde se necesitan features L7.

```bash
# Habilitar ambient en el namespace
kubectl label ns linguadev istio.io/dataplane-mode=ambient

# Añadir waypoint opcional para L7
istioctl waypoint apply --namespace linguadev --enroll-namespace
```

Ventajas: (1) overhead ~8% p99 vs ~166% con sidecar (números publicados por el equipo Istio, cargas HTTP típicas); (2) sin reinicio de Pods al enrolar; (3) upgrades del proxy sin tocar apps; (4) cero problemas de startup order (sidecar-app race). Trade-offs: (a) menos control fino que sidecar (compartes recursos con vecinos del nodo); (b) waypoint es un hop extra si querés L7; (c) requiere kernel Linux razonablemente moderno y CNI compatible.

### 4.2 Linkerd 2.16+ (agosto 2024)

Linkerd es CNCF graduated, data plane en Rust (`linkerd2-proxy`), más ligero (~10-30 MB por sidecar), latencia sub-milisegundo p99 en operaciones comunes. Fortalezas: operabilidad (`linkerd check` diagnostica todo), foco en el 99% del caso común (HTTP/gRPC/TCP), Buoyant como vendor principal. Features clave de 2.16: **IPv6/dual-stack**, **retries/timeouts/métricas por route en HTTPRoute/GRPCRoute (Gateway API parity)**, **audit mode para AuthorizationPolicy** (ver el impacto antes de aplicar), y automatización para workloads en VMs.

```yaml
# Linkerd instala Service Mesh con SMI-like HTTPRoute
apiVersion: policy.linkerd.io/v1beta3
kind: HTTPRoute
metadata:
  name: api-routes
  namespace: linguadev
spec:
  parentRefs:
    - name: api
      kind: Service
      group: core
      port: 80
  rules:
    - matches:
        - path: { type: PathPrefix, value: /v1 }
      timeouts:
        request: 5s
        backendRequest: 1s
      backendRefs:
        - name: api-v1
          port: 80
          weight: 90
        - name: api-v2
          port: 80
          weight: 10
---
apiVersion: policy.linkerd.io/v1alpha1
kind: AuthorizationPolicy
metadata:
  name: api-authz
  namespace: linguadev
spec:
  targetRef:
    kind: Service
    group: core
    name: api
  requiredAuthenticationRefs:
    - name: web-frontend
      kind: MeshTLSAuthentication
      group: policy.linkerd.io
```

Regla de dedo: equipo sin experiencia previa + necesidades básicas (mTLS + observability + retry) → **Linkerd**. Equipo con multi-cluster, WASM filters, ecosistema big-cloud → **Istio**. Latencia extrema HFT → probablemente ninguno o benchmarks propios.

### 4.3 Consul Connect (HashiCorp)

Diferenciador: **multiplataforma**. Funciona en Kubernetes, VMs, bare metal, Nomad, entornos híbridos. Data plane Envoy (default) o proxy nativo. CRDs análogos: `ServiceRouter`, `ServiceResolver`, `ServiceSplitter`, `ServiceIntentions`. Integración nativa con Vault como CA. Recomendado si el stack ya es HashiCorp o hay VMs mezcladas con K8s.

### 4.4 Cilium Service Mesh (eBPF)

Cilium es CNI en eBPF. Su extensión Service Mesh ofrece mTLS, L7 policies y observability con:

- **Agent per-node (cilium-agent)**: eBPF para L3/L4 en kernel.
- **Envoy per-node (opcional)**: para features L7 (HTTP filters, WASM).
- **Hubble**: observability L3-L7 con UI web, replazo de Kiali.

Ventajas: cero sidecar, latencia kernel-level, integración con NetworkPolicies eBPF. En 2026 con versiones 1.19+, Cilium consolida como default de nuevos clusters GKE Dataplane V2 y EKS opcional. Buen ajuste si ya usás Cilium como CNI.

---

## 5. Ejemplo práctico: LinguaDev Pro con Istio Ambient + canary automatizado

Escenario: exponer `api.linguadev.app`, canary 5%→25%→50%→100% de `api-v2`, mTLS STRICT interno, autorización L7 (solo `web-frontend` puede llamar a `api`, y solo `POST /v1/lessons`).

### Paso 1: enrolar namespace en ambient

```bash
kubectl create namespace linguadev
kubectl label namespace linguadev istio.io/dataplane-mode=ambient
istioctl waypoint apply --namespace linguadev --enroll-namespace
```

### Paso 2: PeerAuthentication STRICT + AuthorizationPolicy

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: linguadev
spec:
  mtls: { mode: STRICT }
---
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: api-allow-frontend
  namespace: linguadev
spec:
  selector:
    matchLabels: { app: api }
  action: ALLOW
  rules:
    - from:
        - source:
            principals: ["cluster.local/ns/linguadev/sa/web-frontend"]
      to:
        - operation:
            methods: [POST, GET]
            paths: ["/v1/lessons", "/v1/lessons/*"]
```

### Paso 3: Deployments v1 y v2 + Service

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api
  namespace: linguadev
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-v1
  namespace: linguadev
spec:
  replicas: 3
  selector: { matchLabels: { app: api, version: v1 } }
  template:
    metadata:
      labels: { app: api, version: v1 }
    spec:
      serviceAccountName: api
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.1.0
          ports: [{ containerPort: 8080 }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-v2
  namespace: linguadev
spec:
  replicas: 1
  selector: { matchLabels: { app: api, version: v2 } }
  template:
    metadata:
      labels: { app: api, version: v2 }
    spec:
      serviceAccountName: api
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.2.0-rc1
          ports: [{ containerPort: 8080 }]
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: linguadev
spec:
  selector: { app: api }
  ports: [{ port: 80, targetPort: 8080 }]
```

### Paso 4: canary con DestinationRule + VirtualService

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: api-dr
  namespace: linguadev
spec:
  host: api
  trafficPolicy:
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
  subsets:
    - name: v1
      labels: { version: v1 }
    - name: v2
      labels: { version: v2 }
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: api-vs
  namespace: linguadev
spec:
  hosts: [api]
  http:
    - route:
        - destination: { host: api, subset: v1 }
          weight: 95
        - destination: { host: api, subset: v2 }
          weight: 5
      retries:
        attempts: 3
        perTryTimeout: 1s
        retryOn: 5xx,connect-failure
      timeout: 3s
```

Progresión manual: editar `weight` a 25/75, luego 50/50, luego 0/100. Automatización real con **Argo Rollouts** o **Flagger** (cap [32](./32-blue-green-canary-rolling.md) y [33](./33-progressive-delivery-flagger-argo-rollouts.md)).

### Paso 5: Gateway externo con TLS

```yaml
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: linguadev-gw
  namespace: linguadev
spec:
  selector: { istio: ingressgateway }
  servers:
    - port: { number: 443, name: https, protocol: HTTPS }
      hosts: [api.linguadev.app]
      tls:
        mode: SIMPLE
        credentialName: linguadev-tls
```

### Paso 6: verificación

```bash
istioctl analyze -n linguadev
istioctl proxy-status
kubectl exec -n linguadev deploy/web-frontend -- \
  curl -sI http://api.linguadev/v1/lessons | grep x-envoy
# Debe aparecer x-envoy-upstream-service-time y otros headers Envoy

kubectl exec -n linguadev deploy/random-tester -- \
  curl -s http://api.linguadev/v1/lessons
# 403 (RBAC: SA random-tester no está en principals allowlist)
```

---

## 6. Cheatsheet, reglas mentales, anti-patrones

### Reglas de oro

- ✅ Preguntá primero: ¿qué problema resuelve el mesh que hoy no podés resolver con `cert-manager` + OpenTelemetry + NetworkPolicy?
- ✅ Con <10 microservicios y sin necesidad concreta de mTLS/authZ/canary, **no** instales mesh.
- ✅ Empezá con `PeerAuthentication` en `PERMISSIVE`, valida métricas, después `STRICT`.
- ✅ En 2026 preferí **ambient mode** para greenfield (overhead ~8% vs ~166% sidecar según benchmarks Istio).
- ✅ Usá `Gateway API` en vez de Ingress cuando el proveedor de tu mesh lo soporte.
- ✅ Retries solo en operaciones **idempotentes** (GET/PUT/DELETE); POST requiere idempotency keys en la app.
- ✅ Timeouts en cascada decrecientes: root 5 s → middle 3 s → leaf 1 s.
- ✅ `maxEjectionPercent: 50` en outlier detection para evitar dejar cero pods.
- ✅ AuthorizationPolicy con `principals` (SPIFFE ID), no con IPs.
- ✅ Metricas del mesh + OpenTelemetry en app son **complementarios**, no sustitutos.
- ✅ Root CA compartida entre clusters si usás multi-cluster mesh.
- ✅ Auditá con `istioctl analyze` en CI antes de mergear cambios de CRDs.

### Anti-patrones

- ❌ Instalar Istio "por si acaso" o para el CV.
- ❌ Retry storms sin budget: multiplican carga en el servicio ya degradado.
- ❌ Habilitar mesh en TODOS los namespaces (kube-system, monitoring...) sin evaluar overhead.
- ❌ Confundir `VirtualService` y `DestinationRule` (uno rutea, otro define subsets/políticas).
- ❌ Poner `Gateway` y `VirtualService` en el mismo namespace sin `hosts` explícitos.
- ❌ Migrar de `PERMISSIVE` a `STRICT` sin validar que todo el tráfico ya es mTLS.
- ❌ Depender solo del mesh para autorización de negocio (mesh authZ es coarse-grained).
- ❌ Ignorar el overhead operacional al hacer la propuesta de valor al CTO.

### Tabla de decisión mesh

| Necesidad | Elección 2026 |
|---|---|
| Cluster K8s puro, <10 servicios | Sin mesh; `cert-manager` + `NetworkPolicy` + OTEL |
| Greenfield con muchos servicios | Istio ambient 1.24+ o Cilium Service Mesh |
| Equipo sin experiencia, mTLS + observability | Linkerd 2.16+ |
| VMs + K8s híbrido, stack HashiCorp | Consul Connect |
| Multi-cluster global con features avanzados | Istio (multi-primary o Gloo Mesh) |
| Ya usás Cilium como CNI | Cilium Service Mesh |
| Extrema latencia (<1 ms overhead) | Linkerd o mesh custom |

---

## 7. Casos reales industria 2023-2026

**Lyft (creadores de Envoy):** operan >10 000 Envoys en producción con >100 M requests/s. El origen del proyecto (2016) fue orquestar comunicación entre cientos de servicios en Go/Python/PHP. **Lección:** el sidecar transparente elimina la necesidad de librerías por lenguaje.

**LinkedIn:** opera un mesh interno masivo (previo a Envoy), migrando componentes selectivos a Envoy. Publicaron que tardaron años en la decisión por consideraciones de latencia p99. **Lección:** mesh no es reactivo; se evalúa.

**Airbnb:** adoptó Envoy como proxy estándar antes de Istio y usa mesh para canary con VirtualService + análisis de métricas custom. **Lección:** mesh y observability se retroalimentan.

**Salesforce, Adidas, Chipotle, Nike:** usan Linkerd en producción, atraídos por operabilidad. **Lección:** cuando el equipo prioriza simplicidad, Linkerd gana.

**Google Cloud (Traffic Director + Anthos Service Mesh):** ofrece mesh managed compatible con xDS. Cloud provider apuesta por Istio y xDS como estándares. **Lección:** el ecosistema converge en xDS.

**Isovalent (Cilium) adquirido por Cisco (2023):** Cilium se convierte en default de nuevos GKE Dataplane V2 clusters y opción en EKS. **Lección:** eBPF llegó al mainstream.

**Istio Ambient GA (nov 2024):** benchmarks del equipo Istio muestran latencia p99 con overhead ~8% vs ~166% con sidecar clásico en cargas HTTP típicas. **Lección:** el sidecar clásico está en cuenta regresiva para greenfield.

**Buoyant (2023):** cambió modelo comercial de Linkerd generando controversia, aunque el proyecto sigue CNCF graduated. **Lección:** dependencia de un solo vendor tiene riesgos organizacionales.

**HashiCorp Consul (BSL en 2023):** licencia cambiada; sigue funcional pero altera roadmaps. **Lección:** revisá licencias antes de comprometerte a largo plazo.

**Netflix y Uber:** ambos evitaron Istio y desarrollaron mesh propietarios (por edad y requisitos de latencia). **Lección:** los mesh open-source no cubren todos los casos.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Instalar Istio Ambient y enrolar un namespace

**Objetivo:** desplegar `istioctl install --set profile=ambient` en un cluster kind y verificar que un Deployment recibe mTLS sin sidecar.

**Pasos:**
1. Crear cluster kind con Kubernetes 1.32.
2. `istioctl install --set profile=ambient -y`.
3. `kubectl label ns default istio.io/dataplane-mode=ambient`.
4. Deployar `httpbin` y `curl` client.
5. Ejecutar curl y verificar en `kubectl -n istio-system logs ds/ztunnel` que la conexión salió por ztunnel.

**Criterios de éxito:**
- [ ] `istioctl proxy-status` muestra ambos workloads sincronizados.
- [ ] Los pods **no** tienen container `istio-proxy` (ambient no inyecta sidecar).
- [ ] `ztunnel` logs muestran identidades SPIFFE del cliente y del servidor.
- [ ] Curl a `httpbin` responde 200.

**Bonus:** aplicá waypoint (`istioctl waypoint apply --namespace default`) y creá una `AuthorizationPolicy` L7.

---

### Ejercicio 2: Canary 90/10 con VirtualService + DestinationRule

**Objetivo:** enrutar el 10% del tráfico a `api-v2` y verificar la distribución.

**Pasos:**
1. Deployar `api-v1` y `api-v2` con labels `version: v1|v2`.
2. Crear `DestinationRule` con subsets.
3. Crear `VirtualService` con `weight: 90/10`.
4. Generar 1000 requests con `fortio` desde un pod cliente.
5. Verificar el ratio con métricas Prometheus `istio_requests_total{destination_version}`.

**Criterios de éxito:**
- [ ] Ratio observado entre 8% y 12% para v2 (dentro del intervalo de confianza binomial).
- [ ] Cero errores 5xx (retries funcionaron si algún pod falló).
- [ ] Kiali/Hubble muestra el grafo de servicios con el split.

**Bonus:** añadí `mirrorPercentage: {value: 50}` y verificá que `api-v2-shadow` recibe copia.

---

### Ejercicio 3: mTLS STRICT + AuthorizationPolicy que rechaza cross-SA

**Objetivo:** aplicar `PeerAuthentication STRICT` y `AuthorizationPolicy` que solo permite al SA `web-frontend` llamar a `api`, y verificar rechazo de otros SAs.

**Pasos:**
1. Crear SAs `web-frontend`, `admin`, `random-tester`.
2. Deploy `api` con selector matcheable por AuthPolicy.
3. Aplicar PeerAuth STRICT.
4. AuthPolicy con `principals` = SPIFFE ID de `web-frontend`.
5. Test desde cada SA (`kubectl exec` en un pod que use ese SA).

**Criterios de éxito:**
- [ ] `web-frontend` recibe 200.
- [ ] `admin` y `random-tester` reciben 403.
- [ ] Los logs de Envoy muestran `RBAC: access denied` con SPIFFE ID del caller.
- [ ] `istioctl authz check` valida las reglas antes de aplicar.

**Bonus:** activá `audit mode` (Istio 1.22+) para ver el diff sin bloquear.

---

### Ejercicio 4: Comparar overhead sidecar vs ambient

**Objetivo:** medir latencia y memoria de un mismo workload con sidecar y con ambient.

**Pasos:**
1. Deployar `httpbin` en namespace `sidecar-ns` con `istio-injection=enabled`.
2. Deployar `httpbin` en namespace `ambient-ns` con `istio.io/dataplane-mode=ambient`.
3. Ejecutar `fortio load -c 32 -qps 500 -t 60s` contra cada uno desde un cliente en el mesh.
4. Comparar p50, p99 y memoria (`kubectl top pod`).

**Criterios de éxito:**
- [ ] Diferencia de p99 y memoria documentada en una tabla.
- [ ] Ambient consume ~50-100 MB menos por Pod.
- [ ] Overhead p99 de ambient es notablemente menor que sidecar.

**Bonus:** repetir con Linkerd y comparar los tres.

---

### Ejercicio 5 (bonus): migrar de Ingress-Nginx a Istio Gateway con Gateway API

**Objetivo:** convertir un `Ingress` legacy a `Gateway` + `HTTPRoute` de Kubernetes Gateway API implementado por Istio.

**Pasos:**
1. Anotar el `Ingress` actual (host, paths, TLS).
2. Instalar Gateway API CRDs v1.2.
3. Crear `Gateway` con `gatewayClassName: istio`.
4. Traducir cada path a `HTTPRoute`.
5. Cutover DNS al nuevo entrypoint.
6. Borrar el Ingress viejo.

**Criterios de éxito:**
- [ ] `kubectl get gateway` → `PROGRAMMED=True`.
- [ ] `HTTPRoute` → `ACCEPTED=True`.
- [ ] TLS válido con cert de cert-manager.
- [ ] Cero errores durante el cutover.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [istio.io/latest/docs](https://istio.io/latest/docs/) — Istio 1.24+ con ambient GA.
- [linkerd.io/2-edge](https://linkerd.io/2-edge/) — Linkerd 2.16+.
- [cilium.io/docs](https://docs.cilium.io) — Cilium Service Mesh 1.16+/1.19+.
- [envoyproxy.io](https://www.envoyproxy.io/docs/envoy/latest/) — Envoy y xDS.
- [gateway-api.sigs.k8s.io](https://gateway-api.sigs.k8s.io) — Kubernetes Gateway API v1.2+.

**Herramientas:**
- `istioctl` — install, analyze, proxy-config.
- `linkerd` CLI — check, viz, tap.
- **Kiali** — visualización de topología para Istio.
- **Hubble** — flow observability para Cilium.
- **Fortio** — generador de carga con métricas p50/p99.

**Referencias:**
- William Morgan, *The Service Mesh: What Every Engineer Needs to Know* (Buoyant).
- Matt Klein, *Introducing Envoy* (KubeCon 2017).
- NIST SP 800-207 (Zero Trust Architecture) para el contexto de mTLS everywhere.
- Google SRE Book cap. 22 (Cascading Failures) para retries/timeouts/circuit breakers.

**Siguientes pasos:**
- Completá los 5 ejercicios en tu cluster.
- Auditá tu stack: ¿tenés mesh? ¿en STRICT? ¿con AuthorizationPolicy?
- Continuá con [Capítulo 30 — API Gateways](./30-api-gateways.md) para norte-sur y BFF pattern.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades junior → staff. Cubren: qué es un service mesh y cuándo, sidecar pattern e iptables, Envoy y xDS, istiod, VirtualService, DestinationRule, Gateway, mTLS con SPIFFE, AuthorizationPolicy, retries/timeouts/circuit breakers, Linkerd vs Istio, overhead, Cilium Service Mesh y ambient mode, Consul Connect, multi-cluster, progressive delivery y debugging.

- **Fuente:** [`packages/content/src/tech/devops/sim-29-service-mesh-istio-linkerd.json`](../../packages/content/src/tech/devops/sim-29-service-mesh-istio-linkerd.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-29-service-mesh-istio-linkerd`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 28 — CDN y Edge Computing](./28-cdn-y-edge-computing.md) · [Índice](./README.md) · [Capítulo 30 — API Gateways →](./30-api-gateways.md)
