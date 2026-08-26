# Capítulo 03 — Concurrencia, async y race conditions

> **Focus:** Race conditions, deadlocks, async/await vs threads, idempotencia, atomicidad, uso correcto de estructuras concurrentes y las trampas que solo aparecen bajo carga real.
> **Áreas:** Concurrencia · Fundamentos
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- [Cap 01 — fundamentos y complejidad](./01-fundamentos-y-complejidad.md): stack vs heap, referencia vs valor.
- [Cap 02 — SOLID y patrones](./02-solid-y-patrones.md): encapsulamiento (base para razonar sobre estado compartido).
- Un lenguaje con soporte de concurrencia real: Java, Go, Kotlin, C#, Rust o Python.
- Nociones de qué es un thread OS y qué es un proceso.

**Glosario mínimo:**
- **Concurrencia vs paralelismo:** estructura para lidiar con múltiples tareas vs ejecución física simultánea (Rob Pike).
- **Race condition:** resultado del programa depende del orden no determinista de ejecución entre threads.
- **Deadlock:** dos o más threads esperando indefinidamente recursos que el otro tiene.
- **Livelock:** threads activos pero sin progreso (baile perpetuo evitándose).
- **Backpressure:** mecanismo para que un consumer lento indique al producer "ve más lento".
- **Idempotencia:** ejecutar N veces produce el mismo resultado que ejecutar una vez.
- **Happens-before:** relación formal del memory model que garantiza visibilidad entre threads.
- **Virtual thread (Loom):** thread ligero gestionado por la JVM (~KB por thread vs MB de un platform thread).
- **CAS (Compare-And-Swap):** primitiva atómica de hardware; base de lock-free algorithms.
- **False sharing:** dos variables lógicamente separadas caen en la misma cache line y se invalidan mutuamente.

**Setup mínimo (2026):**

```bash
# Versiones verificadas (agosto 2026)
java --version          # 21 LTS o 25 (con virtual threads maduros)
python --version        # 3.13 (GIL default) o 3.14 free-threaded
go version              # go1.26 (Green Tea GC default)
node --version          # 22 LTS o 24 LTS
rustc --version         # 1.82+

# Herramientas
sysctl kern.osrelease   # kernel (macOS/Linux)
htop                    # visualizar threads
async-profiler          # tracing async en Java
py-spy                  # profiling Python
```

En Python 3.14, el build free-threaded (`--disable-gil`) ya no es experimental pero sigue sin ser default. Overhead single-thread bajó de ~40% (3.13) a 5-10% (3.14). Se espera GIL opt-out en 2027-2028.

---

## 1. El gran cuadro

Concurrencia es donde los programadores mediocres se convierten en programadores buenos y donde los programadores buenos se convierten en programadores mediocres. La razón es simple: nuestros modelos mentales están cableados para secuencial. Cuando dos threads leen y escriben la misma variable, el número de intercalaciones posibles es astronómico y ninguna intuición sobreviene sin herramientas conceptuales precisas. Un bug secuencial se puede depurar con `print`. Un bug de concurrencia aparece solo bajo carga en producción, un martes a las 3 de la madrugada, con un thread dump de 200 páginas y un stack trace inútil.

El coste real de la concurrencia mal implementada es medible y público. Ticketmaster ha tenido bugs históricos de sobre-venta por race conditions en "check-then-act". El famoso *double-checked locking* pre-Java 5 rompió sistemas durante años porque el memory model permitía ver objetos parcialmente construidos. AWS 2019 sufrió cascading failures cuando miles de clientes reintentaron simultáneamente sin jitter — thundering herd. Discord migró servicios críticos a Rust porque las pausas de GC en Go tumbaban p99. Todos son bugs de concurrencia que ningún test unitario dispara.

Pero el panorama cambió radicalmente entre 2023 y 2026. Java 21 (sept 2023) llevó **virtual threads (Project Loom)** a producción. Java 25 (2025) reduce dramáticamente el *pinning* con `synchronized` (JEP 491). En 2025, muchos equipos Spring empezaron a REMOVER WebFlux (paradigma reactivo) para volver a `RestController` bloqueante ejecutándose sobre virtual threads — código secuencial simple con la performance del async. Python 3.13 abrió la puerta al mundo sin GIL. Go 1.26 (feb 2026) trae el Green Tea GC por defecto, con pausas dramáticamente menores. Rust se consolidó como la opción cuando la concurrencia sin data races se puede probar en compile time.

Este capítulo cubre los cimientos que no cambian con las modas: qué es una race condition, cómo se manifiestan deadlocks y livelocks, por qué la inmutabilidad elimina clases enteras de bugs, cuándo async gana y cuándo threads ganan, cómo dimensionar thread pools, y cuáles son las estrategias industriales para sistemas distribuidos (idempotencia, at-least-once + dedup, backpressure, distributed locks con fencing tokens). Al final tendrás las herramientas conceptuales para diagnosticar, no adivinar.

---

## 2. Fundamentos (nivel básico)

### 2.1 Concurrencia ≠ paralelismo

Rob Pike, co-creador de Go: *"Concurrency is about dealing with lots of things; parallelism is about doing lots of things"*.

- **Concurrencia:** ESTRUCTURA para manejar múltiples tareas potencialmente simultáneas. Interleaving, task switching. En 1 core puedes tener concurrencia (event loop, threads con time slicing).
- **Paralelismo:** EJECUCIÓN física simultánea. Múltiples cores/máquinas. Requiere hardware.

Casos:
- Node.js con event loop en 1 core: concurrente, no paralelo.
- Un batch job con 4 workers en 4 cores: paralelo, y concurrente.
- Un web server Java con 200 threads en 8 cores: concurrente (200 tareas) y paralelo (hasta 8 en cualquier instante).

Consecuencias:
- Programas concurrentes bien diseñados ESCALAN cuando les das paralelismo.
- Paralelismo sin concurrencia bien pensada da race conditions inmediatas.
- I/O-bound gana con concurrencia (async, threads con espera).
- CPU-bound requiere paralelismo real (múltiples cores trabajando).
- Python con GIL tiene concurrencia (threads) pero NO paralelismo de bytecode Python (para CPU-bound: `multiprocessing` o C extensions que liberen GIL).

### 2.2 GIL de Python: verdades y mentiras

