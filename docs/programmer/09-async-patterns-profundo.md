# Capítulo 09 — Async patterns profundo

> **Focus:** Futures/promises internals, coroutines vs threads, structured concurrency, cancellation propagation, event loop y epoll/kqueue/io_uring, reactor vs proactor, backpressure, deadlocks async, race conditions con await, Java 21 virtual threads (GA), tokio internals, asyncio Python, Kotlin coroutines, Go CSP, Actor model.
> **Áreas:** Concurrency · Runtime · I/O internals · Distributed patterns.
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%.
> **Nivel:** Junior → Mid → Senior → Staff.

## 0. Antes de empezar

**Pre-requisitos:**
- Comprensión de threads OS y sincronización básica (mutex, condition variable).
- Nociones de sockets y syscalls (ver [Cap 07 — Networking](./07-networking-http-y-tcp.md)).
- Idealmente [Cap 08 — JIT/VM](./08-jit-vm-y-performance.md) para contexto de virtual threads y colored functions.
- Familiaridad con un lenguaje con `async/await` (JS, C#, Python, Rust, Kotlin).

**Glosario mínimo:**
- **Future/Promise**: contenedor de un valor que llegará después. Distintos nombres: `Future` (Java, Rust), `Promise` (JS, Scala), `Task` (.NET), `Deferred` (Kotlin).
- **Coroutine**: función suspendible que cede control voluntariamente y reanuda después. Usuario schedule, no OS.
- **Fiber / Green thread / Virtual thread**: thread manejado por runtime, no por kernel. Miles/millones por proceso.
- **Event loop**: bucle que procesa eventos I/O y ejecuta callbacks/tasks (Node, asyncio, tokio).
- **Reactor**: patrón donde el kernel notifica readiness (`epoll`) y el runtime hace la I/O (Netty, tokio).
- **Proactor**: patrón donde el kernel completa la I/O y notifica el resultado (io_uring, IOCP en Windows).
- **Backpressure**: mecanismo para que el consumidor lento freeze al productor rápido en vez de saturarlo.
- **Structured concurrency**: garantía de que todas las tareas hijas terminan antes que la padre; simplifica error handling y cancellation.
- **Cancellation**: notificar cooperativamente a una task que debe abortar y liberar recursos.
- **Deadlock async**: task espera a otra que espera a la primera, sin threads bloqueados pero también sin progreso.

**Setup mínimo:**

```bash
# Java 21+ LTS (virtual threads GA)
sdk install java 21.0.4-tem
sdk install java 25.0.0-tem

# Node 22+ (LTS 2026)
nvm install 22

# Python 3.13+
pyenv install 3.13.5
pip install trio anyio uvloop httpx

# Rust + tokio (LTS 1.51.x hasta marzo 2027)
rustup update stable

# Kotlin CLI (para coroutines)
sdk install kotlin

# Herramientas de debug
brew install jattach   # jstack por PID sin JDK completo
```

En Windows: virtual threads Java funcionan nativos; para `strace` y `epoll` usa WSL2.

---

## 1. El gran cuadro

Concurrencia es tratar múltiples cosas a la vez; paralelismo es hacerlas literalmente al mismo tiempo. Un programa con un core y `async/await` es concurrente pero no paralelo; un cluster K8s con 200 pods es ambas. La confusión entre ambos ha alimentado 15 años de decisiones arquitectónicas malas: "vamos a Node porque es rápido" (sin considerar CPU-bound), "reactive porque es moderno" (sin medir vs simple thread-per-request), "goroutines porque son ligeras" (sin entender su scheduler).

El segundo eje es el **cambio de paradigma 2020–2026**. Durante décadas, el modelo dominante fue "thread OS por task", limitado a ~5-10 k threads por proceso por coste de kernel stack (~1 MB cada uno) y context switches. Frameworks reactivos (Netty, Reactor, RxJava, Vert.x) surgieron para amortiguar esto con event loops y callbacks, a costa de complejidad brutal ("callback hell", "reactive is hard"). En 2021-2023 llegaron los **virtual threads** de Project Loom (Java 21 GA en sept 2023, JEP 444) y consolidaron los que ya existían en Go (goroutines, 2012) y Erlang (procesos, 1986): threads baratísimos manejados por runtime, thread-per-task escala a millones. En 2026, muchos equipos que estaban en WebFlux/Reactor voluntariamente vuelven a blocking code con virtual threads porque escala igual o mejor con 5% del código.

El tercer factor es la **evolución del kernel Linux**. `epoll` (2002) reemplazó `select/poll` con notificación edge-triggered escalable. `io_uring` (2019, Linux 5.1+) reemplaza el modelo reactor con proactor real: un ring buffer compartido usuario/kernel donde enqueue operations y kernel las completa, dramáticamente reduciendo syscalls. Adopción 2026: madura en runtimes de sistemas (nginx, ScyllaDB, Rust `glommio`), en tokio experimental via `tokio-uring` (aún en desarrollo lento, kernel 5.10+), y **el runtime rust más popular sigue siendo epoll-based** para portabilidad y estabilidad.

El cuarto vector es **structured concurrency**. Nathaniel J. Smith (Trio, 2018) formalizó que el modelo tradicional "lanza task y olvida" es una fuga de recursos y errores silenciosos. Java 21 promocionó `StructuredTaskScope` (JEP 453 preview, en JDK 25 va por 5º preview con JEP 505). Kotlin lo tiene desde 2018 con coroutine scopes. La idea: toda task hija tiene un scope padre; el scope no termina hasta que todas las hijas terminen; excepciones y cancelación se propagan por el árbol.

Este capítulo cubre por dentro cómo funcionan futures/promises, event loops, reactor vs proactor; qué patrón elegir (threads, async, actors, CSP, coroutines) por caso; los bugs típicos (thread starvation en `commonPool`, deadlock por bloquear el event loop, races con await, backpressure ignorada); y ejercicios reales aplicables al backend Node/Lambda de **LinguaDev Pro** y al PWA front.

---

## 2. Futures, promises y tasks: qué hay dentro (nivel medio)

### 2.1 Un futuro es una máquina de estados

Un `Future<T>` es un contenedor con estados: `Pending → Running → (Success(T) | Failure(E) | Cancelled)`. Todos los frameworks son variaciones:
- **Java** `CompletableFuture<T>`: encadenable con `.thenApply`, `.thenCompose`, ejecutable en un `Executor`.
- **JS** `Promise<T>`: `.then/.catch`, siempre corre en el event loop.
- **.NET** `Task<T>` / `ValueTask<T>`: ValueTask evita alocación cuando el valor ya está listo.
- **Rust** `Future`: **lazy** (no corre hasta que un executor lo drivea con `.poll()`).
- **Scala/Kotlin** `Future/Deferred`: eager, similar a CompletableFuture.

Diferencia crítica: en **JS y Java** el future empieza a ejecutar cuando lo creas (eager). En **Rust** no hace nada hasta que un `tokio::runtime` lo llama `poll` (lazy). Consecuencia: en Rust, olvidar `.await` es un warning que apaga el trabajo completo; en JS, olvidar `await` te da el promise pero el trabajo corre.

### 2.2 `async` como transformación del compilador

Cuando escribes:

```rust
async fn fetch(url: &str) -> Result<String, reqwest::Error> {
    let r = reqwest::get(url).await?;
    r.text().await
}
```

El compilador la transforma en una **state machine**: cada `.await` es un punto de suspensión. La función devuelve un `impl Future` con estado `{ url, fut1: Option<...>, fut2: Option<...>, state: Enum }`. Al llamar `.poll(cx)`, avanza al siguiente estado o devuelve `Pending` cuando espera I/O.

Similar en Kotlin: `suspend fun foo() { ... }` se compila a `foo(continuation)` con Continuation-Passing Style (CPS). En C#: `async Task<T>` genera un state machine con `MoveNext()`.

En Java 21 virtual threads **NO** usan esto: no hay `async` keyword. Un virtual thread es un thread real que bloquea, pero el bloqueo lo intercepta la JVM y monta el continuation en heap, liberando el carrier OS thread. Es "async transparente".

### 2.3 Colored functions y su fin

Bob Nystrom (2015) escribió "What Color is Your Function?": en lenguajes con `async/await`, las funciones se pintan de dos colores (sync/async) y no se pueden llamar entre sí libremente. Un `sync` no puede llamar a un `async`; un `async` sólo puede llamarse desde otro `async` o desde un runtime. Es fricción constante.

**Virtual threads y goroutines eliminan el color**: no hay `async` keyword. Todo es "sync"; el runtime hace la magia. Trade-off: menos control fino que Rust/tokio, pero el código es plano.

### 2.4 Cancellation en cada modelo

- **Rust**: canceling = drop the future. Cleanup por `Drop`. Simple y determinista.
- **Java `CompletableFuture.cancel(true)`**: no interrumpe automáticamente el trabajo que ya corre. Sólo funciona si el trabajo cooperativamente chequea `isCancelled()` o si estás usando virtual threads con `Thread.interrupt()`.
- **JS**: `Promise` no tiene cancel nativo. Usar `AbortController` + `signal`.
- **Kotlin coroutines**: cancellation cooperativa; `suspend fun` checkea `coroutineContext.isActive` en cada yield-point.
- **.NET**: `CancellationToken` propagado explícitamente.
- **Go**: `context.Context` con `WithCancel/WithTimeout/WithDeadline`.

**Regla común**: cancelación es **cooperativa** en todos los runtimes serios. El OS no puede interrumpir código en cualquier punto sin corrupción; el código debe chequear "¿me cancelaron?" en yield-points naturales.

---

## 3. Structured concurrency (nivel senior)

### 3.1 El problema con "fire-and-forget"

Código Java clásico:

```java
CompletableFuture.supplyAsync(() -> callDownstreamA());
CompletableFuture.supplyAsync(() -> callDownstreamB());
return "started";
```

Problemas:
1. Si uno lanza excepción, el otro sigue corriendo, tal vez para siempre.
2. Nadie hace `join` — resource leak potencial.
3. Cancelar la operación entera es imposible: no hay handle único.
4. Stack traces mienten: la excepción ocurre en un thread pool anónimo.

### 3.2 El fix: scope explícito

**Java 21+ `StructuredTaskScope`** (JEP 453, en preview; JDK 25 lo tiene en 5º preview, JEP 505):

```java
// Fetch2Downstreams.java
import java.util.concurrent.StructuredTaskScope;
import java.util.concurrent.StructuredTaskScope.Subtask;

record Combined(String a, String b) {}

Combined fetch() throws Exception {
    try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
        Subtask<String> fA = scope.fork(() -> callDownstreamA());
        Subtask<String> fB = scope.fork(() -> callDownstreamB());
        scope.join();               // espera a ambos
        scope.throwIfFailed();      // relanza excepción
        return new Combined(fA.get(), fB.get());
    }
}
```

Garantías:
- Ambas tasks corren en paralelo.
- Si una falla, la otra se **cancela automáticamente** (`ShutdownOnFailure`).
- El try-with-resources garantiza que ninguna hija sobreviva al método.
- Stack trace incluye la línea del `fork`.

Variantes:
- `ShutdownOnFailure`: cancela todas si una falla.
- `ShutdownOnSuccess`: cancela las demás cuando la primera termina exitosa (patrón "race").
- Custom `join`.

**Kotlin coroutines** llevan structured concurrency por default: cada launch/async está atado a un `CoroutineScope`. Salir del scope cancela hijos.

**Python trio** desde 2018:

```python
# trio_nursery.py
import trio, httpx

async def fetch(url):
    async with httpx.AsyncClient() as c:
        return (await c.get(url)).text

async def main():
    async with trio.open_nursery() as nursery:
        nursery.start_soon(fetch, "https://api.a.com")
        nursery.start_soon(fetch, "https://api.b.com")
    # nursery bloquea hasta ambas terminen; si una falla, cancela la otra

trio.run(main)
```

### 3.3 Virtual threads + structured concurrency

Java 21 GA de virtual threads (JEP 444) hizo `StructuredTaskScope` viable en producción: puedes fork millones de tasks sin agotar memory. Combinación estrella:

```java
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    // 1000 fetches en paralelo, cada uno en su virtual thread
    var subtasks = urls.stream()
        .map(url -> scope.fork(() -> httpClient.get(url)))
        .toList();
    scope.join().throwIfFailed();
    return subtasks.stream().map(Subtask::get).toList();
}
```

En 2026, Spring Boot 3.2+ activa virtual threads por default para `@RequestMapping`; muchos equipos han quitado WebFlux al descubrir que blocking + virtual threads escala igual con la mitad de código.

---

## 4. Virtual threads, coroutines, goroutines (nivel senior)

### 4.1 Java 21 virtual threads (JEP 444)

**Estado 2026** (verificado): virtual threads GA en JDK 21 (sept 2023). En JDK 25 (2026) hay refinamientos y `StructuredTaskScope` en 5º preview (JEP 505); `Scoped Values` finalizados (JEP 506). Los tools (JFR, jcmd, threaddump JSON) los soportan completamente.

Modelo:
- Un **virtual thread** es una lightweight thread manejado por la JVM.
- Corren sobre un pequeño pool de **carrier threads** (por default = `Runtime.availableProcessors()`).
- Cuando el virtual thread bloquea (I/O, `Thread.sleep`, `LockSupport.park`), la JVM **unmounts** el continuation y libera el carrier para otro virtual thread.
- Cuando la operación completa, la JVM **remounts** el virtual thread en cualquier carrier.

Coste: un virtual thread cuesta ~1 KB de heap. Millones son posibles.

```java
// VirtualThreadsDemo.java
import java.util.concurrent.Executors;
import java.util.stream.IntStream;

public class VirtualThreadsDemo {
    public static void main(String[] args) throws Exception {
        long t0 = System.nanoTime();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            IntStream.range(0, 10_000).forEach(i -> {
                executor.submit(() -> {
                    Thread.sleep(1000);       // I/O bound
                    return i;
                });
            });
        } // AutoCloseable: espera a que todas terminen
        System.out.printf("done in %.2f s%n", (System.nanoTime() - t0) / 1e9);
    }
}
```

10 000 tasks que duermen 1 s cada una terminan en ~1.1 s (todas en paralelo, virtual threads baratos), no en horas como con platform threads.

**Pinning**: si un virtual thread hace algo que no puede parkearse (bloqueo `synchronized` con recurso ocupado por otra platform thread, JNI call), se **pina** al carrier: no libera. JDK 24+ eliminó el pinning de `synchronized` (JEP 491, mejora clave). En 2026, usa `ReentrantLock` o `synchronized` moderno sin miedo.

### 4.2 Kotlin coroutines

Estructuralmente similar a virtual threads pero implementadas como CPS al compilar. Trade-offs:
- ✅ Muy livianas (miles de millones si hace falta).
- ✅ Structured concurrency por default (`coroutineScope`, `supervisorScope`).
- ✅ Cancelación cooperativa robusta.
- ✅ Flow para streaming reactivo integrado.
- ❌ "Coloring": `suspend` es color explícito.
- ❌ Debuggeo más difícil que virtual threads (stack traces re-armados).

```kotlin
// coroutines_demo.kt
import kotlinx.coroutines.*
import kotlin.system.measureTimeMillis

fun main() = runBlocking {
    val took = measureTimeMillis {
        coroutineScope {
            repeat(10_000) { i ->
                launch(Dispatchers.IO) {
                    delay(1000)
                    // trabajo I/O
                }
            }
        } // coroutineScope espera a todas
    }
    println("done in $took ms")
}
```

### 4.3 Go goroutines y CSP

Go tiene goroutines desde 2012, con scheduler MPG (M=machine/OS thread, P=processor, G=goroutine). Comunicación primaria: **channels** (CSP de Hoare 1978).

```go
// pipeline.go
package main

import (
    "context"
    "fmt"
    "sync"
    "time"
)

func producer(ctx context.Context, out chan<- int) {
    defer close(out)
    for i := 0; ; i++ {
        select {
        case <-ctx.Done():
            return
        case out <- i:
            time.Sleep(10 * time.Millisecond)
        }
    }
}

func consumer(ctx context.Context, in <-chan int, wg *sync.WaitGroup, id int) {
    defer wg.Done()
    for {
        select {
        case <-ctx.Done():
            return
        case v, ok := <-in:
            if !ok { return }
            fmt.Printf("[%d] got %d\n", id, v)
        }
    }
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
    defer cancel()

    ch := make(chan int, 8)   // buffer de 8 → backpressure natural
    var wg sync.WaitGroup

    go producer(ctx, ch)
    for i := 0; i < 3; i++ {
        wg.Add(1)
        go consumer(ctx, ch, &wg, i)
    }
    wg.Wait()
    fmt.Println("done")
}
```

Filosofía Go: "Don't communicate by sharing memory; share memory by communicating." Un channel expresa transferencia de ownership entre goroutines.

### 4.4 Actor model: Erlang, Akka

**Erlang/Elixir/OTP**: cada actor es un proceso ligero con su propio mailbox. Comunicación exclusivamente por mensajes async. Supervisors reinician actores que crashean ("let it crash"). Escalado horizontal built-in (distribución BEAM).

**Akka** (Scala/Java): implementación del actor model. Popular en trading systems, sistemas de baja latencia. Complejidad alta; en 2026 la comunidad se ha movido en parte a Kotlin coroutines o virtual threads para casos más simples.

### 4.5 Comparativa

| Modelo | Coste por unit | Coloring | Structured concurrency | Cancellation |
|---|---|---|---|---|
| Platform thread OS | ~1 MB | No | Manual | Cooperativa (interrupt) |
| Virtual thread Java 21 | ~1 KB | No | Sí (StructuredTaskScope) | Cooperativa |
| Goroutine Go | ~2 KB | No | Manual (context) | Context-based |
| Coroutine Kotlin | <1 KB | Sí (suspend) | Sí (scope) | Cooperativa (isActive) |
| Coroutine C# async | ~KB | Sí (async) | Manual | CancellationToken |
| Rust future | Bytes | Sí (async) | Manual (tokio spawn) | Drop the future |
| Erlang process | ~2 KB | No | Sí (supervisor) | Kill message |
| JS Promise | Bytes | Sí (async) | Manual | AbortController |

---

## 5. Event loops, reactor y proactor (nivel senior)

### 5.1 Node.js event loop en 30 segundos

Node es single-threaded en JS (más el worker pool libuv para file I/O). El event loop tiene fases:
1. **timers**: `setTimeout`, `setInterval` callbacks vencidos.
2. **pending callbacks**: I/O callbacks diferidos.
3. **idle, prepare**: interno.
4. **poll**: recibe events I/O (epoll/kqueue/IOCP), ejecuta sus callbacks.
5. **check**: `setImmediate` callbacks.
6. **close callbacks**: `socket.on('close')`.

Entre cada fase se drenan **microtasks**: `Promise.then`, `queueMicrotask`, `process.nextTick`. Un microtask que nunca termina bloquea el event loop indefinidamente.

Reglas de oro Node:
- Nunca hacer CPU-bound >10 ms en el hilo principal.
- Trabajos pesados: `worker_threads`.
- I/O: siempre async. Un `fs.readFileSync` en un handler HTTP mata el servidor.
- Cuidado con `JSON.parse` de payloads grandes.

### 5.2 asyncio Python

Python 3.4+ `asyncio` es similar: event loop, `async/await` con máquina de estados generada por compilador. `uvloop` (extension C basada en libuv) lo hace 2-3× más rápido, drop-in replacement.

```python
# asyncio_demo.py
import asyncio, httpx, time

async def fetch(client, url):
    r = await client.get(url)
    return r.status_code

async def main():
    urls = [f"https://linguadev.app/api/cards/{i}" for i in range(1, 51)]
    async with httpx.AsyncClient(http2=True, timeout=5.0) as c:
        t0 = time.perf_counter()
        codes = await asyncio.gather(*[fetch(c, u) for u in urls])
        print(f"{len(codes)} in {time.perf_counter()-t0:.2f}s")

asyncio.run(main())
```

Anti-patrón: `time.sleep(5)` en una coroutine bloquea el event loop entero. Usa `await asyncio.sleep(5)`.

### 5.3 Reactor vs proactor

**Reactor** (patrón clásico Netty, tokio, epoll-based):
1. Runtime registra "estoy interesado en readiness de FD X".
2. Kernel notifica con `epoll_wait` cuando FD está listo.
3. Runtime **hace la I/O** (`read`/`write`) que ya no bloquea.
4. Runtime notifica al code de usuario.

Coste: 1 syscall para saber que puedes leer + 1 syscall para leer = 2 syscalls por operación.

**Proactor** (IOCP en Windows, io_uring en Linux):
1. Runtime **encola la I/O completa** ("lee 4 KB desde FD X en este buffer").
2. Kernel la ejecuta.
3. Cuando termina, notifica con el resultado en un ring compartido.

Coste: 1 syscall (submit) + 0-1 (completion polling batched) = casi cero por operación.

### 5.4 io_uring en Linux

Introducido en 5.1 (mayo 2019), maduró rápidamente. En 2026:
- Estable y de uso creciente en runtimes sistema (nginx experimental, ScyllaDB, glommio, Redpanda).
- **tokio-uring** existe pero desarrollo lento; changelog no actualizado desde 2022. La comunidad prefiere `tokio` sobre epoll para portabilidad, y `glommio` (Bytedance) para io_uring puro. `io-uring` crate low-level (0.7.x) más activo.
- Kernel 5.10+ recomendado; muchas features nuevas (multishot poll, direct descriptors) llegan en versiones recientes.
- No portable: es Linux-only. Windows tiene IOCP hace décadas; macOS tiene kqueue.

Ventaja realista para servidores HTTP: 10-30% más throughput en cargas I/O-heavy. No siempre worth it vs mantener code portable con epoll.

### 5.5 Ejemplo tokio moderno

```rust
// tokio_server.rs   cargo add tokio -F full
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:7000").await?;
    println!("listening on 7000");

    loop {
        let (socket, addr) = listener.accept().await?;
        tokio::spawn(async move {
            if let Err(e) = handle(socket).await {
                eprintln!("client {addr} err: {e}");
            }
        });
    }
}

async fn handle(stream: TcpStream) -> std::io::Result<()> {
    let (r, mut w) = stream.into_split();
    let mut reader = BufReader::new(r);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 { return Ok(()); }
        w.write_all(format!("echo: {line}").as_bytes()).await?;
    }
}
```

`tokio::spawn` crea una task lightweight. Cada conexión = 1 task. `tokio` en 2026 va por 1.52.x (LTS 1.47 hasta sept 2026, LTS 1.51 hasta marzo 2027). Debajo: multithread scheduler con work-stealing, epoll/kqueue via `mio`.

---

## 6. Race conditions y sincronización moderna (nivel medio-senior)

### 6.1 Data races vs race conditions

- **Data race**: dos threads acceden a la misma memoria sin sincronización, al menos uno escribe. Undefined behavior en C++ y Java Memory Model, undefined en Rust (imposible en safe code).
- **Race condition**: cualquier bug donde el resultado depende del scheduling. Puede existir sin data race (patrón check-then-act sobre atomic, TOCTOU con filesystem).

### 6.2 Primitivas modernas

**Java `AtomicX`** encapsula CAS (Compare-And-Swap) hardware:

```java
// Contadores contendidos
private final AtomicLong counter = new AtomicLong();
public void inc() { counter.incrementAndGet(); }

// Bajo contención masiva mejor:
private final LongAdder adder = new LongAdder();
public void inc2() { adder.increment(); }  // sharding interno
public long get() { return adder.sum(); }
```

`LongAdder` (JDK 8+) distribuye el contador en cells por thread; reduce contención vs `AtomicLong` bajo carga masiva a costa de lectura O(n).

**Java `VarHandle`**: acceso ordenado a fields con semántica clara (`getAcquire`, `setRelease`, `compareAndSet`, `getPlain`). Reemplaza `Unsafe` para code moderno.

**Rust `Arc<Mutex<T>>`, `RwLock<T>`, `AtomicX`**: type-checked. `Send`/`Sync` traits garantizan safety en compile time.

**Go `sync.Mutex`, `sync/atomic`, `sync.RWMutex`, `sync.Map`, `sync.Once`**: idiomático. Preferir channels cuando sea natural.

### 6.3 CAS y el ABA problem

CAS actualiza si el valor actual coincide con el esperado. Problema **ABA**: hilo lee A, otro cambia a B y vuelve a A; primer hilo CAS(A, C) succeeds pensando que nada cambió. Solución: versión monotónica junto al valor (`AtomicStampedReference` en Java, tags en pointers, generación counter).

### 6.4 Deadlock detection

Deadlock clásico: dos threads adquieren locks en orden opuesto.

```java
Object A = new Object(), B = new Object();

new Thread(() -> { synchronized (A) { synchronized (B) { /* work */ } } }).start();
new Thread(() -> { synchronized (B) { synchronized (A) { /* work */ } } }).start();
```

Debug:
- `jstack <pid>` → sección "Found one Java-level deadlock" cuando el JVM detecta ciclo por locks propios.
- `jcmd <pid> Thread.print` → equivalente.
- Deadlock async (por futures esperándose): no lo detecta la JVM automáticamente. Herramientas: `BlockHound` (Reactor), thread dumps periódicos, tracing (OpenTelemetry).

Prevención:
- **Lock ordering global**: siempre adquirir en orden alfabético/numérico.
- **Timeout en lock acquisition** (`ReentrantLock.tryLock(timeout)`).
- **Menos locks**, más immutabilidad.
- **Message passing** (channels, actors) en vez de shared mutable state.

### 6.5 Race con `await`

Anti-patrón en JS/asyncio: check-then-act atravesando un `await`:

```js
// Bug: dos requests concurrentes crean 2 usuarios en vez de 1
async function findOrCreate(email) {
  const existing = await db.users.findOne({ email });
  if (existing) return existing;
  return db.users.insert({ email });      // race con otras invocaciones
}
```

Fix: unique index en DB + try/catch de duplicate, o lock distribuido, o `INSERT ... ON CONFLICT`. La regla: entre dos `await`, otro trabajo puede pasar.

---

## 7. Backpressure y saturación (nivel senior)

### 7.1 El problema

Productor rápido + consumidor lento sin backpressure = memoria explotada. Escenarios reales:
- Kafka consumer procesa lento, mete todo en `Queue` en memoria → OOM.
- SSE server manda 10 k msg/s, cliente móvil recibe 100 msg/s → buffer del socket kernel llena → app RAM sube → OOM.
- WebSocket con `send()` sin control de `bufferedAmount` → mismo problema.
- Log appender async con `LinkedBlockingQueue(unbounded)` → OOM en pico de tráfico.

### 7.2 Estrategias

1. **Blocking**: el productor bloquea cuando el buffer se llena. `LinkedBlockingQueue(capacity)`, `SynchronousQueue`. Simple pero acopla productor y consumidor.
2. **Drop**: descartar mensajes viejos o nuevos. Válido para telemetría, monitoring. Nunca para datos financieros.
3. **Coalesce**: agrupar N mensajes en uno. Perfecto para updates de UI ("progresa 45%" reemplaza "progresa 40%").
4. **Rate limit / throttle**: productor limita su tasa de envío.
5. **Pull-based (demand-driven)**: consumidor pide N; productor envía N; consumidor pide más. Reactive Streams spec exactamente esto.

### 7.3 Reactive Streams

Estándar cross-vendor (Reactor, RxJava, Akka Streams, Mutiny) desde 2015, incorporado a JDK 9 `java.util.concurrent.Flow`. Contrato:

```
Publisher.subscribe(Subscriber) →
  Subscriber.onSubscribe(Subscription) →
    Subscription.request(n) →
      Publisher.emit onNext × n hasta n items o onError/onComplete
```

Ejemplo Reactor:

```java
// Backpressure con overflow strategy
Flux<Card> highVolume = readKafka();
highVolume
    .onBackpressureBuffer(1000, BufferOverflowStrategy.DROP_OLDEST)
    .publishOn(Schedulers.boundedElastic())
    .flatMap(this::process, /* concurrency */ 8)
    .subscribe();
```

Con virtual threads, el patrón "blocking + bounded pool" también es válido y a menudo más simple.

### 7.4 Backpressure en WebSockets Node

```js
// ws_backpressure.js
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8081 });
wss.on('connection', ws => {
  const timer = setInterval(() => {
    // Nunca escribas si buffer > 1 MB
    if (ws.bufferedAmount > 1_000_000) {
      // opcional: dropear muestras hasta que baje
      return;
    }
    ws.send(JSON.stringify({ ts: Date.now(), payload: 'x'.repeat(10_000) }));
  }, 10);
  ws.on('close', () => clearInterval(timer));
});
```

---

## 8. Async I/O: epoll, io_uring, thread starvation (nivel staff)

### 8.1 Thread starvation en `ForkJoinPool.commonPool()`

Muchos runtimes (CompletableFuture default, Streams parallel, Reactor `parallel` scheduler) usan `ForkJoinPool.commonPool()` (`Runtime.availableProcessors() - 1` threads). Si un endpoint hace blocking allí, todo el pool se satura y otros endpoints no responden.

Fix:
1. Nunca hacer blocking en `commonPool`.
2. Usar `Schedulers.boundedElastic()` (Reactor) para blocking.
3. Virtual threads: cada task va a un virtual thread; el bloqueo libera el carrier.
4. En Node: `worker_threads` para CPU-bound blocking.

### 8.2 Sizing thread pools (Ley de Little revisitada)

Para I/O bound: `pool_size = throughput × latency × (1 + wait/service)`. Ejemplo Brian Goetz: si un servicio hace call HTTP con 100 ms de latency y quieres 200 req/s de throughput, necesitas 20 threads activos (`0.1 × 200`). Buffer 2-3×.

Para CPU-bound: `pool_size ≈ cores` (o cores+1 para GC).

Anti-patrón: 200 threads "porque escala mejor". Bajo carga baja, muchos threads dormidos consumen memoria; bajo alta, contention por locks internos y GC pressure.

### 8.3 Fork/Join framework

Java `ForkJoinPool` implementa **work-stealing**: cada thread tiene su propia deque; cuando su deque está vacía, roba de otra. Ideal para divide-and-conquer:

```java
// TreeSum.java
import java.util.concurrent.RecursiveTask;
import java.util.concurrent.ForkJoinPool;

class Node { long value; Node[] children; }

class SumTask extends RecursiveTask<Long> {
    private final Node node;
    SumTask(Node n) { this.node = n; }
    @Override protected Long compute() {
        if (node.children == null || node.children.length == 0) return node.value;
        var subtasks = new SumTask[node.children.length];
        for (int i = 0; i < node.children.length; i++) {
            subtasks[i] = new SumTask(node.children[i]);
            subtasks[i].fork();   // encola en propia deque
        }
        long total = node.value;
        for (var t : subtasks) total += t.join();
        return total;
    }
}

// Uso
ForkJoinPool pool = new ForkJoinPool();
long total = pool.invoke(new SumTask(root));
```

Con virtual threads + `StructuredTaskScope`, patrones similares con más flexibilidad para I/O mixto.

### 8.4 Immutabilidad como estrategia

Si un objeto no cambia, no hay race. Java `record`, Scala `case class`, Kotlin `data class` + `val`, Rust `let` (por default). Persistente structures (Clojure's, Java `List.copyOf`) crean nueva versión sin mutar la vieja.

Trade-offs:
- ✅ Simplifica razonamiento concurrente.
- ✅ Elimina toda una clase de bugs.
- ❌ Alocación extra (GC pressure).
- ❌ No siempre modelable (mutable state es a veces la spec).

Regla útil: **default immutable, opt-in mutable**.

---

## 9. Ejemplo integrado: pipeline concurrent en LinguaDev Pro

Escenario: la Lambda `POST /api/study/answer` recibe la respuesta del usuario, actualiza FSRS state en DynamoDB, llama a un LLM para generar feedback y publica un evento SNS. Requerimos concurrency para bajar latency, structured concurrency para robustez.

### 9.1 Con virtual threads + StructuredTaskScope

```java
// StudyAnswerHandler.java
import java.util.concurrent.StructuredTaskScope;
import java.util.concurrent.StructuredTaskScope.Subtask;

public class StudyAnswerHandler {

    record Result(FsrsUpdate fsrs, String feedback, String eventId) {}

    public Result handle(AnswerRequest req) throws Exception {
        try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
            Subtask<FsrsUpdate> fFsrs = scope.fork(() ->
                fsrsService.updateAndPersist(req.cardId(), req.grade()));
            Subtask<String>     fLlm  = scope.fork(() ->
                llmClient.generateFeedback(req.userText(), req.expected()));
            Subtask<String>     fEvt  = scope.fork(() ->
                snsClient.publish("study-answered", req.userId()));

            scope.join().throwIfFailed();

            return new Result(fFsrs.get(), fLlm.get(), fEvt.get());
        }
    }
}
```

Beneficios:
- Latency = max(fsrs, llm, sns) en vez de suma.
- Si LLM falla, todo se cancela; no orphan SNS event.
- Con virtual threads, cada fork es ~1 KB de heap.

### 9.2 Con Kotlin coroutines

```kotlin
// StudyAnswerHandler.kt
suspend fun handle(req: AnswerRequest): Result = coroutineScope {
    val fsrs = async(Dispatchers.IO) { fsrsService.updateAndPersist(req.cardId, req.grade) }
    val feedback = async(Dispatchers.IO) { llmClient.generateFeedback(req.userText, req.expected) }
    val event = async(Dispatchers.IO) { snsClient.publish("study-answered", req.userId) }
    Result(fsrs.await(), feedback.await(), event.await())
}
```

### 9.3 Con Node y `Promise.all`

```js
// study-answer.js
export async function handle(req, { fsrs, llm, sns }) {
  const controller = new AbortController();
  const opts = { signal: controller.signal };
  try {
    const [fsrsUpdate, feedback, eventId] = await Promise.all([
      fsrs.updateAndPersist(req.cardId, req.grade, opts),
      llm.generateFeedback(req.userText, req.expected, opts),
      sns.publish('study-answered', req.userId, opts),
    ]);
    return { fsrsUpdate, feedback, eventId };
  } catch (err) {
    controller.abort(err);      // cancela las otras en vuelo
    throw err;
  }
}
```

Node no tiene structured concurrency built-in, así que replicamos con `AbortController`. En 2026, la propuesta `Promise.withResolvers` y patrones agnostic-of-scope emergen; `AsyncContext` para tracing.

### 9.4 Instrumentar con OpenTelemetry

```java
// Instrumenta cada subtask
Subtask<FsrsUpdate> fFsrs = scope.fork(() -> {
    var span = tracer.spanBuilder("fsrs.update").startSpan();
    try (var ss = span.makeCurrent()) {
        return fsrsService.updateAndPersist(req.cardId(), req.grade());
    } finally {
        span.end();
    }
});
```

Un buen trace en OpenTelemetry muestra las 3 subtasks en paralelo en la timeline; si una es la más lenta, la ves inmediatamente.

---

## 10. Cheatsheet, reglas y anti-patrones

### Reglas de oro

- ✅ **Structured concurrency** por default: `StructuredTaskScope`, `coroutineScope`, `trio.open_nursery`.
- ✅ **Virtual threads** en Java 21+ para I/O concurrente; olvida los pools de 200 threads.
- ✅ **Cancelación cooperativa**: propaga `Context`/`CancellationToken`/`AbortSignal`.
- ✅ **Deadline end-to-end** propagado, no timeouts por hop desincronizados (ver [Cap 07 §5.2](./07-networking-http-y-tcp.md#52-timeouts-que-no-matan-al-sistema)).
- ✅ **Backpressure explícita**: buffer bounded, drop/coalesce/pull.
- ✅ **Nunca bloquees el event loop** (Node, asyncio, tokio).
- ✅ **Nunca bloquees `commonPool`** en Java pre-virtual-threads.
- ✅ **Immutabilidad por default**; mutable state es opt-in.
- ✅ **Deadlock prevention**: lock ordering, `tryLock` con timeout, message passing.
- ✅ **CAS/atomic** para contadores; `LongAdder` bajo alta contención.
- ✅ **Instrumenta con tracing** (OpenTelemetry) — es la única forma de ver deadlocks async.
- ✅ **Sizing por Ley de Little** con márgen realista.

### Anti-patrones

- ❌ "Fire and forget" con `CompletableFuture.supplyAsync(...)` sin join ni cancel.
- ❌ `Thread.sleep` en coroutine o `time.sleep` en asyncio.
- ❌ Bloquear una virtual thread por JNI o synchronized con contención (pinning; ya menos con JDK 24+).
- ❌ `Queue` sin bound como buffer productor-consumidor.
- ❌ `synchronized` de granularidad gruesa para todo (contention masiva).
- ❌ Retriar dentro de retriar (amplificación exponencial).
- ❌ `Promise.all` sin `AbortController` cuando cancel importa.
- ❌ Cancel non-cooperativo (`Thread.stop` — deprecated y peligroso).
- ❌ Compartir estado mutable entre goroutines sin channels ni mutex.
- ❌ `sync.Map` cuando `RWMutex+map` sería más simple.
- ❌ Actor model para todo (over-engineering en 90% de casos).

### Tabla decisión: qué runtime concurrente elegir

| Caso | Recomendación |
|---|---|
| Backend Java existente, I/O bound | Virtual threads (JDK 21+) + `StructuredTaskScope` |
| Backend Kotlin, ecosistema Ktor/Spring | Kotlin coroutines |
| Backend Go greenfield | goroutines + channels |
| Sistema baja latencia extrema (trading, ad-tech) | Rust + tokio, o Erlang/Elixir |
| API front en Node existente | asyncio/Node event loop + Promise.all |
| CPU-bound puro en Python | `multiprocessing` o Rust extension; considerar 3.14 free-threaded |
| CLI tool con I/O paralela | Go o Rust |
| Sistema distribuido tolerante a fallos, hot-swap | Erlang/OTP |
| Streaming/reactive con backpressure fine-grained | Kotlin Flow o Rust Streams |
| Pipeline batch simple | Structured concurrency > reactive |

---

## 11. Ejercicios prácticos

### Ejercicio 1: replicar 10 000 tareas con virtual threads

**Objetivo:** experimentar la escala de virtual threads Java 21.

**Setup:** JDK 21+.

**Pasos:**
1. Escribe `VirtualThreadsDemo` de §4.1 pero con `10_000_000` (10 M) tasks que hacen `Thread.sleep(100)`.
2. Corre y mide.
3. Compara con la versión que usa `Executors.newFixedThreadPool(200)`.
4. Observa memoria residente durante la ejecución.

**Criterios de éxito:**
- [ ] 10 M virtual threads corren en <30 s.
- [ ] Con `newFixedThreadPool(200)`, tardaría muchísimo más (200 × 100 ms × 50 000 batches).
- [ ] RSS de virtual threads < 3 GB.
- [ ] Documento con las cifras.

**Bonus:** activa `-Djdk.tracePinnedThreads=full` y verifica que no hay pinning.

---

### Ejercicio 2: structured concurrency vs fire-and-forget

**Objetivo:** ver cómo structured concurrency simplifica error handling.

**Setup:** JDK 21+.

**Pasos:**
1. Escribe una versión con `CompletableFuture.supplyAsync × 3` sin join.
2. Escribe la misma con `StructuredTaskScope.ShutdownOnFailure`.
3. Introduce una excepción en la task B a los 200 ms.
4. Observa qué pasa con las tasks A y C en ambos casos.

**Criterios de éxito:**
- [ ] En la versión "fire and forget", A y C siguen corriendo.
- [ ] En la versión structured, A y C reciben cancelación al fallar B.
- [ ] La excepción propaga limpiamente con stack trace útil.

**Bonus:** haz lo mismo con Kotlin coroutines y compara syntax.

---

### Ejercicio 3: deadlock reproducible y detección con jstack

**Objetivo:** reconocer y diagnosticar deadlock clásico.

**Setup:** JDK 21+, `jstack`.

**Pasos:**
1. Copia el ejemplo de dos threads con locks A/B en orden opuesto (§6.4).
2. Corre. La app se cuelga.
3. En otra terminal: `jps` para encontrar PID; `jstack <pid>` para ver el reporte.
4. Localiza la sección "Found one Java-level deadlock".
5. Aplica lock-ordering fix y verifica que ya no ocurre.

**Criterios de éxito:**
- [ ] jstack reporta el deadlock con ambos threads y sus locks.
- [ ] La fix elimina el deadlock reliably.
- [ ] Documento con snippet del reporte de jstack.

**Bonus:** reemplaza `synchronized` con `ReentrantLock.tryLock(timeout)` y muestra que evita el hang.

---

### Ejercicio 4: race condition con `await`

**Objetivo:** encontrar y arreglar un bug clásico de race async.

**Setup:** Node o Python.

**Pasos:**
1. Implementa `findOrCreate(email)` con `findOne` + `insert` como en §6.5.
2. Con `Promise.all` invoca 10 veces concurrentes con el mismo email.
3. Observa duplicados en la DB.
4. Arréglalo con unique index + try/catch de duplicate key, o transacción `SELECT FOR UPDATE`, o `INSERT ... ON CONFLICT`.
5. Repite el load test; ahora hay 1 solo user.

**Criterios de éxito:**
- [ ] Bug reproducible en al menos 3 corridas.
- [ ] Fix documentado y probado.
- [ ] Test automatizado que valida el invariant "1 user por email".

**Bonus:** implementa idempotency-key en el endpoint y prueba con retries de cliente.

---

### Ejercicio 5: backpressure en un pipeline Kafka → HTTP

**Objetivo:** implementar backpressure real cuando el productor supera al consumidor.

**Setup:** Kafka local (Docker), servicio Java o Kotlin.

**Pasos:**
1. Produce 100 k mensajes a un topic.
2. Consumidor lento (sleep 50 ms por mensaje) mete en `LinkedBlockingQueue(unbounded)` y otro thread los procesa.
3. Corre y observa memoria explotar.
4. Reemplaza con `LinkedBlockingQueue(1000)` con bloqueo del productor Kafka cuando llene.
5. Verifica que memoria se mantiene estable.
6. Añade métricas de queue size (Micrometer/OpenTelemetry).

**Criterios de éxito:**
- [ ] Versión sin bound: RSS crece continuamente.
- [ ] Versión con bound: RSS estable, consumer lag crece controlado.
- [ ] Métrica de queue size expuesta y visible en un dashboard local.

**Bonus:** implementa la misma pipeline con Reactor `onBackpressureBuffer(1000, DROP_OLDEST)` y compara semántica.

---

### Ejercicio 6 (bonus): comparar epoll vs io_uring en Rust

**Objetivo:** experimentar io_uring vs epoll con throughput real.

**Setup:** Linux kernel 5.10+, Rust stable, cargo.

**Pasos:**
1. Escribe un servidor TCP echo con `tokio` (epoll).
2. Escribe la misma versión con `tokio-uring` o `glommio`.
3. Genera 100 k conexiones cortas con `oha` o script custom.
4. Mide throughput (req/s) y CPU consumption.
5. Documenta diferencias.

**Criterios de éxito:**
- [ ] Ambas versiones compilan y corren.
- [ ] Reporte comparativo con throughput y CPU.
- [ ] Observación explicada (io_uring gana en syscall-heavy, empata en workloads pequeños).

**Bonus:** repite con Node `--experimental-node-uring` (si tu Node lo soporta) y compara.

---

## 12. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas por dificultad junior → staff. Cubren: Future vs Promise vs Task; structured concurrency vs unstructured; virtual threads y Project Loom en Java 21; cancellation cooperativa; backpressure en pipelines; sizing de thread pool por Ley de Little; race conditions y CAS; Kotlin coroutines vs threads; event loop de Node single-threaded; actor model Erlang/Akka; CSP y Go channels; deadlock detection con jstack; Fork/Join framework; reactive streams Reactor/RxJava; semaphore vs mutex vs condition; immutabilidad como estrategia concurrente; async I/O epoll vs io_uring; structured concurrency vs supervisors Erlang; thread starvation en `commonPool`; y decisión final threads vs async vs actors vs coroutines por caso.

- **Fuente:** [`packages/content/src/tech/programmer/sim-09-async-patterns-deep.json`](../../packages/content/src/tech/programmer/sim-09-async-patterns-deep.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-09-async-patterns-deep`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 08 — JIT, VM y performance](./08-jit-vm-y-performance.md) · [Índice](./README.md) · [Capítulo 10 — Error handling y recovery →](./10-error-handling-y-recovery.md)
