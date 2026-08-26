# Capítulo 08 — Kubernetes workloads, probes, resources y autoscaling

> **Focus:** Elegir el controlador correcto (Deployment, StatefulSet, DaemonSet, Job, CronJob), diseñar probes (readiness, liveness, startup), gestionar recursos y QoS, autoscalar con HPA/VPA/Karpenter, e implementar patrones init/sidecar (nativos desde 1.29).
> **Áreas:** Kubernetes · Autoscaling · Reliability
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Cap 07 — Fundamentos de Kubernetes ([cap 07](./07-fundamentos-kubernetes.md)) sólido.
- Manejo de kubectl y namespaces.
- Nociones de containers y probes básicos ([cap 05](./05-fundamentos-docker.md)).
- Un cluster funcional (kind, minikube, EKS/GKE/AKS dev).

**Glosario mínimo:**
- **Deployment**: controlador para apps stateless con rolling update y rollback.
- **StatefulSet**: controlador para apps con identidad estable (`app-0`, `app-1`), orden de arranque, PVC por pod.
- **DaemonSet**: un Pod por nodo (log shippers, node exporters, CSI/CNI).
- **Job**: ejecuta N pods hasta completion; útil para batch.
- **CronJob**: crea Jobs según schedule cron.
- **HPA**: Horizontal Pod Autoscaler; escala réplicas según métricas.
- **VPA**: Vertical Pod Autoscaler; ajusta requests/limits automáticamente.
- **Cluster Autoscaler / Karpenter**: escalado de nodos.
- **QoS class**: `Guaranteed`, `Burstable`, `BestEffort`. Determina orden de eviction.
- **PDB (PodDisruptionBudget)**: garantiza un mínimo de pods disponibles durante disruption voluntaria (drain).
- **Probes**: `livenessProbe`, `readinessProbe`, `startupProbe`.
- **Init container**: contenedor que corre a completion antes del main.
- **Native sidecar**: init container con `restartPolicy: Always`. GA en Kubernetes 1.33 (abril 2025), disponible sin feature gate en 1.34.

**Setup mínimo (Kubernetes 1.34, agosto 2026):**

```bash
# Metrics server (necesario para HPA basado en CPU/memory)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system wait --for=condition=available deploy/metrics-server --timeout=90s

# Verificar
kubectl top nodes
kubectl top pods -A

# (Opcional) Karpenter v1 (GA feb 2025) para escalado de nodos en EKS
# Ver docs oficiales: https://karpenter.sh
```

---

## 1. El gran cuadro

Kubernetes no ejecuta contenedores; **ejecuta controladores que ejecutan Pods**. Cada workload real cae en una de cinco categorías con controlador dedicado: stateless (Deployment), stateful con identidad (StatefulSet), un pod por nodo (DaemonSet), tarea a completion (Job), y tarea periódica (CronJob). Elegir el equivocado se paga caro: usar Deployment para una base de datos con réplicas rompe la replicación en cada reprogramación; usar StatefulSet para una API stateless duplica innecesariamente la latencia de rollouts.

Sobre el controlador se construye una segunda capa de decisiones: **probes** (¿cuándo está listo mi pod para tráfico? ¿cuándo hay que reiniciarlo?), **resources y QoS** (¿cuánta CPU y memoria pido? ¿qué pasa cuando el nodo está bajo presión?), **autoscaling** en tres ejes (réplicas con HPA, vertical con VPA, nodos con Cluster Autoscaler o Karpenter) y **patrones de composición** (init containers para setup, sidecars nativos desde 1.29 para telemetría, service mesh, secretos).

Este capítulo cubre las cinco categorías de workload con ejemplos reales, la teoría y práctica de probes (incluido por qué la liveness que consulta la DB es un antipatrón caro), el modelo QoS con casos reales de eviction, y los tres autoscalers con configuraciones canónicas para 2026. Cierra con Karpenter v1 (GA feb 2025) y con el patrón nativo de sidecars que reemplaza al hack tradicional de container-en-mismo-Pod.

---

## 2. Deployment vs StatefulSet vs DaemonSet (nivel básico)

