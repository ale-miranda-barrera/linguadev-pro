# Capítulo 07 — Fundamentos de Kubernetes: arquitectura y objetos core

> **Focus:** Qué es realmente Kubernetes, arquitectura del control plane y de los nodos, Pods como unidad atómica, ReplicaSets y Deployments, kubectl operativo, namespaces, labels/selectors, ConfigMaps y Secrets. Cuándo elegir K8s frente a ECS/Nomad/serverless.
> **Áreas:** Kubernetes · Orquestación · Cloud native
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Sólida base de contenedores ([cap 05](./05-fundamentos-docker.md)) y de seguridad de imágenes ([cap 06](./06-container-security-y-registries.md)).
- Manejo cómodo de YAML (indentación, tipos, anchors) y JSON.
- Conceptos básicos de networking (IP, puertos, DNS, HTTP).
- Un cluster local para practicar: **kind**, **minikube** o **k3d**.

**Glosario mínimo:**
- **Cluster**: conjunto de máquinas (nodos) que ejecutan un plano de control (control plane) y cargas (data plane).
- **Control plane**: componentes que deciden el estado del cluster (`kube-apiserver`, `etcd`, `kube-scheduler`, `kube-controller-manager`).
- **Node**: máquina (VM o física) que corre workloads. Ejecuta `kubelet`, `kube-proxy` y un runtime OCI (containerd por defecto en 2026).
- **Pod**: grupo de 1+ contenedores co-programados que comparten `network`, `IPC`, `UTS` y volúmenes.
- **Deployment**: controlador que gestiona ReplicaSets para pods stateless con rolling updates y rollback.
- **ReplicaSet**: garantiza N réplicas de un Pod. Gestionado por Deployments; raramente creado a mano.
- **Namespace**: partición lógica del cluster para aislar recursos por equipo/entorno.
- **Label / Selector**: metadatos clave=valor + queries. Base de casi toda la interconexión (Services eligen Pods por label).
- **ConfigMap / Secret**: pares clave=valor no confidenciales / confidenciales, montables como env vars o files.
- **CRD**: Custom Resource Definition. Permite extender la API con tus propios tipos.
- **kubectl**: CLI oficial. Cliente Go que habla con `kube-apiserver`.

**Setup mínimo (agosto 2026, Kubernetes 1.34):**

```bash
# 1. Instalar kubectl 1.34 (server-version-skew ±1 minor supported)
curl -LO "https://dl.k8s.io/release/v1.34.1/bin/linux/amd64/kubectl"
install -m 0755 kubectl /usr/local/bin/kubectl

# 2. Instalar kind (local cluster con Docker)
go install sigs.k8s.io/kind@v0.24.0

# 3. Crear cluster local con 1 control-plane + 2 workers
cat <<'EOF' | kind create cluster --name lab --image kindest/node:v1.34.1 --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF

# 4. Verificación mínima
kubectl cluster-info
kubectl get nodes -o wide
kubectl version --short
```

Todo el capítulo asume Kubernetes 1.32-1.34 (líneas de soporte en 2026). Diferencias vs 1.28-1.31 se anotan cuando aplican.

---

## 1. El gran cuadro

Kubernetes es un **orquestador declarativo de contenedores**. Nació en 2014 en Google como reescritura open-source de **Borg** (interno desde 2003), fue donado a la recién fundada CNCF en 2015 y hoy es el proyecto más adoptado de la Cloud Native Foundation. En 2026 es la capa de facto para desplegar workloads containerizados a escala: EKS, GKE, AKS, OpenShift, Rancher, Talos, k3s y decenas más son distribuciones del mismo core.

La idea central es el **reconciliation loop**: tú declaras el estado deseado (`quiero 5 réplicas de esta imagen escuchando en el puerto 8080`) y el control plane observa continuamente el estado real, calcula el delta y actúa para converger. Si un nodo cae, Kubernetes reprograma los pods perdidos en nodos sanos; si un pod hace crash, lo reinicia; si haces un `kubectl apply` con una imagen nueva, hace rolling update sin downtime. El mismo YAML corre en tu kind local, en EKS de producción y en el laptop de tu compañera.

