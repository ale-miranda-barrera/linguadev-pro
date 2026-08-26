# Capítulo 14 — Multi-región y Disaster Recovery

> **Focus:** Diseñar sistemas que sobreviven la caída de una región AWS completa, con RTO/RPO explícitos, replicación cross-region, failover automatizable y ejercitado periódicamente.
> **Áreas:** Resiliencia · Escalabilidad · Continuidad de negocio
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos AWS (VPC, subnets, AZs, regiones, IAM cross-account).
- Conceptos de replicación de datos (síncrona vs asíncrona, CAP theorem).
- DNS y balanceadores (Route 53, ALB, NLB, Global Accelerator).
- Ideal: leer previamente [Cap 04 — resiliencia y fault tolerance](./04-patrones-de-resiliencia.md) y [Cap 13 — chaos engineering](./13-chaos-y-testing-en-produccion.md).
- Familiaridad con Terraform o CloudFormation.

**Glosario mínimo:**
- **RTO (Recovery Time Objective):** cuánto tiempo desde el desastre hasta que el servicio vuelve. Objetivo de negocio, no capacidad técnica.
- **RPO (Recovery Point Objective):** cuántos datos podemos perder (medidos como ventana temporal). Determinado por la frecuencia de replicación o backup.
- **AZ (Availability Zone):** data center físicamente independiente dentro de una región. Latencia inter-AZ típ. < 2ms.
- **Region:** conjunto geográfico de AZs (3-6 típ.) con backbone regional. Latencias inter-región 50-200 ms.
- **Active-Active (multi-site):** múltiples regiones sirven tráfico simultáneamente, con datos replicados.
- **Active-Passive:** una región activa, otra en standby (pilot light, warm, hot).
- **Pilot Light:** infra mínima replicada (DB, secrets), compute apagado; se enciende en desastre.
- **Warm Standby:** infra completa corriendo a capacidad reducida; se escala en desastre.
- **Failover:** transición del tráfico de la región primaria a la secundaria tras desastre.
- **Failback:** vuelta del tráfico a la región primaria tras recuperación.
- **Split-brain:** situación donde dos regiones aceptan writes simultáneos y divergen.
- **LWW (Last-Write-Wins):** política de resolución de conflictos basada en timestamp.
- **Air-gapped vault:** backup lógicamente aislado con acceso severamente restringido, protección contra ransomware/insider.

**Setup mínimo:**

```bash
# 1. AWS CLI con perfiles para múltiples regiones
aws configure --profile linguadev-us-east-1
aws configure --profile linguadev-eu-west-1

# 2. Terraform (multi-region setup)
brew install terraform  # macOS
choco install terraform # Windows
terraform version       # Verificar >= 1.9

# 3. Verificar que tus regiones tienen los servicios que necesitas
aws rds describe-db-engine-versions \
  --engine aurora-postgresql \
  --region us-east-1 \
  --query 'DBEngineVersions[*].EngineVersion' | head

aws dynamodb list-tables --region eu-west-1

# 4. Route 53 health check test manual
aws route53 test-dns-answer \
  --hosted-zone-id Z1234567890ABC \
  --record-name api.linguadev.app \
  --record-type A \
  --resolver-ip 8.8.8.8

# 5. AWS Backup (para políticas cross-region)
aws backup list-backup-vaults --region us-east-1
```

---

## 1. El gran cuadro

Una región AWS típica tiene entre 3 y 6 **Availability Zones** (data centers físicamente independientes) conectadas por fibra redundante de baja latencia. Multi-AZ es el default de la mayoría de servicios managed (RDS Multi-AZ, DynamoDB, S3) y protege contra fallos de un data center: incendio, corte de energía, fallo de red local. Sin embargo, **regiones enteras caen ocasionalmente**: us-east-1 tuvo outages notables en 2015 (DynamoDB), 2017 (S3, "internet roto por horas"), 2020, diciembre de 2021 (24h de interrupciones parciales), diciembre de 2024 (control plane de Lambda). Empresas con arquitectura single-region + backups locales tardaron 4-24 horas en recuperar; empresas con multi-región activo-activo o warm standby validado tuvieron impacto casi nulo.

Multi-región no es un botón que se activa: es una decisión arquitectónica con implicaciones profundas en **costo** (2x-4x infra), **complejidad operacional** (deploys coordinados, monitoring por región, on-call que entiende el fanout) y **consistencia de datos** (CAP theorem manifesto: no puedes tener consistency global + availability + partition tolerance simultáneamente). La conversación empieza con **RTO y RPO explícitos por tier de servicio**: acordar con negocio "¿cuánto downtime tolera este servicio?" y "¿cuántos datos podemos perder?" determina la estrategia (backup+restore, pilot light, warm standby, active-active) y su costo asociado. Un RTO de 1 minuto cuesta ~100x más que un RTO de 1 día.

AWS documenta cuatro estrategias DR clásicas en su whitepaper **Reliability Pillar** del Well-Architected Framework: (1) **Backup & Restore** — RTO horas/días, RPO horas, el más barato, adecuado para no-críticos; (2) **Pilot Light** — RTO decenas de minutos, RPO minutos, infra mínima corriendo con compute apagado; (3) **Warm Standby** — RTO minutos, RPO minutos, infra completa a capacidad reducida; (4) **Multi-Site Active-Active** — RTO segundos, RPO cerca de cero, todas las regiones sirviendo tráfico simultáneamente. La elección debe reflejar el tier del servicio: analytics con backup+restore, API core con warm standby, mission-critical global con active-active.

Este capítulo cubre la conversación completa: definir RTO/RPO con negocio, elegir estrategia, implementar con servicios AWS 2026 (DynamoDB Global Tables, Aurora Global Database, S3 Cross-Region Replication, Route 53 con health checks y failover, Global Accelerator, AWS Backup con logically air-gapped vaults expandidos en julio 2026), ejecutar **DR testing regular** (porque "untested DR is fiction"), y considerar el **failback** —a menudo más complejo que el failover porque requiere reconciliar writes divergentes. Ejercicios aplicables al proyecto **LinguaDev Pro** con foco en su BFF serverless y sus tablas DynamoDB que almacenan cards de FSRS con progreso del usuario.