**Deployment** — apps stateless, pods intercambiables, cualquier réplica sirve cualquier request.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  replicas: 3
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: ghcr.io/miorg/api:1.4.2
```

Nombres random (`api-abc123-x7y8`), IPs random, sin storage persistente ligado al pod. Perfect fit para APIs HTTP, workers stateless, batch computados en memoria.

**StatefulSet** — identidad estable, orden, storage persistente por pod.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres }
spec:
  serviceName: postgres           # headless Service asociado (obligatorio)
  replicas: 3
  selector: { matchLabels: { app: postgres } }
  podManagementPolicy: OrderedReady    # o Parallel (default OrderedReady)
  template:
    metadata: { labels: { app: postgres } }
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: postgres
          image: postgres:16.4-alpine
          env:
            - { name: POSTGRES_PASSWORD, valueFrom: { secretKeyRef: { name: pg, key: password } } }
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3
        resources: { requests: { storage: 50Gi } }
```

Los pods se llaman `postgres-0`, `postgres-1`, `postgres-2` y arrancan en ese orden (a menos que `podManagementPolicy: Parallel`). Cada uno recibe su propio PVC (`data-postgres-0`, `data-postgres-1`…) que sobrevive rescheduling. DNS estable por pod (`postgres-0.postgres.default.svc.cluster.local`) vía headless Service.

Cuándo StatefulSet: bases de datos con réplicas (Postgres, MySQL), colas distribuidas (Kafka, RabbitMQ), stores (Elasticsearch, Cassandra, MongoDB, etcd), Redis clustered. En 2026, para casi todas estas se recomienda un **operator** (Zalando Postgres Operator, Strimzi Kafka, Bitnami charts) que gestione la orquestación por ti; usan StatefulSet internamente pero exponen APIs de más alto nivel.

**DaemonSet** — un Pod por nodo (o subset).

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: fluent-bit, namespace: kube-system }
spec:
  selector: { matchLabels: { app: fluent-bit } }
  template:
    metadata: { labels: { app: fluent-bit } }
    spec:
      tolerations:
        - operator: Exists   # tolera cualquier taint (correr en control-plane también)
      containers:
        - name: fluent-bit
          image: fluent/fluent-bit:3.1.9
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits:   { cpu: 200m, memory: 200Mi }
          volumeMounts:
            - { name: varlog, mountPath: /var/log, readOnly: true }
            - { name: config, mountPath: /fluent-bit/etc }
      volumes:
        - name: varlog
          hostPath: { path: /var/log }
        - name: config
          configMap: { name: fluent-bit-config }
```

Casos típicos: log shippers (Fluent Bit, Vector), node exporters (Node Exporter, cAdvisor), agentes de seguridad (Falco), CNI plugins (Cilium, Calico), CSI drivers, service mesh sidecars a nivel de nodo.

Para limitar a un subset de nodos, usa `nodeSelector` o `nodeAffinity`:

```yaml
nodeSelector:
  node.kubernetes.io/instance-type: g6.xlarge   # solo GPU nodes
```

---

## 3. Job y CronJob (nivel básico-medio)

**Job** ejecuta uno o más pods hasta completion (exit 0). Ideal para migrations, tareas de setup, encoding de vídeo, ML training.

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: db-migrate }
spec:
  backoffLimit: 3                # reintentos ante fallo
  activeDeadlineSeconds: 600     # timeout total
  ttlSecondsAfterFinished: 3600  # borra objeto tras 1h de completar
  parallelism: 1
  completions: 1
  template:
    spec:
      restartPolicy: OnFailure   # o Never (Job requiere uno de estos dos)
      containers:
        - name: migrate
          image: ghcr.io/miorg/api:1.4.2
          command: ["node", "scripts/migrate.js"]
          env:
            - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: db, key: url } } }
```

**Modos de Job**:

- **Non-parallel** (default): `completions=1, parallelism=1`. Una ejecución.
- **Fixed completions**: `completions=N, parallelism=M`. Ejemplo `completions=100, parallelism=10`: 100 tareas, 10 en paralelo.
- **Work queue**: `completions` omitido, cada pod decide cuándo salir (leyendo de una cola).
- **Indexed** (`completionMode: Indexed`, GA 1.24): cada pod recibe `JOB_COMPLETION_INDEX` env var; útil para sharding paralelo determinista (ML batch, ETL particionado).

**CronJob** crea Jobs según schedule cron:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly-backup }
spec:
  schedule: "0 3 * * *"            # cron estándar: cada día a las 03:00
  timeZone: "Europe/Madrid"        # (GA 1.27+)
  concurrencyPolicy: Forbid        # Allow | Forbid | Replace
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  startingDeadlineSeconds: 300     # si K8s no arranca en 5min, skip
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: ghcr.io/miorg/backup:1.0
              args: ["--target", "s3://backups/db"]