Mitos comunes:
- *"Python nunca escala"* — falso. Instagram, Dropbox, YouTube corren Python en producción con miles de rps.
- *"Los threads en Python son inútiles"* — falso. Son útiles para I/O-bound (mientras un thread espera red/disco, el GIL se libera y otro thread ejecuta bytecode).
- *"El GIL es un bug"* — falso. Es una decisión de diseño que simplifica el runtime y la extensión C API. Trade-off consciente.

Verdades:
- El GIL impide que múltiples threads ejecuten BYTECODE Python simultáneamente.
- Los threads Python SÍ son útiles para I/O (requests, DB, files).
- Para CPU-bound: `multiprocessing` (procesos separados, cada uno con su GIL), o librerías que liberen GIL (NumPy, PyTorch, Numba), o async con workers.
- Desde Python 3.13 (oct 2024) hay un build experimental sin GIL (`--disable-gil`, PEP 703).
- En Python 3.14 (oct 2025) el modo free-threaded dejó de ser experimental y el overhead single-thread bajó de ~40% a 5-10%.
- Roadmap oficial: GIL controlado por flag/env var (2026-2027), y disabled por default (~2028-2030).

```python
# CPU-bound: usar multiprocessing
from multiprocessing import Pool

def procesar_imagen(path):
    # Trabajo CPU intenso
    ...

with Pool(processes=4) as pool:
    resultados = pool.map(procesar_imagen, lista_de_paths)
    # 4 procesos separados, cada uno usa un core completo
```

```python
# I/O-bound: usar threads o async
import asyncio, aiohttp

async def fetch(session, url):
    async with session.get(url) as resp:
        return await resp.text()

async def main(urls):
    async with aiohttp.ClientSession() as session:
        return await asyncio.gather(*(fetch(session, u) for u in urls))
```

### 2.3 Race condition en "check-then-act"

Patrón que causa incidentes en producción con altísima frecuencia:

```java
if (event.getReservationCount() < event.getCapacity()) {   // CHECK
    event.incrementReservations();                          // ACT
    return RESERVED;
}
return FULL;
```

Bajo carga con miles de reservas concurrentes, dos threads pueden leer ambos "count = 99, capacity = 100" al mismo tiempo, ambos pasan el check, ambos incrementan — resultado: count = 101, plaza sobre-vendida.

Fixes en orden creciente de robustez:

**Fix 1 — synchronized (funciona en 1 pod, no en varios):**

```java
public synchronized ReservationResult reservar(Event event) {
    if (event.getReservationCount() < event.getCapacity()) {
        event.incrementReservations();
        return RESERVED;
    }
    return FULL;
}
```

Cuando hay 2+ pods de la app, cada pod tiene su propio lock — no se coordinan. Bug persiste.

**Fix 2 — UPDATE condicional atómico en la DB (funciona distribuido):**

```sql
UPDATE events
SET reservation_count = reservation_count + 1
WHERE id = ?
  AND reservation_count < capacity;

-- Si filas afectadas = 0, evento lleno.
```

La DB serializa la sentencia. Check y increment ocurren juntos. Funciona con N réplicas de app sin locks explícitos.

**Fix 3 — Redis con Lua script (para hot paths sin DB):**

```lua
-- reserve.lua
local cap = tonumber(redis.call('GET', KEYS[1] .. ':capacity'))
local cur = tonumber(redis.call('GET', KEYS[1] .. ':count')) or 0
if cur < cap then
    redis.call('INCR', KEYS[1] .. ':count')
    return 1
end
return 0
```

```java
Long result = redisClient.eval(reserveScript, List.of("event:42"));
if (result == 1) { /* RESERVED */ }
```

Lua scripts en Redis se ejecutan atómicamente — el `check` y el `INCR` no pueden intercalarse.

### 2.4 Deadlock canónico y la solución textbook

```java
// Servicio de transferencias bancarias
public void transfer(Account from, Account to, BigDecimal amount) {
    synchronized (from) {
        synchronized (to) {
            from.debit(amount);
            to.credit(amount);
        }
    }
}
```

Bajo carga:
- Thread T1: `transfer(A, B)` — toma lock(A), espera lock(B).
- Thread T2: `transfer(B, A)` — toma lock(B), espera lock(A).
- **Deadlock**: T1 espera B, T2 espera A. Ambos bloqueados para siempre.

Coffman (1971) formalizó las 4 condiciones necesarias:
1. Mutual exclusion (locks).
2. Hold-and-wait (mantienes un lock mientras esperas otro).
3. No preemption (nadie puede quitarte un lock a la fuerza).
4. **Circular wait** (T1 → T2 → T1).

Romper cualquiera basta. La más práctica en producción: eliminar la circular wait con **lock ordering consistente**.

```java
public void transfer(Account from, Account to, BigDecimal amount) {
    Account first  = from.id().compareTo(to.id()) < 0 ? from : to;
    Account second = from.id().compareTo(to.id()) < 0 ? to   : from;
    synchronized (first) {
        synchronized (second) {
            from.debit(amount);
            to.credit(amount);
        }
    }
}
```

Ahora ambos threads intentan tomar los locks en el mismo orden (menor id primero). Uno espera al otro sin ciclo. Deadlock imposible por construcción.

Alternativa: `tryLock(timeout)` con retry — funciona como defensa reactiva, pero es prevención inferior. Bases de datos detectan deadlocks internamente (MySQL InnoDB) y hacen rollback de la "víctima".

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Async/await vs threads: modelo mental

¿Por qué Node.js con async/await maneja 10.000 conexiones simultáneas mejor que un servidor Java con thread-per-request tradicional?

**No es velocidad de CPU** — la JVM es MÁS rápida que V8 en cargas CPU-bound. Es MEMORIA e I/O.

- Cada thread OS consume ~1 MB de stack + estructuras del kernel. 10.000 threads ≈ 10 GB de RAM en stacks + thrashing del scheduler.
- Async usa 1 (o pocos) threads + event loop: al esperar I/O suelta el hilo, permitiendo miles de operaciones concurrentes con memoria mínima.

