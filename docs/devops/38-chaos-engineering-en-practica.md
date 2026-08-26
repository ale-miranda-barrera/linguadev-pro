# Capítulo 38 — Chaos Engineering en práctica

> **Focus:** Chaos Engineering como disciplina científica: 5 principios de principlesofchaos.org, herencia Netflix (Simian Army, Chaos Monkey → Kong), plataformas modernas 2026 (Chaos Mesh 2.7+, LitmusChaos 3.x, AWS FIS, Gremlin, Steadybit), diseño hipótesis-driven, steady-state cuantitativo, blast radius control, game days planificados, chaos automatizado en producción con feature flags y kill switches, cultura de learning organization.
> **Áreas:** Reliability · Distributed systems · Learning culture
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de sistemas distribuidos: timeouts, retries, circuit breakers, bulkheads.
- Kubernetes básico + Deployment/HPA (ver [cap 07 — kubernetes fundamentals](./07-fundamentos-kubernetes.md), [cap 08 — kubernetes workloads](./08-kubernetes-workloads.md)).
- Observability: Prometheus + Grafana + tracing (ver [cap 17](./17-prometheus-y-metrics.md), [cap 18](./18-grafana-y-dashboards.md)).
- SLIs/SLOs: definición, error budgets.
- CI/CD y feature flags (LaunchDarkly, Unleash, OpenFeature).
- Disaster Recovery (ver [cap 37](./37-disaster-recovery-y-backups.md)).

