# Capítulo 15 — Optimización de costos y FinOps en AWS

> **Focus:** Traer accountability financiera al modelo variable del cloud. Visibilidad, right-sizing, commitments, storage tiering, egress hidden costs y governance con AWS Budgets, Cost Anomaly Detection y Compute Optimizer.
> **Áreas:** Escalabilidad · Serverless · FinOps
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Conceptos de AWS EC2, RDS, S3, Lambda, VPC (NAT Gateway, VPC endpoints).
- Familiaridad con CloudWatch y métricas básicas.
- IAM básico y organización con AWS Organizations (opcional pero útil).
- Terraform o CloudFormation para IaC.
- Lectura previa recomendada: [Cap 14 — multi-región y DR](./14-multi-region-y-dr.md) para entender el trade-off entre resiliencia y costo.

**Glosario mínimo:**
- **FinOps:** práctica cross-functional (finance + engineering + product) que trae accountability al cloud variable spend. Framework: Inform → Optimize → Operate.
- **Cost Allocation Tags:** tags que activados en la consola de Billing permiten desglosar costo por Team, Environment, Product, etc.
- **CUR (Cost and Usage Report):** dump raw (Parquet/CSV) del uso detallado, base para análisis avanzado.
- **Reserved Instance (RI):** commitment por instance type + region + tenancy + OS por 1 o 3 años a cambio de descuento hasta ~72%.
- **Savings Plan (SP):** commitment por $/hora de compute que aplica a EC2, Fargate y Lambda con más flexibilidad que RIs.
- **Spot Instance:** capacidad no utilizada de AWS a hasta 90% de descuento, con 2 min de termination notice.
- **Right-sizing:** ajustar el tipo/tamaño de instancia al workload real (típicamente reducción).
- **Egress:** tráfico saliente de AWS (a internet, cross-AZ, cross-region) — la "sorpresa oculta" del cloud billing.
- **VPC Endpoint:** conexión privada a servicios AWS que evita egress a internet.
- **Compute Optimizer:** servicio managed que analiza uso histórico y recomienda right-sizing y migración a Graviton.
- **Scale-to-zero:** capacidad de pausar recursos cuando no hay tráfico (Aurora Serverless v2 scale-to-zero desde nov 2024).
- **Air-gapped / Karpenter / gp3:** términos técnicos que aparecen a lo largo del capítulo.

**Setup mínimo:**

```bash
# 1. Activar Cost Explorer (obligatorio para APIs de costos)
aws ce get-cost-and-usage \
  --time-period Start=2026-07-01,End=2026-08-01 \
  --granularity MONTHLY \
  --metrics UnblendedCost

# 2. Habilitar AWS Cost Anomaly Detection
aws ce create-anomaly-monitor \
  --anomaly-monitor '{"MonitorName":"linguadev-all-services","MonitorType":"DIMENSIONAL","MonitorDimension":"SERVICE"}'

# 3. Instalar aws-nuke o similar para limpieza en dev accounts (¡NO EN PROD!)
brew install aws-nuke

# 4. Compute Optimizer opt-in
aws compute-optimizer put-recommendation-preferences \
  --resource-type Ec2Instance \
  --preferred-resources '[{"name":"Ec2InstanceGenerations","includeList":["current"]}]'

# 5. Herramientas de análisis
pip install boto3 pandas matplotlib
# Para infracost (estimación previa a deploy)
brew install infracost
infracost auth login
```

---

## 1. El gran cuadro

El modelo económico del cloud es fundamentalmente distinto al on-premise: en lugar de invertir en hardware amortizable a 5 años, pagas **por hora, por GB, por request, por byte transferido**. Esta elasticidad es la promesa central del cloud, pero también su trampa: sin governance, cada equipo puede provisionar recursos que suman en la factura del CFO sin que nadie sepa por qué. El caso típico es la conversación del CFO al VP de Engineering: **"gastamos $200k/mes en AWS y no sé por qué"**. Esa pregunta es el nacimiento de la práctica **FinOps**.

FinOps (formalizado por la **FinOps Foundation** dentro de Linux Foundation en 2019) no es "reducir costos" ni tampoco "comprar Reserved Instances". Es una disciplina cross-functional que combina finance + engineering + product para tomar decisiones informadas sobre gasto cloud. Su framework se organiza en tres fases iterativas: **Inform** (visibilidad: tags, cost allocation, dashboards, anomaly detection), **Optimize** (right-sizing, commitments, cleanup de recursos huérfanos, storage tiering), **Operate** (governance: budgets, alerts, forecasting, cultura de accountability distribuida). Empresas maduras designan un rol de **FinOps Practitioner** (certificación disponible); startups distribuyen la práctica entre engineering leads.

En 2026 las herramientas AWS nativas cubren buena parte del camino sin necesidad de comprar SaaS: **AWS Cost Explorer** con recomendaciones de Savings Plans, **Cost Anomaly Detection** con alertas ML-based, **AWS Budgets** con acciones automáticas, **Compute Optimizer** (con capacidad extendida en 2024 para recomendar migración a **Graviton**), **Trusted Advisor** con checks de recursos idle, **S3 Storage Lens** con analytics de bucket. Para necesidades avanzadas o multi-cloud, plataformas como **Vantage**, **CloudHealth**, **Cloudability** o **Datadog Cost Management** añaden features (chargeback automatizado, Kubernetes cost allocation, forecasting sofisticado). Corey Quinn (Duckbill Group) documenta extensivamente los "cost gotchas" de AWS en su newsletter *Last Week in AWS*.

Este capítulo cubre el playbook completo aplicable en 2026: la conversación FinOps, tag taxonomy y enforcement, commitments (Compute Savings Plans vs RIs vs Spot), quick wins (EBS gp3 vs gp2, S3 Intelligent-Tiering, gp3 storage classes, unused resources), egress costs (la sorpresa: cross-AZ, cross-region, NAT Gateway, CloudFront pricing), decisión Lambda vs Fargate vs EC2 con break-even points reales, y RDS optimization con Aurora Serverless v2 scale-to-zero (feature de noviembre 2024). Ejercicios aplicables al proyecto **LinguaDev Pro** con foco en su BFF serverless (Lambda + DynamoDB) y una arquitectura híbrida que combina compute serverless con storage tiered.

---

## 2. Visibilidad: tags, budgets y anomalías (nivel básico)

### 2.1 Tag taxonomy y enforcement

Sin tagging correcto, cost allocation es imposible. Tag taxonomy típica:

