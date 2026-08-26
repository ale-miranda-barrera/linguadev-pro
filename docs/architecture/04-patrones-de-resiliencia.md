# Capítulo 04 — Patrones de Resiliencia

> **Focus:** Diseñar sistemas que degradan en vez de colapsar. Timeouts calibrados, retries con jitter, circuit breakers, bulkheads, idempotencia, dead letter queues, load shedding y backpressure.
> **Áreas:** Resilience · Microservices · Distributed systems
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 60 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de HTTP (status codes 4xx/5xx, headers), TCP y timeouts.
- Nociones de sistemas distribuidos (ver [Cap 01 — fundamentos](./01-eleccion-de-db.md) y [Cap 03 — serverless y networking](./03-serverless-y-networking.md)).
- Familiaridad con al menos un stack de microservicios (Spring Boot, Node/Fastify, FastAPI, Go net/http).
- Idealmente haber operado un incidente real: sirve para entender por qué estos patrones existen.
- Recomendable: leer previamente el capítulo del libro *Release It!* de Michael Nygard sobre estabilidad (Cap. 5).

**Glosario mínimo:**
- **Availability**: probabilidad de que un sistema responda correctamente en un momento dado. Se mide en "nines" (99.9% = 8.76 h de downtime/año).
- **Failure mode**: forma concreta en que un sistema puede fallar (crash, omission, timing, response, byzantine).
- **Gray failure**: el sistema técnicamente responde pero degrada (5% errores, latencia 10x) — es lo peor porque el monitoring dice "ok".
- **Metastable failure**: sistema que entra en estado degradado del que no se recupera aunque el trigger inicial desaparezca (retry storms, thundering herds).
- **Retry storm**: cliente que reintenta agresivamente amplifica el problema del downstream saturado.
- **Circuit breaker**: componente que "abre" el flujo cuando un dependency falla, evitando cascading failure.
- **Bulkhead**: aislamiento de recursos por dependency, análogo a mamparos de barco.
- **Idempotency-key**: identificador único de una operación lógica que permite retries seguros sin duplicación.
- **DLQ (Dead Letter Queue)**: cola donde acaban mensajes que fallaron N intentos.
- **Load shedding**: rechazar activamente requests cuando el sistema está saturado (503) para preservar goodput.
- **Backpressure**: comunicar upstream que el consumidor está saturado (TCP window, HTTP 429).
- **Hedged request**: enviar la misma request a dos servidores y tomar la primera respuesta que llegue.

**Setup mínimo:**

```bash
# Java + Spring Boot con Resilience4j 2.3.x
./mvnw dependency:tree | grep resilience4j
# io.github.resilience4j:resilience4j-spring-boot3:2.3.0

# Python con tenacity 9.x
pip install tenacity==9.0.0

# Go con avast/retry-go v4
go get github.com/avast/retry-go/v4

# Node con cockatiel (Microsoft, alt a Polly en TS)
npm i cockatiel

# Toxiproxy para inyectar fallos en pruebas
docker run -d --name toxiproxy -p 8474:8474 -p 22220:22220 \
  ghcr.io/shopify/toxiproxy:2.9.0

# Chaos Mesh para Kubernetes (v2.7 en 2026)
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm install chaos-mesh chaos-mesh/chaos-mesh -n chaos-mesh --version 2.7.0
```

---

## 1. El gran cuadro

En sistemas distribuidos, **el fallo no es una excepción; es un estado permanente de una fracción del sistema**. En cualquier momento, alguna instancia está reiniciando, algún link tiene packet loss, algún disco se llena. La pregunta arquitectónica no es "¿cómo evito el fallo?" sino "¿cómo diseño para que un fallo local no se convierta en un outage total?". Esa es la disciplina de la **resiliencia**: patrones que permiten que un servicio pierda una réplica, tolere una dependencia lenta, absorba un pico de tráfico o sobreviva a un despliegue defectuoso sin arrastrar consigo al resto del sistema. Los grandes outages públicos —AWS S3 en 2017, Facebook BGP en 2021, Cloudflare regex en 2019, GitHub MySQL Orchestrator en 2018— comparten un patrón: un fallo pequeño amplificado por diseño frágil hasta convertirse en catástrofe.

El segundo eje es **económico**. Cada "nueve" adicional de disponibilidad multiplica el coste aproximadamente por diez. 99% son 3.65 días/año de downtime; 99.99% son 52 minutos; 99.999% requiere multi-región, chaos engineering, automatización profunda y un equipo SRE dedicado. La regla de Google SRE es que la disponibilidad se calibra al valor de negocio: un dashboard interno vive feliz con 99.5%, un procesador de pagos exige 99.99%, un servicio financiero real-time se acerca a 99.999%. La resiliencia no es un absoluto: es un dial. Y los patrones de este capítulo son las palancas que giras ese dial.

El tercer eje es **cultura**. Los patrones técnicos (circuit breaker, bulkhead) son necesarios pero insuficientes sin prácticas: **timeouts calculados y no copiados**, **retries sólo en operaciones idempotentes**, **postmortems blameless**, **GameDays** trimestrales, **chaos engineering** en producción con blast radius controlado, **runbooks** para on-call. Netflix popularizó Chaos Monkey precisamente porque los patrones en código eran aspiracionales hasta que alguien mataba servidores en producción y verificaba que sí, el circuit breaker abría, sí, el bulkhead aislaba, sí, el fallback se activaba. Este capítulo cubre los patrones canónicos, sus interacciones y los antipatrones que los rompen — con código real en Java, Python, Go y YAML (Istio) — y termina con ejercicios verificables sobre el proyecto **LinguaDev Pro**.

---

## 2. Fundamentos: failure modes, timeouts y health checks

### 2.1 Taxonomía de fallos

La clasificación clásica (Cristian, 1991) sigue vigente y organiza cómo pensar la defensa:

