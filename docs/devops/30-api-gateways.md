# Capítulo 30 — API Gateways

> **Focus:** API Gateways como single entry point para microservicios. Patterns (BFF, aggregator, offloading). Kong 3.8+, AWS API Gateway (REST vs HTTP APIs vs WebSocket), Envoy Gateway 1.2 GA sobre Gateway API, Istio Gateway, Traefik, NGINX Ingress. Kubernetes Gateway API vs Ingress (Gateway API GA desde 2023). Rate limiting (token bucket, sliding window), authentication (OAuth2, JWT, API keys, mTLS), transformación de requests, versioning, WAF, y decisiones API Gateway vs Service Mesh.
> **Áreas:** Networking · Security · Cloud
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- HTTP/1.1 y HTTP/2, TLS, DNS.
- Kubernetes Ingress ([cap 09](./09-kubernetes-networking-y-storage.md)) y Service Mesh ([cap 29](./29-service-mesh-istio-linkerd.md)).
- OAuth 2.0 / OpenID Connect básico y JWT structure (header.payload.signature).
- Nociones de reverse proxy (Nginx) y load balancer L4/L7.

**Glosario mínimo:**
- **API Gateway:** componente que actúa como single entry point para requests externas hacia microservicios internos.
- **BFF (Backend For Frontend):** gateway especializado por tipo de cliente (mobile, web, TV).
- **Ingress / Gateway API:** recursos K8s para exponer servicios; Gateway API es el sucesor moderno (GA 2023, v1.2 nov 2024).
- **Kong:** gateway open-source sobre Nginx + OpenResty (Lua), 200+ plugins, versión 3.8+ con AI Gateway.
- **Envoy Gateway 1.2+:** implementación reference de Kubernetes Gateway API por CNCF, GA 2024.
- **AWS API Gateway:** REST API (v1, 2015, feature-rich) vs HTTP API (v2, 2019, 3.5× más barato) vs WebSocket API.
- **Rate limiting:** token bucket, sliding window, leaky bucket, fixed window.
- **JWT vs API key vs mTLS:** distintos mecanismos de auth con distintos casos.
- **JWKS:** JSON Web Key Set endpoint (`/.well-known/jwks.json`) para validar firmas JWT.

**Setup mínimo:**

```bash
# 1) Cluster kind + Gateway API v1.2
kind create cluster --name gw-lab
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml

# 2) Envoy Gateway 1.2+
helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.2.4 \
  -n envoy-gateway-system --create-namespace
kubectl wait --timeout=5m -n envoy-gateway-system deploy/envoy-gateway --for=condition=Available

# 3) Kong 3.8+ (modo DB-less/K8s)
helm repo add kong https://charts.konghq.com
helm install kong kong/kong --version 2.44.0 -n kong --create-namespace \
  --set ingressController.installCRDs=false

# 4) AWS CLI + terraform para AWS API Gateway HTTP API
aws --version
terraform version

# 5) Traefik como alternativa
helm install traefik traefik/traefik --version 33.0.0 -n traefik --create-namespace
```

---

## 1. El gran cuadro

Un **API Gateway** es el componente que actúa como *single entry point* entre clientes externos (mobile, web, partners B2B, dispositivos IoT) y una constelación de microservicios internos. Su propuesta de valor central es **centralizar cross-cutting concerns** que sin gateway se repiten mal en cada servicio: routing (URL → servicio), authentication/authorization, rate limiting/quotas, TLS termination, transformación de requests/responses, observability, protocol translation (HTTP↔gRPC, REST↔GraphQL) y versioning. Sin gateway, cada cliente móvil debe conocer las URLs de 40 microservicios, cada servicio implementa auth de forma distinta y cambiar la topología interna rompe todos los clientes. Con gateway, un solo endpoint por producto, políticas uniformes y evolución libre por dentro.

El eje **API Gateway vs Service Mesh** confunde a menudo. La distinción es **norte-sur vs este-oeste**: API Gateway maneja tráfico *externo → interno* (browser, mobile, partner ↔ tus servicios), mientras Service Mesh (Istio, Linkerd) maneja tráfico *servicio ↔ servicio* dentro del cluster. Son **complementarios**, no competitivos. Una arquitectura madura tiene ambos: gateway al edge (auth, rate limit externo, WAF) y mesh entre servicios (mTLS, retries, canary interno). Kong y Envoy Gateway pueden hacer las dos cosas si la escala lo justifica, pero en producción grande la especialización es clara: gateway con lógica de negocio de APIs (developer portal, plans, quotas), mesh con lógica de infraestructura (mTLS, circuit breaker).