| Tag | Valores ejemplo | Propósito |
|---|---|---|
| `Team` | `platform`, `content`, `ml`, `web` | Chargeback/showback por equipo |
| `Environment` | `prod`, `staging`, `dev`, `sandbox` | Separar costo por env |
| `Product` | `linguadev-pro`, `internal-tools` | Costo por línea de producto |
| `CostCenter` | `CC-100`, `CC-200` | Integración con contabilidad |
| `Owner` | `alice@`, `platform-team@` | A quién preguntar |
| `BackupTier` | `1`, `2`, `3`, `none` | Políticas de AWS Backup |
| `DataClassification` | `public`, `internal`, `pii`, `restricted` | Compliance y encryption |

**Enforcement** con **AWS Config rule** + **Organizations SCP**:

```hcl
# terraform/tagging-enforcement.tf — bloquea creación sin tags obligatorios
resource "aws_config_config_rule" "required_tags" {
  name = "required-tags-linguadev"
  source {
    owner             = "AWS"
    source_identifier = "REQUIRED_TAGS"
  }
  input_parameters = jsonencode({
    tag1Key = "Team"
    tag2Key = "Environment"
    tag3Key = "Product"
    tag4Key = "CostCenter"
  })

  scope {
    compliance_resource_types = [
      "AWS::EC2::Instance",
      "AWS::RDS::DBInstance",
      "AWS::S3::Bucket",
      "AWS::DynamoDB::Table",
      "AWS::Lambda::Function",
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
    ]
  }
}
```

Terraform provider-level tags para consistencia:

```hcl
# terraform/main.tf
provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      Team           = "platform"
      Environment    = var.environment
      Product        = "linguadev-pro"
      CostCenter     = "CC-100"
      ManagedBy      = "terraform"
      Repository     = "github.com/linguadev/infra"
    }
  }
}
```

**Activar cost allocation tags** en la consola de Billing (propagación 24h). Después, Cost Explorer permite filtrar/agrupar por tag.

### 2.2 AWS Budgets con acciones automáticas

Budgets no es solo alerta: puede ejecutar **actions** (aplicar SCP, detener recursos, remover permisos IAM) cuando se alcanza un umbral. Ejemplo: dev account con budget $500/mes que aplica SCP restrictivo al 90%.

```json
{
  "BudgetName": "linguadev-dev-monthly-budget",
  "BudgetLimit": { "Amount": "500", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {
    "TagKeyValue": ["user:Environment$dev"]
  },
  "NotificationsWithSubscribers": [
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 50,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [
        { "SubscriptionType": "EMAIL", "Address": "platform@linguadev.app" },
        { "SubscriptionType": "SNS", "Address": "arn:aws:sns:us-east-1:123456789012:budget-alerts" }
      ]
    },
    {
      "Notification": {
        "NotificationType": "FORECASTED",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 100,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [
        { "SubscriptionType": "EMAIL", "Address": "cfo@linguadev.app" }
      ]
    }
  ]
}
```

Con budget action que aplica SCP al 90%:

```bash
aws budgets create-budget-action \
  --account-id 123456789012 \
  --budget-name linguadev-dev-monthly-budget \
  --notification-type ACTUAL \
  --action-type APPLY_SCP_POLICY \
  --action-threshold ActionThresholdValue=90,ActionThresholdType=PERCENTAGE \
  --definition '{
    "ScpActionDefinition": {
      "PolicyId": "p-restrictdev123",
      "TargetIds": ["ou-abc-def"]
    }
  }' \
  --execution-role-arn arn:aws:iam::123456789012:role/budgets-action-role \
  --approval-model AUTOMATIC \
  --subscribers Address=platform@linguadev.app,Type=EMAIL
```

### 2.3 Cost Anomaly Detection

AWS Cost Anomaly Detection usa ML para detectar spikes inusuales. Configuración:

```bash
# 1. Crear monitor por servicio
aws ce create-anomaly-monitor \
  --anomaly-monitor '{
    "MonitorName": "linguadev-service-monitor",
    "MonitorType": "DIMENSIONAL",
    "MonitorDimension": "SERVICE"
  }'

# 2. Crear subscription con umbral en % o $
aws ce create-anomaly-subscription \
  --anomaly-subscription '{
    "SubscriptionName": "linguadev-anomaly-alerts",
    "Threshold": 100,
    "Frequency": "DAILY",
    "MonitorArnList": ["arn:aws:ce::123456789012:anomalymonitor/xxxx"],
    "Subscribers": [
      {"Address": "platform@linguadev.app", "Type": "EMAIL"},
      {"Address": "arn:aws:sns:us-east-1:123456789012:cost-anomaly", "Type": "SNS"}
    ]
  }'
```

Casos que detecta bien: dev que dejó Aurora encendido en weekend ($50 → $500), NAT Gateway con flood de traffic no-esperado, Lambda con loop infinito, S3 con multipart uploads sin completar.

### 2.4 Análisis programático con Python

Para reports custom o forecasting:

```python
#!/usr/bin/env python3
# scripts/cost_report.py — reporte mensual por team y service
import boto3
import pandas as pd
from datetime import datetime, timedelta

ce = boto3.client('ce', region_name='us-east-1')

def get_cost_by_dimension(days_back: int = 30):
    end = datetime.utcnow().date()
    start = end - timedelta(days=days_back)

    resp = ce.get_cost_and_usage(
        TimePeriod={'Start': start.isoformat(), 'End': end.isoformat()},
        Granularity='DAILY',
        Metrics=['UnblendedCost', 'UsageQuantity'],
        GroupBy=[
            {'Type': 'DIMENSION', 'Key': 'SERVICE'},
            {'Type': 'TAG', 'Key': 'Team'},
        ],
    )

    rows = []
    for day in resp['ResultsByTime']:
        for group in day['Groups']:
            service, team_tag = group['Keys']
            team = team_tag.replace('Team$', '') or 'untagged'
            rows.append({
                'date': day['TimePeriod']['Start'],
                'service': service,
                'team': team,
                'cost_usd': float(group['Metrics']['UnblendedCost']['Amount']),
            })

    return pd.DataFrame(rows)

def summary_by_team(df: pd.DataFrame):
    pivot = df.pivot_table(
        index='team',
        columns='service',
        values='cost_usd',
        aggfunc='sum',
        fill_value=0,
    )
    pivot['total'] = pivot.sum(axis=1)
    return pivot.sort_values('total', ascending=False)

def detect_untagged_percent(df: pd.DataFrame):
    total = df['cost_usd'].sum()
    untagged = df[df['team'] == 'untagged']['cost_usd'].sum()
    return untagged / total * 100 if total > 0 else 0

if __name__ == '__main__':
    df = get_cost_by_dimension(days_back=30)
    print(f"\nTotal últimos 30 días: ${df['cost_usd'].sum():,.2f}")
    print(f"% sin taggear (deuda): {detect_untagged_percent(df):.1f}%\n")
    print("Top costo por team y servicio:")
    print(summary_by_team(df).head(20).to_string())
```

