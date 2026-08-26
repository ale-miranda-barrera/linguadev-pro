# Arquitectura — Sistemas · Cloud · Tradeoffs

Diseño de sistemas: cuándo usar SQL vs NoSQL, cuándo meter Redis, cuándo un event bus (Kafka/SQS/SNS), qué es Cold Start y sus implicaciones en Lambda, cómo escalar, DNS, CDN, patrones de resilencia, monolito vs microservicios, CAP, saga, CQRS, event sourcing. Escenarios reales del tipo "tienes X problema con Y restricciones — ¿qué eliges y por qué?". Sin respuestas fáciles: siempre hay tradeoffs.

## Áreas cubiertas

- **Elección de DB** (`db-choice`) — SQL vs NoSQL, columnar, grafo, search, tiempo-real.
- **Caching** (`caching`) — Redis, CDN, cache-aside, write-through, invalidación, stampede.
- **Mensajería + eventos** (`messaging`) — SQS, SNS, Kafka, pub/sub, sagas, orquestación vs coreografía.
- **Microservicios vs monolito** (`microservices`) — Cuándo dividir, service boundaries, chatty services, distributed transactions.
- **Resilencia + HA** (`resilience`) — Retries, circuit breakers, bulkheads, timeouts, backoff, idempotencia.
- **Escalabilidad + performance** (`scalability`) — Vertical vs horizontal, sharding, latencia vs throughput, N+1, hot partition.
- **Networking + DNS + CDN** (`networking`) — DNS, TTL, HTTP/2/3, TLS, CORS, ping, RTT, edge, latencia geográfica.
- **Serverless** (`serverless`) — Cold start, VPC en Lambda, provisioned concurrency, límites, costos.
- **Observabilidad** (`observability`) — Logs, métricas, tracing, RED/USE, SLIs/SLOs, alerting sano.
- **Seguridad arquitectural** (`security-arch`) — Zero trust, least privilege, defense in depth, secretos, network segmentation.

## Sims (15 total)

### Simulacro 01 — Elegir la base de datos correcta

- **Focus:** SQL vs NoSQL, cuándo un motor no encaja, elegir por patrón de acceso y consistencia, no por moda.
- **Áreas:** db-choice, scalability, resilience
- **Preguntas:** 20
- **Tiempo:** 60 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Vocabulario básico — ACID
  - Teorema CAP — malinterpretación común
  - Índices — B-tree vs Hash vs GIN
  - Aislamiento de transacciones — Read Committed vs Repeatable Read vs Serializable
  - Time-series data — DB especializada vs Postgres
  - Grafos — Neo4j vs relacional
  - Search — Elasticsearch como source of truth (anti-patrón)
  - Vector DB — cuándo es imprescindible
  - OLTP vs OLAP — no mezclar
  - Connection pooling — el bottleneck que no se ve
  - Change Data Capture — el patrón universal
  - Multi-tenancy — schema per tenant vs shared schema
  - UUID vs autoincrement — el debate eterno
  - Migraciones sin downtime — el arte perdido
  - Isolation anomaly — write skew
  - Consistent hashing — para qué sirve
  - Read your writes — consistencia percibida
  - Sharding — cuando y cómo
  - Event Sourcing — cuándo vale la pena
  - Elegir DB — framework de decisión
- **JSON:** `packages/content/src/tech/architecture/sim-01-db-choice.json`

### Simulacro 02 — Mensajería, eventos y microservicios

- **Focus:** Cuándo un event bus vs REST síncrono, SQS vs Kafka vs SNS, sagas, cuándo microservicios y cuándo NO, distributed transactions.
- **Áreas:** messaging, microservices, resilience
- **Preguntas:** 20
- **Tiempo:** 60 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Vocabulario básico — queue vs topic
  - At-least-once vs exactly-once — la verdad incómoda
  - Dead Letter Queue — para qué sirve
  - Bounded contexts — dividir por dominio, no por capa
  - Service-to-service auth
  - SNS/SQS vs Kafka — cuándo cada uno
  - Cuándo NO dividir en microservicios
  - Distributed transaction — saga vs 2PC
  - API Gateway — patrones y anti-patrones
  - Kafka partitions — el corazón del throughput
  - Idempotency — el patrón universal en eventos
  - Contract testing — el problema silencioso
  - Service discovery — cómo se encuentran
  - Choreography vs Orchestration — la decisión clave
  - Backpressure — cuando el consumer no puede
  - Distributed monolith — el peor de dos mundos
  - Schema evolution — compatibilidad hacia atrás
  - Sync vs Async — la decisión más importante
  - Versioning APIs — el eterno debate
  - Framework de decisión — cuándo microservicios
