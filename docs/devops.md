# DevOps — CI/CD · Contenedores · SRE

Todo lo que un DevOps engineer debe dominar para llevar código de commit a producción de forma segura, rápida y observable: cultura y métricas DORA, Git workflows, CI/CD pipelines, Docker y Kubernetes profundo, Helm/Kustomize, IaC (Terraform/Ansible), monitoring stack (Prometheus/Grafana/Loki/Jaeger), SLO management, secretos, container security, supply chain (SLSA/Sigstore), estrategias de deployment (blue/green, canary, feature flags), disaster recovery, chaos engineering, on-call. Escenarios reales de operaciones — no sólo "qué es", sino "cuándo, cómo y por qué".

## Áreas cubiertas

- **Cultura + métricas DORA** (`culture`) — CALMS, deploy frequency, lead time, MTTR, change failure rate.
- **Git + CI** (`vcs-ci`) — Trunk-based, GitFlow, GitHub Actions, Jenkins, caching, artefactos.
- **Docker + contenedores** (`containers`) — Dockerfile, multi-stage, layer cache, security scanning, distroless.
- **Kubernetes** (`kubernetes`) — Pods, Deployments, StatefulSets, Services, Ingress, RBAC, HPA.
- **Infrastructure as Code** (`iac`) — Terraform state, modules, Ansible, Pulumi, GitOps con ArgoCD/Flux.
- **Monitoreo + observabilidad** (`monitoring`) — Prometheus, Grafana, Loki, Jaeger, OpenTelemetry, SLI/SLO.
- **DevSecOps** (`security`) — SAST/DAST/SCA, container security, secretos (Vault/KMS), OPA.
- **Networking + service mesh** (`networking`) — DNS, LB, CDN, ingress controllers, Istio, mTLS, Zero Trust.
- **Deployment strategies** (`deployment`) — Blue/green, canary, rolling, feature flags, dark launches.
- **Reliability + on-call** (`reliability`) — DR, backups, chaos engineering, incident response, blameless PM.

## Sims (40 total)

### Simulacro 01 — Cultura DevOps y métricas DORA

- **Focus:** ¿Qué ES DevOps realmente? Cultura antes que herramientas. Métricas DORA que la industria usa para medir performance de equipos. CALMS framework. Anti-patrones comunes.
- **Áreas:** culture
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué ES DevOps?
  - CALMS framework
  - Métricas DORA — qué son
  - El mito velocidad vs estabilidad
  - 'You build it, you run it'
  - Deploy frequency — ¿por qué importa?
  - Lead Time — la métrica olvidada
  - Blameless postmortem
  - Toil — qué es y por qué reducirlo
  - Error budgets — la herramienta política
  - Continuous Delivery vs Continuous Deployment
  - Trunk-based development vs GitFlow
  - Feature flags — desacoplar deploy de release
  - Shift Left — mover controles río arriba
  - Infrastructure as Code — el cambio mental
  - Chaos Engineering — testear defensas
  - Incident Response — el plan que nunca ejercitas
  - On-call — burnout y sostenibilidad
  - MTTR — recovery time
  - Continuous Learning — el diferenciador
- **JSON:** `packages/content/src/tech/devops/sim-01-devops-culture-and-dora.json`

### Simulacro 02 — Continuous Delivery Fundamentals

- **Focus:** CI vs Continuous Delivery vs Continuous Deployment. Pipeline stages (build/test/deploy). Pipeline as code. Artifact management. Semantic versioning. Release cadence, gates, approvals. Rollback strategies. La diferencia REAL entre las tres 'C's que todos confunden.
- **Áreas:** vcs-ci, deployment
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - CI vs CD vs CD — diferencias fundamentales
  - Pipeline stages básicas
  - Pipeline as Code
  - Artifact management
  - Semantic Versioning (SemVer)
  - Release cadence
  - Gates y approvals
  - Rollback vs roll forward
  - Blue-Green deployment
  - Canary deployment
  - Feature flags
  - Test pyramid
  - Trunk-based development y CI
  - Cache strategies en CI
  - Matrix builds
  - Secrets management en CI
  - Database migrations en CD
  - Progressive delivery techniques
  - Monorepo CI strategy
  - GitOps
- **JSON:** `packages/content/src/tech/devops/sim-02-continuous-delivery-fundamentals.json`

### Simulacro 03 — Git workflows y branching strategies

- **Focus:** Trunk-based vs GitFlow vs GitHub Flow. PR review process. Protected branches. Signed commits. Rebase vs merge. Cherry-pick. Bisect. Hooks. Monorepo vs polyrepo. Submodules. La estrategia de branching define cómo trabaja tu equipo.
- **Áreas:** vcs-ci
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Merge vs Rebase — cuál usar
  - Git branch básico
  - GitFlow — cuándo (y cuándo no)
  - GitHub Flow
  - PR review process
  - Protected branches
  - Signed commits
  - git bisect
  - cherry-pick
  - Git hooks
  - Monorepo vs polyrepo
  - Git submodules
  - git reset vs revert
  - Conventional commits
  - Merge queues
  - git reflog — la red de seguridad
  - Squash and merge
  - Large files en Git
  - Supply chain security en Git
  - Trunk-based development at scale
- **JSON:** `packages/content/src/tech/devops/sim-03-git-workflows-and-branching.json`

### Simulacro 04 — GitHub Actions, Jenkins y CI platforms

- **Focus:** GitHub Actions (workflows, jobs, steps, matrix, secrets, environments). Jenkins pipelines (declarative vs scripted). GitLab CI, CircleCI. Caching. Parallel jobs. Reusable workflows. Artifact passing. Cuándo usar cuál.
- **Áreas:** vcs-ci
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - GitHub Actions básicos
  - Jenkins vs GitHub Actions
  - Triggers en GitHub Actions
  - Jenkins declarative vs scripted
  - Matrix strategy
  - Secrets y environments
  - Caching en GHA
  - Reusable workflows
  - Artifact passing entre jobs
  - Self-hosted runners
  - GitLab CI
  - CircleCI orbs
  - Parallelization strategies
  - Docker en CI
  - CI observability
  - Concurrency y cancel-in-progress
  - OIDC federated auth
  - Pull-based vs push-based CI
  - Security en CI/CD platforms
  - Cost management en CI
- **JSON:** `packages/content/src/tech/devops/sim-04-github-actions-and-jenkins.json`

### Simulacro 05 — Docker fundamentals y best practices