El precio de esta flexibilidad es **complejidad enorme**. Un cluster real tiene 20+ componentes, docenas de recursos, CRDs de operators, redes overlay, storage CSI, políticas de admisión, autoscalers. Para una app con un servicio, poco tráfico y sin necesidad de escalado agresivo, Kubernetes es sobreingeniería: Fly.io, Render, AWS App Runner o ECS Fargate cubren el 90% del caso a una fracción del coste operativo. **Regla de decisión 2026**: si no necesitas al menos 2 de {rolling updates automatizados, autoscaling reactivo, multi-tenancy con policies, service mesh, batch jobs periódicos complejos, portabilidad multi-cloud}, no adoptes Kubernetes. Si necesitas 3+, es probablemente la mejor opción.

Este capítulo cubre la fundación: arquitectura, Pods, controladores stateless (Deployment/ReplicaSet), kubectl operativo, namespaces, labels y ConfigMaps/Secrets. Los workloads avanzados (StatefulSet, DaemonSet, Job/CronJob, HPA/VPA/Karpenter) van en [cap 08](./08-kubernetes-workloads.md); networking y storage en [cap 09](./09-kubernetes-networking-y-storage.md).

---

## 2. Arquitectura: control plane + data plane (nivel básico)

Un cluster Kubernetes se divide en dos planos.

**Control plane** (habitualmente 3 réplicas para HA):

| Componente | Rol | Puerto default |
|---|---|---|
| `kube-apiserver` | Frontend HTTPS de la API. Único componente que habla con etcd. Todos los demás componentes hablan con él. | 6443 |
| `etcd` | Base de datos clave-valor consistente (Raft). Guarda **todo** el estado del cluster. | 2379/2380 |
| `kube-scheduler` | Decide en qué nodo colocar cada Pod nuevo (filtering + scoring). | 10259 |
| `kube-controller-manager` | Corre los controladores built-in: Deployment, ReplicaSet, Node, Endpoints, ServiceAccount, etc. | 10257 |
| `cloud-controller-manager` | Integración con APIs del cloud provider (load balancers, volúmenes, rutas). | 10258 |

**Data plane** (cada nodo worker):

| Componente | Rol |
|---|---|
| `kubelet` | Agente que ejecuta pods (habla con containerd via CRI), reporta estado al apiserver, hace healthchecks. |
| `kube-proxy` | Programa iptables/IPVS/nftables para implementar Services (o cede el paso a un CNI que lo hace). |
| **Container runtime** | containerd (default), CRI-O, o docker-shim (deprecado). Corre los contenedores vía OCI. |
| **CNI plugin** | Cilium, Calico, Flannel, AWS VPC CNI. Asigna IPs a Pods y programa red. |
| **CSI plugin** | Driver de storage: EBS, GCE PD, Azure Disk, Longhorn, Rook, Ceph. |

El flujo de un `kubectl apply -f deployment.yaml`:

1. `kubectl` envía el YAML a `kube-apiserver` con auth mTLS o token.
2. Apiserver autentica, autoriza (RBAC), corre **admission controllers** (mutating y validating; Kyverno/OPA se enganchan aquí).
3. Escribe el objeto en `etcd`.
4. El **Deployment controller** observa el nuevo Deployment y crea un ReplicaSet.
5. El **ReplicaSet controller** observa el RS y crea Pods.
6. Los Pods aparecen sin `spec.nodeName` asignado.
7. `kube-scheduler` filtra nodos elegibles (taints, resources, affinity, PVC) y hace scoring; asigna `nodeName`.
8. El `kubelet` del nodo elegido observa "pod para mí", pide a containerd que baje la imagen y arranque los contenedores.
9. `kubelet` reporta status; `kube-proxy` programa red; Endpoints se actualizan; el Service comienza a rutear tráfico.

Todo el sistema es **eventualmente consistente** vía watch streams sobre `etcd`. Nada es imperativo; nada se le "dice a un nodo qué hacer" directamente.

---

## 3. Pods: la unidad atómica (nivel básico)