```javascript
// Node.js: 1 thread, event loop
async function handle(req, res) {
    const user = await db.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    const profile = await fetch(`https://profiles.example.com/${user.id}`);
    res.json({ user, profile: await profile.json() });
}
// Mientras espera DB o fetch, el thread hace OTRAS handles.
```

Costos del modelo async:
- Código más difícil (callback hell resuelto con async/await, pero stack traces async son opacos).
- NO ayuda si tu carga es CPU-bound — 1 thread congestiona.
- Debugging distinto (async_hooks en Node, `async-profiler` en Java).

**Virtual Threads (Project Loom, Java 21+)** cierran la brecha:

```java
// Java 21 - Virtual Threads
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 100_000; i++) {
        int id = i;
        executor.submit(() -> {
            var user = jdbcTemplate.queryForObject(
                "SELECT * FROM users WHERE id = ?", User.class, id);
            var profile = httpClient.send(profileRequest(id));
            log.info("processed {}", id);
        });
    }
}
```

100.000 virtual threads en un pod pequeño. La JVM los planifica sobre unos pocos carrier threads. Cuando un virtual thread bloquea (JDBC, HTTP, `sleep`), la JVM lo desmonta y usa el carrier para otro. Código secuencial simple + performance async.

En Java 25 (2025), **JEP 491** redujo dramáticamente el *pinning* con `synchronized` — ya no bloquea el carrier thread. Esto eliminó una de las últimas trampas de Loom.

Regla actualizada 2026:
- **I/O-bound sin virtual threads:** async/await (Node.js, Kotlin coroutines, Python asyncio).
- **I/O-bound con virtual threads:** código secuencial normal.
- **CPU-bound:** paralelismo real (multiprocessing, threads en N cores, Go goroutines).

### 3.2 Memory model: reordering y happens-before

Bug real de producción:

```java
// Thread 1
data = 42;
ready = true;

// Thread 2
if (ready) print(data);   // Ocasionalmente imprime 0
```

¿Cómo? El compilador Y la CPU pueden REORDENAR escrituras sin dependencia data. Thread 1 puede escribir `ready = true` ANTES que `data = 42` desde la perspectiva de Thread 2 (o cachear en distintos cores).

Java Memory Model (JSR 133, 2004) define `happens-before` — relaciones que garantizan visibilidad y orden entre threads. Sin sincronización explícita, no hay garantías.

Herramientas para forzar orden y visibilidad:

```java
// 1. volatile — visibility barrier
class Flag {
    volatile boolean ready = false;
    int data = 0;

    // Thread 1
    void producer() {
        data = 42;
        ready = true;   // volatile store: garantiza que data=42 es visible ANTES
    }

    // Thread 2
    void consumer() {
        if (ready) print(data);   // volatile load: si ve true, ve data=42
    }
}
```

- **volatile:** visibilidad + orden en reads/writes de ESA variable. No garantiza atomicidad de operaciones compuestas.
- **synchronized:** lock + visibilidad + orden completo del bloque.
- **atomic (`AtomicInteger`, `AtomicReference`):** read-modify-write atómico con CAS.
- **final fields:** publicación segura tras el constructor.

Reglas prácticas:
- Para SEÑALES simples (flag booleano): `volatile`.
- Para operaciones compuestas: `atomic` o `synchronized`.
- Para bloques enteros: `synchronized` o `Lock`.

En C++11: `std::atomic` con `memory_order_relaxed`, `acquire`, `release`, `seq_cst`. En Rust: `Ordering::{Relaxed, Acquire, Release, AcqRel, SeqCst}`. Same concept, distinta API.

Testing de bugs de memory model: `jcstress` (Java Concurrency Stress) genera millones de intercalaciones para detectar estos bugs que casi nunca aparecen en tests normales.

### 3.3 Estructuras concurrentes en Java

Cuatro familias:

1. **`Collections.synchronizedX`** (legacy) — wrappea cada método con un lock global. No escala. `synchronizedMap`, `synchronizedList`.
2. **`ConcurrentX`** — diseñadas para concurrencia real, escalan por fine-grained locking o CAS. `ConcurrentHashMap`, `ConcurrentLinkedQueue`, `ConcurrentSkipListMap`.
3. **Atomic** — CAS para casos simples. `AtomicInteger`, `AtomicLong`, `LongAdder` (mejor bajo alta contención), `AtomicReference`.
4. **Immutable** — sin thread safety necesaria porque no cambian. `List.copyOf`, `Set.copyOf`, Guava `ImmutableMap`, records.

Comparación clave: `synchronizedMap` vs `ConcurrentHashMap`:

```java
// LEGACY - un lock global, serializa TODOS los accesos
Map<String, User> m1 = Collections.synchronizedMap(new HashMap<>());

// MODERNO - lock striping (Java 7) / CAS + fine locks (Java 8+)
Map<String, User> m2 = new ConcurrentHashMap<>();

// Bench típico: bajo 100 threads concurrentes,
// ConcurrentHashMap es 5-50x más rápido que synchronizedMap.
```

`ConcurrentHashMap` es iteración *weakly consistent* — puede ver o no ver cambios ocurridos durante la iteración, pero no lanza `ConcurrentModificationException`. `synchronizedMap` requiere `synchronized` externo del bloque de iteración.

Caffeine (librería líder de caché Java) usa `ConcurrentHashMap` internamente. Netty, Kafka client, Spring — todos usan estructuras concurrentes.

### 3.4 CompletableFuture: composición async sin callback hell

```java
// PROBLEMA: llamar userService, luego en paralelo prefs+history, combinar
public CompletableFuture<UserDto> loadUser(long id) {
    return getUser(id)
        .thenCompose(user ->
            getPreferences(user.id())
                .thenCombine(getHistory(user.id()),
                    (prefs, hist) -> new UserDto(user, prefs, hist))
        );
}

// Operadores:
// thenApply    - map: transform sync
// thenCompose  - flatMap: chain async
// thenCombine  - zip: dos futures en paralelo
// allOf/anyOf  - join N futures
```

`thenCombine` ejecuta ambas futures en PARALELO — la 2 y 3 se disparan a la vez tras terminar userService. Error handling:

```java
future
    .thenApply(this::process)
    .exceptionally(err -> {
        log.warn("failed, using default", err);
        return defaultValue();
    })
    .thenAccept(this::persist);
```

En 2026, con Virtual Threads maduros, muchos equipos ESCRIBEN código secuencial y dejan que la JVM planifique. Reactive stacks (Reactor, RxJava) siguen siendo dominantes en pipelines de streaming (Kafka Streams, Flink) donde backpressure es crítico.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Producer-Consumer con BlockingQueue

Patrón fundamental: un thread produce eventos rápido, otro los procesa lento.

```java
// NUNCA hacer esto - ArrayList no es thread-safe
List<Event> queue = new ArrayList<>();
// Bajo carga: ConcurrentModificationException, eventos perdidos, corrupción.
```

Solución canónica:

```java
BlockingQueue<Event> queue = new ArrayBlockingQueue<>(1000);

