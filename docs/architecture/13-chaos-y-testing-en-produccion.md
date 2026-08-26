# Capítulo 13 — Chaos engineering y testing en producción

> **Focus:** Inducir fallos controlados en sistemas distribuidos para descubrir debilidades antes de que las descubra un incident real, con blast radius acotado y observability rica.
> **Áreas:** Resiliencia · Testing · Cultura SRE
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Conceptos de disponibilidad, SLI/SLO/SLA y patrones de resiliencia (retry, timeout, circuit breaker, bulkhead — ver [Cap 04 — resiliencia y fault tolerance](./04-patrones-de-resiliencia.md)).
- Fundamentos de observabilidad (traces, metrics, logs — ver [Cap 08 — observabilidad y SLOs](./05-observabilidad-y-escala.md)).
- Kubernetes básico o AWS EC2/EKS (para ejecutar experimentos).
- Feature flags y deploys progresivos (ver [Cap 12 — migraciones zero-downtime](./12-migraciones-zero-downtime.md)).
- Familiaridad con al menos una herramienta de observability (CloudWatch, Grafana, Honeycomb, Datadog).

**Glosario mínimo:**
- **Chaos engineering:** disciplina de experimentar sobre un sistema distribuido con el fin de generar confianza en su capacidad de resistir condiciones turbulentas en producción (definición Netflix, 2010).
- **Blast radius:** conjunto de usuarios, servicios o datos afectados por un experimento o un fallo. Se mide en % de tráfico, número de pods, regiones o clientes impactados.
- **Steady state:** hipótesis medible sobre el comportamiento normal del sistema (p. ej. "p99 latency < 300 ms, error rate < 0.1%").
- **Fault injection:** técnica de introducir deliberadamente un fallo (kill pod, latencia extra, DNS timeout, disk full) para verificar el comportamiento del sistema.
- **Game day:** ejercicio planificado donde el equipo simula o ejecuta un fallo real con timer, runbook y debrief posterior.
- **Canary analysis:** comparación estadística de métricas del canary (deploy nuevo) vs baseline (versión estable) para decidir promoción o rollback.
- **Dark launch:** activar un code path en producción con tráfico real pero sin exponer el resultado al usuario final.
- **Shadow traffic:** duplicar peticiones de producción hacia una nueva versión sin devolver su respuesta al cliente (Diffy, Envoy request mirroring).
- **Error budget:** cantidad tolerada de "quedar por debajo del SLO" en un periodo. Si SLO=99.9% mensual, error budget = 43m 12s de downtime.
- **Blameless postmortem:** análisis post-incident enfocado en factores sistémicos (falta de guardrail, monitoring gap, runbook desactualizado), no en culpar personas.

**Setup mínimo:**

```bash
# 1. Instalar Chaos Mesh 2.7+ en un cluster EKS/Kind local
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm repo update
kubectl create ns chaos-mesh
helm install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace chaos-mesh \
  --set chaosDaemon.runtime=containerd \
  --set chaosDaemon.socketPath=/run/containerd/containerd.sock \
  --version 2.7.2

# 2. Instalar Litmus 3.x (alternativa CNCF)
helm repo add litmuschaos https://litmuschaos.github.io/litmus-helm/
helm install chaos litmuschaos/litmus \
  --namespace litmus --create-namespace \
  --version 3.10.0

# 3. Configurar AWS FIS (fault injection service managed)
aws fis list-experiment-templates --region us-east-1

# 4. k6 para load y canary shadow
brew install k6            # macOS
choco install k6           # Windows
# Verificar
k6 version

# 5. Feature flag SDK (LaunchDarkly, Unleash open source)
docker run -d -p 4242:4242 --name unleash unleashorg/unleash-server:6

# 6. AWS CLI y perfil configurado
aws sts get-caller-identity
```

---

## 1. El gran cuadro

Un sistema distribuido moderno tiene entre cinco y quinientos componentes que fallan de formas que ningún test unitario ni ninguna suite de integración replica: **fallos parciales**, **network partitions**, **dependencias lentas pero no caídas**, **contención de recursos en el kernel**, **degradación de un disco EBS específico**, **una AZ que pierde poder por 20 minutos**. Cuando la primera vez que descubres estos comportamientos es en un incident real —a las 3AM, con clientes reclamando, un dashboard iluminado en rojo y el equipo con adrenalina— pagas por ese aprendizaje con revenue perdido, error budget consumido y confianza erosionada. Chaos engineering es la propuesta inversa: **inducir esos fallos deliberadamente, en horario laboral, con equipo observando y kill switch listo, para descubrir en experimento controlado lo que en producción sería outage**.

La disciplina no es "romper cosas al azar". Es método científico: (1) formular una hipótesis medible sobre el comportamiento en steady state ("si mato una instancia, el LB re-rutea en < 10s sin errores visibles"); (2) diseñar un experimento con blast radius acotado (1 pod, 1% del tráfico, 1 AZ secundaria); (3) ejecutar con observability rica; (4) verificar si la hipótesis se cumple; (5) documentar aprendizajes y crear action items. Netflix popularizó la práctica con **Chaos Monkey** en 2010 y evolucionó al **Simian Army** (Latency Monkey, Chaos Kong para regiones enteras). En 2021, **AWS Fault Injection Service** llevó chaos engineering al mainstream de empresas no-Netflix. Hoy, en 2026, herramientas como **Chaos Mesh 2.7**, **LitmusChaos 3.x**, **Gremlin** y **Steadybit** (open source o SaaS) hacen la práctica accesible desde el primer día.

El complemento inseparable de chaos engineering es **testing en producción**. Charity Majors (Honeycomb) escribió el manifiesto "I test in production" precisamente porque staging nunca reproduce completamente producción: escala de datos, patrones de tráfico, integraciones externas, hardware, comportamiento de CDNs, quirks de ISPs. Aceptado esto, la pregunta cambia de "¿testing en prod, sí o no?" a "¿cómo lo hacemos con seguridad?". Las respuestas son un conjunto de técnicas: **canary analysis automatizado** (Kayenta, Argo Rollouts, Flagger), **dark launches** con tráfico real pero sin exposición al usuario, **shadow traffic** con herramientas como Twitter Diffy o Envoy request mirroring, **feature flags como safety net** para rollback granular en segundos, **synthetic monitoring** siempre-encendido, y sobre todo **observability de alta cardinalidad** que permita responder "¿por qué?" post-hoc.

