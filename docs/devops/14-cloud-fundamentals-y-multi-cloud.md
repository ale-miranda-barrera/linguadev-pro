# Capítulo 14 — Cloud fundamentals y estrategias multi-cloud

> **Focus:** Cloud desde primeros principios. IaaS/PaaS/SaaS, el shared responsibility model, regiones/AZs, cloud-native vs lift-and-shift, cuándo multi-cloud es una ventaja real y cuándo es teatro caro. Well-Architected Framework y FinOps en la práctica.
> **Áreas:** Networking · IaC · arquitectura cloud
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior

## 0. Antes de empezar

**Pre-requisitos:**
- Networking básico: TCP/IP, DNS, subredes CIDR, TLS.
- Linux básico y familiaridad con la línea de comandos AWS/GCP/Azure CLI.
- Nociones de contenedores y Kubernetes (para la sección de portabilidad).
- Haber leído [Cap 13 — Ansible](./13-ansible-y-config-management.md) ayuda para el mindset config management.
- Ideal: haber pagado una factura cloud sorprendente para valorar los apartados de FinOps.

**Glosario mínimo:**
- **IaaS** (Infrastructure as a Service): VMs, redes, discos. Ejemplo: EC2, GCE, Azure VMs.
- **PaaS** (Platform as a Service): runtime gestionado. Ejemplo: App Runner, App Engine, Azure App Service, Heroku.
- **SaaS** (Software as a Service): software listo. Ejemplo: Salesforce, Gmail, Notion.
- **Serverless**: pago por uso, sin gestión de servidor. Ejemplo: Lambda, Cloud Run, Azure Functions.
- **Región** (region): agrupación geográfica de AZs (ej: `eu-west-1`, `us-central1`).
- **AZ** (Availability Zone): datacenter independiente dentro de una región, con energía/red/enfriamiento aislados.
- **Edge / PoP**: puntos de presencia para CDN (CloudFront, Cloud CDN, Front Door).
- **Shared Responsibility Model**: contrato implícito de qué gestiona el provider y qué gestionas tú.
- **Lift-and-shift**: migrar apps on-prem a VMs cloud sin rearquitectura.
- **Cloud-native**: apps diseñadas para cloud (12-factor, contenedores, escala horizontal, managed services).
- **Multi-cloud**: usar más de un provider (AWS + GCP, por ejemplo).
- **Hybrid cloud**: mezcla on-prem + cloud (o edge + cloud).
- **Cross-cloud / Poly-cloud**: abstracciones que permiten desplegar en múltiples clouds (Terraform, Kubernetes, Crossplane).
- **Well-Architected Framework**: guías de diseño oficiales (AWS WAF, GCP Architecture Framework, Azure WAF) con pilares como reliability, security, cost.
- **FinOps**: disciplina de operación financiera del cloud. Framework abierto (FinOps Foundation) con fases *inform, optimize, operate*.
- **Reserved / Committed Use / Savings Plan**: descuentos por commitment de 1-3 años.
- **Spot / Preemptible**: capacidad excedente barata pero interrumpible.

**Setup mínimo:**

```bash
# AWS CLI v2 (2024+)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip awscliv2.zip && sudo ./aws/install
aws --version                  # aws-cli/2.15+
aws configure sso              # SSO recomendado en 2026

# GCP gcloud
curl https://sdk.cloud.google.com | bash
gcloud init
gcloud auth application-default login

# Azure CLI
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az login

# Herramientas cross-cloud
brew install terraform          # o instalar OpenTofu
kubectl version --client
helm version
```

**Nota versiones 2026:** AWS CLI v2 recomendado con SSO integrado; gcloud SDK moderna con `gcloud alpha/beta` deprecated para features estables; Azure CLI 2.60+ con soporte completo para Entra ID.

---

## 1. El gran cuadro

Cloud dejó de ser una decisión estratégica hace más de una década. En 2026, la pregunta ya no es *si* usar cloud, sino *cuál*, *cuánto*, *cómo* y *a qué precio*. El mercado se organiza en tres hiperescala globales —**AWS** (líder histórico), **Microsoft Azure** (crecimiento sostenido por Office 365 + Copilot), **Google Cloud** (foco en data + AI/ML)— más un anillo secundario relevante: **Oracle Cloud**, **Alibaba Cloud** (dominante en China), **IBM Cloud**, y proveedores de nicho como **DigitalOcean**, **Hetzner** (Europa), **Vultr**, **Linode**. Cada uno cubre las mismas primitivas (compute, storage, network, DBs) con nombres distintos y precios distintos. La ilusión de que "todos son iguales" desaparece cuando bajas al detalle de latencias inter-AZ, cuotas por default, precios de egreso, y las capas propietarias PaaS/serverless que definen su lock-in.

Antes de decidir cualquier cosa hay que dominar cuatro modelos mentales. El primero es la **taxonomía IaaS/PaaS/SaaS** —cuánta stack gestiona el provider vs tú—; el segundo es el **shared responsibility model** —quién es responsable si algo se rompe—; el tercero es la **topología física** —regiones, AZs, edge, cross-region networking, DR—; y el cuarto es el **modelo económico** —precios on-demand, reserved, spot, savings plans, egreso—. Sin estos cuatro, cualquier discusión de multi-cloud, cloud-native o FinOps es humo.

El eje que más confusión genera en 2026 es **multi-cloud vs hybrid vs cross-cloud**. *Multi-cloud* estricto significa usar dos o más clouds para la misma carga o para cargas relacionadas (AWS + GCP en producción). *Hybrid* mezcla on-prem con cloud (típico en banca, health, defensa). *Cross-cloud* es la capacidad de abstracción para desplegar la misma pieza en varios clouds (Terraform hacia AWS y Azure, Kubernetes corriendo en EKS y GKE). El mito frecuente es asumir que multi-cloud automáticamente da resiliencia; en la práctica multi-cloud es más caro, más lento y sirve principalmente cuando: (a) hay regulación que lo exige (soberanía de datos, evitar dependencia de un vendor estadounidense en la UE), (b) tienes clientes que operan en clouds distintos y necesitas presencia en cada uno, o (c) evitas lock-in real de precios/features que te bloqueen negocialmente.