---

## 3. Commitments y compute pricing (nivel medio)

### 3.1 Savings Plans vs Reserved Instances

En 2026 la recomendación mayoritaria es **Compute Savings Plans** (CSP) sobre RIs para la mayoría de workloads:

| Tipo | Flexibilidad | Descuento | Uso ideal |
|---|---|---|---|
| **Compute Savings Plan** | Aplica a EC2 (any family/region/OS), Fargate, Lambda | Hasta ~66% | Baseline general, flexibilidad máxima |
| **EC2 Instance Savings Plan** | Por family + region (change size/OS/AZ) | Hasta ~72% | Baseline específico por family |
| **Standard RI** | Locked a instance type + region + OS | Hasta ~72% | Legado; workload muy estable |
| **Convertible RI** | Puede cambiar family | ~60% | Legado; workload que puede evolucionar |

**Estrategia recomendada 2026** (adaptable):

1. **Cubrir 60-80% del baseline mensual** con CSP de 1 año (deja headroom para variabilidad).
2. **Comprar en tranches** (varios meses) para hedge contra cambios de necesidad.
3. **On-demand** para el resto (spikes, variabilidad).
4. **Spot** para workloads batch/interruptibles.
5. **3-year commits** solo para workload muy estable con alta confianza (mayor lock-in).

Ejemplo de análisis de necesidades:

```python
# scripts/commitment_analysis.py — estimar CSP purchase óptimo
import boto3
from datetime import datetime, timedelta

ce = boto3.client('ce')

def get_hourly_compute_cost(days_back: int = 90):
    """Obtiene costo horario de compute (EC2 + Fargate + Lambda) últimos N días."""
    end = datetime.utcnow().date()
    start = end - timedelta(days=days_back)

    resp = ce.get_cost_and_usage(
        TimePeriod={'Start': start.isoformat(), 'End': end.isoformat()},
        Granularity='HOURLY',
        Metrics=['UnblendedCost'],
        Filter={
            'Dimensions': {
                'Key': 'SERVICE',
                'Values': ['Amazon Elastic Compute Cloud - Compute', 'AWS Lambda', 'Amazon EC2 Container Service'],
            }
        },
    )
    hourly = []
    for hour in resp['ResultsByTime']:
        cost = float(hour['Total']['UnblendedCost']['Amount'])
        hourly.append(cost)
    return hourly

def recommend_csp_hourly_commit(hourly_costs: list[float], coverage_percent: float = 70):
    """Recomienda $/hora a comprar en CSP para cubrir el percentil dado."""
    sorted_costs = sorted(hourly_costs)
    percentile_idx = int(len(sorted_costs) * coverage_percent / 100)
    return sorted_costs[percentile_idx]

if __name__ == '__main__':
    hourly = get_hourly_compute_cost(days_back=90)
    p70 = recommend_csp_hourly_commit(hourly, coverage_percent=70)
    p80 = recommend_csp_hourly_commit(hourly, coverage_percent=80)
    baseline = min(hourly)
    peak = max(hourly)
    avg = sum(hourly) / len(hourly)

    print(f"Análisis últimos 90 días de compute:")
    print(f"  Costo horario baseline: ${baseline:.4f}")
    print(f"  Costo horario promedio: ${avg:.4f}")
    print(f"  Costo horario peak:     ${peak:.4f}")
    print(f"  p70 (70% de horas):     ${p70:.4f}")
    print(f"  p80 (80% de horas):     ${p80:.4f}")
    print()
    print(f"Recomendación conservadora: CSP de ${p70:.4f}/h (~${p70*730:.0f}/mes)")
    print(f"Recomendación agresiva:     CSP de ${p80:.4f}/h (~${p80*730:.0f}/mes)")
    print(f"Ahorro estimado (66% off):  ~${p70*730*0.66:.0f}/mes con recomendación conservadora")
```

### 3.2 Spot instances y Karpenter

Spot ofrece hasta **90% de descuento** con la única limitación de 2 min de termination notice. Ideal para: batch, ML training, CI/CD runners, dev/test, workloads con checkpointing.

**Karpenter** (open source de AWS) revolucionó la gestión de Spot en Kubernetes. Configuración típica que combina Graviton + Spot + fallback On-Demand:

```yaml
# karpenter-nodepool-graviton-spot.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: graviton-spot-primary
spec:
  template:
    metadata:
      labels:
        workload-tier: "batch"
    spec:
      requirements:
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["c7g", "c8g", "m7g", "m8g", "r7g"]     # Graviton3+
        - key: karpenter.k8s.aws/instance-cpu
          operator: In
          values: ["2", "4", "8", "16"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]                    # spot first
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]
      nodeClassRef:
        name: default
      taints:
        - key: workload-tier
          value: batch
          effect: NoSchedule
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    expireAfter: 720h                                       # rotate nodes cada 30 días
  limits:
    cpu: 200
    memory: 800Gi
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: x86-ondemand-fallback
spec:
  template:
    spec:
      requirements:
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["m6i", "c6i"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
      weight: 10                                            # menor prioridad
```

Estimación de ahorros: **60-70% vs static ASG** con Graviton + Spot + Karpenter según casos documentados 2026.

### 3.3 Right-sizing con Compute Optimizer

**AWS Compute Optimizer** analiza uso histórico (CPU, memoria, disk, network) y recomienda:
- Change instance type (right-size).
- Migrate a Graviton (recomendaciones extendidas 2024).
- gp2 → gp3 EBS conversion.
- Lambda memory optimization.