| Failure mode | Descripción | Defensa típica |
|---|---|---|
| **Crash (fail-stop)** | El proceso muere abruptamente | Heartbeats + failover, health checks |
| **Omission** | Un mensaje no llega o se pierde la respuesta | Retries idempotentes |
| **Timing** | Respuesta fuera de spec (lenta) | Timeouts + circuit breaker |
| **Response** | Respuesta incorrecta (bug lógico) | Validación, tests de contrato |
| **Byzantine** | Comportamiento arbitrario o malicioso | Consenso (Raft, PBFT), firmas |

En la práctica moderna hay dos categorías que merecen atención extra:

- **Gray failures** (Huang et al., 2017): el sistema técnicamente responde pero degrada. Un caso típico: un nodo con un disco cuyo I/O se ha vuelto lento por sector defectuoso; monitorización a nivel de "está el proceso vivo" dice sí, pero cada request tarda 5x más. El monitoring convencional los oculta; requiere probes multi-perspectiva y trazas distribuidas.
- **Metastable failures** (Bronson et al., 2021): sistema en estado degradado del que no se recupera aunque el trigger inicial desaparezca. Un ejemplo: un spike de tráfico causa saturación, los clientes reintentan, la carga sostiene la saturación aunque el spike inicial ya pasó. Salir requiere intervención (drenar cola, reiniciar, load shedding agresivo).

### 2.2 Timeouts: la regla que casi nadie aplica bien

**Todo I/O tiene timeout, y ese timeout se calcula, no se copia.** El anti-patrón #1 es dejar los defaults: la mayoría de HTTP clients traen 30 s o infinito, y `net.Dial` en Go bloquea indefinidamente si no le pones `context.WithTimeout`. La regla:

> `timeout(A→B) < SLA(A) − overhead(A)`

Si tu SLA con el cliente es p99 < 500 ms y procesas 100 ms internamente, tu timeout al downstream **debe** estar entre 200 ms y 300 ms. Si tu downstream tarda más, mejor devolver un 503 o un fallback que romper tu SLA silenciosamente.

Ejemplo en Go con `context.WithTimeout` y validación de estos límites:

```go
// pkg/httpclient/client.go
package httpclient

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

type Client struct {
	http    *http.Client
	// timeout global por request lógico (incluye retries)
	logical time.Duration
	// timeout por intento individual (< logical / maxRetries)
	perTry  time.Duration
}

func NewClient(perTry, logical time.Duration) (*Client, error) {
	if perTry >= logical {
		return nil, fmt.Errorf("perTry (%s) debe ser < logical (%s)", perTry, logical)
	}
	return &Client{
		http:    &http.Client{Timeout: perTry},
		perTry:  perTry,
		logical: logical,
	}, nil
}

// Do lanza la request con deadline propagada al servidor via context.
// El servidor recibe X-Deadline-MS y puede decidir abortar si sabe que no llegará.
func (c *Client) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, c.logical)
	defer cancel()

	req = req.WithContext(ctx)
	deadline, _ := ctx.Deadline()
	remainingMs := int(time.Until(deadline).Milliseconds())
	req.Header.Set("X-Deadline-MS", fmt.Sprintf("%d", remainingMs))

	return c.http.Do(req)
}
```

El header `X-Deadline-MS` (o el estándar gRPC `grpc-timeout`) permite propagación de **deadline** a través del grafo de llamadas: cada servicio sabe cuánto tiempo real le queda y puede rechazar trabajo que ya llegará tarde. Es una idea potente y muy poco aplicada en HTTP.

### 2.3 Health checks: liveness, readiness, startup

Kubernetes distingue tres probes con **efectos operacionales distintos**:

- **Liveness**: ¿está el proceso vivo? Si falla → Kubernetes **reinicia** el pod. Debe ser **simple**: solo comprueba que el proceso responde y no está deadlocked. **No** debe llamar a la DB ni a dependencias externas: si la DB se cae, no querés reiniciar todos tus pods.
- **Readiness**: ¿puede atender tráfico? Si falla → el Service **quita** el pod del pool (no lo reinicia). Aquí sí es válido chequear dependencias críticas: si la DB no responde, este pod no sirve peticiones nuevas, pero se recupera cuando vuelva.
- **Startup**: ¿ya terminó el boot? Protege durante arranques lentos (JVM warmup, imports pesados, migraciones) para que liveness no dispare prematuramente.

Anti-patrón muy común: `SELECT 1` a la DB en el endpoint `/healthz` de liveness. Cuando la DB se cae 5 s, Kubernetes mata **todos** los pods a la vez; cuando la DB vuelve, todos arrancan y saturan las conexiones. Cascade failure textbook.

Manifest Kubernetes correcto:

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: linguadev-api
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: api
          image: linguadev-pro/api:1.42.0
          startupProbe:
            httpGet: { path: /healthz/startup, port: 8080 }
            periodSeconds: 5
            failureThreshold: 24   # 24 * 5s = 2 min de boot permitido
          livenessProbe:
            httpGet: { path: /healthz/live, port: 8080 }
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3    # 30s antes de reiniciar
          readinessProbe:
            httpGet: { path: /healthz/ready, port: 8080 }
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2    # ~10s antes de sacar del pool
```

Handler mínimo en Node/Fastify:

```ts
// src/routes/health.ts
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { redis } from '../redis';

