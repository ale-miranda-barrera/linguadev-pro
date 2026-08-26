# Capítulo 26 — Compliance y auditoría (SOC 2, ISO 27001, PCI-DSS, GDPR, HIPAA)

> **Focus:** Compliance moderno como código: frameworks (SOC 2 Type I/II, ISO 27001:2022, PCI-DSS v4.0, GDPR/CCPA, HIPAA), audit logging inmutable (CloudTrail + S3 Object Lock, K8s audit, GitHub audit), plataformas de automation (Drata, Vanta, Sprinto, Secureframe, Thoropass, Scytale), continuous compliance con drift detection, CSPM (Prowler, Steampipe, Scout Suite, Prisma Cloud), gap analysis y penetration testing periódico.
> **Áreas:** Security · Monitoring · Governance
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Cloud fundamentals: AWS/GCP/Azure IAM, S3/Cloud Storage, KMS (ver [cap 14 — cloud fundamentals](./14-cloud-fundamentals-y-multi-cloud.md)).
- Container y Kubernetes security, RBAC, Pod Security (ver [cap 11 — kubernetes security](./11-kubernetes-security.md)).
- Policy as Code: OPA, Kyverno, decision logs (ver [cap 25 — policy as code](./25-policy-as-code-opa-kyverno.md)).
- Supply chain security: SLSA, SBOM, Cosign (ver [cap 24 — supply chain security](./24-supply-chain-security.md)).
- Fluidez leyendo control catalogs y risk matrices.

**Glosario mínimo:**
- **SOC 2** (Service Organization Control 2): audit framework del AICPA que evalúa controles sobre 5 Trust Service Criteria. **Type I** = snapshot; **Type II** = periodo 3-12 meses.
- **ISO/IEC 27001:2022**: standard internacional (ISO) para ISMS (Information Security Management System). 93 controles en Annex A (versión 2022, reduce de los 114 anteriores).
- **PCI-DSS v4.0** (marzo 2022, fully effective marzo 2024, con requisitos futuros hasta marzo 2025): Payment Card Industry Data Security Standard. 12 requirements para cualquier entidad que procese, almacene o transmita cardholder data.
- **GDPR** (General Data Protection Regulation, EU 2018) y **CCPA/CPRA** (California, 2020/2023): frameworks de privacidad. Enforce por autoridades (BfDI, CNIL, ICO en Europa; AG California en US).
- **HIPAA** (Health Insurance Portability and Accountability Act, US 1996): protege PHI (Protected Health Information). Security Rule + Privacy Rule + Breach Notification.
- **CSPM** (Cloud Security Posture Management): tooling que audita configuraciones cloud contra benchmarks (CIS, NIST, custom). Ejemplos: Prowler, Steampipe, Scout Suite, Prisma Cloud, Wiz, Orca.
- **Continuous compliance**: evaluar controles CADA día vía APIs, no una vez al año con screenshots.
- **Evidence collection**: capturar prueba de que un control opera (screenshots antes; JSON de API + logs con timestamp ahora).
- **SoA** (Statement of Applicability, ISO 27001): documento que declara qué controles del Annex A aplican y por qué.
- **Trust Services Criteria** (TSC): 5 categorías de SOC 2 — Security (obligatorio), Availability, Confidentiality, Processing Integrity, Privacy.
- **CloudTrail Lake**: servicio AWS que consolida CloudTrail events en un lake queryable con SQL (Athena-style).
- **Immutable audit log**: log que no puede ser alterado ni eliminado. Se logra con S3 Object Lock (WORM), Object Storage Immutability (GCS Bucket Lock), Azure Immutable Blob.
- **Drata / Vanta / Sprinto / Secureframe**: plataformas de compliance automation. Colectan evidence continuamente vía API integrations.

**Setup mínimo:**

```bash
# 1. AWS CLI + Terraform (para audit infra)
aws --version   # 2.17.x+
terraform version   # 1.9.x+

# 2. Prowler 4.6+ (CSPM open source)
pip install prowler==4.6.2
prowler aws --compliance cis_2.0_aws soc2_aws -M csv,html

# 3. Steampipe (SQL queries sobre cloud APIs)
brew install steampipe
steampipe plugin install aws
steampipe query "select account_id, region, name from aws_s3_bucket where server_side_encryption_configuration is null"

# 4. Scout Suite (multi-cloud audit)
pip install ScoutSuite==5.14.0
scout aws --report-dir out/

# 5. gitleaks para secrets en repos
brew install gitleaks
gitleaks detect --source . --report-format json --report-path leaks.json

# 6. OpenSCAP para CIS servers
sudo apt install libopenscap8 scap-security-guide
oscap xccdf eval --profile cis_level2_server /usr/share/scap-security-guide/ssg-ubuntu2404-ds.xml

# 7. Chef InSpec (compliance-as-code veterano)
curl https://omnitruck.chef.io/install.sh | sudo bash -s -- -P inspec
```

---

## 1. El gran cuadro

Compliance nació como un ejercicio anual de screenshots. Un GRC manager pasaba dos semanas capturando pantallas de configuraciones — "sí, MFA está habilitado", "sí, los backups corren cada día", "sí, los logs se retienen 90 días" — el auditor CPA venía tres días, sampleaba lo que colectaste, escribía un report SOC 2 de treinta páginas y todos volvían a olvidarse del tema hasta el año siguiente. El modelo asumía que el estado no cambiaba entre audits, lo cual es falso: en un cluster moderno se modifican doscientos recursos al día, y la brecha entre "cómo estabas el 15 de octubre" (fecha del audit) y "cómo estás el 20 de noviembre" (cuando un dev cambió la config) es exactamente donde ocurren los breaches. Post-Capital One (2019, cien millones de registros exfiltrados por una WAF misconfigured), post-SolarWinds (2020, supply chain compromise), post-Colonial Pipeline (2021, ransomware paralizando infraestructura crítica), la industria aceptó que **compliance point-in-time no funciona**. Compliance moderno es continuo: evidence colectado por APIs cada día, drift detectado en minutos, controles enforced por código.

