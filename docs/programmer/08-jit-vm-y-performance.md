# Capítulo 08 — JIT, VM y performance

> **Focus:** Por qué un programa Java arranca lento y luego vuela; cómo funcionan bytecode → JIT tiered → machine code; inlining, escape analysis y deopt; cache locality, branch prediction, false sharing, SIMD, ILP; benchmarking correcto; flame graphs; GraalVM Native Image; WebAssembly; Python 3.13 JIT.
> **Áreas:** Compilers · Runtime · CPU internals · Perf engineering.
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%.
> **Nivel:** Junior → Mid → Senior → Staff.

## 0. Antes de empezar

**Pre-requisitos:**
- Nociones básicas de compilador (parser, AST, backend).
- Comprensión de threads y memoria (ver [Cap 06 — memoria y GC](./06-memoria-y-gc.md)).
- Familiaridad con al menos un lenguaje con VM (Java, JS/V8, Python, .NET).
- Ideal: haber leído [Cap 07 — Networking](./07-networking-http-y-tcp.md) para contexto de cold starts.

**Glosario mínimo:**
- **Bytecode**: representación intermedia portable (`.class`, `.pyc`, `.wasm`) que la VM interpreta o compila.
- **AOT** (Ahead-of-Time): compilación a machine code antes de correr (C, Rust, GraalVM Native Image).
- **JIT** (Just-in-Time): compilación en tiempo de ejecución basada en profile real (HotSpot C1/C2, V8 TurboFan).
- **Tiered compilation**: pipeline de niveles (interpreter → C1 → C2/Graal) que aplica más optimización según hot-ness.
- **Deoptimization**: revertir código JIT a intérprete cuando una suposición especulativa falla.
- **Inlining**: sustituir una call por el cuerpo del callee para eliminar overhead.
- **Escape analysis**: análisis que decide si un objeto puede vivir en el stack (o desaparecer) en vez del heap.
- **ILP** (Instruction-Level Parallelism): el CPU ejecuta varias instrucciones simultáneamente en un core.
- **SIMD**: Single Instruction Multiple Data (SSE, AVX2, AVX-512, NEON, SVE).
- **PGO** (Profile-Guided Optimization): optimización estática guiada por profile de ejecuciones previas.
- **Flame graph**: visualización jerárquica de stacks agregados de un profiler (Brendan Gregg, 2011).

**Setup mínimo:**

```bash
# Java: JDK 21 LTS o superior (JDK 25 disponible en 2026)
sdk install java 21.0.4-tem   # SDKMAN
sdk install java 25-graalce   # GraalVM CE 25.x

# Benchmarking Java
git clone https://github.com/openjdk/jmh
# o vía Maven en tu pom.xml

# Python: 3.13+ con JIT experimental (build --enable-experimental-jit)
pyenv install 3.13.5t         # variante free-threaded
pyenv install 3.14.0          # free-threading estable (PEP 779)

# Profiling y flame graphs (Linux)
sudo apt install linux-tools-common linux-perf-$(uname -r) inkscape
git clone https://github.com/brendangregg/FlameGraph.git

# async-profiler (JVM, low-overhead, wall/cpu/alloc)
wget https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz
tar xf async-profiler-3.0-linux-x64.tar.gz

# hyperfine (microbench de CLI)
brew install hyperfine
```

En Windows: usa WSL2 para `perf` y `async-profiler`; JDK y Python funcionan nativo.

---

## 1. El gran cuadro

Ejecutar código sobre un chip moderno pasa por más capas de las que la mayoría de developers imagina. Un `for` de Java atraviesa: **fuente → bytecode (`javac`) → intérprete → C1 → C2/Graal → machine code x86/ARM → micro-ops del CPU → pipeline → cache → RAM**. Cada capa hace suposiciones que puede revertir. Un programa Python 3.13 con JIT experimental sigue un pipeline similar: **AST → bytecode → adaptive interpreter → JIT copy-and-patch → x86/ARM**. Un programa Rust va **fuente → LLVM IR → assembly → machine code** en tiempo de build, sin capa de runtime dinámico, pero paga en tiempo de compilación y en falta de optimizaciones de perfil real.

El segundo eje es el **contraste JIT vs AOT**. JIT gana cuando el workload es de larga vida y el profile real difiere del asumido en compile-time: HotSpot C2 puede inlinear métodos virtuales monomorficamente, aplanar exceptions raras a fast-path y devirtualizar. AOT gana en **cold start** y **memoria** (no hay que interpretar, no hay que compilar, no hay tabla de métodos): un microservicio GraalVM Native Image arranca en <100 ms y consume 30-50 MB, versus 3-8 s y 300-800 MB de la misma app en HotSpot. En 2026, GraalVM CE va por 25.1.3 (junio 2026), con imágenes Hello World de ~6.5 MB gracias a intrinsification del `String.format` y PIE por default.

El tercer factor es la **realidad del CPU**. Un core moderno (Intel Golden Cove, AMD Zen 5, Apple Firestorm, ARM Neoverse V2) es superscalar (4-8 instrucciones por ciclo), out-of-order, con branch prediction (>95% accuracy en código bien diseñado), cachés L1/L2/L3 con latencias de 4/12/40 ciclos y RAM a 200-400 ciclos. El determinante de tu performance no es "¿cuántas ops hace mi loop?" sino "¿mi loop mantiene el pipeline lleno, respeta la cache y evita fallos de branch prediction?". Un array iterado por filas es 10× más rápido que iterado por columnas por locality; un contador `long[]` con posiciones espaciadas escala linealmente donde uno con posiciones contiguas sufre false sharing y no escala.