El impacto acumulado en 2026 es concreto: empresas que adoptan chaos engineering + testing en producción como práctica normalizada reducen su MTTR (mean time to recovery) entre 40% y 70%, disminuyen incidents graves porque descubren fallos latentes en experimentos, y protegen mejor sus **error budgets**. Empresas que no lo hacen viven en el patrón conocido: staging verde → deploy → outage sorpresa → postmortem con culpas → repeat. Este capítulo cubre principios, herramientas concretas (con código real), organización cultural (blameless postmortems, error budgets, game days) y termina con ejercicios aplicables al proyecto **LinguaDev Pro** —donde la aplicación tiene una PWA offline-first, un BFF serverless en AWS y dependencias externas (LLMs) con SLA volátil que hacen del chaos engineering algo no opcional.

---

## 2. Principios y taxonomía (nivel básico)

### 2.1 Los cinco principios de chaosengineering.com

La comunidad chaos engineering formuló cinco principios que separan la práctica seria del "sabotaje aleatorio":

1. **Construye una hipótesis alrededor del steady state.** Antes de romper, define qué comportamiento normal esperas (p99 latency, error rate, throughput, business metrics como conversion). Sin baseline explícito, no puedes medir el impacto.
2. **Varía eventos del mundo real.** Fallos que ocurren de verdad: instancias que mueren, discos que se llenan, DNS que falla, dependencias que se degradan a 5s de latencia. No fallos de fantasía.
3. **Ejecuta experimentos en producción.** Staging tiene 1/1000 de datos, no reproduce integraciones externas, no tiene el patrón de tráfico real. Producción es la única fuente de verdad. La progresión es dev → staging → prod con blast radius mínimo → prod con blast radius mayor.
4. **Automatiza para correr continuamente.** Un chaos experiment manual una vez al año no defiende contra regresiones. La resiliencia debe ser verificada continuamente (como los tests).
5. **Minimiza el blast radius.** Empieza con 1 pod, 1% del tráfico, 1 AZ secundaria. Escala solo tras verificar seguridad.

### 2.2 Taxonomía de experimentos

Los tipos de fallo que vale experimentar (adaptado del Simian Army de Netflix y catálogos modernos de Chaos Mesh, Litmus y AWS FIS):

| Categoría | Ejemplos | Qué revela |
|---|---|---|
| **Compute failure** | Kill pod, kill EC2, kill contenedor | Auto-healing, LB re-routing, singleton dependencies |
| **Latency injection** | Delay 500ms-5s en llamadas a DB, cache, APIs externas | Timeouts, circuit breakers, thread pool saturation |
| **Network chaos** | Packet loss, DNS delay, partition split-brain | Resiliencia CAP, retries con backoff, DNS caching |
| **Resource exhaustion** | CPU 100%, memory pressure, disk full, IO throttle | Throttling, backpressure, OOM behavior |
| **Time skew** | Reloj adelantado/atrasado | JWT expiry bugs, ordering, TTL edge cases |
| **Dependency failure** | 5xx en API externa, throttling de DynamoDB | Degradación graceful, fallback paths, feature flags |
| **AZ / Region failure** | Kill AZ (Chaos Gorilla), kill Region (Chaos Kong) | Multi-AZ replication, DR failover real |
| **Application-layer** | HTTP faults, gRPC status codes específicos | Manejo específico de errores de aplicación |

### 2.3 Blast radius y niveles de madurez

El blast radius es la superficie afectada por un experimento. Progresión de menor a mayor riesgo:

1. **Dev/staging con carga sintética** — ejercicio de familiarización.
2. **Producción, 1 pod / 1 nodo / < 1% de tráfico** — canary de chaos.
3. **Producción, 1 AZ secundaria** — verificación de multi-AZ.
4. **Producción, servicio completo con guardrails** — game day serio.
5. **Producción, región completa (Chaos Kong)** — solo con multi-region maduro.

Cada nivel debería estar precedido por semanas/meses de éxito en el nivel anterior. Nunca saltar niveles.

### 2.4 Steady state y su definición práctica

El "steady state" no es un vago "todo está bien". Es un conjunto de métricas cuantificables:

- **Golden signals** (Google SRE): latency (p50/p99), traffic (RPS), errors (%), saturation (CPU/mem/disk/queue).
- **Business metrics** cuando aplique: conversion, revenue por minuto, signups por hora.
- **Custom health indicators**: cache hit ratio, queue depth, DB connection pool utilization.

Ejemplo para LinguaDev Pro:

```yaml
# steady-state.yaml — hipótesis del sistema en operación normal
steady_state:
  api_latency_p99_ms: { target: 300, tolerance: 500 }
  api_error_rate_percent: { target: 0.1, tolerance: 1.0 }
  api_availability_percent: { target: 99.9, minimum: 99.5 }
  dynamodb_throttle_rate: { target: 0, tolerance: 5 }
  lambda_cold_start_p99_ms: { target: 800, tolerance: 1500 }
  llm_completion_success_rate: { target: 98, minimum: 95 }
  active_user_sessions: { minimum_baseline: 100 }
```

Si un experimento hace que cualquier métrica caiga fuera del `tolerance`, el sistema debe **abortar automáticamente** el experimento vía stop conditions (CloudWatch alarm, Prometheus alert).

---

## 3. Herramientas concretas (nivel medio)

### 3.1 Chaos Mesh 2.7 en Kubernetes

Chaos Mesh (CNCF, incubando) es la herramienta más adoptada en el ecosistema Kubernetes en 2026, con la versión **2.7.x** liberada durante 2026 añadiendo mejoras en el dashboard, workflows y soporte extendido para HTTP/DNS chaos. Instalación mostrada en §0. Un experimento típico de kill de pod:

```yaml
# pod-kill-experiment.yaml — mata 1 pod aleatorio del deployment api-bff cada 5 min
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: linguadev-api-pod-kill
  namespace: chaos-testing
spec:
  action: pod-kill
  mode: one                # one pod aleatorio (blast radius mínimo)
  selector:
    namespaces:
      - linguadev-prod
    labelSelectors:
      "app": "api-bff"
  scheduler:
    cron: "@every 5m"
  duration: "30s"
```

Latency injection sobre una dependencia (llamada al LLM):

```yaml
# network-latency-llm.yaml — 800ms de delay a llamadas al LLM externo
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: llm-latency-injection
  namespace: chaos-testing
spec:
  action: delay
  mode: all
  selector:
    namespaces:
      - linguadev-prod
    labelSelectors:
      "app": "api-bff"
  delay:
    latency: "800ms"
    correlation: "100"
    jitter: "50ms"
  direction: to
  target:
    mode: all
    selector:
      externalTargets:
        - "api.anthropic.com"
        - "api.openai.com"
  duration: "10m"
```

HTTP chaos para inyectar errores 500 en un 10% de las respuestas del BFF:

```yaml
# http-fault-api.yaml — 10% de responses del BFF fallan con 500
apiVersion: chaos-mesh.org/v1alpha1
kind: HTTPChaos
metadata:
  name: bff-http-500-injection
  namespace: chaos-testing
spec:
  mode: all
  selector:
    namespaces: [linguadev-prod]
    labelSelectors: { "app": "api-bff" }
  target: Response
  port: 8080
  path: "/api/v1/*"
  abort: false
  replace:
    body: '{"error":"chaos_injected"}'
    code: 500
  probability: 10
  duration: "5m"
```

### 3.2 LitmusChaos 3.x — chaos as workflows

LitmusChaos, incubando en CNCF con release cadence mensual durante 2026 (seis releases en Q1-Q2 según update oficial), destaca por su modelo de **ChaosExperiment + ChaosEngine + ChaosScheduler** y su integración con Argo Workflows. Un workflow completo que ejecuta kill de pod y verifica el steady state:

```yaml
# litmus-workflow.yaml — game day automatizado
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: linguadev-game-day-
spec:
  entrypoint: chaos-and-verify
  templates:
    - name: chaos-and-verify
      steps:
        - - name: install-chaos
            template: install-experiment
        - - name: run-experiment
            template: pod-delete
        - - name: verify-steady-state
            template: prometheus-check

    - name: pod-delete
      resource:
        action: create
        manifest: |
          apiVersion: litmuschaos.io/v1alpha1
          kind: ChaosEngine
          metadata:
            name: linguadev-pod-delete
            namespace: linguadev-prod
          spec:
            appinfo:
              appns: linguadev-prod
              applabel: "app=api-bff"
              appkind: deployment
            chaosServiceAccount: litmus-admin
            experiments:
              - name: pod-delete
                spec:
                  components:
                    env:
                      - name: TOTAL_CHAOS_DURATION
                        value: "60"
                      - name: PODS_AFFECTED_PERC
                        value: "20"
                      - name: FORCE
                        value: "false"

    - name: prometheus-check
      script:
        image: curlimages/curl:8.10.0
        command: [sh]
        source: |
          # Query Prometheus para verificar que el error rate se mantuvo dentro del budget
          RATE=$(curl -s "http://prometheus:9090/api/v1/query?query=rate(http_requests_total{status=~'5..'}[5m])" \
            | jq -r '.data.result[0].value[1] // 0')
          echo "Error rate observado: $RATE"
          if [ "$(echo "$RATE > 0.01" | bc)" -eq 1 ]; then
            echo "FALLO: error rate excedió el 1%"
            exit 1
          fi
          echo "OK: steady state preservado"
```

Litmus 3.x introdujo **Prometheus metrics** de primera clase (visualización de experimentos, éxito/fallo por experimento, blast radius medido) y **job targeting** para experimentos sobre Kubernetes Jobs y CronJobs, no solo Deployments.

### 3.3 AWS Fault Injection Service (FIS)

AWS FIS es el equivalente managed para infra AWS. Cobra ~$0.10 por action-minute. Un template que apaga 30% de instancias EC2 con tag `env=prod-canary`, con stop condition sobre una alarma CloudWatch:

```json
{
  "description": "linguadev-terminate-canary-30pct",
  "targets": {
    "canaryInstances": {
      "resourceType": "aws:ec2:instance",
      "resourceTags": {
        "Environment": "prod-canary",
        "Service": "linguadev-bff"
      },
      "selectionMode": "PERCENT(30)"
    }
  },
  "actions": {
    "terminateInstances": {
      "actionId": "aws:ec2:terminate-instances",
      "parameters": {},
      "targets": { "Instances": "canaryInstances" }
    }
  },
  "stopConditions": [
    {
      "source": "aws:cloudwatch:alarm",
      "value": "arn:aws:cloudwatch:us-east-1:123456789012:alarm:linguadev-bff-error-rate-high"
    },
    {
      "source": "aws:cloudwatch:alarm",
      "value": "arn:aws:cloudwatch:us-east-1:123456789012:alarm:linguadev-bff-p99-latency-high"
    }
  ],
  "roleArn": "arn:aws:iam::123456789012:role/FISExperimentRole",
  "tags": {
    "GameDay": "2026-Q3",
    "Owner": "sre-team"
  }
}
```

Ejecutar el experimento:

```bash
# Registrar template y lanzar experimento
aws fis create-experiment-template \
  --cli-input-json file://terminate-canary-30pct.json \
  --region us-east-1

# Lanzar (con confirmación humana)
aws fis start-experiment \
  --experiment-template-id EXTxxxxxxxxxxx \
  --region us-east-1 \
  --tags Purpose=game-day-q3

# Monitor en tiempo real
watch -n 2 'aws fis get-experiment --id EXPxxxxxxxxxx --query "experiment.state"'
```

### 3.4 Comparativa 2026: Gremlin vs Steadybit vs open source

Panorama de plataformas comerciales de chaos engineering en 2026:

| Herramienta | Modelo | Fortalezas | Debilidades |
|---|---|---|---|
| **Chaos Mesh 2.7** | Open source, CNCF incubating | Rico en fault types (pod/network/IO/HTTP/DNS/time), dashboard integrado, activo en 2026 | Focused en Kubernetes; menos integrations empresariales |
| **LitmusChaos 3.x** | Open source, CNCF incubating | Workflows con Argo, hub de experimentos, Prometheus metrics 2026 | Curva de aprendizaje del CRD model |
| **AWS FIS** | Managed (AWS) | Nativo AWS, sin agentes, stop conditions con CloudWatch, safe defaults | Solo AWS |
| **Gremlin** | Comercial (2016) | UI madura, agente único, catálogo curated de "reliability tests" | Closed source, requiere agente por host, precio |
| **Steadybit** | Hybrid-source (2019) | Framework de extensiones open source, agente por network boundary | Menor adopción que Gremlin todavía |
| **Harness Chaos** | Comercial | Integrado con Harness CD, útil para chaos en pipelines | Solo con Harness |

Recomendación pragmática: **AWS FIS** para workloads AWS puros; **Chaos Mesh** o **Litmus** para Kubernetes-heavy con presupuesto acotado; **Gremlin** o **Steadybit** cuando necesites soporte enterprise + catálogo curated.

---

## 4. Testing en producción con seguridad (nivel avanzado)

### 4.1 Canary analysis automatizado

El canary sin analysis es teatro: subes 5% del tráfico, esperas 15 min, y decides intuitivamente. El **canary analysis automatizado** compara métricas del canary vs baseline con **statistical significance**. Herramientas:

- **Kayenta** (Netflix, open source, base de Spinnaker) — usa Mann-Whitney U test para comparar distribuciones.
- **Argo Rollouts** (CNCF) — templates de análisis basados en queries Prometheus, Datadog o CloudWatch.
- **Flagger** (Weaveworks) — automatización con Istio/Linkerd/NGINX.

Ejemplo Argo Rollouts con análisis Prometheus para LinguaDev Pro:

```yaml
# rollout-with-analysis.yaml — canary con abort automático si p99 o errors degradan
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: linguadev-bff
spec:
  replicas: 20
  strategy:
    canary:
      canaryService: bff-canary
      stableService: bff-stable
      trafficRouting:
        alb:
          ingress: linguadev-ingress
      steps:
        - setWeight: 5
        - pause: { duration: 5m }
        - analysis:
            templates:
              - templateName: success-rate-p99-latency
            args:
              - name: service-name
                value: bff-canary
        - setWeight: 25
        - pause: { duration: 10m }
        - analysis:
            templates:
              - templateName: success-rate-p99-latency
            args:
              - name: service-name
                value: bff-canary
        - setWeight: 50
        - pause: { duration: 10m }
        - setWeight: 100
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate-p99-latency
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate
      interval: 60s
      count: 5
      successCondition: result[0] >= 0.995
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(http_requests_total{service="{{args.service-name}}",status!~"5.."}[2m]))
            /
            sum(rate(http_requests_total{service="{{args.service-name}}"}[2m]))
    - name: p99-latency-ms
      interval: 60s
      count: 5
      successCondition: result[0] <= 500
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            histogram_quantile(0.99,
              sum by (le) (rate(http_request_duration_seconds_bucket{service="{{args.service-name}}"}[2m]))
            ) * 1000
```

Si `success-rate` cae de 99.5% o `p99-latency-ms` supera 500ms más de 2 veces en la ventana, **Argo Rollouts rollback automático** sin intervención humana.

### 4.2 Dark launches: ejercitar sin exponer

Un **dark launch** activa el code path nuevo en producción con tráfico real, pero **no muestra el resultado al usuario**. Facebook popularizó el término al lanzar Chat: la infra corrió durante semanas con requests fantasma antes de que apareciera el botón en la UI. Casos típicos:

- **Nueva DB o cache tier** — dual write (dark) para medir performance y consistency antes de leer de la nueva.
- **Refactor de servicio crítico** — nueva versión corre en paralelo con requests reales; resultados descartados.
- **Nueva feature ML** — el modelo genera predicciones que se descartan, para medir latencia y coste real.
- **Nueva integración externa** — se llama al proveedor pero se ignora la respuesta.

Ejemplo aplicado a LinguaDev Pro (Node/TypeScript en la Lambda BFF):

```ts
// packages/api/src/handlers/evaluate.ts — dark launch de nuevo evaluador LLM
import { evaluateWithGpt4o } from '../providers/openai';
import { evaluateWithClaude } from '../providers/anthropic';
import { logger, metrics } from '../observability';
import { getFlag } from '../flags';

export async function evaluateHandler(event: EvaluateEvent) {
  const userId = event.userId;
  const start = Date.now();

  // Path oficial: Claude (versión estable)
  const officialResult = await evaluateWithClaude(event.answer);

  // Dark launch: correr también GPT-4o si el flag está activo,
  // pero no devolver su resultado al usuario.
  if (await getFlag('dark_launch_gpt4o_evaluator', { userId })) {
    // Fire-and-forget con timeout de 5s para no bloquear
    const darkTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('dark_timeout')), 5000)
    );

    Promise.race([evaluateWithGpt4o(event.answer), darkTimeout])
      .then((darkResult) => {
        const darkLatency = Date.now() - start;
        metrics.gauge('dark_launch.gpt4o.latency_ms', darkLatency);
        metrics.increment('dark_launch.gpt4o.success');
        logger.info({
          event: 'dark_launch_result',
          provider: 'gpt-4o',
          userId,
          latencyMs: darkLatency,
          scoreDelta: darkResult.score - officialResult.score,
        });
      })
      .catch((err) => {
        metrics.increment('dark_launch.gpt4o.error', { reason: err.message });
      });
  }

  return officialResult;
}
```

Ventajas sobre load testing: **tráfico real** es más representativo que sintético (edge cases, patrones de peticiones, distribuciones de longitud de texto reales).

### 4.3 Shadow traffic con Diffy y Envoy