**Glosario mínimo:**
- **Chaos Engineering**: disciplina de experimentar sobre un sistema distribuido para generar confianza en su resiliencia. Definición canónica en [principlesofchaos.org](https://principlesofchaos.org) (Netflix, 2015).
- **Steady state**: comportamiento normal medible del sistema (ej: `stream starts per second` en Netflix, `checkouts/min` en e-commerce). Base para toda hipótesis.
- **Hipótesis**: afirmación falsable sobre cómo el sistema responderá a una perturbación ("si mato 10% de pods, la tasa de éxito seguirá >99%").
- **Blast radius**: alcance máximo del daño potencial de un experimento. Debe controlarse (1% de tráfico → 10% → 100%).
- **Kill switch**: mecanismo automático (stop condition) que aborta el experimento si el steady state se rompe.
- **Game day**: sesión planificada donde el equipo ejecuta experimentos, observa y aprende. Incluye roles, timeline, post-mortem.
- **Simian Army**: familia de herramientas Netflix (Chaos Monkey, Chaos Gorilla AZ, Chaos Kong region, Latency Monkey, Conformity Monkey).
- **Chaos Mesh**: plataforma CNCF (Incubating), operator de Kubernetes con >20 tipos de fault injection. Versión 2.7+ en 2026.
- **LitmusChaos**: plataforma CNCF (Incubating, madura 2024+), GitOps-first, ChaosHub con 50+ experimentos, versión 3.x en 2026.
- **AWS FIS** (Fault Injection Service): servicio managed AWS (GA marzo 2021, expandido continuamente). Integración nativa con CloudWatch alarms como stop conditions.
- **Gremlin**: plataforma SaaS comercial pionera (fundada por ex-Netflix Kolton Andrus, 2016).
- **Steadybit**: plataforma comercial europea (2019+), enfoque hipótesis-driven fuerte.

**Setup mínimo:**

```bash
# 1. Cluster Kubernetes 1.30+ con kubectl configurado
kubectl version --short

# 2. Chaos Mesh 2.7 (agosto 2026)
curl -sSL https://mirrors.chaos-mesh.org/v2.7.0/install.sh | bash -s -- --local kind

# 3. LitmusChaos 3.10+ (alternativa)
kubectl create ns litmus
kubectl apply -f https://litmuschaos.github.io/litmus/3.10.0/litmus-3.10.0.yaml

# 4. AWS CLI 2.17 + acceso a FIS
aws fis list-experiment-templates --region us-east-1

# 5. Prometheus + Grafana para observability (requerido)
kubectl create ns monitoring
helm install kube-prom prometheus-community/kube-prometheus-stack -n monitoring

# 6. Load generator para provocar tráfico realista
kubectl run k6 --rm -it --image=grafana/k6:0.51.0 -- run - <<'EOF'
import http from 'k6/http';
export const options = { vus: 50, duration: '10m' };
export default function () { http.get('http://api/'); }
EOF
```

---

## 1. El gran cuadro

**Chaos Engineering** nació en Netflix entre 2010 y 2011, cuando la migración desde el datacenter a AWS los enfrentó a una verdad incómoda: en un sistema distribuido con cientos de microservicios, **los fallos no son accidentes, son constantes**. En vez de esperar el próximo outage real, decidieron **provocar fallos deliberadamente en un entorno controlado** para descubrir debilidades antes que los clientes. El resultado fue Chaos Monkey (open-source en 2012), la familia Simian Army (Chaos Gorilla para AZs, Chaos Kong para regiones enteras) y en 2015 el manifiesto público [principlesofchaos.org](https://principlesofchaos.org). En 2026, la disciplina es mainstream: AWS, Google, Microsoft, LinkedIn, Facebook y prácticamente cualquier hyperscaler la practican; existen plataformas comerciales (Gremlin, Steadybit) y open-source de nivel CNCF (Chaos Mesh, LitmusChaos); y AWS tiene su propio servicio managed (FIS).

Pero "chaos" es una palabra mal elegida. **No es sabotaje**. Es una práctica **hipótesis-driven** con estructura científica: (1) definís un **steady state** medible (`stream starts per second`, `p99 latency`, `checkout success rate`), (2) formulás una **hipótesis falsable** ("si degrado la latencia de recommendation service 500ms, el checkout rate se mantendrá porque tenemos fallback local"), (3) ejecutás un experimento con **blast radius controlado** (1% del tráfico, una AZ, un servicio no crítico), (4) observás en tiempo real con **kill switches automáticos** que abortan si el steady state se rompe, (5) **aprendés** de la desviación —éxito o fallo, ambos son datos—. Sin estos cinco pilares (los "5 Principios Avanzados"), apagar servidores es simplemente causar incidentes. La distinción no es semántica; es la diferencia entre una práctica que **construye confianza** y una que **destruye trust del equipo**.

El landscape de plataformas se consolidó entre 2020 y 2026. **Chaos Mesh** (CNCF Incubating, desarrollado originalmente por PingCAP) es el operator Kubernetes-nativo más flexible: >20 tipos de fault injection (`PodChaos`, `NetworkChaos`, `IOChaos`, `TimeChaos`, `KernelChaos`, `StressChaos`), workflow engine para experimentos secuenciales, integración Grafana. Versión 2.7+ en 2026 añade mejor soporte multi-cluster y RBAC granular. **LitmusChaos** (CNCF Incubating) apuesta por el modelo GitOps con **ChaosHub** (marketplace de 50+ experimentos reutilizables), **ChaosCenter** centralizado para operar múltiples clusters, y una filosofía de "chaos-as-a-workflow" fuertemente integrada con Argo Workflows. Versión 3.x madura en 2026. **AWS FIS** (Fault Injection Service, GA marzo 2021) es la opción managed: soporta fallos de infra AWS (EC2 stop, RDS failover, ECS task kill, network latency vía SSM), integra CloudWatch alarms como stop conditions automáticas, y desde 2022 puede orquestar Chaos Mesh y Litmus para experimentos K8s dentro de EKS.

En 2026, el debate ya no es "¿hay que hacer chaos?" sino "¿cómo lo hacemos bien?". Los tres pitfalls más caros: (1) **hacer chaos sin observability decente** —sin métricas, no hay señal, es sabotaje ciego—; (2) **empezar directamente en producción a lo grande** —hay que ir de staging → prod con blast radius mínimo → escalar—; (3) **hacer chaos sin cultura de learning** —si el experimento revela un bug y el equipo culpa al que lo encontró, se abandona la práctica—. Este capítulo cubre los principios, el diseño de experimentos, las plataformas concretas con código YAML/JSON, los game days como formato organizacional, y termina con ejercicios sobre el proyecto **LinguaDev Pro** que van desde `PodChaos` en staging hasta un game day completo con roles.

---

## 2. Los 5 Principios Avanzados y el diseño de experimentos (nivel básico)

### 2.1 Los 5 Principios (principlesofchaos.org)

1. **Build a Hypothesis around Steady State Behavior.** Definí qué es "normal" en tu sistema mediante métricas cuantitativas. Ejemplos: Netflix usa **SPS** (stream starts per second), Amazon Prime Video usa `5xx rate <0.1%` en checkout, LinguaDev Pro podría usar `lesson_completions_per_min` + `p99 API latency`.
2. **Vary Real-World Events.** Simulá fallos que **realmente ocurren**: instance failure, network latency, dependency slowdown, spikes de tráfico. No simules "todos los discos explotan simultáneamente a 200°C" —no aporta aprendizaje.
3. **Run Experiments in Production.** Staging no reproduce el volumen, la topología ni las dependencies reales. Netflix es explícito: chaos en staging aporta ~10% del valor de chaos en prod. Esto requiere confianza, observability y blast radius control.
4. **Automate Experiments to Run Continuously.** Chaos manual una vez al mes detecta regresiones lento. Chaos automatizado 24/7 (como Chaos Monkey en Netflix) las detecta al siguiente deploy.
5. **Minimize Blast Radius.** Empezá con el mínimo daño potencial: 1 pod, 1% del tráfico, una AZ pequeña. Escalá cuando confíes en los resultados. Tené siempre kill switch.

**Test mental:** si no podés responder "¿qué hipótesis estás probando?" o "¿cómo mides que salió bien?", **no lo hagas**.

### 2.2 Estructura de un experimento

Formato canónico (adoptado por Gremlin, Steadybit, LitmusChaos):

```markdown
# Experimento CH-2026-08-13-01

## Hipótesis
Si degradamos la latencia de `recommendation-service` en +500ms para 10% del tráfico,
el `lesson_start_rate` NO caerá más de 5% respecto al baseline, porque la app tiene
fallback a recomendaciones cacheadas locales.

## Steady state
- `lesson_start_rate` (Prometheus: rate(lessons_started_total[5m])) baseline: ~40/s
- `api_latency_p99` (Prometheus): baseline: 220ms
- `error_rate_5xx`: baseline: <0.1%

## Método
- Tool: Chaos Mesh NetworkChaos
- Target: pods con label `app=recommendation-service` en namespace `prod`
- Fault: `delay` 500ms, jitter 100ms
- Duration: 15 min
- Traffic scope: 10% (ingress split via Istio VirtualService)

## Blast radius
- Solo 10% del tráfico de una sola región (us-east-1).
- Otras regiones (eu-west-1, us-west-2) sin afectar.
- 1 servicio (recommendation), otros servicios intactos.

## Stop conditions (kill switch automático)
- Si `lesson_start_rate` cae >10% durante >2 min → abortar.
- Si `error_rate_5xx` sube a >1% → abortar.
- Manual: SRE puede abortar con `kubectl delete networkchaos ch-2026-08-13-01`.

## Roles
- Experiment Owner: alice@linguadev.app
- Observer: bob@ (mira dashboards)
- Communicator: carol@ (posts en #chaos-days)

## Timeline
- T-10min: anunciar en Slack, verificar baseline.
- T+0: aplicar chaos.
- T+15min: remover chaos, verificar recuperación.
- T+60min: escribir resumen y decisiones.
```

Publicá cada experimento antes y después. Es la memoria organizacional.

### 2.3 Steady state: métricas de negocio, no solo técnicas

**Trampa común:** definir steady state solo con métricas técnicas (`CPU <70%`, `latency p99 <500ms`). Si el CPU sube pero los usuarios no notan, ¿el experimento causó daño? Netflix insiste: **steady state debe reflejar valor de negocio**.

Ejemplos por dominio:

| Dominio | Steady state ideal |
|---|---|
| Streaming (Netflix) | Stream starts/sec |
| E-commerce | Checkouts/min, cart-add rate |
| SaaS B2B | Successful logins, feature usage rate |
| Fintech | Transactions/sec, funds settled |
| LinguaDev Pro | Lesson completions/min, DAU, first-response time del chat AI |

Combinar 2-3 métricas: una de **volumen** (throughput), una de **calidad** (error rate), una de **experiencia** (p99 latency o Apdex). Si las 3 se mantienen, el experimento no causó daño visible.

### 2.4 Cuándo NO hacer chaos

- ❌ **Sin observability decente.** Si no tenés Prometheus + tracing + logs centralizados, chaos = sabotaje ciego.
- ❌ **Antes de que la aplicación tenga runbooks y ownership claro.** Chaos revela debilidades; si nadie sabe qué hacer con lo revelado, no aprendés.
- ❌ **En una release freeze / high-stakes launch.** Black Friday, Cyber Monday, Super Bowl: no es el momento de introducir variabilidad.
- ❌ **Sobre un servicio que aún no cumple su SLO base.** Primero fix del baseline, después chaos.
- ❌ **Sin buy-in del business owner.** Si el CTO no está de acuerdo con hacer chaos en producción, tenés un problema organizacional, no técnico.

---

## 3. Plataformas modernas: Chaos Mesh, LitmusChaos y AWS FIS (nivel medio)

### 3.1 Chaos Mesh 2.7+: PodChaos, NetworkChaos, StressChaos

**Instalación** (Kubernetes 1.30+):

```bash
# Kind local
curl -sSL https://mirrors.chaos-mesh.org/v2.7.0/install.sh | bash -s -- --local kind

# EKS/GKE/AKS
helm repo add chaos-mesh https://charts.chaos-mesh.org
kubectl create ns chaos-mesh
helm install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace=chaos-mesh --version 2.7.0 \
  --set chaosDaemon.runtime=containerd \
  --set chaosDaemon.socketPath=/run/containerd/containerd.sock
```

**PodChaos: matar el 20% de pods de un deployment cada 60 segundos durante 10 min:**

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: kill-api-pods
  namespace: prod
spec:
  action: pod-kill
  mode: fixed-percent
  value: "20"
  selector:
    namespaces: [prod]
    labelSelectors:
      "app.kubernetes.io/name": "linguadev-api"
  duration: "10m"
  scheduler:
    cron: "@every 60s"
```

**NetworkChaos: introducir 300ms de latencia + 100ms de jitter en tráfico al servicio de recommendations:**

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: delay-recommendations
  namespace: prod
spec:
  action: delay
  mode: all
  selector:
    namespaces: [prod]
    labelSelectors:
      "app.kubernetes.io/name": "recommendation-service"
  delay:
    latency: "300ms"
    correlation: "50"
    jitter: "100ms"
  duration: "15m"
  direction: to
  target:
    mode: all
    selector:
      namespaces: [prod]
      labelSelectors:
        "app.kubernetes.io/name": "linguadev-api"
```

**IOChaos: simular disco lento (100ms delay en escrituras al PVC de Postgres):**

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: slow-postgres-disk
  namespace: prod
spec:
  action: latency
  mode: one
  selector:
    labelSelectors:
      "app.kubernetes.io/name": "postgres"
  volumePath: /var/lib/postgresql/data
  path: "/var/lib/postgresql/data/**/*"
  delay: "100ms"
  percent: 50
  duration: "5m"
```

**StressChaos: consumir 80% de CPU en 2 pods aleatorios:**

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: cpu-stress
  namespace: prod
spec:
  mode: fixed
  value: "2"
  selector:
    labelSelectors:
      "app.kubernetes.io/name": "linguadev-worker"
  stressors:
    cpu:
      workers: 4
      load: 80
  duration: "10m"
```

**Workflow (chain de experimentos):**

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: Workflow
metadata:
  name: dependency-degradation
  namespace: prod
spec:
  entry: sequential-degradation
  templates:
    - name: sequential-degradation
      templateType: Serial
      children: [step-cache, step-db, step-external]
    - name: step-cache
      templateType: NetworkChaos
      networkChaos:
        action: partition
        mode: all
        selector: { labelSelectors: { app: redis } }
        direction: from
        target: { mode: all, selector: { labelSelectors: { app: api } } }
      deadline: 5m
    - name: step-db
      templateType: PodChaos
      podChaos:
        action: pod-failure
        mode: one
        selector: { labelSelectors: { app: postgres } }
      deadline: 3m
    - name: step-external
      templateType: NetworkChaos
      networkChaos:
        action: loss
        mode: all
        selector: { labelSelectors: { app: api } }
        loss: { loss: "50" }
        externalTargets: ["api.openai.com"]
      deadline: 5m
```

### 3.2 LitmusChaos 3.x: GitOps y ChaosHub

LitmusChaos (CNCF Incubating) apuesta por dos ideas:

- **ChaosHub**: catálogo de >50 experimentos reutilizables (pod-delete, node-cpu-hog, aws-ec2-terminate-by-id, azure-vm-power-off, gcp-vm-instance-stop, etc.).
- **ChaosCenter**: UI centralizada que gestiona experimentos sobre múltiples clusters (útil en multi-tenant).

Instalación:

```bash
kubectl create ns litmus
kubectl apply -f https://litmuschaos.github.io/litmus/3.10.0/litmus-3.10.0.yaml

# Instalar el chaos experiment CRDs
kubectl apply -f https://hub.litmuschaos.io/api/chaos/3.10.0?file=charts/generic/experiments.yaml \
  -n litmus
```

Experimento **pod-delete**:

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: linguadev-api-pod-delete
  namespace: prod
spec:
  appinfo:
    appns: prod
    applabel: "app.kubernetes.io/name=linguadev-api"
    appkind: deployment
  chaosServiceAccount: litmus-admin
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: "60"
            - name: CHAOS_INTERVAL
              value: "10"
            - name: FORCE
              value: "false"
            - name: PODS_AFFECTED_PERC
              value: "30"
        probe:
          - name: check-api-availability
            type: httpProbe
            mode: Continuous
            runProperties:
              probeTimeout: 5
              interval: 2
              retry: 3
              probePollingInterval: 2
            httpProbe/inputs:
              url: "http://linguadev-api.prod.svc.cluster.local/healthz"
              insecureSkipVerify: false
              method:
                get:
                  criteria: "=="
                  responseCode: "200"
```

Los **probes** son la diferencia clave con Chaos Mesh: LitmusChaos valida hipótesis **durante** el experimento y marca `Verdict=Fail` si el probe falla. En efecto, es el kill switch integrado.

Ejecutar con Argo Workflows (GitOps):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: chaos-linguadev-
  namespace: litmus
spec:
  entrypoint: run-chaos
  templates:
    - name: run-chaos
      resource:
        action: apply
        manifest: |
          apiVersion: litmuschaos.io/v1alpha1
          kind: ChaosEngine
          metadata:
            name: linguadev-{{workflow.uid}}
            namespace: prod
          spec:
            # ... como arriba
```

### 3.3 AWS FIS (Fault Injection Service)

**AWS FIS** (GA marzo 2021, expandido continuamente) es managed y particularmente útil cuando el fallo simulado está a nivel infra AWS (no en el cluster K8s). Ventajas: (1) integración nativa con CloudWatch alarms como **stop conditions**, (2) soporte para EC2, RDS, ECS, EKS, Systems Manager, (3) integración con Chaos Mesh y Litmus para experimentos K8s dentro de EKS (2022+).

Experimento: apagar 2 instancias EC2 aleatorias de un ASG durante 5 min, con abort si CloudWatch alarm `HighErrorRate` dispara:

```json
{
  "description": "Stop 2 random EC2 instances of prod ASG",
  "roleArn": "arn:aws:iam::123456789012:role/FISExperimentRole",
  "stopConditions": [
    {
      "source": "aws:cloudwatch:alarm",
      "value": "arn:aws:cloudwatch:us-east-1:123456789012:alarm:linguadev-HighErrorRate"
    }
  ],
  "targets": {
    "prod-instances": {
      "resourceType": "aws:ec2:instance",
      "resourceTags": { "Environment": "prod", "Chaos": "eligible" },
      "selectionMode": "COUNT(2)",
      "filters": [
        { "path": "State.Name", "values": ["running"] }
      ]
    }
  },
  "actions": {
    "stop-instances": {
      "actionId": "aws:ec2:stop-instances",
      "parameters": { "startInstancesAfterDuration": "PT5M" },
      "targets": { "Instances": "prod-instances" }
    }
  },
  "tags": { "Name": "kill-2-ec2-prod" }
}
```

Crear el template y ejecutarlo:

```bash
aws fis create-experiment-template --cli-input-json file://experiment.json
# Output: templateId "EXT-abc123"

aws fis start-experiment --experiment-template-id EXT-abc123

# Monitor
aws fis get-experiment --id EXP-xyz789 \
  --query 'experiment.state'
# {"status": "running", "reason": ""}
```

**Experimento avanzado: fallo de dependency externa** (Systems Manager Run Command para inyectar reglas iptables):

```json
{
  "actions": {
    "block-external": {
      "actionId": "aws:ssm:send-command",
      "parameters": {
        "documentArn": "arn:aws:ssm:us-east-1::document/AWSFIS-Run-Network-Blackhole-Port",
        "documentParameters": "{\"Protocol\":\"tcp\",\"Port\":\"443\",\"DurationSeconds\":\"600\"}",
        "duration": "PT10M"
      },
      "targets": { "Instances": "prod-instances" }
    }
  }
}
```

**AWS FIS + Chaos Mesh** (para EKS):

```json
{
  "actions": {
    "run-chaosmesh-experiment": {
      "actionId": "aws:eks:inject-kubernetes-custom-resource",
      "parameters": {
        "kubernetesApiVersion": "chaos-mesh.org/v1alpha1",
        "kubernetesKind": "NetworkChaos",
        "kubernetesNamespace": "prod",
        "kubernetesSpec": "{ ... yaml as JSON ... }",
        "maxDuration": "PT15M"
      },
      "targets": { "Cluster": "linguadev-eks" }
    }
  }
}
```

### 3.4 Comparación 2026

| Plataforma | Modelo | Fortalezas | Trade-offs |
|---|---|---|---|
| **Chaos Mesh 2.7** | K8s operator, open-source | Muy flexible, TimeChaos/KernelChaos únicos, workflows | Solo K8s, curva CRD |
| **LitmusChaos 3.x** | K8s operator + GitOps + hub | ChaosHub, multi-cluster, probes integrados | Setup más pesado |
| **AWS FIS** | Managed AWS | Native EC2/RDS/ECS, stop conditions, orquesta Chaos Mesh/Litmus | Solo AWS |
| **Gremlin** | SaaS comercial | UX pulida, safety built-in, soporte enterprise | $$, cerrado |
| **Steadybit** | SaaS + on-prem | Hipótesis-driven fuerte, integra Prometheus | $$, europeo |

Para LinguaDev Pro (EKS + AWS), la combinación práctica: **Chaos Mesh** para fault injection dentro del cluster + **AWS FIS** para fallos de infra AWS.

---

## 4. Blast radius, kill switches y chaos en producción (nivel avanzado)

### 4.1 La escalera de blast radius

Regla operativa: **cada experimento nuevo empieza en el paso 1** y sube uno cuando el previo es exitoso:

1. Un pod en **dev local** (kind).
2. Un pod en **staging**.
3. Múltiples pods en **staging**.
4. Múltiples pods + servicio dependiente en **staging**.
5. Un pod en **prod** durante bajo tráfico.
6. 1% del tráfico prod durante bajo tráfico.
7. 10% del tráfico prod.
8. Una AZ completa (Chaos Gorilla).
9. Una región completa (Chaos Kong).

Cada escalón revela cosas nuevas. Netflix documentó que el escalón 8→9 tomó ~2 años de práctica.

### 4.2 Kill switches automáticos con Prometheus + AWS FIS

**Patrón: CloudWatch alarm sobre métrica Prometheus** vía CloudWatch metric-stream + FIS stop condition.

```hcl
resource "aws_cloudwatch_metric_alarm" "chaos_kill_switch" {
  alarm_name          = "linguadev-chaos-abort"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "http_5xx_error_rate"
  namespace           = "LinguaDev/API"
  period              = 60
  statistic           = "Average"
  threshold           = 1.0  # 1% error rate
  treat_missing_data  = "notBreaching"

  alarm_description = "Chaos kill switch: aborts FIS if 5xx > 1%"
}

resource "aws_fis_experiment_template" "kill_pods" {
  # ... resto config
  stop_condition {
    source = "aws:cloudwatch:alarm"
    value  = aws_cloudwatch_metric_alarm.chaos_kill_switch.arn
  }
}
```

**Patrón: manual kill switch en Slack** (bot que ejecuta `kubectl delete`):

```yaml
# k8s/chaos-killswitch-bot.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chaos-killswitch-bot
spec:
  template:
    spec:
      containers:
        - name: bot
          image: ghcr.io/linguadev/chaos-bot:2026.08
          env:
            - name: SLACK_APP_TOKEN
              valueFrom: { secretKeyRef: { name: slack, key: app-token } }
            - name: COMMAND
              value: "/chaos-abort"
```

Comando de Slack `/chaos-abort <experiment-id>` invoca:

```python
# chaos_bot.py
import subprocess
from slack_bolt import App

app = App()

@app.command("/chaos-abort")
def abort_chaos(ack, respond, command):
    ack()
    experiment_id = command["text"].strip()
    if not experiment_id:
        respond("Uso: /chaos-abort <experiment-id>")
        return

    result = subprocess.run(
        ["kubectl", "delete", "chaos", experiment_id, "-A"],
        capture_output=True, text=True
    )
    respond(f"Abort executed:\n```{result.stdout}{result.stderr}```")

if __name__ == "__main__":
    app.start(port=3000)
```

### 4.3 Chaos en producción con feature flags

**Idea:** cada fallback path en la app está protegido por un feature flag. Un experimento puede:

1. Activar el flag "simulate recommendation-slow" para 10% de usuarios.
2. La app cliente respeta el flag y usa el fallback local.
3. Métricas verifican que la experiencia no se degrada visiblemente.
4. Si algo va mal, se desactiva el flag instantáneamente (segundos).

Con **OpenFeature** (CNCF, estándar 2024+) + Unleash:

```typescript
// linguadev-api / recommendations.ts
import { OpenFeature } from '@openfeature/server-sdk';

async function getRecommendations(userId: string) {
  const client = OpenFeature.getClient();
  const simulateSlow = await client.getBooleanValue('chaos.simulateSlowRecs', false, {
    targetingKey: userId
  });

  if (simulateSlow) {
    await sleep(500);  // simula degradación
  }

  try {
    return await recommendationService.get(userId, { timeout: 400 });
  } catch (err) {
    // fallback: cached local
    return cache.getRecent(userId);
  }
}
```

El experimento se configura desde el panel de Unleash con targeting `10% users`. Si el fallback no funciona, se apaga en 1 segundo. Este patrón (Netflix, Slack, Uber) es la forma **más segura** de hacer chaos en prod: el chaos vive **dentro del código**, no en la infraestructura, y el kill switch es un flag boolean.

### 4.4 Game days: el formato organizacional

Un **game day** es una sesión planificada (2-4h) donde el equipo ejecuta chaos experiments juntos, observa y aprende. No es un incident real; es un ejercicio.

Formato canónico:

```markdown
# Game Day 2026-08-20 — LinguaDev Pro

## Objetivos
1. Validar que el failover de Aurora funciona con carga real (ver [Cap 37](./37-disaster-recovery-y-backups.md)).
2. Descubrir qué pasa si `recommendation-service` responde 2s en vez de 200ms.
3. Practicar el rol de Incident Commander (ver [Cap 39](./39-incident-response-y-oncall.md)).

## Participantes
- IC: alice
- Ops Lead: bob (ejecuta comandos)
- Observer: carol (mira dashboards)
- Scribe: dave (mantiene timeline)
- Facilitator: eve (introduce sorpresas)

## Agenda
- 09:00 — briefing, revisión de dashboards baseline
- 09:15 — Experimento 1: kill 30% de pods API en staging
- 09:45 — Retrospectiva breve, hipótesis para prod
- 10:00 — Experimento 2: mismo, 10% en prod, 5min
- 10:30 — Break
- 10:45 — Experimento 3: latency injection en recommendations
- 11:30 — Debrief general + action items
- 12:00 — Cierre

## Reglas
- Cualquiera puede decir "STOP" y se aborta.
- Los descubrimientos van al canal público #chaos-days.
- Post-mortem blameless: enfocado en el sistema, no en personas.
- Action items con owner + fecha, tracked en Jira.
```

Regla de oro: **el game day es sagrado**. No se cancela por sprints ocupados; se planifica con anticipación como cualquier ceremonia importante. Netflix, Google DiRT y AWS lo hacen trimestralmente.

### 4.5 Cultura: learning organization

Chaos Engineering funciona solo en culturas que:

- ✅ Ven los descubrimientos como **oro**, no como fallos personales.
- ✅ Publican **blameless post-mortems** obligatorios.
- ✅ Reservan capacity para trabajar los action items (no solo "hallazgos que nadie fixea").
- ✅ Celebran públicamente los aprendizajes ("gracias al chaos day de la semana pasada descubrimos que el retry policy tenía backoff exponencial mal calibrado").
- ✅ Entrenan a nuevos miembros en la práctica (onboarding incluye "tu primer chaos experiment").
- ❌ No usan chaos como métrica de performance individual ("¿cuántos chaos rompiste este trimestre?").
- ❌ No hacen chaos silenciosamente (todo experimento se anuncia).

Sin esta cultura, la primera revelación negativa mata la práctica.

---

## 5. Ejemplo práctico: chaos completo sobre LinguaDev Pro

Objetivo: validar la resiliencia del API frente a (1) muerte de pods, (2) latencia en dependency AI, (3) partición de red hacia Postgres.

### Paso 1: baseline con carga sintética

```bash
# k6 load test durante 15 min
kubectl run k6 --image=grafana/k6:0.51.0 --rm -it -- run - <<'EOF'
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '11m', target: 100 },
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(99)<800'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get('http://linguadev-api.prod.svc.cluster.local/lessons/1');
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(1);
}
EOF
```

Registrar en Grafana: `p99=220ms`, `error_rate=0.05%`, `throughput=100 rps`. Este es el steady state.

### Paso 2: experimento 1 — PodChaos

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: exp01-kill-api
  namespace: prod
  labels:
    experiment.chaos/id: "2026-08-13-01"
    experiment.chaos/hypothesis: "kill-30pct-does-not-degrade-p99"
spec:
  action: pod-kill
  mode: fixed-percent
  value: "30"
  selector:
    namespaces: [prod]
    labelSelectors:
      "app.kubernetes.io/name": "linguadev-api"
  duration: "5m"
```