El cuarto vector es **Python y WebAssembly como emergentes**. Python 3.13 introdujo un JIT copy-and-patch experimental (opcional en build) y un modo free-threaded que retira el GIL (aún experimental en 3.13, oficial en 3.14 con PEP 779, 2026). WebAssembly consolida el rol de "bytecode portable seguro con AOT" para browsers y edge compute (Cloudflare Workers, Fastly Compute@Edge, Bytecode Alliance). Ambos redefinen qué significa "lenguaje interpretado" en 2026.

Este capítulo cubre cómo la JVM y V8 optimizan hot code, por qué el CPU dicta más que el algoritmo cuando el algoritmo ya es correcto, cómo benchmarkear sin engañarse (JMH, `pytest-benchmark`, hyperfine) y cómo leer un flame graph. Termina con ejercicios aplicados a **LinguaDev Pro**, donde el backend Lambda tiene cold-starts sensibles y el motor FSRS local en el PWA compite por tiempo de UI thread.

---

## 2. Bytecode, intérprete y JIT (nivel básico)

### 2.1 De fuente a bytecode

`javac Foo.java` produce `Foo.class`, un blob binario portable con constant pool, tabla de métodos y **bytecode** (instrucciones de una máquina de stack: `iload_0`, `iadd`, `invokevirtual`). Node.js hace lo mismo con V8: parser → AST → bytecode Ignition. Python compila a bytecode CPython (`.pyc` en `__pycache__/`). .NET compila a CIL.

Ver el bytecode Java:

```bash
javac Sum.java
javap -c Sum
```

```java
// Sum.java
public class Sum {
    public static int sum(int[] a) {
        int s = 0;
        for (int i = 0; i < a.length; i++) s += a[i];
        return s;
    }
    public static void main(String[] args) {
        int[] a = new int[1_000_000];
        for (int i = 0; i < a.length; i++) a[i] = i;
        System.out.println(sum(a));
    }
}
```

El bytecode que produce `javap -c Sum` muestra una máquina de pila: `iload`, `iaload`, `iadd`, `istore`. No hay optimizaciones aún.

### 2.2 Intérprete y warmup

Cuando la JVM arranca, ejecuta bytecode **interpretado**. Es lento (~100× más que código nativo) pero baratísimo de arrancar. Simultáneamente, la JVM **profila** cada método: cuántas veces se llama, qué branches se toman, qué tipos entran a los polimorfismos, qué exceptions se lanzan.

Cuando un método supera el umbral de "hot" (default HotSpot: 10 000 invocaciones o 15 000 iteraciones de loop back-edges), pasa al **compilador C1** ("client", rápido pero optimizaciones baratas). Si sigue caliente, se recompila con **C2** ("server", agresivo, minutos de análisis en microsegundos por método): inlining, escape analysis, loop unrolling, vectorización.

Este pipeline es **tiered compilation** (JEP 197):
- **Tier 0**: intérprete.
- **Tier 1**: C1 sin profile.
- **Tier 2**: C1 con contadores básicos.
- **Tier 3**: C1 con full profile (por si C2 no está listo).
- **Tier 4**: C2 (o Graal, si `-XX:+UseJVMCICompiler`).

En apps normales verás: primeras 1 000 llamadas ~500 ns cada una (interpretado), 100 k siguientes ~50 ns (C1), 1 M siguientes ~15 ns (C2 completo). Es warmup real.

### 2.3 Escape analysis y inlining

**Inlining**: si `foo()` llama a `bar()` con cuerpo pequeño, C2 sustituye la call por el cuerpo. Elimina el overhead de call/ret, permite optimizaciones cruzadas (constant folding entre callee y caller), abre paso a devirtualización.

Heurísticas HotSpot: métodos <35 bytes se inlinean casi siempre; hot methods hasta ~325 bytes; `@ForceInline` (interno) fuerza en JDK internals. `-XX:+PrintInlining` los muestra.

**Escape analysis**: si un objeto no escapa fuera del método (no se guarda en campo, no se retorna, no se pasa a otra thread), puede vivir en la stack (o desaparecer completo). Ejemplo:

```java
// Iterator sobre lista pequeña
public int sumFirst(List<Integer> list) {
    int s = 0;
    for (Integer x : list) s += x;
    return s;
}
```

El iterador es un objeto que en teoría se aloja en el heap. Con escape analysis, C2 detecta que no escapa y lo elimina completo (o lo hace stack-allocated). Beneficio: cero GC pressure, cero cache miss del heap.

### 2.4 Deoptimización

C2 hace optimizaciones **especulativas**: asume que la clase concreta que llega a un `invokevirtual` es siempre `String`, o que un branch no se toma nunca. Si ejecutando pasa la asunción falsa (llega otro tipo, se toma el branch), la JVM **deoptimiza**: descarta el código C2, retrocede al intérprete/C1, colecta nuevo profile y eventualmente recompila.

Síntomas en producción: P99 spikes de 100 ms sin GC logs correspondientes. Debug con:

```
-XX:+UnlockDiagnosticVMOptions -XX:+LogCompilation -XX:LogFile=/tmp/hotspot.log
# analiza con jitwatch
```

Anti-patrón que causa deopt: código híper-polimórfico donde 30 clases llegan al mismo `invokevirtual`. HotSpot deoptimiza porque su inline cache monomórfico se rompe. Fix: refactor a menos tipos, o usar `sealed` classes (JDK 17+) que permiten optimizaciones basadas en closed-world.

---

## 3. El CPU importa: cache, branch, ILP, SIMD (nivel medio)

### 3.1 Jerarquía de memoria

Latencias típicas en un core moderno (nanosegundos aproximados):

