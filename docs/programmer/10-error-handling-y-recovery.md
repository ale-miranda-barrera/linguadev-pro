# Capítulo 10 — Error handling y recovery

> **Focus:** Diseñar sistemas que fallen bien: retry con backoff, idempotencia, circuit breakers, sagas, DLQs, timeout budgets, panic recovery y postmortems blameless.
> **Áreas:** Reliability · Distributed systems · Error handling · Ops
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de concurrencia y async (ver [Cap 09 — async patterns profundo](./09-async-patterns-profundo.md)).
- Conceptos básicos de HTTP/TCP: status codes, timeouts, keep-alive.
- Familiaridad con al menos un lenguaje que soporte excepciones (Python, Java, JS) y uno con errors as values (Go, Rust) para comparar modelos.
- Nociones mínimas de sistemas distribuidos: partial failure, network partitions, mensajes duplicados.
- Haber roto algo en producción alguna vez (importante — la humildad es requisito).

**Glosario mínimo:**
- **Retry:** volver a intentar una operación fallida. Sin control es peligroso.
- **Exponential backoff:** cada retry espera `base * 2^n` antes del siguiente intento.
- **Jitter:** aleatoriedad añadida al backoff para evitar el *thundering herd*.
- **Circuit breaker:** interruptor que abre el circuito tras N fallos y deja de intentar durante un tiempo.
- **Bulkhead:** aislar recursos por consumer para que la falla de uno no hunda a los demás (mamparos de barco).
- **DLQ** (Dead Letter Queue): cola donde acaban los mensajes que no se pudieron procesar después de todos los reintentos.
- **Idempotencia:** propiedad de que ejecutar la operación N veces da el mismo resultado que ejecutarla 1 vez.
- **Idempotency key:** identificador enviado por el cliente para deduplicar reintentos server-side.
- **Saga:** transacción distribuida por pasos compensables, sin locks globales.
- **At-least-once:** garantía de que el mensaje se entrega al menos una vez (posiblemente más).
- **Exactly-once:** propiedad *aspiracional*; en la práctica se logra con at-least-once + idempotencia.
- **Timeout budget:** presupuesto total de tiempo para una request end-to-end, dividido entre sus dependencias.
- **Panic:** en Go, un error irrecuperable que aborta la goroutine; se captura con `recover()`.
- **Postmortem blameless:** análisis post-incidente que investiga causas sistémicas, no culpables.
- **Poison message:** mensaje malformado que hace crashear al consumer una y otra vez.

**Setup mínimo:**

```bash
# Python — tenacity para retry con backoff
pip install tenacity==9.0.0 httpx==0.28.1

# Node — cockatiel para retries + circuit breaker
pnpm add cockatiel@3

# Go — dependencias std lib bastan; para métricas
go get github.com/sony/gobreaker/v2

# Java — Resilience4j (2026 sigue siendo el standard)
# build.gradle: implementation("io.github.resilience4j:resilience4j-spring-boot3:2.3.0")

# Chaos engineering local con toxiproxy (Shopify)
docker run -d --name toxiproxy -p 8474:8474 -p 8666:8666 \
  ghcr.io/shopify/toxiproxy:2.11.0
```

---

## 1. El gran cuadro

En 2026 casi ningún sistema serio corre en un solo proceso. La request de un usuario cruza CDN, balanceador, API gateway, tres microservicios, cache, base de datos primaria, réplica y una cola. Cada uno de esos saltos puede fallar de forma **parcial**: timeout, 5xx transitorio, deserialización rota, contención de conexiones, GC pause, red particionada. La cuestión ya no es *"cómo evito los errores"* sino *"cuando ocurran —y ocurrirán— cómo hago que el sistema se recupere sin daño colateral, sin duplicados y sin caer en cascada"*.

Los pilares del error handling moderno son cinco y se enseñan juntos porque se aplican juntos: **timeouts agresivos**, **retries con backoff + jitter**, **circuit breakers** que dejan de martillar dependencias caídas, **idempotencia** que hace seguros los reintentos, y **fallbacks** que degradan la experiencia en lugar de romperla. Todo esto se combina con **observabilidad** (métricas de éxito/error, p50/p99, tasa de retry) para que puedas ver el sistema respirando y actuar antes de que muera.

