# Capítulo 28 — CDN y Edge Computing

> **Focus:** El último kilómetro de latencia. Cómo funcionan los CDN modernos (CloudFront, Cloudflare, Fastly, Akamai), estrategias de cache (TTL, `Cache-Control`, `Vary`, `stale-while-revalidate`), invalidación (purge vs cache-busting vs surrogate keys), edge computing programable (Cloudflare Workers, AWS Lambda@Edge, CloudFront Functions, CloudFront KeyValueStore, Fastly Compute@Edge en WebAssembly), image optimization at edge, WAF integration y DDoS protection L3/L4/L7.
> **Áreas:** Networking · Performance · Security
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- HTTP fundamentals: request/response, headers, status codes, HTTP/1.1 vs HTTP/2 vs HTTP/3.
- DNS y load balancing (ver [cap 27 — DNS y load balancing](./27-dns-y-load-balancing.md)).
- TLS handshake, certificate management.
- Networking: BGP básico, Anycast.
- Cloud fundamentals: AWS/GCP/Azure regiones y edge locations.

**Glosario mínimo:**
- **CDN** (Content Delivery Network): red de servidores caché distribuidos geográficamente. Origina en Akamai 1998; hoy CloudFront (450+ edge locations), Cloudflare (330+ cities), Fastly (~80 PoPs high-performance), Akamai (~4000+ PoPs), Bunny.net, Gcore.
- **PoP** (Point of Presence): datacenter edge del CDN. Anuncia mismo IP vía Anycast; BGP enruta al más cercano.
- **Origin**: tu servidor real. El CDN cachea copias que sirve desde los PoPs.
- **Cache HIT / MISS**: HIT = objeto en PoP, sirve inmediatamente. MISS = PoP debe pedir al origin.
- **CHR** (Cache Hit Ratio): HITs / requests totales. Métrica clave. Bien configurado 80-95%; excelente >95%.
- **Cache-Control**: header HTTP que gobierna caching. Directivas: `max-age`, `s-maxage`, `public`, `private`, `no-store`, `no-cache`, `immutable`, `stale-while-revalidate` (SWR), `stale-if-error`.
- **`Vary` header**: indica qué request headers deben incluirse en la cache key (`Vary: Accept-Encoding`, `Vary: Accept-Language`).
- **Cache key**: identificador único con el que el CDN busca objetos. Default = URL; puede incluir headers/cookies/query params.
- **Purge / Invalidation**: forzar al CDN a marcar objetos como stale inmediatamente. Alternativa: cache-busting por hash en URL.
- **Surrogate keys** (Fastly), **Cache-Tag** (Cloudflare Enterprise): etiquetar objetos con tags para invalidación granular.
- **Origin shield / tiered cache**: capa intermedia entre edge y origin que agrega requests, aumenta CHR global.
- **Edge functions**: JS/WASM que corre en el PoP. Cloudflare Workers, AWS Lambda@Edge, CloudFront Functions, Fastly Compute@Edge.
- **WAF** (Web Application Firewall): filtra requests HTTP maliciosos (SQLi, XSS, OWASP Top 10) en el edge.
- **DDoS**: Distributed Denial of Service. L3/L4 (volumetric, SYN flood, UDP amplification) vs L7 (HTTP flood, slowloris).
- **Anycast**: mismo IP anunciado desde múltiples PoPs vía BGP. Base de CDN modernos y DNS público.

**Setup mínimo:**

```bash
# 1. AWS CLI + Terraform (CloudFront + KeyValueStore)
aws --version   # 2.17+
terraform version   # 1.9+

# 2. Wrangler (Cloudflare Workers CLI)
npm install -g wrangler
wrangler --version   # 3.100+
wrangler login

# 3. Fastly CLI
brew install fastly/tap/fastly
fastly compute init

# 4. curl con headers verbose
curl -svo /dev/null https://linguadev.app/index.html 2>&1 | grep -E "^(<|>)"

# 5. httping para latency
sudo apt install httping
httping -c 20 -G https://linguadev.app

# 6. WebPageTest CLI
npm install -g webpagetest
webpagetest test https://linguadev.app --location "Dulles:Chrome" --runs 3

# 7. Lighthouse CI
npm install -g @lhci/cli
lhci autorun --collect.url=https://linguadev.app
```

---

## 1. El gran cuadro

Cuando un usuario en Tokyo pide `/logo.png` a un servidor en `us-east-1`, el RTT (Round Trip Time) es ~180ms. Multiplicá eso por cuarenta requests para cargar una página web moderna (HTML + CSS + JS bundles + fuentes + imágenes + APIs) y obtenés 7-8 segundos solo de latencia de red — antes de que el navegador empiece a renderizar. Un **CDN** invierte este cálculo: cachea copias del contenido en cientos de PoPs distribuidos globalmente; el user en Tokyo va al PoP de Tokyo/Osaka (~5ms) en vez del origin (~180ms), y las cuarenta requests colapsan a 200-400ms totales. La ganancia percibida es dramática: sitios pasan de "lentos y frustrantes" a "instantáneos". Y todo con un componente stateless que se puede activar en minutos con casi cero cambios de código.

El CDN moderno combina cuatro elementos. Primero, **PoPs distribuidos globalmente** — CloudFront tiene 450+ edge locations, Cloudflare 330+ cities, Fastly ~80 PoPs high-performance con hardware masivo, Akamai ~4000+ PoPs históricos, y newcomers como Bunny.net y Gcore compiten en pricing agresivo. Segundo, **Anycast routing con BGP**: el mismo IP se anuncia desde todos los PoPs, y las rutas BGP del internet convergen a que cada usuario vaya al más cercano en topología de red. Tercero, **TLS y TCP terminados en el edge**: el handshake TLS 1.3 con el PoP local reduce dramáticamente el warm-up de conexión; el CDN mantiene una conexión persistente al origin para servir MISSes. Cuarto, **cache hierarchy con origin shield / tiered cache**: un PoP intermedio agrega requests de múltiples edges antes de pegarle al origin, aumentando CHR global y reduciendo carga del origin en 5-10x.