Observaciones esperadas: `p99` puede subir a 400-500ms durante los primeros 30s (mientras HPA / Karpenter crean nuevos pods) y luego volver a baseline. Si sube >800ms sostenidamente → **problema en readiness probe o startup lento**.

### Paso 3: experimento 2 — NetworkChaos hacia OpenAI

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: exp02-slow-openai
  namespace: prod
spec:
  action: delay
  mode: all
  selector:
    namespaces: [prod]
    labelSelectors: { app: linguadev-api }
  delay:
    latency: "2s"
    jitter: "500ms"
  duration: "10m"
  direction: to
  target:
    mode: all
    selector:
      externalTargets: ["api.openai.com"]
```

Hipótesis: "el API tiene timeout 3s + fallback a respuesta cacheada. p99 endpoints AI subirá pero no habrá 5xx."

Si el resultado es que los request AI **cuelgan** hasta timeout global (60s) y luego 504: el timeout no está bien configurado. **Ese es el aprendizaje**.

### Paso 4: experimento 3 — Partición Postgres

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: exp03-partition-postgres
  namespace: prod
spec:
  action: partition
  mode: all
  selector:
    namespaces: [prod]
    labelSelectors: { app: linguadev-api }
  direction: to
  target:
    mode: all
    selector:
      labelSelectors: { app: postgres }
  duration: "60s"
```

