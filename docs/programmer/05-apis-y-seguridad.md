# Capítulo 05 — APIs, idempotencia y seguridad práctica

> **Focus:** Diseñar APIs REST/GraphQL/gRPC con criterios modernos (idempotencia, versioning, pagination, rate limiting), aplicar defensa en profundidad frente a OWASP Top 10 2025, y saber elegir mecanismo de autenticación/autorización según contexto.
> **Áreas:** APIs · Seguridad
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 22 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

**Pre-requisitos:**
- HTTP/1.1 y HTTP/2 básicos: métodos, headers, status codes, MIME types, TLS.
- JSON, Base64, hexadecimal, y notación URI (RFC 3986).
- Programación async básica (ver [Cap 03 — concurrencia y async](./03-concurrencia-y-async.md)).
- Nociones de bases de datos relacionales (INSERT, SELECT, UNIQUE constraints).
- Comandos `curl`, `openssl`, `jq` en terminal.

**Glosario mínimo:**
- **Idempotencia**: ejecutar la misma operación N veces produce el mismo estado que ejecutarla 1 vez.
- **Idempotency-Key**: header que el cliente envía con un UUID único por operación lógica; el servidor deduplica reintentos.
- **JWS / JWT**: JSON Web Signature (formato base) y JSON Web Token (uso común de JWS con claims). Firmado, NO encriptado.
- **OAuth 2.1**: consolidación de OAuth 2.0 con best practices obligatorias (PKCE en todos los flows, prohibición del implicit grant y del password grant).
- **OIDC**: OpenID Connect. Capa de autenticación (identity) sobre OAuth (authorization).
- **PKCE**: Proof Key for Code Exchange. Extensión de OAuth para clientes públicos (SPA, mobile).
- **mTLS**: mutual TLS. Cliente y servidor se autentican mutuamente con certificados.
- **Argon2id**: función de derivación de clave memory-hard, ganadora de Password Hashing Competition 2015; recomendación #1 de OWASP Password Storage Cheat Sheet 2026.
- **SBOM**: Software Bill of Materials. Inventario completo de dependencias (SPDX o CycloneDX).
- **SLSA**: Supply-chain Levels for Software Artifacts. Framework de OpenSSF para hardening de pipelines.
- **CORS**: Cross-Origin Resource Sharing. Protocolo del browser para requests cross-origin.
- **CSRF**: Cross-Site Request Forgery. Ataque que explota cookies enviadas automáticamente por el browser.
- **XSS**: Cross-Site Scripting. Ejecución de script atacante en el browser de la víctima.
- **SSRF**: Server-Side Request Forgery. Atacante hace que TU server haga request a URLs internas.

**Setup mínimo:**

```bash
# 1. Servidor de práctica (Node.js con Fastify)
mkdir api-security-lab && cd api-security-lab
pnpm init && pnpm add fastify @fastify/cors @fastify/rate-limit \
    @fastify/helmet @fastify/cookie @fastify/jwt argon2 pino

# 2. Cliente para testing
pnpm add -D httpie undici vitest

# 3. Utilidades de seguridad locales
openssl rand -hex 32 > .jwt-secret          # secret para HMAC JWTs
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 \
    -nodes -keyout server-key.pem -out server-cert.pem \
    -subj "/CN=localhost"                    # certificado self-signed para TLS

# 4. Verificar tu stack contra OWASP con ZAP en Docker
docker run -t owasp/zap2docker-stable zap-baseline.py -t https://tuapi.local

# 5. Scanner de dependencias
pnpm audit --prod
pnpm add -D @cyclonedx/cyclonedx-npm && pnpx cyclonedx-npm --output-file sbom.json

# 6. Herramientas de línea de comandos que usarás
curl --version
jq --version
openssl version
```

Si estos comandos ejecutan sin error, estás listo.

---

## 1. El gran cuadro

Diseñar una API pública en 2026 tiene tres frentes simultáneos: **corrección de contrato** (verbos HTTP, status codes, versioning, idempotencia), **defensa en profundidad** (OWASP Top 10 2025 con las nuevas categorías de Supply Chain Failures y Mishandling of Exceptional Conditions) y **experiencia del consumidor** (documentación OpenAPI/AsyncAPI, error responses RFC 7807, pagination que escale, rate limiting con headers estándar). Fallar en cualquiera es medible: contratos frágiles rompen clientes móviles que no actualizan; una vulnerabilidad OWASP es multa, incidente reportable y fuga de datos; APIs inconsistentes son coste de integración eterno para tus clientes.

El paradigma dominante sigue siendo **REST sobre HTTP**, con matices: **GraphQL** para clientes diversos con fetching flexible (mobile + web + admin), **gRPC + Protobuf** para service-to-service interno donde latencia y type safety importan más que observabilidad humana, **WebSockets/SSE** para real-time, y **webhooks** con firma HMAC + idempotency para eventos push. La elección es contextual. Una empresa moderna típica opera un mix: REST público (OpenAPI), gRPC interno, webhooks, y a veces GraphQL como BFF para móvil.

**Idempotencia** merece capítulo aparte porque hace posibles los sistemas distribuidos confiables. Cuando un cliente móvil hace `POST /payments` y la conexión se corta antes de la respuesta, el cliente no sabe si el pago pasó. Si reintenta ingenuamente, el usuario paga dos veces. Solución: **Idempotency-Key** — el cliente genera un UUID por operación lógica; el servidor lo guarda con la respuesta y devuelve la misma si aparece el mismo key. Stripe, Square, PayPal lo implementan; existe draft de RFC HTTP para formalizarlo.

En **seguridad**, la línea de tiempo reciente marca la agenda de 2026:
- **OWASP Top 10 2025** (enero 2026): dos categorías nuevas (A03 Software Supply Chain Failures, A10 Mishandling of Exceptional Conditions); SSRF absorbido en A01; Security Misconfiguration subió a #2. Basado en 175.000+ CVEs y 589 CWEs.
- **Log4Shell (2021)**, **SolarWinds (2020)**, **xz-utils backdoor (marzo 2024)** cambiaron cómo se piensa la cadena de suministro. SBOM es requisito de US Executive Order 14028.
- **OAuth 2.1** consolida best practices: PKCE obligatorio en todo, prohibición explícita del implicit grant y del password grant.
- **Argon2id** es recomendación #1 de OWASP Password Storage 2026 (bcrypt aceptable para migraciones, PBKDF2 solo FIPS, SHA solo inaceptable).
- **TLS 1.3** es el mínimo aceptable; TLS 1.0/1.1 y SSL prohibidos por navegadores y PCI-DSS 4.0.

El objetivo es que salgas capaz de diseñar un endpoint moderno de principio a fin: elegir paradigma, definir contrato con OpenAPI, implementar idempotencia y rate limiting, autenticar y autorizar, prevenir las 10 categorías OWASP, versionar sin romper clientes, y observar el sistema.

---

## 2. Fundamentos (nivel básico)