| Nivel | Tamaño | Latency | En ciclos @3 GHz |
|---|---|---|---|
| Registro | 32-64 | 0.3 ns | 1 |
| L1 data | 32-48 KB | 1 ns | 3-4 |
| L2 | 256 KB - 1 MB | 3-5 ns | 12 |
| L3 | 8-64 MB | 12-20 ns | 40 |
| DRAM | GB | 80-120 ns | 250-400 |
| SSD NVMe | TB | 50-100 μs | ~200 000 |
| HDD | TB | 5-10 ms | ~20 000 000 |

Un algoritmo "óptimo" en Big-O que trashea la cache pierde a uno "peor" que respeta locality. Ejemplo canónico: iterar array 2D `a[i][j]`. Java lo almacena por filas (row-major). Iterar `for i, for j, a[i][j]++` accede posiciones contiguas → cache hit. Iterar `for j, for i, a[i][j]++` salta N words entre accesos → cache miss constante → 10× más lento con N=1000.

### 3.2 Branch prediction

El pipeline del CPU (~15-20 stages) tiene que "adivinar" el resultado de un `if` antes de ejecutarlo. Si acierta, ejecuta continuo. Si falla, el pipeline se vacía (10-20 ciclos perdidos por miss).

El ejemplo célebre de Stack Overflow:

```java
// El famoso caso "sorted vs unsorted"
int[] arr = new int[32_768];
for (int i = 0; i < arr.length; i++) arr[i] = new java.util.Random().nextInt(256);
// Arrays.sort(arr);  // <-- descomentar para 6× speedup

long start = System.nanoTime();
long sum = 0;
for (int iter = 0; iter < 100_000; iter++)
    for (int i = 0; i < arr.length; i++)
        if (arr[i] >= 128) sum += arr[i];
System.out.printf("time=%.3fs sum=%d%n",
    (System.nanoTime() - start) / 1e9, sum);
```

Sin ordenar, el branch `arr[i] >= 128` es 50/50, el predictor falla la mitad de las veces. Ordenado, el predictor aprende "primero todos <128, luego todos ≥128" y acierta ~100%.

Consecuencia práctica: en hot loops, code sin branches (o con branches predecibles) gana. Técnicas: **branchless code** con máscaras, `Math.max/min` en vez de if-else, tables lookups.

### 3.3 Instruction-Level Parallelism

Un core moderno decodifica 4-8 instrucciones por ciclo y las ejecuta en múltiples pipelines (ALU, LSU, branch). Si las instrucciones son independientes, corren en paralelo. Si dependen (`b = a+1; c = b+1;`), se serializan.

Los compiladores rompen dependencias con **loop unrolling** y **múltiples acumuladores**:

```c
// unroll.c   compilar con gcc -O2
long sum_naive(int *a, int n) {
    long s = 0;
    for (int i = 0; i < n; i++) s += a[i];
    return s;
}
// Compilador unrolla + usa varios acumuladores para ILP
long sum_ilp(int *a, int n) {
    long s0=0, s1=0, s2=0, s3=0;
    int i;
    for (i = 0; i + 4 <= n; i += 4) {
        s0 += a[i];
        s1 += a[i+1];
        s2 += a[i+2];
        s3 += a[i+3];
    }
    long s = s0 + s1 + s2 + s3;
    for (; i < n; i++) s += a[i];
    return s;
}
```

Ambos suman lo mismo, pero `sum_ilp` deja el pipeline lleno. Con `-O2`/`-O3`, `gcc` y `clang` a menudo hacen esta transformación por ti; con `-O0` no.

### 3.4 SIMD: procesar N cosas por instrucción

SSE2 (128-bit), AVX2 (256-bit), AVX-512 (512-bit) permiten operar N enteros o floats en un solo ciclo. AVX-512 con `int32` = 16 elementos por instrucción. En ARM: NEON (128-bit), SVE (variable-length).

Ejemplo en C con intrinsics:

```c
// simd_sum.c   gcc -O3 -mavx2 simd_sum.c
#include <immintrin.h>
#include <stdio.h>

int sum_avx2(const int *a, int n) {
    __m256i vsum = _mm256_setzero_si256();
    int i;
    for (i = 0; i + 8 <= n; i += 8) {
        __m256i v = _mm256_loadu_si256((__m256i*)(a + i));
        vsum = _mm256_add_epi32(vsum, v);
    }
    int tmp[8];
    _mm256_storeu_si256((__m256i*)tmp, vsum);
    int s = 0;
    for (int j = 0; j < 8; j++) s += tmp[j];
    for (; i < n; i++) s += a[i];
    return s;
}
```

Java tiene **Vector API** (JEP 448, incubadora en JDK 21+; en JDK 25 sigue en incubator, con progresos hacia stable):

```java
// VectorSum.java   requiere --add-modules jdk.incubator.vector
import jdk.incubator.vector.IntVector;
import jdk.incubator.vector.VectorSpecies;

public class VectorSum {
    static final VectorSpecies<Integer> S = IntVector.SPECIES_PREFERRED;

    public static int sum(int[] a) {
        int i = 0;
        int bound = S.loopBound(a.length);
        IntVector acc = IntVector.zero(S);
        for (; i < bound; i += S.length()) {
            acc = acc.add(IntVector.fromArray(S, a, i));
        }
        int s = acc.reduceLanes(jdk.incubator.vector.VectorOperators.ADD);
        for (; i < a.length; i++) s += a[i];
        return s;
    }
}
```

C2 también vectoriza automáticamente muchos loops simples (**auto-vectorization**), pero Vector API te da control explícito y portable.

### 3.5 False sharing

Cuando dos threads escriben a variables distintas que caen en la misma **cache line** (64 bytes en x86, 128 en Apple Silicon), la coherencia de cache MESI invalida la línea entera constantemente. Resultado: scaling nulo pese a no compartir variables lógicamente.

Reproducción clásica en Java:

```java
// FalseSharing.java
public class FalseSharing implements Runnable {
    // Sin padding: los 8 longs caen en 1-2 cache lines
    static long[] counters = new long[8];

    // Con padding: separación de 8 longs (64 bytes) entre datos útiles
    // static long[] counters = new long[8 * 8];

    final int id;
    FalseSharing(int id) { this.id = id; }

    @Override public void run() {
        for (long i = 0; i < 500_000_000L; i++) {
            counters[id /* * 8 */]++;   // añadir *8 con padding
        }
    }

    public static void main(String[] a) throws Exception {
        int n = 8;
        Thread[] ts = new Thread[n];
        long t0 = System.nanoTime();
        for (int i = 0; i < n; i++) ts[i] = new Thread(new FalseSharing(i));
        for (var t : ts) t.start();
        for (var t : ts) t.join();
        System.out.printf("%.2f s%n", (System.nanoTime() - t0) / 1e9);
    }
}
```

Sin padding, 8 threads tardan casi lo mismo que 1 (contienden por cache line). Con padding (`*8`), escala linealmente.

Java 8+ tiene `@Contended` (JDK internal, requiere `-XX:-RestrictContended`) que añade padding automático. Rust: `crossbeam::utils::CachePadded<T>`. C#: `[StructLayout(LayoutKind.Explicit, Size=...)]`.

---

## 4. Benchmarking correcto (nivel medio-senior)

### 4.1 Por qué `System.currentTimeMillis()` mienta

Errores clásicos que arruinan un microbenchmark:
- No calentar el JIT (mides interpretación).
- Reusar el mismo input (JIT constantifica).
- Ignorar dead-code elimination (el compilador borra tu cálculo si no lo usas).
- No usar `System.nanoTime()` sino wall clock (afectado por NTP).
- Un solo run (varianza no cuantificada).
- GC no controlado durante la ventana medida.

### 4.2 JMH: el estándar Java

**JMH** (Java Microbenchmark Harness) es el framework oficial de OpenJDK. Se encarga de warmup, fork por run (evita profile pollution), dead-code sink (`Blackhole`), state per-thread, y calcula percentiles.

```java
// SumBench.java   requiere jmh-core y annotation processor
import org.openjdk.jmh.annotations.*;
import org.openjdk.jmh.infra.Blackhole;
import java.util.concurrent.TimeUnit;

@State(Scope.Benchmark)
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 10, time = 1)
@Fork(value = 2, jvmArgsAppend = {"-XX:+UseZGC"})
public class SumBench {

    @Param({"1024", "1000000"})
    int n;

    int[] arr;

    @Setup(Level.Trial)
    public void setup() {
        arr = new int[n];
        java.util.Random r = new java.util.Random(42);
        for (int i = 0; i < n; i++) arr[i] = r.nextInt();
    }

    @Benchmark
    public int naive() {
        int s = 0;
        for (int i = 0; i < arr.length; i++) s += arr[i];
        return s;   // devuelto = Blackhole implícito
    }

    @Benchmark
    public void naiveBH(Blackhole bh) {
        int s = 0;
        for (int i = 0; i < arr.length; i++) s += arr[i];
        bh.consume(s);
    }
}
```

Ejecutar: `mvn clean package && java -jar target/benchmarks.jar SumBench`. Salida incluye media, error, percentiles.

### 4.3 `pytest-benchmark` para Python

```python
# test_sum.py    pytest --benchmark-only
import numpy as np

def sum_python(a):
    s = 0
    for x in a:
        s += x
    return s

def sum_numpy(a):
    return int(a.sum())

def test_python(benchmark):
    a = list(range(1_000_000))
    benchmark(sum_python, a)

def test_numpy(benchmark):
    a = np.arange(1_000_000, dtype=np.int64)
    benchmark(sum_numpy, a)
```

`pytest-benchmark` reporta media, stddev, min/max, ops/s. En Python 3.13 con JIT experimental (build `--enable-experimental-jit`), verás mejoras de 10-30% en loops CPython puros; con NumPy la diferencia es marginal porque ya está en C.

### 4.4 `hyperfine` para CLI

```bash
# Compara AOT vs JIT para el mismo binario
hyperfine --warmup 3 \
  'java -jar app.jar' \
  './app-native' \
  --export-json result.json
```

Excelente para cold-start comparisons.

### 4.5 Flame graphs

Un flame graph agrega muestras de stacks: el ancho de cada frame representa el % del CPU (o wallclock) gastado. Lees de abajo (main) hacia arriba (funciones hot).

Con `async-profiler`:

```bash
# Attach por PID
./asprof -d 30 -f flame.html <pid>
# CPU + allocation
./asprof -d 30 -e cpu,alloc -f flame.html <pid>
# Wall-clock (para debuguear I/O bound)
./asprof -d 30 -e wall -f flame.html <pid>
```

Con `perf` + FlameGraph:

```bash
sudo perf record -F 99 -g -p <pid> -- sleep 30
sudo perf script | ./FlameGraph/stackcollapse-perf.pl | ./FlameGraph/flamegraph.pl > flame.svg
```

Modos:
- **CPU flame graph**: dónde se quema CPU (bound-CPU).
- **Alloc flame graph**: dónde se alocan objetos (GC pressure).
- **Lock/monitor flame graph**: dónde hay contención.
- **Wall-clock flame graph**: dónde se pasa el tiempo real (I/O, locks, GC).

Los tres tipos te dicen cosas distintas. Un servicio "lento" puede ser I/O-bound (CPU al 5%): el CPU flame graph engaña; el wall-clock lo revela.

---

## 5. GraalVM, AOT y cold start (nivel senior)

### 5.1 El problema del cold start

