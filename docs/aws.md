# AWS Certifications

Backup de todos los simulacros de certificaciones AWS incluidos en el
proyecto. Cada certificación tiene sus dominios oficiales según la guía de
AWS y una serie de simulacros temáticos + simulacros mixtos de práctica.

## CLF-C02 — AWS Certified Cloud Practitioner

Certificación fundacional AWS. Valida entendimiento general de la nube: conceptos, seguridad, servicios principales y facturación. Ideal para roles no técnicos, iniciados o como base antes de las certificaciones Associate.

- **Preguntas en examen real:** 65
- **Tiempo:** 90 min
- **Puntaje mínimo:** 700/1000

### Dominios oficiales

- **Cloud Concepts** (`concepts`) — 24%
- **Security & Compliance** (`security`) — 30%
- **Cloud Technology & Services** (`technology`) — 34%
- **Billing, Pricing & Support** (`billing`) — 12%

### Simulacros disponibles (20 total)

#### Simulacro 01 — Cloud Concepts: fundamentos y modelo económico

- **Focus:** Dominio 1 — Cloud Concepts (24%). Beneficios de la nube, modelos de despliegue, CapEx vs OpEx, escalabilidad vs elasticidad, agilidad.
- **Dominios:** concepts
- **Preguntas:** 10
- **Tiempo:** 20 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - Beneficios de la nube
  - Escalabilidad vs elasticidad
  - Modelos de despliegue
  - CapEx vs OpEx
  - AWS Global Infrastructure
  - Beneficios de la nube — global reach
  - Cloud Adoption Framework (CAF)
  - Well-Architected Framework
  - Beneficios económicos
  - Antipattern: no cloud
- **JSON:** `packages/content/src/aws/clf-c02/sim-01-cloud-concepts-fundamentals.json`

#### Simulacro 02 — Modelo de Responsabilidad Compartida + IAM básico

- **Focus:** Dominio 1 & 2 — Quién es responsable de qué en AWS y fundamentos de IAM (usuarios, root, MFA, políticas).
- **Dominios:** concepts, security
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - Shared Responsibility Model
  - Shared Responsibility con servicios managed
  - Responsabilidad cliente
  - IAM Users vs Groups
  - Root Account Best Practices
  - IAM Roles
  - IAM Policies
  - MFA
  - Cross-account roles
  - AWS Managed vs Customer Managed Policies
- **JSON:** `packages/content/src/aws/clf-c02/sim-02-shared-responsibility-iam-basics.json`

#### Simulacro 03 — Migración a AWS: 7 R's + Migration Hub, MGN, DMS, Snow

- **Focus:** Dominio 1 — Estrategias de migración (7 Rs), CAF, y servicios de migración: Migration Hub, MGN, DMS, SCT, Snowball.
- **Dominios:** concepts
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - 7 Rs — Rehost
  - 7 Rs — Replatform
  - 7 Rs — Refactor
  - Migration Hub
  - Application Migration Service (MGN)
  - DMS + SCT
  - Snow Family
  - Cloud Adoption Framework (CAF)
  - AWS Application Discovery Service
  - 7 Rs — Repurchase vs Retire
- **JSON:** `packages/content/src/aws/clf-c02/sim-03-migration-strategies.json`

#### Simulacro 04 — IAM en profundidad: Users, Groups, Roles, Policies

- **Focus:** Dominio 2 — IAM completo: identidades, permisos, roles, políticas, best practices.
- **Dominios:** security
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - IAM Least Privilege
  - IAM Policy Anatomy
  - IAM Roles vs Users
  - MFA para root y usuarios
  - IAM Access Analyzer
  - Password Policy
  - Programmatic vs Console Access
  - IAM Roles for Services
  - Access Keys Rotation
  - IAM Global vs Regional
- **JSON:** `packages/content/src/aws/clf-c02/sim-04-iam-deep-dive.json`

#### Simulacro 05 — Identity Center, Cognito, Organizations, SCPs