El cuarto factor es **FinOps**. Con precios spot volátiles, egress caros (los famosos "hotel California charges"), y equipos que crean recursos sin ver el ticket, la factura mensual explota. FinOps es la disciplina que casa ingeniería y finanzas: tags, budgets, alertas, savings plans, right-sizing y cultura de "el que crea el recurso lo paga". La FinOps Foundation publica un framework con tres fases (*inform, optimize, operate*) que se ha vuelto la referencia. En 2026, tener un practitioner FinOps es tan común como tener un SRE.

Finalmente, cada hyperscaler publica su **Well-Architected Framework** —AWS WAF (6 pilares: operational excellence, security, reliability, performance efficiency, cost, sustainability), GCP Architecture Framework, Azure WAF (5 pilares)—. Son guías que combinan best practices con checklists. Ignorarlas es válido si sabes lo que haces; usarlas ciegamente sin criterio también es error. La práctica útil es leerlas, quedarte con los principios y aplicarlos con juicio a tu contexto real.

---

## 2. IaaS/PaaS/SaaS y el shared responsibility model (nivel básico)

### 2.1 La stack ownership

Dibuja mentalmente la stack: **Hardware → Virtualization → OS → Runtime → App → Data → User access**. Cada modelo cloud corta esta stack en un punto distinto:

| Modelo | Provider gestiona | Tú gestionas | Ejemplos |
|---|---|---|---|
| **On-prem** | Nada | Todo | Tu datacenter |
| **IaaS** | Hardware, virtualización | OS, runtime, app, data, red | EC2, GCE, Azure VMs, Hetzner Cloud |
| **PaaS** | + OS + runtime | App + data + config | App Runner, App Engine, Heroku, Beanstalk |
| **Serverless (FaaS)** | + escalado + servidor | Código + evento | Lambda, Cloud Run, Azure Functions, Cloudflare Workers |
| **SaaS** | Todo | Configuración + datos | Salesforce, Google Workspace, Notion |

Regla mental: **cuanto más arriba en la stack cortas, menos control y menos responsabilidad**. IaaS te da freedom pero te obliga a mantener parches, backups, security groups, IAM. SaaS te libera de todo pero atas tu proceso al vendor. La elección depende de cuánta ingeniería propia quieres invertir y qué tan diferenciador es el trozo.

**Ejemplo real:** para LinguaDev Pro, el backend serverless (Lambda + DynamoDB) es una decisión PaaS/FaaS: pagas por request, no gestionas servidor, escala automática. Perfecto para tráfico bursty. Si tuvieras streaming de video sostenido, IaaS (EC2 con instancias reservadas) sería mucho más barato al mes.

### 2.2 Shared Responsibility Model

El *shared responsibility model* es el contrato implícito de quién es responsable de qué. AWS lo popularizó con la frase "**AWS is responsible for the security OF the cloud, customer is responsible for security IN the cloud**". Traducido:

- **Provider responsible:** hipervisor, hardware, red física del datacenter, availability de servicios base, patches del control plane.
- **Cliente responsible:** OS patches (en IaaS), IAM policies, security groups, encriptación de datos en reposo y en tránsito, backups, configuración correcta de servicios.

En PaaS/serverless, el corte se mueve hacia arriba: en Lambda, AWS parchea el runtime; tú eres responsable de tu código, IAM, secretos, dependencias.

Fallo clásico documentado: **S3 buckets públicos accidentales** con datos sensibles. En 2017-2019 hubo docenas de casos (Accenture, Verizon, Booz Allen, Deloitte, US Voter Data). AWS ofrecía el bucket, la responsabilidad era del cliente. Desde 2018 AWS introduce Block Public Access por default, pero la lección persiste: **"cloud provider" ≠ "seguro por defecto"**.

Ejemplo de política S3 mínima segura:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::linguadev-content",
        "arn:aws:s3:::linguadev-content/*"
      ],
      "Condition": {
        "Bool": { "aws:SecureTransport": "false" }
      }
    },
    {
      "Sid": "DenyUnencryptedUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::linguadev-content/*",
      "Condition": {
        "Null": { "s3:x-amz-server-side-encryption": "true" }
      }
    }
  ]
}
```

Esto niega HTTP y niega uploads sin SSE. Ninguna acción del cliente elimina esta responsabilidad; AWS no la asume por ti.

### 2.3 Regiones vs AZs vs Edge

- **Región** (region): agrupación geográfica. Ej: `eu-west-1` (Irlanda), `eu-central-1` (Frankfurt), `us-east-1` (N. Virginia), `ap-southeast-1` (Singapore). Cada región es independiente en control plane y billing. Datos en `eu-west-1` no viajan a `us-east-1` sin réplica explícita.
- **AZ** (Availability Zone): datacenter físicamente aislado dentro de una región (energía, refrigeración, red distintos). Una región típica tiene 3-6 AZs. Latencia inter-AZ típicamente <2 ms. Diseñar apps multi-AZ es el patrón de alta disponibilidad *base*: si una AZ cae (incendio, corte eléctrico, red), tus instancias en las otras AZs siguen respondiendo.
- **Local Zones / Wavelength / Outposts:** extensiones de AWS más cerca de metros o operadores telco.
- **Edge / PoP:** puntos de presencia para CDN (CloudFront ~600 PoPs en 2026), DNS (Route 53) y protección DDoS (Shield).

Regla mental: **single-AZ = single point of failure**. Todo deploy productivo debe ser multi-AZ. Multi-region es más caro y más complejo (data replication, DNS failover, testing continuo de DR) y solo se justifica cuando: SLA muy alto (>99.99%), regulación (data residency), o latencia global (usuarios en varios continentes).

### 2.4 12-Factor y cloud-native

**Heroku publicó el manifiesto 12-Factor App en 2011**. Sigue vigente en 2026 como definición operacional de "cloud-native app":

1. **Codebase** — un repo, muchos deploys.
2. **Dependencies** — declara e aísla (npm, pip, go.mod).
3. **Config** — en env vars, no en código.
4. **Backing services** — DBs y colas como resources attachable.
5. **Build, release, run** — separación estricta.
6. **Processes** — stateless; sesiones en Redis/DB, no en memoria.
7. **Port binding** — la app expone puertos; no depende de un web server externo.
8. **Concurrency** — escala horizontal por procesos.
9. **Disposability** — start/stop rápido; graceful shutdown.
10. **Dev/prod parity** — mismo stack en local y prod.
11. **Logs** — stdout, no ficheros.
12. **Admin processes** — one-off como parte del release.

Cumplir 12-Factor es prerequisito para escalar horizontalmente en cualquier cloud sin sorpresas. Violarlo (ej: sesiones en memoria) fuerza a stickyness en el load balancer, degrada resiliencia y complica autoscaling.

---

## 3. Diseño de VPC, egress, DNS, IAM (nivel medio)

### 3.1 VPC: subnets públicas vs privadas

Una VPC bien diseñada tiene, como mínimo, tres tipos de subnet por AZ:

- **Pública:** ruta 0.0.0.0/0 → Internet Gateway. Aquí van load balancers, NAT gateways, bastion hosts.
- **Privada (app tier):** sin ruta directa a Internet. Los recursos internos hablan al exterior a través de un NAT Gateway en la subnet pública.
- **Privada aislada (data tier):** sin ruta a Internet en absoluto. Bases de datos, caches, colas internas.

Topología multi-AZ típica en `eu-west-1`:

```
VPC 10.0.0.0/16
  eu-west-1a
    public 10.0.1.0/24     → IGW
    private-app 10.0.11.0/24  → NAT-1a
    private-data 10.0.21.0/24 → nada
  eu-west-1b
    public 10.0.2.0/24     → IGW
    private-app 10.0.12.0/24  → NAT-1b
    private-data 10.0.22.0/24 → nada
  eu-west-1c
    public 10.0.3.0/24     → IGW
    private-app 10.0.13.0/24  → NAT-1c
    private-data 10.0.23.0/24 → nada