---

## 2. RTO, RPO y las cuatro estrategias (nivel básico)

### 2.1 Conversación con negocio

RTO y RPO **no son decisiones técnicas puras**: son objetivos de negocio con implicaciones de costo. Un servicio con RTO 15 min + RPO 1 min significa "el servicio debe volver en 15 minutos con máximo 1 minuto de datos perdidos". La conversación con VP de producto y CFO debe cubrir:

- **¿Cuál es el impacto por hora de downtime?** ($/hora en revenue, users afectados, contract SLAs).
- **¿Cuánto podemos perder de datos escritos justo antes del fallo?** Puede ser aceptable perder 1 min en un servicio de logging, inaceptable en pagos.
- **¿Qué tier de servicio?** No todos los servicios necesitan el mismo RTO/RPO. Tiering es esencial.

Ejemplo para LinguaDev Pro:

| Servicio | Tier | RTO objetivo | RPO objetivo | Estrategia |
|---|---|---|---|---|
| BFF /api/v1/auth | Tier 1 (login) | 5 min | 30s | Warm standby multi-región |
| BFF /api/v1/evaluate | Tier 1 (core UX) | 5 min | 30s | Warm standby multi-región |
| DynamoDB user progress | Tier 1 | 5 min | 5s | Global Tables activo-activo |
| S3 audio assets | Tier 2 | 30 min | 1h | CRR asíncrono + CloudFront |
| Analytics DB (Redshift) | Tier 3 | 24h | 24h | Backup + restore cross-region |
| Dev/staging | Tier 4 | 72h | 24h | Backup + restore, best effort |

### 2.2 Las cuatro estrategias DR

AWS Well-Architected define un espectro costo vs RTO/RPO:

| Estrategia | RTO | RPO | Costo relativo | Cuándo usar |
|---|---|---|---|---|
| **Backup & Restore** | horas-días | horas | 1x | Non-critical, dev, analytics |
| **Pilot Light** | 30-60 min | minutos | 1.5x | Important services, cost-sensitive |
| **Warm Standby** | 5-15 min | minutos | 2x | Core services con RTO agresivo |
| **Active-Active** | segundos | ~0 | 2-4x | Mission-critical global |

**Backup & Restore**: solo pagas por backups (S3/Glacier). En desastre aprovisionas infra nueva y restores. Simple, barato, RTO grande.

**Pilot Light**: la "llama piloto" está encendida: DB replicada, secrets, network, imágenes de containers/AMIs listas. Compute apagado. En desastre enciendes servicios (minutos).

**Warm Standby**: infra completa corriendo pero a capacidad reducida (25%). En desastre escalas a capacidad completa. Failover más rápido que pilot light.

**Active-Active**: todas las regiones sirven tráfico normal (via Route 53 latency-based o Global Accelerator). En desastre, la región sana absorbe el tráfico. Failover automático en segundos. Requiere resolver **consistency cross-region** (DDB Global Tables con LWW, Aurora Global con single-writer + read replicas globales).

### 2.3 Multi-AZ vs Multi-Region

Confusión común: pensar que multi-AZ es "suficiente". No lo es contra regional outages. La distinción:

- **Multi-AZ**: default en managed services. Sync replication económica (<2ms). Protección contra failure de data center. RTO segundos/minutos, RPO 0 típico.
- **Multi-Region**: opt-in, complexity mayor. Async replication cross-region (50-200 ms). Protección contra regional outage. RTO segundos-minutos según estrategia, RPO segundos-minutos típ.

**Un servicio Tier-1 requiere ambos**: Multi-AZ dentro de la región primaria, más multi-región para el escenario regional.

### 2.4 CAP theorem y su manifiesto en multi-región

Multi-región es CAP theorem hecho cotidiano. No puedes tener simultáneamente:

- **C**onsistency (todos los nodes ven el mismo dato al mismo tiempo).
- **A**vailability (cada request recibe respuesta, aunque no sea la última).
- **P**artition tolerance (el sistema sigue funcionando ante network partition).

En una red distribuida real, partitions **ocurren** (P es obligatorio). Se elige entre **CP** (sacrificar availability durante partition: rechazar writes) o **AP** (sacrificar consistency: aceptar writes divergentes y reconciliar después). La mayoría de sistemas cloud modernos son **AP con eventual consistency** (DynamoDB Global Tables, Aurora Global con lag, Cassandra). **CP estricto** requiere consensus (Paxos, Raft) con latencia cross-region alta: Google Spanner con TrueTime, CockroachDB.

Para LinguaDev Pro: aceptamos AP con eventual consistency de ~1s en DynamoDB Global Tables. Un user que hace review en Madrid y consulta en Barcelona 500ms después puede ver un lag mínimo; no es un banco.

---

## 3. Herramientas y patrones concretos (nivel medio)

### 3.1 Route 53 health checks y failover

Route 53 es el DNS managed de AWS con features específicos para DR:

- **Health checks** desde múltiples ubicaciones globales, cada 10-30s.
- **Routing policies**: latency-based, geolocation, geoproximity, weighted, failover, multivalue.
- **TTL bajo** (30-60s) para failover rápido, con caveat de DNS caching agresivo en algunos clientes.

Terraform para failover primary/secondary:

```hcl
# terraform/route53-failover.tf
resource "aws_route53_health_check" "primary" {
  fqdn              = "api-us-east-1.linguadev.app"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30
  regions           = ["us-east-1", "us-west-2", "eu-west-1"]

  tags = {
    Name = "linguadev-primary-health"
  }
}

resource "aws_route53_health_check" "secondary" {
  fqdn              = "api-eu-west-1.linguadev.app"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30
  regions           = ["us-east-1", "us-west-2", "eu-west-1"]

  tags = {
    Name = "linguadev-secondary-health"
  }
}

resource "aws_route53_record" "api_primary" {
  zone_id = var.hosted_zone_id
  name    = "api.linguadev.app"
  type    = "A"
  ttl     = 60

  set_identifier  = "primary-us-east-1"
  failover_routing_policy { type = "PRIMARY" }
  health_check_id = aws_route53_health_check.primary.id
  records         = [aws_eip.us_east_1.public_ip]
}

resource "aws_route53_record" "api_secondary" {
  zone_id = var.hosted_zone_id
  name    = "api.linguadev.app"
  type    = "A"
  ttl     = 60

  set_identifier  = "secondary-eu-west-1"
  failover_routing_policy { type = "SECONDARY" }
  health_check_id = aws_route53_health_check.secondary.id
  records         = [aws_eip.eu_west_1.public_ip]
}
```

**Limitación de DNS**: algunos ISPs y clientes ignoran el TTL corto (Java DNS cache es "forever" por default). Solución más robusta para failover: **AWS Global Accelerator** con IPs anycast que no cambian y re-routing en el backbone AWS en <30s.

### 3.2 AWS Global Accelerator

Global Accelerator ofrece 2 IPs anycast estáticas globales. El tráfico entra al backbone AWS en el edge más cercano al cliente y se rutea internamente a la región healthy. Ventajas concretas:

- **IPs fijas anycast** que no cambian.
- **Re-routing en la red AWS** (health-based, ~30s convergence).
- **Mejor performance** (tráfico evita ISP variability).
- **AWS Shield built-in** contra DDoS.
- **TCP/UDP**, no solo HTTP.

Costo: ~$18/mes por accelerator + $0.015-0.035/GB DTO premium. Route 53 es más barato pero limitado por DNS caching.

```hcl
# terraform/global-accelerator.tf
resource "aws_globalaccelerator_accelerator" "linguadev" {
  name            = "linguadev-api"
  ip_address_type = "IPV4"
  enabled         = true

  attributes {
    flow_logs_enabled   = true
    flow_logs_s3_bucket = aws_s3_bucket.ga_logs.bucket
    flow_logs_s3_prefix = "ga-flow-logs/"
  }
}

resource "aws_globalaccelerator_listener" "https" {
  accelerator_arn = aws_globalaccelerator_accelerator.linguadev.id
  client_affinity = "SOURCE_IP"
  protocol        = "TCP"

  port_range {
    from_port = 443
    to_port   = 443
  }
}

resource "aws_globalaccelerator_endpoint_group" "primary" {
  listener_arn          = aws_globalaccelerator_listener.https.id
  endpoint_group_region = "us-east-1"
  traffic_dial_percentage = 100

  health_check_path     = "/health"
  health_check_port     = 443
  health_check_protocol = "HTTPS"
  health_check_interval_seconds = 30
  threshold_count       = 3

  endpoint_configuration {
    endpoint_id = aws_lb.us_east_1.arn
    weight      = 100
  }
}

resource "aws_globalaccelerator_endpoint_group" "secondary" {
  listener_arn          = aws_globalaccelerator_listener.https.id
  endpoint_group_region = "eu-west-1"
  traffic_dial_percentage = 100

  health_check_path     = "/health"
  health_check_port     = 443
  health_check_protocol = "HTTPS"

  endpoint_configuration {
    endpoint_id = aws_lb.eu_west_1.arn
    weight      = 100
  }
}
```

### 3.3 DynamoDB Global Tables

DynamoDB Global Tables es el "multi-region managed" de DDB: replica async (~1s típico) entre regiones con **multi-writer** y conflict resolution **Last-Write-Wins** por timestamp. Cada región paga capacidad + costo de **Replicated Write Requests (RRWs)**.

Requiere Streams habilitado. Consistencia:
- **Reads en la misma región** son strongly consistent (con `ConsistentRead=true`).
- **Cross-region reads** son eventual consistent (llegan cambios con lag).

Terraform para tabla `user_progress` replicada:

```hcl
# terraform/dynamodb-global-table.tf
resource "aws_dynamodb_table" "user_progress" {
  provider = aws.us_east_1

  name             = "linguadev-user-progress"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "user_id"
  range_key        = "card_id"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "user_id"
    type = "S"
  }
  attribute {
    name = "card_id"
    type = "S"
  }

  replica { region_name = "us-east-1" }
  replica { region_name = "eu-west-1" }
  replica { region_name = "ap-southeast-1" }

  point_in_time_recovery { enabled = true }
  deletion_protection_enabled = true

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.dynamodb.arn
  }

  tags = {
    Name = "linguadev-user-progress-global"
    Tier = "1"
  }
}
```

**Diseño defensivo para LWW**: dado que conflicts se resuelven por timestamp del cliente, incluir un **version number** o **operation log** en la app permite detectar y reconstruir divergencias. Ejemplo:

```ts
// packages/api/src/repos/user-progress.ts
interface CardProgress {
  user_id: string;
  card_id: string;
  stability: number;
  difficulty: number;
  last_review_ts: number;  // usado como version implícita
  review_count: number;
  region_origin: string;   // registra dónde se escribió, útil para auditoría
  version: number;         // incrementado en cada update, detecta conflicts
}

export async function updateProgress(progress: CardProgress): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: 'linguadev-user-progress',
    Key: { user_id: progress.user_id, card_id: progress.card_id },
    UpdateExpression: `
      SET stability = :s,
          difficulty = :d,
          last_review_ts = :t,
          region_origin = :r,
          version = :v + if_not_exists(version, :zero),
          review_count = if_not_exists(review_count, :zero) + :one
    `,
    ExpressionAttributeValues: {
      ':s': progress.stability,
      ':d': progress.difficulty,
      ':t': progress.last_review_ts,
      ':r': process.env.AWS_REGION,
      ':v': 1,
      ':zero': 0,
      ':one': 1,
    },
  }));
}
```