Un Pod es un **grupo de 1+ contenedores co-programados** que comparten:

- **Network namespace**: mismo IP, mismos puertos, se hablan por `localhost`.
- **IPC**: pueden usar señales POSIX y semáforos entre sí.
- **UTS**: mismo hostname.
- **Storage**: volúmenes montables por todos los contenedores del Pod.
- **Lifecycle**: nacen y mueren juntos.

La mayoría de Pods tienen **un solo contenedor**. Los multi-container tienen un caso de uso legítimo: **sidecar pattern** (log shipper, service mesh proxy tipo Envoy, config sync, secrets injector). En Kubernetes 1.29+ los sidecars son nativos (init container con `restartPolicy: Always`) — ver [cap 08 §7](./08-kubernetes-workloads.md).

Ejemplo de Pod simple (raro crearlo directamente; casi siempre viene por Deployment):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hello
  labels:
    app: hello
    tier: web
spec:
  containers:
    - name: web
      image: nginx:1.27.1
      ports:
        - containerPort: 80
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits:   { cpu: 500m, memory: 256Mi }
      readinessProbe:
        httpGet: { path: /, port: 80 }
        initialDelaySeconds: 2
        periodSeconds: 5
      livenessProbe:
        httpGet: { path: /, port: 80 }
        initialDelaySeconds: 10
        periodSeconds: 20
```

Un Pod es **efímero e inmutable**: si su nodo cae o se hace `kubectl delete pod`, no "resucita" con el mismo nombre e IP; el controlador padre (Deployment/StatefulSet) crea uno **nuevo**. Nunca dependas del nombre o IP de un Pod específico; para direccionamiento estable usa Services ([cap 09](./09-kubernetes-networking-y-storage.md)).

Estados del Pod (`phase`):

- `Pending`: aceptado, sin scheduler o esperando pull de imagen / PVC.
- `Running`: al menos un container ejecutándose.
- `Succeeded`: todos los containers acabaron con exit 0 (típico de Jobs).
- `Failed`: al menos un container acabó con exit != 0 y no reintenta.
- `Unknown`: apiserver no puede contactar al kubelet.

Un status más útil es `conditions` (`PodScheduled`, `Initialized`, `ContainersReady`, `Ready`). El **`Ready` condition** es lo que decide si un Service enruta tráfico al Pod.

---

## 4. Deployments y ReplicaSets: stateless apps (nivel básico-medio)

Un **Deployment** es el controlador estándar para apps stateless. Gestiona **ReplicaSets** para conseguir:

- Número deseado de réplicas.
- **Rolling updates** sin downtime.
- **Rollback** a versiones anteriores.
- **Pausing** de rollouts para canaries manuales.

Ejemplo canónico:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels: { app: api }
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%          # nuevos pods extra durante el update
      maxUnavailable: 0      # cero downtime: mata solo cuando nuevos ready
  selector:
    matchLabels: { app: api }
  revisionHistoryLimit: 5
  progressDeadlineSeconds: 600
  template:
    metadata:
      labels: { app: api }
    spec:
      containers:
        - name: api
          image: ghcr.io/miorg/api:1.4.2
          ports: [{ containerPort: 8080 }]
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          readinessProbe:
            httpGet: { path: /ready, port: 8080 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /live, port: 8080 }
            initialDelaySeconds: 30
            periodSeconds: 20
      terminationGracePeriodSeconds: 30
```

Operaciones sobre Deployments:

```bash
# Actualizar imagen (crea ReplicaSet nuevo, hace rolling update)
kubectl set image deployment/api api=ghcr.io/miorg/api:1.4.3

# Ver historia
kubectl rollout history deployment/api
kubectl rollout history deployment/api --revision=3

# Rollback a la revisión anterior o específica
kubectl rollout undo deployment/api
kubectl rollout undo deployment/api --to-revision=3

# Estado del rollout (bloquea hasta terminar o timeout)
kubectl rollout status deployment/api --timeout=5m

# Pausar/reanudar (útil para canary manual)
kubectl rollout pause  deployment/api
kubectl rollout resume deployment/api

# Escalar manualmente
kubectl scale deployment/api --replicas=5

# Reiniciar todos los pods (rolling)
kubectl rollout restart deployment/api
```

