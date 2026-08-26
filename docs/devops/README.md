# DevOps — CI/CD · Contenedores · SRE · Cost

Todo lo que un DevOps engineer debe dominar para llevar código de commit a producción de forma segura, rápida y observable: cultura y métricas DORA, Git workflows, CI/CD pipelines, Docker y Kubernetes profundo, Helm/Kustomize, IaC (Terraform/Ansible/Pulumi), monitoring stack (Prometheus/Grafana/Loki/Jaeger), SLO management, secretos, container security, supply chain (SLSA/Sigstore), estrategias de deployment (blue/green, canary, feature flags), disaster recovery, chaos engineering, on-call, FinOps.

## Cómo usar este doc

Cada capítulo sigue la **estructura estándar de 11 secciones**: pre-requisitos + setup, gran cuadro, fundamentos (básico), cómo funciona por dentro (medio), práctica avanzada (senior), ejemplo end-to-end reproducible, cheatsheet + anti-patrones, casos reales 2024-2026, ejercicios verificables, recursos, link al sim.

## Áreas cubiertas (10 áreas)

| ID | Nombre | Descripción |
|---|---|---|
| `culture` | Cultura + DORA | CALMS, deploy frequency, lead time, MTTR, change failure rate. |
| `vcs-ci` | Git + CI | Trunk-based, GitFlow, GitHub Actions, Jenkins, caching, artefactos. |
| `containers` | Docker + contenedores | Dockerfile, multi-stage, layer cache, security scanning, distroless. |
| `kubernetes` | Kubernetes | Pods, Deployments, StatefulSets, Services, Ingress, RBAC, HPA. |
| `iac` | Infrastructure as Code | Terraform state, modules, Ansible, Pulumi, GitOps con ArgoCD/Flux. |
| `monitoring` | Monitoreo + observabilidad | Prometheus, Grafana, Loki, Jaeger, OpenTelemetry, SLI/SLO. |
| `security` | DevSecOps | SAST/DAST/SCA, container security, secretos (Vault/KMS), OPA. |
| `networking` | Networking + service mesh | DNS, LB, CDN, ingress controllers, Istio, mTLS, Zero Trust. |
| `deployment` | Deployment strategies | Blue/green, canary, rolling, feature flags, dark launches. |
| `reliability` | Reliability + on-call | DR, backups, chaos engineering, incident response, FinOps. |

## Índice de capítulos (40)

### Fundamentos + CI/CD (01-04)
- 01 · [Cultura DevOps y DORA](./01-cultura-devops-y-dora.md)
- 02 · [Fundamentos de continuous delivery](./02-fundamentos-de-continuous-delivery.md)
- 03 · [Git workflows y branching](./03-git-workflows-y-branching.md)
- 04 · [GitHub Actions y Jenkins](./04-github-actions-y-jenkins.md)

### Contenedores + Kubernetes (05-11)
- 05 · [Fundamentos Docker](./05-fundamentos-docker.md)
- 06 · [Container security y registries](./06-container-security-y-registries.md)
- 07 · [Fundamentos Kubernetes](./07-fundamentos-kubernetes.md)
- 08 · [Kubernetes workloads](./08-kubernetes-workloads.md)
- 09 · [Kubernetes networking y storage](./09-kubernetes-networking-y-storage.md)
- 10 · [Helm y Kustomize](./10-helm-y-kustomize.md)
- 11 · [Kubernetes security](./11-kubernetes-security.md)

### IaC + GitOps (12-16)
- 12 · [Fundamentos Terraform](./12-fundamentos-terraform.md)
- 13 · [Ansible y config management](./13-ansible-y-config-management.md)
- 14 · [Cloud fundamentals y multi-cloud](./14-cloud-fundamentals-y-multi-cloud.md)
- 15 · [GitOps con ArgoCD y Flux](./15-gitops-con-argocd-y-flux.md)
- 16 · [Pulumi, CDK y IaC moderna](./16-pulumi-cdk-y-iac-moderna.md)

### Observabilidad + SLOs (17-21)
- 17 · [Prometheus y metrics](./17-prometheus-y-metrics.md)
- 18 · [Grafana y dashboards](./18-grafana-y-dashboards.md)
- 19 · [Logging: ELK y Loki](./19-logging-elk-loki.md)
- 20 · [Distributed tracing](./20-distributed-tracing.md)
- 21 · [SLO management y error budgets](./21-slo-management-y-error-budgets.md)

### Seguridad + compliance (22-26)
- 22 · [Fundamentos DevSecOps](./22-fundamentos-devsecops.md)
- 23 · [Secrets management: Vault y KMS](./23-secrets-management-vault-kms.md)
- 24 · [Supply chain security](./24-supply-chain-security.md)
- 25 · [Policy as Code: OPA y Kyverno](./25-policy-as-code-opa-kyverno.md)
- 26 · [Compliance y audit](./26-compliance-y-audit.md)

### Networking + service mesh (27-31)
- 27 · [DNS y load balancing](./27-dns-y-load-balancing.md)
- 28 · [CDN y edge computing](./28-cdn-y-edge-computing.md)
- 29 · [Service mesh: Istio y Linkerd](./29-service-mesh-istio-linkerd.md)
- 30 · [API gateways](./30-api-gateways.md)
- 31 · [Network security: mTLS y Zero Trust](./31-network-security-mtls-zero-trust.md)

### Deployment strategies (32-36)
- 32 · [Blue/green, canary y rolling](./32-blue-green-canary-rolling.md)
- 33 · [Progressive delivery: Flagger y Argo Rollouts](./33-progressive-delivery-flagger-argo-rollouts.md)
- 34 · [Feature flags at scale](./34-feature-flags-at-scale.md)
- 35 · [Database migrations zero-downtime](./35-database-migrations-zero-downtime.md)
- 36 · [Artifact management y caching](./36-artifact-management-y-caching.md)

### Reliability + FinOps (37-40)
- 37 · [Disaster recovery y backups](./37-disaster-recovery-y-backups.md)
- 38 · [Chaos engineering en la práctica](./38-chaos-engineering-en-practica.md)
- 39 · [Incident response y on-call](./39-incident-response-y-oncall.md)
- 40 · [Cost optimization y FinOps](./40-cost-optimization-finops.md)

## Ruta sugerida de estudio

- **Fase 1 (2 semanas):** caps 01-04 (fundamentos + CI/CD) + caps 05-08 (Docker + K8s intro).
- **Fase 2 (2 semanas):** caps 09-11 (K8s avanzado) + caps 12-16 (IaC + GitOps).
- **Fase 3 (2 semanas):** caps 17-21 (observabilidad + SLOs).
- **Fase 4 (2 semanas):** caps 22-26 (seguridad + compliance).
- **Fase 5 (2 semanas):** caps 27-31 (networking + mesh) + caps 32-36 (deployment).
- **Fase 6 (1 semana):** caps 37-40 (reliability + FinOps).

## Volver al índice general

← [Índice general de docs](../README.md)
