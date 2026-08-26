# Capítulo 10 — Arquitectura de seguridad: Zero Trust, secretos e IAM

> **Focus:** Diseñar sistemas donde la seguridad no vive en el perímetro sino en cada request. Zero Trust en serio, least privilege real, secretos gestionados, defensa en profundidad y una postura de threat modeling que aguante auditorías.
> **Áreas:** Security architecture · Networking · Resilience
> **Preguntas de práctica:** 25 · **Tiempo estimado:** 28 min · **Pass:** 75%
> **Nivel:** Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Conceptos base de red (subnet, security group, routing), TLS 1.3 y JWT.
- Nociones de IAM en AWS o GCP (roles, policies, principals).
- Bash y HCL (Terraform) básicos.
- Conocer HTTP, cookies, mismo-origen (SOP) y CORS.
- Idealmente haber leído [Cap 09 — Patrones cloud-native](./09-patrones-cloud-native.md) antes.

**Glosario mínimo:**
- **Zero Trust** — modelo arquitectural (NIST SP 800-207) donde nunca se asume confianza por ubicación de red; cada request se autentica, autoriza y cifra independientemente.
- **Least privilege** — otorgar el mínimo permiso necesario para hacer el trabajo y por el mínimo tiempo posible.
- **Defense in depth** — múltiples controles independientes en capas; si uno falla, el siguiente contiene el daño.
- **KMS** (Key Management Service) — servicio que custodia claves criptográficas maestras y realiza operaciones sin exponer el material.
- **Envelope encryption** — cifrar datos con una *Data Encryption Key* (DEK) y cifrar esa DEK con una *Key Encryption Key* (KEK) que vive en KMS.
- **mTLS** — TLS mutuo: cliente y servidor presentan certificado y se validan mutuamente.
- **STRIDE** — taxonomía de amenazas de Microsoft: *Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege*.
- **SBOM** (Software Bill of Materials) — inventario firmado de todas las dependencias binarias de un artefacto.
- **SLSA** — *Supply-chain Levels for Software Artifacts*; framework de OpenSSF para atestiguar cómo se construyó un artefacto.
- **PII** — *Personally Identifiable Information*; datos que identifican a una persona directa o indirectamente.

**Setup mínimo:**

```bash
# CLI de AWS con perfil dedicado a auditoría (solo lectura)
aws configure --profile audit-ro
aws iam get-account-summary --profile audit-ro

# Herramientas de análisis estático de IAM y policies
pip install checkov
brew install tfsec         # o: curl -s https://raw.githubusercontent.com/aquasecurity/tfsec/master/scripts/install_linux.sh | bash
brew install trivy         # SBOM + vuln scanning

# Vault en local para experimentar (dev mode, NUNCA en prod)
docker run --rm --name vault -p 8200:8200 \
  -e 'VAULT_DEV_ROOT_TOKEN_ID=root' hashicorp/vault:1.18
export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=root
vault status

# Generar un SBOM de tu propia app
syft dir:. -o cyclonedx-json > sbom.cdx.json
grype sbom:sbom.cdx.json    # scan de vulnerabilidades sobre el SBOM

# Ver quién tiene qué en AWS (Access Analyzer)
aws accessanalyzer list-analyzers
aws accessanalyzer list-findings --analyzer-arn "$ARN"
```

---

## 1. El gran cuadro

Durante veinte años la seguridad corporativa vivió del *perímetro*: un firewall enorme protegía el "dentro" del "fuera". La red interna se consideraba de confianza y bastaba con parar al atacante en el borde. Ese modelo se rompió por tres razones convergentes: (a) el trabajo remoto disolvió el borde físico, (b) el cloud volatilizó la topología (no hay un rack donde está tu "dentro"), y (c) los ataques laterales tras compromisos iniciales —Target 2013 vía credenciales de un proveedor HVAC, SolarWinds 2020 vía cadena de suministro, Colonial Pipeline 2021 vía VPN sin MFA— demostraron que "una vez dentro, todo cae". La respuesta arquitectural es **Zero Trust** (formalizado por NIST en la SP 800-207 de 2020 y con la variante multi-cloud SP 800-207A de 2023): nunca asumas confianza por ubicación; cada request se autentica y autoriza contra la identidad del solicitante y el contexto del recurso.

El segundo pilar es **least privilege real**, no cosmético. Estudios repetidos de CyberArk y CIEM muestran que más del 80% de los permisos otorgados en cloud nunca se usan; los `*` en el `Action` o el `Resource` de una policy IAM son la vía preferida para escalado de privilegios post-compromiso. Capital One (2019) perdió 100 millones de registros porque una vulnerabilidad SSRF sumada a un rol excesivamente permisivo permitió enumerar y exfiltrar buckets S3 completos. La disciplina moderna consiste en generar policies a partir de uso real (AWS IAM Access Analyzer), usar SCPs (*Service Control Policies*) como *guardrails* organizacionales y eliminar credenciales estáticas de larga vida a favor de identidades de workload (IRSA en EKS, *Workload Identity* en GKE, OIDC federation desde GitHub Actions).

