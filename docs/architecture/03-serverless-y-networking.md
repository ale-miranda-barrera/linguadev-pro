# Capítulo 03 — Serverless y networking

> **Focus:** Lambda cold starts (causa y mitigación), provisioned concurrency vs on-demand, VPC + ENI, API Gateway vs Function URL vs ALB, CloudFront + OAC, DNS + Route 53 + TTL, HTTP/2 vs HTTP/3/QUIC, TLS 1.3, WebSockets, edge computing (CloudFront Functions, Lambda@Edge, Cloudflare Workers), latencia geográfica.
> **Áreas:** serverless · networking · edge · performance
> **Preguntas:** 20 · **Tiempo:** 60 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- [Cap 01 — Elección de base de datos](./01-eleccion-de-db.md): connection pooling, RDS Proxy.
- [Cap 02 — Mensajería y microservicios](./02-mensajeria-y-microservicios.md): SQS, EventBridge, idempotencia.
- Fundamentos de red: TCP, DNS, HTTP, TLS handshake.
- Familiaridad con AWS CLI y una plantilla SAM o Terraform.
- Cuenta AWS con permisos para Lambda, API Gateway, CloudFront, Route 53 (o LocalStack).

**Glosario mínimo:**
- **Cold start**: latencia adicional en la primera invocación cuando Lambda tiene que crear un nuevo entorno de ejecución.
- **Warm start**: invocación en un entorno de ejecución ya inicializado (mucho más rápido).
- **Execution environment**: sandbox de Firecracker donde corre tu Lambda; se reutiliza mientras hay tráfico.
- **Provisioned Concurrency**: N entornos pre-warmed permanentemente disponibles (con coste).
- **SnapStart**: snapshot del entorno inicializado que restaura en 100-200 ms (Java 2022, Python/Node 2024).
- **ENI (Elastic Network Interface)**: interfaz de red virtual que se adjunta a un recurso en VPC.
- **Hyperplane ENI**: ENI compartido para Lambda-in-VPC (2019) que eliminó el cold start extra de 8-10s.
- **OAC (Origin Access Control)**: mecanismo moderno (2022) para restringir acceso a S3 desde CloudFront (reemplaza OAI).
- **TTL** (Time To Live): cuánto un resolver DNS cachea una respuesta antes de repreguntarse.
- **RTT** (Round Trip Time): tiempo ida-y-vuelta de un paquete de red.
- **QUIC**: transporte sobre UDP que reemplaza TCP+TLS+HTTP en HTTP/3.
- **Edge computing**: ejecutar código en PoPs (points of presence) cerca del usuario, no en tu región AWS.

**Setup mínimo (agosto 2026):**

```bash
# AWS CLI v2 y SAM CLI
aws --version                    # 2.20+
sam --version                    # 1.130+

# LocalStack para simular AWS local
docker run --rm -it -p 4566:4566 \
  -e SERVICES=lambda,apigateway,s3,cloudfront,route53 \
  localstack/localstack:3.8

# Node 22 LTS o Python 3.13 para runtimes Lambda
node --version                   # v22.x
python --version                 # 3.13.x

# Verificar tu red desde diferentes puntos
# curl con timing detallado
curl -w "@curl-format.txt" -o /dev/null -s https://linguadev.app

# curl-format.txt:
#     time_namelookup:  %{time_namelookup}s\n
#     time_connect:     %{time_connect}s\n
#     time_appconnect:  %{time_appconnect}s\n
#     time_pretransfer: %{time_pretransfer}s\n
#     time_starttransfer: %{time_starttransfer}s\n
#     ----------\n
#     time_total:       %{time_total}s\n

# Verificar TLS 1.3 y HTTP/3
curl --http3 -sI https://linguadev.app | head -5
openssl s_client -tls1_3 -connect linguadev.app:443 </dev/null 2>/dev/null | grep -i protocol

# dig para investigar DNS
dig +short linguadev.app
dig +trace linguadev.app         # ver la resolución completa
```

En 2026, **Lambda SnapStart** (originalmente Java 2022) soporta Python 3.13 y Node 22 LTS (extendido en 2024). Lambda añadió **Function URLs** en 2022 (endpoint HTTPS directo sin API Gateway). CloudFront **KeyValueStore** (2023) permite lookups a baja latencia desde CloudFront Functions. HTTP/3 (QUIC, RFC 9114 2022) está soportado por CloudFront desde 2022, Cloudflare desde 2019 y ~95% de navegadores modernos.

---

## 1. El gran cuadro

Serverless no es "sin servidores" — hay servidores; simplemente no los gestionas tú. La promesa es real: escalado automático, coste por uso, sin patching de OS. La otra cara: **cold starts**, límites de concurrencia, tiempos máximos de ejecución, cost model contraintuitivo a escala. La adopción de Lambda pasó por tres fases: pionera (2015-2018, "todo funciona en Lambda"), reacción (2019-2022, "tiene límites, quizás containers"), y madurez (2023-2026, "usa la herramienta correcta por caso"). En 2026, la mayoría de arquitecturas modernas combinan Lambda (spiky, event-driven, glue), Fargate/Cloud Run (steady-state workloads), containers en Kubernetes (control fino, portable), y edge functions (personalización, A/B, geolocalización).

La segunda dimensión es networking. Un endpoint que responde en 50 ms desde tu laptop en Barcelona puede tardar 400 ms desde Sydney. La latencia geográfica está gobernada por la velocidad de la luz — no hay ingeniería que la venza — y por la topología de internet (peering, transit, saturación). Un servidor único en `us-east-1` sirve mal a Europa, muy mal a Asia. Las soluciones son **CDN + edge computing** para contenido cacheable, **multi-región activa-pasiva o activa-activa** para stateful workloads, y **DNS geolocalización** para dirigir usuarios al PoP más cercano. Route 53, Cloudflare y CloudFront son las tres tecnologías que dominan.

La tercera dimensión son los protocolos. HTTP/1.1 (1997) dominó dos décadas. HTTP/2 (2015) introdujo multiplexing sobre una única conexión TCP, resolviendo head-of-line blocking en la aplicación pero no en TCP. HTTP/3 (QUIC, 2022) resolvió el HOL blocking de TCP moviendo todo a UDP con reliability y crypto integrados. Combinado con **TLS 1.3** (RFC 8446, 2018) que redujo el handshake a 1 RTT (o 0 RTT con resumption), el web de 2026 es dramáticamente más rápido que el de 2015 — para quien lo configura bien. Muchos backend Node.js siguen sirviendo HTTP/1.1 detrás de un load balancer que hace bump a 2/3 en el borde.

Este capítulo cubre los tres frentes: (1) qué es realmente serverless, cold starts, límites y patrones para producción, (2) networking en la nube — VPC, Lambda-in-VPC, load balancers L4/L7, y (3) el borde: DNS, CDN, HTTP/2 y HTTP/3, TLS 1.3, edge functions, WebSockets, y multi-región. Al final tendrás las herramientas para diseñar arquitecturas de baja latencia y coste razonable — y saber cuándo NO usar serverless.

---

## 2. Fundamentos (nivel básico)

### 2.1 Vocabulario HTTP: status codes que se confunden

Los códigos HTTP se aprenden mal frecuentemente. Los que causan bugs en producción:

