# Capítulo 37 — Disaster Recovery y estrategias de backup

> **Focus:** Disaster Recovery real: RTO/RPO como decisiones de negocio, patrones DR (backup&restore, pilot light, warm standby, hot standby active-active), regla 3-2-1(-1-0), backups immutables (AWS Backup Vault Lock en modos governance/compliance), cross-region replication, cifrado at-rest y in-transit, testing periódico de restore, IaC (Terraform/CDK) para reconstruir infraestructura, dependency mapping.
> **Áreas:** Reliability · Business continuity · Ransomware defense
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos cloud AWS/GCP/Azure (ver [cap 14 — cloud fundamentals](./14-cloud-fundamentals-y-multi-cloud.md)).
- Kubernetes storage: PV, PVC, StorageClass, VolumeSnapshot (ver [cap 09 — kubernetes networking y storage](./09-kubernetes-networking-y-storage.md)).
- IaC básico: Terraform, CDK (ver [cap 12 — infrastructure as code Terraform](./12-fundamentos-terraform.md) si existe, o pipelines de deploy).
- Postgres/MySQL básico: WAL, binlog, pg_dump, snapshots.
- Cifrado simétrico/asimétrico, KMS, envelope encryption.
- Conceptos de red: DNS TTL, VPC peering, route tables cross-region.

**Glosario mínimo:**
- **RTO** (Recovery Time Objective): tiempo máximo aceptable entre el desastre y el servicio restaurado. Es cuánto puedes estar caído.
- **RPO** (Recovery Point Objective): cantidad máxima de datos que puedes perder, medida en tiempo. Es cuánto retrocedes.
- **MTTR** (Mean Time To Recover): promedio real que se tarda en recuperar; el RTO es un objetivo, el MTTR es una medida.
- **DR** (Disaster Recovery): plan y arquitectura para recuperarse de un desastre (región AWS caída, ransomware, borrado accidental total).
- **BCP** (Business Continuity Plan): plan más amplio que incluye personas, comunicación, proveedores; DR es el subset técnico.
- **3-2-1**: regla clásica de backup: 3 copias, 2 medios distintos, 1 offsite.
- **3-2-1-1-0**: extensión moderna (Veeam): + 1 copia immutable + 0 errores en el último test de restore.
- **PITR** (Point-In-Time Recovery): restaurar la base de datos a un segundo específico usando WAL/binlog continuos.
- **WORM** (Write Once Read Many): storage que no se puede sobrescribir ni borrar hasta que expire la retención.
- **Air-gap**: separación física o lógica total; un backup air-gapped no está online y no puede ser cifrado por ransomware.
- **AWS Backup Vault Lock**: feature (GA agosto 2020, mejorada 2024-2026) que hace immutables las copias en un vault, con dos modos: `governance` (bypass con IAM permission) y `compliance` (nadie, ni root, puede borrar).
- **Pilot Light / Warm Standby / Hot Standby**: patrones DR con creciente coste y menor RTO.
- **KMS** (Key Management Service): servicio de gestión de claves de cifrado (AWS KMS, GCP KMS, Azure Key Vault).

**Setup mínimo:**

```bash
# 1. AWS CLI 2.17+ (agosto 2026)
aws --version
# aws-cli/2.17.x Python/3.12.x

# 2. Verificar que tienes acceso a AWS Backup, S3, RDS, KMS
aws sts get-caller-identity
aws backup list-backup-vaults
aws s3 ls
aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier'

# 3. Terraform 1.9+ para provisionar DR infra
terraform version
# Terraform v1.9.x

# 4. Region primaria + secundaria
export PRIMARY_REGION=us-east-1
export DR_REGION=us-west-2

# 5. jq para manejar JSON
jq --version
```

---

## 1. El gran cuadro

**Disaster Recovery** no es una feature técnica; es una respuesta a una pregunta de negocio: **cuánto puede permitirse la organización estar caída y cuánto puede permitirse perder de datos**. Esa respuesta se codifica en dos números —**RTO** (tiempo máximo de downtime aceptable) y **RPO** (cantidad máxima de datos perdibles, medida en tiempo)— que dictan el resto: qué arquitectura, qué región, qué tipo de replicación, qué presupuesto. Un banco con **RPO=0** exige replicación síncrona multi-región con quórum de commit; un blog personal tolera **RPO=24h** con un `pg_dump` nocturno a S3. Confundir ambos casos lleva a sobre-ingeniería costosa o sub-ingeniería catastrófica. Y lo peor: en 2026 la mayoría de equipos operan **sin números explícitos** —tienen backups, pero no saben cuánto tardan en restaurar ni cuántos datos pierden en el peor caso realista. Eso, técnicamente, no es un plan DR: es una plegaria.

El eje **backup** implementa la promesa del RPO. La disciplina no ha cambiado tanto: la **regla 3-2-1** (3 copias, 2 medios, 1 offsite), formulada por Peter Krogh en fotografía y adoptada por US-CERT, sigue siendo el mínimo. Pero la evolución **3-2-1-1-0** añade dos requisitos críticos para la era ransomware: **una copia immutable** (WORM u Object Lock) y **cero errores en el último test de restore**. La lección más cara de la industria —repetida por GitLab (2017), Colonial Pipeline (2021) y decenas de outages menos publicitados— es que **un backup no verificado no es un backup, es una esperanza**. Los backups fallan silenciosamente: cronjobs que corrompen sin fallar, storage que se llenó hace 6 meses, keys de cifrado rotadas y perdidas, versiones incompatibles entre DB origen y destino. El único método fiable de detectar estos fallos es **restaurar periódicamente**, idealmente automatizado.

El eje **DR arquitectural** implementa la promesa del RTO. Los cuatro patrones canónicos de AWS Well-Architected escalan en coste y RTO inverso: (1) **backup & restore** (RTO horas-días, RPO horas, coste mínimo) — solo restauras cuando pasa algo; (2) **pilot light** (RTO horas, RPO minutos, coste bajo) — la infra crítica está encendida en la región DR (base de datos replicada), el resto se levanta on-demand; (3) **warm standby** (RTO minutos, RPO segundos, coste medio) — hay una versión reducida corriendo en la región DR, se escala al fallar; (4) **hot standby / multi-region active-active** (RTO segundos, RPO cercano a 0, coste alto) — tráfico servido desde múltiples regiones simultáneamente con failover automático. La elección depende del **coste del downtime por hora** vs el **coste de mantener la infra DR corriendo**: si tu downtime cuesta $100k/h, cualquier cosa menos hot standby es imprudente; si cuesta $500/h, backup & restore es suficiente.