```bash
# 1. Recomendaciones EC2 con estimated savings
aws compute-optimizer get-ec2-instance-recommendations \
  --account-ids 123456789012 \
  --output json | jq '.instanceRecommendations[] | select(.finding == "Overprovisioned") | {
    instance: .instanceArn,
    current: .currentInstanceType,
    recommended: .recommendationOptions[0].instanceType,
    savings_pct: .recommendationOptions[0].savingsOpportunity.savingsOpportunityPercentage,
    monthly_savings: .recommendationOptions[0].savingsOpportunity.estimatedMonthlySavings.value
  }'

# 2. Recomendaciones Graviton migration
aws compute-optimizer get-ec2-instance-recommendations \
  --recommendation-preferences '{"cpuVendorArchitectures":["AWS_ARM64"]}' \
  --output json

# 3. Recomendaciones Lambda
aws compute-optimizer get-lambda-function-recommendations \
  --output json | jq '.lambdaFunctionRecommendations[] | select(.finding != "OPTIMIZED") | {
    fn: .functionArn,
    current_mb: .currentMemorySize,
    recommended_mb: .memorySizeRecommendationOptions[0].memorySize,
    projected_savings_pct: .memorySizeRecommendationOptions[0].savingsOpportunity.savingsOpportunityPercentage
  }'

# 4. Recomendaciones EBS gp2 → gp3
aws compute-optimizer get-ebs-volume-recommendations \
  --output json
```

### 3.4 Lambda vs Fargate vs EC2 break-even

Serverless (Lambda, Fargate) es más caro por unidad de compute pero elimina idle capacity. Rules of thumb aproximados:

| Metric | Lambda gana | Fargate gana | EC2 gana |
|---|---|---|---|
| **Utilización < 30%** | ✅ | | |
| **Utilización 30-60%** | | ✅ | |
| **Utilización > 70%** | | | ✅ |
| **Tráfico spiky/impredecible** | ✅ | | |
| **Requests < 100/s constant** | ✅ | | |
| **Requests > 1000/s constant** | | | ✅ (con RIs/SP) |
| **Cold start crítico** | ❌ (aunque SnapStart ayuda) | | ✅ |
| **Duración < 15 min** | ✅ | ✅ | ✅ |
| **Duración > 15 min** | ❌ (límite Lambda) | ✅ | ✅ |
| **GPU / high memory** | ❌ | ⚠️ (limited) | ✅ |
| **Ops overhead** | Mínimo | Bajo | Alto |

Break-even calculation aproximada para un workload:

```python
# scripts/lambda_vs_fargate_break_even.py
def lambda_monthly_cost(requests_per_sec: float, avg_duration_ms: int, memory_mb: int):
    requests_month = requests_per_sec * 3600 * 24 * 30
    gb_seconds = requests_month * (avg_duration_ms / 1000) * (memory_mb / 1024)
    # 2026 pricing us-east-1 (x86)
    compute_cost = gb_seconds * 0.0000166667
    request_cost = (requests_month / 1_000_000) * 0.20
    return compute_cost + request_cost

def fargate_monthly_cost(vcpu: float, memory_gb: float, utilization_pct: float = 100):
    hours_month = 730
    # 2026 pricing us-east-1 x86 (Graviton ~20% menos)
    vcpu_cost = vcpu * hours_month * 0.04048 * (utilization_pct / 100)
    memory_cost = memory_gb * hours_month * 0.004445 * (utilization_pct / 100)
    return vcpu_cost + memory_cost

def ec2_monthly_cost_reserved(instance_hourly_ondemand: float, savings_plan_discount: float = 0.66):
    hours_month = 730
    return instance_hourly_ondemand * hours_month * (1 - savings_plan_discount)

if __name__ == '__main__':
    # Escenario LinguaDev BFF: 50 rps promedio, 200ms de duración, 1024MB
    lambda_cost = lambda_monthly_cost(requests_per_sec=50, avg_duration_ms=200, memory_mb=1024)
    fargate_cost = fargate_monthly_cost(vcpu=1, memory_gb=2, utilization_pct=70)
    ec2_cost = ec2_monthly_cost_reserved(instance_hourly_ondemand=0.0416)  # m6g.large ~= t4g equivalente

    print(f"Comparativa para 50 rps, 200ms, 1024MB:")
    print(f"  Lambda:  ${lambda_cost:.2f}/mes")
    print(f"  Fargate: ${fargate_cost:.2f}/mes")
    print(f"  EC2 con Savings Plan: ${ec2_cost:.2f}/mes")

    # Escenario batch: 1000 rps, 50ms, 512MB (mucho tráfico constante)
    lambda_high = lambda_monthly_cost(1000, 50, 512)
    fargate_high = fargate_monthly_cost(vcpu=4, memory_gb=8, utilization_pct=85)
    ec2_high = ec2_monthly_cost_reserved(instance_hourly_ondemand=0.192)  # c6g.2xlarge

    print(f"\nComparativa para 1000 rps, 50ms constant:")
    print(f"  Lambda:  ${lambda_high:.2f}/mes")
    print(f"  Fargate: ${fargate_high:.2f}/mes")
    print(f"  EC2 con Savings Plan: ${ec2_high:.2f}/mes")
```

---

## 4. Storage y quick wins (nivel medio)

### 4.1 EBS gp3 vs gp2

**gp3** (lanzado re:Invent 2020) es strict upgrade sobre gp2 en casi todos los casos:

- **Costo**: ~$0.08/GB gp3 vs ~$0.10/GB gp2 (~20% menos).
- **IOPS/throughput desacoplados del size**: gp2 requería 1TB para 3000 IOPS; gp3 provee 3000 IOPS baseline + 125 MB/s independiente del size.
- **Migración in-place** con `ModifyVolume` — sin downtime.

Script para migrar todos los gp2:

```bash
#!/bin/bash
# scripts/migrate_gp2_to_gp3.sh
set -euo pipefail

REGION=${1:-us-east-1}
DRY_RUN=${DRY_RUN:-true}

echo "Buscando volúmenes gp2 en $REGION (dry-run=$DRY_RUN)..."

VOLUMES=$(aws ec2 describe-volumes \
  --region "$REGION" \
  --filters "Name=volume-type,Values=gp2" \
  --query 'Volumes[*].[VolumeId,Size,State,Tags[?Key==`Name`].Value|[0]]' \
  --output text)

echo "$VOLUMES" | while read -r vol_id size state name; do
  # Solo modificar volúmenes attached y sanos
  if [[ "$state" != "in-use" ]]; then
    echo "  SKIP $vol_id ($name) — state=$state"
    continue
  fi

  echo "  MIGRAR $vol_id ($name, ${size}GB, state=$state) gp2 -> gp3"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "    (dry-run, no cambios)"
  else
    aws ec2 modify-volume \
      --region "$REGION" \
      --volume-id "$vol_id" \
      --volume-type gp3 \
      --iops 3000 \
      --throughput 125
    echo "    Migración iniciada. Verifica con: aws ec2 describe-volumes-modifications --volume-ids $vol_id"
  fi
done

echo ""
echo "Ahorro estimado: aprox 20% del costo de storage EBS."
```