### 3.4 Aurora Global Database

Aurora Global Database ofrece replicación cross-region con **single-writer** (primary region) y **read replicas** en otras regiones. Lag típico: <1s. En desastre, se **promotes** una secondary a primary (RTO típico 1-2 min).

```hcl
# terraform/aurora-global.tf
resource "aws_rds_global_cluster" "linguadev" {
  global_cluster_identifier = "linguadev-global"
  engine                    = "aurora-postgresql"
  engine_version            = "16.4"
  database_name             = "linguadev"
  storage_encrypted         = true
}

resource "aws_rds_cluster" "primary" {
  provider = aws.us_east_1

  cluster_identifier        = "linguadev-primary"
  engine                    = aws_rds_global_cluster.linguadev.engine
  engine_version            = aws_rds_global_cluster.linguadev.engine_version
  global_cluster_identifier = aws_rds_global_cluster.linguadev.id
  master_username           = "linguadev_admin"
  master_password           = var.db_master_password
  backup_retention_period   = 35
  db_subnet_group_name      = aws_db_subnet_group.us_east_1.name
  vpc_security_group_ids    = [aws_security_group.aurora_us_east_1.id]
  skip_final_snapshot       = false
  final_snapshot_identifier = "linguadev-primary-final"
  storage_encrypted         = true
  kms_key_id                = aws_kms_key.rds.arn
}

resource "aws_rds_cluster" "secondary" {
  provider = aws.eu_west_1

  cluster_identifier        = "linguadev-secondary"
  engine                    = aws_rds_global_cluster.linguadev.engine
  engine_version            = aws_rds_global_cluster.linguadev.engine_version
  global_cluster_identifier = aws_rds_global_cluster.linguadev.id
  db_subnet_group_name      = aws_db_subnet_group.eu_west_1.name
  vpc_security_group_ids    = [aws_security_group.aurora_eu_west_1.id]
  skip_final_snapshot       = true
  storage_encrypted         = true
  kms_key_id                = aws_kms_key.rds_eu.arn

  depends_on = [aws_rds_cluster.primary]
}
```

**Failover manual (documentar en runbook)**:

```bash
# Promover secondary a primary (destructivo: rompe el global cluster)
aws rds failover-global-cluster \
  --global-cluster-identifier linguadev-global \
  --target-db-cluster-identifier arn:aws:rds:eu-west-1:123456789012:cluster:linguadev-secondary \
  --region eu-west-1

# Verificar el nuevo primary
aws rds describe-global-clusters \
  --global-cluster-identifier linguadev-global \
  --query 'GlobalClusters[0].GlobalClusterMembers'
```

Aurora también añadió en 2024 **Aurora Serverless v2 scale-to-zero** (Aurora PostgreSQL 13.15+/14.12+/15.7+/16.3+): ideal para réplicas warm-standby de baja actividad que pausan automáticamente y despiertan en ~15s ante el primer request (útil para tiers 2-3 con RTO tolerante).

### 3.5 S3 Cross-Region Replication

S3 CRR replica objetos **PUT tras la configuración** (no retroactivamente; usar **S3 Batch Replication** para backfill). Async por diseño. Filters permiten replicar subset (prefix, tag).

```hcl
# terraform/s3-crr.tf
resource "aws_s3_bucket" "primary" {
  provider = aws.us_east_1
  bucket   = "linguadev-audio-us-east-1"
}

resource "aws_s3_bucket_versioning" "primary" {
  provider = aws.us_east_1
  bucket   = aws_s3_bucket.primary.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket" "replica" {
  provider = aws.eu_west_1
  bucket   = "linguadev-audio-eu-west-1"
}

resource "aws_s3_bucket_versioning" "replica" {
  provider = aws.eu_west_1
  bucket   = aws_s3_bucket.replica.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_iam_role" "replication" {
  name = "s3-crr-linguadev-audio"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_s3_bucket_replication_configuration" "audio_crr" {
  provider = aws.us_east_1
  role     = aws_iam_role.replication.arn
  bucket   = aws_s3_bucket.primary.id

  rule {
    id     = "replicate-all-with-rtc"
    status = "Enabled"
    filter {}

    destination {
      bucket        = aws_s3_bucket.replica.arn
      storage_class = "STANDARD_IA"

      replication_time {
        status = "Enabled"
        time { minutes = 15 }
      }

      metrics {
        status = "Enabled"
        event_threshold { minutes = 15 }
      }
    }

    delete_marker_replication { status = "Disabled" }  # protección contra deletion propagation
  }

  depends_on = [
    aws_s3_bucket_versioning.primary,
    aws_s3_bucket_versioning.replica,
  ]
}
```

**RTC (Replication Time Control)** ofrece SLA de replicación en <15 min (extra cost). **Delete Marker Replication OFF** es defensa: si un attacker borra objetos en source, destination sigue intacto.

### 3.6 AWS Backup con Vault Lock y air-gapped vaults

AWS Backup centraliza políticas de backup para RDS, EBS, DynamoDB, EFS, S3 y más. **Backup Vault Lock** aplica retención inmutable **WORM** (Write Once Read Many): ni el root account puede borrar backups en el lock period (Compliance mode) o solo un role autorizado (Governance mode).

En julio 2026 AWS extendió los **logically air-gapped vaults** a seis regiones adicionales, permitiendo backups inmutables incluso ante compromise total de la cuenta, con soporte para AWS RAM sharing (recovery cross-account seguro) y multi-party approval.