| Code | Semántica | Cuándo usarlo |
|---|---|---|
| **200 OK** | Éxito con body | GET exitoso |
| **201 Created** | Recurso creado | POST que crea, con `Location` header |
| **204 No Content** | Éxito sin body | DELETE, PUT idempotent |
| **301 Moved Permanently** | Redirect permanente (cacheable) | Cambio de URL definitivo |
| **302 Found** | Redirect temporal | OAuth, login flow |
| **307 Temporary Redirect** | 302 preserva método (POST → POST) | Redirect que debe mantener el POST |
| **308 Permanent Redirect** | 301 preserva método | Migración de API |
| **400 Bad Request** | Cliente envió algo mal formado | Body inválido, params faltantes |
| **401 Unauthorized** | Falta o inválida autenticación | Sin token, token inválido |
| **403 Forbidden** | Autenticado pero sin permisos | Token válido, no puede hacer X |
| **404 Not Found** | Recurso no existe | GET /users/999 (no existe) |
| **409 Conflict** | Estado incompatible | Duplicate key, versión desactualizada |
| **410 Gone** | Recurso existió y fue eliminado (permanente) | Deprecation de endpoints |
| **422 Unprocessable Entity** | Body válido pero semánticamente inválido | Validation errors |
| **429 Too Many Requests** | Rate limit | Include `Retry-After` header |
| **500 Internal Server Error** | Bug del servidor | Excepción no manejada |
| **502 Bad Gateway** | Upstream falló | Downstream cayó |
| **503 Service Unavailable** | Servidor temporalmente no puede servir | Circuit breaker abierto, maintenance |
| **504 Gateway Timeout** | Upstream tardó demasiado | Downstream lento |

Confusiones típicas: usar **401** cuando debería ser **403**, devolver **500** para errores del cliente, no diferenciar **502/503/504**.

### 2.2 HTTP/1.1 vs HTTP/2 vs HTTP/3

Evolución con motivos técnicos claros:

**HTTP/1.1 (1997):** una request por conexión, o pipelining raramente soportado. Head-of-line blocking en aplicación. Overhead de headers repetidos. Múltiples conexiones TCP paralelas (6 por origin era típico).

**HTTP/2 (2015, RFC 7540):** multiplexing sobre 1 conexión TCP. HPACK compresión de headers. Server push (poco usado en 2026). Binary protocol. **Head-of-line blocking en TCP persiste** — si un paquete se pierde, todos los streams pausan.

**HTTP/3 / QUIC (2022, RFC 9114/9000):** transporte QUIC sobre UDP. Streams independientes — pérdida de paquete afecta solo un stream. Handshake más rápido (crypto integrado). 0-RTT para conexiones repetidas. **Connection migration**: si cambias de WiFi a 4G, la conexión sobrevive (importante en mobile).

Adopción 2026:
- **Servers**: CloudFront (2022+), Cloudflare (2019+), Nginx 1.25+, Caddy nativo, Node.js con `node:http3` estable en 24 LTS.
- **Clients**: Chrome, Firefox, Safari, Edge, curl 8+ con `--http3`.
- Tráfico web global sobre HTTP/3: ~35-40% en 2026 (creciendo).

**Regla mental:** en tu load balancer / CDN, activa HTTP/2 y HTTP/3 con fallback a 1.1. En tu backend interno, HTTP/1.1 sigue siendo válido (más simple de operar). La ganancia grande es en la última milla al usuario.

### 2.3 TCP vs UDP vs QUIC

- **TCP**: reliable, ordered, congestion control. Handshake 3-way. Retransmisión automática. Head-of-line blocking. Ideal para todo salvo real-time.
- **UDP**: fire-and-forget. Sin reliability, sin orden. Cero overhead. Video streaming (con protocolo aplicación), DNS, VoIP, gaming.
- **QUIC**: reliability + streams + crypto sobre UDP. Handshake 1 RTT (o 0 RTT). Multiplex sin HOL blocking. Connection migration.

Ejemplo de cuándo cada uno:
- **API REST / GraphQL** → TCP (o QUIC via HTTP/3).
- **Server-Sent Events (SSE)** → TCP (long-lived HTTP).
- **WebSocket** → TCP.
- **WebRTC data channel** → UDP (con SCTP encima).
- **Video conferencing (Zoom, Meet)** → UDP + SRTP.
- **DNS queries** → UDP por default, TCP para respuestas grandes o TCP Fast Open.

### 2.4 Cold start: la causa raíz

Un cold start ocurre cuando Lambda tiene que crear un **execution environment** nuevo. Contribuyentes en orden de impacto:

1. **Deployment package download y unzip** (S3/EBS): tamaño del bundle. 50 MB tarda más que 5 MB.
2. **Runtime initialization**: iniciar el proceso (Node, Python, JVM). JVM lenta históricamente por classloading.
3. **Init phase de tu código**: importaciones top-level, cliente AWS SDK, connection pools.
4. **VPC ENI attachment** (histórico, mitigado desde 2019 con Hyperplane ENI): antes 8-10s extra.

Números típicos en 2026:
- **Node.js/Python (paquete pequeño)**: 100-300 ms.
- **Node.js/Python (paquete grande, muchos imports)**: 500 ms - 1.5 s.
- **Java sin SnapStart**: 2-4 s.
- **Java con SnapStart**: 200-400 ms (snapshot restore).
- **Python con SnapStart (2024)**: 100-300 ms.
- **Node 22 con SnapStart (2024)**: 100-300 ms.
- **Custom runtime (Rust)**: 20-100 ms.

Mitigaciones (orden ascendente de coste):

**1. Optimizar tu bundle**:
- Tree-shaking, minify, elimina dependencies no usadas.
- Layers para código pesado y compartido.
- ESM en Node (más rápido de parsear).

**2. Optimizar init phase**:
- Mueve imports pesados dentro de handlers si no siempre se usan (lazy import).
- Reusa clientes AWS SDK entre invocaciones (`const s3 = new S3Client()` fuera del handler).
- Evita conexiones DB en el init si no siempre necesarias.

**3. SnapStart** (Java, Python, Node en 2024+):
- Toma snapshot del entorno tras init; restaura en 100-300 ms.
- Gratis; caveat: el snapshot no puede tener credenciales/tokens que expiran.

**4. Provisioned Concurrency**:
- N entornos pre-warmed 24/7.
- Cobras por hora del env aunque no lo uses.
- Válido para endpoints con tráfico predecible y SLO estricto.

**5. Warmup lambdas** (anti-patrón moderno):
- Cron que invoca la Lambda cada 5 min para mantenerla caliente.
- Ineficaz a escala (no controla cuántos envs hay) y "hacky".
- **Preferir Provisioned Concurrency**.

### 2.5 Serverless — cuándo NO usarlo

Casos donde serverless es peor opción:

- **Workloads sostenidos 24/7 a throughput alto**: coste Lambda > coste EC2/Fargate a partir de ~15-25% de utilización sostenida.
- **Long-running jobs > 15 min**: Lambda máximo 15 min. Usa Fargate, ECS, Step Functions con activities, o batch processing.
- **Latencia p99 crítica < 50ms sin PC**: cold starts destrozan p99. Con PC funciona.
- **WebSockets / conexiones largas**: API Gateway WebSockets funciona pero es complejo y limitado; considera ALB + Fargate/ECS.
- **Modelos ML grandes** (>10 GB): Lambda 10 GB memoria max. Container image support en Lambda ayuda pero SageMaker es específico.
- **Trabajo CPU-bound con GPU**: Lambda no tiene GPU en 2026 en runtime general (existen extensiones limitadas).
- **Requisitos regulatorios de compute predecible/dedicado**.

Reglas mentales:
- **Spiky traffic + event-driven + glue** → Lambda gana claramente.
- **Steady traffic + latencia p99 estricta** → Fargate/ECS con auto-scaling.
- **Batch grande** → AWS Batch, Fargate, o Step Functions Distributed Map.

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Lambda-in-VPC: el problema histórico y su solución

