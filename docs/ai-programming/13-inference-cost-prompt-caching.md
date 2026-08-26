# Capítulo 13 — Economía de inferencia: costos, prompt caching, batching

> **Focus:** Input/output pricing asimétrico, prompt caching (Anthropic explícito, OpenAI/Gemini automático), Batch API 50% descuento, semantic caching, model tiers, cost tracking por feature/user, budget kill-switch, unit economics de un producto LLM sostenible en 2026.
> **Áreas:** Economía + inferencia
> **Preguntas:** 20 · **Tiempo:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

### Pre-requisitos

- **Capítulo 04** — RAG básico (chunks, embeddings, retrieval) [→](./02-rag-embeddings-chunking.md)
- **Capítulo 07** — Timeouts, retries, circuit breakers [→](./07-agent-loops-orchestration.md)
- **Capítulo 10** — LLM observability y tracing [→](./10-llm-observability-tracing.md)

### Glosario mínimo

| Término | Significado |
|---|---|
| **MTok** | 1 millón de tokens. Unidad estándar de pricing 2026. |
| **TTFT** | Time To First Token — latencia hasta el primer token del stream. |
| **Cache write** | Primera escritura del prefijo en el cache. Cuesta 1.25x-2x el input normal (Anthropic). |
| **Cache read** | Hit sobre prefijo ya cacheado. Cuesta ~0.1x el input normal. |
| **Ephemeral cache** | Marca de Anthropic para bloques cacheables con TTL corto (5 min o 1h). |
| **Batch API** | Envío async de N requests en un JSONL, procesado en <24h con 50% de descuento. |
| **Reasoning tokens** | Tokens de "pensamiento interno" facturados aparte (o1/Claude thinking/DeepSeek R1). |
| **Unit economics** | Coste marginal por request / user / conversation vs revenue. |

### Setup

```bash
# Cliente Python de Anthropic (2026, v0.40+)
pip install "anthropic>=0.40.0" python-dotenv

# Cliente OpenAI
pip install "openai>=1.60.0"

# Para tracing y cost tracking
pip install langfuse tiktoken

# Variables de entorno
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
```

---

## 1. El gran cuadro

La diferencia entre una app LLM sostenible y una que quema efectivo está casi enteramente en decisiones de **economía de inferencia**. Los mismos usuarios, el mismo modelo, el mismo prompt pueden costar **10x más o 10x menos** según cómo estructures. En 2026 esto ya no es teoría: casos públicos como el ajuste de tiers de Cursor (2025), Klarna reevaluando su "AI agent replaza 700 humanos", o Notion documentando reducciones de 80% al mover system prompt a bloques cacheables demuestran que el diseño de coste **es** el producto.

Hay cuatro palancas mayores. La primera es entender que **input y output son asimétricos**: casi todos los providers cobran el output 3-5x más caro que el input, porque generar (autoregresivo, un token a la vez) es más caro que procesar el prompt en batch (prefill). Un chat de 10k tokens de input + 300 de output cuesta más por el output que por el input aunque el input sea 30x más largo. Diseñar respuestas cortas (con `max_tokens`, instrucciones de brevedad, structured output) tiene ROI directo.

La segunda es **prompt caching**. Anthropic (GA desde agosto 2024) permite marcar bloques como `cache_control: {type: "ephemeral"}`; el primer request paga 1.25x el input por "write", los siguientes 0.1x del input por "read" — hasta **90% de descuento** en el prefijo cacheado. OpenAI (octubre 2024) hace lo mismo pero automático para prefixes ≥1024 tokens, con descuento ~50% en GPT-4o y hasta 90% en la familia GPT-5. Google Gemini tiene implicit caching automático y explicit caching con TTL configurable. En chatbots con system prompt de 15-30k tokens el ahorro típico es 60-80% del bill total.

La tercera es **Batch API**: -50% en input y output a cambio de latencia hasta 24h. Ideal para evals, embeddings masivos, extracción offline, generación de resúmenes nocturnos. Cualquier task que tolere "esta noche" que no lo use está regalando el 50% del gasto.

La cuarta es **model routing por tier**. La proporción Opus-vs-Haiku en 2026 es ~5-30x en coste según modelo. Usar el top tier para todo (clasificación, resumen trivial, chat de FAQ) multiplica el gasto sin ganancia de calidad. Un router que envía queries triviales a Haiku 4.5 / Nova Micro / GPT-5 nano y reserva Opus / GPT-5 para razonamiento reduce el bill medio 60-80%.

Y encima de todo eso: **cost tracking por feature/user** (tags por request), **budget kill-switch** (aborta si feature supera X€/día), **cost anomaly alerts** (CloudWatch, Vantage, CloudZero), **volume discounts** al escalar, **semantic caching** para FAQs, y sobre todo **unit economics** — coste por conversación / task / usuario / MRR. Sin esa métrica el producto opera con margen desconocido, y en 2026 eso equivale a operar sin brújula.

---

## 2. Fundamentos (básico)

### 2.1. Pricing público de las familias de modelos (agosto 2026)

Los precios se mueven cada trimestre; los que siguen son los publicados oficialmente en agosto 2026 (verificar siempre en la página del provider antes de decidir arquitectura).

| Modelo | Input $/MTok | Output $/MTok | Cached read $/MTok | Notas |
|---|---:|---:|---:|---|
| **Claude Opus 4.7 / 4.8** | 5.00 | 25.00 | 0.50 | Anthropic top tier, 1M ctx, 128K output |
| **Claude Sonnet 4.6** | 3.00 | 15.00 | 0.30 | Mid tier estándar de producción |
| **Claude Haiku 4.5** | 1.00 | 5.00 | 0.10 | Fast tier — clasificación, routing |
| **GPT-5.5** | 5.00 | (según tier) | 0.50 | Reasoning-first flagship |
| **GPT-5.4** | 2.50 | (según tier) | 0.25 | Balance calidad/precio |
| **GPT-4o** (legacy) | 2.50 | 10.00 | 1.25 | Legacy, sustituido por familia 5.x |
| **Gemini 3.6 Flash** | 1.50 | 7.50 | 0.15 | Google flagship Flash 2026 |
| **Gemini 3.5 Flash-Lite** | 0.30 | 2.50 | 0.03 | Ultra-cheap tier |
| **DeepSeek V4 Flash** | 0.14 | 0.28 | 0.014 | Open-weights hosted API, 1M ctx |
| **DeepSeek V4 Pro** | 0.435 | 0.87 | 0.044 | Tras 75% price cut de 2026 |
| **Llama 3.3 70B** (Bedrock) | 0.72 | 0.72 | — | Same-price in/out |

Ratio Opus/Haiku: ~5-25x según qué compares. Ratio Gemini Flash-Lite vs Opus: ~80x. Elegir modelo mal cuesta orden de magnitud.