El tercer pilar es la **gestión de secretos**: pasar del `.env` commitado a git —o de la variable de entorno pasada a mano— a un sistema centralizado con rotación automatizada y auditoría (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager). El estado del arte de 2026 combina **secretos dinámicos** (Vault genera credenciales de base de datos por request con TTL de minutos) con **envelope encryption** basada en KMS y **rotación federada** vía OIDC. Los datos en reposo se cifran con jerarquías DEK/KEK, y los datos en tránsito se cifran punta a punta incluso dentro del VPC vía **mTLS**, típicamente automatizado con un service mesh (Istio en modo *ambient* alcanzó GA en noviembre de 2024 con solo 8% de overhead frente al 166% del modo *sidecar*; Linkerd sigue siendo el más liviano en p99).

El cuarto pilar es la **seguridad de la cadena de suministro**. Tras SolarWinds, Log4Shell y los repetidos ataques a npm/PyPI, la industria consolidó SBOM (*Software Bill of Materials*, con formatos CycloneDX y SPDX) y **SLSA** (*Supply-chain Levels for Software Artifacts*) como los estándares para atestiguar qué llevan tus artefactos y cómo se construyeron. La UE aplicará el **Cyber Resilience Act** a partir de 2027 exigiendo SBOM para software comercial; muchas empresas ya lo requieren contractualmente en 2026. Este capítulo cubre los cuatro pilares y termina con ejercicios reales aplicables a **LinguaDev Pro**.

---

## 2. Zero Trust en concreto (nivel básico → medio)

### 2.1 Qué NO es Zero Trust

- **No es "quitar la VPN".** BeyondCorp de Google acabó reemplazando la VPN interna con acceso por-app basado en identidad + dispositivo, pero eso es una consecuencia, no la definición.
- **No es "solo mTLS entre servicios".** mTLS es una pieza; hay muchas más.
- **No es "todo con MFA".** MFA es *autenticación fuerte*; Zero Trust incluye autenticación *y* autorización *y* micro-segmentación *y* verificación continua.
- **No es un producto que compras.** Cualquier vendedor que te venda "una solución Zero Trust" te miente por la mitad; Zero Trust es una postura arquitectural.

### 2.2 Los cinco principios de NIST SP 800-207

1. **Toda fuente de datos y servicio de cómputo se considera un recurso.**
2. **Toda comunicación se asegura sin importar la ubicación de red.**
3. **El acceso a recursos se otorga por sesión** (no por sesión de red persistente).
4. **El acceso se determina por una política dinámica** que incluye identidad, dispositivo, contexto y sensibilidad del recurso.
5. **La empresa monitoriza y mide continuamente** la integridad y postura de todos los activos.

La SP 800-207A (2023) extiende esto explícitamente a arquitecturas multi-cloud con enforcement granular a nivel de aplicación.

### 2.3 Los componentes que necesitas

Un despliegue Zero Trust típico combina:

| Capa | Ejemplos concretos |
| --- | --- |
| Identidad fuerte | SSO (OIDC/SAML) + MFA obligatorio + hardware keys FIDO2/WebAuthn |
| Postura de dispositivo | EDR + device compliance (Jamf, Intune) + certificado de dispositivo |
| Autorización fina | OPA, Cedar (AWS), Zanzibar-style (SpiceDB), políticas declarativas |
| Micro-segmentación | Service mesh con mTLS (Istio ambient, Linkerd) + NetworkPolicy en K8s |
| Verificación continua | SIEM (Elastic, Splunk) + UEBA + reautenticación por cambio de contexto |
| Cifrado ubicuo | TLS 1.3 en tránsito, envelope encryption en reposo, mTLS interno |
| Acceso privilegiado | PAM con JIT/JEA (Vault, Teleport) — nada de "admin permanente" |

### 2.4 Ejemplo: policy dinámica con Cedar

Cedar es el lenguaje de autorización open-source que AWS liberó en 2023 y que impulsa Amazon Verified Permissions. Permite políticas legibles con contexto rico:

```cedar
// Solo un profesor puede leer las respuestas de un estudiante si
// pertenece al mismo tenant, la sesión es reciente (<5 min) y el
// dispositivo está en compliance.
permit (
  principal in Group::"teachers",
  action == Action::"readAnswers",
  resource is Student
)
when {
  principal.tenantId == resource.tenantId &&
  context.session.ageMinutes <= 5 &&
  context.device.compliant == true
};

// Denegación explícita: nunca desde un país bloqueado, incluso si
// otra policy da permit.
forbid (
  principal,
  action,
  resource
)
when {
  context.request.country in ["KP", "IR"]
};
```

La ventaja arquitectural: la lógica de autorización sale del código de negocio y vive en un servicio central auditado; los cambios de política no requieren redeploy de las apps.

