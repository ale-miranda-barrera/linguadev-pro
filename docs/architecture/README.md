# Arquitectura — Sistemas · Cloud · Tradeoffs

Diseño de sistemas: cuándo usar SQL vs NoSQL, cuándo meter Redis, cuándo un event bus (Kafka/SQS/SNS), qué es Cold Start y sus implicaciones en Lambda, cómo escalar, DNS, CDN, patrones de resilencia, monolito vs microservicios, CAP, saga, CQRS, event sourcing. Escenarios reales del tipo "tienes X problema con Y restricciones — ¿qué eliges y por qué?". Sin respuestas fáciles: siempre hay tradeoffs.

## Cómo usar este doc

Cada capítulo sigue la **estructura estándar de 11 secciones**: pre-requisitos + setup, gran cuadro, fundamentos (básico), cómo funciona por dentro (medio), práctica avanzada (senior), ejemplo end-to-end reproducible, cheatsheet + anti-patrones, casos reales 2024-2026, ejercicios verificables, recursos, link al sim.

## Áreas cubiertas (10 áreas)

| ID | Nombre | Descripción |
|---|---|---|
| `db-choice` | Elección de DB | SQL vs NoSQL, columnar, grafo, search, tiempo-real, vector. |
| `caching` | Caching | Redis, CDN, cache-aside, write-through, invalidación, stampede. |
| `messaging` | Mensajería + eventos | SQS, SNS, Kafka, pub/sub, sagas, orquestación vs coreografía. |
| `microservices` | Microservicios vs monolito | Cuándo dividir, service boundaries, chatty services, distributed transactions. |
| `resilience` | Resiliencia + HA | Retries, circuit breakers, bulkheads, timeouts, backoff, idempotencia. |
| `scalability` | Escalabilidad + performance | Vertical vs horizontal, sharding, latencia vs throughput, N+1, hot partition. |
| `networking` | Networking + DNS + CDN | DNS, TTL, HTTP/2/3, TLS, CORS, edge, latencia geográfica. |
| `serverless` | Serverless | Cold start, VPC en Lambda, provisioned concurrency, límites, costos. |
| `observability` | Observabilidad | Logs, métricas, tracing, RED/USE, SLIs/SLOs, alerting sano. |
| `security-arch` | Seguridad arquitectural | Zero trust, least privilege, defense in depth, secretos, segmentation. |

## Índice de capítulos (15)

| # | Capítulo |
|---|---|
| 01 | [Elección de DB](./01-eleccion-de-db.md) |
| 02 | [Mensajería y microservicios](./02-mensajeria-y-microservicios.md) |
| 03 | [Serverless y networking](./03-serverless-y-networking.md) |
| 04 | [Patrones de resiliencia](./04-patrones-de-resiliencia.md) |
| 05 | [Observabilidad y escala](./05-observabilidad-y-escala.md) |
| 06 | [CAP y consistencia](./06-cap-y-consistencia.md) |
| 07 | [Event Sourcing y CQRS](./07-event-sourcing-y-cqrs.md) |
| 08 | [Consenso y coordinación](./08-consenso-y-coordinacion.md) |
| 09 | [Patrones cloud-native](./09-patrones-cloud-native.md) |
| 10 | [Arquitectura de seguridad](./10-arquitectura-de-seguridad.md) |
| 11 | [Lambda serverless profundo](./11-lambda-serverless-profundo.md) |
| 12 | [Migraciones zero-downtime](./12-migraciones-zero-downtime.md) |
| 13 | [Chaos y testing en producción](./13-chaos-y-testing-en-produccion.md) |
| 14 | [Multi-región y DR](./14-multi-region-y-dr.md) |
| 15 | [Optimización de costos](./15-optimizacion-de-costos.md) |

## Ruta sugerida de estudio

- **Semana 1:** capítulos 1-3 (DB, mensajería, serverless).
- **Semana 2:** capítulos 4-6 (resiliencia, observabilidad, CAP).
- **Semana 3:** capítulos 7-9 (event sourcing, consenso, cloud-native).
- **Semana 4:** capítulos 10-12 (seguridad, Lambda profundo, migraciones).
- **Semana 5:** capítulos 13-15 (chaos, DR, costos).

## Volver al índice general

← [Índice general de docs](../README.md)