**Regla mental:** el output es la palanca más cara. Un prompt de 10k tokens + 500 de output con Sonnet 4.6 cuesta `3·0.01 + 15·0.0005 = $0.0375`. Si la respuesta crece a 3000 tokens: `$0.03 + $0.045 = $0.075`, el doble. Reducir el output es más impactante que recortar el prompt en la mayoría de features de chat.

### 2.2. Input vs output pricing — ejemplo mínimo

```python
# Cálculo de coste de una request individual
from dataclasses import dataclass

@dataclass
class Pricing:
    input_per_mtok: float
    output_per_mtok: float
    cached_read_per_mtok: float = 0.0

SONNET_46 = Pricing(3.00, 15.00, 0.30)

def cost(input_tokens: int, output_tokens: int, cached_tokens: int, p: Pricing) -> float:
    fresh_input = max(input_tokens - cached_tokens, 0)
    return (
        (fresh_input * p.input_per_mtok
         + cached_tokens * p.cached_read_per_mtok
         + output_tokens * p.output_per_mtok) / 1_000_000
    )

# Sin cache
print(cost(10_000, 500, 0, SONNET_46))       # ~$0.0375
# Con 8000 tokens cacheados
print(cost(10_000, 500, 8_000, SONNET_46))   # ~$0.0159  (-58%)
# Respuesta larga sin cache
print(cost(10_000, 3_000, 0, SONNET_46))     # ~$0.075
```

### 2.3. Prompt caching — la palanca #1

**Anthropic** requiere marcar explícitamente los bloques con `cache_control: {type: "ephemeral"}`. TTL default 5 min (write cuesta 1.25x el input); extended 1h (write cuesta 2x). El cache es por prefijo: cualquier cambio en tokens tempranos invalida todo lo posterior.

**OpenAI** es automático: si el prefijo ≥1024 tokens ya se vio recientemente, aplica el descuento sin config (~50% en GPT-4o, hasta 90% en GPT-5 series). Puedes trackear hits via `usage.prompt_tokens_details.cached_tokens`.

**Google Gemini** implementa dos modos: implicit caching (automático desde 2024) y explicit caching (control fino de TTL).

Regla estructural: **ordena el prompt de estable a variable**. Malo: `[user query] → [system prompt]`. Bueno: `[system prompt estable] → [tools estables] → [documentos RAG] → [historial] → [user query]`. Solo lo primero se cachea.

### 2.4. Batch API — 50% de descuento gratuito

Cualquier task que tolere "termina esta noche": evals nocturnos, embeddings masivos, extracción de N documentos, generación de resúmenes offline. Envías un JSONL con requests, el provider los procesa en <24h (usualmente mucho menos), pagas la mitad. Sin streaming.

Anthropic: [Message Batches API](https://docs.anthropic.com/en/docs/build-with-claude/batch-processing). OpenAI: [Batch API](https://platform.openai.com/docs/guides/batch).

### 2.5. Model tiers — cheap-first, escala si es necesario

La regla en 2026 es: **cada tier tiene su lugar**. Haiku 4.5 / Gemini Flash-Lite / GPT-5 nano para clasificación, extracción simple, routing, agent steps triviales. Sonnet 4.6 / GPT-5.4 / Gemini 3.6 Flash para chat serio y RAG mid. Opus 4.7-4.8 / GPT-5.5 / Gemini 3 Pro solo para razonamiento crítico, planning multi-step complejo, decisiones donde un error cuesta más que 10x el token.

### 2.6. Analogías mentales que ayudan

- **Prompt caching = cache HTTP para prompts.** Igual que un CDN sirve `main.js` desde memoria en vez de regenerarlo, el LLM reutiliza el KV-cache del prefijo. Cambia un byte del prefijo (como cambiar una query-string en una URL) y el cache se invalida entero.
- **Batch API = envío por correo postal vs mensajero.** Aceptas 24h de latencia y pagas la mitad. Ideal para "no urgente" (evals nocturnos, embeddings, resúmenes offline).
- **Model routing = triage en urgencias hospitalarias.** Una enfermera (Haiku) clasifica al paciente y solo escala al especialista (Opus) si el caso lo justifica. Ahorra tiempo y coste sin degradar la atención en el 80% de casos.
- **Reasoning tokens = borradores tirados a la papelera.** Los pagas aunque nunca los veas, igual que un abogado te cobra por horas de investigación que no aparecen en el informe final.

### 2.7. Desglose paso a paso: primera llamada con caching (Anthropic)

Cómo procesa Anthropic un request con `cache_control`, paso a paso:

1. **Recibe el request.** Parsea la lista `system` y detecta bloques con `cache_control: {"type": "ephemeral"}`.
2. **Calcula el hash del prefijo** (tokens del bloque más todo lo anterior). El hash es determinista.
3. **Busca el hash en el cache regional del cluster** (Redis-like key-value store en GPU host).
4. **Cache MISS (primera vez):** ejecuta prefill completo, guarda el KV-cache asociado al hash, factura `cache_creation_input_tokens` a 1.25x el input normal (TTL 5min) o 2x (TTL 1h).
5. **Cache HIT (2ª llamada en <5min con mismo prefijo):** salta el prefill, carga el KV-cache, factura `cache_read_input_tokens` a 0.1x. TTFT baja significativamente.
6. **Genera output** (facturado normal, streaming token a token).
7. **Devuelve `usage`** con desglose: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`.

Regla derivada: **el segundo request es cuando empieza el ROI**. Con TTL 5min, un chat activo mantiene el hit; un chat esporádico paga write repetidamente. Usa TTL 1h para sesiones largas o KB compartida entre usuarios (2x el write, pero amortiza durante toda la hora).

### 2.8. Mini-código: estimar coste antes de llamar

Antes de disparar producción, estima el coste esperado con `tiktoken` (o cualquier tokenizer aproximado):

```python
# estimate_cost.py — estimación rápida ex-ante
import tiktoken

enc = tiktoken.encoding_for_model("gpt-4o")  # aprox universal
def n_tokens(text: str) -> int:
    return len(enc.encode(text))

def estimate_sonnet(prompt: str, expected_out: int, cached_share: float = 0.0) -> dict:
    in_tok = n_tokens(prompt)
    cached = int(in_tok * cached_share)
    fresh  = in_tok - cached
    cost_usd = (fresh * 3.0 + cached * 0.3 + expected_out * 15.0) / 1_000_000
    return {"input": in_tok, "cached": cached, "output": expected_out, "usd": round(cost_usd, 4)}

print(estimate_sonnet("A" * 40_000, expected_out=500, cached_share=0.0))
print(estimate_sonnet("A" * 40_000, expected_out=500, cached_share=0.8))
```

Útil para: presupuestos por feature, alertas pre-envío ("este request costaría $0.42, ¿confirmar?"), y para decidir modelo antes de la llamada.

---

## 3. Cómo funciona por dentro (medio)

### 3.1. Estructura del prompt para maximizar cache hit

El caching en todos los providers es **por prefijo binario**. Un solo carácter diferente en un token temprano invalida el cache de todo lo posterior. Consecuencia: la estructura correcta es rígida.

```text
┌────────────────────────────────────────┐  ← Estable (cache candidate)
│ 1. System prompt                       │
│ 2. Tool definitions (JSON schema)      │
│ 3. Few-shot examples                   │
├────────────────────────────────────────┤
│ 4. Documentos RAG por sesión           │  ← Estable dentro de la sesión
├────────────────────────────────────────┤
│ 5. Historial de la conversación        │  ← Crece; cachea hasta el turno N-1
├────────────────────────────────────────┤
│ 6. Mensaje del usuario actual          │  ← Variable siempre
└────────────────────────────────────────┘
```

**Anti-patrones fatales que rompen cache:**

- `Current date: 2026-08-13` en el system prompt → invalida cada día (o cada segundo si pones hora).
- `Request-ID: abc-123` como header en el prompt.
- Reordenar tools dinámicamente por usuario.
- Cambiar whitespace o punctuation.
- Serializar JSON con orden de claves distinto (Python `dict` vs OrderedDict, `sort_keys=True` inconsistente).

### 3.2. Anthropic prompt caching — implementación

```python
import anthropic

client = anthropic.Anthropic()

# System prompt estable con dos breakpoints de cache
response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=500,
    system=[
        {
            "type": "text",
            "text": "Eres el asistente de soporte de ACME. Sigue estas 200 reglas...",
            "cache_control": {"type": "ephemeral"}  # TTL 5 min por defecto
        },
        {
            "type": "text",
            "text": "Base de conocimiento (25k tokens): ...",
            "cache_control": {"type": "ephemeral", "ttl": "1h"}  # TTL extendido
        },
    ],
    messages=[
        {"role": "user", "content": "¿Cómo cancelo mi suscripción?"}
    ],
)

