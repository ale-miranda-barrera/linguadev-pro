# Capítulo 12 — Fundamentos de Terraform

> **Focus:** Infrastructure as Code declarativa con Terraform 1.10+ y OpenTofu 1.10+. HCL sintaxis y expresiones, providers y modules, state file (backends S3+DynamoDB o S3 native locking), workflow init/plan/apply, refactoring con `state mv`, `count` vs `for_each`, dynamic blocks, sensitive variables, imports, drift detection, Terragrunt, Terraform Cloud/Enterprise.
> **Áreas:** Infrastructure as Code · Cloud provisioning · Config management
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de nube AWS/GCP/Azure: VPC, subnets, IAM roles, S3, EC2 o equivalentes.
- Git (branches, PRs, code review) y CI/CD básico (ver [cap 04 — CI CD pipelines](./02-fundamentos-de-continuous-delivery.md)).
- Un mental model de "estado deseado vs estado real" (aprendido con Kubernetes en [cap 07](./07-fundamentos-kubernetes.md) ayuda).
- JSON/YAML lectura fluida.
- Bash y variables de entorno.

**Glosario mínimo:**
- **HCL** (HashiCorp Configuration Language): DSL declarativo. Bloques `TIPO "nombre" { atributos }`.
- **Provider**: plugin que sabe hablar con un cloud/SaaS. Ejemplos oficiales: `hashicorp/aws`, `hashicorp/google`, `hashicorp/azurerm`, `hashicorp/kubernetes`, `hashicorp/random`.
- **Resource**: unidad que Terraform crea/modifica/destruye. Ej.: `aws_s3_bucket`, `aws_iam_role`.
- **Data source**: lookup readonly. Ej.: `data "aws_ami" "ubuntu"`.
- **Module**: paquete reutilizable de resources con inputs/outputs. Locales (`./modules/vpc`) o del registry.
- **State**: archivo `terraform.tfstate` que mapea recursos del código a IDs reales del cloud. Sin state, Terraform no puede calcular diffs.
- **Backend**: dónde vive el state. `local` (fichero en disco), `s3`, `azurerm`, `gcs`, `remote` (Terraform Cloud), `http`.
- **Lock**: exclusión mutua sobre el state para evitar apply concurrentes. En backend S3 clásico se hace con DynamoDB; desde Terraform 1.10 (nov 2024) y OpenTofu 1.10 (jul 2025) hay **S3 native locking** con `use_lockfile = true`, sin DynamoDB.
- **Workspace**: mecanismo de Terraform para múltiples states dentro del mismo backend (típicamente `dev`, `staging`, `prod`).
- **Drift**: divergencia entre el estado real (cloud) y el declarado (state file + código).
- **Refresh**: operación que consulta el cloud y actualiza el state con lo que existe.
- **OpenTofu**: fork open source de Terraform bajo Linux Foundation (creado agosto 2023 tras cambio de licencia de HashiCorp). Versiones 1.9 y 1.10 introducen `for_each` en providers, OCI registry y OTel tracing.
- **Terragrunt**: wrapper de Terraform de Gruntwork que resuelve DRY entre stacks y environments.
- **Sentinel / OPA**: policy engines usados en Terraform Cloud/Enterprise y en pipelines OSS.

**Setup mínimo:**

```bash
# 1. Terraform 1.10+ o OpenTofu 1.10+ (recomendado en 2026)
brew install opentofu   # macOS
choco install opentofu  # Windows
# o Terraform oficial:
brew install hashicorp/tap/terraform
terraform version
# Terraform v1.10.x
tofu version
# OpenTofu v1.10.x

# 2. AWS CLI (asumiendo perfil "linguadev-sandbox")
aws configure --profile linguadev-sandbox
export AWS_PROFILE=linguadev-sandbox
aws sts get-caller-identity

# 3. Editor con soporte HCL: VSCode + extension "HashiCorp Terraform"
code --install-extension hashicorp.terraform

# 4. Bucket S3 para state remoto (bootstrap manual una sola vez)
aws s3api create-bucket --bucket linguadev-tfstate-eu-west-1 \
  --region eu-west-1 --create-bucket-configuration LocationConstraint=eu-west-1
aws s3api put-bucket-versioning --bucket linguadev-tfstate-eu-west-1 \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket linguadev-tfstate-eu-west-1 \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# 5. Tabla DynamoDB para lock (o skip si vas a usar S3 native locking de TF 1.10+)
aws dynamodb create-table --table-name linguadev-tflock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# 6. tflint y trivy (linting y security scanning para HCL)
brew install tflint
brew install trivy
tflint --version
trivy --version
```

---

## 1. El gran cuadro

Terraform inventó un patrón que hoy dominan la industria: **describir la infraestructura como código declarativo**, comparar contra un archivo de estado y aplicar solo el diff. Antes de Terraform (2014), la provisión de nube pasaba por consolas web con clicks manuales ("ClickOps"), plantillas CloudFormation gigantes específicas de AWS, o scripts imperativos en Bash/Python que había que hacer idempotentes a mano. Terraform introdujo tres ideas: (1) un lenguaje neutral (HCL) con providers plug-in para AWS, GCP, Azure, Cloudflare, Datadog y cientos más; (2) un archivo de estado que memoriza qué recurso del código corresponde a qué ID real; (3) un workflow uniforme (`init → plan → apply`) que hace el diff explícito y revisable en PR.

Doce años después, en 2026, el paisaje es más rico. **HashiCorp** cambió la licencia de Terraform a BSL en agosto 2023, y la comunidad respondió con **OpenTofu** —fork MPL 2.0 bajo Linux Foundation—. OpenTofu 1.9 introdujo `for_each` sobre bloques `provider` (crear un provider por región sin duplicación), y OpenTofu 1.10 (julio 2025) trajo **OCI registry** para módulos y providers, **S3 native locking** sin DynamoDB, y tracing experimental con OpenTelemetry. Terraform respondió con 1.10 (nov 2024) y 1.15 (jun 2026) cerrando el gap. Para greenfield en 2026, **OpenTofu es el default lower-risk** —CLI drop-in, providers compatibles, licencia OSI aprobada— aunque muchas empresas siguen con Terraform + Terraform Cloud por integración enterprise.