### 2.1 HTTP como contrato: métodos y status codes

Roy Fielding (*Architectural Styles*, 2000) formalizó REST sobre HTTP. Los métodos tienen semántica precisa:

| Método | Propiedades | Uso típico |
|---|---|---|
| `GET` | Safe, Idempotente, Cacheable | Leer recurso |
| `HEAD` | Safe, Idempotente, Cacheable | Metadata (headers) sin body |
| `OPTIONS` | Safe, Idempotente | Descubrir métodos permitidos (CORS preflight) |
| `POST` | NO safe, NO idempotente | Crear, invocar acción con side-effects |
| `PUT` | NO safe, Idempotente | Reemplazar recurso completo |
| `PATCH` | NO safe, NO idempotente (por default) | Actualización parcial (JSON Patch RFC 6902 o Merge Patch RFC 7396) |
| `DELETE` | NO safe, Idempotente | Borrar recurso |

**Status codes que todo desarrollador debe dominar (RFC 9110):**

- **200 OK** — success con body.
- **201 Created** — recurso creado; incluye `Location` header.
- **202 Accepted** — solicitud aceptada para procesamiento async; incluye link al estado.
- **204 No Content** — success sin body (típico en DELETE).
- **301 Moved Permanently / 308** — redirección permanente.
- **400 Bad Request** — input malformado sintácticamente.
- **401 Unauthorized** — no autenticado (nombre histórico confuso; debería ser "Unauthenticated").
- **403 Forbidden** — autenticado pero sin permiso.
- **404 Not Found** — recurso no existe.
- **409 Conflict** — estado del recurso conflicta con la operación (email duplicado).
- **410 Gone** — recurso existió pero ya no (información permanente).
- **422 Unprocessable Entity** — sintaxis válida pero semántica inválida.
- **429 Too Many Requests** — rate limit; incluye `Retry-After`.
- **500 Internal Server Error** — bug del servidor (activa alertas).
- **502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout** — problemas de upstream.

**Regla mental**: 4xx no debe reintentarse (cliente debe corregir), 5xx puede reintentarse con backoff (probable transitorio).

Ejemplo de mala vs buena API:

```http
# Mala: 200 con error en body enmascara el problema
POST /users
< 200 OK
< Content-Type: application/json
< {"success": false, "error": "email already exists"}

# Buena: status code semántico + body estructurado (RFC 7807)
POST /users
< 409 Conflict
< Content-Type: application/problem+json
< {
<   "type": "https://api.linguadev.com/errors/email-conflict",
<   "title": "Email already registered",
<   "status": 409,
<   "detail": "The email 'a@b.com' is already registered by another user.",
<   "instance": "/users",
<   "code": "EMAIL_ALREADY_EXISTS"
< }
```

### 2.2 REST vs GraphQL vs gRPC

| Aspecto | REST | GraphQL | gRPC |
|---|---|---|---|
| **Transporte** | HTTP/1.1 o HTTP/2 | HTTP (POST /graphql) | HTTP/2 obligatorio |
| **Formato** | JSON (típico) | JSON | Protobuf (binario) |
| **Type safety** | Débil (OpenAPI ayuda) | Fuerte (schema) | Fuerte end-to-end |
| **Fetching flexible** | Múltiples endpoints o BFF | Cliente elige campos | Método fijo por RPC |
| **Streaming** | SSE / WebSocket separado | Subscriptions (WebSocket) | Bidirectional streaming nativo |
| **Caching HTTP** | Nativo por método | Difícil (todo POST) | Requiere gateway |
| **Discoverability** | OpenAPI + tools estándar | Introspection + GraphiQL | Reflection + grpcurl |
| **Browser-friendly** | Sí | Sí | Requiere gRPC-Web + proxy Envoy |
| **Ecosistema tooling** | Enorme (Postman, curl, insomnia) | Fuerte (Apollo, GraphiQL) | Mediano (BloomRPC, grpcurl) |

**Cuándo elegir cada uno:**
- **REST**: público, con caching HTTP importante, integraciones con muchos clientes heterogéneos. Ejemplo: Stripe, GitHub API v3.
- **GraphQL**: dashboards con muchas entidades por vista, clientes móviles con bandwidth limitado, evolución de schema sin versioning. Ejemplo: GitHub API v4, Shopify.
- **gRPC**: service-to-service interno, low-latency, type safety obligatorio. Ejemplo: Kubernetes API interno, Google internal, Uber microservicios.

### 2.3 Idempotencia y `Idempotency-Key`

El patrón canónico de Stripe (y RFC draft "The Idempotency-Key HTTP Header Field"):

1. El cliente genera un UUID único por **operación lógica** (no por request, sino por lo que quiere lograr).
2. Envía el header `Idempotency-Key: <uuid>`.
3. El servidor busca el key en una tabla dedicada:
   - Si existe con respuesta guardada → devuelve la misma respuesta.
   - Si existe con estado "processing" → devuelve 409 o espera con lock.
   - Si no existe → procesa, guarda respuesta con el key + TTL (24h típico), devuelve respuesta.
4. En reintentos, el cliente reutiliza el mismo UUID.

```javascript
// Cliente Node.js — MISMO idempotencyKey en todos los reintentos
const idempotencyKey = randomUUID();
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const res = await fetch('https://api.linguadev.com/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey,
                 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ amount, currency, source }),
      signal: AbortSignal.timeout(5000)
    });
    if (res.status >= 500) throw new Error(`retry: ${res.status}`);
    return await res.json();
  } catch (err) {
    await new Promise(r => setTimeout(r, 2 ** attempt * 1000 + Math.random() * 500));
  }
}
```

```javascript
// Servidor Fastify — dedup con Redis y lock optimista
app.post('/payments', async (req, reply) => {
  const key = req.headers['idempotency-key'];
  if (!key) return reply.code(400).send({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  const cached = await redis.get(`idem:${key}`);
  if (cached) return JSON.parse(cached);
  const lockOk = await redis.set(`lock:${key}`, '1', 'EX', 30, 'NX');
  if (!lockOk) return reply.code(409).send({ code: 'IDEMPOTENCY_IN_FLIGHT' });
  try {
    const result = await processPayment(req.body);
    await redis.set(`idem:${key}`, JSON.stringify(result), 'EX', 86400);
    return result;
  } finally { await redis.del(`lock:${key}`); }
});
```

### 2.4 Password hashing en 2026

**Regla clara**: SHA-256/SHA-512/MD5 **solos** para passwords son inaceptables. Son rápidos por diseño → un atacante con GPU prueba miles de millones de hashes/segundo.

Recomendación OWASP Password Storage Cheat Sheet (enero 2026):

1. **Argon2id** (default): `t=3, m=64 MiB, p=1` (~100 ms en x86 moderno).
2. **scrypt**: `N=131072, r=8, p=1` como fallback.
3. **bcrypt**: `cost >= 12`. Aceptable para migraciones legacy.
4. **PBKDF2**: solo compliance FIPS. `iterations >= 600.000` con SHA-256.