### 2.5 Auditoría de una decisión Zero Trust

Cada request autorizada debería producir un evento firmado con: `who` (identidad), `what` (recurso), `how` (política aplicada), `context` (IP, device, geo, hora), `decision` (permit/deny), `reason` (política concreta). Con esto puedes reconstruir cualquier acceso ante un auditor SOC2/ISO 27001 y detectar patrones anómalos ex-post.

---

## 3. IAM y least privilege real (nivel medio)

### 3.1 Anti-patrones que deberían estar prohibidos

- `"Action": "*"` sobre `"Resource": "*"` — acceso total; no debería existir jamás en producción.
- `"Action": "s3:*"` — "necesito subir un archivo" no justifica poder borrar el bucket de backups.
- `"iam:PassRole": "*"` — escalado de privilegios trivial (asumir cualquier rol).
- `NotAction` — lógica invertida difícil de razonar; casi siempre es un bug.
- Trust policies con `"AWS": "*"` — cualquier cuenta puede asumir el rol.

### 3.2 Terraform: IAM policy correcto para una Lambda

Este es el patrón realista para la Lambda que ingesta ejercicios de LinguaDev Pro y escribe a DynamoDB + emite eventos a EventBridge:

```hcl
# Rol de ejecución de la Lambda de ingesta
resource "aws_iam_role" "ingest_exec" {
  name = "ld-ingest-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
        }
      }
    }]
  })
  permissions_boundary = aws_iam_policy.ld_boundary.arn
}

# Policy inline: solo lo necesario, con Resource concreto y Conditions
resource "aws_iam_role_policy" "ingest_exec_inline" {
  name = "ld-ingest-least-priv"
  role = aws_iam_role.ingest_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteExercisesTableOnly"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:BatchWriteItem"
        ]
        Resource = aws_dynamodb_table.exercises.arn
        Condition = {
          "ForAllValues:StringEquals" = {
            "dynamodb:LeadingKeys" = ["EXERCISE#"]
          }
        }
      },
      {
        Sid    = "EmitDomainEvents"
        Effect = "Allow"
        Action = "events:PutEvents"
        Resource = aws_cloudwatch_event_bus.domain.arn
        Condition = {
          StringEquals = {
            "events:source" = "linguadev.ingest"
          }
        }
      },
      {
        Sid    = "DecryptDekViaKms"
        Effect = "Allow"
        Action = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.pii.arn
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:tenant" = "$${aws:PrincipalTag/tenant}"
          }
        }
      },
      {
        Sid    = "WriteLogsSameFunctionOnly"
        Effect = "Allow"
        Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/ld-ingest:*"
      }
    ]
  })
}

# Permission boundary organizacional: nadie en la cuenta puede
# saltarse esto, ni siquiera con un rol de admin comprometido.
resource "aws_iam_policy" "ld_boundary" {
  name = "ld-permission-boundary"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Deny", Action = "iam:*",     Resource = "*" },
      { Effect = "Deny", Action = "kms:Delete*", Resource = "*" },
      { Effect = "Deny", Action = "s3:*Bucket*", Resource = "*",
        Condition = { StringNotEquals = { "aws:ResourceTag/managed-by" = "terraform" } } }
    ]
  })
}
```

Puntos clave: (a) `AssumeRole` con `Condition SourceAccount` para prevenir *confused deputy*; (b) `Resource` concreto y `Condition` con `LeadingKeys` para permitir solo un prefijo lógico dentro de DynamoDB; (c) KMS decrypt limitado por **encryption context** que vincula el tenant; (d) *permission boundary* que la cuenta entera no puede superar. El escaneo con `tfsec` y `checkov` es obligatorio en CI.

### 3.3 Eliminar credenciales estáticas: OIDC federation

En GitHub Actions, en lugar de dejar `AWS_ACCESS_KEY_ID` como secret (rotable a mano, con riesgo de leak), configura OIDC y deja que cada workflow reciba credenciales de corta vida:

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push: { branches: [main] }

permissions:
  id-token: write   # necesario para OIDC
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gh-deploy-linguadev
          role-session-name: gh-${{ github.run_id }}
          aws-region: eu-west-1
      - run: aws sts get-caller-identity
      - run: terraform apply -auto-approve
```

Y el rol AWS con trust policy federada al OIDC de GitHub:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:linguadev/linguadev-pro:ref:refs/heads/main"
      }
    }
  }]
}
```

Efecto: cero secretos de larga vida en GitHub; cada run recibe credenciales AWS válidas 60 minutos scoped al repo y branch específicos. Un fork malicioso no puede asumir el rol porque el `sub` no encaja.

---

## 4. Gestión de secretos moderna (nivel medio → avanzado)

### 4.1 El espectro de opciones