Ahorro típico: **~$500-1000/mes** en cuentas con 100+ gp2 volumes de tamaño moderado.

### 4.2 S3 storage classes e Intelligent-Tiering

Panorama 2026 de precio por GB/mes (us-east-1 aproximado):

| Storage class | $/GB/mes | Latencia primer byte | Uso |
|---|---|---|---|
| **S3 Standard** | $0.023 | ms | Hot access, sitio web, APIs |
| **S3 Intelligent-Tiering** | $0.023 (frecuente) → $0.00099 (deep archive) | ms | Mixed access, unpredictable |
| **S3 Standard-IA** | $0.0125 | ms | Backups, DR, > 30 días access |
| **S3 One Zone-IA** | $0.010 | ms | Same as IA pero 1 AZ (no DR-ready) |
| **S3 Glacier Instant Retrieval** | $0.004 | ms | Archive con retrieval frecuente |
| **S3 Glacier Flexible Retrieval** | $0.0036 | minutos-horas | Archive esporádico |
| **S3 Glacier Deep Archive** | $0.00099 | horas (12-48h) | True archive, compliance |

**S3 Intelligent-Tiering** en 2026 tiene 5 tiers automáticos: Frequent → Infrequent (30d) → Archive Instant (90d) → Archive Access (180d configurable) → Deep Archive Access (configurable). Fee de monitoring $0.0025/1000 objetos, **sin retrieval fee dentro del auto-tiering**. Novedad 2025: **S3 Tables** (Iceberg) también soporta Intelligent-Tiering.

Configuración Terraform:

```hcl
# terraform/s3-intelligent-tiering.tf
resource "aws_s3_bucket" "audio_assets" {
  bucket = "linguadev-audio-assets"
}

resource "aws_s3_bucket_intelligent_tiering_configuration" "audio" {
  bucket = aws_s3_bucket.audio_assets.id
  name   = "auto-tier-all-objects"
  status = "Enabled"

  tiering {
    access_tier = "ARCHIVE_ACCESS"
    days        = 90
  }

  tiering {
    access_tier = "DEEP_ARCHIVE_ACCESS"
    days        = 180
  }
}

# Lifecycle para casos deterministicos (logs, backups viejos)
resource "aws_s3_bucket_lifecycle_configuration" "logs_lifecycle" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "logs-retention"
    status = "Enabled"
    filter { prefix = "app-logs/" }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 90
      storage_class = "GLACIER"
    }
    expiration { days = 2555 }   # 7 años para compliance

    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }
    noncurrent_version_expiration { noncurrent_days = 365 }

    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}
```

**S3 Storage Lens** (gratuito) muestra analytics de bucket: distribución de storage class, top objetos, incomplete multipart uploads.

### 4.3 Recursos huérfanos ("silent killer")

Auditoría típica revela recursos que suman en la factura sin uso:

| Recurso | Costo típico si idle | Detección |
|---|---|---|
| **EBS volumes detached** | ~$8/mes cada 100GB gp3 | `aws ec2 describe-volumes --filters Name=status,Values=available` |
| **Elastic IPs unattached** | ~$3.60/mes cada | `aws ec2 describe-addresses` con AssociationId null |
| **RDS snapshots viejos** | ~$0.095/GB/mes | Trusted Advisor + retention policies |
| **NAT Gateways sin uso** | ~$32/mes + traffic | Buscar en dev accounts abandonados |
| **Load balancers idle** | ~$16/mes cada ALB | Zero requests por 30 días = candidato |
| **Elasticache idle** | Muy caro | CloudWatch memory usage < 10% |
| **CloudWatch Logs sin retention** | $0.50/GB ingested + storage indefinido | Set retention policy |
| **Incomplete multipart uploads S3** | ~$0.023/GB acumulado | Lifecycle rule `abort_incomplete_multipart_upload` |

Script de auditoría:

```python
#!/usr/bin/env python3
# scripts/orphaned_resources_audit.py
import boto3

def find_unattached_ebs(region: str):
    ec2 = boto3.client('ec2', region_name=region)
    vols = ec2.describe_volumes(Filters=[{'Name': 'status', 'Values': ['available']}])['Volumes']
    total_gb = sum(v['Size'] for v in vols)
    monthly_cost = total_gb * 0.08  # gp3 avg
    print(f"[{region}] EBS unattached: {len(vols)} volumes, {total_gb} GB, ~${monthly_cost:.2f}/mes")
    for v in vols:
        name = next((t['Value'] for t in v.get('Tags', []) if t['Key'] == 'Name'), '-')
        print(f"    {v['VolumeId']} ({name}) — {v['Size']}GB, {v['VolumeType']}, created {v['CreateTime'].date()}")
    return monthly_cost

def find_unattached_eips(region: str):
    ec2 = boto3.client('ec2', region_name=region)
    addresses = ec2.describe_addresses()['Addresses']
    unattached = [a for a in addresses if 'AssociationId' not in a]
    cost = len(unattached) * 3.60
    print(f"[{region}] EIP unattached: {len(unattached)} — ~${cost:.2f}/mes")
    for eip in unattached:
        print(f"    {eip['PublicIp']} (alloc {eip['AllocationId']})")
    return cost

def find_idle_nat_gateways(region: str):
    ec2 = boto3.client('ec2', region_name=region)
    cw = boto3.client('cloudwatch', region_name=region)
    ngs = ec2.describe_nat_gateways(Filters=[{'Name': 'state', 'Values': ['available']}])['NatGateways']
    idle = []
    for ng in ngs:
        # Check bytes out en últimos 30 días
        resp = cw.get_metric_statistics(
            Namespace='AWS/NATGateway',
            MetricName='BytesOutToDestination',
            Dimensions=[{'Name': 'NatGatewayId', 'Value': ng['NatGatewayId']}],
            StartTime='2026-07-15T00:00:00Z',
            EndTime='2026-08-15T00:00:00Z',
            Period=86400,
            Statistics=['Sum'],
        )
        total_bytes = sum(dp['Sum'] for dp in resp['Datapoints'])
        if total_bytes < 1024 * 1024 * 100:  # <100MB en 30d = idle
            idle.append((ng['NatGatewayId'], total_bytes))
    cost = len(idle) * 32
    print(f"[{region}] NAT Gateways idle: {len(idle)} — ~${cost:.2f}/mes hourly + traffic")
    for ng_id, bytes_out in idle:
        print(f"    {ng_id} — {bytes_out/1024/1024:.1f} MB out en 30d")
    return cost

if __name__ == '__main__':
    total = 0
    for region in ['us-east-1', 'eu-west-1']:
        total += find_unattached_ebs(region)
        total += find_unattached_eips(region)
        total += find_idle_nat_gateways(region)
    print(f"\nAhorro potencial mensual: ~${total:.2f}")
```