Encima de estos motores hay ecosistema. **Terragrunt** (Gruntwork) resuelve DRY entre stacks (`dev/eu-west-1/vpc`, `prod/us-east-1/vpc`). **Atlantis** y **Terraform Cloud** ejecutan `plan` en cada PR y comentan el diff en GitHub. **tflint** hace linting; **trivy** y **checkov** escanean por misconfigs de seguridad; **Sentinel** (HashiCorp) y **OPA/Conftest** aplican policies (ej. "prohibido crear buckets S3 públicos"). Los **modules** en Terraform Registry o GitHub —muchos mantenidos por comunidad, otros por AWS/Google— evitan reinventar VPCs, EKS clusters o RDS.

El impacto práctico: aprender Terraform es aprender a razonar sobre **estado**, no solo sintaxis. La mayoría de los bugs de un ingeniero junior en Terraform vienen de no entender el state file: alguien borra el archivo local y Terraform quiere crear todo de nuevo; dos personas hacen `apply` a la vez y corrompen el state; se importa mal un recurso y el próximo apply lo borra. Este capítulo cubre HCL, providers, state, modules, `count`/`for_each`, dynamic blocks, sensitive values, imports, refactoring, drift, y termina con ejercicios verificables sobre **LinguaDev Pro** para practicar cada patrón con manifiestos que corren de verdad.

---

## 2. HCL y el workflow básico (nivel básico)

### 2.1 Bloques y sintaxis

Un archivo `.tf` es una colección de bloques. Los tipos que verás cada día:

```hcl
# main.tf
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws    = { source = "hashicorp/aws",    version = "~> 5.70" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket       = "linguadev-tfstate-eu-west-1"
    key          = "envs/dev/main.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true   # S3 native lock (Terraform 1.10+ / OpenTofu 1.10+)
  }
}

provider "aws" {
  region  = var.region
  profile = "linguadev-sandbox"
  default_tags {
    tags = {
      Project     = "linguadev"
      Environment = var.env
      ManagedBy   = "terraform"
    }
  }
}

variable "region" {
  type        = string
  default     = "eu-west-1"
  description = "AWS region."
}

variable "env" {
  type    = string
  default = "dev"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be one of: dev, staging, prod."
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "assets" {
  bucket = "linguadev-assets-${var.env}-${random_id.suffix.hex}"
}

output "bucket_name" {
  value       = aws_s3_bucket.assets.id
  description = "Nombre generado del bucket de assets."
}
```

Lo importante: `resource "TIPO" "NOMBRE"`. `TIPO` viene del provider (`aws_s3_bucket`, `aws_iam_role`); `NOMBRE` es tu label local (para referencia: `aws_s3_bucket.assets.arn`). Las referencias son `RECURSO.NOMBRE.ATRIBUTO`; para variables `var.NOMBRE`; para outputs de módulos `module.NOMBRE.OUTPUT`; para locals `local.NOMBRE`.

### 2.2 Workflow init → plan → apply

```bash
# 1. Descarga providers y configura backend
terraform init
# Initializing the backend...
# Successfully configured the backend "s3"!
# Downloading hashicorp/aws v5.75.0...

# 2. Formatea el código estilo canónico (idempotente)
terraform fmt -recursive

# 3. Chequea sintaxis y referencias sin tocar cloud
terraform validate

# 4. Dry-run: qué haría Terraform
terraform plan -out=tfplan
# Plan: 3 to add, 0 to change, 0 to destroy.

# 5. Aplica exactamente ese plan (idempotente con tfplan)
terraform apply tfplan

# 6. Ver outputs
terraform output bucket_name

# 7. Destruir cuando ya no necesites el entorno
terraform destroy
```

**Regla mental:** siempre `plan -out=tfplan` seguido de `apply tfplan`. Aplicar un plan diferente al que revisaste en el PR es la fuente número uno de sorpresas en producción.

### 2.3 Variables, outputs y locals

```hcl
# variables.tf
variable "instance_type" {
  type        = string
  default     = "t3.micro"
  description = "Tipo de instancia EC2."
}

variable "db_password" {
  type      = string
  sensitive = true   # no imprime en logs ni en plan output
}

variable "allowed_cidrs" {
  type    = list(string)
  default = ["10.0.0.0/16", "172.16.0.0/12"]
}

# locals.tf
locals {
  common_tags = {
    Project = "linguadev"
    Env     = var.env
  }
  name_prefix = "${var.env}-linguadev"
}

# outputs.tf
output "db_endpoint" {
  value     = aws_db_instance.main.endpoint
  sensitive = false
}

output "db_password_out" {
  value     = var.db_password
  sensitive = true   # el output está "redacted" pero visible con terraform output -raw
}
```

Los `locals` son constantes de solo lectura para no repetir expresiones. Los `sensitive = true` evitan que el valor aparezca en `terraform plan` o `apply` output (pero **sí queda en el state file en claro**, por eso el state debe cifrarse en el backend).

---

## 3. State, providers, modules (nivel medio)

### 3.1 State file: qué es y por qué es sagrado

El state file (`terraform.tfstate`) es un JSON que mapea `resource "aws_s3_bucket" "assets"` (tu código) a `arn:aws:s3:::linguadev-assets-dev-a4b7f2` (ID real en AWS). Sin él, Terraform no sabe qué recurso ya existe y qué debe crear.