Antes de 2019, poner Lambda en una VPC (para acceder a RDS, ElastiCache o recursos privados) añadía **8-10 segundos de cold start** para adjuntar un ENI. Muchas arquitecturas Lambda evitaban VPC por esto.

En 2019, AWS lanzó **Hyperplane ENI** — ENIs compartidos y pre-creados por subnet + security group. El cold start extra bajó a ~50-200 ms. En 2026 poner Lambda en VPC es transparente para la mayoría de casos.

Cuándo poner Lambda en VPC:
- Acceder a RDS/Aurora sin exponerla a internet.
- Acceder a ElastiCache/Redis privado.
- Acceder a servicios internos vía Direct Connect / VPC Peering.
- Cumplimiento con arquitecturas air-gapped.

Cuándo NO ponerla:
- Solo llamas APIs públicas (DynamoDB, S3, EventBridge — todos AWS-native).
- No necesitas red privada.

**Trampa clásica: Lambda in VPC sin NAT Gateway** — la Lambda no puede salir a internet. Si necesita llamar APIs públicas, hay que añadir NAT Gateway (caro: ~32 USD/mes + data) o **VPC Endpoints** para servicios AWS (mucho más baratos, y no salen a internet).

```yaml
# SAM template — Lambda en VPC con VPC Endpoints para AWS services
Resources:
  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: python3.13
      CodeUri: ./src
      Handler: app.handler
      MemorySize: 512
      Timeout: 30
      VpcConfig:
        SecurityGroupIds:
          - !Ref LambdaSG
        SubnetIds:
          - !Ref PrivateSubnetA
          - !Ref PrivateSubnetB

  # VPC Endpoint para DynamoDB (Gateway endpoint, gratis)
  DynamoDBEndpoint:
    Type: AWS::EC2::VPCEndpoint
    Properties:
      VpcId: !Ref VPC
      ServiceName: !Sub "com.amazonaws.${AWS::Region}.dynamodb"
      VpcEndpointType: Gateway
      RouteTableIds: [!Ref PrivateRouteTable]

  # VPC Endpoint para Secrets Manager (Interface, ~7 USD/mes por AZ)
  SecretsEndpoint:
    Type: AWS::EC2::VPCEndpoint
    Properties:
      VpcId: !Ref VPC
      ServiceName: !Sub "com.amazonaws.${AWS::Region}.secretsmanager"
      VpcEndpointType: Interface
      SubnetIds: [!Ref PrivateSubnetA, !Ref PrivateSubnetB]
      SecurityGroupIds: [!Ref EndpointSG]
      PrivateDnsEnabled: true
```

### 3.2 Lambda + DB: el pattern trap

Anti-patrón clásico: Lambda que abre una conexión a RDS por invocación → bajo tráfico spiky, decenas de miles de Lambda concurrentes abren conexiones simultáneamente → RDS `max_connections` saturado → outage.

Números: RDS PostgreSQL `db.t3.medium` tiene `max_connections=87` por default. 1000 Lambdas concurrentes → catastrophic.

Soluciones:

**1. RDS Proxy (recomendación 2026):**
- Pooler managed que mantiene conexiones al RDS y las reutiliza entre Lambdas.
- Coste: ~7 USD/mes por vCPU.
- IAM auth integrado; failover automático.

```yaml
Resources:
  RDSProxy:
    Type: AWS::RDS::DBProxy
    Properties:
      DBProxyName: linguadev-proxy
      EngineFamily: POSTGRESQL
      Auth:
        - AuthScheme: SECRETS
          SecretArn: !Ref DBSecret
          IAMAuth: REQUIRED
      RoleArn: !GetAtt ProxyRole.Arn
      VpcSubnetIds: [!Ref PrivateSubnetA, !Ref PrivateSubnetB]
      TargetGroupName: default
```

**2. Aurora Data API (HTTP-based):**
- Endpoint HTTP en lugar de conexión persistente.
- Ideal para Lambda sin VPC.
- Latencia extra (~10-30 ms) por el hop HTTP.

**3. DynamoDB (elimina el problema):**
- Sin conexiones persistentes; HTTP a endpoint.
- Escala automática hasta límites de partition.

### 3.3 API Gateway vs Function URL vs ALB + Lambda

Tres formas de exponer una Lambda por HTTPS. Cada una con trade-offs.

| Feature | API Gateway REST | API Gateway HTTP API | Function URL | ALB + Lambda |
|---|---|---|---|---|
| Latencia adicional | 10-30 ms | 5-10 ms | ~0 (más rápido) | 5-15 ms |
| Coste por request | Alto ($3.5/M) | Medio ($1/M) | Gratis | Bajo (LCU-based) |
| Auth integrada | Cognito, JWT, IAM, custom | JWT, IAM | IAM only | Cognito, OIDC |
| WAF | Sí | Sí | No directo (via CloudFront) | Sí |
| Custom domain | Sí | Sí | No directo (via CloudFront) | Sí |
| Throttling | Por API/method | Por route | No (Lambda concurrency) | No |
| WebSocket | Sí (separate) | No | No | No (ALB TCP not real WS) |
| Payload max | 10 MB | 6 MB | 6 MB (invoke) | 1 MB |

**Reglas:**
- **REST API** solo si necesitas features avanzadas (request/response mapping, WAF granular, throttling por API key).
- **HTTP API** (v2, 2019) es el default sensato para APIs REST modernas.
- **Function URL** para prototipos, webhooks internos, edge integration con CloudFront.
- **ALB** cuando ya tienes ALB para ECS/EC2 y quieres consistencia; o para payloads muy pequeños con alto volumen.

Ejemplo HTTP API en SAM:

```yaml
Resources:
  Api:
    Type: AWS::Serverless::HttpApi
    Properties:
      Auth:
        Authorizers:
          JwtAuth:
            IdentitySource: "$request.header.Authorization"
            JwtConfiguration:
              issuer: !Sub "https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}"
              audience: [!Ref UserPoolClient]
        DefaultAuthorizer: JwtAuth
      CorsConfiguration:
        AllowOrigins: ["https://linguadev.app"]
        AllowMethods: ["GET", "POST"]
        AllowHeaders: ["Content-Type", "Authorization"]

  GetCards:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: python3.13
      Handler: app.get_cards
      Events:
        Api:
          Type: HttpApi
          Properties: { Path: /cards, Method: GET, ApiId: !Ref Api }
```

### 3.4 CloudFront + OAC: CDN moderno con S3

Antes de 2022 se usaba **OAI (Origin Access Identity)** para restringir S3 a CloudFront. En 2022 llegó **OAC (Origin Access Control)** que soporta:
- Todas las regiones nuevas.
- SSE-KMS (cifrado con customer-managed keys).
- Compat con Lambda@Edge y CloudFront Functions.

Setup canónico serving un PWA desde S3:

```yaml
Resources:
  StaticBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: linguadev-static
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true

  OAC:
    Type: AWS::CloudFront::OriginAccessControl
    Properties:
      OriginAccessControlConfig:
        Name: linguadev-oac
        OriginAccessControlOriginType: s3
        SigningBehavior: always
        SigningProtocol: sigv4

  Distribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Enabled: true
        HttpVersion: http2and3
        PriceClass: PriceClass_100
        DefaultRootObject: index.html
        Aliases: [linguadev.app]
        ViewerCertificate:
          AcmCertificateArn: !Ref Cert
          SslSupportMethod: sni-only
          MinimumProtocolVersion: TLSv1.2_2021
        Origins:
          - Id: s3-origin
            DomainName: !GetAtt StaticBucket.RegionalDomainName
            S3OriginConfig: { OriginAccessIdentity: "" }
            OriginAccessControlId: !Ref OAC
        DefaultCacheBehavior:
          TargetOriginId: s3-origin
          ViewerProtocolPolicy: redirect-to-https
          CachePolicyId: 658327ea-f89d-4fab-a63d-7e88639e58f6  # CachingOptimized
          Compress: true
        # SPA support: 403/404 → index.html
        CustomErrorResponses:
          - ErrorCode: 403
            ResponseCode: 200
            ResponsePagePath: /index.html
          - ErrorCode: 404
            ResponseCode: 200
            ResponsePagePath: /index.html

  BucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref StaticBucket
      PolicyDocument:
        Statement:
          - Effect: Allow
            Principal: { Service: cloudfront.amazonaws.com }
            Action: s3:GetObject
            Resource: !Sub "${StaticBucket.Arn}/*"
            Condition:
              StringEquals:
                AWS:SourceArn: !Sub "arn:aws:cloudfront::${AWS::AccountId}:distribution/${Distribution}"
```