- **JSON:** `packages/content/src/tech/architecture/sim-02-messaging-and-microservices.json`

### Simulacro 03 — Serverless, cold start, DNS, CDN y latencia

- **Focus:** Cold start real de Lambda, cuándo usar serverless y cuándo NO, DNS y TTL, CDN, dónde está la latencia.
- **Áreas:** serverless, networking, scalability
- **Preguntas:** 20
- **Tiempo:** 60 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Vocabulario básico — HTTP status codes
  - HTTP/1.1 vs HTTP/2 vs HTTP/3
  - TCP vs UDP vs QUIC — cuándo cada uno
  - CDN — cómo funciona realmente
  - Serverless — cuándo NO usarlo
  - Cold start — causa raíz
  - DNS, TTL y failover
  - Latencia — dónde REALMENTE está
  - Lambda + DB — el pattern trap
  - TLS handshake — el hidden cost
  - Serverless containers — Fargate, Cloud Run, App Runner
  - Load balancers — L4 vs L7
  - WebSockets vs SSE vs long-polling
  - Edge functions — cuándo tienen sentido
  - VPC, subnets, security groups — networking fundamentals
  - Step Functions vs orchestrated Lambdas
  - Ingress vs Egress — cost trap
  - Rate limiting — patterns and pitfalls
  - Cost optimization — serverless in production
  - Multi-region architecture — decisiones fundamentales
- **JSON:** `packages/content/src/tech/architecture/sim-03-serverless-and-networking.json`

### Simulacro 04 — Resilencia: retries, circuit breakers, bulkheads, timeouts

- **Focus:** Patrones para sistemas que fallan bien: qué hacer cuando un dependency externa se degrada o cae.
- **Áreas:** resilience, microservices
- **Preguntas:** 20
- **Tiempo:** 60 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Vocabulario básico — availability y nines
  - Failure modes — clasificación
  - Health checks — el corazón del auto-healing
  - Graceful degradation — patterns
  - Idempotency + retries — patrón inseparable
  - Retries — cuándo son peligrosos
  - Circuit Breaker — cuándo abrirlo
  - Timeouts — el 99% de sistemas los pone mal
  - Bulkhead pattern — aislamiento de recursos
  - Chaos engineering — testing failures deliberately
  - Fallback strategies — spectrum of degradation
  - Load shedding — cuando decir no
  - Distributed tracing — cómo se debug distribuido
  - Backup and Recovery — RTO y RPO
  - Blue-green vs Canary vs Rolling deploys
  - Postmortems — culture y aprendizaje
  - On-call — sustainable operations
  - Cascading failure — el killer #1
  - Resilience testing — validate architecture
  - Framework de decisión — designing for resilience
- **JSON:** `packages/content/src/tech/architecture/sim-04-resilience-patterns.json`

### Simulacro 05 — Observabilidad, escalabilidad y hot partition

- **Focus:** Cómo se observa un sistema en producción (logs vs métricas vs tracing), SLIs/SLOs, cardinality, sampling, patrones para escalar sin colapsar por hot partition o cache stampede.
- **Áreas:** observability, scalability
- **Preguntas:** 20
- **Tiempo:** 30 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Logs vs métricas vs tracing — cuándo cada uno
  - SLI vs SLO vs SLA — cómo usar
  - Hot partition — el enemigo silencioso
  - Structured logging — por qué JSON
  - Correlation IDs — trazar requests distribuidas
  - Cardinality explosion en métricas
  - Log levels — cuándo usar cada uno
  - Alerting fatigue — cómo evitarla
  - Sampling de traces — head, tail, adaptive
  - Health checks — liveness vs readiness vs startup
  - Métricas RED vs USE
  - Bimodal distribution — el peligro del promedio
  - Stateless design — la clave para escalar horizontal
  - Auto-scaling — HPA basado en qué
  - Backpressure y load shedding
  - Rate limiting — algoritmos
  - OpenTelemetry — el nuevo estándar
  - PII redaction — logs seguros
  - N+1 queries en escala
  - Continuous profiling