Casos reales 2015-2025 muestran el precio de fallar en esto: AWS S3 (feb 2017) tumbado por un typo que cascadeó porque nadie había probado la restart de un subsystem gigante; GitLab (enero 2017) perdiendo 6 h de datos por un rm -rf en la primary sin réplica útil; Facebook (oct 2021) fuera 6 h por un BGP misconfig sin canary; Cloudflare (jun 2022, jul 2024, jun 2025) con incidentes de config global sin rollout gradual; CrowdStrike (jul 2024) tumbando 8.5M máquinas Windows por un canal de update no validado. En todos, la raíz técnica no fue "un bug", fue **ausencia de mecanismos de contención de fallos**.

Este capítulo cubre el kit completo, con código real en Python, Go, TypeScript, Java y SQL. Aterriza los patrones en el proyecto **LinguaDev Pro** al final: endpoint de evaluación LLM con retry + circuit breaker + idempotencia, DLQ para reintentos manuales, saga para la coreografía de "usuario paga → se asignan lecciones → se envía email".

---

## 2. Fundamentos: fail-fast, exceptions vs errors as values, wrapping

### 2.1 Fail-fast, fail-loud, no fail-silent

La regla número uno del error handling es que **un error silenciado es un bug garantizado dentro de tres meses**. Escribir `try: ... except: pass` sin más es el atajo directo a producción rota sin diagnóstico. La comunidad Go la codificó en un principio: *"don't just check errors, handle them gracefully"*. Rob Pike, 2015.

Fail-fast significa que ante una condición imposible el proceso debe pararse ya, no propagar datos corruptos. Erlang lleva esta filosofía al extremo con *"let it crash"*: los procesos caen, el supervisor los reinicia, el sistema converge a un estado sano. Contrastar con el anti-patrón *defensive-everywhere*, donde cada línea envuelve todo en try/except y termina ocultando bugs.

```python
# ANTI-PATRON: silenciar
def parse_amount(s: str) -> float:
    try:
        return float(s)
    except Exception:
        return 0.0  # HORROR: cobrar 0 en lugar de fallar

# BIEN: validar y propagar con contexto
class InvalidAmountError(ValueError):
    def __init__(self, raw: str, reason: str):
        super().__init__(f"Invalid amount {raw!r}: {reason}")
        self.raw = raw
        self.reason = reason

def parse_amount(s: str) -> float:
    if not s:
        raise InvalidAmountError(s, "empty string")
    try:
        v = float(s)
    except ValueError as e:
        raise InvalidAmountError(s, str(e)) from e
    if v < 0 or v != v:  # negativo o NaN
        raise InvalidAmountError(s, f"out of range: {v}")
    return v
```

### 2.2 Exceptions vs errors as values

Hay dos escuelas de modelado de errores:

- **Exceptions** (Java, Python, C#, JS): el flujo normal devuelve valor; el flujo excepcional propaga hacia arriba en la stack. Ventaja: código feliz limpio. Costo: control flow oculto, catch-all peligrosos, coste de stack unwinding.
- **Errors as values** (Go, Rust, funcional): la función devuelve `(value, error)` o `Result<T, E>`. Ventaja: el error es explícito en la firma, imposible de olvidar sin que el compilador te avise (Rust) o el linter (Go: `errcheck`). Costo: verbosidad.

En 2026 la industria converge en una síntesis pragmática: **excepciones para lo verdaderamente excepcional** (invariantes rotas, panics), **errores como valores para lo esperable** (validación, IO, timeouts). Python añadió `ExceptionGroup` y `except*` en 3.11 para agrupar errores concurrentes; Java lleva años con `sealed` types que permiten simular `Result`; TypeScript tiene librerías como `neverthrow` que emulan Rust.

```go
// Go — errors as values con wrapping (patrón desde Go 1.13)
package payments

import (
    "errors"
    "fmt"
)

var (
    ErrInsufficientFunds = errors.New("insufficient funds")
    ErrCardDeclined      = errors.New("card declined")
)

type ChargeError struct {
    UserID  string
    Amount  int64
    Wrapped error
}

func (e *ChargeError) Error() string {
    return fmt.Sprintf("charge failed user=%s amount=%d: %v", e.UserID, e.Amount, e.Wrapped)
}

func (e *ChargeError) Unwrap() error { return e.Wrapped }

func Charge(userID string, amountCents int64) error {
    if amountCents > getBalance(userID) {
        return &ChargeError{userID, amountCents, ErrInsufficientFunds}
    }
    // ...
    return nil
}

// Caller
err := Charge("u_42", 5000)
if errors.Is(err, ErrInsufficientFunds) {
    // manejo específico
}
var chErr *ChargeError
if errors.As(err, &chErr) {
    log.Printf("failed charge for %s", chErr.UserID)
}
```

### 2.3 Error wrapping: preservar el contexto

Un error sin contexto es un bug sin diagnóstico. El patrón `errors.Wrap` (Go), `raise X from Y` (Python), `throw new Error(msg, { cause })` (JS desde ES2022) preserva la cadena original mientras añade info sobre *dónde* falló.

```python
# Python 3.11+
try:
    data = json.loads(payload)
except json.JSONDecodeError as e:
    raise IngestError(f"failed to parse payload from {source}") from e
```

```typescript
// TypeScript / Node 20+
try {
  await db.query(sql);
} catch (e) {
  throw new Error(`db query failed for user ${userId}`, { cause: e });
}
```

En logs y APM (Datadog, Sentry, Honeycomb) la cadena `cause` se renderiza jerárquica: mensaje humano en el top, stack raíz en la base. Regla: **nunca hagas `except: pass` ni `catch { return null }`** sin loguear y sin adjuntar el error a la métrica correspondiente.

---

## 3. Retries con backoff y jitter

### 3.1 Por qué retry ingenuo es peligroso

Cuando un servicio downstream tiene un pico de latencia, cinco clientes reintentando cada 100 ms lo hunden más rápido de lo que puede recuperarse. Este es el *retry storm* o *thundering herd*. La AWS Architecture Blog publicó en 2015 el paper *"Exponential Backoff and Jitter"* que popularizó tres reglas:

1. **Exponential backoff:** el retry N-ésimo espera `base * 2^N`, con techo.
2. **Jitter:** añade aleatoriedad para desincronizar clientes.
3. **Retry budget:** limita el porcentaje de retries respecto a requests exitosas (típicamente 10-20%).

Fórmulas clásicas:

- *Full jitter*: `sleep = random(0, base * 2^n)` — el mejor para carga.
- *Equal jitter*: `sleep = base * 2^n / 2 + random(0, base * 2^n / 2)`.
- *Decorrelated jitter*: `sleep = min(cap, random(base, prev * 3))` — evita bursts sincronizados con múltiples clientes.

### 3.2 Implementación Python con tenacity

```python
# retries.py
import httpx
from tenacity import (
    retry, wait_exponential_jitter, stop_after_attempt,
    retry_if_exception_type, before_sleep_log,
)
import logging

log = logging.getLogger(__name__)

@retry(
    retry=retry_if_exception_type((httpx.TimeoutException, httpx.ConnectError)),
    wait=wait_exponential_jitter(initial=0.2, max=8.0, jitter=1.0),
    stop=stop_after_attempt(5),
    before_sleep=before_sleep_log(log, logging.WARNING),
    reraise=True,
)
def fetch_lesson(client: httpx.Client, lesson_id: str) -> dict:
    r = client.get(f"/lessons/{lesson_id}", timeout=3.0)
    r.raise_for_status()
    return r.json()
```

**Detalles críticos:**

- Sólo reintenta errores **transitorios**: timeouts, 5xx, `ConnectError`. NO reintentes 4xx (excepto 408, 425, 429): el request es inválido, retry no lo arregla.
- `reraise=True` propaga el error final tras agotar attempts, no envuelve en `RetryError` opaco.
- `before_sleep_log` deja rastro observable.

### 3.3 Implementación Go con backoff nativo

```go
// retry.go
package retry

import (
    "context"
    "errors"
    "math"
    "math/rand/v2"
    "time"
)

type Config struct {
    MaxAttempts int
    Base        time.Duration
    Cap         time.Duration
}

var ErrRetryable = errors.New("retryable")

func Do(ctx context.Context, cfg Config, op func(context.Context) error) error {
    var lastErr error
    for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
        err := op(ctx)
        if err == nil {
            return nil
        }
        if !errors.Is(err, ErrRetryable) {
            return err // fail-fast en errores no retryables
        }
        lastErr = err

        // Decorrelated jitter (AWS blog)
        expo := time.Duration(math.Pow(2, float64(attempt))) * cfg.Base
        if expo > cfg.Cap {
            expo = cfg.Cap
        }
        sleep := time.Duration(rand.Int64N(int64(expo)))

        select {
        case <-time.After(sleep):
        case <-ctx.Done():
            return ctx.Err()
        }
    }
    return lastErr
}
```

Uso:

```go
cfg := retry.Config{MaxAttempts: 5, Base: 200 * time.Millisecond, Cap: 10 * time.Second}
err := retry.Do(ctx, cfg, func(ctx context.Context) error {
    resp, err := client.Do(req.WithContext(ctx))
    if err != nil {
        return fmt.Errorf("%w: %v", retry.ErrRetryable, err)
    }
    if resp.StatusCode >= 500 || resp.StatusCode == 429 {
        return fmt.Errorf("%w: status %d", retry.ErrRetryable, resp.StatusCode)
    }
    if resp.StatusCode >= 400 {
        return fmt.Errorf("non-retryable status %d", resp.StatusCode)
    }
    return nil
})
```

### 3.4 Retry-After y 429

Cuando el downstream responde `429 Too Many Requests` con header `Retry-After`, respétalo. Ignorarlo empeora todo:

```typescript
// TS/Node
async function callWithRetryAfter(url: string, attempts = 4): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url);
    if (r.status !== 429 && r.status < 500) return r;
    const retryAfter = r.headers.get("retry-after");
    const waitMs = retryAfter
      ? Math.max(1000, parseInt(retryAfter, 10) * 1000)
      : Math.min(30_000, 200 * 2 ** i);
    const jitter = Math.random() * waitMs * 0.2;
    await new Promise((res) => setTimeout(res, waitMs + jitter));
  }
  throw new Error(`giving up on ${url}`);
}
```

---

## 4. Circuit breaker, bulkhead, timeouts

### 4.1 Circuit breaker — teoría y estados

Michael Nygard formalizó el patrón en *Release It!* (2007). Tres estados:

- **Closed:** requests pasan; el breaker cuenta fallos. Si `error_rate > threshold` en ventana, transiciona.
- **Open:** requests se rechazan de inmediato (fail-fast). Ahorras carga a la downstream muerta. Tras `resetTimeout`, transiciona.
- **Half-open:** deja pasar un puñado de requests probe. Si tienen éxito → Closed. Si fallan → Open.

Sin breaker, cinco mil clientes reintentan indefinidamente contra un servicio caído, saturan sus conexiones, e impiden la recuperación. Con breaker, el sistema deja de pegar durante 30 s y **le da al downstream aire para recuperarse**.

### 4.2 Java — Resilience4j 2.3

Resilience4j sigue siendo el estándar Java en 2026, sucesor de Hystrix (deprecated 2018). El orden de decoradores importa: **retry envuelve al breaker, no al revés**, para que cada intento cuente en la ventana del breaker.

```java
// resilience.java
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import io.github.resilience4j.retry.Retry;
import io.github.resilience4j.retry.RetryConfig;
import io.github.resilience4j.decorators.Decorators;
import java.time.Duration;
import java.util.function.Supplier;

public class LessonClient {

    private final CircuitBreaker breaker;
    private final Retry retry;

    public LessonClient() {
        var cbCfg = CircuitBreakerConfig.custom()
            .failureRateThreshold(50f)          // 50% de fallos -> open
            .slowCallRateThreshold(60f)          // 60% de calls lentas -> open
            .slowCallDurationThreshold(Duration.ofSeconds(2))
            .waitDurationInOpenState(Duration.ofSeconds(30))
            .permittedNumberOfCallsInHalfOpenState(3)
            .slidingWindowSize(50)
            .minimumNumberOfCalls(20)
            .recordExceptions(java.io.IOException.class,
                              java.util.concurrent.TimeoutException.class)
            .build();
        breaker = CircuitBreaker.of("lessons", cbCfg);

        var retryCfg = RetryConfig.custom()
            .maxAttempts(3)
            .intervalFunction(io.github.resilience4j.core.IntervalFunction
                .ofExponentialRandomBackoff(200, 2.0, 0.5, 5_000))
            .retryOnException(t -> t instanceof java.io.IOException)
            .build();
        retry = Retry.of("lessons", retryCfg);
    }

    public Lesson fetch(String id) {
        Supplier<Lesson> supplier = () -> httpGet("/lessons/" + id);
        var decorated = Decorators.ofSupplier(supplier)
            .withCircuitBreaker(breaker)
            .withRetry(retry)
            .decorate();
        return decorated.get();
    }
}
```

Baeldung y OneUptime documentan este orden como el correcto en 2026: retry por fuera, breaker por dentro. Ver `resilience4j-spring-boot3:2.3.0`.

### 4.3 Bulkhead — aislar consumers

Un bulkhead limita el número de concurrent calls por dependencia. Si el pool de conexiones a Postgres se agota porque un batch job las consume todas, los requests HTTP quedan sin poder hacer query. Con bulkheads separados (pool `web`, pool `batch`), la caída de uno no arrastra al otro.

```go
// bulkhead.go — semáforo simple
type Bulkhead struct {
    sem chan struct{}
}

func New(concurrency int) *Bulkhead {
    return &Bulkhead{sem: make(chan struct{}, concurrency)}
}

func (b *Bulkhead) Do(ctx context.Context, op func() error) error {
    select {
    case b.sem <- struct{}{}:
        defer func() { <-b.sem }()
        return op()
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

### 4.4 Timeout budget

Cada request tiene un presupuesto total end-to-end (ej. 3 s hasta el cliente). Ese presupuesto debe **repartirse** entre las dependencias, no reutilizarse entero. Si tu handler llama a A (1.5 s), B (1 s) y C (1 s), sumas 3.5 s y ya rompes SLO.

Patrón deadline propagation con `context.Context` (Go), `AbortSignal.timeout()` (JS), `httpx.Timeout` (Python):

```go
func Handler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 2500*time.Millisecond)
    defer cancel()

    // A: 1s max
    aCtx, aCancel := context.WithTimeout(ctx, 1*time.Second)
    defer aCancel()
    a, err := serviceA.Get(aCtx)

    // B: reparte lo que queda entre B y C
    remaining := time.Until(deadline(ctx))
    bCtx, bCancel := context.WithTimeout(ctx, remaining/2)
    // ...
}
```

Regla dura: si el ctx padre expira, propagar cancel a hijos elimina work no útil (goroutines colgadas, conexiones abiertas).

### 4.5 Timeouts en cascada — el bug clásico

Servicio A tiene timeout 5 s, llama a B con timeout 5 s, B llama a C con timeout 5 s. Cuando C tarda 4.9 s, B espera 4.9 s, A recibe la respuesta a los 4.9 s. Todo bien.

Cuando C se cuelga, B espera 5 s, cae por timeout, pero A ya expiró a los 5 s y devolvió error al cliente. Peor: el retry del cliente pega otra vez, y ahora tienes duplicados en vuelo. La regla: **los timeouts deben decrecer aguas arriba** (A: 5 s, B: 4 s, C: 3 s) para que aguas arriba siempre reciba error antes de expirar por su cuenta.

---

## 5. Idempotencia, at-least-once y exactly-once

### 5.1 Por qué la idempotencia es la piedra angular

En sistemas distribuidos, **exactly-once entrega es una ilusión**. El teorema de las dos generales (1975) muestra que dos partes no pueden acordar con certeza sobre un canal no fiable. Kafka, SQS, RabbitMQ, incluso HTTP: todos garantizan **at-least-once** en la práctica. La única forma de lograr semántica *effectively exactly-once* es **combinar at-least-once con operaciones idempotentes**.

Una operación es idempotente si `f(f(x)) == f(x)`. Ejemplos:

- ✅ `PUT /users/42 {name: "Ana"}` — poner es idempotente.
- ✅ `SET quantity = 3` — idempotente.
- ❌ `POST /orders` — crea nueva orden cada vez.
- ❌ `UPDATE balance = balance + 100` — suma cada vez.

### 5.2 Idempotency keys (patrón Stripe)

Cuando la operación es intrínsecamente no-idempotente (cobros, envíos de mail), el cliente envía un `Idempotency-Key` (UUID). El server guarda `key → response` y ante retry devuelve la respuesta cacheada sin re-ejecutar.

```sql
-- Postgres 17
CREATE TABLE idempotency_records (
    key            UUID PRIMARY KEY,
    request_hash   BYTEA NOT NULL,        -- SHA256 del body
    response_body  JSONB,
    status_code    SMALLINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours'
);
CREATE INDEX ON idempotency_records (expires_at);
```

```python
# fastapi_idempotency.py
from fastapi import FastAPI, Header, HTTPException, Request
import hashlib, json, uuid