- **Focus:** Dominio 2 — Gestión de identidades corporativa (SSO), usuarios finales (Cognito), governance multicuenta (Organizations + SCPs).
- **Dominios:** security
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - IAM Identity Center
  - Amazon Cognito
  - AWS Organizations
  - Service Control Policies (SCP)
  - AWS Control Tower
  - Consolidated Billing
  - AWS Directory Service
  - Federation con SAML
  - Cognito User Pools vs Identity Pools
  - SCP vs IAM Policy
- **JSON:** `packages/content/src/aws/clf-c02/sim-05-identity-federation-organizations.json`

#### Simulacro 06 — Protección de datos: KMS, cifrado en reposo y en tránsito

- **Focus:** Dominio 2 — KMS, CloudHSM, Secrets Manager, Certificate Manager, cifrado at-rest y in-transit.
- **Dominios:** security
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - Cifrado en reposo vs en tránsito
  - AWS KMS
  - KMS vs CloudHSM
  - AWS Secrets Manager
  - AWS Certificate Manager (ACM)
  - S3 Encryption Options
  - KMS Key Rotation
  - In-Transit Encryption
  - Envelope Encryption
  - SSM Parameter Store
- **JSON:** `packages/content/src/aws/clf-c02/sim-06-data-protection-kms-encryption.json`

#### Simulacro 07 — Detección y monitoreo de seguridad

- **Focus:** Dominio 2 — GuardDuty, Inspector, Macie, Config, CloudTrail, Security Hub, Detective.
- **Dominios:** security
- **Preguntas:** 11
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - Amazon GuardDuty
  - Amazon Inspector
  - Amazon Macie
  - AWS CloudTrail
  - AWS Config
  - AWS Security Hub
  - Amazon Detective
  - CloudWatch vs CloudTrail
  - GuardDuty Malware Protection
  - IAM Access Analyzer
  - CloudTrail Log Integrity
- **JSON:** `packages/content/src/aws/clf-c02/sim-07-detection-monitoring-security.json`

#### Simulacro 08 — Seguridad de red: SG, NACL, WAF, Shield, Firewall Manager

- **Focus:** Dominio 2 — Security Groups vs NACLs, WAF, Shield Standard/Advanced, Network Firewall, Firewall Manager.
- **Dominios:** security
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - Security Groups vs NACLs
  - AWS WAF
  - AWS Shield
  - SG stateful behavior
  - AWS Firewall Manager
  - AWS Network Firewall
  - Rate-based rules WAF
  - SG references
  - Shield Standard vs Advanced
  - VPC Flow Logs
- **JSON:** `packages/content/src/aws/clf-c02/sim-08-network-security.json`

#### Simulacro 09 — Compliance y gobernanza: Artifact, Organizations, SCPs, Control Tower

- **Focus:** Dominio 2 — AWS Artifact, programas de compliance, Organizations, SCPs, Control Tower, Audit Manager.
- **Dominios:** security
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - AWS Artifact
  - Shared Responsibility & Compliance
  - AWS Organizations
  - SCPs
  - AWS Control Tower
  - AWS Audit Manager
  - Data residency
  - Consolidated Billing
  - AWS License Manager
  - AWS Well-Architected Tool
- **JSON:** `packages/content/src/aws/clf-c02/sim-09-compliance-governance.json`

#### Simulacro 10 — Servicios de cómputo: EC2, ECS, EKS, Lambda, Fargate, Batch, Beanstalk

- **Focus:** Dominio 3 — Elegir servicio de cómputo según use case: VMs, contenedores, serverless, batch, PaaS.
- **Dominios:** technology
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - Elegir cómputo por caso de uso
  - EC2 vs Lambda
  - ECS vs EKS
  - Fargate
  - AWS Batch
  - Elastic Beanstalk
  - AWS Outposts
  - Lambda limits
  - AMI
  - Auto Scaling Groups
- **JSON:** `packages/content/src/aws/clf-c02/sim-10-compute-services.json`

#### Simulacro 11 — Modelos de pricing EC2: On-Demand, Reserved, Spot, Savings Plans, Dedicated

- **Focus:** Dominio 3/4 — Elegir el modelo de pricing correcto según el patrón de uso.
- **Dominios:** technology
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - On-Demand
  - Reserved Instances
  - Spot Instances
  - Savings Plans
  - Dedicated Host
  - Capacity Reservations
  - Mix pricing strategy
  - Standard vs Convertible RI
  - Free Tier
  - Sizing y pricing dimensions