En 2026 el contexto cambió por tres fuerzas: **ransomware profesionalizado** (Colonial Pipeline, LockBit, y grupos que atacan específicamente los backups antes que la producción), **immutabilidad accesible** (AWS Backup Vault Lock GA desde agosto 2020, con mejoras continuas en 2024-2026; S3 Object Lock; Azure Immutable Storage) y **cross-region como default** (S3 Cross-Region Replication, Aurora Global Database RPO <1s, DynamoDB Global Tables). La consecuencia práctica: **hoy no hay excusa técnica ni económica** para no tener al menos backups immutables cross-region con test automatizado mensual. Este capítulo cubre RTO/RPO como contrato con el negocio, los patrones DR con código real, la implementación en AWS (Backup Vault Lock, cross-region, KMS), Kubernetes (VolumeSnapshot, Velero) e IaC (Terraform), y termina con ejercicios verificables sobre el proyecto **LinguaDev Pro**.

---

## 2. RTO, RPO y la regla 3-2-1 (nivel básico)

### 2.1 RTO y RPO como contrato con el negocio

RTO y RPO son ejes **ortogonales**. No son sinónimos y no se derivan uno del otro:

| Métrica | Pregunta | Ejemplo bajo | Ejemplo alto |
|---|---|---|---|
| **RTO** | "¿Cuánto tiempo puedo estar caído?" | 15 min (fintech) | 24 h (blog) |
| **RPO** | "¿Cuántos datos puedo perder?" | 0 seg (banco) | 24 h (analytics batch) |

Un banco típico exige `RTO=4h, RPO=0`: no puede perder ninguna transacción (RPO=0 → replicación síncrona) pero acepta 4h de downtime porque restaurar sistemas core-banking es complejo. Un sitio de e-commerce puede tener `RTO=15min, RPO=5min`: cada minuto caído cuesta ventas, pero perder 5min de reviews o carritos es tolerable.

**Regla operativa:** el negocio dice los números, ingeniería los cumple. Si el CTO define los RTO/RPO sin hablar con el CFO, se produce sobre-ingeniería (multi-region activo cuando bastaba pilot light) o sub-ingeniería (backup diario para un servicio con RPO real de 5min).

Ejercicio de tablero: por cada servicio crítico, escribir en una wiki:

```markdown
Servicio: linguadev-api
Business owner: product@linguadev.app
RTO objetivo: 30 min
RPO objetivo: 5 min
Coste de 1h downtime estimado: $2000
Coste de infra DR actual: $180/mes
Última prueba de restore: 2026-07-15 (PASSED, MTTR 22 min)
```

Si no puedes rellenar cada campo, **no tienes plan DR**, tienes un espejismo.

### 2.2 La regla 3-2-1 (y su extensión moderna)

Peter Krogh formuló la regla original en 2009: **3 copias** de los datos, en **2 medios diferentes**, con **1 offsite**. La lógica: cualquier fallo único (disco, humano, ransomware, incendio) no debe eliminar todas las copias.

Extensión **3-2-1-1-0** (Veeam, ampliamente adoptada en 2024-2026):

- **3** copias (producción + 2 backups).
- **2** medios diferentes (evita fallo de tecnología: S3 + Glacier + EBS snapshot).
- **1** offsite (otra región o proveedor).
- **1** immutable (WORM, Object Lock, Vault Lock).
- **0** errores en el último test de restore.

Anti-patrones comunes en 2026:

- ❌ Backup en el mismo bucket S3 que la aplicación. Ransomware con acceso al bucket cifra ambos.
- ❌ Snapshot RDS en la misma cuenta y misma región. Si el atacante compromete la cuenta AWS, los borra todos.
- ❌ Backup diario, nunca probado. Ver GitLab 2017.
- ❌ Backup a un NAS on-prem que está permanentemente montado. No es air-gapped.

### 2.3 Configurando 3-2-1 con AWS: ejemplo con RDS y S3

```bash
# 1. Habilitar automated backups en RDS (PITR incluido, retención 35 días máx)
aws rds modify-db-instance \
  --db-instance-identifier linguadev-prod \
  --backup-retention-period 35 \
  --preferred-backup-window "03:00-04:00" \
  --apply-immediately

# 2. Cross-region snapshot copy (segundo medio + offsite en una sola operación)
aws rds create-db-snapshot \
  --db-instance-identifier linguadev-prod \
  --db-snapshot-identifier linguadev-prod-manual-20260813 \
  --region us-east-1

aws rds copy-db-snapshot \
  --source-db-snapshot-identifier arn:aws:rds:us-east-1:123456789012:snapshot:linguadev-prod-manual-20260813 \
  --target-db-snapshot-identifier linguadev-prod-copy-20260813 \
  --kms-key-id alias/dr-key-us-west-2 \
  --region us-west-2

# 3. Backup lógico (segundo formato, protege contra fallos de RDS snapshot)
aws rds create-db-snapshot ...  # binario
# vs
pg_dump -h linguadev-prod.xyz.rds.amazonaws.com \
  -U backup_user \
  -F c -Z 9 \
  linguadev > /tmp/dump-20260813.pgcustom
aws s3 cp /tmp/dump-20260813.pgcustom s3://linguadev-dr-us-west-2/pg/ \
  --sse aws:kms --sse-kms-key-id alias/dr-key
```

Cuentas: 3 copias (RDS activa + snapshot cross-region + pg_dump en S3 otra región), 2 medios (RDS binario + pg_dump lógico), 1 offsite (us-west-2). Falta la copia immutable y el test — se cubren en las secciones 3 y 5.

### 2.4 Testing de restore: el paso que todos omiten

**Regla dura:** si no probaste el restore en los últimos 90 días, **asume que está roto**.

Script mínimo de "smoke test" mensual de un snapshot RDS:

```bash
#!/usr/bin/env bash
# restore-drill.sh — restaura el snapshot más reciente a una instancia efímera
# y verifica row counts básicos.
set -euo pipefail

SNAPSHOT=$(aws rds describe-db-snapshots \
  --db-instance-identifier linguadev-prod \
  --snapshot-type automated \
  --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[0].DBSnapshotIdentifier' \
  --output text)

TEST_ID="drill-$(date +%Y%m%d-%H%M)"

echo "Restoring $SNAPSHOT to $TEST_ID..."
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "$TEST_ID" \
  --db-snapshot-identifier "$SNAPSHOT" \
  --db-instance-class db.t3.medium \
  --no-multi-az \
  --no-publicly-accessible

aws rds wait db-instance-available --db-instance-identifier "$TEST_ID"

ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "$TEST_ID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)

# Verificación funcional
PGPASSWORD="$RESTORE_PASSWORD" psql -h "$ENDPOINT" -U app -d linguadev <<'SQL'
SELECT COUNT(*) AS users FROM users;
SELECT COUNT(*) AS lessons FROM lessons;
SELECT MAX(created_at) AS latest FROM activity_log;
SQL

# Cleanup
aws rds delete-db-instance \
  --db-instance-identifier "$TEST_ID" \
  --skip-final-snapshot \
  --delete-automated-backups

echo "Drill PASSED: $TEST_ID"
```

Ejecutar como CronJob mensual, publicar el resultado en un dashboard, y **si falla, generar un incident P1** —no un ticket que se archiva.

---

## 3. Backups immutables: AWS Backup Vault Lock y S3 Object Lock (nivel medio)

### 3.1 Por qué immutable importa: ransomware profesional

En 2020-2026 el panorama de amenazas cambió: los grupos de ransomware ya no cifran solo la producción; **atacan primero los backups**. Si el atacante compromete credenciales con permiso de borrado sobre el vault de backups, cifra o elimina las copias, y luego cifra producción, no queda escapatoria más que pagar. Colonial Pipeline (mayo 2021) pagó $4.4M porque sus backups conectados a la red también fueron comprometidos.

La respuesta técnica: **immutabilidad**. Un backup immutable no puede ser sobrescrito ni borrado hasta que expire su retención, ni siquiera por el root de la cuenta. En AWS: **S3 Object Lock** (2018) para objetos y **AWS Backup Vault Lock** (GA agosto 2020, mejorada 2024-2026) para vaults de AWS Backup.

### 3.2 AWS Backup Vault Lock: governance vs compliance

Vault Lock tiene **dos modos**:

| Modo | Bypass | Uso |
|---|---|---|
| `governance` | Sí, con IAM permission `backup:DisableVaultLock` en cuenta con MFA | Protección contra error humano, compatible con cleanup planeado |
| `compliance` | **No**. Ni root, ni support AWS. Immutable hasta que expire | SEC 17a-4, HIPAA, SOC2, protección total ransomware |

**Compliance mode es una decisión de una sola vía**: una vez que expira el `changeable_for_days` (mínimo 3, máximo 30), no hay reversa. Si configuras retención 7 años en compliance, pagarás storage 7 años, hagas lo que hagas.

Setup con AWS CLI:

```bash
# 1. Crear el vault
aws backup create-backup-vault \
  --backup-vault-name linguadev-immutable \
  --encryption-key-arn arn:aws:kms:us-east-1:123456789012:key/abc-def \
  --backup-vault-tags Environment=prod,Purpose=ransomware-defense

# 2. Configurar la lock policy (compliance mode)
aws backup put-backup-vault-lock-configuration \
  --backup-vault-name linguadev-immutable \
  --min-retention-days 30 \
  --max-retention-days 2555 \
  --changeable-for-days 3

# Verifica ANTES de que expire el cooldown
aws backup describe-backup-vault \
  --backup-vault-name linguadev-immutable \
  --query 'LockDate'
# Si LockDate está en el pasado → compliance mode ACTIVO e inmutable
```

Una vez en compliance mode:

- ✅ No se puede borrar el vault mientras haya recovery points.
- ✅ No se pueden borrar recovery points antes de `MinRetentionDays`.
- ✅ La retención por recovery point no puede reducirse.
- ❌ **No** puedes cambiar de compliance a governance.
- ❌ **No** puedes bajar `MinRetentionDays` una vez activo.

**Governance mode** (misma API, sin `--changeable-for-days` corto) permite escape con un IAM role específico:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "BackupVaultBypass",
    "Effect": "Allow",
    "Action": "backup:DisableBackupVaultLock",
    "Resource": "arn:aws:backup:us-east-1:123456789012:backup-vault:linguadev-immutable",
    "Condition": {
      "Bool": { "aws:MultiFactorAuthPresent": "true" }
    }
  }]
}
```

### 3.3 Backup plan con cross-region y KMS: JSON completo

```json
{
  "BackupPlan": {
    "BackupPlanName": "linguadev-prod-plan",
    "Rules": [
      {
        "RuleName": "daily-35d",
        "TargetBackupVaultName": "linguadev-immutable",
        "ScheduleExpression": "cron(0 5 ? * * *)",
        "StartWindowMinutes": 60,
        "CompletionWindowMinutes": 180,
        "Lifecycle": {
          "MoveToColdStorageAfterDays": 30,
          "DeleteAfterDays": 2555
        },
        "CopyActions": [
          {
            "DestinationBackupVaultArn": "arn:aws:backup:us-west-2:123456789012:backup-vault:linguadev-immutable-dr",
            "Lifecycle": {
              "MoveToColdStorageAfterDays": 30,
              "DeleteAfterDays": 2555
            }
          }
        ],
        "EnableContinuousBackup": true
      }
    ]
  }
}
```

Guardar como `plan.json` y aplicar:

```bash
aws backup create-backup-plan --backup-plan file://plan.json

# Asignar recursos por tag (mejor que por ARN — escala automáticamente)
aws backup create-backup-selection \
  --backup-plan-id <plan-id> \
  --backup-selection '{
    "SelectionName": "prod-tagged",
    "IamRoleArn": "arn:aws:iam::123456789012:role/AWSBackupDefaultServiceRole",
    "ListOfTags": [
      {"ConditionType": "STRINGEQUALS", "ConditionKey": "backup", "ConditionValue": "daily"}
    ]
  }'
```

`EnableContinuousBackup: true` habilita **PITR** para servicios compatibles (Aurora, RDS, S3), reduciendo el RPO a segundos.

### 3.4 S3 Object Lock para objetos crudos

Para pipelines que escriben archivos directos (logs, exports, snapshots externos):

```bash
# 1. Crear bucket con Object Lock (SOLO en creación, no se puede activar después)
aws s3api create-bucket \
  --bucket linguadev-immutable-logs \
  --region us-east-1 \
  --object-lock-enabled-for-bucket