- **Focus:** Dockerfile best practices. Layer caching order. Multi-stage builds. Distroless images. Non-root user. ENTRYPOINT vs CMD (exec vs shell form). .dockerignore. Health checks. Image size optimization. Docker compose. Los DETALLES que separan producción de tutorial.
- **Áreas:** containers
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué ES un container?
  - Dockerfile basics
  - Layer caching order
  - Multi-stage builds
  - Distroless y Alpine
  - Non-root user
  - ENTRYPOINT vs CMD
  - .dockerignore
  - HEALTHCHECK
  - Image size optimization
  - Docker volumes vs bind mounts
  - Docker networking
  - Docker Compose
  - Docker secrets
  - Docker logging
  - PID 1 signal handling
  - OCI standards
  - Debugging containers
  - Docker en producción anti-patrones
  - BuildKit y build optimization
- **JSON:** `packages/content/src/tech/devops/sim-05-docker-fundamentals.json`

### Simulacro 06 — Container security y registries

- **Focus:** Image scanning (Trivy, Grype). SBOM (Syft). Signature verification (cosign, Sigstore). Private registries (Harbor, ECR). Image pull secrets. Image immutability. Base image selection. Runtime security (Falco). CVE management. Todo lo que un container debe pasar antes de correr en prod.
- **Áreas:** security, containers
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué es un container registry?
  - ¿Qué es una CVE?
  - Image scanning con Trivy
  - SBOM (Software Bill of Materials)
  - Image signing con cosign
  - Private registries
  - Image pull secrets
  - Image immutability
  - Base image selection
  - Runtime security con Falco
  - Pod Security Standards
  - Network policies
  - Security context en Pods
  - CVE management workflow
  - SLSA framework
  - Registry authentication
  - Container escape scenarios
  - Image provenance verification en producción
  - Secrets rotation en containers
  - Zero-trust container security
- **JSON:** `packages/content/src/tech/devops/sim-06-container-security-and-registries.json`

### Simulacro 07 — Kubernetes Fundamentals

- **Focus:** Qué ES Kubernetes realmente. Arquitectura (control plane vs data plane), objetos core (Pods, Deployments, ReplicaSets), Services (ClusterIP/NodePort/LoadBalancer), Ingress, ConfigMaps, Secrets, Namespaces. kubectl basics. Por qué existe cada pieza y cuándo NO usarla.
- **Áreas:** kubernetes
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué ES Kubernetes?
  - Pod — la unidad atómica
  - Control plane vs data plane
  - Deployment vs ReplicaSet vs Pod
  - Services — ClusterIP, NodePort, LoadBalancer
  - Ingress — HTTP routing
  - ConfigMaps vs Secrets
  - Namespaces — separación lógica
  - kubectl — anatomía y comandos esenciales
  - Kubelet — el agente del nodo
  - Reconciliation loop — el patrón central
  - Liveness, Readiness, Startup probes
  - Resource requests vs limits
  - Labels vs Annotations vs Selectors
  - kube-proxy — cómo funcionan los Services
  - etcd — el corazón del estado
  - Rolling update strategy — RollingUpdate vs Recreate
  - Debugging Pods pending y crashloop
  - API extension — CRDs y Operators
  - Cuándo NO usar Kubernetes
- **JSON:** `packages/content/src/tech/devops/sim-07-kubernetes-fundamentals.json`

### Simulacro 08 — Kubernetes Workloads y Autoscaling

- **Focus:** Workload controllers avanzados: StatefulSets (identity, ordering, persistent storage), DaemonSets, Jobs, CronJobs, PodDisruptionBudgets. Autoscaling: HPA, VPA, Cluster Autoscaler. Resource requests/limits, QoS classes. Entender cuándo cada tipo aplica y por qué.
- **Áreas:** kubernetes
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Deployment vs StatefulSet — cuándo cada uno
  - DaemonSet — un pod por nodo
  - Jobs — trabajos batch
  - PodDisruptionBudget — proteger disponibilidad
  - Horizontal Pod Autoscaler (HPA)
  - Vertical Pod Autoscaler (VPA)
  - QoS classes — Guaranteed, Burstable, BestEffort
  - Cluster Autoscaler vs Karpenter
  - StatefulSet — identity y volumeClaimTemplates
  - InitContainers vs Sidecars
  - Pod affinity, anti-affinity, topology spread
  - Graceful shutdown y SIGTERM
  - PriorityClass y preemption
  - Batch on Kubernetes — Jobs con parallelism sofisticado
  - PodDisruptionBudget vs eviction API
  - ResourceQuota y LimitRange
  - Container startup ordering y readiness gates
  - Autoscaling matrix — HPA + VPA + CA + Karpenter
  - Job idempotency y retries
  - Multi-tenant workload isolation
- **JSON:** `packages/content/src/tech/devops/sim-08-kubernetes-workloads.json`

### Simulacro 09 — Kubernetes Networking y Storage

- **Focus:** CNI plugins (Calico, Cilium, Flannel), Network Policies, Services vs Endpoints, DNS interno (CoreDNS), PersistentVolumes vs Claims, StorageClasses, CSI drivers, dynamic provisioning, StatefulSet volumeClaimTemplates. Entender el data plane real del cluster.
- **Áreas:** kubernetes
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - El modelo de red de Kubernetes
  - CoreDNS — DNS interno del cluster
  - CNI plugins — Calico, Cilium, Flannel
  - NetworkPolicy — firewall entre Pods
  - Services vs Endpoints vs EndpointSlices
  - PersistentVolume vs PersistentVolumeClaim
  - StorageClass y dynamic provisioning
  - CSI (Container Storage Interface)
  - StatefulSet volumeClaimTemplates
  - Ingress Controllers vs Gateway API
  - Headless Services
  - Network Policy egress y DNS
  - IPAM y Pod IP exhaustion
  - Access Modes — RWO, ROX, RWX, RWOP
  - Service topology y externalTrafficPolicy
  - MTU, jumbo frames, y network performance
  - Ephemeral vs persistent volumes
  - Snapshot y backup de PVCs
  - Service Mesh — cuándo aplica
  - Multi-cluster networking y federation
- **JSON:** `packages/content/src/tech/devops/sim-09-kubernetes-networking-storage.json`

### Simulacro 10 — Helm, Kustomize y GitOps