**Estrategias de update**:

- `RollingUpdate` (default): reemplazo progresivo. Controla `maxSurge` y `maxUnavailable`.
- `Recreate`: mata todos y crea todos. Downtime garantizado. Solo para apps que no toleran versiones mezcladas (schema migrations).

Para blue/green y canary sofisticados no uses Deployment nativo; usa Argo Rollouts o Flagger ([cap 15 — GitOps con ArgoCD/Flux](./15-gitops-con-argocd-y-flux.md)).

**Anti-patrones frecuentes**:

- `maxUnavailable: 25%` en clusters pequeños con 4 réplicas → siempre 1 pod menos aceptando tráfico. Si tu app necesita capacidad estricta, `maxUnavailable: 0`.
- `image: myapp:latest` — invalida el rollback y hace no reproducible el despliegue. Usa tag inmutable o digest.
- `readinessProbe` sin `initialDelaySeconds` en apps lentas → primeros pods marcados unhealthy y matados. Usa `startupProbe` (ver [cap 08](./08-kubernetes-workloads.md)).
- No fijar `resources.requests`: el scheduler no puede planificar bien y el pod cae en QoS `BestEffort`, primer candidato a eviction.

---

## 5. kubectl operativo (nivel medio)

`kubectl` es un cliente Go que habla con `kube-apiserver`. Todo lo que hace la UI (Rancher, Lens, k9s) es equivalente a llamadas kubectl.

**El comando que salvó a más ingenieros**: `kubectl explain`.

```bash
kubectl explain deployment.spec.strategy.rollingUpdate
kubectl explain pod.spec.securityContext --recursive
```

Devuelve el schema oficial de la API. No hay excusa para buscar en Stack Overflow qué campo va dónde.

**Verbos principales**:

```bash
# Ver recursos
kubectl get pods -n prod -o wide
kubectl get all -A                 # todos los tipos, todos los namespaces
kubectl get deploy api -o yaml     # export completo
kubectl get pods -l app=api,tier=web    # filtrado por labels

# Describir (eventos + estado detallado; primer sitio a mirar cuando algo falla)
kubectl describe pod api-abc123

# Logs
kubectl logs -f deploy/api                      # sigue logs de todos los pods
kubectl logs api-abc123 -c sidecar --previous   # container específico, instancia anterior
kubectl logs -l app=api --tail=100 --max-log-requests=20

# Exec y port-forward (debug local)
kubectl exec -it api-abc123 -- sh
kubectl port-forward svc/api 8080:80

# Aplicar y borrar
kubectl apply -f k8s/                # aplica todo el directorio
kubectl diff  -f k8s/                # ver qué cambiaría (dry-run server-side)
kubectl delete -f k8s/deploy.yaml

# Editar in-place (útil en emergencias; no queda en Git)
kubectl edit deployment/api

# Contextos y namespaces (varios clusters)
kubectl config get-contexts
kubectl config use-context prod-us-east-1
kubectl config set-context --current --namespace=payments
```

**Server-side apply** (Kubernetes 1.22+, estable 1.26):

```bash
kubectl apply --server-side -f deploy.yaml --field-manager=team-api
```

Cada campo pertenece a un "field manager"; conflictos entre managers (kubectl vs controller vs Argo) se detectan explícitamente en lugar de sobrescribir silenciosamente. Argo CD, Flux, Helm 3.13+ usan server-side apply por defecto.

**Herramientas complementarias**:

- **k9s**: TUI para navegación rápida.
- **stern**: logs multi-pod con colores.
- **kubectx / kubens**: switch rápido entre contextos y namespaces.
- **kubectl-neat**: limpia YAML del apiserver eliminando campos añadidos por el servidor.
- **kube-linter, kubeaudit**: linters de manifests.

---

## 6. Namespaces (nivel medio)