---

## 5. Egress costs y networking (nivel avanzado)

### 5.1 La sorpresa: costos de data transfer

AWS es notoriamente confuso con data transfer pricing. Categorías:

| Tipo | Costo típico | Cuándo se cobra |
|---|---|---|
| **Data In (a AWS)** | Gratis | Siempre |
| **Data Out (a internet)** | $0.09/GB (primer TB) → $0.05/GB (>150TB) | Egress from any AWS service |
| **Cross-AZ (dentro región)** | $0.01/GB in each direction | EC2-to-EC2 cross-AZ, RDS Multi-AZ |
| **Cross-Region** | $0.02/GB (US intra), $0.02-$0.09/GB (cross-continent) | Data replication, cross-region API calls |
| **NAT Gateway** | $0.045/hora + $0.045/GB processed | Traffic desde private subnet a internet |
| **VPC Peering** | Cross-region charges apply | Peering entre VPCs |
| **PrivateLink** | $0.01/hora endpoint + $0.01/GB | Managed connectivity |
| **VPC Endpoint (Gateway)** | Gratis (S3, DynamoDB) | Endpoints tipo Gateway |
| **VPC Endpoint (Interface)** | $0.01/hora × AZ + $0.01/GB | Endpoints tipo Interface (la mayoría de servicios) |
| **CloudFront a origin** | $0.085/GB (US), varía por region | Origin fetch |

### 5.2 NAT Gateway: el asesino silencioso

Un NAT Gateway cuesta $0.045/hora × 730 = **~$33/mes solo por hora**, más **$0.045/GB de traffic processed**. Un dev environment con NG idle desperdicia $33/mes. En prod con 5TB egress/mes: 33 + (5000 × 0.045) = **$258/mes por NAT Gateway**.

Alternativas:

1. **VPC Endpoints (Gateway)** para S3 y DynamoDB — **gratis** y evita egress via NG.
2. **VPC Endpoints (Interface)** para otros servicios AWS (KMS, Secrets Manager, SSM) — reduce egress.
3. **NAT Instance** (EC2 barato tipo t4g.nano ~$3/mes) para dev environments.
4. **Consolidar** múltiples NATs si tienes 1 por AZ y traffic bajo (aceptar single point of failure en dev).

Terraform para VPC Endpoints:

```hcl
# terraform/vpc-endpoints.tf — evita egress a S3 y DynamoDB
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.us-east-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  policy = jsonencode({
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
      Resource = [
        aws_s3_bucket.audio_assets.arn,
        "${aws_s3_bucket.audio_assets.arn}/*",
      ]
    }]
  })
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.us-east-1.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
}

# Interface endpoints (privados a AWS PrivateLink)
resource "aws_vpc_endpoint" "secrets_manager" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.us-east-1.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true
}
```

### 5.3 CloudFront: cache que ahorra egress

CloudFront cachea en edge locations y **evita egress desde origin**. Pricing 2026 (US/EU):
- Data Out **from CloudFront**: $0.085/GB (US), menos que directo S3.
- Data Transfer **from S3 to CloudFront**: **gratis** (2021+).
- Request charges: $0.0075 per 10k HTTPS requests.

Ahorro típico: bucket S3 con 10TB egress/mes directo → ~$900. Via CloudFront con 80% cache hit ratio → 2TB origin fetch (gratis) + 10TB de edge → **$850 aprox pero con mejor latencia + WAF integrado + Shield básico incluido**. El ahorro real es en tráfico repetido y en features (WAF, Shield Standard, HTTP/3, compression).

Configuración de origin failover para audio assets multi-región:

```hcl
# terraform/cloudfront.tf
resource "aws_cloudfront_distribution" "audio" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"      # US + EU (cheaper)
  http_version        = "http2and3"

  aliases = ["cdn.linguadev.app"]

  origin_group {
    origin_id = "audio-origin-group"
    failover_criteria { status_codes = [403, 404, 500, 502, 503, 504] }
    member { origin_id = "s3-us-east-1" }
    member { origin_id = "s3-eu-west-1" }
  }

  origin {
    domain_name = aws_s3_bucket.audio_us_east_1.bucket_regional_domain_name
    origin_id   = "s3-us-east-1"
    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.oai.cloudfront_access_identity_path
    }
  }

  origin {
    domain_name = aws_s3_bucket.audio_eu_west_1.bucket_regional_domain_name
    origin_id   = "s3-eu-west-1"
    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.oai.cloudfront_access_identity_path
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "audio-origin-group"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 3600
    default_ttl = 86400
    max_ttl     = 31536000
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.cdn.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
}
```

---

## 6. RDS y Aurora optimization

### 6.1 Aurora Serverless v2 scale-to-zero

Feature de **noviembre 2024**: Aurora Serverless v2 puede escalar a **0 ACUs**, pausando el DB tras inactividad configurable. Al primer request se reactiva en **~15 segundos**. Version requirements: Aurora PostgreSQL 13.15+/14.12+/15.7+/16.3+, Aurora MySQL 3.08+.

- **Storage sigue cobrándose** en pausa; compute no.
- **Cold-start ~15s** hace el feature apropiado para dev/staging o apps con latencia tolerante en primer request.
- **NO usar en prod tier-1** con SLO estricto de latencia.

```hcl
# terraform/aurora-serverless-scale-to-zero.tf
resource "aws_rds_cluster" "dev_serverless" {
  cluster_identifier      = "linguadev-dev-serverless"
  engine                  = "aurora-postgresql"
  engine_mode             = "provisioned"
  engine_version          = "16.4"
  database_name           = "linguadev_dev"
  master_username         = "dev_admin"
  master_password         = var.dev_db_password
  backup_retention_period = 7
  storage_encrypted       = true
  skip_final_snapshot     = true

  serverlessv2_scaling_configuration {
    max_capacity             = 4
    min_capacity             = 0            # scale-to-zero
    seconds_until_auto_pause = 300          # pausa tras 5 min inactivo
  }
}

resource "aws_rds_cluster_instance" "dev_serverless_writer" {
  cluster_identifier   = aws_rds_cluster.dev_serverless.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.dev_serverless.engine
  engine_version       = aws_rds_cluster.dev_serverless.engine_version
  publicly_accessible  = false
}
```