- **Focus:** Package managers para K8s: Helm (charts, templates, values, releases, dependencies, hooks, rollbacks) vs Kustomize (bases, overlays, strategic merge patches). Cuándo cada uno. GitOps con ArgoCD/Flux. Comparación con raw manifests.
- **Áreas:** iac
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - El problema que Helm/Kustomize resuelven
  - Estructura de Helm chart
  - Templating con Helm — values y Go templates
  - Helm releases, upgrades, rollbacks
  - Kustomize — base y overlays
  - Strategic Merge Patch vs JSON 6902
  - Helm dependencies y umbrella charts
  - Helm hooks
  - GitOps — el pattern
  - ArgoCD vs Flux
  - Helm vs Kustomize — cuándo cada uno
  - Secrets in GitOps — el problema
  - Helm testing y linting
  - Progressive delivery — Argo Rollouts y Flagger
  - Helm anti-patterns y pitfalls
  - Kustomize generators y transformers
  - ArgoCD Applications, ApplicationSets, App-of-Apps
  - Helm y IaC — comparación con Terraform
  - Chart repositories y OCI registries
  - El futuro — Timoni, cdk8s, alternativas
- **JSON:** `packages/content/src/tech/devops/sim-10-helm-and-kustomize.json`

### Simulacro 11 — Kubernetes Security

- **Focus:** RBAC (Roles, ClusterRoles, RoleBindings), ServiceAccounts, Pod Security Standards, Network Policies aplicadas a security, admission controllers (OPA Gatekeeper, Kyverno), image pull secrets, runtime security (Falco), secrets management (Vault CSI, External Secrets Operator).
- **Áreas:** security, kubernetes
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - RBAC — Role vs ClusterRole
  - ServiceAccounts — identidad de Pods
  - Pod Security Standards
  - SecurityContext — configurando el Pod
  - Admission controllers — validating y mutating
  - OPA Gatekeeper vs Kyverno
  - Image pull secrets y registries privados
  - Falco — runtime security
  - Vault CSI Provider y External Secrets Operator
  - Supply chain security — image signing y provenance
  - NetworkPolicy — zero trust networking
  - Audit logs y compliance
  - Escalation via ServiceAccount tokens
  - Cluster hardening — CIS benchmark
  - Container escape y kernel isolation
  - Encryption at rest para etcd
  - Image vulnerability scanning
  - Attack scenarios end-to-end
  - Zero trust workload identity — SPIFFE/SPIRE
  - Security posture management
- **JSON:** `packages/content/src/tech/devops/sim-11-kubernetes-security.json`

### Simulacro 12 — Terraform Fundamentals (HCL, State, Modules, Workflow)

- **Focus:** Infrastructure as Code con Terraform: HCL sintaxis, providers, resources, variables/outputs, state file (local vs remote), state locking, workflow init/plan/apply/destroy, modules (locales y del registry), workspaces, imports. Base sólida sobre por qué Terraform funciona así.
- **Áreas:** iac
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué ES Infrastructure as Code?
  - HCL — sintaxis básica
  - Terraform workflow — init/plan/apply
  - State file — qué es y por qué existe
  - Backend remoto — S3 + DynamoDB
  - Providers y versionado
  - Variables e inputs
  - Módulos locales
  - Módulos del registry
  - Workspaces
  - terraform import
  - count vs for_each
  - Data sources
  - Outputs y composición
  - lifecycle meta-argument
  - Depends_on explícito
  - Provisioners como último recurso
  - terraform_data y null_resource
  - Terraform Cloud vs OSS
  - Estrategia team-level
- **JSON:** `packages/content/src/tech/devops/sim-12-terraform-fundamentals.json`

### Simulacro 13 — Ansible y gestion de configuracion

- **Focus:** Ansible como herramienta de configuration management: playbooks, inventory static y dinamico, roles y Galaxy, idempotency, handlers, when y loops, Vault, comparacion con Chef/Puppet/SaltStack, agent-less vs agent, push vs pull, ad-hoc, facts, Jinja2, block/rescue, delegate_to, ansible-lint.
- **Áreas:** iac
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Que es Ansible
  - Estructura de un playbook
  - Inventory static vs dinamico
  - Idempotency
  - Handlers y notify
  - Ansible vs Chef vs Puppet vs SaltStack
  - Push vs Pull model
  - Ad-hoc commands
  - Facts y setup module
  - when y loops
  - Roles y Ansible Galaxy
  - Ansible Vault
  - Templates Jinja2
  - block/rescue/always (error handling)
  - delegate_to y local_action
  - ansible-lint
  - Precedencia de variables
  - Testing con Molecule
  - Performance a escala
  - Ansible vs Terraform vs immutable infra
- **JSON:** `packages/content/src/tech/devops/sim-13-ansible-and-config-management.json`

### Simulacro 14 — Fundamentos cloud + estrategias multi-cloud

- **Focus:** Cloud desde primeros principios: IaaS/PaaS/SaaS, VPC design, multi-region, hybrid, lock-in tradeoffs, portable IaC, Kubernetes como abstracción, cloud-native (12-factor), AWS vs GCP vs Azure, cross-cloud networking. Cuándo multi-cloud tiene sentido y cuándo es teatro caro.
- **Áreas:** networking, iac
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - IaaS vs PaaS vs SaaS
  - VPC — public vs private subnets
  - IGW vs NAT Gateway
  - Active/Active vs Active/Passive multi-region
  - Cloud lock-in — tradeoffs reales
  - Terraform providers — portabilidad real
  - Kubernetes como capa de portabilidad
  - 12-factor app — principios cloud-native
  - AWS vs GCP vs Azure — fortalezas
  - Hybrid cloud
  - Cross-cloud networking
  - Multi-cloud — cuándo tiene sentido
  - VPC Peering vs Transit Gateway
  - Prime Video Lambda → ECS
  - Cloud regions vs AZs
  - Cloud-native design
  - HashiCorp — herramientas portables
  - Egress costs
  - Basecamp exit cloud
  - Cloud vendor negociación
- **JSON:** `packages/content/src/tech/devops/sim-14-cloud-fundamentals-and-multi-cloud.json`

### Simulacro 15 — GitOps con ArgoCD y Flux

- **Focus:** GitOps como paradigma: Git como fuente de verdad, reconciliación continua, drift detection. ArgoCD (Application, Project, sync policies, self-heal, prune, ApplicationSets, App of Apps). Flux v2 (source-controller, kustomize-controller, helm-controller). Secretos en GitOps (Sealed Secrets, SOPS, External Secrets Operator). Environments as branches vs folders. Multi-cluster. Progressive delivery con Argo Rollouts.
- **Áreas:** iac, deployment
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué ES GitOps?
  - Push vs Pull deployment model
  - ArgoCD Application CRD
  - ArgoCD Projects y multi-tenancy
  - Drift detection y self-heal
  - Environments as branches vs folders
  - PR-based promotion
  - Secretos en GitOps — Sealed Secrets
  - SOPS (Secrets OPerationS)
  - External Secrets Operator
  - App of Apps pattern
  - ApplicationSets y generators
  - Flux v2 architecture
  - ArgoCD vs Flux comparison
  - Multi-cluster GitOps patterns
  - Progressive delivery con Argo Rollouts
  - Sync waves y hooks
  - Anti-patterns en GitOps
  - GitOps para infraestructura (Terraform + Crossplane)
  - Disaster Recovery con GitOps