Hipótesis: "el API detecta pérdida de DB, responde 503 con `Retry-After: 5s`, y se recupera <60s tras restaurar."

### Paso 5: kill switch con FIS + CloudWatch

```hcl
resource "aws_cloudwatch_metric_alarm" "chaos_kill" {
  alarm_name          = "linguadev-chaos-kill"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5xx_rate"
  namespace           = "LinguaDev/API"
  period              = 30
  statistic           = "Average"
  threshold           = 1.0
}

resource "aws_fis_experiment_template" "orchestrate" {
  role_arn    = aws_iam_role.fis.arn
  description = "Orchestrated chaos with kill switch"

  stop_condition {
    source = "aws:cloudwatch:alarm"
    value  = aws_cloudwatch_metric_alarm.chaos_kill.arn
  }

  action {
    name      = "chaos-mesh-network"
    action_id = "aws:eks:inject-kubernetes-custom-resource"
    parameter {
      key   = "kubernetesApiVersion"
      value = "chaos-mesh.org/v1alpha1"
    }
    parameter {
      key   = "kubernetesKind"
      value = "NetworkChaos"
    }
    parameter {
      key   = "kubernetesNamespace"
      value = "prod"
    }
    parameter {
      key   = "kubernetesSpec"
      value = jsonencode({
        action  = "delay"
        mode    = "all"
        delay   = { latency = "500ms" }
        duration = "10m"
      })
    }
    target { key = "Cluster", value = "linguadev-eks" }
  }

  target {
    name          = "linguadev-eks"
    resource_type = "aws:eks:cluster"
    selection_mode = "ALL"
    resource_arns  = [data.aws_eks_cluster.main.arn]
  }
}
```