Ahorro típico en dev: **~$100-300/mes** por cluster que antes corría 24/7 con capacidad fija.

### 6.2 Read replicas y storage tiers

- **Read replicas** para read-heavy: descargar carga del primary. Costo: cada réplica ~= instance cost, pero permite dimensionar primary más pequeño.
- **Aurora I/O-Optimized** (2023) — pricing alternativo: paga 30% más por instance + storage, pero **sin cargo por I/O requests**. Break-even: si I/O es > 25% del bill, migrar a I/O-Optimized.
- **RDS gp3 storage** (2023) — como EBS gp3 pero para RDS: más barato y IOPS/throughput desacoplados.

### 6.3 Idle databases y right-sizing

Compute Optimizer recomienda para RDS:
- **Downsize** instances con CPU/memory bajo consistentemente.
- **Migrate a Graviton** (db.r7g, db.m7g) para 20% de ahorro con similar performance.
- **Upgrade a engine version** más nueva (mejor performance con misma capacidad).

---

## 7. Casos reales industria 2023-2026

**Airbnb S3 Intelligent-Tiering (2022+)**: publicaron ahorros de $500k+ anuales al migrar buckets con mixed access patterns a Intelligent-Tiering. Sin cambios de código, solo config.

**Duolingo migration a Graviton (2024)**: migración completa de infra a Graviton3 con ahorros documentados del ~30% en compute costs, sin degradación de performance. Case study público en re:Invent 2024.

**Pinterest Karpenter + Spot (2023-2024)**: reducción del 30% en EKS costs gracias a Karpenter + Spot con Graviton mix. Casos de spot interruption handled gracefully vía checkpointing.

**Autodesk FinOps journey (2023)**: publicaron transformación de "cloud spend caos" a FinOps mature. Tag taxonomy enforced desde IaC, chargeback mensual por team, reducción del 22% en 12 meses.

**Corey Quinn (Duckbill Group) "Why S3 pricing is so weird"**: newsletter *Last Week in AWS* documenta consistently los gotchas de billing. Casos icónicos: bucket con 400M objetos pequeños donde el request cost superó el storage cost 10x.

**Klarna cost restructuring 2024**: tras el episodio del bot IA, Klarna revisó también sus cloud costs. Reportaron ahorros significativos post-Compute Savings Plans purchase estratégico.

**Aurora Serverless v2 scale-to-zero adoption (nov 2024+)**: feature adoptado en masa para dev/staging environments. Startups reportan reducción de 60-80% en costos de dev DB.

**Ramp AWS cost transparency (2024)**: publicaron sistema interno de cost dashboards por engineer/team. Cultura de "cost is a first-class engineering concern".

**AWS logically air-gapped vault expansion (julio 2026)**: extensión a 6 regiones adicionales. Empresas reguladas migran backups a este modelo, pagando extra por inmutabilidad + air-gap.

**Compute Optimizer Graviton recommendations (2024+)**: la extensión de Compute Optimizer para recomendar migración a Graviton bajó la barrera. Empresas reportan roadmaps de 6-12 meses para migrar workloads elegibles.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Tag taxonomy y auditoría de untagged

**Objetivo:** definir tag taxonomy formal, aplicarla via IaC y medir el % de recursos sin tag.

**Setup:**
- Cuenta AWS con recursos reales.
- Terraform o CDK con provider-level tags.

**Pasos:**
1. Documenta la taxonomía mínima (Team, Environment, Product, CostCenter, Owner).
2. Añade `default_tags` en el provider Terraform.
3. Ejecuta `terraform plan` para ver drift (recursos existentes sin tag).
4. Aplica tags a recursos existentes con `aws resourcegroupstaggingapi tag-resources`.
5. Activa las tags como cost allocation tags en Billing console.
6. Después de 24h, corre el script de §2.4 para ver desglose por team.
7. Documenta el % untagged actual y objetivo (target: < 5%).

**Criterios de éxito:**
- [ ] Taxonomía documentada y publicada.
- [ ] IaC aplicando default_tags.
- [ ] Cost allocation tags activadas.
- [ ] Report inicial de desglose por team publicado.
- [ ] % untagged medido y baseline documentado.

**Bonus:** añade AWS Config rule que fuerce las tags obligatorias.

---

### Ejercicio 2: Migración de EBS gp2 a gp3

**Objetivo:** identificar volúmenes gp2 y migrar a gp3 con ModifyVolume.

**Setup:**
- Cuenta AWS con volúmenes EBS gp2 en uso.
- AWS CLI.

**Pasos:**
1. Ejecuta el script de §4.1 con `DRY_RUN=true` para ver el inventario.
2. Estima ahorro (~20% del total gp2 cost).
3. Ejecuta el script con `DRY_RUN=false` para migrar (los volúmenes atados a instances migran sin downtime).
4. Verifica con `aws ec2 describe-volumes-modifications --volume-ids <id>` que status = "completed".
5. Compara costo antes/después en Cost Explorer (esperar 24-48h para reflejo).
6. Documenta el ahorro real observado.

**Criterios de éxito:**
- [ ] Todos los volúmenes elegibles migrados.
- [ ] Sin downtime observado en instances.
- [ ] Ahorro medido en Cost Explorer.
- [ ] Postmortem con lecciones (edge cases, volúmenes que fallaron migración).

**Bonus:** configura AWS Config rule que detecte creación de nuevos gp2 y alerte.

---

### Ejercicio 3: S3 Intelligent-Tiering + Storage Lens dashboard

**Objetivo:** aplicar Intelligent-Tiering a buckets con mixed access y medir ahorro con Storage Lens.

**Setup:**
- Bucket S3 con al menos 100GB de datos mixtos.
- AWS CLI o Terraform.

**Pasos:**
1. Habilita Storage Lens en Billing console (advanced tier gratis por defecto).
2. Analiza dashboard: distribución de storage class actual, top prefixes por tamaño.
3. Identifica buckets candidatos (mixed access, tamaño moderado).
4. Aplica Intelligent-Tiering con Terraform (ver §4.2).
5. Configura lifecycle para logs (Standard → IA en 30d → Glacier en 90d).
6. Configura `abort_incomplete_multipart_upload` (7 días).
7. Espera 30-60 días y revisa Storage Lens para ver movimiento de tiers y ahorro estimado.