**Shadow traffic** (también llamado "request mirroring") duplica peticiones reales hacia una nueva versión y **compara** las respuestas contra la versión estable. Diferencia con dark launch: shadow compara outputs, dark solo ejercita infra.

**Twitter Diffy** (open source, veterano) fue pionero. En 2026 el enfoque moderno es **Envoy request mirroring** o **NGINX mirror** integrados en el service mesh:

```yaml
# istio-vs-shadow.yaml — Istio VirtualService mirror del 100% del tráfico
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: linguadev-bff
spec:
  hosts:
    - api.linguadev.app
  http:
    - route:
        - destination:
            host: bff-stable
            port: { number: 8080 }
          weight: 100
      mirror:
        host: bff-candidate
        port: { number: 8080 }
      mirrorPercentage:
        value: 100.0
```

El BFF `bff-candidate` recibe copia de cada request, procesa, pero **su respuesta se descarta**. Un servicio comparador (custom o Diffy) compara logs de respuestas y reporta divergencias:

```python
# shadow-diff.py — comparador simple de respuestas shadow vs oficial
import json
from collections import Counter
from deepdiff import DeepDiff

def compare_responses(stable_log_path, candidate_log_path):
    stable = {r['request_id']: r for r in map(json.loads, open(stable_log_path))}
    candidate = {r['request_id']: r for r in map(json.loads, open(candidate_log_path))}

    matched = set(stable) & set(candidate)
    divergences = Counter()

    for req_id in matched:
        diff = DeepDiff(
            stable[req_id]['response'],
            candidate[req_id]['response'],
            ignore_order=True,
            exclude_paths=["root['request_id']", "root['timestamp']"],
        )
        if diff:
            for change_type in diff.keys():
                divergences[change_type] += 1

    total = len(matched)
    print(f"Total comparado: {total}")
    print(f"Sin divergencia: {total - sum(divergences.values())} ({(1 - sum(divergences.values())/total)*100:.2f}%)")
    for change_type, count in divergences.most_common():
        print(f"  {change_type}: {count} ({count/total*100:.2f}%)")

if __name__ == '__main__':
    compare_responses('/logs/stable.jsonl', '/logs/candidate.jsonl')
```

### 4.4 Feature flags como safety net

Un feature flag es un `if` runtime que permite activar/desactivar código sin redeploy. Su valor como safety net es enorme: **rollback de una feature específica en segundos** en lugar de rollback completo del deploy.

Reglas de higiene:
- **Naming convention**: `experiment_*`, `killswitch_*`, `release_*`.
- **Owner + expiry date** por flag.
- **Revisión mensual** de flags stale (LaunchDarkly, Unleash, ConfigCat tienen dashboards de "unused flags").
- Un flag **investigado el sprint siguiente** de su creación: decisión de eliminar o promover.

Uso combinado en LinguaDev Pro (kill switch + progressive rollout + segmentation):

```ts
// packages/api/src/flags.ts
import { UnleashClient } from 'unleash-client';

const unleash = new UnleashClient({
  url: 'https://unleash.linguadev.app/api/',
  appName: 'linguadev-bff',
  environment: process.env.STAGE,
});

// Kill switch global (respuesta en < 1s a un incident)
export async function isLlmEvaluatorEnabled(): Promise<boolean> {
  return unleash.isEnabled('killswitch_llm_evaluator') === false;
}

// Progressive rollout por porcentaje de userId hash
export async function useNewSpacedRepetition(userId: string): Promise<boolean> {
  return unleash.isEnabled('release_fsrs_v6', {
    userId,
    properties: { segment: userIdToSegment(userId) },
  });
}
```

### 4.5 Synthetic monitoring: siempre encendido

**Synthetic monitoring** ejecuta scripts predefinidos desde múltiples ubicaciones geográficas cada N minutos: cargar homepage, hacer login, ejecutar un ejercicio, verificar responses. Herramientas 2026: **Checkly** (Playwright as monitoring), **Datadog Synthetic**, **Grafana Cloud Synthetic Monitoring**, **AWS CloudWatch Synthetics** (Canaries).

Ejemplo Checkly con Playwright para LinguaDev Pro:

```ts
// checkly/homepage-and-review-flow.spec.ts
import { test, expect } from '@playwright/test';

test('landing + primera review offline-first', async ({ page }) => {
  await page.goto('https://linguadev.app', { waitUntil: 'networkidle' });
  await expect(page.locator('h1')).toContainText('LinguaDev Pro');

  // Login demo (usuario sintético dedicado)
  await page.fill('[name="email"]', 'synthetic@linguadev.app');
  await page.fill('[name="password"]', process.env.SYNTHETIC_PASSWORD!);
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL(/\/dashboard/);

  // Primera review (verifica que FSRS+IndexedDB funcionan)
  await page.click('[data-testid="start-review"]');
  await expect(page.locator('[data-testid="card-question"]')).toBeVisible();
  await page.click('[data-testid="show-answer"]');
  await page.click('[data-testid="rate-good"]');

  // Métrica: tiempo total < 3s
  const timing = await page.evaluate(() => performance.now());
  expect(timing).toBeLessThan(3000);
});
```

---

## 5. Cultura: game days, blameless postmortems, error budgets

### 5.1 Game days

Un **game day** convierte el runbook escrito en muscle memory ejecutada. Formato:

1. **Pre-brief** (30 min): equipo, escenario, hipótesis, criterios de éxito, kill switch, roles (incident commander, comunicador, operador).
2. **Ejecución** (60-120 min): alguien orquesta el fallo (con AWS FIS o Chaos Mesh), el equipo responde con runbook, cronómetro visible.
3. **Debrief** (60 min): qué funcionó, qué falló, action items con owner y deadline.
4. **Documentación**: runbook actualizado, tickets creados, aprendizajes compartidos.

Cadencia recomendada: **mensual partial** (un servicio, blast pequeño), **trimestral full** (multi-servicio o multi-AZ). Google llama a esto **DiRT** (Disaster Recovery Testing) y lo hace varias veces al año. Amazon lo tiene documentado como "Operational Readiness Reviews".

### 5.2 Blameless postmortems