- **JSON:** `packages/content/src/aws/clf-c02/sim-11-ec2-pricing-models.json`

#### Simulacro 12 — Almacenamiento: S3, EBS, EFS, FSx, Storage Gateway, Snow Family

- **Focus:** Dominio 3 — Elegir el servicio de almacenamiento correcto por caso de uso.
- **Dominios:** technology
- **Preguntas:** 10
- **Tiempo:** 20 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - S3 vs EBS vs EFS
  - S3 Storage Classes
  - S3 Intelligent-Tiering
  - EBS volume types
  - EFS
  - FSx family
  - Storage Gateway
  - Snow Family
  - S3 Versioning y Object Lock
  - S3 Transfer Acceleration
- **JSON:** `packages/content/src/aws/clf-c02/sim-12-storage-services.json`

#### Simulacro 13 — Bases de datos: RDS, Aurora, DynamoDB, ElastiCache, Redshift, DocumentDB

- **Focus:** Dominio 3 — Elegir el motor de BD adecuado por caso: relacional, NoSQL, cache, warehouse.
- **Dominios:** technology
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - RDS vs DynamoDB
  - Amazon Aurora
  - ElastiCache
  - Redshift
  - DocumentDB
  - RDS Multi-AZ vs Read Replicas
  - DynamoDB features
  - Aurora Serverless
  - Purpose-built databases
  - Database Migration Service (DMS)
- **JSON:** `packages/content/src/aws/clf-c02/sim-13-databases.json`

#### Simulacro 14 — Networking: VPC, subnets, gateways, DX, VPN, Route 53, CloudFront

- **Focus:** Dominio 3 — VPC, subnets pub/priv, IGW/NAT, Direct Connect, VPN, Route 53, CloudFront, Global Accelerator.
- **Dominios:** technology
- **Preguntas:** 10
- **Tiempo:** 20 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - Public vs Private subnet
  - NAT Gateway
  - Direct Connect vs VPN
  - CloudFront
  - Route 53
  - Global Accelerator vs CloudFront
  - VPC Peering vs Transit Gateway
  - VPC Endpoints
  - Elastic Load Balancer types
  - AWS PrivateLink
- **JSON:** `packages/content/src/aws/clf-c02/sim-14-networking.json`

#### Simulacro 15 — Serverless e integración: Lambda, API Gateway, SQS, SNS, EventBridge, Step Functions

- **Focus:** Dominio 3 — Arquitecturas event-driven y de integración.
- **Dominios:** technology
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - SQS vs SNS
  - API Gateway
  - EventBridge
  - Step Functions
  - SQS FIFO vs Standard
  - Kinesis Data Streams
  - Kinesis Data Firehose
  - AWS AppSync
  - Amazon MQ
  - Lambda triggers
- **JSON:** `packages/content/src/aws/clf-c02/sim-15-serverless-integration.json`

#### Simulacro 16 — AI/ML y analítica: Bedrock, SageMaker, servicios AI, Glue, Athena, QuickSight

- **Focus:** Dominio 3 — Bedrock, SageMaker, Rekognition, Comprehend, Polly, Translate, Textract, Glue, Athena, QuickSight, OpenSearch.
- **Dominios:** technology
- **Preguntas:** 10
- **Tiempo:** 20 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - Amazon Bedrock
  - Amazon SageMaker
  - AI services por caso
  - Amazon Comprehend
  - Athena
  - AWS Glue
  - QuickSight
  - Data Lake stack
  - OpenSearch
  - Amazon Q
- **JSON:** `packages/content/src/aws/clf-c02/sim-16-ai-ml-analytics.json`

#### Simulacro 17 — Herramientas de facturación: Cost Explorer, Budgets, Anomaly Detection, Pricing Calculator

- **Focus:** Dominio 4 — Cost Explorer, Budgets, Anomaly Detection, TCO Calculator, Pricing Calculator, tags de costo.
- **Dominios:** billing
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - AWS Cost Explorer
  - AWS Budgets
  - Cost Anomaly Detection
  - AWS Pricing Calculator
  - TCO Calculator (Migration Evaluator)
  - Cost Allocation Tags
  - Cost & Usage Report (CUR)
  - AWS Compute Optimizer
  - Billing Conductor
  - Marketplace y AWS Free Tier