### Paso 6: documentar hallazgos

```markdown
# Chaos Report 2026-08-13

## Exp 01 — kill 30% API pods
- Hipótesis: p99 < 800ms durante experimento. VERIFICADA.
- Observación: p99 pico 540ms segundo 8, back to 220ms segundo 45.
- Action: ninguno.

## Exp 02 — slow OpenAI
- Hipótesis: fallback funciona, no 5xx. FALSA.
- Observación: 12% de 5xx timeout durante experimento; el fallback estaba solo en el endpoint `/chat` pero no en `/lessons/*/hint`.
- Action: extender fallback a hint endpoints (PR #4521, owner alice, due 2026-08-20).

## Exp 03 — partition Postgres
- Hipótesis: 503 con Retry-After. VERIFICADA.
- Observación: recuperación 42s post restauración.
- Action: reducir DB connection pool timeout de 30s a 5s (PR #4522).
```

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ Toda hipótesis es **falsable y cuantitativa**.
- ✅ Steady state con **al menos una métrica de negocio**.
- ✅ Empezá **staging** antes de prod, con **blast radius mínimo**.
- ✅ **Kill switch automático** en cada experimento (Prometheus alarm → abort).
- ✅ **Anuncio previo** en Slack, dashboard visible durante el experimento.
- ✅ **Post-experimento**: siempre resumen escrito con action items.
- ✅ **Game days trimestrales** con roles definidos.
- ✅ **Chaos automatizado 24/7** cuando el equipo está listo (Chaos Monkey style).
- ✅ Feature flags para chaos en **código de aplicación**, no solo infra.
- ✅ **Cultura blameless**: el descubrimiento se celebra.

### Anti-patrones

- ❌ "Chaos" sin hipótesis, steady state, ni observability.
- ❌ Empezar directamente en prod, blast radius grande.
- ❌ Sin kill switch —el humano se distrae, el sistema se rompe.
- ❌ Chaos silencioso (sin anuncio); las víctimas piensan que es incident real.
- ❌ Post-mortem con "culpables" en vez de "sistemas frágiles".
- ❌ No trabajar los action items —el chaos se convierte en show sin efecto.
- ❌ Chaos en **release freeze / Black Friday**.
- ❌ Chaos sobre servicio que **no cumple SLO base** todavía.
- ❌ Hipótesis vaga ("el sistema no se caerá").
- ❌ Confundir chaos engineering con load testing o penetration testing.

### Tabla decisión herramienta

| Necesidad | Herramienta |
|---|---|
| Chaos en K8s, self-hosted, flexible | **Chaos Mesh 2.7** |
| Chaos en K8s con GitOps + hub | **LitmusChaos 3.x** |
| Chaos AWS infra (EC2/RDS/ECS) | **AWS FIS** |
| Chaos + observability + safety UX | **Gremlin** (SaaS) |
| Chaos hipótesis-driven fuerte | **Steadybit** |
| Chaos en app código (feature flags) | **OpenFeature + Unleash/LaunchDarkly** |

---

## 7. Casos reales industria 2011-2026

**Netflix Chaos Monkey (2011):** el origen. Cuando Netflix migró a AWS, Chaos Monkey mataba instancias EC2 al azar durante horas laborales para forzar arquitecturas resilientes. Open-source en 2012 (github.com/Netflix/chaosmonkey). Evolucionó a Simian Army (Latency, Conformity, Doctor, Security, Janitor Monkey; Chaos Gorilla mataba AZs; Chaos Kong mataba regiones enteras).

**Netflix Chaos Kong en incidents reales (2015, 2017, 2021):** durante caídas reales de AWS us-east-1, Netflix ejecutó failover automático a otras regiones —posible porque Chaos Kong los había preparado. Zero downtime visible para usuarios.

**Amazon GameDay (2011+):** Jesse Robbins (ex-Amazon, "Master of Disaster") popularizó los game days internos. Amazon los mantiene como práctica trimestral obligatoria en teams de retail y AWS.

**Google DiRT (Disaster Recovery Testing, 2006+):** anterior incluso a Chaos Monkey. Google ejecuta ejercicios donde simulan caídas de servicios, incluso incluyendo apagado físico de datacenters completos. Documentado en el SRE Book.

**Facebook Storm testing:** Facebook simula pérdida de un datacenter completo periódicamente. En 2011 documentaron que descubrieron dependencies inesperadas en cada ejercicio durante 2+ años.

**LinkedIn Waterbear (2016+):** framework interno para chaos que integra con su observability stack. Publicaron paper sobre lecciones tras 3 años.

**Uber uDestroy (2017+):** su plataforma interna, expandida a incluir tests de failover de regiones y particiones de red. Contribuyeron a la comunidad con learnings sobre chaos en microservicios.

**AWS FIS lanzamiento (marzo 2021):** por primera vez, un hyperscaler ofreció chaos como servicio managed. Democratizó la práctica para empresas sin ex-Netflix. Expansión 2022 con soporte de Chaos Mesh y Litmus. 2024-2026: más tipos de fault (RDS failover, ECS task kill, EKS pod-level).

**Gremlin y Kolton Andrus (2016+):** Andrus (ex-Amazon, ex-Netflix) fundó Gremlin como plataforma comercial. Popularizó el concepto de "safety-first chaos" con dashboards de blast radius integrados. Publicó "Learning Chaos Engineering" (O'Reilly 2020).

**Chaos Mesh CNCF Incubating (2020, madurez 2024+):** PingCAP donó el proyecto a CNCF. En 2024 alcanzó estabilidad para producción en clusters grandes; en 2026 la versión 2.7 mejora RBAC y multi-cluster.

**LitmusChaos CNCF Incubating (2021+):** MayaData donó el proyecto. Su ChaosHub introdujo el modelo "marketplace de experimentos" que resonó con equipos multi-tenant. Version 3.x en 2024-2026 introduce ChaosCenter como control plane.

**Slack incident 2021 + chaos response:** Slack tuvo un outage largo por dependencies inesperadas en su stack de sesiones. Post-mortem público mencionó que **la falta de chaos regular** había permitido que los coupling se acumularan sin detección.

**GitLab ChaosCraft (2023):** GitLab publicó su propio programa interno de chaos, con game days públicos y post-mortems abiertos como parte de su cultura de radical transparency.

**PagerDuty Failure Fridays (2015+):** cada viernes, un equipo diferente ejecuta un experimento y comparte lecciones con toda la empresa. Formato adoptado por Etsy, Salesforce y otros.

---

## 8. Ejercicios prácticos

### Ejercicio 1: PodChaos con hipótesis y verificación

**Objetivo:** ejecutar tu primer experimento con estructura completa.

**Setup:**
- Cluster kind con Chaos Mesh 2.7 instalado.
- Deployment `nginx` con 5 réplicas y Service `nginx`.
- k6 corriendo carga (`kubectl run k6...`).
- Grafana con dashboard mostrando `http_success_rate` desde k6 metrics.

**Pasos:**
1. Escribí hipótesis: "matar 20% de pods → success rate se mantiene >99% gracias a load balancer y Deployment reconciliation".
2. Establecé baseline (5 min de tráfico estable).
3. Aplicá `PodChaos` con `mode: fixed-percent`, `value: 20`, `duration: 3m`.
4. Observá success rate y latencia p99 durante el experimento.
5. Remové chaos y verificá recuperación.
6. Documentá resultado: hipótesis verificada o rechazada, con datos.

**Criterios de éxito:**
- [ ] Hipótesis por escrito **antes** del experimento.
- [ ] Baseline capturado (screenshot Grafana).
- [ ] Success rate durante el experimento medido.
- [ ] Post-mortem breve escrito (aún si nada rompió).
- [ ] Chaos removido correctamente.

**Bonus:** repetir con `value: 60` y observar diferencia.

---

### Ejercicio 2: NetworkChaos con kill switch manual

**Objetivo:** aprender a abortar experimentos y practicar el discipline de blast radius.

**Setup:**
- Chaos Mesh en cluster.
- Deployment `linguadev-api` (mock con `python -m http.server`) y dependency `db`.
- Prometheus + Grafana con `error_rate` graficado.

**Pasos:**
1. Aplicá `NetworkChaos` con `action: delay`, `latency: 1s`, sobre el tráfico API → DB.
2. Observá el impacto.
3. Introducí un cambio en el manifest: `latency: 30s` (excesivo).
4. Antes de aplicar, escribí el comando exacto de abort: `kubectl delete networkchaos <name> -n <ns>`.
5. Aplicá el chaos.
6. Cuando `error_rate` sube a >5%, **ejecutá el abort manual**.
7. Verificá recuperación.

**Criterios de éxito:**
- [ ] Comando de abort documentado y ensayado.
- [ ] Abort ejecutado en <30s tras detectar la degradación.
- [ ] Recuperación total <2 min.
- [ ] Documento con las decisiones tomadas en tiempo real.

**Bonus:** configurar Prometheus alert que emita evento cuando `error_rate > 3%` y automatizar el abort con un webhook.

---

### Ejercicio 3: game day de 90 min sobre LinguaDev Pro

**Objetivo:** ensayar el formato completo con roles.

**Setup:**
- Equipo mínimo 3 personas (IC, Ops, Observer).
- Cluster staging con Chaos Mesh.
- Slack channel dedicado #game-day-YYYYMMDD.
- Dashboard baseline en Grafana.

**Pasos:**
1. Preparar 3 experimentos escritos (uno por participante).
2. Kickoff 15 min: revisar dashboards baseline, distribuir roles.
3. Experimento 1 (25 min): ejecutar, observar, resumen breve.
4. Break 5 min.
5. Experimento 2 (25 min).
6. Experimento 3 (25 min).
7. Debrief final (15 min): action items con owner+fecha.

**Criterios de éxito:**
- [ ] Los 3 experimentos completados sin causar incident real.
- [ ] Al menos 3 action items generados y tracked.
- [ ] Timeline documentado por el Scribe.
- [ ] Post-mortem publicado en confluence/wiki en <7 días.

**Bonus:** invitar a un stakeholder de negocio como observer (transparencia).

---

### Ejercicio 4: AWS FIS con stop condition CloudWatch

**Objetivo:** experimentar con managed chaos y kill switch automático.

**Setup:**
- Cuenta AWS sandbox con al menos 4 instancias EC2 taggeadas `Chaos=eligible`.
- CloudWatch metric `HighErrorRate` publicada por app (o simulada con `put-metric-data`).
- IAM role `FISExperimentRole` con permissions.

**Pasos:**
1. Crear la CloudWatch alarm con umbral 1%.
2. Crear experiment template FIS que apaga 2 instancias, con stop_condition apuntando a la alarm.
3. Iniciar el experimento.
4. Simular que la alarm dispara: `aws cloudwatch set-alarm-state --alarm-name ... --state-value ALARM`.
5. Verificar que FIS aborta y devuelve las instancias.
6. Revisar los logs en `aws fis get-experiment`.

**Criterios de éxito:**
- [ ] Experimento inicia correctamente.
- [ ] Alarma dispara y FIS aborta en <60s.
- [ ] Instancias vuelven a `running`.
- [ ] Documento con timeline de eventos.

**Bonus:** integrar el resultado con SNS + Slack notification.

---

### Ejercicio 5 (avanzado): chaos automatizado 24/7 (mini Chaos Monkey)

**Objetivo:** montar un cron que mata 1 pod aleatorio cada 2 horas en staging, con reporte diario.

**Setup:**
- Cluster staging con Chaos Mesh.
- Namespace `staging` con 3+ Deployments.
- Slack webhook para reporte.

**Pasos:**
1. Crear `Schedule` de Chaos Mesh que ejecuta `PodChaos` cada 2 horas:

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata:
  name: monkey
  namespace: staging
spec:
  schedule: "0 */2 * * *"
  historyLimit: 20
  concurrencyPolicy: Forbid
  type: PodChaos
  podChaos:
    action: pod-kill
    mode: one
    selector:
      namespaces: [staging]