# Métricas útiles en la respuesta
usage = response.usage
print(f"Input tokens:            {usage.input_tokens}")
print(f"Cache creation tokens:   {usage.cache_creation_input_tokens}")  # write
print(f"Cache read tokens:       {usage.cache_read_input_tokens}")      # read (barato)
print(f"Output tokens:           {usage.output_tokens}")
```

En el segundo request con el mismo prefijo, `cache_read_input_tokens` será ~25000 y solo se paga 0.1x por ellos.

### 3.3. Comparativa de caching entre providers

| Aspecto | Anthropic | OpenAI | Google Gemini |
|---|---|---|---|
| **Activación** | Explícita (`cache_control`) | Automática si prefix ≥1024 tokens | Automática (implicit) + explícita (`cachedContent`) |
| **Mínimo cacheable** | 1024 tokens (Sonnet/Opus), 2048 (Haiku) | 1024 tokens | Variable |
| **TTL default** | 5 min | ~5-10 min (opaco) | 1 h (configurable en explicit) |
| **TTL extendido** | 1 h (write 2x) | No | Sí, hasta N horas |
| **Write cost** | 1.25x input (5min) / 2x (1h) | Sin sobrecoste | Sin sobrecoste |
| **Read cost** | 0.1x input (~90% off) | ~0.5x (GPT-4o) / ~0.1x (GPT-5) | ~0.1x |
| **Métrica hit** | `cache_read_input_tokens` | `cached_tokens` en usage | `cachedContentTokenCount` |
| **Control fino** | Alto | Nulo | Medio |

### 3.4. Batch API — implementación mínima Anthropic

```python
import anthropic
import json

client = anthropic.Anthropic()

# Preparar 100 requests
requests = [
    {
        "custom_id": f"eval-{i}",
        "params": {
            "model": "claude-haiku-4-5",
            "max_tokens": 200,
            "messages": [{"role": "user", "content": f"Clasifica: {texto}"}]
        }
    }
    for i, texto in enumerate(load_dataset_100())
]

batch = client.messages.batches.create(requests=requests)
print(f"Batch ID: {batch.id}")  # msgbatch_...

# Poll hasta terminar (o usa webhook en prod)
while True:
    b = client.messages.batches.retrieve(batch.id)
    if b.processing_status == "ended":
        break
    time.sleep(30)

# Recuperar resultados
for result in client.messages.batches.results(batch.id):
    if result.result.type == "succeeded":
        print(result.custom_id, result.result.message.content[0].text)
```

Coste: 50% del on-demand. Para 100 requests de 500 in / 200 out con Haiku 4.5:
- On-demand: `100 · (500·1 + 200·5) / 1M = $0.15`
- Batch:     `~$0.075`

Escala a 100k requests/día y el ahorro se materializa.

### 3.5. Reasoning models y hidden tokens

Los modelos de razonamiento (o-series de OpenAI, Claude con `thinking`, DeepSeek R1) generan tokens de "pensamiento interno" **no visibles pero facturados**. Ratio típico: 3-10x el output visible.

```python
# Claude Sonnet 4.6 con extended thinking (2026)
response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=2000,
    thinking={"type": "enabled", "budget_tokens": 10_000},
    messages=[{"role": "user", "content": "Prueba el teorema de Pitágoras."}]
)

# El pensamiento interno cuenta como output tokens
print("Thinking tokens:", response.usage.output_tokens)  # incluye thinking
```

Consecuencia: no uses reasoning models para clasificación trivial. El "responde 100 tokens" puede facturar 2000 tokens de reasoning silencioso.

### 3.6. Batch API + prompt caching combinados — código avanzado

Anthropic soporta cache en batch desde 2025. Combinar ambos multiplica el ahorro:

```python
# batch_with_cache.py — 100 requests, mismo system prompt cacheado + descuento batch 50%
import anthropic, time, itertools

client = anthropic.Anthropic()
SYSTEM = "Eres un clasificador de tickets ACME. Reglas: ...\n" + ("X" * 40_000)  # ~10k tokens

def build_request(idx: int, ticket: str) -> dict:
    return {
        "custom_id": f"clf-{idx}",
        "params": {
            "model": "claude-haiku-4-5",
            "max_tokens": 60,
            "system": [
                # Bloque cacheable: se computa una vez, se reusa en cada request del batch
                {"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral", "ttl": "1h"}}
            ],
            "messages": [{"role": "user", "content": f"Ticket: {ticket}\nDevuelve JSON {{priority, category}}."}],
        },
    }

tickets = [f"Ticket ejemplo #{i}" for i in range(100)]
batch = client.messages.batches.create(requests=[build_request(i, t) for i, t in enumerate(tickets)])
print(f"Batch: {batch.id} — polling...")

# Poll con back-off
delay = 5
while (b := client.messages.batches.retrieve(batch.id)).processing_status != "ended":
    time.sleep(delay); delay = min(delay * 1.5, 60)

# Consolidar resultados y calcular ahorro
total_write = total_read = total_out = 0
for r in client.messages.batches.results(batch.id):
    if r.result.type == "succeeded":
        u = r.result.message.usage
        total_write += u.cache_creation_input_tokens or 0
        total_read  += u.cache_read_input_tokens  or 0
        total_out   += u.output_tokens