**Blameless ≠ sin accountability**. Blameless significa el análisis se enfoca en **factores sistémicos**: falta de guardrail, monitoring gap, runbook desactualizado, training insuficiente. Nunca en "quién fue el que rompió esto".

Template mínimo (adaptado de Google SRE Book y Etsy):

```markdown
# Postmortem — Outage LinguaDev BFF 2026-08-05

## Summary
Desde 14:03 UTC hasta 14:47 UTC (44 min), el endpoint /api/v1/evaluate devolvió
5xx al 78% del tráfico. Causa raíz: retry storm hacia la API del LLM
tras timeout regional temporal en el proveedor.

## Impact
- Usuarios afectados: ~4,200 (78% del tráfico activo)
- Requests fallidos: 12,400
- Error budget consumido: 8m 12s de 43m mensuales (19%)
- Revenue impact: ~$180 (sesiones abandonadas)

## Timeline (UTC)
- 14:00 — LLM provider reporta timeout regional (status page)
- 14:03 — p99 latency del BFF supera 5s, alarma dispara
- 14:07 — Circuit breaker NO abre (bug: threshold en 10s, dep tardó 4-8s)
- 14:15 — Retries del BFF (3 con backoff) saturan thread pool
- 14:22 — On-call recibe page, empieza investigación
- 14:35 — Kill switch de fallback local activado (feature flag)
- 14:47 — Servicio recupera, LLM provider también

## Root cause analysis (5 whys)
1. ¿Por qué 5xx? El BFF agotó thread pool.
2. ¿Por qué se agotó? Retries acumulados con timeouts largos.
3. ¿Por qué no cortó el circuit breaker? Threshold configurado a 10s, la dep tardaba 4-8s.
4. ¿Por qué mal configurado? Nunca se validó con chaos experiment de latencia.
5. ¿Por qué no había chaos test? No estaba en el pipeline de release.

## What went well
- Kill switch por feature flag funcionó y recuperó en < 2 min tras activarlo.
- Observability con traces distribuidas identificó rápido el cuello.

## What went wrong
- Circuit breaker mal calibrado, sin chaos test que lo validara.
- Alarma de p99 latency alertaba pero on-call tardó 7 min en responder.
- Runbook mencionaba el kill switch pero no explicaba cuándo usarlo.

## Action items
- [ ] Recalibrar circuit breaker: threshold 2s, half-open recovery 30s (OWNER: sre, DUE: 2026-08-12)
- [ ] Añadir chaos test de latencia 3-8s en pipeline canary (OWNER: sre, DUE: 2026-08-19)
- [ ] Runbook: sección "cuándo activar kill_llm_fallback" con decision tree (OWNER: dev, DUE: 2026-08-15)
- [ ] Revisar on-call rotation, considerar segundo respondedor para services tier-1 (OWNER: em, DUE: 2026-09-01)
```

### 5.3 Error budgets

Un **error budget** cuantifica cuánto "quedar por debajo del SLO" el equipo puede tolerar en un periodo. Si el SLO mensual es 99.9%, el error budget = 43m 12s de downtime por mes. Es el puente entre reliability y velocity: **si queda budget → puedes deployar features, hacer chaos, tomar riesgos**; si se agotó → freeze de features, prioridad a reliability work.

Cálculo básico:

```python
# scripts/error_budget.py — reporte mensual de error budget
from datetime import datetime, timedelta

def error_budget_report(slo_percent: float, incidents_downtime_sec: int, period_days: int = 30):
    total_period_sec = period_days * 24 * 3600
    budget_sec = total_period_sec * (1 - slo_percent / 100)
    consumed_percent = (incidents_downtime_sec / budget_sec) * 100 if budget_sec > 0 else 0
    remaining_sec = max(0, budget_sec - incidents_downtime_sec)

    print(f"SLO: {slo_percent}% mensual ({period_days} días)")
    print(f"Error budget total: {budget_sec/60:.1f} min")
    print(f"Consumido: {incidents_downtime_sec/60:.1f} min ({consumed_percent:.1f}%)")
    print(f"Restante: {remaining_sec/60:.1f} min")
    if consumed_percent >= 100:
        print("STATUS: agotado — FREEZE de features")
    elif consumed_percent >= 75:
        print("STATUS: crítico — reducir cadencia de deploys")
    elif consumed_percent >= 50:
        print("STATUS: precaución — no chaos experiments agresivos")
    else:
        print("STATUS: saludable — puedes experimentar")

if __name__ == '__main__':
    # LinguaDev Pro BFF, agosto 2026
    error_budget_report(slo_percent=99.9, incidents_downtime_sec=1240, period_days=30)
```

**Regla de oro**: si consumes 100% del error budget en un mes, la política es congelar features y priorizar reliability. Sin esta regla explícita, el error budget es teatro.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ Empezar con **hipótesis medible** antes de romper.
- ✅ **Blast radius mínimo** primero; escalar tras verificar seguridad.
- ✅ **Stop conditions automáticas** (CloudWatch alarm, Prometheus rule) en cada experimento.
- ✅ **Horario laboral**, equipo cerca, kill switch listo.
- ✅ Feature flags con **naming + owner + expiry**.
- ✅ **Canary analysis automatizado** con statistical significance.
- ✅ **Dark launch** antes de exponer feature de alto riesgo.
- ✅ **Shadow traffic** para validar refactors críticos.
- ✅ **Synthetic monitoring** desde múltiples geos, siempre encendido.
- ✅ **Game days trimestrales**, con debrief documentado.
- ✅ **Blameless postmortems** con action items sistémicos.
- ✅ **Error budget como policy**, no como decoración.
- ✅ **Chaos in CI** post-deploy para regresiones.
- ✅ Observability rica **antes** de chaos, no después.

### Anti-patrones

- ❌ Chaos "aleatorio" sin hipótesis (sabotaje disfrazado).
- ❌ Empezar en producción con blast radius grande.
- ❌ Sin stop conditions (chaos que escala a outage real).
- ❌ Chaos a las 3AM sin equipo.
- ❌ Approval theater en canary (nadie mira las métricas).
- ❌ Feature flags zombies (años sin revisión).
- ❌ Postmortems con "el que rompió fue X".
- ❌ Error budget documentado pero nunca invocado.
- ❌ Runbook nunca ejecutado (fiction).
- ❌ Confiar solo en tests unitarios y staging.
- ❌ Load test con perfil uniforme (no refleja producción).
- ❌ Mocks sin contract testing (drift silencioso).

