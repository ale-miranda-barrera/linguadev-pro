# Capítulo 15 — Cuándo NO entrenar: prompting vs RAG vs LoRA vs destilación

> **Focus:** Decisión arquitectónica: cuándo cada técnica. RAG para conocimiento fresco, fine-tuning para estilo/formato, destilación para reducir coste, prompting para lo demás. LoRA/QLoRA, RLHF vs DPO, evaluación pre/post, open-weights vs closed.
> **Áreas:** Model strategy · Cost & inference
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de LLMs (tokens, context window, sampling; ver [cap 01 — LLM basics](./01-fundamentos-tokens-contexto.md)).
- Uso de APIs de proveedores cerrados (OpenAI, Anthropic; ver [cap 02 — prompting](./01-fundamentos-tokens-contexto.md)).
- Conocer RAG a nivel básico (embeddings, vector DB, retrieval; ver [cap 06 — RAG](./03-vector-dbs-hybrid-reranking.md)).
- Python 3.11+, `pip`/`uv`, familiarity con Hugging Face `transformers` y `datasets`.
- Ideal: haber ejecutado un fine-tune trivial (aunque sea "hola mundo") o al menos leído el walkthrough oficial de Hugging Face.

**Glosario mínimo:**
- **SFT** (Supervised Fine-Tuning): entrenamiento supervisado del modelo con pares `{input, output_deseado}`.
- **PEFT** (Parameter-Efficient Fine-Tuning): familia de métodos que entrenan solo un subconjunto pequeño de parámetros — LoRA, QLoRA, DoRA, Adapters, IA3, Prompt Tuning.
- **LoRA** (Low-Rank Adaptation): descompone la actualización de una matriz de pesos `W` en `W + BA`, con `A ∈ R^{r×k}` y `B ∈ R^{d×r}`, rank `r` pequeño (8, 16, 32).
- **QLoRA**: LoRA sobre modelo base cuantizado a 4-bit (NF4), permite entrenar 70B en ~48 GB VRAM.
- **DoRA** (Weight-Decomposed LoRA, 2024): descompone en magnitud + dirección; suele igualar full FT con mismo presupuesto que LoRA.
- **Destilación** (knowledge distillation): un modelo pequeño (student) aprende a imitar las salidas de un modelo grande (teacher) en una tarea concreta.
- **RLHF**: Reinforcement Learning from Human Feedback (PPO + reward model entrenado con preferencias humanas).
- **DPO** (Direct Preference Optimization): reformula RLHF como optimización supervisada directa sobre pares `{preferred, rejected}`.
- **RAG**: Retrieval-Augmented Generation. Inyecta contexto recuperado en el prompt.
- **Catastrophic forgetting**: degradación de capacidades no representadas en el dataset de fine-tune.

**Setup mínimo (Google Colab o máquina con GPU ≥ 16 GB VRAM):**

```bash
# Entorno base
python -m venv .venv && source .venv/bin/activate      # macOS/Linux
# .\.venv\Scripts\Activate.ps1                          # Windows PowerShell

# Stack de fine-tuning verificado a 2026
pip install --upgrade pip
pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
pip install "transformers>=4.46" "datasets>=3.0" "trl>=0.12" "peft>=0.19" \
            "bitsandbytes>=0.44" "accelerate>=1.0" "sentencepiece>=0.2"

# Para evals y logging
pip install "wandb>=0.18" "lm-eval>=0.4.5" "ragas>=0.2"

# Verificar GPU
python - <<'PY'
import torch
print("CUDA disponible:", torch.cuda.is_available())
print("GPU:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU only")
PY
```

Si trabajas en Colab, elige runtime T4 (gratis) para modelos ≤ 8B con QLoRA o A100 (Pro+) para hasta 34B. Para 70B se requiere entorno pagado (Runpod H100, Modal, Together fine-tune API).

---

## 1. El gran cuadro

Cuando un modelo no hace lo que quieres, la respuesta instintiva de muchos equipos es "entrenamos uno propio con nuestros datos". Es casi siempre la respuesta equivocada. En 2026 hay cuatro herramientas para modificar el comportamiento de un LLM y cada una resuelve un problema distinto: **prompt engineering** cambia instrucciones sin tocar el modelo, **RAG** añade conocimiento en tiempo de inferencia, **fine-tuning** modifica los pesos para transferir estilo o comportamiento, y **destilación** copia la habilidad de un modelo grande a uno pequeño. Elegir la incorrecta cuesta semanas, dinero y, lo peor, deja al equipo pensando que "la IA no funciona para nosotros".

El heurístico central es preguntarse por la naturaleza del problema. Si el modelo *no sabe algo*, no hace falta entrenarlo: probablemente el dato es dinámico (SKUs, precios, políticas) y quedará desactualizado el día siguiente al fine-tune. La respuesta es **RAG**. Si el modelo *sabe pero lo dice mal* (formato inconsistente, tono equivocado, ignora estructuras), el problema es de estilo y **fine-tuning** con pocos cientos de ejemplos canónicos suele resolverlo. Si el modelo *funciona pero es demasiado caro o lento*, la técnica es **destilación**: un teacher grande enseña a un student pequeño la tarea concreta que te importa. Y si nada de lo anterior aplica, **prompting** —con structured outputs, few-shot, chain-of-thought y prompt caching— suele bastar.

La revolución de 2023-2024 en fine-tuning viene de dos frentes complementarios. Por un lado, **PEFT** (LoRA y QLoRA sobre todo) democratizó el fine-tune: entrenar Llama 3.1-8B con 5000 ejemplos cuesta menos de treinta dólares en 2026 usando Unsloth en Colab. Por otro lado, la evidencia empírica del paper **LIMA** ("Less Is More for Alignment", Meta 2023) demostró que 1000 ejemplos cuidados superan a 50 000 mediocres. La consecuencia práctica es enorme: la barrera no es la infra, es la curación de datos. Un equipo con paciencia y un dataset limpio puede lograr resultados que hace tres años requerían infraestructura de laboratorio.

El alignment post-SFT también cambió. **RLHF** (Reinforcement Learning from Human Feedback) fue la técnica de OpenAI y Anthropic para alinear modelos con preferencias humanas, pero requería infra de RL (PPO, reward model separado) que muy pocas organizaciones podían operar. En 2023 aparece **DPO** (Direct Preference Optimization), que reformula el mismo objetivo como optimización supervisada directa sobre pares `{preferred, rejected}`, sin RL y sin reward model. En 2024 se convirtió en el estándar de facto (Llama 3, Zephyr, Tulu, OpenHermes usan variantes: IPO, KTO, ORPO). RLHF sigue vivo en frontier labs, pero para el 99% de equipos, DPO es la respuesta correcta.

Este capítulo cierra con dos temas transversales: la elección entre modelos **open-weights** (Llama 3.3, Mistral, DeepSeek V3/R1, Qwen 2.5, Gemma 2) y **closed** (Claude, GPT, Gemini), y el concepto de **sovereign AI** (autonomía de infraestructura y datos). Ambas discusiones son estratégicas y afectan no solo el stack técnico sino la compliance, el coste a escala y la capacidad de fine-tune profundo.

---

## 2. Fundamentos (nivel básico)

### 2.1 La matriz de decisión

Antes de escribir una sola línea de código, un equipo debería poder responder a esta pregunta: **¿qué categoría de problema tengo?** La matriz siguiente es el diagrama mental que todo ingeniero de IA debería memorizar:

| Síntoma | Causa raíz | Técnica correcta | Antipatrón |
|---|---|---|---|
| "No conoce nuestros productos / documentos" | Falta conocimiento | **RAG** | Fine-tune con SKUs (queda obsoleto) |
| "Sabe pero contesta con formato malo / tono raro" | Estilo inconsistente | **Fine-tune (LoRA)** | Prompts kilométricos con reglas |
| "Funciona pero cuesta $50k/mes" | Modelo sobredimensionado | **Destilación** | Cambiar de vendor sin más |
| "No sigue las instrucciones bien" | Prompt subóptimo | **Prompt engineering** | Fine-tune para "que obedezca" |
| "Alucina hechos" | Falta grounding | **RAG + citations** | Fine-tune (empeora la confianza) |
| "Necesita razonar step-by-step" | Falta estructura | **CoT / reasoning models** | Fine-tune para "pensar" |