La disciplina de operar un CDN se reduce a tres cosas: **maximizar cache hit ratio**, **invalidar correctamente** y **elegir qué corre en el edge**. CHR es la métrica número uno: 60% es bajo y grita mala config (TTLs cortos, cookies contaminando responses, query strings dinámicos rompiendo la cache key, `Vary` excesivo); 80-95% es objetivo típico; >95% es excelente (Wikipedia sirve 95%+ de sus pageviews desde Varnish edge). Invalidación es "una de las dos cosas difíciles en computer science": estrategias van desde `cache-busting por hash de contenido` (assets con `main.abc123.js` inmutables, la solución dominante frontend moderno), `TTL corto + SWR` (para HTML), `surrogate keys` (Fastly/Cloudflare Enterprise: etiquetás objetos con tags como `product-123 category-42` e invalidás por tag), hasta `purge quirúrgico` para hotfixes y `purge global` como último recurso — Fastly es famoso por su instant purge sub-segundo, pero el mismo mecanismo que te salva puede amplificar errores (outage global 8 junio 2021).

El eje que definió los últimos años es el **edge computing programable**. Cloudflare Workers (V8 isolates, JavaScript/TypeScript/Rust vía WASM, zero cold starts, ~50ms wall time free tier), AWS Lambda@Edge (Node.js/Python, más pesado ~100-500ms), CloudFront Functions (JavaScript ultra-ligero, <1ms, para request/response rewrites simples), CloudFront KeyValueStore (KV distribuido global, GA 2024, para feature flags/redirects/A-B test config sin external API calls), y Fastly Compute@Edge (WebAssembly, Rust/Go/JS/AssemblyScript, sub-ms). Estos runtimes ejecutan lógica en el PoP: A/B testing, personalization, geo routing, JWT validation, image transformation, edge-side authentication, bot detection. La ganancia es doble: latencia (no round-trip al origin) y coste (menos cómputo en el origin). En 2026, Cloudflare Workers domina en developer experience, AWS Lambda@Edge en integración con el resto del ecosystem AWS, y Fastly Compute en performance pura para casos high-throughput. Este capítulo cubre los mecanismos, los patterns, y termina con ejercicios sobre LinguaDev Pro implementando cada uno.

---

## 2. Cache fundamentals: HIT/MISS, CHR, Cache-Control (nivel básico)

### 2.1 Cómo funciona un CDN internamente

Flujo completo de una request:

1. Usuario en Tokyo pide `https://linguadev.app/js/main.abc123.js`.
2. DNS resuelve `linguadev.app` a un IP anycast del CDN (CloudFront/Cloudflare/Fastly).
3. BGP enruta el packet al PoP más cercano (Tokyo).
4. El PoP termina TLS 1.3 (~5ms handshake vs ~180ms al origin).
5. El PoP busca en cache local. Cache key = URL + query params + headers en `Vary`.
6. **HIT**: sirve inmediatamente (~1-5ms).
7. **MISS**: el PoP hace request al origin (o al **origin shield** intermedio). Si origin shield hace HIT, sirve al PoP; si origin shield hace MISS, va al origin. El PoP cachea la respuesta según `Cache-Control` y la sirve.
8. Response llega al usuario ~10-50ms desde PoP local.

### 2.2 Cache Hit Ratio: la métrica clave

CHR = HITs / (HITs + MISSes). Objetivo típico: 80-95%. Un CHR de 60% significa que 40% del traffic llega al origin — casi como no tener CDN.

**Causas comunes de CHR bajo**:
- TTLs cortos en assets que podrían ser inmutables (`main.abc123.js` con TTL de 5min en vez de 1 año).
- **URLs con query params variables**: `?utm_source=...&fbclid=...&v=timestamp` rompe la cache key porque cada URL parece "única".
- `Cache-Control: no-store` o `private` en respuestas que serían cacheables.
- `Vary: User-Agent`: cada navegador (Chrome, Firefox, Edge, mobile Chrome) obtiene entrada separada. Explosión combinatoria.
- Origin devuelve `Set-Cookie` en assets estáticos (algunos CDNs no cachean con Set-Cookie).
- No usar origin shield / tiered cache → cada PoP fetcha independientemente del origin.

**Optimizaciones**:
- Normalizá cache keys: excluir `utm_*`, `fbclid`, `gclid` del cache key.
- TTLs largos para assets con hash (`main.abc123.js` → `Cache-Control: public, max-age=31536000, immutable`).
- TTLs cortos + `stale-while-revalidate` para HTML.
- Evitar `Vary: User-Agent`; preferir device-type detection en edge function.
- Habilitar origin shield (CloudFront) o Argo Tiered Cache (Cloudflare).

### 2.3 Cache-Control headers en profundidad

Cache-Control governance directivas (HTTP RFC 9111, revisión 2022):

| Directiva | Efecto |
|---|---|
| `max-age=N` | Fresh durante N segundos para browser + CDN. |
| `s-maxage=N` | Igual para shared caches (CDN); override `max-age`. |
| `public` | Cacheable en shared caches (CDN). |
| `private` | Solo cache privado (browser); CDN debe skip. |
| `no-cache` | Cacheable pero DEBE revalidar antes de servir. |
| `no-store` | No cachear en ningún lado. |
| `immutable` | El objeto nunca cambia; browser no revalida nunca. |
| `stale-while-revalidate=N` | Servir stale hasta N segundos mientras revalida en background. |
| `stale-if-error=N` | Servir stale hasta N segundos si origin devuelve error. |
| `must-revalidate` | Prohíbe servir stale sin revalidar. |

**Config canónica moderna**:

Assets con hash (immutable):
```
Cache-Control: public, max-age=31536000, immutable
```

HTML dinámico pero cacheable brevemente:
```
Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400
```

API responses (por-usuario):
```
Cache-Control: private, no-store
```

APIs cacheables (leaderboards, top posts):
```
Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=300
Surrogate-Key: leaderboard global-stats
```