- **JSON:** `packages/content/src/tech/devops/sim-15-gitops-with-argocd-flux.json`

### Simulacro 16 — Pulumi, CDK y IaC moderno

- **Focus:** IaC más allá de Terraform: Pulumi (TypeScript/Python/Go), AWS CDK (constructs L1/L2/L3), Crossplane (K8s-native), cdk8s, tradeoffs DSL vs código real, testing (unit/integration/snapshot), policy as code (OPA/Rego, Sentinel, CDK Aspects), state comparativo y backend management.
- **Áreas:** iac
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - IaC en lenguajes reales vs DSL
  - Pulumi — modelo de ejecución
  - AWS CDK — L1, L2, L3 constructs
  - CDK — synth y CloudFormation
  - Crossplane — K8s-native infra
  - cdk8s y cdktf — CDK más allá de AWS
  - Testing IaC — unit tests
  - OPA + Rego para policy as code
  - HashiCorp Sentinel vs OPA
  - CDK Aspects — policy embedded
  - State management comparativo
  - Multi-language IaC — Pulumi cross-language
  - Backend management strategies
  - Integration testing con terratest
  - Snapshot testing y su valor
  - IaC para GitOps — Crossplane vs Argo + Terraform
  - Pulumi Automation API
  - Compositions en Crossplane
  - OpenTofu, license, market state
  - Elección de tool para tu contexto
- **JSON:** `packages/content/src/tech/devops/sim-16-pulumi-cdk-and-modern-iac.json`

### Simulacro 17 — Prometheus y métricas

- **Focus:** Arquitectura Prometheus (server, exporters, PushGateway), PromQL, tipos de métricas (counter, gauge, histogram, summary), cardinality explosion, recording/alerting rules, federation, Cortex/Thanos/Mimir para long-term storage y HA.
- **Áreas:** monitoring
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Modelo pull de Prometheus
  - Tipos de métricas: Counter
  - Histogram vs Summary
  - Cardinality explosion
  - PromQL: rate vs irate vs increase
  - Recording rules vs alerting rules
  - Alertmanager: routing y silencing
  - Long-term storage: Thanos vs Cortex vs Mimir
  - Federation
  - Exporters ecosystem
  - PushGateway — cuándo (y cuándo NO)
  - Service Discovery en Kubernetes
  - RED y USE methods
  - TSDB internals
  - Alerts efectivos: symptoms vs causes
  - Native Histograms
  - Exemplars: bridge metrics → traces
  - Scrape config avanzado
  - Multi-window burn rate alerts
  - Prometheus vs alternatives
- **JSON:** `packages/content/src/tech/devops/sim-17-prometheus-and-metrics.json`

### Simulacro 18 — Grafana y dashboards

- **Focus:** Diseño de dashboards, variables/templates, Alertmanager en Grafana, notification channels, RED/USE panels, integración Loki + Tempo, dashboards as code (Grafonnet, Terraform), unified observability.
- **Áreas:** monitoring
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué es Grafana?
  - Variables y templates en dashboards
  - RED dashboard design
  - Grafana Alerting (nuevo, unificado)
  - Panels: elección del tipo correcto
  - Data sources y federated queries
  - Loki integration
  - Tempo integration
  - Dashboards as code
  - Grafana permissions y multi-tenancy
  - Panel transformations
  - Grafana Loki + Tempo + Prometheus workflow
  - Grafana OnCall
  - Panel best practices: color, units, thresholds
  - Grafana Faro y RUM
  - Alertmanager routing en Grafana
  - Performance de Grafana
  - Annotations
  - Grafana Cloud vs self-hosted
  - Grafana observability roadmap
- **JSON:** `packages/content/src/tech/devops/sim-18-grafana-and-dashboards.json`

### Simulacro 19 — Logging: ELK y Loki

- **Focus:** Structured logging JSON, correlation IDs, log levels, ELK stack (Elasticsearch, Logstash, Kibana), Loki (label-based), Fluentd vs Fluent Bit, retention strategies, cost management, PII redaction, log sampling.
- **Áreas:** monitoring
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Structured logging vs plain text
  - Log levels: uso apropiado
  - Correlation IDs y trace context
  - ELK stack arquitectura
  - Loki vs Elasticsearch
  - Fluentd vs Fluent Bit
  - Log retention strategies
  - PII redaction
  - Log sampling
  - Elasticsearch shards y replicas
  - LogQL basics
  - Loki label design
  - OpenSearch: fork y estado actual
  - Logs vs metrics vs traces
  - Kubernetes logging arquitectura
  - Grok patterns y parsing
  - Log-based metrics
  - Log ingestion backpressure
  - Splunk: cuándo tiene sentido
  - Logging maturity model
- **JSON:** `packages/content/src/tech/devops/sim-19-logging-elk-loki.json`

### Simulacro 20 — Distributed tracing

- **Focus:** OpenTelemetry (SDK, Collector, exporters), Jaeger, Tempo, Zipkin, spans/traces/baggage, sampling strategies (head/tail/adaptive), auto-instrumentation vs manual, W3C Trace Context, exemplars.
- **Áreas:** monitoring
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué es distributed tracing?
  - OpenTelemetry: componentes
  - Spans y attributes
  - W3C Trace Context propagation
  - Sampling strategies
  - OpenTelemetry Collector
  - Auto-instrumentation vs manual
  - Jaeger vs Tempo vs Zipkin
  - Exemplars: metrics → traces bridge
  - Baggage vs context
  - Service graphs y dependency mapping
  - Overhead de instrumentation
  - TraceQL — buscar traces sin trace_id
  - Continuous profiling integración
  - Trace-to-logs correlation
  - Tail-based sampling en Collector
  - Metrics from traces
  - Debugging con traces
  - Costos y storage
  - OpenTelemetry adoption roadmap
- **JSON:** `packages/content/src/tech/devops/sim-20-distributed-tracing.json`

### Simulacro 21 — Gestión de SLOs y error budgets

