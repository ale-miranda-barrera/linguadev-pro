# Programando con IA — Doc de estudio

Todo lo que un programador senior 2026 debería saber para llevar features con LLM a producción sin quemar dinero, filtrar datos ni depender de "vibe coding". Cubre los 10 bloques que hoy diferencian a un dev pro con IA: (1) context engineering (RAG, embeddings, chunking, vector DBs, reranking, memoria), (2) agentes y herramientas (tool calling, MCP, ReAct, orquestación, computer use), (3) evals y observabilidad de LLM (datasets, LLM-as-judge, tracing con Langfuse/Braintrust), (4) seguridad IA (prompt injection, OWASP LLM Top 10, sandboxing, guardrails), (5) economía de inferencia (tokens, prompt caching, batching, streaming, model routing), (6) cuándo NO entrenar (prompting vs RAG vs LoRA vs destilación), (7) infra IA en AWS (Bedrock, SageMaker, vLLM), (8) nuevas prácticas de desarrollo (Spec-Driven Development, repos diseñados para agentes, CLI + IA en CI/CD), (9) datos y gobernanza (PII, EU AI Act, versionado), (10) UX de productos IA + GEO/AEO (posicionamiento en respuestas de IA). Escenarios reales de features en producción: qué eliges, por qué, cuáles son los tradeoffs y qué se rompe.

## Filosofía del módulo

Este módulo **NO** es "vibe coding". Está diseñado para que el programador salga sabiendo:

- **Diseñar y controlar sistemas con LLMs**, no solo consumirlos como una caja negra que devuelve texto.
- Aplicar **patrones probados** (spec-driven development, sandboxing, evals, tracing) que evitan las trampas típicas de introducir IA en producción.
- **Decidir con criterio arquitectural**: RAG vs fine-tune vs prompting, cuándo agente vs workflow determinista, cuándo NO usar IA porque una regresión lineal o un `if` bastan.
- **Reducir costo, latencia y riesgo** cuando el proyecto llega a escala real (miles de usuarios, cientos de miles de requests, presupuesto que se dispara).

La diferencia entre alguien que "usa ChatGPT" y alguien que **construye productos IA en serio** está en estos 20 capítulos. Los buenos jobs de 2026 no piden "prompt engineer": piden gente que sepa hacer evals, montar RAG que no alucine, poner guardrails, controlar la factura y depurar por qué el agente se atascó en un loop.

## Cómo usar este doc

1. **Cada capítulo es un tema auto-contenido.** Puedes leerlo sin haber leído los anteriores. Los conceptos que un capítulo asume que ya conoces están enlazados o glosados brevemente.
2. **Al final de cada capítulo** hay 20 preguntas de práctica (con escenarios reales, alternativas y explicaciones) en el JSON del sim asociado. Corre el sim en la app o abre el JSON directamente.
3. **Los 10 bloques que dominan la industria 2026** están cubiertos en 20 capítulos: uno introduce, otro profundiza, o cubren áreas complementarias.
4. Cada capítulo sigue una **estructura fija de 11 secciones** para que puedas navegar y estudiar de manera consistente:
   - **§0. Antes de empezar** — pre-requisitos, glosario mínimo, setup con comandos concretos (`pip install …`).
   - **§1. El gran cuadro** — por qué el tema importa hoy y qué pasa si no lo dominas.
   - **§2. Fundamentos (básico)** — 3-5 conceptos base con ejemplo mínimo funcionando.
   - **§3. Cómo funciona por dentro (medio)** — mecanismos técnicos con código real, tablas comparativas y diagramas ASCII.
   - **§4. Práctica avanzada (senior)** — patrones profesionales, trade-offs, anti-patrones.
   - **§5. Ejemplo práctico completo** — caso end-to-end reproducible con código (~50-150 líneas).
   - **§6. Cheatsheet + reglas mentales + anti-patrones** — resumen compacto con ✅/❌ y tablas de decisión.
   - **§7. Casos reales industria 2026** — 3-5 incidentes o casos famosos con fechas.
   - **§8. Ejercicios prácticos** — 3-5 ejercicios con objetivo, setup, pasos y criterios de éxito (checkbox).
   - **§9. Recursos y siguientes pasos** — referencias oficiales, papers, tools recomendadas, qué leer después.
   - **§10. Preguntas de práctica (20)** — link al JSON del sim asociado + ruta en la app.