Un microservicio Spring Boot típico tarda 3-8 s en arrancar: cargar clases, inicializar el context, ejecutar `@PostConstruct`, calentar el JIT. Consume 300-800 MB de heap.

En AWS Lambda, cada cold start bloquea al primer usuario. Con provisioned concurrency es caro. En K8s con autoscaling agresivo, el tiempo entre "pod pedido" y "pod recibe tráfico" limita cuán rápido reaccionas a picos.

Mitigaciones dentro de JVM:
- **CDS** (Class Data Sharing) / **AppCDS**: precomputar y compartir metadata de clases. Reduce startup ~30-50%.
- **JEP 483 Ahead-of-Time Class Loading & Linking** (JDK 24+, 2025): promocionado dentro de HotSpot.
- **Layered classloading** cuidado.
- **Lazy initialization** del framework (Spring Boot 3 mejoró mucho).

### 5.2 GraalVM Native Image

**GraalVM** (Oracle Labs desde 2013) tiene dos productos clave:
- **Graal compiler**: reemplazo escrito en Java para C2 (opt-in JVM via `-XX:+UseJVMCICompiler`). En algunos workloads bate a C2, en otros pierde; es una pista de que C2 tiene 15 años pero sigue sólido.
- **Native Image**: AOT que produce ejecutables nativos. El programa se analiza con **closed-world assumption**: se calculan todas las clases posibles, se elimina lo no reachable. Resultado: binario auto-contenido, sin JIT, sin metadata dinámica.

**Estado 2026** (verificado): GraalVM CE 25.1.3 (junio 2026), Native Image en LTS, imagen Hello World reducida a ~6.5 MB, Position Independent Executables (PIE) por default en Linux, soporte para recording/replay de compilaciones JIT.

Trade-offs Native Image:
- ✅ Cold start ~50-100 ms.
- ✅ RAM ~30-80 MB.
- ✅ Menos superficie de ataque (no clases dinámicas).
- ❌ Reflection, dynamic proxies, JNI, resource loading requieren **hints** (metadata JSON o `@ReflectionHint`).
- ❌ Build time enorme (2-15 min).
- ❌ Sin JIT: throughput en steady-state ~10-30% peor que HotSpot con C2 tibio.
- ❌ Menos observabilidad (no async-profiler nativo).

Frameworks amistosos: **Quarkus**, **Micronaut**, **Spring Boot 3+ con `-Pnative`**, **Helidon**. Estos generan hints automáticamente durante el build.

Ejemplo Quarkus:

```bash
# Crear proyecto con soporte native
mvn io.quarkus:quarkus-maven-plugin:create \
    -DprojectGroupId=app -DprojectArtifactId=fsrs-svc \
    -DclassName="app.CardResource" -Dpath="/cards"
cd fsrs-svc

# Build native
./mvnw package -Pnative -Dquarkus.native.container-build=true

# Corre
./target/fsrs-svc-1.0-runner
# Cold start ~30 ms, RSS ~40 MB
```

### 5.3 Cuándo migrar (y cuándo no)

**Migra a Native Image** si:
- Es una Lambda / Cloud Run / K8s con HPA agresivo.
- CLI o herramienta corta.
- La RAM es cost driver principal.
- El throughput steady-state importa menos que start-up.

**No migres** si:
- Servicio de larga vida con alto throughput donde ganas 10-30% con JIT.
- Reflection-heavy y frameworks no compatibles (algunos ORMs, mocking libraries).
- Team sin experiencia con debugging de imágenes nativas (harder).

### 5.4 WebAssembly como puente

**Wasm** (WebAssembly) es bytecode portable, seguro (sandbox), AOT-friendly. Nacido en browsers, hoy corre server-side (Fastly Compute@Edge, Cloudflare Workers, Fermyon Spin) y como plugin runtime (Envoy WASM filters, Redpanda plugins).

Ventajas: cold start ~1 ms, memoria ~1-5 MB, portable multi-arquitectura, sin filesystem por default. Ecosistema: `wasi-libc`, componente model (WIT), lenguajes que compilan a Wasm (Rust, C/C++, Go via TinyGo, AssemblyScript, Zig, Kotlin/Wasm).

Ejemplo Rust → Wasm:

```rust
// src/lib.rs
#[no_mangle]
pub extern "C" fn fib(n: i32) -> i32 {
    if n <= 1 { n } else { fib(n - 1) + fib(n - 2) }
}
```

```bash
cargo add wasm-bindgen   # opcional
rustup target add wasm32-wasi
cargo build --release --target wasm32-wasi
wasmtime target/wasm32-wasi/release/lib.wasm
```

En LinguaDev Pro, Wasm es candidato para portar funciones de FSRS al PWA (browser) y a Lambda (server) sin duplicar código.

### 5.5 Python 3.13 JIT y free-threading

Python 3.13 (octubre 2024) trajo dos experimentos radicales:
- **JIT copy-and-patch**: opt-in en build (`--enable-experimental-jit`). Genera templates precompilados y los "parcha" en runtime con constantes del bytecode. Speedup modesto (10-30%) en workloads CPU-bound puros.
- **Free-threaded** (`python3.13t`): build sin GIL. Threads pueden ejecutar Python code en paralelo. Costo: 10-40% single-thread regression, dependencies necesitan adaptarse. En 3.13 sigue experimental; **Python 3.14 (2026)** oficializó con PEP 779.

En 2026, tu Lambda LinguaDev Pro no lo usa por default en pyenv/uv builds; para probar CPU-bound seriamente conviene esperar a 3.14 con free-threading estable.

---

## 6. System calls, denormals y speculative execution (nivel senior/staff)

### 6.1 User space vs kernel space

Cada llamada al kernel (`read`, `write`, `send`, `recv`, `mmap`) cuesta un context switch (guardar registros, cambiar page tables, ejecutar handler, volver). Coste: 100-500 ns por syscall en x86, más en ARM.