app = FastAPI()

@app.post("/charges")
async def create_charge(
    request: Request,
    idempotency_key: uuid.UUID = Header(alias="Idempotency-Key"),
):
    body = await request.body()
    req_hash = hashlib.sha256(body).digest()

    async with db.transaction():
        row = await db.fetchrow(
            "SELECT request_hash, response_body, status_code, completed_at "
            "FROM idempotency_records WHERE key = $1 FOR UPDATE",
            idempotency_key,
        )
        if row:
            if row["request_hash"] != req_hash:
                raise HTTPException(409, "Idempotency key reused with different body")
            if row["completed_at"] is not None:
                return row["response_body"]  # ya terminado, devolver cacheado
            raise HTTPException(409, "Request in progress")

        await db.execute(
            "INSERT INTO idempotency_records (key, request_hash) VALUES ($1, $2)",
            idempotency_key, req_hash,
        )

    # Ejecutar cobro real
    result = await stripe_charge(json.loads(body))

    await db.execute(
        "UPDATE idempotency_records SET response_body=$1, status_code=$2, completed_at=now() "
        "WHERE key=$3",
        json.dumps(result), 200, idempotency_key,
    )
    return result
```

Puntos críticos:

- La transacción SQL con `FOR UPDATE` evita que dos requests concurrentes con la misma key ejecuten dos veces.
- Se hashea el body para detectar el error del cliente que reusa la key con payload distinto (regresar 409).
- TTL de 24 h ligado a expiración; job diario borra caducados.

### 5.3 Deduplicación en consumers (Kafka)

Cuando consumes Kafka con `enable.auto.commit=true`, el consumer puede procesar un mensaje y morir antes de commitear el offset: el siguiente consumer lo re-procesa. Solución patrones:

- **DedupCache** (Redis SET NX con TTL): `SET msg:<id> 1 NX EX 3600`. Si devuelve false, ya procesado.
- **Transaccional (Kafka Streams EOS):** `processing.guarantee=exactly_once_v2`. Bien para pipelines Kafka-a-Kafka; no ayuda con side effects externos.
- **Outbox pattern:** producer escribe a tabla `outbox` en la misma transacción que su cambio; un poller relay envía a Kafka. Elimina dual-write.

---

## 6. Saga pattern y transacciones distribuidas

### 6.1 Por qué 2PC no escala

Two-Phase Commit garantiza atomicidad entre nodos, pero **bloquea recursos** durante la fase de preparación. En microservicios con 5-10 servicios, un participante lento bloquea a todos. Además, si el coordinador cae en la fase 2, todos quedan en limbo. La industria abandonó 2PC para operaciones cross-service en los 2010s.

### 6.2 Saga — coreografía vs orquestación

Hector Garcia-Molina, 1987. Una saga es una secuencia de transacciones locales. Cada una tiene su **compensación**. Si el paso 5 falla, se ejecutan las compensaciones de 4, 3, 2, 1 en reverso.

Dos estilos:

- **Coreografía:** cada servicio escucha eventos y publica los suyos. Simple con pocos pasos; se complica con muchos (nadie ve el flujo completo).
- **Orquestación:** un orquestador central llama a cada servicio y ordena compensaciones. Fácil de razonar; punto único de complejidad.

### 6.3 Ejemplo LinguaDev Pro — saga de onboarding

Flujo: usuario paga suscripción → se crea cuenta → se generan lecciones iniciales → se envía email de bienvenida.

```typescript
// saga-onboarding.ts
type Step<T> = {
  name: string;
  exec: (ctx: T) => Promise<Partial<T>>;
  compensate: (ctx: T) => Promise<void>;
};