export async function healthRoutes(app: FastifyInstance) {
  // Liveness: SIMPLE. Solo prueba que el event loop responde.
  app.get('/healthz/live', async () => ({ status: 'ok' }));

  // Startup: espera a que las migraciones acaben.
  app.get('/healthz/startup', async (_req, reply) => {
    if (!app.hasDecorator('migrationsDone')) return reply.code(503).send();
    return { status: 'ready' };
  });

  // Readiness: chequea dependencias críticas con timeout corto.
  app.get('/healthz/ready', async (_req, reply) => {
    try {
      await Promise.race([
        Promise.all([db.raw('SELECT 1'), redis.ping()]),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('probe timeout')), 1500)),
      ]);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
}
```

---

## 3. Retries: cuándo, cuánto y cómo

### 3.1 Anatomía de un retry profesional

Un retry mal hecho **empeora** el problema. La combinación mínima aceptable en 2026 es:

1. **Sólo en operaciones idempotentes** (GET, PUT con idempotency-key, DELETE) o en errores donde sabes que el servidor no procesó nada (connection refused antes del write).
2. **Sólo en errores transitorios**: 502, 503, 504, 429, timeouts de red. **Nunca** en 400, 401, 403, 404, 422 (fallará igual la próxima vez).
3. **Exponential backoff**: cada retry duplica el delay. Da tiempo al downstream a recuperarse.
4. **Jitter** (aleatoriedad ±25%): sin él, N clientes que fallan a la vez reintentan sincronizados creando oleadas periódicas ("thundering herd").
5. **Max retries + max total time**: nunca infinito. El cliente espera un tiempo acotado.
6. **Retry budget** (Google SRE): a nivel de sistema, no permitir más de X% de retries sobre requests totales. Si el porcentaje supera un límite, deja de reintentar aunque el algoritmo lo pida.

Marc Brooker (AWS) publicó el paper canónico *Exponential Backoff and Jitter* con las tres variantes:

- **Full jitter**: `sleep = random(0, base * 2^attempt)` — la más recomendada.
- **Equal jitter**: `sleep = base * 2^attempt / 2 + random(0, base * 2^attempt / 2)`.
- **Decorrelated jitter**: `sleep = min(cap, random(base, prev * 3))` — evita bursts residuales.

### 3.2 Python con Tenacity 9.x

```python
# app/pricing_client.py
import httpx
from tenacity import (
    retry, stop_after_attempt, stop_after_delay, wait_exponential_jitter,
    retry_if_exception_type, before_sleep_log,
)
import logging

log = logging.getLogger(__name__)

class PricingError(Exception): ...
class PricingTransient(PricingError): ...   # 5xx, 429, timeout
class PricingPermanent(PricingError): ...   # 4xx no retryable

@retry(
    stop=stop_after_attempt(4) | stop_after_delay(2.0),   # max 4 intentos o 2s totales
    wait=wait_exponential_jitter(initial=0.1, max=1.0, jitter=0.25),  # 100ms → 200 → 400 → 800 ± jitter
    retry=retry_if_exception_type(PricingTransient),
    before_sleep=before_sleep_log(log, logging.WARNING),
    reraise=True,
)
async def get_price(sku: str, *, client: httpx.AsyncClient) -> float:
    try:
        r = await client.get(f"/prices/{sku}", timeout=0.3)   # perTry timeout 300ms
    except (httpx.TimeoutException, httpx.NetworkError) as e:
        raise PricingTransient(f"network: {e}") from e

    if r.status_code == 429 or 500 <= r.status_code < 600:
        raise PricingTransient(f"http {r.status_code}")
    if r.status_code >= 400:
        raise PricingPermanent(f"http {r.status_code}")

    return r.json()["price"]
```

Detalles importantes: el `stop_after_delay(2.0)` corta el total aunque el algoritmo pidiera más intentos, y el `reraise=True` asegura que la última excepción sale limpia (no envuelta en `RetryError`).

### 3.3 Java con Resilience4j 2.3

Resilience4j 2.3 (2025) introdujo un sliding window lock-free para las métricas internas del CircuitBreaker y añadió un `Clock` a `CircuitBreakerConfig` (útil para tests deterministas). El módulo `retry` combina de forma limpia con `circuitbreaker` y `timelimiter`.

```java
// PricingClient.java
import io.github.resilience4j.retry.Retry;
import io.github.resilience4j.retry.RetryConfig;
import io.github.resilience4j.retry.RetryRegistry;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import io.github.resilience4j.timelimiter.TimeLimiter;
import io.github.resilience4j.timelimiter.TimeLimiterConfig;
import io.github.resilience4j.decorators.Decorators;

import java.net.http.*;
import java.net.URI;
import java.time.Duration;
import java.util.concurrent.*;

public class PricingClient {
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(200)).build();

    private final Retry retry;
    private final CircuitBreaker cb;
    private final TimeLimiter tl;

    public PricingClient() {
        RetryConfig retryCfg = RetryConfig.<HttpResponse<String>>custom()
                .maxAttempts(4)
                .intervalFunction(io.github.resilience4j.core.IntervalFunction
                        .ofExponentialRandomBackoff(100, 2.0, 0.25))
                .retryOnResult(r -> r.statusCode() == 429 || r.statusCode() >= 500)
                .retryExceptions(java.io.IOException.class, TimeoutException.class)
                .build();

        CircuitBreakerConfig cbCfg = CircuitBreakerConfig.custom()
                .failureRateThreshold(50)                   // 50% de errores
                .slowCallRateThreshold(80)                  // 80% "slow" también abre
                .slowCallDurationThreshold(Duration.ofMillis(400))
                .slidingWindowSize(20)
                .minimumNumberOfCalls(10)
                .waitDurationInOpenState(Duration.ofSeconds(15))
                .permittedNumberOfCallsInHalfOpenState(3)
                .build();

        TimeLimiterConfig tlCfg = TimeLimiterConfig.custom()
                .timeoutDuration(Duration.ofMillis(300))   // per-try timeout
                .build();

        this.retry = RetryRegistry.of(retryCfg).retry("pricing");
        this.cb = CircuitBreaker.of("pricing", cbCfg);
        this.tl = TimeLimiter.of("pricing", tlCfg);
    }

    public CompletableFuture<String> price(String sku) {
        Supplier<CompletionStage<HttpResponse<String>>> supplier = () -> http.sendAsync(
                HttpRequest.newBuilder(URI.create("http://pricing/prices/" + sku)).build(),
                HttpResponse.BodyHandlers.ofString());

        return Decorators.ofCompletionStage(supplier)
                .withTimeLimiter(tl, Executors.newSingleThreadScheduledExecutor())
                .withCircuitBreaker(cb)
                .withRetry(retry, Executors.newSingleThreadScheduledExecutor())
                .withFallback(ex -> CompletableFuture.completedFuture(
                        HttpResponse.BodyHandlers.ofString().getBody().toString()))  // pseudo-fallback
                .get()
                .toCompletableFuture()
                .thenApply(HttpResponse::body);
    }
}
```

En Spring Boot 3 la configuración vive en `application.yml` bajo `resilience4j.retry.instances.pricing.*` y las anotaciones `@Retry`, `@CircuitBreaker`, `@TimeLimiter`, `@Bulkhead` decoran métodos directamente.

### 3.4 Go con avast/retry-go

```go
// pkg/pricing/client.go
package pricing

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/avast/retry-go/v4"
)