```javascript
import argon2 from 'argon2';
const hashed = await argon2.hash(password, {
  type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1
});
// Guardas hashed en DB. Format: $argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>
const ok = await argon2.verify(hashed, password);
```

**Nunca hagas** en 2026: SHA-256(password) sin salt ni iteraciones; MD5 de nada relevante; "cifrado reversible" para passwords; loggear el password; enviar el password por email en signup.

### 2.5 OAuth 2.1 y OIDC

**Distinción crítica**: **OAuth 2.0/2.1** = framework de **autorización** ("esta app puede leer tus files de Drive"). **OIDC** = capa de **autenticación** sobre OAuth ("quién eres tú"). Para "Login with Google" → OIDC. Para "permitir esta app publicar en tu Twitter" → OAuth.

**OAuth 2.1** consolida: PKCE obligatorio en TODOS los flows con Authorization Code; Implicit Grant eliminado; Resource Owner Password Credentials Grant eliminado; refresh token rotation recomendado; redirect URI matching exacto.

Flow Authorization Code + PKCE:

```
1. Cliente genera code_verifier (43-128 chars random) y
   code_challenge = base64url(sha256(code_verifier))
2. GET /authorize?response_type=code&client_id=X&redirect_uri=Y
     &scope=openid profile email&state=<csrf>
     &code_challenge=<c>&code_challenge_method=S256
3. Callback: GET /callback?code=<auth_code>&state=<same>
4. POST /token con grant_type=authorization_code, code, redirect_uri,
   client_id, code_verifier=<verifier>  # AS verifica sha256(verifier)==challenge
5. Response: { access_token, id_token (JWT con identidad),
              refresh_token, expires_in: 900, token_type: "Bearer" }
```

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 JWT en profundidad

Un JWT es `header.payload.signature`, cada parte Base64URL. Header: `{"alg":"RS256","kid":"1"}`. Payload (claims): `{"sub":"1234","exp":1699...,"iss":"linguadev","aud":"api"}`. Signature: firma sobre `base64url(header) + "." + base64url(payload)`.

**Claims estándar (RFC 7519):** `iss` (issuer), `sub` (userId), `aud` (audience), `exp` (expiration), `nbf` (not before), `iat` (issued at), `jti` (JWT id).

**JWT es firmado, NO encriptado**: cualquiera con el token lee el payload con `base64 -d`. NO metas datos sensibles (PII, email, DNI).

**Vulnerabilidades históricas:**
1. **`alg: none` bypass**: atacante fabrica token sin firma. Fix: whitelist explícito de algoritmos.
2. **HS256/RS256 confusion**: server espera RS256 pero acepta HS256; atacante firma con la pubkey.
3. **Weak HMAC secret**: `HS256` con "secret" es crackeable en segundos.
4. **`kid` injection**: path traversal para leer archivos del server.
5. **JKU/X5U SSRF**: header `jku` apunta a URL controlada por atacante.

**Best practices 2026:** access token corto (5-15 min); refresh con rotation, revocable; firma RS256/ES256 en sistemas distribuidos; `kid` para rotación; validación estricta de `alg`/`iss`/`aud`/`exp`/`nbf`; almacenamiento en httpOnly cookies con SameSite=Lax, o BFF pattern.

### 3.2 Cookies, CSRF, CORS: el triángulo del browser

**Same-Origin Policy (SOP)**: el browser bloquea que scripts de origin A **lean** responses de origin B, pero permite **hacer** requests cross-origin (con preflight en varios casos).

**CORS** relaja SOP: el server declara qué origins pueden leer:

```
Access-Control-Allow-Origin: https://app.linguadev.com  # NO uses "*" con credentials
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, PUT, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type, Idempotency-Key
Access-Control-Max-Age: 3600
Vary: Origin
```

**CSRF**: sitio malicioso `evil.com` auto-submitea `<form action="https://tubanco.com/transfer" method="POST">`. Browser envía cookies de tubanco.com automáticamente. **Solo aplica a cookies auto-enviadas**; con `Authorization: Bearer` en header, el atacante no puede añadir el header desde `evil.com` (SOP bloquea).

**Prevención CSRF**: SameSite cookies (`Strict`/`Lax`, default en Chrome desde 2020); CSRF token (double-submit o synchronizer); custom header (`X-Requested-With`); BFF pattern.

**Cookie moderna segura**: `Set-Cookie: session=abc; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`.

### 3.3 SQL Injection y XSS: los dos gigantes

**SQL Injection** (OWASP A06 Injection). Única defensa aceptable en 2026: **prepared statements**.

```python
# MAL: f-string
cursor.execute(f"SELECT * FROM users WHERE email = '{email}'")  # x' OR '1'='1

# MAL: "sanitizar" comillas
email = email.replace("'", "")  # bypasses: unicode, backslash, second-order

# BIEN: prepared statement — driver separa SQL de datos
cursor.execute("SELECT * FROM users WHERE email = %s", (email,))
```

ORMs (SQLAlchemy, Prisma, Hibernate, TypeORM) usan prepared statements por debajo. Cuidado con `raw()`/`$queryRaw`. Aplica **least privilege**: la conexión de la app solo tiene SELECT/INSERT/UPDATE sobre tablas necesarias.

**XSS**: (a) Stored (payload en DB), (b) Reflected (URL parameter reflejado), (c) DOM-based (JS del cliente pone `location.hash` en `innerHTML`).

Defensa: **contextual output encoding**. HTML text (`<`→`&lt;`), HTML attribute (`"`→`&quot;`), URL (`encodeURIComponent`), JavaScript (JSON.stringify + escape), CSS (hex encoding).

**Frameworks modernos escapan por default**: React `{user.name}` (no `dangerouslySetInnerHTML`), Vue `{{ }}` (no `v-html`), Angular interpolation (cuidado con `[innerHTML]`).

**Content Security Policy** limita qué scripts pueden ejecutar:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-r4nd0mV4lu3';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;
  frame-ancestors 'none'; base-uri 'self'; form-action 'self';
  upgrade-insecure-requests; report-to csp-endpoint;
```

Con nonce, los `<script nonce="r4nd0mV4lu3">` inline se permiten; el atacante no puede predecir el nonce.

### 3.4 Rate limiting: algoritmos

| Algoritmo | Descripción | Ventajas | Contras |
|---|---|---|---|
| **Fixed Window** | Contador por ventana (00:00-00:59) | Simple, poca memoria | Burst en boundary (200 requests en 2 seg) |
| **Sliding Window Log** | Guardar timestamps de cada request | Precisión perfecta | Memoria O(rate × window) |
| **Token Bucket** | Bucket capacidad N, refill rate R | Permite bursts, popular | Requiere refill timer |
| **Leaky Bucket** | Cola FIFO con rate constante | Smoothing perfecto | No permite bursts |
| **Sliding Window Counter** | Aproximación con 2 fixed windows + weighted | Balance memoria/precisión | Aproximado |

**Token bucket en Redis** (el más popular en producción) usa un Lua script atómico que en cada request: (1) obtiene `tokens` y `last_refill` del bucket, (2) recalcula tokens sumando `elapsed × refill_rate` capped a `capacity`, (3) si `tokens >= requested` consume y devuelve `allowed`, si no rechaza. El script ejecuta atómicamente vía `EVAL`, evitando race conditions. Librerías listas: `rate-limiter-flexible` (Node), `redis-cell` (module de Redis), `bucket4j` (Java), `slowapi` (Python FastAPI).

**Response headers estándar (draft RFC 9331):**

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1735689600     # Unix timestamp when window resets
Retry-After: 60                    # segundos hasta el próximo intento (con 429)
```