Buffered I/O amortiza:

```java
// Sin buffer: 1 syscall por escritura
try (FileOutputStream fos = new FileOutputStream("out.log")) {
    for (int i = 0; i < 100_000; i++) fos.write(("line " + i + "\n").getBytes());
}

// Con buffer: 1 syscall por N escrituras
try (BufferedOutputStream bos = new BufferedOutputStream(new FileOutputStream("out.log"), 8192)) {
    for (int i = 0; i < 100_000; i++) bos.write(("line " + i + "\n").getBytes());
}
```

En loggers modernos (Log4j2 async, Logback async appender), el patrón es un ring buffer lock-free + un thread de escritura que hace grandes flushes.

Alternativas para reducir syscalls:
- `sendfile` (`man 2 sendfile`): copia file→socket sin pasar por user space.
- `mmap` (`man 2 mmap`): mapea file en memoria, accede como array.
- **io_uring** (Linux 5.1+): batch de I/O asíncronas con rings compartidos. Ver [Cap 09 §8](./09-async-patterns-profundo.md).

### 6.2 Denormalized floats

IEEE 754 tiene **denormalized numbers**: valores más pequeños que el mínimo normal (~1e-308 en `double`, ~1e-38 en `float`). Se representan con exponente cero y mantissa desnormalizada.

Ciertos CPUs manejan denormals en **microcódigo** (10-100× más lento). Un simulador de física con valores cercanos a cero puede sufrir 20× slowdown misterioso.

Fix: **flush-to-zero** en el registro de control del FPU. En Java (no expuesto directamente): usar `Math.max(x, MIN_NORMAL)`. En C:

```c
#include <xmmintrin.h>
_mm_setcsr(_mm_getcsr() | 0x8040);  // FTZ + DAZ
```

### 6.3 Spectre, Meltdown y su costo perpetuo

En 2018, Spectre (bounds check bypass via speculative execution) y Meltdown (kernel memory read desde userspace) forzaron parches profundos: KPTI (Kernel Page Table Isolation), retpolines para saltos indirectos, microcode updates. Costo típico: 5-30% de throughput en workloads syscall-heavy, negligible en compute-bound.

Impacto perpetuo: apps que hacían muchos syscalls (databases, filesystems) tuvieron regresiones sostenidas. En 2026 los kernels y CPUs modernos mitigan mejor, pero KPTI sigue on por default en el kernel Linux mainline.

### 6.4 Memory ordering: x86 vs ARM

Los CPUs modernos reordenan memory operations para maximizar throughput. x86 es **strong-ordered** (mostly ordered, algunas relajaciones). ARM/Apple Silicon/Graviton es **weak-ordered**: sin barreras explícitas, dos escrituras a variables distintas pueden reordenarse arbitrariamente vistas desde otro thread.

Bug clásico: código que funciona en x86 falla en ARM porque asume ordering que no existe. Fix: usar tipos con semántica clara.
- Java: `volatile`, `AtomicX`, `VarHandle` con `acquireRelease/opaque/plain`.
- C++: `std::atomic<T>` con `memory_order_*`.
- Rust: `std::sync::atomic::{AtomicX, Ordering}`.

Nunca dependas del "funciona en mi Intel" para código multi-threaded no sincronizado. AWS Graviton (ARM) es cada vez más común en producción; testea allí.

---

## 7. JVM tuning: cuándo hacerlo y cómo (nivel senior)

### 7.1 Tuning por default es un anti-patrón

JVM moderna (JDK 21+) tiene defaults sensatos. Copiar flags de un blog de 2015 (`-XX:+UseCMSInitiatingOccupancyOnly`, `-XX:CMSInitiatingOccupancyFraction=70`) empeora las cosas: **CMS fue eliminado en JDK 14**. G1 es el default desde JDK 9; ZGC y Shenandoah son opciones para latencia extrema.

### 7.2 Tuning informado

Antes de tocar flags:
1. Instrumenta: métricas de GC (jfr, `-Xlog:gc*`), CPU (async-profiler), allocation.
2. Identifica el problema real: ¿cold start? ¿P99 spikes por GC? ¿throughput bajo?
3. Aplica el flag específico. Verifica en A/B.

Flags que sí valen la pena:

```bash
# Heap explícito para hosts con memoria constrained (containers)
-Xmx2g -Xms2g

# GC:
-XX:+UseG1GC                 # default JDK 9+, general purpose
-XX:+UseZGC                  # low pause (<1 ms), heap grande
-XX:+UseShenandoahGC         # low pause, hemos vivido con él
-XX:MaxGCPauseMillis=200     # target G1

# Startup y cold start
-XX:+UnlockExperimentalVMOptions -XX:+UseEpsilonGC   # sólo para benchmarks
-XX:ArchiveClassesAtExit=app.jsa
-XX:SharedArchiveFile=app.jsa   # AppCDS
-XX:+AOTClassLoading            # JEP 483 en JDK 24+

# Observabilidad
-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/dumps
-Xlog:gc*:file=/var/log/gc.log:time,uptime:filecount=5,filesize=100M

# Compiler
-XX:+PrintCompilation                # ver JIT decidiendo
-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining
```

### 7.3 Container awareness

Desde JDK 10+ (backport a 8u191), la JVM lee cgroups y calcula heap por defecto como fracción de la memoria del container (`-XX:MaxRAMPercentage=75.0`). Configura explícitamente para evitar sorpresas.

```bash
docker run --memory=2g myapp:latest \
  -XX:MaxRAMPercentage=70 -XX:InitialRAMPercentage=70
```

---

## 8. Ejemplo integrado: profilear un endpoint FSRS de LinguaDev Pro