**Criterios de éxito:**
- [ ] Intelligent-Tiering aplicado.
- [ ] Lifecycle rules para logs configurado.
- [ ] Multipart cleanup activo.
- [ ] Storage Lens muestra movimiento entre tiers en 30+ días.
- [ ] Ahorro medido y reportado.

**Bonus:** configura S3 Storage Lens custom dashboard con metrics avanzadas y export a S3 en Parquet.

---

### Ejercicio 4: Análisis Compute Savings Plans y compra en tranches

**Objetivo:** analizar tu compute spend, calcular CSP óptimo y comprar en tranches.

**Setup:**
- Al menos 90 días de historial en la cuenta.
- Python con boto3.

**Pasos:**
1. Ejecuta el script de §3.1 (`commitment_analysis.py`) para ver baseline y recomendaciones.
2. Verifica en AWS Cost Explorer → Savings Plans Recommendations que coincide aproximadamente.
3. Decide política: 60% del baseline con CSP 1-year, resto on-demand/spot.
4. Compra en 3 tranches (1/3 cada mes) para hedge contra cambios.
5. Documenta el commitment en un doc de FinOps.
6. Mide utilization mensual (target: >90%) con Cost Explorer → Savings Plans Utilization.
7. Ajusta en el siguiente ciclo según observado.

**Criterios de éxito:**
- [ ] Análisis del baseline documentado.
- [ ] Estrategia de commitment escrita.
- [ ] Al menos 1 CSP purchase ejecutado.
- [ ] Utilization tracking configurado.
- [ ] Retrospectiva mensual programada.

**Bonus:** evalúa también EC2 Instance SP y Spot Placement Score para workloads batch.

---

### Ejercicio 5 (bonus): AWS Budgets con acciones automáticas y Cost Anomaly Detection

**Objetivo:** configurar guardrails automáticos que reaccionen a spend inesperado.

**Setup:**
- AWS Organizations con múltiples accounts (opcional pero útil).
- IAM role con permisos para budget actions.

**Pasos:**
1. Crea 3 budgets: prod ($X/mes), staging ($Y/mes), dev ($Z/mes).
2. Configura notifications a 50% (info), 80% (warning), 100% (critical).
3. Para dev budget: configura budget action que aplica SCP restrictivo al 90%.
4. Activa Cost Anomaly Detection con monitor por servicio y subscription por email + SNS.
5. Simula spike (crea recursos costosos por 24h) y verifica que las alertas disparan.
6. Documenta runbook: "budget exceeded, what to do".

**Criterios de éxito:**
- [ ] 3 budgets creados con thresholds.
- [ ] Notifications configuradas a múltiples niveles.
- [ ] Budget action con SCP para dev.
- [ ] Cost Anomaly Detection activo.
- [ ] Alerta recibida y verificada.
- [ ] Runbook publicado.

**Bonus:** integra alertas con Slack via SNS + Lambda para visibilidad del equipo.

---

## 9. Recursos + siguientes pasos

**AWS nativo:**
- **AWS Cost Explorer** — visualización y forecasting.
- **AWS Cost and Usage Report (CUR)** — dump raw para análisis avanzado.
- **AWS Budgets** con budget actions.
- **AWS Cost Anomaly Detection** — ML-based anomaly detection.
- **AWS Compute Optimizer** — right-sizing + Graviton recommendations.
- **AWS Trusted Advisor** — checks de recursos idle y best practices.
- **AWS S3 Storage Lens** — analytics de buckets.

**Tools de terceros:**
- **Vantage** — dashboards + Autopilot para SP purchases.
- **CloudHealth** (VMware) — enterprise cost management.
- **Cloudability** (Apptio) — enterprise + Kubernetes cost allocation.
- **Datadog Cost Management** — integración con observability.
- **Infracost** — estimación de costo pre-deploy en Terraform PRs.
- **Kubecost** — Kubernetes cost allocation open source.
- **Cast AI** — Kubernetes autoscaling con cost optimization.

**Comunidad y referencias:**
- [FinOps Foundation (finops.org)](https://www.finops.org) — framework oficial + State of FinOps report.
- [Corey Quinn — Last Week in AWS](https://www.lastweekinaws.com) — newsletter semanal con gotchas.
- [CloudZero blog](https://www.cloudzero.com/blog/) — S3 pricing deep dives.
- [Duckbill Group](https://duckbillgroup.com) — cost optimization consultancy.

**Certificaciones:**
- **FinOps Certified Practitioner** — cert oficial de FinOps Foundation.
- **AWS Certified Solutions Architect Professional** — incluye Well-Architected cost pillar.

**Documentación clave:**
- [AWS Well-Architected — Cost Optimization Pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html).
- [AWS Pricing Calculator](https://calculator.aws) para estimación pre-deploy.
- [AWS Bulk Pricing API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json) para automatización.

**Siguientes pasos:**
- Ejecutar los 5 ejercicios sobre LinguaDev Pro.
- Instituir revisión FinOps mensual con métricas de coverage, utilization, waste %.
- Publicar dashboard de cost per team en Slack semanal.
- Revisar los capítulos anteriores del módulo Arquitectura para asegurar que las decisiones de resiliencia y multi-región balanceen con las restricciones de costo.
- Considerar formar un rol de FinOps Practitioner cuando el spend anual supere $1M o cuando la organización cruza los 50 ingenieros.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre `scalability` y `serverless`, dificultades mid → staff. Cubren: filosofía FinOps y framework (Inform/Optimize/Operate), Savings Plans vs Reserved Instances vs Spot con estrategias de commitment, Spot instances con checkpointing y Karpenter, EBS gp3 vs gp2 con migration in-place, S3 storage classes (Standard, IA, Glacier variants, Intelligent-Tiering, Storage Lens), tag-based cost allocation con Organizations SCP y Config, recursos unused (EBS detached, EIP unattached, RDS snapshots, NAT Gateway idle), right-sizing con Compute Optimizer y Graviton recommendations, egress costs escondidos (cross-AZ, cross-region, NAT, VPC endpoints), Lambda vs Fargate vs EC2 break-even, CloudFront pricing y cache economics, AWS Budgets con acciones automáticas, Cost Anomaly Detection con ML, y RDS/Aurora optimization (Aurora Serverless v2 scale-to-zero, I/O-Optimized, read replicas, gp3 storage).

- **Fuente:** [`packages/content/src/tech/architecture/sim-15-cost-optimization.json`](../../packages/content/src/tech/architecture/sim-15-cost-optimization.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-15-cost-optimization`
- **Tiempo:** 25 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 14 — Multi-región y DR](./14-multi-region-y-dr.md) · [Índice](./README.md)