- **JSON:** `packages/content/src/aws/clf-c02/sim-17-billing-tools.json`

#### Simulacro 18 — Support plans, Trusted Advisor, Well-Architected, Health

- **Focus:** Dominio 4 — AWS Support (Basic/Dev/Business/Enterprise), Trusted Advisor, Well-Architected Tool, Personal Health Dashboard.
- **Dominios:** billing
- **Preguntas:** 10
- **Tiempo:** 18 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - Support plans
  - Support Basic
  - Trusted Advisor
  - Well-Architected Framework
  - Personal Health Dashboard
  - Response times Support
  - IEM y TAM
  - AWS Knowledge & Training
  - AWS Partner Network (APN)
  - AWS Professional Services
- **JSON:** `packages/content/src/aws/clf-c02/sim-18-support-well-architected.json`

#### Simulacro 19 — Mixto #1: Simulacro completo tipo examen (todos los dominios)

- **Focus:** Mezcla proporcional a pesos oficiales: Cloud Concepts 24%, Security 30%, Technology 34%, Billing 12%.
- **Dominios:** concepts, security, technology, billing
- **Preguntas:** 12
- **Tiempo:** 20 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - 6 beneficios cloud
  - Shared Responsibility
  - IAM roles vs users
  - MFA on root
  - GuardDuty vs Inspector
  - Encryption in transit
  - Lambda vs EC2 vs Fargate
  - S3 storage classes
  - VPC Peering vs TGW
  - RDS vs DynamoDB
  - Support plans
  - Budgets vs Cost Explorer
- **JSON:** `packages/content/src/aws/clf-c02/sim-19-mixed-simulacro-1.json`

#### Simulacro 20 — Mixto #2: Simulacro final avanzado (todos los dominios, difícil)

- **Focus:** Simulacro final harder. Mezcla proporcional Concepts 24%, Security 30%, Technology 34%, Billing 12%.
- **Dominios:** concepts, security, technology, billing
- **Preguntas:** 12
- **Tiempo:** 20 min
- **Pass threshold:** 70%
- **Temas cubiertos:**
  - CAF vs Well-Architected vs 7 R
  - Hybrid architecture
  - Elasticity vs scalability vs HA
  - KMS envelope encryption
  - SCPs vs IAM Policies
  - Security services orchestration
  - Redshift vs Athena vs EMR
  - SQS vs SNS vs Kinesis
  - Auto Scaling patterns
  - Global architecture
  - Cost optimization avanzado
  - Support & Well-Architected
- **JSON:** `packages/content/src/aws/clf-c02/sim-20-mixed-simulacro-2.json`

## SAA-C03 — AWS Certified Solutions Architect – Associate

Certificación Associate para arquitectos de soluciones. Valida diseño de arquitecturas seguras, resilientes, de alto rendimiento y optimizadas en costo sobre AWS. Recomienda 1 año de experiencia diseñando en AWS.

- **Preguntas en examen real:** 65
- **Tiempo:** 130 min
- **Puntaje mínimo:** 720/1000

### Dominios oficiales

- **Design Secure Architectures** (`secure`) — 30%
- **Design Resilient Architectures** (`resilient`) — 26%
- **Design High-Performing Architectures** (`high-performing`) — 24%
- **Design Cost-Optimized Architectures** (`cost-optimized`) — 20%

### Simulacros disponibles (20 total)

#### Simulacro 01 — IAM para arquitectos: roles, trust policies y cross-account

- **Focus:** Dominio 1 — Design Secure Architectures (30%). Identidad, autorización, roles temporales, boundaries y federación multi-cuenta.
- **Dominios:** secure
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - Cross-account roles y ExternalId
  - Permission Boundaries y delegación
  - IAM Identity Center vs Cognito
  - Roles para servicios AWS (EC2 instance profile)
  - Organizations y SCPs
  - IAM condition MFA
  - AWS Control Tower y landing zone
  - IAM Access Analyzer y least privilege
  - Federación SAML/OIDC
  - Cross-account access con RAM
  - Session policies y roles temporales
  - Resource-based policies y cross-account S3