### 3.5 Pagination: cursor vs offset

**Offset** (`LIMIT N OFFSET M`): simple pero degrada (`OFFSET 200000` cuenta y salta 200k rows) y produce duplicados/saltos si se insertan items durante paginación.

**Cursor-based**: escalable (O(log n) con index), estable ante inserts. Cursor debe ser **opaco** (base64 del id+timestamp) para no atar al cliente.

```
GET /messages?cursor=eyJpZCI6MTIzNDUsInRzIjoxNzM1fQ==&limit=20
```

```sql
SELECT * FROM messages
WHERE (created_at, id) < ('2026-08-13 10:00:00', 12345)  -- keyset dos columnas
ORDER BY created_at DESC, id DESC
LIMIT 21;  -- uno extra para saber si hay next
```

Response: `{ data: [...20...], pageInfo: { endCursor: "...", hasNextPage: true } }`. GraphQL Relay formaliza esto con `edges`/`nodes`/`pageInfo`.

### 3.6 Webhooks confiables

Requisitos: (1) **at-least-once delivery** con exponential backoff + jitter + DLQ; (2) **firma HMAC** `X-Signature: sha256=<hmac(secret, timestamp + body)>` con timestamp para prevenir replay; (3) **idempotency** con `event_id` único, receiver dedup; (4) **timeouts** 15-30 seg máx; (5) **docs de schema** (AsyncAPI, CloudEvents); (6) **sandbox** para el consumer.

Verificación segura (constant-time, no `==`):

```javascript
function verifyWebhookSignature(body, headerSig, secret, maxAgeSec = 300) {
  const [t, v1] = headerSig.split(',').map(s => s.split('=')[1]);
  const timestamp = parseInt(t, 10);
  if (Math.abs(Date.now() / 1000 - timestamp) > maxAgeSec)
    throw new Error('Signature too old (possible replay)');
  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${body}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)))
    throw new Error('Invalid signature');
}
```

---

## 4. Práctica avanzada (nivel senior/staff)

### 4.1 OWASP Top 10 2025 (enero 2026)

La lista final publicada por OWASP en enero 2026 introduce dos categorías nuevas y consolida SSRF en Broken Access Control:

| Rank | Categoría | Cambio vs 2021 |
|---|---|---|
| **A01** | Broken Access Control | Sigue #1; absorbe SSRF (era A10) |
| **A02** | Security Misconfiguration | Sube de #5 a #2 |
| **A03** | **Software Supply Chain Failures** (nuevo) | Amplía "Vulnerable Components" |
| **A04** | Cryptographic Failures | Estable |
| **A05** | Insecure Design | Estable |
| **A06** | Injection | Baja (ORMs mitigan) |
| **A07** | Identification and Authentication Failures | Estable |
| **A08** | Software and Data Integrity Failures | Estable |
| **A09** | Security Logging and Monitoring Failures | Estable |
| **A10** | **Mishandling of Exceptional Conditions** (nuevo) | Error handling, failing open |

**Filosofía 2025**: énfasis en **causas raíz** (design flaws, misconfigurations, dependency-level weaknesses) sobre síntomas. Coherente con el énfasis en supply chain post log4shell y xz-utils backdoor.

### 4.2 Supply chain security

Post xz-utils backdoor (marzo 2024) y log4shell (dic 2021), el estándar mínimo 2026:

1. **Dependency scanning automático**: Dependabot, Snyk, Renovate. Alerta y crea PRs de update.
2. **SBOM en cada build**: SPDX o CycloneDX. Necesario para US Executive Order 14028.
3. **Lockfiles verificados** con integrity hashes (`sha512-...`).
4. **Signed artifacts**: Sigstore/Cosign para containers y binaries.
5. **SLSA Level 2+**: build pipeline en YAML del repo con provenance atestada.
6. **Private registries** para dependencies críticas.
7. **Secret scanning**: `git-secrets`, `trufflehog`, GitHub Secret Scanning.
8. **Minimize dependencies**: cada dep es superficie de ataque.

Ejemplo pipeline Node generando SBOM firmado:

```yaml
# .github/workflows/sbom.yml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: '22' }
  - run: pnpm install --frozen-lockfile
  - run: pnpx @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json
  - run: cosign sign-blob --yes sbom.cdx.json --output-signature sbom.cdx.json.sig
  - uses: actions/upload-artifact@v4
    with: { name: sbom, path: sbom.cdx.json* }
```

### 4.3 Circuit breakers, timeouts, bulkheads

En sistemas distribuidos, un downstream degradado causa cascada. Patrones de Michael Nygard (*Release It!*, 2ª ed. 2018) y Sam Newman:

- **Timeout obligatorio en TODA network call**: default sin timeout es letal. Regla: timeout < SLA de tu servicio × 0.5.
- **Circuit breaker** (CLOSED → OPEN → HALF-OPEN): si supera umbral de failures, abre y falla fast. Da tiempo al downstream para recuperar.
- **Bulkhead**: thread pool separado por downstream. Si uno satura, otros siguen.
- **Fallback**: cache stale, respuesta default. Graceful degradation > hard failure.
- **Retry con exponential backoff + jitter**: nunca infinito.

Ejemplo con Resilience4j (Java):

```java
var cb = CircuitBreaker.of("paymentService", CircuitBreakerConfig.custom()
    .failureRateThreshold(50).slowCallDurationThreshold(Duration.ofSeconds(2))
    .slidingWindowSize(20).waitDurationInOpenState(Duration.ofSeconds(30)).build());
var bulkhead = Bulkhead.of("paymentBulkhead",
    BulkheadConfig.custom().maxConcurrentCalls(50).build());
var timeLimiter = TimeLimiter.of(Duration.ofSeconds(3));

Supplier<PaymentResult> decorated = Decorators.ofSupplier(() -> paymentClient.charge(req))
    .withCircuitBreaker(cb).withBulkhead(bulkhead)
    .withTimeLimiter(timeLimiter, Executors.newScheduledThreadPool(1))
    .withFallback(List.of(TimeoutException.class, CallNotPermittedException.class),
                  ex -> PaymentResult.pending("Payment queued for retry"))
    .decorate();
```