```

Ejemplo Terraform:

```hcl
# terraform/vpc.tf
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.10"

  name = "linguadev-prod"
  cidr = "10.0.0.0/16"

  azs             = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
  public_subnets  = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  private_subnets = ["10.0.11.0/24", "10.0.12.0/24", "10.0.13.0/24"]
  intra_subnets   = ["10.0.21.0/24", "10.0.22.0/24", "10.0.23.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = false   # uno por AZ (HA); true = single point of failure
  enable_dns_hostnames = true
  enable_dns_support   = true

  # Endpoints para no salir a Internet cuando hablas con servicios AWS
  enable_s3_endpoint       = true
  enable_dynamodb_endpoint = true

  tags = {
    Env    = "prod"
    Owner  = "platform"
    CostCenter = "eng"
  }
}
```

**Trampa de coste típica:** `single_nat_gateway = true` es barato (~$32/mes por NAT vs 3x $32 = $96) pero introduce un single point of failure y todo el egress cross-AZ pasa por él (con coste inter-AZ adicional). En producción usa uno por AZ. En dev/staging, uno solo está bien.

### 3.2 Egress cost — la trampa oculta

El precio de datos **saliendo** del cloud es el capítulo más doloroso del billing. Aproximado 2026 (varía por región y tier):

| Tráfico | Precio típico | Notas |
|---|---|---|
| Ingreso a AWS | $0 | Siempre gratis |
| AWS → Internet | ~$0.09/GB primeros 10 TB | Baja por escala |
| AWS inter-región | ~$0.02/GB | S3→S3 cross-region |
| AWS inter-AZ (misma región) | $0.01/GB | Sumar para chatty apps |
| VPC → VPC peering | $0.01/GB | Cross-AZ |
| S3 → CloudFront | $0 | Gratis con OAC |

Datos moviendo 100 TB/mes al Internet: **~$5000-9000/mes** solo en egress. Cloudflare (con R2 zero-egress) y otros hyperscalers presionan a AWS a bajar egress; en 2024 hubo reducciones parciales, pero sigue siendo la trampa nº1.

**Mitigación:**
- Servir estáticos vía CDN (CloudFront, Cloud CDN) con edge caché.
- VPC endpoints para tráfico interno AWS (S3, DynamoDB, KMS, Secrets Manager).
- Colocar batch jobs y análisis en la misma región que el data source.
- Comprimir respuestas (gzip, brotli).
- Cachear agresivamente en el cliente (CDN + Cache-Control).

### 3.3 DNS y latencia global

Route 53 (AWS), Cloud DNS (GCP) o Azure DNS ofrecen políticas de routing:

- **Simple:** un recordset devuelve un valor.
- **Weighted:** distribuye tráfico según pesos (útil para blue/green).
- **Latency-based:** enruta al endpoint con menor latencia desde el resolver.
- **Geolocation:** enruta según país/región del usuario.
- **Failover:** primario/secundario con health checks.

Ejemplo latency-based:

```hcl
resource "aws_route53_record" "api_eu" {
  zone_id        = data.aws_route53_zone.main.zone_id
  name           = "api.linguadev.dev"
  type           = "A"
  set_identifier = "eu"
  latency_routing_policy { region = "eu-west-1" }
  alias {
    name                   = aws_lb.eu.dns_name
    zone_id                = aws_lb.eu.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api_us" {
  zone_id        = data.aws_route53_zone.main.zone_id
  name           = "api.linguadev.dev"
  type           = "A"
  set_identifier = "us"
  latency_routing_policy { region = "us-east-1" }
  alias {
    name                   = aws_lb.us.dns_name
    zone_id                = aws_lb.us.zone_id
    evaluate_target_health = true
  }
}
```

Usuarios de Europa aterrizan en `eu-west-1`; usuarios de US en `us-east-1`. Con `evaluate_target_health`, si el LB de EU cae, Route 53 saca esa entrada y todo el tráfico va a US.

### 3.4 IAM: principio de mínimo privilegio

Regla dura: **nunca uses `*:*`**. Cada rol, política, key debe permitir solo lo necesario. IAM tiene tres primitivas clave:

- **User:** identidad humana o app. En 2026, prefiere SSO federado (Okta, Entra ID, AWS Identity Center) sobre users locales.
- **Role:** identidad asumible sin credenciales estáticas. Instances asumen roles vía instance profile; Lambdas asumen sus execution roles.
- **Policy:** JSON con `Statement[].Effect`, `Action`, `Resource`, `Condition`.

Política mínima para una Lambda que solo lee de una tabla DynamoDB:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:BatchGetItem",
        "dynamodb:Query"
      ],
      "Resource": "arn:aws:dynamodb:eu-west-1:123456789012:table/linguadev-cards",
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["${aws:PrincipalTag/tenant}"]
        }
      }
    }
  ]
}
```

Ese `Condition` limita la Lambda a leer solo items cuyo partition key sea el tenant asociado al principal. Es lo que cierra multi-tenancy en la capa IAM.

**Herramientas 2026:**
- **AWS IAM Access Analyzer:** detecta recursos con acceso público o cross-account.
- **iamlive:** genera políticas mínimas trazando calls reales.
- **cloudsplaining, Prowler, Steampipe:** auditoría de IAM.

---

## 4. Multi-cloud, cross-cloud y Well-Architected (nivel avanzado)

### 4.1 Multi-cloud: cuándo tiene sentido

**Multi-cloud vs hybrid vs cross-cloud** son distintos:

- **Multi-cloud:** AWS + GCP + Azure para cargas relacionadas. Requiere skills en cada uno.
- **Hybrid:** on-prem + cloud. Común en enterprises con inversión histórica en DCs.
- **Cross-cloud:** capa de abstracción que permite desplegar la misma pieza en varios clouds (Terraform, Kubernetes, Crossplane).

**Motivos legítimos para multi-cloud:**
1. **Regulación** — soberanía de datos: cliente en Alemania exige que sus datos residan en un cloud europeo (OVHcloud, IONOS) además de tu prod en AWS.
2. **Best-of-breed** — BigQuery en GCP para analytics, S3 + Lambda en AWS para product, GitHub en Azure (Microsoft).
3. **Presencia por cliente** — clientes enterprise que exigen despliegue en su cloud (SaaS B2B).
4. **Riesgo de vendor** — hedging contra outages regionales o cambios de precio (raro pero real: OpenAI outages Nov 2023).
5. **Negocial** — palanca en negociaciones de descuento con hyperscalers.

**Motivos falsos que llevan a decisiones caras:**
1. "Multi-cloud da alta disponibilidad." Falso: es más fácil un multi-AZ o multi-region en un mismo cloud que multi-cloud. La complejidad operacional suele quitar más HA de la que aporta.
2. "Evitamos lock-in." Parcial: usar el mínimo común denominador (VMs + Kubernetes) mata las ventajas de managed services. Un multi-cloud "puro" cuesta el doble en horas de ingeniería.
3. "Es la moda." No es razón.

**Regla mental:** empieza single-cloud. Añade el segundo solo cuando el business case sea explícito y cuantificable.

### 4.2 Cross-cloud tooling

**Terraform / OpenTofu:** único plano de control para provisionar en cualquier cloud. Un módulo `network` puede tener provider `aws`, otro provider `google`. Estado por cloud. Es la solución más común para IaC cross-cloud.

```hcl
# terraform/multi-cloud.tf
provider "aws" {
  region = "eu-west-1"
}

provider "google" {
  project = "linguadev-prod"
  region  = "europe-west1"
}

# S3 en AWS para storage principal
resource "aws_s3_bucket" "content" {
  bucket = "linguadev-content"
}

# GCS en GCP para backup off-provider
resource "google_storage_bucket" "backup" {
  name     = "linguadev-content-backup"
  location = "EU"
  storage_class = "COLDLINE"
}

# Replicación cross-cloud vía Lambda + gsutil (fuera de scope IaC)
```

**Kubernetes** (EKS, GKE, AKS, on-prem con kops/kubeadm): abstrae compute. Deploy el mismo YAML. Los managed services (DB, colas, secrets) siguen siendo proprietarios; usa **External Secrets Operator** para uniformar el acceso a Vault/Secrets Manager/GCP Secret Manager desde el cluster (ver Cap 15).

**Crossplane** (CNCF, v2 desde 2025): Kubernetes como plano de control para provisionar recursos cloud. Composiciones declarativas con `Composition` y `XRD` (Composite Resource Definitions). Modelo GitOps-friendly. Ver Cap 16.

**Anthos / Azure Arc / AWS Outposts:** ofertas managed para extender el cloud al on-prem, invertir la relación (correr GKE on-prem). Coste alto, adopción en enterprises grandes.

### 4.3 Well-Architected Framework en la práctica

AWS WAF define 6 pilares:

1. **Operational Excellence:** IaC, playbooks, observabilidad, aprendizaje de fallos.
2. **Security:** IAM mínimo privilegio, cifrado en reposo y tránsito, incident response.
3. **Reliability:** multi-AZ, chaos testing, DR, backups verificados.
4. **Performance Efficiency:** elegir el instance type correcto, caching, edge.
5. **Cost Optimization:** RIs/Savings Plans, right-sizing, apagar dev-envs fuera de horas.
6. **Sustainability** (añadido 2021): elegir regiones con energía renovable, right-sizing agresivo, arm/graviton.

Uso práctico: cada trimestre, hacer un **Well-Architected Review** por workload. AWS ofrece la tool en consola con checklist. Google y Azure tienen equivalentes.

Ejemplo checklist reliability sobre un servicio:
- [ ] Deploy multi-AZ.
- [ ] Backup automatizado y probado (restore drill semestral).
- [ ] SLO documentado (ej: 99.9% mensual).
- [ ] Runbook para top 5 fallos.
- [ ] Circuit breakers en clientes.
- [ ] Retry con jitter exponencial.
- [ ] Chaos testing en staging (kill instancia, latency injection).

### 4.4 FinOps: inform → optimize → operate

La **FinOps Foundation** publica el framework abierto. Aplicado:

**Inform (visibilidad):**
- Etiquetado obligatorio (`Env`, `Owner`, `CostCenter`, `Product`) con enforcement via SCP/policy.
- Cost Explorer / GCP Billing Reports / Azure Cost Management dashboards.
- Ver cost per env, per team, per product.
- Anomaly Detection (AWS, Azure) para picos raros.

**Optimize:**
- Right-sizing: analizar CPU/mem utilization; downsizing agresivo.
- Reserved Instances / Savings Plans para carga base predecible (1-3y, 40-70% descuento).
- Spot / preemptible para batch tolerante a interrupciones (60-90% descuento).
- Delete unused: EIPs sueltas, EBS gp2 no attached, snapshots viejos, RDS snapshots huérfanos, LBs sin targets.
- S3 lifecycle: mover a IA/Glacier/Deep Archive según patrón de acceso.
- Elegir Graviton (ARM) cuando la app compile: ~20% ahorro.

**Operate:**
- Budgets con alertas 50%, 80%, 100%.
- FinOps champions por equipo.
- Weekly cost review, monthly deep dive.
- KPIs: cost per active user, cost per request, cost per feature.

Ejemplo policy con AWS Budgets:

```json
{
  "BudgetName": "linguadev-prod-monthly",
  "BudgetLimit": { "Amount": "1500", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {
    "TagKeyValue": ["Env$prod"]
  },
  "NotificationsWithSubscribers": [
    {
      "Notification": {
        "NotificationType": "ACTUAL",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 80
      },
      "Subscribers": [
        { "SubscriptionType": "SNS", "Address": "arn:aws:sns:eu-west-1:123:cost-alerts" }
      ]
    },
    {
      "Notification": {
        "NotificationType": "FORECASTED",
        "ComparisonOperator": "GREATER_THAN",
        "Threshold": 100
      },
      "Subscribers": [
        { "SubscriptionType": "EMAIL", "Address": "finops@linguadev.dev" }
      ]
    }
  ]
}
```

Herramientas FinOps 2026: **Vantage**, **CloudHealth (VMware/Broadcom)**, **Cloudability (Apptio/IBM)**, **Kubecost** (Kubernetes-specific), **Infracost** (shift-left en PRs de Terraform), **OpenCost** (CNCF).

### 4.5 Comparación AWS vs Azure vs GCP en 2026

Trade-offs típicos:

| Área | AWS | Azure | GCP |
|---|---|---|---|
| Market share | Líder (~30-33%) | 2º (~22-25%) | 3º (~10-12%) |
| Fortaleza | Amplitud servicios, madurez | Integración MS (365, AD), enterprise sales | Data + AI/ML (BigQuery, Vertex) |
| PaaS estrella | Lambda + Fargate | App Service + Functions | Cloud Run + Cloud Functions |
| K8s managed | EKS | AKS | GKE (mejor UX según muchos) |
| DB serverless | Aurora Serverless, DynamoDB | Cosmos DB, SQL serverless | Spanner, Firestore, BigQuery |
| Networking | Complejo pero flexible | Similar AWS | Global VPC (única en 2026) |
| Egress | Alto | Similar | Ligeramente menor + free egress promo 2024 |
| Precio VM base | Referencia | Similar | ~10-20% menor on-demand |
| RI/Savings discount | Hasta 72% | Hasta 65% | CUD hasta 57% |
| AI/ML | Bedrock (multi-model) | OpenAI partnership (Azure OpenAI) | Vertex + Gemini native |
| DevEx | Consola sobrecargada | Portal mejorado | Consola más limpia |

**Recomendaciones prácticas:**
- Startup nueva sin restricciones → GCP (mejor DevEx, precios más agresivos, cloud run + firestore muy potente).
- Empresa con Windows/AD/365 → Azure (integración natural, contratos enterprise).
- Perfil serverless-heavy con muchos servicios → AWS (amplitud imbatible).
- Analytics/ML masivos → GCP (BigQuery, Vertex).
- Startup con exposición europea/regulación → mixtura AWS + OVHcloud/IONOS o Scaleway (soberanía).

---

## 5. Ejemplo práctico completo: arquitectura cloud de LinguaDev Pro

Aplicamos todo a la arquitectura target de LinguaDev Pro en AWS con presencia europea, cost-conscious y con hooks preparados para multi-cloud si el negocio lo pide.

### Diagrama conceptual

```
Users (browsers, PWA)
  |
  v
CloudFront (edge cache, WAF)
  |
  +--> S3 (static assets: html, js, css, imgs)
  |
  +--> API Gateway (HTTPS, throttling, JWT)
        |
        v
      Lambda (Node 22, Graviton) — eu-west-1
        |
        +--> DynamoDB (cards, users) — on-demand billing
        +--> S3 (audio/tts assets) — Intelligent-Tiering
        +--> Secrets Manager (API keys OpenAI, Anthropic)
        +--> EventBridge (async workflows)
              |
              v
            SQS -> Lambda worker (batch evals con LLM)

Observability
  CloudWatch Logs + Metrics -> Grafana Cloud (long term)
  X-Ray tracing
  AWS Cost Anomaly Detection -> Slack #finops
```

### Módulo Terraform de red (mínimo)

```hcl
# terraform/network.tf
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.10"

  name = "linguadev-${var.env}"
  cidr = "10.${var.env == "prod" ? 0 : 1}.0.0/16"

  azs             = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
  public_subnets  = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  private_subnets = ["10.0.11.0/24", "10.0.12.0/24", "10.0.13.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = var.env != "prod"    # prod = HA, otros = ahorro

  enable_dns_hostnames = true

  enable_s3_endpoint       = true
  enable_dynamodb_endpoint = true

  tags = local.common_tags
}

locals {
  common_tags = {
    Project    = "linguadev"
    Env        = var.env
    Owner      = "platform"
    CostCenter = "eng"
    ManagedBy  = "terraform"
  }
}
```

### CloudFront + S3 con OAC (Origin Access Control)

```hcl
# terraform/cdn.tf
resource "aws_s3_bucket" "static" {
  bucket = "linguadev-${var.env}-static"
  tags   = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "static" {
  bucket                  = aws_s3_bucket.static.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "static" {
  name                              = "linguadev-${var.env}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "static" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"   # EU + US only, más barato
  http_version        = "http2and3"

  origin {
    domain_name              = aws_s3_bucket.static.bucket_regional_domain_name
    origin_id                = "s3-static"
    origin_access_control_id = aws_cloudfront_origin_access_control.static.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-static"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"   # CachingOptimized managed
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  tags = local.common_tags
}
```

### DynamoDB on-demand con auto-scaling

```hcl
resource "aws_dynamodb_table" "cards" {
  name         = "linguadev-${var.env}-cards"
  billing_mode = "PAY_PER_REQUEST"    # on-demand: pagas por request, escala automática
  hash_key     = "userId"
  range_key    = "cardId"

  attribute { name = "userId"; type = "S" }
  attribute { name = "cardId"; type = "S" }

  point_in_time_recovery {
    enabled = var.env == "prod"
  }

  server_side_encryption {
    enabled = true
  }

  tags = local.common_tags
}
```

### FinOps: budget + alertas

```hcl
resource "aws_budgets_budget" "monthly" {
  name         = "linguadev-${var.env}"
  budget_type  = "COST"
  limit_amount = var.env == "prod" ? "1500" : "200"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["Env$${var.env}"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = ["finops@linguadev.dev"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = ["finops@linguadev.dev"]
  }
}
```

### Sustainability: elegir Graviton

En cada Lambda:

```hcl
resource "aws_lambda_function" "api" {
  function_name = "linguadev-${var.env}-api"
  architectures = ["arm64"]                # Graviton, ~20% barato + energía renovable
  runtime       = "nodejs22.x"
  role          = aws_iam_role.lambda.arn
  handler       = "dist/index.handler"
  filename      = "dist/api.zip"

  memory_size   = 512
  timeout       = 10

  environment {
    variables = {
      NODE_ENV    = var.env
      REGION      = "eu-west-1"
      LOG_LEVEL   = var.env == "prod" ? "info" : "debug"
    }
  }

  tracing_config { mode = "Active" }

  tags = local.common_tags
}
```

### Hook para multi-cloud (opcional futuro)

Ejemplo de replicación de contenido a GCS como backup off-provider:

```hcl
# terraform/backup-gcp.tf (activable con var.enable_gcp_backup)
provider "google" {
  project = var.gcp_project
  region  = "europe-west1"
}

resource "google_storage_bucket" "backup" {
  count         = var.enable_gcp_backup ? 1 : 0
  name          = "linguadev-${var.env}-backup"
  location      = "EU"
  storage_class = "COLDLINE"

  lifecycle_rule {
    condition { age = 365 }
    action    { type = "SetStorageClass"; storage_class = "ARCHIVE" }
  }

  versioning { enabled = true }
}
```

Con `var.enable_gcp_backup = false` por default, cero coste; cuando el negocio lo pida, se activa con una var. Ese es el patrón cross-cloud pragmático: preparado pero no pagado hasta que hace falta.

---

## 6. Cheatsheet + reglas mentales + antipatrones

### Reglas de oro

- ✅ Multi-AZ es el mínimo para producción.
- ✅ Multi-region solo si SLA >99.99% o data residency lo exige.
- ✅ Cifrado en reposo y en tránsito por default.
- ✅ IAM mínimo privilegio; nada de `*:*`.
- ✅ Tags obligatorios (`Env`, `Owner`, `CostCenter`) con enforcement policy.
- ✅ Budget + alertas 80/100% desde el día 1.
- ✅ S3 con Block Public Access ON y política Deny insecure transport.
- ✅ VPC endpoints para tráfico interno AWS (ahorro egress).
- ✅ CDN + gzip/brotli para todo lo estático.
- ✅ Graviton (ARM) cuando la app compile: 20% ahorro + sustainability.
- ✅ Right-sizing quarterly con datos reales de utilización.
- ✅ RIs/Savings Plans para carga base predecible.
- ✅ Spot/preemptible para batch tolerante a interrupciones.
- ✅ WAR (Well-Architected Review) trimestral por workload.
- ✅ FinOps champion por equipo.
- ✅ Cross-cloud tooling (Terraform/K8s) para portabilidad, sin obsesionarse con lock-in.

### Antipatrones

- ❌ Single-AZ en producción.
- ❌ Bucket S3 público accidental.
- ❌ IAM users con Access Keys estáticas para humanos (usa SSO federado).
- ❌ NAT único en producción (single point of failure + coste cross-AZ).
- ❌ Multi-cloud sin business case explícito.
- ❌ Servir estáticos directo desde Lambda o Origin (sin CDN).
- ❌ Recursos sin tags — imposible auditar coste.
- ❌ Recursos huérfanos: EIP sin attach, EBS gp2 no montado, LBs sin targets.
- ❌ Dev/staging on 24/7 (usa scheduled stop/start).
- ❌ Egress uncontrolled — mide y limita.
- ❌ Cross-region replication automática sin necesidad clara.
- ❌ Kubernetes solo "por si acaso hay multi-cloud".
- ❌ Managed service exótico sin analizar dependencia (lock-in inesperado).
- ❌ Ignorar el Well-Architected Framework y luego auditar "de urgencia".
- ❌ "Optimizar coste después" — cada mes que pasa es dinero perdido.

### Tabla de decisión modelo

| Situación | Elección | Razón |
|---|---|---|
| App nueva, sin restricciones, quieres velocidad | GCP Cloud Run + Firestore | DevEx superior, precio agresivo |
| Empresa Windows-heavy, AD, Office | Azure | Integración natural, contratos existentes |
| Serverless-first, muchos servicios AWS | AWS Lambda + DynamoDB + API Gateway | Amplitud sin igual |
| Analytics y ML masivos | GCP BigQuery + Vertex | Ecosistema maduro |
| Regulación EU estricta | AWS eu-west-1 + backup en OVH/IONOS | Cumple con presencia europea |
| Necesitas rebajar factura urgente | RIs/Savings Plans + right-sizing + Graviton | Payoff inmediato |
| Cliente exige tu servicio en su cloud (B2B) | Terraform o Crossplane para portabilidad | Cross-cloud real |

---

## 7. Casos reales industria 2020-2026

**Netflix on AWS (2008-2026):** referencia histórica. Netflix decidió full AWS tras el corte propio de 2008. Contribuyó a la comunidad con Simian Army, Spinnaker, Hystrix. Lección: single-cloud bien hecho supera multi-cloud mal hecho.

**Snap Inc. GCP contract $2B (S-1 2017):** Snap eligió GCP en su IPO. Ahorro operacional por no construir infra propia. Ejemplo canónico de bet estratégica en un cloud.

**Basecamp / 37signals (2022-2024):** DHH publicó "leaving cloud" mostrando ahorro >$500K/año al mover Hey.com y Basecamp a datacenter propio. Lección: cloud no es siempre más barato; hay economía de escala en on-prem si tienes previsibilidad y equipo capaz. NO es señal para "cloud=malo"; es señal para hacer el math honestamente.

**Broadcom compra VMware (2023) + cambios de licensing (2024):** provocó pánico masivo en empresas VMware on-prem. Aceleró migraciones a Kubernetes/cloud. Lección: dependencia de un vendor propietario puede volverse tóxica.

**Ma-El-Sisi 2023, ChatGPT downtime Nov 2023:** un solo cloud/proveedor puede caer. Ejemplo de por qué diversificación (aunque no siempre multi-cloud) ayuda: multi-region, multi-provider LLM, degradación grácil.

**AWS us-east-1 outages recurrentes (2020, 2021, 2023, 2024):** us-east-1 es la región más grande y también la que más falla. Muchas apps con "presencia global" pero control plane en us-east-1 sufren. Lección: elegir región con criterio, no por default de la consola.

**EU AI Act (aplicable escalonado 2024-2027):** presiona a startups europeas a preferir clouds con presencia UE clara. En 2026, muchas empresas EU añaden OVHcloud/Scaleway/IONOS al mix.

**Cloudflare R2 zero-egress (2022-2026):** disparó presión sobre AWS S3 en egress. AWS respondió con free egress cuando cambias de cloud (2024) y con precios más agresivos. Lección: competencia real baja precios.

**FinOps Foundation (Linux Foundation, 2019-2026):** movimiento estructurado. 12,000+ practitioners certificados en 2026. Empresas grandes tienen "FinOps team" dedicado. Lección: ya no es opcional.

**Kubernetes market saturation (2024-2026):** después de años de "todos usan K8s", el péndulo se mueve hacia "usa K8s solo si lo necesitas". Cloud Run, App Runner, Fly.io ganan tracción para casos donde K8s es overkill. Lección: elige la abstracción por caso, no por FOMO.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Auditar tu cuenta AWS por buenas prácticas mínimas

**Objetivo:** identificar y corregir top 5 riesgos de seguridad/coste en una cuenta AWS.

**Setup:** cuenta AWS con permisos IAM de auditoría (SecurityAudit + ReadOnlyAccess).

**Pasos:**
1. Instala Prowler (`pip install prowler` o docker) y corre `prowler aws --compliance cis_2.0_aws`.
2. Revisa hallazgos críticos: root MFA, S3 buckets públicos, security groups con `0.0.0.0/0:22`, CloudTrail habilitado, GuardDuty ON.
3. Corre `aws-nuke --dry-run` en cuentas sandbox para ver recursos huérfanos.
4. En Cost Explorer, filtra por "Usage Type = Unused" y ordena por spend.
5. Documenta top 5 hallazgos y plan de remediación.

**Criterios de éxito:**
- [ ] Root user tiene MFA activo.
- [ ] Cero S3 buckets con `PublicAccessBlock` desactivado sin justificación.
- [ ] Cero SGs con puerto 22 abierto a `0.0.0.0/0`.
- [ ] CloudTrail habilitado en todas las regiones.
- [ ] GuardDuty activo o justificación documentada.
- [ ] Top 5 hallazgos con dueño y fecha de fix.

**Bonus:** integra Prowler en CI como scheduled job semanal con output a S3.

---

### Ejercicio 2: Construir una VPC multi-AZ con Terraform

**Objetivo:** desplegar VPC 10.0.0.0/16 con 3 AZs, subnets pública/privada/intra, NAT por AZ, VPC endpoints S3/Dynamo.

**Setup:** cuenta AWS, Terraform 1.10+ u OpenTofu 1.9+, AWS CLI configurado.

**Pasos:**
1. Crea `terraform/main.tf` con `terraform-aws-modules/vpc/aws ~> 5.10`.
2. Configura 3 AZs, `single_nat_gateway = false` para HA.
3. Añade `enable_s3_endpoint` y `enable_dynamodb_endpoint`.
4. Añade tags obligatorios (`Env`, `Owner`, `CostCenter`).
5. `terraform plan` y `apply`.
6. Verifica en consola: 3 NAT gateways, VPC endpoints presentes.
7. Lanza una EC2 en subnet privada, comprueba egress via NAT.

**Criterios de éxito:**
- [ ] 3 AZs, cada una con public/private/intra.
- [ ] 3 NAT gateways activos.
- [ ] VPC endpoints S3 y Dynamo listados.
- [ ] EC2 privada puede `curl https://s3.eu-west-1.amazonaws.com` sin salir a Internet.
- [ ] Tags aplicados en todos los recursos.

**Bonus:** añade `terraform destroy` scheduled con Lambda + EventBridge para labs.

---

### Ejercicio 3: Presupuesto + alertas + tag policy

**Objetivo:** montar governance mínima de coste con budgets, tags obligatorios y alertas.

**Setup:** cuenta AWS + Slack webhook (o SNS + email).

**Pasos:**
1. Define en Terraform `aws_budgets_budget` con límite mensual, alertas al 50/80/100%.
2. Crea una SCP en Organizations que requiera tags `Env`, `Owner`, `CostCenter` al crear EC2/RDS/S3/Lambda.
3. Configura Cost Anomaly Detection con destino SNS.
4. Suscribe Slack al SNS via Lambda o AWS Chatbot.
5. Prueba disparando una anomalía (spin-up de instancia grande temporalmente).

**Criterios de éxito:**
- [ ] Budget existe con las 3 alertas configuradas.
- [ ] SCP bloquea creación de recursos sin tags requeridos.
- [ ] Alerta llega a Slack con contexto (recurso, servicio, coste).
- [ ] Test: crear EC2 sin tags → SCP la rechaza.
- [ ] Test: dispara anomalía → alerta llega en <24 h.

**Bonus:** dashboard Grafana Cloud consumiendo AWS Cost & Usage Report + Athena.

---

### Ejercicio 4: Comparativa coste real entre AWS, GCP y Azure para el mismo workload

**Objetivo:** poner número al debate. Estimar coste mensual de LinguaDev Pro (2M requests/mes, 5 GB storage, 50 GB egress) en los 3 clouds.

**Setup:** hojas de cálculo, calculators oficiales, Infracost.

**Pasos:**
1. Define workload: 2M Lambda/CloudRun invocations, 512 MB, 300 ms avg, 5 GB DynamoDB/Firestore/CosmosDB, 50 GB S3/GCS/Blob, 50 GB egress.
2. Estima en cada calculator: [AWS Pricing Calculator](https://calculator.aws), [GCP Calculator](https://cloud.google.com/products/calculator), [Azure Calculator](https://azure.microsoft.com/pricing/calculator/).
3. Registra costes en tabla comparativa (compute, storage, egress, total).
4. Corre Infracost sobre Terraform equivalente para verificar.
5. Documenta trade-offs no monetarios (DevEx, madurez de servicios).

**Criterios de éxito:**
- [ ] Tabla con 4 columnas (recurso, AWS, GCP, Azure).
- [ ] Total mensual estimado en cada uno.
- [ ] Comentario sobre RIs/CUDs disponibles.
- [ ] Recomendación argumentada.
- [ ] Análisis de "peor caso" (5x tráfico).

**Bonus:** publica el análisis interno como ADR (Architecture Decision Record).

---

### Ejercicio 5 (bonus): DR failover multi-region

**Objetivo:** implementar failover Route 53 entre eu-west-1 (primary) y eu-central-1 (secondary) con health checks.

**Setup:** cuenta AWS con 2 ALBs deployados (uno por región) sirviendo la misma app.

**Pasos:**
1. Crea 2 aws_route53_record con `failover_routing_policy` (PRIMARY / SECONDARY).
2. Adjunta `health_check_id` con endpoint `/health`.
3. Configura CloudWatch alarm para transitions.
4. Simula fallo: security group primario deny all → health check falla → Route 53 conmuta.
5. Mide RTO (recovery time objective): tiempo desde fallo detectado hasta usuario servido por secundario.
6. Restaura y observa reversión.

**Criterios de éxito:**
- [ ] Failover automático detectable en <60 s.
- [ ] RTO documentado (esperado ~2 min con TTL 60).
- [ ] Ambos ALBs sirven la misma app.
- [ ] Métricas de failover a CloudWatch/Grafana.
- [ ] Runbook documentado para DR drill semestral.

**Bonus:** añade backup cross-region S3 con replication rules y prueba restore.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/).
- [GCP Architecture Framework](https://cloud.google.com/architecture/framework).
- [Azure Well-Architected Framework](https://learn.microsoft.com/azure/well-architected/).
- [NIST SP 800-145 — Cloud Computing Definition](https://csrc.nist.gov/publications/detail/sp/800-145/final).
- [12-Factor App](https://12factor.net/) — el manifiesto original de Heroku.

**FinOps:**
- [FinOps Foundation](https://www.finops.org/framework/) — framework abierto.
- [FinOps X annual conference](https://x.finops.org/).
- Libros: "Cloud FinOps" (O'Reilly, 2nd ed 2023) — Storment & Fuller.
- Tools: Vantage, CloudHealth, Cloudability, Kubecost, Infracost, OpenCost.

**Security:**
- Prowler, ScoutSuite, Steampipe — cloud posture management OSS.
- CIS Benchmarks para AWS/GCP/Azure.
- SANS Cloud Security Fundamentals.

**Comparativas y benchmarks 2026:**
- Flexera State of the Cloud Report (anual).
- CNCF Annual Survey.
- Gartner Magic Quadrant Cloud Infrastructure.

**Alternativas hyperscalers:**
- OVHcloud, Scaleway, IONOS (EU sovereignty).
- Hetzner (precio agresivo, EU).
- DigitalOcean, Vultr, Linode (dev-friendly, precios claros).
- Cloudflare Workers/R2/D1 (edge-first).
- Fly.io (edge multi-region).

**Siguientes pasos:**
- Aplica el checklist Well-Architected a tu workload actual.
- Configura budgets + tags policy antes de la próxima factura.
- Revisa [Cap 15 — GitOps con ArgoCD y Flux](./15-gitops-con-argocd-y-flux.md) para operar Kubernetes de forma declarativa.
- Prepara la lectura de [Cap 16 — Pulumi, CDK y IaC moderna](./16-pulumi-cdk-y-iac-moderna.md) para explorar IaC más allá de Terraform.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre IaaS/PaaS/SaaS, VPC design, shared responsibility, multi-region/DR, multi-cloud vs hybrid, cross-cloud tooling, Well-Architected, FinOps y comparativa AWS/Azure/GCP. Dificultades junior → mid → senior.

- **Fuente:** [`packages/content/src/tech/devops/sim-14-cloud-fundamentals-and-multi-cloud.json`](../../packages/content/src/tech/devops/sim-14-cloud-fundamentals-and-multi-cloud.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-14-cloud-fundamentals-and-multi-cloud`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 13 — Ansible y config management](./13-ansible-y-config-management.md) · [Índice](./README.md) · [Capítulo 15 — GitOps con ArgoCD y Flux →](./15-gitops-con-argocd-y-flux.md)
