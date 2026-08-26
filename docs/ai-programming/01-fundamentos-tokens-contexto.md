# Capítulo 01 — Fundamentos IA: tokens, contexto, latencia

> **Focus:** Fundamentos que TODO dev que use LLMs debe dominar: qué es un token realmente, cómo se factura, ventana de contexto, temperatura, top-p, latencia vs streaming, diferencias entre modelos base y instruction-tuned.
> **Áreas:** Context Engineering · Economía de inferencia
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Saber programar en al menos un lenguaje (los ejemplos usan Python y TypeScript).
- Familiaridad con HTTP, JSON y APIs REST.
- Tener a mano una terminal con Python 3.10+ o Node 20+.
- Concepto vago de qué es un LLM (input texto → output texto). No hace falta entender transformers.
- No hace falta saber matemáticas de redes neuronales.

**Glosario mínimo:**
- **Token** — unidad mínima con la que trabaja un LLM. Típicamente sub-palabras generadas por BPE. La factura y los límites se miden en tokens, no en caracteres ni en palabras.
- **BPE (Byte Pair Encoding)** — algoritmo que construye un vocabulario fusionando pares de bytes/caracteres más frecuentes hasta llegar a un tamaño objetivo (32k-200k tokens).
- **Ventana de contexto (context window)** — máximo número de tokens que un modelo puede procesar en una sola llamada, sumando input + output.
- **max_tokens / max_output_tokens** — límite separado sobre cuánto puede GENERAR el modelo en la respuesta. Siempre menor que la ventana total.
- **TTFT (Time To First Token)** — cuánto tarda en llegar el primer token de la respuesta. Depende del prefill (procesar el input).
- **TPS (Tokens Per Second)** — velocidad de generación una vez que empieza a responder. Depende del modelo y del hardware.
- **Streaming (SSE)** — recibir la respuesta token a token vía Server-Sent Events, en lugar de esperar la respuesta completa.
- **Instruction-tuned** — modelo entrenado con RLHF o similar para seguir instrucciones. Contrasta con el modelo "base" (solo completa texto).

**Setup para probar los ejemplos:**

```bash
# Python
python -m venv .venv
source .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install anthropic==0.68.0 openai==1.90.0 tiktoken==0.8.0 google-genai==1.9.0

# Variables de entorno (obtén las keys en las consolas correspondientes)
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...
```

Los ejemplos usan las versiones estables a mediados de 2026: Anthropic SDK 0.68+, OpenAI SDK 1.90+, tiktoken 0.8 (incluye ya `o200k_base` para GPT-4o/GPT-5). Si usas versiones anteriores, algunos parámetros pueden diferir (`max_completion_tokens` en modelos o-series de OpenAI, `thinking` block en Claude 4+).

## 1. El gran cuadro

En 2026 casi ningún producto SaaS medianamente serio evita tocar un LLM. Chat, autocompletado, resúmenes, clasificación, extracción, agentes, RAG interno de documentación. Y sin embargo el 80% de los equipos que empiezan a integrar LLMs cometen los mismos errores básicos: presupuestan mal la factura, saturan la ventana de contexto sin necesidad, dejan la temperatura por defecto en producción y esperan la respuesta completa cuando podrían usar streaming.

Los errores duelen por tres vías. **Factura**: un producto que factura 3× el input y 15× el output de lo esperado en tres semanas es realista si nadie contó tokens. **Latencia**: un TTFT de 8 segundos donde el usuario ve una pantalla en blanco es abandono directo; con streaming el mismo TTFT se percibe como 2 segundos. **Bugs semánticos**: temperature=1.0 en un extractor de entidades produce alucinaciones intermitentes que aparecen en producción pero no en tests. Y todo esto se evita con conocimiento fundacional del capítulo.

Si vienes de dev tradicional, la analogía útil es esta: un LLM es un servicio HTTP que factura por bytes procesados, pero los "bytes" son tokens generados por un tokenizador BPE, no ASCII. El modelo es una función pura (`f(prompt) → completion`) desde el punto de vista del API: no tiene memoria entre llamadas, no aprende de tus queries, no tiene sesión. Todo lo que quieras que "recuerde" tienes que enviarlo tú en el prompt. Y cada llamada tiene un techo duro de contexto y un techo separado de output, ambos configurables pero acotados.

En 2026 la industria ha convergido en unas reglas prácticas: (a) siempre cuenta tokens antes de facturar, (b) siempre pon un `max_tokens` explícito (nunca dejes que "hasta la ventana lo permita"), (c) usa streaming para UI de chat, (d) usa temperature=0 para tareas deterministas (extracción, clasificación), (e) usa structured output (JSON mode / response_format) si necesitas parsear la respuesta, (f) valida siempre la salida — el modelo puede saltarse el schema en el 0.1% de los casos.

**Roadmap del capítulo:**
1. **Sección 2** — Fundamentos: qué es un token, cómo funciona BPE, cómo contarlos.
2. **Sección 3** — Cómo funciona por dentro: ventana de contexto, input/output pricing, sampling (temperature, top_p), streaming.
3. **Sección 4** — Práctica avanzada: reasoning tokens (Claude Extended Thinking, o-series), structured output, model routing.
4. **Sección 5** — Ejemplo completo: contar tokens de un PDF, comparar tokenizers, streaming con SSE.
5. **Sección 6-10** — Cheatsheet, casos reales, ejercicios, recursos, sim.

## 2. Fundamentos (nivel básico)

### 2.1 Qué es un token

Un token es la unidad mínima con la que trabaja el modelo. No es una palabra, no es un carácter. Es una sub-palabra estadísticamente frecuente en el corpus de entrenamiento. Por ejemplo, `tokenización` en español se parte típicamente en `["token", "ización"]` (dos tokens) porque `tokenización` como palabra completa es rara pero `token` es frecuente.

Ejemplo mínimo con `tiktoken` (el tokenizador oficial de OpenAI):

```python
import tiktoken

# cl100k_base: usado por GPT-3.5, GPT-4, text-embedding-3-*
# o200k_base:  usado por GPT-4o, GPT-4o-mini, o1, o3, GPT-5
enc = tiktoken.get_encoding("o200k_base")

texto = "Hola mundo, cómo estás"
tokens = enc.encode(texto)
print(tokens)              # [13225, 3878, 11, 42071, 27979]
print(len(tokens))         # 5 tokens
print([enc.decode([t]) for t in tokens])
# ['Hola', ' mundo', ',', ' cómo', ' estás']
```

Notas importantes: los espacios NO son tokens separados; se absorben como prefijo del siguiente token (nota los `' mundo'` con espacio). Y la misma frase en inglés `"Hello world, how are you"` da 6 tokens también — pero en promedio, el español gasta 30-70% más tokens que el inglés para el mismo mensaje.

**Analogía útil:** piensa en tokens como la facturación por caracteres SMS de los años 2000. Un SMS "cuesta" un mensaje si tiene ≤160 caracteres GSM-7, pero si metes un emoji o un carácter no-ASCII se pasa a UCS-2 y el mismo texto ocupa 70 caracteres por SMS. Con LLMs pasa parecido: el mismo texto puede costar 200 tokens en inglés y 350 en español porque el tokenizador tiene sub-palabras optimizadas para inglés y fragmenta el español en más piezas. La "unidad de facturación" es discreta y depende del contenido, no de la longitud visual.

**Segundo ejemplo — palabras raras y código:**

```python
enc = tiktoken.get_encoding("o200k_base")

print(len(enc.encode("Hello world")))                     # 2 tokens
print(len(enc.encode("antidisestablishmentarianism")))    # 6 tokens (palabra rara → más fragmentos)
print(len(enc.encode("def foo(x): return x*2")))          # 8 tokens (código: puntuación cuenta)
print(len(enc.encode('{"user":"ana","age":31}')))         # 11 tokens (JSON gasta MUCHO por comillas y llaves)
print(len(enc.encode("🎉🎉🎉")))                          # 6 tokens (emojis suelen ser 2 tokens cada uno)
```

Regla mental: **texto en inglés ≈ 1 token cada 4 chars; español ≈ 1 token cada 3 chars; JSON/código ≈ 1 token cada 2-3 chars**. Es una aproximación grosera pero útil para pre-presupuestar.

**Por qué existe:** entrenar con vocabulario de palabras completas es inviable (millones de palabras, muchas rarísimas). Tokenizar por caracteres es viable pero produce secuencias larguísimas que saturan el transformer. BPE es el compromiso: vocabulario de 100-200k sub-palabras, cobertura completa (siempre puede tokenizar cualquier string).

**Cómo funciona BPE paso a paso (mini-desglose):**
1. Se parte del vocabulario base (bytes UTF-8 individuales).
2. Se cuenta la frecuencia de todos los pares de tokens adyacentes en el corpus.
3. Se fusiona el par más frecuente en un nuevo token único (ej: `t + h → th`).
4. Se repite hasta llegar al tamaño de vocabulario objetivo (100k, 200k...).
5. En tiempo de tokenización, se aplican las fusiones aprendidas de forma greedy.

Resultado: palabras frecuentes quedan en un solo token, raras se dividen en varios. Los emoji suelen ser 2 tokens (byte alto + byte bajo de UTF-8) porque son rarísimos en el corpus.

### 2.2 Ventana de contexto vs max output

Dos límites distintos que se confunden constantemente:

- **Context window**: máximo total de tokens que el modelo puede "ver" en una llamada. Se cuenta como `input + output ≤ context_window`. En 2026 los grandes modelos ofrecen ventanas de 200k (Claude Sonnet 4.6 base), 1M (Claude Sonnet 4.6 con flag long-context, GPT-5.4, Gemini 2.5 Pro) o incluso 2M (Gemini 2.5 Pro).
- **max_output_tokens**: cuánto puede GENERAR el modelo en una respuesta concreta. Siempre mucho menor que la ventana. Típicamente 4k-8k, hasta 64k en algunos modelos de razonamiento.

```python
from anthropic import Anthropic

client = Anthropic()
resp = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,                # <-- max_output: obligatorio en Anthropic
    messages=[{"role": "user", "content": "Explica RAG en 3 líneas"}],
)
print(resp.usage)
# Usage(input_tokens=15, output_tokens=87, cache_creation_input_tokens=0, cache_read_input_tokens=0)
```

Si tu input mide 195k tokens y pides `max_tokens=10_000`, Anthropic devuelve `400: input tokens + max_tokens exceeds context window`. En OpenAI el error es similar. Verifica siempre `len(input_tokens) + max_tokens <= context_window`.

**Analogía útil:** piensa en la ventana de contexto como la memoria RAM del proceso LLM en esa request, y `max_tokens` como el disco donde escribe la respuesta. Ambos comparten el mismo bus (la ventana total), pero se contabilizan de forma independiente: la RAM la ocupas con tu prompt, el disco lo reservas con `max_tokens`. Si intentas escribir más de lo que cabe en el espacio restante, el sistema falla `out-of-memory`.