### 4.4 mTLS y zero-trust

Autenticación mutua con certificados X.509: cliente y servidor validan mutuamente. Común en microservicios internos y APIs financial-grade (Open Banking, FAPI).

Service mesh (Istio, Linkerd) automatiza mTLS entre pods de Kubernetes: emisión automática de certs por SPIFFE/SPIRE, rotación cada 24h, revocación por CRL/OCSP. Cero configuración por servicio.

**Zero-trust** como paradigma (BeyondCorp de Google, 2011): "nunca confíes, siempre verifica". Cada request se autoriza en base al contexto (identidad, dispositivo, geolocalización, comportamiento), no en base a "está en la red interna".

### 4.5 API versioning: estrategias comparadas

| Estrategia | Ejemplo | Pros | Contras |
|---|---|---|---|
| **URL path** | `/v1/users`, `/v2/users` | Simple, muy visible, cache HTTP intuitiva | "Cambio de URL" cuando REST evangelistas dicen "el recurso es el mismo" |
| **Custom header** | `Accept: application/vnd.linguadev.v2+json` | Más "RESTful"; misma URL | Menos discoverable; herramientas cliente más pobres |
| **Query param** | `?version=2` | Trivial | Ensuria URL; cache confuso |
| **Date-based** (Stripe) | `Stripe-Version: 2024-08-14` | Granularidad fina; migración a rytmo del cliente | Complejidad de mantener N versiones |
| **Schema evolution** (GraphQL) | Sin versioning; añades campos, marcas `@deprecated` | Sin versión = sin ruptura si no eliminas | No cubre breaking changes de arquitectura |

**Deprecation process profesional**:
1. Anunciar en changelog + email a integradores.
2. Add response headers: `Deprecation: true`, `Sunset: Wed, 31 Dec 2026 23:59:59 GMT`, `Link: <https://api.linguadev.com/v2/users>; rel="successor-version"`.
3. Monitoring de uso por versión.
4. Reminder emails 30d, 15d, 7d antes.
5. Sunset.

### 4.6 Anti-patrones catalogados

| Anti-patrón | Por qué | Alternativa |
|---|---|---|
| `200 OK` con `{"success": false, "error": ...}` | Rompe todo el ecosistema HTTP (proxies, retry logic, monitoring) | Status code semántico + RFC 7807 |
| `alg: none` aceptado por librería JWT | Bypass trivial | Whitelist explícita de algoritmos |
| `Access-Control-Allow-Origin: *` con `Credentials: true` | Spec-violation + expone tu API | Whitelist explícita de origins |
| SQL con concatenación de strings | Injection casi garantizada | Prepared statements SIEMPRE |
| Secrets en repo (incluso privado) | Ex-empleado, fork, git history | Vault / Secrets Manager / env vars |
| `md5(password)` o `sha256(password)` sin salt | Rainbow tables + brute force | Argon2id |
| JWT con validez 30 días sin refresh | Ventana de compromise enorme | Access 15 min + refresh rotativo |
| Retry infinito | Amplifica outage aguas arriba | Retry con límite + backoff + jitter + circuit breaker |
| Verify webhook con `==` (comparación no constant-time) | Timing attack revela HMAC | `crypto.timingSafeEqual` |
| `dangerouslySetInnerHTML={{__html: userInput}}` | Stored XSS instantáneo | Escape + DOMPurify si necesitas HTML |
| CORS "solved" con proxy `no-cors` en dev | Solo funciona en dev | Configurar CORS correcto |

---

## 5. Ejemplo práctico completo: endpoint `POST /orders` production-grade

Vas a construir un endpoint que crea una orden con: autenticación JWT, idempotencia con Idempotency-Key, validación de input, rate limiting per-user, error responses RFC 7807, structured logging, y verificación con contract tests.

### 5.1 Fastify server con todo lo necesario

```javascript
// src/server.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

const app = Fastify({
  logger: { level: 'info',
    formatters: { log: (obj) => ({ ...obj, service: 'orders-api', env: process.env.NODE_ENV }) } },
  requestIdHeader: 'x-request-id', genReqId: () => randomUUID()
});
const redis = new Redis(process.env.REDIS_URL);

// -------- Security headers, CORS, JWT, Rate limit --------
await app.register(helmet, {
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], frameAncestors: ["'none'"] } },
  strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: true }
});
await app.register(cors, {
  origin: (origin, cb) => {
    const allowlist = ['https://app.linguadev.com', 'https://admin.linguadev.com'];
    if (!origin || allowlist.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id']
});
await app.register(jwt, {
  secret: { private: process.env.JWT_PRIVATE_KEY, public: process.env.JWT_PUBLIC_KEY },
  sign: { algorithm: 'RS256', expiresIn: '15m', iss: 'linguadev', aud: 'orders-api' },
  verify: { algorithms: ['RS256'], allowedIss: 'linguadev', allowedAud: 'orders-api' }
});
await app.register(rateLimit, {
  max: 100, timeWindow: '1 minute', redis,
  keyGenerator: (req) => req.user?.sub || req.ip,
  errorResponseBuilder: (req, ctx) => ({
    type: 'https://api.linguadev.com/errors/rate-limit', title: 'Too many requests',
    status: 429, code: 'RATE_LIMITED', retryAfter: ctx.after
  })
});
```

### 5.2 Endpoint con idempotencia

```javascript
// src/orders/create-order.route.js
const orderBodySchema = {
  type: 'object', required: ['items', 'currency'], additionalProperties: false,
  properties: {
    items: {
      type: 'array', minItems: 1, maxItems: 100,
      items: { type: 'object', required: ['productId', 'quantity'], additionalProperties: false,
        properties: {
          productId: { type: 'string', format: 'uuid' },
          quantity: { type: 'integer', minimum: 1, maximum: 100 } } }
    },
    currency: { type: 'string', enum: ['EUR', 'USD', 'GBP'] },
    shippingAddressId: { type: 'string', format: 'uuid' }
  }
};

async function createOrderRoute(app) {
  app.post('/orders', {
    schema: {
      body: orderBodySchema,
      headers: { type: 'object', required: ['idempotency-key'],
        properties: { 'idempotency-key': { type: 'string', format: 'uuid' } } }
    },
    onRequest: [app.authenticate], // valida JWT
    handler: async (req, reply) => {
      const key = req.headers['idempotency-key'];
      const userId = req.user.sub;
      const redisKey = `idem:${userId}:${key}`;

      // 1. Check idempotency cache
      const cached = await redis.get(redisKey);
      if (cached) {
        const { status, body } = JSON.parse(cached);
        return reply.code(status).send(body);
      }

      // 2. Optimistic lock
      const lockKey = `lock:${userId}:${key}`;
      const lockOk = await redis.set(lockKey, '1', 'EX', 30, 'NX');
      if (!lockOk) return reply.code(409).send({
        type: '.../idempotency-in-flight', title: 'Duplicate in flight',
        status: 409, code: 'IDEMPOTENCY_IN_FLIGHT'
      });

      try {
        // 3. Business logic
        const order = await app.orderService.create({ userId, ...req.body });
        await redis.set(redisKey, JSON.stringify({ status: 201, body: order }), 'EX', 86400);
        req.log.info({ orderId: order.id, userId }, 'Order created');
        return reply.code(201).header('Location', `/orders/${order.id}`).send(order);
      } catch (err) {
        if (err.code === 'INSUFFICIENT_STOCK') {
          return reply.code(422).send({
            type: '.../insufficient-stock', title: 'Insufficient stock',
            status: 422, detail: err.message, code: 'INSUFFICIENT_STOCK',
            invalidProductId: err.productId
          });
        }
        throw err;
      } finally { await redis.del(lockKey); }
    }
  });
}
export default createOrderRoute;
```