- **Focus:** SLI selection (availability, latency percentiles, correctness), SLO calculation, error budget policies (feature freeze), multi-window burn rate alerts, SLO tools (Nobl9, Grafana SLO, Prometheus recording rules), SLO para batch jobs, SLA vs SLO vs SLI.
- **Áreas:** monitoring, reliability
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - SLI vs SLO vs SLA
  - SLI selection: availability
  - SLI: latency percentiles
  - Error budget: concept
  - Burn rate alerts
  - SLO tools: Nobl9 vs Grafana vs custom
  - SLO for batch jobs
  - Choosing SLO targets
  - Error budget policies
  - Multi-tier SLOs
  - Prometheus recording rules for SLO
  - SLO windows
  - SLI: correctness
  - SLO reporting y stakeholder communication
  - SLO for dependencies
  - Alerting fatigue y SLO alerts
  - SLO iteration y adjustment
  - Common SLO pitfalls
  - SLO en microservices grande
  - SLO maturity model
- **JSON:** `packages/content/src/tech/devops/sim-21-slo-management-and-error-budgets.json`

### Simulacro 22 — Fundamentos DevSecOps

- **Focus:** Shift-left security: integrar seguridad en TODO el SDLC (no como gate final). SAST/DAST/SCA/IAST comparados. Vulnerability management workflow. STRIDE threat modeling. OWASP Top 10 CI/CD. Security champions. Dependency scanning + auto-updates. IaC security scanners. Pre-commit hooks para evitar leaks de secretos.
- **Áreas:** security
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Shift-left security — el concepto base
  - DevSecOps vs DevOps tradicional
  - SAST vs DAST vs SCA vs IAST — el cuadrante
  - Semgrep — SAST moderno
  - CodeQL — SAST profundo
  - Snyk y SCA (Software Composition Analysis)
  - Vulnerability management workflow
  - STRIDE threat modeling
  - OWASP Top 10 CI/CD (2022)
  - Security champions program
  - Dependabot vs Renovate
  - IaC security — Checkov
  - tfsec vs Terrascan vs Checkov
  - Pre-commit hooks para secretos — gitleaks
  - TruffleHog — verification y history scan
  - Poisoned Pipeline Execution (PPE)
  - OIDC federation en CI
  - SBOM y provenance
  - Log4Shell — lecciones de response time
  - Uber breach lessons — DevSecOps failures
- **JSON:** `packages/content/src/tech/devops/sim-22-devsecops-fundamentals.json`

### Simulacro 23 — Gestión de secrets (Vault, KMS, rotation)

- **Focus:** Anti-patrones (secrets en código, .env commiteado), HashiCorp Vault (auth methods, secrets engines, transit, dynamic secrets), AWS Secrets Manager vs Parameter Store, GCP Secret Manager, KMS integration, rotation automática, sealed-secrets, External Secrets Operator, SOPS, git-crypt, secret scanning (TruffleHog, gitleaks).
- **Áreas:** security
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Anti-patrón: secrets hardcoded en código
  - Variables de entorno vs archivo de secrets
  - HashiCorp Vault — auth methods
  - Vault secrets engines — KV vs dinámicos
  - AWS Secrets Manager vs Parameter Store
  - KMS envelope encryption
  - Secret rotation — estrategias
  - Kubernetes Secrets — limitaciones
  - Sealed Secrets vs External Secrets Operator
  - SOPS + age/PGP para IaC
  - git-crypt vs SOPS vs BlackBox
  - Secret scanning — TruffleHog y gitleaks
  - Vault transit engine para app-level encryption
  - Vault Agent Injector en K8s
  - GCP Secret Manager vs AWS Secrets Manager
  - Vault seal/unseal y auto-unseal
  - Vault Policies y ACL
  - Secret leak response — playbook
  - Secrets en pipelines CI/CD
  - Estrategia de secrets management a escala
- **JSON:** `packages/content/src/tech/devops/sim-23-secrets-management-vault-kms.json`

### Simulacro 24 — Supply Chain Security (SLSA, Sigstore, SBOM)

- **Focus:** Seguridad de supply chain de software: SLSA levels 1-4, Sigstore (cosign/rekor/fulcio) y keyless signing, SBOM (Syft, CycloneDX, SPDX), dependency confusion, typosquatting, provenance attestations, EO 14028, firma de paquetes (npm/PyPI/Maven), reproducible builds, in-toto, GitHub Actions attestations. Casos reales: SolarWinds, Log4Shell, event-stream, colors.js, XZ Utils, Codecov.
- **Áreas:** security
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué es un ataque de supply chain?
  - SBOM — qué es y por qué
  - SLSA framework — qué es
  - Sigstore — arquitectura
  - Dependency confusion attack
  - Typosquatting en package registries
  - SLSA levels 1-4 detallados
  - SBOM formats — SPDX vs CycloneDX
  - In-toto framework
  - Executive Order 14028
  - npm package signing y provenance
  - Reproducible builds
  - GitHub Actions attestations
  - Verificación de attestations en CI/CD
  - XZ Utils backdoor 2024
  - Codecov bash uploader 2021
  - PyPI package signing (PEP 740)
  - Container image signing con cosign
  - Maven Central signing
  - Estrategia integral de supply chain security
- **JSON:** `packages/content/src/tech/devops/sim-24-supply-chain-security.json`

### Simulacro 25 — Policy as Code con OPA y Kyverno

- **Focus:** Policy as Code como disciplina: por qué escribir políticas en Rego/YAML en vez de wikis. OPA como motor general (K8s, Terraform, microservicios, CI/CD). Kyverno como alternativa K8s-nativa. Gatekeeper, mutation, bundle distribution, decision logs, testing y compliance auditables.
- **Áreas:** security, kubernetes
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué es Policy as Code (PaC)?
  - Arquitectura de OPA
  - Rego language basics
  - Gatekeeper para admission control
  - Kyverno vs OPA/Gatekeeper
  - Ejemplo Rego — block :latest tag
  - Ejemplo Kyverno YAML — mismo caso
  - Mutating vs Validating policies
  - Testing policies (opa test / kyverno test)
  - Bundle distribution
  - Decision logs
  - OPA en Terraform (pre-plan / pre-apply)
  - CI/CD gates con OPA
  - OPA para authorization de microservicios
  - Compliance as code — CIS benchmarks
  - Standards cross-teams a escala
  - Pod Security Standards con Kyverno
  - Performance y escalabilidad
  - Anti-patterns comunes
  - El futuro de Policy as Code
- **JSON:** `packages/content/src/tech/devops/sim-25-policy-as-code-opa-kyverno.json`

### Simulacro 26 — Compliance y auditoría (SOC2, ISO, PCI, GDPR)