| Opción | Cifrado real | Rotación | Auditoría | Ideal para |
| --- | --- | --- | --- | --- |
| `.env` en git | ❌ | ❌ | ❌ | Nunca |
| Env var vía consola | ❌ (plaintext en API) | Manual | Débil | Nunca en prod |
| K8s Secret (base64) | ❌ salvo etcd-at-rest | Manual | Débil | Baseline mínimo |
| Sealed Secrets (Bitnami) | ✅ asimétrico | Manual | Git-based | GitOps puro |
| AWS Secrets Manager | ✅ | Automática (Lambda) | CloudTrail | AWS-native |
| GCP Secret Manager | ✅ | Automática | Cloud Audit | GCP-native |
| HashiCorp Vault | ✅ + dynamic secrets | Automática + TTL | Nativa | Multi-cloud, enterprise |
| SPIFFE/SPIRE | Identidad de workload | N/A | Nativa | Cross-cluster/cloud |

### 4.2 Vault: política y secreto dinámico de base de datos

Ejemplo real de configuración de Vault 1.18 para generar credenciales de Postgres con TTL de 5 minutos, revocación automática y auditoría completa:

```hcl
# 1. Habilitar el database secrets engine
vault secrets enable database

# 2. Conectar a Postgres con un usuario "root" que solo Vault usa
vault write database/config/linguadev-pg \
  plugin_name=postgresql-database-plugin \
  allowed_roles="app-read,app-write" \
  connection_url="postgresql://{{username}}:{{password}}@pg.internal:5432/linguadev?sslmode=require" \
  username="vault_admin" \
  password="$(cat /run/secrets/vault_admin_pg)"

# 3. Definir un rol que genera un usuario ephemeral por request
vault write database/roles/app-read \
  db_name=linguadev-pg \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; \
                        GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="5m" \
  max_ttl="1h"
```

Y la política que permite a la app leer credenciales de ese rol y nada más:

```hcl
# policies/app-read.hcl
path "database/creds/app-read" {
  capabilities = ["read"]
}

path "sys/leases/renew" {
  capabilities = ["update"]
}
```

La app pide credenciales con `vault read database/creds/app-read`; Vault ejecuta el `CREATE ROLE`, devuelve `username`+`password`+`lease_id`, y a los 5 minutos ejecuta un `DROP ROLE` automáticamente. Si un atacante roba las credenciales de un dump de memoria, tienen ventana de minutos en lugar de indefinida.

### 4.3 Envelope encryption con AWS KMS

Nunca cifres 10 GB de datos directamente con KMS (lento, caro, límites de tamaño). El patrón correcto:

```python
# python 3.12, boto3 1.35+
import boto3, os, json
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

kms = boto3.client("kms")
KEY_ARN = os.environ["KMS_KEY_ARN"]

def encrypt_pii(plaintext: bytes, tenant_id: str) -> dict:
    # 1) Pedir a KMS una DEK (data key) de 256 bits
    r = kms.generate_data_key(
        KeyId=KEY_ARN,
        KeySpec="AES_256",
        EncryptionContext={"tenant": tenant_id},   # bind al tenant
    )
    dek_plain = r["Plaintext"]        # solo en memoria, nunca a disco
    dek_wrapped = r["CiphertextBlob"] # esto se persiste con el dato

    # 2) Cifrar el payload con AES-GCM localmente
    nonce = os.urandom(12)
    ct = AESGCM(dek_plain).encrypt(nonce, plaintext, tenant_id.encode())
    del dek_plain  # zero from memory ASAP

    return {
        "ciphertext": ct,
        "nonce": nonce,
        "wrapped_dek": dek_wrapped,
        "tenant": tenant_id,
        "alg": "AES-256-GCM",
        "kms_key": KEY_ARN,
    }

def decrypt_pii(blob: dict) -> bytes:
    r = kms.decrypt(
        CiphertextBlob=blob["wrapped_dek"],
        EncryptionContext={"tenant": blob["tenant"]},
    )
    dek_plain = r["Plaintext"]
    try:
        return AESGCM(dek_plain).decrypt(
            blob["nonce"], blob["ciphertext"], blob["tenant"].encode()
        )
    finally:
        del dek_plain
```

Ventajas concretas: (a) el 99% de las operaciones criptográficas son AES-GCM local (rápido, hardware-accelerated); (b) KMS solo interviene para *wrap/unwrap* de DEKs; (c) el `EncryptionContext` bindea el ciphertext al tenant y aparece en CloudTrail para auditoría; (d) rotar la KEK no obliga a re-cifrar los datos (rewrap sólo las DEKs).

### 4.4 Sealed Secrets para GitOps

Cuando quieres commitear secretos a git de forma segura (patrón GitOps con Flux/ArgoCD), Bitnami Sealed Secrets cifra con la clave pública del cluster:

```bash
# Cifrar un secreto con la key pública del cluster
kubectl create secret generic ld-openai-key \
  --from-literal=OPENAI_API_KEY=sk-real-value \
  --dry-run=client -o yaml \
| kubeseal --format yaml --controller-name=sealed-secrets \
> sealed-openai-key.yaml

# Ahora sealed-openai-key.yaml puede commitearse; solo el
# controller en el cluster puede descifrarlo con su private key.
git add sealed-openai-key.yaml && git commit -m "add sealed openai key"
```