### 5.3 Global error handler + logging

```javascript
// src/errors/handler.js
app.setErrorHandler((err, req, reply) => {
  req.log.error({ err, requestId: req.id, userId: req.user?.sub, path: req.url }, 'Unhandled');

  if (err.validation) {
    return reply.code(400).send({
      type: 'https://api.linguadev.com/errors/validation', title: 'Validation failed',
      status: 400, code: 'VALIDATION_ERROR',
      errors: err.validation.map(v => ({ path: v.instancePath, message: v.message }))
    });
  }
  if (err.statusCode === 401) {
    return reply.code(401).send({ type: '.../unauthorized', title: 'Unauthorized',
      status: 401, code: 'UNAUTHORIZED' });
  }
  const detail = process.env.NODE_ENV === 'production'
    ? 'An unexpected error occurred.' : err.message;
  reply.code(500).send({ type: '.../internal', title: 'Internal server error',
    status: 500, detail, code: 'INTERNAL_ERROR', requestId: req.id });
});
```

### 5.4 Test end-to-end con vitest

```javascript
// test/create-order.e2e.test.js
import { test, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer } from 'testcontainers';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';

let app, redis, token;
beforeAll(async () => {
  redis = await new GenericContainer('redis:7').withExposedPorts(6379).start();
  process.env.REDIS_URL = `redis://localhost:${redis.getMappedPort(6379)}`;
  app = await buildApp();
  token = app.jwt.sign({ sub: 'user-123', roles: ['customer'] });
});
afterAll(async () => { await app.close(); await redis.stop(); });

const inject = (payload, key = randomUUID(), extraHeaders = {}) => app.inject({
  method: 'POST', url: '/orders',
  headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key, ...extraHeaders },
  payload
});
const validOrder = { items: [{ productId: 'uuid-1', quantity: 2 }], currency: 'EUR' };

test('creates order with valid input', async () => {
  const res = await inject(validOrder);
  expect(res.statusCode).toBe(201);
  expect(res.json()).toMatchObject({ id: expect.any(String), status: 'pending' });
});

test('same Idempotency-Key returns cached response', async () => {
  const key = randomUUID();
  const first = await inject(validOrder, key);
  const second = await inject(validOrder, key);
  expect(first.json().id).toBe(second.json().id);
});