Un **Namespace** es una partición lógica dentro del cluster. Es aislamiento **débil**: no es seguridad multi-tenant real (para eso hace falta también NetworkPolicies, RBAC, ResourceQuotas y potencialmente clusters separados), pero sí evita colisiones de nombres y ordena el cluster por equipo/entorno.

Recursos **namespaced** (viven dentro de un namespace): Pod, Deployment, Service, ConfigMap, Secret, PVC, Job, CronJob, Role, RoleBinding, ServiceAccount…

Recursos **cluster-scope**: Node, Namespace, PersistentVolume, StorageClass, ClusterRole, ClusterRoleBinding, CRD.

Namespaces creados automáticamente:

- `default`: donde va todo si no especificas.
- `kube-system`: componentes del control plane (kube-proxy, CoreDNS, CNI).
- `kube-public`: recursos públicos, legibles sin auth.
- `kube-node-lease`: leases de heartbeat de nodes.

**Convención**: **nunca despliegues en `default`** en un cluster serio. Crea namespaces por equipo (`payments`, `search`, `identity`) o por entorno si el cluster es multi-env (`staging`, `prod`).

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    team: payments-core
    env: prod
    pod-security.kubernetes.io/enforce: restricted     # Pod Security Standards
    pod-security.kubernetes.io/enforce-version: v1.34
```

**ResourceQuota** para limitar consumo total:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: payments-quota
  namespace: payments
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    pods: "100"
    persistentvolumeclaims: "20"
    count/deployments.apps: "30"
    count/services: "20"
```

**LimitRange** para defaults por Pod:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: payments-limits
  namespace: payments
spec:
  limits:
    - type: Container
      default:        { cpu: 200m, memory: 256Mi }   # limits si no se especifican
      defaultRequest: { cpu: 100m, memory: 128Mi }   # requests default
      max:            { cpu: "4",  memory: 8Gi }
      min:            { cpu: 10m,  memory: 32Mi }
```

Sin `LimitRange`, un dev que se olvida de `resources:` deja un Pod en QoS `BestEffort`, que el kubelet mata primero bajo presión de memoria ([cap 08 §5](./08-kubernetes-workloads.md)).

---

## 7. Labels, selectors y annotations (nivel medio)

**Labels** son metadatos `clave=valor` diseñados para **query**. Casi toda la interconexión de Kubernetes se hace por labels:

- Un `Service` selecciona qué Pods son sus endpoints (`selector: { app: api }`).
- Un `Deployment` selecciona qué ReplicaSets/Pods gestiona.
- Un `NetworkPolicy` selecciona qué Pods se comunican.
- Un `HorizontalPodAutoscaler` mide sobre pods que matchean un selector.

Recomendación de convención (labels bien conocidos, [Kubernetes docs](https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/)):

```yaml
metadata:
  labels:
    app.kubernetes.io/name: api
    app.kubernetes.io/instance: api-prod
    app.kubernetes.io/version: "1.4.2"
    app.kubernetes.io/component: backend
    app.kubernetes.io/part-of: linguadev
    app.kubernetes.io/managed-by: argocd
```

**Selectores** en queries:

```bash
kubectl get pods -l 'app.kubernetes.io/name=api'
kubectl get pods -l 'env in (staging, prod), tier notin (batch)'
kubectl get pods -l 'critical'                  # existe la key (sin valor)
kubectl get pods -l '!critical'                 # NO existe la key
```

**Annotations** son también `clave=valor`, pero **no se usan para queries**. Sirven para:

- Metadatos ricos: `git.commit`, `build.pipeline.url`.
- Configuración de controllers: `kubectl.kubernetes.io/last-applied-configuration`, `prometheus.io/scrape: "true"`, `service.beta.kubernetes.io/aws-load-balancer-type: "nlb"`.
- CRDs de operators que necesitan pasar información.

Regla mnemónica: **si necesitas filtrar por ello, es label; si es solo informativo o configuración de controller, es annotation**.

---

## 8. ConfigMaps y Secrets (nivel medio-avanzado)

**ConfigMap**: pares clave=valor no confidenciales inyectables como env vars, argumentos CLI o ficheros montados.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
  namespace: payments
data:
  LOG_LEVEL: info
  MAX_CONNECTIONS: "200"
  feature-flags.json: |
    {
      "newCheckout": true,
      "experimentalCache": false
    }
```