// Producer
executor.submit(() -> {
    while (running) {
        Event e = receive();
        queue.put(e);   // BLOQUEA si la queue está llena (backpressure natural)
    }
});

// Consumer
executor.submit(() -> {
    while (running) {
        Event e = queue.take();   // BLOQUEA si la queue está vacía
        process(e);
    }
});
```

Ventajas:
- Thread-safe internamente (sin locks manuales).
- Back-pressure: si consumer no puede seguir, producer se bloquea → evita OOM.
- Bounded — capacidad fija limita memoria.

Variantes:
- `ArrayBlockingQueue` — bounded, array circular.
- `LinkedBlockingQueue` — unbounded por default (cuidado con OOM). Bounded si se especifica capacidad.
- `PriorityBlockingQueue` — orden por prioridad, no FIFO.
- `SynchronousQueue` — sin buffer; hand-off directo entre producer y consumer.
- `LinkedTransferQueue` — combina ventajas.

`ExecutorService` en Java usa `BlockingQueue` internamente para su pool de tareas. Log frameworks (Log4j 2 AsyncAppender) usan `BlockingQueue` o RingBuffer (disruptor) para logging asíncrono.

### 4.2 Immutability como estrategia de concurrencia

Race conditions requieren dos ingredientes: (a) estado compartido, (b) mutación. Elimina la mutación y las race conditions se vuelven **imposibles por construcción**.

```clojure
;; Clojure: todo inmutable por default
(def usuarios (atom {}))                          ;; atom = referencia atómica
(swap! usuarios assoc "ana" {:score 100})         ;; crear nuevo map, reemplazar atom
(swap! usuarios assoc "ana" {:score 200})         ;; ídem, sin race conditions
```

```rust
// Rust: ownership system garantiza no data races en compile-time
use std::sync::Arc;

let datos = Arc::new(vec![1, 2, 3]);
let d1 = Arc::clone(&datos);
let d2 = Arc::clone(&datos);

std::thread::spawn(move || println!("{:?}", d1));
std::thread::spawn(move || println!("{:?}", d2));
// Múltiples threads leen; nadie escribe. Compilador lo prueba.
```

```java
// Java: records + colecciones inmutables
public record User(String name, int score) {}

Map<String, User> snapshot = Map.of(
    "ana", new User("ana", 100),
    "bob", new User("bob", 50)
);
// snapshot no se puede modificar; se comparte libremente entre threads sin locks.
```

Cómo modelar CAMBIOS de estado sin mutación:
1. Crear objeto NUEVO con los cambios.
2. Reemplazar referencia atomicamente (CAS, `AtomicReference`, atom).
3. Estructuras persistentes con structural sharing (Clojure, Immer en JS) — no copias todo, comparten sub-árboles.

Alternativas relacionadas:
- **Actor model** (Erlang, Akka, Elixir) — cada actor tiene estado privado, comunica por mensajes inmutables.
- **STM (Software Transactional Memory)** — Clojure `ref` con `dosync`.
- **CRDT (Conflict-free Replicated Data Types)** — estructuras que mergean automáticamente por diseño matemático (Figma, Notion).

WhatsApp escaló a mil millones de usuarios con ~50 ingenieros en Erlang. React basa toda su UI en immutability (`setState` reemplaza, no muta). Discord migró servicios críticos a Rust por el ownership system que garantiza en compile-time la ausencia de data races.

### 4.3 Thread pool sizing

Configurar mal un `ExecutorService` es una de las decisiones que más impacta estabilidad y latencia.

Fórmulas (Brian Goetz, *Java Concurrency in Practice*):

- **CPU-bound:** `N_cores + 1` (extra para cuando un thread bloquea en page fault, GC).
- **I/O-bound:** `N_cores * (1 + waitTime / serviceTime)`.
  - Si esperas 90 ms de IO y computes 10 ms, ratio = 10 → 40 threads en 4 cores.

```java
// CPU-bound
int cores = Runtime.getRuntime().availableProcessors();
ExecutorService cpuPool = Executors.newFixedThreadPool(cores + 1);

// I/O-bound
int ioThreads = cores * (1 + 90 / 10);   // 4 * 10 = 40
ExecutorService ioPool = Executors.newFixedThreadPool(ioThreads);
```

**Regla crítica: SEPARAR pools por workload** (bulkhead pattern, Michael Nygard, *Release It!*). Mezclar CPU-heavy con I/O-heavy en el mismo pool causa que una imagen procesándose bloquee capacity de I/O. Ejemplo:

```java
public class OrderService {
    private final ExecutorService cpuPool  = Executors.newFixedThreadPool(cores + 1);
    private final ExecutorService ioPool   = Executors.newFixedThreadPool(cores * 10);
    private final ExecutorService dbPool   = Executors.newFixedThreadPool(20);

    public CompletableFuture<Order> process(OrderRequest req) {
        return CompletableFuture
            .supplyAsync(() -> validate(req), cpuPool)
            .thenComposeAsync(v -> fetchProducts(v), ioPool)
            .thenComposeAsync(p -> save(p), dbPool);
    }
}
```

Netflix Hystrix (2011-2019) formalizó bulkhead pattern para microservicios. Log4j 2.x separa thread pool de I/O de logging del principal por esto exacto.

**Reglas duras:**
- ❌ NUNCA `Executors.newCachedThreadPool()` en producción — sin límite, bajo carga puedes explotar en miles de threads → OOM.
- ✅ SIEMPRE bounded queue (`new ThreadPoolExecutor(...)`) para evitar OOM por backlog.
- ✅ SIEMPRE nombra los threads (`ThreadFactory`) para debugging: thread dumps se leen infinitamente mejor.
- ✅ MIDE con métricas: queue length, active threads, task duration histogram.

Alternativa moderna: **Virtual Threads (Loom, Java 21)** eliminan la necesidad de dimensionar para I/O — millones de virtual threads son baratos. Para CPU-bound sigues necesitando pool bounded.

### 4.4 Cancelación cooperativa

`Thread.stop()` está DEPRECATED desde Java 1.1. Aborta el thread en medio de cualquier operación: locks aún tomados, invariantes rotos, datos corruptos. Sigue deprecated en Java 25.

Modelo correcto: **cancelación cooperativa** — el thread chequea si le pidieron parar en puntos seguros.

```java
public class Worker implements Runnable {
    public void run() {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                Task task = queue.take();   // lanza InterruptedException si interrumpido
                process(task);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();   // preserve interrupt status
                return;                                // exit limpiamente
            }
        }
    }
}