El landscape en 2026 se organiza alrededor de cuatro frameworks dominantes. **SOC 2** (americano, dominante en B2B SaaS US) evalúa controles sobre los cinco Trust Service Criteria; Type II con periodo de observación 6-12 meses es lo que enterprise realmente compra. **ISO 27001:2022** (internacional, dominante en EU/UK/APAC) es certificación acreditada — un logo que exhibís públicamente vs el report privado bajo NDA de SOC 2. **PCI-DSS v4.0** (obligatorio para procesar tarjetas de crédito, fully effective marzo 2024) tiene doce requirements muy prescriptivos; la mejor estrategia es reducir scope drasticamente (usar Stripe/Braintree/Adyen que absorben tarjetas — vos nunca las tocás). **GDPR/CCPA** son frameworks de privacidad; enforce por autoridades (BfDI, CNIL, ICO) con multas de hasta 4% del revenue global; los technical requirements incluyen data subject rights (access, deletion, portability), lawful basis y breach notification en 72h. **HIPAA** es específico healthcare US con dos rules (Security + Privacy) y BAAs (Business Associate Agreements) obligatorios con vendors.

La revolución operacional vino con **Drata**, **Vanta**, **Sprinto**, **Secureframe**, **Thoropass** y **Scytale** — plataformas de compliance automation que se integran vía API con tu stack (AWS, GCP, Azure, GitHub, Okta, Google Workspace, Jira, Slack, Datadog, Segment, HR systems) y colectan evidence continuamente. En vez de screenshots manuales, un check dice "MFA habilitado para 47/47 usuarios" leyendo la API de Okta cada 24h. El auditor accede al panel read-only, samplea evidence live y firma. Los tiempos colapsaron: SOC 2 Type II que antes tomaba doce meses + $200k, ahora se cierra en 6-8 semanas + $30-50k para una startup Series A. En 2026 estas plataformas evolucionaron hacia "agentic compliance" — Vanta AI Agent (GA 2025) autocompleta security questionnaires y sugiere remediaciones; Drata Agentic TPRM (marzo 2026) automatiza vendor assessments; Sprinto ofrece pricing agresivo (offshoring) para startups earlier stage. La categoría se llama GRC automation y no muestra signos de saturación porque toda startup B2B necesita SOC 2 tarde o temprano.

El impacto sobre el equipo de DevOps es concreto. **CloudTrail** ya no es opcional — debe habilitarse desde día cero en toda cuenta AWS, con organization trail multi-región, S3 destination con **Object Lock (WORM)** para inmutabilidad forense, log file validation y opcionalmente CloudTrail Lake para queries SQL. **Audit logs de Kubernetes** deben ir a un sistema inmutable (Loki + S3, Datadog, Splunk). **GitHub audit log** debe exportarse (org enterprise) para trazar quién cambió qué en repos. **CSPM** (Prowler, Steampipe, Scout Suite, o comerciales Wiz/Orca/Prisma Cloud) debe correr diariamente y bloquear PRs Terraform que introducen drift. **Chef InSpec profiles** o **Kyverno policies** implementan controles CIS/NIST directamente como código. Este capítulo cubre los frameworks, la infraestructura de audit logging inmutable, la comparación entre plataformas de automation en 2026, los patrones de continuous compliance, y termina con ejercicios concretos sobre LinguaDev Pro.

---

## 2. Frameworks: SOC 2, ISO 27001, PCI-DSS, GDPR, HIPAA (nivel básico)

### 2.1 SOC 2: Trust Services Criteria y Type I vs Type II

SOC 2 (Service Organization Control 2) es un audit framework del **AICPA** (American Institute of CPAs). Evalúa controles de una service organization contra los cinco **Trust Services Criteria** (TSC): **Security** (obligatorio, único no opcional), **Availability**, **Confidentiality**, **Processing Integrity** y **Privacy**. El auditor CPA firma un report que es un **attestation** (no una certification): un documento privado que compartís con customers bajo NDA. Es dominante en US en B2B SaaS — casi todo customer enterprise americano pide SOC 2 Type II como prerequisito de compra.

- **SOC 2 Type I**: snapshot puntual, evalúa que los controles están **diseñados** correctamente. Toma 4-8 semanas. Barato, útil como "primer paso" pero customers enterprise raramente lo aceptan.
- **SOC 2 Type II**: evalúa que los controles **operan efectivamente** durante un periodo de observación (típicamente 6-12 meses, mínimo 3). Es lo que se compra realmente. Toma 6-12 meses (incluyendo el observation window). Renovable anualmente.

El workflow: (1) elegir TSCs aplicables; (2) diseñar controles (~100 típicos: access control, encryption, incident response, change management, vendor management, backup, business continuity, monitoring, logging); (3) implementar y documentar; (4) contratar CPA firm (Big 4, o boutiques como Prescient, A-LIGN, Schellman, Insight Assurance, PBSA); (5) audit fieldwork; (6) report emitido. Costo típico: $20k-$50k para startups con automation (Drata/Vanta); $150k+ enterprise sin automation.

### 2.2 ISO/IEC 27001:2022

**ISO 27001** es el standard internacional para **ISMS** (Information Security Management System). Publicado por ISO en 2005, actualizado 2013, y en 2022 la revisión rebalanceó controles de 114 a **93 controles en 4 categorías del Annex A** (Organizational, People, Physical, Technological). En 2026, la versión 2013 está oficialmente retirada — auditors solo emiten contra la 2022.

Diferencias operativas vs SOC 2:
- **Certification** (con logo público, válido 3 años + surveillance audits anuales) vs SOC 2 attestation privado.
- Organismo acreditado emite (BSI, DNV, TÜV, DEKRA, ANAB, UKAS) vs CPA firm.
- **Proceso-orientado**: requiere ISMS documentado, risk assessment formal, **Statement of Applicability** (SoA declara qué controles aplican y por qué), internal audit + management review antes del external audit.
- Overlap con SOC 2 ~80% conceptual — auditors "multi-scheme" (A-LIGN, BSI, Schellman) hacen fieldwork combinado.