El controller decodifica y crea el `Secret` real dentro del cluster; el ciphertext en git es inútil sin la clave privada del cluster.

---

## 5. Defense in depth y threat modeling STRIDE (nivel medio)

### 5.1 STRIDE, cabina rápida

STRIDE (Microsoft, 1999) sigue siendo la taxonomía más usada porque cubre casi todo lo relevante:

| Letra | Amenaza | Propiedad violada | Mitigación típica |
| --- | --- | --- | --- |
| **S** | Spoofing | Authentication | MFA, mTLS, firmas |
| **T** | Tampering | Integrity | HMAC, firmas, WORM logs |
| **R** | Repudiation | Non-repudiation | Audit trail firmado, transacciones |
| **I** | Information disclosure | Confidentiality | Cifrado, RBAC, redacción |
| **D** | Denial of Service | Availability | Rate limit, autoscaling, WAF, load-shedding |
| **E** | Elevation of privilege | Authorization | Least privilege, sandboxing, permission boundaries |

### 5.2 Data Flow Diagram y trust boundaries

El truco práctico: dibuja los componentes y las flechas de datos entre ellos. Cada vez que una flecha cruza un **trust boundary** (Internet → tu backend, tu backend → una API de terceros, tu app → una BD compartida), pregúntate las seis letras.

```
+------------+       HTTPS        +---------+         mTLS         +--------+
|  Browser   |------------------->|   BFF   |--------------------->| Postgres |
+------------+                    +---------+                      +--------+
      ^                                |                                |
      |  cookie httpOnly               | KMS decrypt (EncCtx=tenant)    |
      |  Secure, SameSite=Lax          v                                |
      |                          +----------+                           |
      |                          |   KMS    |                           |
      |                          +----------+                           |
      |                                                                 |
      |     LLM completions (OpenAI, Anthropic)                         |
      +-----------------[ trust boundary externo ]---------------------+
```

En LinguaDev Pro los tres *trust boundaries* más críticos son: (1) navegador → BFF (aquí S, T, D dominan: MFA, CSRF token, rate limit); (2) BFF → LLM externo (I domina: no mandes PII, filtra prompts); (3) BFF → Postgres (E, I dominan: mTLS, least privilege por rol app, envelope encryption para PII).

### 5.3 Un modelo STRIDE aplicable a LinguaDev Pro

| Componente | S | T | R | I | D | E |
| --- | --- | --- | --- | --- | --- | --- |
| Login flow | MFA + WebAuthn | JWT firmado RS256 | audit log firmado | password hash Argon2id | rate limit por IP + user | permission boundary IAM |
| Envío de speech al LLM | mTLS al LLM proxy | HMAC del payload | trace_id inmutable | redact PII antes de llamar | circuit breaker + fallback | egress policy por namespace |
| Escritura en Postgres | mTLS + cert por servicio | transactional outbox | audit table append-only | column-level encryption para email | connection pool con límite | rol `app_write` sin DDL |

### 5.4 Layers concretas: cinco anillos que un atacante debe romper

1. **Edge:** WAF (AWS WAF, Cloudflare) con reglas gestionadas OWASP + DDoS L3/L4 + bot mitigation.
2. **API Gateway:** autenticación (JWT/OIDC), rate limiting por API key + por IP, schema validation.
3. **Aplicación:** input validation, output encoding, parameterized queries (jamás concatenar SQL), context-aware sanitization.
4. **Datos:** parameterized queries + rol DB con permisos mínimos (no `DROP TABLE`), envelope encryption para PII, replicación cifrada.
5. **Observabilidad:** logs firmados, alertas por anomalía (Falco, GuardDuty), correlación por SIEM.

Ninguna capa se fía de la anterior. Un WAF no exime al backend de validar entrada; un firewall no exime a los pods de mTLS.

---

## 6. Red y mTLS con service mesh (nivel avanzado)

### 6.1 VPC design canónico

El patrón *3-tier* sigue siendo la referencia. Para tres AZs:

```
                       Internet
                          |
                       [ALB / NLB]                            (public subnets)
                          |
      +-------------------+-------------------+
      |                                       |
  [app tier a1]  [app tier a2]  [app tier a3] (private subnets, egress NAT)
      |                                       |
  [data tier a1] [data tier a2] [data tier a3] (isolated subnets, NO egress)
                          |
                    VPC Endpoints (Gateway: S3/DDB, Interface: KMS/SM/STS)
```

Reglas: (1) *public* solo aloja balancers y NAT; (2) *private* corre los pods/Lambdas; (3) *isolated* aloja RDS/Aurora/ElastiCache y no tiene ruta a Internet; (4) Security Groups por instancia (stateful, deny-by-default), (5) NACLs por subnet como *backstop*; (6) VPC Endpoints para todo servicio AWS accedido con frecuencia (ahorro real en NAT gateway data cost).