// Cancelar desde fuera:
Thread t = new Thread(new Worker());
t.start();
// ... más tarde
t.interrupt();
```

Otros lenguajes:

```kotlin
// Kotlin coroutines - structured concurrency
val job = launch {
    while (isActive) {
        val item = channel.receive()
        process(item)
    }
}
job.cancel()   // cancela el job y todos sus hijos
```

```go
// Go - context.Context
func worker(ctx context.Context, tasks <-chan Task) {
    for {
        select {
        case <-ctx.Done():
            return
        case t := <-tasks:
            process(t)
        }
    }
}

ctx, cancel := context.WithTimeout(ctx.Background(), 30*time.Second)
defer cancel()
go worker(ctx, tasks)
```

Regla mental: en loops largos, chequea cancellation cada N iteraciones o en cada I/O. En operaciones bloqueantes, propaga `InterruptedException` / respeta `context.Done()` / respeta `CancellationException`.

### 4.5 Backpressure en streams reactivos

Servicio consume eventos de Kafka rápido y publica a downstream lento. Bajo carga: OOM porque buffer interno crece indefinidamente.

**Backpressure:** mecanismo para que el consumer indique al producer "ve más lento". Estrategias:

1. **Bounded buffer que bloquea al producer** (`BlockingQueue.put()`).
2. **Drop policy** — descartar viejos o nuevos.
3. **Sampling** — procesar 1 de cada N.
4. **Request-N** (Reactive Streams) — consumer pide `N` items explícitamente al publisher.

Reactive Streams (spec 2015, ahora en JDK `Flow`) formalizó el modelo request-N:

```java
import java.util.concurrent.Flow;

Flow.Publisher<Event> source = ...;

source.subscribe(new Flow.Subscriber<Event>() {
    Flow.Subscription sub;

    public void onSubscribe(Flow.Subscription s) {
        this.sub = s;
        s.request(10);   // pido 10 eventos
    }

    public void onNext(Event e) {
        process(e);
        sub.request(1);   // pido uno más tras procesar
    }
    public void onError(Throwable t) { /* ... */ }
    public void onComplete()          { /* ... */ }
});
```

Frameworks que implementan Reactive Streams: RxJava, Reactor, Akka Streams, Vert.x.

Kafka tiene backpressure natural con el poll model: el consumer decide cuánto consume y a qué velocidad. No hay push descontrolado desde el broker. En HTTP/2 hay flow control por streams. En TCP, sliding window.

En un servicio 2026 típico, la regla es: **SIEMPRE plantea "qué pasa si downstream es lento"**. Sin respuesta clara, tienes un OOM latente.

### 4.6 Idempotencia y at-least-once

Sistemas distribuidos con Kafka, SQS, RabbitMQ garantizan típicamente **at-least-once**: bajo failure, mensajes pueden procesarse 2+ veces por retry. Si tu processing incrementa un contador, quedará inflado.

Regla industrial: **at-least-once + idempotent processing = exactly-once effect**.

Implementaciones de idempotencia:

**1. Dedup con messageId (tabla o Redis SET NX):**

```python
def process(msg):
    if redis.set(f"processed:{msg.id}", "1", nx=True, ex=86400):
        # SET NX ha tenido éxito: primera vez que vemos este id
        do_work(msg)
    else:
        # Ya procesado, ignorar
        logger.info(f"skip duplicate: {msg.id}")
```

**2. Operaciones idempotentes por diseño (upsert, replace, set):**

```sql
INSERT INTO user_settings (user_id, theme)
VALUES ($1, $2)
ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme;
-- Reprocesar el mismo evento produce el mismo estado.
```

**3. Optimistic locking / version check:**

```sql
UPDATE orders
SET status = 'SHIPPED', version = version + 1
WHERE id = $1 AND version = $2;
-- Filas afectadas = 0 significa que otro proceso ya avanzó.
```

**4. En APIs — Idempotency-Key header (Stripe, Square):**

```http
POST /v1/charges
Idempotency-Key: 5f1c9c96-3e6b-4b6a-9e5f-1abcdefabcde

{"amount": 2000, "currency": "usd", "source": "tok_visa"}
```

Stripe guarda el resultado del primer request bajo esa key. Retries con la misma key devuelven la misma respuesta sin re-cobrar.

**Cuándo NO es suficiente:**
- Kafka soporta **exactly-once semantics** DENTRO de Kafka (produce-consume). El consumer aún puede procesar 2 veces si tu app hace retry sin dedup. La idempotencia debe estar en la LÓGICA de processing.
- Deshabilitar retries convierte at-least-once en at-most-once (mensajes perdidos) — peor.
- Transactions ACID cross-service (2PC, XA) son prohibitivamente caras.

### 4.7 Distributed locks: Redlock y fencing tokens

Necesitas un lock DISTRIBUIDO para asegurar que solo UN worker procesa una tarea. Debate clásico:

- **SET NX en Redis simple** — frágil. Si Redis se cae, el lock desaparece. Si el worker es lento y el TTL expira, otro worker toma el lock. Bug.
- **Redlock** (Antirez, 2016) — múltiples Redis con quorum. Kleppmann (2016) publicó *"How to do distributed locking"* criticándolo: depende de asunciones fuertes sobre clocks (GC pauses, network delays, clock drift pueden hacerlo fallar).
- **Consensus systems** (etcd, Zookeeper, Consul) — linearizable, correcto por construcción.

Kleppmann distingue dos casos de uso:

1. **Lock por EFFICIENCY** — nice-to-have. Si falla, hay trabajo duplicado. Redlock o SET NX bastan.
2. **Lock por CORRECTNESS** — must-have. Si falla, hay bug de negocio (double-charge, data corruption). Requiere consensus + **fencing tokens**.

Fencing token = número monotónicamente creciente que el sistema de storage rechaza si el que llega es viejo.

```
Client 1 pide lock:   token = 33
Client 1 pause GC 30s
Client 1 lock expira, Client 2 pide lock:   token = 34
Client 2 escribe:    write(x, token=34) → OK
Client 1 despierta:  write(x, token=33) → REJECTED por storage
```

Sin fencing, Client 1 sobrescribiría lo que Client 2 escribió durante su GC pause.

Ejemplos reales:
- **Kubernetes** usa etcd (Raft) para todo el state global — locks incluidos.
- **Google Chubby** (Paxos) — servicio de lock que inspiró Zookeeper.
- **Redis Redlock** — usado en muchos startups; controversia sobre correctness bajo condiciones extremas.

---

## 5. Ejemplo práctico completo: pipeline productor-consumidor con backpressure

**Contexto.** Diseñas un ingester de eventos: recibe de Kafka, enriquece con lookup en cache/DB, publica a downstream lento (API de 3rd party). Requisitos: no perder eventos, no OOM bajo carga, dedup en caso de retries, shutdown limpio.

**Paso 1 — Setup con `BlockingQueue` y virtual threads (Java 21).**

```java
public class EventIngester {
    private final KafkaConsumer<String, byte[]> consumer;
    private final BlockingQueue<Event> buffer = new ArrayBlockingQueue<>(1000);
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();
    private final Redis redis;
    private final Downstream downstream;
    private volatile boolean running = true;