```json
{
  "version": 4,
  "terraform_version": "1.10.3",
  "serial": 42,
  "lineage": "d6f9-...",
  "resources": [
    {
      "mode": "managed",
      "type": "aws_s3_bucket",
      "name": "assets",
      "provider": "provider[\"registry.terraform.io/hashicorp/aws\"]",
      "instances": [
        {
          "attributes": {
            "id": "linguadev-assets-dev-a4b7f2",
            "arn": "arn:aws:s3:::linguadev-assets-dev-a4b7f2",
            "region": "eu-west-1"
          }
        }
      ]
    }
  ]
}
```

**Reglas de oro:**
- El state file contiene **datos sensibles en claro** (passwords, keys, private_key de tls_private_key). Nunca lo commitees a Git. Cifra el backend.
- **Nunca edites el state a mano** salvo emergencia. Usa `terraform state` subcommand.
- Con múltiples personas en el equipo, **el state DEBE ser remoto** (S3, GCS, Azure Blob, Terraform Cloud). Local solo para experimentos personales.
- **Locking**: sin lock, dos `apply` concurrentes corrompen el state. En S3 clásico se hace con DynamoDB; desde Terraform 1.10 / OpenTofu 1.10 hay `use_lockfile = true` sin DynamoDB.

### 3.2 Backend S3 + DynamoDB (clásico) y S3 native locking (2026)

```hcl
# BACKEND CLÁSICO (funciona en cualquier versión):
terraform {
  backend "s3" {
    bucket         = "linguadev-tfstate-eu-west-1"
    key            = "envs/dev/main.tfstate"
    region         = "eu-west-1"
    encrypt        = true
    dynamodb_table = "linguadev-tflock"
    kms_key_id     = "alias/tfstate"
  }
}

# BACKEND MODERNO (Terraform 1.10+ / OpenTofu 1.10+):
terraform {
  backend "s3" {
    bucket       = "linguadev-tfstate-eu-west-1"
    key          = "envs/dev/main.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true   # lock nativo, sin DynamoDB
  }
}
```

El bloque `backend` **no admite variables ni interpolación** (se lee antes de que Terraform inicialice). Para valores por entorno, se usa `-backend-config`:

```bash
# init con backend por env
terraform init \
  -backend-config="bucket=linguadev-tfstate-eu-west-1" \
  -backend-config="key=envs/prod/main.tfstate"

# o con archivo:
terraform init -backend-config=backends/prod.hcl
```

### 3.3 Providers

Un provider es un binario que traduce HCL a llamadas API. `terraform init` los descarga a `.terraform/providers/` según `required_providers`. Los versionás con **pessimistic version constraint** (`~> 5.70` = ">= 5.70.0, < 6.0.0") para evitar breaking changes silenciosos, y guardás el `.terraform.lock.hcl` en Git para reproducibilidad.

**Multi-región o multi-account con `alias`:**

```hcl
provider "aws" {
  region = "eu-west-1"
}

provider "aws" {
  alias  = "us"
  region = "us-east-1"
}

resource "aws_s3_bucket" "eu_bucket" {
  bucket = "linguadev-eu"
  # usa provider default eu-west-1
}

resource "aws_s3_bucket" "us_bucket" {
  provider = aws.us
  bucket   = "linguadev-us"
}
```

**OpenTofu 1.9+** añadió `for_each` en providers, útil para deploys a N regiones:

```hcl
# OpenTofu 1.9+ (no disponible en Terraform aún)
provider "aws" {
  for_each = toset(["eu-west-1", "us-east-1", "ap-southeast-1"])
  alias    = "region"
  region   = each.value
}
```

### 3.4 Modules

Un module es una carpeta con archivos `.tf` que se puede invocar múltiples veces con distintos inputs. La organización típica de LinguaDev Pro:

```
infra/
├── envs/
│   ├── dev/
│   │   ├── main.tf         # invoca modules
│   │   ├── backend.tf
│   │   └── variables.tf
│   └── prod/
│       └── main.tf
└── modules/
    ├── vpc/
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    ├── rds/
    └── ecs-service/
```

```hcl
# envs/dev/main.tf
module "vpc" {
  source = "../../modules/vpc"

  name       = "linguadev-dev"
  cidr       = "10.20.0.0/16"
  az_count   = 2
  enable_nat = false
}

module "rds" {
  source = "../../modules/rds"

  identifier    = "linguadev-dev"
  engine        = "postgres"
  version       = "16.4"
  instance_class = "db.t4g.micro"
  vpc_id        = module.vpc.vpc_id
  subnet_ids    = module.vpc.private_subnet_ids
  password      = var.db_password
}

# Registry module (mantenido por AWS): mejor no reinventar
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.30"

  cluster_name    = "linguadev-dev"
  cluster_version = "1.32"
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnet_ids
}
```

**Reglas para modules propios:**
- Interface mínima: solo inputs necesarios; defaults sanos.
- `outputs.tf` expone todo lo que otros modules necesitarán (IDs, ARNs, endpoints).
- Versioná con Git tags si vive en un repo separado: `source = "git::https://github.com/linguadev/tf-modules.git//vpc?ref=v1.4.0"`.
- Testeá con `terraform validate` en CI para cada module.

### 3.5 `count` vs `for_each`

Terraform tiene dos meta-argumentos para crear N instancias del mismo recurso. La elección importa mucho.

**`count`** — para "N idénticos" cuando el índice numérico está bien:

```hcl
resource "aws_instance" "workers" {
  count         = 3
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.medium"
  tags = { Name = "worker-${count.index}" }
}
# Direccionamiento: aws_instance.workers[0], [1], [2]
```

Problema de `count`: si borrás el `[0]`, Terraform re-indexa y termina destruyendo TODOS los recursos. Un cambio de 1 elemento provoca destroy+create en cascada.

**`for_each`** — para colecciones con clave estable:

```hcl
resource "aws_iam_user" "team" {
  for_each = toset(["alice", "bob", "carol"])
  name     = each.key
}
# Direccionamiento: aws_iam_user.team["alice"]

# Con map (más rico):
locals {
  services = {
    web   = { port = 3000, replicas = 2 }
    api   = { port = 8080, replicas = 3 }
    admin = { port = 4000, replicas = 1 }
  }
}

resource "aws_ecs_service" "app" {
  for_each        = local.services
  name            = "linguadev-${each.key}"
  desired_count   = each.value.replicas
  # ...
}
```

Si eliminás `alice` del set, solo `aws_iam_user.team["alice"]` se destruye. Los demás quedan intactos.

**Regla mental:** `for_each` es el default para producción. Usá `count` solo si tenés `count = var.enable ? 1 : 0` (recurso condicional) o cuando N y orden son irrelevantes.

### 3.6 Dynamic blocks

Un `dynamic` genera sub-bloques repetidos a partir de una lista. Se usa cuando el número de sub-bloques no se conoce a priori:

```hcl
variable "ingress_rules" {
  type = list(object({
    port  = number
    cidrs = list(string)
  }))
  default = [
    { port = 443, cidrs = ["0.0.0.0/0"] },
    { port = 22,  cidrs = ["10.0.0.0/16"] },
  ]
}

resource "aws_security_group" "web" {
  name   = "linguadev-web"
  vpc_id = module.vpc.vpc_id

  dynamic "ingress" {
    for_each = var.ingress_rules
    content {
      from_port   = ingress.value.port
      to_port     = ingress.value.port
      protocol    = "tcp"
      cidr_blocks = ingress.value.cidrs
    }
  }
}
```

Sin `dynamic`, tendrías que escribir cada `ingress { ... }` a mano o duplicar el recurso.

### 3.7 Workspaces vs directorios

Terraform tiene el concepto `workspace` (`terraform workspace new prod`) que crea múltiples states en el mismo backend. **Antipatrón para prod**: usar workspaces para separar `dev/staging/prod` mezcla accidentalmente el código de producción con el de dev y complica IAM (mismo IAM policy para todos).

**Patrón recomendado en 2026:** un **directorio por environment**, cada uno con su backend y sus variables. Módulos compartidos. Esta separación además permite pipelines distintos (staging deploya en cada push, prod requiere approval manual).

```
infra/
├── envs/
│   ├── dev/     # tfstate propio, IAM propio
│   ├── staging/
│   └── prod/
└── modules/     # compartido
```

Workspaces sí son útiles para: (a) branches efímeros de review, (b) tenants dentro de un mismo entorno cuando quieren aislamiento de state pero no de infra.

---

## 4. Refactoring, drift, imports y policy (nivel senior)

### 4.1 Refactoring del state con `terraform state mv` y `moved`

Renombrar un recurso en el código sin `state mv` genera destroy+create. Ejemplo: `aws_s3_bucket.data` → `aws_s3_bucket.raw`:

**Antes de Terraform 1.1:**

```bash
terraform state mv aws_s3_bucket.data aws_s3_bucket.raw
```

**Desde Terraform 1.1 y OpenTofu 1.6 (recomendado):** bloque `moved` en el código, versionado y revisable:

```hcl
moved {
  from = aws_s3_bucket.data
  to   = aws_s3_bucket.raw
}

resource "aws_s3_bucket" "raw" {
  bucket = "linguadev-raw"
}
```

En el próximo `plan`, Terraform detecta el rename sin destruir nada. Después de que todo el equipo haya actualizado, el bloque `moved` se puede borrar.

Mover un recurso a un module:

```hcl
moved {
  from = aws_s3_bucket.raw
  to   = module.data.aws_s3_bucket.raw
}
```

### 4.2 `terraform import` para adoptar recursos existentes

Si tenés recursos creados a mano (ClickOps legacy), los importás al state en vez de recrearlos:

```bash
# Sintaxis clásica (CLI)
terraform import aws_s3_bucket.legacy linguadev-legacy-bucket

# Sintaxis moderna (Terraform 1.5+ / OpenTofu 1.6+): bloque import en el código
```

```hcl
import {
  to = aws_s3_bucket.legacy
  id = "linguadev-legacy-bucket"
}

resource "aws_s3_bucket" "legacy" {
  bucket = "linguadev-legacy-bucket"
  # el resto de atributos debe reflejar el estado real, si no, plan mostrará diffs
}
```

Terraform 1.5+ también permite `terraform plan -generate-config-out=generated.tf` que genera el HCL del recurso importado.

### 4.3 Drift detection

**Drift** = alguien tocó el cloud a mano. `terraform plan` refresca el state contra el cloud y muestra diffs. Estrategias:

- **CI job programado** (`terraform plan -detailed-exitcode`) que corre cada noche y alerta si hay drift.
- **Terraform Cloud** tiene drift detection nativo (paid feature).
- **driftctl** (Snyk, open source) es una alternativa que compara cloud vs state.
- **Prevención cultural**: revocar permisos de write en la consola AWS para roles humanos; solo el rol de CI puede hacer `apply`.

### 4.4 Sensitive values y secrets

Terraform NO es un vault. `sensitive = true` solo oculta el valor de la CLI output; el state file lo tiene en claro. Para secretos reales:

```hcl
# 1. Traer de un vault externo (best practice)
data "aws_secretsmanager_secret_version" "db" {
  secret_id = "linguadev/db/password"
}

resource "aws_db_instance" "main" {
  password = data.aws_secretsmanager_secret_version.db.secret_string
  # ...
}

# 2. Marcar output como sensitive (evita fugas por logs de CI)
output "connection_string" {
  value     = "postgres://user:${aws_db_instance.main.password}@${aws_db_instance.main.endpoint}/db"
  sensitive = true
}
```

**Reglas:**
- Cifrá el backend (S3 con SSE-KMS, GCS con CMEK).
- Restringí acceso al bucket del state (IAM policy que solo permita al rol de CI leer/escribir).
- Rotá credentials que hayan pasado alguna vez por state.