Ejemplo concreto: un PM dice "el chatbot inventa precios de nuestros productos, entrenemos un modelo custom". La cadena de razonamiento correcta es (1) los precios cambian semanalmente → fine-tune obsoleto en días, (2) el modelo no accede a la fuente autoritativa → RAG con API de catálogo. Cero fine-tune, dos días de trabajo.

### 2.2 Prompt engineering: lo primero, siempre

Antes de considerar RAG o fine-tune, agota estas técnicas en orden de eficacia:

1. **Structured outputs / JSON schema estricto**. OpenAI `response_format: {type: "json_schema"}`, Anthropic tool use con schema, Gemini `responseSchema`. Garantiza validez sintáctica.
2. **Few-shot**. Tres a cinco ejemplos del formato exacto. Anthropic recomienda envolverlos en XML: `<example><input>...</input><output>...</output></example>`.
3. **Roles claros en system prompt**. "Eres un revisor legal. Devuelves exclusivamente..."
4. **Chain-of-thought** si la tarea requiere razonamiento. `<thinking>...</thinking><answer>...</answer>`.
5. **Delimitadores explícitos** (XML, JSON, `###`) para separar entradas.
6. **Auto-verification**: pide al modelo que revise su output antes de emitirlo.
7. **Prompt caching** (Anthropic, OpenAI) para amortizar system prompts largos.

Ejemplo mínimo con Anthropic + structured outputs:

```python
from anthropic import Anthropic

client = Anthropic()

response = client.messages.create(
    model="claude-opus-4-7",  # verificar id más reciente en la doc
    max_tokens=1024,
    system=(
        "Eres un extractor de tickets. Devuelves exclusivamente JSON con "
        "el schema {priority: 'low'|'med'|'high', category: str, summary: str}. "
        "Nunca comentarios adicionales."
    ),
    messages=[{
        "role": "user",
        "content": "Cliente enojado: la app crashea al abrir el chat. Impacto: 500 users."
    }],
)
print(response.content[0].text)
```

Si esto ya te da 95% de accuracy en el formato, no hay nada más que hacer. Fine-tune sería overkill.

### 2.3 RAG: para conocimiento nuevo, fresco o dinámico

RAG (Retrieval-Augmented Generation) es la técnica correcta cuando el modelo necesita **datos que no tenía en training o que cambian con frecuencia**. Ejemplos canónicos:

- Catálogo de productos con precios (Notion, Shopify).
- Base de conocimiento interna corporativa (Slack de empresa, Confluence).
- Documentación técnica versionada (docs de un SaaS).
- Políticas legales y de compliance actualizadas trimestralmente.

Anti-caso: información generalista y estable ("¿qué es la fotosíntesis?" no requiere RAG; el modelo ya lo sabe).

Regla mental: **si mañana el dataset cambia, RAG. Si el estilo/formato no cambia, fine-tune está OK.**

### 2.4 Fine-tuning: para estilo, formato o comportamiento

Fine-tune brilla cuando:

- Necesitas un **formato de salida consistente** que los prompts largos no logran garantizar al 100%.
- Quieres **reducir tokens de system prompt** (200 tokens tras fine-tune vs 2000 antes) para bajar coste a volumen alto.
- El **estilo/tono/persona** es idiosincrático (tono corporativo específico, jerga de dominio).
- Tienes **~100-1000 ejemplos canónicos** de alta calidad.

Fine-tune NO es la respuesta cuando:

- El dato es dinámico.
- Solo tienes datos ruidosos (garbage in → garbage out).
- El objetivo es "que no alucine" (eso es RAG + grounding).
- Puedes conseguir el resultado con prompting bien optimizado.

### 2.5 Destilación: para bajar coste manteniendo calidad

Destilación teacher-student es una técnica establecida (Hinton 2015, Distil-BERT 2019) que colapsa un modelo grande caro en uno pequeño barato **para una tarea concreta**. El student no será tan bueno como el teacher en general, pero en la tarea específica alcanza 90-97% del rendimiento a 1/20 o 1/50 del coste.

Ejemplo típico: clasificar tickets de soporte con Claude Opus cuesta $0.05 por ticket a 100k/día = $5000/día. Destilar a Llama 3.1-8B fine-tuneado logra $50/día por el mismo trabajo con calidad casi idéntica.

### 2.6 Analogías mentales

- **Prompting = darle instrucciones a un consultor experto.** Rápido, sin re-entrenamiento; funciona para cualquier tarea que ya "sepa hacer" el modelo.
- **RAG = darle al consultor la biblioteca de tu empresa antes de responder.** No cambia al consultor, cambia lo que ve.
- **Fine-tuning = escuela particular para el modelo.** Modificas los pesos para que absorba estilo/formato específico. No añade conocimiento fresco (para eso, RAG).
- **Destilación = un maestro (teacher) enseñando a un estudiante (student).** El student memoriza cómo resolver una tarea concreta; no aprende la carrera entera. Barato de servir, limitado en generalización.
- **LoRA = post-it notes en un manual gigante.** El manual (modelo base) no se toca; sólo añades notas (matrices A/B) que el modelo consulta al leer. Puedes tener 100 sets de notas para 100 clientes/tareas.
- **DPO = ajustar preferencias sin RL.** Le enseñas al modelo "prefieres A sobre B" con pares directos, en vez de montar todo el pipeline RL (reward model + PPO).

### 2.7 Desglose paso a paso: ciclo de vida de un fine-tune LoRA

1. **Confirmar que fine-tune es la respuesta correcta.** Aplicar la matriz de §2.1. Si el problema es conocimiento fresco → RAG (STOP).
2. **Recolectar datos candidatos.** Logs de producción, exportes manuales, datasets sintéticos generados por teacher LLM. Volumen inicial: 500-2000 candidatos.
3. **Curar con proceso multi-etapa.** Filtro automático (longitud, idioma) → LLM judge score 0-10 → revisión humana top decile → reescritura canónica. Salida: 100-500 ejemplos oro.
4. **Split train/val estratificado** por categoría (80/20 o 90/10). Sin val no puedes detectar overfit.
5. **Formatear con chat template** del modelo base (Llama 3, Mistral, ChatML). Un token mal en el template rompe el training silenciosamente.
6. **Baseline eval PRE fine-tune.** Corre `lm-eval-harness` + tu eval propia sobre el modelo base. Guarda métricas.
7. **Training con QLoRA en Unsloth.** 1-3 epochs, lr 2e-4, cosine scheduler, warmup 3%, gradient checkpointing. En Colab T4 con 500 ejemplos: ~40-60 min.
8. **Eval POST fine-tune** con la misma suite del paso 6. Compara: delta en tarea target vs delta en benchmarks generales (catastrophic forgetting).
9. **Iterar** si el delta target es <5% de mejora o si hay regresión >5% en benchmark general. Ajusta rank, epochs, target modules, dataset.
10. **Deploy:** sube adapter a S3/HF Hub, sirve con vLLM multi-LoRA (100 adapters concurrentes en 1 GPU) o mergea con base y sirve como modelo estándar.

### 2.8 Mini-código: decisión programática RAG vs fine-tune

Antes de comprometerte, contesta con código:

```python
# should_finetune.py — heurística de decisión
def recommend(problem: dict) -> str:
    if problem["data_changes_weekly"]:
        return "RAG"                              # dato dinámico → nunca fine-tune
    if problem["style_matters"] and problem["examples_available"] >= 100:
        return "Fine-tune LoRA"
    if problem["cost_per_month_usd"] > 10_000 and problem["task_narrow"]:
        return "Destilación teacher→student"
    if not problem["prompt_optimized"]:
        return "Optimizar prompt PRIMERO (structured + few-shot + caching)"
    return "Prompting engineering + RAG selectivo"

# Ejemplo
print(recommend({
    "data_changes_weekly": False,
    "style_matters": True,
    "examples_available": 400,
    "cost_per_month_usd": 3000,
    "task_narrow": True,
    "prompt_optimized": True,
}))  # → "Fine-tune LoRA"
```

Simple y quirúrgico: 90% de los "queremos fine-tune" no pasan ni el primer if.

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 LoRA: la matemática básica

LoRA (Hu et al. 2021) parte de la observación de que la actualización de pesos durante el fine-tune tiene **rank bajo intrínseco**: no necesitas modificar los `d × k` parámetros de una matriz de atención completa, basta con una descomposición `ΔW = BA` donde `A ∈ R^{r×k}` y `B ∈ R^{d×r}`, con `r << min(d, k)`.

En el forward pass:

```
h = W·x + ΔW·x = W·x + B·A·x
```