Escenario: el endpoint `POST /api/study/answer` en Lambda tarda 400 ms P99. Queremos bajarlo a <100 ms.

### 8.1 Instrumentar

```bash
# Local, con async-profiler adjunto al proceso de test
mvn -Dtest=StudyLoadTest test &
sleep 5
PID=$(pgrep -f StudyLoadTest)
./asprof -d 60 -e cpu -f cpu.html $PID
./asprof -d 60 -e alloc -f alloc.html $PID
./asprof -d 60 -e wall -f wall.html $PID
```

### 8.2 Leer el flame graph

Casos típicos:
- CPU flame ancho en `parseJson` → cambiar a `simd-json` o precompilar deserializador (Jackson afterburner).
- Alloc flame ancho en `String.format` → usar `StringBuilder` o `Formatter` reusable.
- Wall flame ancho en `sun.nio.Poll` → I/O bound, poner virtual threads o async.
- Lock flame en `ConcurrentHashMap$Node` con muchos threads → contención de bucket.

### 8.3 JMH aislado

Con el hot spot identificado, escribir un JMH para probar alternativas:

```java
// FsrsBench.java
@State(Scope.Benchmark)
@Fork(2)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 10, time = 1)
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
public class FsrsBench {

    private Card card;

    @Setup public void s() { card = Card.sample(); }

    @Benchmark
    public double schedulerV1() { return FsrsV1.nextInterval(card, 3); }

    @Benchmark
    public double schedulerV2() { return FsrsV2.nextInterval(card, 3); }
}
```

Si `V2` es 40% más rápido, el A/B en producción vale.

### 8.4 Cold start con Native Image

Cuando Lambda cold-start P99 sea el bottleneck, portar a Quarkus + Native Image:

```bash
./mvnw package -Pnative
# Deploy a Lambda (custom runtime OR AL2023)
sam deploy --template template.yaml
```

Métricas post-migración esperables: cold start 3.5 s → 90 ms; memoria de 512 MB configurada → 256 MB suficiente; billing baja proporcionalmente.

---

## 9. Cheatsheet, reglas y anti-patrones

### Reglas de oro

- ✅ **Deja calentar la JVM** en workloads long-lived; mide steady-state, no boot.
- ✅ **JMH** para microbenchmarks Java. `pytest-benchmark` en Python. `hyperfine` en CLI.
- ✅ **Flame graph** primero, hipótesis después.
- ✅ **Cache locality** > algoritmo mágico: iterar en row-major.
- ✅ **Branch predictable** en hot loops; sort si te ayuda.
- ✅ **False sharing eliminado** con padding o `@Contended` en variables per-thread.
- ✅ **Vector API o auto-vectorization** para números.
- ✅ **AppCDS / AOT class loading** para reducir cold start.
- ✅ **GraalVM Native Image** para Lambda, CLI, K8s con HPA agresivo.
- ✅ **Container awareness**: `-XX:MaxRAMPercentage`.
- ✅ **Métricas GC + async-profiler + wall-clock flames** en producción crítica.

### Anti-patrones

- ❌ Microbench con `System.currentTimeMillis()` en un `main`.
- ❌ Copiar 20 flags JVM de un blog viejo sin entender.
- ❌ Optimizar prematuramente sin flame graph.
- ❌ Uso híper-polimórfico que causa deopts constantes.
- ❌ Alocar en el hot path (usa pools/reuse).
- ❌ String concatenation en loops (usa StringBuilder o Java 21 String Templates).
- ❌ Boxing/unboxing en primitives críticos (usa arrays primitivos o Valhalla previews).
- ❌ Reflection en hot path.
- ❌ Threads OS por request (usa virtual threads o async).
- ❌ Escribir con FileOutputStream sin buffer.
- ❌ Ignorar diferencias x86 vs ARM en memory ordering.

### Tabla decisión: JIT vs AOT

| Caso | Recomendación |
|---|---|
| Microservicio HTTP long-lived, alto RPS | HotSpot + G1/ZGC |
| Lambda / Cloud Run con cold-start crítico | GraalVM Native Image |
| CLI tool que corre 200 ms | Native Image o Rust/Go |
| Data pipeline batch 30 min | HotSpot con warm-up rápido |
| Framework flexible con reflection pesada | HotSpot (Native rompe) |
| Plugin runtime seguro embed | WebAssembly |
| Notebook Python CPU-bound | Python 3.13 JIT experimental; considerar 3.14 free-threaded |

---

## 10. Ejercicios prácticos

### Ejercicio 1: reproducir el "sorted vs unsorted" y medir con JMH

**Objetivo:** experimentar el impacto de branch prediction.

**Setup:** JDK 21+, Maven con `jmh-core`.

**Pasos:**
1. Escribe `BranchBench` con dos benchmarks: `sorted()` y `unsorted()`, iterando 32 768 ints y sumando los ≥128.
2. En `@Setup(Level.Trial)` genera el array; en el `sorted()` aplica `Arrays.sort()`.
3. Corre con `mvn clean package && java -jar target/benchmarks.jar BranchBench`.
4. Anota el ratio.
5. Habilita `-XX:+PrintCompilation` y verifica que ambos entran a C2.

**Criterios de éxito:**
- [ ] `sorted` es al menos 4× más rápido que `unsorted`.
- [ ] Documentado media, error, y percentiles.
- [ ] Sin optimizaciones adicionales; sólo cambia el ordering del input.

**Bonus:** implementa versión branchless con máscara `s += (arr[i] - 128) >> 31 & 0 : arr[i]` y compara.

---

### Ejercicio 2: row-major vs column-major iteration

**Objetivo:** medir cache locality.

**Setup:** Java o C.