### 2.4 SWR (stale-while-revalidate): el patrón moderno

`stale-while-revalidate` permite servir la respuesta stale inmediatamente mientras el CDN revalida en background. Elimina la "cliff" de latencia al expirar el cache — sin SWR, un request que pega justo al expirar debe esperar el fetch al origin (~200ms); con SWR, sirve stale en <5ms y el próximo request ya tendrá el nuevo.

```
Cache-Control: max-age=60, stale-while-revalidate=600
```

Timeline:
- t=0 a t=60: fresh, sirve HIT rápido.
- t=61 a t=660: stale pero servible; sirve stale + trigger revalidation background.
- t=661+: expired hard, próximo request debe esperar fetch.

Cloudflare, Fastly, CloudFront (con extensiones) soportan SWR. Es el patrón dominante para HTML en 2026.

---

## 3. Invalidación: purge, cache-busting, surrogate keys (nivel medio)

### 3.1 Estrategias en orden de preferencia

1. **Cache-busting por hash**: cambiás el nombre del archivo (`main.js` → `main.abc123.js`). El HTML apunta al nuevo hash; el viejo queda cacheado sin problema. Sin invalidations, sin race conditions. Es el patrón dominante en frontend moderno (webpack, Vite, Turbopack, Next.js). TTL largo (1 año) sin miedo.

2. **Surrogate keys / Cache-Tag**: etiquetás objetos con tags en response header. Al actualizar un producto, purgás por tag y todos los objetos etiquetados se invalidan atómicamente. Ideal para e-commerce donde editar un producto debe invalidar homepage + categoría + producto + APIs relacionadas simultáneamente.

   ```
   HTTP/1.1 200 OK
   Cache-Control: public, s-maxage=3600
   Surrogate-Key: product-123 category-42 homepage
   ```

   Purge:
   ```bash
   # Fastly
   curl -X POST -H "Fastly-Key: <token>" \
     "https://api.fastly.com/service/<sid>/purge/product-123"

   # Cloudflare Enterprise
   curl -X POST "https://api.cloudflare.com/client/v4/zones/<zid>/purge_cache" \
     -H "Authorization: Bearer <token>" \
     --data '{"tags":["product-123"]}'
   ```

3. **TTL corto + SWR**: para HTML y API responses.

4. **Purge quirúrgico por URL**: para hotfixes específicos.

   ```bash
   # CloudFront
   aws cloudfront create-invalidation \
     --distribution-id E123ABC \
     --paths "/blog/2026/critical-post.html"

   # Cloudflare
   curl -X POST "https://api.cloudflare.com/client/v4/zones/<zid>/purge_cache" \
     -H "Authorization: Bearer <token>" \
     --data '{"files":["https://linguadev.app/blog/2026/critical-post.html"]}'
   ```

5. **Purge global**: último recurso. Cloudflare "Purge Everything", Fastly "purge all", CloudFront `/*`. Peligroso: causa **cache stampede** al origin (todos los edges MISSean simultáneamente). Fastly outage 8 junio 2021 fue básicamente esto.

### 3.2 Costos de invalidación

- CloudFront: 1000 invalidations gratis/mes, luego $0.005 por path.
- Cloudflare: purge por URL gratis en todos los planes; purge by tag Enterprise-only.
- Fastly: instant purge gratis, sub-150ms globalmente (feature marquee).
- Akamai: variable por contract.

**Best practice**: minimizá purges usando cache-busting + surrogate keys. Purge manual solo para hotfixes.

### 3.3 Cache stampede (thundering herd)

Scenario: hot content con TTL 60s + 10k req/s. Cuando expira, 10k requests simultáneos pegan al origin porque ninguno tiene cache warm. El origin se satura, timeouts, cascading failure.

**Mitigaciones**:
- **stale-while-revalidate**: sirve stale mientras se revalida (solo 1 request va al origin).
- **Request coalescing**: el CDN detecta que hay 10k requests iguales pendientes al origin, hace 1 request, y responde a los 10k con la misma respuesta. Fastly y Cloudflare lo hacen nativo. CloudFront tiene "Origin Shield" similar.
- **Jitter en TTLs**: en vez de TTL=60 fijo, usá TTL en rango [45, 75] para desincronizar expirations.
- **Warm cache**: pre-fetch antes de expirar (cronjob).

---

## 4. Edge computing: Workers, Lambda@Edge, Fastly Compute, KeyValueStore (nivel avanzado)

### 4.1 Cloudflare Workers

**Cloudflare Workers** ejecuta JS/TS/Rust/Python (via WASM) en 330+ cities con **V8 isolates** (no containers, no VMs): zero cold starts, isolate startup en microsegundos. Free tier generoso (100k requests/día, 10ms CPU por request). Modelo de programación estilo Service Worker (`fetch` handler). Ecosystem completo: **Workers KV** (eventually-consistent global KV), **Durable Objects** (stateful coordination con strong consistency), **D1** (SQLite serverless), **R2** (object storage S3-compatible, sin egress fees), **Queues**, **Pub/Sub**, **Cron Triggers**, **Workers AI**.

Ejemplo Worker: A/B testing con Workers KV para experiment config:

```javascript
// wrangler.toml declara binding EXPERIMENTS
// [[kv_namespaces]]
// binding = "EXPERIMENTS"
// id = "abc123..."

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Solo aplicar A/B a /pricing
    if (url.pathname !== "/pricing") {
      return fetch(request);
    }

    // Sticky bucket via cookie
    let bucket = getCookie(request, "ab_bucket");
    if (!bucket) {
      // Determinar bucket con hash de IP + user-agent
      const ip = request.headers.get("cf-connecting-ip") || "";
      const ua = request.headers.get("user-agent") || "";
      const hash = await sha256(ip + ua);
      const rand = parseInt(hash.slice(0, 8), 16) / 0xffffffff;
      bucket = rand < 0.5 ? "control" : "variant";
    }

    // Fetch experiment config desde KV (cache <100ms globally)
    const config = await env.EXPERIMENTS.get("pricing-2026", {
      type: "json",
      cacheTtl: 300,
    });

    // Rewrite URL según bucket
    const backendUrl = new URL(request.url);
    backendUrl.pathname = bucket === "variant"
      ? config.variantPath
      : config.controlPath;

    const response = await fetch(backendUrl.toString(), request);

    // Clonar y añadir headers de telemetría + cookie sticky
    const newResp = new Response(response.body, response);
    newResp.headers.set("Set-Cookie",
      `ab_bucket=${bucket}; Path=/; Max-Age=2592000; SameSite=Lax`);
    newResp.headers.set("X-AB-Bucket", bucket);
    newResp.headers.set("Cache-Control", "private, no-store");

    // Emitir evento analytics via ctx.waitUntil (no bloquea response)
    ctx.waitUntil(
      fetch("https://analytics.linguadev.app/event", {
        method: "POST",
        body: JSON.stringify({
          bucket,
          path: url.pathname,
          ts: Date.now(),
        }),
      })
    );

    return newResp;
  },
};

function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp(`${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
```

Deploy:

```bash
wrangler kv namespace create EXPERIMENTS
wrangler kv key put --binding=EXPERIMENTS "pricing-2026" \
  '{"controlPath":"/pricing-v1.html","variantPath":"/pricing-v2.html"}'
wrangler deploy
```

### 4.2 AWS Lambda@Edge + CloudFront Functions + KeyValueStore

**CloudFront Functions**: JavaScript ultra-ligero (subset ECMAScript 5.1), <1ms wall time, ideal para request/response rewrites (URL rewrites, header manipulation, redirects, JWT check simple). No puede hacer network calls externas. Free tier 2M invocations/mes.

**Lambda@Edge**: Node.js/Python full runtime, hasta 5s timeout, puede hacer network calls, integra con toda AWS. Latencia 100-500ms típica. Más caro.

**CloudFront KeyValueStore** (GA 2024): KV distribuido globalmente, low-latency reads desde CloudFront Functions, actualizaciones propagan en segundos. Para redirects tables, feature flags, A/B config, geo maps, sin requerir external API call.

CloudFront Function con KeyValueStore para redirect table:

```javascript
// cf-function-redirects.js
import cf from 'cloudfront';

// Handle del KVS declarado en el resource
const kvsHandle = cf.kvs("<kvs-id-arn>");

async function handler(event) {
  const request = event.request;
  const uri = request.uri;

  try {
    // Buscar redirect en KVS. Retorna undefined si no existe.
    const targetUrl = await kvsHandle.get(uri);

    if (targetUrl) {
      return {
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: {
          'location': { value: targetUrl },
          'cache-control': { value: 'public, max-age=86400' },
        },
      };
    }
  } catch (e) {
    // Key not found - continuar al origin
  }

  return request;
}
```

Terraform completo con KVS + Function + Distribution:

```hcl
resource "aws_cloudfront_key_value_store" "redirects" {
  name = "linguadev-redirects"
  comment = "Redirect table for legacy URLs"
}

resource "aws_cloudfront_function" "redirects" {
  name    = "redirects-viewer"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/cf-function-redirects.js")

  key_value_store_associations = [
    aws_cloudfront_key_value_store.redirects.arn
  ]
}

resource "aws_cloudfront_distribution" "linguadev" {
  origin {
    domain_name = aws_lb.web.dns_name
    origin_id   = "web-alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2", "TLSv1.3"]
    }

    # Origin Shield en la region más cercana al origin
    origin_shield {
      enabled              = true
      origin_shield_region = "us-east-1"
    }
  }

  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  aliases         = ["linguadev.app", "www.linguadev.app"]

  default_cache_behavior {
    target_origin_id       = "web-alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = aws_cloudfront_cache_policy.default.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.default.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.redirects.arn
    }
  }

  # Behavior para assets con hash: TTL 1 año
  ordered_cache_behavior {
    path_pattern           = "/static/*"
    target_origin_id       = "web-alb"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    min_ttl     = 31536000
    default_ttl = 31536000
    max_ttl     = 31536000
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.linguadev.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  web_acl_id = aws_wafv2_web_acl.cloudfront.arn

  logging_config {
    bucket          = "${aws_s3_bucket.cf_logs.bucket_domain_name}"
    prefix          = "cf/"
    include_cookies = false
  }

  price_class = "PriceClass_All"    # todas las locations globales
}
```

### 4.3 Fastly Compute@Edge (WebAssembly)

Fastly Compute@Edge ejecuta WebAssembly (Rust/Go/JS/AssemblyScript). Sub-ms startup, memory isolation vía WASM. Ideal para high-throughput sub-ms latency.

Rust example: geo routing + header manipulation:

```rust
// src/main.rs
use fastly::http::{header, StatusCode};
use fastly::{Error, Request, Response};