Solo `A` y `B` se entrenan. Para Llama 3-8B con `r=16` sobre las proyecciones `q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj`, el número de parámetros entrenables baja de 8 000 000 000 a aproximadamente 40-80 millones (0.5-1%). El modelo base queda congelado, en 4-bit si usas QLoRA, ocupando la mayor parte de la VRAM sin actualizar.

**QLoRA** (Dettmers 2023) añade:
- Cuantización NF4 del modelo base (4-bit).
- Double quantization (cuantiza las constantes de cuantización).
- Paged optimizers (usa RAM del sistema como swap para gradientes).

Resultado: Llama 3-70B fine-tuneable en una sola H100 de 80 GB.

**DoRA** (Weight-Decomposed LoRA, 2024) descompone el peso en dirección y magnitud, entrenando ambas por separado con LoRA en la dirección. En benchmarks suele igualar full fine-tune con el mismo presupuesto que LoRA vanilla.

### 3.2 Tabla comparativa: full FT vs LoRA vs QLoRA vs DoRA

| Técnica | Parámetros entrenables | VRAM 8B (fp16) | VRAM 70B | Velocidad | Calidad relativa |
|---|---|---|---|---|---|
| Full fine-tune | 100% | ~80 GB | 4× H100 | 1× | 100% (baseline) |
| LoRA (r=16) | ~0.5% | ~24 GB | 2× H100 | 2-3× | 97-99% |
| QLoRA (4-bit + r=16) | ~0.5% | ~10 GB | 1× H100 | 1.5-2× | 96-98% |
| DoRA | ~0.6% | ~24 GB | 2× H100 | 2× | 99-100% |
| Full FT en Unsloth 2026 | 100% | ~40 GB (opt) | 2× H100 | 3-5× | 100% |

Los números son orientativos: dependen del rank, del subset de módulos target, de batch size, de gradient checkpointing, y de si usas Unsloth (2-5× más rápido y ~30% menos VRAM que HuggingFace vanilla).

### 3.3 Diagrama ASCII: pipeline canónico de fine-tune

```
                     [DATASET RAW]
                          │
                          ▼
                 ┌──────────────────┐
                 │  1. Curación     │  filter, dedup, revisar,
                 │     humana       │  reescribir outputs
                 └──────────────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │  2. Split        │  train / val (80/20 o 90/10)
                 │     estratifi-   │  balance por clase/dominio
                 │     cado         │
                 └──────────────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │  3. Formateo     │  chat template del modelo
                 │     chat template│  (Llama-3, Mistral, ChatML)
                 └──────────────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │  4. Training     │  LoRA/QLoRA/DoRA
                 │     (Unsloth)    │  lr 2e-4, 3 epochs, bs 4
                 └──────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
          [ADAPTER]   [MERGED]    [GGUF]
          para vLLM   para       para
          multi-LoRA  serving    Ollama/
                      simple     llama.cpp
                          │
                          ▼
                 ┌──────────────────┐
                 │  5. Evaluación   │  eval suite pre/post:
                 │     pre/post     │  - tarea target
                 │                  │  - benchmarks generales
                 │                  │  - safety
                 └──────────────────┘
                          │
                          ▼
                     [DEPLOY]
```

### 3.4 Datasets: calidad sobre cantidad

El paper **LIMA** (Meta, 2023) es probablemente el resultado más importante para practitioners: entrenaron Llama-1 65B con solo 1000 ejemplos cuidadosamente seleccionados y obtuvieron resultados equiparables a modelos entrenados con datasets masivos. Conclusión: **la calidad domina sobre la cantidad**.

Pipeline de curación recomendado:

1. **Recolectar candidatos** (logs de producción, datasets sintéticos, expertos humanos).
2. **Filtrado automático**: longitud mínima, idioma correcto, dedup exacto (hash) y near-dup (MinHash).
3. **Filtrado por calidad**: LLM judge (Claude, GPT-4) puntúa cada ejemplo 0-10 en corrección, formato, tono. Descartar <7.
4. **Revisión humana** del top decile: un anotador revisa 200-500 ejemplos, corrige outputs.
5. **Reescritura a canonical form**: outputs con formato exacto, sin variaciones estilísticas.
6. **Split train/val** estratificado (80/20 o 90/10) por categoría.
7. **Augmentation opcional**: usar teacher LLM para expandir 200 → 1000 con variaciones controladas.

Herramientas: `argilla` (etiquetado colaborativo), `cleanlab` (detección de errores), `Label Studio`, `LlamaFactory` (UI para todo el pipeline).

### 3.5 RLHF, DPO, RLAIF, Constitutional AI: elegir el alineamiento

Después del SFT viene el alineamiento con preferencias:

- **RLHF** (Christiano 2017, InstructGPT 2022): entrenar reward model desde pares humanos `{preferred, rejected}`, luego optimizar la política con PPO maximizando la recompensa. Complejo, inestable, requiere infra RL. Sigue vivo en OpenAI/Anthropic.
- **DPO** (Rafailov et al. 2023): matemáticamente equivalente a RLHF pero sin RL. Loss supervisada directa sobre pares. Adopción masiva desde 2024. Es el default para cualquier equipo que no tenga MLOps de RL.
- **IPO** (Identity-PO): variante de DPO más estable en datos ruidosos.
- **KTO** (Kahneman-Tversky Optimization): funciona con binary feedback (`good` / `bad`) sin pares, más práctico cuando no tienes rejected explícito.
- **ORPO** (Odds Ratio PO): combina SFT y preference learning en un solo objetivo, ahorrando una pasada.
- **RLAIF** (RL from AI Feedback): usa un LLM juez en vez de humanos. Escala barato pero introduce el sesgo del juez.
- **Constitutional AI** (Anthropic 2022): el modelo se auto-critica según una "constitución" de principios, generando preferencias sin humanos.

Tabla resumen:

| Técnica | Complejidad | Datos requeridos | Cuándo usarla |
|---|---|---|---|
| RLHF (PPO) | Alta | Pares humanos + reward model | Frontier labs, dominios críticos |
| DPO | Baja | Pares `{preferred, rejected}` | Default 2026 |
| IPO | Baja | Pares (más robusto a ruido) | Datasets ruidosos |
| KTO | Baja | Feedback binario | Cuando no tienes rejected explícito |
| ORPO | Baja | Pares (ahorra fase SFT) | Datasets pequeños |
| RLAIF | Media | Prompts + LLM juez | Escalar sin humanos |
| Constitutional AI | Media | Principios + auto-crítica | Cuando no puedes usar labels humanos |

### 3.6 Herramientas 2026: ecosistema PEFT

- **Unsloth v2026.7+**: motor optimizado (2-5× más rápido que HF TRL), soporte FP8, Full-FT to GGUF, Studio no-code, MoE LoRA. Requiere GPU NVIDIA (o AMD MI50/Radeon VII para casos limitados). Es el default para práctica en 2026.
- **PEFT (Hugging Face)**: librería canónica con LoRA, DoRA, IA3, prompt-tuning. PEFT 0.19+ soporta reload de LoRA en varios formatos.
- **TRL (Hugging Face)**: `SFTTrainer`, `DPOTrainer`, `RewardTrainer`, `KTOTrainer`, `ORPOTrainer`, `PPOTrainer`.
- **Axolotl**: framework config-driven (YAML), popular en la comunidad open.
- **LlamaFactory**: UI Gradio para entrenamiento visual.
- **Together AI fine-tune API**: managed, LoRA/full, precios por token de training.
- **OpenAI fine-tune**: GPT-4o mini y GPT-4o (verificar disponibilidad), fine-tune server-side.
- **Anthropic fine-tune**: Haiku fine-tune en Bedrock (custom models).
- **Predibase, Fireworks, OctoAI**: hosting managed de LoRA adapters con multi-tenant.

### 3.7 Comparación cost: prompting con Sonnet vs fine-tune LoRA de Llama 3.1-8B servido

La pregunta más común en 2026: "¿me sale a cuenta fine-tunear?" Depende del volumen. Cuentas realistas para clasificación de tickets a 100k/día:

| Escenario | Setup | Coste/mes @ 100k req/día |
|---|---|---:|
| **Sonnet 4.6 vanilla (prompting)** | 3k in + 200 out por request | ~$3,000 |
| **Sonnet 4.6 + prompt caching** | Cache 90% del prompt | ~$1,100 |
| **Haiku 4.5 vanilla (routing simple)** | 3k in + 200 out | ~$550 |
| **Haiku 4.5 + caching** | Cache 90% | ~$220 |
| **Llama 3.1-8B fine-tune LoRA (auto-host EKS + vLLM)** | 1× g6e.12xlarge $6.85/h | ~$5,000/mes infra + $50-200 fine-tune (one-shot) |
| **Llama 3.1-8B fine-tune LoRA (Together AI managed)** | $0.20/M in + $0.60/M out | ~$700 |
| **DeepSeek V4 Flash (destilación no propia)** | $0.14/M in + $0.28/M out | ~$150 |

Lecciones:
- **A volumen bajo (<10k/día)**, prompting con Haiku + caching gana; el overhead de MLOps no compensa.
- **A volumen medio (10k-100k/día)**, fine-tune managed (Together, Fireworks, Predibase) suele ser el sweet spot.
- **A volumen alto (>500k/día)** + tarea narrow, auto-host o destilación pueden bajar bill 10-50x.
- **DeepSeek** cambia la ecuación en 2026: precios agresivos hacen que casos "obvios de fine-tune" ahora sean "sólo si además del coste, necesitas control de weights o offline".

### 3.8 Bajo el capó — qué pasa dentro de un fine-tune LoRA

Cuando corres el bucle de training de un fine-tune LoRA, ocurre esto en cada step:

**Forward pass.** El batch de ejemplos pasa por el modelo base congelado en 4-bit (QLoRA). Cada capa lineal proyectada por atención (`q_proj`, `k_proj`, `v_proj`, `o_proj`) o MLP (`gate_proj`, `up_proj`, `down_proj`) suma la contribución del adapter LoRA: `h = W·x + (α/r)·B·(A·x)`. Nota el escalado `α/r`: es un hyperparameter clave; típico `α=2r`. El modelo base emite logits y calculas la loss (cross-entropy sobre next-token prediction).

**Backward pass.** Aquí está la magia de LoRA: los gradientes se calculan sólo respecto a los pesos entrenables (`A` y `B`), no respecto a `W`. Como `A` es `r×k` y `B` es `d×r` con `r=16`, para Llama-8B con 32 capas × 7 módulos entrenables, hablamos de ~40M parámetros vs 8B del full. Menos VRAM en gradientes (~150MB vs ~32GB), menos VRAM en optimizer states (AdamW guarda 2 estados por parámetro), menos ancho de banda GPU-CPU.

**Optimizer step.** AdamW-8bit (via `bitsandbytes`) actualiza `A` y `B` usando gradientes + momenta acumulados. El modelo base **nunca se toca**: los pesos originales quedan en HBM en 4-bit, inmutables.

**Checkpoint.** Guardas solo `A` y `B` (~120MB para Llama-8B con r=16). El checkpoint del modelo base no existe — sigue siendo el mismo que descargaste.

**Serving.** En inferencia, cargas el modelo base una vez en GPU + los adapters específicos por cliente/tarea (multi-LoRA en vLLM). Cada request especifica qué adapter usar; vLLM hace hot-swap en microsegundos. Puedes servir 100 clientes con 1 modelo base y 100 adapters en la misma GPU, vs 100 modelos completos que requerirían 100 GPUs.

**Merge (opcional).** Si prefieres no gestionar adapters, puedes hacer `merged_W = W + (α/r) · B · A` y guardar el modelo fusionado. Ocupa lo mismo que el base, sirve como cualquier modelo estándar, pero pierdes multi-tenancy y facilidad de A/B testing entre adapters.

**Por qué funciona (intuición matemática):** el paper de Hu et al. 2021 argumentó que la actualización de pesos durante el fine-tune tiene **rank bajo intrínseco**: no necesitas modificar los `d×k` parámetros de una matriz de atención completa, la información nueva vive en un subespacio de dimensión pequeña. LoRA parametriza directamente ese subespacio via la descomposición `BA` con rank `r << min(d,k)`. Empíricamente, `r=8-32` captura el 95-99% del efecto del full fine-tune para tareas de estilo/formato/dominio.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Multi-LoRA serving

Un solo modelo base + N adaptadores LoRA permite servir múltiples clientes / tareas con una fracción del coste de N modelos separados. **vLLM** y **TGI** soportan multi-LoRA out-of-the-box: cargas 100 adaptadores, cada request especifica cuál usar, el motor hace hot-swap.

```python
# vLLM con multi-LoRA
from vllm import LLM, SamplingParams
from vllm.lora.request import LoRARequest

llm = LLM(
    model="meta-llama/Meta-Llama-3.1-8B-Instruct",
    enable_lora=True,
    max_loras=16,          # cuántos adaptadores concurrentes en GPU
    max_lora_rank=32,
    dtype="bfloat16",
)

lora_customer_A = LoRARequest("customer_a", 1, "/adapters/customer_a")
lora_customer_B = LoRARequest("customer_b", 2, "/adapters/customer_b")

outputs = llm.generate(
    ["Resume este email: ..."],
    sampling_params=SamplingParams(temperature=0.3, max_tokens=256),
    lora_request=lora_customer_A,   # o B según request
)
```

Casos reales: Predibase, Fireworks y OctoAI ofrecen exactamente este patrón como producto.

### 4.2 Catastrophic forgetting y capability regression

Fine-tunear un modelo en dataset específico puede **degradar** capacidades no representadas. Ejemplo real: entrenas para clasificación de tickets y descubres semanas después que el modelo perdió habilidad de escribir código o razonar sobre matemáticas.

Prevención:

- **Eval suite amplia pre/post fine-tune** que cubra:
  - Tarea target (tu métrica de negocio).
  - Capacidades adyacentes al dominio (razonamiento, lenguaje, código).
  - Safety benchmarks (BeaverTails, AdvBench, ToxicChat).
  - Benchmarks generales (MMLU, HellaSwag, TruthfulQA, IFEval).
- **Menos epochs** (típico 1-3 para SFT; más causa overfitting).
- **Learning rate bajo** (2e-5 a 2e-4 según tamaño de modelo).
- **LoRA en vez de full FT** (menos parámetros modificados = menos daño colateral).
- **Rehearsal / replay**: mezcla 5-10% de datos generales (OpenHermes, Ultrachat) para preservar capacidades base.
- **Regularización** (early stopping, weight decay).

### 4.3 Anti-patrones frecuentes

| ❌ Antipatrón | ✅ Alternativa |
|---|---|
| Fine-tune para "que sepa nuestro producto" | RAG sobre catálogo con embeddings |
| Fine-tune con 50k ejemplos ruidosos | Curar 500 excelentes |
| Full fine-tune de Llama 70B en la primera iteración | LoRA/QLoRA primero, escalar si hace falta |
| Entrenar más epochs "por si acaso" | 1-3 epochs + eval; overfit degrada |
| Evaluar solo en la tarea target | Eval suite amplia con regresiones |
| Bajar temperature a 0 para "no alucinar" | RAG + grounding + citations |
| Meter 500 páginas de guías en system prompt cada request | RAG con re-embedding cuando cambien |
| Destilar outputs de GPT-4 y venderlo como servicio | Leer TOS: OpenAI/Anthropic lo prohíben |
| Ignorar catastrophic forgetting | Evals pre/post en capacidades adyacentes |
| Comparar loss en vez de métrica de negocio | Métricas de tarea (accuracy, F1, latencia, coste) |

### 4.4 Hyperparámetros típicos (Llama 3.1-8B con LoRA)

```yaml
# axolotl-config.yaml (referencia)
base_model: meta-llama/Meta-Llama-3.1-8B-Instruct

adapter: lora
lora_r: 16                    # rank; 8-32 típico
lora_alpha: 32                # típicamente 2×rank
lora_dropout: 0.05
lora_target_modules:
  - q_proj
  - k_proj
  - v_proj
  - o_proj
  - gate_proj
  - up_proj
  - down_proj                 # todos los lineales, mejor calidad

learning_rate: 2.0e-4         # LoRA tolera lr más alto que full FT
lr_scheduler: cosine
warmup_ratio: 0.03

num_epochs: 3                 # 1-5; overfit >5 típico
micro_batch_size: 4
gradient_accumulation_steps: 4  # batch efectivo = 16
gradient_checkpointing: true
bf16: true
optimizer: adamw_torch_fused
weight_decay: 0.01

max_seq_length: 4096          # ajustar a tu dataset
sample_packing: true          # empaqueta secuencias cortas para eficiencia

save_strategy: epoch
eval_strategy: epoch
```

Para QLoRA añades:

```yaml
load_in_4bit: true
bnb_4bit_compute_dtype: bfloat16
bnb_4bit_use_double_quant: true
bnb_4bit_quant_type: nf4
```

### 4.5 Cost estimation realista (2026)

Fine-tune QLoRA 5000 ejemplos, ~1M tokens de training:

| Modelo | GPU típica | Tiempo | Coste on-demand |
|---|---|---|---|
| Llama 3.2-3B | 1× A10 24 GB | 30-60 min | $2-5 |
| Llama 3.1-8B | 1× A100 40 GB | 1-3 h | $5-20 |
| Mistral 7B | 1× A100 40 GB | 1-3 h | $5-20 |
| Llama 3.1-13B / Qwen 2.5-14B | 1× A100 80 GB | 2-4 h | $10-40 |
| Llama 3.3-70B (QLoRA) | 1× H100 80 GB | 4-8 h | $50-200 |
| Llama 3.1-405B | 8× H100 | 12-24 h | $600-1500 |

Proveedores on-demand: Runpod, Modal, Lambda Labs, Vast.ai, Together fine-tune API, Predibase. Managed suele añadir 30-100% premium por conveniencia.

---

## 5. Ejemplo práctico completo: fine-tune LoRA de Llama 3.1-8B con Unsloth

Objetivo: entrenar un adaptador LoRA sobre Llama 3.1-8B-Instruct para responder tickets de soporte en tono formal español (saludo + cuerpo + firma), con 500 ejemplos curados. Ejecutable en Google Colab con T4 (gratis).

```python
# =========================================================
# fine-tune Llama 3.1-8B con QLoRA en Unsloth (Colab T4)
# =========================================================

from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments
import torch

# 1) Cargar modelo base en 4-bit (QLoRA)
max_seq_length = 2048
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Meta-Llama-3.1-8B-Instruct-bnb-4bit",
    max_seq_length=max_seq_length,
    dtype=None,                # auto: bf16 en A100/H100, fp16 en T4
    load_in_4bit=True,
)

# 2) Añadir adaptadores LoRA
model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
    lora_alpha=32,
    lora_dropout=0.05,
    bias="none",
    use_gradient_checkpointing="unsloth",   # 30% menos VRAM
    random_state=42,
    use_rslora=False,
    loftq_config=None,
)

# 3) Cargar y formatear dataset (chat template Llama-3)
raw = load_dataset("json", data_files="tickets_curados_500.jsonl", split="train")

def formatting_func(example):
    # cada example: {"ticket": "...", "respuesta": "..."}
    messages = [
        {"role": "system", "content":
            "Eres un agente de soporte. Responde en español, tono formal, "
            "empieza con saludo cortés y cierra con firma 'Atentamente, Equipo Soporte'."},
        {"role": "user", "content": example["ticket"]},
        {"role": "assistant", "content": example["respuesta"]},
    ]
    return tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=False
    )

# 4) Configurar trainer
trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=raw,
    dataset_text_field=None,
    formatting_func=formatting_func,
    max_seq_length=max_seq_length,
    packing=True,                       # empaqueta ejemplos cortos
    args=TrainingArguments(
        output_dir="./lora_soporte_v1",
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,  # batch efectivo = 8
        warmup_ratio=0.03,
        num_train_epochs=3,
        learning_rate=2e-4,
        fp16=not torch.cuda.is_bf16_supported(),
        bf16=torch.cuda.is_bf16_supported(),
        logging_steps=10,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="cosine",
        seed=42,
        report_to="none",               # "wandb" si quieres tracking
    ),
)

# 5) Entrenar
stats = trainer.train()
print(f"Loss final: {stats.training_loss:.4f}")

# 6) Guardar adaptador LoRA
model.save_pretrained("lora_soporte_v1")
tokenizer.save_pretrained("lora_soporte_v1")

# 7) Inferencia rápida
FastLanguageModel.for_inference(model)     # 2x más rápido
prompt = tokenizer.apply_chat_template(
    [
        {"role": "system", "content":
            "Eres un agente de soporte. Responde en español, tono formal..."},
        {"role": "user", "content":
            "Mi app se cierra al abrir chat. Pierdo mensajes. Necesito ayuda urgente."},
    ],
    tokenize=False, add_generation_prompt=True,
)
inputs = tokenizer(prompt, return_tensors="pt").to("cuda")
out = model.generate(**inputs, max_new_tokens=300, temperature=0.3)
print(tokenizer.decode(out[0], skip_special_tokens=True))

# 8) Exportar a GGUF para llama.cpp/Ollama (opcional)
# model.save_pretrained_gguf("lora_soporte_v1_gguf", tokenizer, quantization_method="q4_k_m")

# 9) Merge adapter → modelo base fusionado (opcional, para deploys sin PEFT)
# merged = model.merge_and_unload()
# merged.save_pretrained("llama-8b-soporte-merged")
```

**Notas prácticas:**

- Con 500 ejemplos y 3 epochs, la corrida completa toma ~40-60 min en T4 gratis.
- Loss final típica: 0.6-1.2 dependiendo de dispersión del dataset.
- Si loss <0.3, sospecha overfit: revisa val loss o reduce epochs.
- El adaptador ocupa ~120 MB (vs ~16 GB del modelo base). Puedes tener docenas.
- Para producción, sube el adaptador a HuggingFace Hub o S3 y cárgalo con `PeftModel.from_pretrained(base, "hf-user/lora_soporte_v1")` o servido con vLLM multi-LoRA.

**Eval post-entrenamiento (esqueleto):**

```python
# Comparar base vs fine-tuned en 50 ejemplos hold-out
from datasets import load_dataset

holdout = load_dataset("json", data_files="tickets_holdout_50.jsonl", split="train")

def score_output(model_output: str, ideal: str) -> float:
    # Rúbrica simple: formato, tono, corrección semántica
    checks = {
        "saludo": model_output.strip().startswith(("Estimado", "Estimada", "Buenos días")),
        "firma":  "Atentamente" in model_output,
        "es_español": all(w in model_output.lower() for w in ["por favor", "gracias"]) or True,
        "longitud_razonable": 100 <= len(model_output) <= 800,
    }
    return sum(checks.values()) / len(checks)
# ... loop de generación + scoring sobre base y fine-tune
```

### 5.1 Por qué cada decisión — narrativa detrás del código

- **Por qué Unsloth y no HF TRL vanilla:** Unsloth reescribe kernels de attention/MLP en Triton con optimizaciones custom (fused ops, sequence packing). Resultado: 2-5× más rápido y ~30% menos VRAM que HF TRL vanilla con misma calidad. En Colab T4 gratis, esto es la diferencia entre "cabe" y "OOM".
- **Por qué QLoRA 4-bit en vez de LoRA 16-bit:** el modelo base ocupa 4× menos VRAM en 4-bit (Llama-8B: 4GB vs 16GB). Deja espacio para batch size mayor y gradientes de adapter. Calidad final: ~1-2% peor que LoRA-16bit, invisible en la mayoría de tareas.
- **Por qué target modules "todos los lineales":** el paper original de LoRA (2021) probó con solo `q_proj + v_proj`. La comunidad descubrió (2023) que añadir `k, o, gate, up, down` mejora consistencia en tareas de estilo. Coste extra: ~0.2% más parámetros entrenables. ROI positivo.
- **Por qué 3 epochs y no 10:** con 500 ejemplos, 3 epochs = 1500 pasadas de gradient. Más causa overfitting (val loss sube). Regla empírica: si val loss deja de bajar tras epoch 2, para. Si nunca bajó, tu dataset tiene problemas.
- **Por qué lr=2e-4 y no 5e-5:** LoRA tolera lr 5-10× mayor que full fine-tune porque las matrices A/B parten de ruido pequeño (`A` normal, `B=0`). Con lr muy bajo, no converges en tiempo razonable.

### 5.2 Verificación intermedia — checks durante y después del training

```python
# checks.py
def sanity_check_training(trainer_state) -> None:
    """Llamar cada N steps o al final."""
    losses = [log["loss"] for log in trainer_state.log_history if "loss" in log]
    if len(losses) < 5:
        return
    # 1) Loss debe descender los primeros steps
    if losses[-1] > losses[0]:
        raise RuntimeError(f"Loss subió: {losses[0]:.3f} → {losses[-1]:.3f}. Revisa lr o dataset.")
    # 2) Loss final no debe ser <0.1 (overfit)
    if losses[-1] < 0.1:
        print(f"[WARN] Loss muy baja ({losses[-1]:.3f}): sospecha overfit.")
    # 3) Curva debe ser suave (no oscilar)
    from statistics import stdev
    if stdev(losses[-10:]) > 0.3 * losses[-1]:
        print("[WARN] Loss oscila mucho: baja lr o sube gradient accumulation.")

# Uso: trainer.state expone log_history
sanity_check_training(trainer.state)
```