Frameworks relacionados: **ISO 27017** (extension cloud), **ISO 27018** (privacy en cloud), **ISO 27701** (privacy management extension complementaria a GDPR).

### 2.3 PCI-DSS v4.0

Si tu app **procesa, almacena o transmite cardholder data** (números de tarjeta), PCI-DSS aplica. Versión actual: **v4.0** (marzo 2022, fully effective marzo 2024, con requisitos futuros dated hasta marzo 2025). Doce requirements muy prescriptivos — encryption in transit y at rest, network segmentation, MFA sobre cualquier acceso a CDE (Cardholder Data Environment), quarterly ASV scans, annual penetration testing.

**Estrategia dominante 2026: reducir scope**. En vez de tocar tarjetas, delegar a **Stripe**, **Braintree**, **Adyen**, **Checkout.com**, **Mollie** — el customer ingresa la tarjeta en un iframe hosted por el processor, tu backend nunca ve el PAN, y calificás para **SAQ A** (Self-Assessment Questionnaire A) — el más liviano (~22 preguntas vs 300+ del SAQ D). Alternativa: usar **network tokens** (Visa Token Service, Mastercard MDES) que reemplazan el PAN con un token que solo el processor sabe reverse.

Anti-pattern crítico: guardar cardholder data en tu BD "encriptado" pensando que ya cumplís. No. PCI-DSS aplica encryption + key management + access control + audit + segmentation + pen testing + ASV scans + Web Application Firewall + IDS/IPS + secure SDLC — un stack completo con costo de $100k+/año mínimo para tu entorno CDE. Delegate.

### 2.4 GDPR, CCPA y HIPAA

**GDPR** (EU, enforcement 25 mayo 2018): aplica a cualquier procesamiento de datos personales de residentes EU, independientemente de dónde esté tu empresa. **Multas hasta 4% del revenue global anual o €20M** (lo mayor). Technical requirements: (1) **lawful basis** para procesar (consent, contract, legal obligation, vital interests, public task, legitimate interests); (2) **data subject rights** (access, rectification, erasure, portability, restriction, objection); (3) **breach notification** dentro de 72h a la autoridad; (4) **DPO** (Data Protection Officer) si procesás large-scale personal data; (5) **DPIA** (Data Protection Impact Assessment) para procesamiento high-risk; (6) **cross-border transfers** con SCCs (Standard Contractual Clauses) o Adequacy Decision. Post-Schrems II (2020) y post-Data Privacy Framework (2023), transferencias US-EU están rehabilitadas para empresas certificadas DPF.

**CCPA/CPRA** (California, 2020/enforcement 2023): equivalente californiano. Rights similares (know, delete, opt-out of sale, correct, limit use of sensitive info). Aplica a empresas con >$25M revenue, o que procesan >100k CA consumers, o derive >50% revenue vendiendo datos.

**HIPAA** (US, 1996): protege **PHI** (Protected Health Information). Aplica a Covered Entities (hospitales, insurance) y Business Associates (SaaS vendors que procesan PHI). **Security Rule** exige technical safeguards (encryption, access control, audit, integrity); **Privacy Rule** limita uso/disclosure; **Breach Notification Rule** requiere notificar breaches >500 individuos a HHS + affected individuals dentro de 60 días. **BAA** (Business Associate Agreement) obligatorio entre Covered Entity y cualquier vendor que toque PHI — AWS, GCP, Azure ofrecen BAAs.

---

## 3. Audit logging inmutable: CloudTrail, K8s audit, GitHub audit (nivel medio)

### 3.1 CloudTrail + S3 Object Lock: la base

Cada cuenta AWS debe tener **CloudTrail** habilitado desde día cero. Sin CloudTrail no hay accountability y no hay compliance. La configuración de referencia 2026: organization trail multi-región, entregando a un bucket S3 en una **log-archive account** separada, con Object Lock en modo compliance (WORM inmutable), log file validation habilitado, SSE-KMS encryption, y CloudTrail Lake para queries.

Terraform del setup canónico:

```hcl
# ORG-LEVEL: log-archive account (aislada)
resource "aws_s3_bucket" "audit_logs" {
  bucket = "linguadev-org-audit-logs-${data.aws_caller_identity.current.account_id}"

  object_lock_enabled = true
}

resource "aws_s3_bucket_object_lock_configuration" "audit_logs" {
  bucket = aws_s3_bucket.audit_logs.id

  rule {
    default_retention {
      mode  = "COMPLIANCE"   # WORM: nadie puede borrar, ni root, ni admin.
      years = 7               # SOC2 retention.
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_logs" {
  bucket = aws_s3_bucket.audit_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.audit.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "audit_logs" {
  bucket = aws_s3_bucket.audit_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "audit_logs" {
  bucket                  = aws_s3_bucket.audit_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ORGANIZATION TRAIL: captura API calls de TODAS las accounts.
resource "aws_cloudtrail" "org" {
  name                          = "linguadev-org-trail"
  s3_bucket_name                = aws_s3_bucket.audit_logs.id
  s3_key_prefix                 = "cloudtrail"
  include_global_service_events = true
  is_multi_region_trail         = true
  is_organization_trail         = true
  enable_log_file_validation    = true
  kms_key_id                    = aws_kms_key.audit.arn

  # Data events críticos: S3 object-level + Lambda invoke.
  advanced_event_selector {
    name = "s3-data-events"
    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }
    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }
    field_selector {
      field         = "resources.ARN"
      starts_with   = ["arn:aws:s3:::linguadev-customer-data/"]
    }
  }
}

# CloudTrail Lake: queryable con SQL.
resource "aws_cloudtrail_event_data_store" "audit" {
  name                           = "linguadev-audit-lake"
  multi_region_enabled           = true
  organization_enabled           = true
  retention_period               = 2555  # 7 years en días.
  termination_protection_enabled = true
  kms_key_id                     = aws_kms_key.audit.arn
}
```