- **JSON:** `packages/content/src/aws/saa-c03/sim-01-iam-authz-fundamentals.json`

#### Simulacro 02 — KMS, Secrets Manager, Parameter Store y envelope encryption

- **Focus:** Dominio 1 — Design Secure Architectures (30%). Cifrado at-rest e in-transit, gestión de claves, secretos y rotación.
- **Dominios:** secure
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - Rotación de credenciales de BD
  - Envelope encryption y KMS
  - KMS Multi-Region keys
  - KMS vs CloudHSM
  - S3 encryption options
  - KMS key policies
  - Rotación de CMK
  - TLS end-to-end
  - Parameter Store para configuración
  - KMS Grants
  - Compartir secretos cross-region
  - Client-side vs server-side encryption
- **JSON:** `packages/content/src/aws/saa-c03/sim-02-kms-secrets-encryption.json`

#### Simulacro 03 — VPC deep dive: subnets, NAT, endpoints, PrivateLink, Transit Gateway

- **Focus:** Dominio 1 — Design Secure Architectures (30%). Segmentacion de red, salida a Internet controlada, acceso privado a servicios AWS y conectividad multi-VPC.
- **Dominios:** secure
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - Subnets publicas vs privadas y NAT
  - VPC Endpoints Gateway vs Interface
  - AWS PrivateLink para servicios de terceros
  - Transit Gateway vs VPC Peering
  - Security Groups vs NACLs
  - NAT Gateway HA y coste
  - Direct Connect vs VPN
  - VPC Flow Logs
  - AWS Network Firewall vs SG/NACL
  - IPv6 y dual-stack
  - Egress control con Network Firewall centralizado
  - Route 53 Resolver hibrido DNS
- **JSON:** `packages/content/src/aws/saa-c03/sim-03-vpc-networking-deep.json`

#### Simulacro 04 — Edge security: WAF, Shield Advanced, CloudFront, Route 53 DNSSEC

- **Focus:** Dominio 1 — Design Secure Architectures (30%). Proteccion en el borde: DDoS, WAF L7, CDN, DNSSEC.
- **Dominios:** secure
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - AWS WAF: managed rules y OWASP Top 10
  - AWS Shield Standard vs Advanced
  - CloudFront como proteccion perimetral
  - CloudFront Origin Access Control (OAC) para S3
  - Route 53 DNSSEC
  - WAF rate limiting y bot control
  - CloudFront signed URLs / cookies
  - Global Accelerator vs CloudFront
  - WAF cross-region con Firewall Manager
  - CloudFront Functions vs Lambda@Edge
  - ACM certificados publicos vs privados
  - Origin failover en CloudFront
- **JSON:** `packages/content/src/aws/saa-c03/sim-04-edge-security-waf-cloudfront.json`

#### Simulacro 05 — Data protection at scale: S3 encryption, policies, Object Lock, VPC Endpoints

- **Focus:** Dominio 1 — Design Secure Architectures (30%). Proteccion de datos en S3: cifrado, control de acceso, retencion legal, acceso privado.
- **Dominios:** secure
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - S3 Block Public Access
  - S3 Object Lock y compliance
  - S3 Access Points y buckets grandes
  - S3 replication cross-region con KMS
  - S3 VPC endpoint policy
  - S3 Presigned URLs
  - S3 Server Access Logging vs CloudTrail Data Events
  - S3 versioning y MFA Delete
  - S3 Access Analyzer
  - S3 encryption default y bucket keys
  - S3 Cross-Account acceso via bucket policy
  - S3 Storage Lens y visibilidad
- **JSON:** `packages/content/src/aws/saa-c03/sim-05-data-protection-s3.json`

#### Simulacro 06 — Detection & compliance: GuardDuty, Macie, Config, CloudTrail, Security Hub, Detective