# Precios Haiku 4.5, con batch 50% off
in_p, out_p, w_p, r_p = 0.5, 2.5, 0.625, 0.05   # todos × 0.5 por batch
cost = (total_write * w_p + total_read * r_p + total_out * out_p) / 1_000_000
print(f"Total: write={total_write} read={total_read} out={total_out} → ${cost:.4f}")
```

Esperado: **~93-95% de ahorro** vs on-demand sin cache. Cache write se paga solo una vez para los 100 requests del batch.

### 3.7. Bajo el capó — cómo un provider factura tu request

Entender por qué input y output tienen precios asimétricos requiere mirar dentro del transformer.

**Fase 1: Prefill (input).** El modelo procesa TODOS los tokens del prompt de una sola vez en paralelo, aprovechando toda la matriz de atención. Un prompt de 10k tokens se procesa en ~200-800ms en una H100, porque las GPUs son masivamente paralelas y el prefill es una operación matriz × matriz densa (throughput-bound). El coste marginal por token es bajo. **Aquí es donde el KV-cache se construye**: para cada token del prompt, se calculan los tensores K y V de cada capa y se almacenan en memoria HBM de la GPU. Esos tensores son lo que "cachea" prompt caching: si el prefijo ya se computó en un request anterior y sigue en HBM (o en un tier de almacenamiento rápido asociado a la sesión), la fase de prefill se salta enteramente para ese prefijo.

**Fase 2: Decode (output).** Aquí generas token por token, autoregresivamente. Cada nuevo token requiere una pasada completa del modelo (aunque optimizada por el KV-cache acumulado). Es una operación matriz × vector — latency-bound, no throughput-bound. La GPU está infrautilizada: procesas ~1 token en el tiempo que en prefill procesarías 100. De ahí el 3-5x de precio: el mismo token en output tarda mucho más wall-clock y ocupa más recursos por unidad de trabajo útil.

**Reasoning tokens** son output invisible: el modelo genera un stream de "pensamiento" que luego resume en la respuesta visible. Todo se factura como output. Providers lo separan en la API (`reasoning_output_tokens` en OpenAI o1/o3, `thinking` blocks en Claude) para trazabilidad, pero el pricing es el mismo por token.

**Batch API** funciona porque el provider agrega N requests, los planifica en momentos de baja demanda, y saturan mejor las GPUs (menos idle). Te ceden el 50% del ahorro operacional.

**Cross-region inference profiles** aprovechan que la capacidad regional es asimétrica: `us-east-1` puede saturarse mientras `us-west-2` tiene GPUs libres. El profile enruta transparente y sube tus cuotas efectivas.

Regla: cualquier optimización de coste efectiva ataca una de estas tres palancas: (1) reducir tokens de output, (2) reutilizar prefill (caching), (3) mejorar utilización de GPU del provider (batch, provisioned).

### 3.8. Tabla exhaustiva de pricing y throughput (agosto 2026)

| Modelo | Input $/MTok | Output $/MTok | Cache read | Cache write | TPS típico | TTFT p50 | Ctx |
|---|---:|---:|---:|---:|---:|---:|---:|
| Claude Opus 4.8 | 5.00 | 25.00 | 0.50 | 6.25 | 55-80 | 750 ms | 1M |
| Claude Sonnet 4.6 | 3.00 | 15.00 | 0.30 | 3.75 | 80-120 | 500 ms | 1M |
| Claude Haiku 4.5 | 1.00 | 5.00 | 0.10 | 1.25 | 130-180 | 300 ms | 400K |
| GPT-5.5 | 5.00 | 25.00 | 0.50 | n/a | 40-70 | 900 ms | 400K |
| GPT-5.4 | 2.50 | 10.00 | 0.25 | n/a | 90-140 | 500 ms | 400K |
| GPT-5 nano | 0.20 | 1.20 | 0.02 | n/a | 200-300 | 200 ms | 200K |
| Gemini 3.6 Flash | 1.50 | 7.50 | 0.15 | n/a | 150-200 | 350 ms | 2M |
| Gemini 3.5 Flash-Lite | 0.30 | 2.50 | 0.03 | n/a | 250-350 | 200 ms | 1M |
| DeepSeek V4 Pro | 0.44 | 0.87 | 0.04 | n/a | 60-90 | 700 ms | 1M |
| DeepSeek V4 Flash | 0.14 | 0.28 | 0.01 | n/a | 100-150 | 400 ms | 1M |
| Llama 3.3-70B (Bedrock) | 0.72 | 0.72 | — | — | 40-80 | 800 ms | 128K |
| Llama 3.3-70B (Groq LPU) | 0.59 | 0.79 | — | — | 500-800 | 250 ms | 128K |

*TPS y TTFT son medianas de Artificial Analysis 2026 en carga moderada; p99 puede ser 3-8× peor en spikes.*

---

## 4. Práctica avanzada (senior)

### 4.1. Semantic caching — para FAQs y queries repetitivas

Cache pares `(embedding(query), response)`. En una nueva query, busca por similitud coseno > threshold; si hay hit, devuelve sin llamar al LLM. Ahorros típicos en FAQs bien elegidas: 30-70%.

```python
import numpy as np
from openai import OpenAI

client = OpenAI()
cache: list[tuple[np.ndarray, str]] = []
THRESHOLD = 0.94  # ni muy laxo (0.85 devuelve mal) ni muy estricto (0.98 casi nunca hitea)

def embed(text: str) -> np.ndarray:
    v = client.embeddings.create(model="text-embedding-3-small", input=text).data[0].embedding
    return np.array(v)

def cached_ask(prompt: str) -> str:
    q = embed(prompt)
    for e, resp in cache:
        sim = float(np.dot(q, e) / (np.linalg.norm(q) * np.linalg.norm(e)))
        if sim >= THRESHOLD:
            return resp  # HIT — cero coste de LLM
    r = client.responses.create(model="gpt-5.4", input=prompt).output_text
    cache.append((q, r))
    return r
```

**Precauciones**:
- **Personalización**: si la respuesta depende de `user_id`/tenant, NO uses cache global. Segmenta por tenant o desactiva.
- **Threshold**: empieza en 0.94, ajusta con evals.
- **TTL**: cuando la fuente cambia (nueva versión de docs, nuevo pricing), invalida.

Frameworks: [GPTCache](https://github.com/zilliztech/GPTCache), Redis Semantic Cache, Langchain `RedisSemanticCache`, MongoDB Atlas Vector Search.

### 4.2. Cost tracking por feature/user

Con tracing (ver cap 10), cada request lleva metadatos:

```python
# Langfuse tracing con dimensiones de coste
from langfuse.decorators import observe, langfuse_context

@observe(name="generate_summary")
def summarize(user_id: str, tenant_id: str, doc: str) -> str:
    langfuse_context.update_current_trace(
        user_id=user_id,
        tags=[f"tenant:{tenant_id}", "feature:summary", "tier:sonnet"],
    )
    r = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=300,
        messages=[{"role": "user", "content": f"Resume: {doc}"}]
    )
    # Langfuse calcula el coste automáticamente si el modelo está en su catálogo
    return r.content[0].text
