# Capítulo 09 — Evals: datasets, LLM-as-judge, regression tests

> **Focus:** Cómo diseñar el CI/CD de aplicaciones LLM: golden datasets, LLM-as-judge (biases y mitigaciones), regression tests en CI, evals de RAG (retrieval y generación), correlación juez-humano, comparativa de frameworks 2026 (RAGAS, DeepEval, promptfoo, Braintrust, LangSmith, Inspect AI).
> **Áreas:** Evals + observabilidad
> **Preguntas:** 20 · **Tiempo:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

### Pre-requisitos

- Capítulo 03 (prompting y structured output) — para entender qué producen tus prompts.
- Capítulo 05 (RAG) — para el bloque de retrieval/generation metrics.
- Capítulo 08 (agentes) — para el apartado de evals de trajectory.
- Familiaridad básica con GitHub Actions o CI equivalente (GitLab CI, CircleCI).
- Python 3.11+ o Node 20+ para los ejemplos.

### Glosario mínimo

- **Golden dataset**: colección curada de `(input, expected_output|rubric)` versionada en git.
- **LLM-as-judge**: LLM que puntúa outputs contra una rúbrica (pointwise) o los compara (pairwise).
- **Pointwise**: cada output recibe score absoluto (ej. 1-5).
- **Pairwise**: se compara A vs B y se elige la mejor (o "tie").
- **Faithfulness**: métrica RAG que mide si la respuesta cita solo el contexto (anti-alucinación).
- **Regression test**: eval que corre en CI y bloquea el merge si el score baja del umbral.
- **Recall@k / MRR / nDCG**: métricas de retrieval; miden si el chunk correcto aparece en el top-k.
- **Adversarial eval**: prompts diseñados para romper el sistema (jailbreak, PII, contradicciones).

### Setup

```bash
# Python: RAGAS + promptfoo + DeepEval
pip install "ragas>=0.2" "deepeval>=2.0" "openai>=1.50" "anthropic>=0.40"

# promptfoo (CLI Node)
npm install -g promptfoo

# Inspect AI (UK AI Safety Institute, adoptado por muchos labs)
pip install inspect-ai

# Directorio de trabajo
mkdir -p evals/{datasets,configs,results}
```

---

## 1. El gran cuadro

En 2026 la disciplina de evals es lo que separa un producto LLM que **itera con confianza** de uno que "parece bien en 5 casos manuales". La mayoría de equipos que fracasan al escalar IA no fracasan por falta de talento en prompting: fracasan porque no pueden medir si un cambio mejora o empeora. Sin evals no hay iteración informada; iterar sin evals es superstición.

El problema es específicamente difícil en LLMs por tres razones. **Uno**, los outputs son largos, abiertos y probabilísticos: `assert output == expected` casi nunca sirve. **Dos**, los modelos base cambian por debajo (los providers actualizan `claude-sonnet-4.7`, `gpt-5.1`, sin previo aviso semántico); sin regression tests, un update silencioso rompe producción. **Tres**, la lógica del sistema tiene múltiples capas (retrieval, prompt, tools, post-process), y un fallo puede originarse en cualquiera; sin evals segmentados no sabes qué arreglar.

La solución madura tiene cuatro capas: **golden dataset** curado (50-500 casos, versionado en git), **métricas automáticas** cuando aplican (recall@k, exact match, faithfulness LLM-judged), **LLM-as-judge** calibrado para dimensiones subjetivas (utilidad, tono, correctness), y **regression tests en CI** que bloquean el merge si un cambio degrada el score core. Sobre esto se construyen **A/B tests en producción** para métricas que solo el tráfico real revela (satisfaction, conversion, task completion).

En 2026 el stack estándar es: **promptfoo** o **Inspect AI** para el CI (open-source, YAML-first), **RAGAS 0.2+** o **DeepEval** para métricas RAG específicas, **Braintrust** o **Langfuse** para el UI de diffs y experiment tracking cuando el equipo crece, y **Chatbot Arena / LMSYS-style** pairwise para comparar modelos/prompts con Elo. El paper *Judging LLM-as-a-Judge* de Zheng et al. (2023) y sus follow-ups (*Justice or Prejudice?*, 2024) documentan los sesgos que necesitas mitigar.

Este capítulo cubre cómo construir cada capa desde cero, cómo detectar y corregir los sesgos del juez, y cómo integrar todo en GitHub Actions. El ejemplo práctico completo (sección 5) monta un eval suite con promptfoo, tres test cases con LLM-as-judge, y un workflow que bloquea el PR si el score baja más del umbral.

---

## 2. Fundamentos (básico)

### 2.1 Golden dataset: la fuente de verdad

Un golden dataset es un archivo (JSON o CSV) en tu repo con `input` y `expected_output` (o `rubric`), curado a mano. Empieza con 30-50 casos que cubran tu tráfico real; crecerá a 200-500 con el tiempo.

**Analogía**: el golden dataset es la "batería de tests unitarios" de tu prompt. Igual que no harías merge de un cambio en `calculateInvoice()` sin pasar los tests, no deberías cambiar un prompt sin pasar el golden set. La diferencia: los tests unitarios son binarios (pass/fail), los evals son graduales (score 0-5, threshold configurable).
