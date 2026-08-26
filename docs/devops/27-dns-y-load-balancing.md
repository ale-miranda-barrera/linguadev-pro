# Capítulo 27 — DNS y Load Balancing

> **Focus:** El plano de tráfico global de una app moderna. DNS profundo (record types, TTL, resolvers recursivos vs autoritativos, DNSSEC, DoH/DoT), Route 53 routing policies (simple, weighted, latency, geolocation, geoproximity, failover, multi-value), health checks (endpoint, calculated, CloudWatch alarm), split-horizon DNS, load balancers L4 vs L7 en AWS (ALB, NLB, GLB, CLB legacy), sticky sessions, connection draining, algoritmos (round-robin, least connections, weighted), y global load balancing con Cloudflare/Route 53.
> **Áreas:** Networking · Reliability
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- TCP/IP fundamentals: capa 4 vs capa 7, puertos, TLS handshake.
- HTTP/1.1 y HTTP/2, headers, keep-alive.
- Cloud fundamentals: AWS VPC, subnets, security groups (ver [cap 14 — cloud fundamentals](./14-cloud-fundamentals-y-multi-cloud.md)).
- Kubernetes networking: Service, Ingress, Gateway API (ver [cap 09 — kubernetes networking](./09-kubernetes-networking-y-storage.md)).
- CDN básica (se cubre en profundidad en [cap 28](./28-cdn-y-edge-computing.md)).

**Glosario mínimo:**
- **DNS** (Domain Name System, RFC 1034/1035, 1987): traduce nombres a IPs (y otros records). Sistema distribuido jerárquico root → TLD → authoritative.
- **A record**: IPv4 (32-bit). **AAAA**: IPv6 (128-bit). **CNAME**: alias canónico. **MX**: mail exchange con priority. **TXT**: texto libre (SPF, DKIM, DMARC, verificación). **NS**: nameservers. **SOA**: Start of Authority. **PTR**: reverse DNS. **SRV**: service location. **CAA**: certificate authority authorization.
- **TTL** (Time To Live): segundos que un resolver debe cachear un record. Trade-off entre agilidad (TTL bajo) y eficiencia (TTL alto).
- **Recursive resolver**: hace toda la búsqueda iterativa (ISP, 8.8.8.8, 1.1.1.1). **Authoritative**: fuente de verdad de una zona (Route 53, Cloudflare DNS, BIND).
- **DNSSEC** (DNS Security Extensions, RFC 4033/4034/4035): firmas criptográficas para prevenir cache poisoning y spoofing.
- **DoH/DoT** (DNS over HTTPS/TLS): cifran la conexión client↔resolver para privacidad.
- **Alias record** (Route 53) / **ANAME** (otros): "CNAME en el apex" — resuelve al IP AWS-side.
- **Split-horizon DNS**: la misma zona resuelve distinto según origin (interno vs externo).
- **Routing policy** (Route 53): simple, weighted, latency-based, geolocation, geoproximity (Traffic Flow), failover, multi-value answer.
- **Health check**: verificación periódica de un endpoint (HTTP/HTTPS/TCP) desde múltiples locations globales; base de failover automático.
- **Load balancer L4** (Layer 4): balancea a nivel TCP/UDP (source/dest IP:port). **NLB** en AWS.
- **Load balancer L7** (Layer 7): entiende HTTP/HTTPS, rutea por host/path/header. **ALB** en AWS.
- **GLB** (Gateway Load Balancer): AWS, transparent bump-in-the-wire para inserción de appliances (firewalls, IDS).
- **Sticky session** (session affinity): las requests del mismo client van al mismo target. Cookie-based o IP-based.
- **Connection draining** (deregistration delay): esperar N segundos antes de kill un target para no romper conexiones activas.
- **Anycast**: mismo IP anunciado desde múltiples PoPs; BGP enruta al más cercano. Base de CDN modernos y DNS público (8.8.8.8, 1.1.1.1).

**Setup mínimo:**

```bash
# 1. dig + dnsutils
sudo apt install dnsutils    # dig, nslookup, host
dig +short example.com A
dig +trace example.com       # ver toda la cadena root → TLD → authoritative
dig @8.8.8.8 example.com     # forzar resolver específico
dig example.com CAA          # certificate authority authorization
dig example.com +dnssec      # incluir DNSSEC signatures

# 2. AWS CLI + Terraform para Route 53 + ELBv2
aws --version   # 2.17.x+
terraform version   # 1.9.x+

# 3. httpie o curl para testing L7
brew install httpie
http --verify=no https://api.linguadev.app/healthz

# 4. mtr para path analysis
sudo apt install mtr
mtr --report --report-cycles=100 api.linguadev.app

# 5. dnsperf para load testing DNS
sudo apt install dnsperf
echo "example.com A" > queries.txt
dnsperf -s 8.8.8.8 -d queries.txt -c 100 -Q 1000

# 6. openssl para TLS debugging
openssl s_client -connect api.linguadev.app:443 -servername api.linguadev.app -showcerts
```

---

## 1. El gran cuadro

DNS y load balancing son los dos gates invisibles por los que pasa cada request antes de tocar tu backend. Cuando funcionan, nadie los nota. Cuando fallan, el mundo se cae y no de forma parcial — se cae completo. **Facebook octubre 2021**: cambios BGP hicieron unreachable a los nameservers autoritativos, y por seis horas nadie pudo resolver `facebook.com`, `instagram.com` ni `whatsapp.com`; los ingenieros no pudieron entrar físicamente al datacenter porque el sistema de badges dependía de DNS interno. **AWS us-east-1 diciembre 2021**: fallas en el control plane cascadearon a Route 53 y ELB, causando outage de 8 horas para servicios que dependían de esa región. **Cloudflare junio 2022**: config change en 19 datacenters causó 90 minutos de downtime global. **Fastly junio 2021**: misconfig de un cliente disparó bug latente que tumbó Reddit, Amazon, GitHub durante ~1h. La lección se repite: DNS y LB son infraestructura crítica; su misconfig es la fuente más común de outages globales.