    public EventIngester(KafkaConsumer<String, byte[]> c, Redis r, Downstream d) {
        this.consumer = c; this.redis = r; this.downstream = d;
    }
```

**Paso 2 — Producer thread que llena el buffer.**

```java
    public void startProducer() {
        Thread.startVirtualThread(() -> {
            try {
                consumer.subscribe(List.of("events"));
                while (running) {
                    var records = consumer.poll(Duration.ofMillis(100));
                    for (var rec : records) {
                        Event e = deserialize(rec.value());
                        buffer.put(e);   // BLOQUEA si buffer lleno = backpressure natural
                    }
                    consumer.commitSync();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
    }
```

**Paso 3 — N workers procesan del buffer con dedup + retry.**

```java
    public void startWorkers(int n) {
        for (int i = 0; i < n; i++) {
            workers.submit(() -> {
                while (running || !buffer.isEmpty()) {
                    try {
                        Event e = buffer.poll(1, TimeUnit.SECONDS);
                        if (e == null) continue;
                        processWithDedup(e);
                    } catch (InterruptedException ex) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            });
        }
    }

    private void processWithDedup(Event e) {
        // Dedup: SET NX con TTL 24h
        Boolean isNew = redis.setnx("proc:" + e.id(), "1", Duration.ofHours(24));
        if (!isNew) {
            log.info("skip duplicate {}", e.id());
            return;
        }
        try {
            var enriched = enrich(e);
            sendWithRetry(enriched);
        } catch (Exception ex) {
            log.error("failed {}: {}", e.id(), ex.getMessage());
            redis.del("proc:" + e.id());   // libera la key para retry
            // opcional: publicar a DLQ (dead letter queue)
        }
    }
```

**Paso 4 — Retry con exponential backoff + jitter.**

```java
    private void sendWithRetry(EnrichedEvent e) throws Exception {
        int maxAttempts = 5;
        long baseDelayMs = 100;
        Random rng = ThreadLocalRandom.current();
        Exception last = null;
        for (int attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                downstream.send(e);
                return;
            } catch (TransientException ex) {
                last = ex;
                long delay = (long) (baseDelayMs * Math.pow(2, attempt));
                long jitter = rng.nextLong(delay / 2);   // Full jitter (AWS)
                Thread.sleep(delay + jitter);
            }
        }
        throw new RuntimeException("max attempts exceeded", last);
    }
```

**Paso 5 — Shutdown limpio.**

```java
    public void shutdown() throws InterruptedException {
        running = false;                       // señal a producer + workers
        workers.shutdown();                    // no acepta nuevas tareas
        if (!workers.awaitTermination(30, TimeUnit.SECONDS)) {
            log.warn("forced shutdown");
            workers.shutdownNow();
        }
        consumer.close();
    }
}
```

**Paso 6 — Verificación con test de carga.**

```java
@Test
void ingester_procesa_10k_eventos_sin_perder_bajo_downstream_lento() throws Exception {
    var mockDownstream = new SlowMockDownstream(50);   // 50 ms por request
    var ingester = new EventIngester(mockConsumer(10_000), redis, mockDownstream);
    ingester.startWorkers(20);
    ingester.startProducer();

    Thread.sleep(60_000);
    ingester.shutdown();

    assertEquals(10_000, mockDownstream.receivedCount());
    assertTrue(usedMemoryMB() < 512);   // no OOM
}
```

**Discusión.**
- Producer bloqueado por `buffer.put()` cuando workers no siguen — backpressure llega hasta Kafka (no committemos offsets si no procesamos).
- Dedup con Redis SET NX evita procesar 2 veces bajo Kafka retries.
- Retry con exponential backoff + JITTER (AWS "Full Jitter") evita thundering herd.
- Virtual threads permiten `Thread.sleep` sin desperdiciar carrier — millones de threads teóricos, pero limitamos con el semáforo natural del buffer.
- Shutdown limpio drena el buffer antes de terminar (`running || !buffer.isEmpty()`).
- Falta en producción real: métricas (queue depth, throughput, error rate), tracing distribuido (OpenTelemetry), circuit breaker cuando downstream falla persistentemente, DLQ para eventos que no se pueden procesar.

---

## 6. Cheatsheet, reglas mentales y anti-patrones

**Reglas de oro:**

- ✅ Immutability primero. Sin mutación, no hay race conditions.
- ✅ Prefiere estructuras concurrentes (`ConcurrentHashMap`, `BlockingQueue`) sobre `synchronized` manual.
- ✅ Para check-then-act, atomiza en el sitio donde vive el estado (DB, atomic, Lua script).
- ✅ Lock ordering consistente previene deadlocks por construcción.
- ✅ Exponential backoff + jitter para retries.
- ✅ At-least-once + idempotent processing = exactly-once effect.
- ✅ Separa thread pools por workload (bulkhead pattern).
- ✅ Cancelación cooperativa: chequea `Thread.interrupted()` / `ctx.Done()` / `isActive`.
- ✅ Diseña con backpressure desde el día uno.
- ✅ En Java 21+, considera Virtual Threads antes de reactive.

**Anti-patrones:**

- ❌ `Thread.stop()` — deprecated desde 1.1, sigue deprecated en 25.
- ❌ `Executors.newCachedThreadPool()` en producción — sin límite, OOM asegurado.
- ❌ Compartir `HashMap` entre threads sin sincronización.
- ❌ Compartir mutable state entre threads sin `volatile`, `synchronized` o atomic.
- ❌ Retry en loop tight sin backoff — thundering herd.
- ❌ Distributed lock por correctness sin fencing tokens.
- ❌ Buffers unbounded en pipelines de streaming.
- ❌ `synchronized` con lock en objetos con `intern()` (String literal) — cualquiera puede tomarlo.
- ❌ Double-checked locking sin `volatile` en el field (pre-Java 5 style).
- ❌ Mezclar CPU-bound y I/O-bound en el mismo pool.

**Tabla de decisión: qué modelo de concurrencia:**

| Situación | Modelo |
|-----------|--------|
| Web server I/O-bound (pre Java 21) | Async / Reactive |
| Web server I/O-bound (Java 21+) | Virtual threads + código secuencial |
| CPU-bound batch | Thread pool = N cores |
| Muchos clientes con estado | Actor model (Erlang/Akka/Elixir) |
| Editor colaborativo | CRDT o OT |
| Contadores de alta frecuencia | LongAdder (mejor que AtomicLong) |
| Producer-consumer local | BlockingQueue |
| Pipeline distribuido | Kafka / RabbitMQ + idempotencia |
| Lock local | synchronized o ReentrantLock |
| Lock distribuido (correctness) | etcd/Zookeeper + fencing tokens |
| Lock distribuido (efficiency) | Redis SET NX |
| Signal booleano entre threads | volatile |
| Estado compartido complejo | Immutable + AtomicReference / STM |

---

## 7. Casos reales de la industria (2024-2026)

- **Java 21 Virtual Threads + Spring — remove WebFlux (2025).** En 2025 muchos equipos Spring empezaron a REMOVER WebFlux para volver a `RestController` bloqueante ejecutándose sobre virtual threads. Servicios previamente throttled a 200 platform threads ahora manejan decenas de miles de operaciones concurrentes sin configuración ni rewrites reactivos. JEP 491 (Java 25, 2025) redujo dramáticamente el pinning con `synchronized`.
- **Python free-threading (2024-2026).** CPython 3.13 (oct 2024) introdujo `--disable-gil` (PEP 703). Con 3.14 (oct 2025) el overhead single-thread bajó de ~40% a 5-10%, y el modo dejó de ser experimental. Roadmap: GIL controlado por flag en 2026-2027, disabled por default en ~2028-2030. En 2026 la mayoría de servicios Python siguen usando multiprocessing para paralelismo CPU real.
- **Go 1.26 — Green Tea GC default (feb 2026).** El Green Tea garbage collector, experimental en Go 1.25, es default en 1.26. Reduce dramáticamente las pausas GC — el problema que originalmente motivó la migración de Discord a Rust.
- **AWS Route53 outage (2024).** Cascading failure exacerbada por retries sin jitter — thundering herd al recuperarse. AWS Architecture Blog "Exponential Backoff and Jitter" sigue siendo lectura obligatoria.
- **Discord — Elixir para presence (2020, referenciado 2024).** Servicio de presencia con millones de conexiones concurrentes en Elixir (actor model + BEAM VM). Ejemplo canónico de que el modelo importa: para este caso, actor model gana claramente sobre threads compartidos.
- **Figma — CRDT para multiplayer (2019-2024).** Documentado en "How Figma's multiplayer technology works". CRDT permite merge automático de ediciones concurrentes sin locks. Notion, Linear, Miro usan enfoques similares.
- **Kafka + idempotency en Stripe.** Stripe usa `Idempotency-Key` en toda su API pública. Combinado con at-least-once delivery interno, garantiza que un cliente reintentando no genera cobros duplicados.
- **Kleppmann vs Antirez sobre Redlock (2016, referenciado en incidents 2024).** Debate público sobre correctness de Redis Redlock bajo GC pauses y clock drift. Consenso 2026: para efficiency locks, Redlock/SET NX bastan; para correctness locks, consensus systems + fencing tokens.
- **LMAX Disruptor (2010, todavía referencia).** Framework de trading de alta frecuencia. Millones de ops/s en un core evitando false sharing (padding), cache misses (ring buffer contiguo) y locks (CAS). Sigue siendo la referencia para latencia sub-microsegundo.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Reproducir y arreglar un race condition

**Objetivo:** implementar un contador compartido con y sin sincronización; observar el bug y aplicar tres fixes distintos.

**Setup:** Java 21 o Kotlin. 8+ threads incrementando `long counter` un millón de veces cada uno.

**Pasos:**
1. Versión A: `long counter` sin sync. Ejecuta 5 veces. Anota el valor final.
2. Versión B: `synchronized` en el increment. Ejecuta 5 veces.
3. Versión C: `AtomicLong` con `incrementAndGet()`.
4. Versión D: `LongAdder`.
5. Bench los cuatro con `System.nanoTime`.

**Criterios de éxito:**
- [ ] Versión A muestra valor < 8M (evidencia del race).
- [ ] Versiones B, C, D dan exactamente 8.000.000.
- [ ] `LongAdder` es más rápido que `AtomicLong` bajo 8+ threads (~2-5×).
- [ ] Puedes explicar por qué (false sharing / cache line contention).

**Bonus:** medir con JMH (Java Microbenchmark Harness) para números serios.

### Ejercicio 2: Provocar y prevenir un deadlock

**Objetivo:** escribir un servicio de transferencia entre cuentas que deadlockee bajo carga, y arreglarlo con lock ordering.

**Setup:** Java + JUnit. 100 threads haciendo transferencias aleatorias entre 10 cuentas.

**Pasos:**
1. Implementa `transfer(from, to)` con `synchronized(from) { synchronized(to) { ... } }`.
2. Lanza 100 threads que hagan 1000 transferencias cada uno con `from` y `to` random.
3. Observa deadlock (usa `jstack <pid>` para confirmar).
4. Aplica lock ordering: siempre tomar el lock de la cuenta con menor id primero.
5. Verifica que 100 threads x 1000 transferencias terminan sin bloquearse.

**Criterios de éxito:**
- [ ] La versión buggy se cuelga (`jstack` muestra "waiting for lock 0x... which is held by...").
- [ ] La versión fixed termina en <10 segundos.
- [ ] La suma total de balances es invariante entre las dos versiones (0 dinero creado/destruido).
- [ ] Añade un test que ejecuta 10 rounds y verifica que ninguno se cuelga (con timeout).

**Bonus:** implementa la versión con `tryLock` + retry con jitter y compara latencias.

### Ejercicio 3: Pipeline con backpressure

**Objetivo:** implementar ingester Kafka-like con `BlockingQueue`, N workers, dedup con Redis y shutdown limpio.

**Setup:** Java 21 con Virtual Threads. Redis local (Docker). Mock de "Kafka" y "Downstream".

**Pasos:**
1. Sigue el diseño del §5 de este capítulo.
2. Producer lee 10.000 eventos de un iterador mock; llena `BlockingQueue(1000)`.
3. 20 workers procesan del buffer con SET NX en Redis para dedup.
4. Downstream mock tarda 20-100ms por evento (aleatorio).
5. Añade 10% de eventos duplicados en el stream (mismo id).
6. Shutdown limpio drena el buffer y termina.

**Criterios de éxito:**
- [ ] Procesa los 10.000 eventos únicos.
- [ ] Los 1.000 duplicados se detectan y skip (verifica con log).
- [ ] Memoria del proceso <512 MB durante la ejecución.
- [ ] Shutdown termina en <5 segundos sin perder eventos en el buffer.
- [ ] Añade métricas: throughput actual (events/s), queue depth, errores.

**Bonus:** añade circuit breaker cuando el downstream falla >50% en los últimos 100 requests.

### Ejercicio 4: Async/await vs Virtual Threads

**Objetivo:** implementar el mismo endpoint (fetch 3 URLs en paralelo, combinar) en tres modelos y comparar performance.

**Setup:** Java 21 o Kotlin. Endpoint que hace 3 llamadas HTTP a un mock local con 50ms de latencia cada una.

**Pasos:**
1. Versión A: threads platform tradicionales (`Executors.newFixedThreadPool(50)`).
2. Versión B: `CompletableFuture` con reactive style (thenCombine).
3. Versión C: Virtual Threads (`Executors.newVirtualThreadPerTaskExecutor()`).
4. Test de carga: 1000 requests concurrentes, medir p50, p99, throughput.

**Criterios de éxito:**
- [ ] Las 3 versiones dan la misma respuesta funcional.
- [ ] Versión A tiene throughput limitado por el pool size.
- [ ] Versiones B y C escalan a 1000 concurrentes sin problemas.
- [ ] Versión C tiene código más simple (sin composition async) y latencia comparable a B.
- [ ] Puedes explicar por qué C es viable en 2026 pero no en Java 17.

**Bonus:** añade un downstream CPU-bound (hash de un bloque grande) y observa dónde falla cada modelo.

### Ejercicio 5: Idempotencia end-to-end

**Objetivo:** implementar un endpoint de "create payment" con `Idempotency-Key` que soporta retries seguros.

**Setup:** cualquier framework HTTP + Redis + una "DB" en memoria.

**Pasos:**
1. Endpoint `POST /payments` acepta `Idempotency-Key` header + body con amount.
2. Antes de procesar, chequea Redis: `GET idem:<key>`. Si existe, devuelve la respuesta cacheada.
3. Si no existe, procesa: crea payment en DB, guarda respuesta en Redis con TTL 24h, devuelve.
4. Usa `SET NX` para evitar race condition si dos requests con la misma key llegan concurrentemente.
5. Test: envía el mismo request 5 veces con la misma key. Verifica que solo un payment se crea.
6. Test: envía dos requests concurrentes con la misma key. Verifica idempotencia.

**Criterios de éxito:**
- [ ] Enviando 5 requests con misma key, solo hay 1 payment en la DB.
- [ ] Todos los 5 responses son idénticos (mismo payment id).
- [ ] Bajo requests concurrentes (10 threads con misma key), solo 1 payment se crea.
- [ ] Timeout entre request y respuesta cacheada es <100ms.
- [ ] Errores 5xx del downstream NO se cachean (deben poder reintentarse).

**Bonus:** implementa el mismo patrón sobre una DB en vez de Redis (con `UNIQUE(idempotency_key)` constraint).

---

## 9. Recursos y siguientes pasos

**Referencias canónicas:**
- Brian Goetz — *Java Concurrency in Practice* (2006). Sigue siendo la referencia. Capítulos 5 (building blocks), 7 (cancellation), 8 (thread pools), 10-11 (liveness, performance).
- Martin Kleppmann — *Designing Data-Intensive Applications* (2017). Capítulos 7-9 (transactions, distributed systems, consistency).
- Doug Lea — *"The JSR-133 Cookbook for Compiler Writers"*. Memory model formal.
- Barbara Liskov (original) y Rob Pike ("Concurrency is not Parallelism", 2012).
- Joe Armstrong — *Programming Erlang* y su tesis *"Making reliable distributed systems in the presence of software errors"* (2003).
- Ulrich Drepper — *"What Every Programmer Should Know About Memory"* (2007).
- Java 21 Virtual Threads: JEP 444. Java 25: JEP 491 (pinning reduction).

**Blogs y herramientas 2026:**
- <https://py-free-threading.github.io/> — estado oficial de Python free-threaded.
- <https://openjdk.org/projects/loom/> — Project Loom.
- <https://tip.golang.org/doc/go1.26> — release notes Go 1.26.
- <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/> — canonical.
- <https://lmax-exchange.github.io/disruptor/> — LMAX Disruptor.
- Async Profiler, py-spy, Go pprof, JFR (Java Flight Recorder), jcstress.
- OpenTelemetry para tracing distribuido async.

**Qué leer/practicar después:** el capítulo 04 (testing y refactor) cubrirá cómo testear código concurrente sin flakiness. Antes de saltar, resuelve al menos dos de los ejercicios anteriores en tu lenguaje principal. Sin práctica, la teoría de concurrencia se olvida en semanas.

---

## 10. Preguntas de práctica (20)

- **Fuente:** [`packages/content/src/tech/programmer/sim-03-concurrency-and-async.json`](../../packages/content/src/tech/programmer/sim-03-concurrency-and-async.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-03-concurrency-and-async`

Cubre: concurrencia vs paralelismo, GIL de Python y sus mitos, race conditions en check-then-act, async/await vs threads, volatile vs synchronized, deadlocks y prevención con lock ordering, livelock, producer-consumer con BlockingQueue, immutability como estrategia, thread pool sizing, ConcurrentHashMap, composición async con CompletableFuture, idempotencia y at-least-once, optimistic vs pessimistic locking, cancelación cooperativa, backpressure en streams reactivos, actor model, memory model y happens-before, false sharing, y distributed locks con fencing tokens.

---

## Navegación

← [Cap 02](./02-solid-y-patrones.md) · [Índice](./README.md) · [Cap 04 →](./04-testing-y-refactor.md)