Uso desde un Pod:

```yaml
spec:
  containers:
    - name: api
      envFrom:
        - configMapRef: { name: api-config }
      volumeMounts:
        - name: config
          mountPath: /etc/app
          readOnly: true
  volumes:
    - name: config
      configMap:
        name: api-config
        items:
          - key: feature-flags.json
            path: feature-flags.json
```

**Cambio de ConfigMap NO reinicia pods automáticamente**. Dos soluciones:

1. Hash del ConfigMap como annotation del template (Helm hace esto con `checksum/config`).
2. Herramientas como [Reloader](https://github.com/stakater/Reloader) que observan cambios y disparan `kubectl rollout restart`.

**Secrets**: mismo modelo pero con contenido **base64**-encoded (no cifrado; base64 es solo codificación). El cifrado real requiere:

- **etcd encryption at rest** (config del apiserver `--encryption-provider-config`), preferiblemente con KMS (`aescbc` con provider `kms`).
- **External Secrets Operator** para no meter secretos en Git; sincroniza desde AWS Secrets Manager, Vault, GCP Secret Manager.
- **Sealed Secrets** de Bitnami: cifra Secret manifests con clave pública del cluster; se pueden meter en Git.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-secrets
  namespace: payments
type: Opaque
stringData:                # stringData es plaintext; K8s lo pasa a base64
  DATABASE_URL: postgres://user:pass@db.internal:5432/app
  JWT_SIGNING_KEY: ${GENERATED_AT_DEPLOY}
```

Consumo por env vars:

```yaml
envFrom:
  - secretRef: { name: api-secrets }
```

O como file (monta cada key como archivo en `mountPath`):

```yaml
volumeMounts:
  - name: creds
    mountPath: /var/run/secrets/db
    readOnly: true
volumes:
  - name: creds
    secret:
      secretName: api-secrets
      defaultMode: 0400
```

**Prácticas obligatorias 2026**:

- Habilitar **encryption at rest** en etcd con KMS. Sin esto, cualquiera con acceso a los backups del control plane lee todos los secretos en texto claro.
- Nunca meter Secrets en Git en texto claro. Sealed Secrets o External Secrets Operator.
- Rotación regular. Vault + External Secrets Operator con `refreshInterval: 1h` renueva credenciales dinámicas ([cap 23 — Secrets management](./23-secrets-management-vault-kms.md)).
- **`ImageVolume`** (Kubernetes 1.31 alpha, 1.34 beta con feature gate): permite montar una OCI image como volumen de solo lectura para distribuir configs/modelos ML como imágenes firmadas. Se irá popularizando en 2026.

---

## 9. Cuándo usar Kubernetes (y cuándo no) (nivel avanzado)

Decidir "K8s sí / K8s no" es una de las conversaciones más caras del año en cualquier equipo. Framework de decisión útil:

**Señales a favor**:

- Múltiples servicios (>5) con lifecycle independiente.
- Requisitos serios de autoscaling reactivo con métricas custom.
- Batch jobs, cron jobs, colas de trabajo con patrones variables.
- Multi-tenant con NetworkPolicies + RBAC + Quotas.
- Requisito de portabilidad (multi-cloud o cloud→on-prem).
- Ecosistema de operators que necesitas (Kafka, PostgreSQL, Redis, ML).
- Equipo dedicado de plataforma (o presupuesto para managed EKS/GKE + un especialista).

**Señales en contra**:

- Un solo servicio web, tráfico previsible.
- Equipo pequeño (<10 devs) sin platform engineer.
- Startup pre-PMF donde velocidad de iteración > eficiencia de infra.
- Presupuesto de infra bajo (managed K8s cuesta ~$70/mes control plane + workers).

**Alternativas por caso**:

| Caso | Mejor alternativa |
|---|---|
| Monolito Django/Rails de una empresa mediana | Fly.io, Render, Railway, Heroku |
| API stateless en AWS con hierro AWS | ECS Fargate |
| Web + API + workers en GCP | Cloud Run + Cloud Run Jobs |
| Workloads batch predecibles | AWS Batch, GCP Batch |
| Event-driven puro | AWS Lambda + EventBridge, Cloudflare Workers |
| Workloads mixtos con Hashi stack | Nomad + Consul + Vault |
| Datos serios (base + app) | RDS + ECS Fargate (o similar en tu cloud) |

Kubernetes tiene sentido cuando la escala/complejidad rebasa la abstracción anterior. Adoptarlo antes de tiempo es un impuesto operativo del 20-40% del tiempo del equipo. Recomendación 2026: **empieza en managed** (EKS Auto Mode, GKE Autopilot, AKS Automatic) para que el control plane y los nodos sean problema del cloud provider. Solo self-host cuando tengas razones fuertes (soberanía, latencia, coste a escala grande).

**Perfiles de distribución 2026**:

- **EKS Auto Mode** (AWS, GA 2024): AWS gestiona control plane + nodos + addons esenciales. Casi serverless K8s.
- **GKE Autopilot** (Google): filosofía similar; solo pagas por pods.
- **k3s / k0s / MicroK8s**: distros ligeras para edge, single-node, dev.
- **Talos Linux**: OS inmutable para K8s, API-driven, sin SSH.
- **OpenShift**: enterprise superset de K8s con opinions fuertes (Red Hat).
- **Rancher**: multi-cluster management sobre K8s upstream o RKE2.

---

## 10. Ejercicios verificables

**Ejercicio 1 — Cluster local con kind.** Crea un cluster kind con 1 control-plane + 2 workers. Verifica con `kubectl get nodes -o wide` que las 3 aparecen en `Ready`. Ejecuta `kubectl get pods -A` y anota qué corre en `kube-system`.

**Ejercicio 2 — Primer Deployment.** Aplica un Deployment de nginx con 3 réplicas, resources limits, readiness y liveness probes. Verifica con `kubectl get pods -l app=nginx -o wide` que las 3 están `Ready` y en nodos diferentes. Simula un fallo con `kubectl delete pod <name>` y observa cómo se recrea.

**Ejercicio 3 — Rolling update + rollback.** Cambia la imagen con `kubectl set image` a una versión que no existe (`nginx:99.99`). Observa el rollout atascado con `kubectl rollout status --timeout=60s`. Haz `kubectl rollout undo` y verifica recuperación.

**Ejercicio 4 — Namespaces + Quotas.** Crea namespace `payments` con `pod-security.kubernetes.io/enforce=restricted`. Aplica una `ResourceQuota` limitando a 10 pods y una `LimitRange` con defaults. Intenta desplegar un Deployment con 15 réplicas y otro con contenedor privileged. Ambos deben fallar por razones distintas; documéntalas.

**Ejercicio 5 — ConfigMap + Secret rotation.** Crea un ConfigMap y un Secret. Móntalos en un Pod (env vars + files). Modifica el ConfigMap con `kubectl edit`; verifica que el Pod NO recoge el cambio automáticamente. Reinicia con `kubectl rollout restart deploy/x` y confirma que el valor nuevo llega. Extra: instala Reloader y comprueba que el rollout se dispara solo.

**Ejercicio 6 — Labels práctico.** Etiqueta 3 Deployments con `app.kubernetes.io/part-of=linguadev`. Escribe una query kubectl que liste solo los Pods con `env in (staging, prod)` y `tier=backend`. Verifica que el filtro funciona con `-l`.

**Referencia al simulacro:**

- Path del JSON: [`packages/content/src/tech/devops/sim-07-kubernetes-fundamentals.json`](../../packages/content/src/tech/devops/sim-07-kubernetes-fundamentals.json)
- ID interno: `devops-sim-07-kubernetes-fundamentals`

---

## Navegación

- Prev: [Cap 06 — Container security y registries](./06-container-security-y-registries.md)
- Next: [Cap 08 — Kubernetes workloads →](./08-kubernetes-workloads.md)