- **JSON:** `packages/content/src/tech/architecture/sim-05-observability-and-scale.json`

### Simulacro 06 — CAP, PACELC y modelos de consistencia reales

- **Focus:** CAP theorem sin mitos, modelos de consistencia (strong, causal, eventual, monotonic reads, read-your-writes), quorums (N/W/R en Dynamo/Cassandra), CRDTs, resolución de conflictos y por qué 'AP' o 'CP' rara vez son elecciones puras.
- **Áreas:** db-choice, scalability, resilience
- **Preguntas:** 20
- **Tiempo:** 28 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - CAP theorem — el mito más malinterpretado
  - Quorums N/W/R en Dynamo/Cassandra
  - Modelos de consistencia — jerarquía
  - Read-your-writes — el bug invisible
  - CRDTs — cuándo y por qué
  - LWW y el problema del reloj
  - Split-brain en multi-master
  - DynamoDB — strong vs eventual read
  - Sharding — trampas comunes
  - Isolation levels — anomalías reales
  - Eventual consistency — cuándo es aceptable
  - Idempotencia y deduplicación
  - Fencing tokens y locks distribuidos
  - Causal consistency práctica
  - Bounded staleness
  - Conflict resolution strategies
  - Linearizability vs Serializability
  - Read replicas — lag y sus riesgos
  - Choosing consistency level per operation
  - Anti-entropy y Merkle trees
- **JSON:** `packages/content/src/tech/architecture/sim-06-cap-and-consistency.json`

### Simulacro 07 — Event Sourcing, CQRS y la verdad de exactly-once

- **Focus:** Event sourcing vs snapshot, CQRS y proyecciones, replay, schema evolution de eventos, idempotencia de consumers, el mito de exactly-once delivery vs exactly-once processing.
- **Áreas:** messaging, microservices, scalability
- **Preguntas:** 20
- **Tiempo:** 28 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Event Sourcing — qué es realmente
  - CQRS — trampas del write model y read model
  - Exactly-once delivery — el mito
  - Outbox pattern
  - Event schema evolution
  - Idempotent consumers
  - Kafka partitioning strategy
  - Snapshots en Event Sourcing
  - Projection rebuilds
  - Dead letter queues
  - Event vs Command
  - Consumer offset management
  - Choreography vs Orchestration
  - Event enrichment vs event lookup
  - Compacted topics en Kafka
  - Backpressure
  - Event ordering across aggregates
  - Change Data Capture (CDC)
  - Event granularity
  - Async vs Sync — cuándo async no aplica
- **JSON:** `packages/content/src/tech/architecture/sim-07-event-sourcing-and-cqrs.json`

### Simulacro 08 — Consenso, leader election y coordinación distribuida

- **Focus:** Raft y Paxos, leader election, split-brain, quorums, Zookeeper vs etcd vs Consul, distributed locks (por qué son peligrosos), fencing tokens y por qué el consenso siempre paga latencia.
- **Áreas:** resilience, scalability, db-choice
- **Preguntas:** 20
- **Tiempo:** 28 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - FLP impossibility
  - Raft vs Paxos
  - Leader election y split-brain
  - Quorum sizing
  - Zookeeper vs etcd vs Consul
  - Distributed locks — por qué son peligrosos
  - Leader lease vs heartbeat
  - Fencing tokens
  - Election storms
  - Consenso vs coordination
  - Membership protocols
  - TrueTime y Spanner
  - Two-Phase Commit y sus problemas
  - Sequence numbers y timestamps
  - Watch mechanisms
  - Cluster membership changes
  - Read scaling en consensus systems
  - Multi-region consensus
  - Consenso y availability tradeoff
  - Byzantine fault tolerance
