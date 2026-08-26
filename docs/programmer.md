# Programador — Fundamentos → Senior

Preguntas de práctica que cubren los fundamentos que TODO programador debería dominar antes de llamarse senior: complejidad, estructuras de datos, patrones, SOLID, concurrencia, testing, code smells, refactor. Cada pregunta parte de un escenario real (bug, decisión de diseño, code review) y explica por qué cada opción es correcta o un anti-patrón típico.

## Áreas cubiertas

- **Fundamentos** (`fundamentals`) — Complejidad, tipos, memoria, referencia vs valor.
- **Estructuras de datos** (`data-structures`) — Elección de estructura correcta según acceso/tamaño/mutabilidad.
- **Algoritmos** (`algorithms`) — Ordenamiento, búsqueda, recursión, greedy, DP básica.
- **OOP + SOLID** (`oop-solid`) — Principios de diseño OO, cohesión, acoplamiento.
- **Patrones de diseño** (`patterns`) — GoF, patrones de aplicación real, cuándo NO usarlos.
- **Concurrencia** (`concurrency`) — Threads, locks, async, race conditions, deadlocks.
- **Testing + calidad** (`testing`) — TDD, mocks vs stubs vs fakes, tests frágiles, cobertura.
- **Refactor + code smells** (`refactor`) — Long method, feature envy, primitive obsession, cambio incremental seguro.
- **APIs + protocolos** (`apis`) — REST, GraphQL, gRPC, idempotencia, versioning, error handling.
- **Seguridad** (`security`) — OWASP top 10, secretos, auth, hashing, injection, XSS/CSRF.

## Sims (15 total)

### Simulacro 01 — Fundamentos, complejidad y elección de estructura

- **Focus:** Complejidad temporal/espacial en escenarios reales, elección de estructura de datos según patrón de acceso, referencia vs valor y sus bugs típicos.
- **Áreas:** fundamentals, data-structures, algorithms
- **Preguntas:** 20
- **Tiempo:** 20 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Big-O básico — identificar complejidad
  - Stack vs Heap — dónde vive qué
  - Complejidad amortizada vs peor caso
  - Elección de estructura por patrón de acceso
  - Referencia vs valor — bug de mutación compartida
  - Elegir el algoritmo correcto (no siempre el más 'inteligente')
  - HashMap collision y cuando NO usarlo
  - LinkedList vs ArrayList — cuándo cada uno
  - Búsqueda binaria — condiciones y bugs típicos
  - HashMap vs TreeMap — cuándo cada uno
  - Recursión — memoization y complejidad
  - Floating point — errores típicos
  - Bloom Filter — cuándo y por qué
  - Two pointers / Sliding window — reconocer el patrón
  - Big-O de operaciones en estructuras stdlib
  - String algorithms — no reinventar
  - Union-Find (Disjoint Set Union)
  - Complejidad espacial — no solo tiempo
  - LRU Cache — diseño e implementación
  - Complejidad de operaciones distribuidas — factor red
- **JSON:** `packages/content/src/tech/programmer/sim-01-fundamentals-and-complexity.json`

### Simulacro 02 — SOLID, patrones y anti-patrones

- **Focus:** Aplicación real de SOLID en decisiones concretas de diseño, cuándo un patrón es útil y cuándo es sobre-ingeniería.
- **Áreas:** oop-solid, patterns, refactor
- **Preguntas:** 20
- **Tiempo:** 22 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Definición de encapsulamiento
  - Herencia vs composición
  - Single Responsibility Principle real
  - Cuándo NO usar un patrón (sobre-ingeniería)
  - Open/Closed Principle en la práctica
  - Liskov Substitution Principle — el ejemplo clásico
  - Interface Segregation Principle
  - Dependency Inversion en la práctica
  - Singleton — dolor y alternativas
  - Factory Method vs Abstract Factory
  - Observer vs Pub/Sub — matices
  - Decorator vs Herencia
  - Command Pattern y undo/redo
  - Repository vs Active Record
  - Strategy Pattern — real vs sobre-ingeniería
  - Law of Demeter — cadena de llamadas
  - Adapter vs Facade
  - Anti-patrón: God Object / God Class
  - CQRS — cuándo lo introducimos
  - Anti-patrón: Anemic Domain Model