# 2. Configurar retention default (compliance mode)
aws s3api put-object-lock-configuration \
  --bucket linguadev-immutable-logs \
  --object-lock-configuration '{
    "ObjectLockEnabled": "Enabled",
    "Rule": {
      "DefaultRetention": {
        "Mode": "COMPLIANCE",
        "Days": 2555
      }
    }
  }'

# 3. Bloquear versionado (obligatorio con Object Lock)
aws s3api put-bucket-versioning \
  --bucket linguadev-immutable-logs \
  --versioning-configuration Status=Enabled

# 4. Upload con retention override si necesitas plazo distinto
aws s3api put-object \
  --bucket linguadev-immutable-logs \
  --key exports/2026/08/13/daily.tar.zst \
  --body daily.tar.zst \
  --object-lock-mode COMPLIANCE \
  --object-lock-retain-until-date 2033-08-13T00:00:00Z \
  --sse aws:kms --ssekms-key-id alias/dr-key
```

Combinado con **replication cross-region** y **cross-account** (para prevenir compromiso de una sola cuenta):

```json
{
  "Role": "arn:aws:iam::123456789012:role/s3-replication",
  "Rules": [{
    "Priority": 1,
    "Status": "Enabled",
    "Filter": { "Prefix": "" },
    "Destination": {
      "Bucket": "arn:aws:s3:::linguadev-immutable-logs-dr",
      "Account": "999888777666",
      "AccessControlTranslation": { "Owner": "Destination" },
      "EncryptionConfiguration": {
        "ReplicaKmsKeyID": "arn:aws:kms:us-west-2:999888777666:key/xyz"
      }
    },
    "SourceSelectionCriteria": {
      "SseKmsEncryptedObjects": { "Status": "Enabled" }
    },
    "DeleteMarkerReplication": { "Status": "Disabled" }
  }]
}
```

Cuenta 999... es la **cuenta de backup** aislada, sin acceso desde credenciales de producción. Un compromiso de la cuenta principal no toca esta copia.

### 3.5 Cifrado end-to-end y gestión de claves

**Regla:** cifrado at-rest (KMS/CMK, no keys default) + cifrado in-transit (TLS 1.2+). Las claves nunca deben vivir solo en la cuenta de producción; usa **KMS multi-region keys** (2021+) o keys separadas por región con acceso cross-account controlado.

```bash
# Crear multi-region key
aws kms create-key \
  --description "linguadev DR primary" \
  --multi-region \
  --region us-east-1

# Replicar la key a us-west-2 (misma key ID en ambas regiones)
aws kms replicate-key \
  --key-id mrk-abc123 \
  --replica-region us-west-2
```

**Antipatrones:**

- ❌ Guardar la única copia de la KMS key policy sin backup. Si el `Deny` policy bloquea a todos, ni root puede recuperarla (hay procesos AWS de recovery, pero tardan días).
- ❌ Cifrar backups con una key que solo existe en la región primaria. Si la región cae, no puedes descifrar en DR.
- ❌ No rotar keys. AWS KMS rota automáticamente CMKs anualmente si activas `EnableKeyRotation`.

---

## 4. Patrones DR: backup&restore, pilot light, warm standby, active-active (nivel avanzado)

### 4.1 Los cuatro patrones canónicos

| Patrón | RTO | RPO | Coste relativo | Cuándo |
|---|---|---|---|---|
| Backup & Restore | Horas–días | Horas | 1x | Blogs, dev/staging, ROI bajo |
| Pilot Light | Minutos–horas | Segundos–minutos | 2–3x | SaaS mediano, ROI medio |
| Warm Standby | Minutos | Segundos | 4–6x | Producción crítica media |
| Hot Standby (active-active) | Segundos | 0 (o cerca) | 6–10x+ | Banca, healthcare, e-commerce top |

### 4.2 Pilot Light con Terraform

**Idea:** el "core" (base de datos replicada) está siempre encendido en la región DR; el resto (app servers, workers) está apagado y se levanta on-demand.

```hcl
# terraform/dr/main.tf
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}

provider "aws" {
  region = "us-east-1"
  alias  = "primary"
}

provider "aws" {
  region = "us-west-2"
  alias  = "dr"
}

# Aurora Global Database: primary en us-east-1, secondary en us-west-2
resource "aws_rds_global_cluster" "linguadev" {
  provider                  = aws.primary
  global_cluster_identifier = "linguadev-global"
  engine                    = "aurora-postgresql"
  engine_version            = "16.4"
  database_name             = "linguadev"
  storage_encrypted         = true
}

resource "aws_rds_cluster" "primary" {
  provider                  = aws.primary
  cluster_identifier        = "linguadev-primary"
  engine                    = "aurora-postgresql"
  engine_version            = "16.4"
  global_cluster_identifier = aws_rds_global_cluster.linguadev.id
  master_username           = "app"
  master_password           = var.db_password
  kms_key_id                = aws_kms_key.multi_region.arn
  backup_retention_period   = 35
  storage_encrypted         = true
}

resource "aws_rds_cluster_instance" "primary" {
  provider           = aws.primary
  count              = 2
  identifier         = "linguadev-primary-${count.index}"
  cluster_identifier = aws_rds_cluster.primary.id
  instance_class     = "db.r7g.large"
  engine             = aws_rds_cluster.primary.engine
  engine_version     = aws_rds_cluster.primary.engine_version
}

# DR cluster: SIN instancias hasta que sea necesario (pilot light real)
resource "aws_rds_cluster" "dr" {
  provider                  = aws.dr
  cluster_identifier        = "linguadev-dr"
  engine                    = "aurora-postgresql"
  engine_version            = "16.4"
  global_cluster_identifier = aws_rds_global_cluster.linguadev.id
  kms_key_id                = aws_kms_key.multi_region_replica.arn
  skip_final_snapshot       = true

  lifecycle {
    ignore_changes = [replication_source_identifier]
  }
}

# Failover procedure: convertir dr → primary + crear instancias
# Se ejecuta manualmente o vía Lambda de failover
```

**Failover con Aurora Global Database** (RPO típico <1s):

```bash
# 1. Remover el cluster DR del global cluster (promoción)
aws rds remove-from-global-cluster \
  --global-cluster-identifier linguadev-global \
  --db-cluster-identifier arn:aws:rds:us-west-2:123456789012:cluster:linguadev-dr \
  --region us-west-2

# 2. Crear instancias (esto tarda 3-5 min)
aws rds create-db-cluster-endpoint \
  --db-cluster-identifier linguadev-dr \
  --db-cluster-endpoint-identifier linguadev-writer \
  --endpoint-type WRITER \
  --region us-west-2