#[fastly::main]
fn main(mut req: Request) -> Result<Response, Error> {
    let country = req
        .get_client_geo_data()
        .and_then(|g| g.country_code().map(str::to_string))
        .unwrap_or_default();

    // Redirect EU users a subdomain regional
    if ["DE","FR","IT","ES","NL","PL","SE","BE","AT"].contains(&country.as_str()) {
        if !req.get_url_str().contains("eu.linguadev.app") {
            let target = format!(
                "https://eu.linguadev.app{}",
                req.get_url().path()
            );
            return Ok(Response::from_status(StatusCode::TEMPORARY_REDIRECT)
                .with_header(header::LOCATION, target)
                .with_header(header::CACHE_CONTROL, "public, max-age=60"));
        }
    }

    // Añadir country a request headers for backend analytics
    req.set_header("X-Client-Country", country.clone());

    // Forward al origin
    let mut resp = req.send("linguadev_origin")?;

    // Añadir security headers
    resp.set_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    resp.set_header("X-Content-Type-Options", "nosniff");
    resp.set_header("X-Frame-Options", "DENY");
    resp.set_header("X-Detected-Country", country);

    Ok(resp)
}
```

### 4.4 Comparación runtimes edge 2026

| Feature | Cloudflare Workers | CloudFront Functions | Lambda@Edge | Fastly Compute |
|---|---|---|---|---|
| Runtime | V8 isolates | JS light (ES 5.1 subset) | Node/Python | WebAssembly |
| Startup | µs (zero cold) | <1ms | 100-500ms cold | µs (WASM) |
| Wall time free tier | 10ms CPU | 1ms | N/A | N/A |
| Network calls externas | ✅ | ❌ | ✅ | ✅ |
| Storage global | Workers KV, D1, R2, DO | KeyValueStore | DynamoDB Global | Config Store |
| Lenguajes | JS/TS, Rust, Python (beta) | JS subset | Node, Python | Rust, Go, JS, AssemblyScript |
| PoPs (2026) | 330+ cities | 450+ edge locations | 450+ | ~80 high-performance |
| P50 latency US-East | 8-12ms | 12-18ms | ~40ms | 10-15ms |
| Pricing free | 100k req/día | 2M invocations/mes | Pay only | Pay only |
| Ideal use case | Full-featured edge apps | URL/header rewrites, redirects | AWS-native ecosystem | High-throughput sub-ms |

---

## 5. Ejemplo práctico: LinguaDev Pro con CloudFront + KeyValueStore + WAF

Setup completo: origin ALB en `us-east-1` con backends multi-región (ver cap 27), CloudFront delante con optimal cache config, WAF + shield, KeyValueStore para feature flags, CloudFront Function para geo redirect, Lambda@Edge para JWT validation, monitoring.

### Paso 1: cache policies optimales

```hcl
resource "aws_cloudfront_cache_policy" "default" {
  name        = "linguadev-default"
  min_ttl     = 0
  default_ttl = 60
  max_ttl     = 86400

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    query_strings_config {
      query_string_behavior = "whitelist"
      query_strings { items = ["v", "locale", "theme"] }
    }
    headers_config {
      header_behavior = "whitelist"
      headers { items = ["Authorization", "CloudFront-Viewer-Country"] }
    }
    cookies_config {
      cookie_behavior = "none"
    }
  }
}

resource "aws_cloudfront_cache_policy" "static_assets" {
  name        = "linguadev-static"
  min_ttl     = 31536000
  default_ttl = 31536000
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
    query_strings_config { query_string_behavior = "none" }
    headers_config       { header_behavior       = "none" }
    cookies_config       { cookie_behavior       = "none" }
  }
}
```

### Paso 2: response headers security policy

```hcl
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "linguadev-security"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.linguadev.app; frame-ancestors 'none';"
      override = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "geolocation=(), microphone=(), camera=()"
      override = true
    }
  }
}
```

### Paso 3: WAF con managed rules + rate limiting

```hcl
resource "aws_wafv2_web_acl" "cloudfront" {
  provider    = aws.us_east_1     # WAF para CloudFront debe estar en us-east-1
  name        = "linguadev-cf-waf"
  scope       = "CLOUDFRONT"

  default_action { allow {} }

  # Managed rules: OWASP Top 10
  rule {
    name     = "AWS-CommonRuleSet"
    priority = 1
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common-ruleset"
      sampled_requests_enabled   = true
    }
  }

  # Bot control
  rule {
    name     = "AWS-BotControl"
    priority = 2
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesBotControlRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "bot-control"
      sampled_requests_enabled   = true
    }
  }

  # Rate limiting: 2000 req/5min por IP
  rule {
    name     = "RateLimit"
    priority = 10
    action { block {} }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "linguadev-cf-waf"
    sampled_requests_enabled   = true
  }
}
```

### Paso 4: Lambda@Edge para JWT validation en /api/*

```javascript
// lambda-edge-jwt.js
import { createVerify } from 'crypto';

const PUBLIC_KEY_PEM = process.env.JWT_PUBLIC_KEY;