### 3.5 DNS, Route 53 y TTL

DNS es la primera cosa que rompe cuando cambias infraestructura. Entender TTL es crítico.

**TTL** (Time To Live): cuánto tiempo un resolver DNS cachea la respuesta antes de repreguntarse. Si tienes TTL 3600, un cambio de IP tardará hasta 1 hora en propagarse a los usuarios (peor caso).

Reglas 2026:
- **TTL alto (3600s+)**: dominios estables. Menos queries al authoritative, menos coste.
- **TTL bajo (60s)**: para failover activo o durante cambios.
- **BAJAR TTL 24-48 h ANTES** de un cambio planeado. Luego cambiar. Luego subir TTL de nuevo.

**Route 53 routing policies:**

| Policy | Cuándo |
|---|---|
| Simple | Un registro, sin lógica. |
| Weighted | A/B testing, traffic shifting. |
| Latency | Envía al endpoint con menor latencia desde el resolver. |
| Geolocation | Por país/continente. |
| Failover | Primary/secondary con health checks. |
| Multivalue Answer | Devuelve hasta 8 IPs; el cliente elige (fake load balancer). |
| Geoproximity | Weighted por proximidad geográfica (más granular que geo). |

**Failover pattern con health check:**

```yaml
Resources:
  PrimaryHealthCheck:
    Type: AWS::Route53::HealthCheck
    Properties:
      HealthCheckConfig:
        Type: HTTPS
        FullyQualifiedDomainName: primary.linguadev.app
        Port: 443
        ResourcePath: /health
        RequestInterval: 30
        FailureThreshold: 3

  PrimaryRecord:
    Type: AWS::Route53::RecordSet
    Properties:
      HostedZoneName: linguadev.app.
      Name: api.linguadev.app
      Type: A
      SetIdentifier: primary
      Failover: PRIMARY
      HealthCheckId: !Ref PrimaryHealthCheck
      TTL: 60
      ResourceRecords: [1.2.3.4]

  SecondaryRecord:
    Type: AWS::Route53::RecordSet
    Properties:
      HostedZoneName: linguadev.app.
      Name: api.linguadev.app
      Type: A
      SetIdentifier: secondary
      Failover: SECONDARY
      TTL: 60
      ResourceRecords: [5.6.7.8]
```

### 3.6 TLS 1.3 y el handshake reducido

TLS 1.2 (2008) usaba handshake de 2 RTTs. TLS 1.3 (2018, RFC 8446):
- **1 RTT** en el primer connect (ClientHello con key share; ServerHello con certificate y finished).
- **0 RTT** con session resumption (envío datos en el primer paquete).
- Elimina cifrados legacy inseguros (RC4, SHA-1, CBC modes).
- Perfect Forward Secrecy obligatorio.

Adopción 2026: ~95% de tráfico HTTPS es TLS 1.3. CloudFront default. AWS ALB soporta TLS 1.3.

**Trampa 0-RTT:** los datos 0-RTT son **replayable** — un atacante que capturó el 0-RTT puede reenviarlos. **Nunca uses 0-RTT para operaciones no idempotentes** (POST /transfer). GET son OK.

### 3.7 WebSockets vs SSE vs long-polling

Tres formas de push server→client:

- **Long-polling**: cliente hace request; server retiene hasta tener datos o timeout. Reconecta. Alto overhead HTTP.
- **Server-Sent Events (SSE)**: server → cliente unidireccional sobre HTTP. Nativo en browsers. Ideal para notifications, feeds.
- **WebSockets**: bidireccional full-duplex sobre 1 conexión. Ideal para chat, colaboración en tiempo real, gaming.

En serverless:
- **API Gateway WebSocket API**: managed, escala automáticamente. Coste por minuto de conexión + por mensaje. Ideal para casos con miles de conexiones.
- **ALB + Fargate con Node.js**: más control, WebSocket estándar. Mejor para persistent state en memoria.
- **AWS AppSync** (GraphQL managed): incluye subscriptions WebSocket, ideal si ya usas GraphQL.

SSE en Lambda con Function URL (2023+):

```python
def handler(event, context):
    def stream():
        yield "data: hello\n\n"
        yield "data: world\n\n"

    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        },
        "body": "".join(stream())
    }
```

Con **Lambda Response Streaming** (2023 GA), Function URL soporta streaming genuino sin buffering completo.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Provisioned Concurrency vs On-Demand — economía

**On-Demand**: pagas por invocación + duración GB-s. Sin overhead cuando no hay tráfico.

**Provisioned Concurrency (PC)**: pagas por hora del env (por N envs) + invocación con tarifa más baja. Sin cold starts.

Break-even simplificado (2026 pricing, `arm64`, region us-east-1):
- On-demand: 0.20 USD/1M req + 0.0000133 USD/GB-s.
- PC: 0.0000041 USD/GB-s (env) + 0.0000097 USD/GB-s (invoke) + 0.20 USD/1M req.

Para una función 512 MB con ~50 ms de duración:
- Break-even ~15-25% utilization sostenida.
- Below: PC pierde (pagas env ocioso).
- Above: PC gana y elimina cold starts.

**Uso híbrido**:
- PC = capacidad baseline (ej. 10 envs siempre).
- On-demand para picos.
- **Application Auto Scaling** puede ajustar PC por scheduled o target-tracking.

```yaml
Resources:
  HighTrafficFunction:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: python3.13
      ProvisionedConcurrencyConfig:
        ProvisionedConcurrentExecutions: 10

  # Auto-scaling de PC por hora del día
  PcScalingTarget:
    Type: AWS::ApplicationAutoScaling::ScalableTarget
    Properties:
      MaxCapacity: 100
      MinCapacity: 5
      ResourceId: !Sub "function:${HighTrafficFunction}:${HighTrafficFunction.Version}"
      ScalableDimension: lambda:function:ProvisionedConcurrency
      ServiceNamespace: lambda
      RoleARN: !GetAtt ScalingRole.Arn
```

### 4.2 SnapStart en profundidad

SnapStart toma un snapshot de Firecracker tras la fase init. En cada invocación cold, restaura ese snapshot en lugar de re-inicializar. Beneficios:

- Java Corretto 11/17/21: cold start baja de 2-4s → 200-400 ms.
- Python 3.12+ y Node 20+ (2024): cold start baja de 500-1500 ms → 100-300 ms.
- **Gratis** — no cobra extra por PC.

Caveats:
- **No puedes tener credenciales o tokens que expiran en el snapshot** — usa lazy init.
- **Uniqueness** — cada instancia restaurada tiene el mismo state; regenera UUIDs, secrets, random seeds en runtime.

