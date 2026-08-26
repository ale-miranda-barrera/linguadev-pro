# Programador — Fundamentos → Senior

Preguntas de práctica y capítulos de estudio que cubren los fundamentos que TODO programador debería dominar antes de llamarse senior: complejidad, estructuras de datos, patrones, SOLID, concurrencia, testing, code smells, refactor, APIs, seguridad. Cada capítulo parte de escenarios reales (bug, decisión de diseño, code review) y explica por qué cada opción es correcta o un anti-patrón típico.

## Cómo usar este doc

1. Cada capítulo es un tema auto-contenido con estructura fija de **11 secciones**:
   - **§0. Antes de empezar** — pre-requisitos, glosario mínimo, setup con comandos concretos.
   - **§1. El gran cuadro** — por qué el tema importa y qué pasa si no lo dominas.
   - **§2. Fundamentos (básico)** — 3-5 conceptos base con ejemplo mínimo.
   - **§3. Cómo funciona por dentro (medio)** — mecanismos técnicos con código real, tablas y diagramas ASCII.
   - **§4. Práctica avanzada (senior)** — patrones profesionales, trade-offs, anti-patrones.
   - **§5. Ejemplo práctico completo** — caso end-to-end reproducible con código (~50-150 líneas).
   - **§6. Cheatsheet + reglas mentales + anti-patrones** — resumen compacto con ✅/❌.
   - **§7. Casos reales industria 2024-2026** — 3-5 incidentes con fechas.
   - **§8. Ejercicios prácticos** — 3-5 ejercicios con criterios de éxito checkbox.
   - **§9. Recursos y siguientes pasos** — referencias oficiales, papers, tools.
   - **§10. Preguntas de práctica (20)** — link al JSON del sim asociado.
2. **Nivel dentro del capítulo:** Básico → Medio → Avanzado.
3. Los ejercicios y ejemplos son **ejecutables** con las versiones citadas 2025-2026.

## Áreas cubiertas (10 áreas)

| ID | Nombre | Descripción |
|---|---|---|
| `fundamentals` | Fundamentos | Complejidad, tipos, memoria, referencia vs valor. |
| `data-structures` | Estructuras de datos | Elección correcta según acceso/tamaño/mutabilidad. |
| `algorithms` | Algoritmos | Ordenamiento, búsqueda, recursión, greedy, DP. |
| `oop-solid` | OOP + SOLID | Principios OO, cohesión, acoplamiento. |
| `patterns` | Patrones de diseño | GoF, aplicación real, cuándo NO usarlos. |
| `concurrency` | Concurrencia | Threads, locks, async, race conditions, deadlocks. |
| `testing` | Testing + calidad | TDD, mocks vs stubs vs fakes, tests frágiles. |
| `refactor` | Refactor + code smells | Long method, feature envy, cambio incremental seguro. |
| `apis` | APIs + protocolos | REST, GraphQL, gRPC, idempotencia, versioning. |
| `security` | Seguridad | OWASP top 10, secretos, auth, hashing, injection. |

## Índice de capítulos (15)

| # | Capítulo |
|---|---|
| 01 | [Fundamentos y complejidad](./01-fundamentos-y-complejidad.md) |
| 02 | [SOLID y patrones](./02-solid-y-patrones.md) |
| 03 | [Concurrencia y async](./03-concurrencia-y-async.md) |
| 04 | [Testing y refactor](./04-testing-y-refactor.md) |
| 05 | [APIs y seguridad](./05-apis-y-seguridad.md) |
| 06 | [Memoria y GC](./06-memoria-y-gc.md) |
| 07 | [Networking, HTTP y TCP](./07-networking-http-y-tcp.md) |
| 08 | [JIT, VM y performance](./08-jit-vm-y-performance.md) |
| 09 | [Async patterns profundo](./09-async-patterns-profundo.md) |
| 10 | [Error handling y recovery](./10-error-handling-y-recovery.md) |
| 11 | [Bases de datos para devs](./11-bases-de-datos-para-devs.md) |
| 12 | [Git y colaboración](./12-git-y-colaboracion.md) |
| 13 | [Docker y contenedores](./13-docker-y-contenedores.md) |
| 14 | [Linux y shell](./14-linux-y-shell.md) |
| 15 | [Observabilidad para devs](./15-observabilidad-para-devs.md) |

## Ruta sugerida de estudio

- **Semana 1:** capítulos 1-3 (fundamentos + SOLID + concurrencia).
- **Semana 2:** capítulos 4-6 (testing + APIs + memoria).
- **Semana 3:** capítulos 7-9 (networking + performance + async).
- **Semana 4:** capítulos 10-12 (error handling + DB + git).
- **Semana 5:** capítulos 13-15 (docker + linux + observabilidad).

## Volver al índice general

← [Índice general de docs](../README.md)