- **Focus:** Dominio 1 — Design Secure Architectures (30%). Servicios de deteccion, cumplimiento y respuesta a incidentes.
- **Dominios:** secure
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - GuardDuty deteccion de amenazas
  - Macie deteccion de PII en S3
  - AWS Config compliance
  - Security Hub como agregador
  - Detective investigacion
  - CloudTrail multi-cuenta y multi-region
  - Inspector v2
  - AWS Audit Manager
  - Auto-remediation con EventBridge y SSM
  - AWS Trusted Advisor
  - CloudWatch Logs y metric filters para alerting
  - AWS Artifact para compliance reports
- **JSON:** `packages/content/src/aws/saa-c03/sim-06-detection-compliance.json`

#### Simulacro 07 — EC2 HA patterns: Multi-AZ ASG, ELB (ALB/NLB/GLB), health checks

- **Focus:** Dominio 2 — Design Resilient Architectures (26%). Alta disponibilidad de computo elastico y balanceo de carga.
- **Dominios:** resilient
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - Multi-AZ Auto Scaling Group
  - ALB vs NLB vs GLB
  - Health checks EC2 vs ELB
  - Sticky sessions
  - Auto Scaling policies
  - Launch Template y AMIs golden
  - Placement Groups para HA
  - ELB cross-zone load balancing
  - Multi-AZ vs Multi-Region
  - Lifecycle hooks y warm-up
  - Termination protection y stateful instances
  - Session state externo
- **JSON:** `packages/content/src/aws/saa-c03/sim-07-ec2-ha-patterns.json`

#### Simulacro 08 — RDS HA/DR: Multi-AZ, read replicas, Aurora Global Database, backups

- **Focus:** Dominio 2 — Design Resilient Architectures (26%). Alta disponibilidad y disaster recovery de bases de datos relacionales.
- **Dominios:** resilient
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - RDS Multi-AZ vs Read Replicas
  - Aurora Global Database
  - RDS backups: automated vs manual snapshots
  - DB engines: RDS vs Aurora
  - RDS Proxy
  - Aurora Serverless v2
  - DMS para migracion y replicacion
  - Backup centralizado con AWS Backup
  - Aurora Backtrack
  - Read replica lag y consistency
  - DynamoDB Global Tables como alternativa
  - Snapshot cross-region para DR
- **JSON:** `packages/content/src/aws/saa-c03/sim-08-rds-ha-dr.json`

#### Simulacro 09 — Serverless resilience: Lambda destinations, SQS DLQ, EventBridge retries, Step Functions

- **Focus:** Dominio 2 — Design Resilient Architectures (26%). Patrones de resiliencia en arquitecturas serverless y event-driven.
- **Dominios:** resilient
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - SQS Dead Letter Queue
  - Lambda destinations vs DLQ
  - Step Functions vs choreography con EventBridge
  - EventBridge retries y archives
  - SQS FIFO vs Standard
  - Lambda concurrency y throttling
  - SNS fan-out con SQS
  - Idempotency en handlers Lambda
  - API Gateway throttling y caching
  - Circuit breaker pattern
  - Kinesis vs SQS para streams
  - Step Functions Wait y Callback
- **JSON:** `packages/content/src/aws/saa-c03/sim-09-serverless-resilience.json`

#### Simulacro 10 — DR patterns: backup-restore, pilot light, warm standby, multi-site active-active, RTO/RPO

- **Focus:** Dominio 2 — Design Resilient Architectures (26%). Estrategias de disaster recovery y decision framework RTO/RPO.
- **Dominios:** resilient
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - RTO vs RPO conceptos
  - 4 estrategias DR AWS
  - AWS Elastic Disaster Recovery (DRS)
  - Route 53 failover para DR
  - S3 Cross-Region Replication para DR
  - Aurora Global Database para DR
  - DynamoDB Global Tables para DR
  - Chaos engineering con AWS Fault Injection
  - Backup vault lock
  - Region evacuation con Route 53 ARC
  - AWS Systems Manager runbooks para DR
  - Testing DR periodico
- **JSON:** `packages/content/src/aws/saa-c03/sim-10-dr-patterns.json`

#### Simulacro 11 — Route 53 routing policies: simple, weighted, latency, failover, geolocation, multi-value