5. **Nivel dentro del capítulo:** Básico → Medio → Avanzado. Puedes parar en §3 si buscas panorámica, o llegar hasta §8 si quieres dominio operacional.
6. **Ejemplos y ejercicios son ejecutables**. Todos los `pip install`, comandos bash, y snippets Python/TypeScript/YAML/HCL están probados en el rango de versiones citado (2025-2026).

## Áreas cubiertas (10 áreas)

| ID | Nombre | Descripción |
|---|---|---|
| `context-engineering` | Context Engineering | RAG, embeddings, chunking, vector DBs, reranking, memoria persistente, gestión de ventana. |
| `agents-tools` | Agentes + herramientas | Tool/function calling, MCP, loops ReAct, orquestación multi-agente, agentes de código, computer use. |
| `evals-observability` | Evals + observabilidad | Datasets de evaluación, LLM-as-judge, regression tests de prompts, tracing (Langfuse/Braintrust/LangSmith). |
| `security` | Seguridad IA | Prompt injection, OWASP LLM Top 10, sandboxing de agentes, guardrails, exfiltración vía tools. |
| `cost-inference` | Economía + inferencia | Costo por token, prompt caching, batching, streaming, latencia, model routing, fallbacks. |
| `model-strategy` | Estrategia de modelo | Cuándo prompting vs RAG vs fine-tuning (LoRA) vs destilación. Decisión arquitectónica. |
| `ai-infra-aws` | Infra IA en AWS | Bedrock, SageMaker, vLLM, inferencia serverless, GPUs, cuotas y costos. |
| `ai-dev-practices` | Nuevas prácticas de dev | Spec-Driven Development, repos legibles por agentes, CLI, agentes en CI/CD, code review con IA. |
| `data-governance` | Datos + gobernanza | Pipelines de datos para IA, calidad, versionado, PII, EU AI Act, compliance. |
| `ai-ux-geo` | UX productos IA + GEO | Diseño para incertidumbre, human-in-the-loop, GEO/AEO (posicionamiento en respuestas de IA). |

## Índice de capítulos (20)