El sistema DNS moderno funciona como una jerarquía delegada. Cuando tu navegador pide `api.linguadev.app`, la resolución involucra cuatro actores: (1) el **stub resolver** del OS pregunta al recursivo configurado; (2) el **recursive resolver** (Google 8.8.8.8, Cloudflare 1.1.1.1, ISP, o corporate) hace queries iterativas: pregunta al root (`.`), le dan los nameservers del TLD (`.app`), pregunta al TLD que le da los nameservers autoritativos de `linguadev.app`, finalmente pregunta al autoritativo (Route 53, Cloudflare DNS) que responde con el A record; (3) el recursivo cachea la respuesta según el TTL y la devuelve al cliente. El sistema depende críticamente de dos propiedades: **caching agresivo** (por TTL) para escalabilidad, y **redundancia** (múltiples nameservers autoritativos, root servers replicados globalmente vía Anycast). La primera propiedad es la fuente de dolor en migraciones ("cambié el A record y todavía va al servidor viejo"), la segunda es lo que permite que el sistema sobreviva a fallas parciales.

Encima de DNS viven los **load balancers**. AWS ofrece cinco tipos en 2026: **CLB** (Classic Load Balancer, legacy, desaconsejado para nuevos deploys), **ALB** (Application Load Balancer, L7, entiende HTTP/HTTPS/HTTP/2/WebSockets/gRPC, rutea por host/path/header, integra WAF y Cognito auth), **NLB** (Network Load Balancer, L4, TCP/UDP/TLS passthrough, latencia sub-ms, IP estática por AZ, ideal para high-throughput y protocolos no-HTTP), **GLB** (Gateway Load Balancer, transparente L3, para insertar firewalls/IDS de terceros), y para Kubernetes on-AWS lo típico es **AWS Load Balancer Controller** que provisiona ALB via Ingress/Gateway API y NLB via Service `type: LoadBalancer`. La decisión ALB vs NLB depende de si necesitás routing L7 (host/path/header → ALB) o performance/protocolo TCP/UDP (→ NLB). Ambos hacen health checks continuos, connection draining, sticky sessions y multi-AZ automáticamente.

El siguiente eje es **global load balancing** — múltiples regiones con failover y routing inteligente. **Route 53** tiene siete routing policies (simple, weighted para canary/blue-green, latency-based, geolocation, geoproximity para bias, failover para active-passive, multi-value answer para round-robin básico) combinables con **health checks** (endpoint HTTP/HTTPS/TCP, calculated agregando múltiples, CloudWatch alarm para métricas internas). Las alternativas incluyen **Cloudflare Load Balancing** (Anycast-native, geo steering, health checks distribuidos), **GCP Cloud Load Balancing** (global Anycast único IP), **Azure Front Door** (global L7). El patrón moderno multi-región combina: DNS latency-based con failover, ALB por región con health checks, y CDN encima (ver [cap 28 — CDN y edge](./28-cdn-y-edge-computing.md)). Este capítulo cubre los mecanismos, los patrones de deployment y los anti-patterns más comunes con código Terraform ejecutable sobre LinguaDev Pro.

---

## 2. DNS: records, TTL, resolvers y DNSSEC (nivel básico)

### 2.1 Record types y sus reglas

Los record types más usados en 2026:

| Record | Uso | Ejemplo |
|---|---|---|
| **A** | IPv4 (32-bit) | `api → 203.0.113.10` |
| **AAAA** | IPv6 (128-bit) | `api → 2001:db8::1` |
| **CNAME** | Alias canónico | `www → app.example.com.` |
| **MX** | Mail exchange + priority | `10 aspmx.l.google.com.` |
| **TXT** | Texto libre (SPF, DKIM, DMARC, verificación) | `"v=spf1 include:_spf.google.com ~all"` |
| **NS** | Nameservers autoritativos | `ns-123.awsdns.com.` |
| **SOA** | Start of Authority (metadata zona) | serial, refresh, retry, expire, minimum |
| **PTR** | Reverse DNS (IP → nombre) | `10.113.0.203.in-addr.arpa → smtp.example.com.` |
| **SRV** | Service location | `_sip._tcp → 10 60 5060 sipserver.example.com.` |
| **CAA** | Certificate Authority Authorization | `"0 issue \"letsencrypt.org\""` |
| **ALIAS** (AWS-only) | "CNAME en apex" a ELB/CloudFront/S3 | `example.com → ALIAS my-alb` |

**Reglas críticas:**

1. **CNAME nunca en el apex** (RFC 1912): el root de la zona (`example.com`, sin subdominio) obligatoriamente tiene registros SOA + NS. CNAME + otros records = conflicto. Solución en AWS: `ALIAS` record; en Cloudflare: **CNAME flattening** (auto-resuelve al IP subyacente); en otros DNS providers: **ANAME**.
2. **CAA record** (RFC 6844): opcional pero recomendado — declarás qué CAs pueden emitir certs para tu dominio, previniendo cert-jacking. Let's Encrypt lo respeta automáticamente.
3. **Email moderno** requiere MX + SPF (TXT) + DKIM (TXT/CNAME) + DMARC (TXT). Sin los cuatro, tu correo termina en spam.

Terraform Route 53 completo:

```hcl
data "aws_route53_zone" "linguadev" {
  name = "linguadev.app"
}

# A record IPv4
resource "aws_route53_record" "api_a" {
  zone_id = data.aws_route53_zone.linguadev.zone_id
  name    = "api.linguadev.app"
  type    = "A"
  ttl     = 300
  records = ["203.0.113.10"]
}

# AAAA record IPv6
resource "aws_route53_record" "api_aaaa" {
  zone_id = data.aws_route53_zone.linguadev.zone_id
  name    = "api.linguadev.app"
  type    = "AAAA"
  ttl     = 300
  records = ["2001:db8::1"]
}

# ALIAS al ALB (evita CNAME-en-apex)
resource "aws_route53_record" "root_alias" {
  zone_id = data.aws_route53_zone.linguadev.zone_id
  name    = "linguadev.app"
  type    = "A"
  alias {
    name                   = aws_lb.web.dns_name
    zone_id                = aws_lb.web.zone_id
    evaluate_target_health = true
  }
}

# CNAME de www al apex
resource "aws_route53_record" "www" {
  zone_id = data.aws_route53_zone.linguadev.zone_id
  name    = "www.linguadev.app"
  type    = "CNAME"
  ttl     = 300
  records = ["linguadev.app"]
}

# MX para Google Workspace
resource "aws_route53_record" "mx" {
  zone_id = data.aws_route53_zone.linguadev.zone_id
  name    = "linguadev.app"
  type    = "MX"
  ttl     = 3600
  records = [
    "1 aspmx.l.google.com.",
    "5 alt1.aspmx.l.google.com.",
    "5 alt2.aspmx.l.google.com.",
    "10 alt3.aspmx.l.google.com.",
    "10 alt4.aspmx.l.google.com."
  ]
}

# SPF (TXT)
resource "aws_route53_record" "spf" {
  zone_id = data.aws_route53_zone.linguadev.zone_id
  name    = "linguadev.app"
  type    = "TXT"
  ttl     = 3600
  records = ["v=spf1 include:_spf.google.com ~all"]
}

# DMARC
resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.linguadev.zone_id
  name    = "_dmarc.linguadev.app"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@linguadev.app; pct=100"]
}

# CAA: solo Let's Encrypt puede emitir certs
resource "aws_route53_record" "caa" {
  zone_id = data.aws_route53_zone.linguadev.zone_id
  name    = "linguadev.app"
  type    = "CAA"
  ttl     = 3600
  records = [
    "0 issue \"letsencrypt.org\"",
    "0 issuewild \"letsencrypt.org\"",
    "0 iodef \"mailto:security@linguadev.app\""
  ]
}
```