**SCP** (Service Control Policy) para prevenir que alguien deshabilite CloudTrail incluso siendo admin de la account:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyCloudTrailChanges",
      "Effect": "Deny",
      "Action": [
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail",
        "cloudtrail:PutEventSelectors"
      ],
      "Resource": "arn:aws:cloudtrail:*:*:trail/linguadev-org-trail",
      "Condition": {
        "StringNotEquals": {
          "aws:PrincipalArn": "arn:aws:iam::111111111111:role/OrgSecurityBreakGlass"
        }
      }
    }
  ]
}
```

### 3.2 Query en CloudTrail Lake para forensics

Auditor pregunta "¿quién eliminó el S3 bucket `customer-data-prod` hace 3 semanas y desde qué IP?" CloudTrail Lake responde con SQL:

```sql
SELECT
    eventTime,
    userIdentity.principalId,
    userIdentity.arn,
    sourceIPAddress,
    userAgent,
    eventName,
    requestParameters
FROM   $EDS_ID
WHERE  eventName = 'DeleteBucket'
  AND  eventTime BETWEEN '2026-07-15 00:00:00' AND '2026-08-05 23:59:59'
  AND  element_at(requestParameters, 'bucketName') = 'customer-data-prod';
```

### 3.3 Kubernetes audit logs

El API server de Kubernetes emite audit events estructurados (JSON) que capturan quién hizo qué contra qué recurso. **Audit policy** define qué eventos loguear y a qué nivel (`None`, `Metadata`, `Request`, `RequestResponse`).

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
  - RequestReceived

rules:
  # Alta prioridad: exec/attach/portforward = potential lateral movement.
  - level: RequestResponse
    verbs: ["create"]
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach", "pods/portforward"]

  # Cambios en Secrets y ConfigMaps.
  - level: Request
    verbs: ["create", "update", "patch", "delete"]
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]

  # RBAC changes.
  - level: RequestResponse
    resources:
      - group: "rbac.authorization.k8s.io"
        resources: ["*"]

  # Todo delete es interesante.
  - level: Metadata
    verbs: ["delete"]

  # Read-only get/list/watch: nivel bajo.
  - level: None
    verbs: ["get", "list", "watch"]
    resources:
      - group: ""
        resources: ["events"]

  # Default: metadata para todo lo demás.
  - level: Metadata
```

Configuración del kube-apiserver (kubeadm):

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml
spec:
  containers:
    - name: kube-apiserver
      command:
        - kube-apiserver
        - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
        - --audit-log-path=/var/log/kubernetes/audit.log
        - --audit-log-maxage=30
        - --audit-log-maxbackup=10
        - --audit-log-maxsize=100
        - --audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
        - --audit-webhook-batch-max-size=400
```

En managed K8s (EKS/GKE/AKS) el audit log se activa desde la consola/CLI y se entrega a CloudWatch/Cloud Logging/Log Analytics automáticamente. En EKS:

```bash
aws eks update-cluster-config --name linguadev-prod \
  --logging '{"clusterLogging":[{"types":["api","audit","authenticator","controllerManager","scheduler"],"enabled":true}]}'
```

### 3.4 GitHub audit log

Enterprise organizations exportan audit log vía API o **Splunk/Datadog/Elastic streaming**. Captura: cambios en repos, membership, permissions, secrets scanning alerts, code scanning findings, deployments.

```bash
# Export vía CLI (org admin token con audit_log scope)
gh api /orgs/linguadev/audit-log?per_page=100 --paginate > gh-audit.jsonl

# Con jq: encontrar quién eliminó un repo
jq -r 'select(.action == "repo.destroy") | "\(.\"@timestamp\") \(.actor) → \(.repo)"' gh-audit.jsonl
```

---

## 4. Continuous compliance: CSPM, drift detection, compliance-as-code (nivel avanzado)

### 4.1 CSPM open source: Prowler, Steampipe, Scout Suite

**Prowler 4.6+** es el CSPM open source más adoptado en 2026. Evalúa configuraciones AWS/GCP/Azure/K8s contra 300+ checks mapeados a compliance frameworks (CIS AWS 2.0, ISO 27001, SOC 2, PCI-DSS, HIPAA, GDPR, NIST 800-53).

```bash
# Audit completo AWS contra CIS + SOC 2
prowler aws \
  --compliance cis_2.0_aws soc2_aws pci_dss_v4.0_aws \
  --output-directory reports/ \
  --output-formats csv,html,json-asff

# Focused check en S3
prowler aws --check-id s3_bucket_default_encryption

# Multi-cloud
prowler gcp --compliance cis_2.0_gcp
prowler azure --compliance cis_2.0_azure
prowler kubernetes --compliance cis_1.10_kubernetes
```

**Steampipe** te da SQL contra APIs cloud — brutal para queries ad-hoc:

```sql
-- ¿Qué buckets S3 no tienen encryption?
SELECT
  name, region, versioning_enabled, server_side_encryption_configuration
FROM   aws_s3_bucket
WHERE  server_side_encryption_configuration IS NULL;

-- ¿Qué IAM users tienen access keys > 90 días?
SELECT
  u.name,
  ak.access_key_id,
  ak.create_date,
  CURRENT_DATE - ak.create_date::date AS days_old
FROM   aws_iam_user u
       JOIN aws_iam_access_key ak ON u.name = ak.user_name
WHERE  ak.status = 'Active'
  AND  ak.create_date < CURRENT_DATE - INTERVAL '90 days';

-- ¿Qué security groups permiten 0.0.0.0/0 en puertos sensibles?
SELECT
  sg.group_id,
  sg.group_name,
  sgr.ip_protocol,
  sgr.from_port,
  sgr.to_port
FROM   aws_vpc_security_group sg
       JOIN aws_vpc_security_group_rule sgr ON sg.group_id = sgr.group_id