### Tabla de decisión: qué técnica cuándo

| Situación | Técnica adecuada |
|---|---|
| Feature de alto riesgo, ready para probar sin exponer | Dark launch |
| Refactor de servicio crítico, comparar outputs | Shadow traffic (Istio mirror + Diffy) |
| Release grande, quiero verificar no rompe métricas | Canary analysis (Argo Rollouts + Prometheus) |
| Rollback rápido necesario ante incident | Feature flag kill switch |
| Validar multi-AZ failover | Chaos Kong / FIS terminate AZ |
| Descubrir cadenas ocultas de dependencias | Latency injection (Chaos Mesh NetworkChaos) |
| Verificar circuit breaker calibrado | Latency injection sostenida + observar |
| Detección proactiva de degradación regional | Synthetic monitoring multi-geo |
| Training del equipo en runbook | Game day trimestral |

---

## 7. Casos reales industria 2023-2026

**Netflix Chaos Kong (2024)**: Netflix confirmó ejecutar Chaos Kong (kill de región AWS entera) trimestralmente en producción. Diseñaron su arquitectura activa-activa multi-región precisamente para tolerar esto.

**AWS us-east-1 outage diciembre 2024**: falla en control plane de Lambda causó cascada global. Empresas con multi-región activo-activo y game days regulares recuperaron en minutos; las de "single region + backups" tardaron 4-12 horas.

**Klarna revierte automatización del CS bot (2024-2025)**: Sebastian Siemiatkowski (CEO Klarna) anunció en 2024 que su chatbot IA reemplazaba 700 agentes; en 2025 admitió pérdidas de calidad y recontrató humanos. Lección: sin chaos experiments de "qué pasa cuando el LLM responde mal", la caída de calidad era inevitable.

**GitHub Copilot postmortem público (marzo 2025)**: GitHub publicó postmortem blameless tras 4 horas de degradación por retry storm hacia el modelo backend. Action items incluían chaos test específico de latency injection en LLM.

**Cloudflare BGP incident junio 2024**: mala config de BGP tumbó parte de la red por 25 minutos. Postmortem publicado en 48h identificó falta de progressive rollout de config; Cloudflare añadió chaos experiments específicos para BGP validation.

**Formula 1 y AWS FIS (2024)**: F1 documentó en re:Invent 2024 su uso de AWS FIS para game days pre-carrera. Recovery time mejorado de 15 min a < 2 min en 18 meses.

**AWS Backup logically air-gapped vault expansion (julio 2026)**: AWS extendió los air-gapped vaults a seis regiones adicionales. Empresas que ejecutan game days de "recovery desde backup" fueron las primeras en adoptar el feature.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Definir steady state y ejecutar tu primer PodChaos

**Objetivo:** ejecutar tu primer experimento chaos con blast radius mínimo y verificar que el steady state se preserva.

**Setup:**
- Cluster Kubernetes (Kind/Minikube/EKS) con LinguaDev BFF desplegado con >= 3 replicas.
- Chaos Mesh 2.7 instalado (ver §0).
- Prometheus + Grafana para observar métricas.

**Pasos:**
1. Define un `steady-state.yaml` con al menos 3 métricas cuantificadas (p99 latency, error rate, availability).
2. Documenta la hipótesis: "si mato 1 pod del deployment, el LB re-rutea en < 10s sin pasar el error rate del 1%".
3. Crea el PodChaos que mata 1 pod (blast mode: `one`).
4. Ejecuta y observa Grafana durante 5 minutos.
5. Verifica si la hipótesis se cumplió; si no, documenta qué falló.

**Criterios de éxito:**
- [ ] Steady state documentado con umbrales concretos.
- [ ] Experimento ejecutado con `blast=one`.
- [ ] Métricas observadas antes/durante/después.
- [ ] Postmortem breve (1 párrafo) con aprendizajes.

**Bonus:** añade stop condition con Prometheus rule que aborte si error rate > 2%.

---

### Ejercicio 2: Latency injection y detección de cadenas ocultas

**Objetivo:** descubrir dependencias críticas ocultas y verificar el circuit breaker.

**Setup:**
- Mismo cluster.
- BFF con circuit breaker configurado (opossum, resilience4j o equivalente).

**Pasos:**
1. Identifica una dependency crítica (LLM externa, DynamoDB, cache).
2. Crea un `NetworkChaos` con latency 2s hacia esa dependency.
3. Genera carga con `k6 run --vus 50 --duration 5m load.js`.
4. Observa: ¿Se abre el circuit breaker? ¿En cuánto tiempo? ¿Cuántos errors ve el usuario?
5. Documenta cadenas de fallo descubiertas.

**Criterios de éxito:**
- [ ] Latency injection ejecutada sin tumbar el sistema.
- [ ] Circuit breaker abrió (o documentado por qué no lo hizo).
- [ ] Action items para recalibrar timeouts/breakers si necesarios.

**Bonus:** repite con 5s y 10s para encontrar el "breaking point".

---

### Ejercicio 3: Feature flag como kill switch en 30 segundos

**Objetivo:** demostrar que puedes desactivar una feature específica en producción en < 30s sin redeploy.

**Setup:**
- Unleash (open source) o LaunchDarkly free tier.
- BFF con al menos una feature detrás de flag `killswitch_llm_evaluator`.

**Pasos:**
1. Ejecuta un experimento que causa problemas en la feature (chaos con HTTP 500 en 50% de responses del LLM).
2. Cronómetro: mide el tiempo desde que decides desactivar hasta que efectivamente se desactiva.
3. Verifica en logs que el path alternativo (fallback local) se está usando.
4. Vuelve a activar tras el experimento; verifica tiempo de propagación.