- **Focus:** Compliance moderno como código: SOC2 automation (Drata, Vanta, Secureframe), ISO 27001, PCI-DSS en cloud, GDPR technical requirements, HIPAA controls. Audit logging (CloudTrail, K8s audit, GitHub audit). Evidence collection continua, drift detection, CSPM (Prowler, Steampipe, Scout Suite), compliance-as-code, CIS Benchmarks, NIST frameworks.
- **Áreas:** security, monitoring
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - SOC2 — qué es
  - AWS CloudTrail — audit log foundational
  - SOC2 automation — Drata, Vanta, Secureframe
  - ISO 27001 vs SOC2 — diferencias
  - PCI-DSS en cloud
  - GDPR technical requirements
  - Kubernetes audit logs
  - GitHub audit log
  - HIPAA controls
  - CSPM — Cloud Security Posture Management
  - CIS Benchmarks
  - NIST frameworks
  - Compliance-as-code
  - Evidence collection best practices
  - Drift detection
  - Steampipe — SQL para cloud audit
  - Audit log immutability & WORM
  - Continuous compliance automation architecture
  - Compliance failures — anti-patterns
  - Future of compliance — SBOM, SSDF, Zero Trust maturity
- **JSON:** `packages/content/src/tech/devops/sim-26-compliance-and-audit.json`

### Simulacro 27 — DNS y Load Balancing

- **Focus:** DNS profundo (record types, TTL, resolvers, propagation), Route 53 features (failover, weighted, geolocation, latency-based), Load Balancers L4 vs L7, ALB vs NLB vs CLB, sticky sessions, session affinity tradeoffs y Global Load Balancing.
- **Áreas:** networking
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - DNS record types básicos
  - TTL y propagación DNS
  - Recursive resolver vs authoritative
  - Route 53 routing policies
  - Load balancer L4 vs L7
  - ALB vs NLB vs CLB
  - Sticky sessions
  - Health checks profundos
  - Connection draining
  - TLS termination patterns
  - DNS-based load balancing
  - DNS security (DNSSEC, DoH, DoT)
  - Load balancing algorithms
  - BGP y anycast
  - Multi-region failover strategy
  - GSLB vs regional LB
  - Split-brain y quorum en LBs
  - Rate limiting en LB layer
  - IPv6 adoption strategy
  - Load balancer as SPOF
- **JSON:** `packages/content/src/tech/devops/sim-27-dns-and-load-balancing.json`

### Simulacro 28 — CDN y Edge Computing

- **Focus:** CDN moderno (CloudFront, Cloudflare, Fastly, Akamai) — cache hit ratio, invalidation (purge vs TTL), edge functions (Lambda@Edge, CloudFront Functions, Cloudflare Workers), static vs dynamic content, geographic distribution (PoPs), DDoS protection (L3/L4/L7), cache stampede (thundering herd) y patrones para mitigarlo (SWR, request coalescing, jitter).
- **Áreas:** networking
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué es un CDN y para qué sirve?
  - Cache hit ratio — la métrica clave
  - Cache invalidation — purge vs TTL
  - Cache-Control headers
  - CloudFront vs Cloudflare vs Fastly vs Akamai
  - Edge functions — Lambda@Edge vs CloudFront Functions
  - Cloudflare Workers — V8 isolates
  - CDN para contenido estático vs dinámico
  - Geographic distribution — PoPs y Anycast
  - Origin shield y tiered caching
  - DDoS protection en el edge
  - Cache stampede — thundering herd
  - Cloudflare 2019 regex CPU incident
  - Edge storage — KV, R2, D1
  - AWS CloudFront outages — historia
  - Signed URLs y signed cookies
  - Image optimization en el edge
  - Cache poisoning attacks
  - SSR vs SSG vs ISR en el edge
  - Observability de CDN
- **JSON:** `packages/content/src/tech/devops/sim-28-cdn-and-edge-computing.json`

### Simulacro 29 — Service Mesh (Istio, Linkerd, Cilium)

- **Focus:** Sidecar pattern y Envoy proxy, control plane de Istio (istiod, pilot, citadel), traffic management (VirtualService, DestinationRule, Gateway), mTLS automático, observabilidad out-of-the-box, tradeoffs Linkerd vs Istio, overhead operacional, alternativas eBPF (Cilium Service Mesh) y cuándo NO usar service mesh.
- **Áreas:** networking, kubernetes
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué ES un service mesh?
  - Sidecar pattern — cómo funciona
  - Envoy proxy — el corazón del data plane
  - Istio arquitectura — istiod
  - VirtualService — routing L7
  - DestinationRule — subsets y policies del destino
  - Gateway — tráfico norte-sur
  - mTLS automático — zero trust
  - Observabilidad out-of-the-box
  - Retries, timeouts, circuit breakers
  - Linkerd vs Istio — tradeoffs
  - Overhead del service mesh
  - eBPF y Cilium Service Mesh — sin sidecar
  - Cuándo NO usar service mesh
  - Consul Connect — el mesh de HashiCorp
  - AuthorizationPolicy — authZ L7 declarativa
  - Multi-cluster mesh
  - Progressive delivery con mesh + Flagger/Argo Rollouts
  - Debugging problemas en service mesh
  - Roadmap y futuro de service mesh
- **JSON:** `packages/content/src/tech/devops/sim-29-service-mesh-istio-linkerd.json`

### Simulacro 30 — API Gateways

- **Focus:** API Gateways como single entry point para microservicios. Kong, AWS API Gateway (REST vs HTTP API), Nginx, Envoy Gateway, Traefik, Apigee. Rate limiting, authentication (OAuth 2.0, API keys, JWT validation), request/response transformation. Cuando API Gateway vs service mesh vs ambos. BFF pattern. GraphQL federation. Casos reales: Netflix Zuul → Zuul 2, Airbnb migration, LinkedIn Rest.li, Google Espresso.
- **Áreas:** networking
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué ES un API Gateway y por qué?
  - Kong Gateway — arquitectura
  - AWS API Gateway — REST API vs HTTP API
  - Nginx como API Gateway
  - Rate limiting — algoritmos
  - Authentication — OAuth 2.0 en gateway
  - API Keys vs JWT — cuándo usar cada uno
  - JWT validation — signature verification
  - Request/Response transformation
  - API Gateway vs Service Mesh vs ambos
  - BFF Pattern — Backend for Frontend
  - GraphQL Federation en gateway
  - Apigee — API Management enterprise
  - Envoy Gateway y Kubernetes Gateway API
  - Traefik — dynamic routing
  - Circuit breakers y retries en gateway
  - Netflix Zuul 1 → Zuul 2 migration
  - LinkedIn Rest.li y Google Espresso
  - Airbnb API Gateway migration
  - Anti-patterns y elección de gateway
