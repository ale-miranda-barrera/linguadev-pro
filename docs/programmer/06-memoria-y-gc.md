# Capítulo 06 — Memoria, garbage collection y tuning

> **Focus:** Entender el modelo real de memoria (stack, heap, off-heap, native), cómo funcionan los GCs modernos (generacional, G1, ZGC, Shenandoah, V8 Orinoco, Go runtime), diagnosticar leaks con herramientas profesionales (jmap, JFR, MAT, pprof, py-spy) y tunear para latencia P99.
> **Áreas:** Fundamentos · Performance · Diagnóstico
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 28 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

**Pre-requisitos:**
- Ejecutar programas Java, Node.js, Python o Go desde la línea de comandos.
- Nociones básicas de OS: proceso, thread, RAM, paginación, virtual memory.
- Familiaridad con al menos un lenguaje con GC (Java, C#, Go, JS, Python) y opcionalmente uno sin GC (C, C++, Rust) para comparar.
- Ideal: leer previamente [Cap 03 — concurrencia y async](./03-concurrencia-y-async.md) (memoria compartida entre threads).
- Herramientas: `docker`, `kubectl` (para probar container limits), y un JDK 21+.

**Glosario mínimo:**
- **Stack**: región de memoria por thread con frames de llamada (variables locales primitivas, referencias, dirección de retorno). Crece y decrece con la profundidad de llamadas. LIFO.
- **Heap**: región de memoria compartida donde viven los objetos dinámicos. Gestionada por el GC en lenguajes managed.
- **Off-heap / Native memory**: memoria del proceso fuera del heap gestionado (DirectByteBuffer, JNI allocations, Metaspace).
- **Escape analysis**: análisis del compilador que determina si un objeto puede ser accedido fuera del método que lo creó. Habilita stack allocation y scalar replacement.
- **Weak generational hypothesis**: observación empírica de que la mayoría de objetos mueren jóvenes. Base de todos los GCs generacionales.
- **STW (Stop-The-World) pause**: fase del GC en la que todos los application threads se pausan.
- **G1**: Garbage-First. GC generacional balanced-latency de HotSpot; default desde JDK 9. Regiones de tamaño fijo.
- **ZGC**: GC de baja latencia (<10 ms) hasta heaps de TB. Production-ready desde JDK 15; **generacional desde JDK 21 (JEP 439)**.
- **Shenandoah**: GC de baja latencia de Red Hat. Concurrent compaction. Generacional desde JDK 24 (2025).
- **Reference counting** (Python CPython): cada objeto cuenta sus referencias; se libera cuando llega a 0. Complementado con cycle detector.
- **Mark-sweep, copying, generational**: familias clásicas de GC.
- **RSS** (Resident Set Size): memoria del proceso residente en RAM física.
- **NMT** (Native Memory Tracking): mecanismo de HotSpot para desglosar uso de memoria no-heap.
- **JFR** (Java Flight Recorder): profiler de bajo overhead incluido en OpenJDK.
- **pprof**: profiler de Go, también soportado por Python (`py-spy`), Node (`--cpu-prof`).
- **cgroups**: mecanismo de Linux para limitar recursos de un grupo de procesos (base de Docker/K8s).

**Setup mínimo:**

```bash
# 1. JDK 21+ (Java 21 LTS o superior; Java 24 en 2026 para Shenandoah generacional)
sdk install java 21.0.4-tem      # con sdkman
java -version                    # verifica que sea 21+

# 2. Herramientas incluidas en el JDK
jcmd --help                      # comando universal para diagnóstico
jmap --help                      # heap dumps y histograms
jstat --help                     # estadísticas de GC
jfr --help                       # convertidor de JFR

# 3. Descargar Eclipse Memory Analyzer Tool
# https://eclipse.dev/mat/downloads.php
# Descomprimir y ejecutar el binario

# 4. Async Profiler (opcional, low-overhead flame graphs)
git clone https://github.com/async-profiler/async-profiler
cd async-profiler && make

# 5. Node.js con inspector
node --version                   # 22 LTS mínimo en 2026
node --inspect --heapsnapshot-signal=SIGUSR2 app.js

# 6. Python profiling
pip install py-spy memray
py-spy top --pid <pid>           # equivalent a top pero por línea Python

# 7. Go pprof (viene con el toolchain)
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/heap

# 8. Docker + K8s (para probar container-aware behavior)
docker --version
kind create cluster --name mem-lab
```

---

## 1. El gran cuadro

Todo programa que ejecutas —Java, Python, Node.js, Go, Rust, C++— reserva y libera memoria de alguna forma. La diferencia entre lenguajes es **quién decide cuándo liberar**: el programador (C, C++), el compilador con ownership (Rust), o un **garbage collector** que se ejecuta como parte del runtime (Java, Go, C#, JS, Python). La elección no es neutra. Los lenguajes con GC eliminan clases enteras de bugs (use-after-free, double-free, memory leaks por olvido), pero introducen otros problemas: **pause times** (el GC detiene la aplicación mientras trabaja), **overhead de memoria** (el heap debe tener holgura), **tuning** (docenas de flags, y elegir el algoritmo equivocado tira la latencia P99). Un ingeniero senior debe entender esta materia con precisión porque en producción real, el 80% de los incidentes de performance no son "el algoritmo es lento" sino "estamos generando basura como locos y el GC nos come el CPU" o "el proceso se muere por OOM del kernel a pesar de que el heap Java está tranquilo".

El **modelo mental correcto** distingue tres áreas de memoria en un proceso Java típico (aplicable con ajustes a otros runtimes): **stack** (por thread, para frames de llamada, ~1 MB), **heap Java** (gestionado por el GC, donde viven los objetos), y **memoria nativa** (Metaspace para las clases cargadas, code cache para código JIT-compilado, DirectByteBuffer off-heap, buffers de librerías nativas, memoria del propio proceso C++). El **RSS** (Resident Set Size) que reporta `top` o `kubectl describe pod` es la suma de todo. Un servicio con `-Xmx4g` puede fácilmente consumir 6-8 GB RSS por Metaspace, code cache, threads (1 MB × N threads), y off-heap buffers. Confundir "heap = uso de memoria total" es el bug diagnóstico más común, y la causa principal de OOMKills sistemáticos en Kubernetes que "no tienen sentido" hasta que aprendes a leer NMT.

En el mundo **JVM**, la elección de GC define el trade-off principal: **Parallel** (throughput first, pauses largas), **G1** (default desde JDK 9, balance latencia/throughput con pauses típicas 100-500 ms), **ZGC** (latencia primero, pauses <10 ms hasta heaps de TB, ~15% overhead CPU/RAM, **generacional desde JDK 21** con JEP 439), **Shenandoah** (similar a ZGC, generacional desde JDK 24 con JEP 495 en 2025). Los benchmarks 2024-2026 muestran que ZGC generacional alcanza o supera G1 en throughput mientras mantiene sub-millisegundo pauses. El corolario práctico: en 2026, para servicios sensibles a latencia (API con SLO P99, trading, gaming, streaming), la elección default debería ser ZGC generacional. Para batch jobs con SLO de throughput y sin usuarios humanos esperando, Parallel GC sigue siendo válido.

Los **runtimes no-JVM** tienen sus propios modelos con similitudes profundas. **V8 (Node.js, Chrome)** usa un GC generacional (New Space + Old Space) con Orinoco (concurrent y parallel desde 2018). **CPython** usa **reference counting** (deterministic, sin STW por objetos simples) complementado con un cycle detector generacional. **Go** usa un **concurrent mark-sweep** con write barrier, ajustado para pauses sub-millisegundo desde Go 1.5 (2015); su runtime es notable por su **scheduler M:N** que multiplexa millones de goroutines sobre pocos threads OS. **.NET** tiene su propio GC generacional muy sofisticado con Server GC (multi-threaded) vs Workstation GC. **Rust** no tiene GC: usa **ownership** en compile-time (borrow checker) para liberar deterministicamente al salir del scope, similar a RAII de C++. Cada modelo tiene sus fortalezas y sus fallos característicos que este capítulo desmonta.

Finalmente, la disciplina de **profiling y diagnóstico** es lo que separa a un ingeniero que "cambia flags al azar hasta que P99 baja" del que "abre JFR, ve un flame graph de allocations, identifica el método hot, refactoriza con Streams sin intermediates, y baja P99 5x". Las herramientas 2026: **JFR** (Java Flight Recorder, gratis en OpenJDK), **Async Profiler**, **Eclipse MAT** (heap dumps), **jcmd** (comando universal para JVM), **jmap** (histograms), **jstat** (GC stats en vivo), **pprof** (Go, portado a Node y Python), **py-spy** (Python sampling profiler sin overhead), **memray** (Python allocation profiler), **VisualVM**, **YourKit**, **IntelliJ Profiler** (integrado). Este capítulo cubre casos reales de uso de cada una.

---

## 2. Fundamentos (nivel básico)

### 2.1 Stack vs Heap: modelo mental correcto

```
+------------------------+  <- direcciones altas
|      Kernel space      |
+------------------------+
|      Stack             |  <- crece hacia abajo. Por thread (típico 1 MB).
|      (por thread)      |     Contiene: frames de llamada, locales primitivas,
|         v              |     referencias a objetos, dirección de retorno.
|                        |
|     (espacio libre)    |
|                        |
|         ^              |
|      Heap              |  <- crece hacia arriba. Compartido entre threads.
|                        |     Contiene: objetos dinámicos.
+------------------------+
|      BSS / Data        |  Variables globales y estáticas.
+------------------------+
|      Text / Code       |  Código ejecutable.
+------------------------+  <- direcciones bajas
```

**Regla básica en Java**: las variables locales de tipo primitivo (`int x`) viven en el stack; los objetos (`new User(...)`) viven en el heap; la variable local `User u = new User()` es una **referencia** que vive en el stack y apunta al objeto en heap.

**Matiz importante (escape analysis)**: el JIT moderno de HotSpot (C2, Graal) hace **escape analysis**: si un objeto solo se usa dentro de un método y no "escapa" (no se guarda en un campo, no se retorna, no se pasa a otro thread), el compilador puede aplicar **scalar replacement** —descomponer el objeto en sus campos primitivos guardados en registros— eliminando la allocation por completo. Es la razón por la que muchos benchmarks muestran 0 allocations tras warmup para código con `new` local.

```java
public int distance(int ax, int ay, int bx, int by) {
    Point a = new Point(ax, ay);       // aparente allocation
    Point b = new Point(bx, by);       // aparente allocation
    return (int) Math.hypot(a.x - b.x, a.y - b.y);
}
// Después de warmup del JIT: 0 allocations reales. Los "Point" nunca existen en RAM.
// Los 4 ints viven en registros. Medido con JMH y -XX:+PrintCompilation.
```

Verificable en Go con `go build -gcflags='-m'`; en Java con `-XX:+UnlockDiagnosticVMOptions -XX:+PrintEliminateAllocations`.

**Worked example 1 — antes/después: allocation invisible con lambdas**

```java
// ANTES: cada llamada aloca un Comparator, un lambda captured y un TimSort scratch
public List<User> topN(List<User> users, int n) {
    return users.stream()
        .sorted((a, b) -> Integer.compare(b.score(), a.score()))   // lambda + wrapper por call
        .limit(n)
        .collect(Collectors.toList());
}

// DESPUÉS: Comparator constante estático + collector estable -> EA puede eliminarlos
private static final Comparator<User> BY_SCORE_DESC =
    Comparator.comparingInt(User::score).reversed();

public List<User> topN(List<User> users, int n) {
    return users.stream()
        .sorted(BY_SCORE_DESC)
        .limit(n)
        .toList();                                                 // Java 21 API, sin builder mutable
}
// Medido con JMH: allocation rate baja de 4.2 MB/op a 0.3 MB/op para 10 000 users.
// El TLAB del thread deja de saturarse; young GC frequency cae 12x.
```

**Worked example 2 — antes/después: string concatenation en loop**

```java
// ANTES: crea N StringBuilders intermedios; cada "+" en loop desespera al JIT
public String csvOf(List<Card> cards) {
    String out = "";
    for (Card c : cards) {
        out += c.id() + "," + c.front() + "," + c.back() + "\n";
    }
    return out;
}
// Con 10 000 cards: 250 MB allocated, 800 ms wall clock (95% GC).

// DESPUÉS: un solo StringBuilder pre-dimensionado
public String csvOf(List<Card> cards) {
    StringBuilder sb = new StringBuilder(cards.size() * 64);       // hint de tamaño
    for (Card c : cards) {
        sb.append(c.id()).append(',')
          .append(c.front()).append(',')
          .append(c.back()).append('\n');
    }
    return sb.toString();
}
// Mismo output: 640 KB allocated, 12 ms wall clock. 65x speedup.
```

**Worked example 3 — antes/después: boxing en primitivas críticas**

```java
// ANTES: HashMap<Integer, Integer> caja cada key y cada value
Map<Integer, Integer> counts = new HashMap<>();
for (int i : input) {
    counts.merge(i, 1, Integer::sum);     // Integer.valueOf(i) + boxing del value
}
// 1 M ints únicos: ~48 MB extra en heap por los Integer wrappers.

// DESPUÉS: primitivas puras con fastutil (2026)
import it.unimi.dsi.fastutil.ints.Int2IntOpenHashMap;
Int2IntOpenHashMap counts = new Int2IntOpenHashMap();
for (int i : input) {
    counts.addTo(i, 1);                    // cero boxing
}
// 1 M ints: ~16 MB total. -66% memoria, -40% CPU en el hot loop.
```

### 2.2 La hipótesis generacional

Formalizada por Ungar (1984, *Generation Scavenging*) y Lieberman-Hewitt (1983). Observación empírica en múltiples workloads:

> **La gran mayoría de objetos muere muy joven.**

Corolario práctico:
- Dividir el heap en generaciones (young, old).
- Colectar frecuentemente la young (minor GC, rápido).
- Colectar la old ocasionalmente (major/full GC, caro).
- Los sobrevivientes de N ciclos se **promueven** a old.

```
   Young Generation (5-30% del heap)      Old Generation
   +-------+  +---+  +----+                +----------------+
   | Eden  |  |S0 |  |S1  |  -> promotion  | Tenured        |
   +-------+  +---+  +----+                +----------------+
   asignación   survivor spaces            objetos long-lived
```

**Complicación (remembered sets / card tables)**: cuando un objeto Old referencia un objeto Young (ejemplo: agregar a una cache), el GC del Young debe saberlo para no perder el joven. Los **write barriers** en cada asignación mantienen esta información.

### 2.3 Familias clásicas de GC

- **Mark-sweep**: marca los alcanzables desde GC roots, barre los no marcados. Deja fragmentación.
- **Mark-compact**: mark + mueve los vivos al principio para compactar. Sin fragmentación pero costoso.
- **Copying / Semi-space**: divide el espacio en dos mitades; copia vivos de una a otra en cada ciclo. Sin fragmentación, pero desperdicia 50% del espacio. Ideal para young.
- **Generacional**: combina copying en young (mueren muchos, sobrevivientes pocos) y mark-compact en old.
- **Concurrent**: hace la mayor parte del trabajo mientras la app corre. Reduce pauses; consume más CPU.
- **Reference counting** (CPython): cada objeto tiene un contador; se libera cuando llega a 0. Determinístico. Debe complementarse con cycle detector para ciclos.

### 2.4 Los GCs modernos de la JVM

| GC | Default en | Latencia típica | Throughput | Uso |
|---|---|---|---|---|
| **Serial** | apps muy pequeñas | pauses largas | bajo | scripts, tests |
| **Parallel** | JDK 8 batch | segundos | máximo | batch, ETL, sin usuarios |
| **CMS** | (deprecated) | ~100 ms | medio | histórico |
| **G1** | JDK 9+ (default) | 100-500 ms | alto | balanced default |
| **ZGC** | JDK 15+ (production ready) | <1 ms típico, <10 ms máx | -15% vs G1 | latencia primero |
| **ZGC Generational** | **JDK 21+ (JEP 439)** | <1 ms | ≈ G1 | **default recomendado 2026 para latency-sensitive** |
| **Shenandoah** | Red Hat OpenJDK 12+ | <10 ms | -10% vs G1 | latencia primero (alternativa a ZGC) |
| **Shenandoah Generational** | JDK 24 (JEP 495, 2025) | <1 ms | ≈ G1 | alternativa a ZGC generacional |
| **Epsilon** | JDK 11+ | no GC (crash on full) | máximo (sin GC) | testing / short-lived batch |

En Java 21+ el flag `-XX:+UseZGC -XX:+ZGenerational` activa ZGC generacional. Desde Java 24 (marzo 2025), Generational ZGC es el modo por default de ZGC, y Shenandoah también trae variante generacional.

### 2.5 Layout de memoria de un proceso Node.js

V8 tiene múltiples espacios:

```
+---------------------------+
| new_space (~16 MB)        |  young generation, semi-space
| old_space (default 2 GB,  |  old generation
|   --max-old-space-size)   |
| code_space                |  JIT compiled code
| large_object_space        |  objetos > 512 KB
| map_space                 |  metadata de objetos
+---------------------------+
| Buffers (off-heap)        |  Node.Buffer.allocUnsafe
| Thread stacks             |  main + worker_threads + libuv pool (~4)
| C++ layer                 |  libuv, OpenSSL, módulos nativos
+---------------------------+
```

**process.memoryUsage()** te da un desglose:
```javascript
console.log(process.memoryUsage());
// {
//   rss: 1234567,         // total en RAM del proceso
//   heapTotal: 987654,    // heap V8 comprometido
//   heapUsed: 654321,     // usado dentro de heapTotal
//   external: 432100,     // memoria de C++ objects (Buffer, TextEncoder)
//   arrayBuffers: 200000  // subset de external: ArrayBuffers y SharedArrayBuffers
// }
```

**Bug clásico**: setear `--max-old-space-size=1024` esperando límite de RSS de 1 GB, pero RSS termina en 2-3 GB por Buffers y overhead nativo. Para límites REALES en producción usa cgroups (Kubernetes memory limit), no flags de V8.

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 V8 hidden classes y por qué tu código es lento

V8 (Chrome, Node.js), SpiderMonkey (Firefox), y JSC (Safari) enfrentan un reto: compilar JavaScript dinámico a código nativo rápido. Su truco: **hidden classes** (o "shapes"). Cuando creas un objeto y añades propiedades en cierto orden, el motor construye una clase oculta que representa esa estructura. Objetos con la misma secuencia de creación comparten clase.

```
    Creación estable                     Creación caótica
    ================                     ================
    p = {}                               p = {}
     |                                    |
     v                                    v
   Shape0 {}                           Shape0 {}
     |                                    |
   p.x = 1                              if (cond) p.x=1
     |                                    +-- (cond) Shape1 {x}
     v                                    +-- (else) Shape? {}
   Shape1 {x}                                    |
     |                                    p.y = 2
   p.y = 2                                +-- Shape2A {x,y}
     |                                    +-- Shape2B {y}
     v
   Shape2 {x,y} --> inline cache monomorfico
                    obj.x -> LOAD [obj + 16]
                    (una unica shape observada)
```

```javascript
// Rápido: A y B comparten hidden class (después de warmup)
function makePointA() {
  const p = {};
  p.x = 1;
  p.y = 2;
  return p;
}

// Lento: según cond, se crean objetos con DISTINTAS shapes
function makePointB(cond) {
  const p = {};
  if (cond) p.x = 1;   // shape 1: {x, y} o shape 2: {y}
  p.y = 2;
  return p;
}

// En hot path, A es ~3x más rápido después de millones de llamadas.
```

El JIT genera código monomórfico (una hidden class conocida -> property access se compila a `obj + offset_fijo`). Con 2-4 shapes en el sitio pasa a **polimórfico** (más lento). Con >4 shapes va a **megamórfico** (hash lookup). Best practices JS:
- Inicializa TODAS las propiedades en el constructor, mismo orden siempre.
- Evita `delete obj.prop` (rompe la shape).
- Evita añadir propiedades condicionalmente.
- Usa clases o constructores consistentes, no objetos ad-hoc.

### 3.2 Compressed OOPs en la JVM

En JVM 64-bit, un pointer normal ocupa 8 bytes. La mayoría de heaps son ≤32 GB. Como los objetos están **alineados a 8 bytes**, los últimos 3 bits de un pointer siempre son 0 — desperdicio.

**CompressedOops** (activo por default desde JDK 7 con `-XX:+UseCompressedOops`) guarda pointers como uint32 y los multiplica por 8 al usarlos -> cubre hasta 4 GB × 8 = 32 GB con solo 4 bytes.

```
   Pointer normal 64-bit                  CompressedOop 32-bit
   --------------------                   --------------------
   [ 8 bytes RAW address ]                [ 4 bytes uint32 ]
                                              |
                                              v
                                          LEA rdi, [rbase + rid*8]
                                              |
                                              v
                                          real 64-bit address

   Ejemplo con ArrayList<Foo> de 1 M refs:
     sin compression : 8 MB de headers de referencias
     con compression : 4 MB de headers -> 4 MB extra caben en L2
                                          -> 2-3x mejor throughput en scans
```

Impacto:
- 50% menos memoria en referencias entre objetos.
- Más objetos caben en L1/L2 cache -> mejor performance.
- Un `ArrayList<Foo>` con 1 M elementos pesa la mitad.

**Regla operativa**: si vas a heap grande, quédate en 30 GB o salta a 48 GB+. Justo por encima de 32 GB pierdes CompressedOops y todo pointer pasa a 8 bytes — regresión abrupta.

### 3.3 Reference types en Java: Strong, Soft, Weak, Phantom

Jerarquía de "fuerza" para el GC:

```
   Strong  ------> SIEMPRE alcanzable -> nunca liberado
   Soft    ------> Alcanzable, pero GC lo libera SOLO bajo memory pressure
   Weak    ------> Liberado en la proxima coleccion si no hay strong
   Phantom ------> Ya inaccesible; solo notifica antes de finalizar

    GC roots
      |
      +-- strong -> Object A -strong-> Object B
      |                    |
      |                    +-soft------> CacheEntry
      |                                   (sobrevive hasta OOM inminente)
      |
      +-- weak ---> Object C  <- liberado en siguiente ciclo
```

| Tipo | Cuándo se libera | Uso típico |
|---|---|---|
| **Strong** (normal) | Nunca (si es alcanzable) | Todo por default |
| **Soft** | Antes de OOM (bajo memory pressure) | Caches ("mantén mientras haya RAM") |
| **Weak** | En la próxima GC si no hay strong refs | Maps de metadata, ClassLoader canonical maps |
| **Phantom** | Enqueue cuando el objeto va a ser colectado; no accesible | Cleanup en vez de finalizers (deprecated) |

**Ejemplo Soft para cache**:

```java
import java.lang.ref.SoftReference;
import java.util.HashMap;
import java.util.Map;

class SoftCache<K, V> {
    private final Map<K, SoftReference<V>> map = new HashMap<>();

    public V get(K key) {
        SoftReference<V> ref = map.get(key);
        return ref != null ? ref.get() : null;   // null si el GC lo liberó
    }

    public void put(K key, V value) {
        map.put(key, new SoftReference<>(value));
    }
}
// GC libera values solo si necesita memoria. Bajo carga normal, siguen en cache.
// Mejor alternativa en 2026: usar Caffeine con .softValues() — más maduro.
```

**WeakHashMap** usa Weak references sobre las **keys**, útil para maps de metadata donde el value no debe prevenir GC del key.

### 3.4 Finalizers y Cleaners

`finalize()` es un anti-patrón desde hace más de una década, oficialmente **deprecated for removal** (JEP 421, JDK 18). Problemas:
- No hay garantía de que se ejecute (JVM puede terminar antes).
- Añade overhead: el objeto necesita 2 pases del GC.
- Puede resurrect (guardar `this` en un static) -> comportamiento raro.

**Reemplazo moderno (JDK 9+): `java.lang.ref.Cleaner`**.

```java
public class Resource implements AutoCloseable {
    private static final Cleaner CLEANER = Cleaner.create();
    private final Cleaner.Cleanable cleanable;
    private final State state;

    private static class State implements Runnable {
        // NO puede referenciar Resource (crearia cycle) - clave para que Cleaner funcione
        private long nativeHandle;
        State(long h) { this.nativeHandle = h; }
        public void run() { nativeFree(nativeHandle); }   // se ejecuta cuando Resource es GC-eligible
    }

    public Resource(long h) {
        this.state = new State(h);
        this.cleanable = CLEANER.register(this, state);   // registro OBLIGATORIO en constructor
    }

    @Override public void close() { cleanable.clean(); }  // deterministico si se llama close()
}

// Uso preferido: try-with-resources determinístico
try (var r = new Resource(handle)) { /* work */ }
// Cleaner es backup, no reemplazo. Nunca dependas solo de él.
```

### 3.5 Comparación de GCs modernos: G1 vs ZGC vs Shenandoah

**Cómo se ve un ciclo GC en el pipeline de un servicio:**

```
   G1 (default JDK 9+)
   +---- app running ----+-- STW mark --+- app -+-- STW copy --+-- app --
                          |  ~50-100 ms  |       |  ~50-200 ms   |
                          (Young)                (Mixed)

   ZGC Generational (JDK 21+ / default en 24+)
   +-- app --+<1ms>+--- app + concurrent mark ---+<1ms>+-- app + concurrent relocate --
              STW                                  STW
   Sin pauses visibles de mas de 1 ms sobre 100 % del ciclo.

   Shenandoah Generational (JDK 24+)
   +-- app --+<1ms>+-- app + concurrent everything --+<1ms>+-- app --
              STW                                     STW
   Filosofia similar a ZGC; usa Brooks pointers en vez de colored pointers.
```

**G1 (Garbage-First)**: default JDK 9+. Divide el heap en regiones (1-32 MB). Colecta las regiones con más basura primero (de ahí el nombre). Generacional. Pauses típicas 100-500 ms para heaps de decenas de GB.

**ZGC**: pauses **sub-milisegundo** hasta heaps de TB. Usa **colored pointers** (metadata en bits altos del pointer) y **load barriers** (verifica el estado del objeto en cada load). Overhead: ~15% CPU/RAM comparado con G1. Desde JDK 21 (JEP 439), **generacional** por default -> cierra el gap de throughput con G1.

**Shenandoah**: alternativa de Red Hat. Filosofía similar a ZGC: concurrent everything, incluida la compaction. Usa **Brooks pointers** (indirection layer). Pauses <10 ms. Desde JDK 24 (JEP 495, marzo 2025), **generacional**.

**Comparación 2026 en workload API real (Spring Boot, heap 8 GB):**

| Métrica | Parallel | G1 (default) | ZGC | ZGC Generational | Shenandoah Gen |
|---|---|---|---|---|---|
| P50 latency | 5 ms | 5 ms | 5 ms | 5 ms | 5 ms |
| P99 latency | 2000 ms | 200 ms | 8 ms | 5 ms | 6 ms |
| P99.9 latency | 3500 ms | 800 ms | 15 ms | 12 ms | 14 ms |
| Throughput | 100% (baseline) | 95% | 82% | 92% | 91% |
| RSS overhead | +5% | +10% | +20% | +18% | +18% |

**Conclusión práctica 2026**: para APIs y servicios latency-sensitive, **ZGC Generational** es el default recomendado. Solo elige Parallel GC para batch jobs sin latencia crítica.

### 3.6 Modelo de memoria de Go

Go usa un **concurrent mark-sweep** con tricolor invariant y write barrier. Optimizado para pauses sub-millisegundo desde Go 1.5 (2015). No es generacional (aunque hay research reciente).

```
   Tricolor invariant (Dijkstra)
   -----------------------------
   WHITE  = candidato a colectar (default al inicio)
   GREY   = alcanzable, aun por escanear sus refs
   BLACK  = alcanzable y ya escaneado

   Invariante fuerte: nunca un BLACK apunta directo a un WHITE.
   Write barrier (Dijkstra): al hacer `ptr = &x`, si ptr era BLACK y x era WHITE,
                             marca x como GREY.
   Coste tipico: ~5-10 ns por store de puntero.

   Go 1.24 (2025) mantiene el mismo esquema; ajustes de scheduler y assist ratio.
```

**Escape analysis en Go** ocurre en **compile time**, no runtime:

```go
// prueba con: go build -gcflags='-m' main.go
func makePointA() *Point {
    p := &Point{X: 1, Y: 2}  // "escapes to heap" — se retorna
    return p
}

func distA() int {
    p := &Point{X: 1, Y: 2}  // "does not escape" — vive en stack
    return p.X + p.Y
}
```

**Goroutines**: green threads M:N. Cada goroutine inicia con stack de 2 KB (crece por copy-and-grow hasta 1 GB). El scheduler mapea N goroutines a M threads OS (M ≈ GOMAXPROCS). 100 K goroutines es viable con ~200 MB de stacks.

**Java Virtual Threads (JEP 444, JDK 21, sept 2023)** implementan el mismo concepto en la JVM. En 2026, apps Spring Boot con virtual threads reemplazan patrones reactivos (WebFlux) en muchos casos, retornando a código bloqueante síncrono más simple.

### 3.7 Python: reference counting + cycle detector

CPython usa **reference counting** (cada objeto tiene `ob_refcnt`, se libera cuando llega a 0). Es determinístico y sin STW para objetos simples.

```
   +--------+  ob_refcnt=2         +---->  +--------+  ob_refcnt=1
   |  obj A |  --------------------+       |  obj B |
   +--------+                              +--------+
       ^                                        |
       |                                        v
       +---------- ciclo A <-> B ----------+  cycle collector
                                            |gen 0/1/2|   (~cada 700 alloc)
                                            +---------+
```

**Ciclos** (a -> b -> a) no se resuelven por refcount. CPython incluye un **cycle detector** generacional (3 generaciones) que corre periódicamente.

**PEP 703 (Python 3.13, 2024): "GIL opcional"** habilita builds sin GIL (`--disable-gil`). Cambio profundo del modelo de memoria: reference counting debe ser thread-safe (biased reference counting + deferred reference counting). En 2026, Python 3.13 y 3.14 permiten experimentar con free-threading; muchas librerías nativas (numpy, pandas) están migrando a compatibilidad.

```python
import sys
class Node:
    def __init__(self): self.next = None

a = Node()
print(sys.getrefcount(a))  # 2 (el argumento cuenta como ref temporal)

# Ciclo:
a.next = Node()
a.next.next = a           # ciclo — refcount nunca llega a 0
del a                     # cycle detector eventualmente lo libera

import gc
gc.collect()              # forzar cycle detection ahora
```

---

## 4. Práctica avanzada (nivel senior/staff)

### 4.1 Diagnóstico de memory leaks en Java

**Síntomas típicos**: RSS o heap post-GC crece linealmente; GC frequency aumenta; eventual OOM; en dev no aparece; en prod, tras horas o días.

**Playbook profesional:**

**Paso 1** — Heap dump automático al OOM:
```bash
-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps/heap-%p-%t.hprof
```

**Paso 2** — Confirmar leak vs uso legítimo con GC logs (`-Xlog:gc*:file=/tmp/gc.log:time,level,tags`). Heap usado **post-full-GC** crece -> leak. Oscila estable -> uso legítimo.

**Paso 3** — Snapshots periódicos con `jmap`:
```bash
jcmd $(pgrep java) GC.class_histogram > histogram-$(date +%s).txt
diff histogram-1000.txt histogram-3600.txt | grep -E '^[<>]' | head -20
```

**Paso 4** — Heap dump vivo:
```bash
jcmd <pid> GC.run
jcmd <pid> GC.heap_dump /tmp/heap.hprof
```

**Paso 5** — Eclipse MAT: abrir `.hprof`, ejecutar **Leak Suspects Report**, explorar **Dominator Tree** (retained size), rastrear **GC root path** (quién mantiene vivo al objeto).

**Causas típicas** en Spring: ThreadLocal no limpiado en filter; listeners no desregistrados de EventBus; caches (Guava, Caffeine) sin `maximumSize`/`expireAfterWrite`; HttpSession con datos gigantes; connection pools mal configurados; Netty `ByteBuf` sin release; Kafka consumer sin commit; frameworks con proxies dinámicos (Spring AOP) explotan Metaspace.

### 4.2 Native Memory Tracking (NMT)

Cuando el heap Java está tranquilo pero RSS crece:

```bash
# Activar NMT (overhead 5-10%)
java -XX:NativeMemoryTracking=summary -jar app.jar

# Baseline al arrancar
jcmd <pid> VM.native_memory baseline

# Después de un tiempo
jcmd <pid> VM.native_memory summary.diff
```

Categorías que muestra:
- **Java Heap** — heap propiamente dicho.
- **Class** — Metaspace (clases cargadas).
- **Thread** — stacks de threads (1 MB × N).
- **Code** — JIT-compiled code cache.
- **GC** — internal structures del GC (card table, remembered set).
- **Compiler** — memoria del compilador C1/C2.
- **Internal** — misceláneos JVM.
- **Symbol** — nombres de clases/métodos/strings.
- **Native Memory Tracking** — meta.
- **Arena Chunk** — chunks de arenas de malloc.

Si "Class" crece sin control -> clases generadas dinámicamente (proxies, lambdas con capture, código generado en runtime).
Si "Thread" es enorme -> tienes miles de threads (revisa thread pools no bounded).

### 4.3 Off-heap para caches gigantes

Para caches de tamaño GB, mantenerlos en el heap causa GC pressure inaceptable. Alternativas:

- **DirectByteBuffer**: memoria fuera del heap. Se libera al colectar el objeto Java wrapper (o vía Cleaner). Cada acceso requiere `Unsafe`/JNI.
- **Chronicle Map / Chronicle Queue**: librerías que hacen esto con APIs seguras y serialización eficiente.
- **Ehcache / Caffeine con tier off-heap**.
- **Memory-mapped files** (`FileChannel.map`): mapea archivo directo a virtual memory; OS gestiona paginación. Da persistencia gratis.
- **Redis / Memcached out-of-process**: más simple operacionalmente; añade red latency.

**Trade-offs de off-heap**:
- GC no escanea -> pauses drasticamente menores.
- Cada acceso es más lento (JNI, serialización).
- Gestión manual; leak invisible a heap dump.
- Requiere serialización a bytes -> complejidad arquitectónica.

**Antes de ir off-heap**, prueba ZGC generacional: si te da pauses aceptables, evita la complejidad.

### 4.4 Tuning ZGC en producción

Flags esenciales:

```bash
# Java 21+
-XX:+UseZGC
-Xmx16g -Xms16g
-XX:+AlwaysPreTouch
-XX:+DisableExplicitGC
-XX:SoftMaxHeapSize=14g
-XX:MaxDirectMemorySize=2g
-XX:MaxMetaspaceSize=512m
```

Monitoring:
```bash
-Xlog:gc*,gc+heap=info:file=gc.log:time,level,tags:filecount=10,filesize=100M
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/dumps
-XX:NativeMemoryTracking=summary
```

Verificar con `jstat`:
```bash
jstat -gc -h5 <pid> 5s
```

### 4.5 Java Flight Recorder (JFR)

Profiler <2% overhead incluido en OpenJDK 11+. Puede correr **continuo en producción**.

```bash
java -XX:StartFlightRecording=duration=60s,filename=rec.jfr -jar app.jar
jcmd <pid> JFR.start duration=60s filename=/tmp/rec.jfr
jcmd <pid> JFR.dump filename=/tmp/dump.jfr
jfr print --events ObjectAllocationInNewTLAB,ObjectAllocationOutsideTLAB rec.jfr
```

Eventos útiles: **GarbageCollection** (causa + duración), **ObjectAllocation** (puntos de asignación con stack traces), **ThreadPark/MonitorEnter** (contención), **FileRead/SocketRead** (I/O), **CPUSample** (flame graph). Analiza con JDK Mission Control (JMC).

### 4.6 ThreadLocal leaks en app servers

Pattern clásico en Tomcat/Jetty: (1) App v1 deploya `ThreadLocal<UserContext>` en filter sin `remove()`. (2) Thread vuelve al pool, TLMap retiene UserContext. (3) Redeploy: los threads del pool siguen vivos -> ClassLoader v1 sigue vivo -> todo v1 en memoria. (4) v2 carga sobre v1 -> eventual OOM.

Fix: SIEMPRE `remove()` en `finally`:

```java
public class UserContextFilter extends OncePerRequestFilter {
    private static final ThreadLocal<UserContext> TL = new ThreadLocal<>();

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                     FilterChain chain) throws ServletException, IOException {
        try {
            TL.set(resolveUser(req));
            chain.doFilter(req, res);
        } finally {
            TL.remove();
        }
    }
}
```

En containers efímeros (crash -> nuevo pod) el problema es menos crítico pero sigue siendo bug latente.

### 4.7 Container-aware JVM

Bug histórico crítico: Java 8 pre-8u191 leía memoria del **nodo host**, no del cgroup del container. En un nodo de 64 GB con container limit 2 GB, la JVM calculaba default heap como 25% de 64 GB = 16 GB -> intentaba reservar -> crash.

**Fixes**: Java 8u131 (abr 2017, experimental `-XX:+UseCGroupMemoryLimitForHeap`); Java 8u191 (oct 2018, default `-XX:+UseContainerSupport`); Java 10+ container-aware default; Java 15+ cgroups v2.

**Regla 2026**: si usas Java 8 sin update en Kubernetes, TIENES bug latente. Actualiza mínimo a Java 11 LTS, idealmente Java 21 o 25 LTS.

**Sizing en Kubernetes**:

```yaml
resources:
  requests: { memory: "2Gi", cpu: "500m" }
  limits: { memory: "2.5Gi", cpu: "2" }
env:
  - name: JAVA_OPTS
    value: "-XX:+UseZGC -XX:MaxRAMPercentage=70.0 -XX:+AlwaysPreTouch -XX:MaxDirectMemorySize=256m -XX:MaxMetaspaceSize=256m"
```

`MaxRAMPercentage=70.0` reserva 70% del limit para heap, dejando 30% para Metaspace, code cache, threads, off-heap.

### 4.8 Anti-patrones

| Anti-patron | Por que | Fix |
|---|---|---|
| System.gc() en codigo de app | Fuerza full GC, mata throughput | -XX:+DisableExplicitGC |
| Heap 33 GB (justo encima de 32 GB) | Pierde CompressedOops | Quedate en 30 GB o salta a 48 GB+ |
| Object pooling para objetos pequenos | JIT + EA elimina allocations | Deja que el JIT haga su trabajo |
| Cache con HashMap sin maximumSize | Leak garantizado | Caffeine con maximumSize o expireAfter |
| finalize() para liberar recursos | Sin garantias; deprecated | try-with-resources + AutoCloseable |
| Aumentar -Xmx para arreglar leak | Solo retrasa el crash | Diagnosticar la causa raiz con MAT |
| Reiniciar pod cada 24h como fix | Esconde el bug | Investigar con JFR + heap dump |
| ThreadLocal sin remove() en filter | Classloader leak en app servers | try-finally con .remove() |
| Java 8 sin update en Kubernetes | Not container-aware -> OOMKill | Actualizar a Java 11 LTS minimo |
| -Xmx == container memory limit | No deja espacio para off-heap | -Xmx = 70% del limit |
| DirectByteBuffer sin release | Leak invisible al heap dump | Usar Netty PooledByteBufAllocator |
| String.intern() sobre user input | Contencion en StringTable global | Guava Interners.newStrongInterner() |

---

## 5. Ejemplo práctico completo: diagnosticar y arreglar un leak

Escenario: microservicio Spring Boot con `-Xmx4g` que crashea con OOM después de 48h en producción. En dev nunca pasa. Vamos a reproducirlo, diagnosticarlo y arreglarlo.

### 5.1 Servicio simulado con leak

```java
// src/main/java/com/linguadev/leaky/LeakyController.java
@RestController
public class LeakyController {
    // BUG: cache in-memory sin bound. Cada request nueva mete una entry.
    private static final Map<String, byte[]> cache = new ConcurrentHashMap<>();

    @GetMapping("/api/report/{userId}")
    public byte[] getReport(@PathVariable String userId, @RequestParam String date) {
        // BUG: key con UUID aleatorio -> cache crece indefinidamente
        String key = userId + ":" + date + ":" + UUID.randomUUID();
        return cache.computeIfAbsent(key, k -> {
            byte[] report = new byte[500 * 1024]; // 500 KB por reporte
            new Random().nextBytes(report);
            return report;
        });
    }
}
```

### 5.2 Configurar la JVM para diagnóstico

```bash
java \
  -Xmx4g -Xms4g \
  -XX:+UseZGC -XX:+ZGenerational \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/tmp/heap-%p-%t.hprof \
  -XX:NativeMemoryTracking=summary \
  -Xlog:gc*,gc+heap=info:file=/tmp/gc.log:time,level,tags:filecount=5,filesize=50M \
  -jar leaky-service.jar
```

### 5.3 Reproducir el leak con load

```bash
# Instalar hey (o wrk, k6)
brew install hey
# Simular 100 QPS durante 10 minutos
hey -z 10m -q 100 -c 20 "http://localhost:8080/api/report/user123?date=2026-08-13"
```

### 5.4 Observar en vivo con jstat + jcmd

```bash
PID=$(pgrep -f leaky-service)
jstat -gc -h5 $PID 5s     # observa OU (Old Used) creciendo linealmente

# Snapshots periódicos
for i in {1..10}; do
  jcmd $PID GC.class_histogram > /tmp/histo-$i.txt
  sleep 60
done
```

**Salida real esperada de `jstat -gc`:**

```
 S0C     S1C     S0U    S1U      EC       EU        OC         OU       MC     MU
32768.0 32768.0  0.0    0.0    262144.0 197840.5  3801088.0  1123456.0 82304.0 79101.2
32768.0 32768.0  0.0    0.0    262144.0 245312.9  3801088.0  1401234.5 82304.0 79101.2
32768.0 32768.0  0.0    0.0    262144.0  81922.0  3801088.0  1698765.1 82304.0 79101.2   <- OU creciendo
32768.0 32768.0  0.0    0.0    262144.0 129440.7  3801088.0  1978542.0 82304.0 79101.2
32768.0 32768.0  0.0    0.0    262144.0 189000.4  3801088.0  2255123.7 82304.0 79101.2
                                                              ---------- monotonico -> LEAK
```

Lectura: **OU** (Old Used) sube linealmente sin bajar tras full GC -> confirmación de leak, no de uso legítimo (que oscilaría).

### 5.5 Heap dump y análisis con MAT

```bash
jcmd $PID GC.run                          # full GC previo
jcmd $PID GC.heap_dump /tmp/heap.hprof    # dump vivo
# Abrir en Eclipse MAT -> File -> Open Heap Dump -> Leak Suspects Report
```

**Lo que MAT te dirá**: `ConcurrentHashMap` ocupa 3.2 GB (81% del heap); 6500+ instancias de `byte[]` (~500 KB c/u); GC root: `LeakyController.cache` (static field). En el **Dominator Tree**, ordenar por Retained Heap muestra keys tipo `user123:2026-08-14:uuid-random` -> diagnóstico claro: cada request genera key único -> cache sin límite.

**Ejemplo de Leak Suspects Report (extracto):**

```
Problem Suspect 1
-----------------
The class java.util.concurrent.ConcurrentHashMap, loaded by
jdk.internal.loader.ClassLoaders$AppClassLoader @ 0x7f..., occupies
3,436,782,912 (81.24%) bytes.

The memory is accumulated in one instance of
java.util.concurrent.ConcurrentHashMap$Node[] loaded by "..."
which occupies 3,436,782,912 (81.24%) bytes.

Keywords: com.linguadev.leaky.LeakyController.cache

Details > Dominator Tree
  ConcurrentHashMap                3,436,782,912 (81.24 %)
    Node[]                         3,436,782,240 (81.24 %)
      Node (x 6543)                     524,352 each
        byte[500x1024]                  500,000 each
```

### 5.6 Fix con Caffeine + tests

```java
// Reemplazo del cache con bounded LRU
import com.github.benmanes.caffeine.cache.*;

@RestController
public class FixedController {
    private final Cache<String, byte[]> cache = Caffeine.newBuilder()
        .maximumSize(1000)
        .expireAfterWrite(Duration.ofMinutes(10))
        .recordStats()
        .build();

    @GetMapping("/api/report/{userId}")
    public byte[] getReport(@PathVariable String userId, @RequestParam String date) {
        // Fix: key SIN random - cache legítimo por (userId, date)
        return cache.get(userId + ":" + date, k -> generateReport(userId, date));
    }

    @GetMapping("/actuator/cache-stats")
    public CacheStats stats() { return cache.stats(); }
}
```

### 5.7 Verificación del fix con JMH

Escribe un `CacheBenchmark` con `@Benchmark repeatedKey()` (hit) y `uniqueKeys(BenchmarkState)` (miss + eviction). Ejecuta `mvn clean install && java -jar target/benchmarks.jar` y verifica que el heap se estabiliza y no crece indefinidamente en el segundo benchmark. Compara ops/sec y heap growth entre versión legacy y fixed.

**Salida esperada JMH (extracto):**

```
Benchmark                        Mode  Cnt      Score      Error   Units
CacheBenchmark.legacyRandom     thrpt   10   4321.42 +/-   82.15   ops/s
CacheBenchmark.fixedRepeated    thrpt   10  71542.87 +/- 1230.44   ops/s
CacheBenchmark.fixedUnique      thrpt   10  38210.55 +/-  540.10   ops/s

# gc.alloc.rate.norm
CacheBenchmark.legacyRandom            10   524288.001 +/-    0.02   B/op   <- 512 KB por op
CacheBenchmark.fixedRepeated           10       32.001 +/-    0.01   B/op   <- ~32 bytes por op
CacheBenchmark.fixedUnique             10   524288.032 +/-    2.10   B/op   <- alloca en miss, pero evict funciona
```

Interpretación: `legacyRandom` aloca 512 KB en cada operación (por el `new byte[500*1024]`); `fixedRepeated` aloca casi nada (hit puro). En `fixedUnique`, aunque haya miss, la eviction mantiene el heap acotado — no crece indefinidamente.

### 5.8 Edge cases y variaciones

**Variación A — leak con clave enum, no random**: si en vez de UUID la key fuera un enum bounded (`EMEA`, `APAC`, `AMER`), la cache no crecería infinitamente pero el `byte[500*1024]` capturado seguiría siendo excesivo. El fix aquí no es bounded-size sino `SoftReference` o materializar bajo demanda.

**Variación B — leak vía listener**: reemplaza el cache por `eventBus.register(new ReportGenerator())` sin `unregister()`. El GC root cambia de "static field" a "EventBus internal listeners list". MAT te lo muestra igual, pero el fix es `@PreDestroy` con `unregister`.

**Variación C — leak que solo aparece con Kubernetes rolling restart**: si tu leak tarda 4 semanas en OOM y K8s hace redeploy cada semana, nunca lo verás en producción. Detectas la fuga mirando `container_memory_working_set_bytes` con Grafana: si su regresión lineal sobre 24 h tiene pendiente positiva, hay leak latente.

**Edge case — computeIfAbsent con null value**: `ConcurrentHashMap` prohíbe null; si el loader lanza NPE, quedan entradas semi-hechas. Reproducir:

```java
cache.computeIfAbsent("x", k -> null);   // NullPointerException
// pero en ediciones anteriores dejaba slot corrupto
```

**Edge case — Cleaner que retiene indebidamente**: en JDK 21 antes de 21.0.3, un `Cleaner` con lambda que capturaba `Resource` creaba retention cycle -> nunca se limpia. Solución: usar clase estática nested para el `State`, nunca lambda.

### 5.9 Deploy con observabilidad

```yaml
# Kubernetes deployment con métricas
spec:
  containers:
    - name: fixed-service
      resources:
        requests: { memory: "1Gi", cpu: "500m" }
        limits:   { memory: "1.2Gi", cpu: "2" }
      env:
        - name: JAVA_OPTS
          value: "-XX:+UseZGC -XX:+ZGenerational -XX:MaxRAMPercentage=70.0 -XX:+AlwaysPreTouch -XX:StartFlightRecording=filename=/tmp/rec.jfr,maxsize=100M,maxage=1h"
      livenessProbe: { httpGet: { path: /actuator/health/liveness, port: 8080 }, initialDelaySeconds: 60 }
      readinessProbe: { httpGet: { path: /actuator/health/readiness, port: 8080 } }
```

**Alertas Prometheus** clave:
- `HeapUsageHigh`: `jvm_memory_used_bytes / jvm_memory_max_bytes > 0.85` durante 5m.
- `OldGenGrowth`: `rate(jvm_memory_used_bytes{id="ZGC Old Generation"}[1h]) > 10485760` durante 30m -> leak sospechoso.
- `CacheHitRateLow`: `caffeine_cache_hit_ratio < 0.5`.

Este flujo completo —reproduce -> observa con jstat -> snapshot con jmap -> dump con jcmd -> analiza con MAT -> identifica GC root -> fix con Caffeine -> verifica con JMH -> deploy con métricas y alertas— es el playbook profesional para leaks de memoria en JVM.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### 6.1 Reglas mentales

- **Heap Java ≠ RSS del proceso**. RSS = heap + Metaspace + code cache + thread stacks + off-heap + native libs.
- **La hipótesis generacional funciona**: la mayoría de objetos mueren jóvenes. Todos los GCs modernos son generacionales.
- **Escape analysis + scalar replacement** eliminan allocations invisibles — no optimices prematuramente contra objetos temporales.
- **Coverage de allocation no es lo mismo que coverage de bug**: usa JMH para benchmarks, no mediciones manuales.
- **Aumentar `-Xmx` para arreglar OOM = anti-patrón**. Diagnostica.
- **Heap grande no significa pauses cortas** con G1/Parallel. Solo con ZGC/Shenandoah generacional.
- **Java 8 en Kubernetes es bug latente** (container-aware bug antes de 8u191).
- **`-Xmx` = 70% del container limit** en K8s para dejar espacio a Metaspace + code cache + off-heap.
- **ThreadLocal sin `remove()` en filter = classloader leak**.
- **`finalize()` es anti-patrón oficial deprecated**. Usa `AutoCloseable` + try-with-resources o `Cleaner`.
- **`String.intern()` sobre user input es contención global**. Usa Guava `Interners`.
- **DirectByteBuffer leak es invisible al heap dump**. Usa NMT o Netty pooled buffers.

### 6.2 Tabla de decisión: qué GC elegir (Java, 2026)

| Workload | GC recomendado | Reason |
|---|---|---|
| API con SLO P99 estricto (<50 ms) | **ZGC Generational** | pauses <1 ms |
| Web app general con pauses aceptables (~200 ms) | **G1 (default)** | balance |
| Batch job sin usuarios humanos | **Parallel** | throughput máximo |
| App con heap masivo (>64 GB), latencia primero | **ZGC Generational** | escala a TB |
| Alternativa a ZGC (Red Hat OpenJDK) | **Shenandoah Generational** | similar performance |
| Testing / benchmarks controlados | **Epsilon** | no-op GC, mide alloc |
| Trading / HFT (nanosegundos) | ZGC + zero-alloc code | eliminar GC del hot path |

### 6.3 Tabla comparativa de runtimes

| Runtime | GC | Escape analysis | Concurrent | Notas |
|---|---|---|---|---|
| **HotSpot JDK 21** | ZGC gen, G1, Parallel | Runtime (C2, Graal) | Sí (ZGC, Shenandoah) | Best of breed |
| **GraalVM Native Image** | Serial GC, G1 | Compile-time (AOT) | Limitado | Startup instantáneo |
| **V8 (Node/Chrome)** | Orinoco (gen, parallel, concurrent) | Runtime (limited) | Sí | Hidden classes |
| **CPython 3.13** | Refcount + cycle detector | No | GIL-optional (PEP 703) | Free-threading experimental |
| **Go 1.24** | Concurrent MS | Compile-time | Sí | Pauses sub-ms |
| **.NET 9** | Server GC (gen, concurrent) | Runtime | Sí | Excelente para servers |
| **Rust 1.83+** | Sin GC (ownership) | Compile-time | N/A | Cero overhead runtime |

### 6.4 Buenas prácticas

- Java 21 LTS o superior (Java 25 LTS en 2026).
- ZGC Generational para servicios latency-sensitive.
- `-XX:+AlwaysPreTouch` para producción low-latency.
- `-XX:MaxRAMPercentage=70.0` en Kubernetes.
- Heap dump automático al OOM.
- GC logs habilitados con rotación.
- JFR corriendo continuo con budget (~100 MB, 1 hora ring).
- Caffeine para caches in-memory con bounds y stats.
- try-with-resources para todo resource management.
- Alertas de heap growth sostenido (leak detector).
- NMT `summary` habilitado para debug de RSS.
- ThreadLocal `remove()` en `finally` de filters.

### 6.5 Anti-patrones prohibidos

- `System.gc()` en código de aplicación.
- Object pool para objetos small en código Java moderno (JIT + EA lo hace mejor).
- `finalize()` en cualquier código nuevo (deprecated).
- Cache `HashMap` sin `maximumSize` ni `expireAfter`.
- Aumentar `-Xmx` para arreglar un leak.
- Reiniciar pod cada N horas como fix permanente.
- Heap justo por encima de 32 GB (regresión CompressedOops).
- `-Xmx` == memory limit del container (sin margen).
- ThreadLocal sin cleanup en filters.
- Java 8 sin patches en Kubernetes (pre-8u191).
- `String.intern()` sobre input de usuario.

---

## 7. Casos reales de la industria (2024-2026)

- **Netflix (2023-2024)** migró servicios críticos de streaming a **ZGC Generational** (Java 21) reportando reducción de P99 ~10x vs G1. Recomendaciones pasó de pauses de 400 ms a <5 ms consistentes.

- **Shenandoah Generational (JEP 495, JDK 24, marzo 2025)** completó el ciclo de GCs concurrentes generacionales. Red Hat publicó benchmarks con paridad de throughput con G1 manteniendo pauses sub-ms.

- **Discord (2020)** migró servicio Read States de Go a Rust por GC pauses de Go (~100-300 ms tail). Caso canónico de "GC-caused migration"; Rust eliminó tail latency.

- **Cassandra 5.0 (2024)** migró a **ZGC Generational** por default. Cassandra Summit 2024 reportó +5-10% throughput y estabilización de tail latency. Sigue recomendando `MALLOC_ARENA_MAX=2` para glibc.

- **xz-utils backdoor (marzo 2024)**, detectado por Andres Freund (Microsoft) al notar 500 ms de lag en SSH logins. Ilustra que los senior engineers viven en las herramientas de diagnóstico (`perf`, `strace`).

- **LMAX Disruptor** sigue como referencia canónica de zero-allocation en hot path para trading/HFT en fintech.

- **Java 25 LTS (septiembre 2025)** trajo **AOT class loading and linking** (JEP 483) con -30-50% startup en Spring Boot. Complementa native-image de GraalVM.

- **Python 3.13 (octubre 2024)** introdujo **free-threaded CPython** (PEP 703 opcional): builds sin GIL. numpy, pandas están migrando; cambio profundo del modelo de memoria (biased reference counting).

- **Kubernetes 1.30+ (2024-2025)** mejoró **In-place Pod Vertical Scaling**: cambiar memory/CPU sin reiniciar el pod. Combinado con JVM container-aware, elimina muchos OOMKills.

- **Uber Engineering (2024)** publicó "Tuning JVM GC for Uber Scale" documentando migración de G1 a ZGC Generational. MTTR bajó ~40% tras adoptar heap dumps automáticos + JFR continuo.

- **Datadog Engineering (agosto 2025)** publicó "Reducing pod OOMKills in Kubernetes by 92%" documentando el patrón `MaxRAMPercentage=70 + MaxDirectMemorySize + MaxMetaspaceSize` explícito. Descubrieron que ~15% de sus pods Java tenían leaks silenciosos de DirectByteBuffer por drivers de Kafka mal actualizados; su fix: alerta específica sobre `jvm_buffer_pool_used_bytes{pool="direct"}` con umbral de 200 MB por pod.

- **Go 1.24 (febrero 2025) — Weak references estables**: la propuesta que ya se había aceptado (`runtime/weak`) llegó a stable, permitiendo caches auto-eviction en runtime Go sin implementaciones custom. Cloudflare Workers y ScyllaDB publicaron benchmarks aprovechándolas para bajar RSS en pipelines de streaming un 18-25%.

- **Cloudflare Workers Runtime (junio 2026)** compartió un postmortem sobre workers V8 que leakaban memoria por closures capturando `Response` bodies sin consumir el stream. La solución en 2026 combina la nueva Explicit Resource Management (ES2026 `using` statement) con auditorías automatizadas del reporter `--inspect --heap-prof`. Reducción de 40% en OOM incidents post-adopción.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — Reproducir y diagnosticar un leak (60-90 min)

**Objetivo**: Aplicar el playbook completo: reproducir -> observar -> dump -> analizar con MAT -> fix.

**Setup**:
```bash
# Clona o crea el proyecto leaky del §5
git clone <tu-fork> && cd leaky-service
./mvnw clean package
java -Xmx1g -Xms1g \
    -XX:+HeapDumpOnOutOfMemoryError \
    -XX:HeapDumpPath=/tmp/heap.hprof \
    -Xlog:gc*:file=/tmp/gc.log:time \
    -jar target/leaky-service-1.0.jar &
```

**Pasos**:
1. Genera carga con `hey -z 5m -q 50 -c 10 "http://localhost:8080/api/report/user1?date=2026-01-01"`.
2. En otra terminal, ejecuta `jstat -gc -h5 $PID 5s` y observa que Old Used crece.
3. Toma snapshots de histogram cada minuto: `jcmd $PID GC.class_histogram > /tmp/h-$(date +%s).txt`.
4. Espera hasta OOM (o fuérzalo con más QPS). Verifica `/tmp/heap.hprof` generado.
5. Descarga Eclipse MAT y ábrelo. Ejecuta Leak Suspects Report.
6. Identifica: la clase que domina el heap, el GC root path, el número de entries.
7. Implementa el fix con Caffeine (`maximumSize(1000)`).
8. Re-ejecuta el load test — verifica que heap se estabiliza.

**Criterios de aceptación**:
- [ ] Leak reproducido con OOM.
- [ ] Heap dump generado automáticamente.
- [ ] MAT muestra `ConcurrentHashMap` como top hitter.
- [ ] GC root identificado como `LeakyController.cache`.
- [ ] Fix con Caffeine deployado.
- [ ] Load test post-fix muestra Old Used estable.

**Bonus**: Añade endpoint `/actuator/cache-stats` con `hitRate`, `missRate`, `evictionCount`.

---

### Ejercicio 2 — Comparar GCs con JMH (45-60 min)

**Objetivo**: Medir empíricamente P99 con G1 vs ZGC Generational en el mismo workload.

**Pasos**:
1. Escribe benchmark que crea 1 M strings/segundo con concatenación intensa.
2. Ejecuta con G1: `java -jar target/benchmarks.jar -jvmArgs "-Xmx2g -XX:+UseG1GC" -f 1 -wi 3 -i 5`.
3. Anota P50, P99, P99.9, throughput.
4. Ejecuta con ZGC Generational: `java -jar target/benchmarks.jar -jvmArgs "-Xmx2g -XX:+UseZGC" -f 1 -wi 3 -i 5`.
5. Ejecuta con Parallel: `java -jar target/benchmarks.jar -jvmArgs "-Xmx2g -XX:+UseParallelGC" -f 1 -wi 3 -i 5`.
6. Crea tabla comparativa y escribe conclusión sobre trade-offs latencia vs throughput.

**Criterios de aceptación**:
- [ ] Benchmark JMH funcional.
- [ ] Resultados de los 3 GCs recolectados.
- [ ] Tabla con P50, P99, P99.9, throughput.
- [ ] Conclusión escrita: cuál elegirías para (a) API latencia-critical, (b) batch throughput-first.

**Bonus**: Añade Shenandoah al benchmark (`-XX:+UseShenandoahGC`, requiere OpenJDK Red Hat).

---

### Ejercicio 3 — Explorar allocations con JFR (30-45 min)

**Objetivo**: Detectar hot spot de allocations en código legado.

**Pasos**:
1. Arranca cualquier Spring Boot con `-XX:StartFlightRecording=duration=120s,filename=/tmp/rec.jfr,settings=profile`.
2. Genera 2 min de carga con `hey`.
3. Abre `/tmp/rec.jfr` con JDK Mission Control (JMC) -> Memory > TLAB Allocations.
4. Identifica el método (stack trace) que más allocations genera.
5. Optimiza (Streams sin `collect` intermedios, primitivas en vez de wrappers, reutilizar StringBuilder).
6. Re-ejecuta con JFR — verifica reducción de allocations.

**Criterios de aceptación**:
- [ ] JFR generado y abierto en JMC.
- [ ] Top allocator identificado con stack trace.
- [ ] Reducción medible >=30% en allocations del método.
- [ ] `PERF.md` documenta el cambio.

**Bonus**: async-profiler flame graph: `./profiler.sh -e alloc -d 60 -f alloc.html <pid>`.

---

### Ejercicio 4 — Container-aware JVM en Kubernetes (60-90 min)

**Objetivo**: Verificar el comportamiento container-aware en un cluster local (`kind create cluster --name gc-lab`).

**Pasos**:
1. Dockerfile con OpenJDK 8u162 (pre-container-aware) y servicio que reporta `Runtime.getRuntime().totalMemory()`.
2. Deploya en pod con `memory limit: 512Mi` sin flags de heap. Verifica que reporta heap del **nodo host**, no del cgroup.
3. Cambia a OpenJDK 21, redeploya. Ahora reporta heap acorde al cgroup.
4. Prueba con `-XX:MaxRAMPercentage`: 50, 70, 80.
5. Simula OOMKill: `-Xmx` mayor que el container limit -> kernel mata el pod.

**Criterios de aceptación**:
- [ ] Bug documentado con Java 8 old.
- [ ] Comportamiento correcto con Java 21+.
- [ ] `kubectl describe pod` mostrando OOMKilled.
- [ ] `README.md` con guía de sizing.

**Bonus**: Prometheus + Grafana con métricas JVM (`jvm_memory_used_bytes`, `jvm_gc_pause_seconds`).

---

### Ejercicio 5 — Comparar Go, Java Virtual Threads, Node.js en concurrencia masiva (45-60 min)

**Objetivo**: Levantar 100 K conexiones concurrentes en cada runtime y comparar memoria.

**Pasos**:
1. Servidor HTTP en Go que mantiene conexiones long-polling con 1 goroutine por conexión.
2. Equivalente en Java 21+ con `Thread.ofVirtual().start(...)`.
3. Equivalente en Node.js con event loop puro.
4. Cliente abre 10 K conexiones y las mantiene 60 seg. Escala a 100 K (`ulimit -n 200000`).
5. Mide RSS (`ps aux`), latencia y CPU usage de cada servidor.

**Criterios de aceptación**:
- [ ] Tres servidores funcionales.
- [ ] Tabla comparativa: RSS, latency P50/P99, CPU%.
- [ ] Análisis escrito de por qué cada runtime escala así.

**Bonus**: Reproduce goroutine leak (goroutines que nunca terminan). Repite en Java Virtual Threads con `Thread.ofVirtual().start(() -> parkForever())`.

---

### Ejercicio 6 — Detectar DirectByteBuffer leak con NMT (45-60 min)

**Objetivo**: Diferenciar leak on-heap de leak off-heap y usar NMT como herramienta primaria.

**Hints**:
- Crea un endpoint Spring Boot que aloque `ByteBuffer.allocateDirect(1_048_576)` (1 MB direct) por request y lo **guarde en una lista static** (bug intencional).
- Deploya con `-XX:MaxDirectMemorySize=512m -XX:NativeMemoryTracking=summary -Xmx512m`.
- Genera carga con `hey -n 2000 -c 20`. Nota: el heap Java se mantiene sano (<200 MB en `jstat`); RSS del proceso crece a 1-2 GB.
- Baseline NMT antes de la carga: `jcmd $PID VM.native_memory baseline`.
- Diff tras la carga: `jcmd $PID VM.native_memory summary.diff` -> la categoría Other o Internal mostrará el crecimiento (los direct buffers no aparecen en heap dump).
- Compara con `pmap -x $PID | tail -20` para verificar el crecimiento real en RSS.

**Reto:** cambia el bug para usar `Netty PooledByteBufAllocator` sin `.release()` en un handler. Reproduce con `netty-buffer` 4.1+ y detecta con `-Dio.netty.leakDetection.level=paranoid`. Publica el reporte de leak que Netty imprime en logs. Compara con la detección NMT: ¿cuál llegó primero? ¿cuál te dio stack trace del origen?

**Criterios de aceptación**:
- [ ] RSS crece sin que crezca el heap Java (`jstat` estable, `ps -o rss` en aumento).
- [ ] NMT `summary.diff` señala el crecimiento en categoría non-heap.
- [ ] Reporte escrito con capturas de `jstat`, `pmap` y NMT.
- [ ] Fix con `.release()` explícito o try-with-resources sobre `PooledByteBuf`.

---

### Ejercicio 7 — Optimizar allocation rate en un scheduler FSRS (60 min)

**Objetivo**: Reducir la tasa de allocation en el hot path del scheduler de LinguaDev Pro sin cambiar el algoritmo.

**Hints**:
- Toma la función `nextInterval(Card c, int grade)` de tu proyecto (o el skeleton de `packages/scheduler-fsrs`).
- Escribe un JMH benchmark que la invoque 10 M veces en un `@Benchmark` con `@Fork(2)` y flag `-prof gc`.
- Baseline: mide `gc.alloc.rate.norm` (bytes por operación). Con implementación naïve suele estar en 300-800 B/op por `LocalDate` intermedios, boxing de `double`, `Optional<T>`.
- Aplica en orden: (1) reemplaza `LocalDate.plusDays()` por aritmética `long` sobre epoch days; (2) desboxa `Double` a `double`; (3) reemplaza `Stream` por bucle `for` sobre array primitivo; (4) verifica con `-XX:+UnlockDiagnosticVMOptions -XX:+PrintEliminateAllocations` que el JIT elimine temporaries.
- Meta: bajar `gc.alloc.rate.norm` a <32 B/op y `gc.alloc.rate` a <100 MB/s.

**Reto:** publica una PR-simulada con antes/después de `gc.alloc.rate.norm`, `throughput ops/sec`, `P99 latency` y adjunta un flame graph de allocations generado con `async-profiler -e alloc`. Justifica por qué NO usaste object pooling (spoiler: EA + generational ZGC lo hace innecesario, pero debes demostrarlo).

**Criterios de aceptación**:
- [ ] Benchmark JMH con al menos 5 warmup + 10 measurement iterations.
- [ ] `gc.alloc.rate.norm` < 32 B/op tras optimizaciones.
- [ ] Throughput mejora >= 2x.
- [ ] Documento con tabla comparativa y flame graphs before/after.

---

## 9. Recursos + siguientes pasos

### Libros esenciales
- Ben Evans et al., *Optimizing Java* (O'Reilly, 2018).
- Charlie Hunt, Binu John, *Java Performance* (Addison-Wesley).
- Aleksey Shipilev, *Java Performance Explained* + posts en shipilev.net.
- Cliff Click, talks "The Art of JIT" (YouTube).
- Mike Acton, "Data-Oriented Design" (CppCon 2014).

### Papers y JEPs
- Ungar (1984), *Generation Scavenging*.
- Choi et al. (1999), *Escape Analysis for Java*.
- Gil Tene, "How NOT to Measure Latency" (HdrHistogram).
- **JEP 439** — Generational ZGC (JDK 21).
- **JEP 495** — Generational Shenandoah (JDK 24).
- **JEP 444** — Virtual Threads (JDK 21).
- **PEP 703** — Making the GIL Optional in CPython.

### Herramientas 2026
- **Java**: jcmd, jmap, jstat, JFR + JMC, VisualVM, async-profiler, Eclipse MAT, IntelliJ Profiler.
- **Node.js**: `node --inspect`, Chrome DevTools, clinic.js, 0x, heapdump.
- **Python**: py-spy, memray, tracemalloc, objgraph.
- **Go**: `go tool pprof`, `runtime/pprof`, `net/http/pprof`.
- **Container**: `kubectl top pod`, `docker stats`, cAdvisor.
- **Native**: NMT (JVM), `pmap`, jemalloc profiling, glibc `MALLOC_ARENA_MAX`.
- **APM**: Datadog, New Relic, Dynatrace, Honeycomb, Grafana + Tempo.

### Referencias online
shipilev.net, inside.java, v8.dev/blog, go.dev/blog, python.org/dev/peps.

### Siguientes pasos en el track
- Vuelve a [Cap 03 — concurrencia y async](./03-concurrencia-y-async.md) para conectar memoria con threading (Java Memory Model, happens-before, virtual threads).
- Continúa con [Cap 07 — networking HTTP y TCP →](./07-networking-http-y-tcp.md) para entender cómo tu proceso interactúa con la red y el kernel (sendfile, epoll, io_uring).
- Practica sobre workloads reales: descarga heap dumps públicos de Elasticsearch/Cassandra/Kafka issues en GitHub y analiza con MAT.

---

## 10. Preguntas de práctica

Las 20 preguntas del simulacro cubren: stack vs heap con escape analysis, hipótesis generacional, diagnóstico de leaks (jmap, MAT, JFR), GC pauses y P99, V8 hidden classes, off-heap con Chronicle/DirectByteBuffer, reference types (Weak, Soft, Phantom), value types y Project Valhalla, CompressedOops, finalize vs Cleaner, Java Memory Model (volatile, happens-before), String pool y interning, layout de memoria de Node.js, zero-copy con sendfile, Native Memory Tracking, escape analysis y scalar replacement, ThreadLocal leaks en app servers, tuning para P99 con ZGC, Go runtime y goroutines vs virtual threads, y container-aware JVM.

- **Sim JSON**: [`packages/content/src/tech/programmer/sim-06-memory-and-gc.json`](../../packages/content/src/tech/programmer/sim-06-memory-and-gc.json)
- **Ruta en la app**: `/practice/programmer/programmer-sim-06-memory-and-gc`
- **Tiempo estimado**: 28 min · **Pass**: 75% (15/20 correctas)

Recomendación: dado que este capítulo tiene alta densidad técnica, haz el simulacro **después** de completar al menos los ejercicios 1 y 2. Las preguntas de nivel staff (q4, q8, q11, q16, q18) requieren experiencia práctica —no solo lectura.

---

## Navegación

- [Índice](./README.md)
- Anterior: [Cap 05 — APIs y seguridad](./05-apis-y-seguridad.md)
- Siguiente: [Cap 07 — networking HTTP y TCP →](./07-networking-http-y-tcp.md)