### 6.2 Security Groups vs NACLs, la distinción que se olvida

| | Security Group | NACL |
| --- | --- | --- |
| Nivel | Instancia/ENI | Subnet |
| Estado | Stateful (return traffic implícito) | Stateless (necesitas allow return) |
| Reglas | Allow only | Allow + Deny |
| Evaluación | Todas las reglas se evalúan | En orden por número |
| Uso típico | Control fino de acceso servicio-a-servicio | Backstop, bloquear IPs conocidas |

En 90% de los casos con Security Groups + rutas correctas + IAM basta. Los NACLs son útiles para bloquear rangos de IP maliciosos a nivel subnet sin tocar cada SG.

### 6.3 mTLS interno con Istio ambient

Antes de 2024, la crítica principal a Istio era el overhead del sidecar Envoy (memoria + latencia + operación). El modo **ambient** —GA en noviembre de 2024— elimina el sidecar y mueve L4/mTLS a un DaemonSet llamado *ztunnel* por nodo, con *waypoint proxies* opcionales solo cuando necesitas políticas L7. Los benchmarks reportan **8% de overhead p99 para mTLS en ambient vs 166% en modo sidecar tradicional**.

Habilitar ambient en un namespace:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: linguadev-prod
  labels:
    istio.io/dataplane-mode: ambient
```

Y una política de autorización que restringe qué servicios pueden llamar al BFF:

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: bff-only-from-web
  namespace: linguadev-prod
spec:
  selector:
    matchLabels: { app: bff }
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/linguadev-prod/sa/web-frontend"]
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/v1/*"]
```

Linkerd sigue siendo la alternativa más liviana en single-tier (un proxy Rust por pod) con p99 ~11 ms mejor que ambient a 2000 rps en benchmarks recientes; la elección es más de operación que de rendimiento puro.

### 6.4 Cuando NO usar service mesh

- Menos de ~10 servicios y un solo cluster: mTLS con `cert-manager` + `trust-manager` puede ser suficiente y muchísimo más simple.
- App monolítica desplegada en Fargate detrás de un ALB: TLS end-to-end en el ALB target group basta.
- Equipo sin experiencia en Envoy/proxy debugging: introducir Istio en producción sin conocimiento es fuente garantizada de incidentes.

---

## 7. Gestión de PII y arquitectura de privacidad (nivel avanzado)

### 7.1 GDPR y CCPA a nivel arquitectural

Los tres requisitos que impactan la arquitectura son:

- **Derecho al olvido (art. 17 GDPR):** debes poder borrar todos los datos de un usuario en un plazo razonable, incluidos los replicados en warehouse, logs y backups. Diseña con **crypto-shredding**: cifra los datos de cada usuario con una DEK distinta, y "borrar" = destruir la DEK. Los backups pasan a ser ilegibles automáticamente.
- **Portabilidad (art. 20):** exportar en formato estructurado. Diseña un endpoint `/me/export` que agregue todos los datos y firme el zip.
- **Minimización (art. 5.1.c):** no colecciones lo que no necesitas. Cada campo PII debería tener un "por qué" documentado y una TTL asignada.

### 7.2 Patrón de tokenización para PII

Una técnica arquitectural potente: el sistema operativo maneja **tokens opacos**; solo un servicio dedicado (*PII vault*) puede detokenizar. Bases de datos, logs, warehouse y colas de eventos guardan tokens, no PII.

```
Cliente -> BFF -> PII Vault: detokenize(tok_a1b2c3) -> email real
                    |
                    v
             Log de aplicación: user=tok_a1b2c3 acción=login   (SEGURO)
```

Efecto: un dump de la BD principal filtra tokens, no emails. Un log leak es inservible. El PII vault se audita minuciosamente, se aísla en su propia VPC y se accede solo por servicios autorizados.

### 7.3 Redacción de PII antes de enviar a LLM externo

En LinguaDev Pro los prompts que van a OpenAI/Anthropic no deben contener PII salvo consentimiento explícito. Un middleware simple:

```python
import re
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine

analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

EMAIL_RE = re.compile(r"[\w\.-]+@[\w\.-]+\.\w+")

def redact_before_llm(prompt: str) -> tuple[str, dict]:
    results = analyzer.analyze(text=prompt, language="en",
                               entities=["EMAIL_ADDRESS", "PHONE_NUMBER",
                                         "PERSON", "CREDIT_CARD", "IBAN_CODE"])
    anon = anonymizer.anonymize(text=prompt, analyzer_results=results)
    return anon.text, {"redactions": [r.entity_type for r in results]}

# uso:
safe_prompt, meta = redact_before_llm(user_input)
if meta["redactions"]:
    log.info("redacted %s", meta["redactions"])
llm.complete(safe_prompt)
```

Con Presidio (Microsoft, open source) detectas y anonimizas antes de la llamada externa. Registra qué se redactó para poder investigar falsos positivos.