```

Dashboards que necesitas:
- Top 10 usuarios por gasto/día.
- Coste por feature (`summary` vs `chat` vs `agent`).
- Coste por modelo.
- Cache hit rate por feature.
- Ratio input/output real (para detectar bloat).

### 4.3. Budget kill-switch

Cap por feature/user con Redis:

```python
import redis
r = redis.Redis()

DAILY_LIMIT_USD = {"summary": 20.0, "chat": 200.0, "agent": 500.0}

def check_budget(feature: str) -> None:
    key = f"cost:{feature}:{today()}"
    spent = float(r.get(key) or 0)
    if spent >= DAILY_LIMIT_USD[feature]:
        raise BudgetExceeded(f"Feature {feature} alcanzó ${spent:.2f}/${DAILY_LIMIT_USD[feature]}")

def record_cost(feature: str, cost_usd: float) -> None:
    key = f"cost:{feature}:{today()}"
    r.incrbyfloat(key, cost_usd)
    r.expire(key, 86400 * 2)

def safe_call(feature: str, fn, *a, **kw):
    check_budget(feature)
    result = fn(*a, **kw)
    record_cost(feature, calculate_cost_from_usage(result.usage))
    return result
```

Previene: bug que multiplica llamadas 100x, retry-loop patológico, abuse por parte de usuario, feature runaway.

### 4.4. Provisioned throughput vs on-demand

- **On-demand**: pay-per-token, elástico, sin commit. Puede throttlear en spikes.
- **Provisioned** (Bedrock Provisioned Throughput, OpenAI Enterprise reserved capacity, Anthropic Enterprise): capacity reservada (Model Units), latencia predecible, sin cold start, sin throttle. Commit mensual/anual.

**Break-even**: provisioned sale a cuenta cuando utilización > 60-70% del baseline sostenido. Si tu tráfico es bursty (10x picos), on-demand + cross-region inference es mejor.

### 4.5. Volume discounts y committed spend

Todos los providers dan descuentos por commit anual:
- **Anthropic Enterprise**: 10-30% según spend.
- **OpenAI Enterprise**: reserved capacity + descuentos.
- **AWS Bedrock EDP** (Enterprise Discount Program): descuentos por commit total AWS.
- **Google Vertex AI**: Committed Use Discounts.

Regla: si gastas >$50k/mes sostenido, negocia. Si gastas >$500k, tienes account manager y descuentos serios.

### 4.6. Anti-patrones caros

- **Timestamp/UUID en system prompt** → 0% cache hit. Consecuencia típica: 10x el bill esperado.
- **Opus para todo** → 5-25x coste sin ganancia perceptible en 80% de casos.
- **No usar Batch para offline** → 2x el coste de embeddings, evals, extracción masiva.
- **Reasoning model para clasificación** → hidden tokens facturados; 3-10x output visible.
- **No cap `max_tokens`** → modelo mal-instruido escupe 4096 tokens de "elaboración".
- **Retries sin límite ni jitter** → thundering herd + factura oculta.
- **No structured output** → JSON malformado → retry → 2x tokens gastados.
- **Semantic cache sin segmentar por tenant** → filtración de datos entre clientes.
- **Sin unit economics** → producto con margen negativo escalando "para arreglarlo con volumen".

---

## 5. Ejemplo práctico completo step-by-step

**Objetivo:** Un chatbot RAG con system prompt de 20k tokens y KB de 30k tokens. Comparamos coste con/sin prompt caching sobre 100 requests simulados, y añadimos cost tracking + kill-switch.

```python
"""
demo_prompt_caching.py — Compara coste con/sin Anthropic prompt caching.
Requiere: pip install anthropic python-dotenv
"""
import os
import time
import anthropic
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()
client = anthropic.Anthropic()

MODEL = "claude-sonnet-4-6"
SYSTEM = "Eres el asistente de ACME. Sigue estas reglas...\n" + ("A" * 78_000)  # ~20k tokens
KB = "Base de conocimiento:\n" + ("B" * 120_000)                                 # ~30k tokens

# Precios oficiales agosto 2026 (Sonnet 4.6)
PRICE_IN     = 3.00 / 1_000_000
PRICE_OUT    = 15.00 / 1_000_000
PRICE_WRITE  = 3.75 / 1_000_000   # 1.25x input (TTL 5 min)
PRICE_READ   = 0.30 / 1_000_000   # 0.1x input

@dataclass
class RunStats:
    total_cost: float = 0.0
    total_in: int = 0
    total_out: int = 0
    total_cache_write: int = 0
    total_cache_read: int = 0

def ask(prompt: str, use_cache: bool, stats: RunStats) -> str:
    system_blocks = (
        [
            {"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": KB,     "cache_control": {"type": "ephemeral"}},
        ]
        if use_cache
        else [{"type": "text", "text": SYSTEM + "\n" + KB}]
    )

    r = client.messages.create(
        model=MODEL,
        max_tokens=200,
        system=system_blocks,
        messages=[{"role": "user", "content": prompt}],
    )

    u = r.usage
    cost = (
        u.input_tokens * PRICE_IN
        + (u.cache_creation_input_tokens or 0) * PRICE_WRITE
        + (u.cache_read_input_tokens or 0) * PRICE_READ
        + u.output_tokens * PRICE_OUT
    )
    stats.total_cost         += cost
    stats.total_in           += u.input_tokens
    stats.total_out          += u.output_tokens
    stats.total_cache_write  += u.cache_creation_input_tokens or 0
    stats.total_cache_read   += u.cache_read_input_tokens or 0
    return r.content[0].text

def bench(use_cache: bool, n: int = 100) -> RunStats:
    stats = RunStats()
    for i in range(n):
        ask(f"Consulta #{i}: ¿cómo cancelo mi suscripción?", use_cache, stats)
    return stats

if __name__ == "__main__":
    print("[1/2] Sin cache...")
    no_cache = bench(use_cache=False, n=100)

    print("[2/2] Con cache...")
    with_cache = bench(use_cache=True, n=100)

    print(f"\nSin cache:  ${no_cache.total_cost:.2f}  (in={no_cache.total_in:,}, out={no_cache.total_out:,})")
    print(f"Con cache:  ${with_cache.total_cost:.2f}  (write={with_cache.total_cache_write:,}, read={with_cache.total_cache_read:,})")
    print(f"Ahorro:     {100 * (1 - with_cache.total_cost / no_cache.total_cost):.1f}%")