```

Gotchas: si el cluster está sobrecargado y un cronjob no arranca a tiempo, sin `startingDeadlineSeconds` se puede acumular. `concurrencyPolicy: Forbid` es defensa contra ejecuciones solapadas cuando el schedule es más frecuente que la duración.

---

## 4. Probes: readiness, liveness, startup (nivel medio)

Tres probes con propósitos distintos. Confundirlos causa outages.

- **`readinessProbe`**: ¿este pod acepta tráfico? Fallar quita el pod de los Endpoints del Service; **no** lo reinicia. Perfect para dependencias externas: si mi cache está fría o mi conexión a DB no está lista, dejo de recibir tráfico pero no muero.
- **`livenessProbe`**: ¿este pod está vivo? Fallar mata el container (que kubelet reinicia según policy). Debe ser una comprobación **local y barata**. Nunca consultes deps externas aquí.
- **`startupProbe`** (GA 1.20): protege el startup lento. Mientras esté ACTIVE, las otras dos se posponen. Cuando pasa la primera vez, se desactiva.

Ejemplo completo:

```yaml
containers:
  - name: api
    image: ghcr.io/miorg/api:1.4.2
    ports: [{ containerPort: 8080 }]
    startupProbe:
      httpGet: { path: /startup, port: 8080 }
      periodSeconds: 5
      failureThreshold: 60           # hasta 5 min para arrancar
    readinessProbe:
      httpGet: { path: /ready, port: 8080 }
      periodSeconds: 5
      timeoutSeconds: 2
      failureThreshold: 3
    livenessProbe:
      httpGet: { path: /live, port: 8080 }
      periodSeconds: 20
      timeoutSeconds: 3
      failureThreshold: 3
```

**Diseño de endpoints**:

- `/live` — solo comprueba que el proceso responde. `return 200` literal.
- `/ready` — comprueba dependencias locales (pool DB inicializado, cache warmed). Puede consultar deps críticas con timeout corto pero **con circuit breaker**: si la dep externa falla, no marca todos los pods `NotReady` a la vez.
- `/startup` — chequeo de estado inicial (migrations aplicadas, warm-up completo). Solo relevante en primeros N segundos.

**Anti-patrón mortal**: `livenessProbe` que hace `SELECT 1` a Postgres. Cuando Postgres tiene un hipo de 10 s, **todos** tus pods fallan liveness a la vez, K8s los reinicia todos, y cuando Postgres vuelve todos intentan reconectar simultáneamente. Cascada de fallos. La regla: **liveness comprueba el proceso; readiness comprueba dependencias**.

**Probes con `exec`** (para no-HTTP):

```yaml
readinessProbe:
  exec:
    command: ["/bin/sh", "-c", "pg_isready -U app -d app -h 127.0.0.1"]
  periodSeconds: 10
```

**Probes con `grpc`** (GA 1.27):

```yaml
livenessProbe:
  grpc:
    port: 9090
    service: myservice.HealthCheck    # opcional