El landscape 2026 está dominado por **Kubernetes Gateway API v1.2+** (GA desde octubre 2023, v1.2 en noviembre 2024). Es el sucesor de Ingress con roles separados: `GatewayClass` (implementación provista por infra), `Gateway` (instancia concreta con listeners y TLS) y `HTTPRoute/GRPCRoute/TCPRoute` (routing declarado por developers). Implementaciones production-ready: **Envoy Gateway 1.2 GA** (CNCF, reference implementation), **Istio Gateway** (Istio 1.24+), **Cilium Gateway** (1.16+/1.19+), **Kong Gateway Operator** (Kong 3.8+), **Traefik**, **NGINX Gateway Fabric**. Fuera de K8s, los pesos pesados siguen siendo **Kong** (Nginx + OpenResty + plugins), **AWS API Gateway** (REST v1 legacy o HTTP v2 moderno + WebSocket), **Apigee** (Google, enterprise), **Azure API Management** y **Tyk** (Go).

El impacto práctico en LinguaDev Pro es directo. Un gateway al frente permite: (1) exponer una sola URL (`https://api.linguadev.app`) que rutea internamente a BFF mobile, BFF web, admin API y webhooks; (2) validar JWTs emitidos por Auth0/Cognito antes de que lleguen al backend, ahorrando llamadas inútiles; (3) aplicar rate limiting por API key para el plan gratuito (100 req/min) vs premium (10k req/min); (4) hacer canary con `weight` en `HTTPRoute` sin tocar código; (5) centralizar logs de acceso y traces con `x-request-id` propagado. Este capítulo cubre patrones, implementaciones, ejemplos YAML/HCL reales y ejercicios verificables.

---

## 2. Patterns y arquitecturas (nivel básico)

### 2.1 Los cuatro patrones canónicos

- **Single Gateway:** un solo punto de entrada para toda la API. Simple pero puede convertirse en God Object.
- **BFF (Backend For Frontend):** un gateway especializado por tipo de cliente. Netflix lo popularizó: BFF mobile agrega respuestas diferentes que BFF TV o BFF web. Reduce chatter y overfetching.
- **Aggregator:** el gateway hace fan-out a varios servicios internos y compone la respuesta (útil cuando el cliente necesita datos de 4 servicios en una sola llamada).
- **Offloading:** el gateway se encarga de tareas comunes (auth, rate limit, TLS termination, caching) para descargar a los backends.

**Cuidado:** meter lógica de negocio en el gateway lo convierte en God Object. Regla: transformaciones **stateless, side-effect-free, testeables en aislamiento** son válidas. Cálculos de precios, orquestación multi-servicio con estado, reglas de dominio → **no** en el gateway.

### 2.2 Kong Gateway 3.8+ arquitectura

Kong es Nginx + OpenResty (LuaJIT) + plugin system + Admin API + storage (PostgreSQL o DB-less YAML). Data plane ejecuta plugins Lua en fases del request cycle: `certificate`, `rewrite`, `access` (auth, rate limit), `header_filter`, `body_filter`, `log`. Kong 3.8 (septiembre 2024) añade **Incremental Configuration Sync** que reduce memoria/CPU transmitiendo solo cambios, y el **AI Gateway 3.8** con Semantic Prompt Guard, Semantic Caching y Semantic Routing para GenAI. Modos operativos:

- **DB-mode:** PostgreSQL como source of truth, config dinámica vía Admin API REST.
- **DB-less:** config declarativa en `kong.yaml`, ideal para GitOps y Kubernetes.
- **Hybrid:** control plane centralizado + data planes distribuidos (geo-distributed).

```yaml
# kong.yaml declarativo (DB-less)
_format_version: "3.0"
services:
  - name: api-linguadev
    url: http://api.linguadev.svc.cluster.local:80
    routes:
      - name: v1-lessons
        paths: [/v1/lessons]
        methods: [GET, POST]
    plugins:
      - name: rate-limiting-advanced
        config:
          limit: [100]
          window_size: [60]
          sync_rate: 1
          strategy: redis
          redis: { host: redis.kong.svc, port: 6379 }
      - name: jwt
        config:
          key_claim_name: iss
          claims_to_verify: [exp, nbf]
      - name: prometheus
        config: { per_consumer: true }
consumers:
  - username: mobile-app
    jwt_secrets:
      - key: https://linguadev.auth0.com/
        algorithm: RS256
        rsa_public_key: |
          -----BEGIN PUBLIC KEY-----
          ...
          -----END PUBLIC KEY-----
```