```

2. Crear CronJob que cada 24h ejecuta un script que:
   - Cuenta cuántos experimentos ocurrieron.
   - Cuenta pods restart en cada Deploy.
   - Cuenta alertas Prometheus disparadas.
   - Postea resumen en Slack.
3. Ejecutar 1 semana en staging.
4. Revisar: ¿algún Deployment tuvo restart storm? ¿algún alert disparó?

**Criterios de éxito:**
- [ ] Schedule ejecuta consistentemente cada 2h.
- [ ] Reporte diario en Slack.
- [ ] Al menos 1 finding real de fragilidad descubierto.
- [ ] Action item generado y trackeado.

**Bonus:** expandir a NetworkChaos aleatorio (`delay` entre 100-500ms).

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [principlesofchaos.org](https://principlesofchaos.org) — manifiesto.
- [chaos-mesh.org/docs](https://chaos-mesh.org/docs/) — Chaos Mesh 2.7 docs.
- [litmuschaos.io](https://litmuschaos.io) — LitmusChaos 3.x.
- [docs.aws.amazon.com/fis](https://docs.aws.amazon.com/fis/) — AWS FIS.
- [openfeature.dev](https://openfeature.dev) — OpenFeature (feature flags standard).

**Herramientas:**
- **Chaos Mesh** — K8s operator open-source (CNCF Incubating).
- **LitmusChaos** — K8s + GitOps chaos (CNCF Incubating).
- **AWS FIS** — managed chaos AWS.
- **Gremlin** — SaaS comercial pionero.
- **Steadybit** — SaaS + on-prem, hipótesis-driven.
- **Chaos Toolkit** — CLI open-source para experimentos JSON declarativos.
- **Toxiproxy** — proxy para chaos a nivel de red por Shopify.

**Referencias adicionales:**
- Casey Rosenthal & Nora Jones — *Chaos Engineering* (O'Reilly 2020).
- Kolton Andrus & Matthew Fornaciari — *Learning Chaos Engineering* (O'Reilly 2020).
- Google SRE Book, cap 15 "Postmortem Culture" — cultura blameless base para chaos.
- Netflix Tech Blog serie "The Netflix Simian Army".
- AWS Well-Architected Reliability Pillar — "Test reliability" pillar.

**Siguientes pasos:**
- Empezá con **staging** y `PodChaos` esta semana.
- Programá el primer **game day** en el próximo mes.
- Instrumentá al menos 1 **kill switch** automático (Prometheus + FIS o webhook manual).
- Publicá los primeros resultados en un canal público (transparencia = cultura).
- Continuá con [Cap 39 — Incident Response y on-call](./39-incident-response-y-oncall.md) para responder cuando el chaos revela un problema real.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales sobre los 5 principios de principlesofchaos.org, la genealogía Netflix Simian Army (Monkey/Gorilla/Kong), diseño hipótesis-driven, steady state cuantitativo, blast radius control, kill switches automáticos, plataformas 2026 (Chaos Mesh 2.7, LitmusChaos 3.x, AWS FIS, Gremlin, Steadybit), game days con roles, chaos en producción con feature flags, cultura blameless y anti-patrones.

- **Fuente:** [`packages/content/src/tech/devops/sim-38-chaos-engineering-in-practice.json`](../../packages/content/src/tech/devops/sim-38-chaos-engineering-in-practice.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-38-chaos-engineering-in-practice`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 37 — Disaster Recovery y backups](./37-disaster-recovery-y-backups.md) · [Índice](./README.md) · [Capítulo 39 — Incident Response y on-call →](./39-incident-response-y-oncall.md)