```

**Resultado esperado (aprox):**
```
Sin cache:  $15.20  (in=5,000,000, out=20,000)
Con cache:  $2.10   (write=50,000, read=4,950,000)
Ahorro:     86.2%
```

**Bonus: mueve las 100 evals a Batch API para 50% adicional.**

```python
# batch_evals.py — mismos 100 prompts en Batch API (~24h SLA, 50% descuento)
requests = [
    {
        "custom_id": f"eval-{i}",
        "params": {
            "model": MODEL,
            "max_tokens": 200,
            "system": [
                {"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": KB,     "cache_control": {"type": "ephemeral"}},
            ],
            "messages": [{"role": "user", "content": f"Consulta #{i}"}],
        },
    }
    for i in range(100)
]
batch = client.messages.batches.create(requests=requests)
```

Coste combinado (cache + batch): ~$1.05, un **93% de ahorro** sobre el naïve.

### 5.1. Por qué cada paso: la narrativa detrás del código

- **Por qué separamos `SYSTEM` y `KB` en dos bloques cacheables:** Anthropic permite hasta 4 breakpoints. Separar system estable (200 reglas, cambia mensualmente) de KB (30k tokens, se actualiza cuando cambian los docs) permite invalidar solo lo necesario. Si mañana cambias el system prompt, el KB sigue cacheado.
- **Por qué TTL default 5min y no 1h siempre:** el write de 1h cuesta 2x (vs 1.25x para 5min). Solo compensa si prevés ≥15-20 requests con el mismo prefijo dentro de la hora. Para picos cortos (chat de sesión de 3-5 min), 5min es más barato.
- **Por qué medimos `cache_read_input_tokens` explícitamente:** sin esa métrica, no sabes si tu cache está funcionando. Un cambio accidental de whitespace en el system prompt puede llevar el hit rate a 0% y solo lo detectas en la factura.

### 5.2. Manejo de errores robusto

El ejemplo minimalista de §5 asume happy-path. En producción necesitas capturar:

```python
from anthropic import APIStatusError, RateLimitError, APITimeoutError
import time, random

def ask_safe(prompt: str, use_cache: bool, stats: RunStats, retries: int = 3) -> str:
    for attempt in range(retries):
        try:
            return ask(prompt, use_cache, stats)
        except RateLimitError as e:
            wait = int(e.response.headers.get("retry-after", "5"))
            print(f"[429] esperando {wait}s...")
            time.sleep(wait + random.uniform(0, 1))
        except APITimeoutError:
            print(f"[timeout] retry {attempt + 1}/{retries}")
            time.sleep(2 ** attempt + random.uniform(0, 1))
        except APIStatusError as e:
            if 500 <= e.status_code < 600 and attempt < retries - 1:
                time.sleep(2 ** attempt + random.uniform(0, 1))
                continue
            raise
    raise RuntimeError("Retries exhausted")
```

Justificación: sin backoff+jitter, un batch de 100 requests fallando el mismo segundo por 429 genera thundering herd cuando el rate-limit resetea. El jitter distribuye los retries.

### 5.3. Verificación intermedia (sanity checks)

Antes de dar por bueno el ahorro reportado, valida:

```python
def assert_caching_works(stats: RunStats, n_requests: int) -> None:
    """Falla ruidoso si el cache no está funcionando como esperamos."""
    # 1) Debe haber al menos 1 write (primer request)
    assert stats.total_cache_write > 0, "No hubo cache write; ¿falta cache_control?"
    # 2) Cache reads debería dominar tras 5+ requests
    if n_requests >= 5:
        assert stats.total_cache_read > stats.total_cache_write * 3, \
            f"Cache hit rate bajo: read={stats.total_cache_read} vs write={stats.total_cache_write}"
    # 3) Coste debe ser mucho menor que sin cache
    fresh_only = (stats.total_in + stats.total_cache_write + stats.total_cache_read) * 3.0
    fresh_only = fresh_only / 1_000_000 + stats.total_out * 15.0 / 1_000_000
    ratio = stats.total_cost / fresh_only
    assert ratio < 0.4, f"Ahorro <60%; algo no cachea (ratio={ratio:.2%})"
    print(f"[OK] cache verificado: {(1 - ratio) * 100:.1f}% ahorro")

assert_caching_works(with_cache, n_requests=100)
```

### 5.4. Extendiendo el ejemplo — 3 mejoras que añadirías en producción

**Mejora 1: cost tracking por usuario/feature.** Añade tags a cada request para atribuir gasto por dimensión y detectar power users abusivos.

```python
def ask_tracked(prompt: str, user_id: str, feature: str, stats: RunStats) -> str:
    result = ask(prompt, use_cache=True, stats=stats)
    # En prod, enviar a Langfuse/Datadog con tags {user_id, feature, model}
    print(f"[metric] user={user_id} feature={feature} cost={stats.total_cost:.4f}")
    return result
```

**Mejora 2: budget kill-switch por feature.** Corta requests cuando el gasto diario excede el cap; ver §4.3 para la implementación con Redis.

**Mejora 3: fallback a modelo más barato si el TTFT excede SLO.** Si `Sonnet 4.6` tarda >2s p95, cae a `Haiku 4.5` para el próximo batch:

```python
FALLBACK_MAP = {"claude-sonnet-4-6": "claude-haiku-4-5"}

def ask_with_slo_fallback(prompt: str, model: str, ttft_slo_ms: int = 2000) -> str:
    t0 = time.time()
    stream = client.messages.stream(model=model, max_tokens=200, messages=[{"role": "user", "content": prompt}])
    first_chunk = next(iter(stream))
    ttft = (time.time() - t0) * 1000
    if ttft > ttft_slo_ms and model in FALLBACK_MAP:
        stream.close()
        return ask_with_slo_fallback(prompt, FALLBACK_MAP[model])
    return "".join(chunk.text for chunk in stream if hasattr(chunk, "text"))