- **Focus:** Dominio 2 — Design Resilient Architectures (26%). Politicas de routing DNS y decision framework.
- **Dominios:** resilient
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - Weighted routing para canary
  - Latency vs Geolocation
  - Multivalue answer routing
  - Geolocation para compliance
  - IP-based routing
  - Alias records vs CNAME
  - Private hosted zones
  - TTL y propagacion DNS
  - Health checks calculated
  - Route 53 Traffic Flow
  - Route 53 vs Global Accelerator para failover
  - Split-horizon DNS
- **JSON:** `packages/content/src/aws/saa-c03/sim-11-route53-routing.json`

#### Simulacro 12 — Caching: CloudFront, ElastiCache (Redis vs Memcached), DAX, S3 Transfer Acceleration

- **Focus:** Dominio 3 — Design High-Performing Architectures (24%). Estrategias de caching a distintos niveles: edge, aplicacion, DB, transferencia.
- **Dominios:** high-performing
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - ElastiCache Redis vs Memcached
  - DAX para DynamoDB
  - CloudFront caching estrategias
  - S3 Transfer Acceleration
  - Cache-aside vs write-through
  - CloudFront origin shield
  - ElastiCache cluster mode enabled
  - S3 Multi-Region Access Points
  - CloudFront con Lambda@Edge personalizacion
  - Amazon MemoryDB for Redis
  - API Gateway caching
  - TTL y cache stampede
- **JSON:** `packages/content/src/aws/saa-c03/sim-12-caching-cloudfront-elasticache.json`

#### Simulacro 13 — Databases performance & choice: DynamoDB, RDS, Aurora, Redshift, Neptune, OpenSearch

- **Focus:** Dominio 3 — Design High-Performing Architectures (24%). Decision framework: que base de datos para que carga.
- **Dominios:** high-performing
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - OLTP vs OLAP decision
  - DynamoDB vs Aurora vs DocumentDB
  - Amazon Neptune para graph
  - Timestream para time-series
  - QLDB ledger inmutable
  - OpenSearch para logs y search
  - Redshift architecture y RA3
  - Aurora Serverless v2
  - DynamoDB single-table design
  - Keyspaces (Cassandra) vs DynamoDB
  - RDS read replicas para escalar lecturas
  - DocumentDB vs MongoDB en EC2
- **JSON:** `packages/content/src/aws/saa-c03/sim-13-databases-choice.json`

#### Simulacro 14 — DynamoDB deep: partition keys, GSI/LSI, on-demand vs provisioned, DAX, Streams, TTL

- **Focus:** Dominio 3 — Design High-Performing Architectures (24%). Modelado, indexes, capacity y features avanzadas de DynamoDB.
- **Dominios:** high-performing
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - Partition key design y hot partitions
  - GSI vs LSI
  - On-demand vs Provisioned capacity
  - DynamoDB Streams
  - TTL para expiration automatica
  - Transactions DDB
  - DAX cache
  - DynamoDB Scan vs Query
  - Global Tables multi-region
  - PITR Point-in-Time Recovery
  - Adaptive capacity y burst
  - DynamoDB export to S3
- **JSON:** `packages/content/src/aws/saa-c03/sim-14-dynamodb-deep.json`

#### Simulacro 15 — Compute performance: EC2 instance families, Placement Groups, EBS types, Nitro

- **Focus:** Dominio 3 — Design High-Performing Architectures (24%). Seleccion de compute y storage para performance optimo.
- **Dominios:** high-performing
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - EC2 instance families
  - EBS types gp3 vs io2 vs st1
  - Placement Groups
  - EFA Elastic Fabric Adapter
  - Instance Store vs EBS
  - EBS Multi-Attach
  - AMI y user data para bootstrap
  - AWS Nitro System
  - Spot Instances para reducir coste
  - Spot Fleet y allocation strategies
  - Graviton ARM para reducir coste
  - Fargate vs EC2 launch types
- **JSON:** `packages/content/src/aws/saa-c03/sim-15-compute-performance.json`

#### Simulacro 16 — Data pipelines: Kinesis, MSK, Glue, EMR, Athena, Redshift Spectrum