**Criterios de éxito:**
- [ ] Kill switch propagó en < 30s.
- [ ] Fallback path funcionó sin errores.
- [ ] Métricas confirmaron reducción del error rate tras el kill.

**Bonus:** implementa segmentación (kill switch solo para users no-premium, mantener para premium).

---

### Ejercicio 4: Canary analysis con Argo Rollouts

**Objetivo:** desplegar una versión nueva con rollback automático si degrada métricas.

**Setup:**
- Argo Rollouts instalado.
- Prometheus con métricas del BFF.
- Nueva versión del BFF con un bug intencional (aumenta p99 latency artificialmente).

**Pasos:**
1. Crea `Rollout` con estrategia canary (5% → 25% → 50% → 100%).
2. Añade `AnalysisTemplate` con umbrales de success rate (>= 99.5%) y p99 latency (<= 500ms).
3. Deploya la versión buggy.
4. Observa el rollback automático cuando el análisis falla.
5. Deploya versión corregida y confirma que llega al 100%.

**Criterios de éxito:**
- [ ] Rollback automático disparado en step correcto.
- [ ] Sin intervención manual necesaria.
- [ ] Log de decisión de Argo Rollouts documenta el fail count.

**Bonus:** añade una métrica de business (`conversion_rate`) además de las técnicas.

---

### Ejercicio 5 (bonus): Game day con blameless postmortem

**Objetivo:** ejecutar un game day de 90 min y producir un postmortem publicable.

**Setup:**
- Equipo de 2-4 personas.
- Runbook actual de tu sistema (o el de LinguaDev Pro).
- AWS FIS o Chaos Mesh disponible.

**Pasos:**
1. **Pre-brief (30 min):** define escenario ("cae la región primaria del BFF"), hipótesis, roles.
2. **Ejecución (45 min):** orquesta el fallo, equipo responde con runbook.
3. **Debrief (30 min):** timeline detallada, qué funcionó, qué no.
4. **Postmortem (async, 1-2 horas):** escribir usando template blameless de §5.2.
5. **Follow-up:** crear tickets por cada action item.

**Criterios de éxito:**
- [ ] Runbook ejecutado con timer visible.
- [ ] Al menos 3 action items sistémicos identificados.
- [ ] Postmortem publicado internamente en < 48h.
- [ ] Tickets creados y asignados.

**Bonus:** repite el game day 3 meses después con las mismas condiciones; mide reducción en MTTR.

---

## 9. Recursos + siguientes pasos

**Herramientas open source:**
- [Chaos Mesh (chaos-mesh.org)](https://chaos-mesh.org) — CNCF, K8s-native, versión 2.7 en 2026.
- [LitmusChaos (litmuschaos.io)](https://litmuschaos.io) — CNCF, workflows con Argo, cadence mensual en 2026.
- [Argo Rollouts (argoproj.io/rollouts)](https://argoproj.github.io/rollouts) — canary + blue-green + analysis.
- [Kayenta](https://github.com/spinnaker/kayenta) — canary analysis original de Netflix.

**Managed / comercial:**
- **AWS Fault Injection Service** — nativo AWS, con stop conditions CloudWatch.
- **Gremlin** — pionero comercial (2016), catálogo curado.
- **Steadybit** — hybrid-source, framework extensible (2019).
- **Harness Chaos** — integrado con Harness CD.

**Testing en producción:**
- **Checkly** — synthetic monitoring con Playwright.
- **Datadog Synthetic** — enterprise multi-geo.
- **AWS CloudWatch Synthetics (Canaries)** — nativo AWS.
- **Diffy** (Twitter) — comparador shadow traffic.

**Feature flags:**
- **LaunchDarkly** — líder mercado.
- **Unleash** — open source con SaaS hospedado.
- **AWS AppConfig** — nativo AWS.
- **ConfigCat** — pricing amigable para startups.

**Lecturas fundamentales:**
- **Google SRE Book** (Beyer et al.) — capítulos 15 (postmortem) y 17 (testing).
- **Chaos Engineering** (Rosenthal & Jones, O'Reilly) — libro canónico de la disciplina.
- **Observability Engineering** (Majors, Fong-Jones, Miranda-Steiner) — high-cardinality observability.
- **Increment magazine — Testing issue** — colección de perspectivas.
- **Charity Majors — "I Test in Production"** (blog).

**Conferencias y comunidades:**
- **Chaos Community Day** — evento anual, talks públicos.
- **AWS re:Invent** — sesiones anuales sobre chaos con FIS (código ARC).
- **KubeCon** — track de resilience/chaos con LitmusChaos y Chaos Mesh.
- **SREcon** (Usenix) — track SRE con game days y postmortems.

**Siguientes pasos:**
- Ejecuta los 5 ejercicios sobre LinguaDev Pro.
- Instituye un game day trimestral con calendario fijo.
- Añade una fase de chaos en tu pipeline post-canary.
- Continúa con [Cap 14 — Multi-región y DR](./14-multi-region-y-dr.md) para llevar los aprendizajes a escala regional.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas en el área `resilience`, dificultades mid → staff. Cubren: filosofía chaos, Simian Army, load testing patterns (k6, Gatling, Locust, JMeter, Vegeta), AWS FIS con templates y stop conditions, dependency injection para testing, canary analysis automatizado (Kayenta, Argo Rollouts, Flagger), feature flags como safety net, dark launches, filosofía "testing en producción" (Charity Majors), synthetic monitoring, game days y DiRT, contract testing con Pact, taxonomía de test doubles (Meszaros), A/B testing infra, chaos en CI/CD, blameless postmortems, retry storms como descubrimiento chaos, test data management, observability para chaos (traces, high-cardinality, correlation IDs), y adopción cultural de chaos engineering.

- **Fuente:** [`packages/content/src/tech/architecture/sim-13-chaos-and-testing-production.json`](../../packages/content/src/tech/architecture/sim-13-chaos-and-testing-production.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-13-chaos-and-testing-production`
- **Tiempo:** 25 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 12 — Migraciones zero-downtime](./12-migraciones-zero-downtime.md) · [Índice](./README.md) · [Capítulo 14 — Multi-región y DR →](./14-multi-region-y-dr.md)