```

Con las tres mejoras, el ejemplo pasa de "prueba de concepto" a "listo para producción con SLO y presupuesto".

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Cheatsheet

| Situación | Acción |
|---|---|
| Chat con system largo estable | ✅ Prompt caching (Anthropic explícito, OpenAI/Gemini auto) |
| Task offline que tolera 24h | ✅ Batch API (-50%) |
| Clasificación / extracción simple | ✅ Haiku 4.5 / Gemini Flash-Lite / GPT-5 nano |
| Razonamiento crítico | ✅ Opus 4.7-4.8 / GPT-5.5, con eval antes |
| FAQs repetitivas | ✅ Semantic cache con threshold 0.94 |
| Feature con volumen predecible | ✅ Provisioned throughput |
| Retries transitorios | ✅ Backoff exponencial + jitter, cap N |
| JSON de output | ✅ Structured output (schema forzado) |

### Reglas mentales

1. **Output cuesta 3-5x más que input.** Optimizar respuestas cortas antes que prompts largos.
2. **Ordena estable → variable.** System → tools → docs → historial → user.
3. **Cache write cuesta 1.25x, read cuesta 0.1x** (Anthropic). Rentable desde el 2º hit.
4. **Batch API para todo lo offline.** -50% gratis.
5. **Model routing:** clasifica intent en Haiku, escala solo si necesario.
6. **`max_tokens` bajo** por defecto en chat (200-500).
7. **Structured output** en extracción → cero retries por JSON.
8. **Trace cost por feature/user.** Sin tags no puedes optimizar.
9. **Budget kill-switch por feature.** Cap en Redis + alerta.
10. **Unit economics** > MRR. Si el margen es <40%, revisa antes de escalar.

### Anti-patrones (fatales)

- ❌ Timestamp o request-id en system prompt → 0% cache hit.
- ❌ Opus para todo → 5-25x sin ganancia.
- ❌ Reasoning model para clasificación → hidden tokens facturados 3-10x.
- ❌ No `max_tokens` → 4096 tokens de "elaboración" gratis para el modelo, caro para ti.
- ❌ Semantic cache global con personalización → filtración entre tenants.
- ❌ Batch olvidado en offline → 2x el coste innecesario.
- ❌ Sin cost tracking → un feature gasta 80% del budget y nadie sabe.

### Tabla de decisión rápida

| Volumen mensual | Estrategia recomendada |
|---|---|
| <$500 | On-demand, sin caching complejo, Haiku para todo lo posible |
| $500-$5k | + Prompt caching agresivo, + Batch para offline |
| $5k-$50k | + Model routing, + cost tracking granular, + budget alerts |
| $50k-$500k | + Provisioned, + enterprise contract, + FinOps dedicado |
| >$500k | + Auto-host open-weights (ver cap 16), + committed spend agresivo |

---

## 7. Casos reales industria 2026

### 7.1. Cursor — 65% ahorro con caching agresivo (2024-2025)
- **Qué pasó:** Cursor (IDE con IA) creció de 10k a 500k+ users en 2024; su bill de Anthropic escalaba superlinealmente por el system prompt de ~30k tokens que enviaba con cada tab-completion.
- **Cómo se detectó:** unit economics por usuario (MRR - infra cost) mostró márgenes negativos en tier gratuito y frágiles en $20/mes.
- **Cómo se arregló:** movieron system prompt + tool definitions a bloques `cache_control` con TTL 5min. Reordenaron el prompt para poner contenido del archivo del usuario al final. Adoptaron routing Haiku 4.5 para intent classification.
- **Aprendizaje industrial:** post público de junio 2024 reportó 65% de reducción del gasto de infra. Estableció el patrón "cache-first" en dev tools. Cursor eventualmente removió el tier de $30/mes (2025) porque power users seguían superando break-even.

### 7.2. Notion AI — multi-model routing 40% ahorro (2025)
- **Qué pasó:** Notion añadió AI features (summarize, Q&A, autofill) a millones de páginas; el modelo default era GPT-4/Claude Opus para todo.
- **Cómo se detectó:** telemetry mostró que 70% de queries eran clasificación trivial (¿esto es una tarea? ¿qué tipo?), no requerían frontier reasoning.
- **Cómo se arregló:** implementaron router basado en Haiku 4.5 que clasifica intent; solo escala a Sonnet/Opus para razonamiento explícito. Añadieron caching por-workspace del prompt de contexto.
- **Aprendizaje:** blog público de 2025 reportó 40% de reducción en bill sin caída de NPS. El router costaba <2% del total ahorrado.

### 7.3. Anthropic prompt caching GA (agosto 2024, mejoras 2025-2026)
- **Qué pasó:** Anthropic lanzó `cache_control` explícito en agosto 2024 tras 6 meses de beta cerrada con Notion, Sourcegraph Cody y Cursor como design partners.
- **Cómo se detectó como necesidad:** feedback de early adopters mostrando que 70-90% de tokens en prod eran system prompts repetidos.
- **Cómo se implementó:** hash del prefijo, KV-cache regional en cluster, TTL 5min default + 1h extended.
- **Aprendizaje:** presión competitiva forzó a OpenAI (oct 2024, automático) y Google (implicit desde 2024, explicit 2025) a añadir su versión. Descuentos escalaron de 50% → 90% en dos años.

### 7.4. OpenAI cached input y GPT-5 series (octubre 2024 → 2026)
- **Qué pasó:** OpenAI lanzó cached input automático (sin config) para prefijos ≥1024 tokens. Descuento inicial 50% en GPT-4o.
- **Aprendizaje:** con GPT-5.5 (2026) subieron el descuento a 90% para competir con Anthropic explícito. Vercel AI SDK y LangChain exponen `cached_tokens` en usage; teams sin observability lo desperdician silenciosamente.

### 7.5. DeepSeek V4 price cut (2026) — commoditización
- **Qué pasó:** DeepSeek recortó V4 Pro 75% (de $1.75 → $0.44/MTok input) en Q2 2026.
- **Cómo se detectó impacto:** competidores vieron churn masivo hacia DeepSeek en workloads batch/embedding.
- **Cómo se arregló (industria):** Anthropic aceleró Haiku 4.5 pricing tier, OpenAI lanzó nano tier, Google bajó Flash-Lite. Efecto commodity real.
- **Aprendizaje:** LLM APIs se comportan como commodity mercantil (grain, oil). Volumen ganado por precio a corto plazo pero margen técnico por caching/routing sostiene diferenciación.

### 7.6. Klarna AI rollback parcial (2024-2026)
- **Qué pasó:** claim inicial de "700 agentes reemplazados" (Feb 2024) fue revisado en 2025: recontrataron parcialmente humanos porque unit economics del agente en edge cases (disputas complejas, multi-idioma raro) no cerraban.
- **Aprendizaje:** unit economics de agente vs humano dependen críticamente de tier de modelo y caching agresivo. Sin ambos, el "AI replaces humans" es marketing más que operación.

### 7.7. AWS Bedrock cross-region inference (2024-2026)
- **Qué pasó:** AWS lanzó inference profiles (`us.*`, `eu.*`, `apac.*`, `global.*`) que enrutan entre regiones transparente.
- **Aprendizaje:** default en la mayoría de deployments enterprise; sube availability sin código extra y previene throttling en spikes. Trade-off: data residency requiere modelId regional puro.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — Medir cache hit rate real

**Objetivo:** entender el impacto empírico de prompt caching en tu app.

**Setup:** una app o script que llame a Anthropic o OpenAI ≥50 veces con un system prompt >2k tokens.

**Pasos:**
1. Añade tracing que loguee `cache_read_input_tokens` (Anthropic) o `cached_tokens` (OpenAI) por request.
2. Corre 50 requests con el prompt tal cual.
3. Calcula: `hit_rate = sum(cached) / sum(total_input)`.
4. Reordena el prompt para poner lo estable arriba, aplica `cache_control` (Anthropic).
5. Vuelve a correr y compara.

**Criterios verificables:**
- [ ] Log muestra `cache_read_input_tokens > 0` en request #2 en adelante.
- [ ] Hit rate final > 60%.
- [ ] Coste calculado por request bajó ≥40%.

**Bonus:** grafica hit rate por hora durante 24h; ¿ves caídas cuando el TTL de 5min expira?

**Hints:**
- Si `cache_read_input_tokens` es siempre 0, revisa si tu system prompt cambia por request (timestamps, UUIDs, user_id embebido).
- Anthropic requiere ≥1024 tokens en el bloque cacheado (2048 para Haiku). Si tu system es más corto, no cachea.
- Serializa JSON siempre con `sort_keys=True` para evitar cache miss por reordenación.

**Solución de referencia (esbozo):**
```python
def measure_cache(prompts: list[str], use_cache: bool) -> dict:
    hits, writes, totals = 0, 0, 0
    for p in prompts:
        r = client.messages.create(
            model="claude-sonnet-4-6", max_tokens=200,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}] if use_cache
                   else [{"type": "text", "text": SYSTEM}],
            messages=[{"role": "user", "content": p}])
        hits   += r.usage.cache_read_input_tokens or 0
        writes += r.usage.cache_creation_input_tokens or 0
        totals += r.usage.input_tokens + (r.usage.cache_creation_input_tokens or 0) + (r.usage.cache_read_input_tokens or 0)
    return {"hit_rate": hits / totals, "writes": writes, "hits": hits}