```hcl
# terraform/aws-backup.tf
resource "aws_backup_vault" "primary" {
  name        = "linguadev-backup-primary"
  kms_key_arn = aws_kms_key.backup.arn
}

resource "aws_backup_vault_lock_configuration" "primary" {
  backup_vault_name   = aws_backup_vault.primary.name
  changeable_for_days = 3
  max_retention_days  = 3650
  min_retention_days  = 30
}

# Logically air-gapped vault (2024 GA, expandido 2026)
resource "aws_backup_logically_air_gapped_vault" "airgap" {
  name               = "linguadev-airgap-vault"
  min_retention_days = 30
  max_retention_days = 3650
}

resource "aws_backup_plan" "linguadev" {
  name = "linguadev-daily-cross-region"

  rule {
    rule_name         = "daily-with-crr"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 3 * * ? *)"     # 03:00 UTC diario
    start_window      = 60
    completion_window = 300

    lifecycle {
      delete_after       = 90
      cold_storage_after = 30
    }

    copy_action {
      destination_vault_arn = aws_backup_vault.dr_replica.arn
      lifecycle {
        delete_after       = 365
        cold_storage_after = 60
      }
    }

    copy_action {
      destination_vault_arn = aws_backup_logically_air_gapped_vault.airgap.arn
      lifecycle {
        delete_after = 2555   # 7 años, air-gapped inmutable
      }
    }
  }

  advanced_backup_setting {
    backup_options = { WindowsVSS = "enabled" }
    resource_type  = "EC2"
  }
}

resource "aws_backup_selection" "critical_resources" {
  name         = "linguadev-tier1-resources"
  plan_id      = aws_backup_plan.linguadev.id
  iam_role_arn = aws_iam_role.backup.arn

  selection_tag {
    type  = "STRINGEQUALS"
    key   = "BackupTier"
    value = "1"
  }
}
```

---

## 4. Active-Active en profundidad (nivel avanzado)

### 4.1 Requerimientos técnicos

Active-Active multi-región es la joya de la corona, pero costosa y compleja. Requerimientos:

1. **DB multi-región**: DynamoDB Global Tables (LWW, multi-writer), Aurora Global (single-writer), CockroachDB, Google Spanner.
2. **Session storage compartido o sticky por región**: JWT stateless o Redis global (ElastiCache Global Datastore).
3. **DNS/LB routing**: Route 53 latency-based o Global Accelerator.
4. **Deploy pipelines regionales** coordinados (waves progresivos).
5. **Observability regional** (dashboards, alertas, on-call por región).
6. **Resolución de identidad global** (userId único, no per-región).
7. **Backward-compatible data schemas** (v2 en región A no rompe v1 en región B durante rollouts).

### 4.2 Estrategias de writes cross-region

Tres opciones para writes:

**a) Single-writer región**: todas las escrituras al primary; réplicas read-only.
- Pros: simple, consistency clara.
- Cons: writes cross-region con latencia alta (100-200 ms).
- Ejemplo: Aurora Global Database.

**b) Multi-writer con conflict resolution**: LWW, CRDTs, custom logic.
- Pros: writes locales (baja latencia).
- Cons: complejidad de reconciliación, posible pérdida de datos con LWW.
- Ejemplo: DynamoDB Global Tables.

**c) Partitioning geográfico**: usuarios EU escriben a EU, US a US, sin overlap.
- Pros: elegante, sin conflicts.
- Cons: rompe para usuarios cross-region (viajeros, colaboración cross-timezone).
- Ejemplo: apps con "data residency" estricta.

Para LinguaDev Pro usamos (b) DynamoDB Global Tables con protecciones:
- Timestamps del **servidor** (no del cliente) para reducir clock skew.
- Version numbers para auditoría.
- Merge policy en la app para casos críticos (progress no se debe perder aunque LWW gane).

### 4.3 Deploys multi-región coordinados

Deploy en 1 región deja el sistema inconsistente si la otra tiene código viejo. Pipeline maduro:

1. Deploy a canary de cada región (5%) → verificación.
2. Rollout 100% región 1 → observar 30-60 min.
3. Rollout 100% región 2 → observar.
4. Rollout 100% región N.

Feature flags cross-region para coordinar activación. Ejemplo con Spinnaker o ArgoCD.

```yaml
# .github/workflows/deploy-multi-region.yml
name: Deploy multi-region wave
on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Docker image tag'
        required: true

jobs:
  deploy-canary-us-east-1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy 5% canary us-east-1
        run: |
          aws eks update-kubeconfig --name linguadev-us-east-1
          kubectl argo rollouts set image linguadev-bff \
            bff=ghcr.io/linguadev/bff:${{ inputs.version }} \
            --namespace linguadev-prod
      - name: Wait for canary analysis
        run: |
          kubectl argo rollouts wait linguadev-bff \
            --for-condition=Healthy \
            --timeout=15m

  deploy-full-us-east-1:
    needs: deploy-canary-us-east-1
    runs-on: ubuntu-latest
    steps:
      - name: Promote us-east-1
        run: kubectl argo rollouts promote linguadev-bff
      - name: Observation window
        run: sleep 1800   # 30 min

  deploy-canary-eu-west-1:
    needs: deploy-full-us-east-1
    runs-on: ubuntu-latest
    steps:
      - name: Deploy 5% canary eu-west-1
        run: |
          aws eks update-kubeconfig --name linguadev-eu-west-1
          kubectl argo rollouts set image linguadev-bff \
            bff=ghcr.io/linguadev/bff:${{ inputs.version }} \
            --namespace linguadev-prod

  deploy-full-eu-west-1:
    needs: deploy-canary-eu-west-1
    runs-on: ubuntu-latest
    steps:
      - name: Promote eu-west-1
        run: kubectl argo rollouts promote linguadev-bff
```

### 4.4 Failback: la mitad olvidada

Failback (volver a primary tras recuperación) es a menudo **más complejo** que failover. Durante el downtime, secondary recibió writes que primary NO tiene. Failback naive (volver a primary) = perder esos writes.

Runbook de failback:

1. **Verificar que primary está sano** (health checks estables, DB recuperada).
2. **Iniciar reverse replication** (secondary → primary, si no está ya bidireccional).
3. **Esperar sync completo** (verificar lag = 0 en métricas de replicación).
4. **Data consistency check**: checksums, counts, sample queries.
5. **Planned write freeze** breve (30-60s) para cutover atómico.
6. **Switch routing** (Route 53 o Global Accelerator vuelve a primary).
7. **Verify traffic distribution** normal.
8. **Rollback plan** listo por si algo falla.