```java
// Java con SnapStart y CRaC (Coordinated Restore at Checkpoint)
import org.crac.*;

public class Handler implements RequestHandler<Input, Output>, Resource {
    private HttpClient client;

    public Handler() {
        Core.getGlobalContext().register(this);
        // Init pesado — cachea entre invocaciones
        this.client = HttpClient.newBuilder().build();
    }

    @Override
    public void beforeCheckpoint(Context context) {
        // Antes del snapshot — cierra recursos con state efímero
        // Ej: cerrar conexiones DB
    }

    @Override
    public void afterRestore(Context context) {
        // Tras restore — reabre lo cerrado, regenera secrets
    }

    @Override
    public Output handleRequest(Input input, Context context) {
        return new Output(client.send(...));
    }
}
```

### 4.3 Edge computing: CloudFront Functions vs Lambda@Edge vs Cloudflare Workers

Tres runtimes edge principales:

**CloudFront Functions (2021+):**
- JavaScript ES 5.1 (limitado).
- Max 1 ms de CPU, 2 KB de memoria.
- Solo request/response modification.
- Ejecuta en cada PoP CloudFront.
- **Muy barato** ($0.10 por 1M).
- Ideal para: header manipulation, URL rewrite, A/B routing, JWT signature check.

**Lambda@Edge (2017+):**
- Node.js 20+ o Python 3.11+.
- Max 5s (viewer) o 30s (origin), 128 MB memoria (viewer) o 10 GB (origin).
- Full runtime; puede llamar servicios AWS.
- Ejecuta en **regional edge caches**, no en cada PoP.
- Latencia más alta que CloudFront Functions.
- Ideal para: transformaciones complejas, personalización, security por origen.

**Cloudflare Workers (2018+):**
- V8 isolates (no containers) — cold start <5 ms.
- WASI y muchos lenguajes vía WASM.
- 50 ms CPU (default), 128 MB memoria.
- KV, D1 (SQLite), Durable Objects, R2 (S3-compat).
- Ejecuta en cada PoP Cloudflare.
- **Cero cold start efectivo** — V8 isolates son casi instantáneos.

Cuándo cada uno:
- **CloudFront Functions**: transformaciones triviales de request/response.
- **Lambda@Edge**: lógica compleja con acceso AWS.
- **Cloudflare Workers**: apps completas en el edge, si estás en Cloudflare.

CloudFront Function ejemplo — reescribir URLs para SPA routing:

```javascript
// viewer-request function
function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // Si no tiene extensión y no termina en /, servir index.html (SPA)
    if (!uri.includes('.') && !uri.endsWith('/')) {
        request.uri = '/index.html';
    }

    // Añadir header custom
    request.headers['x-served-by'] = { value: 'cloudfront-fn' };
    return request;
}
```

### 4.4 Multi-región activa-pasiva vs activa-activa

- **Activa-pasiva**: producción sirve desde región A. Región B tiene infraestructura standby con datos replicados. Failover por Route 53 health checks.
- **Activa-activa**: ambas regiones sirven tráfico. Necesita DB multi-master (DynamoDB Global Tables, Aurora Global con write forwarding, Aurora DSQL).

Trade-offs:
- Activa-pasiva: más simple, RTO en minutos, RPO depende de replicación.
- Activa-activa: RTO ~0, mejor latencia (usuarios sirven desde región más cercana), pero conflictos de escritura y coste 2x.

DynamoDB Global Tables (v2, 2019+): replicación multi-master eventual con LWW conflict resolution. GA en 20+ regiones. Ideal para active-active.

**Aurora DSQL (GA 2025)**: PostgreSQL-compatible activa-activa multi-región con serializable isolation global. Alternativa a Spanner en AWS.

### 4.5 Cost optimization en serverless production

Cinco palancas críticas:

**1. Memory sizing (Power Tuning):**

Lambda cobra por GB-s. Más memoria = más CPU = a veces más barato porque termina antes. La tool oficial [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) mide el trade-off automáticamente.

**2. Arquitectura arm64 (Graviton):**
- ~20% más barato que x86_64.
- Mejor perf/watt.
- Compatible con Python, Node, Java, Go.

**3. HTTP API vs REST API:**
- HTTP API 70% más barato con features suficientes para 90% de casos.

**4. Reducir data transfer:**
- Data OUT de AWS es caro (~0.09 USD/GB en us-east-1).
- CloudFront reduce esto (0.085 USD/GB para primeros TB, baja con volumen).
- Compresión (gzip, brotli) en respuestas.
- VPC Endpoints para AWS-to-AWS (evita NAT Gateway).

**5. Directly to service integrations (sin Lambda):**
- API Gateway → DynamoDB direct (VTL): elimina Lambda intermedia.
- Step Functions → SDK integrations directas (Optimized integrations).

### 4.6 Ingress vs Egress — el cost trap

**Ingress a AWS es gratis. Egress es caro.** Estructura:

- **Data In** (internet → AWS): **gratis**.
- **Data Out** (AWS → internet): ~0.09 USD/GB (baja con volumen; primeros 100 GB/mes gratis).
- **Cross-region**: 0.02 USD/GB.
- **Cross-AZ dentro de misma región**: 0.01 USD/GB por sentido.

Trampas comunes:
- Servicios cross-AZ que no lo necesitan → cobros de data transfer invisibles.
- ALB con targets en otra AZ → 0.01 USD/GB doble sentido.
- VPC Endpoints (Interface): 0.01 USD/GB procesado, pero evitas NAT Gateway y salir a internet.

Herramientas: **AWS Cost Explorer** con "Group by" data transfer, **Cost & Usage Reports (CUR)** para análisis detallado.

### 4.7 Rate limiting patterns

Cuatro algoritmos clásicos:

**1. Token bucket**: bucket con N tokens, se rellena a X tokens/s. Cada request consume 1. Permite bursts.
**2. Leaky bucket**: bucket con capacity, drena a rate fijo. Sin bursts.
**3. Fixed window**: N requests por ventana fija (ej. 100/min). Trampa: 200 requests entre 12:00:30 y 12:01:30 posible.
**4. Sliding window**: ventana móvil con log de requests. Preciso pero más caro (memoria).

Implementaciones:

- **API Gateway**: throttling nativo por API/method/API key.
- **CloudFront + AWS WAF**: rate-based rules por IP.
- **Redis con Lua script**: implementación custom (token bucket clásico).
- **Cloudflare Rate Limiting**: managed, por IP/JWT/URL/etc.

```lua
-- Token bucket con Redis
-- KEYS[1] = "rate:user:123"
-- ARGV[1] = capacity, ARGV[2] = refill_rate, ARGV[3] = now
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or ARGV[1])
local last   = tonumber(redis.call('HGET', KEYS[1], 'last') or ARGV[3])
local delta  = math.max(0, tonumber(ARGV[3]) - last)
tokens = math.min(tonumber(ARGV[1]), tokens + delta * tonumber(ARGV[2]))
if tokens < 1 then return 0 end
tokens = tokens - 1
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last', ARGV[3])
redis.call('EXPIRE', KEYS[1], 3600)
return 1
```

### 4.8 Load balancers L4 vs L7

- **L4 (Network Load Balancer)**: TCP/UDP-level. No lee HTTP. Ultra-baja latencia. Preserva source IP. Ideal para gRPC, WebSocket persistente, protocolos custom.
- **L7 (Application Load Balancer)**: HTTP/HTTPS. Path/host routing. WAF integration. WebSocket support. Ideal para APIs REST.

Cuándo NLB:
- Latencia p99 <5 ms crítica.
- Volumen extremo (millones RPS).
- Protocolos no-HTTP.
- Static IP obligatoria (whitelist en firewalls externos).

Cuándo ALB:
- APIs REST/HTTP con routing por path/host.
- WebSocket managed.
- Auth OIDC integrada.
- WAF granular.

En 2026, ALB soporta gRPC nativamente (2020+).

---

