# Capítulo 31 — mTLS, Zero Trust y seguridad de red

> **Focus:** Zero Trust Architecture NIST SP 800-207 y BeyondCorp, mTLS everywhere entre servicios, SPIFFE/SPIRE 1.10+ como workload identity portable, Cilium eBPF NetworkPolicies, network segmentation, WAF (Web Application Firewall), DDoS protection, egress control, private clusters, PrivateLink AWS, VPC peering, Bastion vs Session Manager, VPN vs Zero Trust Network Access (ZTNA) con Tailscale/Cloudflare Access, cert-manager y rotación short-lived.
> **Áreas:** Security · Networking · Kubernetes
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos TLS/HTTPS: handshake, X.509, PKI, CA raíz vs intermediate.
- Kubernetes networking ([cap 09](./09-kubernetes-networking-y-storage.md)) y Security ([cap 11](./11-kubernetes-security.md)).
- Service Mesh ([cap 29](./29-service-mesh-istio-linkerd.md)) para el contexto de mTLS automático.
- API Gateways ([cap 30](./30-api-gateways.md)) para el contexto de auth externa.
- Nociones de VPC, subnets, security groups, ACLs.

**Glosario mínimo:**
- **mTLS:** Mutual TLS. Ambos lados (cliente y servidor) presentan y validan certificados.
- **X.509:** formato estándar de certificados digitales (RFC 5280).
- **CSR:** Certificate Signing Request (PKCS#10), contiene la public key + subject y se envía a la CA.
- **SPIFFE / SPIRE:** estándar CNCF de identidad de workload y su implementación de referencia. SPIRE 1.10+ en 2026.
- **SVID:** SPIFFE Verifiable Identity Document. Puede ser X.509-SVID o JWT-SVID.
- **Zero Trust:** modelo arquitectural (NIST SP 800-207) que elimina la confianza implícita en la red interna.
- **BeyondCorp:** implementación de Zero Trust de Google (post-Aurora attack, 2010).
- **Cilium:** CNI eBPF con NetworkPolicies L3-L7 y observability con Hubble. Versiones 1.16+ en 2024, 1.19+ en 2026.
- **WAF:** Web Application Firewall (AWS WAF, Cloudflare WAF, ModSecurity).
- **ZTNA:** Zero Trust Network Access. Reemplazo moderno de VPN. Cloudflare Access, Tailscale, Zscaler.
- **PrivateLink:** endpoint privado AWS para consumir servicios sin salir a internet.

**Setup mínimo:**

```bash
# 1) cert-manager v1.16+
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml

# 2) SPIRE 1.10+
kubectl create namespace spire
helm repo add spiffe https://spiffe.github.io/helm-charts-hardened/
helm install spire-crds spiffe/spire-crds -n spire
helm install spire spiffe/spire -n spire \
  --set global.spire.trustDomain=linguadev.local

# 3) Cilium 1.16+ con Hubble
helm repo add cilium https://helm.cilium.io/
helm install cilium cilium/cilium --version 1.16.5 \
  -n kube-system \
  --set kubeProxyReplacement=true \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set encryption.enabled=true \
  --set encryption.type=wireguard

# 4) Tailscale para ZTNA
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --advertise-tags=tag:prod-cluster

# 5) AWS CLI + Terraform
aws --version && terraform version
```

---

## 1. El gran cuadro

**Zero Trust** es una arquitectura y filosofía, no un producto. Su principio fundacional lo resume el eslogan **"never trust, always verify"**: no existe una red "interna" de confianza implícita. Todo request se autentica y autoriza sin importar de dónde venga —la LAN corporativa, una VPN o un café público—. NIST SP 800-207 (Zero Trust Architecture) codifica siete pilares: recursos no-privilegiados por defecto, seguridad de comunicación agnóstica de ubicación, acceso por sesión, policy dinámica basada en identidad + estado del dispositivo + señales, monitorización continua de assets, autenticación y autorización estrictas antes de cualquier acceso, y recolección de información para mejorar la postura. Google lo materializó en **BeyondCorp** post-Aurora attack (2010). La orden ejecutiva 14028 (2021) tras SolarWinds mandó Zero Trust para agencias federales US.

En el plano técnico, Zero Trust requiere tres capacidades primarias: **identidad criptográfica de workloads** (no basada en IPs efímeras), **mTLS everywhere** entre servicios, y **policies declarativas** que auditan cada request. La identidad la resuelve **SPIFFE** (Secure Production Identity Framework For Everyone), un estándar CNCF que define el SPIFFE ID como URI `spiffe://<trust-domain>/ns/<ns>/sa/<sa>` firmado en un SVID (X.509 o JWT). **SPIRE** (SPIFFE Runtime Environment) es la implementación de referencia; en 2026 SPIRE 1.10+ integra con Kubernetes 1.28+, Istio 1.22+ y HashiCorp Vault 1.16+. mTLS lo hace la app o el service mesh (Istio/Linkerd/Consul automatizan el sidecar handshake). Policies las expresan NetworkPolicy (L3/L4), CiliumNetworkPolicy (hasta L7), AuthorizationPolicy (mesh L7), o WAF rules (perímetro HTTP).

El otro eje es **segmentación y perímetro**. Segmentación interna con **CNI NetworkPolicies** y microsegmentación con **Cilium eBPF** (que también hace observability con Hubble). Perímetro con **WAF** (AWS WAF, Cloudflare, ModSecurity/CRS) para OWASP Top 10, protección **DDoS** en capas (edge CDN → LB → gateway → app), y **egress control** para forzar todo el tráfico saliente por un gateway auditado (evita data exfiltration). Networking privado con **VPC PrivateLink**, **VPC peering**, **Transit Gateway**, **private clusters** (sin IP pública en la control plane). Acceso administrativo: reemplazar VPN por **ZTNA** —**Cloudflare Access**, **Tailscale**, **Google IAP**, **AWS Session Manager** en vez de bastion SSH tradicional—.

El impacto en LinguaDev Pro es concreto. Zero Trust exige: (1) mTLS pod-to-pod con SPIFFE IDs (via mesh o SPIRE stand-alone); (2) NetworkPolicies default-deny en cada namespace productivo, con allows explícitos por SA; (3) cert-manager para TLS público automático (Let's Encrypt vía ACME) y CA interna con Vault o SPIRE para certs internos; (4) WAF delante del gateway API (AWS WAF managed rules o Cloudflare); (5) Session Manager en vez de bastion SSH para acceso a EC2/EKS; (6) Tailscale/Cloudflare Access para acceso admin a paneles internos (Grafana, Argo CD, Kibana). Este capítulo desglosa cada pieza con YAML/HCL real y ejercicios verificables.

---

## 2. mTLS, PKI y rotación (nivel básico)

### 2.1 TLS vs mTLS

- **TLS estándar (HTTPS)**: solo el servidor presenta certificado. El cliente valida contra la trust store del sistema (root CAs). El usuario se autentica DESPUÉS con cookie/JWT.
- **mTLS**: además del server cert, el **cliente** presenta el suyo firmado por una CA de confianza mutua. Ambos se autentican criptográficamente ANTES del intercambio de bytes de aplicación.

Handshake mTLS TLS 1.3:

1. `ClientHello` (ciphers, extensions).
2. `ServerHello` + certificate + `CertificateRequest` (pide cert al cliente).
3. Cliente envía **su cert** + `CertificateVerify` (firma con su private key, prueba de posesión).
4. Servidor valida la cadena del cliente contra su trust bundle.
5. Si algo falla → conexión cortada antes de datos de aplicación.

Ventaja frente a bearer tokens: no hay "secreto robable" en tránsito; hay que robar la **private key**, que puede vivir en TPM/HSM.

**Regla de dedo:**
- Humanos al frente → TLS estándar + auth por OIDC/OAuth.
- Servicios entre sí en tu infra → mTLS + identidad por cert.
- API B2B con partners → mTLS es común (partners son "servicios", no humanos).

### 2.2 Ciclo de vida de un certificado X.509

Flujo canónico PKI:

1. El servicio genera un **keypair** (private + public). La private key **nunca sale** del solicitante.
2. Crea un **CSR** (PKCS#10) con la public key + subject/SANs + prueba de posesión firmada.
3. Envía el CSR a la **CA**.
4. La CA valida identidad (ACME challenge, admission K8s, atestación cloud) y firma el CSR emitiendo un cert X.509 con `notBefore`/`notAfter`.
5. Servicio instala cert + private key.
6. Antes de expirar, renueva.

Extensiones X.509 críticas:

- **SAN URI/DNS/IP**: hostnames o SPIFFE IDs válidos.
- **Key Usage**: `digitalSignature`, `keyEncipherment`.
- **Extended Key Usage**: `serverAuth`, `clientAuth` (mTLS necesita ambos).
- **Basic Constraints**: `CA:FALSE` para leaf certs.

Formato de cadena: **root CA** (offline, superprotegida) → **intermediate CA** (online, firma leaves) → **leaf cert** (servicio).

### 2.3 cert-manager en Kubernetes

Cert-manager es CNCF graduated. Introduce CRDs `Certificate`, `Issuer`, `ClusterIssuer` y automatiza emisión + renovación contra CAs (Let's Encrypt vía ACME RFC 8555, HashiCorp Vault, Venafi, AWS Private CA, Google Cloud CA, self-signed, CA interna).

```yaml
# ClusterIssuer Let's Encrypt Prod con DNS-01 challenge (Route53)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@linguadev.app
    privateKeySecretRef: { name: letsencrypt-prod-key }
    solvers:
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890ABC
        selector:
          dnsZones: [linguadev.app]
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: linguadev-tls
  namespace: gateway-system
spec:
  secretName: linguadev-tls
  issuerRef: { name: letsencrypt-prod, kind: ClusterIssuer }
  dnsNames:
    - api.linguadev.app
    - "*.linguadev.app"
  duration: 2160h        # 90d
  renewBefore: 720h      # renovar 30d antes de expirar
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always
  usages: [server auth, client auth]
```

### 2.4 Rotación short-lived sin downtime

**Regla de oro:** renová antes de expirar (típicamente al 2/3 de la vida útil). Emití nuevo cert, distribuí al Secret, servicio recarga con SIGHUP o watcher. Conexiones existentes siguen con cert viejo hasta cierre natural; nuevas usan el nuevo.

**Trust bundle overlap**: al rotar la CA raíz o intermediate, tu bundle debe aceptar la CA vieja Y la nueva durante N días para no romper servicios con bundle viejo. Si rotás sin overlap → outage.

**Short-lived credentials (SPIRE, Netflix Bless, Vault):** certs de horas u minutos. Fuerzan que la automatización sea sólida; si falla, te enterás rápido. SPIRE emite SVIDs con TTL default 1 hora.

**Ejemplos históricos de outages por cert expirado:**
- **Ericsson (dic 2018):** cert expirado en su software tumbó las redes 4G de O2 UK y SoftBank Japón — 32 millones de usuarios sin servicio horas.
- **Microsoft Teams (feb 2020):** cert expirado causó outage global.
- **Cisco WebEx (2020):** mismo problema.

Alertas obligatorias: Prometheus `blackbox_exporter` probes SSL con warning a 30 días y critical a 7.

---

## 3. SPIFFE, SPIRE y Zero Trust workload identity (nivel medio)

### 3.1 Anatomía del SPIFFE ID

Formato: `spiffe://<trust-domain>/<path>`.

- **Trust domain**: la "organización" (usualmente una o pocas por empresa: `spiffe://linguadev.local`).
- **Path**: identifica el workload. Convención K8s: `/ns/<namespace>/sa/<serviceaccount>`.

Ejemplo: `spiffe://linguadev.local/ns/prod/sa/checkout`. Este URI va en la **extensión SAN URI** del cert X.509 emitido a `checkout`. Cualquier verificador que valide el cert también valida la identidad SPIFFE.

Ventajas frente a `CN=api-payments`:

- Formato acordado, parseable, con semántica clara.
- Portable entre plataformas (K8s, VMs, cloud X, cloud Y, on-prem).
- Base para federation cross-cluster.
- Integra con IAM cloud (AWS IAM Roles Anywhere, GCP Workload Identity Federation).

### 3.2 SPIRE Server + Agent

Arquitectura:

- **SPIRE Server**: la CA central (o intermediate). Mantiene registration entries (`spire-server entry create -parentID X -spiffeID Y -selector Z`).
- **SPIRE Agent**: DaemonSet per-node. Se **atiesta contra el Server** con la "natural identity" del cloud (K8s service account token, AWS Instance Identity Document, GCP instance metadata).
- **Workload API**: UDS (Unix Domain Socket) que expone el Agent. El workload llama gRPC al socket y recibe su SVID sin credenciales pre-configuradas.

Flujo canónico:

1. SPIRE Server bootstrap con root CA propia o intermediate desde Vault/ACM PCA.
2. Agent inicia en nodo → node attestation → Server emite SVID de nodo al Agent.
3. Workload arranca en el nodo → llama Workload API socket local.
4. Agent inspecciona el proceso (K8s namespace, SA, labels del pod) → matches contra registration entries → pide SVID al Server → lo entrega al workload.
5. Agent auto-rota SVIDs antes de expirar (default 1h).

```yaml
# SPIRE registration entry: linguadev api recibe identidad SPIFFE
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: linguadev-api
spec:
  spiffeIDTemplate: "spiffe://linguadev.local/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      spire-managed: "true"
  namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: linguadev
  ttl: 3600s              # 1 hora
```

### 3.3 mTLS con SPIFFE en la aplicación

Librerías por lenguaje: `go-spiffe`, `java-spiffe`, `py-spiffe`, `spiffe-helper` (sidecar que escribe cert/key/bundle a disco para apps legacy).

```go
// Go: cliente HTTP con mTLS SPIFFE
import (
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

ctx := context.Background()
source, err := workloadapi.NewX509Source(ctx)
if err != nil { panic(err) }
defer source.Close()

// TLS config que confía en la trust domain y valida SPIFFE ID del peer
serverID := spiffeid.RequireFromString("spiffe://linguadev.local/ns/prod/sa/payments")
tlsConfig := tlsconfig.MTLSClientConfig(source, source, tlsconfig.AuthorizeID(serverID))

client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig}}
resp, err := client.Get("https://payments.prod.svc/api/charge")
```

### 3.4 Zero Trust en la práctica

Cuatro cambios de mentalidad frente a "castillo y foso":

1. **Never trust, always verify**: quitar allowlists por CIDR interno. Todo pedido pasa por auth + authz.
2. **Least privilege**: cada identidad accede solo a lo que necesita, por tiempo limitado. Sin "admin general".
3. **Assume breach**: diseño asume que atacante ya está dentro. Microsegmentación, logging exhaustivo, MFA everywhere.
4. **Verify explicitly**: múltiples señales (identidad + device posture + ubicación + hora + comportamiento). No binary sí/no.

Diferencia entre **VPN legacy** y **ZTNA**:

| Aspecto | VPN | ZTNA (Cloudflare Access, Tailscale) |
|---|---|---|
| Modelo | Perímetro (dentro = confía) | Zero Trust (cada request se valida) |
| Acceso | Toda la LAN | App específica |
| Identidad | Credenciales de red | Identidad de usuario + device posture |
| Escalabilidad | Cliente VPN pesado | Cliente ligero o browser-native |
| Split tunneling | Manual | Automático por app |

---

## 4. Segmentación, WAF, DDoS y networking privado (nivel avanzado)

### 4.1 NetworkPolicy y Cilium

Semántica de NetworkPolicy K8s: **sin policies = todo permitido**. Cuando una policy selecciona un Pod, ese Pod pasa a **deny-by-default** excepto por lo permitido. Las policies aplicables se unen (OR).

Baseline default-deny:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: linguadev
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

**Trampa clásica**: olvidar egress DNS. Fix:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: linguadev
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
          podSelector:
            matchLabels: { k8s-app: kube-dns }
      ports: [{ port: 53, protocol: UDP }, { port: 53, protocol: TCP }]
```

**Cilium 1.16+/1.19+** amplía a L7 y FQDN, y ofrece observability con Hubble:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-to-payments-l7
  namespace: linguadev
spec:
  endpointSelector:
    matchLabels: { app: payments }
  ingress:
    - fromEndpoints:
        - matchLabels: { app: api }
      toPorts:
        - ports: [{ port: "8080", protocol: TCP }]
          rules:
            http:
              - method: POST
                path: /v1/charges
              - method: GET
                path: /v1/charges/.*
  egress:
    - toFQDNs:
        - matchName: api.stripe.com
      toPorts:
        - ports: [{ port: "443", protocol: TCP }]
```

Con `encryption.type=wireguard` habilitado, Cilium encripta tráfico node-to-node transparentemente (complementario a mTLS pod-to-pod).

### 4.2 WAF: AWS WAF, Cloudflare, ModSecurity

Un WAF (Web Application Firewall) inspecciona tráfico HTTP L7 y bloquea patterns maliciosos: **OWASP Top 10** (SQLi, XSS, SSRF, path traversal), bots, scrapers, requests malformados, IPs conocidas malas, geo-blocking.

Modos:
- **AWS WAF Managed Rule Groups** (Amazon IP Reputation List, Anonymous IP List, Core Rule Set, SQL Injection, Known Bad Inputs).
- **Cloudflare WAF Managed Rules** (con actualizaciones diarias del threat intel de Cloudflare).
- **ModSecurity + OWASP CRS** (open-source, ejecuta como módulo Nginx/Envoy).

```hcl
# Terraform: AWS WAFv2 asociado a CloudFront/ALB
resource "aws_wafv2_web_acl" "main" {
  name  = "linguadev-waf"
  scope = "REGIONAL"
  default_action { allow {} }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "CommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimit100PerMinute"
    priority = 20
    action { block {} }
    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "linguadev-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.api.arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}
```

### 4.3 DDoS protection en capas

Nunca una sola línea de defensa:

1. **Edge / CDN**: Cloudflare, AWS Shield Standard/Advanced, Google Cloud Armor. Absorben SYN floods, UDP amplification, L7 floods a gran escala.
2. **Load Balancer**: ALB/NLB con connection limits, cross-zone LB, sticky para minimizar impact.
3. **API Gateway / WAF**: rate limiting por IP, JA3/JA4 fingerprinting, bot detection.
4. **App layer**: connection pools, timeouts agresivos, circuit breakers, gradual degradation (feature flags para deshabilitar endpoints caros).

AWS Shield Advanced ($3 000/mes por org) da SLA + Response Team + protección contra costos de DDoS. Cloudflare Enterprise integra WAF + DDoS + bot management.

### 4.4 Egress control y private networking

Control de tráfico saliente evita **data exfiltration** y satisface compliance:

- **Egress gateway (Istio/Envoy)**: obliga a todo el tráfico externo a pasar por un pod dedicado con logs y allowlist FQDN.
- **NAT gateway con whitelist**: en AWS, un NAT gateway con security groups restrictivos.
- **Cilium egress gateway**: rutea tráfico saliente por nodos dedicados con IPs fijas (útil para partners que hacen IP whitelisting).

**Private clusters:**

- **EKS Private endpoint**: control plane sin IP pública, acceso solo por VPC.
- **GKE Private cluster**: nodos sin IP pública, control plane con endpoint privado.
- **AKS Private cluster**: similar.

**AWS PrivateLink**: endpoint privado para consumir servicios (S3, DynamoDB, RDS, servicios de partners) sin salir a internet. Evita NAT charges y elimina superficie pública.

```hcl
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.us-east-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
}

resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.us-east-1.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
}
```

### 4.5 Bastion vs Session Manager vs ZTNA

Reemplazá bastion SSH tradicional (host expuesto a internet con SSH port 22) por:

- **AWS Systems Manager Session Manager**: shell interactivo a EC2/ECS sin SSH port, con IAM auth, logs a CloudWatch/S3.
- **Google Cloud IAP** (Identity-Aware Proxy): equivalente en GCP.
- **Tailscale SSH**: ZTNA basado en WireGuard con identity providers (Google, GitHub, Okta) + ACLs.
- **Cloudflare Access**: reverse proxy con auth OIDC delante de aplicaciones internas.
- **Boundary (HashiCorp)**: broker de acceso con auditoría.

```bash
# AWS Session Manager: shell a EC2 sin SSH
aws ssm start-session --target i-0abc123def456

# Tailscale SSH
tailscale up --ssh
ssh user@node-tailnet-hostname
```

---

## 5. Ejemplo práctico: LinguaDev Pro con SPIRE + Cilium + AWS WAF + Session Manager

Escenario: cluster EKS privado con Cilium eBPF, SPIRE emitiendo SVIDs a `api` y `payments`, mTLS SPIFFE app-to-app, WAF delante del ALB, Session Manager para acceso admin, VPC endpoints para S3/Secrets Manager.

### Paso 1: EKS privado con Terraform

```hcl
module "eks" {
  source          = "terraform-aws-modules/eks/aws"
  version         = "~> 20.0"
  cluster_name    = "linguadev-prod"
  cluster_version = "1.32"

  cluster_endpoint_public_access  = false
  cluster_endpoint_private_access = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_addons = {
    coredns   = { most_recent = true }
    vpc-cni   = { most_recent = true }
  }
}
```

### Paso 2: Cilium con encryption WireGuard

```bash
helm install cilium cilium/cilium --version 1.16.5 -n kube-system \
  --set kubeProxyReplacement=true \
  --set encryption.enabled=true \
  --set encryption.type=wireguard \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true
```

### Paso 3: SPIRE + registration entries

```bash
helm install spire-crds spiffe/spire-crds -n spire
helm install spire spiffe/spire -n spire \
  --set global.spire.trustDomain=linguadev.aws \
  --set spire-server.controllerManager.enabled=true
```

```yaml
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: linguadev-workloads
spec:
  spiffeIDTemplate: "spiffe://linguadev.aws/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels: { spire-managed: "true" }
  namespaceSelector:
    matchLabels: { kubernetes.io/metadata.name: linguadev }
  ttl: 3600s
```

### Paso 4: default-deny + allows

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: default-deny
  namespace: linguadev
spec:
  endpointSelector: {}
  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts: [{ ports: [{ port: "53", protocol: UDP }] }]
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-to-payments
  namespace: linguadev
spec:
  endpointSelector:
    matchLabels: { app: payments }
  ingress:
    - fromEndpoints:
        - matchLabels: { app: api }
      toPorts:
        - ports: [{ port: "8443", protocol: TCP }]
          rules:
            http:
              - method: POST
                path: /v1/charges
```

### Paso 5: WAF + ALB Terraform

```hcl
resource "aws_wafv2_web_acl" "prod" {
  name  = "linguadev-prod-waf"
  scope = "REGIONAL"
  default_action { allow {} }

  rule {
    name     = "CommonRuleSet"
    priority = 10
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "prod-waf"
    sampled_requests_enabled   = true
  }
}
```

### Paso 6: Session Manager en vez de bastion

```hcl
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
# Ya no hay security group con SSH ingress 0.0.0.0/0
```

### Paso 7: verificación

```bash
# mTLS entre api y payments
kubectl -n linguadev exec deploy/api -- \
  spire-agent api fetch x509 -socketPath /run/spire/sockets/agent.sock
# Debe listar SVIDs con URI SAN

# Hubble: observar flujos
kubectl -n kube-system port-forward svc/hubble-ui 12000:80

# Session Manager en vez de SSH
aws ssm start-session --target $(aws ec2 describe-instances \
  --filters 'Name=tag:eks:cluster-name,Values=linguadev-prod' \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

# WAF metrics
aws wafv2 get-sampled-requests --web-acl-arn ... --rule-metric-name common
```

---

## 6. Cheatsheet, reglas mentales, anti-patrones

### Reglas de oro

- ✅ Zero Trust es arquitectura, no producto.
- ✅ mTLS pod-to-pod por default (via mesh o SPIRE stand-alone).
- ✅ **SPIFFE IDs** como identidad, no IPs efímeras.
- ✅ Cert-manager para TLS público, SPIRE/Vault para PKI interna.
- ✅ Renová certs al 2/3 de la vida útil (30 días antes en LE 90-day certs).
- ✅ Trust bundle overlap al rotar CAs raíz/intermediate.
- ✅ Default-deny NetworkPolicy en namespaces sensibles + allows explícitos.
- ✅ Nunca olvides egress DNS al aplicar default-deny.
- ✅ WAF managed rule set + rate limiting por IP como línea base.
- ✅ DDoS defense en capas (CDN + LB + WAF + app).
- ✅ Private clusters + PrivateLink evitan superficie pública.
- ✅ Session Manager en vez de bastion SSH.
- ✅ Tailscale/Cloudflare Access para paneles internos (Grafana, Argo CD).
- ✅ Alertas SSL expiry (Prometheus blackbox_exporter, 30d warn / 7d critical).
- ✅ Rechazá JWTs con `alg: none` y validá `iss`/`aud`.
- ✅ Egress control con FQDN allowlist para evitar exfiltration.

### Anti-patrones

- ❌ Confiar en la LAN corporativa por estar "detrás del firewall".
- ❌ Bearer tokens long-lived en microservicios internos.
- ❌ Bastion SSH con puerto 22 expuesto a 0.0.0.0/0.
- ❌ Regenerar keypair en la CA y transmitirla al cliente (rompe PKI).
- ❌ Cert válido por 10 años (ventana enorme si se compromete).
- ❌ Sin plan de rotación → cert expira → Ericsson-like outage.
- ❌ TLS solo en el edge, tráfico interno plain HTTP.
- ❌ VPN full-tunnel con acceso a toda la LAN.
- ❌ WAF sin exclusiones tunneladas (rompe legítimos endpoints como `/graphql`).
- ❌ NetworkPolicy default-deny sin allow-dns (todo parece "connection refused").
- ❌ mTLS con validación de CN en vez de SAN URI (deprecated desde 2000).

### Tabla decisión

| Necesidad | Elección 2026 |
|---|---|
| TLS público (browsers) | cert-manager + Let's Encrypt ACME |
| PKI interna K8s + mesh | SPIRE 1.10+ o istiod CA |
| PKI enterprise multi-plataforma | HashiCorp Vault PKI engine |
| Auth admin a apps internas | Cloudflare Access, Tailscale, IAP |
| Shell a EC2 | AWS Session Manager |
| WAF managed cloud | AWS WAF Managed Rules o Cloudflare |
| Encriptación node-to-node K8s | Cilium WireGuard |
| Segmentación L7 | CiliumNetworkPolicy + AuthorizationPolicy |
| Servicios AWS sin internet | VPC PrivateLink |

---

## 7. Casos reales industria 2020-2026

**Google BeyondCorp (2010+):** post-Aurora attack, Google migró toda su infra interna a Zero Trust. Sin VPN corporativa; cada app accedida vía proxy autenticado (context-aware access). **Lección:** el modelo funciona a escala Google si hay inversión sostenida.

**SolarWinds attack (dic 2020):** compromiso de la cadena de suministro afectó ~18 000 organizaciones incluyendo agencias US federal. Motivó **EO 14028 (mayo 2021)** que mandó Zero Trust para gov federal. **Lección:** los perímetros tradicionales no bastan.

**Ericsson (dic 2018):** cert expirado en su software tumbó redes 4G de O2 UK (32M) y SoftBank Japan por horas. **Lección:** monitorear expiración y automatizar renovación no es opcional.

**Microsoft Teams (feb 2020) y Cisco WebEx (2020):** outages globales por certs expirados. **Lección:** hasta bigcos fallan en operaciones básicas de PKI.

**Cloudflare Access + Tailscale (2020+):** ZTNA reemplaza VPN en muchas empresas. Cloudflare Zero Trust suite (Access + Gateway + Tunnel) da acceso app-por-app con auth OIDC. **Lección:** VPN legacy tiene reemplazo viable.

**Pinterest, Uber, Bloomberg, Square:** publicaron adopción de SPIFFE/SPIRE para identidad de workload cross-cloud. **Lección:** SPIFFE es el estándar de facto para identidad de workload multi-plataforma en 2026.

**Cilium adoption (2023-2026):** Isovalent adquirida por Cisco (2023). GKE Dataplane V2 default. AWS EKS con opción Cilium. En 2026 Cilium 1.19+ consolida como default de nuevos clusters serios. **Lección:** eBPF llegó al mainstream para networking + security.

**AWS Session Manager adoption:** post-2018 empresas eliminan bastion hosts SSH masivamente. **Lección:** superficie de ataque = líneas de firewall abiertas al mundo.

**Airbnb NetworkPolicies (2023):** estandarizaron default-deny en todos los namespaces productivos. Reducción documentada de blast radius de incidentes. **Lección:** microsegmentación es viable con DX correcto (self-service policies + tooling).

**SPIRE 1.10+ integrations (2026):** integración madura con Istio 1.22+, Envoy 1.30+, Vault 1.16+, AWS App Mesh, Tetragon. **Lección:** SPIFFE ecosystem ha madurado a producción enterprise.

---

## 8. Ejercicios prácticos

### Ejercicio 1: cert-manager con Let's Encrypt DNS-01

**Objetivo:** emitir un wildcard cert `*.linguadev.local` con DNS-01 challenge (Route53) y renovarlo automáticamente.

**Pasos:**
1. Instalar cert-manager v1.16+ en cluster kind/EKS.
2. Crear IAM role con permisos Route53 (o usar staging LE).
3. Definir `ClusterIssuer` con solver DNS-01.
4. Crear `Certificate` para `*.linguadev.local`.
5. Ver `kubectl describe certificate` hasta que `READY=True`.
6. Verificar Secret `linguadev-tls` con `tls.crt` y `tls.key`.

**Criterios de éxito:**
- [ ] Certificate `READY=True` en <5 min.
- [ ] `openssl x509 -in tls.crt -text | grep 'DNS:'` muestra el wildcard.
- [ ] Renewal automático programado 30d antes de expirar (ver `.status.renewalTime`).

**Bonus:** rotar la key con `rotationPolicy: Always` y verificar nuevo `tls.key`.

---

### Ejercicio 2: SPIRE emitiendo SVIDs y mTLS Go client/server

**Objetivo:** instalar SPIRE, registrar entries para 2 workloads, verificar handshake mTLS SPIFFE.

**Pasos:**
1. Helm install SPIRE con trust domain `linguadev.local`.
2. Crear `ClusterSPIFFEID` para namespace `demo`.
3. Deployar `spire-echo-server` y `spire-echo-client` (Go, usa go-spiffe).
4. Verificar SVIDs con `spire-agent api fetch`.
5. Ejecutar client → server y ver identidad SPIFFE del peer.

**Criterios de éxito:**
- [ ] SVIDs con TTL 1h y auto-rotación observable en logs.
- [ ] mTLS exitoso client → server.
- [ ] Cliente rechaza conexión si el SPIFFE ID del server no matchea el esperado.

**Bonus:** rotar la root CA de SPIRE con overlap y verificar cero downtime.

---

### Ejercicio 3: default-deny + Cilium L7 + Hubble

**Objetivo:** aplicar default-deny en namespace `secure-app`, permitir solo `GET /health` de `web` a `api`, y observar drops en Hubble.

**Pasos:**
1. Cilium 1.16+ con Hubble UI.
2. Namespace `secure-app` con 2 Deployments (`web`, `api`) + 1 pod `debug`.
3. `CiliumNetworkPolicy` default-deny.
4. `CiliumNetworkPolicy` `web → api` solo `GET /health`.
5. Test: `web` curl `/health` OK; `web` curl `/data` → 403; `debug` curl → dropped.

**Criterios de éxito:**
- [ ] Hubble UI muestra flujos ALLOWED y DROPPED con verdict.
- [ ] `GET /health` responde 200 solo desde `web`.
- [ ] `POST /data` desde `web` bloqueado a nivel policy L7.

**Bonus:** habilitar encryption WireGuard y verificar `wg show` en nodos.

---

### Ejercicio 4: AWS WAF + rate limiting + geo-blocking

**Objetivo:** desplegar WAFv2 asociado a ALB con Common Rule Set + rate limit 100/min por IP + block de países específicos.

**Pasos:**
1. Terraform: WAFv2 con `AWSManagedRulesCommonRuleSet`.
2. Añadir regla `rate_based_statement` limit 100.
3. Añadir regla `geo_match_statement` con `country_codes = ["CN", "RU"]` action `block`.
4. Asociar al ALB.
5. Test con `hey` desde tu IP y verificar 429 después de 100 req.
6. Ver CloudWatch metrics.

**Criterios de éxito:**
- [ ] Requests exceso → 429.
- [ ] Geo-blocked responden 403.
- [ ] CloudWatch muestra métricas separadas por regla.

**Bonus:** añadir `bot_control` managed rule y evaluar coste.

---

### Ejercicio 5 (bonus): Reemplazar bastion SSH por Session Manager + Cloudflare Access

**Objetivo:** eliminar bastion tradicional y usar Session Manager para EC2 + Cloudflare Access para Grafana.

**Pasos:**
1. Terraform: EC2 con IAM role `AmazonSSMManagedInstanceCore`, sin SG SSH.
2. `aws ssm start-session --target <instance-id>`.
3. Cloudflare Tunnel + Access policy con OIDC (Google Workspace).
4. Grafana internal accedido vía `grafana.linguadev.internal` con auth OIDC.
5. Auditar sesiones en CloudWatch y Cloudflare dashboard.

**Criterios de éxito:**
- [ ] SSH port 22 no está en ningún security group.
- [ ] Session logs en CloudWatch con user IAM.
- [ ] Grafana requiere login Google, valida group membership.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [NIST SP 800-207](https://csrc.nist.gov/publications/detail/sp/800-207/final) — Zero Trust Architecture.
- [BeyondCorp papers](https://cloud.google.com/beyondcorp) — Google.
- [cert-manager.io](https://cert-manager.io/docs/) — CNCF graduated.
- [spiffe.io](https://spiffe.io/docs/) — SPIFFE spec + SPIRE 1.10+.
- [docs.cilium.io](https://docs.cilium.io) — Cilium 1.16+/1.19+ con eBPF y Hubble.
- [tailscale.com/kb](https://tailscale.com/kb/) — ZTNA WireGuard.
- [developers.cloudflare.com/cloudflare-one](https://developers.cloudflare.com/cloudflare-one/) — Cloudflare Zero Trust.

**Referencias:**
- RFC 5280 (X.509 v3), RFC 5246/8446 (TLS 1.2/1.3), RFC 8555 (ACME), RFC 2986 (CSR PKCS#10).
- Netflix Tech Blog — *Bless* (SSH short-lived certs).
- Google BeyondCorp papers (2014-2018).
- CISA Zero Trust Maturity Model 2.0.
- OWASP API Security Top 10 (2023).

**Herramientas:**
- **openssl** — inspección de certs.
- **cfssl** (CloudFlare) — CLI para PKI.
- **step-ca** (Smallstep) — CA privada simple.
- **Hubble CLI** — observability Cilium.
- **Prometheus blackbox_exporter** — probes SSL con alertas.

**Siguientes pasos:**
- Completá los 5 ejercicios.
- Auditá tu infra: ¿tenés certs expirando? ¿bastion SSH? ¿default-deny?
- Continuá con [Capítulo 32 — Blue/Green, Canary y Rolling](./32-blue-green-canary-rolling.md).

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades junior → staff. Cubren: qué es mTLS y diferencias con TLS, ciclo de vida X.509, cert-manager, Let's Encrypt/ACME, rotación short-lived, SPIFFE ID, SPIRE server/agent, Zero Trust principios, mTLS everywhere en la práctica, Cilium NetworkPolicies, WAF, DDoS, egress control, PrivateLink, Session Manager, ZTNA vs VPN.

- **Fuente:** [`packages/content/src/tech/devops/sim-31-network-security-mtls-zero-trust.json`](../../packages/content/src/tech/devops/sim-31-network-security-mtls-zero-trust.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-31-network-security-mtls-zero-trust`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 30 — API Gateways](./30-api-gateways.md) · [Índice](./README.md) · [Capítulo 32 — Blue/Green, Canary y Rolling →](./32-blue-green-canary-rolling.md)