Para DynamoDB Global Tables, la replicación es bidireccional por diseño; el "failback" es solo cambio de routing. Para Aurora Global tras `failover-global-cluster`, hay que **reconstruir** el global cluster con la nueva topology, más complejo.

---

## 5. Selección de regiones y compliance

### 5.1 Criterios de selección

1. **Latencia a usuarios**: geo-cerca de la mayor base. Herramientas: [cloudping.co](https://cloudping.co) mide RTT a regiones AWS.
2. **Compliance / data sovereignty**: GDPR (EU), CCPA (California), LGPD (Brasil), data residency (China con AWS China separada, Suiza con Zurich).
3. **Feature availability**: no todos los servicios están en todas las regiones. AWS Region Table.
4. **Costo**: pricing varía por región (us-east-1 típ. más barato; Bahrain, Zurich típ. más caros).
5. **Distancia geográfica entre regiones DR**: emparejar us-east-1 + us-west-2, o eu-west-1 + eu-central-1.

### 5.2 Emparejamientos comunes

| Base primaria | DR complementaria | Justificación |
|---|---|---|
| us-east-1 | us-west-2 | Diferentes coasts, servicios completos, latencia moderada |
| us-east-1 | eu-west-1 | Cross-continent, muy alta separación de fallo |
| eu-west-1 | eu-central-1 | GDPR compliance intra-EU |
| ap-southeast-1 | ap-northeast-1 | Asia cross-country |
| us-east-1 | us-east-2 | Mismo país, misma coast, bajo latency inter-región (~15 ms) |

### 5.3 Governance con AWS Organizations

Enforcement de que todos los recursos Tier-1 estén en cierta lista de regiones:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyResourcesOutsideApprovedRegions",
      "Effect": "Deny",
      "NotAction": [
        "iam:*",
        "route53:*",
        "cloudfront:*",
        "waf:*",
        "wafv2:*",
        "support:*",
        "trustedadvisor:*",
        "globalaccelerator:*",
        "organizations:*"
      ],
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestedRegion": [
            "us-east-1",
            "us-west-2",
            "eu-west-1"
          ]
        }
      }
    }
  ]
}
```

---

## 6. DR testing regular: "untested DR is fiction"

### 6.1 Por qué es crítico

Un DR plan sin ejercitar es un ensayo, no una capacidad. Descubrimientos comunes en el primer game day de DR:

- Runbook menciona un endpoint que ya no existe.
- Credential de Terraform no la tiene el equipo actual.
- Failover tarda 3 horas y decían "30 min".
- Monitoring stack corría en primary — cegado durante failover.
- Automation asume dependency X que no está en la región DR.

Google (**DiRT**, Disaster Recovery Testing), Amazon (**Operational Readiness Reviews**), Netflix (**Chaos Kong**) todos ejecutan DR testing regular.

### 6.2 Formatos de DR drill

1. **Tabletop exercise**: discusión, no ejecutar. Bueno para runbook review.
2. **Partial failover**: failover de 1 servicio, no todo el stack.
3. **Full failover**: game day serio, toda la región.
4. **Automated chaos**: experiments regulares (mensuales).

Cadencia recomendada: monthly partial + quarterly full + annually full multi-región.

### 6.3 Script de DR drill automatizado

```python
#!/usr/bin/env python3
# scripts/dr_drill.py — orquestador de DR drill con timing y validaciones
import boto3
import time
import json
from datetime import datetime, timezone

session = boto3.Session()
route53 = session.client('route53')
cloudwatch_primary = session.client('cloudwatch', region_name='us-east-1')
cloudwatch_secondary = session.client('cloudwatch', region_name='eu-west-1')

DRILL_ID = f"dr-drill-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}"
HOSTED_ZONE = 'Z1234567890ABC'
API_RECORD = 'api.linguadev.app.'

def log(event: str, **kwargs):
    entry = {'drill_id': DRILL_ID, 'ts': datetime.now(timezone.utc).isoformat(), 'event': event, **kwargs}
    print(json.dumps(entry))

def measure_baseline():
    log('baseline_start')
    resp = cloudwatch_primary.get_metric_statistics(
        Namespace='linguadev/bff',
        MetricName='RequestCount',
        StartTime=datetime.now(timezone.utc).replace(minute=datetime.now().minute - 5),
        EndTime=datetime.now(timezone.utc),
        Period=60,
        Statistics=['Sum'],
    )
    rps_primary = sum(dp['Sum'] for dp in resp['Datapoints']) / 300 if resp['Datapoints'] else 0
    log('baseline_measured', rps_primary=rps_primary)
    return rps_primary

def trigger_failover():
    log('failover_triggered')
    # Simular: disable health check del primary
    route53.update_health_check(
        HealthCheckId='HC-PRIMARY-ID',
        Disabled=True,
    )
    log('primary_health_check_disabled')

def measure_convergence(timeout_sec: int = 600):
    log('convergence_measurement_start')
    start = time.time()
    while time.time() - start < timeout_sec:
        resp = cloudwatch_secondary.get_metric_statistics(
            Namespace='linguadev/bff',
            MetricName='RequestCount',
            StartTime=datetime.now(timezone.utc).replace(minute=datetime.now().minute - 2),
            EndTime=datetime.now(timezone.utc),
            Period=60,
            Statistics=['Sum'],
        )
        rps_secondary = sum(dp['Sum'] for dp in resp['Datapoints']) / 120 if resp['Datapoints'] else 0
        if rps_secondary > 10:  # threshold de considerar failover exitoso
            convergence_time = time.time() - start
            log('failover_converged', convergence_sec=convergence_time, rps_secondary=rps_secondary)
            return convergence_time
        time.sleep(15)
    log('failover_timeout', timeout_sec=timeout_sec)
    return None