- **JSON:** `packages/content/src/tech/devops/sim-30-api-gateways.json`

### Simulacro 31 — mTLS, Zero Trust y seguridad de red

- **Focus:** mTLS everywhere, Zero Trust Architecture NIST 800-207, BeyondCorp Google, VPN vs Zero Trust modernos, cert-manager, SPIFFE/SPIRE identity, Tailscale/WireGuard, private connectivity.
- **Áreas:** networking, security
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué es mTLS?
  - TLS vs mTLS diferencias operativas
  - Cert lifecycle (CSR → CA → cert)
  - cert-manager en Kubernetes
  - Let's Encrypt y ACME automation
  - Cert rotation strategy sin downtime
  - SPIFFE identity framework
  - SPIRE server y agent
  - Zero Trust principios core
  - Never trust always verify - qué implica en la práctica
  - BeyondCorp Google origin
  - NIST SP 800-207 componentes
  - Traditional VPN limitations
  - Tailscale vs WireGuard vs OpenVPN
  - ZeroTier y mesh networks
  - VPC endpoints AWS PrivateLink
  - Direct Connect vs VPN
  - Microsegmentation
  - Identity-based network policies
  - Zero Trust migration strategy
- **JSON:** `packages/content/src/tech/devops/sim-31-network-security-mtls-zero-trust.json`

### Simulacro 32 — Blue/Green, Canary y Rolling Updates

- **Focus:** Estrategias de deployment fundamentales: Blue/green (duplicado completo, cutover instantáneo), Canary (rollout gradual por porcentaje), Rolling updates (in-place progresivo), A/B testing vs canary, automated rollback triggers, cutover strategies y tradeoffs de costo/riesgo de cada uno.
- **Áreas:** deployment
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Definición básica — blue/green
  - Rolling update en Kubernetes
  - Canary deployment — definición y valor
  - Cost tradeoffs entre estrategias
  - A/B testing vs canary
  - Automated rollback triggers
  - Cutover strategy — DNS vs LB vs Service Mesh
  - Session affinity y state durante cutover
  - Database schema y deployments
  - Progressive delivery — el spectrum
  - Rolling update — configurar maxSurge/maxUnavailable
  - Canary con Istio VirtualService
  - Shadow/mirror traffic
  - Rollback strategies — automated vs manual
  - Deployment strategies para servicios stateful
  - Multi-region deployments
  - Deployments a mobile — app stores
  - Deployments de infra vs deployments de app
  - Deployment window vs continuous
  - Escoger estrategia — decision framework
- **JSON:** `packages/content/src/tech/devops/sim-32-blue-green-canary-rolling.json`

### Simulacro 33 — Progressive Delivery: Flagger y Argo Rollouts

- **Focus:** Progressive delivery patterns modernos: Flagger (con Istio/Linkerd/NGINX), Argo Rollouts (con service mesh o Ingress), automated canary analysis basado en métricas, Kayenta (Netflix), integración con Prometheus para promotions metrics-driven, differences entre Flagger y Argo Rollouts.
- **Áreas:** deployment
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Definición de progressive delivery
  - Argo Rollouts — qué es
  - Flagger — qué es
  - Automated canary analysis — Kayenta
  - Prometheus queries para canary analysis
  - Setup canary steps — decision points
  - Traffic routing — Istio integration
  - AnalysisTemplate — patterns comunes
  - Blue/green con Argo Rollouts
  - Analysis providers — más allá de Prometheus
  - Debugging progressive delivery
  - Header-based canary (A/B testing)
  - Experimentation vs canary
  - GitOps + Progressive Delivery
  - SLO-based progressive delivery
  - Multi-cluster progressive delivery
  - Post-analysis y feedback loop
  - Comparison — Argo Rollouts vs Flagger vs Spinnaker
  - Failure modes de progressive delivery
  - Adoption journey — de rolling a progressive delivery
- **JSON:** `packages/content/src/tech/devops/sim-33-progressive-delivery-flagger-argo-rollouts.json`

### Simulacro 34 — Feature Flags a escala

- **Focus:** Feature flags types (release, ops, experiment, permission), comparación LaunchDarkly vs Split vs Unleash vs GrowthBook, flag lifecycle management, avoiding flag debt, testing con flags, feature flag SDKs (server-side vs client-side), targeting rules.
- **Áreas:** deployment
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Qué es un feature flag
  - Types de flags — taxonomía
  - LaunchDarkly — arquitectura
  - Comparación de vendors
  - Targeting rules
  - Server-side vs client-side flags
  - Flag debt — el problema principal
  - Testing con flags
  - Flag consistency — stateful reads
  - Flag audit y compliance
  - Dark launches
  - Kill switches
  - Circuit breakers con flags
  - Distributed flags — multi-service consistency
  - Flag observability
  - OpenFeature standard
  - Flags en CI/CD pipeline
  - Flag failure modes
  - ROI y flag adoption
  - Progressive delivery + feature flags integration
- **JSON:** `packages/content/src/tech/devops/sim-34-feature-flags-at-scale.json`

### Simulacro 35 — Database migrations con zero downtime

- **Focus:** Expand-contract pattern, backfill strategies, online schema changes (pt-online-schema-change, gh-ost), Flyway vs Liquibase, forward-only migrations, testing migrations, dark reads/writes, rollback strategies para migrations.
- **Áreas:** deployment, reliability
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Downtime en DB migrations — el problema
  - Expand-contract pattern
  - Backfill strategies
  - Flyway vs Liquibase
  - Forward-only migrations
  - Online schema changes — gh-ost
  - pt-online-schema-change
  - PostgreSQL online migrations
  - Testing migrations
  - Dark reads y dark writes
  - Migration rollback strategies
  - Coordinating app + DB deploys
  - Long-running migrations en producción
  - NoSQL migrations
  - Migration monitoring
  - Cross-service data migrations
  - Sharding migrations
  - Data quality durante migrations
  - Migration workflow best practices
  - Case study — Notion Postgres reshard
- **JSON:** `packages/content/src/tech/devops/sim-35-database-migrations-zero-downtime.json`

### Simulacro 36 — Artifact management y caching en CI/CD