# 3. Actualizar Route53 con weighted routing para failover
aws route53 change-resource-record-sets \
  --hosted-zone-id Z123... \
  --change-batch file://failover.json
```

RTO típico end-to-end: **5-10 min** (mayoritariamente esperando a que las instancias RDS estén ready).

### 4.3 Warm Standby con Route53 health checks

**Idea:** en DR hay una versión reducida (1-2 pods vs 10 en primary) que puede escalar rápido. Route53 hace health check y flippa DNS.

```hcl
resource "aws_route53_health_check" "primary" {
  fqdn              = "api-primary.linguadev.app"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = 3
  request_interval  = 30
  regions           = ["us-east-1", "us-west-2", "eu-west-1"]
}

resource "aws_route53_record" "api_primary" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "api.linguadev.app"
  type    = "A"
  set_identifier = "primary"

  failover_routing_policy {
    type = "PRIMARY"
  }

  alias {
    name                   = aws_lb.primary.dns_name
    zone_id                = aws_lb.primary.zone_id
    evaluate_target_health = true
  }

  health_check_id = aws_route53_health_check.primary.id
}

resource "aws_route53_record" "api_dr" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "api.linguadev.app"
  type    = "A"
  set_identifier = "dr"

  failover_routing_policy {
    type = "SECONDARY"
  }

  alias {
    name                   = aws_lb.dr.dns_name
    zone_id                = aws_lb.dr.zone_id
    evaluate_target_health = true
  }
}
```

**Trampas:**

- El **DNS TTL** es crítico. Un TTL de 300s significa que los clientes tardan hasta 5 min en ver el nuevo IP tras el failover. Reducir a 60s en prod si RTO exige.
- **Connection pooling** en clientes: pools que cachean conexiones no renegocian DNS. Requiere config de TTL en driver o restart forzado.
- **Warm** significa que la app está corriendo pero con recursos reducidos. Al fallar, el HPA/Karpenter debe escalar rápido; probar el escalado bajo carga real es parte del game day.

### 4.4 Hot Standby / Active-Active: cuando RPO=0 y RTO=segundos

Requiere:

- **Replicación síncrona** o **conflict-free replication** (CRDTs, DynamoDB Global Tables, Aurora Global Database con write forwarding en 2024+).
- **Stateless application** (o session storage compartido: Redis Global Datastore, DynamoDB).
- **DNS o Anycast** para enrutar tráfico a la región más cercana (Route53 latency-based, CloudFront, Global Accelerator).
- **Bidirectional writes** manejados: DynamoDB Global Tables (last-writer-wins), Aurora Global (single-writer con write forwarding), Spanner (external consistency).

Ejemplo DynamoDB Global Tables (RPO típico segundos, propagación cross-region <1s):

```bash
aws dynamodb create-table \
  --table-name linguadev-sessions \
  --attribute-definitions AttributeName=session_id,AttributeType=S \
  --key-schema AttributeName=session_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
  --region us-east-1

aws dynamodb update-table \
  --table-name linguadev-sessions \
  --replica-updates 'Create={RegionName=us-west-2}' 'Create={RegionName=eu-west-1}' \
  --region us-east-1
```

**Advertencia:** hot standby multiplica coste (2-3x storage, 2-3x compute) y complica escritura. No lo uses por defecto; úsalo cuando el negocio lo pague explícitamente.

### 4.5 Dependency mapping: el paso que se olvida

Un plan DR falla porque un servicio interno (autenticación, secrets manager, feature flags) no fue considerado. **Dependency mapping** documenta cada dependencia externa e interna:

```yaml
# service-dependencies.yaml
service: linguadev-api
dependencies:
  hard:  # sin esto no arranca
    - postgres (RDS)
    - redis (ElastiCache)
    - secrets-manager
    - kms (para descifrar secrets)
  soft:  # degrada pero sigue funcionando
    - openai-api (fallback: mensaje "AI unavailable")
    - stripe (fallback: pagos en cola)
  external_sla:
    - postgres: RTO 5min, RPO 5s (Aurora Global)
    - redis: RTO 10min, RPO 60s (Global Datastore)
    - secrets-manager: RTO region-scoped, replica cross-region
    - kms: multi-region keys