Y post-training, antes de deploy:

```python
def eval_gate(base_model, ft_model, test_set, min_improvement: float = 0.05) -> bool:
    """No deployes si no mejoras al menos min_improvement puntos."""
    base_score = evaluate(base_model, test_set)
    ft_score = evaluate(ft_model, test_set)
    if ft_score - base_score < min_improvement:
        print(f"[REJECT] mejora insuficiente: base={base_score:.3f} ft={ft_score:.3f}")
        return False
    # Chequeo de regresión en benchmark general
    from lm_eval import evaluator
    base_mmlu = evaluator.simple_evaluate(base_model, tasks=["mmlu"])["results"]["mmlu"]["acc"]
    ft_mmlu   = evaluator.simple_evaluate(ft_model,   tasks=["mmlu"])["results"]["mmlu"]["acc"]
    if base_mmlu - ft_mmlu > 0.05:
        print(f"[REJECT] regresión MMLU: {base_mmlu:.3f} → {ft_mmlu:.3f}")
        return False
    return True
```

### 5.3 Extendiendo el ejemplo — 3 mejoras para producción

**Mejora 1: DPO post-SFT para refinar preferencias.** Tras el SFT del §5, corre 1 epoch de DPO con 100-200 pares `{chosen, rejected}` donde `chosen` refleja mejor el tono target. Costo extra: ~15 min en T4. Ganancia típica: +5-10% en rúbrica de estilo.

```python
from trl import DPOTrainer, DPOConfig

dpo_trainer = DPOTrainer(
    model=model,                          # el SFT del §5
    ref_model=None,                       # None = auto ref implícita
    args=DPOConfig(
        output_dir="./dpo_soporte_v1",
        per_device_train_batch_size=2,
        num_train_epochs=1,
        learning_rate=5e-7,               # ¡órdenes menor que SFT!
        beta=0.1,                          # implicit reward strength
    ),
    train_dataset=preference_dataset,     # cols: prompt, chosen, rejected
    tokenizer=tokenizer,
)
dpo_trainer.train()
```

**Mejora 2: Multi-LoRA serving con vLLM (economics ganadora).** En vez de mergear el adapter en el base, sirve `base + 100 adapters` con vLLM enable-lora. Cada tenant tiene su LoRA, cambio en microsegundos.

```python
from vllm import LLM, SamplingParams
from vllm.lora.request import LoRARequest

llm = LLM("meta-llama/Meta-Llama-3.1-8B-Instruct", enable_lora=True, max_loras=100, max_lora_rank=32)
outputs = llm.generate(
    ["Ticket: mi app se cierra..."],
    SamplingParams(temperature=0.3, max_tokens=300),
    lora_request=LoRARequest("cliente_A", 1, "/adapters/cliente_A"),
)
```

**Mejora 3: rehearsal para prevenir catastrophic forgetting.** Mezcla 10% de datos generales (OpenHermes-2.5, Ultrachat-200k) con tu dataset target. Ganancia: el modelo mantiene capacidades de conversación general mientras adopta el estilo target.

```python
from datasets import load_dataset, concatenate_datasets
target = load_dataset("json", data_files="tickets_curados_500.jsonl", split="train")
general = load_dataset("HuggingFaceH4/ultrachat_200k", split="train_sft").shuffle(seed=42).select(range(50))
mixed = concatenate_datasets([target, general]).shuffle(seed=42)
# ...usar `mixed` en SFTTrainer
```

Con las 3 mejoras: modelo mejor calibrado, servido eficientemente para N clientes, sin regresión en capacidades base.

---

## 6. Cheatsheet, reglas mentales y anti-patrones

### 6.1 Tabla de decisión rápida

| Problema | Técnica primaria | Complemento |
|---|---|---|
| Conocimiento nuevo/fresco/dinámico | **RAG** | grounding + citations |
| Estilo/formato/tono consistente | **Fine-tune LoRA** | few-shot como fallback |
| Reducir coste de modelo grande | **Destilación** | evals rigurosos |
| Sigue mal las instrucciones | **Prompt engineering** | structured outputs |
| Alucinaciones | **RAG + citations** | prompt "di no sé si no encuentras" |
| Razonamiento complejo | **Reasoning model (o1/o3)** | CoT en prompt |
| Latencia mala | Modelo pequeño / destilación | vLLM continuous batching |
| Contexto muy largo repetido | **Prompt caching** | RAG selectivo |

### 6.2 Reglas mentales

- **La primera respuesta a "necesito fine-tune" es "primero optimicemos el prompt".** El 70% de los casos se resuelven con prompt engineering.
- **La segunda respuesta es "¿es un problema de conocimiento?".** Si sí, RAG antes que fine-tune.
- **Solo entrena si tienes 100+ ejemplos limpios y el estilo/formato es genuinamente idiosincrático.**
- **Empieza con LoRA (r=16, α=32) sobre todos los lineales.** Full FT solo si LoRA se queda corto.
- **1-3 epochs suele ser suficiente.** Más causa overfitting.
- **Eval suite amplia PRE y POST.** Sin baseline, no sabes si mejoraste o empeoraste.
- **Data quality > data quantity.** 500 excelentes > 50 000 ruidosos.
- **Destilación es el "gran secreto" para bajar costes.** Poco usada, muy efectiva.
- **DPO es el default de alignment en 2026.** RLHF solo si tienes MLOps de RL.
- **Nunca entrenes para "que no alucine".** Alucinación es un problema arquitectónico (RAG), no de pesos.

### 6.3 Anti-patrones ✅/❌

✅ Empezar con prompt engineering + few-shot antes de nada.
✅ Curar 300 ejemplos que 3 humanos revisaron.
✅ Usar QLoRA para probar hipótesis rápido y barato.
✅ Correr eval suite amplia PRE y POST fine-tune.
✅ Documentar hyperparams, dataset version y métricas en cada corrida.
✅ Empezar con modelo pequeño (7-8B) antes de escalar.
✅ Usar prompt caching para amortizar system prompts largos.
✅ Preferir DPO sobre RLHF si no eres un frontier lab.
✅ Preferir destilación sobre fine-tune cuando el objetivo es bajar coste.
✅ Validar TOS de teachers antes de destilar en modelos comerciales.

❌ "Entrenamos un modelo custom con nuestros datos" sin distinguir qué problema resuelves.
❌ Fine-tune con SKUs / precios / catálogos (queda obsoleto).
❌ Full fine-tune Llama 70B en la primera iteración.
❌ Meter todo en system prompt (dilution + coste).
❌ Evaluar solo tu tarea target (pierdes regresiones invisibles).
❌ Reusar hyperparams de un blog sin validar en tu dataset.
❌ Ignorar catastrophic forgetting.
❌ Destilar outputs de GPT-4 y venderlo (revisa TOS).
❌ Fine-tunear para "que sea más creativo" (temperature ajusta esto).
❌ Confundir loss baja con calidad alta.

---

## 7. Casos reales industria 2026

### 7.1 Notion AI: RAG sobre workspace del usuario
- **Qué pasó:** Notion añadió AI features (Q&A, summarize, autofill) a millones de workspaces con documentos privados por cliente.
- **Cómo se detectó como problema:** fine-tune per-tenant era inviable (millones de tenants); usar un modelo compartido "sabía" nada del contenido del usuario.
- **Cómo se arregló:** RAG multi-tenant sobre Claude/GPT compartido. Cada workspace tiene sus embeddings; el retrieval inyecta contexto en runtime; el modelo base nunca cambia.
- **Aprendizaje industrial:** RAG multi-tenant es la arquitectura dominante en SaaS de IA. Fine-tune per-tenant es antipatrón salvo en enterprise con corpus >100k docs y contrato de exclusividad.