- **JSON:** `packages/content/src/tech/programmer/sim-02-solid-and-patterns.json`

### Simulacro 03 — Concurrencia, async y race conditions

- **Focus:** Race conditions, deadlocks, async/await vs threads, idempotencia, atomicidad, uso correcto de estructuras concurrentes.
- **Áreas:** concurrency, fundamentals
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Diferencia entre concurrencia y paralelismo
  - GIL de Python — malentendidos
  - Race condition en 'check-then-act'
  - Async/await vs threads — modelo mental
  - Volatile vs synchronized en Java
  - Deadlock — diagnóstico
  - Livelock — el hermano olvidado del deadlock
  - Producer-Consumer y BlockingQueue
  - Immutability como estrategia de concurrencia
  - Thread pool sizing
  - ConcurrentHashMap vs HashMap synchronized
  - CompletableFuture — composición async
  - Idempotencia y at-least-once delivery
  - Optimistic locking vs Pessimistic locking
  - Cancelación cooperativa en Java
  - Backpressure en streams reactivos
  - Actor Model — cuándo aplicarlo
  - Memory model — reordering y happens-before
  - False sharing — bug de cache line
  - Distributed locks — Redlock y sus críticas
- **JSON:** `packages/content/src/tech/programmer/sim-03-concurrency-and-async.json`

### Simulacro 04 — Testing, refactor y code smells

- **Focus:** Tests que aportan valor real vs frágiles, TDD real, mocks vs stubs vs fakes, code smells, refactor seguro con red de tests.
- **Áreas:** testing, refactor
- **Preguntas:** 20
- **Tiempo:** 22 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Pirámide de tests — estructura sana
  - Mock vs Stub vs Fake
  - Tests frágiles vs tests robustos
  - Refactor seguro sobre código legacy
  - Code smells — primitive obsession
  - Test coverage — el KPI engañoso
  - TDD — Red/Green/Refactor real
  - Flaky tests — causas y fixes
  - Extract Method — el refactor más común
  - Rule of Three — extraer abstracción
  - Given-When-Then / AAA pattern
  - Feature Envy — método en el lugar equivocado
  - Contract tests y consumer-driven contracts
  - Property-based testing
  - Refactor de Long Method
  - Snapshot testing — cuándo sí y cuándo no
  - Strangler Fig Pattern
  - Test Data Builders y Object Mother
  - Deuda técnica — decisión estratégica
  - Chaos engineering — testear failure modes
- **JSON:** `packages/content/src/tech/programmer/sim-04-testing-and-refactor.json`

### Simulacro 05 — APIs, idempotencia y seguridad práctica

- **Focus:** Diseño de APIs REST/GraphQL, idempotencia, versioning, error handling y errores de seguridad frecuentes (OWASP).
- **Áreas:** apis, security
- **Preguntas:** 20
- **Tiempo:** 22 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - HTTP status codes — uso correcto
  - REST vs RPC vs GraphQL
  - Idempotencia — por qué importa
  - Password hashing — errores frecuentes
  - SQL Injection en 2026
  - API versioning — estrategias
  - JWT — usos correctos y errores
  - Pagination — cursor vs offset
  - CSRF — qué es y cómo prevenir
  - XSS — tipos y prevención
  - Rate limiting — algoritmos
  - REST — errores de diseño
  - Secrets management
  - OAuth 2.0 y OIDC — cuál para qué
  - Error responses — diseño consistente
  - CORS — configuración correcta
  - Webhooks — delivery guarantees
  - OWASP Top 10 — 2021/2025
  - Timeouts y circuit breakers
  - Supply chain security
- **JSON:** `packages/content/src/tech/programmer/sim-05-apis-and-security.json`

### Simulacro 06 — Memoria, garbage collection y tuning