## 5. Ejemplo práctico completo: LinguaDev Pro backend con Lambda + CloudFront

**Contexto.** Un endpoint `GET /api/cards/due` que:
1. Autentica JWT.
2. Lee cards vencidas del usuario en DynamoDB.
3. Responde JSON.
4. Sirve desde el PoP más cercano.
5. p50 <100 ms globalmente, p99 <300 ms.
6. Coste bajo control con cost optimization.

**Paso 1 — Lambda con arm64, SnapStart, min bundle.**

```yaml
Resources:
  CardsFunction:
    Type: AWS::Serverless::Function
    Properties:
      Runtime: python3.13
      Architectures: [arm64]                # 20% más barato
      MemorySize: 512
      Timeout: 5
      Handler: app.get_cards
      CodeUri: ./src
      SnapStart: { ApplyOn: PublishedVersions }
      AutoPublishAlias: live
      Environment:
        Variables:
          TABLE: !Ref CardsTable
          LOG_LEVEL: INFO
      Policies:
        - DynamoDBReadPolicy: { TableName: !Ref CardsTable }
      Tracing: Active                         # X-Ray tracing
      Events:
        Api:
          Type: HttpApi
          Properties: { Path: /api/cards/due, Method: GET, ApiId: !Ref Api }
```

**Paso 2 — Handler idiomático.**

```python
# src/app.py
import os, json, time
import boto3
from boto3.dynamodb.conditions import Key

# INIT PHASE — se ejecuta una vez y se snapshot con SnapStart
dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'eu-west-1'))
table = dynamodb.Table(os.environ['TABLE'])

def get_cards(event, context):
    """
    GET /api/cards/due — cards vencidas del usuario autenticado
    JWT authorizer inyecta claims en event['requestContext']['authorizer']['jwt']['claims']
    """
    try:
        claims = event['requestContext']['authorizer']['jwt']['claims']
        user_id = claims['sub']

        now = int(time.time())
        resp = table.query(
            KeyConditionExpression=Key('PK').eq(f'USER#{user_id}') & Key('SK').begins_with('CARD#'),
            FilterExpression='due_at <= :now',
            ExpressionAttributeValues={':now': now},
            Limit=50,
            ProjectionExpression='card_id, stability, difficulty, due_at'
        )

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Cache-Control': 'private, no-store'
            },
            'body': json.dumps({'cards': resp['Items']}, default=str)
        }
    except KeyError as e:
        return {'statusCode': 401, 'body': json.dumps({'error': 'unauthorized'})}
    except Exception as e:
        print(f"ERROR: {e}")
        return {'statusCode': 500, 'body': json.dumps({'error': 'internal_error'})}
```

**Paso 3 — HTTP API con JWT authorizer.**

```yaml
  Api:
    Type: AWS::Serverless::HttpApi
    Properties:
      Auth:
        Authorizers:
          JwtAuth:
            IdentitySource: "$request.header.Authorization"
            JwtConfiguration:
              issuer: !Sub "https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}"
              audience: [!Ref UserPoolClient]
        DefaultAuthorizer: JwtAuth
```

**Paso 4 — CloudFront delante para cache y edge.**

```yaml
  Distribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Enabled: true
        HttpVersion: http2and3
        Aliases: [api.linguadev.app]
        ViewerCertificate:
          AcmCertificateArn: !Ref Cert
          MinimumProtocolVersion: TLSv1.2_2021
          SslSupportMethod: sni-only
        Origins:
          - Id: api-origin
            DomainName: !Sub "${Api}.execute-api.${AWS::Region}.amazonaws.com"
            CustomOriginConfig:
              OriginProtocolPolicy: https-only
              OriginSSLProtocols: [TLSv1.2]
            OriginShield: { Enabled: true, OriginShieldRegion: eu-west-1 }
        DefaultCacheBehavior:
          TargetOriginId: api-origin
          ViewerProtocolPolicy: https-only
          AllowedMethods: [GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE]
          CachedMethods: [GET, HEAD, OPTIONS]
          CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad  # CachingDisabled
          OriginRequestPolicyId: 216adef6-5c7f-47e4-b989-5492eafa07d3  # AllViewer
          FunctionAssociations:
            - EventType: viewer-request
              FunctionARN: !GetAtt HeaderStripFunction.FunctionMetadata.FunctionARN
```

**Paso 5 — CloudFront Function para header manipulation.**

```yaml
  HeaderStripFunction:
    Type: AWS::CloudFront::Function
    Properties:
      Name: header-strip
      AutoPublish: true
      FunctionConfig:
        Comment: Strip cookies and add security headers
        Runtime: cloudfront-js-2.0
      FunctionCode: |
        function handler(event) {
            var request = event.request;
            // Strip cookies innecesarias para APIs (reduce Vary y cache misses)
            delete request.cookies;
            return request;
        }
```

**Paso 6 — Route 53 con failover y health check.**

```yaml
  DistributionRecord:
    Type: AWS::Route53::RecordSet
    Properties:
      HostedZoneName: linguadev.app.
      Name: api.linguadev.app
      Type: A
      AliasTarget:
        DNSName: !GetAtt Distribution.DomainName
        HostedZoneId: Z2FDTNDATAQYW2   # CloudFront zone ID canónico
```

**Paso 7 — CloudWatch alarms.**

```yaml
  P99LatencyAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      MetricName: Duration
      Namespace: AWS/Lambda
      Statistic: p99
      Dimensions: [{ Name: FunctionName, Value: !Ref CardsFunction }]
      Period: 60
      EvaluationPeriods: 5
      Threshold: 300                      # 300 ms
      ComparisonOperator: GreaterThanThreshold
      AlarmActions: [!Ref AlertTopic]

  ErrorsAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      MetricName: Errors
      Namespace: AWS/Lambda
      Statistic: Sum
      Dimensions: [{ Name: FunctionName, Value: !Ref CardsFunction }]
      Period: 60
      EvaluationPeriods: 5
      Threshold: 10
      ComparisonOperator: GreaterThanThreshold
      AlarmActions: [!Ref AlertTopic]
```

**Paso 8 — Test de carga con k6.**

```javascript
// loadtest.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '5m', target: 500 },
    { duration: '2m', target: 0 }
  ],
  thresholds: {
    http_req_duration: ['p(99)<300'],   // p99 <300ms
    http_req_failed: ['rate<0.01'],
  }
};

export default function () {
  const res = http.get('https://api.linguadev.app/api/cards/due', {
    headers: { Authorization: `Bearer ${__ENV.JWT}` }
  });
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
```

**Discusión y trade-offs:**

- Arm64 + SnapStart eliminan cold starts sin PC.
- CloudFront delante da terminación TLS al PoP más cercano — RTT reducido incluso para APIs no-cacheables.
- Origin Shield (single region cache layer) reduce fanout al origin.
- HTTP/3 default; conexiones móviles se benefician.
- CloudFront Function elimina glue de headers.
- p99 se controla con alarma; escalamiento con concurrency reserved si necesario.
- Falta: budget alarms, provisioned concurrency scheduled si tráfico predecible, autoscaling de DynamoDB.

---

## 6. Cheatsheet, reglas mentales y anti-patrones

### Reglas de oro