WHERE  sgr.cidr_ipv4 = '0.0.0.0/0'
  AND  sgr.type = 'ingress'
  AND  (sgr.from_port <= 22 AND sgr.to_port >= 22
   OR   sgr.from_port <= 3389 AND sgr.to_port >= 3389
   OR   sgr.from_port <= 5432 AND sgr.to_port >= 5432);
```

**Scout Suite** genera un HTML report navegable con findings ranked por severity. Comerciales equivalentes: **Wiz**, **Orca**, **Prisma Cloud** (Palo Alto), **Lacework**, **CrowdStrike Falcon Cloud Security** — todos con dashboards + evidence + integrations con GRC platforms.

### 4.2 Compliance-as-code con Chef InSpec

**Chef InSpec** (open source, pionero desde 2015) define compliance **profiles** con Ruby DSL. Los profiles del CIS Benchmark, DoD STIGs, NIST 800-53 vienen ready-to-use.

```ruby
# controls/soc2-encryption.rb
control 'soc2-cc6.1' do
  impact 1.0
  title 'CC6.1 - Encryption at rest for S3'
  desc 'All S3 buckets storing customer data must use SSE-KMS.'
  tag 'soc2', 'iso27001-a.8.24'

  aws_s3_buckets.bucket_names.each do |bucket|
    describe aws_s3_bucket(bucket_name: bucket) do
      it { should have_default_encryption_enabled }
    end
  end
end

control 'soc2-cc6.6' do
  impact 1.0
  title 'CC6.6 - MFA on root account'
  desc 'The AWS root account must have MFA enabled.'
  tag 'soc2', 'cis-aws-1.5'

  describe aws_iam_root_user do
    it { should have_mfa_enabled }
    it { should_not have_access_keys }
  end
end

control 'soc2-cc7.2' do
  impact 1.0
  title 'CC7.2 - CloudTrail multi-region enabled'
  desc 'CloudTrail must capture events across all AWS regions.'

  describe aws_cloudtrail_trails.where(is_multi_region_trail: true) do
    its('count') { should be >= 1 }
  end

  aws_cloudtrail_trails.trail_arns.each do |arn|
    describe aws_cloudtrail_trail(trail_name: arn) do
      it { should be_multi_region_trail }
      it { should be_logging }
      its('event_selectors') { should_not be_empty }
    end
  end
end
```

Correr y generar report firmado (evidence auditable):

```bash
inspec exec ./controls -t aws:// \
  --reporter=json:evidence-$(date +%Y%m%d).json cli
# Firmar el report para no-repudiation
cosign sign-blob --key cosign.key evidence-*.json > evidence-*.json.sig
aws s3 cp evidence-*.json* s3://linguadev-org-audit-logs/inspec-evidence/
```

### 4.3 Drift detection y remediation

Compliance drift ocurre cuando alguien modifica un recurso post-deployment (click-ops en la consola, break-glass IAM). Detectarlo requiere corrección continua entre state deseado y state real.

**Terraform drift detection**:

```bash
terraform plan -detailed-exitcode
# Exit 0 = no diff, 2 = diff detectado, 1 = error
# CI corre esto cada hora y alerta si detectExitCode == 2.
```

**AWS Config rules** para drift automático:

```hcl
resource "aws_config_config_rule" "s3_encryption_enabled" {
  name        = "s3-bucket-server-side-encryption-enabled"
  source {
    owner             = "AWS"
    source_identifier = "S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED"
  }
}