- **Focus:** Stack vs heap, generacional GC, pause times, tuning JVM/V8, detección de leaks, escape analysis y off-heap.
- **Áreas:** fundamentals
- **Preguntas:** 20
- **Tiempo:** 28 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Stack vs Heap — modelo mental
  - Generacional GC — hipótesis generacional
  - Detección de memory leak en Java
  - GC pauses — Stop-The-World y latencia P99
  - V8 heap y hidden classes
  - Off-heap memory
  - Reference types — Weak, Soft, Phantom
  - Value types y layout de memoria
  - Compressed OOPs
  - Finalizers y Cleaners
  - Memory model — visibility y happens-before
  - String pool y interning
  - V8 heap y las 4 heaps de Node
  - Zero-copy y sendfile
  - Native Memory Tracking
  - Escape analysis y scalar replacement
  - ThreadLocal leaks en app servers
  - Latencia P99 y outliers de GC
  - Go runtime memory y goroutines
  - Container-aware JVM
- **JSON:** `packages/content/src/tech/programmer/sim-06-memory-and-gc.json`

### Simulacro 07 — Networking, HTTP/2/3 y TCP en profundidad

- **Focus:** HTTP/1.1 vs 2 vs 3, TCP handshake, TLS, keep-alive, connection pooling, HOL blocking, slow start, congestion control.
- **Áreas:** apis
- **Preguntas:** 20
- **Tiempo:** 28 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Handshake TCP + TLS — costo real
  - HTTP/2 multiplexing y HOL blocking
  - Connection pooling — sizing
  - Keep-alive y TIME_WAIT
  - TCP slow start y bandwidth-delay product
  - Cache-Control y validators
  - CORS preflight
  - gRPC vs REST vs GraphQL
  - Retries idempotentes y exponential backoff
  - WebSockets vs SSE vs long-polling
  - DNS resolution y latency
  - TLS 1.3 y forward secrecy
  - TCP Nagle vs delayed ACK
  - OSI vs TCP/IP y encapsulación
  - QUIC connection migration
  - Load balancing L4 vs L7
  - MTU, PMTUD y fragmentación
  - HTTP/2 header compression (HPACK)
  - gRPC deadlines vs timeouts
  - TCP congestion control moderno
- **JSON:** `packages/content/src/tech/programmer/sim-07-networking-http-and-tcp.json`

### Simulacro 08 — JIT, VMs y micro-arquitectura de performance

- **Focus:** JIT vs AOT, warmup, inlining, deoptimización, hot methods, branch prediction, cache lines, false sharing, mecánicas de CPU.
- **Áreas:** fundamentals
- **Preguntas:** 20
- **Tiempo:** 28 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - JIT vs AOT — el trade-off
  - Warmup y tiered compilation
  - Inlining — decisiones del JIT
  - Deoptimización — outliers de latency
  - Branch prediction en CPU
  - Cache lines y locality
  - False sharing
  - SIMD y vectorization
  - Instruction-level parallelism (ILP)
  - Loop unrolling y compiler
  - Class Data Sharing (CDS)
  - Memory ordering y CPU reordering
  - V8 Ignition + TurboFan pipeline
  - Profiling — CPU vs allocation vs lock
  - Denormalized numbers y floating point
  - System calls y kernel/user transitions
  - GraalVM y polyglot
  - JVM tuning — cuando hacerlo
  - Speculative execution y Spectre
  - AOT vs JIT — cuándo migrar
- **JSON:** `packages/content/src/tech/programmer/sim-08-jit-vm-and-performance.json`

### Simulacro 09 — Async avanzado, coroutines y structured concurrency

- **Focus:** Promise/Task/Future, structured concurrency, cancellation, backpressure, reactive streams, coroutines, virtual threads, sizing.
- **Áreas:** concurrency
- **Preguntas:** 20
- **Tiempo:** 28 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Future vs Promise vs Task
  - Structured concurrency
  - Virtual threads (Project Loom)
  - Cancellation cooperativa
  - Backpressure
  - Thread pool sizing
  - Race conditions y compare-and-swap
  - Kotlin coroutines vs threads
  - Event loop y single-threaded async
  - Actor model (Erlang, Akka)
  - CSP (Go channels)
  - Deadlock detection
  - Fork/Join framework
  - Reactive streams — Reactor / RxJava
  - Semaphore vs mutex vs condition
  - Immutability como estrategia
  - Async I/O — epoll, io_uring
  - Structured concurrency vs supervisors
  - Async pitfalls — thread starvation
  - Choice: threads vs async vs actors vs coroutines