- **JSON:** `packages/content/src/tech/architecture/sim-08-consensus-and-coordination.json`

### Simulacro 09 — Kubernetes, service mesh y patrones cloud-native

- **Focus:** Kubernetes patterns (init containers, sidecars, ambassador, operator), service mesh (Istio/Linkerd), stateful vs stateless, StatefulSets, node affinity, cost of over-provisioning y por qué 'todo en K8s' no siempre es la respuesta.
- **Áreas:** serverless, microservices, scalability, resilience
- **Preguntas:** 20
- **Tiempo:** 28 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Sidecar pattern
  - Init containers
  - Ambassador pattern
  - Kubernetes Operator pattern
  - StatefulSet vs Deployment
  - Service mesh — cuándo justificado
  - Node affinity y anti-affinity
  - Requests vs Limits
  - Horizontal Pod Autoscaler
  - Overprovisioning y cost
  - Kubernetes vs Serverless (Lambda)
  - Rolling update strategies
  - Multi-tenancy en Kubernetes
  - Ingress vs Gateway API
  - GitOps y ArgoCD/Flux
  - eBPF y next-gen networking
  - Pod Disruption Budget
  - Sidecar overhead at scale
  - Kubernetes anti-patterns
  - Cuándo NO usar Kubernetes
- **JSON:** `packages/content/src/tech/architecture/sim-09-cloud-native-patterns.json`

### Simulacro 10 — Security architecture: Zero Trust, secrets, IAM, network design

- **Focus:** Zero Trust, least privilege, defense-in-depth, secrets management (Vault/SSM/Secrets Manager), IAM policies traps, network segmentation, VPC design, TLS everywhere, JWT vs sessions.
- **Áreas:** security-arch, networking, resilience
- **Preguntas:** 20
- **Tiempo:** 28 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Zero Trust — qué es realmente
  - Least privilege IAM traps
  - Secrets management
  - JWT vs sessions
  - TLS everywhere / mTLS
  - VPC design principles
  - Defense in depth
  - OWASP Top 10 y injection
  - Rotación de credentials
  - Encryption at rest — más allá de 'sí, tengo'
  - Threat modeling
  - Supply chain security
  - SSRF (Server-Side Request Forgery)
  - Rate limiting y DDoS
  - Passwordless y FIDO2
  - CORS explicado
  - Container security
  - Audit logging y forensics
  - Secure defaults
  - Security is a process
- **JSON:** `packages/content/src/tech/architecture/sim-10-security-architecture.json`

### Simulacro 11 — Lambda y serverless en profundidad

- **Focus:** Cold start real, Provisioned Concurrency vs SnapStart, Lambda en VPC, límites de payload/timeout, memory-CPU, cuándo Lambda cuesta MÁS que ECS, event sources, Reserved Concurrency y DLQ.
- **Áreas:** serverless, scalability, resilience
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Anatomía del cold start
  - Provisioned Concurrency vs SnapStart
  - Lambda dentro de VPC — ENI overhead
  - Payload y timeout limits
  - Memory-CPU relationship
  - Cuándo Lambda cuesta MÁS que ECS/Fargate
  - Event source: SQS
  - Event source: DynamoDB Streams / Kinesis
  - Event source: S3 y EventBridge
  - Reserved Concurrency — trampas
  - DLQ y error handling
  - Concurrency modelo
  - Warm invocations y execution context
  - Observabilidad en Lambda
  - Lambda Extensions
  - Lambda + API Gateway vs Function URLs vs ALB
  - Lambda Layers y contenedores
  - Step Functions vs Lambda orchestration
  - Cost gotchas Lambda
  - Cuándo NO usar serverless
- **JSON:** `packages/content/src/tech/architecture/sim-11-lambda-serverless-deep.json`

### Simulacro 12 — Migraciones sin downtime: blue/green, canary, expand-contract

