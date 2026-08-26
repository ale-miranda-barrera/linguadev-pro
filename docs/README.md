# LinguaDev Pro — Documentación de contenido

Documentación de estudio y respaldo legible de todos los módulos de contenido del proyecto. Los JSON con las preguntas de práctica viven en `packages/content/src/` (fuente autoritativa); estos documentos son la versión **estudiable** que sobrevive incluso si la app deja de funcionar.

## Módulos disponibles

### Docs de estudio profesionales (90 capítulos, ~500K palabras)

Cada capítulo sigue una **estructura fija de 11 secciones** con contenido básico → medio → avanzado, ejemplos de código reproducibles, ejercicios verificables con criterios de éxito, y casos reales de la industria 2024-2026.

- **[Programador](./programmer/README.md)** — Fundamentos → Senior. 15 capítulos.
- **[Arquitectura](./architecture/README.md)** — Sistemas · Cloud · Tradeoffs. 15 capítulos.
- **[DevOps](./devops/README.md)** — CI/CD · Contenedores · SRE · FinOps. 40 capítulos.
- **[Programando con IA](./ai-programming/README.md)** — Context · Agents · Evals · Cost · Security. 20 capítulos.

### Backup rápido (índice de temas, sin contenido didáctico)

Solo lista título, focus, áreas y `topic` de cada pregunta — útil para navegación rápida cuando ya conoces el tema y solo quieres localizar una pregunta.

- [Programador](./programmer.md) — 15 sims × 20 preguntas.
- [Arquitectura](./architecture.md) — 15 sims × 20 preguntas.
- [DevOps](./devops.md) — 40 sims × 20 preguntas.

### Inglés (CEFR A2 → C1)

- **[Docs de estudio por nivel CEFR](./english/README.md)** — 5 docs consolidados (A2, A2+, B1, B2, B2+) con gramática core, vocab core, listening/speaking/writing patterns, errores típicos hispanos, plan semanal y recursos. ~301 KB / ~44,500 palabras.
- [Backup rápido de packs](./english-packs.md) — 9 packs temáticos + 250 packs por nivel. Vocab/dictations/speaking completos como flashcards. Útil para búsqueda rápida.

### Certificaciones AWS

- [AWS Certifications](./aws.md) — Cloud Practitioner (CLF-C02, 20 sims) + Solutions Architect Associate (SAA-C03, 20 sims).

## Estructura estándar de los capítulos de estudio

Todos los 90 caps (programmer + architecture + devops + ai-programming) siguen esta plantilla:

- **§0. Antes de empezar** — pre-requisitos + glosario mínimo + setup con comandos concretos (`pip install …`, `docker run …`).
- **§1. El gran cuadro** — por qué el tema importa hoy y qué pasa si no lo dominas.
- **§2. Fundamentos (básico)** — 3-5 conceptos base con ejemplo mínimo funcionando.
- **§3. Cómo funciona por dentro (medio)** — mecanismos técnicos con código real, tablas comparativas y diagramas ASCII.
- **§4. Práctica avanzada (senior)** — patrones profesionales, trade-offs, anti-patrones.
- **§5. Ejemplo práctico completo** — caso end-to-end reproducible con código (~50-150 líneas).
- **§6. Cheatsheet + reglas mentales + anti-patrones** — resumen compacto con ✅/❌ y tablas de decisión.
- **§7. Casos reales industria 2024-2026** — 3-5 incidentes o casos famosos con fechas.
- **§8. Ejercicios prácticos** — 3-5 ejercicios con objetivo, setup, pasos y criterios de éxito (checkbox).
- **§9. Recursos y siguientes pasos** — referencias oficiales, papers, tools recomendadas.
- **§10. Preguntas de práctica (20)** — link al JSON del sim asociado + ruta en la app.

**Nivel dentro de cada capítulo:** Básico → Medio → Avanzado. Puedes parar en §3 si buscas panorámica, o llegar hasta §8 si quieres dominio operacional.

**Ejemplos y ejercicios ejecutables:** todos los `pip install`, comandos bash, y snippets Python/TypeScript/YAML/HCL/Terraform están probados en el rango de versiones citado (2025-2026).

## Tamaño total del contenido de estudio

- **90 capítulos** (15 programmer + 15 architecture + 40 devops + 20 ai-programming).
- **~3.7 MB** de Markdown.
- **~500,000 palabras** en español.
- **Miles de bloques de código** en Python, TypeScript, Java, Go, Rust, Bash, YAML, HCL, SQL, PromQL, JSON.
- **~1,800 preguntas de práctica** en 90 sims JSON con escenarios reales.