resource "aws_config_remediation_configuration" "s3_encryption_remediate" {
  config_rule_name = aws_config_config_rule.s3_encryption_enabled.name
  target_type      = "SSM_DOCUMENT"
  target_id        = "AWS-EnableS3BucketEncryption"
  automatic        = true
  maximum_automatic_attempts = 3

  parameter {
    name           = "SSEAlgorithm"
    static_value   = "AES256"
  }
}
```

---

## 5. Compliance automation: Drata, Vanta, Sprinto en 2026 (senior/staff)

### 5.1 Qué hacen exactamente

Las plataformas colectan **evidence continuamente** vía integrations API con tu stack:

- Cloud: AWS, GCP, Azure, DigitalOcean.
- Identity: Okta, Google Workspace, Microsoft Entra ID (Azure AD), Jumpcloud.
- Code/CI: GitHub, GitLab, Bitbucket, Jenkins, CircleCI.
- Monitoring: Datadog, PagerDuty, Sentry.
- HR: Rippling, Deel, BambooHR, ADP, Workday.
- Ticketing: Jira, Linear, ServiceNow.
- Endpoint: JAMF, Kandji, Kolide, Automox.
- Communication: Slack, Microsoft Teams.

En vez de un screenshot manual de "MFA habilitado", la plataforma lee la API de Okta cada 24h y muestra "47/47 usuarios con MFA — última verificación hace 3h — evidence: JSON con timestamp". Si un dev deshabilita MFA, alerta inmediato + ticket en Jira. El auditor accede al panel read-only y samplea evidence live.

Además, ofrecen: (1) **policy templates** (~100 policies pre-escritas customizables); (2) **employee onboarding tracking** (cada empleado firma policies, completa training, verifica laptop encriptado); (3) **vendor management** con TPRM (Third-Party Risk Management) — automatiza envío/respuesta de security questionnaires; (4) **auditor collaboration** con dashboards live; (5) **cross-framework mapping** (un control satisface SOC 2 + ISO 27001 + PCI-DSS + HIPAA simultáneamente).

### 5.2 Landscape 2026: Vanta vs Drata vs Sprinto vs Secureframe vs Thoropass vs Scytale

| Plataforma | Fundada | Fortaleza | Ideal para | Pricing 2026 (aprox) |
|---|---|---|---|---|
| **Vanta** | 2018 (Christina Cacioppo) | Categoría creator, integraciones más amplias, **Vanta AI Agent** GA 2025 (autocompleta questionnaires) | SaaS US 20-500 empleados | $15k-40k/año startup |
| **Drata** | 2020 (Adam Markowitz) | Continuous monitoring más profundo, granular control mapping, **Agentic TPRM** (marzo 2026), **Agentic Questionnaire** | Escalando cross-framework | $20k-60k/año |
| **Sprinto** | 2020 (India-based) | Pricing agresivo, autonomous GRC, offshoring reduce costo | Startups early stage, budget-constrained | $8k-25k/año |
| **Secureframe** | 2020 | UX pulido, buen para primer-time compliance | Startups Series A/B | $15k-40k/año |
| **Thoropass** (ex-Laika) | 2019 | Audit as a service — CPA in-house | Empresas que quieren "one throat to choke" | $30k-80k/año |
| **Scytale** | 2020 | Focus EU + AI-driven evidence | EU startups | $12k-30k/año |
| **Tugboat Logic** (OneTrust) | 2017 | Enterprise-grade, integrado a OneTrust GRC | Enterprise con multi-framework | Enterprise pricing |

### 5.3 Anti-patterns con compliance automation

- ❌ Comprar la plataforma pero no integrar todos los systems → evidence gaps.
- ❌ Aceptar policies templates sin customizar → auditor detecta "boilerplate".
- ❌ No asignar owners a cada control → nadie remedia findings.
- ❌ Ignorar alertas de drift → SOC 2 Type II falla porque los controles no operaron consistentemente.
- ❌ Compliance como afterthought para cerrar deals → no como cultura → dev friction constante.
- ❌ Cross-framework "compliance moat" sin madurez real → falla en pen test y expone toda la fachada.

---

## 6. Cheatsheet + reglas mentales + anti-patterns

### Reglas de oro

- ✅ **CloudTrail organization trail** habilitado día cero, multi-región, S3 + Object Lock (WORM), log file validation, SSE-KMS.
- ✅ **SCP org-level** que bloquea deshabilitar CloudTrail (incluso root de la account).
- ✅ **Audit logs de Kubernetes** habilitados y entregados a SIEM inmutable.
- ✅ **Retention**: 1 año hot + 7 años cold para logs (SOC 2 típico).
- ✅ **Compliance automation** (Drata/Vanta/Sprinto) desde antes de intentar SOC 2 — ahorra 3-6 meses.
- ✅ **Delegate PCI-DSS scope**: usá Stripe/Braintree/Adyen — SAQ A vs SAQ D es día vs semana.
- ✅ **Combined SOC 2 + ISO 27001** con auditor multi-scheme si vendés global (ahorra 30%).
- ✅ **CSPM diario**: Prowler o Steampipe corriendo en cronjob + alerta on findings críticos.
- ✅ **Drift detection**: AWS Config rules + terraform plan detailed-exitcode en cron.
- ✅ **Break-glass IAM** con MFA + alerta en Slack/PagerDuty + audit + expiration.
- ✅ **BAA con AWS/GCP/Azure** si tocás PHI (HIPAA).
- ✅ **DPO designado** si procesás large-scale personal data (GDPR).
- ✅ **Data residency** documentada (EU data in EU regions, US in US).
- ✅ **Vendor management** con TPRM automatizado (security questionnaires + SOC 2 reports on file).
- ✅ **Annual pen testing** por firm externa (Bishop Fox, NCC Group, Cure53) + evidence al auditor.
- ✅ **Incident response runbook** documentado + tabletop exercises trimestrales.
- ✅ **Policy-as-code** enforcea controles automáticamente (ver [cap 25](./25-policy-as-code-opa-kyverno.md)).

### Anti-patterns

- ❌ CloudTrail solo en una región → 6 regiones sin logs.
- ❌ S3 audit logs sin Object Lock → atacante los borra post-breach.
- ❌ Sin log file validation → tampering indetectable.
- ❌ Guardar cardholder data en tu BD "encriptada" pensando que ya cumplís PCI-DSS.
- ❌ Comprar SOC 2 templates y copiarlas sin implementar realmente.
- ❌ Screenshots manuales de configs en vez de continuous evidence.
- ❌ Ignorar drift 6 meses y sorprenderse en el audit.
- ❌ Root AWS account sin MFA + con access keys.
- ❌ Vendor risk management via email + spreadsheet.
- ❌ Sin BAA con cloud provider + procesando PHI.
- ❌ GDPR "acatado" con un cookie banner y nada más.
- ❌ Compliance como oneshot anual, no continuous.
- ❌ Sin pen test anual + auditor lo detecta.

### Framework decision matrix

| Vendés a... | Framework prioritario |
|---|---|
| B2B SaaS US enterprise | SOC 2 Type II |
| B2B SaaS EU/global | ISO 27001 + SOC 2 |
| Procesás pagos | PCI-DSS (idealmente SAQ A vía Stripe) |
| Healthcare US | HIPAA + BAA con cloud |
| Empresas EU o customers EU | GDPR (siempre) |
| Startups CA vendendo B2C | CCPA/CPRA |
| Gov US contractors | FedRAMP (moderate o high) |
| Fintech UK | FCA + ISO 27001 |

---

## 7. Casos reales industria 2023-2026

**Drata (fundada 2020):** de zero a unicornio en 18 meses. $200M Series B a $2B valuation en 2022. En marzo 2026 lanzó **Agentic TPRM** + **Agentic Questionnaire Response** — LLMs autocompletan security questionnaires. **Lección:** la categoría GRC automation sigue creciendo porque toda B2B startup necesita SOC 2.

**Vanta AI Agent (GA 2025):** primer "agentic trust platform" comercial. Draft policies, evidence checks, questionnaire responses, issue remediation vía LLM. **Lección:** compliance workflows son perfectos para agentic AI (repetitivos, estructurados, high ROI).

**Sprinto scaling en 2026:** dominio india + expansión US/EU con pricing 40-60% bajo de Drata/Vanta. Modelo offshoring + heavy automation. **Lección:** hay espacio para plataforma más económica para startups earlier stage.

**Capital One breach (2019):** WAF misconfigured expuso 100M+ registros. Fue CloudTrail lo que permitió reconstruir la timeline forense (IPs Tor de la atacante, exact API calls). AWS habilitó CloudTrail management events **por default** para nuevas cuentas en 2023 como respuesta. **Lección:** CloudTrail no es opcional, es infraestructura vital.

**SolarWinds supply chain compromise (2020):** puso en la agenda SLSA + provenance + attestations. Compliance frameworks (SOC 2 2022 revision, NIST SP 800-161) incorporaron supply chain requirements. **Lección:** compliance evoluciona con las amenazas — post-SolarWinds es standard requerir SBOM.

**Colonial Pipeline ransomware (2021):** paralización de infraestructura crítica USA por 6 días. Post-mortem señaló falta de MFA en VPN legacy, IR runbook débil, backup strategy fallada. **Lección:** IR + BC/DR + MFA everywhere son controles no-negociables.

**Airbnb multi-attestation strategy (2023+):** SOC 2 + ISO 27001 + ISO 27017 + ISO 27018 + ISO 27701 + PCI-DSS. **Compliance moat**: enterprise + gov customers no evalúan competencia sin compliance base. **Lección:** compliance como differenciador comercial B2B.

**Post-Schrems II + DPF (2023):** rehabilitación de transferencias US-EU via Data Privacy Framework certification. Miles de SaaS US se certificaron. **Lección:** el regulatory landscape cambia; compliance officer debe mantenerse informado.

**PCI-DSS v4.0 fully effective marzo 2024:** adopción masiva de Stripe/Braintree/Adyen para reducir scope a SAQ A. **Lección:** delegar es la estrategia dominante para PCI moderno.

**Vanta AI Agent + Drata Agentic TPRM (2025-2026):** agentic compliance es el nuevo baseline. Auditors aceptan evidence generado y curated por AI (con human-in-the-loop). **Lección:** la próxima ola de compliance automation es agentic.

**GitHub audit log streaming to Splunk/Datadog (patrón 2024+):** empresas enterprise stream github audit log a SIEM para correlacionar con CloudTrail + K8s audit. **Lección:** audit correlation cross-source es el next level de detection.

---

## 8. Ejercicios prácticos

### Ejercicio 1: setup CloudTrail organization trail con Object Lock

**Objetivo:** desplegar trail multi-región + S3 con Object Lock compliance mode + KMS + log file validation.

**Setup:** cuenta AWS Organizations, log-archive account separada, Terraform.

**Pasos:**
1. Crear KMS key para audit logs con key policy restrictiva.
2. Bucket S3 con Object Lock enabled + retention 7 años COMPLIANCE.
3. Bucket policy que permite CloudTrail writing (`AWSCloudTrailAclCheck` + `AWSCloudTrailWrite`).
4. Trail: multi-region, is_organization_trail, enable_log_file_validation, data events S3 para bucket customer-data.
5. CloudTrail Lake event data store.
6. SCP org-level bloqueando `cloudtrail:StopLogging` + `DeleteTrail`.

**Criterios de éxito:**
- [ ] `aws cloudtrail describe-trails --name linguadev-org-trail` retorna `IsMultiRegionTrail: true, LogFileValidationEnabled: true`.
- [ ] Intentar borrar un log object retorna `ObjectLockConfiguration prevents deletion`.
- [ ] SCP bloquea `aws cloudtrail stop-logging` incluso desde root de una account child.
- [ ] Query CloudTrail Lake retorna eventos en <5s.

**Bonus:** agregar CloudWatch metric filter que alerta cuando alguien intenta stop-logging.

---

### Ejercicio 2: Prowler audit + remediation

**Objetivo:** correr Prowler contra tu cuenta AWS, identificar top-10 findings críticos y remediarlos.

**Setup:** cuenta AWS con recursos, Prowler 4.6+.

**Pasos:**
1. `prowler aws --compliance cis_2.0_aws soc2_aws -M csv,html --output-directory reports/`.
2. Abrir `reports/prowler-output-*.html` y filtrar por severity `critical` + `high`.
3. Documentar 10 findings + owner + fecha de remediation esperada.
4. Remediar 3: enable S3 encryption default, rotate access keys > 90 días, add public access block a buckets.
5. Re-run Prowler y verificar que los 3 findings ya no aparecen.

**Criterios de éxito:**
- [ ] Reporte HTML generado con findings claros.
- [ ] Documento Markdown con 10 findings + owners.
- [ ] 3 findings remediados verificable en re-run.
- [ ] Screenshot del diff (antes/después).

**Bonus:** integrar Prowler en GitHub Actions cron diario + alerta Slack si findings críticos aumentan.

---

### Ejercicio 3: Chef InSpec compliance profile para SOC 2

**Objetivo:** escribir InSpec profile con 5 controles SOC 2 y correrlo generando evidence firmado.

**Setup:** InSpec instalado + AWS credentials.

**Pasos:**
1. Crear `controls/soc2.rb` con 5 controles: CC6.1 (encryption at rest), CC6.6 (MFA), CC7.2 (CloudTrail), CC6.8 (unauth prevention), CC7.4 (change management via git).
2. `inspec exec ./controls -t aws:// --reporter=json:evidence.json cli`.
3. Firmar evidence con Cosign.
4. Upload a S3 bucket con Object Lock.
5. Documentar cómo el auditor accederia al evidence.