| # | Capítulo | Bloque | Preguntas |
|---|---|---|---|
| 01 | [Fundamentos IA: tokens, contexto, latencia](./01-fundamentos-tokens-contexto.md) | Base | 20 |
| 02 | [RAG parte 1: embeddings y chunking](./02-rag-embeddings-chunking.md) | Context Engineering | 20 |
| 03 | [RAG parte 2: vector DBs, hybrid search, reranking](./03-vector-dbs-hybrid-reranking.md) | Context Engineering | 20 |
| 04 | [Context engineering: memoria, semantic cache, ventana](./04-context-memory-caching.md) | Context Engineering | 20 |
| 05 | [Tool/Function calling: schemas y idempotencia](./05-tool-function-calling.md) | Agentes + Tools | 20 |
| 06 | [MCP profundo: crear un server, primitives, transports](./06-mcp-model-context-protocol.md) | Agentes + Tools | 20 |
| 07 | [Loops de agentes: ReAct, orquestación, multi-agent](./07-agent-loops-orchestration.md) | Agentes + Tools | 20 |
| 08 | [Agentes de código y computer use](./08-code-agents-computer-use.md) | Agentes + Tools | 20 |
| 09 | [Evals: datasets, LLM-as-judge, regression tests](./09-evals-datasets-llm-judge.md) | Evals + Observabilidad ⭐ | 20 |
| 10 | [Observabilidad LLM: tracing con Langfuse/Braintrust](./10-llm-observability-tracing.md) | Evals + Observabilidad ⭐ | 20 |
| 11 | [Seguridad IA parte 1: prompt injection y OWASP LLM](./11-prompt-injection-owasp-llm.md) | Seguridad ⭐ | 20 |
| 12 | [Seguridad IA parte 2: sandboxing y guardrails](./12-agent-sandboxing-guardrails.md) | Seguridad ⭐ | 20 |
| 13 | [Economía de inferencia: costos, prompt caching, batching](./13-inference-cost-prompt-caching.md) | Economía | 20 |
| 14 | [Latencia: streaming, model routing, fallbacks](./14-latency-streaming-model-routing.md) | Economía | 20 |
| 15 | [Cuándo NO entrenar: prompting vs RAG vs LoRA vs destilación](./15-prompting-vs-rag-vs-finetuning.md) | Estrategia de modelo | 20 |
| 16 | [Infra IA en AWS: Bedrock, SageMaker, vLLM](./16-ai-infra-aws-bedrock-sagemaker.md) | Infra AWS | 20 |
| 17 | [Spec-Driven Development y repos para agentes](./17-spec-driven-development-agent-ready-repos.md) | Nuevas prácticas | 20 |
| 18 | [CLI + agentes en CI/CD, code review con IA](./18-cli-agents-ci-cd-code-review.md) | Nuevas prácticas | 20 |
| 19 | [Datos y gobernanza: PII, EU AI Act, versionado](./19-data-pipelines-pii-eu-ai-act.md) | Datos + gobernanza | 20 |
| 20 | [UX de productos IA + GEO/AEO](./20-ai-product-ux-geo-aeo.md) | UX + GEO | 20 |

## Ruta sugerida de estudio

**Prioridad de retorno (según industria 2026):** 1 → 2 → 3 → 4 → 5, donde 3 y 4 son los diferenciadores clave que muy poca gente domina bien.

- **Semana 1:** capítulos 1-4 (base + context engineering — sin esto no eres capaz ni de leer código IA).
- **Semana 2:** capítulos 5-8 (agentes, tools, MCP, code agents — la mecánica del "hacer cosas").
- **Semana 3:** capítulos 9-12 (evals + seguridad — aquí es donde realmente te diferencias del 90%).
- **Semana 4:** capítulos 13-16 (costo, latencia, estrategia de modelo, AWS — la parte "adulta").
- **Semana 5:** capítulos 17-20 (SDD, CI/CD, gobernanza, UX + GEO — la modernidad).

## Glosario rápido