async function runSaga<T>(steps: Step<T>[], initial: T): Promise<T> {
  const done: Step<T>[] = [];
  let ctx = { ...initial };
  try {
    for (const step of steps) {
      const patch = await step.exec(ctx);
      ctx = { ...ctx, ...patch };
      done.push(step);
    }
    return ctx;
  } catch (err) {
    for (const step of done.reverse()) {
      try {
        await step.compensate(ctx);
      } catch (compErr) {
        // Log crítico: compensación falló, requiere intervención humana
        console.error(`compensation failed for ${step.name}`, compErr);
      }
    }
    throw err;
  }
}

// Uso
const onboarding: Step<Ctx>[] = [
  {
    name: "charge",
    exec: async (c) => ({ chargeId: await stripe.charge(c.userId, c.amount) }),
    compensate: async (c) => { if (c.chargeId) await stripe.refund(c.chargeId); },
  },
  {
    name: "provision-account",
    exec: async (c) => ({ accountId: await accounts.create(c.userId) }),
    compensate: async (c) => { if (c.accountId) await accounts.deactivate(c.accountId); },
  },
  {
    name: "generate-lessons",
    exec: async (c) => ({ lessonIds: await lessons.seed(c.accountId, c.level) }),
    compensate: async (c) => { if (c.lessonIds) await lessons.remove(c.lessonIds); },
  },
  {
    name: "welcome-email",
    exec: async (c) => { await email.send(c.userId, "welcome"); return {}; },
    compensate: async () => { /* no-op: emails no se "descompensan" */ },
  },
];
```

**Lecciones cruciales:**

- Cada paso debe ser **idempotente** (retry-safe): las compensaciones también se pueden reintentar.
- Algunas acciones no compensan (email enviado, mensaje escrito en foro público). Diseña el orden para que estas sean **las últimas**.
- Persiste el estado de la saga (`sagas` table) para poder reanudar tras un crash del orquestador.

### 6.4 Rollback vs compensación

En SQL, `ROLLBACK` deshace mágicamente porque el DB tiene MVCC. En sistemas distribuidos no existe rollback: hay que **compensar** con una acción semánticamente inversa (refund de un charge, delete de un user creado). No es lo mismo: el refund puede tardar 3-5 días en aparecer en la tarjeta del cliente.

---

## 7. Dead Letter Queues, poison messages y background jobs

### 7.1 DLQ — la red de seguridad

Un consumer que no puede procesar un mensaje debe tener a dónde mandarlo. Sin DLQ, tres alternativas y todas malas:

- **Loop infinito:** el mensaje se reintenta para siempre; bloquea la partition (Kafka) o consume workers (SQS).
- **Silent drop:** el mensaje se pierde; nadie se entera.
- **Crash del consumer:** el proceso muere y reinicia; el mensaje vuelve; loop de crashes.

Con DLQ: tras N intentos fallidos, el mensaje se enrutea a `<topic>-dlq` con metadata (razón, timestamp, retry count). Un humano o proceso auxiliar los revisa.

### 7.2 SQS DLQ (AWS)

```json
{
  "QueueName": "lessons-generation",
  "RedrivePolicy": {
    "deadLetterTargetArn": "arn:aws:sqs:us-east-1:123:lessons-generation-dlq",
    "maxReceiveCount": 5
  }
}
```

Tras 5 intentos con `ReceiveMessage` sin `DeleteMessage`, SQS mueve el mensaje al DLQ automáticamente.

### 7.3 Kafka retry topics

Spring Kafka en 2026 sigue la convención Uber (2018):

```
lessons.generate
  ├── lessons.generate.retry.1s
  ├── lessons.generate.retry.5s
  ├── lessons.generate.retry.30s
  └── lessons.generate.dlq