test('rate limits per user', async () => {
  const results = await Promise.all(Array.from({ length: 110 }, () => inject(validOrder)));
  const rateLimited = results.filter(r => r.statusCode === 429);
  expect(rateLimited.length).toBeGreaterThan(0);
});
```

### 5.5 OpenAPI spec generado (extracto)

```yaml
openapi: 3.1.0
paths:
  /orders:
    post:
      summary: Create an order
      security: [{ bearerAuth: [] }]
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema: { type: string, format: uuid }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateOrderRequest' }
      responses:
        '201': { description: Created, headers: { Location: { schema: { type: string } } } }
        '400': { $ref: '#/components/responses/ValidationError' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '409': { description: Idempotency in flight }
        '422': { description: Insufficient stock or similar }
        '429': { $ref: '#/components/responses/RateLimited' }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
```

Este endpoint cumple: idempotencia rigurosa, autenticación JWT con validación estricta, autorización a nivel handler, rate limiting per-user, validación de schema JSON, error responses RFC 7807, structured logging con requestId, headers de seguridad (HSTS, CSP, CORS estricto), tests e2e con Testcontainers, y OpenAPI spec para clientes.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### 6.1 Reglas mentales

- **HTTP status codes son contrato**: 2xx success, 3xx redirect, 4xx client error (no reintentar), 5xx server error (puede reintentar).
- **Idempotencia es responsabilidad del servidor**; los verbos HTTP son solo convención.
- **Los mocks son adecuados solo en el borde**; para colaboradores internos usa fakes.
- **JWT es firmado, NO encriptado**: nunca metas datos sensibles.
- **CSRF solo aplica con cookies auto-enviadas**; con Bearer header no aplica.
- **Prepared statements SIEMPRE** para SQL con input de usuario.
- **Contextual output encoding** por default; frameworks modernos ayudan pero cuidado con `dangerouslySetInnerHTML`.
- **Argon2id primero**, bcrypt fallback, PBKDF2 solo compliance, SHA solo hashing no.
- **OAuth para autorización, OIDC para autenticación**. Nunca uses OAuth "puro" para login.
- **`Access-Control-Allow-Origin: *` con credentials es prohibido por spec** y peligroso.
- **Timeouts obligatorios en TODA network call**; el default sin timeout es letal.
- **Retry con exponential backoff + jitter + límite**; nunca infinito.

### 6.2 Tabla de decisión: paradigma de API

| Contexto | Recomendación |
|---|---|
| API pública para muchos clientes heterogéneos | **REST** + OpenAPI |
| Cliente móvil con muchas entidades por vista | **GraphQL** |
| Service-to-service interno con low-latency | **gRPC** + Protobuf |
| Push de eventos a partners | **Webhooks** con HMAC + Idempotency |
| Real-time bidireccional (chat, colaboración) | **WebSocket** o SSE |
| Batch/async con eventual consistency | **Message queue** (SQS, Kafka) |
| Compliance financial / banking | **REST + FAPI** (perfil estricto de OAuth) |

### 6.3 Tabla de decisión: autenticación

| Caso | Mecanismo |
|---|---|
| Login usuario web | OIDC (Google/Auth0/Cognito) o session cookies |
| API entre servicios internos | mTLS con service mesh (Istio, Linkerd) |
| API pública a partners | OAuth 2.1 Client Credentials + API Keys |
| SPA con backend propio | BFF pattern con session cookies (HttpOnly, SameSite=Lax) |
| App móvil | OAuth 2.1 Authorization Code + PKCE + refresh rotation |
| Machine-to-machine con proveedor cloud | IAM role del cloud (AWS SigV4, Google service accounts) |

### 6.4 ✅ Buenas prácticas 2026

- ✅ Argon2id con `t=3, m=64 MiB, p=1`.
- ✅ TLS 1.3 obligatorio; TLS 1.2 tolerado; TLS 1.0/1.1/SSL prohibidos.
- ✅ `Idempotency-Key` obligatorio en todo POST/PUT/PATCH que mute estado.
- ✅ Rate limiting por user y por IP con headers estándar (`X-RateLimit-*`).
- ✅ RFC 7807 (`application/problem+json`) para errores.
- ✅ Structured logging con `requestId`, `userId`, `path`, `status`.
- ✅ SBOM generado en cada build (CycloneDX o SPDX).
- ✅ Signed container images con Cosign.
- ✅ Dependency scanning automático (Dependabot/Snyk).
- ✅ Secret scanning pre-commit y en push.
- ✅ CSP con nonce o hash; sin `unsafe-inline`.
- ✅ HttpOnly + Secure + SameSite=Lax en session cookies.
- ✅ Prepared statements para SQL.
- ✅ Constant-time comparison para HMAC (`crypto.timingSafeEqual`).
- ✅ Access token corto (5-15 min) + refresh rotativo.

### 6.5 ❌ Anti-patrones prohibidos

- ❌ `200 OK` con `{"success": false, "error": "..."}`.
- ❌ Secrets hardcoded en repo (incluso privado).
- ❌ `Access-Control-Allow-Origin: *` con `Credentials: true`.
- ❌ JWT con `alg: none` aceptado.
- ❌ SHA-256(password) sin salt ni iteraciones.
- ❌ SQL con concatenación de strings.
- ❌ `dangerouslySetInnerHTML` con input de usuario.
- ❌ Retry infinito sin límite ni backoff.
- ❌ Timeouts default (infinito) en HTTP client.
- ❌ CSRF token en cookie sin verificación server-side.
- ❌ `PUT` que no es idempotente en la implementación.
- ❌ Breaking changes en v1 activa.

---

## 7. Casos reales de la industria (2024-2026)

- **xz-utils backdoor (marzo 2024)** —Andres Freund detectó 500 ms de lag en logins SSH y descubrió un backdoor sofisticado introducido por un maintainer que ganó trust durante años. Aceleró la adopción de SBOM, reproducible builds y scrutiny sobre maintainers de dependencies críticas.

- **OWASP Top 10 2025** (anuncio nov 2025 en Global AppSec Washington, final release enero 2026): basado en análisis de 175.000+ CVEs y 589 CWEs. Nuevas categorías: A03 Software Supply Chain Failures y A10 Mishandling of Exceptional Conditions. SSRF absorbido en A01. Security Misconfiguration sube al #2.

- **Stripe** publica anualmente "Rate limiting at Stripe" e "Idempotent Requests"; su implementación es referencia industrial. En 2024 documentaron cómo su webhook system procesa >1 billón de eventos/mes con at-least-once + client dedup.

- **Log4Shell (dic 2021)** y **SolarWinds (2020)** demostraron que la mayoría de organizaciones no sabían qué versión de qué dependency corría en producción. Impulsaron adopción masiva de SBOM. En 2026, la US Executive Order 14028 lo hace requisito para government contractors.

- **Booking.com CVE-2023** de OAuth `redirect_uri` validation débil permitía account takeover via Facebook Login. Fixed con matching exacto; consolidado en OAuth 2.1 spec.

- **Java Virtual Threads (JEP 444, JDK 21, sept 2023)** en 2026: Spring Boot 3.3+ los soporta nativamente; muchos servicios reemplazan WebFlux/Reactor por código bloqueante síncrono más simple.

- **NIST Post-Quantum Cryptography (agosto 2024)** finalizó los primeros standards (ML-KEM/Kyber, ML-DSA/Dilithium). En 2026, los principales cloud providers ofrecen KEM híbrido en TLS 1.3; servicios financial-grade migran activamente.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — Endpoint con Idempotency-Key + Redis (45-60 min)

**Objetivo**: Implementar el patrón idempotency completo con lock optimista.

**Setup**: `pnpm add fastify ioredis; pnpm add -D vitest testcontainers; docker run -d -p 6379:6379 redis:7`.

**Pasos**:
1. Endpoint `POST /transfers { fromAccount, toAccount, amount, currency }` requiere header `Idempotency-Key` (UUID; rechaza con 400).
2. Flow: check `idem:{userId}:{key}` en Redis → si existe, devolver cache. Si no, set lock `lock:{userId}:{key}` NX EX 30. Si falla → 409 problem+json. Procesa (`setTimeout(200)`), guarda respuesta TTL 24h, libera lock en `finally`.
3. 4 tests: happy path; retry mismo key → cached; request concurrente → 409; key inválido → 400.

**Criterios de aceptación**:
- [ ] Endpoint funcional con Fastify + ioredis.
- [ ] 4 tests pasan en verde con Testcontainers.
- [ ] Errores en formato RFC 7807.
- [ ] Lock TTL configurable por env var.

**Bonus**: Verificar body hash: mismo Idempotency-Key con body distinto → 422 `IDEMPOTENCY_KEY_MISUSE`.

---

### Ejercicio 2 — Auth con OAuth 2.1 + PKCE (60-90 min)

**Objetivo**: Implementar Authorization Code + PKCE flow en cliente SPA.

**Setup**: Keycloak en Docker: `docker run -d -p 8080:8080 -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak:26.0 start-dev`.

**Pasos**:
1. Crea Realm `linguadev`, Client `spa-app` (public, redirect URIs `http://localhost:5173/callback`).
2. SPA (Vite): `generateCodeVerifier()` (43-128 chars random) + `codeChallenge(verifier) = base64url(sha256(verifier))`. Botón Login redirige a `.../auth?response_type=code&code_challenge=...&code_challenge_method=S256&state=...`. Callback extrae `code`, valida `state`, POST a `/token` con `code_verifier`.
3. Endpoint protegido `/api/me` valida Bearer con JWKS del Keycloak.
4. Refresh flow al expirar access_token.

**Criterios de aceptación**:
- [ ] Flow completo end-to-end funcional.
- [ ] `state` validado contra CSRF.
- [ ] Tokens en sessionStorage o cookies HttpOnly (documenta trade-off).
- [ ] Access token expirado se renueva automáticamente.
- [ ] `/api/me` rechaza token inválido con 401 RFC 7807.

**Bonus**: RP-Initiated Logout que invalida sesión en Keycloak.

---

### Ejercicio 3 — Password reset seguro (30-45 min)

**Objetivo**: Implementar reset de password con Argon2id, token de un solo uso, y rate limiting.

**Pasos**:
1. `POST /auth/forgot-password { email }`: siempre devuelve 202 (evita user enumeration). Si email existe, genera token `crypto.randomBytes(32).hex`, guarda hash SHA-256 en DB con expiración 30 min, envía email. Rate limit: 3 / 15 min por email + 10 / 15 min por IP.
2. `POST /auth/reset-password { token, newPassword }`: verifica token no expirado, policy de password (mín 12 chars), hashea con Argon2id, invalida el token, invalida todas las sesiones del usuario.
3. Tests: token expirado → 400; token reutilizado → 400; password débil → 422; rate limit funciona.

**Criterios de aceptación**:
- [ ] User enumeration prevention (mismo response con o sin email).
- [ ] Argon2id con params OWASP 2026.
- [ ] Token de un solo uso.
- [ ] Rate limiting per-email y per-IP.
- [ ] Todas las sesiones invalidadas tras cambio.
- [ ] 4+ tests en verde.

**Bonus**: Email de notificación al user post-reset ("tu password fue cambiada; si no fuiste tú, contacta soporte").

---

### Ejercicio 4 — Prevenir SQL Injection y XSS (30-45 min)

**Objetivo**: Auditar y corregir endpoint vulnerable.

**Setup**: Endpoint deliberadamente vulnerable:

```javascript
// VULNERABLE — corregir
app.get('/search', async (req, reply) => {
  const q = req.query.q;
  const results = await db.raw(`SELECT * FROM products WHERE name LIKE '%${q}%'`);
  return reply.type('text/html').send(
    `<h1>Results for: ${q}</h1><ul>${results.map(r => `<li>${r.name}</li>`).join('')}</ul>`
  );
});
```

**Pasos**:
1. Identifica vulnerabilidades (SQL injection en `q` y XSS reflected).
2. Explota con payloads: SQL `?q=%25' OR 1=1 --`; XSS `?q=<script>alert(document.cookie)</script>`.
3. Corrige: prepared statements (`db.query('... LIKE $1', [`%${q}%`])`), template engine que escapa, header CSP `default-src 'self'; script-src 'self'`.
4. Ejecuta OWASP ZAP baseline antes y después: `docker run -t owasp/zap2docker-stable zap-baseline.py -t http://host.docker.internal:3000`.

**Criterios de aceptación**:
- [ ] Ambos exploits reproducibles antes del fix, fallan después.
- [ ] ZAP baseline no reporta HIGH ni MEDIUM.
- [ ] Test que ejecuta payloads XSS/SQL como input y verifica escape.

**Bonus**: CSP report-only, recolecta violations en `/csp-report`, luego endurece.

---

### Ejercicio 5 — Webhook receiver con HMAC + idempotency (45-60 min)

**Objetivo**: Implementar un receiver de webhooks robusto tipo Stripe.

**Pasos**:
1. Endpoint `POST /webhooks/orders` recibe eventos `order.paid`, `order.refunded`.
2. Valida firma HMAC del header `X-Signature: t=<ts>,v1=<hex>`: `signed_payload = timestamp + "." + raw_body`; `expected = hmac_sha256(secret, signed_payload)`; constant-time compare; rechaza si timestamp >5 min (replay protection).
3. Extrae `event_id` del payload; check Redis; si ya procesado → 200 sin re-procesar. Si no → guarda con TTL 30 días.
4. Procesa el evento y retorna 200 (el sender reintentará solo con 5xx).
5. Tests: firma correcta → 200; incorrecta → 401; timestamp viejo → 401; mismo `event_id` dos veces → dedup.

**Criterios de aceptación**:
- [ ] Firma HMAC validada con `crypto.timingSafeEqual`.
- [ ] Replay protection y dedup por `event_id` funcionales.
- [ ] 4+ tests en verde.
- [ ] Logs estructurados con event type, event_id, duration.

**Bonus**: Implementa DLQ en Redis para retries manuales desde endpoint admin.

---

## 9. Recursos + siguientes pasos

### Referencias esenciales
- **OWASP Cheat Sheets Series**, **OWASP Top 10 2025**.
- **RFC 9110** HTTP Semantics; **RFC 7519** JWT; **RFC 7807** Problem Details.
- **OAuth 2.1 draft**, **OpenID Connect Core 1.0**.
- **SLSA Framework** (supply chain); **Sigstore** (signed artifacts).

### Libros
- Michael Nygard, *Release It!* 2ª ed. (2018).
- Sam Newman, *Building Microservices* 2ª ed. (2021).
- Michal Zalewski, *The Tangled Web* (2011).
- Alex Xu, *System Design Interview* series (2020-2024).
- Adam Shostack, *Threat Modeling* (2014).

### Herramientas 2026
- **APIs**: Fastify, NestJS (Node); FastAPI (Python); Spring Boot + Loom (Java); Go gin/chi; ASP.NET Core.
- **Auth**: Auth0, Cognito, Keycloak, Ory, WorkOS.
- **Rate limiting**: Redis + Lua, Envoy, Kong, Cloudflare.
- **Secrets**: HashiCorp Vault, AWS Secrets Manager, 1Password Secrets Automation, SOPS + KMS.
- **Security testing**: OWASP ZAP, Burp Suite, Semgrep (SAST), Snyk (SCA), Dependabot, Trivy (containers).
- **Contract testing**: Pact, Schemathesis.
- **Observability**: OpenTelemetry, Grafana, Datadog, Honeycomb.

### Siguientes pasos en el track
- Vuelve a [Cap 04 — testing y refactor](./04-testing-y-refactor.md) para aplicar contract testing con Pact sobre los endpoints de este capítulo.
- Continúa con [Cap 06 — memoria y GC](./06-memoria-y-gc.md) para entender cómo tu servidor consume recursos en producción.
- Practica con proyectos open source: Fastify plugins, Spring Boot samples, FastAPI templates. Todos tienen ejemplos de authentication, rate limiting, error handling profesionales.

---

## 10. Preguntas de práctica

Las 20 preguntas del simulacro cubren: HTTP status codes, REST vs GraphQL vs gRPC, idempotencia con Idempotency-Key, password hashing con Argon2id, SQL injection y prepared statements, versioning de APIs, JWT (usos correctos y ataques), pagination cursor vs offset, CSRF y cookies, XSS y CSP, rate limiting (fixed/sliding/token bucket), diseño REST, secrets management, OAuth 2.0 y OIDC, error responses (RFC 7807), CORS, webhooks con HMAC, OWASP Top 10, timeouts y circuit breakers, y supply chain security.

- **Sim JSON**: [`packages/content/src/tech/programmer/sim-05-apis-and-security.json`](../../packages/content/src/tech/programmer/sim-05-apis-and-security.json)
- **Ruta en la app**: `/practice/programmer/programmer-sim-05-apis-and-security`
- **Tiempo estimado**: 22 min · **Pass**: 75% (15/20 correctas)

Recomendación: haz el simulacro **antes** de los ejercicios prácticos para ver dónde tienes gaps; y **de nuevo** después. Presta especial atención a las preguntas de multi-select (Q2, Q7, Q11, Q13, Q17, Q18, Q19, Q20): tienen varias respuestas correctas y son las más discriminantes.

---

## Navegación

- [Índice](./README.md)
- Anterior: [Cap 04 — testing y refactor](./04-testing-y-refactor.md)
- Siguiente: [Cap 06 — memoria y GC →](./06-memoria-y-gc.md)