### 7.2 Klarna: fine-tune de estilo + rollback parcial (2024-2026)
- **Qué pasó:** Klarna deployó asistente AI para ~90% de queries de servicio al cliente en 2024, con fine-tune LoRA sobre Llama para tono/formato consistente en múltiples idiomas (con RAG sobre catálogo para datos frescos). Claim inicial: "reemplaza 700 humanos".
- **Cómo se detectó problema:** métricas de NPS en 2025 mostraron degradación en edge cases (disputas complejas, multi-idioma raro, situaciones emocionales).
- **Cómo se arregló:** recontrataron parcialmente humanos para triage/escalado; el bot sigue manejando el "easy path" pero con handoff explícito a humano en categorías identificadas por otro clasificador.
- **Aprendizaje:** fine-tune de estilo funciona; "reemplazar humanos al 100%" requiere edge case coverage que rara vez se alcanza con 800 ejemplos. Pattern dominante 2026: híbrido bot + human-in-the-loop.

### 7.3 Airtable + Claude Haiku fine-tune vía Bedrock (2024-2025)
- **Qué pasó:** Airtable quería el "AI Blocks" con Claude Haiku para clasificar/etiquetar records, pero necesitaba consistencia de formato que el prompting variable no daba al 99%.
- **Cómo se detectó:** telemetry mostraba 3-5% de outputs mal formateados; con volumen (millones de records), 3% = miles de errores/día.
- **Cómo se arregló:** Anthropic Bedrock custom models — fine-tune de Haiku 3.5 con ~2000 ejemplos server-side, sin exponer weights. Consistencia formato subió a 99.7%.
- **Aprendizaje:** managed fine-tune (Bedrock custom models, OpenAI fine-tuning, Together) reduce fricción vs auto-host. Trade-off: precio 20-40% más alto que Haiku vanilla, sin capacidad de mover weights fuera del vendor.

### 7.4 Perplexity Sonar: destilación agresiva + open-weights (2024-2026)
- **Qué pasó:** Perplexity servía todas las queries con Claude/GPT frontier — coste insostenible a volumen search-scale (billones de queries/año).
- **Cómo se detectó:** unit economics per-query = -$0.02 en free tier, -$0.005 en pro.
- **Cómo se arregló:** entrenaron "Perplexity Sonar" — modelo destilado (teacher: Claude Opus + GPT-4; student: Llama 70B fine-tuneado) especializado en search-first RAG con citations. Para queries frontier (código, matemática) sigue routing a Claude/GPT.
- **Aprendizaje:** destilación + routing por complejidad es el patrón económico dominante para apps con volumen enorme + tarea narrow (search, chat FAQ, classification).

### 7.5 DeepSeek R1: destilaciones oficiales cambian el mercado (2025-2026)
- **Qué pasó:** DeepSeek publicó V3 (dic 2024) y R1 (ene 2025) con licencias permisivas y coste 90% menor que GPT-4o. Publicaron **destilaciones oficiales** (R1-Distill-Llama-8B, R1-Distill-Qwen-14B) que capturan el razonamiento del modelo grande.
- **Cómo se detectó impacto:** en Q1 2025, adopción en HuggingFace saltó a top-3 downloads. Startups migraron partes del pipeline a DeepSeek + destilación.
- **Cómo se arregló (industria):** frontier vendors bajaron precios (75% en algunos tiers), aceleraron caching, y ofrecieron destilaciones oficiales (Claude Haiku 3.5, GPT-5 nano).
- **Aprendizaje:** destilación oficial (teacher share sus destilaciones) es un movimiento defensivo eficaz. Cambia la economía del ecosistema — un frontier lab con distill oficial captura mercado que iría a auto-hosted.

### 7.6 GPT-4o → Llama 3.1-8B destilación en fintech (2025)
- **Qué pasó:** una fintech (caso anonimizado en blog Anyscale 2025) clasificaba transacciones con GPT-4o a $0.08/req × 500k/día = $40k/día.
- **Cómo se detectó:** unit economics negativos en tier freemium.
- **Cómo se arregló:** destilaron con teacher GPT-4o generando labels en 100k transacciones; entrenaron Llama 3.1-8B con LoRA sobre esos labels; serving en EKS + vLLM.
- **Resultado:** coste bajó a $0.008/req (10×), accuracy 96% (vs 97% del teacher). Payback del fine-tune: 2 días.
- **Aprendizaje:** cuando (a) task es narrow, (b) volumen >100k/día, (c) tolerancia a -1% accuracy, destilación es el default económico.

---

## 8. Ejercicios prácticos

### 8.1 Ejercicio: matriz de decisión aplicada a tu proyecto

**Objetivo.** Clasificar 5 problemas reales de tu producto en las categorías correctas (RAG / fine-tune / destilación / prompt).

**Setup.**
- Lista 5 features actuales o planeadas de tu producto que involucren LLM.
- Documenta síntoma observado y datos disponibles.

**Pasos.**
1. Para cada feature, escribe una descripción de 1-2 líneas del comportamiento esperado.
2. Identifica el síntoma (¿no sabe?, ¿lo dice mal?, ¿es caro?, ¿lento?).
3. Aplica la matriz del §2.1 y elige técnica primaria + complementos.
4. Justifica cada elección en 2-3 frases.
5. Estima coste y tiempo de implementación para cada uno.

**Criterios de aceptación.**
- [ ] 5 features clasificadas.
- [ ] Ninguna dice "fine-tune para que sepa X" (ese sería RAG).
- [ ] Ninguna dice "RAG para cambiar tono" (ese sería fine-tune).
- [ ] Justificación explícita por qué NO las otras técnicas.

**Bonus.** Comparte con un colega senior y compara respuestas.

**Hints:**
- Si dudas entre RAG y fine-tune, pregúntate: "¿mañana los datos cambian?" → RAG. "¿el output está bien pero mal formateado?" → fine-tune.
- Nunca combines "fine-tune para conocimiento" y "prompt caching de KB grande" — ambas cubren el mismo problema mal.
- Costo de fine-tune ≠ costo de mantenerlo: cada trimestre re-evalúa datos + re-entrena si drift.

---

### 8.2 Ejercicio: fine-tune LoRA reproducible en Colab

**Objetivo.** Correr el walkthrough del §5 con dataset propio de al menos 100 ejemplos y reportar métricas pre/post.

**Setup.**
- Colab gratuito con T4 o Runpod con A10.
- Dataset JSONL con `{"input": "...", "output": "..."}` mínimo 100 filas.
- Cuenta HuggingFace (para descargar modelo base).

**Pasos.**
1. Crear tu dataset JSONL curado (mínimo 100, ideal 300-500).
2. Ejecutar 20 requests de ejemplo contra el modelo base y guardar outputs.
3. Correr el script del §5 adaptado a tu dataset.
4. Ejecutar los mismos 20 requests contra el modelo fine-tuneado.
5. Comparar cualitativamente y cuantitativamente (rúbrica 1-5 en formato, tono, corrección).
6. Registrar hyperparams y loss curve.

**Criterios de aceptación.**
- [ ] Fine-tune completa sin OOM.
- [ ] Loss desciende suavemente (curva monotónica).
- [ ] Al menos 15/20 outputs post- son mejores según la rúbrica.
- [ ] Adaptador guardado y probado con `PeftModel.from_pretrained`.

**Bonus.** Sube el adaptador a HuggingFace Hub y compártelo.

---

### 8.3 Ejercicio: eval suite pre/post fine-tune

**Objetivo.** Detectar catastrophic forgetting midiendo capacidades adyacentes al dominio.

**Setup.**
- Modelo fine-tuneado del ejercicio anterior.
- Instalar `lm-eval-harness`.

**Pasos.**
1. Correr `lm-eval` sobre modelo base con tasks: `mmlu`, `hellaswag`, `truthfulqa_mc2`, `arc_challenge`.
2. Correr la misma suite sobre modelo fine-tuneado.
3. Correr tu eval propia de la tarea target en ambos.
4. Producir tabla comparativa base vs fine-tune.
5. Interpretar: ¿mejora en target? ¿regresión en generales?

**Criterios de aceptación.**
- [ ] 4 benchmarks generales ejecutados en ambos.
- [ ] Métrica de tarea propia definida y ejecutada.
- [ ] Tabla comparativa con delta absoluto y %.
- [ ] Análisis escrito: ¿es aceptable la regresión (si la hay)?

**Bonus.** Añade un benchmark de safety (BeaverTails o AdvBench) y reporta.

---

### 8.4 Ejercicio: destilación teacher-student

**Objetivo.** Destilar clasificación de sentimiento de Claude Sonnet a Llama 3.2-3B.

**Setup.**
- API key Anthropic (o alternativa: GPT-4o mini vía OpenAI).
- Dataset de 2000 textos sin labels.
- Colab con A100 o T4.