### 2.2 TTL: el mecanismo de caching y su trade-off

TTL define cuántos segundos un resolver debe cachear un record antes de re-consultar al autoritativo. **Trade-off central**: TTL alto = queries menos frecuentes (barato, rápido) pero cambios lentos en propagar; TTL bajo = queries frecuentes (más caro Route 53 charging + más carga a authoritative) pero cambios rápidos.

**Estrategia estándar para migración de A record**:

```
T-48h: bajar TTL de 86400 (24h) → 60s. Los resolvers cachean por 24h la respuesta con TTL=60.
T-24h: los caches del TTL=60 ya expiraron. Nuevos queries reciben TTL=60.
T-0:   hacer el cambio del A record. Propaga en ~60s a resolvers respetuosos.
T+2h:  confirmar que traffic va al nuevo IP.
T+6h:  subir TTL de vuelta a 3600 (1h) para ahorrar queries.
```

**Caveats reales**:
- Algunos resolvers (ISPs residenciales asiáticos son famosos por esto) **ignoran TTLs bajos** y aplican un mínimo interno (30-300s), o incluso violan TTL cacheando días.
- Navegadores tienen sus propios caches (Chrome ~60s default).
- Sistemas operativos también (nscd/systemd-resolved en Linux, DNS Client Service en Windows, mDNSResponder en macOS).
- **Mitigación**: mantener AMBOS backends corriendo 24-72h post-cutover (dual-stack) para capturar rezagados.

### 2.3 Recursive vs authoritative

Distinción crítica que confunde a juniors: **recursivo hace el trabajo**, **authoritative tiene la respuesta**. Nunca configures un servidor como "open recursive resolver" expuesto a Internet — es vector de DNS amplification DDoS (el atacante manda queries con source IP spoofed al recursivo, que responde 10x más data a la víctima).

```bash
# Ver toda la cadena
dig +trace api.linguadev.app
# 1. Root servers (a.root-servers.net, etc.) → dan NS de .app
# 2. TLD .app NS → dan NS de linguadev.app
# 3. Authoritative de linguadev.app (Route 53 ns-xxx.awsdns-xx.co.uk) → responden A record
```

### 2.4 DNSSEC, DoH, DoT

**DNSSEC** (Domain Name System Security Extensions, RFC 4033-4035) añade firmas criptográficas a las respuestas DNS. Cada zona firma sus records con **ZSK** (Zone Signing Key); la ZSK se firma con **KSK** (Key Signing Key); la KSK se pública en la zona padre como **DS** record. La cadena de trust va del root (con Trust Anchor conocido) hasta tu zona.

**Route 53 DNSSEC** en 2026:

```hcl
resource "aws_kms_key" "dnssec" {
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  policy                   = data.aws_iam_policy_document.dnssec_key_policy.json
}

resource "aws_route53_key_signing_key" "ksk" {
  hosted_zone_id             = data.aws_route53_zone.linguadev.zone_id
  key_management_service_arn = aws_kms_key.dnssec.arn
  name                       = "linguadev-ksk"
}

resource "aws_route53_hosted_zone_dnssec" "dnssec" {
  depends_on     = [aws_route53_key_signing_key.ksk]
  hosted_zone_id = data.aws_route53_zone.linguadev.zone_id
}
```

Después publicar el DS record en el registrar (GoDaddy, Route 53 Domains, Namecheap):

```bash
aws route53 get-dnssec --hosted-zone-id Z123456 --query 'KeySigningKeys[0].DSRecord'
# "20326 13 2 ABCD1234..."
```

**DoH** (DNS over HTTPS, RFC 8484) y **DoT** (DNS over TLS, RFC 7858) cifran la conexión resolver↔cliente. Cloudflare 1.1.1.1, Google 8.8.8.8 y Quad9 los soportan. Firefox y Chrome tienen DoH built-in con toggle. Trade-off: privacidad vs corporate DNS filtering (algunos empresas bloquean DoH porque no pueden ver las queries de empleados).

### 2.5 Split-horizon DNS

El mismo hostname resuelve a IP interno para clientes en la VPC y a IP público para clientes en Internet. Útil para API management, dashboards internos, DBs.

```hcl
# Public hosted zone (Internet)
resource "aws_route53_zone" "public" {
  name = "linguadev.app"
}

resource "aws_route53_record" "public_api" {
  zone_id = aws_route53_zone.public.zone_id
  name    = "api.linguadev.app"
  type    = "A"
  alias {
    name                   = aws_lb.public_alb.dns_name
    zone_id                = aws_lb.public_alb.zone_id
    evaluate_target_health = true
  }
}

# Private hosted zone (VPC-only)
resource "aws_route53_zone" "private" {
  name = "linguadev.app"
  vpc {
    vpc_id = aws_vpc.main.id
  }
}

resource "aws_route53_record" "private_api" {
  zone_id = aws_route53_zone.private.zone_id
  name    = "api.linguadev.app"
  type    = "A"
  alias {
    name                   = aws_lb.internal_alb.dns_name
    zone_id                = aws_lb.internal_alb.zone_id
    evaluate_target_health = true
  }
}
```

Desde una EC2 en la VPC, `dig api.linguadev.app` retorna el IP interno; desde Internet retorna el público.

---

## 3. Route 53 routing policies y health checks (nivel medio)

### 3.1 Las siete routing policies

Route 53 combina siete políticas:

1. **Simple**: default. Un record, una respuesta.
2. **Weighted**: distribuye por peso (`weight`). Ideal para canary (90/10 → 50/50 → 0/100) y blue-green.
3. **Latency-based**: mide latencia real desde el resolver a cada región AWS y rutea al más cercano. Más adaptable que geolocation.
4. **Geolocation**: rutea por país/continente del client. Útil para compliance (data residency EU) o localización.
5. **Geoproximity** (Traffic Flow feature): rutea por proximidad geográfica pero permite **bias** (ajustar el radio de influencia de cada región para mover traffic entre regiones sin cambio hard).
6. **Failover**: active-passive. Primary healthy → todo va al primary; primary unhealthy → todo va al secondary.
7. **Multi-value answer**: retorna hasta 8 records aleatoriamente (poor man's LB). Con health checks, solo retorna los healthy.

### 3.2 Combinación para multi-región

Escenario: LinguaDev deployado en `us-east-1`, `eu-west-1`, `ap-southeast-1`. Usuarios europeos van al ALB EU, americanos al US, asiáticos al AP, con failover automático.

```hcl
# Health checks por región
resource "aws_route53_health_check" "us_east_1" {
  fqdn              = aws_lb.us_east_1.dns_name
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = 3
  request_interval  = 30
  measure_latency   = true

  tags = { Region = "us-east-1" }
}

resource "aws_route53_health_check" "eu_west_1" {
  fqdn              = aws_lb.eu_west_1.dns_name
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = 3
  request_interval  = 30
  measure_latency   = true

  tags = { Region = "eu-west-1" }
}

resource "aws_route53_health_check" "ap_southeast_1" {
  fqdn              = aws_lb.ap_southeast_1.dns_name
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = 3
  request_interval  = 30
  measure_latency   = true

  tags = { Region = "ap-southeast-1" }
}

# Latency-based routing: cada region tiene su record con set_identifier
resource "aws_route53_record" "api_us" {
  zone_id        = data.aws_route53_zone.linguadev.zone_id
  name           = "api.linguadev.app"
  type           = "A"
  set_identifier = "us-east-1"

  latency_routing_policy {
    region = "us-east-1"
  }

  alias {
    name                   = aws_lb.us_east_1.dns_name
    zone_id                = aws_lb.us_east_1.zone_id
    evaluate_target_health = true
  }

  health_check_id = aws_route53_health_check.us_east_1.id
}

resource "aws_route53_record" "api_eu" {
  zone_id        = data.aws_route53_zone.linguadev.zone_id
  name           = "api.linguadev.app"
  type           = "A"
  set_identifier = "eu-west-1"

  latency_routing_policy {
    region = "eu-west-1"
  }

  alias {
    name                   = aws_lb.eu_west_1.dns_name
    zone_id                = aws_lb.eu_west_1.zone_id
    evaluate_target_health = true
  }

  health_check_id = aws_route53_health_check.eu_west_1.id
}

resource "aws_route53_record" "api_ap" {
  zone_id        = data.aws_route53_zone.linguadev.zone_id
  name           = "api.linguadev.app"
  type           = "A"
  set_identifier = "ap-southeast-1"

  latency_routing_policy {
    region = "ap-southeast-1"
  }

  alias {
    name                   = aws_lb.ap_southeast_1.dns_name
    zone_id                = aws_lb.ap_southeast_1.zone_id
    evaluate_target_health = true
  }

  health_check_id = aws_route53_health_check.ap_southeast_1.id
}
```

Con esta config, un user en Frankfurt resolverá al ALB EU; si el ALB EU cae, health check falla, Route 53 lo saca del pool, y el user es ruteado al segundo más cercano (US). El failover DNS-level toma ~60s (30s de check interval + TTL bajo).

### 3.3 Health checks: tipos y trampas

Route 53 tiene tres tipos:

1. **Endpoint health check**: request periódico HTTP/HTTPS/TCP desde 15+ locations globales.
2. **Calculated**: agrega N health checks con AND/OR. Útil para "region healthy si ALB + DB + Redis están healthy".
3. **CloudWatch alarm**: basado en métrica interna (útil para monitor recursos privados que Route 53 no puede alcanzar).

Configuración avanzada:

```hcl
resource "aws_route53_health_check" "api_advanced" {
  fqdn              = "api.linguadev.app"
  port              = 443
  type              = "HTTPS_STR_MATCH"
  resource_path     = "/healthz"
  search_string     = "\"status\":\"ok\""
  request_interval  = 10               # $$$: default 30s, 10s cuesta más
  failure_threshold = 2
  enable_sni        = true
  regions           = ["us-east-1", "us-west-2", "eu-west-1"]   # subset para reducir cost
  measure_latency   = true

  # Evaluar solo desde N regions saludables
  invert_healthcheck = false
}
```

**Trampas comunes**:
- `evaluate_target_health = true` en el ALIAS record depende del health check DEL ALB, no del Route 53 health check custom.
- Endpoints internos (VPC-only) no son alcanzables por Route 53 → usar CloudWatch alarm health check.
- Health check requests vienen de rangos IPs específicos de AWS — no bloquearlos en security groups (usar el `AmazonRoute53HealthChecks` prefix list o `route53-healthchecks.amazonaws.com`).
- Costo: 15+ probes globales cada 10s multiplicado por número de checks se acumula rápido. Reducí a 30s + subset de regions para dev/staging.

---

## 4. Load Balancers: ALB, NLB, GLB y patrones (nivel avanzado)

### 4.1 ALB (Application Load Balancer, L7)

ALB opera en capa 7: entiende HTTP/1.1, HTTP/2, HTTP/3 (HTTP/3 GA 2024), WebSockets, gRPC. Rutea por host, path, header, query string, method, source IP. Integra AWS WAF, Cognito para authentication, redirect rules, fixed responses. En 2026, el AWS Load Balancer Controller para K8s provisiona ALBs vía Ingress y Gateway API.

Terraform ALB con TLS + WAF + listener rules:

```hcl
resource "aws_lb" "web" {
  name               = "linguadev-web-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection       = true
  enable_http2                     = true
  enable_cross_zone_load_balancing = true
  idle_timeout                     = 60
  drop_invalid_header_fields       = true

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "alb"
    enabled = true
  }
}

resource "aws_lb_target_group" "api" {
  name        = "linguadev-api-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"     # ip = pod IPs en EKS; instance = EC2

  health_check {
    path                = "/healthz"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200-299"
  }

  deregistration_delay = 30   # connection draining

  stickiness {
    type            = "lb_cookie"
    cookie_duration = 3600
    enabled         = false   # activar solo si REALMENTE necesitás
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.web.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-3-2021-06"
  certificate_arn   = aws_acm_certificate.linguadev.arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "Not found"
    }
  }
}

# Rule: /api/* → API target group
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }

  condition {
    host_header {
      values = ["api.linguadev.app", "www.linguadev.app"]
    }
  }
}

# Rule: /admin/* → require Cognito auth
resource "aws_lb_listener_rule" "admin" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 50

  action {
    type = "authenticate-cognito"
    authenticate_cognito {
      user_pool_arn       = aws_cognito_user_pool.admin.arn
      user_pool_client_id = aws_cognito_user_pool_client.admin.id
      user_pool_domain    = aws_cognito_user_pool_domain.admin.domain
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.admin.arn
  }

  condition {
    path_pattern { values = ["/admin/*"] }
  }
}

# Redirect HTTP → HTTPS
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
```

### 4.2 NLB (Network Load Balancer, L4)

NLB opera en capa 4: TCP, UDP, TLS passthrough. Latencia sub-ms, IP estática por AZ (asignable como EIP), preserva source IP del cliente. Ideal para: high-throughput (>100k req/s), protocolos no-HTTP (SMTP, PostgreSQL, gRPC-heavy, gaming UDP), casos que requieren source IP real, TLS terminado en el backend por compliance.

```hcl
resource "aws_lb" "grpc" {
  name               = "linguadev-grpc-nlb"
  load_balancer_type = "network"
  subnets            = aws_subnet.public[*].id

  enable_cross_zone_load_balancing = true

  subnet_mapping {
    subnet_id     = aws_subnet.public[0].id
    allocation_id = aws_eip.nlb_a.id
  }
  subnet_mapping {
    subnet_id     = aws_subnet.public[1].id
    allocation_id = aws_eip.nlb_b.id
  }
}

resource "aws_lb_target_group" "grpc" {
  name        = "linguadev-grpc-tg"
  port        = 50051
  protocol    = "TCP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  preserve_client_ip = true

  health_check {
    protocol            = "TCP"
    port                = 50051
    healthy_threshold   = 3
    unhealthy_threshold = 3
    interval            = 10
  }
}

resource "aws_lb_listener" "grpc" {
  load_balancer_arn = aws_lb.grpc.arn
  port              = 50051
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.grpc.arn
  }
}
```

### 4.3 Algoritmos y sticky sessions

Los algorithms disponibles:

- **Round-robin** (default ALB): distribuye secuencialmente.
- **Least outstanding requests** (LOR) en ALB: envía al target con menos requests activas. Mejor para requests con duración variable.
- **Weighted target groups**: distribuye por peso (canary, blue-green).
- **Flow hash** (NLB): hash de 5-tuple (source IP:port, dest IP:port, protocol). Deterministic per-connection.

**Sticky sessions** (session affinity): útil solo cuando la app guarda state en memoria del server (session HTTP local). En apps modernas stateless con state en Redis/DB, **no uses sticky** — desbalancea la carga y reduce resilience.

- ALB: **lb_cookie** (AWS-generated `AWSALB` cookie) o **app_cookie** (usa cookie de tu app).
- NLB: **source IP affinity** (todos los packets de la misma source IP van al mismo target).

**Trade-off crítico**: sticky session activa reduce elasticidad — cuando escalás up, los nuevos targets no reciben tráfico existente. Cuando scaleás down, killear un target rompe todas sus sessions. Best practice: state externo (Redis) + LB stateless.

### 4.4 Connection draining (deregistration delay)

Cuando desregistrás un target (deploy, scale down), el LB debe esperar antes de kill para no romper conexiones activas. `deregistration_delay` (default 300s en AWS) controla ese timeout.

- Apps con requests cortos (<5s): `deregistration_delay = 30s` suficiente.
- Apps con requests largos (uploads, batch, gRPC streaming): `120-300s`.
- WebSockets/streaming eternos: enviar aviso al cliente para reconectar antes de kill.

### 4.5 AWS Load Balancer Controller en EKS

En Kubernetes on EKS, el AWS Load Balancer Controller provisiona ALB/NLB desde annotations en Ingress/Service:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: linguadev-web
  namespace: linguadev-prod
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:111111111111:certificate/abc-def
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-3-2021-06
    alb.ingress.kubernetes.io/backend-protocol: HTTP
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: '15'
    alb.ingress.kubernetes.io/wafv2-acl-arn: arn:aws:wafv2:us-east-1:111111111111:regional/webacl/linguadev-waf/abc
    alb.ingress.kubernetes.io/load-balancer-attributes: |
      idle_timeout.timeout_seconds=60,
      routing.http2.enabled=true,
      access_logs.s3.enabled=true,
      access_logs.s3.bucket=linguadev-alb-logs
spec:
  rules:
    - host: api.linguadev.app
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 80
    - host: www.linguadev.app
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

---

## 5. Ejemplo práctico: LinguaDev Pro multi-región con Route 53 + ALB

Setup completo: 3 regiones, ALB por región, Route 53 latency-based con failover, health checks, DNSSEC, blue-green deploy vía weighted routing.

### Paso 1: ALB por región con Terraform module

```hcl
# modules/region-stack/main.tf
variable "region" {}
variable "vpc_id" {}
variable "subnet_ids" { type = list(string) }
variable "certificate_arn" {}

resource "aws_lb" "regional" {
  name               = "linguadev-${var.region}"
  load_balancer_type = "application"
  subnets            = var.subnet_ids
  security_groups    = [aws_security_group.alb.id]

  enable_deletion_protection       = true
  enable_cross_zone_load_balancing = true
}

resource "aws_lb_target_group" "app" {
  name        = "linguadev-${var.region}-app"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path              = "/healthz"
    healthy_threshold = 2
    interval          = 15
    matcher           = "200"
  }

  deregistration_delay = 30
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.regional.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-3-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

output "alb_dns_name" { value = aws_lb.regional.dns_name }
output "alb_zone_id"  { value = aws_lb.regional.zone_id }
```

### Paso 2: Route 53 latency-based con failover

```hcl
# main.tf
module "region_us" {
  source          = "./modules/region-stack"
  providers       = { aws = aws.us_east_1 }
  region          = "us-east-1"
  vpc_id          = aws_vpc.us.id
  subnet_ids      = aws_subnet.us_public[*].id
  certificate_arn = aws_acm_certificate.us.arn
}

module "region_eu" {
  source          = "./modules/region-stack"
  providers       = { aws = aws.eu_west_1 }
  region          = "eu-west-1"
  vpc_id          = aws_vpc.eu.id
  subnet_ids      = aws_subnet.eu_public[*].id
  certificate_arn = aws_acm_certificate.eu.arn
}

module "region_ap" {
  source          = "./modules/region-stack"
  providers       = { aws = aws.ap_southeast_1 }
  region          = "ap-southeast-1"
  vpc_id          = aws_vpc.ap.id
  subnet_ids      = aws_subnet.ap_public[*].id
  certificate_arn = aws_acm_certificate.ap.arn
}

# Latency records
resource "aws_route53_record" "api_us" {
  zone_id        = data.aws_route53_zone.linguadev.zone_id
  name           = "api.linguadev.app"
  type           = "A"
  set_identifier = "us-east-1"

  latency_routing_policy { region = "us-east-1" }

  alias {
    name                   = module.region_us.alb_dns_name
    zone_id                = module.region_us.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api_eu" {
  zone_id        = data.aws_route53_zone.linguadev.zone_id
  name           = "api.linguadev.app"
  type           = "A"
  set_identifier = "eu-west-1"

  latency_routing_policy { region = "eu-west-1" }

  alias {
    name                   = module.region_eu.alb_dns_name
    zone_id                = module.region_eu.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api_ap" {
  zone_id        = data.aws_route53_zone.linguadev.zone_id
  name           = "api.linguadev.app"
  type           = "A"
  set_identifier = "ap-southeast-1"

  latency_routing_policy { region = "ap-southeast-1" }

  alias {
    name                   = module.region_ap.alb_dns_name
    zone_id                = module.region_ap.alb_zone_id
    evaluate_target_health = true
  }
}
```

### Paso 3: blue-green vía weighted routing

```hcl
resource "aws_route53_record" "api_blue" {
  zone_id        = data.aws_route53_zone.linguadev.zone_id
  name           = "api.linguadev.app"
  type           = "A"
  set_identifier = "blue"

  weighted_routing_policy { weight = 100 }   # 100/0 al inicio

  alias {
    name                   = aws_lb.blue.dns_name
    zone_id                = aws_lb.blue.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api_green" {
  zone_id        = data.aws_route53_zone.linguadev.zone_id
  name           = "api.linguadev.app"
  type           = "A"
  set_identifier = "green"

  weighted_routing_policy { weight = 0 }   # cambiar a 10, 50, 100 para cutover progresivo

  alias {
    name                   = aws_lb.green.dns_name
    zone_id                = aws_lb.green.zone_id
    evaluate_target_health = true
  }
}
```

Cambio de weights via `terraform apply -var 'blue_weight=50' -var 'green_weight=50'` para 50/50 canary.

### Paso 4: verificación end-to-end

```bash
# Desde una máquina en EU
dig +short api.linguadev.app @1.1.1.1
# 34.246.xxx.xxx (IP del ALB EU)

# Desde una máquina en US
dig +short api.linguadev.app @8.8.8.8
# 3.219.xxx.xxx (IP del ALB US)

# Simular fallo: apagar target EU
kubectl scale deployment/api --replicas=0 -n linguadev-prod

# Esperar ~60s (health check interval 15s * failure_threshold 3)
sleep 60

# Verificar desde EU
dig +short api.linguadev.app @1.1.1.1
# 3.219.xxx.xxx (ahora rutea a US porque EU es unhealthy)
```

---

## 6. Cheatsheet + reglas mentales + anti-patterns

### Reglas de oro

- ✅ **CNAME nunca en el apex** — usar ALIAS (Route 53), ANAME (otros), o CNAME flattening (Cloudflare).
- ✅ **Bajar TTL 24-48h antes de migrar** DNS + subirlo post-cutover.
- ✅ **Mantener dual-stack 24-72h** post-cutover para capturar rezagados.
- ✅ **Health checks** en todo record que apunta a servicio crítico.
- ✅ **DNSSEC** para dominios high-value (bancos, gov, fintech).
- ✅ **CAA record** para prevenir cert-jacking (declarar CAs autorizadas).
- ✅ **SPF + DKIM + DMARC** completos para email delivery.
- ✅ **ALB para HTTP/HTTPS** con host/path/header routing.
- ✅ **NLB para TCP/UDP** high-throughput o preservar source IP.
- ✅ **Deregistration delay 30s** apps stateless; **120-300s** long-running.
- ✅ **Cross-zone load balancing enabled** para distribución uniforme multi-AZ.
- ✅ **TLS 1.3 policy** (`ELBSecurityPolicy-TLS13-1-3-2021-06` o superior).
- ✅ **Drop invalid header fields** en ALB para mitigar HTTP smuggling.
- ✅ **Access logs a S3** en ALBs productivos.
- ✅ **WAF integrado** con ALB en apps públicas.
- ✅ **Multi-región con latency-based + health checks** para global apps.
- ✅ **Split-horizon DNS** cuando internal + external necesitan misma zona.
- ✅ **Sticky sessions solo si REALMENTE stateful** (evitar).
- ✅ **Blue-green o canary via Route 53 weighted** o ALB weighted target groups.

### Anti-patterns

- ❌ **CNAME en apex** → resolvers fallan o rompen SOA/NS.
- ❌ **TTL alto** en records críticos que migrás frecuentemente.
- ❌ **Cambiar record sin bajar TTL** primero.
- ❌ **Cerrar backend viejo antes de propagación completa** (72h+).
- ❌ **Sin health checks** → traffic va a targets caídos.
- ❌ **Bloquear IPs de Route 53 health checkers** en security groups.
- ❌ **CLB para nuevos deploys** (legacy, desaconsejado).
- ❌ **NLB cuando querés routing L7** (host/path) — usar ALB.
- ❌ **ALB cuando necesitás source IP real** o TCP/UDP — usar NLB.
- ❌ **Sticky sessions activas** en apps stateless (desbalancea + reduce resilience).
- ❌ **Sin connection draining** → 502/503 durante deploys.
- ❌ **TLS 1.0/1.1** en apps públicas.
- ❌ **Sin WAF** en apps con exposición a Internet.
- ❌ **Sin access logs** → forensics imposible post-incident.
- ❌ **Health check interval 10s** en checks costosos → factura Route 53 se dispara.
- ❌ **Depender solo de single-region** para apps global.
- ❌ **Sin DNSSEC + sin CAA** en dominios high-value.

### Tabla decisión LB AWS

| Necesidad | Tipo |
|---|---|
| HTTP/HTTPS + host/path routing | **ALB** |
| HTTP/2 + gRPC + WebSockets | **ALB** |
| TCP/UDP performance | **NLB** |
| Source IP preservation | **NLB** con `preserve_client_ip` |
| TLS passthrough al backend | **NLB** |
| Insertar firewall/IDS transparente | **GLB** |
| Global (multi-region) | Route 53 + ALB/NLB por región |
| Legacy (no nuevos deploys) | ~~CLB~~ |

---

## 7. Casos reales industria 2021-2026

**Facebook DNS outage (4 octubre 2021):** cambio BGP hizo unreachable a los nameservers autoritativos. 6 horas de outage global de facebook.com, instagram.com, whatsapp.com. Los ingenieros no podían ni entrar físicamente al datacenter — badges dependían de DNS interno. **Lección:** DNS es infrastructure crítica; break-glass procedures deben ser out-of-band.

**AWS us-east-1 outage (7 diciembre 2021):** control plane failure cascadeó a Route 53 y ELB. 8 horas de downtime para servicios que dependían de esa región. **Lección:** multi-región no es opcional para apps críticas.

**Fastly outage (8 junio 2021):** misconfig de un cliente disparó bug latente global. Reddit, Amazon, GitHub, NY Times cayeron ~1h. **Lección:** vendors CDN/DNS son single-point-of-failure de la Internet.

**Cloudflare 1.1.1.1 launch (2018):** DNS resolver público con foco en privacidad + performance vs Google 8.8.8.8. Popularizó DoH/DoT. **Lección:** DNS resolvers pueden ser feature-diferenciados.

**AWS Route 53 DNSSEC signing (GA 2020):** finalmente permitió DNSSEC para dominios en Route 53. Antes requería self-hosted BIND. **Lección:** managed DNS servicios llegando a paridad con self-hosted.

**AWS ALB HTTP/3 GA (2024):** HTTP/3 (QUIC) built-in en ALB sin config extra. **Lección:** LB modernos siguen evolucionando en features.

**Cloudflare Global Load Balancer + Steering (2023+):** health-checks Anycast + geo steering + weighted origin pools. Alternativa multi-cloud a Route 53. **Lección:** hay ecosistema fuera de AWS igualmente maduro.

**GCP Cloud Load Balancing Anycast single IP (2020+):** un IP global anunciado desde múltiples regions vía Anycast. Simplifica DNS (no necesitás latency records). **Lección:** GCP tiene arquitecturas diferentes que aportan a la industria.

**Kubernetes Gateway API GA (2023, v1.2 en 2024):** sucesor de Ingress con roles separados (infra vs app). AWS Load Balancer Controller v2.7+ soporta Gateway API. **Lección:** paradigma K8s converge hacia Gateway API para exposición.

**Post-Log4Shell WAF adoption (2022+):** casi todo ALB productivo pública ahora tiene WAF asociado. **Lección:** WAF no es opcional.

**Cloudflare Workers + DNS (2024+):** DNS records con Workers script que retorna respuesta dinámica basada en geo, headers, A/B testing. **Lección:** DNS se está volviendo programable en el edge.

**Route 53 Application Recovery Controller (ARC, 2021+):** feature enterprise para failover multi-región con readiness checks. Usado por fintech + healthcare. **Lección:** el mercado empuja hacia MTTR sub-minutos.

---

## 8. Ejercicios prácticos

### Ejercicio 1: setup DNS completo con Terraform

**Objetivo:** desplegar todos los records de una zona: A/AAAA, ALIAS al ALB, CNAME www, MX Google Workspace, SPF/DKIM/DMARC, CAA.

**Setup:** dominio en Route 53 + AWS account.

**Pasos:**
1. Crear módulo Terraform con los records de la sección 2.1.
2. Aplicar y verificar con `dig` cada record type.
3. Enviar un email de test y validar SPF/DKIM/DMARC con `mail-tester.com`.
4. Intentar crear un CNAME en el apex → debe fallar (o usar ALIAS).
5. Verificar CAA con `dig linguadev.app CAA`.

**Criterios de éxito:**
- [ ] Todos los records resuelven correctamente.
- [ ] `mail-tester.com` retorna 10/10.
- [ ] CAA es respetado por Let's Encrypt al emitir cert.
- [ ] ALIAS al ALB devuelve A record del ALB actual.

**Bonus:** habilitar DNSSEC + publicar DS record en registrar.

---

### Ejercicio 2: migración de A record con TTL strategy

**Objetivo:** migrar `api.linguadev.app` de un ALB viejo a uno nuevo sin downtime.

**Setup:** 2 ALBs corriendo, TTL actual 86400.

**Pasos:**
1. T-48h: bajar TTL a 60s. `terraform apply` con `ttl = 60`.
2. Verificar propagación: `dig +noall +answer api.linguadev.app` desde múltiples resolvers.
3. Confirmar que los TTLs devueltos son 60.
4. T-0: cambiar el ALIAS target al ALB nuevo.
5. Monitorear traffic hitting ambos ALBs (CloudWatch RequestCount).
6. T+2h: confirmar que el ALB viejo tiene traffic residual <1%.
7. T+24h: cerrar el ALB viejo.
8. T+48h: subir TTL de vuelta a 3600.

**Criterios de éxito:**
- [ ] Cutover sin errores 5xx en clientes.
- [ ] Traffic residual al ALB viejo <5% después de 6h.
- [ ] Zero user complaints post-migración.
- [ ] Documentar timeline y observaciones.

**Bonus:** implementar como weighted (100/0 → 50/50 → 0/100) para rollback fácil.

---

### Ejercicio 3: multi-región con Route 53 latency-based + failover

**Objetivo:** desplegar app en 2 regiones (us-east-1, eu-west-1) con Route 53 latency-based y health checks.

**Setup:** AWS 2 regiones + Terraform.

**Pasos:**
1. Módulo Terraform `region-stack` (ALB + Target Group + healthcheck path).
2. Deploy en ambas regiones.
3. Route 53 records latency-based con health checks per region.
4. Test: `curl -H "X-Debug-Region: 1" api.linguadev.app` desde EU y US → distintas regiones.
5. Simular fallo: `kubectl scale deployment/api --replicas=0` en EU.
6. Esperar 60s.
7. Verificar que traffic EU ahora va a US.
8. Restaurar EU.

**Criterios de éxito:**
- [ ] Traffic normal rutea por latencia (EU → EU, US → US).
- [ ] Health check falla en <60s cuando el target cae.
- [ ] Failover automático a la región healthy.
- [ ] Recovery automático cuando el target vuelve.
- [ ] Documentar RTO observado.

**Bonus:** agregar 3ª región (ap-southeast-1) + geolocation policy override para compliance data residency.

---

### Ejercicio 4: ALB con listener rules avanzadas

**Objetivo:** implementar ALB con rules: /api/* → API TG, /admin/* → Cognito auth + Admin TG, / → static site, HTTP → HTTPS redirect.

**Setup:** ALB + 2 target groups + Cognito user pool.

**Pasos:**
1. Terraform del ALB + listeners de la sección 4.1.
2. Deployar 2 services K8s con AWS LB Controller.
3. Test: `curl https://api.linguadev.app/api/hello` → API.
4. Test: `curl https://api.linguadev.app/admin/dashboard` → Cognito login redirect.
5. Test: `curl http://api.linguadev.app` → 301 to HTTPS.
6. Verificar en CloudWatch RequestCount que cada TG recibe traffic correcto.

**Criterios de éxito:**
- [ ] 4 rules funcionando correctamente.
- [ ] Cognito auth intercepta admin correctamente.
- [ ] HTTP redirect a HTTPS con 301.
- [ ] Access logs a S3 verificables.
- [ ] WAF ACL asociada (rate limiting básico).

**Bonus:** implementar canary con weighted target groups (90/10 → 100/0).

---

### Ejercicio 5: NLB para gRPC service

**Objetivo:** desplegar servicio gRPC detrás de NLB con preserve source IP.

**Setup:** EKS cluster + servicio gRPC (ejemplo: bookinfo o custom).

**Pasos:**
1. Terraform NLB de la sección 4.2 con EIP estático por AZ.
2. Deploy gRPC service en EKS con Service `type: LoadBalancer` + annotations NLB.
3. Test client gRPC desde external network.
4. Verificar en logs del backend que source IP es el real del client (no del NLB).
5. Simular target failure: verificar failover a target healthy.

**Criterios de éxito:**
- [ ] gRPC funciona end-to-end.
- [ ] Source IP preservada en logs del backend.
- [ ] EIP estático accesible.
- [ ] Health check TCP funcionando.
- [ ] Latencia p99 <10ms.

**Bonus:** habilitar TLS passthrough con cert terminado en el backend.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [docs.aws.amazon.com/Route53](https://docs.aws.amazon.com/Route53/) — routing policies, health checks, DNSSEC.
- [docs.aws.amazon.com/elasticloadbalancing](https://docs.aws.amazon.com/elasticloadbalancing/) — ALB, NLB, GLB.
- [kubernetes-sigs/aws-load-balancer-controller](https://github.com/kubernetes-sigs/aws-load-balancer-controller) — controller K8s.
- [cloudflare.com/learning/dns](https://www.cloudflare.com/learning/dns/) — DNS learning center.
- [gateway-api.sigs.k8s.io](https://gateway-api.sigs.k8s.io) — Gateway API v1.2 spec.

**RFCs esenciales:**
- RFC 1034/1035 — DNS foundational.
- RFC 4033/4034/4035 — DNSSEC.
- RFC 6844 — CAA.
- RFC 7858 — DoT.
- RFC 8484 — DoH.
- RFC 9110 — HTTP semantics (revisión 2022).

**Herramientas:**
- **dig, dnsutils** — debug DNS.
- **dnsperf** — load testing DNS.
- **mtr** — path analysis (traceroute + ping).
- **DNSViz** — visualiza cadena DNSSEC.
- **SSL Labs** — audit TLS de ALB público.
- **mail-tester.com** — audit SPF/DKIM/DMARC.
- **Cloudflare Radar** — visibilidad global DNS + BGP.

**Providers alternativos AWS:**
- Cloudflare DNS + Load Balancing.
- Google Cloud DNS + Cloud Load Balancing.
- Azure DNS + Front Door + Traffic Manager.
- NS1 (managed DNS enterprise).
- Fastly (CDN + DNS).

**Referencias adicionales:**
- Cricket Liu, Paul Albitz, *"DNS and BIND"* (O'Reilly, 5ª ed) — biblia del DNS.
- Julia Evans, *"How DNS Works"* (zine ilustrado 2023).
- AWS re:Invent 2024 talks sobre Route 53 y ELB.
- Google SRE Book, capítulo "Load Balancing at the Frontend".

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Auditá tus records DNS actuales: ¿TTLs razonables? ¿CAA? ¿SPF/DKIM/DMARC? ¿DNSSEC?
- Auditá tus ALBs: ¿WAF? ¿TLS 1.3? ¿access logs? ¿health checks tight?
- Diseñá tu estrategia multi-región (aunque solo tengas 1 hoy).
- Continuá con [cap 28 — CDN y edge computing](./28-cdn-y-edge-computing.md), donde vas a poner CloudFront/Cloudflare encima de todo esto.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas junior → mid → senior → staff. Cubren: DNS record types (A, AAAA, CNAME, MX, TXT, SRV, CAA, ALIAS), TTL trade-offs y migration strategy, recursive vs authoritative resolvers, DNSSEC + DoH/DoT, Route 53 routing policies (simple, weighted, latency, geolocation, geoproximity, failover, multi-value), health checks (endpoint, calculated, CloudWatch alarm), split-horizon DNS, load balancers L4 vs L7, ALB vs NLB vs GLB vs CLB legacy, sticky sessions y sus trade-offs, connection draining, algoritmos (round-robin, LOR, weighted), AWS Load Balancer Controller para K8s, Gateway API, global load balancing multi-cloud (Cloudflare, GCP Anycast, Azure Front Door), TLS policies modernas, WAF integration, anti-patterns (CNAME en apex, TTL alto en migraciones, bloquear health check IPs).

- **Fuente:** [`packages/content/src/tech/devops/sim-27-dns-and-load-balancing.json`](../../packages/content/src/tech/devops/sim-27-dns-and-load-balancing.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-27-dns-and-load-balancing`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 26 — Compliance y auditoría](./26-compliance-y-audit.md) · [Índice](./README.md) · [Capítulo 28 — CDN y Edge Computing →](./28-cdn-y-edge-computing.md)