type transientError struct{ err error }

func (e transientError) Error() string { return e.err.Error() }

func GetPrice(ctx context.Context, http *http.Client, sku string) (string, error) {
	var body []byte
	err := retry.Do(
		func() error {
			perTry, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
			defer cancel()

			req, _ := http.NewRequestWithContext(perTry, "GET", "http://pricing/prices/"+sku, nil)
			resp, err := http.Do(req)
			if err != nil {
				return transientError{err}
			}
			defer resp.Body.Close()

			if resp.StatusCode == 429 || resp.StatusCode >= 500 {
				return transientError{fmt.Errorf("http %d", resp.StatusCode)}
			}
			if resp.StatusCode >= 400 {
				return retry.Unrecoverable(fmt.Errorf("http %d", resp.StatusCode))
			}
			body, _ = io.ReadAll(resp.Body)
			return nil
		},
		retry.Attempts(4),
		retry.Delay(100*time.Millisecond),
		retry.MaxDelay(1*time.Second),
		retry.DelayType(retry.BackOffDelay),   // exponential
		retry.MaxJitter(50*time.Millisecond),  // jitter
		retry.Context(ctx),
		retry.RetryIf(func(err error) bool {
			_, ok := err.(transientError)
			return ok
		}),
	)
	return string(body), err
}
```

`retry.Unrecoverable(err)` marca la excepción como no reintentable, útil para errores 4xx permanentes.

---

## 4. Circuit breaker, bulkhead y timeouts en cascada

### 4.1 Circuit breaker: los tres estados y por qué medirlo

Un circuit breaker mide la tasa de fallo en una ventana reciente y transiciona entre tres estados:

- **CLOSED**: requests fluyen; se cuentan éxitos/fallos.
- **OPEN**: cuando la tasa de fallo supera un umbral (ej. 50% en 20 llamadas recientes) el circuito abre; las siguientes requests **fallan inmediatamente** sin llamar al downstream. Los threads del cliente no se bloquean esperando timeouts.
- **HALF-OPEN**: pasado un cooldown (ej. 15 s), permite un número limitado de requests "de prueba" (ej. 3). Si suficientes tienen éxito, cierra; si no, vuelve a abrir.

Resilience4j 2.3 añadió `slowCallRateThreshold` y `slowCallDurationThreshold`: puedes abrir el circuito no sólo por errores sino por **lentitud** (una request de 5 s técnicamente exitosa es tan mala como una fallida para un cliente con SLA 500 ms).

**Antipatrón a evitar**: exponer un 500 al usuario cuando el circuito está abierto. La razón de abrir es **aplicar un fallback**: cache stale, valor por defecto, respuesta degradada.

### 4.2 Bulkhead: aislamiento de recursos

El nombre viene de los mamparos que dividen el casco de un barco. En software, aislar recursos por dependencia evita que un fallo local se propague a todo el sistema. Formas:

- **Thread pool bulkhead**: cada dependency tiene su propio pool. Si X se degrada y satura sus 30 threads, Y y Z siguen atendiendo con los suyos.
- **Semaphore bulkhead**: límite de concurrencia por dependency sin coste de threads dedicados (mejor para código async / non-blocking).
- **Connection pool bulkhead**: pools separados por servicio/DB.
- **Isolation a nivel de pod/proceso**: separar Lambda functions o pods por criticidad.

En Resilience4j:

```java
// Semaphore bulkhead: max 20 concurrent calls a "pricing", cola de espera 100
BulkheadConfig bcfg = BulkheadConfig.custom()
        .maxConcurrentCalls(20)
        .maxWaitDuration(Duration.ofMillis(50))
        .build();
Bulkhead bulkhead = Bulkhead.of("pricing", bcfg);
```

Cuando el bulkhead está lleno, la request falla rápido (`BulkheadFullException`) — perfecto insumo para el circuit breaker o para servir fallback.

### 4.3 Timeouts en cascada: el "deadline budget"

En una cadena `A → B → C → D`, si cada nivel usa timeout de 30 s, un fallo en D bloquea C 30 s, luego B otros 30, luego A. El request original ve 90 s. La solución es **deadline budget**: A propaga cuánto tiempo real le queda; cada nivel calcula su propio timeout como `min(timeout_local, remaining_budget − network_margin)`. gRPC lo implementa nativamente con `grpc-timeout`; en HTTP hay que hacerlo a mano.

En Istio 1.24 puedes declarar timeouts y retries a nivel de VirtualService:

```yaml
# istio/virtualservice-pricing.yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: pricing
spec:
  hosts: [pricing]
  http:
    - route:
        - destination: { host: pricing, subset: v1 }
      timeout: 300ms                # deadline por request
      retries:
        attempts: 3
        perTryTimeout: 100ms        # 3 * 100ms = 300ms total
        retryOn: 5xx,gateway-error,connect-failure,refused-stream
```

Y a nivel de DestinationRule aplicar circuit breaking por conexiones y outlier detection (Envoy 1.32 ejecta pods con exceso de 5xx del pool de LB):

```yaml
# istio/destinationrule-pricing.yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: pricing
spec:
  host: pricing
  trafficPolicy:
    connectionPool:
      tcp:  { maxConnections: 100 }
      http: { http1MaxPendingRequests: 100, maxRequestsPerConnection: 10 }
    outlierDetection:
      consecutive5xxErrors: 5       # 5 x 5xx consecutivos → eject
      interval: 10s                 # revisa cada 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 50        # nunca ejecta más del 50% del pool