- ✅ **HTTP API** (v2) por default en Lambda; REST API solo si necesitas features avanzadas.
- ✅ **Arm64 (Graviton)** para 20% descuento en Lambda.
- ✅ **SnapStart** en Java/Python/Node cuando aplica.
- ✅ **Provisioned Concurrency** para SLO estricto o latencia predecible; on-demand para bursts.
- ✅ **RDS Proxy** si conectas Lambda a RDS.
- ✅ **VPC Endpoints (Gateway)** para DynamoDB/S3 sin coste extra.
- ✅ **CloudFront** delante de APIs y static, con **HTTP/2 y HTTP/3**.
- ✅ **OAC** en lugar de OAI para S3 origin.
- ✅ **Route 53 con health checks** para failover.
- ✅ **BAJAR TTL 24-48h ANTES** de cambios DNS planeados.
- ✅ **TLS 1.3** en todos los frontends; **min TLS 1.2** obligatorio.
- ✅ **CloudFront Functions** para transformaciones ligeras (más baratas y rápidas que Lambda@Edge).
- ✅ **Métricas** p50/p95/p99 en CloudWatch para cada endpoint.
- ✅ **Idempotency keys** en APIs mutantes para tolerar retries.
- ✅ **DLQ** en toda función que procesa eventos.

### Anti-patrones

- ❌ **Lambda con warmup lambdas** — usa PC.
- ❌ **Lambda + RDS sin RDS Proxy** — connection storm garantizado.
- ❌ **Lambda in VPC sin NAT Gateway o VPC Endpoints** — no puede salir a internet.
- ❌ **CloudFront con TTL 0 y cache disabled** — pagas por hop sin cache.
- ❌ **Cambio DNS con TTL 3600** — 1 hora sin propagar.
- ❌ **0-RTT TLS 1.3 en POST no idempotentes** — replay attack.
- ❌ **Elasticsearch/OpenSearch como origin de CloudFront** sin cache — cache miss = DoS al cluster.
- ❌ **NAT Gateway para AWS-to-AWS** — usa VPC Endpoints.
- ❌ **Lambda 128 MB "para ahorrar"** — a veces 512 MB termina antes y cuesta menos.
- ❌ **API Gateway REST cuando HTTP API basta** — 3.5x más caro.
- ❌ **Servir imágenes desde S3 sin CloudFront** — 100x más caro y lento.
- ❌ **Cross-region default sin necesidad** — 0.02 USD/GB es caro a escala.
- ❌ **Cross-AZ chatter** — 0.01 USD/GB doble sentido invisible.
- ❌ **Lambda para batch >15 min** — usa Fargate, Batch o Step Functions.

### Tabla de decisión rápida

| Necesidad | Elección 2026 |
|---|---|
| API HTTP nueva en AWS | HTTP API (API Gateway v2) + Lambda arm64 |
| API pública mundial | CloudFront delante de HTTP API |
| Static SPA | S3 + CloudFront + OAC |
| Latencia mínima edge | CloudFront Functions o Cloudflare Workers |
| Long-running job (<15 min) | Lambda + Step Functions |
| Long-running job (>15 min) | Fargate / ECS |
| Batch grande | Step Functions Distributed Map / AWS Batch |
| WebSocket chat | API Gateway WebSocket API o ALB + Fargate |
| SSE stream | Function URL con Response Streaming |
| Real-time video | UDP + WebRTC (no serverless) |
| Multi-región activa-activa | DynamoDB Global Tables o Aurora DSQL |
| Multi-región activa-pasiva | Route 53 failover + read replicas |
| Rate limiting global | Cloudflare Rate Limiting o AWS WAF rate-based |
| Cache warm | Origin Shield + long TTLs |

---

## 7. Casos reales industria 2024-2026

**Lambda SnapStart para Python y Node (2024).** AWS extendió SnapStart más allá de Java. Adopción rápida: teams reportan cold starts bajando de 1s a 200 ms. **Lección:** re-evalúa tus assumptions sobre cold starts cada 6 meses; el runtime evoluciona.

**AWS Lambda Response Streaming GA (2023).** Permite streaming de respuestas hasta 20 MB desde Function URL. Elimina buffering para respuestas largas (SSE, generación LLM). **Lección:** patterns que requerían ALB + Fargate ahora funcionan en Lambda.

**HTTP/3 adoption crossing 35% (2024-2026).** Cloudflare y CloudFront reportan que HTTP/3 supera 1/3 del tráfico global. Móvil se beneficia especialmente. **Lección:** activa HTTP/3 en tu CDN — es un config change.

**Cloudflare Workers y Bindings evolution (2024-2026).** Cloudflare añadió D1 (SQLite distribuida), Durable Objects mejorados, AI Workers con GPU en edge (2024). **Lección:** el edge se ha vuelto plataforma completa; considera Cloudflare stack para greenfield con requisitos globales.

**CloudFront KeyValueStore (2023 GA).** Store distribuido con lecturas 1 ms desde CloudFront Functions. Reemplaza patterns donde Lambda@Edge leía DynamoDB para lookups simples. **Lección:** menos hops, más edge-native.

**AWS Aurora DSQL (preview 2024, GA 2025).** PostgreSQL-compatible distribuida activa-activa multi-región con serializable global. Competencia directa a Spanner. **Lección:** multi-region active-active con RDBMS transaccional finalmente viable en AWS.

**Cloudflare "Total TLS" (2023-2026).** Provisioning automático de certs SAN para wildcards de subdominios. Reduce fricción operacional. **Lección:** cert management es cada vez más invisible; ACME + auto-renew es baseline.

**Vercel Functions moving to edge (2024-2026).** Vercel/Netlify apuestan por edge runtimes como default para functions. Next.js App Router con edge runtime es común. **Lección:** edge-first afecta el diseño de arquitecturas de frontend framework.

**Fastly Compute@Edge (basado en WASM) — adopción 2024-2026.** Alternativa a CF Workers, con foco en compliance y control. **Lección:** WASM en edge es el ecosistema en crecimiento.

**AWS re:Invent 2024 — Lambda enhanced with Application Signals.** Observabilidad nativa OTel para Lambda sin extra layers. **Lección:** OpenTelemetry se ha vuelto standard cross-vendor.

**Google Cloud Run "always on CPU" (2024).** Cloud Run introduce billing con CPU siempre asignada (no solo durante request), acercándose a Fargate en modelo. **Lección:** los productos serverless convergen hacia opciones híbridas.

**Vercel Bandwidth pricing cambios (2024).** Vercel actualizó pricing de bandwidth causando fricción en algunos startups. **Lección:** vendor lock-in en hosting frontend tiene costes latentes.

**Route 53 Resolver DNS Firewall (2020, escalado 2024).** Reglas de bloqueo de dominios maliciosos a nivel DNS. Preview de expansión con AI en 2025-2026. **Lección:** DNS es control plane de seguridad; no lo delegues sin logging.

---

## 8. Ejercicios prácticos

### Ejercicio 1: medir cold start propio en 3 runtimes

**Objetivo:** cuantificar cold start en Node 22, Python 3.13, Java 21 (con y sin SnapStart) en tu cuenta.

**Setup:**
- SAM CLI y cuenta AWS sandbox.
- Bundle mínimo (`hello world`) por cada runtime.

**Pasos:**
1. Deploy 4 Lambdas: `hello-node`, `hello-python`, `hello-java`, `hello-java-snapstart`.
2. Todas devuelven `{"ok": true}` con handler mínimo.
3. Ejecuta 30 invocaciones espaciadas de 5 min cada una (fuerza cold starts).
4. Recolecta métricas de `Init Duration` y `Duration` en CloudWatch.
5. Grafica p50, p95, p99 de cold start por runtime.

**Criterios de éxito:**
- [ ] Node y Python p95 <400 ms cold start.
- [ ] Java sin SnapStart p95 >1.5 s.
- [ ] Java con SnapStart p95 <500 ms.
- [ ] Documento con conclusiones y recomendaciones para tu stack.

**Bonus:** repite con arm64 y compara latencia y coste.

---

### Ejercicio 2: HTTP API + CloudFront + Lambda con JWT