- **JSON:** `packages/content/src/tech/programmer/sim-09-async-patterns-deep.json`

### Simulacro 10 — Manejo de errores y recuperación

- **Focus:** Exceptions vs error values, retries, dead-letter queues, saga compensation, defensive vs offensive programming, error boundaries — la línea entre un sistema que se cae y uno que degrada elegantemente.
- **Áreas:** apis, concurrency, patterns
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Fail fast vs Fail silently
  - Exception vs error values
  - Retry con exponential backoff
  - Idempotencia — la piedra angular de retries
  - Dead Letter Queues
  - Saga pattern — transacciones distribuidas
  - Circuit Breaker
  - Bulkhead pattern
  - Fallback y degradación elegante
  - Defensive vs Offensive programming
  - Error boundaries en React
  - Timeouts — el 99% de sistemas los pone mal
  - Panic recovery en Go
  - Poison message handling
  - Compensación vs rollback
  - Chaos Engineering — probar recovery
  - Timeouts en cascada
  - Retry loops que no convergen
  - Errores en background jobs
  - Postmortems blameless
- **JSON:** `packages/content/src/tech/programmer/sim-10-error-handling-and-recovery.json`

### Simulacro 11 — Bases de datos para developers (índices, EXPLAIN, aislamiento)

- **Focus:** Lo que un DEV (no un DBA) debe dominar de la DB relacional: cómo funcionan los índices por dentro, leer EXPLAIN, evitar N+1, connection pooling, niveles de aislamiento y patrones para dormir tranquilo.
- **Áreas:** apis, fundamentals
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - B-tree vs Hash vs GIN — cuándo cada uno
  - Leer EXPLAIN ANALYZE — señales de alarma
  - N+1 queries — detección y solución
  - Connection pooling — números correctos
  - Isolation levels — dirty read, non-repeatable read, phantom
  - Deadlocks — causa raíz típica
  - JSONB indexes — cuándo y cómo
  - Partial indexes — el índice más barato
  - Transacciones largas y el bloat de MVCC
  - Migraciones online sin lockeo largo
  - Serializable isolation en Postgres (SSI)
  - Paginación — keyset vs offset
  - SELECT FOR UPDATE — SKIP LOCKED en queues
  - Read replicas — consistencia y lag
  - Transacciones distribuidas — 2PC y saga
  - Outbox pattern — dual-write correcto
  - Postgres vs MySQL — diferencias que importan al dev
  - Full-text search — Postgres vs Elasticsearch
  - UUID como PK — trade-offs
  - Backup y restore — probar el restore
- **JSON:** `packages/content/src/tech/programmer/sim-11-databases-for-devs.json`

### Simulacro 12 — Git avanzado y colaboración

- **Focus:** Herramientas de git más allá de add/commit/push: rebase interactivo, cherry-pick, bisect, hooks, estrategias de merge, reflog para rescates y worktrees para monorepos.
- **Áreas:** refactor, testing
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Rebase interactivo — squash y edit
  - Cherry-pick — usar y no abusar
  - git bisect — encontrar el commit que rompió algo
  - Hooks — pre-commit vs pre-push
  - Merge strategies — fast-forward, merge commit, squash
  - git reflog — el salvavidas
  - Worktrees — trabajar en múltiples ramas sin stash
  - Conflictos de merge — resolución sistemática
  - git blame y git log -S — arqueología de código
  - Force push — cuándo y cómo con seguridad
  - Sub-modules vs sub-trees vs monorepo
  - Conventional commits + changelog automatizado
  - Signed commits — GPG y SSH signing
  - Sparse checkout y partial clone
  - .gitignore vs .git/info/exclude vs skip-worktree
  - Detached HEAD — qué significa y cómo salir
  - Revert vs Reset — cuándo cada uno
  - git rerere — recordar resoluciones de merge
  - Trailers en commits — Signed-off-by, Co-authored-by
  - Git como herramienta de forensics — CVE arqueología