### 4.5 Terragrunt: DRY entre stacks y environments

Terragrunt (Gruntwork) es un wrapper que evita duplicación entre `envs/dev`, `envs/staging`, `envs/prod`. Configuración típica:

```hcl
# terragrunt.hcl (raíz)
remote_state {
  backend = "s3"
  config = {
    bucket         = "linguadev-tfstate-eu-west-1"
    key            = "${path_relative_to_include()}/terraform.tfstate"
    region         = "eu-west-1"
    encrypt        = true
    use_lockfile   = true
  }
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite"
  }
}

# live/prod/eu-west-1/vpc/terragrunt.hcl
include "root" {
  path = find_in_parent_folders()
}

terraform {
  source = "git::https://github.com/linguadev/tf-modules.git//vpc?ref=v1.4.0"
}

inputs = {
  name = "linguadev-prod"
  cidr = "10.30.0.0/16"
  env  = "prod"
}
```

Con esta estructura, `cd live/prod/eu-west-1/vpc && terragrunt apply` genera el backend, descarga el module en versión pinneada y aplica. `terragrunt run-all apply` aplica todo el arbol.

### 4.6 Policy as code

En 2026 no se hace `apply` en producción sin policies automáticas. Dos ecosistemas:

**Sentinel** (HashiCorp, cerrado, integrado con Terraform Cloud/Enterprise):

```hcl
# no-public-s3.sentinel
import "tfplan/v2" as tfplan

s3_buckets = filter tfplan.resource_changes as _, rc {
  rc.type is "aws_s3_bucket" and
  rc.change.actions is not ["delete"]
}

main = rule {
  all s3_buckets as _, bucket {
    bucket.change.after.acl is not "public-read"
  }
}
```

**OPA / Conftest** (open source, funciona en cualquier pipeline):

```rego
# policies/s3.rego
package terraform.s3

deny[msg] {
  resource := input.resource_changes[_]
  resource.type == "aws_s3_bucket"
  resource.change.after.acl == "public-read"
  msg := sprintf("Bucket '%s' no puede ser public-read", [resource.address])
}
```

```bash
# En el pipeline:
terraform plan -out=tfplan
terraform show -json tfplan > plan.json
conftest test plan.json --policy policies/
```

---

## 5. Ejemplo práctico: infra base de LinguaDev Pro en AWS

Vamos a provisionar VPC + subnets + RDS Postgres + S3 assets + IAM role para el backend, todo con state remoto en S3 con lock nativo. Estructura:

```
infra/
├── envs/dev/
│   ├── backend.tf
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   └── terraform.tfvars
└── modules/
    ├── vpc/
    ├── rds/
    └── s3-bucket/
```

### Paso 1: backend.tf (state remoto)

```hcl
# infra/envs/dev/backend.tf
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws    = { source = "hashicorp/aws",    version = "~> 5.75" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket       = "linguadev-tfstate-eu-west-1"
    key          = "envs/dev/main.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "linguadev"
      Environment = var.env
      ManagedBy   = "terraform"
    }
  }
}
```

### Paso 2: module vpc

```hcl
# modules/vpc/main.tf
data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = var.name }
}

resource "aws_subnet" "public" {
  for_each                = { for i in range(var.az_count) : i => data.aws_availability_zones.available.names[i] }
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.cidr, 8, each.key)
  availability_zone       = each.value
  map_public_ip_on_launch = true
  tags = { Name = "${var.name}-public-${each.value}" }
}

resource "aws_subnet" "private" {
  for_each          = { for i in range(var.az_count) : i => data.aws_availability_zones.available.names[i] }
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.cidr, 8, each.key + 100)
  availability_zone = each.value
  tags = { Name = "${var.name}-private-${each.value}" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags = { Name = var.name }
}

# outputs.tf
output "vpc_id"             { value = aws_vpc.this.id }
output "public_subnet_ids"  { value = [for s in aws_subnet.public : s.id] }
output "private_subnet_ids" { value = [for s in aws_subnet.private : s.id] }

# variables.tf
variable "name"     { type = string }
variable "cidr"     { type = string }
variable "az_count" { type = number, default = 2 }
```

### Paso 3: module rds

```hcl
# modules/rds/main.tf
resource "aws_db_subnet_group" "this" {
  name       = "${var.identifier}-subnets"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  name   = "${var.identifier}-db-sg"
  vpc_id = var.vpc_id

  dynamic "ingress" {
    for_each = var.allowed_cidrs
    content {
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "this" {
  identifier              = var.identifier
  engine                  = "postgres"
  engine_version          = var.engine_version
  instance_class          = var.instance_class
  allocated_storage       = 20
  storage_encrypted       = true
  db_name                 = "linguadev"
  username                = "linguadev"
  password                = var.password
  db_subnet_group_name    = aws_db_subnet_group.this.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  skip_final_snapshot     = var.env != "prod"
  deletion_protection     = var.env == "prod"
  backup_retention_period = var.env == "prod" ? 7 : 1
}

output "endpoint" { value = aws_db_instance.this.endpoint }
output "id"       { value = aws_db_instance.this.id }
```

### Paso 4: env dev compone todo

```hcl
# envs/dev/main.tf
data "aws_secretsmanager_secret_version" "db" {
  secret_id = "linguadev/${var.env}/db/password"
}

module "vpc" {
  source = "../../modules/vpc"
  name   = "linguadev-${var.env}"
  cidr   = "10.20.0.0/16"
  az_count = 2
}

module "rds" {
  source = "../../modules/rds"

  identifier     = "linguadev-${var.env}"
  engine_version = "16.4"
  instance_class = "db.t4g.micro"
  vpc_id         = module.vpc.vpc_id
  subnet_ids     = module.vpc.private_subnet_ids
  allowed_cidrs  = ["10.20.0.0/16"]
  password       = data.aws_secretsmanager_secret_version.db.secret_string
  env            = var.env
}

resource "random_id" "assets_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "assets" {
  bucket = "linguadev-assets-${var.env}-${random_id.assets_suffix.hex}"
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}

output "vpc_id"           { value = module.vpc.vpc_id }
output "rds_endpoint"     { value = module.rds.endpoint, sensitive = true }
output "assets_bucket"    { value = aws_s3_bucket.assets.id }
```

