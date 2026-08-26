# Capítulo 40 — Cost Optimization y FinOps

> **Focus:** FinOps como práctica cultural + operativa (FinOps Foundation, ahora Linux Foundation) en 3 fases iterativas Inform / Optimize / Operate. Showback vs chargeback. Tagging strategy obligatoria. AWS Cost Explorer + Budgets + Cost Anomaly Detection. Compute pricing (On-Demand vs Reserved Instances vs Savings Plans vs Spot). Right-sizing con Compute Optimizer/Graviton. Kubernetes cost visibility con Kubecost/OpenCost. Karpenter v1 (default 2026 en EKS/AKS/GKE) para autoscaling con Spot + Graviton. Egress cost hidden (NAT Gateway, cross-AZ, cross-region). S3 Intelligent-Tiering. Cost como métrica de primera clase.
> **Áreas:** Reliability · Cloud economics · Engineering culture
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos cloud AWS/GCP/Azure (ver [cap 14 — cloud fundamentals](./14-cloud-fundamentals-y-multi-cloud.md)).
- Kubernetes básico + HPA/PDB (ver [cap 07](./07-fundamentos-kubernetes.md), [cap 08](./08-kubernetes-workloads.md)).
- IaC (Terraform, CDK).
- Familiaridad con billing dashboards AWS/GCP/Azure.
- Prometheus + Grafana (ver [cap 17](./17-prometheus-y-metrics.md), [cap 18](./18-grafana-y-dashboards.md)).