---

## 8. Supply chain security: SBOM, SLSA y firma de artefactos (nivel avanzado)

### 8.1 SBOM en tu pipeline

Genera un SBOM en cada build y súbelo como artefacto:

```yaml
# .github/workflows/build.yml (extracto)
- name: Generar SBOM (CycloneDX)
  uses: anchore/sbom-action@v0
  with:
    format: cyclonedx-json
    output-file: sbom-${{ github.sha }}.cdx.json
    upload-artifact: true

- name: Scan de vulnerabilidades del SBOM
  uses: anchore/scan-action@v3
  with:
    sbom: sbom-${{ github.sha }}.cdx.json
    fail-build: true
    severity-cutoff: high
```

### 8.2 SLSA: atestiguar el build

SLSA v1.2 (2025) define niveles progresivos:
- **L1:** el build produce provenance (metadatos: qué source, qué builder, qué args).
- **L2:** provenance firmada por un servicio de build "hosted" (no un runner ad-hoc).
- **L3:** builder aislado (efímero, no persistente entre builds), non-falsifiable provenance.
- **L4:** two-person review + reproducible builds (raro en la práctica).

Con `slsa-github-generator` en GitHub Actions logras L3 sin escribir código propio:

```yaml
jobs:
  build:
    outputs:
      digest: ${{ steps.hash.outputs.digest }}
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t app:${{ github.sha }} .
      - id: hash
        run: echo "digest=$(docker inspect --format='{{index .RepoDigests 0}}' app:${{ github.sha }})" >> $GITHUB_OUTPUT

  provenance:
    needs: [build]
    permissions:
      actions: read
      id-token: write
      contents: write
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v2.0.0
    with:
      image: app
      digest: ${{ needs.build.outputs.digest }}
      registry-username: ${{ github.actor }}
```

### 8.3 Firma con Sigstore/cosign

`cosign` firma imágenes de contenedor sin llaves persistentes (usando OIDC de GitHub como identidad):

```bash
# Firmar en CI, sin manejar keys
cosign sign --yes ghcr.io/linguadev/bff@sha256:abc123...

# Verificar antes de deployar
cosign verify \
  --certificate-identity-regexp "https://github.com/linguadev/.*" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/linguadev/bff@sha256:abc123...
```

Combinado con una `ImagePolicyWebhook` en Kubernetes o una policy en Kyverno/Gatekeeper puedes rechazar en admisión cualquier imagen no firmada por tu pipeline.

### 8.4 EU Cyber Resilience Act (aplicación 2027)

El **CRA** entró en vigor en diciembre 2024 y sus obligaciones sustantivas se aplican progresivamente hasta diciembre de 2027. Impone: SBOM disponible por 5 años, notificación de vulnerabilidades explotadas activamente en 24h, "security by design" durante todo el ciclo de vida. Multas hasta 15 M EUR o 2,5% del turnover global. Si vendes software en la UE, la política de "software as-is, no warranty" deja de ser suficiente.

---

## 9. Aplicación a LinguaDev Pro (nivel avanzado)

Un ejercicio integrado: modela la arquitectura de seguridad de la app.

### 9.1 Boundary map

- **Público:** navegador móvil (PWA) → API pública.
- **Interno tenant-aware:** BFF, servicio de speech, servicio de ejercicios.
- **Datos regulados:** Postgres (usuarios, respuestas), Redis (sesiones), S3 (uploads audio).
- **Externo:** OpenAI/Anthropic para completions, Twilio para SMS/OTP.

### 9.2 Controles por capa (LinguaDev-specific)

- **Edge:** CloudFront + AWS WAF con reglas *AWSManagedRulesCommonRuleSet* + rate limit 100 rps por IP + geoblock (KP, IR).
- **Auth:** Cognito con MFA obligatorio para cuentas *teacher*; WebAuthn (passkeys) para *student premium*. Access token 5 min + refresh token 30 días revocable.
- **API:** API Gateway HTTP con Lambda authorizer (Cedar policy), request validation por JSON Schema.
- **App:** cada Lambda con rol IAM específico (least priv), permission boundary a nivel cuenta.
- **Servicio LLM:** dedicated egress vía NAT con IP fija, Presidio en el path, prompt firmado HMAC para trazabilidad.
- **Datos:** RDS Postgres con IAM auth, TDE con KMS CMK per-tenant, column-level encryption para `email` y `dob`, backups cifrados con CMK distinta.
- **Observabilidad:** CloudTrail data events on, GuardDuty on, Security Hub con CIS Benchmark, alertas a PagerDuty.

### 9.3 Runbook de compromiso (extracto)

Ante sospecha de credenciales comprometidas de un rol:

1. `aws iam list-attached-role-policies --role-name $ROLE` → snapshot para forense.
2. `aws iam put-role-policy --role-name $ROLE --policy-name deny-all --policy-document file://deny-all.json` (allowlist vacía).
3. `aws sts get-session-token` invalidado por rotar la clave STS del rol.
4. Consultar CloudTrail: `LookupEvents` con filtro `EventName=AssumeRole` para las últimas 24h.
5. Rotar cualquier secreto que ese rol pudo haber leído.
6. Post-mortem público (para el equipo), no punitivo.