- **Focus:** Dominio 3 — Design High-Performing Architectures (24%). Ingestion, ETL, analytics batch y streaming.
- **Dominios:** high-performing
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - Kinesis Data Streams vs Firehose
  - MSK vs Kinesis
  - Athena para queries S3
  - AWS Glue ETL
  - EMR para big data
  - Redshift Spectrum para data lake queries
  - AWS Lake Formation
  - Kinesis Data Analytics / Managed Flink
  - Kinesis Firehose transformations
  - QuickSight para visualization
  - S3 formats para analytics
  - AWS DataSync para transferencia masiva
- **JSON:** `packages/content/src/aws/saa-c03/sim-16-data-pipelines.json`

#### Simulacro 17 — Cost optimization compute: Savings Plans vs Reserved vs Spot vs On-Demand

- **Focus:** Dominio 4 — Design Cost-Optimized Architectures (20%). Decision framework compute pricing.
- **Dominios:** cost-optimized
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - Savings Plans vs Reserved Instances
  - Spot Instances casos de uso
  - Right-sizing con Compute Optimizer
  - Mixed Instances Policy en ASG
  - Lambda cost optimization
  - EC2 idle detection
  - Fargate vs Lambda vs EC2 costs
  - Reserved Instance types Standard vs Convertible
  - Data transfer costs
  - Fargate Spot
  - Elastic IP y coste hidden
  - AWS Savings Plans coverage y utilization
- **JSON:** `packages/content/src/aws/saa-c03/sim-17-cost-optimization-compute.json`

#### Simulacro 18 — Storage cost: S3 Intelligent-Tiering, lifecycle, Glacier tiers, EBS snapshots

- **Focus:** Dominio 4 — Design Cost-Optimized Architectures (20%). Storage classes, lifecycle y tiering para reducir costo.
- **Dominios:** cost-optimized
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - S3 storage classes
  - S3 Lifecycle policies
  - S3 Intelligent-Tiering
  - Glacier retrieval tiers
  - EBS snapshot lifecycle
  - S3 Storage Lens para visibility
  - S3 requester pays
  - EFS Infrequent Access
  - S3 Bucket Keys para reducir KMS cost
  - S3 minimum storage duration
  - S3 multipart upload cleanup
  - AWS Backup cost optimization
- **JSON:** `packages/content/src/aws/saa-c03/sim-18-storage-cost.json`

#### Simulacro 19 — Right-sizing y waste elimination: Trusted Advisor, Compute Optimizer, Cost Explorer, Budgets

- **Focus:** Dominio 4 — Design Cost-Optimized Architectures (20%). Herramientas de visibility, right-sizing y control presupuestario.
- **Dominios:** cost-optimized
- **Preguntas:** 12
- **Tiempo:** 25 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - AWS Cost Explorer
  - AWS Budgets para alertas y actions
  - Trusted Advisor cost checks
  - Cost Allocation Tags
  - Reserved Instance Optimization Trusted Advisor
  - Cost Anomaly Detection
  - AWS Compute Optimizer
  - S3 Intelligent-Tiering vs Storage Lens
  - Data transfer optimization
  - AWS Marketplace y SaaS savings
  - AWS Well-Architected Cost pillar
  - Managed services vs self-managed cost
- **JSON:** `packages/content/src/aws/saa-c03/sim-19-right-sizing-waste.json`

#### Simulacro 20 — Simulacro FINAL mixto: los 4 dominios proporcional a pesos oficiales

- **Focus:** Simulacro final tipo examen real: 4 dominios (Secure 30%, Resilient 26%, High-Performing 24%, Cost 20%).
- **Dominios:** secure, resilient, high-performing, cost-optimized
- **Preguntas:** 12
- **Tiempo:** 30 min
- **Pass threshold:** 72%
- **Temas cubiertos:**
  - IAM roles cross-account con MFA
  - S3 encryption y compliance
  - WAF y Shield para app publica
  - Multi-AZ ASG + ALB
  - Aurora Global Database para DR
  - SQS DLQ para poison pill
  - DynamoDB partition key design
  - ElastiCache Redis vs DAX
  - Athena optimization
  - Savings Plans vs Spot
  - S3 lifecycle y storage classes
  - Compute Optimizer right-sizing
- **JSON:** `packages/content/src/aws/saa-c03/sim-20-mixed-final.json`