**Glosario mínimo:**
- **FinOps** (Cloud Financial Operations): práctica cultural y operativa que combina finance + engineering + product para gestionar el gasto cloud como responsabilidad compartida. Framework mantenido por [FinOps Foundation](https://finops.org) (Linux Foundation).
- **Inform / Optimize / Operate**: las 3 fases iterativas del framework FinOps.
- **Showback**: mostrar el costo por equipo/proyecto sin cobrarlo internamente.
- **Chargeback**: cobrar el costo internamente al equipo/proyecto.
- **Tagging strategy**: convención de tags obligatorios (owner, cost-center, environment, project) que permite cost allocation.
- **On-Demand**: precio estándar sin compromiso.
- **Reserved Instance (RI)**: compromiso 1-3 años a un instance type específico, descuento 40-72%.
- **Savings Plan**: compromiso 1-3 años a un gasto/hora, más flexible que RI, descuento 27-72%.
- **Spot Instance**: capacidad ociosa AWS con precio 70-90% menor, interrumpible con 2 min warning.
- **Compute Optimizer**: servicio AWS de recomendaciones ML para right-sizing (extendido a Graviton en 2024+).
- **Graviton**: procesadores ARM AWS, ~20% más baratos que x86 equivalentes.
- **Karpenter**: node provisioner Kubernetes (open-source AWS + CNCF), **default 2026 en EKS/AKS/GKE**, provisiona en 30-60s vs 3-5 min de Cluster Autoscaler.
- **Kubecost / OpenCost**: OpenCost es motor CNCF open-source de cost monitoring K8s; Kubecost es producto comercial encima.
- **Egress cost**: costo de tráfico saliente (S3→internet, cross-AZ, cross-region, NAT Gateway); la fuente más común de sorpresas en la factura.
- **Unit economics**: costo por unidad de negocio ($/user, $/transacción, $/lesson).

**Setup mínimo:**

```bash
# 1. AWS CLI 2.17+
aws --version

# 2. Verificar acceso a Cost Explorer + Budgets + Compute Optimizer
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -d '30 days ago' +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY \
  --metrics UnblendedCost

aws budgets describe-budgets --account-id $(aws sts get-caller-identity --query Account --output text)

aws compute-optimizer get-enrollment-status

# 3. OpenCost en cluster K8s
kubectl create ns opencost
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm install opencost opencost/opencost -n opencost

# Acceder a la UI
kubectl -n opencost port-forward svc/opencost 9090:9090

# 4. Karpenter v1 en EKS
helm install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "1.2.0" --namespace kube-system \
  --set "settings.clusterName=linguadev-eks"

# 5. Infracost para IaC
brew install infracost   # o https://www.infracost.io/docs/
infracost breakdown --path=terraform/
```

---

## 1. El gran cuadro

**La cloud no es barata por defecto —hay que operarla.** Esta frase, atribuida a Corey Quinn (Duckbill Group / Last Week in AWS), sintetiza la industria en 2026. Migrar a AWS/GCP/Azure prometía "solo pagás lo que usás", pero la realidad es que el gasto crece 20-40% anualmente en muchas empresas sin control explícito, y termina siendo la segunda o tercera línea de costo tras nómina. Los CFO ya no aceptan "es lo que cuesta la nube"; exigen visibilidad, ownership y accountability. La respuesta cultural + operativa se llama **FinOps** (Cloud Financial Operations), un framework mantenido por la [FinOps Foundation](https://finops.org) (parte de Linux Foundation desde 2020) que redefine el gasto cloud como **responsabilidad compartida** entre finance, engineering y product.

FinOps se articula en **3 fases iterativas**: (1) **Inform** —construir visibilidad: tagging estratégico, cost allocation por equipo/producto, showback dashboards accesibles, alertas de anomalía—; (2) **Optimize** —actuar sobre los datos: right-sizing con AWS Compute Optimizer + Graviton, comprar Savings Plans/RIs para el baseline estable, mover workloads elegibles a Spot con Karpenter, S3 Intelligent-Tiering, EBS gp2→gp3, eliminar unused—; (3) **Operate** —convertir en proceso continuo: policies IaC (Terraform Sentinel, OPA), Infracost en PRs, cost como KPI, FinOps reviews mensuales, unit economics dashboards. El error clásico es saltarse Inform: sin visibilidad, cualquier optimización es adivinanza. Comprar Reserved Instances 3 años sin saber qué workloads van a migrar a Graviton en 6 meses = commitment perdido. Corey Quinn advierte constantemente que "los 3-year RIs se compran con optimismo y se lloran con Graviton".

El landscape 2026 se transformó por tres fuerzas técnicas: **Karpenter v1** (GA 2024, default 2026 en EKS/AKS/GKE) provisiona nodos K8s en 30-60s vs 3-5 min de Cluster Autoscaler, con soporte first-class para Spot + Graviton + right-sizing automático. **Kubecost/OpenCost** (OpenCost es CNCF Incubating, motor open-source; Kubecost es el producto comercial) hicieron accesible el cost allocation a nivel pod/deployment/label; hoy es baseline en cualquier cluster serio, con alternativas como **Cast AI** y **ScaleOps** ofreciendo optimization automática. **Graviton** (procesadores ARM AWS, 3ª generación en 2023, 4ª en 2024-2025) consolidó su valor: ~20% más barato que x86 equivalente y frecuentemente mejor performance por watt; AWS Compute Optimizer añadió recomendaciones Graviton nativas en 2024, y la mayoría de imágenes populares (Node, Python, JVM, PostgreSQL) tienen builds ARM oficiales.

El eje **costos ocultos** merece atención: la factura visible (compute, storage) suele ser solo 60-70% del total; el resto viene de **egress cost** —**la fuente #1 de sorpresas**: cross-AZ traffic ($0.01-0.02/GB), cross-region ($0.02-0.09/GB), NAT Gateway ($0.045/GB), internet egress ($0.09/GB desde us-east-1)—; **licenses SaaS ocultas** (Datadog, New Relic sub-cuentas), **snapshots olvidados**, **EBS volumes de instancias terminadas**, **Load Balancers unused**, **Elastic IPs no attached**. En 2026, este capítulo cubre FinOps end-to-end: framework con casos reales, Cost Explorer + Budgets + Anomaly Detection con CLI, Reserved Instances vs Savings Plans vs Spot decision matrix, Kubernetes cost con Karpenter + OpenCost, egress traps con arquitecturas para reducirlos, y termina con ejercicios verificables sobre **LinguaDev Pro**.

---

## 2. FinOps framework y visibilidad (Inform) (nivel básico)

### 2.1 FinOps: 6 principios y 3 fases

**Los 6 principios de FinOps Foundation:**

1. **Teams need to collaborate.** Finance + Engineering + Product hablan en la misma mesa.
2. **Everyone takes ownership of their cloud usage.** No hay un "cost cop" central; cada team responde por su gasto.
3. **A centralized team drives FinOps.** Hay un team pequeño (FinOps team) que **habilita**, no ejecuta por otros.
4. **Reports should be accessible and timely.** Dashboards near-real-time por equipo.
5. **Decisions are driven by business value of cloud.** No es "gastar menos" — es maximizar valor por dólar.
6. **Take advantage of the variable cost model of the cloud.** RIs, Spot, autoscaling —no seas "cloud pero on-prem mentality".

**Las 3 fases (iterativas, no lineales):**

| Fase | Mes | Actividades |
|---|---|---|
| **Inform** | 1-3 | Tagging strategy, Cost Explorer + CUR, dashboards showback, alerts anomalía |
| **Optimize** | 3-6 | Right-sizing, RI/SP purchase para baseline, Spot para elegibles, S3 tiering, cleanup |
| **Operate** | 6+ | Policies IaC, Infracost en PRs, cost KPIs, unit economics, monthly FinOps reviews |

Cada iteración descubre más waste y afina más policies. **Empezar por Optimize sin Inform = optimizar a ciegas.**

### 2.2 Tagging strategy: la base de todo

Sin tags, no hay cost allocation. Los tags no se retrofitean fácilmente —hay que definir la estrategia y aplicarla como policy desde el primer recurso.

**Tags obligatorios (LinguaDev Pro):**

| Tag | Valores | Ejemplo |
|---|---|---|
| `Environment` | prod, staging, dev, sandbox | `Environment=prod` |
| `Owner` | team email | `Owner=platform@linguadev.app` |
| `CostCenter` | código contable | `CostCenter=CC-1042` |
| `Project` | slug del proyecto/producto | `Project=linguadev-api` |
| `ManagedBy` | terraform, cdk, manual | `ManagedBy=terraform` |
| `DataClass` | public, internal, confidential, pii | `DataClass=pii` |

**Enforcement con AWS Organizations Service Control Policies (SCPs) + tag policies:**

```json
{
  "tags": {
    "Environment": {
      "tag_key": { "@@assign": "Environment" },
      "tag_value": { "@@assign": ["prod", "staging", "dev", "sandbox"] },
      "enforced_for": { "@@assign": ["ec2:instance", "s3:bucket", "rds:cluster", "rds:instance", "eks:cluster"] }
    },
    "Owner": {
      "tag_key": { "@@assign": "Owner" },
      "enforced_for": { "@@assign": ["ec2:instance", "s3:bucket", "rds:cluster"] }
    }
  }
}
```

**Enforcement con Terraform (default tags):**

```hcl
provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      Environment = var.environment
      Owner       = var.owner_email
      CostCenter  = var.cost_center
      Project     = "linguadev"
      ManagedBy   = "terraform"
    }
  }
}
```

**Enforcement con Kubernetes admission webhook (Kyverno o Gatekeeper):**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-cost-tags
spec:
  validationFailureAction: enforce
  rules:
    - name: require-namespace-labels
      match:
        resources:
          kinds: [Namespace]
      validate:
        message: "Namespaces must have owner, cost-center, project labels"
        pattern:
          metadata:
            labels:
              owner: "?*"
              cost-center: "?*"
              project: "?*"
```

**Auditoría de tags:**

```bash
# Buckets sin owner tag
aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do
  o=$(aws s3api get-bucket-tagging --bucket "$b" 2>/dev/null | jq -r '.TagSet[]|select(.Key=="Owner")|.Value // "MISSING"')
  echo "$b $o"
done | grep MISSING

# EC2 instances sin CostCenter tag
aws ec2 describe-instances \
  --query 'Reservations[].Instances[?!Tags[?Key==`CostCenter`]].[InstanceId,State.Name]' \
  --output table
```

### 2.3 AWS Cost Explorer + Cost and Usage Report (CUR)

**Cost Explorer** (UI + API): views agregadas por dimensión (service, linked account, tag). Free, incluido en toda cuenta AWS.

CLI: gasto de los últimos 30 días agrupado por servicio:

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -d '30 days ago' +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --query 'ResultsByTime[-1].Groups[?Metrics.UnblendedCost.Amount>`50`].[Keys[0],Metrics.UnblendedCost.Amount]' \
  --output table
```

**CUR (Cost and Usage Report):** dataset detallado a nivel de línea horaria, entregado a S3, consumible con Athena/QuickSight/tools terceros. Es la fuente de la verdad para análisis profundo.

Setup CUR:

```bash
aws cur put-report-definition --report-definition '{
  "ReportName": "linguadev-cur-hourly",
  "TimeUnit": "HOURLY",
  "Format": "Parquet",
  "Compression": "Parquet",
  "AdditionalSchemaElements": ["RESOURCES", "SPLIT_COST_ALLOCATION_DATA"],
  "S3Bucket": "linguadev-cur-us-east-1",
  "S3Prefix": "cur/",
  "S3Region": "us-east-1",
  "AdditionalArtifacts": ["ATHENA"]
}'
```

Query Athena típico: top 20 recursos por costo del último mes:

```sql
SELECT
  line_item_resource_id,
  product_servicecode,
  resource_tags_user_project,
  resource_tags_user_owner,
  SUM(line_item_unblended_cost) AS cost_usd
FROM cur.linguadev_cur_hourly
WHERE line_item_usage_start_date >= date_add('day', -30, current_date)
  AND line_item_line_item_type = 'Usage'
GROUP BY 1,2,3,4
ORDER BY cost_usd DESC
LIMIT 20;
```

### 2.4 AWS Budgets + Cost Anomaly Detection

**AWS Budgets:** alertas de costo/uso vs threshold. Por servicio, por tag, por cuenta.

```json
{
  "BudgetName": "linguadev-monthly-total",
  "BudgetLimit": { "Amount": "20000", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {
    "TagKeyValue": ["user:Project$linguadev"]
  },
  "NotificationsWithSubscribers": [
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 80.0,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [
        { "SubscriptionType": "EMAIL", "Address": "finops@linguadev.app" },
        { "SubscriptionType": "SNS", "Address": "arn:aws:sns:us-east-1:123456789012:finops" }
      ]
    },
    {
      "Notification": {
        "NotificationType": "FORECASTED",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 100.0,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [
        { "SubscriptionType": "EMAIL", "Address": "cfo@linguadev.app" }
      ]
    }
  ]
}
```

**AWS Cost Anomaly Detection** (GA 2020, más features 2024-2026): ML-based, detecta desviaciones inusuales sin threshold manual.

```bash
# Crear monitor
aws ce create-anomaly-monitor \
  --anomaly-monitor '{
    "MonitorName": "linguadev-all-services",
    "MonitorType": "DIMENSIONAL",
    "MonitorDimension": "SERVICE"
  }'

# Crear subscription
aws ce create-anomaly-subscription \
  --anomaly-subscription '{
    "SubscriptionName": "linguadev-anomalies",
    "MonitorArnList": ["arn:aws:ce::123456789012:anomalymonitor/abc-def"],
    "Subscribers": [
      { "Type": "SNS", "Address": "arn:aws:sns:us-east-1:123456789012:cost-anomalies" }
    ],
    "Threshold": 100.0,
    "Frequency": "DAILY"
  }'
```

Detecta cosas como: "el gasto en NAT Gateway pasó de $200/día a $2400/día en 48h" —usualmente un bug de retry loop haciendo tráfico masivo cross-AZ.

### 2.5 Showback vs chargeback

**Showback:** mostrar el gasto por equipo/producto en un dashboard. Presión moral, no financiera.

**Chargeback:** cobrar internamente al equipo/producto (cross-charge en contabilidad). Presión financiera directa, exige más maturity.

| Estrategia | Ventajas | Desventajas |
|---|---|---|
| **Showback** | Fácil, buy-in rápido | Puede ignorarse si no hay accountability |
| **Chargeback** | Accountability alto | Requiere maturity contable, puede generar juegos |

Recomendación práctica: **empezar con showback**, considerar chargeback tras 6-12 meses de FinOps maduro.

Dashboard Grafana con OpenCost + Prometheus:

```promql
# Costo mensual por namespace (últimos 30 días)
sum(
  opencost_pod_cost_hourly * 24 * 30
) by (namespace)
```

---

## 3. Optimize: compute pricing, right-sizing, Karpenter (nivel medio)

### 3.1 On-Demand vs Reserved Instances vs Savings Plans vs Spot

**Landscape AWS 2026:**

| Modelo | Descuento típico | Compromiso | Uso ideal |
|---|---|---|---|
| **On-Demand** | 0% (baseline) | Ninguno | Cargas variables, pruebas |
| **Compute Savings Plans** | 27-66% | 1-3 años, $/hora | Baseline flexible cross-family/region |
| **EC2 Instance Savings Plans** | 27-72% | 1-3 años, family+region | Baseline restringido a family |
| **Standard Reserved Instance** | 40-72% | 1-3 años, instance específico | Legacy, casi obsoleto vs SP |
| **Convertible Reserved Instance** | 40-66% | 1-3 años, cambiable | Legacy, casi obsoleto vs SP |
| **Spot Instance** | 70-90% | Ninguno, 2min warning | Workloads interrumpibles |

**Regla de oro FinOps:** comprometer solo el **baseline estable** —la porción del gasto que sabés con >90% confianza estará ahí en 1-3 años—. Sobre-comprometer = commitment perdido si migrás o reducís. Sub-comprometer = pagás On-Demand innecesariamente.

**Cobertura target típica:** 60-80% del gasto compute cubierto por commitments (nunca 100% —dejá margen para migración/cambios).

**Preferir Compute Savings Plans sobre EC2 Instance SP** en 2026: la flexibilidad (aplica a EC2, Fargate, Lambda; cualquier region/family) vale más que el 6% adicional de descuento. Excepción: si tenés 100% certeza de instance family estable (raro con Graviton apareciendo).

**Corey Quinn quote:** "3-year RIs se compran con optimismo y se lloran con Graviton."

Comprar Savings Plan CLI:

```bash
# 1. Ver ofertas actuales
aws savingsplans describe-savings-plans-offerings \
  --plan-types Compute \
  --payment-options 'No Upfront' \
  --durations 31536000 \
  --currencies USD

# 2. Comprar (después de verificación en Cost Explorer recommendations)
aws savingsplans create-savings-plan \
  --savings-plan-offering-id "abc-123" \
  --commitment "10.00" \
  --upfront-payment-amount "0"
```

**Reevaluar cada 3-6 meses**: workloads cambian, families evolucionan (Graviton), tu baseline se ajusta.

### 3.2 Spot instances: cuándo SÍ y cuándo NO

**Reglas:**

- ✅ Workload **interruptible** (tolera 2 min warning).
- ✅ **Stateless** o con **checkpointing**.
- ✅ **Horizontal scalable** (no una gran instancia crítica).
- ✅ **Diversificado** en 5+ instance types (reduce spot outage simultáneo).

**Buenos candidatos:** batch, CI/CD runners, ML training (con checkpointing), stateless workers, dev/staging clusters.

**Malos candidatos:** DB primaria, API con SLA estricto 100% en Spot, cualquier stateful crítico sin replicación.

**Estrategia práctica:** mix conservador — mayoría On-Demand/SP para baseline crítico, 10-30% Spot como buffer flexible.

### 3.3 Right-sizing con AWS Compute Optimizer y Graviton

**AWS Compute Optimizer** analiza CloudWatch metrics (CPU, memoria, network, disk) durante ≥14 días y emite recomendaciones ML de right-sizing por recurso.

**Novedad 2024-2026:** recomendaciones Graviton nativas. Si tu m5.xlarge está sobredimensionada, sugiere `m7g.large` con estimación de ahorro (~20% base + right-size). Requiere validar compatibilidad ARM (imágenes, dependencies).

```bash
# Habilitar
aws compute-optimizer put-recommendation-preferences \
  --resource-type Ec2Instance \
  --scope '{"Name": "AccountId", "Value": "123456789012"}' \
  --enhanced-infrastructure-metrics ACTIVE

# Ver recomendaciones EC2
aws compute-optimizer get-ec2-instance-recommendations \
  --query 'instanceRecommendations[?finding==`Overprovisioned`].[instanceArn,currentInstanceType,recommendationOptions[0].instanceType,recommendationOptions[0].estimatedMonthlySavings.value]' \
  --output table
```

**Ejemplo salida real:**

```
| instanceArn | current | recommended | savings/mes |
|-------------|---------|-------------|-------------|
| ...i-abc123 | m5.4xlarge | m7g.xlarge | $312 |
| ...i-def456 | c5.2xlarge | c7g.large  | $184 |
| ...i-ghi789 | r5.large   | r7g.medium | $98  |
```

**Python: análisis de gastos y sugerencias combinadas Compute Optimizer + tags:**

```python
# scripts/cost_analysis.py
"""Combina CUR + Compute Optimizer para sugerencias por owner."""
import boto3
import pandas as pd
from collections import defaultdict

ce = boto3.client('ce', region_name='us-east-1')
co = boto3.client('compute-optimizer', region_name='us-east-1')

def get_cost_by_tag(days=30):
    """Costo por tag Owner en los últimos N días."""
    from datetime import datetime, timedelta
    end = datetime.utcnow().date()
    start = end - timedelta(days=days)
    resp = ce.get_cost_and_usage(
        TimePeriod={'Start': str(start), 'End': str(end)},
        Granularity='MONTHLY',
        Metrics=['UnblendedCost'],
        GroupBy=[{'Type': 'TAG', 'Key': 'Owner'}],
    )
    result = {}
    for group in resp['ResultsByTime'][0]['Groups']:
        owner = group['Keys'][0].split('$')[-1] or 'UNTAGGED'
        cost = float(group['Metrics']['UnblendedCost']['Amount'])
        result[owner] = cost
    return result

def get_rightsizing_savings():
    """Suma ahorros mensuales potenciales por instancia."""
    savings = defaultdict(float)
    paginator = co.get_paginator('get_ec2_instance_recommendations')
    for page in paginator.paginate():
        for rec in page['instanceRecommendations']:
            if rec['finding'] == 'Overprovisioned':
                opt = rec['recommendationOptions'][0]
                monthly = float(opt.get('estimatedMonthlySavings', {}).get('value', 0))
                # Owner tag
                owner = 'UNTAGGED'
                for t in rec.get('tags', []):
                    if t['key'] == 'Owner':
                        owner = t['value']
                        break
                savings[owner] += monthly
    return dict(savings)

def report():
    cost = get_cost_by_tag(30)
    savings = get_rightsizing_savings()
    rows = []
    for owner, monthly_cost in cost.items():
        s = savings.get(owner, 0)
        pct = (s / monthly_cost * 100) if monthly_cost else 0
        rows.append({
            'Owner': owner,
            'Monthly cost (USD)': round(monthly_cost, 0),
            'Potential savings (USD)': round(s, 0),
            'Savings %': round(pct, 1),
        })
    df = pd.DataFrame(rows).sort_values('Monthly cost (USD)', ascending=False)
    print(df.to_string(index=False))

if __name__ == '__main__':
    report()
```

Output ejemplo:

```
             Owner  Monthly cost (USD)  Potential savings (USD)  Savings %
        platform@                24800                     4200       16.9
             data@                18400                     3100       16.8
             web@                 12300                     1900       15.4
         mobile@                  6200                      780       12.6
         UNTAGGED                 4100                      620       15.1
```

El equipo con más ahorro potencial es el primer target.

### 3.4 EBS: gp2 → gp3, snapshots, unused volumes

**EBS gp3** (2020+) es ~20% más barato que gp2 con mejor performance base. Migración trivial:

```bash
# Convertir todos los volumes gp2 → gp3
aws ec2 describe-volumes --filters Name=volume-type,Values=gp2 \
  --query 'Volumes[].VolumeId' --output text | tr '\t' '\n' | while read vid; do
  aws ec2 modify-volume --volume-id "$vid" --volume-type gp3
done
```

**Cleanup EBS orfanos** (volumes de EC2 terminadas):

```bash
aws ec2 describe-volumes \
  --filters Name=status,Values=available \
  --query 'Volumes[].[VolumeId,Size,Tags[?Key==`Name`].Value|[0],CreateTime]' \
  --output table
```

**Snapshots viejos:**

```bash
aws ec2 describe-snapshots --owner-ids self \
  --query 'Snapshots[?StartTime<=`2025-08-13`].[SnapshotId,VolumeSize,StartTime,Description]' \
  --output table
```

### 3.5 S3: Intelligent-Tiering, lifecycle, unused buckets

**S3 Intelligent-Tiering** (2018+, mejorado continuamente) mueve automáticamente objetos entre tiers según acceso —sin retrieval fees—. En 2026 es baseline para cualquier bucket con acceso variable.

```bash
aws s3api put-bucket-intelligent-tiering-configuration \
  --bucket linguadev-user-uploads \
  --id "auto-tier" \
  --intelligent-tiering-configuration '{
    "Id": "auto-tier",
    "Status": "Enabled",
    "Tierings": [
      { "Days": 90, "AccessTier": "ARCHIVE_ACCESS" },
      { "Days": 180, "AccessTier": "DEEP_ARCHIVE_ACCESS" }
    ]
  }'
```

**Lifecycle rules** (más manual pero predecible):

```json
{
  "Rules": [
    {
      "ID": "logs-to-glacier",
      "Status": "Enabled",
      "Filter": { "Prefix": "logs/" },
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" },
        { "Days": 90, "StorageClass": "GLACIER" },
        { "Days": 365, "StorageClass": "DEEP_ARCHIVE" }
      ],
      "Expiration": { "Days": 2555 }
    },
    {
      "ID": "expire-multipart",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    },
    {
      "ID": "expire-old-versions",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 90 }
    }
  ]
}
```

**Detección de buckets no usados:**

```bash
# Buckets sin GET requests en 90 días (via CloudWatch)
aws s3api list-buckets --query 'Buckets[].Name' --output text | tr '\t' '\n' | while read b; do
  gets=$(aws cloudwatch get-metric-statistics \
    --namespace AWS/S3 --metric-name AllRequests \
    --dimensions Name=BucketName,Value="$b" Name=FilterId,Value=EntireBucket \
    --start-time $(date -u -d '90 days ago' +%Y-%m-%dT%H:%M:%S) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
    --period 86400 --statistics Sum --query 'Datapoints[].Sum' --output text)
  total=$(echo "$gets" | tr '\t' '\n' | awk '{s+=$1} END {print s+0}')
  [ "$total" -eq 0 ] && echo "UNUSED: $b"
done
```

---

## 4. Kubernetes cost con Karpenter, OpenCost y egress (nivel avanzado)

### 4.1 Karpenter v1: el default 2026

**Karpenter** (open-source AWS, ahora también en AKS y GKE) reemplaza a Cluster Autoscaler. Ventajas:

- **Provisiona nodos en 30-60s** (vs 3-5 min de Cluster Autoscaler).
- **Bin-packing dinámico**: elige instance types óptimos por workload real, no por node groups pre-definidos.
- **Spot native**: manejo de interrupciones con drenado ordenado.
- **Graviton native**: mezcla ARM + x86 según affinity.
- **Consolidación**: mueve pods para densificar y apaga nodos vacíos.

En **2026 es default** en EKS Auto Mode (2024), AKS Automatic (2024) y GKE Autopilot (con adopters crecientes).

**Instalación (EKS 1.30+):**

```bash
helm install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "1.2.0" \
  --namespace kube-system \
  --set "settings.clusterName=linguadev-eks" \
  --set "settings.interruptionQueue=linguadev-karpenter-sqs" \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::123456789012:role/karpenter"
```

**NodePool** con Spot + Graviton + fallback:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  template:
    metadata:
      labels:
        provisioned-by: karpenter
    spec:
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]
        - key: kubernetes.io/os
          operator: In
          values: ["linux"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["6"]
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      expireAfter: 720h  # ciclado cada 30 días
  limits:
    cpu: 1000
    memory: 1000Gi
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
  weight: 100
---
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  amiFamily: Bottlerocket
  role: karpenter-node
  subnetSelectorTerms:
    - tags: { karpenter.sh/discovery: linguadev-eks }
  securityGroupSelectorTerms:
    - tags: { karpenter.sh/discovery: linguadev-eks }
  tags:
    Environment: prod
    ManagedBy: karpenter
    CostCenter: CC-1042
```

**NodePool separado para workloads no-interruptibles** (DB, stateful):

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: stateful
spec:
  template:
    spec:
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]   # solo on-demand
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["r"]            # memoria alta
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]        # Graviton
      taints:
        - key: stateful
          value: "true"
          effect: NoSchedule
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
```

Pods stateful requieren `tolerations` matching.

### 4.2 Kubecost / OpenCost: cost allocation por pod/deployment/label

**OpenCost** (CNCF Incubating, motor open-source) y **Kubecost** (producto comercial encima, con multi-cluster, SSO, RBAC avanzado) mapean el costo del cluster (nodos EC2, EBS, egress) a workloads (pods, deployments, namespaces, labels).

Instalación OpenCost:

```bash
helm repo add opencost https://opencost.github.io/opencost-helm-chart
helm install opencost opencost/opencost \
  --namespace opencost --create-namespace \
  --set opencost.exporter.defaultClusterId=linguadev-prod \
  --set opencost.prometheus.internal.enabled=true \
  --set opencost.prometheus.internal.namespaceName=monitoring \
  --set opencost.prometheus.internal.serviceName=prometheus-server
```

**Query cost por namespace últimos 7 días:**

```bash
kubectl -n opencost port-forward svc/opencost 9003:9003 &
curl "http://localhost:9003/allocation?window=7d&aggregate=namespace&accumulate=true" | \
  jq '.data[] | { namespace: .name, cpu: .cpuCost, ram: .ramCost, network: .networkCost, total: .totalCost }' | \
  jq -s 'sort_by(.total) | reverse | .[0:10]'
```

Ejemplo output:

```json
[
  { "namespace": "prod", "cpu": 412.30, "ram": 187.20, "network": 89.10, "total": 688.60 },
  { "namespace": "prod-workers", "cpu": 214.80, "ram": 92.10, "network": 12.30, "total": 319.20 },
  { "namespace": "monitoring", "cpu": 62.10, "ram": 48.30, "network": 8.70, "total": 119.10 }
]
```

**Kubecost adicional (comercial):** multi-cluster consolidation, savings recommendations automáticas, integración Slack, chargeback reports para finance.

**Alternativas 2026:**

- **Cast AI** — autopilot que optimiza nodes en background.
- **ScaleOps** — VPA/HPA-like optimization con recomendaciones aplicadas automáticamente.
- Ambas ofrecen "no code" con más automation, a costo mensual.

### 4.3 Egress cost: la fuente #1 de sorpresas

**Precios AWS típicos (2026, us-east-1):**

| Tipo | Costo típico |
|---|---|
| **Same AZ, private IP** | Gratis |
| **Cross-AZ, private IP** | $0.01/GB (en cada dirección → $0.02/GB efectivo) |
| **Cross-region** | $0.02-0.09/GB |
| **NAT Gateway** | $0.045/GB procesado + $0.045/hora/gateway |
| **Internet egress** | $0.09/GB (primeros 10TB), decreciente |
| **CloudFront to internet** | $0.085/GB pero cache reduce origen |

**Casos reales que explotan la factura:**

1. **Microservicios cross-AZ sin awareness.** Un cluster con pods distribuidos entre 3 AZs y servicios que hablan aleatoriamente → cada request internet cruza AZ 2 veces → $$ inesperado.
2. **NAT Gateway como bottleneck.** Todo egress de subnet privada pasa por NAT → si tu app hace 10TB/mes de tráfico a S3 (no via VPC endpoint), pagás $450/mes de NAT + egress adicional.
3. **Datadog / New Relic / Splunk agents** enviando logs a internet desde subnets privadas via NAT → miles de $.
4. **Cross-region replication de datos grandes** sin evaluar coste ($0.02/GB us-east-1 → us-west-2, ~$20/TB).
5. **Egress a competidores** (S3 → un cliente en GCP): 10TB/mes desde S3 = $900/mes solo egress.

**Mitigaciones:**

- **VPC Endpoints (S3, DynamoDB, ECR)**: gratis para S3 gateway endpoint; interface endpoints con costo pero mucho menor que NAT.
- **Zone-aware routing** (topology-aware hints en Kubernetes 1.27+): pods hablan preferentemente con pods de la misma AZ.
- **CloudFront** delante de S3 público reduce origen egress.
- **Private link** para SaaS soportado (Datadog, Snowflake).
- **Compresión de logs** antes de mandarlos out.

**Ejemplo VPC Endpoint S3 (Terraform):**

```hcl
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id
  tags = { Name = "s3-endpoint", ManagedBy = "terraform" }
}
```

Ahorro típico: si tenés 20TB/mes de tráfico S3, pasás de $900 (NAT + egress) a $0 (VPC endpoint gateway).

**Query CUR: top consumidores de NAT Gateway:**

```sql
SELECT
  line_item_resource_id AS nat_gateway,
  resource_tags_user_owner,
  SUM(line_item_unblended_cost) AS cost_last_30d
FROM cur.linguadev_cur_hourly
WHERE line_item_usage_start_date >= date_add('day', -30, current_date)
  AND product_product_name = 'Amazon Virtual Private Cloud'
  AND line_item_usage_type LIKE '%NatGateway-Bytes%'
GROUP BY 1, 2
ORDER BY cost_last_30d DESC
LIMIT 20;
```

### 4.4 Cost como métrica de primera clase: unit economics

El objetivo maduro FinOps: **cost por unidad de negocio** ($ per user, $ per transaction, $ per lesson en LinguaDev). Cuando el equipo mira dashboards de reliability, también mira "$0.023 per active user" y trend mensual.

Grafana panel con OpenCost + Prometheus metrics propias:

```promql
# Costo por lesson completada, últimos 7 días
sum(rate(opencost_pod_cost_hourly{namespace="prod"}[7d]))
  /
sum(rate(lessons_completed_total[7d]))
```

Si el número crece sin razón (más costo por lesson) → señal de degradación de eficiencia.

**Dashboard target: 5 tiles:**

1. Total spend MTD vs budget.
2. Top 10 services by cost (con delta vs mes anterior).
3. Cost by team/owner (chargeback view).
4. Waste indicators (unused EBS, Elastic IPs, orphaned snapshots).
5. Unit economics ($/user, $/lesson) con trend.

---

## 5. Ejemplo práctico: FinOps completo para LinguaDev Pro

Objetivo: implementar Inform + Optimize + Operate baseline.

### Paso 1: tagging strategy (Terraform default tags)

```hcl
# terraform/providers.tf
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Environment  = var.environment
      Owner        = var.owner_email
      CostCenter   = var.cost_center
      Project      = "linguadev"
      ManagedBy    = "terraform"
      DataClass    = var.data_class
    }
  }
}

# Kyverno policy para namespaces K8s
resource "kubernetes_manifest" "require_tags" {
  manifest = yamldecode(file("${path.module}/../k8s/policies/require-tags.yaml"))
}
```

### Paso 2: Cost Explorer + Anomaly Detection

```bash
# Habilitar CUR y anomaly detection
aws ce create-anomaly-monitor --anomaly-monitor '{
  "MonitorName": "linguadev-all-services",
  "MonitorType": "DIMENSIONAL",
  "MonitorDimension": "SERVICE"
}'

aws ce create-anomaly-subscription --anomaly-subscription '{
  "SubscriptionName": "linguadev-anomalies-slack",
  "MonitorArnList": ["arn:aws:ce::123456789012:anomalymonitor/mon-abc"],
  "Subscribers": [{"Type": "SNS", "Address": "arn:aws:sns:us-east-1:123456789012:finops-alerts"}],
  "Threshold": 100.0,
  "Frequency": "DAILY"
}'
```

### Paso 3: Budgets por proyecto

```hcl
resource "aws_budgets_budget" "linguadev_monthly" {
  name              = "linguadev-monthly-total"
  budget_type       = "COST"
  limit_amount      = "20000"
  limit_unit        = "USD"
  time_unit         = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$linguadev"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = ["finops@linguadev.app"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = ["cfo@linguadev.app"]
  }
}
```

### Paso 4: right-sizing con Compute Optimizer + Graviton

```bash
# Auditar overprovisioning
aws compute-optimizer get-ec2-instance-recommendations \
  --query 'instanceRecommendations[?finding==`Overprovisioned`].[
    instanceArn,
    currentInstanceType,
    recommendationOptions[0].instanceType,
    recommendationOptions[0].estimatedMonthlySavings.value
  ]' --output table

# Migrar a Graviton donde aplique (verificar compatibilidad ARM primero)
# 1. Build image multi-arch
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/linguadev/api:2026.08 --push .

# 2. Actualizar Deployment con nodeSelector arm64
kubectl -n prod patch deployment linguadev-api --patch '{
  "spec": {"template": {"spec": {"nodeSelector": {"kubernetes.io/arch": "arm64"}}}}
}'
```

### Paso 5: Karpenter con Spot + Graviton (ver secc 4.1)

Aplicar `NodePool` "default" (spot+graviton) y "stateful" (on-demand+graviton) del ejemplo previo.

### Paso 6: OpenCost + dashboard Grafana

```bash
helm install opencost opencost/opencost -n opencost --create-namespace \
  --set opencost.exporter.defaultClusterId=linguadev-prod

# Dashboard Grafana: importar dashboard ID 15419 (OpenCost oficial)
```

### Paso 7: Savings Plans para baseline

```bash
# Revisar recomendaciones en Cost Explorer
aws ce get-savings-plans-purchase-recommendation \
  --savings-plans-type COMPUTE_SP \
  --term-in-years ONE_YEAR \
  --payment-option NO_UPFRONT \
  --lookback-period-in-days SIXTY_DAYS

# Comprar según recomendación
aws savingsplans create-savings-plan \
  --savings-plan-offering-id "offering-abc" \
  --commitment "12.50"   # $/hora, cubre ~70% del baseline
```

### Paso 8: Infracost en PRs (Operate)

```yaml
# .github/workflows/infracost.yaml
name: Infracost
on: [pull_request]
jobs:
  infracost:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: infracost/actions/setup@v3
        with: { api-key: ${{ secrets.INFRACOST_API_KEY }} }
      - run: |
          infracost breakdown --path=terraform/ \
            --format=json --out-file=/tmp/infracost.json
          infracost comment github --path=/tmp/infracost.json \
            --repo=$GITHUB_REPOSITORY --pull-request=${{ github.event.number }} \
            --github-token=${{ secrets.GITHUB_TOKEN }} \
            --behavior=update
```

Cada PR muestra el delta de costo del cambio IaC. Cambios grandes (>$500/mes) requieren aprobación de FinOps team.

### Paso 9: FinOps review mensual

Reunión de 60 min con:

- Finance representative.
- Engineering leads (platform, data, mobile, web).
- Product owner.

Agenda:

- Gasto MTD vs budget, delta vs mes anterior.
- Top 5 anomalías detectadas.
- Estado de action items del mes previo.
- Nuevas oportunidades (right-sizing, Graviton migrations, SP purchases).
- Unit economics trend ($/user).
- Decisiones estratégicas.

Output: minute publicada + action items en Jira.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Tagging enforcement desde día 1** (SCP + Terraform default_tags + Kyverno).
- ✅ **Inform antes que Optimize**; sin datos, las decisiones son adivinanzas.
- ✅ **Showback antes que chargeback**; empezar con visibilidad, avanzar cuando maduro.
- ✅ **Savings Plans > Reserved Instances** (flexibilidad).
- ✅ **Cubrir 60-80% del compute con commitments**, no 100%.
- ✅ **Spot solo para workloads interruptibles + diversificados**.
- ✅ **Compute Optimizer + Graviton** en cada review trimestral.
- ✅ **Karpenter v1 default** para K8s (2026).
- ✅ **OpenCost/Kubecost** para cost visibility en K8s.
- ✅ **VPC Endpoints (S3, DynamoDB, ECR)** para reducir NAT Gateway cost.
- ✅ **Topology-aware routing** para minimizar cross-AZ egress.
- ✅ **S3 Intelligent-Tiering** por default en buckets con acceso variable.
- ✅ **Infracost en PRs** de IaC.
- ✅ **Unit economics** ($/user, $/tx) como métrica top.
- ✅ **FinOps review mensual** con finance + engineering + product.

### Anti-patrones

- ❌ Comprar RIs 3 años sin Inform.
- ❌ Sin tagging strategy (untagged = pool huérfano imposible de asignar).
- ❌ Spot 100% para servicios stateful críticos.
- ❌ Datadog/New Relic sin private link → egress masivo.
- ❌ NAT Gateway procesando todo el tráfico S3 (usar VPC endpoint).
- ❌ FinOps como "puesto de trabajo" único ("FinOps engineer arreglará todo").
- ❌ "FinOps = gastar menos" en vez de "maximizar valor por dólar".
- ❌ Snapshots y EBS orfanos sin cleanup.
- ❌ Cross-region replication sin evaluar $0.02/GB.
- ❌ Dashboard cost solo visible por finance (equipos no ven su gasto).
- ❌ Ignorar Compute Optimizer / Graviton recommendations.
- ❌ Cluster Autoscaler en 2026 cuando Karpenter provisiona 5x más rápido.

### Tabla decisión compute pricing

| Situación | Recomendación |
|---|---|
| Baseline estable 24/7 conocido | Compute Savings Plan 1 año no upfront |
| Compromiso 3 años + máximo descuento | Standard RI 3 años all-upfront (poco común 2026) |
| Cargas efímeras batch | Spot |
| CI/CD, dev/staging | Spot con Karpenter |
| ML training | Spot con checkpointing (SageMaker Managed Spot) |
| DB primaria | On-Demand + Reserved (no Spot) |
| API con SLA estricto | On-Demand baseline + SP + 10-20% Spot buffer |

---

## 7. Casos reales industria 2019-2026

**FinOps Foundation (2019, Linux Foundation 2020):** J.R. Storment (ex-Cloudability, ex-Apptio) fundó FinOps Foundation como cuerpo profesional. El libro *Cloud FinOps* (O'Reilly 2019, 2ª edición 2023) es referencia canónica. Framework, principios, certificaciones (FOCP - FinOps Certified Practitioner). State of FinOps Report anual (2024: 62% de empresas cloud reportan FinOps activo).

**Netflix (público desde 2015+):** combina RIs masivos + Spot masivo. Encoding Farm es 90%+ Spot (batch idempotente ideal). Migró a Graviton progresivamente 2020-2024 con ahorros documentados. Publican tech blog posts sobre cost engineering.

**Pinterest cost migration (2020+ blog):** documentaron paso de 100% On-Demand a ~70% Savings Plans + 20% Spot + 10% On-Demand. Ahorro anual de decenas de millones. Educaron internamente sobre "cost as first-class metric".

**Spotify (2021+ blog):** construyeron "Cost Insights" interno como capa de showback antes de adoptar tooling comercial. Descubrieron waste en cross-region traffic post-migración a Google Cloud.

**Adobe (FinOps Foundation case study):** 6 meses solo Inform + tagging, luego Optimize salvando 25%, luego Operate con policies. Case study público en finops.org.

**Basecamp / 37signals "cloud exit" (2022-2024):** DHH publicó extensivamente sobre migración de AWS a colocation propio. Ahorros reportados: $4M/año post-migración. Contra-narrativa útil (no todos los workloads son ideales cloud). Pero critics señalan que para muchos workloads modernos (serverless, event-driven, global) el cloud sigue siendo mejor.

**Duolingo ML on Spot (2022+):** documentaron entrenamiento de modelos en GPU Spot con checkpointing. Ahorro 70%+ vs On-Demand.

**Corey Quinn / Duckbill Group:** el analista más citado en cost analysis pública. Newsletter *Last Week in AWS* (>50k subs), podcast *Screaming in the Cloud*, roasts públicos de AWS pricing weirdness. Su tesis: "AWS bill is fractal — cada corte revela más complejidad".

**AWS Spot outage regional 2019:** múltiples empresas perdieron capacidad Spot simultáneamente. Refuerzo de importancia de diversificación (5+ instance types por ASG Spot).

**Graviton adoption wave 2023-2026:** Snap, ByteDance, Twitter (X), Datadog publicaron sobre migración a Graviton. Barrera: builds ARM (multi-arch images), dependencies binarias (algunas Python packages). En 2026, ~40% de EC2 nuevo en AWS es Graviton.

**Karpenter GA 2023, v1 2024:** AWS lanzó como sucesor de Cluster Autoscaler. En 2026 es default en EKS Auto Mode, disponible en AKS y GKE. Kubernetes 1.30+ recomendado.

**Kubecost / OpenCost:** OpenCost donado a CNCF por Kubecost Inc. en 2022, Incubating desde 2023. En 2026 es standard en clusters productivos. **Cast AI / ScaleOps** compiten con "autopilot cost optimization" — toman decisiones automáticas (right-size, spot migration) en background.

**Snowflake compute cost horror stories:** usage-based pricing puede explotar con queries mal escritas. Empresas han reportado facturas 10x del budget. Snowflake respondió con warehouse limits y resource monitors.

---

## 8. Ejercicios prácticos

### Ejercicio 1: implementar tagging + auditoría

**Objetivo:** dejar toda la cuenta AWS con tags obligatorios y auditar drift.

**Setup:**
- Cuenta AWS con acceso admin.
- Terraform o CDK para IaC.
- Al menos 20 recursos existentes.

**Pasos:**
1. Definir tag policy con `Environment`, `Owner`, `CostCenter`, `Project`, `ManagedBy`.
2. Añadir `default_tags` en providers Terraform.
3. Aplicar Terraform (los recursos IaC se re-taggean automáticamente).
4. Ejecutar auditoría con script (secc 2.2) para recursos manuales.
5. Aplicar tags manualmente o eliminar recursos huérfanos.
6. Configurar SCP + tag policy en AWS Organizations para prevenir drift.

**Criterios de éxito:**
- [ ] 100% de recursos con Environment y Owner.
- [ ] Documento de tag policy en wiki.
- [ ] Cost Explorer muestra desglose por Owner.
- [ ] Script de auditoría automatizado (CronJob/Lambda semanal).

**Bonus:** dashboard Grafana con "% tagged compliance" por servicio.

---

### Ejercicio 2: recomendaciones Compute Optimizer + migración Graviton

**Objetivo:** ejecutar right-sizing en producción reduciendo gasto ≥15%.

**Setup:**
- Compute Optimizer habilitado por ≥14 días.
- Al menos 10 EC2 en cuenta.
- Capacidad de rebuild images multi-arch (buildx).

**Pasos:**
1. `aws compute-optimizer get-ec2-instance-recommendations` → export CSV.
2. Filtrar `Overprovisioned` + candidatos Graviton.
3. Verificar compatibilidad ARM (deps, imagen base).
4. Build imágenes multi-arch (`docker buildx`).
5. Migrar workloads a nuevos instance types en waves (staging → prod).
6. Medir ahorro real en Cost Explorer 30 días después.

**Criterios de éxito:**
- [ ] Al menos 5 instancias migradas a size correcto o Graviton.
- [ ] Ahorro real medido ≥15% en compute.
- [ ] Zero downtime durante migraciones (rolling).
- [ ] Documento con lessons learned (qué apps no eran compatibles).

**Bonus:** automatizar el reporte Compute Optimizer semanal a Slack.

---

### Ejercicio 3: Karpenter + Spot en staging cluster

**Objetivo:** montar Karpenter con NodePool spot+graviton en staging.

**Setup:**
- Cluster EKS 1.30+ staging.
- IAM roles preparados.
- 3-5 deployments con réplicas variables.

**Pasos:**
1. Instalar Karpenter v1 (secc 4.1).
2. Crear NodePool `default` con spot + graviton + fallback on-demand.
3. Escalar workloads y observar provisioning speed.
4. Simular Spot interruption con `chaos-mesh` o AWS FIS.
5. Verificar drenado limpio y re-provisioning.
6. Comparar cost antes/después en OpenCost.

**Criterios de éxito:**
- [ ] Provisioning nuevo node en <90s (típico 30-60s).
- [ ] ≥70% de capacity en Spot durante steady state.
- [ ] Interrupción Spot manejada sin request drop.
- [ ] Ahorro medido ≥40% vs Cluster Autoscaler + On-Demand.

**Bonus:** aplicar consolidación agresiva (`consolidateAfter: 10s`) y medir estabilidad.

---

### Ejercicio 4: eliminar egress cost via VPC Endpoint S3

**Objetivo:** identificar y reducir NAT Gateway cost.

**Setup:**
- Cuenta AWS con NAT Gateway activo y tráfico S3 significativo.
- Athena habilitado sobre CUR.

**Pasos:**
1. Query CUR: top 10 usage types de NAT Gateway (secc 4.3).
2. Identificar qué % del tráfico es hacia S3.
3. Crear VPC Endpoint gateway para S3 (Terraform).
4. Añadir route en tablas privadas.
5. Verificar tráfico redirigido con VPC Flow Logs.
6. Medir reducción NAT en Cost Explorer 30 días.

**Criterios de éxito:**
- [ ] VPC Endpoint funcional.
- [ ] Reducción NAT cost ≥40%.
- [ ] Documento de arquitectura updated.
- [ ] Runbook para replicar en otras VPCs.

**Bonus:** hacer lo mismo con DynamoDB y ECR endpoints.

---

### Ejercicio 5 (avanzado): FinOps review + policy IaC + unit economics

**Objetivo:** montar el proceso Operate completo.

**Setup:**
- 3 meses de FinOps Inform + Optimize funcionando.
- Infracost API key.
- Grafana + OpenCost.

**Pasos:**
1. Habilitar Infracost en workflow GitHub Actions.
2. Definir policy: cualquier PR con delta >$500/mes requiere aprobación FinOps.
3. Crear dashboard Grafana con:
   - Spend MTD vs budget.
   - Top 10 services delta MoM.
   - Cost by owner.
   - Waste indicators.
   - Unit economics ($/user).
4. Instrumentar Prometheus con métrica `lessons_completed_total`.
5. Publicar dashboard link en wiki + Slack.
6. Ejecutar FinOps review mensual con finance + product.
7. Documentar action items con owner y follow-up.

**Criterios de éxito:**
- [ ] Infracost en cada PR.
- [ ] Dashboard visible por todo engineering.
- [ ] Unit economics tracked mensualmente.
- [ ] Al menos 1 review realizada con minutes públicas.
- [ ] Action items closeados en el siguiente ciclo.

**Bonus:** publicar postmortem interno de un cost anomaly reciente (analog a incidents).

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [FinOps Foundation Framework](https://www.finops.org/framework/).
- [FinOps Foundation Certifications](https://www.finops.org/certifications/).
- [AWS Cost Management Docs](https://docs.aws.amazon.com/cost-management/).
- [AWS Compute Optimizer](https://aws.amazon.com/compute-optimizer/).
- [Karpenter docs](https://karpenter.sh/docs/).
- [OpenCost docs](https://www.opencost.io/docs/).
- [Kubecost docs](https://docs.kubecost.com).

**Herramientas 2026:**
- **AWS Cost Explorer + Budgets + Anomaly Detection** — base gratis.
- **Infracost** — cost estimates en PRs de IaC.
- **OpenCost** (CNCF) — K8s cost visibility open-source.
- **Kubecost** — comercial encima de OpenCost.
- **Cast AI / ScaleOps** — autopilot optimization.
- **CloudHealth (VMware)**, **Cloudability (Apptio)** — enterprise FinOps platforms.
- **Vantage** — modern cost management SaaS.
- **CloudZero** — unit economics focus.

**Referencias adicionales:**
- J.R. Storment & Mike Fuller — *Cloud FinOps* (O'Reilly, 2ª ed 2023).
- Corey Quinn — [*Last Week in AWS* newsletter](https://www.lastweekinaws.com/).
- FinOps Foundation — *State of FinOps* annual report.
- Google — *Cloud Economics* whitepapers.

**Siguientes pasos:**
- Habilitá tagging enforcement esta semana.
- Configurá Anomaly Detection + Budget con alerts.
- Empezá con Inform 1-3 meses antes de Optimize.
- Migrá 1 workload a Graviton este mes.
- Instalá Karpenter + OpenCost en staging.
- Reuní finance + engineering + product para el primer FinOps review.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales sobre FinOps Foundation framework, 6 principios y 3 fases (Inform / Optimize / Operate), tagging strategy obligatoria, showback vs chargeback, AWS Cost Explorer + Budgets + Anomaly Detection, decisión entre On-Demand vs Reserved Instances vs Savings Plans vs Spot (con reglas de cobertura y anti-patrones), right-sizing con Compute Optimizer y migración a Graviton, Karpenter v1 (default 2026 en EKS/AKS/GKE), Kubecost/OpenCost para K8s cost, egress cost hidden (NAT Gateway, cross-AZ, cross-region) y mitigación con VPC endpoints, S3 Intelligent-Tiering, Infracost en PRs, y cost como métrica de primera clase con unit economics.

- **Fuente:** [`packages/content/src/tech/devops/sim-40-cost-optimization-finops.json`](../../packages/content/src/tech/devops/sim-40-cost-optimization-finops.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-40-cost-optimization-finops`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 39 — Incident Response y on-call](./39-incident-response-y-oncall.md) · [Índice](./README.md)