**Pasos:**
1. Crea `int[][] a = new int[2000][2000]`.
2. Benchmark A: `for (i) for (j) a[i][j]++;`.
3. Benchmark B: `for (j) for (i) a[i][j]++;`.
4. Corre con JMH; mide.
5. Repite con `int[][] a = new int[8][8]` (cabe en L1) — el efecto debe desaparecer.

**Criterios de éxito:**
- [ ] A es al menos 8× más rápido que B con matriz grande.
- [ ] La diferencia se colapsa con matriz que cabe en L1.
- [ ] Reporte documentado.

**Bonus:** repítelo en C con `perf stat -e L1-dcache-load-misses ./run` y verifica los misses.

---

### Ejercicio 3: false sharing con y sin padding

**Objetivo:** reproducir false sharing.

**Setup:** JDK 21+, 4+ cores físicos.

**Pasos:**
1. Copia `FalseSharing.java` de §3.5.
2. Corre con `counters = new long[8]` (sin padding). Anota tiempo.
3. Cambia a `counters = new long[8 * 8]` (padding). Cambia el index de `counters[id]` a `counters[id * 8]`. Anota tiempo.
4. Repite 5 veces y compara.

**Criterios de éxito:**
- [ ] Sin padding: escala < 2× con 8 threads.
- [ ] Con padding: escala > 6× con 8 threads.
- [ ] Reporte con las cifras.

**Bonus:** aplica `@jdk.internal.vm.annotation.Contended` con `-XX:-RestrictContended` y compara.

---

### Ejercicio 4: flame graph de un endpoint

**Objetivo:** identificar hot spot en un servicio.

**Setup:** un servicio HTTP (Fastify, Spring Boot, Quarkus) y `async-profiler` (para JVM) o `perf` + FlameGraph (para nativo).

**Pasos:**
1. Levanta el servicio y genera carga con `oha -z 60s -c 50 http://localhost:8080/api/cards/42`.
2. En paralelo, adjunta profiler: `./asprof -d 30 -e cpu -f cpu.html <pid>`.
3. Abre `cpu.html` en el browser.
4. Identifica el top-3 de funciones más anchas en la parte superior.
5. Repite con `-e wall` y compara.

**Criterios de éxito:**
- [ ] Genera CPU y wall-clock flame graphs.
- [ ] Documenta top-3 hot spots.
- [ ] Explica la diferencia entre ambos flame graphs (I/O vs CPU).

**Bonus:** genera un allocation flame graph (`-e alloc`) y detecta un `String.format` innecesario.

---

### Ejercicio 5: Native Image en LinguaDev Pro (Quarkus)

**Objetivo:** portar un microservicio Java a GraalVM Native Image y medir startup.

**Setup:** GraalVM CE 25.x, Docker o Podman.

**Pasos:**
1. Crea proyecto Quarkus con `mvn io.quarkus:quarkus-maven-plugin:create`.
2. Añade un `CardResource` con GET/POST.
3. Corre `./mvnw quarkus:dev` en JVM mode y mide startup.
4. Build native: `./mvnw package -Pnative -Dquarkus.native.container-build=true`.
5. Corre el binario nativo y mide startup.
6. Con `hyperfine`, compara: `hyperfine './target/xxx-runner' 'java -jar target/xxx-runner.jar'`.
7. Compara memoria residente (`ps -o rss` o `docker stats`).

**Criterios de éxito:**
- [ ] Native image builds sin errores.
- [ ] Startup nativo <200 ms.
- [ ] RSS <100 MB en steady state.
- [ ] Documento comparativo con cifras.

**Bonus:** despliega a AWS Lambda con custom runtime AL2023 y mide cold-start en la nube.

---

### Ejercicio 6 (bonus): activar Python 3.13 JIT y comparar

**Objetivo:** ver el efecto del JIT experimental en Python.

**Setup:** Linux o macOS; capacidad de compilar CPython.

**Pasos:**
1. Descarga source de Python 3.13.x.
2. Build con `./configure --enable-experimental-jit && make -j$(nproc)`.
3. Escribe un benchmark CPU-bound (fibonacci recursivo, sudoku solver).
4. `pytest-benchmark` con Python 3.13 estándar vs Python 3.13 con JIT.
5. Documenta el speedup.

**Criterios de éxito:**
- [ ] Build exitoso con JIT habilitado.
- [ ] Benchmark corre en ambos runtimes.
- [ ] Speedup medible (esperar 10-30% en Python puro CPU-bound).

**Bonus:** repite con Python 3.14 free-threaded (PEP 779) y mide multi-thread.

---

## 11. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas por dificultad junior → staff. Cubren: JIT vs AOT y por qué HotSpot puede vencer a C compilado; warmup y tiered compilation C1/C2; inlining y por qué Java no tiene `inline` explícito; deoptimization y P99 spikes sin GC; branch prediction en CPU y el ejemplo "sorted vs unsorted"; cache lines y row-major; false sharing y padding; SIMD y auto-vectorization; ILP con múltiples acumuladores; loop unrolling del compilador; CDS/AppCDS para arranque; memory ordering x86 vs ARM; V8 Ignition + TurboFan; tipos de profiling (CPU, alloc, lock, wall); denormals y flush-to-zero; syscall cost y buffering; GraalVM y polyglot; JVM tuning informado vs cargo cult; Spectre/Meltdown; y decisión AOT vs JIT para migrar.

- **Fuente:** [`packages/content/src/tech/programmer/sim-08-jit-vm-and-performance.json`](../../packages/content/src/tech/programmer/sim-08-jit-vm-and-performance.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-08-jit-vm-and-performance`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 07 — Networking, HTTP y TCP](./07-networking-http-y-tcp.md) · [Índice](./README.md) · [Capítulo 09 — Async patterns profundo →](./09-async-patterns-profundo.md)