- **JSON:** `packages/content/src/tech/programmer/sim-12-git-and-collaboration.json`

### Simulacro 13 — Docker y contenedores en la práctica

- **Focus:** Escribir Dockerfiles correctos (multistage, caching, non-root), diferenciar imagen/contenedor/volumen, redes, tamaño, seguridad y patrones para dev con docker-compose.
- **Áreas:** apis
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Layer caching — orden correcto
  - Multi-stage builds — imagen final minimalista
  - Non-root user — por qué siempre
  - ENTRYPOINT vs CMD
  - Volúmenes vs Bind mounts
  - .dockerignore — por qué siempre
  - Redes de Docker — bridge, host, none
  - Tamaño de imagen — Alpine trade-offs
  - Docker Compose para dev — health checks y depends_on
  - Security scanning — Trivy, Snyk, Dockle
  - Signal handling — PID 1 y graceful shutdown
  - Docker Hub rate limits y proxies
  - Secrets en Docker — cómo NO manejar
  - docker system prune — riesgos
  - Docker vs Podman vs runtime alternatives
  - COPY vs ADD
  - BuildKit — features modernas
  - docker exec y debugging containers en producción
  - Imagen 'latest' y versioning
  - Dev vs Prod parity — 12-factor
- **JSON:** `packages/content/src/tech/programmer/sim-13-docker-and-containers.json`

### Simulacro 14 — Linux y shell para developers

- **Focus:** Fundamentos de Linux que todo dev debe manejar: procesos y threads, señales y shutdown, file descriptors, permisos, pipes, grep/awk/sed, systemd, cron y cgroups.
- **Áreas:** fundamentals
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Procesos vs threads en Linux
  - SIGTERM vs SIGKILL — graceful shutdown
  - File descriptors — límites y leaks
  - Permisos — chmod y su octal
  - chown vs chgrp — grupos y ownership
  - Pipes y redirections — stdin/stdout/stderr
  - grep avanzado — regex y flags
  - awk — extracción y transformación
  - sed — sustitución y edición in-place
  - systemd — services básicos
  - cron — sintaxis y errores comunes
  - cgroups y limits — memoria y CPU
  - ps, top, htop — inspección de procesos
  - strace y lsof — debugging profundo
  - find — búsqueda avanzada
  - netstat / ss — inspección de red
  - disk usage — du y df
  - SSH — configuración y ProxyJump
  - xargs — construir comandos a partir de stdin
  - Shell scripting — safety flags
- **JSON:** `packages/content/src/tech/programmer/sim-14-linux-and-shell.json`

### Simulacro 15 — Observabilidad para developers (logs, métricas, tracing)

- **Focus:** Logging estructurado, correlation IDs, métricas Prometheus (RED/USE), cardinalidad, tracing distribuido con OpenTelemetry y errores comunes.
- **Áreas:** apis
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Structured logging — por qué JSON gana
  - Correlation IDs — trace request across services
  - Sampling — no puedes trazar todo
  - Métricas — counter, gauge, histogram
  - Cardinalidad — el error caro
  - RED method — request-oriented services
  - OpenTelemetry — la unificación
  - Log levels — cuándo cada uno
  - Health checks — liveness vs readiness
  - Métricas — SLO / SLI / error budget
  - Alerting — alertas actionable
  - PII y logs — data privacy
  - Distributed tracing — anatomy of a trace
  - Logs vs metrics vs traces — cuándo cada uno
  - Prometheus — pull vs push
  - Exemplars — bridge metrics to traces
  - Continuous profiling — el 4o pilar?
  - Logging library performance
  - Blackbox vs whitebox monitoring
  - Post-mortem — cultura blameless
- **JSON:** `packages/content/src/tech/programmer/sim-15-observability-for-devs.json`