```

`consecutive5xxErrors: 5` significa que si un pod devuelve 5 respuestas 5xx seguidas, Envoy lo saca del pool de load balancing por 30 s. Es un **circuit breaker distribuido a nivel de infraestructura**, no de código: cualquier servicio en la mesh lo obtiene "gratis".

---

## 5. Idempotencia, DLQs y hedged requests

### 5.1 Idempotency-Key: el patrón universal

Cuando un cliente hace `POST /transfer $100`, la request llega al servidor, se procesa, y la respuesta se pierde por un timeout de red. El cliente reintenta. Sin defensa, se transfieren 200 €. La solución canónica —usada por Stripe, GitHub, PayPal, Shopify— es el header `Idempotency-Key`:

1. El cliente genera un UUID por **operación lógica** (no por retry).
2. Envía `Idempotency-Key: <uuid>` en el POST.
3. El servidor: `SELECT` en la tabla de dedupe; si existe → devuelve la respuesta cacheada; si no → procesa la operación **y** guarda `(key, response)` en la **misma transacción**.
4. TTL de la key típicamente 24-72 h (mayor que el max retry window del cliente).

Postgres schema mínimo:

```sql
CREATE TABLE idempotency_keys (
    key           UUID PRIMARY KEY,
    request_hash  BYTEA NOT NULL,
    status_code   INT NOT NULL,
    response_body JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys(expires_at);

-- Purga periódica (cron)
DELETE FROM idempotency_keys WHERE expires_at < now();
```

Handler middleware pseudo-código:

```ts
// middleware/idempotency.ts
export async function idempotency(req: Req, res: Res, next: Next) {
  const key = req.header('Idempotency-Key');
  if (!key || req.method !== 'POST') return next();

  const bodyHash = sha256(req.rawBody);

  const existing = await db.query(
    'SELECT status_code, response_body, request_hash FROM idempotency_keys WHERE key = $1 AND expires_at > now()',
    [key],
  );
  if (existing.rows[0]) {
    if (!existing.rows[0].request_hash.equals(bodyHash)) {
      return res.status(422).json({ error: 'idempotency_key_reused_with_different_body' });
    }
    return res.status(existing.rows[0].status_code).json(existing.rows[0].response_body);
  }

  // Interceptamos res.json para guardar la respuesta en la misma tx
  const origJson = res.json.bind(res);
  res.json = (body: unknown) => {
    db.query(
      `INSERT INTO idempotency_keys (key, request_hash, status_code, response_body, expires_at)
       VALUES ($1,$2,$3,$4, now() + interval '72 hours')`,
      [key, bodyHash, res.statusCode, body],
    ).catch(err => req.log.error({ err }, 'idempotency_persist_failed'));
    return origJson(body);
  };

  next();
}
```

Regla dura: el guardado del key + response y la operación real deben estar en la **misma transacción DB**. Si están separadas, una race puede resultar en operación ejecutada dos veces (key todavía no persistido cuando llega el retry).

### 5.2 Dead Letter Queues

En un consumidor de cola (SQS, Kafka, RabbitMQ), un mensaje puede fallar el procesamiento por razones transitorias (retry ayuda) o permanentes (bug, payload malformado). El patrón DLQ:

1. Se configura `maxReceiveCount` (SQS) o `max.delivery.attempts` (Kafka + Cruise Control patterns).
2. Tras N intentos fallidos, el mensaje se mueve a la **Dead Letter Queue**.
3. La DLQ **no** se consume automáticamente: un operador la inspecciona, corrige el bug, y decide reencolar o descartar.

Configuración en AWS CDK v2 (2026 usa v2.170+):

```ts
// infra/queue.ts
import { Queue, DeadLetterQueue } from 'aws-cdk-lib/aws-sqs';
import { Duration, Stack } from 'aws-cdk-lib';

export function createEvalQueue(stack: Stack) {
  const dlq = new Queue(stack, 'EvalDlq', {
    retentionPeriod: Duration.days(14),
  });

  const main = new Queue(stack, 'EvalQueue', {
    visibilityTimeout: Duration.seconds(60),
    deadLetterQueue: { queue: dlq, maxReceiveCount: 5 } satisfies DeadLetterQueue,
  });

  // Alarma cuando la DLQ acumula mensajes: siempre debe ser 0.
  dlq.metricApproximateNumberOfMessagesVisible().createAlarm(stack, 'DlqAlarm', {
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: 'Hay mensajes en la DLQ de evals — investigar.',
  });

  return { main, dlq };
}
```

Reglas duras: **alerta cuando la DLQ tiene mensajes** (siempre debe ser 0 en operación normal), y **runbook documentado** con pasos para inspeccionar, corregir y reencolar.

### 5.3 Hedged requests (para reducir tail latency)

Concepto (Google Dapper / Jeff Dean 2013): para reducir la latencia de cola (p99), enviar la misma request a **dos** réplicas si la primera no responde en un tiempo corto (p95 esperado); tomar la primera respuesta que llegue; cancelar la otra. Aumenta el coste (algo de tráfico extra), reduce dramáticamente el p99.

En Go, un hedge sencillo:

```go
// pkg/hedge/hedge.go
package hedge

import (
	"context"
	"time"
)

func Do[T any](ctx context.Context, delay time.Duration, fn func(context.Context) (T, error)) (T, error) {
	type result struct { v T; err error }
	ch := make(chan result, 2)
	ctx1, c1 := context.WithCancel(ctx)
	defer c1()

	go func() { v, err := fn(ctx1); ch <- result{v, err} }()

	select {
	case r := <-ch:
		return r.v, r.err
	case <-time.After(delay):
		// Hedge: lanza el segundo intento
		ctx2, c2 := context.WithCancel(ctx)
		defer c2()
		go func() { v, err := fn(ctx2); ch <- result{v, err} }()

		r := <-ch
		return r.v, r.err
	}
}
```

**Precauciones**: sólo para operaciones idempotentes (o con idempotency-key), sólo cuando el downstream tiene suficiente capacidad extra, y monitorizando la "hedge rate" para no cruzar el 15-20% (por encima indica que el p95 base está mal).

---

## 6. Load shedding, backpressure y graceful degradation

### 6.1 Load shedding: cuando decir no

Cuando el sistema recibe carga superior a su capacidad, **rechazar activamente** parte del tráfico preserva el resto del servicio. Sin load shedding, la carga se acumula en colas, todos los requests degradan, y el sistema entra en metastable failure. Técnicas:

- **Fixed concurrency limits**: máximo N requests in-flight. Requests extra reciben 503 o entran en cola con límite.
- **Adaptive concurrency limits** (Netflix, algoritmo tipo TCP Vegas): ajusta el límite dinámicamente según latencia observada. Cuando p99 sube, reduce el límite; cuando baja, lo aumenta.
- **Priority queuing**: rechazar primero requests de menor prioridad (free tier antes que paid; batch antes que user-facing).
- **LIFO en overload**: bajo carga extrema, procesar requests frescas antes que colas antiguas (las antiguas probablemente ya excedieron el timeout del cliente).

Envoy 1.32 tiene el filtro `adaptive_concurrency` nativo. Netflix publicó `concurrency-limits` (Java) que implementa Gradient2 y VegasLimit.

Ejemplo de handler en Node con `p-queue` y límite:

```ts
// src/middleware/loadShed.ts
import PQueue from 'p-queue';

const queue = new PQueue({ concurrency: 100 });
const MAX_QUEUE = 50;   // rechazamos si la cola pasa de 50 pendientes

export async function loadShed(req: Req, res: Res, next: Next) {
  if (queue.size >= MAX_QUEUE) {
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ error: 'overloaded', hint: 'retry_after_seconds:2' });
  }
  await queue.add(() => new Promise<void>(resolve => {
    res.on('finish', resolve);
    next();
  }));
}
```

### 6.2 Backpressure

Backpressure es la señal **"reduce tu rate porque no doy abasto"** que el sistema comunica upstream. En TCP, es la ventana. En HTTP, el status `429 Too Many Requests` con `Retry-After`. En gRPC, `RESOURCE_EXHAUSTED`. En reactive streams (Project Reactor, RxJava), pull-based subscription.

Un rate limiter en Redis con token bucket, para exponer 429 con Retry-After correcto:

```lua
-- redis/token_bucket.lua
-- KEYS[1] = clave del bucket
-- ARGV[1] = capacity, ARGV[2] = refillPerSec, ARGV[3] = nowMs, ARGV[4] = cost
local capacity   = tonumber(ARGV[1])
local refill     = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local cost       = tonumber(ARGV[4])

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1]) or capacity
local ts     = tonumber(data[2]) or now