### Paso 5: init + plan + apply

```bash
cd infra/envs/dev
terraform init
terraform validate
terraform plan -out=tfplan
# Plan: 14 to add, 0 to change, 0 to destroy.
terraform apply tfplan

# Ver outputs
terraform output
```

### Paso 6: refactoring — mover assets a un module

Después de un tiempo decidís que el bucket de assets debería ser un module:

```hcl
# envs/dev/main.tf
moved {
  from = aws_s3_bucket.assets
  to   = module.assets.aws_s3_bucket.this
}

moved {
  from = aws_s3_bucket_versioning.assets
  to   = module.assets.aws_s3_bucket_versioning.this
}

module "assets" {
  source = "../../modules/s3-bucket"
  name   = "linguadev-assets-${var.env}-${random_id.assets_suffix.hex}"
}
```

`terraform plan` mostrará "0 to add, 0 to change, 0 to destroy" — solo movimientos en el state. Sin `moved`, hubiera destruído y recreado el bucket (perdiendo datos).

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Backend remoto siempre en producción** (S3, GCS, Terraform Cloud). Nunca commitees `terraform.tfstate` a Git.
- ✅ **`plan -out=tfplan` seguido de `apply tfplan`**. Nunca `apply` a ciegas.
- ✅ **Un directorio por environment** (`envs/dev`, `envs/prod`). Workspaces solo para casos específicos.
- ✅ **`for_each` es el default**; `count` solo para condicionales `count = var.enable ? 1 : 0`.
- ✅ **Bloques `moved` y `import`** en el código (Terraform 1.1+/1.5+), no CLI ad-hoc.
- ✅ **Cifrá el state**: SSE-KMS en S3, CMEK en GCS.
- ✅ **Lock del state**: DynamoDB clásico o `use_lockfile = true` (TF 1.10+/OpenTofu 1.10+).
- ✅ **Pin de versiones**: `~> 5.75` en `required_providers`; commitea `.terraform.lock.hcl`.
- ✅ **Policies en el pipeline** (OPA/Conftest o Sentinel) antes de `apply`.
- ✅ **Modules propios pequeños y opinados**; modules del registry para VPC/EKS/RDS complejos.
- ✅ **CI job de drift** nocturno con `plan -detailed-exitcode`.
- ✅ **Secrets desde vault** (Secrets Manager, Vault), no hardcodeados en `terraform.tfvars`.
- ✅ **`terraform fmt -check` y `tflint` en pre-commit hooks**.

### Anti-patrones

- ❌ `terraform.tfstate` local con múltiples devs (corrupción garantizada).
- ❌ Workspaces `dev/staging/prod` en el mismo backend con mismo código (blast radius enorme).
- ❌ Renombrar un recurso sin `moved` (destroy + create con pérdida de datos).
- ❌ `count = length(var.list)` con listas que cambian orden (re-indexado destructivo).
- ❌ Ejecutar `terraform destroy` en un pipeline de prod (poné IAM que lo prohíba).
- ❌ Poner passwords en `terraform.tfvars` commiteado.
- ❌ `terraform apply -auto-approve` en máquina local para prod.
- ❌ Un solo módulo gigante que provisiona VPC + EKS + RDS + IAM + monitoring (blast radius).
- ❌ `sensitive = true` como sustituto de un vault (el state sigue en claro).
- ❌ No revisar el `plan` en el PR (para eso está Atlantis / TF Cloud).

### Tabla decisión: cómo elegir tu herramienta IaC

| Situación | Elección |
|---|---|
| Greenfield 2026, evitar vendor lock-in | **OpenTofu 1.10+** |
| Ya en Terraform Cloud/Enterprise, feature necesarios | **Terraform 1.10+** |
| Solo AWS, equipo prefiere código TS/Python | **AWS CDK** (ver cap 16) |
| Multi-cloud + código real | **Pulumi** (ver cap 16) |
| K8s-native infra reconciliation | **Crossplane** (ver cap 16) |
| Config management (SSH-based) | **Ansible** (ver cap 13) |

### Tabla decisión: `count` vs `for_each`

| Caso | Elección |
|---|---|
| Recurso condicional (`enable ? 1 : 0`) | `count` |
| N instancias idénticas donde índice numérico da igual | `count` |
| Colección con clave estable (usernames, service names) | `for_each` |
| Map de configs por servicio | `for_each` |
| Cualquier cosa donde el orden pueda cambiar | `for_each` |

---

## 7. Casos reales industria 2023-2026

**HashiCorp cambio de licencia y fork OpenTofu (ago 2023):** HashiCorp cambió Terraform de MPL 2.0 a BSL, restringiendo usos comerciales competitivos. La Linux Foundation creó **OpenTofu** como fork MPL 2.0 con governance neutral. IBM adquirió HashiCorp en abril 2024. En 2026, OpenTofu 1.10 lidera en features open source (OCI registry, S3 native locking, OTel tracing) y Terraform 1.15 (jun 2026) cerró el gap. **Lección:** la licencia importa; fork MPL da opción de salida.

**Snowflake, Mercedes-Benz, Panasonic con Pulumi (2022-2025):** empresas dev-heavy migraron partes de Terraform a Pulumi buscando abstracciones más ricas en TypeScript/Python. **Lección:** el lenguaje real gana cuando la infra tiene mucha lógica; HCL brilla en configuración pura.