```

### Ejercicio 2 — Migrar un batch job a Batch API

**Objetivo:** ahorrar 50% en un job offline (embeddings, evals, extracción).

**Setup:** identifica un job que corras periódicamente y tolere 24h de latencia.

**Pasos:**
1. Convierte los N requests a un archivo JSONL (formato Anthropic o OpenAI Batch).
2. Envía con la SDK; guarda `batch_id`.
3. Poll (o suscríbete a webhook) hasta `ended`.
4. Descarga y procesa resultados.
5. Compara coste antes/después.

**Criterios:**
- [ ] Job completa en <24h.
- [ ] Coste 50% menor exactamente vs on-demand.
- [ ] Manejas errores individuales (algunos requests fallan, otros ok).

**Bonus:** paraleliza con prompt caching dentro del batch (Anthropic soporta cache en batch desde 2025).

**Hints:**
- El `custom_id` debe ser único y estable — úsalo como idempotency key para reintentos.
- Los errores individuales llegan en `result.result.type == "errored"` con detalles en `error`. No abortes el batch entero.
- Con Anthropic, poll cada 30-60s (no más frecuente) para no gastar API calls innecesarias.

### Ejercicio 3 — Implementar budget kill-switch

**Objetivo:** prevenir un runaway cost de un feature.

**Setup:** Redis local o managed, tu app usando algún feature LLM.

**Pasos:**
1. Wrappea las llamadas al LLM con `check_budget(feature)` y `record_cost(feature, cost)`.
2. Cap diario en `DAILY_LIMIT_USD`.
3. Cuando excede: log estructurado + retorna respuesta pre-canned + notifica Slack/PagerDuty.
4. Simula runaway: 10.000 requests en un minuto.
5. Verifica que el kill-switch se activa antes del límite.

**Criterios:**
- [ ] Antes del límite: requests pasan normalmente.
- [ ] Al alcanzar: request N+1 devuelve error controlado (no 500).
- [ ] Cost registrado en Redis coincide (±1%) con lo cobrado por el provider.

**Bonus:** cap por (user, feature) para prevenir abuse individual.

### Ejercicio 4 — Comparar 3 modelos en un mismo eval

**Objetivo:** validar model routing con datos reales.

**Setup:** 100 queries reales de tu producto, un juez (LLM o humano) que rankea 1-5.

**Pasos:**
1. Corre los 100 con Haiku 4.5, Sonnet 4.6, Opus 4.7 (o equivalentes).
2. Guarda: coste total por modelo, latencia p50/p95, score del juez.
3. Grafica: coste vs score.
4. Encuentra el "Pareto frontier": qué modelo da mejor score/€.

**Criterios:**
- [ ] Tabla con 3 filas (modelo) x 4 columnas (coste, p50, p95, score).
- [ ] Al menos un caso donde Haiku iguala calidad de Sonnet.
- [ ] Recomendación explícita: "para tarea X, elegir Y".

**Bonus:** router LLM que decide en runtime cuál usar según features de la query (longitud, palabras clave).

### Ejercicio 5 — RETO: caching + batch + routing combinados con ROI ≥90%

**Objetivo:** en un único pipeline batch nocturno, combinar las 3 palancas del capítulo para reducir el bill de 1000 evals a ≥90% menos que el naïve.

**Setup:** 1000 queries reales del producto, system prompt >20k tokens, 3 modelos disponibles (Haiku, Sonnet, Opus).

**Pasos:**
1. Escribe un clasificador (Haiku, ~50 tokens output) que etiquete cada query como `simple` / `complex`.
2. Empaqueta 1000 requests en un JSONL con `cache_control` en el system prompt (TTL 1h).
3. Envía a Batch API. Routea `simple` → Haiku, `complex` → Sonnet.
4. Mide coste real total, compara vs "todo Opus on-demand sin cache".
5. Documenta hit rate del cache, distribución simple/complex, y ahorro por palanca.

**Criterios:**
- [ ] Ahorro total ≥90% vs baseline naïve.
- [ ] Desglose por palanca: caching (X%), batch (Y%), routing (Z%).
- [ ] ≥95% de queries devuelven output válido.
- [ ] Sin degradación de calidad >0.3 puntos en una rúbrica 1-5 evaluada por LLM juez.

**Hints:** las 3 palancas son multiplicativas, no aditivas: 60% cache + 50% batch + 50% routing = 1 - (0.4 × 0.5 × 0.5) = 90% ahorro teórico.

---

## 9. Recursos + siguientes pasos

### Referencias oficiales

- Anthropic — Pricing: https://www.anthropic.com/pricing
- Anthropic — Prompt caching: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- Anthropic — Message Batches: https://docs.anthropic.com/en/docs/build-with-claude/batch-processing
- OpenAI — Pricing: https://openai.com/api/pricing/
- OpenAI — Prompt caching: https://platform.openai.com/docs/guides/prompt-caching
- OpenAI — Batch API: https://platform.openai.com/docs/guides/batch
- Google — Gemini pricing: https://ai.google.dev/pricing
- DeepSeek — API pricing: https://api-docs.deepseek.com/quick_start/pricing

### Tools 2026

- **Langfuse** — tracing + cost analytics open source.
- **Braintrust** — evals + observability.
- **Helicone** — proxy + cache + observability.
- **Vantage / CloudZero** — FinOps para IA + cloud.
- **GPTCache** — semantic cache open source.
- **LiteLLM** — proxy unified con cost tracking.
- **Portkey** — gateway con caching, routing, fallback.

### Papers

- Shumailov et al. — "AI models collapse when trained on recursively generated data" (Nature, 2024).
- Levine et al. — Speculative decoding (2023).

### Siguiente paso

Cap 14 — Latencia y routing: streaming, model routing, fallbacks.

---

## 10. Preguntas de práctica (20)

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-13-inference-cost-prompt-caching.json`](../../packages/content/src/tech/ai-programming/sim-13-inference-cost-prompt-caching.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-13-inference-cost-prompt-caching`

---

## Navegación

[← Capítulo 12](./12-agent-sandboxing-guardrails.md) · [Índice](./README.md) · [Capítulo 14 →](./14-latency-streaming-model-routing.md)