### 2.3 AWS API Gateway: REST vs HTTP vs WebSocket

Tres productos distintos bajo el mismo nombre:

| Feature | REST API (v1) | HTTP API (v2) | WebSocket API |
|---|---|---|---|
| Año | 2015 | 2019 | 2018 |
| Precio (req/millón) | $3.50 | $1.00 | $1.00 + $0.25/M msg |
| Latencia añadida | 15-30 ms | 5-10 ms | Bidireccional persistente |
| Auth | IAM, Cognito, Lambda authorizer, API keys | JWT/OIDC, IAM, Lambda | IAM, Lambda |
| VTL transformation | Sí (Velocity) | Limited | No |
| WAF nativo | Sí | Vía CloudFront | No |
| Private API | Sí (VPC endpoints) | No | No |
| Caching | Sí | No | No |
| Usage plans + API keys | Sí | No | No |
| Edge-optimized | Sí | No | No |

**Regla:** HTTP API por default (3.5× más barato, 60% menor latencia). REST API solo si necesitás VTL, WAF nativo, private API con VPC endpoints, caching en gateway, o usage plans managed.

```hcl
# Terraform: HTTP API con JWT authorizer contra Cognito
resource "aws_apigatewayv2_api" "http" {
  name          = "linguadev-http"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["https://linguadev.app"]
    allow_methods = ["GET", "POST", "PUT", "DELETE"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito"
  jwt_configuration {
    audience = ["mobile-app-client-id"]
    issuer   = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.this.id}"
  }
}

resource "aws_apigatewayv2_integration" "lessons" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "HTTP_PROXY"
  integration_uri        = "https://internal-alb.linguadev.internal/v1/lessons/{proxy}"
  integration_method     = "ANY"
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "lessons" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "ANY /v1/lessons/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.lessons.id}"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
  authorization_type = "JWT"
}
```

---

## 3. Kubernetes Gateway API y Envoy Gateway (nivel medio)

### 3.1 Ingress vs Gateway API

Ingress es K8s core (v1 desde 2019) pero limitado: un solo tipo mezcla infra y app, extensiones vía annotations vendor-specific (portable? no), solo HTTP/HTTPS oficialmente. **Gateway API v1.2** (nov 2024) resuelve todo eso con roles separados y CRDs standard:

- **Infrastructure provider** define `GatewayClass` (implementación: Envoy Gateway, Istio, Cilium, Kong).
- **Cluster operator** crea `Gateway` (listeners, TLS, IPs).
- **Application developer** crea `HTTPRoute` / `TCPRoute` / `GRPCRoute`.

Weighted routing, header matching, canary, multi-tenant con `allowedRoutes` son first-class citizens sin annotations. En 2026 Gateway API v1.4 sigue evolucionando; **Envoy Gateway 1.2 GA** es la reference implementation CNCF vendor-neutral.

### 3.2 Envoy Gateway 1.2+ sobre Kubernetes Gateway API

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: linguadev-gw
  namespace: gateway-system
spec:
  gatewayClassName: eg
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: linguadev-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: prod
  labels: { gateway-access: "true" }
spec:
  parentRefs:
    - name: linguadev-gw
      namespace: gateway-system
  hostnames: [api.linguadev.app]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /v1 }
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-Request-ID
                value: "{{.RequestID}}"
            remove: [X-Internal-Debug]
      backendRefs:
        - name: api-v1
          port: 80
          weight: 90
        - name: api-v2
          port: 80
          weight: 10
    - matches:
        - path: { type: PathPrefix, value: /admin }
        - headers:
            - name: X-Admin-Key
              value: "true"
      backendRefs:
        - name: admin-api
          port: 80