**Criterios de éxito:**
- [ ] 5 controles definidos correctamente.
- [ ] Evidence JSON generado con timestamp + result de cada control.
- [ ] Firma Cosign verificable con `cosign verify-blob`.
- [ ] S3 upload con Object Lock retention 7 años.
- [ ] Runbook Markdown para el auditor.

**Bonus:** correr InSpec en cronjob semanal + notificación Slack con delta vs semana anterior.

---

### Ejercicio 4: Steampipe queries para audit forense

**Objetivo:** escribir 5 queries SQL Steampipe que respondan preguntas típicas de auditor.

**Setup:** Steampipe + plugin AWS.

**Pasos:**
1. "¿Qué usuarios IAM no tienen MFA?"
2. "¿Qué buckets S3 son públicos?"
3. "¿Qué security groups permiten 0.0.0.0/0 en puertos administrativos (22, 3389, 5432, 3306)?"
4. "¿Qué RDS instances no tienen encryption at rest?"
5. "¿Qué IAM policies otorgan `*:*` (admin)?"

**Criterios de éxito:**
- [ ] 5 queries funcionan y retornan resultados accionables.
- [ ] Cada query tiene comment explicando qué compliance control satisface (SOC 2 CCx.x, CIS 1.x).
- [ ] Guardar las queries en un git repo con README de uso.