- **Focus:** Deploys sin caída: blue/green, canary, rolling, expand-contract para schemas DB, feature flags, cutover, rollback, testing en shadow.
- **Áreas:** resilience, microservices
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Blue/Green — cuándo usarlo
  - Canary deployment
  - Rolling update
  - Expand-contract para agregar columna
  - Expand-contract para renombrar campo
  - Feature flags como safety net
  - Backfill de datos
  - Cutover atómico
  - Rollback plan
  - Shadow testing
  - API versioning
  - Event schema evolution
  - Idempotency en migrations
  - Testing migrations
  - Deployment ordering
  - Long-running migrations
  - Feature flags vs branch
  - Deploy freeze windows
  - Dependencia entre migrations
  - Post-deploy verification
- **JSON:** `packages/content/src/tech/architecture/sim-12-migrations-zero-downtime.json`

### Simulacro 13 — Chaos engineering y testing en producción

- **Focus:** Chaos engineering, load testing, fault injection, DI para test doubles, canary analysis, feature flags como safety nets, dark launches, testing en producción sin cagarla.
- **Áreas:** resilience
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - Chaos engineering — filosofía
  - Simian Army y variantes de chaos
  - Load testing — k6 y patterns
  - Fault injection — AWS FIS
  - Dependency injection para testing
  - Canary analysis automation
  - Feature flags como safety net
  - Dark launch
  - Testing en producción — filosofía
  - Synthetic monitoring
  - Game days
  - Contract testing
  - Test doubles taxonomy
  - A/B testing infra
  - Chaos in CI/CD
  - Postmortems blameless
  - Retry-storm en testing
  - Test data management
  - Observability en testing
  - Culture and organization
- **JSON:** `packages/content/src/tech/architecture/sim-13-chaos-and-testing-production.json`

### Simulacro 14 — Multi-región y Disaster Recovery

- **Focus:** Active-active vs active-passive, DNS failover vs Global Accelerator, RTO/RPO, cross-region replication asincrónica, pilot light, warm standby, backup strategies, disaster testing.
- **Áreas:** resilience, scalability
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - RTO vs RPO
  - Estrategias DR — las 4 clásicas
  - Active-active vs Active-passive
  - DNS failover — Route 53
  - Global Accelerator
  - Cross-region replication asíncrona
  - DynamoDB Global Tables
  - Backup strategies — snapshots vs incremental
  - Disaster testing regular
  - Region selection y sovereignty
  - AZ (Availability Zone) design
  - Failback complexity
  - Backup Vault Lock
  - S3 replication
  - Multi-region latency-based routing
  - Multi-region deploys
  - Session state y stickiness
  - External dependencies en multi-region
  - Compliance and multi-region
  - DR strategy — how to choose
- **JSON:** `packages/content/src/tech/architecture/sim-14-multi-region-and-dr.json`

### Simulacro 15 — Cost optimization y FinOps en AWS

- **Focus:** FinOps básico, Savings Plans vs Reserved vs Spot, EBS gp3 vs gp2, S3 storage classes, tag-based cost allocation, unused resources, right-sizing, egress costs (la sorpresa), CloudFront vs S3 direct, Lambda 1ms billing.
- **Áreas:** scalability, serverless
- **Preguntas:** 20
- **Tiempo:** 25 min
- **Pass threshold:** 75%
- **Temas cubiertos:**
  - FinOps — filosofía
  - Savings Plans vs Reserved Instances
  - Spot instances
  - EBS gp3 vs gp2
  - S3 storage classes
  - Tag-based cost allocation
  - Unused resources — the silent killer
  - Right-sizing EC2
  - Network egress — la sorpresa mayor
  - CloudFront vs S3 direct
  - Lambda billing implications
  - CloudWatch cost gotchas
  - Budgets and alerts
  - Multi-account cost structure
  - RDS cost optimization
  - Container / Kubernetes cost
  - Data warehouse cost — Redshift vs alternatives
  - Dev/Test environment cost
  - Data transfer within AWS
  - FinOps cultural adoption
- **JSON:** `packages/content/src/tech/architecture/sim-15-cost-optimization.json`