---

## 10. Ejercicios prácticos

Los ejercicios son verificables: cada uno tiene un criterio "verde" claro que puedes ejecutar tú mismo.

### 10.1 Auditoría IAM express (30 min)

**Objetivo:** encontrar tres policies con `Action: *` o `Resource: *` en tu cuenta de sandbox.

```bash
# Instala prowler v4+
pip install prowler
prowler aws --checks iam_policy_no_administrative_privileges \
             iam_policy_attached_only_to_group_or_roles \
             iam_root_hardware_mfa_enabled \
  --output-formats json-ocsf --output-directory ./out
jq '.[] | select(.status_code=="FAIL") | {name, resource_uid, message}' \
  ./out/*.json | head -50
```

**Verde:** obtienes ≥3 findings clasificados como `high`; para al menos uno de ellos escribes un ticket con la policy corregida (Terraform diff aplicable).

### 10.2 Vault dinámico contra Postgres local (45 min)

**Objetivo:** correr Vault en dev mode + Postgres en Docker, configurar el database secrets engine, obtener creds efímeras.

```bash
docker network create sec-lab
docker run -d --name pg --network sec-lab -e POSTGRES_PASSWORD=root postgres:16
docker run -d --name vault --network sec-lab -p 8200:8200 \
  -e VAULT_DEV_ROOT_TOKEN_ID=root hashicorp/vault:1.18

export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root
vault secrets enable database
vault write database/config/pg plugin_name=postgresql-database-plugin \
  allowed_roles="ro" \
  connection_url="postgresql://{{username}}:{{password}}@pg:5432/postgres?sslmode=disable" \
  username=postgres password=root
vault write database/roles/ro db_name=pg default_ttl=2m max_ttl=10m \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT pg_read_all_data TO \"{{name}}\";"

# Pide credenciales y úsalas
vault read database/creds/ro
```

**Verde:** logras conectarte a Postgres con las creds devueltas, esperas 3 minutos, y la reconexión falla con `password authentication failed` (Vault revocó el rol).

### 10.3 mTLS local con cert-manager y kind (60 min)

**Objetivo:** dos servicios en un cluster kind se hablan por mTLS con certificados emitidos automáticamente.

Instala `kind` + `cert-manager` + `trust-manager`, crea un `Issuer` self-signed, genera certificados con `Certificate` para dos deployments, monta como volúmenes y configura Nginx/Envoy para exigir mTLS.

**Verde:** un `curl` desde un pod sin certificado a otro pod obtiene `400 No required SSL certificate was sent`; el mismo curl con `--cert client.crt --key client.key` responde `200`.

### 10.4 SBOM + firma cosign de una imagen (30 min)

```bash
docker build -t ghcr.io/tuuser/testapp:v1 .
syft ghcr.io/tuuser/testapp:v1 -o cyclonedx-json > sbom.json
grype sbom:sbom.json --fail-on high
cosign sign --yes --key cosign.key ghcr.io/tuuser/testapp:v1
cosign verify --key cosign.pub ghcr.io/tuuser/testapp:v1
```

**Verde:** `cosign verify` responde con el payload de firma y `grype` reporta 0 vulnerabilidades `high`.

### 10.5 Threat modeling STRIDE para el flujo de login de LinguaDev Pro (45 min)

**Objetivo:** producir un DFD (data flow diagram) del login con OTP + un STRIDE matrix con al menos 12 amenazas identificadas y su mitigación arquitectural correspondiente.

**Verde:** entregas un `.drawio` (o Miro) con los nodos y flechas + una tabla en Markdown que para cada letra de STRIDE lista amenazas concretas, no genéricas ("SMS interceptación por SIM swap: mitigar con TOTP como fallback y device fingerprint"). Al menos dos amenazas deben tener acción arquitectural pendiente en el backlog.

### 10.6 Simulacro oficial

Cuando termines los ejercicios, resuelve el simulacro con los 25 escenarios reales de arquitectura de seguridad:

[`packages/content/src/tech/architecture/sim-10-security-architecture.json`](../../packages/content/src/tech/architecture/sim-10-security-architecture.json) — **id:** `architecture-sim-10-security-architecture`.

Cubre Zero Trust, IAM traps, gestión de secretos, JWT vs sessions, mTLS, VPC design, defense in depth, OWASP, rotación de credentials, cifrado at rest y varios más. Aspira al 75% o más antes de pasar al Cap 11.

---

## Navegación

- Anterior: [Cap 09 — Patrones cloud-native](./09-patrones-cloud-native.md)
- Siguiente: [Cap 11 — Lambda serverless en profundidad →](./11-lambda-serverless-profundo.md)
- [Índice](./README.md)