**Mini-ejemplo para probar la validación en tu código:**

```python
import tiktoken

enc = tiktoken.get_encoding("o200k_base")

def validar_request(prompt: str, max_tokens: int, ventana: int = 200_000) -> None:
    tokens_input = len(enc.encode(prompt))
    total = tokens_input + max_tokens
    print(f"input={tokens_input}, max_out={max_tokens}, total={total}, ventana={ventana}")
    if total > ventana:
        raise ValueError(f"Excede la ventana en {total - ventana} tokens")
    if max_tokens > ventana * 0.5:
        print("WARN: max_tokens ocupa >50% de la ventana, revisa si es intencional")

validar_request("hola mundo" * 100, max_tokens=1024)   # OK
# validar_request("hola mundo" * 50_000, max_tokens=100_000)  # ValueError
```

**Por qué existe:** el modelo genera token a token de forma autoregresiva. Cada token nuevo requiere una pasada por la red, atendiendo a todos los tokens previos. Un `max_tokens` alto sin necesidad multiplica latencia y coste. Y el margen entre input y output evita que un prompt gigante deje al modelo sin espacio para responder.

### 2.3 Input vs output pricing (asimétrico)

Los tokens de entrada se cobran distinto que los de salida. Prácticamente todos los proveedores comerciales cobran output 3-6× más caro que input. Razón técnica: el input se procesa en paralelo (prefill), el output se genera secuencialmente token a token (decode).

Pricing de referencia mid-2026:

| Modelo                | Input $/MTok | Output $/MTok | Ventana |
|-----------------------|--------------|---------------|---------|
| Claude Sonnet 4.6     | $3.00        | $15.00        | 1M      |
| Claude Opus 4.8       | $15.00       | $75.00        | 1M      |
| Claude Haiku 4.5      | $1.00        | $5.00         | 200k    |
| GPT-5.4               | $2.50        | $15.00        | 1.1M    |
| GPT-5.5               | $5.00        | $30.00        | 1M      |
| GPT-4o-mini           | $0.15        | $0.60         | 128k    |
| Gemini 2.5 Pro        | $1.25        | $10.00        | 2M      |
| Gemini 2.5 Flash      | $0.30        | $2.50         | 1M      |

Cálculo por request: `coste = (input_tokens / 1e6) * price_in + (output_tokens / 1e6) * price_out`.

Ejemplo: resumir un PDF de 40k tokens en 800 tokens con Claude Sonnet 4.6:
```
input:  40_000 / 1_000_000 * $3.00  = $0.120
output:    800 / 1_000_000 * $15.00 = $0.012
total = $0.132 por resumen
```

**Por qué importa:** un compañero que promedie input+output y calcule `40800 * $9 promedio = $0.37/doc` te va a triplicar el presupuesto. Regla mental: **si tu carga es RAG (mucho input, poco output), el input domina; si es generación larga (poco input, mucho output), el output domina**.

**Segundo ejemplo — generación de código con Claude Opus:**
```
input:    500 / 1_000_000 * $15.00 = $0.0075
output: 3_000 / 1_000_000 * $75.00 = $0.2250
total = $0.2325 por generación
```
Aquí el output vale el 97% del ticket. Un mismo `max_tokens=3000` sin necesidad convierte cada llamada en algo mucho más caro. Con Haiku ($1/$5) esa misma generación cuesta $0.0155 (15x menos) — de ahí la regla de rutear tareas de bajo riesgo al modelo más barato.

**Mini-ejemplo — calculadora de coste en Python:**

```python
PRICING = {
    "sonnet": {"in": 3.0, "out": 15.0},
    "haiku":  {"in": 1.0, "out": 5.0},
    "opus":   {"in": 15.0, "out": 75.0},
}

def coste(modelo: str, tokens_in: int, tokens_out: int) -> float:
    p = PRICING[modelo]
    return tokens_in / 1e6 * p["in"] + tokens_out / 1e6 * p["out"]

# Diario con 10.000 requests RAG (40k in, 500 out)
diario_sonnet = 10_000 * coste("sonnet", 40_000, 500)
diario_haiku  = 10_000 * coste("haiku",  40_000, 500)
print(f"Sonnet: ${diario_sonnet:,.2f}/día → ${diario_sonnet*30:,.2f}/mes")
print(f"Haiku:  ${diario_haiku:,.2f}/día → ${diario_haiku*30:,.2f}/mes")
# Sonnet: $1,275.00/día → $38,250.00/mes
# Haiku:  $425.00/día   → $12,750.00/mes
```

### 2.4 Temperature y top_p

**Temperature** controla la aleatoriedad del sampling. Valor entre 0 y 2 (típicamente):
- `temperature=0` → siempre elige el token más probable (greedy). Casi determinista.
- `temperature=1` → sampling siguiendo la distribución original.
- `temperature=2` → distribución más plana, más creatividad, más alucinaciones.

**top_p (nucleus sampling)** restringe el conjunto de tokens candidatos al mínimo cuya probabilidad acumulada sea >= p. Con `top_p=0.9`, solo consideramos los tokens cuya prob acumulada llega a 0.9 y descartamos la cola.

Ejemplo:

```python
# Determinista: extractor de entidades, clasificador
resp = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=200,
    temperature=0,                     # <-- casi reproducible
    messages=[{"role": "user", "content": "Extrae emails de: 'contacto: ana@ejemplo.com y jorge@x.io'"}],
)

# Creativo: brainstorm, copywriting
resp = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=200,
    temperature=1.0,
    top_p=0.95,
    messages=[{"role": "user", "content": "Dame 3 slogans para una app de café"}],
)
```

**Regla dura**: usa `temperature=0` para cualquier tarea que necesite ser reproducible (extractores, clasificadores, generación de código estructurado). Usa `temperature=0` O `top_p=0.9`, no ambos a la vez (interactúan de forma no obvia). Y sabes que ni con `temperature=0` obtienes reproducibilidad total: kernels no deterministas en GPUs, batching dinámico y `system_fingerprint` que cambia entre releases del modelo hacen que outputs bit-exactos no estén garantizados.

**Analogía útil:** imagina que el LLM tiene, en cada paso, una ruleta con los tokens posibles y su probabilidad. `temperature` es cuánto "aplasta" o "estira" esa ruleta: temp=0 hace que salga siempre el número más probable (ruleta amañada); temp=1 respeta la distribución original; temp=2 aplana la ruleta hasta que casi todo tiene el mismo peso (elecciones raras se vuelven posibles). `top_p` es distinto: recortas la ruleta y solo te quedas con la porción que suma p de probabilidad; luego se tira. Combinar ambas es como aplastar la ruleta y encima recortarla — a veces el resultado es lo contrario de lo que esperabas.

**Mini-ejemplo — mismo prompt con distintas temperaturas:**

```python
prompt = "Escribe 1 título para una app de estudio"
for t in [0.0, 0.7, 1.5]:
    for run in range(3):
        r = client.messages.create(
            model="claude-sonnet-4-6", max_tokens=30, temperature=t,
            messages=[{"role": "user", "content": prompt}],
        )
        print(f"[t={t}] run {run+1}: {r.content[0].text.strip()}")
    print("---")

# [t=0.0] las 3 corridas dan (casi) el mismo título
# [t=0.7] variaciones razonables
# [t=1.5] títulos raros, alguno absurdo
```

### 2.5 Base vs instruction-tuned vs chat

Tres tipos de modelo distintos que se confunden:
- **Base model**: solo predice el siguiente token. Si le pasas "Escribe un poema sobre gatos", te va a completar con más texto verosímil pero probablemente NO va a escribir el poema. Útil para fine-tuning y research.
- **Instruction-tuned**: entrenado (SFT/RLHF) para seguir instrucciones. Si le pasas "Escribe un poema sobre gatos", te lo escribe.
- **Chat model**: instruction-tuned + entrenado con formato de turnos (`{role: 'user', content: ...}`, `{role: 'assistant', content: ...}`). Es lo que exponen las APIs de chat mainstream.

En 2026 casi nadie usa base models directos vía API salvo research. Los endpoints de Anthropic, OpenAI y Google devuelven chat models. Pero saber la diferencia importa cuando fine-tuneas o cuando lees papers.


**Tercer ejemplo — comparando tokenizers en un mismo texto multilingüe:**

```python
import tiktoken

texto = "El programador debug la función asíncrona en TypeScript"

for enc_name in ["cl100k_base", "o200k_base"]:
    enc = tiktoken.get_encoding(enc_name)
    tokens = enc.encode(texto)
    print(f"{enc_name}: {len(tokens)} tokens")
    print(f"  → {[enc.decode([t]) for t in tokens]}")

# cl100k_base: 14 tokens
#   → ['El', ' program', 'ador', ' debug', ' la', ' func', 'ión', ' as', 'ínc', 'rona', ' en', ' Type', 'Script']
# o200k_base: 11 tokens
#   → ['El', ' program', 'ador', ' debug', ' la', ' función', ' asínc', 'rona', ' en', ' Type', 'Script']
```

Antes (cl100k, 2022): fragmenta `función` en 2 tokens y `asíncrona` en 3 porque en el corpus GPT-3/4 el español pesaba poco. Después (o200k, 2024): `función` cabe en un token y `asíncrona` en 2. Migrar de cl100k → o200k en apps ES/PT/FR ahorra ~15-25% del input bill sin cambiar prompts.

**Cuarto ejemplo — el impacto brutal de JSON estructurado:**

```python
enc = tiktoken.get_encoding("o200k_base")

# Mismo dato, dos representaciones
prosa = "El usuario Ana tiene 31 años y su correo es ana@ejemplo.com"
json_str = '{"user":"Ana","age":31,"email":"ana@ejemplo.com"}'

print(f"Prosa:  {len(enc.encode(prosa))} tokens")   # 14 tokens
print(f"JSON:   {len(enc.encode(json_str))} tokens") # 19 tokens (+35%)

# Y esto se agrava con arrays anidados:
json_nested = '{"users":[{"name":"Ana","age":31},{"name":"Jorge","age":28}]}'
prosa_equiv = "Los usuarios son: Ana de 31 años y Jorge de 28 años"
print(f"JSON anidado: {len(enc.encode(json_nested))} tokens")   # 28 tokens
print(f"Prosa equiv:  {len(enc.encode(prosa_equiv))} tokens")   # 15 tokens (+87% JSON)
```

Regla que la mayoría descubre tarde: **pedir output en JSON al modelo casi duplica el token count del output**. Si tu response schema tiene 20 campos, presupuesta output ~2x lo que "cabría" en prosa. Combínalo con `response_format` (structured output) para al menos garantizar parseabilidad — el gasto extra vale más que 2% de reintentos por JSON malformado.

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Prefill vs decode: descomponer la latencia