```

---

## 5. Resources: requests, limits, QoS classes (nivel medio-avanzado)

`resources.requests` es la **reserva** para el scheduler: garantiza que el nodo tiene al menos eso libre antes de programar el Pod. `resources.limits` es el **techo**: si el container excede, será estrangulado (CPU) o matado (memoria, OOMKilled).

```yaml
resources:
  requests:
    cpu: 500m           # 0.5 CPU
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 1Gi
```

**Regla operativa 2026**:

- **CPU**: fija `requests` con margen para no sobre-reservar; para `limits` hay debate. La escuela clásica pone limits para prevenir noisy neighbor; escuelas más modernas (Kepler, Google SRE Book) advierten que los limits de CPU introducen throttling **incluso con CPU libre** (bug histórico del kernel < 5.4 mitigado pero no eliminado), y prefieren omitir limits de CPU. Para 2026, si no tienes multi-tenant hostil, considera **omitir limits de CPU** y confiar en `requests` + prioridad + PDB.
- **Memoria**: `requests == limits` es lo más simple y predecible. Si `limits > requests` puedes ser OOMKilled cuando otros pods compiten por memoria.

**QoS classes** (asignadas automáticamente):

| Clase | Regla | Comportamiento en eviction |
|---|---|---|
| `Guaranteed` | Todos los containers tienen requests == limits para CPU y memoria | Última en ser evicted |
| `Burstable` | Al menos un request > 0, pero no cumple Guaranteed | Segunda en eviction |
| `BestEffort` | Sin requests ni limits | Primera en ser evicted bajo presión |

Para workloads producción críticos, apunta a `Guaranteed`. Para batch y jobs tolerantes, `Burstable` está bien. **Nunca dejes producción en `BestEffort`**; el kubelet los mata al primer signo de node pressure.

Ver clase real:

```bash
kubectl get pod api-abc123 -o jsonpath='{.status.qosClass}{"\n"}'
```

**Ejemplo de eviction**: nodo con 8 GiB. Pods asignados: 4 `Guaranteed` reservando 6 GiB; 3 `Burstable` que en total usan otros 1.5 GiB pero solo reservaron 0.5 GiB; 5 `BestEffort` que crecieron a 500 MiB cada uno. Total real: >8 GiB. El kubelet mata primero los BestEffort en orden de uso; después Burstable si sigue la presión.

---

## 6. HPA, VPA y Cluster Autoscaler / Karpenter (nivel avanzado)

Tres ejes de autoscaling. Cada uno resuelve un problema distinto y **se combinan**.

### 6.1 HorizontalPodAutoscaler (HPA)

Escala réplicas según métricas. Basado en `autoscaling/v2`. Necesita `metrics-server` para CPU/memoria; para métricas custom, `prometheus-adapter` o `keda`.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: api }
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 3
  maxReplicas: 30
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 60 }
    - type: Resource
      resource:
        name: memory
        target: { type: AverageValue, averageValue: 400Mi }
    - type: Pods
      pods:
        metric: { name: http_requests_per_second }
        target: { type: AverageValue, averageValue: "100" }
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - { type: Percent, value: 25, periodSeconds: 60 }
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - { type: Percent, value: 100, periodSeconds: 30 }
        - { type: Pods,    value: 5,   periodSeconds: 30 }
      selectPolicy: Max
```

`behavior` (GA 1.23) es imprescindible para producción: scale-up rápido (100% en 30 s), scale-down conservador (25% cada 60 s con ventana 5 min) evita oscilaciones ("flapping").