**Pasos.**
1. Enviar 2000 textos al teacher con prompt: "clasifica en positivo/neutro/negativo".
2. Guardar `{texto, label_teacher}` como dataset destilado.
3. Fine-tunear Llama 3.2-3B con LoRA sobre ese dataset.
4. Preparar test set de 200 textos con labels humanos.
5. Medir accuracy del student vs teacher vs modelo base sin fine-tune.
6. Calcular coste por 1M inferencias en ambos.

**Criterios de aceptación.**
- [ ] Student alcanza ≥90% del accuracy del teacher.
- [ ] Coste por inferencia del student es ≥20× más barato.
- [ ] Comparativa documentada con métricas y latencias.
- [ ] TOS del teacher verificado (permite uso de outputs para training propio).

**Bonus.** Prueba con temperature=0 en el teacher y compara. Documenta el efecto en accuracy del student.

---

### 8.5 Ejercicio: DPO sobre modelo fine-tuneado

**Objetivo.** Aplicar DPO sobre el modelo del §8.2 para mejorar preferencias de tono.

**Setup.**
- Modelo LoRA del §8.2.
- Dataset de preferencias: 100 pares `{prompt, chosen, rejected}` donde `chosen` sigue mejor el estilo target.
- TRL `>=0.12`.

**Pasos.**
1. Preparar el dataset como HuggingFace Dataset con columnas `prompt`, `chosen`, `rejected`.
2. Cargar el modelo fine-tuneado + tokenizer.
3. Configurar `DPOTrainer` con `beta=0.1`, `learning_rate=5e-7`, 1 epoch.
4. Entrenar.
5. Comparar 20 outputs pre-DPO vs post-DPO con rúbrica de estilo.

**Criterios de aceptación.**
- [ ] DPO completa sin errores.
- [ ] Los outputs post-DPO reflejan mejor los `chosen` en al menos 15/20 casos.
- [ ] Sin regresión en capacidades generales (correr mini-eval).
- [ ] Comparativa documentada.

**Bonus.** Repite con KTO (feedback binario) sobre el mismo dataset expandido y compara resultados.

---

### 8.6 Ejercicio RETO: destilar Claude Sonnet 4.5 → Llama 3.1-8B con ROI positivo

**Objetivo.** Reproducir el patrón del caso 7.6: destilar un modelo frontier en un modelo pequeño servido, con métricas de ROI documentadas.

**Setup.**
- Tarea narrow: clasificación de emails en {support, sales, spam, other}.
- 5000 emails sin labels.
- Colab con A100 (Pro+) o RunPod A10.
- API keys de Anthropic (teacher) + HF (base model).

**Pasos.**
1. **Generar dataset destilado:** enviar 5000 emails a Claude Sonnet 4.5 con prompt "clasifica en 4 categorías. Responde SOLO la categoría." Guardar `{email, label_teacher}`.
2. **Curar:** filtrar respuestas malformadas del teacher (~2-5% típico). Split 4500/500.
3. **Fine-tune LoRA de Llama 3.1-8B** con Unsloth, 2 epochs, dataset destilado.
4. **Eval en test set humano** (200 emails labeled manualmente): accuracy teacher vs student vs base.
5. **Modelar cost:**
   - Sonnet: $3 in + $15 out por MTok → ~$0.0006/email = $0.6/1k emails.
   - Llama fine-tune en Together AI: $0.20 in + $0.60 out → ~$0.00005/email = $0.05/1k emails.
6. **Producir tabla** con accuracy, latency p50, coste por 1M inferencias.

**Criterios:**
- [ ] Student alcanza ≥93% del accuracy del teacher.
- [ ] Coste por inferencia ≥10× menor.
- [ ] Payback documentado (a qué volumen de emails/día compensa el fine-tune inicial).
- [ ] Verificado que TOS del teacher permite training con outputs (Anthropic Business Tier lo permite; consumer, ambiguous).
- [ ] Adaptador serviciable con vLLM multi-LoRA.

**Hints:**
- Con Anthropic, usa Batch API para generar los 5000 labels: 50% descuento y evitas rate limits.
- Balancea el dataset final por clase; si teacher da 80% "other", entrenas un modelo que dice "other" siempre.
- Compara `temperature=0` (teacher determinista) vs `temperature=0.3` en generación de labels; determinista mejora consistencia del student.

**Solución de referencia (esbozo):**
```python
# 1. Generar labels con teacher (batch)
requests = [{"custom_id": f"email-{i}", "params": {"model": "claude-sonnet-4-5",
    "max_tokens": 10, "messages": [{"role":"user","content": f"Clasifica: {email}"}]}}
    for i, email in enumerate(emails)]
batch = anthropic_client.messages.batches.create(requests=requests)
# ... esperar, extraer labels

# 2. Preparar dataset chat template
dataset = Dataset.from_dict({"text": [format_chat(e, l) for e, l in zip(emails, labels)]})

# 3. Fine-tune Unsloth
model, tokenizer = FastLanguageModel.from_pretrained("unsloth/Meta-Llama-3.1-8B-Instruct-bnb-4bit")
model = FastLanguageModel.get_peft_model(model, r=16, ...)
trainer = SFTTrainer(model=model, train_dataset=dataset, ...)
trainer.train()

# 4. Serve + benchmark
llm = LLM("meta-llama/Meta-Llama-3.1-8B-Instruct", enable_lora=True)
# medir p50 latency + accuracy vs test set humano
```

---

## 9. Recursos y siguientes pasos

**Papers fundacionales:**
- Hu et al. (2021), "LoRA: Low-Rank Adaptation of Large Language Models".
- Dettmers et al. (2023), "QLoRA: Efficient Finetuning of Quantized LLMs".
- Zhou et al. (2023), "LIMA: Less Is More for Alignment".
- Rafailov et al. (2023), "Direct Preference Optimization".
- Hinton et al. (2015), "Distilling the Knowledge in a Neural Network".
- Bai et al. (2022), "Constitutional AI: Harmlessness from AI Feedback" (Anthropic).
- Liu et al. (2024), "DoRA: Weight-Decomposed Low-Rank Adaptation".

**Documentación oficial:**
- Unsloth: `https://unsloth.ai/docs`
- Hugging Face PEFT: `https://huggingface.co/docs/peft`
- TRL (SFT/DPO/KTO/ORPO): `https://huggingface.co/docs/trl`
- Axolotl: `https://github.com/OpenAccess-AI-Collective/axolotl`
- Meta Llama Recipes: `https://github.com/meta-llama/llama-recipes`
- OpenAI fine-tuning guide: `https://platform.openai.com/docs/guides/fine-tuning`
- Anthropic prompting guide: `https://docs.anthropic.com/claude/docs/prompt-engineering`

**Blogs y guías 2025-2026:**
- Predibase blog: benchmarks de cost/perf de LoRA en distintos modelos.
- Together AI cookbook: fine-tune managed.
- Anthropic Bedrock custom models docs.
- Hugging Face "Open LLM Leaderboard" para tracking del estado del arte open.

**Herramientas para evals:**
- `lm-eval-harness` (EleutherAI): benchmarks estándar.
- `Ragas`: evals de RAG.
- `Braintrust`, `Langfuse evals`, `Weave`: LLM-as-judge orquestado.
- `IFEval`: instruction-following benchmark.

**Siguientes pasos naturales:**
- [Cap 16 — Infra IA en AWS: Bedrock, SageMaker, vLLM](./16-ai-infra-aws-bedrock-sagemaker.md) — donde deployeas los modelos que fine-tuneaste.
- [Cap 09 — Evals & LLM-as-judge](./09-evals-datasets-llm-judge.md) — eval suites rigurosos.
- [Cap 19 — Data pipelines, PII, EU AI Act](./19-data-pipelines-pii-eu-ai-act.md) — gobernanza de los datos que usaste para fine-tune.

---

## 10. Preguntas de práctica

Simulacro completo de 20 preguntas con explicaciones, casos reales y referencias:

- JSON del simulacro: `packages/content/src/tech/ai-programming/sim-15-prompting-vs-rag-vs-finetuning.json`
- Ruta en la app: `/tech/ai-programming/simulacro/15-prompting-vs-rag-vs-finetuning`

Tiempo: 25 min. Pass: 75%. Cubre las áreas de model strategy y cost/inference.

---

## Navegación

← [Cap 14 — Agents y tool use](./07-agent-loops-orchestration.md) · [Índice AI programming](./README.md) · [Cap 16 — Infra IA en AWS →](./16-ai-infra-aws-bedrock-sagemaker.md)