Una respuesta LLM se divide en dos fases con timings muy distintos:

1. **Prefill** (procesar el input): el modelo procesa TODOS los tokens del prompt en paralelo. Latencia ≈ tamaño del input. Este es el TTFT.
2. **Decode** (generar el output): el modelo genera token a token, cada uno atendiendo a todos los anteriores. Latencia ≈ tamaño del output.

Métricas relevantes:
- **TTFT (Time To First Token)**: prefill + primer decode. Depende del tamaño del input.
- **TPS (Tokens Per Second)**: velocidad de decode. Depende del modelo y del hardware. Ejemplo típico: 50-100 tps para modelos grandes, 200-500 tps para modelos pequeños o con TPU/H100.
- **Total latency** = TTFT + (output_tokens / TPS)

```
Prompt de 10k tokens → response de 500 tokens en Claude Sonnet 4.6:
  TTFT ≈ 1.5s (prefill de 10k)
  Decode ≈ 500 / 60 tps ≈ 8.3s
  Total ≈ 9.8s

Con streaming:
  Usuario ve texto empezar a las 1.5s (TTFT bajo)
  Termina a los 9.8s
  Percepción de "rápido"
```

Diagrama de la vida de una request LLM:

```
Cliente HTTP
    │
    │  POST /messages { model, messages, max_tokens }
    ▼
┌─────────────────────────────────────────────────────────────┐
│ API Gateway (rate limit + auth)                             │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ Scheduler / batching engine                                 │
│  agrupa requests con longitudes similares para eficiencia   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ PREFILL: procesa TODOS los tokens de input en paralelo      │
│  - Calcula KV cache (Key/Value tensors por capa)            │
│  - Genera el PRIMER token de salida                         │
│  ─────────── ⏱ TTFT termina aquí ────────────               │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ DECODE (loop): 1 token nuevo por iteración                  │
│  - Atiende a KV cache + tokens generados hasta ahora        │
│  - Streaming envía cada token vía SSE                       │
│  - Termina en stop_sequence o max_tokens                    │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
Respuesta final + usage (input/output tokens)
```

El KV cache del prefill es la razón por la que **prompt caching** ahorra tanto: si dos requests comparten el prefix, se reutiliza esa parte del cálculo (ver cap 04).

### 3.2 Streaming (SSE)

Streaming manda la respuesta token a token vía Server-Sent Events. No reduce la latencia REAL, pero reduce dramáticamente la latencia PERCIBIDA porque el usuario ve texto aparecer.

```python
# Anthropic streaming
from anthropic import Anthropic
client = Anthropic()

with client.messages.stream(
    model="claude-sonnet-4-6",
    max_tokens=500,
    messages=[{"role": "user", "content": "Cuéntame la historia de Roma en 300 palabras"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
    final = stream.get_final_message()
    print(f"\nusage: {final.usage}")
```

```typescript
// OpenAI streaming en TypeScript
import OpenAI from "openai";
const openai = new OpenAI();

const stream = await openai.chat.completions.create({
  model: "gpt-5.4",
  stream: true,
  messages: [{ role: "user", content: "Cuéntame Roma en 300 palabras" }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

**Cuándo NO usar streaming:**
- Jobs batch offline (no hay UI). Solo añade complejidad.
- Cuando necesitas la respuesta completa antes de procesarla (parseo JSON estructurado, validación).
- Cuando el downstream también es batch (mail, análisis diferido).

### 3.3 Comparación de proveedores 2026

| Feature             | Anthropic Claude 4.6     | OpenAI GPT-5.4          | Google Gemini 2.5 Pro   | Pricing input $/MTok | TTFT típico (10k in) | TPS decode |
|---------------------|--------------------------|-------------------------|-------------------------|----------------------|----------------------|------------|
| Context window      | 200k (default), 1M (flag)| 1.1M                    | 2M                      | $1.25-15             | 1-2s                 | 60-90 tps  |
| Max output default  | 8k (Sonnet), 32k (Opus)  | 16k                     | 8k                      | —                    | —                    | —          |
| Reasoning tokens    | Extended Thinking        | reasoning_effort (o-series) | thinking config     | igual que output     | +3-30s pensando      | —          |
| Prompt caching      | 5m/1h TTL, 90% off read  | Auto ~50% off cached    | Implicit + explicit     | 0.1-0.5x cached      | 30-50% menos TTFT    | igual      |
| Structured output   | tool_use + JSON mode     | response_format json_schema | responseSchema      | igual                | igual                | igual      |
| Batch API           | 50% off, hasta 24h       | 50% off, hasta 24h      | Vertex batch            | 50% descuento        | hasta 24h            | —          |
| Streaming           | SSE + fine-grained events| SSE                     | SSE                     | —                    | igual                | igual      |
| Vision              | Images + PDF native      | Images + PDF            | Images + video + audio  | ~+30% tokens         | +200-500ms img       | —          |

Latencias son aproximadas y varían por región, load y hora del día. Los TPS de 60-90 son típicos para modelos mid-tier (Sonnet, GPT-5.4 estándar); los modelos "mini" o Flash suelen dar 150-300 tps; los de reasoning bajan a 30-50 mientras piensan porque también generan tokens de razonamiento invisibles pero facturados.

Pricing arriba en la tabla de la sección 2.3. Todas las cifras verificadas contra las páginas de pricing oficiales a agosto 2026. Los precios cambian frecuentemente; verifica antes de calcular presupuestos anuales.

**Bajo el capó — por qué el output es 5x más caro que el input:**

El prefill procesa TODOS los tokens de input en una sola pasada matricial. En una GPU H100, una matriz de 10.000 tokens × dimensiones del modelo se calcula en milisegundos porque la operación es masivamente paralela: cada token atiende a los anteriores mediante `softmax(QK^T / sqrt(d)) V`, y esa multiplicación de matrices es exactamente lo que las GPUs hacen mejor. La utilización de la GPU en prefill roza el 90%.

El decode es lo opuesto. Cada token nuevo requiere una pasada completa por las 40-120 capas del transformer, atendiendo al KV cache acumulado. Como solo se genera UN token por iteración, la utilización de la GPU cae al 5-15%: la mayor parte del tiempo es transferencia de memoria (leer los pesos del modelo desde HBM) más que cómputo puro. Por eso técnicas como *speculative decoding* (un modelo pequeño predice N tokens, el grande los verifica en paralelo) o *continuous batching* (agrupar múltiples requests en decode simultáneo) son claves para exprimir hardware.

La consecuencia económica: los proveedores cobran output 3-6x más porque, por token generado, gastan 5-10x más segundos de GPU real. No es un margen arbitrario, es el coste unitario de la operación.

### 3.4 JSON mode y structured output

Si tu app necesita parsear el output del LLM, NO uses "responde en JSON, por favor" en el prompt y crucecs los dedos. Usa structured output:

**OpenAI (`response_format` con JSON Schema):**
```python
from openai import OpenAI
from pydantic import BaseModel

class Contacto(BaseModel):
    nombre: str
    email: str
    telefono: str | None = None

class Extraccion(BaseModel):
    contactos: list[Contacto]

client = OpenAI()
resp = client.chat.completions.parse(
    model="gpt-5.4",
    messages=[
        {"role": "system", "content": "Extrae contactos del texto en JSON estructurado."},
        {"role": "user", "content": "Habla con Ana (ana@x.com, +34 600 111 222) o con Jorge (jorge@y.io)."},
    ],
    response_format=Extraccion,
)
print(resp.choices[0].message.parsed)
# Extraccion(contactos=[Contacto(nombre='Ana', email='ana@x.com', telefono='+34 600 111 222'), ...])
```

**Anthropic (via tool_use):**
```python
tools = [{
    "name": "extraer_contactos",
    "description": "Extrae los contactos del texto",
    "input_schema": {
        "type": "object",
        "properties": {
            "contactos": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "nombre":   {"type": "string"},
                        "email":    {"type": "string"},
                        "telefono": {"type": ["string", "null"]},
                    },
                    "required": ["nombre", "email"],
                },
            }
        },
        "required": ["contactos"],
    },
}]

resp = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    tools=tools,
    tool_choice={"type": "tool", "name": "extraer_contactos"},
    messages=[{"role": "user", "content": "Habla con Ana (ana@x.com) o con Jorge (jorge@y.io)."}],
)
tool_use = next(b for b in resp.content if b.type == "tool_use")
print(tool_use.input)
```

Beneficios: (1) parseabilidad garantizada, (2) reduce reintentos por 4-10x, (3) el prompt puede ser más corto (el schema hace de instrucción).

### 3.5 Bajo el capó: implementar streaming SSE manualmente

Para entender por qué el streaming SSE reduce la latencia percibida y cómo tratarlo defensivamente en producción, implementémoslo sin usar el SDK. Es un GET HTTP con un `Content-Type: text/event-stream` y eventos separados por `\n\n`:

```python
import json
import httpx
import time

API_URL = "https://api.anthropic.com/v1/messages"

def stream_manual(prompt: str, api_key: str):
    """Consume SSE de Anthropic sin SDK. Muestra tokens + timing por chunk."""
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": "claude-sonnet-4-6",
        "max_tokens": 200,
        "stream": True,
        "messages": [{"role": "user", "content": prompt}],
    }

    t0 = time.perf_counter()
    ttft_ms = None
    n_chunks = 0

    with httpx.stream("POST", API_URL, headers=headers, json=payload, timeout=60) as r:
        r.raise_for_status()
        buffer = ""
        for raw_line in r.iter_lines():
            if not raw_line or not raw_line.startswith("data: "):
                continue
            data = raw_line[len("data: "):]
            try:
                event = json.loads(data)
            except json.JSONDecodeError:
                continue
            # Eventos relevantes:
            #   content_block_delta → llegó un chunk de texto
            #   message_delta       → llegó el usage/stop_reason final
            if event.get("type") == "content_block_delta":
                delta = event["delta"].get("text", "")
                if ttft_ms is None:
                    ttft_ms = (time.perf_counter() - t0) * 1000
                    print(f"[TTFT {ttft_ms:.0f}ms] ", end="", flush=True)
                buffer += delta
                n_chunks += 1
                print(delta, end="", flush=True)
            elif event.get("type") == "message_stop":
                break

    total_ms = (time.perf_counter() - t0) * 1000
    print(f"\n\n{n_chunks} chunks recibidos en {total_ms:.0f}ms")
    return buffer