**GitLab migration a Terraform + Atlantis (2019+):** GitLab.com operó su infra con Terraform desde 2017. Atlantis (open source de Runatlantis) automatiza plan/apply en cada PR. **Lección:** `plan-in-PR` es hoy el patrón dominante; sin él, review es imposible.

**Gruntwork Terragrunt (2016+):** Yevgeniy Brikman (autor de "Terraform: Up & Running") mantiene Terragrunt como wrapper DRY. Empresas con 20+ environments (dev/staging/prod por región) lo adoptan para no duplicar backends. **Lección:** en escala multi-env, Terragrunt o Terraform Cloud son necesarios.

**Uber, Airbnb, Netflix (2020+):** operan miles de recursos con Terraform + policy engines internos. Airbnb open-sourced parte de sus modules. Uber construyó su propio wrapper. **Lección:** en escala, la platform team escribe capas por encima de Terraform (self-service para devs).

**Cloudflare Terraform provider (2020+):** Cloudflare mantiene su provider oficial. Empresas gestionan DNS, WAF rules, Workers, Zero Trust policies con TF. **Lección:** Terraform ya no es solo cloud infra; SaaS provisioning es use case masivo (Datadog monitors, PagerDuty schedules, GitHub repos).

**IBM adquiere HashiCorp (abr 2024, cerrado feb 2025):** el ecosistema Terraform Enterprise ahora dentro de IBM. Preocupación de la comunidad sobre roadmap; OpenTofu ganó tracción como alternativa neutral. **Lección:** vendor consolidation es riesgo real; forks OSS son seguro.

**Drift incidents (2020-2024):** múltiples empresas post-mortem citan drift como causa raíz. Alguien hace un cambio "urgente" en la consola AWS, Terraform apply posterior lo revierte, incidente. **Lección:** drift detection + prohibir writes manuales en prod IAM.

**Terraform Cloud → HCP Terraform rebrand (2024):** HashiCorp rebrandeó Terraform Cloud como HCP Terraform, con free tier y pricing por resource-hour. Competidores como Spacelift, env0, Scalr, Digger crecieron ofreciendo alternativas. **Lección:** el mercado de "runners de Terraform managed" es competitivo; evaluá.

**OpenTofu 1.10 OCI registry (jul 2025):** empresas grandes ahora publican modules internos en registries OCI (ECR, GAR, GHCR) en vez de Git tags. Alignment con supply chain security (signing con Cosign, provenance con SLSA). **Lección:** IaC supply chain security es agenda 2026.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Backend S3 con lock nativo y primer apply

**Objetivo:** configurar backend remoto, provisionar un bucket S3 y verificar que el state está en S3.

**Setup:**
- AWS CLI configurada con perfil sandbox.
- OpenTofu 1.10+ o Terraform 1.10+ instalado.
- Bucket S3 bootstrap creado (ver Setup §0).

**Pasos:**
1. Crea directorio `lab-ex1/` con `main.tf` que declara `backend "s3"` con `use_lockfile = true`, provider AWS, y un `aws_s3_bucket "test"`.
2. `terraform init` — verifica que dice `Successfully configured the backend`.
3. `terraform plan -out=tfplan`.
4. `terraform apply tfplan`.
5. Comprueba con `aws s3 ls s3://linguadev-tfstate-eu-west-1/` que el `.tfstate` existe.
6. Verifica que se generó un archivo de lock: `aws s3 ls s3://linguadev-tfstate-eu-west-1/envs/dev/` durante un `apply` largo.

**Criterios de éxito:**
- [ ] `terraform init` reporta backend `s3` inicializado.
- [ ] `terraform.tfstate` está en el bucket S3, cifrado (`ServerSideEncryption: AES256`).
- [ ] No existe `.terraform.tfstate.lock.info` local.
- [ ] No hay tabla DynamoDB creada.
- [ ] Segundo `terraform plan` (sin cambios) reporta "No changes".

**Bonus:** simulá dos `apply` concurrentes (dos terminales) y verifica que uno recibe error `Error acquiring the state lock`.

---

### Ejercicio 2: Refactor con `moved` sin destruir recursos

**Objetivo:** renombrar y mover recursos al state sin destroy+create.

**Setup:**
- Directorio del ejercicio 1 con el bucket ya aplicado.

**Pasos:**
1. Renombrá `aws_s3_bucket.test` a `aws_s3_bucket.data` en el código.
2. `terraform plan` — observa que quiere destruir + crear (mal).
3. Añade bloque `moved { from = aws_s3_bucket.test, to = aws_s3_bucket.data }`.
4. `terraform plan` — ahora reporta "0 to add, 0 to change, 0 to destroy".
5. Crea `modules/s3-bucket/` con `main.tf` que declare `aws_s3_bucket "this"`.
6. Reemplaza el recurso raíz por `module "data" { source = "./modules/s3-bucket" }` + `moved { from = aws_s3_bucket.data, to = module.data.aws_s3_bucket.this }`.
7. `terraform plan` debe seguir mostrando cero cambios.

**Criterios de éxito:**
- [ ] Sin `moved`, `plan` muestra destroy+create.
- [ ] Con `moved`, `plan` muestra "0 changes".
- [ ] El bucket real en AWS mantiene su ID y datos.
- [ ] Segundo refactor a module tampoco destruye.

**Bonus:** después de que el equipo haga pull, elimina el bloque `moved` (ya cumplió su función).

---

### Ejercicio 3: Importar recurso legacy al state

**Objetivo:** adoptar un recurso existente creado a mano en la consola AWS.

**Setup:**
- Crea a mano un bucket S3 en la consola: `linguadev-legacy-ex3`.
- Directorio nuevo `lab-ex3/`.