```

Envoy Gateway añade CRDs propios (`BackendTrafficPolicy`, `SecurityPolicy`, `ClientTrafficPolicy`) para features Envoy avanzados que Gateway API core no cubre.

### 3.3 NGINX Ingress vs Traefik

- **NGINX Ingress:** el más maduro y usado. Config vía annotations (`nginx.ingress.kubernetes.io/rewrite-target`, etc.). Performance excelente. Curva empinada para features avanzados.
- **Traefik:** middleware-based, integración con Let's Encrypt built-in, ideal para dev/staging y clusters pequeños. Dashboard incluido.
- **Kong Ingress Controller:** Kong + K8s CRDs (`KongPlugin`, `KongConsumer`). Máxima flexibilidad si ya usás Kong fuera de K8s.

---

## 4. Rate limiting, autenticación y transformación (nivel avanzado)

### 4.1 Algoritmos de rate limiting

Cuatro clásicos con trade-offs distintos:

- **Fixed Window** (100 req/min por reloj): simple, implementable con Redis `INCR + EXPIRE`. Problema: burst en el borde (200 req en 2 s cruzando el minuto).
- **Sliding Window Counter**: híbrido — cuenta ventana actual + weighted % de ventana previa. Precisión buena, memoria O(1).
- **Token Bucket** (capacidad C, refill R tokens/s): permite bursts hasta C, rate promedio R. Estándar en AWS API Gateway, Stripe, Envoy.
- **Leaky Bucket**: procesa a rate constante, descarta exceso. Traffic shaping hacia backends frágiles, no user-facing.

**En producción:** token bucket por default. Sliding window counter para límites estrictos. Fixed window solo prototipos.

Dimensiones típicas:
- Por **IP** (defensa DDoS).
- Por **API key / consumer** (plans/quotas).
- Por **user** (fair use).
- Por **endpoint** (proteger endpoints caros como `/search` o `/export`).

Storage: in-memory con consistent hashing, o Redis compartido con Lua scripts atómicos (para evitar race conditions bajo alta concurrencia).

```yaml
# Kong plugin rate-limiting-advanced con Redis (token bucket implícito)
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: api-rate-limit
  namespace: linguadev
plugin: rate-limiting-advanced
config:
  limit: [100, 1000]           # 100/min y 1000/hora
  window_size: [60, 3600]
  identifier: consumer          # o header, ip, credential
  sync_rate: 1                  # sincroniza con Redis cada 1s
  strategy: redis
  redis:
    host: redis-master.kong.svc
    port: 6379
    ssl: true
  hide_client_headers: false    # devuelve X-RateLimit-Remaining