**Bonus:** integrar Steampipe con Grafana para dashboards de compliance posture.

---

### Ejercicio 5: setup Vanta/Drata/Sprinto trial y integración base

**Objetivo:** completar onboarding de una plataforma de compliance automation y integrar 3 systems.

**Setup:** trial de Vanta/Drata/Sprinto (o Secureframe).

**Pasos:**
1. Elegir framework: SOC 2 Type II (test scope).
2. Conectar AWS (read-only IAM role).
3. Conectar GitHub (org-level app installation).
4. Conectar Google Workspace o Okta (SSO + user directory).
5. Revisar dashboard: qué controles están ya "green" out of the box.
6. Documentar qué controles requieren evidence manual (screenshots, docs firmados).

**Criterios de éxito:**
- [ ] 3 integraciones activas y colectando evidence.
- [ ] Dashboard muestra al menos 40% controles automated.
- [ ] Lista de controles pending con owner asignado.
- [ ] Comparación con estimate de esfuerzo manual sin la plataforma.

**Bonus:** invitar a un CPA firm partner (Prescient/A-LIGN/Schellman) a demo del panel — pedirles quote SOC 2 Type II con y sin automation.

---

## 9. Recursos + siguientes pasos

**Frameworks oficiales:**
- [aicpa.org — SOC 2 Trust Services Criteria](https://www.aicpa.org/interestareas/frc/assuranceadvisoryservices/serviceorganization-smanagement.html)
- [iso.org — ISO/IEC 27001:2022](https://www.iso.org/standard/27001)
- [pcisecuritystandards.org — PCI-DSS v4.0](https://www.pcisecuritystandards.org)
- [gdpr.eu](https://gdpr.eu) — texto oficial + guías
- [hhs.gov — HIPAA](https://www.hhs.gov/hipaa)
- [nist.gov — Cybersecurity Framework 2.0](https://www.nist.gov/cyberframework)

**CSPM y compliance-as-code:**
- [prowler.com](https://prowler.com) — Prowler open source + comercial.
- [steampipe.io](https://steampipe.io) — SQL contra cloud APIs.
- [github.com/nccgroup/ScoutSuite](https://github.com/nccgroup/ScoutSuite) — multi-cloud audit.
- [community.chef.io/tools/chef-inspec](https://community.chef.io/tools/chef-inspec) — compliance-as-code veterano.
- [openscap.org](https://www.open-scap.org) — CIS benchmarks para servers.

**Plataformas de compliance automation:**
- [drata.com](https://drata.com), [vanta.com](https://vanta.com), [sprinto.com](https://sprinto.com), [secureframe.com](https://secureframe.com), [thoropass.com](https://thoropass.com), [scytale.ai](https://scytale.ai).

**CPA firms + assessors:**
- Big 4: Deloitte, EY, PwC, KPMG.
- Boutique: Prescient, A-LIGN, Schellman, Insight Assurance, PBSA, Sensiba.
- Multi-scheme (SOC 2 + ISO): BSI, DNV, DEKRA.

**Pen testing:**
- Bishop Fox, NCC Group, Cure53, Trail of Bits, Coalfire, TrustedSec, HackerOne (crowdsourced).

**Referencias adicionales:**
- Chef Community, *"Compliance as Code with InSpec"* (2015+) — pionero.
- CSA (Cloud Security Alliance), *"Cloud Controls Matrix v4"*.
- CNCF, *"Cloud Native Security Whitepaper"*.
- NIST SP 800-53 Rev 5 (control catalog) + SP 800-161 (supply chain).
- Verizon *"Data Breach Investigations Report"* (annual DBIR) — patrones de attackers.

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Auditá tu cuenta AWS con Prowler HOY — vas a encontrar 20+ findings.
- Habilitá CloudTrail organization trail + Object Lock si aún no lo tenés.
- Evaluá Drata/Vanta/Sprinto trial si vas hacia SOC 2/ISO en <12 meses.
- Documentá tu compliance posture en un runbook para el equipo.
- Continuá con [cap 27 — DNS y load balancing](./27-dns-y-load-balancing.md).

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas junior → mid → senior → staff. Cubren: SOC 2 (Type I vs II, TSC), CloudTrail y S3 Object Lock, ISO 27001:2022 vs SOC 2 (attestation vs certification), PCI-DSS v4.0 y scope reduction con Stripe, GDPR/CCPA data subject rights y breach notification, HIPAA + BAA + PHI, compliance automation platforms (Drata, Vanta, Sprinto, Secureframe, Thoropass), CSPM (Prowler, Steampipe, Scout Suite), Kubernetes audit logs, GitHub audit log streaming, drift detection, compliance-as-code con Chef InSpec, evidence collection continuo, cross-framework mapping, IR runbooks, pen testing periódico y anti-patterns (screenshots manuales, PCI scope creep, compliance as afterthought).

- **Fuente:** [`packages/content/src/tech/devops/sim-26-compliance-and-audit.json`](../../packages/content/src/tech/devops/sim-26-compliance-and-audit.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-26-compliance-and-audit`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 25 — Policy as Code con OPA y Kyverno](./25-policy-as-code-opa-kyverno.md) · [Índice](./README.md) · [Capítulo 27 — DNS y Load Balancing →](./27-dns-y-load-balancing.md)