- **Focus:** Artifact repositories (Nexus, Artifactory, GitHub Packages, ECR), image caching en CI, dependency caching strategies, build caches (Docker BuildKit, Turborepo, Nx), immutable artifacts, semantic versioning enforcement, promotion pipelines.
- **Áreas:** vcs-ci
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Artifact repositories — qué son
  - Immutable artifacts
  - Container image registries
  - Docker layer caching
  - Dependency caching en CI
  - Docker BuildKit inline cache
  - Turborepo y Nx
  - Semantic versioning enforcement
  - Artifact promotion pipelines
  - Multi-arch images
  - Vulnerability scanning
  - Registry as proxy cache
  - Retention policies
  - Signing y provenance
  - Language-specific package registries
  - Distributed cache challenges
  - Monorepo publishing strategies
  - Cost optimization en artifact storage
  - Air-gapped environments
  - End-to-end artifact strategy
- **JSON:** `packages/content/src/tech/devops/sim-36-artifact-management-and-caching.json`

### Simulacro 37 — Disaster Recovery y estrategias de backup

- **Focus:** Disaster Recovery real: RTO/RPO como decisiones de negocio (no técnicas), estrategias de backup (full/incremental/differential/PITR), regla 3-2-1, testing de restore (un backup no probado no es backup), immutable backups (WORM/Object Lock), cross-region, protección contra ransomware (Vault Lock, air-gap), patrones DR (backup&restore, pilot light, warm standby, active-active), Aurora Global Database vs DynamoDB Global Tables, RDS Point-In-Time Recovery, cifrado de backups y gestión de claves. GitLab 2017, Colonial Pipeline y Facebook Oct 2021 como casos reales.
- **Áreas:** reliability
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - RTO vs RPO — definición
  - Regla 3-2-1
  - Full vs Incremental vs Differential
  - Untested backups = no backups
  - DR patterns — 4 niveles
  - Cross-region backups
  - Immutable backups y WORM
  - Aurora Global Database vs DynamoDB Global Tables
  - RDS PITR — Point-In-Time Recovery
  - Backup encryption y key management
  - Ransomware protection layers
  - Testing DR — Game Days
  - Retention policy design
  - Failover DNS y Route53
  - Data consistency en active-active
  - Backup de datos vs backup de infraestructura
  - Backup de sistemas distribuidos y consistencia
  - Financial modeling de DR
  - Backup validation con checksums y integrity
  - DR governance y organizational readiness
- **JSON:** `packages/content/src/tech/devops/sim-37-disaster-recovery-and-backups.json`

### Simulacro 38 — Chaos Engineering en producción

- **Focus:** Chaos Engineering en la práctica: principios (principlesofchaos.org), Netflix Simian Army (Chaos Monkey/Kong/Gorilla), plataformas modernas (Gremlin, LitmusChaos, Chaos Mesh, AWS FIS), diseño de experimentos hipótesis-driven, blast radius control, game days, cuándo NO hacer chaos, inyección de fallos (network, CPU, memoria, pod/node/AZ/region), Toxiproxy, dependency failure injection.
- **Áreas:** reliability
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué ES Chaos Engineering?
  - Netflix Simian Army — lineage
  - Los 5 Principios Avanzados
  - Steady State e hipótesis
  - Blast radius control
  - Chaos en producción vs staging
  - Cuándo NO hacer chaos
  - Game Days
  - AWS Fault Injection Simulator (FIS)
  - Chaos Mesh vs LitmusChaos
  - Gremlin platform
  - Toxiproxy — network chaos
  - Kill process, pod, node, AZ, region
  - Network partitions
  - CPU y memory pressure
  - Dependency failure injection
  - Chaos maturity model
  - Facebook mata 30% de servers monthly
  - Chaos Engineering + Continuous Verification
  - Anti-patterns y lecciones
- **JSON:** `packages/content/src/tech/devops/sim-38-chaos-engineering-in-practice.json`

### Simulacro 39 — Incident Response y on-call sostenible

- **Focus:** Incident Response profesional: runbooks vivos, rol de Incident Commander (inspirado en NIMS), ChatOps (Slack + bots), PagerDuty analytics, eliminación de alert fatigue, principio de alertas accionables, escalation policies (primary/secondary/manager), follow-the-sun rotation, on-call sostenible (rotation 6-8+, compensación), cultura de post-mortems blameless, NIST SP 800-61 IR framework, comms templates durante incidents.
- **Áreas:** reliability
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué es un runbook?
  - Actionable alerts principle
  - Incident Commander role
  - ChatOps para incident response
  - Escalation policies
  - Alert fatigue diagnostics
  - On-call rotation sustainability
  - Follow-the-sun rotation
  - Blameless post-mortem
  - PagerDuty analytics
  - NIST SP 800-61 IR framework
  - Comms templates during incidents
  - Severity levels y decision matrix
  - Post-mortem action items
  - Chaos Engineering + game days para IR training
  - SRE handoff to product teams
  - Public post-mortems — transparencia
  - Multi-team incidents y cross-team coordination
  - Metrics para evaluar salud IR program
  - Caso comparativo — Cloudflare vs Equifax
- **JSON:** `packages/content/src/tech/devops/sim-39-incident-response-and-oncall.json`

### Simulacro 40 — FinOps y optimización de costos cloud

- **Focus:** FinOps framework (Inform/Optimize/Operate). Savings Plans vs Reserved Instances vs Spot. Right-sizing con AWS Compute Optimizer / GCP Recommender. Tagging strategy para cost allocation. Showback vs chargeback. Infracost para IaC. Cost anomaly detection. EBS gp3 vs gp2. S3 storage classes. Egress cost surprises (NAT Gateway, cross-AZ, cross-region). Kubernetes resource requests tuning. Unused resources detection. La cloud NO es barata por defecto — hay que operarla.
- **Áreas:** reliability
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - ¿Qué ES FinOps?
  - Fases FinOps — Inform, Optimize, Operate
  - Savings Plans vs Reserved Instances vs On-Demand
  - Spot Instances — cuándo SÍ, cuándo NO
  - Right-sizing — AWS Compute Optimizer / GCP Recommender
  - Tagging strategy para cost allocation
  - Showback vs Chargeback
  - Infracost — cost estimation en PRs
  - Cost anomaly detection
  - EBS gp3 vs gp2 — quick win
  - S3 storage classes — cuándo usar cuál
  - Egress cost surprises — NAT Gateway
  - Cross-AZ y cross-region data transfer
  - Kubernetes resource requests tuning
  - Unused resources detection
  - Serverless cost model — Lambda cost analysis
  - Cloud exit / repatriation — cuando la cloud NO es óptima
  - Unit economics — $ per user, $ per transaction
  - Multi-cloud FinOps — complejidad adicional
  - FinOps culture — engineering ownership
- **JSON:** `packages/content/src/tech/devops/sim-40-cost-optimization-finops.json`