**Pasos:**
1. Escribí en `main.tf` el bloque `import { to = aws_s3_bucket.legacy, id = "linguadev-legacy-ex3" }`.
2. Ejecutá `terraform plan -generate-config-out=generated.tf`.
3. Revisá `generated.tf` — Terraform generó el HCL con los atributos actuales.
4. Copia el contenido a `main.tf`, borra `generated.tf`.
5. `terraform apply` — el recurso se adopta sin cambios.
6. Verificá con `terraform state list` que el bucket aparece.

**Criterios de éxito:**
- [ ] `generated.tf` contiene el resource con atributos correctos.
- [ ] `terraform apply` reporta "1 imported, 0 changed".
- [ ] `terraform state show aws_s3_bucket.legacy` muestra los atributos.
- [ ] Un `plan` posterior reporta "No changes".

**Bonus:** importa una VPC completa con `import` bloques para VPC + subnets + IGW.

---

### Ejercicio 4: `for_each` vs `count` en producción

**Objetivo:** demostrar que `count` re-indexa destructivamente.

**Setup:**
- Directorio nuevo con `aws_iam_user`.

**Pasos:**
1. Deploy con `count`: `resource "aws_iam_user" "team" { count = length(var.users); name = var.users[count.index] }` y `var.users = ["alice", "bob", "carol"]`.
2. `apply`. Verificá `terraform state list` → 3 recursos indexados `[0]`, `[1]`, `[2]`.
3. Cambiá `var.users` a `["bob", "carol"]` (eliminaste alice al principio).
4. `plan` — deberías ver "1 to destroy, 1 to change, 1 to change" (mal, re-indexa).
5. Refactorizá a `for_each = toset(var.users)` con bloque `moved` para preservar bob y carol.
6. Nueva `apply`, luego eliminá `alice` del set y verificá que solo `["alice"]` se destruye.

**Criterios de éxito:**
- [ ] Con `count`, un remove del inicio provoca destroy+create de todos los siguientes.
- [ ] Con `for_each`, un remove afecta solo al elemento removido.
- [ ] `terraform state list` muestra `aws_iam_user.team["bob"]` (map key) en vez de `[0]`.
- [ ] Los usuarios existentes (bob, carol) no se recrean al hacer refactor.

**Bonus:** repetí el ejercicio con `aws_iam_user_policy_attachment` que dependen del user (verás encadenamiento del bug).

---

### Ejercicio 5: policy as code con OPA/Conftest

**Objetivo:** bloquear un `apply` que crearía un bucket S3 público.

**Setup:**
- Terraform aplicando (ejercicio 1 sirve).
- Conftest instalado (`brew install conftest`).

**Pasos:**
1. Añade al `main.tf` un `aws_s3_bucket_public_access_block` con `block_public_acls = false`.
2. `terraform plan -out=tfplan && terraform show -json tfplan > plan.json`.
3. Crea `policies/s3.rego` con la policy `deny` para buckets no bloqueados públicamente.
4. `conftest test plan.json --policy policies/` — debe fallar con el mensaje de tu policy.
5. Corrige `main.tf` con `block_public_acls = true`.
6. Repite y verifica que ahora pasa.

**Criterios de éxito:**
- [ ] `conftest` falla con exit code != 0 cuando policy detecta violación.
- [ ] Mensaje `deny` referencia el recurso ofensor por address.
- [ ] Con `block_public_acls = true`, policy pasa.
- [ ] Integrás el paso en un workflow GitHub Actions.

**Bonus:** añade policy `deny` para instancias EC2 sin tag `Environment` y para RDS sin `storage_encrypted = true`.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [developer.hashicorp.com/terraform](https://developer.hashicorp.com/terraform) — docs oficiales.
- [opentofu.org/docs](https://opentofu.org/docs) — OpenTofu 1.10 docs.
- [registry.terraform.io](https://registry.terraform.io) — modules y providers.

**Herramientas:**
- [Terragrunt](https://terragrunt.gruntwork.io) — wrapper DRY.
- [Atlantis](https://www.runatlantis.io) — plan-in-PR OSS.
- [HCP Terraform](https://cloud.hashicorp.com/products/terraform) — managed backend + policies.
- [tflint](https://github.com/terraform-linters/tflint) — linter.
- [trivy](https://trivy.dev) — security scanning para IaC.
- [checkov](https://www.checkov.io) — policy-as-code para Terraform.
- [driftctl](https://github.com/snyk/driftctl) — drift detection OSS.
- [Conftest](https://www.conftest.dev) + OPA — policies genéricas.

**Libros y referencias:**
- Yevgeniy Brikman, "*Terraform: Up & Running*" (O'Reilly, 3ª ed. 2022).
- Kief Morris, "*Infrastructure as Code*" (O'Reilly, 2ª ed. 2020).
- Rosemary Wang, "*Infrastructure as Code, Patterns and Practices*" (Manning, 2022).

**Siguientes pasos:**
- Ejecutá los 5 ejercicios contra tu sandbox AWS.
- Migrá 1 recurso ClickOps existente al state con `import` bloques.
- Configurá plan-in-PR con Atlantis en tu repo.
- Añade políticas OPA en el pipeline (S3 público prohibido, encryption obligatorio).
- Continuá con [cap 13 — Ansible y config management](./13-ansible-y-config-management.md) para configuración de servidores.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre HCL, state, providers, modules, workflow, refactoring, `count`/`for_each`, dynamic blocks, sensitive values, imports, workspaces, Terragrunt, drift detection y Terraform Cloud/Enterprise. Dificultad junior → staff.

- **Fuente:** [`packages/content/src/tech/devops/sim-12-terraform-fundamentals.json`](../../packages/content/src/tech/devops/sim-12-terraform-fundamentals.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-12-terraform-fundamentals`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 11 — Kubernetes Security](./11-kubernetes-security.md) · [Índice](./README.md) · [Capítulo 13 — Ansible y config management →](./13-ansible-y-config-management.md)