export const handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;

  const authHeader = headers.authorization?.[0]?.value;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      status: '401',
      statusDescription: 'Unauthorized',
      body: JSON.stringify({ error: 'missing_token' }),
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'application/json' }],
      },
    };
  }

  const token = authHeader.slice(7);
  const [headerB64, payloadB64, sigB64] = token.split('.');

  // Verify signature RSA-SHA256
  const data = `${headerB64}.${payloadB64}`;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(data);
  const valid = verifier.verify(PUBLIC_KEY_PEM, sigB64, 'base64url');

  if (!valid) {
    return {
      status: '401',
      body: JSON.stringify({ error: 'invalid_signature' }),
    };
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url'));
  if (payload.exp < Date.now() / 1000) {
    return {
      status: '401',
      body: JSON.stringify({ error: 'expired' }),
    };
  }

  // Inyectar user info al origin request
  headers['x-user-id'] = [{ key: 'X-User-ID', value: payload.sub }];
  headers['x-tenant-id'] = [{ key: 'X-Tenant-ID', value: payload.tenant }];

  return request;
};
```

### Paso 5: monitoring y alertas

```hcl
resource "aws_cloudwatch_metric_alarm" "low_cache_hit_ratio" {
  alarm_name          = "cf-low-chr"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CacheHitRate"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Average"
  threshold           = 0.80
  alarm_description   = "CHR under 80% - investigate cache config"
  dimensions = {
    DistributionId = aws_cloudfront_distribution.linguadev.id
    Region         = "Global"
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "high_origin_latency" {
  alarm_name          = "cf-high-origin-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "OriginLatency"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "p99"
  threshold           = 500
  dimensions = {
    DistributionId = aws_cloudfront_distribution.linguadev.id
    Region         = "Global"
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}
```

### Paso 6: verificación end-to-end

```bash
# Cache HIT verification
curl -svo /dev/null https://linguadev.app/static/main.abc123.js 2>&1 \
  | grep -Ei "x-cache|age|cache-control"
# < x-cache: Hit from cloudfront
# < age: 4523
# < cache-control: public, max-age=31536000, immutable

# WAF block test (SQLi)
curl -i "https://linguadev.app/?id=1' OR '1'='1"
# HTTP/2 403

# Rate limit test
for i in {1..3000}; do curl -so /dev/null -w "%{http_code}\n" https://linguadev.app/; done | sort | uniq -c
# 2000 200
# 1000 429

# CHR check
aws cloudwatch get-metric-statistics --namespace AWS/CloudFront \
  --metric-name CacheHitRate --dimensions Name=DistributionId,Value=E123 Name=Region,Value=Global \
  --start-time $(date -u -d "1 hour ago" +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 300 --statistics Average
```

---

## 6. Cheatsheet + reglas mentales + anti-patterns

### Reglas de oro

- ✅ **Cache-busting por hash** para assets (`main.abc123.js`) + `Cache-Control: public, max-age=31536000, immutable`.
- ✅ **TTL corto + SWR** para HTML dinámico (`max-age=60, stale-while-revalidate=3600`).
- ✅ **`Cache-Control: private, no-store`** para API responses per-user.
- ✅ **CHR objetivo >80%** en apps productivas; alertar si baja.
- ✅ **Origin shield / tiered cache** habilitado para reducir carga origin.
- ✅ **WAF asociado** al CDN en apps públicas (managed rules + rate limiting).
- ✅ **Access logs** a S3/GCS y export a SIEM para forensics.
- ✅ **HTTPS only** con TLS 1.2+ (idealmente TLS 1.3).
- ✅ **HTTP/3 (QUIC)** habilitado (soportado en CloudFront desde 2024).
- ✅ **Brotli + gzip** compression en cache key.
- ✅ **Security headers policy**: HSTS, CSP, X-Content-Type-Options, Referrer-Policy.
- ✅ **Cache key normalization**: excluir `utm_*`, `fbclid`, `gclid`.
- ✅ **Surrogate keys** para invalidation granular (Fastly / CF Enterprise).
- ✅ **Edge functions** para lógica ligera (redirects, A/B, JWT validation, geo).
- ✅ **KeyValueStore** (CloudFront) o Workers KV (Cloudflare) para config dinámica en edge.
- ✅ **Monitoring**: alertas en CHR bajo + origin latency alta + error rate.

### Anti-patterns

- ❌ **CHR bajo (<60%)** por Set-Cookie en assets o query params variables.
- ❌ **Purge global frecuente** → cache stampede al origin.
- ❌ **Sin SWR** en HTML dinámico → latency cliff al expirar.
- ❌ **TTL corto en assets con hash** → desperdicio de caching.
- ❌ **`Vary: User-Agent`** → explosión combinatoria de cache entries.
- ❌ **Sin WAF** en app público → OWASP Top 10 vulnerable.
- ❌ **Sin rate limiting** → DDoS L7 tumba el origin.
- ❌ **Sin origin shield** → cada PoP MISSea independientemente.
- ❌ **Sin HTTP/3** en 2026 → 15-25% latency penalty vs competidores.
- ❌ **Lambda@Edge para tareas simples** que CloudFront Functions haría → 100x más caro y lento.
- ❌ **Config CDN en la consola** sin IaC → drift + no rollback.
- ❌ **Sin access logs** → forensics imposible.
- ❌ **Ignore GeoRestriction** cuando debés compliance data residency.
- ❌ **Cache privado** (sin CDN) para contenido que sería cacheable.
- ❌ **TLS 1.0/1.1** habilitados.
- ❌ **Confiar en CDN como único DDoS mitigation** sin AWS Shield Advanced / Cloudflare Enterprise.

### Tabla decisión edge runtime

| Necesidad | Runtime |
|---|---|
| URL rewrite, redirect table, header manipulation | **CloudFront Functions** (o CF Function CDN) |
| Feature flag/A-B config en edge | **CloudFront KeyValueStore** o **Cloudflare Workers KV** |
| JWT validation, geo routing, personalization | **Cloudflare Workers** o **Lambda@Edge** |
| Full app en edge (SSR, APIs, DB) | **Cloudflare Workers + D1 + R2** o **Fastly Compute** |
| Sub-ms high-throughput WASM | **Fastly Compute@Edge** |
| AWS-native ecosystem integration | **Lambda@Edge + KeyValueStore** |
| Image optimization at edge | **Cloudflare Images**, **Vercel Image**, **AWS Lambda@Edge** |

### Tabla decisión CDN provider 2026

| Necesidad | Provider |
|---|---|
| AWS-native, integración con S3/ALB/ACM | **CloudFront** |
| Developer experience + Workers/D1/R2 completo | **Cloudflare** |
| High-performance sub-ms + WASM | **Fastly** |
| Enterprise legacy + más PoPs mundo | **Akamai** |
| Pricing agresivo, sin egress fees | **Bunny.net**, **Cloudflare R2** |
| Video streaming | **Akamai**, **Cloudflare Stream**, **AWS MediaPackage** |
| APAC dominante | **Alibaba Cloud CDN**, **Tencent Cloud** |

---

## 7. Casos reales industria 2020-2026

**Fastly outage (8 junio 2021):** misconfig de un cliente disparó bug latente global. Reddit, Amazon, GitHub, NY Times cayeron ~1h. Instant purge sub-segundo se convirtió en instant break sub-segundo. **Lección:** la misma velocidad que te salva puede amplificar errores; blast radius de CDN outage es catastrófico.

**Cloudflare outage (2 julio 2019, 21 junio 2022):** misconfig BGP y regex catastrófico causaron outages parciales globales. Post-mortem público es lectura obligada. **Lección:** CDN es infraestructura crítica; testing de config debe ser exhaustivo.

**Netflix Open Connect:** en vez de usar CDN de terceros, Netflix distribuye appliances físicos (OCAs — Open Connect Appliances) dentro de ISPs del mundo. Cachea catálogo completo cerca del usuario, sirve >95% del traffic desde el ISP local. **Lección:** para casos extremos, CDN privado con appliances es viable.

**Cloudflare 1.1.1.1 launch (2018):** DNS resolver público con foco privacy + performance vs Google 8.8.8.8. Popularizó DoH/DoT en el consumer. **Lección:** infraestructura pública puede diferenciarse en privacy.

**CloudFront KeyValueStore GA (2024):** KV distribuido global integrado con CloudFront Functions. Elimina external API calls para config dinámica. **Lección:** el edge se está volviendo stateful (con eventual consistency).

**Cloudflare Workers + D1 + R2 (2022+):** stack full-featured para apps en edge (SSR, APIs, DB, object storage sin egress). Startups como CraftDocs, Hex, Loops.so shipeando 100% en Workers. **Lección:** edge computing pasó de "solo caching" a "full app deployment".

**Vercel Edge Network (2023+):** Next.js + Vercel Edge Functions + Vercel Image + KV + Cron unificado. **Lección:** platform-native edge integration es más productivo que ensamblar componentes.

**AWS Shield Advanced (post-2016 mass DDoS):** protección DDoS L3/L4/L7 avanzada, 24/7 DRT (DDoS Response Team). Enterprise adoption post-Dyn attack (2016 Mirai botnet 1.2Tbps). **Lección:** DDoS mitigation es enterprise-grade cost pero necesario para high-value targets.

**Fastly Compute@Edge WebAssembly (GA 2021):** primer CDN comercial ejecutando WASM. Rust/Go performance en edge. **Lección:** WASM es el futuro de edge runtimes multi-lenguaje.

**Cloudflare Radar (2022):** dashboard público con datos de Internet en real-time — DNS queries, BGP, security, adoption HTTP/3. **Lección:** CDN operators tienen visibilidad única de la Internet.

**Image optimization at edge (Cloudflare Images, Vercel Image, Netlify Image CDN, Bunny Optimizer, 2023+):** transformación on-the-fly según device/viewport/format (WebP/AVIF/JXL). Reduce bandwidth 40-70% vs assets estáticos. **Lección:** image optimization es table stakes en 2026.

**HTTP/3 (QUIC) mainstream (2024+):** CloudFront, Cloudflare, Fastly, Akamai todos soportan HTTP/3 GA. Ganancias observables en mobile networks. **Lección:** habilitar HTTP/3 es free win.

---

## 8. Ejercicios prácticos

### Ejercicio 1: setup CloudFront con cache optimales

**Objetivo:** desplegar CloudFront delante de un ALB con cache policy custom, HTTP/3, Brotli, security headers, WAF asociado.

**Setup:** ALB corriendo + Terraform + certificate ACM.

**Pasos:**
1. Terraform del `aws_cloudfront_distribution` de la sección 5.
2. Cache policy default (TTL 60, whitelist query strings, forward Auth header).
3. Cache policy `static_assets` (TTL 1 año, no query strings, no headers).
4. Response headers policy con HSTS, CSP, XFO.
5. WAF acl con AWS Managed Rules + rate limiting.
6. Aliases DNS al CloudFront.
7. Test cache HIT en assets y HTML.

**Criterios de éxito:**
- [ ] `curl -sv https://linguadev.app/static/main.abc123.js` → `x-cache: Hit`.
- [ ] Security headers presentes en response.
- [ ] WAF bloquea request con SQLi (`?id=1' OR '1'='1`).
- [ ] HTTP/3 negociado (`curl --http3`).
- [ ] CHR >80% después de 30 min de traffic.

**Bonus:** habilitar origin shield en us-east-1 + agregar geo restriction para block CU/IR/KP.

---

### Ejercicio 2: Cloudflare Worker con A/B testing + KV

**Objetivo:** desplegar Worker que ejecuta A/B test con sticky bucket via cookie y config en Workers KV.

**Setup:** Cloudflare account + wrangler CLI + dominio en Cloudflare DNS.

**Pasos:**
1. `wrangler init linguadev-ab-test`.
2. Escribir Worker de la sección 4.1.
3. `wrangler kv namespace create EXPERIMENTS`.
4. Poblar KV con config: `pricing-2026 → {controlPath, variantPath}`.
5. `wrangler deploy`.
6. Configurar route: `linguadev.app/pricing*`.
7. Test: enviar 100 requests + verificar 50/50 distribution.
8. Verificar sticky bucket via cookie repetida.

**Criterios de éxito:**
- [ ] Worker responde <20ms P50 desde ubicaciones globales.
- [ ] Distribution 50/50 en muestra grande.
- [ ] Sticky bucket funciona (cookie retained).
- [ ] Analytics event emitido async sin bloquear response.

**Bonus:** actualizar config KV en runtime + verificar propagación en <60s + agregar dashboard Cloudflare Analytics.

---

### Ejercicio 3: CloudFront Function + KeyValueStore para redirects

**Objetivo:** implementar tabla de redirects legacy → nuevo URL en KVS.

**Setup:** CloudFront distribution + Terraform.

**Pasos:**
1. Crear `aws_cloudfront_key_value_store` "linguadev-redirects".
2. Poblar KVS con 10 redirects (`/old-blog/post-1 → /blog/new-slug-1`).
3. CloudFront Function de la sección 4.2.
4. Asociar Function al viewer-request event.
5. Test con curl a las 10 URLs old → 301 con Location correcto.
6. Actualizar 1 redirect en KVS → verificar propagación <60s.

**Criterios de éxito:**
- [ ] 10 redirects funcionando con 301.
- [ ] Función ejecuta <1ms.
- [ ] Update KVS propaga globalmente en <60s.
- [ ] URLs no en KVS pasan al origin normalmente.

**Bonus:** agregar 3° condición (301 vs 302 según metadata en value JSON) + logging a CloudWatch.

---

### Ejercicio 4: Fastly Compute@Edge en Rust

**Objetivo:** desplegar Compute@Edge que hace geo routing + inyecta security headers.

**Setup:** Fastly account + fastly CLI + Rust toolchain.

**Pasos:**
1. `fastly compute init` (elegir Rust template).
2. Escribir código de la sección 4.3.
3. `fastly compute publish`.
4. Configurar service en el Fastly dashboard con origin `linguadev.app`.
5. Test: request desde EU IP → 307 a `eu.linguadev.app`.
6. Verificar security headers en response.

**Criterios de éxito:**
- [ ] Compute service running.
- [ ] Geo routing funciona (EU → eu.linguadev.app, US → linguadev.app).
- [ ] Headers de security presentes.
- [ ] Latencia P99 <10ms.

**Bonus:** agregar cache override via `req.set_ttl(3600)` + bypass condicional para logged-in users.

---

### Ejercicio 5: WAF + DDoS simulation

**Objetivo:** configurar WAF con managed rules + rate limiting + custom regla, y validar con requests maliciosos.

**Setup:** CloudFront + WAF WebACL.

**Pasos:**
1. Terraform del WAF de la sección 5.
2. Agregar 3ª regla custom: block requests con `User-Agent` empty.
3. Deployar y asociar al CloudFront.
4. Test SQLi: `curl "https://linguadev.app/?id=1'%20OR%20'1'='1"` → 403.
5. Test XSS: `curl "https://linguadev.app/search?q=<script>alert(1)</script>"` → 403.
6. Test rate limit: loop 3000 requests → primeros 2000 pasan, últimos 1000 blocked (429).
7. Verificar CloudWatch metrics de WAF rules disparadas.

**Criterios de éxito:**
- [ ] 3 rules activas y bloqueando correctamente.
- [ ] Rate limit dispara a los ~2000 req/5min.
- [ ] CloudWatch metric `BlockedRequests` incrementa.
- [ ] Sampled requests visibles en WAF console.

**Bonus:** agregar bot control rule + logging a Kinesis Firehose + dashboard Grafana.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [docs.aws.amazon.com/AmazonCloudFront](https://docs.aws.amazon.com/AmazonCloudFront/) — CloudFront + Functions + KeyValueStore.
- [developers.cloudflare.com/workers](https://developers.cloudflare.com/workers/) — Workers, KV, D1, R2, Durable Objects.
- [docs.fastly.com/products/compute-at-edge](https://docs.fastly.com/products/compute-at-edge) — Fastly Compute + WASM.
- [developer.akamai.com](https://developer.akamai.com) — Akamai EdgeWorkers.
- [datatracker.ietf.org/doc/html/rfc9111](https://datatracker.ietf.org/doc/html/rfc9111) — HTTP Caching (2022).
- [datatracker.ietf.org/doc/html/rfc5861](https://datatracker.ietf.org/doc/html/rfc5861) — stale-while-revalidate.

**Herramientas:**
- **WebPageTest** — analysis end-user real de performance.
- **Lighthouse** / **PageSpeed Insights** — audit performance.
- **httping** — latency continuous.
- **curl -v** con `--http3` para HTTP/3 testing.
- **k6**, **vegeta** — load testing.
- **Cloudflare Radar** — visibilidad global Internet.
- **Fastly Real-Time Analytics** — CHR + latency en dashboard live.

**CDN providers 2026:**
- Enterprise: **Akamai**, **CloudFront**, **Cloudflare Enterprise**, **Fastly**, **Azure Front Door**.
- Developer-friendly: **Cloudflare**, **Vercel**, **Netlify**, **Bunny.net**.
- Video: **Cloudflare Stream**, **Mux**, **AWS MediaPackage**, **JW Player**.
- Image optimization: **Cloudflare Images**, **Vercel Image**, **Bunny Optimizer**, **Imgix**, **Cloudinary**.

**Referencias adicionales:**
- Ilya Grigorik, *"High Performance Browser Networking"* (O'Reilly 2013, still relevant).
- Steve Souders, *"High Performance Web Sites"* — clásico rules of performance.
- Google web.dev — Core Web Vitals + LCP/FID/CLS.
- Fastly *"Fast, Reliable, Programmable Edge"* series — architectural talks.
- Cloudflare blog — post-mortems detallados + Workers evolution.
- AWS re:Invent 2024/2025 — CloudFront + edge computing tracks.

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Mide tu CHR actual: ¿está sobre 80%? Si no, investigá.
- Migrá 1 config a IaC (Terraform/Pulumi) si tu CDN vive en la consola.
- Evaluá si Workers/Lambda@Edge/CloudFront Functions pueden reemplazar lógica hoy en origin.
- Habilitá HTTP/3 + Brotli si aún no los tenés.
- Auditá security headers con `securityheaders.com`.
- Continuá con [cap 29 — service mesh (Istio, Linkerd)](./29-service-mesh-istio-linkerd.md), donde vas a manejar el traffic INTERNO al mesh una vez que el traffic entra al cluster.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas junior → mid → senior → staff. Cubren: qué es un CDN y Anycast routing, cache hit ratio (CHR) y optimización, `Cache-Control` headers modernos, `stale-while-revalidate`, `Vary` header, cache invalidation strategies (purge, cache-busting, surrogate keys, Cache-Tag), origin shield / tiered cache, cache stampede y mitigations, comparación CloudFront vs Cloudflare vs Fastly vs Akamai vs Bunny, edge functions (CloudFront Functions, Lambda@Edge, Cloudflare Workers, Fastly Compute@Edge), CloudFront KeyValueStore para config dinámica, Workers KV, image optimization at edge, WAF integration, DDoS protection L3/L4/L7, HTTP/2 vs HTTP/3, TLS handshake optimization y anti-patterns (CHR bajo, purge global, sin WAF).

- **Fuente:** [`packages/content/src/tech/devops/sim-28-cdn-and-edge-computing.json`](../../packages/content/src/tech/devops/sim-28-cdn-and-edge-computing.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-28-cdn-and-edge-computing`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 27 — DNS y Load Balancing](./27-dns-y-load-balancing.md) · [Índice](./README.md) · [Capítulo 29 — Service Mesh (Istio, Linkerd) →](./29-service-mesh-istio-linkerd.md)