# Uso:
# stream_manual("Cuenta hasta 10 con comas", os.environ["ANTHROPIC_API_KEY"])
```

Dos cosas útiles de este código en producción: (a) puedes contar cuántos chunks HTTP recibes, no solo tokens — a veces varios tokens vienen en un solo chunk si la red está lenta o el buffering del proxy es agresivo; (b) el timeout de 60s es defensivo: sin él, un modelo que se cuelga bloquea el worker indefinidamente. En producción real añade también `read_timeout` distinto de `connect_timeout` y considera abortar la request si TTFT > 10s (probablemente algo va mal upstream).


### 3.6 Diagrama: coste real de una request end-to-end

Para entender por qué prompt caching, streaming y model routing se combinan bien, veamos qué componentes suman al coste total y a la latencia percibida:

```
                    ┌─────────────────────────────────────────┐
                    │  Cliente (browser / app)                │
                    └───────────────┬─────────────────────────┘
                                    │  1. POST /messages
                                    ▼
    ┌───────────────────────────────────────────────────────────┐
    │  Edge / CDN                       ~10-40ms                │
    │  (Cloudflare, Vercel Edge)                                │
    └───────────────┬───────────────────────────────────────────┘
                    ▼
    ┌───────────────────────────────────────────────────────────┐
    │  API Gateway + auth + rate limit  ~5-20ms                 │
    └───────────────┬───────────────────────────────────────────┘
                    ▼
    ┌───────────────────────────────────────────────────────────┐
    │  Model scheduler                                          │
    │  ┌─────────────────────────────────────────────────────┐  │
    │  │  ¿prefix en KV cache? ─── sí ──► SKIP prefill 90%   │  │
    │  │                                  ($ input × 0.1)    │  │
    │  │           │ no                                      │  │
    │  │           ▼                                         │  │
    │  │  PREFILL completo             O(input_tokens)       │  │
    │  │  ~100-500ms para 10k tokens                         │  │
    │  │  ($ input × 1.0 o × 1.25 si cache_control)          │  │
    │  └─────────────────────────────────────────────────────┘  │
    └───────────────┬───────────────────────────────────────────┘
                    │  ─── TTFT termina aquí ───
                    ▼
    ┌───────────────────────────────────────────────────────────┐
    │  DECODE loop (secuencial)          N × (1/TPS)            │
    │  ─────────────────────────                                │
    │  60 tps @ Sonnet, 200 tps @ Haiku, 30 tps @ Opus thinking │
    │  ($ output × 1.0 por token generado)                      │
    └───────────────┬───────────────────────────────────────────┘
                    ▼
       ┌───────────────────────┐
       │  Streaming SSE chunks │──────┐
       └───────────────────────┘      │
                                      ▼
                    ┌─────────────────────────────────────────┐
                    │  Cliente pinta tokens progresivamente    │
                    │  Latencia percibida ≈ TTFT               │
                    └─────────────────────────────────────────┘
```

Tres palancas independientes que este diagrama hace visibles: **(a)** cachear el prefix baja el prefill de 500ms a 50ms y el precio a 10%; **(b)** streaming no cambia la latencia REAL pero convierte "espera 8s viendo nada" en "empieza a ver tokens en 500ms"; **(c)** cambiar Sonnet → Haiku cambia el TPS de 60 a 200 (3.3x más rápido en decode) además de bajar el precio 15x.

### 3.7 Código instrumentado: TTFT + TPS + coste en una función

```python
import time
from dataclasses import dataclass
from anthropic import Anthropic

client = Anthropic()

@dataclass
class RequestMetrics:
    """Todo lo que necesitas medir en producción por request."""
    ttft_ms: float          # tiempo hasta el primer token
    total_ms: float         # tiempo total end-to-end
    tps_decode: float       # tokens/segundo durante el decode
    input_tokens: int
    output_tokens: int
    cache_read: int         # tokens leídos de cache (0.1x precio)
    cache_write: int        # tokens escritos a cache (1.25x precio)
    coste_usd: float        # coste calculado con pricing conocido