**Objetivo:** deploy end-to-end de un endpoint autenticado servido globalmente.

**Setup:**
- SAM CLI.
- Cognito User Pool o JWT signer local.
- Dominio propio (o `cloudfront.net` default).

**Pasos:**
1. Crea Cognito User Pool y un app client.
2. Deploy HTTP API con JWT authorizer.
3. Deploy Lambda que devuelve `{"user_id": claims.sub}`.
4. Deploy CloudFront delante del HTTP API con Origin Shield.
5. Autentica un user, obtén JWT, prueba `curl` desde 3 países usando VPNs o `time` con headers.
6. Mide p50/p99 desde 3 continentes.

**Criterios de éxito:**
- [ ] Sin JWT: 401.
- [ ] Con JWT válido: 200 con claims correctas.
- [ ] Latencia desde continente propio <200 ms.
- [ ] Latencia desde otro continente <400 ms (con CloudFront).
- [ ] HTTP/3 activo (`curl --http3`).

**Bonus:** añade CloudFront Function que strippee headers no necesarios.

---

### Ejercicio 3: RDS Proxy y connection pooling en Lambda

**Objetivo:** demostrar el problema de conexiones y su fix con RDS Proxy.

**Setup:**
- Postgres t3.medium en RDS.
- Lambda que hace `SELECT NOW()`.
- k6 o similar para load.

**Pasos:**
1. Deploy Lambda que conecta a RDS **sin proxy**.
2. Load test con 500 requests concurrentes.
3. Observa `max_connections` errors en CloudWatch RDS.
4. Deploy **RDS Proxy** y modifica Lambda para conectar al proxy.
5. Repite load test — verifica que ahora funciona.
6. Compara latencia p50/p99 antes y después.

**Criterios de éxito:**
- [ ] Sin proxy: >20% de requests fallan con connection errors bajo 500 concurrentes.
- [ ] Con proxy: 100% éxito bajo mismo load.
- [ ] Latencia p50 con proxy es ~5-15 ms mayor (hop extra).
- [ ] Métrica `DatabaseConnections` en RDS estable con proxy.

**Bonus:** añade autoscaling de la Lambda y prueba hasta 2000 concurrent.

---

### Ejercicio 4: multi-región activa-pasiva con Route 53 failover

**Objetivo:** setup failover automático entre 2 regiones con health checks.

**Setup:**
- 2 endpoints simulados: primario en `us-east-1`, secundario en `eu-west-1`.
- Ambos exponen `/health` que devuelve 200 normalmente.

**Pasos:**
1. Crea 2 Route 53 records tipo A con failover routing (`PRIMARY` y `SECONDARY`).
2. Crea health checks apuntando a `/health` de cada uno.
3. Verifica que `dig` devuelve el primario cuando ambos están sanos.
4. Simula fallo en el primario (devuelve 500 en `/health`).
5. Espera hasta 90 segundos (3 fails × 30 s interval).
6. Verifica que `dig` ahora devuelve el secundario.
7. Restaura primario y verifica el flip back.

**Criterios de éxito:**
- [ ] Failover automático dentro de 2 minutos.
- [ ] Flip back automático cuando primario recupera.
- [ ] TTL DNS configurado a 60s (o menor) para failover rápido.
- [ ] Health check tiene 3 failure threshold (evita flapping).

**Bonus:** implementa multi-value answer con weighted routing para load balancing entre regiones activas.

---

### Ejercicio 5: CloudFront Functions para A/B testing edge

**Objetivo:** repartir tráfico 90/10 entre dos variantes desde el edge sin hit al origin.

**Setup:**
- Distribución CloudFront con dos orígenes: `origin-a` (control) y `origin-b` (variant).
- CloudFront Function asignada a viewer-request.

**Pasos:**
1. Crea CloudFront Function que:
   - Lee cookie `ab_bucket`; si no existe, genera random en [0,100).
   - Si <10, setea `ab_bucket=variant`.
   - Si ≥10, setea `ab_bucket=control`.
   - Añade header `x-origin-target` con el bucket.
2. Deploy origin request policy que forwardee el header.
3. Origin request routing basado en header.
4. Prueba con 100 requests fresh (sin cookie); mide distribución.

**Criterios de éxito:**
- [ ] Distribución ~10/90 (con margen 3%).
- [ ] Requests con cookie `ab_bucket=variant` siempre van al `origin-b`.
- [ ] Latencia edge <5 ms.
- [ ] Cookie sticky funciona: mismo usuario ve misma variante en sesiones subsecuentes.

**Bonus:** log cada asignación a CloudWatch via Kinesis Data Firehose para análisis.

---

## 9. Recursos y siguientes pasos

**Docs oficiales:**
- AWS Lambda Operator Guide y Best Practices.
- AWS Well-Architected Serverless Lens.
- AWS CloudFront Developer Guide, especialmente Origin Shield y CloudFront Functions.
- Cloudflare Developer Docs — Workers, D1, Durable Objects.
- RFC 9114 (HTTP/3), RFC 9000 (QUIC), RFC 8446 (TLS 1.3).

**Libros y whitepapers:**
- Yan Cui — *Serverless Architectures on AWS*, 2nd ed. (2020).
- Sheen Brisals — *Enterprise Serverless* patterns.
- Adrian Hornsby — talks de AWS re:Invent sobre resiliencia serverless.
- Werner Vogels — writings en All Things Distributed.

**Herramientas 2026:**
- **AWS Lambda Power Tuning** (Alex Casalboni) — memory sizing óptimo.
- **AWS SAM CLI** — desarrollo y deploy local.
- **serverless.tf** o **Terraform AWS Modules** — alternativa IaC.
- **k6, Artillery, Locust** — load testing.
- **AWS X-Ray + OpenTelemetry** — distributed tracing.
- **AWS Application Signals** (2024) — observabilidad app-centric.
- **Datadog Serverless Monitoring** — third-party observability.

**Blogs y newsletters:**
- Yan Cui — [theburningmonk.com](https://theburningmonk.com).
- Ben Kehoe — sobre serverless architectural principles.
- Cloudflare blog — HTTP/3, TLS, edge topics.
- AWS Compute Blog y AWS Architecture Blog.
- Marc Brooker (AWS) — sobre sistemas distribuidos y Lambda internals.

**Siguientes pasos:**
- Implementa dos de los ejercicios en tu cuenta AWS sandbox.
- Aprende a leer un CloudWatch X-Ray trace con detalle.
- Considera el próximo capítulo: [Cap 04 — Patrones de resiliencia](./04-patrones-de-resiliencia.md) donde veremos circuit breakers, bulkheads, retries budget y chaos engineering.
- Suscríbete a AWS Compute Blog y Cloudflare Blog para novedades continuas.

---

## 10. Preguntas de práctica (20)

Cubre 20 escenarios sobre serverless y networking. Temas: HTTP status codes, HTTP/1/2/3, TCP/UDP/QUIC, CDN, cuándo NO usar serverless, cold start causes, DNS y TTL, latencia real, Lambda + DB traps, TLS handshake, serverless containers (Fargate/Cloud Run/App Runner), L4 vs L7 load balancing, WebSocket vs SSE vs long-polling, edge functions, VPC networking, Step Functions vs orchestrated Lambdas, ingress/egress cost trap, rate limiting patterns, cost optimization production, y multi-region architecture.

- **Fuente:** [`packages/content/src/tech/architecture/sim-03-serverless-and-networking.json`](../../packages/content/src/tech/architecture/sim-03-serverless-and-networking.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-03-serverless-and-networking`
- **Tiempo:** 60 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Cap 02](./02-mensajeria-y-microservicios.md) · [Índice](./README.md) · [Cap 04 →](./04-patrones-de-resiliencia.md)