```

Herramientas: **CloudFormation StackSets** para replicar dependencies en múltiples regiones, **AWS Resilience Hub** (2021+, GA con mejoras 2024-2026) para descubrir y valorar dependencies automáticamente.

---

## 5. Ejemplo práctico: DR completo para LinguaDev Pro

Objetivo: implementar `RTO=15min, RPO=1min` para el módulo API+DB de LinguaDev Pro usando pilot light con Aurora Global + Vault Lock + Velero para Kubernetes.

### Paso 1: infraestructura primaria con backups immutables

```hcl
# 1.1 KMS multi-region
resource "aws_kms_key" "backup" {
  description             = "LinguaDev DR key"
  multi_region            = true
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

# 1.2 Vault Lock en compliance mode
resource "aws_backup_vault" "immutable" {
  name        = "linguadev-immutable"
  kms_key_arn = aws_kms_key.backup.arn
}

resource "aws_backup_vault_lock_configuration" "compliance" {
  backup_vault_name   = aws_backup_vault.immutable.name
  changeable_for_days = 3
  min_retention_days  = 30
  max_retention_days  = 2555
}

# 1.3 Backup plan con cross-region y PITR
resource "aws_backup_plan" "prod" {
  name = "linguadev-prod"

  rule {
    rule_name           = "daily-continuous"
    target_vault_name   = aws_backup_vault.immutable.name
    schedule            = "cron(0 5 ? * * *)"
    enable_continuous_backup = true

    lifecycle {
      cold_storage_after = 30
      delete_after       = 2555
    }

    copy_action {
      destination_vault_arn = aws_backup_vault.immutable_dr.arn

      lifecycle {
        cold_storage_after = 30
        delete_after       = 2555
      }
    }
  }
}

resource "aws_backup_selection" "prod_tagged" {
  iam_role_arn = aws_iam_role.backup.arn
  name         = "prod-tagged"
  plan_id      = aws_backup_plan.prod.id

  selection_tag {
    type  = "STRINGEQUALS"
    key   = "backup"
    value = "daily"
  }
}
```

### Paso 2: Aurora Global Database (RPO <1s)

```hcl
resource "aws_rds_global_cluster" "linguadev" {
  global_cluster_identifier = "linguadev-global"
  engine                    = "aurora-postgresql"
  engine_version            = "16.4"
  storage_encrypted         = true
}

# Primary us-east-1 (2 instancias)
resource "aws_rds_cluster" "primary" {
  provider                  = aws.primary
  cluster_identifier        = "linguadev-primary"
  global_cluster_identifier = aws_rds_global_cluster.linguadev.id
  # ... otros params
  tags = { backup = "daily", Environment = "prod" }
}

# DR us-west-2 (0 instancias — pilot light)
resource "aws_rds_cluster" "dr" {
  provider                  = aws.dr
  cluster_identifier        = "linguadev-dr"
  global_cluster_identifier = aws_rds_global_cluster.linguadev.id
  # ... sin cluster_instances
}
```

### Paso 3: Velero para backup de Kubernetes (EKS)

```bash
# Instalar Velero 1.14+ con AWS plugin
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket linguadev-velero-us-east-1 \
  --backup-location-config region=us-east-1,kmsKeyId=alias/velero-key \
  --snapshot-location-config region=us-east-1 \
  --secret-file ./credentials-velero \
  --use-node-agent

# Schedule diario con retention 90 días
velero schedule create daily-full \
  --schedule "0 4 * * *" \
  --ttl 2160h \
  --include-namespaces linguadev,linguadev-workers
```

### Paso 4: test de restore automatizado (CronJob mensual)

```yaml
# k8s/dr-drill-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: dr-drill
  namespace: sre
spec:
  schedule: "0 6 1 * *"   # 1º de cada mes 06:00 UTC
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      template:
        spec:
          restartPolicy: Never
          serviceAccountName: dr-drill
          containers:
            - name: drill
              image: ghcr.io/linguadev/dr-drill:2026.08
              env:
                - name: SNAPSHOT_SOURCE
                  value: "linguadev-immutable"
                - name: DR_REGION
                  value: "us-west-2"
                - name: SLACK_WEBHOOK
                  valueFrom:
                    secretKeyRef:
                      name: slack
                      key: webhook
              command:
                - /bin/sh
                - -c
                - |
                  set -e
                  ./run-drill.sh || {
                    curl -X POST "$SLACK_WEBHOOK" \
                      -d '{"text":"DR DRILL FAILED — investigate"}'
                    exit 1
                  }
                  curl -X POST "$SLACK_WEBHOOK" \
                    -d '{"text":"DR drill PASSED, MTTR: '$MTTR'"}'
```

### Paso 5: runbook operativo de failover

```markdown
# LinguaDev Pro — DR Failover Runbook

## Precondiciones
- Confirmado que us-east-1 está no disponible (AWS Health Dashboard).
- Incident Commander declarado.

## Pasos (RTO objetivo 15 min)

1. **[t+0]** Detectar caída (PagerDuty alert on `api-primary` health check FAIL).
2. **[t+1]** IC declara P1, abre war room #inc-YYYYMMDD-dr.
3. **[t+2]** Promocionar Aurora DR:
   ```bash
   aws rds remove-from-global-cluster \
     --global-cluster-identifier linguadev-global \
     --db-cluster-identifier linguadev-dr \
     --region us-west-2
   ```
4. **[t+3]** Crear instancias RDS en DR (Terraform apply target):
   ```bash
   cd terraform/dr && terraform apply -target=aws_rds_cluster_instance.dr -auto-approve
   ```
5. **[t+8]** Actualizar Kubernetes secret con nuevo endpoint:
   ```bash
   kubectl -n linguadev create secret generic db \
     --from-literal=host=linguadev-dr.cluster-xxx.us-west-2.rds.amazonaws.com \
     --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n linguadev rollout restart deploy/api
   ```
6. **[t+12]** Route53 failover automático (health check ya detectó); verificar propagación.
7. **[t+15]** Smoke test end-to-end. Update status page.

## Post-incident
- Post-mortem blameless en 5 días laborales.
- Verificar coste extra y volver a pilot light cuando us-east-1 se recupere.
```

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ Definí RTO/RPO **con el negocio** y ponelos por escrito.
- ✅ Cumplí **3-2-1-1-0**: 3 copias, 2 medios, 1 offsite, 1 immutable, 0 fallos en restore.
- ✅ Un backup **no probado** es esperanza, no seguridad. Test mínimo trimestral, ideal mensual.
- ✅ Usá **AWS Backup Vault Lock compliance mode** para retenciones legales/ransomware.
- ✅ **Cross-region + cross-account** en backups críticos (aislamiento total).
- ✅ **KMS multi-region keys** para descifrar backups desde cualquier región.
- ✅ **Aurora Global Database** o **DynamoDB Global Tables** cuando el RPO exige <1s.
- ✅ **DNS TTL ≤60s** en registros de failover.
- ✅ **Dependency mapping** documentado: hard/soft, RTO/RPO por dependencia.
- ✅ **Runbook** de failover con comandos exactos, no prosa.
- ✅ **Game days** trimestrales que ejecuten el failover real (o al menos el simulacro completo).
- ✅ Retención de backups **≥ retention legal** (GDPR 6 años, SOX 7 años, HIPAA variable).
- ✅ Cifrar backups **at-rest y in-transit**, con keys que existan en la región DR.
- ✅ Aislar la cuenta de backup (delegated admin en AWS Organizations).

### Anti-patrones

- ❌ Backup en el mismo bucket/región/cuenta que producción.
- ❌ Snapshot RDS sin copia cross-region.
- ❌ Compliance mode aplicado sin entender que **no hay reversa**.
- ❌ Confiar en "el software de backup no reportó error".
- ❌ Runbook DR en prosa larga que nadie lee a las 3 AM.
- ❌ Failover manual sin DNS pre-configurado.
- ❌ Multi-region active-active para una app que no lo necesita (multiplica coste 3-10x).
- ❌ No mapear dependencias externas (Stripe, OpenAI, secrets managers).
- ❌ KMS keys que solo existen en la región primaria.
- ❌ Retención mensual cuando compliance exige 7 años.

### Tabla decisión patrón DR

| Perfil | Patrón | Coste típico |
|---|---|---|
| Blog personal, RTO 24h | Backup & Restore | $10/mes |
| SaaS B2B, RTO 4h, RPO 15min | Pilot Light | 2x infra |
| Fintech, RTO 30min, RPO 1min | Warm Standby + Aurora Global | 4x infra |
| Banca / healthcare, RTO 1min, RPO 0 | Hot Standby / Active-Active | 8x infra |

---

## 7. Casos reales industria 2017-2026

**GitLab 2017-01-31:** el famoso incident de GitLab.com: un SRE cansado borró el directorio wrong en el DB primario, y descubrieron que **5 de 5 métodos de backup fallaban silenciosamente**: `pg_dump` producía archivos vacíos por mismatch de versión, LVM snapshots no se estaban ejecutando, S3 upload fallaba sin alertar. Perdieron 6 horas de datos. Post-mortem público publicado con transparencia total —lectura obligada para toda persona en DevOps. Lección: **el monitoring "verde" no es suficiente; el test de restore es el único validador**.

**Colonial Pipeline 2021:** ransomware DarkSide cifró los sistemas y también los backups conectados. Pagaron $4.4M (recuperados parcialmente por el FBI). Post-analyses coincidieron: la falta de **backups offline / air-gapped / immutable** convirtió una incidencia recuperable en una crisis nacional. Detonó regulaciones tipo NIS2 (EU) y guías de CISA para infraestructura crítica.

**Facebook Oct 2021:** 6h de outage por BGP misconfig. Recuperación tardó porque los sistemas de gestión también dependían de los sistemas caídos. Post-mortem oficial destacó que **incluso las herramientas de acceso físico a datacenters fallaron** porque las tarjetas de acceso dependían de servicios internos. Los ingenieros tuvieron que ir físicamente con angle grinders. Lección: mapear dependencias circulares.

**AWS us-east-1 Dec 7 2021:** 8h de degradación cascada. Empresas con multi-region real (Netflix, cierta parte de Amazon.com misma) sobrevivieron; muchas SaaS single-region cayeron duramente. Netflix documentó que Chaos Kong los preparó para este escenario exacto.

**AWS us-east-2 Aug 2023:** networking issues afectaron varios servicios core. Casos publicados de empresas que perdieron ventana comercial porque su "multi-region" era en realidad DR pasivo mal probado.

**Rackspace Hosted Exchange Dec 2022:** ransomware Play afectó email empresarial de miles de clientes. Rackspace declaró que la recuperación total no era posible; migró clientes a Microsoft 365. Lección para SaaS providers: **el DR de tu vendor es tu DR**.

**CrowdStrike Falcon July 2024:** un update defectuoso de sensor kernel de Windows brickeo 8.5M+ hosts globalmente. Aunque no fue "desastre" en el sentido clásico, expuso la debilidad de dependencias monoculturales: hospitales, aeropuertos y bancos cayeron simultáneamente. Muchos tuvieron que restaurar backups de horas antes; los que no tenían **snapshots recientes** perdieron un día de trabajo.

**AWS Backup Vault Lock 2020-2026:** GA en agosto 2020, con mejoras continuas: multi-region copy con lock preservado (2022), soporte para más servicios (Aurora, S3, EFS, EBS, DynamoDB, FSx, Storage Gateway), Backup Audit Manager para compliance reporting (2022), **AWS Backup logically air-gapped vaults** (2024) que añaden una capa adicional de aislamiento cross-account/cross-region administrado por AWS. En 2026 es baseline razonable en cualquier arquitectura AWS seria.

**Datadog Mar 2023:** outage de 24h+ afectando observability de miles de clientes. Post-mortem público: dependencia inesperada en un servicio interno cross-region. Datadog implementó posteriormente aislamiento por celda ("cell-based architecture") — patrón cada vez más común en 2024-2026.

**Basecamp / 37signals 2022-2024 "cloud exit":** DHH publicó extensivamente sobre migrar de la cloud (AWS) a colocation propio. Parte de su motivación fue simplificar DR (control físico + snapshots). Contra-narrativa útil: el cloud DR es más simple **si lo usas bien**, más caro si no.

---

## 8. Ejercicios prácticos

### Ejercicio 1: implementar 3-2-1-1-0 en AWS para una DB PostgreSQL

**Objetivo:** montar una estrategia completa que cumpla la regla extendida.

**Setup:**
- Cuenta AWS con RDS PostgreSQL 16.
- CLI configurada con permisos IAM sobre RDS, S3, Backup, KMS.
- Dos regiones (us-east-1 primaria, us-west-2 DR).

**Pasos:**
1. Habilitar automated backups + PITR con retention 35 días.
2. Crear vault Vault Lock en `governance mode` (para practicar sin bloqueo permanente).
3. Configurar backup plan con cross-region copy.
4. Añadir un job semanal de `pg_dump` a S3 con Object Lock (compliance mode retention 30d).
5. Crear KMS multi-region key y usarla en todos los cifrados.

**Criterios de éxito:**
- [ ] `aws backup describe-backup-vault` muestra `LockDate` seteado.
- [ ] Vault DR aparece en `us-west-2` con recovery points replicados tras 24h.
- [ ] Un intento manual de borrar un recovery point da error `AccessDenied`.
- [ ] pg_dump reciente existe en S3 con `ObjectLockMode=COMPLIANCE`.
- [ ] KMS key tiene réplica en la región DR (`aws kms describe-key` muestra `MultiRegionConfiguration`).

**Bonus:** documentar en README.md el `MinRetentionDays` y el impacto legal de la retención elegida.

---

### Ejercicio 2: game day pilot light con Aurora Global Database

**Objetivo:** ejecutar un failover real de us-east-1 → us-west-2 y medir MTTR.

**Setup:**
- Aurora Global Database desplegada con Terraform (código de sección 4.2).
- Kubernetes deployment `linguadev-api` en ambos clusters (staging).
- Route53 configurado con health check + failover routing.

**Pasos:**
1. Establecer baseline: request rate, latencia, error rate desde staging.
2. Iniciar carga sintética con k6/locust (`~100 rps`).
3. **T+0**: simular caída us-east-1 con Network ACL bloqueando egress a RDS.
4. Ejecutar el runbook de failover paso a paso, midiendo tiempo por paso.
5. Confirmar que el tráfico se sirve desde us-west-2 y no hay errores post-failover.
6. Revertir tras validar (remover ACL, degradar cluster).

**Criterios de éxito:**
- [ ] MTTR total ≤ 15 min.
- [ ] Pérdida de datos comprobada ≤ 5 seg (Aurora Global RPO).
- [ ] Carga sintética termina con <2% de errores durante la ventana de failover.
- [ ] Route53 propaga en ≤60s (usaste TTL corto).
- [ ] Post-mortem redactado con timeline y action items.

**Bonus:** automatizar el failover como Step Functions state machine.

---

### Ejercicio 3: restore drill de Velero en Kubernetes

**Objetivo:** validar que un cluster puede ser reconstruido desde un backup Velero.

**Setup:**
- Cluster EKS de origen con namespace `linguadev` (2 deploys + 1 StatefulSet Postgres + 3 PVCs).
- Cluster EKS de destino (o `kind` local con AWS credentials).
- Velero instalado en ambos.

**Pasos:**
1. Crear backup: `velero backup create test-1 --include-namespaces linguadev --wait`.
2. Verificar en S3: objetos existen y hay checksums.
3. En cluster destino, restaurar: `velero restore create --from-backup test-1 --wait`.
4. Verificar recursos: `kubectl get all,pvc,secret -n linguadev`.
5. Query DB restaurada y compararla contra el snapshot original.

**Criterios de éxito:**
- [ ] Backup `Completed` sin errors ni warnings.
- [ ] Restore `Completed`, todos los pods `Running`.
- [ ] PVCs `Bound` con datos.
- [ ] Query de row count coincide con origen.
- [ ] Documentar tiempo total (objetivo <20 min para el volumen del ejercicio).

**Bonus:** convertir el drill en CronJob mensual con alerta Slack.

---

### Ejercicio 4: auditoría de dependencias y clasificación

**Objetivo:** producir un dependency map completo para LinguaDev API.

**Setup:**
- Acceso al repo del API.
- Lista de servicios externos usados (OpenAI, Stripe, SendGrid, etc.).
- Cuenta AWS con Resilience Hub habilitado (opcional).

**Pasos:**
1. Recorrer código: identificar cada llamada out-of-process.
2. Clasificar en `hard` (bloquea startup / requests core) vs `soft` (degrada).
3. Documentar RTO/RPO de cada dependencia (según SLA del vendor).
4. Diseñar fallback para cada `soft` (mensaje, cola, cache).
5. Ejecutar chaos test (network policy block) para verificar clasificación.

**Criterios de éxito:**
- [ ] YAML de dependency map completo (formato de sección 4.5).
- [ ] Cada dependencia tiene owner + SLA + fallback documentado.
- [ ] Block network policy sobre `soft` no rompe el servicio.
- [ ] Block sobre `hard` produce 503 con mensaje claro (no crash).

**Bonus:** integrar Resilience Hub y comparar su análisis con el tuyo.

---

### Ejercicio 5 (avanzado): Vault Lock compliance mode simulado

**Objetivo:** demostrar que ni root puede borrar un backup en compliance mode.

**Setup:**
- **Cuenta AWS sandbox** (nunca en prod real — es irreversible).
- Terraform o CLI.
- MFA activado en root.

**Pasos:**
1. Crear vault con Vault Lock en compliance mode y `MinRetentionDays=7`.
2. Esperar el `ChangeableForDays` (mínimo 3 días — planificar el ejercicio).
3. Realizar un backup manual de un recurso pequeño.
4. Intentar borrar el recovery point con IAM user normal → esperar `AccessDeniedException`.
5. Intentar borrar con root → esperar mismo error.
6. Intentar reducir `MinRetentionDays` → esperar error.
7. Documentar cada intento con timestamp y respuesta AWS.

**Criterios de éxito:**
- [ ] Todos los intentos de bypass fallan.
- [ ] Documento con evidencia (screenshots o CLI output).
- [ ] Vault sigue existiendo tras el ejercicio con los recovery points intactos.
- [ ] Plan de cleanup: esperar los 7 días o usar la cuenta sandbox como throwaway.

**Bonus:** presentar al equipo el trade-off "compliance mode = seguro pero costoso e irreversible" con datos reales.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [AWS Backup User Guide — Vault Lock](https://docs.aws.amazon.com/aws-backup/latest/devguide/vault-lock.html).
- [AWS Well-Architected — Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/).
- [S3 Object Lock overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html).
- [Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html).
- [Velero docs](https://velero.io/docs/).
- [PostgreSQL Continuous Archiving and PITR](https://www.postgresql.org/docs/current/continuous-archiving.html).

**Herramientas:**
- **Velero** — backup y restore Kubernetes cluster + PVCs.
- **Kasten K10** — enterprise Kubernetes DR.
- **AWS Backup**, **AWS Elastic Disaster Recovery (DRS)**.
- **restic** / **borg** — backups a nivel filesystem con dedup e immutable options.
- **Duplicity** / **Rclone** — sync/backup a múltiples proveedores.
- **AWS Resilience Hub** — assessment de RTO/RPO por app.

**Referencias adicionales:**
- Google SRE Book cap 26 — "Data Integrity: What You Read Is What You Wrote".
- Nora Jones, Adrian Cockcroft — "Chaos Engineering" y "Cloud Native Reliability".
- Veeam Whitepaper — "3-2-1-1-0 Backup Rule".
- CISA guide — "Ransomware Guide" (updates 2024-2026).
- NIST SP 800-34 — Contingency Planning Guide for Federal Information Systems.

**Siguientes pasos:**
- Escribí el documento "RTO/RPO por servicio" con owners de negocio, publicalo en la wiki.
- Habilitá al menos **1 vault** en compliance mode para tu DB más crítica.
- Programá un **game day** en los próximos 30 días.
- Automatizá el drill mensual y alerta si falla.
- Continuá con [Cap 38 — Chaos Engineering en práctica](./38-chaos-engineering-en-practica.md) para probar las hipótesis DR bajo fallo real.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales sobre RTO/RPO, regla 3-2-1, tipos de backup (full/incremental/differential/PITR), testing de restore, backups immutables (S3 Object Lock, Vault Lock compliance vs governance), cross-region replication, cifrado at-rest/in-transit y KMS multi-region, patrones DR (backup&restore, pilot light, warm standby, active-active), Aurora Global Database, DynamoDB Global Tables, Velero para Kubernetes, dependency mapping, y casos reales GitLab/Colonial/Facebook.

- **Fuente:** [`packages/content/src/tech/devops/sim-37-disaster-recovery-and-backups.json`](../../packages/content/src/tech/devops/sim-37-disaster-recovery-and-backups.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-37-disaster-recovery-and-backups`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 36 — Artifact Management y Caching](./36-artifact-management-y-caching.md) · [Índice](./README.md) · [Capítulo 38 — Chaos Engineering en práctica →](./38-chaos-engineering-en-practica.md)