local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retryMs = 0
if tokens >= cost then
    tokens = tokens - cost
    allowed = 1
else
    retryMs = math.ceil((cost - tokens) / refill * 1000)
end

redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / refill) * 2)

return { allowed, retryMs }
```

Cliente que llama al script y traduce a header HTTP:

```ts
const [allowed, retryMs] = await redis.eval(script, 1, key, capacity, refillPerSec, Date.now(), 1);
if (!allowed) {
  res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
  return res.status(429).json({ error: 'rate_limited' });
}
```

### 6.3 Graceful degradation: los tres niveles

Cuando una dependencia no crítica falla, **servir un peor esfuerzo** en vez de un error. La jerarquía típica:

1. **Full functionality**: todo OK.
2. **Cached stale response**: si recommendations falla, servir el último cache (aunque tenga 10 min).
3. **Default/hardcoded**: si personalization falla, mostrar "top products" hardcodeados.
4. **Feature hidden**: la sección desaparece con nota discreta ("recomendaciones no disponibles ahora").
5. **Explicit error** (último recurso): "servicio no disponible, reintenta en unos minutos".

Y **feature flags** como kill-switch manual: cuando el equipo detecta un problema, un toggle desactiva la feature sin necesidad de deploy. LaunchDarkly, Flagsmith, Split, o self-hosted con Unleash. Cada feature crítica debe tener flag.

---

## 7. Casos reales industria (2015-2026)

**AWS DynamoDB — sep 2015**: un fallo de metadata service en `us-east-1` amplificado por retries agresivos en clientes SDK causó degradación regional de varias horas. Post-mortem: retries sin jitter suficientes, sin retry budget global. Consecuencia: AWS SDK v3 rediseñó el retry con adaptive strategy por default.

**GitHub MySQL Orchestrator — oct 2018**: split-brain entre `us-east` y `us-west` durante 43 s de partición promovió dos primaries; 40 s de writes divergentes. Reconciliación manual bloqueó writes 24 h. Post-mortem público de lectura obligada. GitHub migró a un modelo con Vitess-inspired routing y fencing más estricto.

**Cloudflare — jul 2019**: un regex mal escrito en un WAF rule causó CPU 100% en todos los proxys globales durante 27 min. Cascada: los pods reiniciaban al detectar OOM, pero los nuevos también entraban en el mismo regex. Post-mortem: falta de kill switch inmediato para reglas WAF; hoy Cloudflare tiene un feature flag global para "dry-run" cada regla antes de propagar.

**Facebook / Meta — oct 2021**: un cambio de BGP tumbó DNS de Facebook globalmente 6 h; los ingenieros no podían siquiera acceder al datacenter porque los sistemas de acceso físico dependían del DNS interno. Cascade de dependencias circulares. Post-mortem: separación de "control plane" y "data plane" y runbooks out-of-band.

**Slack — feb 2022**: un cambio en la lógica de connection pooling saturó las conexiones Postgres bajo carga normal, degradando el servicio 2 h. Un caso de bug "sencillo" amplificado por ausencia de canary staging con carga real.

**Datadog — mar 2023**: un incident multi-región de ~24 h atribuido a un rollout de systemd + docker en decenas de miles de hosts que causó desconexión masiva. Post-mortem público extenso; añadieron gates de despliegue con métricas por región.

**Kalshi / Robinhood — 2024-2025**: varios incidentes de trading bloqueado durante picos de mercado por load shedding mal calibrado y falta de bulkheads entre order-entry y market-data. Regulación FINRA endureció requisitos de resilience testing.

**AWS DynamoDB Global Tables Multi-Region Strong Consistency GA — jun 2025**: por primera vez, DynamoDB ofrece linearizabilidad cross-región (RPO=0). Cambia el trade-off histórico "eventual entre regiones" para aplicaciones críticas.

**Prometheus 3.0 — nov 2024, Prometheus 3.13 LTS — jul 2026**: native histograms estables desde 3.8, OTLP ingestion directa, UTF-8 en labels, remote-write 2.0. Cambio importante para la telemetría de patrones de resiliencia.

**Cloudflare — nov 2025**: un incidente de cache poisoning por un race en el edge propagó respuestas equivocadas 90 min. Consecuencia: adopción interna de "hedged deploys" con blast radius por país.

---

## 8. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Todo I/O tiene timeout**, calculado desde el SLA hacia adentro.
- ✅ **Retries sólo en idempotentes y transitorios**, con exponential backoff + jitter.
- ✅ **Circuit breaker** por dependency, con fallback obligatorio.
- ✅ **Bulkhead** aísla thread/connection pools por dependency.
- ✅ **Deadline budget** propagado en la cadena de llamadas.
- ✅ **Idempotency-Key** en toda API que muta estado externo.
- ✅ **DLQ + alerta** para todo consumidor asíncrono.
- ✅ **Load shedding** con 503/429 y `Retry-After`.
- ✅ **Graceful degradation** con fallbacks independientes.
- ✅ **Feature flags** como kill-switch para cada feature crítica.
- ✅ **Health checks** distintos: liveness simple, readiness con dependencias.
- ✅ **Chaos engineering** para verificar que los patrones activan realmente.
- ✅ **Blameless postmortems** con action items rastreados.
- ✅ **On-call sostenible**: <2 pages/shift, todo actionable, runbooks pre-escritos.

### Anti-patrones

- ❌ Timeout por defecto (30 s o infinito).
- ❌ Retry infinito o sin jitter.
- ❌ Retry de POST no idempotente.
- ❌ Circuit breaker abierto devolviendo 500 al usuario.
- ❌ `SELECT 1` a la DB en liveness (mata todos los pods si la DB tose).
- ❌ Fallback que llama a otro servicio que también puede fallar.
- ❌ Redlock sin fencing tokens (Kleppmann 2016 lo demostró).
- ❌ Deploy sin canary a un servicio user-facing.
- ❌ Postmortem con "root cause = human error".
- ❌ Retries agresivos amplificando un fallo transitorio.
- ❌ Alertas no accionables (fatigue mata la reliability).
- ❌ Backup untested (Schrödinger backup — no existe hasta que restauras).

### Tabla de decisión: qué patrón para qué fallo

| Failure mode | Patrón primario | Patrón secundario |
|---|---|---|
| Dependency lenta (timing) | Timeout agresivo | Circuit breaker (slow calls) |
| Dependency caída (omission) | Circuit breaker | Fallback / feature flag |
| Spike de tráfico | Load shedding | Adaptive concurrency + autoscale |
| Retry storm | Backoff + jitter | Retry budget |
| Cliente que reintenta duplicando | Idempotency-Key | 409 con hint |
| Cascading failure | Bulkhead + timeout corto | Circuit breaker |
| Poison message | DLQ + alerta | Runbook manual |
| Cold start Lambda | Provisioned concurrency | SnapStart (Java) |
| Split-brain replica | Consensus (Raft/Paxos) | Fencing tokens |
| Long tail latency | Hedged request | Cache + prefetch |

---

## 9. Ejercicios prácticos

### Ejercicio 1: calibrar timeouts en LinguaDev Pro

**Objetivo:** definir y aplicar timeouts derivados del SLA en la Lambda de evaluación de respuestas del usuario.

**Setup:**
- Repositorio LinguaDev Pro clonado.
- Lambda `packages/api/src/lambdas/eval-answer.ts` que llama al proveedor LLM.
- SLA objetivo del endpoint: p99 < 3 s (tiempo antes de que el PWA muestre "reintentar").

**Pasos:**
1. Documenta el presupuesto: `SLA − overhead_lambda − network_margin`. Ejemplo: 3000 − 300 − 200 = 2500 ms para el LLM.
2. Configura `timeout` explícito en el cliente HTTP del proveedor (Anthropic/OpenAI SDK: `timeout: 2500`).
3. Propaga `X-Deadline-MS` en el header a componentes internos si los hay.
4. Añade log estructurado con `duration_ms`, `remaining_ms_at_call`, `timed_out` (boolean).
5. Configura CloudWatch metric filter para `timed_out=true`.
6. Verifica en staging con Toxiproxy inyectando 3 s de latencia:
   ```bash
   toxiproxy-cli create --listen 0.0.0.0:20001 --upstream api.anthropic.com:443 llm
   toxiproxy-cli toxic add llm -t latency -a latency=3000 -a jitter=200
   ```

**Criterios de éxito:**
- [ ] Timeout explícito ≤ 2500 ms en el cliente LLM.
- [ ] Header `X-Deadline-MS` propagado en 100% de invocaciones.
- [ ] Métrica `linguadev.eval.timeout` visible en CloudWatch.
- [ ] Con Toxiproxy inyectando 3 s, el endpoint devuelve 504 o fallback en < 2600 ms, no en 30 s.
- [ ] Sin timeout, ninguna request excede el p99 SLA.

**Bonus:** implementa `deadline aware` en la Lambda: si `remaining < 500 ms`, no llames al LLM y devuelve fallback inmediatamente.

---

### Ejercicio 2: implementar Idempotency-Key en el endpoint de review

**Objetivo:** el endpoint `POST /reviews` (registrar una revisión FSRS) debe ser idempotente ante retries del PWA.

**Setup:**
- Tabla DynamoDB `Reviews` o Postgres `reviews`.
- Cliente PWA que ya envía UUID v4 por review.

**Pasos:**
1. Crea la tabla `idempotency_keys` (Postgres) o añade un item por key en DynamoDB con TTL 72 h.
2. Escribe el middleware `idempotency.ts` siguiendo el patrón de la sección 5.1.
3. Asegura que la escritura del key + la review estén en la misma transacción (Postgres: `BEGIN … COMMIT`; DynamoDB: `TransactWriteItems`).
4. Test unitario: dos POST consecutivos con el mismo `Idempotency-Key` deben crear **una** review y devolver la misma response.
5. Test de conflicto: mismo key con body distinto → 422.
6. Verifica en la consola de DynamoDB / Postgres que sólo hay una fila.

**Criterios de éxito:**
- [ ] Header `Idempotency-Key` validado (UUID v4).
- [ ] Segunda request con mismo key devuelve status y body idénticos.
- [ ] Body distinto con mismo key → 422 con mensaje claro.
- [ ] Test de carga (`k6` con 100 clientes reintentando) no produce duplicados.
- [ ] TTL de 72 h configurado en la tabla.

**Bonus:** expone métrica `linguadev.reviews.idempotency_hit_rate` (% requests que devolvieron respuesta cacheada) y dashboarda.

---

### Ejercicio 3: Chaos engineering en la Lambda de evaluación

**Objetivo:** verificar que el circuit breaker y el fallback activan cuando el proveedor LLM está caído.

**Setup:**
- AWS Fault Injection Simulator (FIS) o Toxiproxy local.
- Métricas del circuit breaker exportadas (state, failure_rate).

**Pasos:**
1. Con Toxiproxy delante del endpoint del LLM: inyecta `down` (100% packet loss) durante 60 s.
2. Genera 20 requests al endpoint en ese intervalo.
3. Verifica en logs que las primeras N (según `minimumNumberOfCalls`) intentan; después, el circuito abre y las siguientes devuelven fallback inmediatamente.
4. Retira el `down`. Verifica que tras `waitDurationInOpenState`, el circuito entra HALF-OPEN, prueba 1 request, y cierra.
5. Documenta la línea de tiempo (timestamps de open/half-open/closed).

**Criterios de éxito:**
- [ ] Circuit breaker transiciona a OPEN < 10 s tras el fallo.
- [ ] Requests durante OPEN retornan fallback en < 50 ms.
- [ ] Circuit vuelve a CLOSED tras recuperación en < 30 s del "up".
- [ ] Ningún thread queda bloqueado esperando timeouts largos.
- [ ] Log estructurado con state transitions.

**Bonus:** repite con `latency=5000ms` (no down) y verifica que el `slowCallRateThreshold` también abre el circuito.

---

### Ejercicio 4: DLQ + alerting para la cola de evals asíncronas

**Objetivo:** procesar reviews en batch nocturno; los fallos permanentes van a DLQ con alerta.

**Setup:**
- SQS `EvalQueue` y DLQ `EvalDlq` (usa el CDK de §5.2).
- Worker Lambda que procesa mensajes.

**Pasos:**
1. Configura `maxReceiveCount: 5` en la SQS main.
2. Añade una CloudWatch alarm: `ApproximateNumberOfMessagesVisible >= 1` en la DLQ.
3. Simula un poison message: envía un mensaje con payload malformado.
4. Verifica que tras 5 intentos, aterriza en la DLQ.
5. La alarma debe disparar y enviar notificación (SNS → email/Slack).
6. Escribe un runbook `docs/runbooks/eval-dlq.md` con pasos: inspeccionar mensaje, decidir fix, reencolar con `aws sqs send-message`.

**Criterios de éxito:**
- [ ] `maxReceiveCount = 5` verificable en consola.
- [ ] Poison message llega a DLQ en < 5 min (con visibility timeout adecuado).
- [ ] Alarma dispara y notifica.
- [ ] Runbook existe y es probado por otro miembro del equipo.
- [ ] Métrica `linguadev.eval.dlq_depth` en dashboard.

**Bonus:** implementa endpoint interno `POST /admin/dlq/replay?id=<msg>` con auth para reencolar desde UI en vez de CLI.

---

### Ejercicio 5: GameDay de 30 min en LinguaDev Pro

**Objetivo:** simular un incidente y verificar la respuesta del equipo.

**Setup:**
- Un facilitador que conoce el escenario.
- El resto del equipo on-call.
- Grabar Zoom / logs de Slack para el postmortem.

**Escenario:**
- El facilitador mata pods de la Lambda `eval-answer` de forma progresiva (25%, 50%, 100%) durante 20 min.
- El equipo debe: detectar (alertas), diagnosticar (logs + traces), mitigar (rollback, feature flag, escalar), comunicar (statuspage interno).

**Pasos:**
1. Definir "steady state": eval success rate > 99%, p99 < 3 s.
2. Facilitador ejecuta la primera fase (25% pods down).
3. Cronometrar TTD (time-to-detect), TTA (acknowledge), TTM (mitigate).
4. Al final del ejercicio: postmortem blameless de 30 min. ¿Qué runbook faltó? ¿Qué alerta era ruidosa? ¿Qué automatización aceleraría la respuesta?
5. Action items concretos con owner y deadline.

**Criterios de éxito:**
- [ ] TTD < 2 min (alerta dispara automáticamente).
- [ ] TTM < 10 min (rollback o kill switch activado).
- [ ] Postmortem escrito y compartido.
- [ ] ≥ 3 action items rastreados en el backlog.
- [ ] Al menos un runbook actualizado con lo aprendido.

**Bonus:** repite trimestralmente con un escenario distinto (DB slow, Redis down, DNS interno flapping).

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades junior → staff. Cubren: availability y nines, failure modes (crash/omission/timing/response/byzantine + gray + metastable), health checks Kubernetes, graceful degradation, idempotency + retries, backoff y jitter, circuit breaker, timeouts calibrados, bulkhead, chaos engineering, fallback strategies, load shedding, rate limiting (token bucket, sliding window, leaky), distributed tracing con OpenTelemetry, RTO/RPO y backup, deploy strategies (blue-green, canary, rolling, feature flags), blameless postmortems, on-call sostenible, cascading failure, resilience testing, y framework de decisión completo.

- **Fuente:** [`packages/content/src/tech/architecture/sim-04-resilience-patterns.json`](../../packages/content/src/tech/architecture/sim-04-resilience-patterns.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-04-resilience-patterns`
- **Tiempo:** 60 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 03 — serverless y networking](./03-serverless-y-networking.md) · [Capítulo 05 — observabilidad y escala →](./05-observabilidad-y-escala.md) · [Índice](./README.md)