- **Token** — unidad mínima con la que trabaja un LLM (aprox 4 caracteres o 0.75 palabras en inglés). Toda la factura y todos los límites se miden en tokens, no en caracteres.
- **BPE (Byte Pair Encoding)** — algoritmo de tokenización que combina pares de bytes/caracteres frecuentes. Usado por GPT, Claude, Llama.
- **Ventana de contexto** — máximo de tokens (input + output) que el modelo puede procesar en una llamada. 200k en Claude, 128k-1M en GPT-4o/Gemini.
- **TTFT (Time To First Token)** — latencia hasta el primer token. Métrica clave de UX con streaming.
- **TPS (Tokens Per Second)** — velocidad de generación tras el TTFT.
- **Embedding** — vector de flotantes (típicamente 384-3072 dimensiones) que representa el significado semántico de un texto.
- **RAG (Retrieval-Augmented Generation)** — patrón: recupera documentos relevantes vía búsqueda vectorial, mételos en el prompt, deja que el LLM responda con ese contexto.
- **Chunking** — partir documentos en fragmentos indexables por embedding.
- **Vector DB** — base de datos optimizada para ANN (Approximate Nearest Neighbor). Pinecone, Weaviate, Qdrant, pgvector.
- **HNSW** — algoritmo de índice ANN basado en grafos jerárquicos. Estándar hoy.
- **Hybrid search** — combinar búsqueda densa (embeddings) con dispersa (BM25) y fusionar con RRF.
- **RRF (Reciprocal Rank Fusion)** — método simple y robusto de fusionar rankings.
- **Reranking** — segunda fase con cross-encoder que reordena top-K resultados por relevancia real.
- **Cross-encoder vs bi-encoder** — cross procesa query+doc juntos (preciso, caro); bi procesa por separado (rápido, para búsqueda inicial).
- **MMR (Maximal Marginal Relevance)** — algoritmo para diversificar resultados evitando redundancia.
- **Prompt caching** — cachear el prefix del prompt para no re-facturar el mismo system message millones de veces. Anthropic y OpenAI lo soportan (2024+).
- **Semantic cache** — cachear respuestas por similitud semántica de queries, no exactitud.
- **LLM-as-judge** — usar un LLM para evaluar outputs de otro LLM contra una rúbrica.
- **Golden dataset** — set curado (100-500 ejemplos) contra el que corres regression tests de prompts.
- **Faithfulness** — métrica RAG: si la respuesta cita solo el contexto o inventa.
- **Recall@k, MRR, NDCG** — métricas clásicas de retrieval.
- **Tool calling / function calling** — mecanismo por el que un LLM devuelve JSON estructurado indicando qué función llamar.
- **MCP (Model Context Protocol)** — protocolo abierto de Anthropic (nov 2024) para conectar clientes IA con servidores de tools/resources/prompts.
- **ReAct** — patrón: el agente alterna Reasoning (piensa qué hacer) y Acting (llama tool). Base de casi todos los agentes.
- **HITL (Human-in-the-Loop)** — pedir confirmación humana antes de acciones destructivas o irreversibles.
- **Prompt injection** — instrucción maliciosa (directa o indirecta vía documento externo) que sobrescribe el system prompt.
- **OWASP LLM Top 10** — lista de riesgos de seguridad específicos de LLM (2025).
- **Guardrail** — filtro/regla externa al modelo (input o output) que bloquea contenido tóxico, PII, jailbreaks. NeMo, Guardrails AI, Bedrock Guardrails.
- **Sandboxing** — aislar la ejecución de código/tools generados por LLM en contenedor sin acceso a filesystem/red del host.
- **LoRA (Low-Rank Adaptation)** — fine-tuning eficiente que solo entrena matrices de bajo rango (adapters). 100x más barato que full fine-tune.
- **Destilación** — entrenar un modelo pequeño usando outputs de uno grande como labels.
- **RLHF / DPO** — Reinforcement Learning from Human Feedback / Direct Preference Optimization. Métodos de alignment.
- **SLO (Service Level Objective)** — objetivo medible (p95 latency < 800 ms, error rate < 1%) contra el que se opera.
- **SDD (Spec-Driven Development)** — escribir la spec como artefacto principal, dejar que el agente regenere el código desde la spec.
- **GEO (Generative Engine Optimization)** — SEO para respuestas de IA: cómo hacer que Perplexity, ChatGPT, Google AI Overview te citen.
- **AEO (Answer Engine Optimization)** — variante de GEO más enfocada a respuestas directas.
- **PII (Personally Identifiable Information)** — datos personales (nombre, email, DNI, IP, etc). Regulados por GDPR y otros.
- **EU AI Act** — regulación europea (2024, enforcement escalonado 2025-2027) que clasifica sistemas IA por riesgo.
- **Streaming (SSE)** — Server-Sent Events, protocolo unidireccional server→cliente estándar para tokens en tiempo real.
- **Bedrock** — servicio managed de AWS para llamar modelos foundation (Claude, Nova, Llama, Mistral) vía API unificada.
- **SageMaker** — plataforma AWS para entrenar y desplegar modelos custom (incluye JumpStart, HyperPod).
- **vLLM** — servidor de inferencia open-source de alto throughput (PagedAttention, continuous batching).