```

### 4.2 Autenticación: OAuth 2.0, JWT, API keys, mTLS

Matriz de decisión:

| Caso | Mecanismo |
|---|---|
| Servicio ↔ Servicio interno | mTLS (service mesh identity) |
| Partner B2B server-to-server | API keys u OAuth2 Client Credentials |
| App mobile / web con user | OAuth 2.0 Auth Code + PKCE → JWT + refresh |
| Webhook desde tercero | HMAC signature (Stripe, GitHub style) |

**JWT validation** en el gateway (RS256, típico):

1. Descargar **JWKS** del IdP (`/.well-known/jwks.json`), cachear con TTL 1h + refresh en background.
2. Verificar `signature` sobre `header.payload` con la public key indicada por `kid`. Rechazar `alg: none` (CVE-2015-9235).
3. Verificar `exp > now`, `nbf < now`, `iat` razonable (30 s de leeway).
4. Verificar `iss` == tu IdP y `aud` == tu API identifier.
5. Verificar `scope` incluye lo necesario para la operación.

```yaml
# Envoy Gateway SecurityPolicy con JWT authn
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: jwt-auth
  namespace: prod
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: api-route
  jwt:
    providers:
      - name: auth0
        issuer: https://linguadev.auth0.com/
        audiences: [https://api.linguadev.app]
        remoteJWKS:
          uri: https://linguadev.auth0.com/.well-known/jwks.json
          backendRefs:
            - name: auth0-backend
              port: 443
          backendSettings:
            retry:
              numRetries: 3
              perRetry: { timeout: 1s }
        claimToHeaders:
          - claim: sub
            header: X-User-Id
          - claim: email
            header: X-User-Email
```

**API keys**: hash en DB (nunca plaintext), asociar con consumer + plan + quota. Rotación manual con overlap.

### 4.3 Transformación de requests/responses

Casos legítimos: protocol translation (SOAP↔REST, REST↔GraphQL, HTTP↔gRPC), format translation (XML↔JSON), header manipulation (add `X-Request-ID`, remove `X-Internal-Secret`), versioning (v1 client → v2 backend con field renames), response filtering (remover PII para clientes menos privilegiados).

Casos **malos**: lógica de negocio (cálculos, reglas), orchestración stateful multi-servicio (mejor un BFF real), transformaciones que dependen de estado externo.

```yaml
# Kong request-transformer + response-transformer
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: add-trace-id
plugin: request-transformer
config:
  add:
    headers:
      - X-Request-ID:$(uuid)
      - X-Gateway-Version:kong-3.8
---
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: strip-internal
plugin: response-transformer
config:
  remove:
    headers: [X-Internal-Debug, X-DB-Query-Time]
    json: [debug_info, internal_id]
  rename:
    json: [user_id:userId, created_at:createdAt]
```

### 4.4 API Gateway vs Service Mesh: cuándo cada uno

| Aspecto | API Gateway | Service Mesh |
|---|---|---|
| Tráfico | Norte-sur (externo → interno) | Este-oeste (interno) |
| Auth | OAuth 2.0, JWT, API keys, mTLS opcional | mTLS por default con SPIFFE |
| Rate limit | Por consumer/plan externo | No (o por servicio) |
| Versioning | Sí (API versions, deprecation) | No |
| WAF | Frecuente | Raro |
| Developer portal | Sí | No |
| Transformación | Sí (VTL, Lua, WASM) | Sí pero uncomún |
| Instalación | En el edge | Sidecar/ambient por servicio |

**Arquitectura madura**: gateway al edge + mesh entre servicios. Un mismo Envoy puede servir ambos (Envoy Gateway + Istio) pero se **configuran** de forma distinta.

---

## 5. Ejemplo práctico: LinguaDev Pro con Envoy Gateway + Kong para APIs de partners

Escenario: exponer `api.linguadev.app` a móvil/web con JWT (Auth0), y `partners.linguadev.app` a partners B2B con API keys + rate limiting por plan. Además, canary 10% a `api-v2`.

### Paso 1: cluster + Gateway API + Envoy Gateway

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml
helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.2.4 \
  -n envoy-gateway-system --create-namespace
kubectl create namespace linguadev
kubectl label namespace linguadev gateway-access=true
```

### Paso 2: TLS con cert-manager

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: linguadev-tls
  namespace: envoy-gateway-system
spec:
  secretName: linguadev-tls
  issuerRef: { name: letsencrypt-prod, kind: ClusterIssuer }
  dnsNames: [api.linguadev.app, partners.linguadev.app]
```

### Paso 3: Gateway con dos listeners

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: linguadev-gw
  namespace: envoy-gateway-system
spec:
  gatewayClassName: eg
  listeners:
    - name: api-https
      port: 443
      protocol: HTTPS
      hostname: api.linguadev.app
      tls:
        mode: Terminate
        certificateRefs: [{ name: linguadev-tls }]
      allowedRoutes:
        namespaces: { from: Selector, selector: { matchLabels: { gateway-access: "true" } } }
    - name: partners-https
      port: 443
      protocol: HTTPS
      hostname: partners.linguadev.app
      tls:
        mode: Terminate
        certificateRefs: [{ name: linguadev-tls }]
      allowedRoutes:
        namespaces: { from: Selector, selector: { matchLabels: { gateway-access: "true" } } }
```

### Paso 4: HTTPRoute API con canary + JWT

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: linguadev
spec:
  parentRefs: [{ name: linguadev-gw, namespace: envoy-gateway-system, sectionName: api-https }]
  hostnames: [api.linguadev.app]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /v1 } }]
      backendRefs:
        - name: api-v1
          port: 80
          weight: 90
        - name: api-v2
          port: 80
          weight: 10
      timeouts:
        request: 5s
        backendRequest: 3s
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: api-jwt
  namespace: linguadev
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: api-route
  jwt:
    providers:
      - name: auth0
        issuer: https://linguadev.auth0.com/
        audiences: [https://api.linguadev.app]
        remoteJWKS: { uri: https://linguadev.auth0.com/.well-known/jwks.json }
        claimToHeaders:
          - { claim: sub, header: X-User-Id }
```

### Paso 5: HTTPRoute partners con rate limiting por API key

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: partners-rate-limit
  namespace: linguadev
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: partners-route
  rateLimit:
    type: Global
    global:
      rules:
        - clientSelectors:
            - headers:
                - name: X-Plan
                  value: free
          limit: { requests: 100, unit: Minute }
        - clientSelectors:
            - headers:
                - name: X-Plan
                  value: premium
          limit: { requests: 10000, unit: Minute }
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: partners-route
  namespace: linguadev
spec:
  parentRefs: [{ name: linguadev-gw, namespace: envoy-gateway-system, sectionName: partners-https }]
  hostnames: [partners.linguadev.app]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /v1 } }]
      backendRefs: [{ name: partners-api, port: 80 }]
```

### Paso 6: verificación

```bash
kubectl -n linguadev get httproute -o wide
kubectl -n envoy-gateway-system get gateway linguadev-gw -o yaml | grep -A5 status

# Test canary distribution
for i in {1..200}; do
  curl -s -H "Authorization: Bearer $JWT" https://api.linguadev.app/v1/health |\
    jq -r .version
done | sort | uniq -c
# Ejemplo: 180 v1, 20 v2 (10% ± noise)

# Test rate limit free plan
for i in {1..150}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "X-Api-Key: free-partner" \
    -H "X-Plan: free" \
    https://partners.linguadev.app/v1/lessons
done | grep 429 | wc -l
# > 50 (excede 100/min)
```

---

## 6. Cheatsheet, reglas mentales, anti-patrones

### Reglas de oro

- ✅ Gateway al edge, mesh entre servicios: complementarios, no competitivos.
- ✅ En 2026 usá **Kubernetes Gateway API v1.2+** para greenfield; Ingress solo para maintenance.
- ✅ Elegí **HTTP API** en AWS por default (3.5× más barato); REST API solo si necesitás VTL, WAF, private API, caching.
- ✅ JWT local validation (con JWKS cacheado 1h) para performance; introspection solo para revocación instantánea (banking).
- ✅ **Token bucket** como algoritmo default de rate limiting.
- ✅ Rate limit por consumer + plan (no solo por IP).
- ✅ API keys para M2M, JWT para user-facing, mTLS para intra-cluster.
- ✅ Hash de API keys en DB, jamás plaintext.
- ✅ Transformaciones stateless y testeables; nada de lógica de negocio.
- ✅ WAF (AWS WAF, Cloudflare) delante del gateway para OWASP Top 10.
- ✅ Observability: `x-request-id` propagado, access logs estructurados, métricas RED por endpoint.
- ✅ Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`.

### Anti-patrones

- ❌ Meter lógica de negocio en el gateway (God Object).
- ❌ API keys en mobile app (extraibles con reversing).
- ❌ Aceptar JWTs con `alg: none` o sin verificar `aud`/`iss`.
- ❌ Rate limiting solo por IP cuando hay NAT (bloqueás oficinas enteras).
- ❌ VTL templates complejos en AWS REST API (mantenimiento infernal).
- ❌ Un solo Gateway monolítico para toda la empresa sin BFF por cliente.
- ❌ Confundir Gateway con Service Mesh.
- ❌ Olvidar CORS en HTTP API cuando el frontend está en otro dominio.
- ❌ TTL de JWKS cache infinito (miss key rotation).

### Tabla decisión gateway

| Necesidad | Elección 2026 |
|---|---|
| Serverless AWS, apps simples | AWS API Gateway HTTP API |
| Enterprise con muchos plugins | Kong 3.8+ o Apigee |
| K8s-native, Gateway API standard | Envoy Gateway 1.2 GA |
| Ya usás Istio | Istio Gateway (soporta Gateway API) |
| Ya usás Cilium CNI | Cilium Gateway |
| Dev/staging simple con Let's Encrypt | Traefik |
| Máxima performance sin plugins | NGINX Ingress o pingora (Cloudflare) |
| AI/GenAI proxy con semantic caching | Kong AI Gateway 3.8+ |

---

## 7. Casos reales industria 2023-2026

**Netflix Zuul 1 → Zuul 2 (2018):** Zuul 1 (2013, Java + servlets bloqueantes) escaló a billones de req/día pero sufrió thread starvation. Rewrite en Netty non-blocking dio saltos de eficiencia. **Lección:** el modelo de concurrencia del gateway es crítico a escala.

**AWS API Gateway HTTP API (re:Invent 2019):** AWS lanzó v2 después de años de feedback de que REST API era caro y lento. Muchas empresas migraron ahorrando 60-70%. **Lección:** revisar decisiones legacy periódicamente.

**Kong Konnect SaaS (2020):** Kong lanza managed platform compitiendo con Apigee/Mulesoft. **Lección:** el mercado enterprise valora control plane managed.

**Cloudflare Pingora en Rust (2024):** reemplaza su fork custom de Nginx por Pingora, HTTP proxy en Rust. Manejan trillones de req/día. **Lección:** Rust está madurando para infraestructura crítica.

**Gateway API GA (oct 2023) y v1.2 (nov 2024):** todos los grandes (Istio, Envoy Gateway, Cilium, Kong, NGINX) convergen. En 2026 Gateway API v1.4 sigue evolucionando y "Envoy-native" es el patrón arquitectural dominante. **Lección:** apostar por standards abiertos evita vendor lock-in.

**Envoy Gateway 1.2 GA (2024):** implementación CNCF vendor-neutral con highest conformance. **Lección:** cuando existe reference implementation, usarla facilita portabilidad.

**Kong AI Gateway 3.8 (sep 2024):** Semantic Prompt Guard, Semantic Caching, Semantic Routing para GenAI. Los gateways añaden features nativas para LLM traffic. **Lección:** los gateways son la primera línea de defensa para tráfico LLM (rate limit por tokens, cache semántico, protección de prompts).

**Stripe rate limiting con token bucket (blog 2017):** Stripe publicó su implementación distribuida con Redis Lua scripts. **Lección:** rate limiting distribuido requiere atomicidad para evitar overflows.

**GitHub API con sliding window + `X-RateLimit-Remaining`:** headers estándar para comunicar límites al cliente. **Lección:** UX de rate limit importa; `Retry-After` es cortesía mínima.

**Netflix BFF (2013+):** popularizó el patrón. BFF mobile agrega respuestas distintas de BFF TV o BFF web. **Lección:** un solo gateway monolítico rara vez encaja con todos los clientes.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Instalar Envoy Gateway 1.2 y publicar un HTTPRoute

**Objetivo:** exponer `httpbin` via `Gateway` + `HTTPRoute` con TLS de cert-manager y validar respuesta.

**Pasos:**
1. Cluster kind con Gateway API v1.2.1 CRDs.
2. Helm install `envoyproxy/gateway-helm v1.2.4`.
3. Deploy `httpbin` en namespace `demo`.
4. Crear `Gateway` + `HTTPRoute` con `hostname: httpbin.local`.
5. Port-forward al Envoy proxy y curl con `--resolve`.

**Criterios de éxito:**
- [ ] `kubectl get gateway` → `PROGRAMMED=True`.
- [ ] `kubectl get httproute` → `ACCEPTED=True`.
- [ ] Curl responde 200 con headers de Envoy.
- [ ] Métricas expuestas en `/stats/prometheus`.

**Bonus:** añadí un segundo `backendRef` con `weight: 20`.

---

### Ejercicio 2: JWT authentication con SecurityPolicy y Auth0

**Objetivo:** validar JWTs Auth0 en el gateway y rechazar tokens inválidos.

**Pasos:**
1. Crear tenant Auth0 y app.
2. Definir `SecurityPolicy` con `remoteJWKS`.
3. Test con token válido → 200.
4. Test con token expirado → 401.
5. Test sin token → 401.
6. Test con `alg: none` forged → 401.

**Criterios de éxito:**
- [ ] JWKS cacheado (logs muestran una sola descarga por hora).
- [ ] `X-User-Id` header aparece en backend con `sub` del JWT.
- [ ] Auditar en logs los 4 escenarios.

**Bonus:** añadí `claim: scope` matcher para `/admin`.

---

### Ejercicio 3: Rate limiting por API key con Kong 3.8

**Objetivo:** aplicar 100 req/min para plan `free` y 10 000 req/min para plan `premium` usando Kong `rate-limiting-advanced` con Redis.

**Pasos:**
1. Instalar Kong en modo DB-less.
2. Definir dos `KongConsumer` con distintas `credentials`.
3. Aplicar `KongPlugin` `rate-limiting-advanced` con `identifier: consumer`.
4. Ejecutar 150 requests con cada key.
5. Verificar 429 en `free` después de 100.

**Criterios de éxito:**
- [ ] `X-RateLimit-Remaining` decrece con cada request.
- [ ] `429 Too Many Requests` con `Retry-After` header aparece.
- [ ] Redis muestra las claves de conteo (`kong:rl:...`).

**Bonus:** añadir `sync_rate: 0.1` y comparar accuracy vs `sync_rate: 5`.

---

### Ejercicio 4: AWS HTTP API con Terraform + JWT authorizer

**Objetivo:** desplegar HTTP API con JWT authorizer Cognito y verificar auth end-to-end.

**Pasos:**
1. Crear Cognito User Pool + app client con Terraform.
2. Crear HTTP API con `aws_apigatewayv2_authorizer` tipo JWT.
3. Crear ruta `ANY /v1/{proxy+}` con integración a Lambda.
4. Registrar usuario en Cognito, login, obtener JWT.
5. Curl con y sin JWT.

**Criterios de éxito:**
- [ ] Curl sin token → 401.
- [ ] Curl con token expirado → 401.
- [ ] Curl con token válido → 200 (Lambda responde).
- [ ] CloudWatch logs muestran el `sub` autenticado.

**Bonus:** añadir CORS configuration y probar preflight OPTIONS.

---

### Ejercicio 5 (bonus): Migrar de Ingress-Nginx a Gateway API con Envoy Gateway

**Objetivo:** convertir un `Ingress` productivo a `Gateway` + `HTTPRoute` sin downtime.

**Pasos:**
1. Anotar el `Ingress` actual (host, paths, TLS, annotations relevantes).
2. Instalar Envoy Gateway en paralelo al Ingress controller.
3. Crear `Gateway` + `HTTPRoute` equivalentes.
4. Publicar en un DNS staging.
5. Cutover DNS.
6. Borrar Ingress viejo.

**Criterios de éxito:**
- [ ] Ambos entrypoints funcionan en paralelo antes del cutover.
- [ ] Cutover sin errores 5xx.
- [ ] Métricas del Gateway se comparan con las del Ingress.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [gateway-api.sigs.k8s.io](https://gateway-api.sigs.k8s.io) — Kubernetes Gateway API v1.2+.
- [gateway.envoyproxy.io](https://gateway.envoyproxy.io) — Envoy Gateway 1.2 GA.
- [konghq.com/docs](https://developer.konghq.com/) — Kong Gateway 3.8+ y AI Gateway.
- [docs.aws.amazon.com/apigateway](https://docs.aws.amazon.com/apigateway/) — REST vs HTTP vs WebSocket.
- [traefik.io/traefik](https://doc.traefik.io/traefik/) — Traefik v3.

**Herramientas:**
- **cert-manager** — TLS automático con Let's Encrypt.
- **k6, wrk, fortio** — load testing con métricas p50/p99.
- **Kong Insomnia** — testing y colecciones.
- **Postman** — colecciones colaborativas.
- **OAuth Playground** — testing de flows OAuth.

**Referencias:**
- Chris Richardson, *Microservices Patterns* (Manning).
- Netflix Tech Blog — *Zuul 2 rewrite*.
- Stripe Engineering — *Scaling your API with rate limiters* (2017).
- OWASP API Security Top 10 (2023).
- RFC 6749 (OAuth 2.0), RFC 7662 (Token Introspection), RFC 8555 (ACME), RFC 7519 (JWT).

**Siguientes pasos:**
- Completá los 5 ejercicios en tu cluster.
- Elegí un gateway para LinguaDev Pro y publicá la primera ruta.
- Continuá con [Capítulo 31 — mTLS, Zero Trust y seguridad de red](./31-network-security-mtls-zero-trust.md).

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades junior → staff. Cubren: qué es un API Gateway, Kong arquitectura, AWS REST vs HTTP API, Nginx puro como gateway, algoritmos de rate limiting, OAuth 2.0 en gateway, API keys vs JWT, JWT signature validation, transformación de requests, gateway vs mesh, BFF pattern, Envoy Gateway, Gateway API vs Ingress, GraphQL federation, WAF.

- **Fuente:** [`packages/content/src/tech/devops/sim-30-api-gateways.json`](../../packages/content/src/tech/devops/sim-30-api-gateways.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-30-api-gateways`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 29 — Service Mesh](./29-service-mesh-istio-linkerd.md) · [Índice](./README.md) · [Capítulo 31 — mTLS, Zero Trust y seguridad de red →](./31-network-security-mtls-zero-trust.md)