def failback():
    log('failback_started')
    route53.update_health_check(
        HealthCheckId='HC-PRIMARY-ID',
        Disabled=False,
    )
    log('primary_health_check_reenabled')
    time.sleep(120)
    log('failback_complete')

def main():
    log('drill_start')
    baseline = measure_baseline()
    trigger_failover()
    convergence = measure_convergence()
    failback()
    log('drill_complete', baseline_rps=baseline, convergence_sec=convergence)
    print(f"\nDRILL SUMMARY {DRILL_ID}")
    print(f"  Baseline RPS: {baseline:.1f}")
    print(f"  Failover convergence: {convergence:.1f}s" if convergence else "  FAILOVER TIMEOUT")

if __name__ == '__main__':
    main()
```

---

## 7. Casos reales industria 2023-2026

**AWS us-east-1 outage diciembre 2021**: cascada por fallos en control plane afectó Netflix, Slack, Roku, Coinbase globally. Empresas active-active recuperaron en minutos; single-region tardaron horas. AWS publicó post-event summary. Muchas empresas invirtieron en multi-región tras el incidente.

**AWS us-east-1 outage diciembre 2024**: control plane Lambda outage causó impacto global durante ~4 horas. Adobe, Ring, Duolingo y Slack afectados. Empresas con Aurora Global + DynamoDB Global Tables + Route 53 failover recuperaron en < 15 min. Lección: multi-región es seguro de negocio.

**Facebook global outage octubre 2021**: BGP config error tumbó Facebook, Instagram, WhatsApp durante 6 horas. Ilustración de la importancia de progressive rollouts de config changes y de tener DNS/BGP con failover independiente.

**Netflix Chaos Kong 2024**: Netflix confirmó ejecutar Chaos Kong (kill de región AWS entera) trimestralmente en producción. Arquitectura active-active multi-región tolera sin impacto visible. Ingeniero cita: "si nuestra infra no tolera Chaos Kong, es deuda de resiliencia".

**Colonial Pipeline ransomware 2021**: $4.4M ransom pagado, semanas de disrupción. Aceleró la adopción de AWS Backup Vault Lock y logically air-gapped vaults en industrias reguladas (energy, finance, healthcare).

**AWS Backup logically air-gapped vault expansion julio 2026**: AWS extendió el servicio a 6 regiones adicionales, permitiendo backup vaults completamente aislados del account principal, con Multi-party approval y RAM sharing. Empresas con compliance HIPAA/PCI/SOC2 adoptando en masa.

**Aurora Serverless v2 scale-to-zero noviembre 2024**: AWS anunció la capacidad de escalar a 0 ACUs, con cold-start de ~15s al primer request. Ideal para réplicas warm-standby de baja actividad y para dev/staging environments cross-region con costo reducido.

**Rogers Communications outage julio 2022**: 12 horas de disrupción total en Canadá (móvil + internet + interac) por mala config de red. Sin DR plan efectivo para el escenario. Regulator canadiense forzó investment en multi-carrier failover.

**Cloudflare regional outage junio 2024**: 25 min de degradación por BGP config change. Postmortem público en 48h con action items sistémicos. Lección: cambios de config globales requieren progressive rollout tanto o más que cambios de código.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Definir RTO/RPO por tier y estrategia DR

**Objetivo:** producir un documento formal de tiering con RTO/RPO y estrategia DR asignada por servicio.

**Setup:**
- Inventario de servicios (LinguaDev Pro o el que uses).
- Sesión de 60 min con al menos 1 stakeholder de negocio.

**Pasos:**
1. Lista todos los servicios/componentes de tu stack.
2. Asigna tier (1-4) según impacto de downtime.
3. Consensúa RTO y RPO por tier con negocio.
4. Asigna estrategia (backup+restore / pilot light / warm standby / active-active) por tier.
5. Estima costo relativo (documenta 1x, 1.5x, 2x, 3x baseline).
6. Publica en confluence/wiki con firma del stakeholder.

**Criterios de éxito:**
- [ ] Todos los servicios tienen tier asignado.
- [ ] RTO y RPO cuantificados (no "lo antes posible").
- [ ] Estrategia DR documentada por tier.
- [ ] Sign-off de negocio explícito.

**Bonus:** anota el costo mensual estimado por estrategia y presenta al CFO para approval.

---

### Ejercicio 2: Configurar DynamoDB Global Tables

**Objetivo:** replicar una tabla DynamoDB a una segunda región y verificar el lag de replicación.

**Setup:**
- Cuenta AWS con acceso a 2 regiones.
- Terraform o AWS CLI.

**Pasos:**
1. Crear tabla `user_progress` con Streams habilitado en us-east-1.
2. Añadir réplica en eu-west-1 con Terraform (`replica` block).
3. Insertar 100 items en us-east-1.
4. Medir el lag hasta que aparezcan en eu-west-1 (usar `list-items` con timestamp).
5. Documentar el lag observado (típico: <2s).

**Criterios de éxito:**
- [ ] Tabla global operativa en 2+ regiones.
- [ ] PITR habilitado.
- [ ] Encryption at rest con KMS.
- [ ] Lag medido y documentado.

**Bonus:** insertar simultáneamente en ambas regiones el mismo item y observar el LWW conflict resolution.

---

### Ejercicio 3: Route 53 failover con health checks

**Objetivo:** configurar failover DNS con health checks y verificar en un DR drill.

**Setup:**
- Dominio en Route 53.
- 2 endpoints (regions primary + secondary).

**Pasos:**
1. Crear health checks para ambos endpoints (HTTPS, path `/health`).
2. Crear records A tipo `PRIMARY` y `SECONDARY` con TTL 60s.
3. Verificar routing normal (primary responde).
4. Simular falla: deshabilitar el health check del primary o parar el servicio.
5. Cronómetro: medir tiempo hasta que el DNS resuelve secondary.
6. Restaurar primary y medir failback.

**Criterios de éxito:**
- [ ] Failover automático dispara en <2 min.
- [ ] `dig` desde diferentes resolvers confirma la nueva IP.
- [ ] Failback también funciona.
- [ ] Runbook actualizado con los pasos observados.

**Bonus:** repite con AWS Global Accelerator y compara los tiempos de convergencia.

---

### Ejercicio 4: DR drill completo con Aurora Global Database

**Objetivo:** ejecutar un failover Aurora Global y medir RTO/RPO reales.

**Setup:**
- Aurora Global cluster con primary y secondary (ver §3.4).
- Script de generación de carga (SQL inserts).

**Pasos:**
1. Iniciar carga (100 inserts/s) sobre primary.
2. Ejecutar `aws rds failover-global-cluster` para promover secondary.
3. Cronómetro: medir el tiempo desde el comando hasta que secondary es writable.
4. Contar los inserts que se perdieron (comparar count antes/después).
5. Documentar RTO (tiempo de failover) y RPO (inserts perdidos × tiempo entre inserts).
6. Publicar en runbook con evidencia.

**Criterios de éxito:**
- [ ] Failover ejecutado sin data corruption.
- [ ] RTO medido (típ. 1-2 min).
- [ ] RPO medido (típ. <1s de datos).
- [ ] Postmortem con hallazgos.

**Bonus:** ejecutar el failback y documentar la complejidad adicional.

---

### Ejercicio 5 (bonus): AWS Backup con Vault Lock inmutable

**Objetivo:** configurar backup con inmutabilidad WORM y validar restauración cross-region.

**Setup:**
- AWS Backup habilitado.
- Al menos un recurso taggeado (`BackupTier=1`).

**Pasos:**
1. Crear vault en us-east-1 con Vault Lock (Compliance mode, min retention 30d).
2. Crear vault en eu-west-1 como destination de copy_action.
3. Crear backup plan diario con copy cross-region.
4. Ejecutar backup manual (`start-backup-job`).
5. Intentar borrar el recovery point (debería fallar por Vault Lock).
6. Restaurar el recurso en eu-west-1 desde el copy.

**Criterios de éxito:**
- [ ] Vault Lock aplicado en Compliance mode.
- [ ] Copy cross-region funciona.
- [ ] Intento de deletion fallido con error claro.
- [ ] Restore exitoso desde eu-west-1.

**Bonus:** configurar logically air-gapped vault en las nuevas regiones (feature GA julio 2026) y compartir el recovery point con otra cuenta via AWS RAM.

---

## 9. Recursos + siguientes pasos

**AWS whitepapers y documentación:**
- [AWS Well-Architected — Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html).
- [AWS — Disaster Recovery of Workloads on AWS (whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html).
- **AWS re:Invent ARC317 — DR Strategies** (video sessions anuales).
- [AWS Multi-Region application architecture](https://aws.amazon.com/architecture/global-solutions/).

**Servicios AWS clave:**
- **Route 53** — DNS con health checks y routing policies.
- **Global Accelerator** — IPs anycast con failover en backbone AWS.
- **DynamoDB Global Tables** — multi-region managed NoSQL.
- **Aurora Global Database** — cross-region con RPO < 1s.
- **S3 Cross-Region Replication** con RTC.
- **AWS Backup** con Vault Lock y logically air-gapped vaults (expandidos julio 2026).
- **AWS Elastic Disaster Recovery** (managed continuous replication).

**Terraform / IaC:**
- Terraform AWS provider — módulos oficiales para multi-region.
- **Terragrunt** para gestionar DRY entre regiones.
- **AWS CloudFormation StackSets** para deploy multi-account/region.

**Databases distribuidas:**
- **CockroachDB** — SQL distribuido, active-active con serializable.
- **Google Spanner** — CP con TrueTime + Paxos.
- **YugabyteDB** — SQL distribuido open source.
- **MongoDB Atlas Global Clusters** — sharding geográfico.

**Comunidades y referencias:**
- **Google SRE Book** cap. 17 (Testing for Reliability) y 22 (Cascading Failures).
- **Designing Data-Intensive Applications** (Kleppmann) — CAP, replicación, consenso.
- **AWS Community Builders** — talks sobre DR en producción.

**Siguientes pasos:**
- Ejecutar los 5 ejercicios sobre LinguaDev Pro.
- Instituir DR drill trimestral con calendario fijo.
- Publicar runbook de failover y failback en el repo.
- Continuar con [Cap 15 — optimización de costos](./15-optimizacion-de-costos.md) para hacer la arquitectura multi-región sostenible económicamente.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre `resilience` y `scalability`, dificultades mid → staff. Cubren: RTO vs RPO como decisión de negocio, las 4 estrategias DR clásicas (backup+restore, pilot light, warm standby, active-active), active-active vs active-passive con consistency implications, Route 53 health checks y failover con TTL, Global Accelerator vs Route 53, replicación async y CAP theorem, DynamoDB Global Tables con LWW y RRWs, backup strategies (snapshots vs PITR, AWS Backup, cross-region copy), disaster testing regular (Google DiRT, Chaos Kong), region selection y compliance (GDPR, LGPD, sovereignty), multi-AZ vs multi-region, failback complexity (reverse replication, data reconciliation), Backup Vault Lock contra ransomware, S3 Cross-Region Replication con RTC, latency-based routing, deploys multi-región coordinados, y session state cross-region con JWT o Redis Global.

- **Fuente:** [`packages/content/src/tech/architecture/sim-14-multi-region-and-dr.json`](../../packages/content/src/tech/architecture/sim-14-multi-region-and-dr.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-14-multi-region-and-dr`
- **Tiempo:** 25 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 13 — Chaos engineering y testing en producción](./13-chaos-y-testing-en-produccion.md) · [Índice](./README.md) · [Capítulo 15 — Optimización de costos →](./15-optimizacion-de-costos.md)