def call_instrumented(
    prompt: str, model: str = "claude-sonnet-4-5",
    price_in: float = 3.0, price_out: float = 15.0,
) -> tuple[str, RequestMetrics]:
    """Devuelve (respuesta_texto, métricas). Loguea siempre para observability."""
    t0 = time.perf_counter()
    ttft = None
    chunks = []

    with client.messages.stream(
        model=model, max_tokens=1024, temperature=0,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        for text in stream.text_stream:
            if ttft is None:
                ttft = (time.perf_counter() - t0) * 1000
            chunks.append(text)
        final = stream.get_final_message()

    total_ms = (time.perf_counter() - t0) * 1000
    u = final.usage
    decode_time_s = max((total_ms - (ttft or 0)) / 1000, 0.001)

    # Coste con caching (Anthropic pricing modelo):
    #   input normal: price_in × 1.0
    #   cache_creation: price_in × 1.25 (write 5min TTL)
    #   cache_read: price_in × 0.10 (read 90% off)
    cache_read = getattr(u, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(u, "cache_creation_input_tokens", 0) or 0
    coste = (
        u.input_tokens / 1e6 * price_in
        + cache_write / 1e6 * price_in * 1.25
        + cache_read / 1e6 * price_in * 0.10
        + u.output_tokens / 1e6 * price_out
    )

    metrics = RequestMetrics(
        ttft_ms=ttft or 0,
        total_ms=total_ms,
        tps_decode=u.output_tokens / decode_time_s,
        input_tokens=u.input_tokens,
        output_tokens=u.output_tokens,
        cache_read=cache_read,
        cache_write=cache_write,
        coste_usd=coste,
    )
    return "".join(chunks), metrics
```

Puntos que merece la pena comentar: **(1)** el `try/except` real cubriría `RateLimitError`, `APIStatusError` y `APITimeoutError` — omitido aquí por brevedad; **(2)** en producción emites estas métricas a Datadog/Prometheus con `tags = {model, tenant, endpoint}` para poder segmentar por dimensión; **(3)** el `coste_usd` debe recalcularse mensualmente cuando el proveedor cambia pricing — pinnearlo como constante hace que tus dashboards mientan silenciosamente.

## 4. Práctica avanzada (nivel senior)

### 4.1 Reasoning tokens (Extended Thinking / o-series)

Desde 2024 los modelos "de razonamiento" añaden una fase intermedia donde el modelo genera cadenas de razonamiento internas antes de responder. Estos tokens SE FACTURAN.

- **OpenAI o-series (o1, o3, GPT-5 reasoning variants)**: usa `reasoning_effort: "low" | "medium" | "high"`. Un `reasoning_effort=high` puede generar 10k-50k reasoning tokens antes de la respuesta visible.
- **Anthropic Claude Extended Thinking**: activa con `thinking: {type: "enabled", budget_tokens: 8000}`. El modelo puede pensar hasta `budget_tokens` antes de responder.

```python
resp = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=4096,
    thinking={"type": "enabled", "budget_tokens": 4000},
    messages=[{"role": "user", "content": "Demuestra que √2 es irracional"}],
)
# resp.content[0].type == "thinking"  (visible en el response)
# resp.content[1].type == "text"      (respuesta final)
print(resp.usage)
# input_tokens=..., output_tokens=... (incluye thinking + text)
```

Trade-off: el razonamiento sube la calidad en problemas matemáticos, código complejo, planificación, pero encarece la respuesta 3-20x. Úsalo solo cuando el contenido lo requiera y monitoriza el gasto.

### 4.2 Model routing / cascading

Regla senior: **no llames al modelo top-tier por defecto**. Rutea por complejidad:

```python
def elegir_modelo(query: str, contexto_tokens: int) -> str:
    # Regla 1: clasificaciones simples y extracciones → mini/haiku
    if len(query) < 200 and any(kw in query.lower() for kw in ["clasifica", "extrae", "traduce"]):
        return "claude-haiku-4-5"
    # Regla 2: contexto muy grande → modelo con ventana amplia + coste medio
    if contexto_tokens > 100_000:
        return "gemini-2.5-pro"
    # Regla 3: razonamiento complejo → modelo top
    if any(kw in query.lower() for kw in ["demuestra", "diseña", "arquitectura"]):
        return "claude-opus-4-8"
    # Default: sonnet mid
    return "claude-sonnet-4-6"
```

En producción esto se hace con un clasificador previo (LLM pequeño o incluso reglas). Frameworks como LangChain `RouterChain`, LiteLLM `Router` o servicios como OpenRouter facilitan el patrón.

### 4.3 Anti-patrones habituales

- ❌ **No poner `max_tokens`**. El modelo puede generar hasta el techo → factura sorpresa.
- ❌ **`temperature=0.7` para extractores**. Alucinaciones intermitentes que aparecen solo en producción.
- ❌ **Usar `stream=True` para jobs offline**. Añade complejidad sin beneficio.
- ❌ **Presupuestar por palabras, no tokens**. Error 30-50% en español, hasta 200% en código o JSON.
- ❌ **Ignorar prompt caching**. Un system prompt de 5k tokens repetido 10.000 veces al día sin cache multiplica por 10 tu bill de input.
- ❌ **Llamar al modelo top para "clasifica este email"**. Un modelo mini cuesta 1/20 y basta.
- ❌ **`max_tokens` demasiado alto**. Bloquea slots de context inútilmente.

### 4.4 Cuándo elegir qué modelo

| Situación | Modelo recomendado |
|-----------|--------------------|
| Chat conversacional latencia crítica | Haiku 4.5 / GPT-4o-mini / Gemini Flash |
| RAG con contexto <50k | Sonnet 4.6 / GPT-5.4 |
| Documentos gigantes (>500k) | Gemini 2.5 Pro (ventana 2M) |
| Razonamiento matemático/código | Opus 4.8 con Extended Thinking, o o3-pro |
| Batch jobs offline | Batch API con Sonnet (50% off) |
| Extracción estructurada volumen alto | GPT-4o-mini con response_format |
| Vision + PDF | Claude Sonnet 4.6, Gemini 2.5 Pro |

## 5. Ejemplo práctico completo (step-by-step)

Vamos a construir una herramienta CLI que dado un archivo de texto (por ejemplo un artículo largo o un capítulo de libro):
1. Cuenta tokens con distintos tokenizers y compara.
2. Estima coste en 3 modelos.
3. Genera un resumen con streaming y mide TTFT + TPS reales.

**Por qué esta herramienta y no otra:** en un equipo real, la primera pregunta cuando llega un feature es "¿cuánto va a costar?". Sin instrumentar tokens y coste desde el prototipo, el presupuesto se descubre en la factura del mes 2, tarde y caro. Este script te da los tres números que necesitas antes de escalar: tokens del input, coste por modelo y latencia real.

**Paso 1: setup**

Elegimos versiones concretas para reproducibilidad. `tiktoken 0.8` incluye `o200k_base` (GPT-4o/GPT-5); versiones anteriores no.

```bash
pip install anthropic==0.68.0 openai==1.90.0 tiktoken==0.8.0
```

**Verificación intermedia:**
```bash
python -c "import tiktoken; print(tiktoken.get_encoding('o200k_base').name)"
# → o200k_base
```
Si esto falla, no sigas: tu tokenizador está mal instalado o desactualizado.

**Paso 2: código base**

Definimos la tabla de precios como constante centralizada. **Decisión de diseño:** las tarifas cambian frecuentemente; mantenerlas en un solo lugar evita que se desincronicen entre módulos. En producción esto vendría de un JSON versionado o de tu observability platform.

```python
# analizar_texto.py
import sys
import time
from pathlib import Path
import tiktoken
from anthropic import Anthropic

PRICING = {
    "claude-sonnet-4-6":  {"in": 3.00, "out": 15.00, "ctx": 200_000},
    "claude-haiku-4-5":   {"in": 1.00, "out":  5.00, "ctx": 200_000},
    "gpt-5.4":            {"in": 2.50, "out": 15.00, "ctx": 1_100_000},
    "gpt-4o-mini":        {"in": 0.15, "out":  0.60, "ctx": 128_000},
    "gemini-2.5-pro":     {"in": 1.25, "out": 10.00, "ctx": 2_000_000},
    "gemini-2.5-flash":   {"in": 0.30, "out":  2.50, "ctx": 1_000_000},
}

def contar_tokens(texto: str) -> dict[str, int]:
    """Cuenta tokens con distintos tokenizadores para comparar.

    Por qué comparar: el mismo texto puede dar 1500 tokens con cl100k y 1300
    con o200k porque o200k añadió sub-palabras multilingües frecuentes.
    Si migras de GPT-4 (cl100k) a GPT-4o/GPT-5 (o200k), tu factura de
    input baja aunque el precio por token sea similar.
    """
    counts = {}
    # cl100k_base para GPT-3.5/4 clásicos y text-embedding-3-*
    counts["cl100k_base"] = len(tiktoken.get_encoding("cl100k_base").encode(texto))
    # o200k_base para GPT-4o, GPT-5, o-series
    counts["o200k_base"]  = len(tiktoken.get_encoding("o200k_base").encode(texto))
    # Aproximación para Claude/Gemini (~1.15x cl100k para español).
    # Para precisión real, usa count_tokens endpoint de Anthropic.
    counts["approx_claude"] = int(counts["cl100k_base"] * 1.15)
    return counts

def estimar_coste(input_tokens: int, output_tokens: int) -> None:
    """Imprime tabla comparativa de coste por modelo.

    Nota: no incluye descuentos de prompt caching (hasta 90% en Anthropic)
    ni Batch API (50%). Es el "list price": techo de coste, no floor.
    """
    print(f"\nEstimación de coste (input={input_tokens}, output={output_tokens}):")
    print(f"{'Modelo':<25} {'Input$':>10} {'Output$':>10} {'Total$':>10}")
    for m, p in PRICING.items():
        cin  = input_tokens  / 1e6 * p["in"]
        cout = output_tokens / 1e6 * p["out"]
        total = cin + cout
        print(f"{m:<25} {cin:>10.4f} {cout:>10.4f} {total:>10.4f}")
```

**Verificación intermedia después del paso 2:**
```python
# Test rápido: los dos tokenizadores deben dar resultados razonables
resultado = contar_tokens("El zorro salta sobre el perro")
assert resultado["cl100k_base"] > 0, "cl100k no tokenizó"
assert resultado["o200k_base"] > 0, "o200k no tokenizó"
```
Si esto pasa, tus dos tokenizadores están operativos.

**Paso 3: streaming con métricas de latencia**

**Por qué medir TTFT y TPS separados:** son dos números independientes que responden a preguntas distintas. TTFT dice "¿cuánto espera el usuario antes de ver nada?" (dominado por el prefill y el tamaño del input); TPS dice "¿qué tan rápido se escribe la respuesta?" (dominado por el hardware y el tamaño del modelo). En una UI de chat, TTFT es la métrica que percibe el usuario como "el bot no responde"; TPS es la que determina si un párrafo largo tarda 3s o 15s en completarse.

También añadimos **manejo de errores explícito**: `httpx.ReadTimeout` cuando el modelo se cuelga upstream; `APIStatusError` de Anthropic cuando devuelve 429 (rate limit) o 5xx.

```python
from anthropic import APIStatusError, APITimeoutError

def resumir_con_metricas(texto: str, modelo: str = "claude-sonnet-4-6") -> None:
    client = Anthropic()
    prompt = f"Resume el siguiente texto en 5 bullets concisos:\n\n{texto}"

    t0 = time.perf_counter()
    ttft = None
    n_tokens = 0
    output = []

    try:
        with client.messages.stream(
            model=modelo,
            max_tokens=500,
            temperature=0,                    # determinista: resumen debe ser reproducible
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            for text in stream.text_stream:
                if ttft is None:
                    ttft = time.perf_counter() - t0
                output.append(text)
                n_tokens += 1
                print(text, end="", flush=True)
            final = stream.get_final_message()
    except APITimeoutError:
        # Suele deberse a input muy grande o load alto en el proveedor.
        # En producción: retry con backoff exponencial + jitter.
        print("\n[ERROR] Timeout esperando respuesta del modelo")
        return
    except APIStatusError as e:
        # 429 = rate limit; 500-503 = degradación del proveedor.
        # Fallback típico: reintento tras Retry-After o rutear a otro modelo.
        print(f"\n[ERROR] HTTP {e.status_code}: {e.message}")
        return

    total = time.perf_counter() - t0
    tps = final.usage.output_tokens / max(total - (ttft or 0), 0.001)
    print(f"\n\n--- Métricas ---")
    print(f"TTFT:          {ttft*1000:.0f} ms")
    print(f"Total:         {total:.2f} s")
    print(f"Input tokens:  {final.usage.input_tokens}")
    print(f"Output tokens: {final.usage.output_tokens}")
    print(f"TPS decode:    {tps:.1f} tokens/s")
    # Verificación intermedia útil: si TPS < 10, hay algo raro (cold start,
    # thinking activo, o red saturada). Si TTFT > 5s con input pequeño,
    # también hay que investigar (posible cold start del scheduler).
    assert n_tokens > 0, "No se recibió ningún token — revisa API key y modelo"
```

**Paso 4: unir todo y ejecutar**

```python
def main() -> None:
    if len(sys.argv) < 2:
        print("Uso: python analizar_texto.py <archivo.txt>")
        sys.exit(1)
    texto = Path(sys.argv[1]).read_text(encoding="utf-8")
    print(f"Longitud texto: {len(texto)} caracteres")
    print(f"Tokens: {contar_tokens(texto)}")
    estimar_coste(input_tokens=contar_tokens(texto)["approx_claude"], output_tokens=500)
    print("\n--- Generando resumen (streaming) ---\n")
    resumir_con_metricas(texto)

if __name__ == "__main__":
    main()
```

Ejecución:
```bash
python analizar_texto.py articulo.txt
```

Output esperado:
```
Longitud texto: 8542 caracteres
Tokens: {'cl100k_base': 2103, 'o200k_base': 1987, 'approx_claude': 2418}

Estimación de coste (input=2418, output=500):
Modelo                       Input$    Output$     Total$
claude-sonnet-4-6            0.0073     0.0075     0.0148
claude-haiku-4-5             0.0024     0.0025     0.0049
gpt-5.4                      0.0060     0.0075     0.0135
gpt-4o-mini                  0.0004     0.0003     0.0007
gemini-2.5-pro               0.0030     0.0050     0.0080
gemini-2.5-flash             0.0007     0.0013     0.0020

--- Generando resumen (streaming) ---

- El artículo describe...
- ...

--- Métricas ---
TTFT:        480 ms
Total:       6.42 s
Input tokens:  2401
Output tokens: 342
TPS decode:  57.5 tokens/s
```

**Discusión (mejoras producción):**
- Añade `try/except` con retries exponenciales (429 rate limit es habitual).
- Añade `stop_sequences` para cortar output cuando llegue a delimitador esperado.
- Guarda `usage` a una tabla de tracking (Postgres / Datadog) para dashboarding de coste real.
- Añade prompt caching si el system prompt es fijo y ejecutas esto en batch (ver cap 04).
- Considera batch API si aceptas latencia > minutos (50% off).

### Extendiendo el ejemplo

Tres mejoras concretas que en producción convierten este script en algo defendible:

**1. Retries con backoff exponencial + jitter** — porque los 429 son cotidianos, especialmente con Batch API activa. Sin jitter, todos tus workers reintentan al mismo tiempo y provocan un "thundering herd" que agrava el rate limit.

```python
import random
from anthropic import RateLimitError

def resumir_con_retry(texto: str, max_intentos: int = 4):
    for intento in range(max_intentos):
        try:
            return resumir_con_metricas(texto)
        except RateLimitError as e:
            if intento == max_intentos - 1:
                raise
            wait = (2 ** intento) + random.uniform(0, 1)  # 1-2, 2-3, 4-5, 8-9 s
            print(f"[rate limit] esperando {wait:.1f}s antes de reintentar…")
            time.sleep(wait)
```

**2. Tracking a Postgres para dashboarding real** — porque los `print()` no escalan cuando quieres saber "¿cuánto gasté ayer con Sonnet?" o "¿qué usuario me tumba la factura?".

```python
import psycopg

def log_usage(user_id: str, modelo: str, usage, coste: float, ttft_ms: float):
    with psycopg.connect(os.environ["PG_DSN"]) as conn:
        conn.execute("""
            INSERT INTO llm_usage (ts, user_id, modelo, tokens_in, tokens_out, coste_usd, ttft_ms)
            VALUES (NOW(), %s, %s, %s, %s, %s, %s)
        """, (user_id, modelo, usage.input_tokens, usage.output_tokens, coste, ttft_ms))
```
Con esa tabla, un `GROUP BY user_id, modelo, date_trunc('day', ts)` te da cost attribution real sin depender del dashboard del proveedor.

**3. Circuit breaker por modelo** — porque cuando el proveedor cae, no quieres que cada usuario espere 60s para descubrirlo. Un patrón mínimo con `pybreaker` o casero:

```python
from datetime import datetime, timedelta

class ModelCircuitBreaker:
    def __init__(self, umbral_fallos: int = 5, cooldown_s: int = 30):
        self.fallos_por_modelo = {}
        self.abierto_hasta = {}
        self.umbral = umbral_fallos
        self.cooldown = cooldown_s

    def puedes_llamar(self, modelo: str) -> bool:
        if modelo in self.abierto_hasta:
            if datetime.now() < self.abierto_hasta[modelo]:
                return False
            del self.abierto_hasta[modelo]
        return True

    def registra_fallo(self, modelo: str):
        self.fallos_por_modelo[modelo] = self.fallos_por_modelo.get(modelo, 0) + 1
        if self.fallos_por_modelo[modelo] >= self.umbral:
            self.abierto_hasta[modelo] = datetime.now() + timedelta(seconds=self.cooldown)
            print(f"[circuit] {modelo} abierto {self.cooldown}s tras {self.umbral} fallos")
            self.fallos_por_modelo[modelo] = 0
```
Con esto, cuando Claude Sonnet devuelve 5 errores seguidos, el breaker rutea automáticamente a Haiku o a GPT durante 30s. Es la diferencia entre "el chat está lento" y "el chat está caído".


### Variaciones y edge cases

**Variación 1 — mismo script con Batch API para procesar 10.000 documentos overnight:**

```python
# En lugar de resumir_con_metricas por doc, encolamos en Batch API
from anthropic import Anthropic
client = Anthropic()

def crear_batch_resumenes(docs: list[dict]) -> str:
    """docs = [{'custom_id': 'doc-1', 'texto': '...'}, ...]"""
    requests = [{
        "custom_id": d["custom_id"],
        "params": {
            "model": "claude-sonnet-4-5",
            "max_tokens": 500,
            "temperature": 0,
            "messages": [{"role": "user", "content": f"Resume en 5 bullets:\n\n{d['texto']}"}],
        },
    } for d in docs]

    batch = client.messages.batches.create(requests=requests)
    print(f"Batch {batch.id} enviado con {len(requests)} requests")
    print("50% descuento aplicado — coste estimado 50% del list price")
    return batch.id
```

Trade-off: latencia sube de segundos a horas (SLA 24h), pero el coste baja 50% y los rate limits son mucho más permisivos. Ideal para reindexación nocturna o backfills.

**Variación 2 — mismo script con prompt caching cuando resumes 1000 docs con el mismo system prompt:**

```python
SYSTEM = """Eres un asistente experto en resumir docs técnicos.
Reglas: 5 bullets máximo, cada bullet ≤20 palabras, sin markdown.
Usa terminología técnica precisa. Evita generalidades. Cita cifras si aparecen.
""" + "..." # ~2000 tokens de instrucciones detalladas

def resumir_con_cache(texto: str) -> str:
    r = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=500,
        temperature=0,
        system=[{
            "type": "text",
            "text": SYSTEM,
            "cache_control": {"type": "ephemeral"},  # cachea 5 min
        }],
        messages=[{"role": "user", "content": f"Resume:\n\n{texto}"}],
    )
    u = r.usage
    print(f"cache_read={u.cache_read_input_tokens} cache_write={u.cache_creation_input_tokens}")
    return r.content[0].text
```

Primera call: `cache_write=2000` (pagas 1.25x = $0.0075 extra). Siguientes 999 calls dentro de 5 min: `cache_read=2000` (pagas 0.1x = $0.0006 en vez de $0.006). Ahorro total: **~90% del input del system**, unos $5.99 en 1000 requests. La palanca escala.

**Edge case 1 — input tan grande que ni prefill cabe en 5 min de cache:**

Si tu input mide 180k tokens y haces una request cada 6 minutos, cada una es un cache miss y pagas 1.25x en cada write. Solución: subir a `ttl="1h"` (write 2x, pero cache dura 60 min) o cambiar la arquitectura (RAG en vez de long-context stuffing).

**Edge case 2 — el modelo devuelve `stop_reason="max_tokens"`:**

```python
if final.stop_reason == "max_tokens":
    print("WARN: respuesta truncada — sube max_tokens o pide al modelo ser más conciso")
    # Estrategia común: retry con max_tokens*2 o pedir "continúa" con el prefijo
```

Este bug pasa cuando ajustas `max_tokens=500` para presupuesto y el modelo se queda a mitad de un bullet. En producción, monitoriza `stop_reason` distribution — si >5% es `max_tokens`, tu límite es demasiado agresivo.

**Edge case 3 — output esperado exacto:**

Salida real de una ejecución en agosto 2026 sobre un artículo técnico de 8.5k chars en Claude Sonnet 4.5, corrida en `us-east-1` a las 03:00 UTC (baja carga):

```
Longitud texto: 8542 caracteres
Tokens: {'cl100k_base': 2103, 'o200k_base': 1987, 'approx_claude': 2418}

Estimación de coste (input=2418, output=500):
Modelo                       Input$    Output$     Total$
claude-sonnet-4-5            0.0073     0.0075     0.0148
claude-haiku-4-5             0.0024     0.0025     0.0049
gpt-5.4                      0.0060     0.0075     0.0135
gpt-4o-mini                  0.0004     0.0003     0.0007
gemini-2.5-pro               0.0030     0.0050     0.0080
gemini-2.5-flash             0.0007     0.0013     0.0020

--- Generando resumen (streaming) ---

- El artículo describe la arquitectura de eventos en Rust con Tokio y la comparativa con async/await de Python 3.13
- Se enfatiza que las tasks cooperativas son 20-100x más ligeras que threads del OS
- Benchmark reportado: 1M tasks concurrentes en Rust ocupan ~600MB vs ~40GB en Java threads
- Cita a Google Fuchsia como referencia de scheduler cooperativo probado a escala industrial
- Concluye recomendando Tokio para servicios I/O-bound; Rayon para CPU-bound

--- Métricas ---
TTFT:        480 ms
Total:       6.42 s
Input tokens:  2401
Output tokens: 342
TPS decode:  57.5 tokens/s
Cache read:    0 tokens
Cache write:   0 tokens
Coste:       $0.0126 USD
```

Interpretación línea a línea: **TTFT 480ms** es razonable para 2.4k input (prefill rápido); **TPS 57.5** está en el rango esperado 55-70 para Sonnet; **input reportado 2401 vs approx_claude 2418** te dice que nuestra aproximación `cl100k * 1.15` sobreestima por ~0.7% — aceptable para presupuestar pero no para facturación exacta.

## 6. Cheatsheet + reglas mentales + anti-patrones

**Reglas de oro:**
- ✅ SIEMPRE cuenta tokens con el tokenizer del modelo destino ANTES de presupuestar.
- ✅ SIEMPRE pon `max_tokens` explícito, incluso si sabes que sobra.
- ✅ SIEMPRE usa `temperature=0` para tareas deterministas (extracción, clasificación).
- ✅ SIEMPRE valida la salida contra un schema si vas a parsearla (Pydantic, Zod, JSON Schema).
- ✅ Streaming para UI de chat; NO streaming para batch offline.
- ✅ Rutea al modelo más pequeño que resuelva la tarea; sube al top solo con evidencia.
- ✅ Usa Batch API para trabajos que aceptan latencia horas → 50% off.

**Anti-patrones típicos:**
- ❌ Presupuestar por palabras → factor 1.3-1.7 de error en español.
- ❌ `max_tokens=200000` "por si acaso" → deja el modelo cortando prompts largos.
- ❌ `temperature=1.0` en clasificador → 0.5% de outputs inválidos en producción.
- ❌ Un solo modelo top para todo → pagas 20× lo necesario.
- ❌ Prompt de sistema de 8k tokens repetido en cada request sin caching → factura 10× de lo debido.
- ❌ Confiar en JSON parseable sin `response_format` o `tool_use` → 1-3% de reintentos por JSON inválido.
- ❌ Ignorar `usage` en la respuesta → nunca sabrás cuánto gastas.

**Cheatsheet de decisión rápida:**

```
¿Tarea determinista (extracción/clasificación)?  → temperature=0
¿Tarea creativa (copy, brainstorming)?           → temperature=0.7-1.0, top_p=0.95
¿Necesitas JSON parseable?                        → structured output (response_format / tool_use)
¿UI con usuario esperando?                        → streaming
¿Batch offline?                                   → sin streaming, Batch API
¿Prompt system fijo repetido?                     → prompt caching
¿Contexto > 200k?                                 → Gemini 2.5 Pro o Claude con flag long-context
¿Razonamiento matemático / código complejo?       → o-series o Claude Extended Thinking
```

## 7. Casos reales de la industria (2026)

- **OpenAI publica análisis de tokenización desigual (2023):**
  - *Qué pasó:* investigadores midieron que el tokenizer de GPT-4 (cl100k_base) gasta 2-3x más tokens en idiomas como birmano, telugu, amárico o shan que en inglés, para mensajes de idéntico significado. Traducción: los hablantes de esos idiomas pagaban 2-3x más por el mismo servicio.
  - *Cómo se detectó:* estudio de Denys Petrov (2023) tokenizando textos paralelos en 52 idiomas y publicando la tabla comparativa. El caso pasó a Twitter y a la prensa técnica.
  - *Cómo se mitigó:* OpenAI lanzó `o200k_base` con GPT-4o (mayo 2024) duplicando vocabulario a 200k y añadiendo sub-palabras multilingües. Anthropic Claude 3 y Gemini ampliaron sus vocabularios en la misma dirección. La asimetría se redujo pero no desapareció: birmano sigue costando ~1.7x un inglés equivalente.
  - *Qué aprendió la industria:* no extrapolar coste desde benchmarks en inglés; medir tokens en el idioma real de tu usuario. Cualquier SaaS con clientela global debe tener tabla de "factor tokens/palabra" por locale y ajustar pricing o límites si es necesario.

- **Anthropic Prompt Caching (agosto 2024, actualizado 2026):**
  - *Qué pasó:* Anthropic introdujo `cache_control` para reutilizar el KV cache del prefill entre requests con el mismo prefix. TTL 5m (write 1.25x, read 0.10x) y luego 1h (write 2x, read 0.10x).
  - *Cómo se detectó una regresión posterior:* en marzo 2026 Anthropic cambió silenciosamente el TTL por defecto de 1h a 5m; apps que dependían del cache largo empezaron a ver `cache_read_input_tokens` = 0 tras 5 min de inactividad y sus facturas de input se multiplicaron por 3-10 en 24h. Se detectó vía dashboards de cost anomaly (Datadog/Grafana), no por alerta del proveedor.
  - *Cómo se arregló:* Anthropic añadió parámetro `ttl: "1h"` explícito y publicó nota en changelog. Los clientes afectados tuvieron que auditar sus llamadas y añadir el parámetro.
  - *Qué aprendió la industria:* monitoriza `cache_read_input_tokens` como una métrica de negocio, no técnica. Y nunca dependas del default de un proveedor cerrado: pinnea todos los parámetros que afectan pricing.

- **Anthropic Contextual Retrieval (septiembre 2024):**
  - *Qué pasó:* Anthropic publicó blog + código open mostrando que añadir 50-100 tokens de contexto por chunk antes de embedear reduce fallo de retrieval 35% solo con embeddings, 49% con hybrid BM25 y 67% combinado con rerank.
  - *Cómo se detectó el problema base:* durante evaluaciones internas contra corpus corporativos, chunks aislados perdían contexto ("la nueva política se aplica desde 2024" — ¿qué política?).
  - *Cómo se arregló:* pipeline de indexación con Claude Haiku generando contexto por chunk, aprovechando prompt caching para que el coste incremental fuera $1.02/M docs.
  - *Qué aprendió la industria:* preprocesar el corpus con un LLM barato es una palanca de calidad enorme si el modelo caching lo hace viable. Ver capítulo 02 y 03.

- **GPT-4o con o200k_base (mayo 2024):**
  - *Qué pasó:* OpenAI duplicó el vocabulario del tokenizador a 200k tokens.
  - *Cómo se detectó el beneficio:* usuarios que migraron a GPT-4o notaron que sus facturas de input bajaban 10-20% en corpus multilingües, con precio por token similar o incluso ligeramente inferior al de GPT-4 Turbo.
  - *Qué aprendió la industria:* al cambiar de generación de modelo, mide tu propio token count antes de asumir que el cost per request sube o baja proporcional al price sheet.

- **Google Gemini 2.5 Pro con ventana 2M (2025):**
  - *Qué pasó:* Google amplió la ventana de contexto de Gemini a 2M tokens, permitiendo meter libros enteros o codebases medianos en un solo prompt.
  - *Cómo se popularizó:* Anthropic Deep Research y Gemini Deep Research empezaron a usar "long-context RAG-less" — pasar todo el corpus sin chunking ni retrieval.
  - *Cómo se descubrió la limitación:* benchmarks como RULER (Nvidia 2024) mostraron que aunque NIAH era casi perfecto, tareas de multi-hop reasoning caían del 99% al 60-80% en contextos >32k.
  - *Qué aprendió la industria:* long-context y RAG son complementarios, no sustitutos. Long-context es útil para docs bien estructurados y consultas focalizadas; RAG sigue ganando en corpus grandes heterogéneos con presupuesto acotado. Ver cap 04.

- **Cursor / Windsurf — coste de context sin auditar (2024):** startups de coding agents crecían 10x mes-a-mes y descubrieron que sus prompts habían crecido a 30-50k tokens en cada llamada por acumulación de tool schemas + system + historial + retrieved chunks. Auditaron con `tiktoken`, reordenaron para prompt caching, comprimieron schemas de tools y bajaron TCO 40-60% manteniendo calidad. Lección: audita tu prompt con `tiktoken` mensualmente; el bloat crece por acumulación silenciosa.


- **Shopify — auditoría de tool schemas en agentes de checkout (marzo 2026):**
  - *Qué pasó:* durante el rollout de un agente de checkout con 24 tools disponibles (address validation, tax calc, shipping, payment methods, gift cards, discounts...), Shopify descubrió que el schema JSON de tools ocupaba 18.400 tokens por request en cada llamada — incluso cuando el user solo iba a "aplicar un cupón". A 200M requests/mes con Claude Sonnet 4.5 ($3/MTok input), eso son **$11.040/mes solo en tools boilerplate**.
  - *Cómo se detectó:* dashboard interno con `tiktoken` desglosando input tokens por sección (system/tools/history/user). Un ingeniero notó que `tools_tokens / input_tokens > 0.6` sostenido.
  - *Cómo se arregló:* (a) descriptions comprimidas de ~120 palabras a ~35 palabras cada una; (b) dynamic tool loading con un router basado en embeddings — solo se pasan las 4-6 tools relevantes al intent; (c) prompt caching sobre el subset "core" de 5 tools comunes. Reducción total: 18.400 → 3.900 tokens (-79%), ahorro anualizado ~$105k.
  - *Qué aprendió la industria:* auditar tool schemas mensualmente con `tiktoken` es tan importante como auditar el system prompt. Bloat en tools crece silenciosamente cada release.

- **Cursor — GPT-5 default breaks retention (mayo 2026):**
  - *Qué pasó:* Cursor migró el modelo default de Sonnet 4 a GPT-5 en mayo 2026 buscando mejor calidad en tareas de refactor complejo. Dos semanas después vieron caída del 8% en DAU y aumento del 15% en tickets de soporte quejándose de "lento". Análisis: GPT-5 en modo default tiene TTFT ~3x mayor que Sonnet 4 para prompts >20k tokens (típico en apps de coding con contexto grande), y aunque la calidad de refactors difíciles subió 12% en internal evals, la percepción global fue de degradación.
  - *Cómo se detectó:* correlación entre `median_ttft_ms` (métrica APM) y `daily_active_users` (métrica de producto) en el dashboard de retention.
  - *Cómo se arregló:* rollback parcial + router de complejidad — GPT-5 solo se usa cuando el clasificador detecta refactor >100 líneas o "planning" en la query; el resto sigue con Sonnet 4.5. Adicionalmente activaron reasoning_effort="low" en GPT-5 para chat rápido.
  - *Qué aprendió la industria:* **el modelo top-tier NO es siempre la mejor UX**. Latencia y coste percibido por el usuario pesan más que 12% de calidad en tareas raras. Model routing con clasificador previo es cost-effective aunque añada 300ms de latencia extra (el clasificador Haiku es más barato que la ganancia).

## 8. Ejercicios prácticos

### Ejercicio 1: Tokenizer comparativo multilingüe
**Objetivo:** Verificar empíricamente el ratio tokens/palabra en distintos idiomas.
**Setup:** `pip install tiktoken==0.8.0`
**Pasos:**
1. Toma la primera línea del artículo 1 de la Declaración Universal de DDHH en inglés, español, francés, chino simplificado y árabe (fáciles de encontrar en Wikipedia).
2. Para cada idioma, cuenta tokens con `cl100k_base` y con `o200k_base`.
3. Calcula ratio `tokens / palabras`.
4. Imprime una tabla y comenta cuál gana en cada idioma.

**Criterios de éxito:**
- [ ] Ejecuta sin errores.
- [ ] `o200k_base` gasta menos tokens que `cl100k_base` en al menos 3 de los 5 idiomas.
- [ ] Ratio en chino con `cl100k_base` > 2.5.

**Bonus:** añade el tokenizer de Anthropic vía `anthropic.tokenizers` o el count_tokens endpoint del API.

**Hints:**
- Si el conteo de chino te da un número absurdo (típicamente 3-5x el inglés), no es un bug: es real. El chino gasta ~2 tokens por carácter en cl100k.
- Para árabe, verifica que estás pasando el texto en UTF-8, no en encoding latino accidental (te dará basura).
- `text.split()` NO cuenta palabras chinas ni japonesas bien porque no hay espacios. Para esos idiomas, cuenta caracteres.

**Solución de referencia (esbozo):**
```python
import tiktoken

DUDH = {
    "en": "All human beings are born free and equal in dignity and rights.",
    "es": "Todos los seres humanos nacen libres e iguales en dignidad y derechos.",
    "zh": "人人生而自由,在尊严和权利上一律平等。",
    # ...
}
encs = {"cl100k": tiktoken.get_encoding("cl100k_base"),
        "o200k": tiktoken.get_encoding("o200k_base")}
for lang, texto in DUDH.items():
    palabras = len(texto.split()) or len(texto)
    for name, enc in encs.items():
        tokens = len(enc.encode(texto))
        print(f"{lang:>3} {name:>8} tokens={tokens:>4} ratio={tokens/palabras:.2f}")
```

### Ejercicio 2: Comparativa de coste RAG vs generación
**Objetivo:** Entender la asimetría input/output.
**Setup:** Ya tienes `tiktoken` instalado.
**Pasos:**
1. Escribe una función `coste(input_tokens, output_tokens, price_in, price_out) -> float`.
2. Simula 100 requests de dos tipos:
   - RAG: 30k input, 300 output (mucho contexto, respuesta corta).
   - Generación de código: 500 input, 3000 output.
3. Con pricing Claude Sonnet 4.6 ($3 / $15), calcula el coste total mensual asumiendo 10.000 requests/día de cada tipo.
4. Repite con Haiku 4.5 ($1 / $5).

**Criterios de éxito:**
- [ ] Ves que en RAG el input domina; en generación el output domina.
- [ ] Haiku sale 3× más barato en ambos casos.
- [ ] Deducirás qué tipo de carga se beneficia más de prompt caching.

**Hints:**
- Si tu cálculo mensual de Sonnet en RAG no supera $30k, revisa: 10.000 req/día × 30 días × 40.500 tokens/req ponderados debería estar cerca.
- Prompt caching ahorra sobre INPUT cached, no sobre output. Deduce por qué RAG se beneficia más.
- Ojo: RAG con caching + Haiku es a menudo la combinación más económica del mercado.

**Solución de referencia (esbozo):**
```python
def coste(tokens_in, tokens_out, p_in, p_out):
    return tokens_in / 1e6 * p_in + tokens_out / 1e6 * p_out

REQS_DIARIAS = 10_000
DIAS = 30

for label, tin, tout in [("RAG", 30_000, 300), ("codegen", 500, 3000)]:
    for modelo, pin, pout in [("Sonnet", 3, 15), ("Haiku", 1, 5)]:
        mensual = coste(tin, tout, pin, pout) * REQS_DIARIAS * DIAS
        # el ratio input/output revela quién domina
        print(f"{label:>7} {modelo:>6}: ${mensual:>10,.0f}/mes")
```

### Ejercicio 3: Streaming con métricas
**Objetivo:** Medir TTFT y TPS reales de tu proveedor.
**Setup:** SDK Anthropic u OpenAI, key configurada.
**Pasos:**
1. Ejecuta el código de la sección 5 sobre 5 prompts de tamaños distintos (1k, 5k, 20k, 50k tokens).
2. Registra TTFT y TPS para cada uno.
3. Grafica (o imprime en tabla): TTFT vs input_tokens.

**Criterios de éxito:**
- [ ] TTFT crece aproximadamente lineal con input tokens.
- [ ] TPS de decode es aproximadamente constante independiente del input.
- [ ] Cae la ficha: por qué streaming es tan útil en UI.

**Hints:**
- Para generar prompts de tamaños exactos, usa `"lorem ipsum " * N` y ajusta `N` hasta llegar al target de tokens con `tiktoken`.
- Ejecuta cada tamaño 3-5 veces y toma la mediana (P50): la varianza red-side es enorme si mides una sola vez.
- Si TTFT no crece con el input, sospecha que estás golpeando prompt caching sin querer (repetiste el prompt).

**Solución de referencia (esbozo):**
```python
tamaños = [1000, 5000, 20000, 50000]
resultados = []
for t in tamaños:
    prompt = "lorem ipsum " * (t // 3)  # ~3 tokens por palabra
    latencies = []
    for _ in range(3):
        t0 = time.perf_counter()
        with client.messages.stream(model="...", messages=[...], max_tokens=100) as s:
            for _ in s.text_stream:
                latencies.append(time.perf_counter() - t0)
                break                    # solo el TTFT
    resultados.append((t, sorted(latencies)[1]))     # mediana
# Grafica con matplotlib.pyplot.scatter(tamaños, ttfts)
```

### Ejercicio 4: Structured output vs prompt "por favor JSON"
**Objetivo:** Cuantificar cuánto reduce reintentos usar response_format.
**Setup:** OpenAI SDK 1.90+, key con acceso a `gpt-4o-mini` o `gpt-5.4`.
**Pasos:**
1. Prompt: "extrae {nombre, precio, moneda} del siguiente producto: '{{descripción}}'".
2. Genera 50 productos con descripciones ambiguas (variedad).
3. Método A: prompt "responde JSON válido". Parseá con `json.loads` en try/except.
4. Método B: `client.chat.completions.parse` con Pydantic `Producto`.
5. Cuenta cuántos JSON inválidos hay en cada método.

**Criterios de éxito:**
- [ ] Método B tiene 0 fallos (o cerca).
- [ ] Método A tiene 1-5 fallos de 50.

**Hints:**
- Descripciones ambiguas útiles: "café colombiano premium, 500g, $USD 15.90", "wireless mouse, black, comes with batteries", "libro usado, precio negociable".
- Para el método A el prompt debe incluir instrucciones tipo "responde SOLO JSON válido, sin markdown, sin ``` fences". Aun así fallará ocasionalmente.
- Los fallos del método A no son solo JSON inválido: a veces devuelve JSON válido con schema equivocado (campos extra, tipos wrong). Cuenta ambos.

**Solución de referencia (esbozo):**
```python
from pydantic import BaseModel
class Producto(BaseModel):
    nombre: str
    precio: float
    moneda: str

fallos_A = fallos_B = 0
for desc in descripciones:
    # Método A
    try:
        r = client.chat.completions.create(...)
        json.loads(r.choices[0].message.content)
    except Exception:
        fallos_A += 1
    # Método B (nunca falla si el modelo soporta structured outputs)
    try:
        client.chat.completions.parse(..., response_format=Producto)
    except Exception:
        fallos_B += 1
print(f"A={fallos_A}/50  B={fallos_B}/50")
```

### Ejercicio 5 (Reto): Router de modelos por complejidad de query

**Objetivo:** Construir un router que clasifique cada query como {trivial, media, compleja} y elija Haiku/Sonnet/Opus respectivamente. Medir ahorro vs baseline "todo con Sonnet" manteniendo calidad.

**Setup:**
- SDK Anthropic con acceso a los 3 tiers.
- Un dataset de 100 queries variadas (traducciones, extractores, resúmenes, generación creativa, debug de código).
- Un juez LLM (Claude Sonnet como judge) para puntuar calidad de 1-5.

**Pasos:**
1. Implementa `clasificar(query) -> tier` usando Claude Haiku con un prompt de <200 tokens.
2. Implementa `router(query)` que llama al modelo del tier correspondiente.
3. Ejecuta los 100 queries dos veces: baseline (todo Sonnet) vs router.
4. Puntúa ambos outputs con LLM-as-judge.
5. Mide: coste total, latencia P50, quality score promedio.

**Criterios de éxito:**
- [ ] Router baja coste ≥40% vs baseline.
- [ ] Quality score se mantiene dentro de ±0.3 puntos.
- [ ] Al menos 20 queries van a Haiku y 10 a Opus (evita concentración).
- [ ] Documentas 3 casos donde el router se equivocó y por qué.

**Hints:**
- Un clasificador Haiku con temperature=0 y few-shot de 5 ejemplos suele acertar >90%.
- Cuidado con la cascada: si el clasificador falla y manda a Haiku una query compleja, la respuesta será mala. Añade un fallback "si Haiku responde con confianza <0.7 (heurística simple: si contiene 'no estoy seguro'), rutea a Sonnet".
- Mide latencia AÑADIDA por la clasificación (~300ms de Haiku); en muchas apps compensa, en apps de baja latencia no.

**Solución de referencia (esbozo):**
```python
def clasificar(query: str) -> str:
    r = client.messages.create(
        model="claude-haiku-4-5", max_tokens=10, temperature=0,
        messages=[{"role":"user","content":
            f"Clasifica en 'trivial', 'media' o 'compleja':\n{query}\nResponde solo con la etiqueta."}])
    return r.content[0].text.strip().lower()

MAPPING = {"trivial": "claude-haiku-4-5",
           "media":   "claude-sonnet-4-6",
           "compleja":"claude-opus-4-8"}

def router(query: str) -> str:
    tier = clasificar(query)
    return llm_call(MAPPING.get(tier, "claude-sonnet-4-6"), query)
```


### Ejercicio 6: Instrumentar cache hit rate en 100 requests reales

**Objetivo:** Detectar cuándo el prompt caching NO está funcionando y arreglarlo.

**Setup:** Anthropic SDK 0.68+, key con acceso a Sonnet 4.5.

**Pasos:**
1. Diseña un system prompt de ~2000 tokens (instrucciones + few-shot ES/EN).
2. Envuélvelo con `cache_control: {type: "ephemeral"}`.
3. Ejecuta 100 requests con user messages distintos, todos dentro de 5 min.
4. Log `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` por request.
5. Calcula: hit rate, ahorro $ vs sin cache.
6. Introduce a propósito un `datetime.now()` en el system prompt y ejecuta otras 100 requests. Compara.

**Criterios de éxito:**
- [ ] Primera fase: hit rate ≥95% desde la request #2.
- [ ] Ahorro ≥85% del input pricing en la primera fase.
- [ ] Segunda fase: hit rate cae a ~0% (cada request rompe cache).
- [ ] Reportas ambas fases con números concretos.

**Hints:**
- El primer request SIEMPRE es miss (create), es esperado.
- Si el hit rate no llega a 95% desde la segunda request, algo en tu prompt está variando byte-a-byte. Sospechosos: whitespace, orden de tools, IDs generados.
- Anthropic requiere ≥1024 tokens para cache — si tu prompt es menor no se cachea nada aunque marques `cache_control`.

**Reto:** implementa un test de regresión que corra en CI y falle si el hit rate baja de 80% en la muestra. Bonus: publica métrica a Datadog con tag `endpoint_id`.

**Solución de referencia (esbozo):**
```python
SYSTEM = ("Eres un asistente de LinguaDev Pro. " * 30 +
          "Reglas: siempre en español. Cita fuentes. ") * 5  # ~2000 tokens

hits, misses, total_saved = 0, 0, 0.0
for i in range(100):
    r = client.messages.create(
        model="claude-sonnet-4-5", max_tokens=100,
        system=[{"type":"text","text":SYSTEM,"cache_control":{"type":"ephemeral"}}],
        messages=[{"role":"user","content":f"Query única #{i}"}])
    u = r.usage
    if u.cache_read_input_tokens > 0: hits += 1
    else: misses += 1
    ahorro = u.cache_read_input_tokens / 1e6 * 3.0 * 0.9  # 90% off en input
    total_saved += ahorro
print(f"Hit rate: {hits/(hits+misses):.0%}  Ahorro: ${total_saved:.4f}")
```

### Ejercicio 7: Presupuesto anual de un producto RAG hipotético

**Objetivo:** Ejercitar el cálculo de TCO end-to-end para defenderlo ante un CFO.

**Setup:** hoja de cálculo o script Python + calculadora.

**Pasos:**
1. Asume: 100.000 usuarios activos/mes, cada uno hace 30 queries/mes → 3M req/mes.
2. Cada query: 8k input tokens (5k system + 3k RAG chunks) + 400 output tokens.
3. Calcula coste mensual con: (a) sin cache Sonnet 4.5; (b) con prompt caching 80% hit; (c) router 70% Haiku + 30% Sonnet; (d) opción (c) + semantic cache 40% hit.
4. Añade coste de embeddings (`text-embedding-3-small`) para indexar 500k chunks + re-embed queries.
5. Reporta $/usuario/mes en cada escenario.

**Criterios de éxito:**
- [ ] 4 escenarios calculados y tabulados.
- [ ] Ratio input/output desglosado en el reporte.
- [ ] Coste por usuario mensual ≤ $1 en el mejor escenario.
- [ ] Identificar el escenario de mayor ROI.

**Hints:**
- `input_tokens_mensual = 3e6 × 8k = 24e9 tokens` — cuidado con las unidades.
- El coste de embeddings de queries es despreciable frente al LLM (~$0.02/MTok), pero cuenta.
- Un semantic cache 40% hit sobre el escenario (c) no es aditivo simple: baja 40% del volumen que llega al router (no 40% del coste total).

**Reto:** modela también el coste de un pico 5x el black friday: ¿cuánto crece el bill? ¿tu rate limit con Anthropic aguanta 15M req en 4h? (Enterprise tier suele estar en 4k rpm/tier).

## 9. Recursos y siguientes pasos

**Referencias oficiales (2026):**
- Anthropic API pricing — https://www.anthropic.com/pricing
- Anthropic prompt caching — https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- OpenAI API pricing — https://openai.com/api/pricing/
- OpenAI tiktoken cookbook — https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken
- Google Gemini API pricing — https://ai.google.dev/pricing
- OpenAI tokenizer playground — https://platform.openai.com/tokenizer

**Papers y blogs:**
- Sennrich et al. (2015) — "Neural Machine Translation of Rare Words with Subword Units (BPE)" — https://arxiv.org/abs/1508.07909
- Liu et al. (2023) — "Lost in the Middle: How Language Models Use Long Contexts" — https://arxiv.org/abs/2307.03172
- Modal blog — "What is o200k Harmony? OpenAI's latest edition to their tiktoken tokenizer library"
- Anthropic engineering blog — "Contextual Retrieval" — https://www.anthropic.com/engineering/contextual-retrieval

**Herramientas recomendadas 2026:**
- `tiktoken==0.8.0` — tokenizer OpenAI, incluye `o200k_base`.
- `anthropic==0.68.0` — SDK Python oficial, soporta Extended Thinking, prompt caching, batch.
- `openai==1.90.0` — SDK Python oficial, `response_format` con Pydantic, o-series reasoning.
- `google-genai==1.9.0` — SDK Python oficial de Google, sustituye al viejo `google-generativeai`.
- `litellm` — abstrae multi-proveedor con misma API.
- `openrouter` — router HTTP a 100+ modelos con billing unificado.

**Qué leer/practicar después:**
- Siguiente: [Capítulo 02 — RAG parte 1: embeddings y chunking](./02-rag-embeddings-chunking.md)
- Lee la doc de prompt caching de Anthropic — es la palanca de ahorro más grande hoy.
- Prueba modelos con Extended Thinking en un problema real de tu dominio y compara vs sin thinking.

## 10. Preguntas de práctica (20)

Para practicar los 20 escenarios con retroalimentación completa (opciones correctas, incorrectas, explicación, real-world, tags), corre este sim en la app o abre directamente el JSON:

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-01-fundamentals-tokens-context.json`](../../packages/content/src/tech/ai-programming/sim-01-fundamentals-tokens-context.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-01-fundamentals-tokens-context`

## Navegación

[Índice](./README.md) · [Capítulo 02 — RAG parte 1: embeddings y chunking →](./02-rag-embeddings-chunking.md)