**KEDA** ([keda.sh](https://keda.sh)) extiende HPA para escalar por **eventos**: longitud de cola Kafka/RabbitMQ/SQS, lag de consumer group, count de mensajes pendientes. Puede escalar a 0. Prácticamente estándar en 2026 para workers event-driven.

### 6.2 VerticalPodAutoscaler (VPA)

Ajusta `requests` y `limits` automáticamente basándose en uso histórico. Tres modos: `Off` (solo recomienda), `Initial` (fija al crear), `Auto` (recrea pod con nuevos valores). En 2026 **VPA en `Auto` es incompatible con HPA por CPU/memoria en el mismo target** (compiten). Patrones válidos:

- HPA por métrica externa (RPS, cola) + VPA `Auto` para dimensionar cada pod.
- VPA `Off` (recomendación) para dimensionar manualmente después.

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata: { name: api }
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  updatePolicy: { updateMode: Auto }
  resourcePolicy:
    containerPolicies:
      - containerName: api
        minAllowed: { cpu: 100m, memory: 128Mi }
        maxAllowed: { cpu: "2",  memory: 2Gi  }
        controlledResources: ["cpu", "memory"]
```

VPA `Auto` recrea pods; **respeta tu PDB** (§8) pero fuerza rolling reboots. Para stateless está bien; para stateful evalúa cuidadosamente.

**In-place pod resize** (Kubernetes 1.33 alpha, 1.34 beta): permite cambiar `resources.requests/limits` sin recrear el pod. Cambio de juego para VPA en workloads stateful; en 2026 hay que habilitarlo con feature gate `InPlacePodVerticalScaling`.

### 6.3 Cluster Autoscaler y Karpenter

Escalado horizontal de **nodos**. Cuando pods están `Pending` porque no cabe en los nodos existentes, se aprovisiona más capacidad; cuando hay nodos infrautilizados, se drenan y borran.

- **Cluster Autoscaler** (CA): opción clásica. Trabaja sobre node groups (ASG en AWS, MIG en GCP) fijos. Añade/quita nodos del grupo. Fricción: hay que definir tipos de nodo por adelantado.
- **Karpenter** (Amazon, OSS, v1 GA feb 2025): elige el tipo de instancia óptimo dinámicamente según los pods `Pending`. Menos ceremonia, mejor bin-packing, más rápido (~30 s vs varios minutos), soporta spot con fallback a on-demand.

Config Karpenter v1 (fragmento) — `NodePool`:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata: { name: default }
spec:
  template:
    spec:
      requirements:
        - key: "kubernetes.io/arch"
          operator: In
          values: ["amd64", "arm64"]
        - key: "kubernetes.io/os"
          operator: In
          values: ["linux"]
        - key: "karpenter.sh/capacity-type"
          operator: In
          values: ["spot", "on-demand"]
        - key: "karpenter.k8s.aws/instance-family"
          operator: In
          values: ["m7i", "m7g", "c7i", "c7g"]
        - key: "karpenter.k8s.aws/instance-size"
          operator: NotIn
          values: ["metal", "24xlarge", "48xlarge"]
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      expireAfter: 720h    # rota nodos cada 30 días
  limits:
    cpu: "2000"
    memory: 4000Gi
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
    budgets:
      - nodes: "20%"
```

En 2026 Karpenter es también soportado en Azure (AKS Karpenter Provider) y Alibaba; sigue siendo AWS-first.

---

## 7. Init containers, sidecars nativos y patrones (nivel avanzado)

Un **init container** corre a completion **antes** que los main containers. Casos: esperar a que una dep esté disponible, ejecutar migrations, descargar assets iniciales, generar config.

```yaml
spec:
  initContainers:
    - name: wait-for-db
      image: busybox:1.36
      command:
        - sh
        - -c
        - >
          until nc -z db.internal 5432; do
            echo "Waiting for DB…"; sleep 2;
          done
    - name: migrate
      image: ghcr.io/miorg/api:1.4.2
      command: ["node", "scripts/migrate.js"]
  containers:
    - name: api
      image: ghcr.io/miorg/api:1.4.2
```

Corren **secuencialmente** en el orden declarado. Si uno falla, el Pod falla y se reintenta (según restartPolicy).

**Sidecar tradicional** (pre-1.29): container adicional en `containers:`. Problemas:

- Startup order no garantizado (main puede arrancar antes que el sidecar de logging).
- Termination: en un Job, el Pod nunca acaba porque el sidecar no muere solo.
- Signal handling awkward: main termina, sidecar sigue.

**Sidecar nativo** (Kubernetes 1.28 alpha, 1.29 beta on-by-default, 1.33 GA en abril 2025, en 1.34+ disponible sin feature gate). Se declara como init container con `restartPolicy: Always`:

```yaml
spec:
  initContainers:
    - name: envoy-proxy
      image: envoyproxy/envoy:v1.31.0
      restartPolicy: Always    # <-- lo convierte en sidecar nativo
      ports: [{ containerPort: 15000 }]
      lifecycle:
        preStop:
          exec:
            command: ["sh", "-c", "sleep 15"]
  containers:
    - name: api
      image: ghcr.io/miorg/api:1.4.2
```

Ventajas frente al modelo antiguo:

1. **Startup ordering garantizado**: sidecars arrancan antes de los main containers.
2. **Shutdown ordering garantizado**: sidecars sobreviven hasta que todos los main terminan (crítico para log shippers y proxies).
3. **Compatible con Jobs**: el sidecar termina cuando el main sale.
4. **Terminación individual con `terminationGracePeriodSeconds`** por container (K8s 1.34).

Patrones actuales:

- **Service mesh** (Istio Ambient vs sidecar): en 2025-2026 Istio ambient mode gana terreno para reducir la sobrecarga del sidecar, pero el sidecar nativo sigue vigente en despliegues Linkerd, Consul Connect.
- **Log shipping**: Fluent Bit / Vector como sidecar por pod es raro en 2026 (más común como DaemonSet). Sidecar sigue útil cuando cada pod escribe a paths sin estructura homogénea.
- **Config sync / secret rotation**: sidecar que refresca ficheros desde Vault/Consul.

---

## 8. PodDisruptionBudget, drain y disruption (nivel avanzado)

Un **PDB** limita cuántos pods pueden estar indisponibles simultáneamente durante disruption **voluntaria** (drain, upgrade, VPA reboot). No aplica a disruption **involuntaria** (nodo cae, OOM).

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: api }
spec:
  minAvailable: 2                # o maxUnavailable: 1
  selector:
    matchLabels: { app: api }
```

Cuando alguien hace `kubectl drain node-3`, K8s respetará el PDB: no dejará caer réplicas por debajo del mínimo. Si el PDB no puede satisfacerse (por ejemplo `minAvailable: 2` con 2 réplicas y drain de las dos), el drain espera.

**Anti-patrones**:

- `minAvailable: 100%` con 1 réplica → drain imposible; los mantenimientos se atascan.
- Sin PDB en producción → durante autoscaler consolidations o upgrades puedes quedar en 0 réplicas por un instante.

**PDB obligatorio para**: cualquier workload con más de 1 réplica que sirva tráfico. Regla mínima: `maxUnavailable: 1` para stateless con 3+ réplicas.

**Disruption budget en Karpenter** (§6.3) es complementario: limita porcentaje de nodos que Karpenter puede reciclar por ventana temporal.

---

## 9. Priority, PreemptionPolicy y Overcommit (nivel avanzado)

**PriorityClass** ordena qué Pods sobreviven cuando el scheduler no puede colocar uno nuevo. Un Pod nuevo con priority alta puede **preemptar** (matar) a uno con priority baja para hacer sitio.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata: { name: critical }
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Workloads críticos que pueden desalojar pods menos prioritarios"
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  template:
    spec:
      priorityClassName: critical
```

Kubernetes trae dos PriorityClass built-in: `system-cluster-critical` y `system-node-critical` para componentes del control plane.

**PreemptionPolicy: Never**: el Pod no preempta a otros; se queda `Pending` si no hay sitio. Útil para batch que puede esperar.

**Overcommit consciente**: la suma de `requests` en un nodo debe ser ≤ capacidad del nodo. `limits` puede sumar por encima (overcommit); si todos los pods usan simultáneamente sus limits, el nodo entra en presión y el kubelet evicta según QoS. En un cluster bien dimensionado, overcommit 2:1 en CPU es común y ahorra costes; 2:1 en memoria es peligroso.

---

## 10. Ejercicios verificables

**Ejercicio 1 — Elegir controlador.** Diseña manifests para: (a) API HTTP stateless, (b) Postgres primario + 2 réplicas, (c) log shipper por nodo, (d) tarea de generación de reportes diarios a las 03:00, (e) job one-off de importación. Justifica en un comentario YAML por qué elegiste cada controlador.

**Ejercicio 2 — Probes correctos.** Toma un Deployment con probes que consultan la DB en liveness. Refactoriza a: `/live` local trivial, `/ready` con circuit breaker a la DB, `/startup` que espera migraciones. Simula caída de DB con `kubectl delete svc db` y verifica que los pods pasan a `NotReady` pero **no** son reiniciados. Vuelve a levantar la DB; los pods deben volver a `Ready` sin restart.

**Ejercicio 3 — HPA con behavior.** Crea un HPA con `minReplicas=2, maxReplicas=10`, target CPU 60%. Añade `behavior` con scale-up agresivo y scale-down conservador. Genera carga con `hey -z 5m -c 50 http://api/`. Observa `kubectl get hpa -w`. Documenta cuántos segundos tarda en escalar de 2 a 10 y de 10 de vuelta a 2.

**Ejercicio 4 — QoS class.** Crea 3 pods: uno sin resources, uno con solo requests, y uno con requests==limits. Verifica que las QoS asignadas son BestEffort, Burstable y Guaranteed. Simula presión de memoria con `stress-ng` y observa cuál eviction primero.

**Ejercicio 5 — Sidecar nativo.** Construye un Job con un main container (contador que hace 100 iteraciones) y un sidecar nativo (log shipper falso que hace `tail -f` sobre un emptyDir compartido). Verifica que: (a) el sidecar arranca antes que el main, (b) cuando el main termina el sidecar también termina, (c) el Job pasa a Succeeded (con el modelo antiguo no lo haría).

**Ejercicio 6 — PDB + drain.** Crea un Deployment con 3 réplicas y un PDB `minAvailable: 2`. Ejecuta `kubectl drain <node>` sobre el nodo que hospeda 2 réplicas. Verifica que el drain espera respetando el PDB. Sube el `minAvailable` a `3` y repite; el drain debe bloquearse permanentemente hasta que aumentes réplicas.

**Referencia al simulacro:**

- Path del JSON: [`packages/content/src/tech/devops/sim-08-kubernetes-workloads.json`](../../packages/content/src/tech/devops/sim-08-kubernetes-workloads.json)
- ID interno: `devops-sim-08-kubernetes-workloads`

---

## Navegación

- Prev: [Cap 07 — Fundamentos de Kubernetes](./07-fundamentos-kubernetes.md)
- Next: [Cap 09 — Kubernetes networking y storage →](./09-kubernetes-networking-y-storage.md)