```

Consumer principal falla → produce a `.retry.1s`. Consumer del retry topic espera hasta que el timestamp del mensaje + 1s haya pasado, luego lo procesa. Escala en tres niveles. Si al final falla, DLQ.

### 7.4 Poison message

Un mensaje que hace crash al consumer (deserialización rota, invariante violada). Sin manejo: bloquea la partition. Patrón:

```java
// Spring Kafka poison handler
@Bean
DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> tmpl) {
    var recoverer = new DeadLetterPublishingRecoverer(tmpl,
        (rec, ex) -> new TopicPartition(rec.topic() + ".dlq", rec.partition()));
    return new DefaultErrorHandler(recoverer,
        new ExponentialBackOffWithMaxRetries(3));
}
```

### 7.5 Background jobs — Sidekiq / Celery / Cloud Tasks

Todos los frameworks serios de background jobs tienen retry policy + DLQ built-in:

- **Sidekiq (Ruby):** `dead set` tras 25 intentos con backoff exponencial. Interfaz web para inspeccionar.
- **Celery (Python):** `autoretry_for`, `retry_backoff`, `max_retries`. Failure state en result backend.
- **Cloud Tasks (GCP):** `retryConfig.maxAttempts` + `maxRetryDuration`. Sin DLQ nativo hasta 2024, ahora sí.
- **BullMQ (Node):** `attempts`, `backoff: { type: 'exponential', delay: 1000 }`, `failed jobs queue`.

---

## 8. Panic recovery en Go, error boundaries en React, defensive vs offensive

### 8.1 Go panic/recover

Un `panic` en Go aborta la goroutine y sube por el stack. Si nadie lo captura, mata el proceso. En servidores HTTP, un panic en un handler mata **todo** el servidor a menos que uses `recover()`:

```go
// middleware/recovery.go
func Recovery(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                stack := debug.Stack()
                log.Printf("panic: %v\n%s", err, stack)
                metrics.PanicsTotal.WithLabelValues(r.URL.Path).Inc()
                http.Error(w, "internal error", http.StatusInternalServerError)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

Regla: **recover() solo en el nivel más externo** (middleware HTTP, boundary de goroutine worker). NO uses recover para control de flujo dentro de funciones normales — es el equivalent a un try/catch de "ignora todo".

### 8.2 React error boundaries

React 16+ introdujo `componentDidCatch` para evitar que un error en un componente hijo desmonte todo el árbol. En 2026 con React 19 el patrón es el mismo:

```tsx
class ErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo) {
    console.error("boundary caught", err, info.componentStack);
    // Sentry.captureException(err, { contexts: { react: info } });
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

// Uso
<ErrorBoundary fallback={<p>Algo falló, refresca la página.</p>}>
  <LessonPlayer />
</ErrorBoundary>
```

Boundaries NO capturan: errores en event handlers, código async (usa try/catch), SSR errors (Next.js tiene `error.tsx` para eso).

### 8.3 Defensive vs offensive programming

- **Defensive:** valida entradas de todos lados. Útil en la frontera del sistema (parsers, endpoints públicos).
- **Offensive (design by contract):** asume invariantes internas ciertas; usa `assert`. Útil en código de dominio interno.

Anti-patrón: defensive everywhere, con `if (x != null) { if (x.foo != null) { ... } }` en cada línea. Añade ruido, no información, y oculta el bug real cuando `x` es null porque un caller lo pasó mal (el fallo debe estar arriba en la stack).

---

## 9. Chaos engineering, observabilidad de errores y postmortems

### 9.1 Chaos engineering

Netflix popularizó Chaos Monkey (2011) y luego Simian Army. La premisa: si no rompes tu sistema en prueba, se romperá solo en producción. Herramientas 2026:

- **Chaos Mesh** (CNCF, K8s): pod kill, network delay, IO error, DNS chaos.
- **Litmus** (CNCF): experimentos declarativos.
- **Gremlin** (SaaS): failure injection controlado.
- **Toxiproxy** (Shopify): proxy TCP que inyecta latencia, drops, jitter. Perfecto para dev local.

```bash
# Toxiproxy — 500ms de latencia extra a Redis
docker exec toxiproxy /toxiproxy-cli create redis \
  --listen 0.0.0.0:6379 --upstream redis-real:6379
docker exec toxiproxy /toxiproxy-cli toxic add redis \
  -t latency -a latency=500
```

### 9.2 Golden signals y SLOs

Google SRE Book (2016) define los 4 golden signals:

- **Latency** (p50, p99, p999).
- **Traffic** (requests/s).
- **Errors** (rate, %).
- **Saturation** (CPU, memory, pool).

Un SLO típico: `99.9% de requests con latencia < 500 ms medidos en ventana rolling 28d`. El error budget es 0.1% × traffic. Cuando el budget se agota, congela features y prioriza reliability.

### 9.3 Postmortem blameless

Convención Google/Etsy. Post-incidente:

- Timeline objetivo (cuando cayó, cuando se detectó, cuando se resolvió).
- Impacto medible (requests fallidos, usuarios afectados, ingresos perdidos).
- Root cause **técnica y sistémica** (no "Juan hizo push a main").
- Action items con owner y deadline.
- Lecciones para el equipo, no reprimendas.

Regla del *blameless*: el humano actuó dado la información y presión que tenía. La pregunta es "¿por qué el sistema permitió ese error?", no "¿por qué el humano falló?". Corolario: si un incidente ocurrió, hay al menos 3 causas sistémicas que lo permitieron (falta de gate, falta de test, falta de alerta).

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales de producción. Cubren: fail-fast vs silent, exceptions vs errors as values, wrapping con contexto, retry con exponential backoff + jitter, idempotency keys, at-least-once vs exactly-once, DLQs, saga pattern y compensación, circuit breaker + bulkhead, timeouts en cascada, panic recovery en Go, poison messages en Kafka, background job retries, defensive vs offensive, chaos engineering y postmortems blameless.

- **Fuente:** [`packages/content/src/tech/programmer/sim-10-error-handling-and-recovery.json`](../../packages/content/src/tech/programmer/sim-10-error-handling-and-recovery.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-10-error-handling-and-recovery`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 09 — async patterns profundo](./09-async-patterns-profundo.md) · [Capítulo 11 — bases de datos para devs →](./11-bases-de-datos-para-devs.md) · [Índice](./README.md)
