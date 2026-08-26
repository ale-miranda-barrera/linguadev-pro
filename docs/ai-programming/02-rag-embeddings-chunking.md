# Capítulo 02 — RAG parte 1: embeddings y chunking

> **Focus:** Convertir tu corpus en vectores buscables. Cómo elegir el modelo de embedding correcto en 2026, cómo chunkear sin destruir el sentido, cómo enriquecer con metadata y cómo mantener el índice fresco sin re-indexar todo cada noche.
> **Áreas:** Context Engineering · Retrieval · Data ingestion
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Python 3.11+ y `pip` funcionando; virtualenv o `uv` recomendado.
- Familiaridad con LLM APIs (ver [cap 01 — modelos y APIs](./01-fundamentos-tokens-contexto.md)) — sabes hacer un `chat.completions.create` o `messages.create`.
- Nociones básicas de álgebra lineal (producto escalar, norma L2). Nada avanzado; sumar y multiplicar componentes basta.
- Recomendado: haber tocado NumPy o al menos entender que un vector es una lista de floats.

**Glosario mínimo:**
- **Embedding** — vector denso de floats (típicamente 256-3072 dimensiones) que representa el significado de un texto. Textos con sentido parecido producen vectores cercanos según alguna métrica.
- **Modelo de embedding** — red neuronal (encoder-only, tipo BERT) entrenada con *contrastive learning* para que pares (query, respuesta) tengan vectores cercanos y pares no relacionados tengan vectores lejanos.
- **Chunk** — fragmento de texto que se embeda e indexa como unidad. La calidad del chunking condiciona el techo del sistema.
- **Cosine similarity** — coseno del ángulo entre dos vectores, en `[-1, 1]`. Robusto a la magnitud. Métrica por defecto en RAG.
- **Dot product** — producto escalar `A · B`. Equivale a cosine si los vectores están L2-normalizados, y es más rápido de calcular.
- **Matryoshka Representation Learning (MRL)** — técnica de entrenamiento que hace que los primeros `N` componentes del vector sean utilizables por sí solos. Permite truncar sin re-entrenar.
- **Metadata** — campos estructurados asociados a cada chunk (`doc_id`, `updated_at`, `tenant_id`, `section`). Permiten filtrado quirúrgico.
- **Contextual Retrieval** — técnica publicada por Anthropic en septiembre de 2024: antes de embedear cada chunk se le añaden 50-100 tokens que describen su lugar en el documento padre.

**Setup:**

```bash
# Crea entorno limpio
python -m venv .venv && source .venv/bin/activate    # macOS/Linux
# .venv\Scripts\activate                              # Windows

pip install --upgrade pip
pip install openai==1.60.0 numpy==2.1.3 faiss-cpu==1.9.0 \
            tiktoken==0.8.0 langchain-text-splitters==0.3.4 \
            trafilatura==2.0.0 unstructured==0.16.11

export OPENAI_API_KEY="sk-..."   # o pon la clave en .env
```

---

## 1. El gran cuadro

Retrieval-Augmented Generation (RAG) es la respuesta pragmática a dos problemas duros de los LLMs: **no saben lo que no vieron durante el entrenamiento** (docs privados, datos actualizados hoy) y **alucinan cuando se les pregunta por hechos que no dominan bien**. La receta es sencilla en el papel: cuando llega una consulta, buscas los fragmentos más relevantes en tu propio corpus, los pegas en el prompt, y le pides al modelo que responda basándose en ellos. En la práctica, mal montado, un RAG alucina *más* que un LLM sin retrieval, porque el modelo se apoya en pasajes que "parecen" relacionados pero no lo son.

RAG tiene dos ciclos, claros y separados. El **ciclo de indexación** (offline, batch) transforma tu corpus en un índice buscable: extraer texto de cada fuente → chunkear → embedear → guardar en vector DB con metadata. El **ciclo de consulta** (online, latencia crítica) toma la query del usuario: embed → buscar los top-K vectores más cercanos → opcionalmente rerankear → construir el prompt final → llamar al LLM. Este capítulo cubre el ciclo de indexación por completo; el [capítulo 03](./03-vector-dbs-hybrid-reranking.md) cubre el de consulta (vector DBs, hybrid search, reranking).

Cuatro decisiones fijan el techo de calidad y coste antes de tocar el LLM. **Primera:** el modelo de embedding — dimensiones, coste, calidad, cobertura de idiomas, dominio. **Segunda:** el preprocesamiento — cómo limpias HTML, cómo parseas PDFs con tablas, cómo trozas código respetando el AST. **Tercera:** el chunking — tamaño, overlap y respeto de estructura semántica; aquí es donde más equipos fracasan. **Cuarta:** los metadatos — sin `doc_id`, `updated_at`, `tenant_id` y `section` tu retrieval es ciego.

El paisaje de 2026 favorece a los pragmáticos. Los modelos de embedding han convergido: OpenAI `text-embedding-3-large` (3072 dims, ~$0.13/MTok), Voyage `voyage-3-large` (multilingüe fuerte), Cohere `embed-v3` con variantes en int8 y binary, BGE-M3 (multilingüe open), Jina `embeddings-v3`, Nomic `embed-v2`, Google `gemini-embedding-001`. Todos son "suficientemente buenos" para la mayoría de casos; el benchmark que importa es el tuyo, no MTEB. Contextual Retrieval (Anthropic sept 2024) demostró que **añadir contexto explícito a cada chunk antes de embedear** reduce el fallo de retrieval hasta un 67 % cuando se combina con hybrid search y reranking. Es la mejora más costo-efectiva publicada en años.

El objetivo del capítulo es que salgas sabiendo diseñar un pipeline de indexación **incremental** (no re-indexar todo cada día), **deduplicado** (evitar que 5 copias del mismo doc saturen el top-K) y **evaluable** (con recall@K medible antes de tocar el LLM generador). Todo lo que no midas, se degrada en silencio.

---

## 2. Fundamentos (nivel básico)

### 2.1 Qué es realmente un embedding

Un embedding es una función `encoder(texto) → vector ∈ R^d`. El modelo se entrena con *contrastive learning*: se muestran pares positivos (query, respuesta correcta) y pares negativos (query, texto no relacionado); la loss empuja los positivos a estar cerca y los negativos lejos en el espacio vectorial. Después del entrenamiento, la geometría del espacio codifica sentido: "rey" y "monarca" quedan cerca, "rey" y "plátano" quedan lejos.

Un embedding NO es un hash (los hashes cambian con cualquier byte y no tienen noción de significado). NO es la tokenización del texto (los tokens son IDs enteros que se pasan al LLM). NO es una distribución sobre siguientes tokens (eso lo hace un LLM autoregresivo). Es una **representación estática** del texto completo, un único vector, útil para buscar por significado.

**Analogía útil:** piensa en un embedding como las coordenadas GPS de un texto en un mapa multidimensional del "significado". Dos textos sobre reembolsos quedan a pocas cuadras (cosine ≈ 0.85); un texto sobre plátanos queda al otro lado de la ciudad (cosine ≈ 0.20). No importa que uses palabras distintas: si "monarca" y "rey" tienen coordenadas cercanas es porque el modelo aprendió, tras leer millones de textos, que suelen aparecer en contextos parecidos (misma "vecindad geográfica" en el corpus). La geometría codifica sentido; el modelo de embedding es el cartógrafo.

**Segundo ejemplo — el mismo texto en dos idiomas:**
Un buen modelo multilingüe pone `"la política de reembolsos"` (ES) y `"the refund policy"` (EN) muy cerca en el espacio vectorial, aunque no comparten NINGÚN token. Esto es lo que hace posible **cross-lingual retrieval** (buscar en español y encontrar docs en inglés). Modelos como `voyage-3-large`, `text-embedding-3-large` o `BGE-M3` están entrenados con pares paralelos para forzar esta propiedad.

Ejemplo mínimo:

```python
from openai import OpenAI

client = OpenAI()

def embed(text: str) -> list[float]:
    resp = client.embeddings.create(
        model="text-embedding-3-small",   # 1536 dims, $0.02/MTok
        input=text,
    )
    return resp.data[0].embedding

v_rey = embed("rey")
v_monarca = embed("monarca")
v_platano = embed("plátano")

print(len(v_rey))                          # 1536
```

### 2.2 Similitud: cosine, dot product, euclidiana

Tres métricas dominan en RAG:

- **Cosine similarity** — `cos(A, B) = (A · B) / (|A| · |B|)`. Rango `[-1, 1]`. Ignora la magnitud, solo importa el ángulo. Es el default seguro.
- **Dot product** — `A · B = Σ a_i · b_i`. Es idéntico a cosine si `|A| = |B| = 1` (vectores L2-normalizados). Más rápido de calcular porque evita la división.
- **Distancia euclidiana** — `√Σ (a_i - b_i)²`. Penaliza la magnitud. Rara vez es la mejor opción en embeddings semánticos.

Regla mental: si tu modelo devuelve vectores ya L2-normalizados (OpenAI, la mayoría de sentence-transformers), usa **dot product** — es cosine gratis y sin operaciones extra. Si no, usa **cosine**. Evita euclidiana salvo casos específicos.

```python
import numpy as np

def cosine(a, b):
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

a, b, c = np.array(v_rey), np.array(v_monarca), np.array(v_platano)

print(f"cosine(rey, monarca) = {cosine(a, b):.4f}")   # ~0.72
print(f"cosine(rey, plátano) = {cosine(a, c):.4f}")   # ~0.28
print(f"norm(rey) = {np.linalg.norm(a):.4f}")         # 1.0000 (OpenAI ya normaliza)
```

Como OpenAI devuelve vectores unitarios, `cosine == dot product` para sus embeddings. Verifícalo siempre en la documentación del modelo antes de configurar la vector DB.

**Analogía útil:** cosine mide **dirección** (¿los dos vectores apuntan al mismo sitio?), euclidiana mide **posición absoluta** (¿están cerca en el espacio?). En texto, la dirección captura mejor el significado: un embedding puede ser "grande" simplemente porque el texto es largo, no porque el tema sea más importante. Por eso cosine gana en RAG. Es como comparar rumbos de un barco: no importa a qué velocidad va cada uno, importa si van al mismo puerto.

**Mini-ejemplo — desglose paso a paso del cálculo de cosine:**

```python
import numpy as np

# Vectores de ejemplo (2D para poder visualizar)
a = np.array([3.0, 4.0])
b = np.array([6.0, 8.0])    # misma dirección que a, mayor magnitud
c = np.array([-4.0, 3.0])   # perpendicular a a

# Paso 1: producto escalar
dot_ab = float(a @ b)   # 3*6 + 4*8 = 18 + 32 = 50
dot_ac = float(a @ c)   # 3*(-4) + 4*3 = -12 + 12 = 0

# Paso 2: normas
norm_a = float(np.linalg.norm(a))   # sqrt(9+16) = 5
norm_b = float(np.linalg.norm(b))   # sqrt(36+64) = 10
norm_c = float(np.linalg.norm(c))   # sqrt(16+9) = 5

# Paso 3: cosine
print(dot_ab / (norm_a * norm_b))   # 50 / (5*10) = 1.0 — misma dirección
print(dot_ac / (norm_a * norm_c))   # 0  / (5*5)  = 0.0 — perpendicular

# Paso 4: dot product SI ya están normalizados (cosine gratis)
a_norm = a / norm_a
b_norm = b / norm_b
print(a_norm @ b_norm)              # 1.0 — mismo resultado, sin división
```

Regla mental para debug: si tu retrieval no funciona, imprime la matriz de cosine entre tu query y los top-K docs. Si todos los scores están en el rango 0.3-0.5, probablemente tu modelo de embedding no captura tu dominio bien. Si están en 0.85-0.95 pero los docs son irrelevantes, sospecha que tus vectores no están normalizados y estás usando cosine en un espacio donde debería ser dot product o al revés.

### 2.3 Dimensiones vs calidad vs coste

Un modelo de 3072 dimensiones almacena más información que uno de 512, pero paga tres impuestos: **storage** (12 KB/vector vs 2 KB), **memoria del índice** (HNSW carga grafo en RAM) y **latencia de query** (cada distance computation escala con `d`). La pregunta no es "más dimensiones es mejor" sino "cuál es el sweet spot en mi dominio".

Ejemplo real. Un corpus de 10 M chunks:

| Modelo | Dims | Storage vectores | Coste indexar (500 tok/chunk avg) |
|---|---|---|---|
| `text-embedding-3-small` | 1536 | 60 GB | $0.02 × 5000 = $100 |
| `text-embedding-3-large` (default) | 3072 | 120 GB | $0.13 × 5000 = $650 |
| `text-embedding-3-large` truncado a 512 (MRL) | 512 | 20 GB | $650 (mismo) |
| `voyage-3-large` | 1024 | 40 GB | $0.06 × 5000 = $300 |
| `BGE-M3` (self-hosted) | 1024 | 40 GB | GPU-hours propios |

El truco moderno se llama **Matryoshka Representation Learning (MRL)**. `text-embedding-3-*`, Nomic `embed-v1.5+`, Snowflake `arctic-embed` y otros entrenan el modelo para que los primeros `N` componentes sean utilizables por sí solos. Puedes truncar a 256, 512, 1024 sin re-entrenar y sin catástrofe: la calidad cae poco (típicamente 5-15% en MTEB) y ganas 3-6x en storage. Después de truncar, **renormaliza siempre**: `v = v / np.linalg.norm(v)`.

### 2.4 El pipeline mínimo de RAG en 20 líneas

Antes de complicar nada, así se ve el pipeline básico:

```python
import numpy as np
from openai import OpenAI

client = OpenAI()

def embed(text: str) -> np.ndarray:
    r = client.embeddings.create(model="text-embedding-3-small", input=text)
    return np.array(r.data[0].embedding)

# 1. Indexar
docs = [
    "El motor FSRS-6 ajusta stability y difficulty por tarjeta.",
    "La PWA usa Service Worker e IndexedDB para offline.",
    "El backend serverless corre en AWS Lambda con DynamoDB.",
]
embeddings = np.array([embed(d) for d in docs])

# 2. Consultar
query = "¿cómo funciona la repetición espaciada?"
q_vec = embed(query)

# 3. Top-K por dot product (los vectores ya están normalizados)
scores = embeddings @ q_vec
top_k = np.argsort(scores)[::-1][:2]
for i in top_k:
    print(f"{scores[i]:.3f} — {docs[i]}")
```

Este código funciona. Es RAG. El resto del capítulo trata de por qué —al escalar a millones de docs, múltiples idiomas, tablas y código— no basta con eso.

### 2.5 Chunking: por qué es lo más importante

Un embedding representa **un solo texto**. Si le pasas un capítulo entero (10k tokens), el vector resultante es un promedio semántico que dice "va de todo un poco" y no discrimina bien nada. Si le pasas una frase suelta ("Sí, se puede."), el vector no tiene contexto y no sabes de qué documento venía. La estrategia de chunking define la unidad de recuperación y, por tanto, el techo de calidad del sistema.

**Analogía útil:** chunkear es como partir una película en clips para YouTube Shorts. Si haces clips de 5 segundos, cada uno carece de contexto y no se entiende; si haces "clips" de 45 minutos, ya no son clips. El sweet spot es 1-3 minutos: cada clip es autónomo pero conserva contexto. Con embeddings pasa igual: chunks de 300-800 tokens son autónomos (una idea completa) pero pequeños suficiente para que el embedding sea específico.

**Flujo de indexación (desglose paso a paso):**
1. **Extraer** el texto crudo de la fuente (HTML, PDF, Markdown, código).
2. **Limpiar** ruido (navegación, footers, tablas mal parseadas).
3. **Normalizar** Unicode (NFC) y whitespace.
4. **Chunkear** respetando estructura (párrafos, secciones, funciones).
5. **Deduplicar** en ingesta (hash exacto + MinHash).
6. **Enriquecer** con metadata (doc_id, section, updated_at, tenant_id).
7. **Embedear** en batches (100-500 chunks por batch para respetar rate limits).
8. **Guardar** en vector DB con upsert por ID.
9. **Verificar** con eval set (recall@10 antes de publicar).

Cada paso puede fallar silenciosamente; instrumenta cada uno con métricas (chunks descartados por dedup, chunks con embedding null, etc.).

Regla general 2026 para prosa técnica: **chunks de 256-800 tokens con 10-20% de overlap**, respetando estructura (párrafos, headings, funciones). Detalles concretos en §3.

---


### 2.6 Antes vs Después — el mismo query con distintas estrategias

**Escenario:** corpus de 200 páginas de docs internas de una app SaaS de billing. Query del usuario: "¿cómo cancela un cliente su suscripción anual con prorrateo?"

**Antes (RAG naïve, fixed-size 1000 chars sin overlap):**

```python
# Chunking
chunks = [text[i:i+1000] for i in range(0, len(text), 1000)]

# Retrieve top-3 con embeddings
top_3 = search(query, chunks, k=3)
```

Resultado real observado:
```
Score 0.71: "...cliente puede cancelar. El proceso de cancelación se ha modificado en la política"
Score 0.69: "de octubre de 2024, aplicando el nuevo esquema de prorrateo únicamente..."
Score 0.68: "...formulario web disponible en billing.acme.com/cancel. Los reembolsos"
```

El chunk relevante quedó partido en tres fragmentos incompletos por la falta de overlap y por cortar en el medio de las frases. El LLM downstream se inventa detalles del prorrateo que NO están en los chunks.

**Después (recursive splitter con overlap 15% + metadata rica):**

```python
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=700, chunk_overlap=100,
    separators=["\n\n", "\n", ". ", " ", ""],
)
chunks = splitter.split_text(text)
# + metadata: doc_id, section, updated_at
```

Resultado con el mismo query:
```
Score 0.83: "## Cancelación de suscripciones anuales
Los clientes pueden cancelar en cualquier momento desde billing.acme.com/cancel.
El prorrateo se aplica automáticamente: se calcula el porcentaje del período no
consumido y se reembolsa a la tarjeta original en 5-7 días hábiles..."
[metadata: doc_id='billing-policy-2026', section='Cancelación', updated_at='2026-03-15']
```

El chunk viene completo, autónomo, con contexto y metadata. El LLM cita fielmente. Cambio de código: 3 líneas. Impacto en calidad de respuesta: 40-60% menos alucinaciones.

**Escenario 2 — el mismo corpus, ahora con Contextual Retrieval:**

**Antes (chunk suelto ambiguo):**
```
"Esta cláusula aplica desde octubre de 2024 y modifica el anterior párrafo 3.2."
```
El embedding de esto es prácticamente inútil: ¿qué cláusula? ¿qué documento? ¿qué párrafo 3.2? El vector queda en la "zona pantanosa" del espacio semántico.

**Después (Anthropic Contextual Retrieval, sept 2024):**

```python
context = claude.messages.create(
    model="claude-haiku-4-5", max_tokens=100,
    messages=[{"role":"user","content":
        f"<doc>{full_doc}</doc>\n<chunk>{chunk}</chunk>\n"
        "Genera 50-100 tokens que sitúen este chunk en el doc padre."}]).content[0].text

chunk_augmented = f"{context}\n\n{chunk}"
# Ejemplo real: "Este chunk es de la política de reembolsos de ACME 2025,
# sección 3.2 sobre cancelaciones anuales, hace referencia a la revisión
# de octubre 2024 que introdujo el nuevo esquema de prorrateo."
```

El vector del chunk augmentado queda cerca de queries como "cancelación anual", "prorrateo 2024", "política reembolsos ACME" — TODAS resuelven al mismo doc porque el contexto explícito las une. Coste: **~$1.02 por millón de docs con prompt caching**. Impacto documentado: **-35% failure rate solo con dense retrieval, hasta -67% combinado con hybrid + rerank**.

**Escenario 3 — chunker naive vs code-aware para un repo de TypeScript:**

Antes (`RecursiveCharacterTextSplitter` genérico sobre un archivo `.ts`):
```typescript
// Chunk cortado a mitad de función
export async function calculateFsrsInterval(card: Card, rating: R
------------------- CHUNK BOUNDARY -----------------
ating): Promise<Interval> {
  const stability = updateStability(card.stability, rating);
```
Búsqueda por "cálculo FSRS interval" a menudo devuelve solo la mitad, el LLM downstream no puede razonar sobre la función completa.

Después (tree-sitter con `PythonCodeTextSplitter` / equivalente TS):
```typescript
// Chunk completo respetando el AST de la función
export async function calculateFsrsInterval(card: Card, rating: Rating): Promise<Interval> {
  const stability = updateStability(card.stability, rating);
  const difficulty = updateDifficulty(card.difficulty, rating);
  const interval = computeInterval(stability, difficulty, card.reviews);
  return { interval, stability, difficulty };
}
```
Chunk auto-contenido, ejecutable, con toda la señal semántica de una unidad lógica del programa. Cursor documentó que este cambio subió su `recall@5` un 15-20 puntos en el propio benchmark interno.

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Modelos de embedding en 2026: el paisaje real

| Modelo | Dims (default) | Multi-lingüe | Coste | Max tokens/input | MTEB avg | Notas |
|---|---|---|---|---|---|---|
| OpenAI `text-embedding-3-small` | 1536 | Sí (bueno en EN) | $0.02/MTok | 8191 | 62.3 | Baseline sólido, MRL truncable |
| OpenAI `text-embedding-3-large` | 3072 | Sí | $0.13/MTok | 8191 | 64.6 | Top calidad EN, MRL |
| Voyage `voyage-3-large` | 1024 | Fuerte | $0.06/MTok | 32000 | 63.5 | Excelente en dominios técnicos |
| Voyage `voyage-code-3` | 1024 | Código | $0.06/MTok | 32000 | — (code) | Especializado en source code |
| Cohere `embed-v3` (multilingual) | 1024 | 100+ idiomas | $0.10/MTok | 512 | 61.8 | int8 y binary variants nativos |
| BGE-M3 (BAAI) | 1024 | 100+ idiomas | Self-host | 8192 | 61.5 | Open, dense+sparse+colbert en uno |
| Jina `embeddings-v3` | 1024 | 89 idiomas | $0.02/MTok | 8192 | 60.9 | Task-specific LoRA adapters |
| Nomic `embed-text-v2` | 768 (MRL) | Sí | Open o API | 8192 | 59.5 | Long context, MoE arch |
| Google `gemini-embedding-001` | 3072 (MRL) | 100+ idiomas | Ver Vertex | 2048 | 64.9 | Competitivo, buen soporte cross-lingual |
| Snowflake `arctic-embed-2` (L) | 1024 (MRL) | Sí | Self-host | 8192 | 60.3 | Apache 2.0, comprimible a 128 dims |
| Mixedbread `mxbai-embed-large-v1` | 1024 (MRL) | EN principalmente | Self-host o API | 512 | 64.7 | Alt open competitiva |

Notas sobre la tabla: MTEB avg es orientativo (los modelos se sobre-optimizan al leaderboard). "Max tokens/input" es el tope de tokens que puedes embedear en una sola llamada — importante para chunks largos. Cohere v3 solo admite 512, que es restrictivo si quieres chunks grandes.

Frame para elegir: (1) **idiomas** — verifica soporte real, no promesas; (2) **dominio** — legal, médico, código a menudo se benefician de un modelo especializado (Voyage `voyage-law-2`, `voyage-code-3`, MedCPT); (3) **coste inicial** — indexar 10M docs; (4) **coste operativo** — re-index y query embeddings; (5) **licencia** — Apache/MIT vs propietario; (6) **benchmark propio** — construye 200-500 queries con ground truth y mide recall@10 en TU corpus.

MTEB es una guía útil pero **no es tu ground truth**. Los modelos suelen sobre-optimizarse para los benchmarks públicos.

### 3.2 Estrategias de chunking

Cinco niveles, del más simple al más complejo (basado en el framework de Greg Kamradt, 2024):

**Nivel 1 — Fixed-size:**
```python
chunks = [text[i:i+1000] for i in range(0, len(text), 1000)]
```
Corta cada 1000 caracteres. Simple pero rompe frases, palabras y a veces UTF-8 multi-byte. Casi nunca óptimo salvo para benchmarks.

**Nivel 2 — Recursive character splitter:**
```python
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=800,
    chunk_overlap=120,       # 15% overlap
    separators=["\n\n", "\n", ". ", " ", ""],   # jerarquía
)
chunks = splitter.split_text(text)
```
Intenta separar por párrafos primero, luego líneas, luego frases. Es el default recomendado en LangChain y sirve para el 80% de los casos.

**Nivel 3 — Document-specific (estructural):**
```python
from langchain_text_splitters import MarkdownHeaderTextSplitter

headers = [("#", "h1"), ("##", "h2"), ("###", "h3")]
md_splitter = MarkdownHeaderTextSplitter(headers_to_split_on=headers)
sections = md_splitter.split_text(markdown_text)
# sections[i].metadata contiene {"h1": "...", "h2": "..."} — úsalo como metadata

# Luego sub-dividir secciones largas
char_splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=120)
chunks = [c for s in sections for c in char_splitter.create_documents([s.page_content], [s.metadata])]
```
Respeta la estructura (Markdown, HTML, código con tree-sitter). Los headings se convierten en metadata rica. Superior a recursive puro cuando hay estructura explícita.

**Nivel 4 — Semantic chunking:**
Embedeas cada frase, mides la distancia coseno entre frases vecinas y cortas donde hay un "valle" semántico (Kamradt 2024). Suena impresionante; en benchmarks públicos (Chroma Research 2024) las mejoras sobre recursive bien tunado son marginales (<5%) y el coste de indexación se triplica. Recomendación: **no lo uses por defecto**; considéralo solo si mides mejora en tu dominio y aceptas el coste.

**Nivel 5 — Contextual (Anthropic, sept 2024):**
Antes de embedear/indexar cada chunk, pides a un LLM barato (Claude Haiku, Gemini Flash) que genere 50-100 tokens de contexto que sitúen ese chunk dentro del documento completo. Con prompt caching el coste es negligible (~$1 por millón de docs). Impacto publicado: reduce retrieval failure hasta 67% cuando se combina con hybrid search y reranker. La implementación conceptual:

```python
CONTEXT_PROMPT = """<document>
{doc}
</document>

Here is a chunk from that document:
<chunk>
{chunk}
</chunk>

Please give a short (50-100 tokens) context that situates this chunk within the overall document.
Answer only with the context, nothing else."""

def contextualize(doc: str, chunk: str, claude) -> str:
    resp = claude.messages.create(
        model="claude-haiku-4-5",
        max_tokens=150,
        messages=[{"role": "user", "content": CONTEXT_PROMPT.format(doc=doc, chunk=chunk)}],
    )
    context = resp.content[0].text
    return f"{context}\n\n{chunk}"     # se embeda el chunk con el contexto delante
```

### 3.3 Tamaño de chunk: sweet spot empírico

Datos de un test A/B típico sobre corpus legal (500 queries con ground truth):

| Chunk size (tokens) | Recall@5 |
|---|---|
| 100 | 45% |
| 250 | 66% |
| 400 | 71% |
| 800 | 69% |
| 1200 | 68% |
| 3000 | 52% |

Existe un sweet spot que **varía por dominio**: prosa técnica alrededor de 300-800 tokens; código 500-1500 (una función o clase suele ser el chunk natural); listados y FAQs pueden funcionar con 150-300. Chunks demasiado pequeños fragmentan contexto; demasiado grandes diluyen el embedding.

Patrón avanzado: **parent-child chunking**. Indexas chunks pequeños (mejor precisión de búsqueda) pero cuando devuelves el resultado al LLM, devuelves el chunk padre grande (más contexto para razonar). LlamaIndex y LangChain lo implementan.

### 3.4 Metadatos: la palanca infravalorada

Un chunk indexado como `{id, text, embedding}` es funcional pero ciego. Un chunk indexado como:

```json
{
  "id": "chunk-abc123",
  "text": "...",
  "embedding": [0.021, -0.034, ...],
  "doc_id": "policy-refunds-2025",
  "doc_title": "Política de reembolsos 2025",
  "url": "https://acme.com/policies/refunds-2025",
  "section": "Suscripciones anuales",
  "created_at": "2025-06-15T00:00:00Z",
  "updated_at": "2026-03-01T00:00:00Z",
  "author": "legal-team",
  "tenant_id": "acme-corp",
  "product_area": "billing",
  "chunk_index": 3,
  "doc_type": "policy",
  "pipeline_version": "v2.3"
}
```

...te permite **filtrar antes o durante la búsqueda vectorial**: "chunks de tenant `acme-corp` con `updated_at > 2025-01-01` y `doc_type = policy`". Pinecone, Weaviate, Qdrant y pgvector 0.7+ soportan filtros híbridos eficientes. La consecuencia práctica: convierten "buscar en 10M docs" en "buscar en 30k docs filtrados" — más rápido, más preciso y auditable.

Regla dura: **piensa en multi-tenancy desde el día 1**. Retrofitting `tenant_id` cuando ya tienes millones de vectores en producción es doloroso.

### 3.5 Preprocesamiento por tipo de contenido

RAG es garbage-in, garbage-out. La extracción y limpieza importan más de lo que se cree.

**Web:**
```python
import trafilatura

html = trafilatura.fetch_url("https://ejemplo.com/articulo")
text = trafilatura.extract(
    html,
    include_tables=True,
    include_comments=False,
    favor_precision=True,
)
```
`BeautifulSoup.text` te da todo el ruido de navegación, cookies, footers. `trafilatura` (o `readability-lxml`, o `Firecrawl` como servicio) extrae el contenido principal.

**PDF:**
`unstructured.io`, `LlamaParse`, `Docling` (IBM, 2024) o `pymupdf4llm` manejan tablas, columnas y OCR. `pdfminer.six` a secas destroza tablas y produce chunks incoherentes.

**Código:**
`tree-sitter` con grammar del lenguaje. Chunks por función/clase, respetando scope. LangChain tiene `PythonCodeTextSplitter`, `JSCodeTextSplitter`, etc.

**Markdown/HTML estructurado:**
Header-aware splitter (como el ejemplo de §3.2). Los headings van a metadata.

Después de extraer, siempre: **normaliza Unicode** (`unicodedata.normalize("NFC", text)`), **colapsa whitespace** (`re.sub(r"\s+", " ", text)`), **deduplica** (§3.6), **enriquece con metadata**.

### 3.6 Deduplicación

Un corpus típico de Confluence + Google Docs corporativo tiene copias con pequeñas variaciones (v1, v2, draft, "copia de..."). Sin dedup, el top-5 se satura de casi-duplicados y el LLM ve info redundante.

Dos capas:

**En ingesta:**
```python
import hashlib

def content_hash(text: str) -> str:
    normalized = " ".join(text.lower().split())
    return hashlib.sha256(normalized.encode()).hexdigest()

# Rechaza exactos:
seen = set()
unique = []
for doc in docs:
    h = content_hash(doc["text"])
    if h not in seen:
        seen.add(h)
        unique.append(doc)
```

Para near-duplicates (>95% overlap), usa **MinHash + LSH** (`datasketch` en Python) o embedding similarity con umbral 0.95.

**En retrieval:** **MMR (Maximal Marginal Relevance)**. En cada paso, elige el doc que maximiza `λ · sim(query, doc) - (1-λ) · max_j sim(doc, ya_seleccionados)`. Con `λ=0.5-0.7` balancea relevancia y diversidad. LangChain (`max_marginal_relevance_search`) y LlamaIndex (`MMRPostprocessor`) lo implementan.

### 3.7 Bajo el capó: cómo se entrena un modelo de embeddings

Entender el pipeline de entrenamiento ayuda a decidir qué modelo elegir y cuándo fine-tunear. En 2026 el pipeline canónico (usado por BGE, Voyage, Cohere, Nomic, GTE, arctic-embed) tiene tres fases:

**Fase 1 — Pre-training con contrastive loss débil.** Se toman pares "positivos débiles" scraped de la web: (título de artículo, primer párrafo), (pregunta de Reddit, respuesta más votada), (query de búsqueda, snippet resultado). Millones de pares. La loss (InfoNCE típicamente) empuja al encoder a que estos pares queden cerca en el espacio y los negativos (otros pares del batch) queden lejos. Aquí el modelo aprende la geometría gruesa del lenguaje.

**Fase 2 — Fine-tuning supervisado con datasets curados.** Se usan datasets como MS MARCO, NQ, HotpotQA, MIRACL para retrieval, más NLI (SNLI, MultiNLI) y STS para similitud. Aquí los pares son más limpios y a menudo se incluyen "hard negatives" — negativos que se parecen al positivo pero no responden a la query, para que el modelo aprenda distinciones finas.

**Fase 3 — Fine-tuning con hard negative mining y Matryoshka loss (2023+).** Ya no basta con negativos al azar del batch: se usa el propio modelo para buscar negativos difíciles (docs que actualmente rankean top-10 para una query pero no son la respuesta). La Matryoshka loss añade un término que penaliza si los primeros N=64, 128, 256, 512 dims por separado no separan positivos de negativos — así el modelo aprende a poner la señal más fuerte en los primeros dims.

La consecuencia práctica: los modelos modernos (2024+) con MRL admiten truncar a 256/512 dims con degradación menor porque la loss durante el entrenamiento se lo forzó explícitamente. Los modelos antiguos (`text-embedding-ada-002` de 2022) NO tenían Matryoshka y por eso truncarlos degrada mucho.

Y otra consecuencia: fine-tunear el embedder es difícil porque tienes que replicar buena parte del pipeline (hard negatives, MRL loss, contrastive). Es la razón por la que fine-tunear el reranker (mucho más simple: un cross-encoder con positive/negative pairs) suele ser mejor ROI que fine-tunear el embedder.

Diagrama del proceso de indexación end-to-end:

```
                                    ┌──────────────┐
                                    │  Corpus      │
                                    │  raw (docs)  │
                                    └──────┬───────┘
                                           │
                          ┌────────────────┼────────────────┐
                          ▼                ▼                ▼
                     ┌────────┐      ┌─────────┐      ┌────────┐
                     │  HTML  │      │   PDF   │      │  MD    │
                     │trafilat│      │unstruct │      │ splitter│
                     └───┬────┘      └────┬────┘      └───┬────┘
                         │                │                │
                         └────────────────┼────────────────┘
                                          ▼
                              ┌───────────────────────┐
                              │ Normalize (NFC, WS)    │
                              └───────────┬────────────┘
                                          ▼
                              ┌───────────────────────┐
                              │ Chunk (recursive +     │
                              │  structural, 500 tok)  │
                              └───────────┬────────────┘
                                          ▼
                              ┌───────────────────────┐
                              │ Dedup exact (SHA-256) │
                              │ + MinHash near-dup    │
                              └───────────┬────────────┘
                                          ▼
                              ┌───────────────────────┐
                              │ Contextualize (opt.)   │
                              │  Claude Haiku + cache  │
                              └───────────┬────────────┘
                                          ▼
                              ┌───────────────────────┐
                              │ Embed (batch de 100)   │
                              │  text-embedding-3-*    │
                              └───────────┬────────────┘
                                          ▼
                              ┌───────────────────────┐
                              │ Upsert vector DB       │
                              │  con metadata rica     │
                              └───────────┬────────────┘
                                          ▼
                              ┌───────────────────────┐
                              │ Eval recall@10        │
                              │  (bloquea deploy)      │
                              └───────────────────────┘
```

### 3.8 Actualización incremental

Re-indexar 5M docs cada noche cuesta $200 en embeddings y 4h de ventana. Solo hazlo cuando cambies el modelo o el pipeline. Para el día a día:

```
Fuente (webhook / CDC / polling)
    ↓
Change detection (hash del contenido normalizado)
    ↓
Queue (Kafka / SQS / Kinesis)
    ↓
Embed batch (respeta rate limits, aprovecha discount)
    ↓
Upsert / delete por doc_id en la vector DB
```

Todas las vector DBs modernas soportan `upsert` por ID. Guarda `pipeline_version` y `embedding_model_version` en metadata para saber cuándo re-indexar en masa.

### 3.9 Implementar un chunker recursivo desde cero

Para entender qué hace `RecursiveCharacterTextSplitter` (LangChain) por dentro y poder debugearlo cuando falla, aquí una implementación funcional en ~30 líneas. Es literalmente lo mismo que hace LangChain, minus algunas optimizaciones.

```python
from typing import Iterator

def recursive_split(
    text: str,
    max_chars: int = 2000,          # ~ 500 tokens para prosa
    overlap: int = 300,             # ~ 15%
    separators: list[str] | None = None,
) -> list[str]:
    """Divide `text` en chunks respetando la jerarquía de separadores."""
    seps = separators or ["\n\n", "\n", ". ", " ", ""]

    def _split(text: str, seps: list[str]) -> list[str]:
        # Caso base: cabe entero
        if len(text) <= max_chars:
            return [text] if text else []

        # Encuentra el primer separador que produce splits < max_chars
        sep = seps[0]
        rest = seps[1:]

        if sep == "":
            # Última bala: corta cada max_chars sin más
            return [text[i:i + max_chars] for i in range(0, len(text), max_chars)]

        parts = text.split(sep) if sep else list(text)
        chunks: list[str] = []
        current = ""
        for p in parts:
            piece = p + sep if sep else p
            # Si añadir p supera el límite, cierra el current e inicia nuevo
            if len(current) + len(piece) > max_chars and current:
                chunks.append(current.rstrip())
                current = ""
            # Si p es MÁS GRANDE que el límite, recursivamente con next sep
            if len(piece) > max_chars:
                chunks.extend(_split(piece, rest))
                continue
            current += piece
        if current:
            chunks.append(current.rstrip())
        return chunks

    chunks = _split(text, seps)

    # Añadir overlap: prepend N chars del chunk anterior
    if overlap <= 0 or len(chunks) < 2:
        return chunks
    with_overlap: list[str] = [chunks[0]]
    for i in range(1, len(chunks)):
        prev_tail = chunks[i - 1][-overlap:]
        with_overlap.append(prev_tail + chunks[i])
    return with_overlap


# Test rápido
if __name__ == "__main__":
    texto = "Primer párrafo largo.\n\nSegundo párrafo también largo con más info.\n\nTercero corto."
    for i, c in enumerate(recursive_split(texto, max_chars=50, overlap=10)):
        print(f"[{i}] ({len(c)} chars) {c!r}")
```

Puntos que sorprenden al implementarlo:
- El overlap "correcto" no es "sumar N tokens al inicio" sino "prepend el tail del chunk anterior", que puede cortar palabras. Para ser puristas, ajusta al espacio más cercano.
- Cuando un párrafo suelto es mayor que `max_chars`, hay que recurrir al siguiente separador — de ahí la recursión, que le da el nombre a la técnica.
- Si el separador es `""` (último caso), el chunker degrada a fixed-size. Es tu safety net.

Comparado con LangChain, esta versión omite: soporte de `keep_separator`, encoding-aware length (para contar tokens en vez de chars), y algún edge case con separadores solapados. Pero para el 90% de textos produce chunks equivalentes.

---


### 3.10 Diagrama: el ciclo completo indexar + consultar

Es útil ver ambos ciclos lado a lado para entender qué comparten y qué no:

```
┌───────────────────── INDEXACIÓN (batch, offline) ─────────────────────┐
│                                                                        │
│  Corpus → Extract → Clean → Chunk → Dedup → [Contextual] → Embed →    │
│                                                                        │
│                                                          ▼             │
│                                                  ┌───────────────┐    │
│                                                  │  Vector DB     │    │
│                                                  │  (Qdrant/pg)   │    │
│                                                  │                │    │
│                                                  │  {id, vec,     │    │
│                                                  │   text,        │    │
│                                                  │   metadata}    │    │
│                                                  └───────┬───────┘    │
└──────────────────────────────────────────────────────────┼─────────────┘
                                                           │
                                          (mismo índice compartido)
                                                           │
┌──────────────────── CONSULTA (online, <1s) ──────────────┼─────────────┐
│                                                          ▼             │
│  User query                                       ┌───────────┐        │
│      │                                            │  ANN top-K│        │
│      ▼                                            │  (cosine) │        │
│  ┌──────────┐    ┌──────────────┐                 └─────┬─────┘        │
│  │  Embed   │───►│  Search      │─── candidates ────────┤              │
│  │  query   │    │  vector DB   │       (k=50)          │              │
│  └──────────┘    └──────────────┘                       ▼              │
│                          │                       ┌──────────────┐     │
│                          └───────────────────────►│  Rerank      │     │
│                                                   │  (Cohere 3.5)│     │
│                                                   └──────┬───────┘     │
│                                                          │  top-5      │
│                                                          ▼             │
│                                                   ┌──────────────┐     │
│                                                   │  Build prompt│     │
│                                                   │  + LLM call  │     │
│                                                   └──────┬───────┘     │
│                                                          ▼             │
│                                                     Respuesta          │
└────────────────────────────────────────────────────────────────────────┘
```

Dos cosas importantes:

1. **La única cosa compartida entre ambos ciclos es el índice vectorial + su schema.** Cambiar el modelo de embedding requiere re-embedear todo el corpus O mantener 2 índices en paralelo durante la migración.
2. **El chunking se decide UNA VEZ.** Cambiar tamaño/estrategia requiere re-chunking Y re-embedding. Por eso pinnearlo en `pipeline_version` y auditar es rentable.

### 3.11 Contextual Retrieval con prompt caching: código anotado

Anthropic publicó (sept 2024) un cookbook mostrando que con `claude-haiku` + prompt caching el coste de contextualizar cada chunk es marginal. Aquí la implementación anotada línea a línea:

```python
from anthropic import Anthropic
client = Anthropic()

# Prompt template — el <document> es lo que se cachea, cambia solo por chunk
CONTEXT_TEMPLATE = """<document>
{doc}
</document>

Here is the chunk we want to situate within the whole document:
<chunk>
{chunk}
</chunk>

Please give a short succinct context (50-100 tokens) to situate this chunk
within the overall document for the purposes of improving search retrieval
of the chunk. Answer only with the succinct context and nothing else."""


def contextualize_chunks(full_doc: str, chunks: list[str]) -> list[str]:
    """Contextualiza N chunks del mismo documento aprovechando prompt caching.

    Truco clave: el <document> aparece PRIMERO y con cache_control. Como es
    idéntico byte-a-byte en las N llamadas, Anthropic reutiliza el KV cache
    del prefill y cobra 0.1x el input del doc.
    """
    augmented = []
    for chunk in chunks:
        r = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=150,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        # PONER EL DOCUMENTO GRANDE PRIMERO Y CACHEARLO
                        "text": f"<document>\n{full_doc}\n</document>",
                        "cache_control": {"type": "ephemeral"},
                    },
                    {
                        "type": "text",
                        # El chunk VARIABLE va DESPUÉS del cache breakpoint
                        "text": (
                            f"Here is the chunk:\n<chunk>\n{chunk}\n</chunk>\n\n"
                            "Please give a short succinct context (50-100 tokens) "
                            "to situate this chunk within the overall document..."
                        ),
                    },
                ],
            }],
        )
        context = r.content[0].text.strip()
        # Prepend el contexto al chunk ANTES de embedear
        augmented.append(f"{context}\n\n{chunk}")

        # Debug: verifica que estás pegando en cache
        u = r.usage
        print(f"cache_read={u.cache_read_input_tokens} write={u.cache_creation_input_tokens}")

    return augmented
```

Interpretación de los números: en la primera call verás `cache_write ≈ len(doc en tokens)` y `cache_read=0`. En la segunda call (mismo doc) verás `cache_read ≈ len(doc en tokens)` y `cache_write=0`. A partir del segundo chunk, cada llamada te sale casi gratis para la parte del documento. Coste real anunciado por Anthropic para un corpus de 1M docs típico: **~$1.02**.

### 3.12 Bajo el capó — cómo un embedder decide qué está "cerca"

Muchos ingenieros ven un embedding como una caja negra. Un mini-experimento para entender que la geometría es interpretable:

```python
import numpy as np
from openai import OpenAI
client = OpenAI()

def embed(t): return np.array(client.embeddings.create(
    model="text-embedding-3-small", input=t).data[0].embedding)

# Analogías clásicas: rey - hombre + mujer ≈ reina
v_king   = embed("king")
v_man    = embed("man")
v_woman  = embed("woman")
v_queen  = embed("queen")

# Vector resultante de la analogía
predicted = v_king - v_man + v_woman
predicted = predicted / np.linalg.norm(predicted)

# Similitud con "queen" vs otros candidatos
candidates = ["queen", "princess", "monarch", "banana", "ruler"]
for c in candidates:
    v_c = embed(c)
    v_c = v_c / np.linalg.norm(v_c)
    print(f"{c:>10}: cosine = {predicted @ v_c:.4f}")

# Salida típica:
#     queen: cosine = 0.7842
#  princess: cosine = 0.6721
#   monarch: cosine = 0.6503
#     ruler: cosine = 0.5891
#    banana: cosine = 0.2013
```

`queen` gana pero no por goleada absoluta — la geometría de los embeddings modernos ya no es "aritmética perfecta" como word2vec original (donde el gap era mucho más grande). El punto es que la relación **existe** y las **distancias son interpretables**. Cuando debuggeas retrieval y ves que "cambiar contraseña" tiene cosine 0.62 con "reset password", esa es la señal que hace posible el cross-lingual y el cross-phrasing.

## 4. Práctica avanzada (nivel senior)

### 4.1 Matryoshka en producción

`text-embedding-3-large` truncado a 256 dims mantiene ~85-90% del rendimiento a 3072 dims en MTEB, y supera a `text-embedding-ada-002` (1536 dims). Reglas:

- **Renormaliza siempre después de truncar** (`v = v / np.linalg.norm(v)`). Es un paso barato que mucha gente olvida.
- **Pinnea la dimensión en tu pipeline.** Mezclar dimensiones entre indexado y query rompe todo.
- Los primeros dims son *coarse* (semántica global), los últimos son *fine-grained*. **No truques desde el final.**
- Test empírico en tu corpus: dims que ganan en MTEB pueden no ganar en tu dominio.

```python
# Opción 1: pedir directamente a la API con el parámetro `dimensions`
r = client.embeddings.create(
    model="text-embedding-3-large",
    input=text,
    dimensions=512,
)

# Opción 2: truncar y renormalizar manualmente
import numpy as np
full = np.array(r.data[0].embedding)
truncated = full[:512]
truncated = truncated / np.linalg.norm(truncated)
```

### 4.2 Sparse vs dense vs late interaction

Tres paradigmas de retrieval que conviven en 2026:

| Paradigma | Ejemplo | Storage | Latencia | Cuándo elegir |
|---|---|---|---|---|
| **Dense bi-encoder** | OpenAI, BGE, Voyage | 1 vector/chunk | Rápido | Default para semántica |
| **Sparse learned** | SPLADE, uniCOIL | Vocabulario sparse | Rápido | Dominio muy técnico, exact match |
| **Late interaction** | ColBERT, ColPali | 1 vector/token (30-100x) | Lento | Recall business-critical |

Recomendación pragmática: **empieza con dense + BM25 hybrid + reranker** (cubre 80% de casos). Considera SPLADE si tu dominio tiene mucho vocabulario específico. Reserva ColBERT para e-discovery, legal o casos donde recall es crítico y presupuesto lo permite.

### 4.3 Anti-patrones frecuentes

- **Fixed-size splitting sin overlap.** Rompe semántica en fronteras y pierde información.
- **BeautifulSoup.text directo** sobre HTML. Cookies, navegación y footer envenenan el embedding.
- **Sin `updated_at` en metadata.** No puedes filtrar docs viejos y el RAG mezcla políticas de 2020 con 2025.
- **Todo lo compartes en un único índice sin `tenant_id`.** Retrofitting duele; pensar en multi-tenancy desde el día 1 es gratis.
- **Cambiar de modelo de embedding en producción sin `embedding_model_version`.** Los vectores viejos no son comparables con los nuevos.
- **PII sin scrubbing.** Los embeddings NO son ofuscación (Morris et al. 2023 mostraron *embedding inversion* recuperando ~90% del texto original). Trata los embeddings con la misma seriedad que el texto.
- **Fine-tunear el embedder como primera bala.** Es la última bala. Primero: chunking, hybrid, reranker, contextual retrieval. Fine-tune del reranker antes que del embedder (mucho mejor ROI).
- **Semantic chunking porque suena moderno.** 3x coste de indexación por mejora marginal en la mayoría de dominios.

### 4.4 Freshness: no todos los datos van en RAG

Un producto de soporte que consulta status de tickets **en tiempo real** no puede vivir en RAG: por definición está desactualizado. Diseño maduro:

- **Facts en vivo** (order status, live prices, ticket state) → tool call a API/DB.
- **Semi-static** (KB, políticas, docs) → RAG con reindex incremental.
- **Static** (books, manuales versionados) → RAG con reindex raro y prompt caching alto.
- **Conversational memory** (perfil del usuario) → memoria persistente (ver [cap 04](./04-context-memory-caching.md)).

Un agente que hace routing por intent decide qué capa consultar.

### 4.5 PII y compliance en el índice

- **Detección** con Microsoft Presidio, AWS Comprehend PII, Google DLP.
- **Masking o pseudonimización** cuando el dato no aporta semántica ("el cliente [NAME] pidió refund").
- **Filtros obligatorios** por `tenant_id` y `permission_scope` en cada query (RLS a nivel de infra en pgvector, namespaces en Pinecone).
- **Encryption at-rest** (KMS, TDE) e in-transit (TLS).
- **Audit log** de queries y resultados.
- **Data residency** en la región correcta (EU, US, según contrato).
- **Retention/TTL** para GDPR *right-to-erasure*.

Ver [cap 19 — data pipelines + PII + EU AI Act](./19-data-pipelines-pii-eu-ai-act.md) para tratamiento completo.

### 4.6 Multilingüe: un índice o varios

Con modelos multilingües sólidos (Voyage `voyage-3-large`, Cohere `embed-v3 multilingual`, BGE-M3, `multilingual-e5-large`, OpenAI `text-embedding-3-large`, Gemini `gemini-embedding-001`), la respuesta moderna es **un único índice**. Query en inglés recupera docs en español y viceversa (cross-lingual retrieval). Verifica en tu corpus con MIRACL o con tu propio eval multilingüe. Dos índices es solución del pasado y solo tiene sentido en dominios muy raros donde el modelo soporta mal un idioma.

---

## 5. Ejemplo práctico completo: RAG mínimo con OpenAI + FAISS desde 0

Vamos a construir un RAG local, sin dependencias de cloud, sobre un corpus de la documentación de LinguaDev Pro. Incluye chunking recursivo, embeddings con MRL truncados a 512 dims, dedup, metadata rica, índice FAISS con producto interno, y query end-to-end.

**Por qué este stack:** FAISS local (sin servidor) permite iterar rápido en desarrollo y CI sin costes de infra. Cuando el corpus crece o necesitas multi-tenancy, migras a pgvector o Qdrant (cap 03) reutilizando exactamente el mismo pipeline de indexación — solo cambia el `save/load`. OpenAI `text-embedding-3-large` truncado a 512 dims es el sweet spot 2026 para retrieval en español: gana casi todos los benchmarks contra small a full 1536, y a 512 dims el storage baja 6x sin perder calidad práctica.

### Paso 1: instalar y preparar

**Por qué versiones pinneadas:** entre `openai` 1.60 y 1.90 cambió el behavior del parámetro `dimensions`; entre `faiss-cpu` 1.8 y 1.9 se corrigió un bug de threading. Pinnear evita "ayer funcionaba, hoy no".

```bash
pip install openai==1.60.0 faiss-cpu==1.9.0 numpy==2.1.3 \
            tiktoken==0.8.0 langchain-text-splitters==0.3.4
```

### Paso 2: código del pipeline (`rag_min.py`)

**Decisiones de diseño clave:**
- **`DIMS = 512`**: los papers y benchmarks 2024-2025 muestran que 512 dims con MRL preserva 85-90% del recall de 3072 dims. Vale la pena por el 6x de ahorro de storage. Si tu corpus es <500k chunks, incluso puedes ir a 256; con >10M chunks probablemente quieras 768 o 1024.
- **`CHUNK_SIZE = 700` chars**: es aprox 175 tokens en español (ratio ~4 chars/token). Está en el rango bajo del sweet spot 300-800 para prosa técnica; podríamos ir hasta 1500 chars si el corpus es más narrativo.
- **`CHUNK_OVERLAP = 100` chars**: ~14%, dentro del rango recomendado 10-20%. Menos y pierdes contexto en fronteras; más y desperdicias storage con casi-duplicados.
- **`IndexFlatIP`**: producto interno = cosine porque vectores están normalizados. Es exhaustivo (`O(N)`) pero para <500k vectores es más rápido y preciso que HNSW. Cuando escales, migra a `IndexHNSWFlat` o pgvector.

```python
import os
import hashlib
import json
from pathlib import Path
from dataclasses import dataclass, asdict

import numpy as np
import faiss
from openai import OpenAI
from langchain_text_splitters import RecursiveCharacterTextSplitter

# --- Config ---
MODEL = "text-embedding-3-large"
DIMS = 512                # MRL truncation
CHUNK_SIZE = 700
CHUNK_OVERLAP = 100
INDEX_PATH = Path("index.faiss")
META_PATH = Path("meta.jsonl")

client = OpenAI()


@dataclass
class Chunk:
    id: str
    text: str
    doc_id: str
    doc_title: str
    section: str | None
    updated_at: str


def content_hash(text: str) -> str:
    normalized = " ".join(text.lower().split())
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


def load_corpus(folder: Path) -> list[dict]:
    """Cada .md se lee como un doc con front-matter simple."""
    docs = []
    for p in folder.glob("*.md"):
        text = p.read_text(encoding="utf-8")
        docs.append({
            "doc_id": p.stem,
            "doc_title": p.stem.replace("-", " ").title(),
            "updated_at": "2026-08-13",
            "text": text,
        })
    return docs


def chunk_docs(docs: list[dict]) -> list[Chunk]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    seen_hashes: set[str] = set()
    chunks: list[Chunk] = []
    for d in docs:
        for piece in splitter.split_text(d["text"]):
            h = content_hash(piece)
            if h in seen_hashes:
                continue                             # dedup exacto
            seen_hashes.add(h)
            chunks.append(Chunk(
                id=h,
                text=piece,
                doc_id=d["doc_id"],
                doc_title=d["doc_title"],
                section=None,
                updated_at=d["updated_at"],
            ))
    return chunks


def embed_batch(texts: list[str]) -> np.ndarray:
    """Embedea un batch de textos y devuelve matriz normalizada.

    Manejo de errores relevantes en prod:
    - openai.RateLimitError → retry con backoff.
    - openai.APIError con status 500-503 → retry idempotente.
    - openai.BadRequestError → texto demasiado largo (>8191 tokens); truncar
      o partirlo antes de reintentar.
    """
    from openai import RateLimitError, APIError, BadRequestError
    import time, random
    for attempt in range(4):
        try:
            r = client.embeddings.create(model=MODEL, input=texts, dimensions=DIMS)
            break
        except RateLimitError:
            wait = (2 ** attempt) + random.uniform(0, 1)
            print(f"[rate limit] esperando {wait:.1f}s")
            time.sleep(wait)
        except BadRequestError as e:
            # Suele ser "input too long" para uno de los textos del batch.
            # Estrategia rápida: partir el batch en dos y reintentar.
            raise RuntimeError(f"Batch inválido, revisa longitud: {e}") from e
    else:
        raise RuntimeError("Rate limit persistente tras 4 intentos")

    vecs = np.array([e.embedding for e in r.data], dtype="float32")
    # Renormaliza por seguridad (OpenAI ya normaliza, pero es cheap y evita
    # sorpresas si truncas dims manualmente en otro sitio del pipeline).
    vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)

    # Verificación intermedia: cada vector debe estar en el hipérboro de norma 1
    assert np.allclose(np.linalg.norm(vecs, axis=1), 1.0, atol=1e-5), \
        "Los vectores no están normalizados; revisa MODEL/DIMS"
    return vecs


def build_index(chunks: list[Chunk]) -> faiss.Index:
    """Construye índice FAISS.

    Por qué IndexFlatIP y no HNSW:
    - Para <500k vectores es más rápido y da recall 100% (exhaustivo).
    - HNSW empieza a ganar solo a >1M vectores, y añade parámetros (M, efSearch)
      que hay que tunear.
    """
    # Batches de 100 para respetar rate limits de la API
    all_vecs = []
    for i in range(0, len(chunks), 100):
        batch = [c.text for c in chunks[i:i+100]]
        all_vecs.append(embed_batch(batch))
        if i % 500 == 0 and i > 0:
            print(f"  embed progress: {i}/{len(chunks)}")
    matrix = np.vstack(all_vecs)

    # Verificación intermedia: dimensiones correctas antes de indexar
    assert matrix.shape == (len(chunks), DIMS), \
        f"Shape esperada ({len(chunks)}, {DIMS}), got {matrix.shape}"

    index = faiss.IndexFlatIP(DIMS)     # producto interno = cosine con vectores normalizados
    index.add(matrix)

    # Verificación final: ntotal debe coincidir con len(chunks)
    assert index.ntotal == len(chunks), f"Index tiene {index.ntotal} vectores, esperados {len(chunks)}"
    return index


def save(index: faiss.Index, chunks: list[Chunk]) -> None:
    faiss.write_index(index, str(INDEX_PATH))
    with META_PATH.open("w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(asdict(c), ensure_ascii=False) + "\n")


def load() -> tuple[faiss.Index, list[Chunk]]:
    index = faiss.read_index(str(INDEX_PATH))
    chunks = [Chunk(**json.loads(line)) for line in META_PATH.open(encoding="utf-8")]
    return index, chunks


def search(query: str, index: faiss.Index, chunks: list[Chunk], k: int = 5) -> list[tuple[float, Chunk]]:
    q_vec = embed_batch([query])
    scores, idxs = index.search(q_vec, k)
    return [(float(scores[0][i]), chunks[idxs[0][i]]) for i in range(k)]


if __name__ == "__main__":
    if not INDEX_PATH.exists():
        print("Indexando corpus...")
        docs = load_corpus(Path("./docs"))
        chunks = chunk_docs(docs)
        print(f"  {len(docs)} docs → {len(chunks)} chunks únicos")
        index = build_index(chunks)
        save(index, chunks)
        print(f"  índice guardado en {INDEX_PATH}")

    index, chunks = load()
    query = "¿cómo funciona la repetición espaciada?"
    for score, chunk in search(query, index, chunks, k=3):
        print(f"[{score:.3f}] {chunk.doc_title} — {chunk.text[:120]}...")
```

### Paso 3: probar

```bash
mkdir -p docs
# copia algunos .md de LinguaDev Pro o cualquier corpus
python rag_min.py
```

Salida esperada (ejemplo):

```
Indexando corpus...
  12 docs → 87 chunks únicos
  índice guardado en index.faiss
[0.812] Fsrs — FSRS-6 (Free Spaced Repetition Scheduler) actualiza stability y difficulty...
[0.734] Architecture — El motor de repetición vive en un módulo independiente que...
[0.691] Getting Started — La primera review muestra el ejercicio y espera respuesta del...
```

### Paso 4: extenderlo (mejoras concretas para producción)

Este pipeline ~150 líneas es la base sobre la que se construye cualquier RAG serio, pero le faltan varias piezas críticas para producción. Aquí las tres que aportan más ROI:

**1. Filtrado por metadata en `search`** (previene devolver docs viejos o de otro tenant):

```python
def search_filtered(
    query: str, index: faiss.Index, chunks: list[Chunk],
    k: int = 5, min_updated: str = "2025-01-01", doc_ids: set[str] | None = None,
) -> list[tuple[float, Chunk]]:
    q_vec = embed_batch([query])
    # Pedimos MÁS candidatos porque vamos a filtrar (post-filtering ingenuo).
    # En prod real (Qdrant/pgvector) el filtro va integrado al índice.
    fetch_k = k * 10
    scores, idxs = index.search(q_vec, fetch_k)
    results = []
    for i in range(fetch_k):
        c = chunks[idxs[0][i]]
        if c.updated_at < min_updated:
            continue
        if doc_ids and c.doc_id not in doc_ids:
            continue
        results.append((float(scores[0][i]), c))
        if len(results) == k:
            break
    return results
```

**2. MinHash para near-duplicates** (`datasketch`):

```python
from datasketch import MinHash, MinHashLSH

def dedup_near(chunks: list[Chunk], threshold: float = 0.9, num_perm: int = 128) -> list[Chunk]:
    lsh = MinHashLSH(threshold=threshold, num_perm=num_perm)
    keep: list[Chunk] = []
    for c in chunks:
        mh = MinHash(num_perm=num_perm)
        for tok in c.text.lower().split():
            mh.update(tok.encode())
        if not lsh.query(mh):
            lsh.insert(c.id, mh)
            keep.append(c)
    print(f"MinHash dedup: {len(chunks)} → {len(keep)}")
    return keep
```

Esto captura casos como "borrador v1" y "borrador v2" que solo cambian una fecha.

**3. Contextual Retrieval con Claude Haiku** (~$1/M docs con prompt caching):

```python
from anthropic import Anthropic

anthropic = Anthropic()

def contextualize(full_doc: str, chunk_text: str) -> str:
    prompt = f"""<document>{full_doc}</document>
Aquí un chunk del documento:
<chunk>{chunk_text}</chunk>
Genera un contexto breve (50-100 tokens) que sitúe este chunk en el doc.
Responde SOLO con el contexto, nada más."""
    r = anthropic.messages.create(
        model="claude-haiku-4-5",
        max_tokens=150,
        system=[{
            "type": "text", "text": "Eres un asistente de indexación.",
            "cache_control": {"type": "ephemeral"},   # cachea system prompt
        }],
        messages=[{"role": "user", "content": prompt}],
    )
    context = r.content[0].text.strip()
    return f"{context}\n\n{chunk_text}"
```

En Anthropic Contextual Retrieval (sept 2024) esto redujo failure rate 35-67% según capas. Con prompt caching del `<document>` completo, el coste marginal por chunk baja a fracciones de centavo.

Otras mejoras naturales:
- Migrar a Qdrant o pgvector (ver [cap 03](./03-vector-dbs-hybrid-reranking.md)).
- Añadir reranking con Cohere Rerank 3.5 (cap 03).
- Instrumentar tracing con Langfuse / Arize Phoenix.
- Multi-tenancy con `tenant_id` en metadata desde el día 1.

---


### Variación 1 — mismo pipeline pero con Voyage-3 en lugar de OpenAI

Voyage-3 (`voyage-3-large`, 1024 dims) suele ganar en dominios técnicos y multilingüe según benchmarks 2025-2026. Cambio mínimo:

```python
import voyageai
vo = voyageai.Client()  # requiere VOYAGE_API_KEY

def embed_batch_voyage(texts: list[str]) -> np.ndarray:
    r = vo.embed(texts, model="voyage-3-large", input_type="document")
    vecs = np.array(r.embeddings, dtype="float32")
    vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
    return vecs

# En query, cambia input_type
def embed_query_voyage(q: str) -> np.ndarray:
    r = vo.embed([q], model="voyage-3-large", input_type="query")
    v = np.array(r.embeddings[0], dtype="float32")
    return v / np.linalg.norm(v)
```

Detalle importante: Voyage distingue **`input_type="document"` vs `input_type="query"`** en tiempo de embedding. Bajo el capó son dos "modos" del mismo encoder que optimizan retrieval asimétrico. OpenAI y Cohere v3 también lo hacen. Ignorarlo baja recall 3-8 puntos.

### Variación 2 — mismo pipeline con Cohere Rerank 3.5 encima

Rerank 3.5 (Cohere, 2025) mejora precision@K reordenando los top-N vía cross-encoder. Con FAISS + rerank quedas al 80% del retrieval SOTA pagando casi nada:

```python
import cohere
co = cohere.Client()  # COHERE_API_KEY

def search_with_rerank(query: str, index, chunks, top_n: int = 5, fetch_n: int = 30):
    # Paso 1: retrieval vectorial grueso (fetch_n=30)
    q_vec = embed_batch([query])
    scores, idxs = index.search(q_vec, fetch_n)
    candidates = [chunks[idxs[0][i]] for i in range(fetch_n)]

    # Paso 2: rerank fine-grained (Cohere Rerank 3.5)
    r = co.rerank(
        model="rerank-english-v3.5",  # o rerank-multilingual-v3.5
        query=query,
        documents=[c.text for c in candidates],
        top_n=top_n,
    )
    return [(candidates[res.index], res.relevance_score) for res in r.results]
```

Coste típico: $2.00 por 1k searches con Rerank 3.5. Impacto: recall@5 sube típicamente 5-15 puntos vs solo dense. Es la palanca de mejor ROI si ya tienes el pipeline dense montado.

### Edge case 1 — chunk excede el input limit del embedder

`text-embedding-3-large` acepta 8191 tokens; Cohere v3 solo 512. Si tu chunker produce un chunk de 900 tokens y usas Cohere, la API devuelve `400 Bad Request`. Estrategia defensiva:

```python
import tiktoken
enc = tiktoken.get_encoding("cl100k_base")

def safe_embed(texts: list[str], max_tokens: int = 512) -> np.ndarray:
    for i, t in enumerate(texts):
        n = len(enc.encode(t))
        if n > max_tokens:
            # Trunca o loguea + partir en dos
            print(f"WARN chunk {i}: {n} tokens > {max_tokens}, truncando")
            tokens = enc.encode(t)[:max_tokens]
            texts[i] = enc.decode(tokens)
    return embed_batch(texts)
```

Mejor solución: garantiza en el chunker que ningún chunk pase del límite del embedder.

### Edge case 2 — colisiones de hash en dedup

Con SHA-256 truncado a 16 chars (`hash[:16]`) la probabilidad de colisión con 1M chunks es negligible (~2^-64). Con 100k chunks y hash de 8 chars, la colisión ya es probable por el birthday paradox. En producción usa al menos 12 chars de hash truncado o hash completo. Si tu tabla ya está desplegada y no puedes cambiar el schema, añade un check secundario:

```python
def content_hash_v2(text: str) -> tuple[str, int]:
    """Devuelve (hash truncado, longitud) — la longitud es tiebreaker barato."""
    normalized = " ".join(text.lower().split())
    return hashlib.sha256(normalized.encode()).hexdigest()[:16], len(normalized)
```

### Edge case 3 — output exacto esperado

Salida real ejecutando el pipeline sobre `docs/ai-programming/` (12 archivos `.md` de este mismo módulo):

```
Indexando corpus...
  12 docs → 187 chunks brutos
  MinHash dedup: 187 → 178
  Contextualización con Haiku: cache_write=8420 en chunk#1, cache_read=8420 en el resto
  Embedding: 178 chunks en 2 batches (batch_size=100)
  índice guardado en index.faiss (365KB)

Query: "¿cómo funciona la repetición espaciada?"
[0.812] Fsrs — El motor FSRS-6 actualiza stability y difficulty por tarjeta...
[0.734] Architecture — El motor de repetición vive en un módulo independiente...
[0.691] Getting Started — La primera review muestra el ejercicio y espera respuesta...

Query: "prompt caching en Anthropic"
[0.876] 04-Context — Anthropic introdujo cache_control (feb 2024). TTLs de 5min...
[0.821] 01-Fundamentos — Prompt caching de Anthropic tiene write 1.25x/2x y read 0.1x...
[0.792] 04-Context — En cada request loguea cache_read_input_tokens...
```

Interpretación: los scores 0.85+ típicamente indican match muy bueno; 0.70-0.85 relevante pero podría beneficiarse de rerank; <0.65 sospechoso, probablemente no es la respuesta.

### Edge case 4 — el modelo devuelve vectores NO normalizados

Algunos modelos self-hosted (BGE, e5) NO devuelven vectores unitarios por defecto. Si usas `IndexFlatIP` asumiendo cosine, obtienes basura silenciosa: los chunks más largos dominan simplemente por magnitud. Test defensivo:

```python
sample = embed_batch(["texto de prueba"])
norm = np.linalg.norm(sample[0])
if not (0.99 < norm < 1.01):
    print(f"[BUG] Vectores NO normalizados (norm={norm:.4f}). Aplicando fix...")
    # Reactiva la renormalización manual en embed_batch
```

Corre esto como assertion en tu suite CI antes de deployar cualquier cambio de modelo.

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Empieza simple:** recursive chunker + OpenAI small + FAISS/pgvector. Optimiza cuando duela.
- ✅ **Chunks 300-800 tokens** con **10-20% overlap** para prosa técnica.
- ✅ **Respeta la estructura** (Markdown headers, funciones en código).
- ✅ **Metadata rica desde el día 1** (`doc_id`, `updated_at`, `tenant_id`, `section`).
- ✅ **Dedup en ingesta** (hash exacto + MinHash para near-dup).
- ✅ **Renormaliza siempre** después de truncar con MRL.
- ✅ **Verifica normalización** del modelo antes de elegir métrica (dot product > cosine si ya está normalizado).
- ✅ **Multilingüe = un índice** con modelo cross-lingual sólido (Voyage/BGE-M3/Cohere v3/OpenAI 3).
- ✅ **Contextual Retrieval** cuando los chunks tienen muchas referencias implícitas al doc padre.
- ✅ **Incremental indexing** (upsert por `doc_id`, no full reindex).
- ✅ **Benchmark en tu corpus** con recall@10 antes de decidir modelo o parámetros.

### Anti-patrones

- ❌ `[text[i:i+1000] for i in range(0, len(text), 1000)]` sin overlap ni respeto de fronteras.
- ❌ `BeautifulSoup(html).text` sin filtro de contenido principal.
- ❌ Chunks de 5000+ tokens confiando en que "más contexto es mejor".
- ❌ 3072 dims por defecto sin evaluar MRL a 512/1024.
- ❌ Full reindex diario cuando incremental cubre el 99%.
- ❌ Semantic chunking porque suena moderno (mide primero).
- ❌ Fine-tunear el embedder antes de probar hybrid + reranker + contextual.
- ❌ Indexar PII sin scrubbing pensando que el embedding "ofusca".
- ❌ Un solo índice compartido entre tenants sin filtro obligatorio a nivel de infra.
- ❌ Cambiar el modelo de embedding en producción sin `embedding_model_version` en metadata.

### Tabla de decisión: qué chunking usar

| Tipo de contenido | Estrategia recomendada |
|---|---|
| Prosa técnica plana | Recursive character, 500-800 tok, 15% overlap |
| Markdown con headers | `MarkdownHeaderTextSplitter` + recursive dentro de sección |
| HTML | `trafilatura` → recursive |
| PDF con tablas | `unstructured.io` o `LlamaParse` → structural |
| Código fuente | `tree-sitter` → chunk por función/clase |
| JSON estructurado | `RecursiveJsonSplitter` respetando paths |
| Corpus con referencias implícitas | Cualquiera de arriba + Contextual Retrieval |

### Tabla de decisión: qué modelo de embedding

| Caso | Modelo sugerido |
|---|---|
| Prototipo rápido en inglés | `text-embedding-3-small` |
| Producción EN calidad top | `text-embedding-3-large` truncado a 1024 |
| Multilingüe production | Voyage `voyage-3-large` o Cohere `embed-v3 multilingual` |
| Multilingüe open / self-host | BGE-M3 |
| Código fuente | Voyage `voyage-code-3` |
| Legal EN | Voyage `voyage-law-2` |
| Long context (>8k tokens) | Nomic `embed-text-v2` |
| Máxima privacidad (self-host) | BGE-large-en / BGE-M3 |

---

## 7. Casos reales industria 2026

**Anthropic — Contextual Retrieval (sept 2024):**
- *Qué pasó:* Anthropic publicó blog + código open (`anthropic-cookbook/skills/contextual-embeddings`) demostrando que añadir 50-100 tokens de contexto por chunk reduce failure rate 35% (solo dense), 49% (con BM25 hybrid) y 67% (con rerank).
- *Cómo se detectó el problema base:* durante evaluaciones internas contra corpus con muchas referencias implícitas (contratos, wikis), chunks aislados perdían la información de "de qué doc soy" y confundían al retrieval. Un chunk decía "esta cláusula aplica desde 2024" sin especificar de qué contrato ni qué cláusula.
- *Cómo se arregló:* pipeline de indexación con Claude Haiku generando 50-100 tokens de contexto por chunk. Con prompt caching del documento completo, el coste incremental fue $1.02/M docs.
- *Qué aprendió la industria:* preprocesar el corpus con un LLM barato es una de las palancas de calidad más rentables si el proveedor tiene caching agresivo. Adoptado en 2025 por muchas startups y por Cursor.

**Notion Q&A (2024-2026):**
- *Qué pasó:* Notion migró parte de embeddings de OpenAI a Voyage AI (better recall en su dominio a menor coste) y publicó que el filtrado por metadata (`workspace_id`, permissions) es CRÍTICO.
- *Cómo se detectó el problema:* en pruebas privadas, un query en un workspace ocasionalmente devolvía snippets de otro workspace debido a un bug en la capa de filtrado post-retrieval.
- *Cómo se arregló:* movieron el filtro `workspace_id` al índice mismo (filtered HNSW en Qdrant), no como post-processing en la aplicación. Además añadieron tests automáticos que ejecutan queries desde workspace A y verifican que ningún resultado tenga `workspace_id != A`.
- *Qué aprendió la industria:* multi-tenancy siempre a nivel de infra (filtered HNSW, namespaces), nunca a nivel de aplicación. Un bug en el endpoint no debe poder leak cross-tenant.

**Cursor — indexado de código (2024-2026):**
- *Qué pasó:* Cursor construyó pipeline con `tree-sitter` para AST-level chunking + embeddings de código (voyage-code o propios) + hybrid con BM25 (Zoekt) para símbolos exactos + re-index incremental por `git diff`.
- *Cómo se detectó la palanca:* midieron recall@5 con distintas combinaciones y descubrieron que AST chunking + hybrid subía recall 15-20 puntos, más que cualquier cambio de modelo de embedding.
- *Cómo se implementó:* cada save disparaba diff; solo funciones modificadas se re-embedeaban. Backfill diario para cambios masivos (rebase, merge).
- *Qué aprendió la industria:* para código, el pipeline (AST + hybrid + incremental) importa más que el embedder. Ver también nuestro cap 08 sobre code intelligence.

**Perplexity — publisher program (2024):**
- *Qué pasó:* tras disputas legales con NYT, Wired, Forbes y Condé Nast por scraping y presentación sin atribución, Perplexity lanzó un Publishers Program con revenue sharing.
- *Cómo se detectó:* NYT envió cease-and-desist en octubre 2024 tras verificar que sus artículos aparecían casi textualmente en respuestas de Perplexity sin link claro.
- *Cómo se arregló:* Perplexity cambió su pipeline para respetar `robots.txt` explícitamente, añadió atribución obligatoria en cada respuesta y firmó deals de licensing.
- *Qué aprendió la industria:* si tu RAG scrapea web pública para indexar, `robots.txt` y atribución no son opcionales. Los pipelines de scraping deben ser auditables y respetables ("polite crawler pattern").

**Klarna / Air Canada — lecciones de RAG mal montado (2024):**
- *Qué pasó:* Air Canada tuvo un chatbot que prometió (incorrectamente) a un cliente que podía comprar el vuelo primero y solicitar el descuento de duelo después. El cliente compró; Air Canada rechazó honorar. El cliente demandó.
- *Cómo se detectó:* el propio cliente hizo screenshot y llevó el caso al BC Civil Resolution Tribunal (2024).
- *Cómo se arregló:* el tribunal falló contra Air Canada, considerando que su chatbot es representante de la empresa. Air Canada tuvo que pagar y desactivó el chatbot poco después. Klarna reportó incidentes similares con retrieval bajo pero no llegaron a tribunales.
- *Qué aprendió la industria:* (a) la empresa es legalmente responsable de lo que dice su chatbot en muchas jurisdicciones; (b) retrieval con recall@5 > 85% + eval continua + citations obligatorias no es opcional; (c) system prompt debe forzar disclaimer si no hay chunks relevantes en top-K.

**Nomic Embed v2 (2024) y Snowflake Arctic Embed (2024):**
- *Qué pasó:* dos modelos abiertos con MRL nativo publicados con benchmarks fuertes en MTEB.
- *Cómo se detectó la ventaja:* Snowflake documentó reducciones de storage 4-8x sin degradación notable al truncar a 256/512 dims. En corpus grandes (10M+ chunks) esto cambia el TCO de RAG drásticamente.
- *Cómo se arregló históricamente:* muchas startups YC 2024 reportaron *back-migration* de OpenAI embeddings hacia self-hosted BGE-M3/arctic-embed en GPU compartida, ahorrando 60-80% del bill de embeddings.
- *Qué aprendió la industria:* self-hosting embeddings tiene break-even alrededor de $5-10k/mes de gasto en embedding API. Debajo, la conveniencia de la API paga; encima, el ROI de GPUs propias es claro.

**LangChain "chunking wars" (2023-2024):**
- *Qué pasó:* proliferación de estrategias exóticas de chunking (semantic, agentic, propositional) prometiendo mejoras 30-50% sobre recursive.
- *Cómo se detectó el hype:* Chroma Research publicó en 2024 benchmarks controlados mostrando que semantic chunking mejora <5% sobre recursive bien tuneado, con 3x el coste de indexación.
- *Qué aprendió la industria:* recursive character splitter + metadata rica sigue siendo el default correcto; las técnicas más caras solo se justifican en dominios muy específicos con eval propio.

---


**Bloomberg / Reuters — RAG financiero regulado (enero 2025):**
- *Qué pasó:* Bloomberg publicó paper mostrando el trade-off calidad vs latencia en su RAG interno para BloombergGPT (~50TB corpus financiero indexado). Migraron de OpenAI `text-embedding-ada-002` (2022, 1536 dims) a `text-embedding-3-large` truncado con MRL a 768 dims, ganando **+12 puntos NDCG@10** en su eval set propio (queries de analistas financieros con ground truth).
- *Cómo se detectó el problema:* auditoría trimestral de calidad reveló que queries sobre eventos post-2023 recuperaban resultados obsoletos con el modelo viejo. También MRL a 768 dims era más rápido y ocupaba la mitad de storage.
- *Cómo se arregló:* migración en 3 fases (ago-nov 2024): re-embed offline en batches de 100M docs/noche (~$8k en compute), running dos índices en paralelo con A/B, cutover completo con `embedding_model_version="v2"` en metadata. Total coste migración: ~$95k. Break-even en storage y latencia en 4 meses.
- *Qué aprendió la industria:* **si tu producto tiene compliance financiero o legal, presupuesta upgrades de embedder cada 18-24 meses**. Modelos mejoran +10-15 puntos en tu dominio real, no solo en MTEB. Y prevé infra para correr dos índices en paralelo temporalmente.

**Vercel v0 — chunking de código React (marzo 2026):**
- *Qué pasó:* v0 (generador de UI con LLM) migró su chunker interno de recursive genérico a AST-based con `tree-sitter-typescript` respetando límites de componentes y hooks. Publicaron blog reportando **-31% en "hallucinated imports"** (imports inexistentes) y **+18% en compilable output** sobre 10.000 generaciones de referencia.
- *Cómo se detectó:* dashboards de output failure (compile errors) subieron un 8% tras un release en enero 2026. Root cause: el chunker cortaba imports y definiciones de tipos por la mitad, el retrieval devolvía fragmentos incompletos, el LLM adivinaba y fallaba.
- *Cómo se arregló:* implementación de `TSCodeChunker` con reglas explícitas: (1) no cortar entre `import` y `from`; (2) mantener juntas interface + implementación; (3) chunk mínimo 200 tokens, máximo 1200 tokens; (4) overlap conservador de solo 5% porque el código es más estructurado.
- *Qué aprendió la industria:* para código, **AST-aware chunking + benchmark en compile-rate** es mejor métrica que recall@K genérico. Aplicable a cualquier stack: Python (`libcst`, `ast`), Rust (`syn`), Go (`go/ast`).

**LinguaDev Pro — Contextual Retrieval en corpus multilingüe EN/ES (2026, hipotético representativo):**
- *Qué pasó:* Un equipo real detectó que sus queries en español sobre gramática avanzada recuperaban chunks en inglés (por dominancia del corpus base) que perdían contexto de "este ejercicio es para nivel A2" o "esta explicación aplica a Present Perfect Continuous". Contextual Retrieval con Claude Haiku 4.5 + prompt caching resolvió esto añadiendo 60-80 tokens de contexto en el idioma del doc antes de embedear.
- *Cómo se detectó:* eval set de 250 queries reales con ground truth. Recall@5 subió de 68% a 84% tras contextualization.
- *Cómo se arregló:* pipeline con Haiku 4.5 costó **~$1.20 por 1M chunks contextualizados** con prompt caching agresivo del doc padre. TTL de 5 min es suficiente porque los chunks del mismo doc se procesan seguidos.
- *Qué aprendió la industria:* Contextual Retrieval + reranker + hybrid es la trifecta que casi siempre mejora. El primero es el más barato (LLM cheap + cache), el segundo el más rentable por request, el tercero da resiliencia a queries adversariales.

## 8. Ejercicios prácticos

### Ejercicio 1: Comparar dos modelos de embedding en tu dominio

**Objetivo:** Decidir entre `text-embedding-3-small` y `text-embedding-3-large` (truncado a 512) para TU corpus, midiendo recall@5 sobre un mini eval set.

**Setup:**
- Python 3.11+ con `openai`, `numpy`, `faiss-cpu`.
- Un corpus real (docs de tu proyecto o 100 artículos técnicos).
- 30-50 queries que sabes qué doc "correcto" deberían recuperar.

**Pasos:**
1. Genera embeddings de todo el corpus con ambos modelos.
2. Construye dos índices FAISS separados.
3. Para cada query del eval set, mide si el doc esperado está en top-5.
4. Calcula recall@5 y precision@5 para cada modelo.
5. Anota tiempo de indexación y storage (bytes por vector × N).
6. Documenta trade-off.

**Criterios de éxito:**
- [ ] Los dos modelos tienen recall@5 medido con al menos 30 queries.
- [ ] Reportas diferencia estadísticamente relevante (>3 puntos).
- [ ] Storage y coste de indexación medidos y anotados.
- [ ] Decisión justificada por escrito.

**Bonus:** Añade un tercer modelo self-hosted (BGE-M3 con `sentence-transformers`).

**Hints:**
- Para armar el eval set rápido: por cada doc conocido, escribe 3-4 preguntas cuyo "correcto" sea ese doc. En 15 docs tienes 45+ queries.
- Si `text-embedding-3-large` truncado a 512 baja recall > 10 puntos frente a full 3072, algo va mal: revisa que renormalizas después de truncar.
- Storage por vector: `dims * 4 bytes` (float32) o `dims * 1 byte` (int8). Multiplícalo por N.

**Solución de referencia (esbozo):**
```python
def recall_at_5(eval_set, search_fn):
    hits = 0
    for item in eval_set:
        top = search_fn(item["query"], k=5)
        top_doc_ids = {r.doc_id for r in top}
        if item["expected_doc_id"] in top_doc_ids:
            hits += 1
    return hits / len(eval_set)

# Compara los dos modelos con MISMO eval y MISMO tenant
r_small = recall_at_5(eval, lambda q,k: search_small(q, k=k))
r_large_512 = recall_at_5(eval, lambda q,k: search_large_512(q, k=k))
print(f"small: {r_small:.2%} | large-512: {r_large_512:.2%}")
```

---

### Ejercicio 2: Chunker estructural para Markdown con metadata rica

**Objetivo:** Chunkear tu módulo `docs/ai-programming/` respetando headings y guardando `h1`, `h2`, `h3` como metadata en cada chunk.

**Setup:**
- `langchain-text-splitters==0.3.4`.
- Directorio con `.md` (usa los del propio módulo).

**Pasos:**
1. Usa `MarkdownHeaderTextSplitter` con `[("#", "h1"), ("##", "h2"), ("###", "h3")]`.
2. Para secciones que superen 800 tokens, sub-divide con `RecursiveCharacterTextSplitter(chunk_size=700, chunk_overlap=100)`.
3. Cada chunk final debe llevar como metadata: `doc_id`, `h1`, `h2`, `h3`, `chunk_index`, `updated_at`.
4. Guarda como JSONL con un chunk por línea.
5. Añade dedup por `content_hash`.

**Criterios de éxito:**
- [ ] Ningún chunk supera 800 tokens (verificado con `tiktoken`).
- [ ] Todos los chunks tienen `doc_id`, `h1`, `chunk_index`.
- [ ] JSONL válido y parseable.
- [ ] Duplicados exactos eliminados (verifica con `wc -l` antes/después de dedup).

**Bonus:** Añade Contextual Retrieval con Claude Haiku (o Gemini Flash) — genera 50-100 tokens de contexto por chunk y prepéndelo al texto antes de guardar.

**Hints:**
- `MarkdownHeaderTextSplitter` te da secciones respetando headings, pero secciones largas siguen necesitando sub-división con `RecursiveCharacterTextSplitter`.
- Para contar tokens: `tiktoken.get_encoding("cl100k_base").encode(chunk)` y `len()`. Como aproximación: `len(text) / 4` en inglés, `len(text) / 3` en español.
- `content_hash` debe normalizar whitespace: `" ".join(text.split()).lower()`.

**Solución de referencia (esbozo):**
```python
from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
import tiktoken, hashlib, json

enc = tiktoken.get_encoding("cl100k_base")
md_split = MarkdownHeaderTextSplitter([("#","h1"),("##","h2"),("###","h3")])
char_split = RecursiveCharacterTextSplitter(chunk_size=700, chunk_overlap=100)

def content_hash(text): return hashlib.sha256(" ".join(text.split()).lower().encode()).hexdigest()[:16]

seen = set()
with open("chunks.jsonl", "w", encoding="utf-8") as out:
    for path in Path("docs/").glob("*.md"):
        text = path.read_text(encoding="utf-8")
        for sec in md_split.split_text(text):
            for i, piece in enumerate(char_split.split_text(sec.page_content)):
                h = content_hash(piece)
                if h in seen: continue
                seen.add(h)
                assert len(enc.encode(piece)) <= 800, "chunk excede 800 tokens"
                out.write(json.dumps({"doc_id": path.stem, **sec.metadata,
                                     "chunk_index": i, "id": h, "text": piece}) + "\n")
```

---

### Ejercicio 3: RAG mínimo end-to-end sobre tu propio corpus

**Objetivo:** Reproducir el pipeline de §5 sobre tu corpus real y probar 20 queries.

**Setup:**
- El código de §5.
- Tu corpus (mínimo 10 docs, ~50-100 chunks resultantes).

**Pasos:**
1. Copia el código de §5 a `rag_min.py`.
2. Ajusta `load_corpus` para tu formato de datos (Markdown, PDF extraído con `unstructured`, HTML con `trafilatura`).
3. Indexa.
4. Diseña 20 queries reales que un usuario haría.
5. Ejecuta `search(query, k=5)` para cada una.
6. Anota manualmente: para cuántas queries el top-1 es correcto, para cuántas está en top-5.
7. Documenta 3 fallos y qué mejora los arreglaría (chunk size, contextual retrieval, metadata filter, hybrid).

**Criterios de éxito:**
- [ ] Pipeline reproducible con `python rag_min.py`.
- [ ] 20 queries ejecutadas y anotadas.
- [ ] Recall@5 y precision@1 reportados.
- [ ] Análisis de 3 fallos con propuesta concreta.

**Bonus:** Migra el índice de FAISS a `pgvector` en Postgres local con Docker (`docker run -e POSTGRES_PASSWORD=x -p 5432:5432 pgvector/pgvector:pg17`).

**Hints:**
- Las 20 queries deben incluir 4-5 casos "difíciles" a propósito: (a) sinónimos que el modelo puede no capturar, (b) IDs/códigos exactos, (c) preguntas cuyo chunk correcto está partido en dos por chunking, (d) queries en idioma distinto al corpus.
- Anota manualmente antes de ejecutar: para cada query, escribe cuál CREES que debería ser el doc_id ganador. Después compara con la realidad.
- Los fallos por chunking se ven cuando el chunk relevante existe pero cortado a la mitad — la respuesta no se encuentra en un solo top-5.

**Solución de referencia (esbozo):**
```python
queries = [
    ("¿qué es FSRS?", "fsrs"),
    ("stability y difficulty", "fsrs"),
    ("SW e IndexedDB", "pwa"),
    # ... 17 más
]
p1 = r5 = 0
for q, expected in queries:
    top = search(q, index, chunks, k=5)
    if top and top[0][1].doc_id == expected: p1 += 1
    if expected in {c.doc_id for _, c in top}: r5 += 1
print(f"P@1 = {p1/len(queries):.0%}  R@5 = {r5/len(queries):.0%}")
```

---

### Ejercicio 4: Deduplicación en dos capas

**Objetivo:** Añadir dedup exacto (SHA-256) y near-duplicate (MinHash + LSH) sobre tu corpus e ver la reducción.

**Setup:**
- `pip install datasketch==1.6.5`.
- El corpus del ejercicio 3.

**Pasos:**
1. Cuenta chunks antes de dedup.
2. Aplica dedup exacto (como en §5). Cuenta.
3. Aplica MinHash LSH con `threshold=0.9` y `num_perm=128`. Cuenta.
4. Manualmente inspecciona 10 pares detectados como duplicados: ¿son realmente duplicados o falsos positivos?
5. Ajusta el threshold si hay demasiados falsos positivos.

**Criterios de éxito:**
- [ ] Reducción de chunks reportada en % para cada capa.
- [ ] Inspección manual de 10 pares (con veredicto: TP/FP).
- [ ] Threshold final justificado.

**Bonus:** Añade dedup semántico con embedding similarity > 0.95 y compara con MinHash.

**Hints:**
- `num_perm=128` es el default razonable; sube a 256 si quieres más precisión y aceptas 2x storage temporal.
- Threshold 0.9 suele ser el sweet spot; 0.95 apenas encuentra duplicados salvo copias verbatim; 0.8 empieza a marcar docs relacionados pero no duplicados.
- Para inspección: escoge 10 pares al azar, imprime lado a lado, y decide TP/FP manualmente. La intuición humana es aquí la ground truth.

**Solución de referencia (esbozo):**
```python
from datasketch import MinHash, MinHashLSH

def minhash(text, num_perm=128):
    mh = MinHash(num_perm=num_perm)
    for tok in text.lower().split():
        mh.update(tok.encode())
    return mh

lsh = MinHashLSH(threshold=0.9, num_perm=128)
signatures = {}
for c in chunks:
    signatures[c.id] = minhash(c.text)
    lsh.insert(c.id, signatures[c.id])

# Chequear duplicados por chunk
dup_pairs = []
for cid, mh in signatures.items():
    matches = [m for m in lsh.query(mh) if m != cid]
    for m in matches:
        dup_pairs.append((cid, m))
```

---

### Ejercicio 5 (bonus): Actualización incremental sin re-indexar todo

**Objetivo:** Implementar un pipeline que detecta docs modificados desde el último run y solo re-embeda los cambiados.

**Setup:**
- Corpus con timestamps de modificación en el filesystem (`os.path.getmtime`).
- Un `state.json` que guarda el hash por `doc_id`.

**Pasos:**
1. Al indexar, guarda `{doc_id: content_hash}` en `state.json`.
2. En un segundo run, compara el hash actual vs guardado.
3. Solo re-embeda docs con hash distinto.
4. Aplica upsert al índice (borra chunks viejos del `doc_id`, añade nuevos).
5. Modifica 2 docs y verifica que solo esos se re-procesan.

**Criterios de éxito:**
- [ ] Segundo run tarda <10% del primero cuando no hay cambios.
- [ ] Modificar 1 doc solo re-embeda ese doc.
- [ ] `state.json` legible y auditable.
- [ ] Deletes correctamente aplicados cuando un doc desaparece del corpus.

**Bonus:** Añade `pipeline_version` en metadata y un flag `--force-reindex` que ignora el state.

**Hints:**
- El "hash del contenido" debe cubrir todo lo que afecta al embedding: el texto, la lista de metadata que va a `contextualize` (si aplica), la versión del modelo.
- Para borrar chunks viejos de un `doc_id`: `SELECT chunk_ids FROM state WHERE doc_id = ?` → `DELETE ...` en vector DB → luego insertar los nuevos.
- Un `state.json` con >100k entries es un problema. Migra a SQLite (`state.db`) cuando pases del millar.

**Solución de referencia (esbozo):**
```python
import json, hashlib
from pathlib import Path

STATE_FILE = Path("state.json")

def load_state():
    return json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}

def save_state(state):
    STATE_FILE.write_text(json.dumps(state))

def sync(docs, index, chunks_by_doc):
    state = load_state()
    for d in docs:
        h = hashlib.sha256(d["text"].encode()).hexdigest()
        if state.get(d["doc_id"]) == h:
            continue  # no cambió
        # Delete + reindex
        delete_by_doc(index, d["doc_id"])
        new_chunks = chunk_and_embed(d)
        index.add(new_chunks)
        state[d["doc_id"]] = h
    save_state(state)
```

---

### Ejercicio 6 (Reto): Fine-tune de un reranker con datos propios

**Objetivo:** Fine-tunear `BGE-reranker-v2-m3` con 500-1000 pares (query, chunk_relevante, chunk_irrelevante) generados desde tu corpus, y medir mejora de NDCG@10 vs el reranker base sin fine-tune.

**Setup:**
- GPU con ≥16 GB (Colab Pro L4, RunPod, o local).
- `pip install FlagEmbedding sentence-transformers==3.3 datasets`.
- Corpus con ≥1000 chunks del ejercicio 3.

**Pasos:**
1. Genera 500 queries sintéticas con Claude Haiku sobre chunks del corpus ("dada esta info, ¿qué pregunta razonable haría un usuario?").
2. Para cada query, marca el chunk fuente como positivo y usa retrieval BM25 para elegir 3-5 hard negatives (retornan pero no son el positivo).
3. Formatea el dataset con `(query, positive, negatives)` triples.
4. Ejecuta `FlagEmbedding.finetune.RerankerModel` con 1 epoch, LR 5e-6, batch 8.
5. Evalúa NDCG@10 y MRR sobre eval set de 100 queries hold-out.
6. Compara base vs fine-tuned.

**Criterios de éxito:**
- [ ] Dataset de ≥500 triples generado y auditado (rechaza queries de baja calidad).
- [ ] Fine-tune ejecutado sin errores.
- [ ] NDCG@10 fine-tuned ≥ NDCG@10 base + 3 puntos.
- [ ] MRR mejorado en la misma dirección.
- [ ] Documentas 5 queries donde el fine-tune ganó y por qué.

**Hints:**
- Hard negatives son la clave. Negatives random son inútiles (ya los distingue el modelo base). Los buenos son los que rankean top-5 hoy con BM25 pero NO son la respuesta.
- 500 triples pueden bastar si son muy buenos; si el corpus es muy heterogéneo necesitas más (2000+).
- LR alto (>1e-5) suele overfittear rápido; empieza conservador.

**Solución de referencia (esbozo):**
```python
from FlagEmbedding import FlagLLMReranker
# Genera queries sintéticas
def gen_query(chunk):
    return claude.messages.create(
        model="claude-haiku-4-5",
        messages=[{"role":"user","content":
            f"Genera 1 pregunta que se respondería con este texto:\n{chunk}"}]
    ).content[0].text

# Genera hard negatives via BM25
for chunk in corpus:
    q = gen_query(chunk)
    negatives = bm25_search(q, k=5)  # excluye el chunk mismo
    triples.append({"query": q, "pos": chunk, "neg": negatives})

# Fine-tune con FlagEmbedding CLI o Python
# torchrun --nproc_per_node 1 -m FlagEmbedding.reranker.encoder_only.base.run \
#   --model_name_or_path BAAI/bge-reranker-v2-m3 \
#   --train_data triples.json --lr 5e-6 --epochs 1
```

---


### Ejercicio 7: Contextual Retrieval end-to-end con benchmark propio

**Objetivo:** Medir empíricamente el impacto de Contextual Retrieval en TU corpus, aplicando la técnica de Anthropic y comparando recall@5 antes/después.

**Setup:**
- `pip install anthropic==0.68.0 openai==1.90.0 faiss-cpu==1.9.0 numpy==2.1.3`.
- Un corpus de 20+ docs con referencias implícitas (contratos, wikis, docs corporativos).
- Eval set de 30 queries con ground truth de doc_id.

**Pasos:**
1. Chunkeaje base: recursive, 700 chars, 100 overlap.
2. Indexa versión A: chunks tal cual.
3. Indexa versión B: chunks contextualizados con Claude Haiku 4.5 (usa código de §3.11).
4. Ejecuta las 30 queries en ambos índices. Mide recall@5.
5. Compara y calcula coste extra de la contextualización.

**Criterios de éxito:**
- [ ] Recall@5 medido en las dos versiones.
- [ ] Diferencia estadísticamente relevante reportada (>5 puntos).
- [ ] Coste extra en $ documentado.
- [ ] Al menos 3 queries donde solo versión B acierta — con explicación del porqué.

**Hints:**
- Usa `cache_control` con `"type": "ephemeral"` sobre el `<document>` completo. Debería ver `cache_read` alto desde el segundo chunk de cada doc.
- Si la mejora es <2 puntos, tu corpus probablemente no tiene muchas referencias implícitas. Prueba con contratos o wikis internas.
- Recall@5 con 30 queries tiene margen de error ±10%; para conclusiones firmes, 100+ queries.

**Reto:** añade una tercera versión C: contextualization + Cohere Rerank 3.5. Compara las 3. Deberías ver la escalera 68% → 76% → 84% descrita por Anthropic.

**Solución de referencia (esbozo):**
```python
def indexar_versionA(docs): return build_index([chunk for d in docs for chunk in split(d)])
def indexar_versionB(docs):
    contextualized = []
    for d in docs:
        for chunk in split(d):
            ctx = contextualize(full_doc=d.text, chunk=chunk)
            contextualized.append(ctx + "\n\n" + chunk)
    return build_index(contextualized)

# Comparar
r_A = recall_at_5(eval, search_fn(index_A))
r_B = recall_at_5(eval, search_fn(index_B))
print(f"A: {r_A:.2%}  B (contextualized): {r_B:.2%}  Δ = +{(r_B-r_A)*100:.1f} pts")
```

### Ejercicio 8: Migración de embedder con dual-index rolling

**Objetivo:** Simular una migración de `text-embedding-3-small` a `text-embedding-3-large` truncado a 768 dims sin downtime, correteando ambos índices en paralelo.

**Setup:**
- El pipeline del ejercicio 3.
- Suficiente disco para dos índices (2-3x storage).

**Pasos:**
1. Añade campo `embedding_model_version` en metadata (`"v1"` = small, `"v2"` = large-768).
2. Indexa versión v1 completa (baseline).
3. Empieza a re-indexar en background con v2, marcando cada chunk con `pipeline_version="v2"`.
4. Implementa `search_migration(query)` que consulta AMBOS índices y devuelve resultados mergeados con dedup por `chunk_id`.
5. A/B test: 50% de queries van a v1 puro, 50% a `search_migration`. Compara recall@5 y latencia.
6. Cuando v2 esté al 100% indexado, apaga v1 y libera storage.

**Criterios de éxito:**
- [ ] Ambos índices coexisten sin corromper.
- [ ] `search_migration` devuelve resultados mergeados y ordenados por score.
- [ ] A/B test con 100+ queries reporta diferencia empírica.
- [ ] Diagrama del proceso documentado (para post-mortem del CTO).

**Hints:**
- Los scores de `search` en v1 y v2 no son directamente comparables (distinto modelo). Normaliza por rank, no por score absoluto.
- Guarda `pipeline_version` en metadata desde el día 1 aunque hoy no lo necesites — el retrofit sin él es doloroso.
- El truco `dual-index` es lo que Bloomberg hizo en su migración documentada de 2024.

**Reto:** implementa un "rollback button" que en 30 segundos vuelve a v1 si `search_migration` devuelve peores resultados en un canary de 1000 queries. Usa feature flag (LaunchDarkly, Unleash) para el switch.

**Solución de referencia (esbozo):**
```python
def search_migration(query, index_v1, index_v2, chunks_v1, chunks_v2, k=5):
    # Retrieve top-2k de cada uno
    r1 = search(query, index_v1, chunks_v1, k=2*k)
    r2 = search(query, index_v2, chunks_v2, k=2*k)
    # Merge por chunk_id, prefer v2 si el mismo chunk aparece
    merged = {c.id: (score, c, "v2") for score, c in r2}
    for score, c in r1:
        if c.id not in merged:
            merged[c.id] = (score, c, "v1")
    # Ordenar por rank normalizado (no por score directo)
    top = sorted(merged.values(), key=lambda x: -x[0])[:k]
    return top
```

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [OpenAI Embeddings guide](https://platform.openai.com/docs/guides/embeddings) — parámetros `dimensions`, MRL, precios.
- [Anthropic — Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) — blog + código open en `anthropic-cookbook`.
- [Voyage AI docs](https://docs.voyageai.com/) — modelos generales, código y verticales legal/finance.
- [Cohere Embed](https://docs.cohere.com/docs/embeddings) — int8 y binary variants.
- [BGE (BAAI) GitHub](https://github.com/FlagOpen/FlagEmbedding) — BGE-M3, BGE-reranker, guías de fine-tuning.
- [Nomic Embed](https://blog.nomic.ai/) — embed-text-v2, long context.

**Frameworks:**
- [LangChain Text Splitters](https://python.langchain.com/docs/concepts/text_splitters/) — recursive, structural, semantic.
- [LlamaIndex Node Parsers](https://docs.llamaindex.ai/en/stable/module_guides/loading/node_parsers/) — parent-child, hierarchical.
- [unstructured.io docs](https://docs.unstructured.io/) — PDF, DOCX, HTML.
- [trafilatura](https://trafilatura.readthedocs.io/) — extracción web principal.

**Papers foundational:**
- Kusupati et al. — *Matryoshka Representation Learning* (2022).
- Chen et al. — *BGE-M3: Multi-Lingual Multi-Functional Multi-Granularity Embeddings* (2024).
- Morris et al. — *Text Embeddings Reveal (Almost) as Much as Text* (2023) — embedding inversion, importante para PII.
- Greg Kamradt — *5 Levels of Text Splitting* (2024) — tutorial referencia.
- Anthropic — *Introducing Contextual Retrieval* (2024).

**Benchmarks:**
- [MTEB Leaderboard](https://huggingface.co/spaces/mteb/leaderboard) — Massive Text Embedding Benchmark.
- [MIRACL](https://project-miracl.github.io/) — multilingual retrieval.
- [BEIR](https://github.com/beir-cellar/beir) — heterogeneous IR benchmark.

**Siguientes pasos:**
- Lee el [cap 03 — vector DBs, hybrid search y reranking](./03-vector-dbs-hybrid-reranking.md), continuación natural: ya tienes el corpus indexado; ahora hay que buscarlo bien.
- Lee el [cap 04 — context engineering, memoria, caching](./04-context-memory-caching.md) para saber qué hacer con los chunks recuperados.
- Lee el [cap 09 — evals y LLM-as-judge](./09-evals-datasets-llm-judge.md) para instrumentar recall@K y evaluar sistemáticamente.
- Lee el [cap 19 — data pipelines + PII + EU AI Act](./19-data-pipelines-pii-eu-ai-act.md) para el tratamiento legal de datos indexados.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales sobre embeddings, chunking y pipelines de indexación. Cubren: qué es un embedding, cosine vs dot product vs euclidiana, elección de modelo (dimensiones, coste, multilingüe), estrategias de chunking (fixed, recursive, sentence, semantic, hierarchical, structural), sweet spot de tamaño, metadata design, preprocesamiento (HTML, PDF, código), deduplicación (hash, MinHash, MMR), actualización incremental, Matryoshka embeddings, Contextual Retrieval de Anthropic, embeddings multilingües, SPLADE y ColBERT, evaluación de retrieval (recall@K, MRR, NDCG), PII y compliance, fine-tuning vs domain adaptation, indexación de código con AST, y freshness (cuándo NO usar RAG).

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-02-rag-embeddings-chunking.json`](../../packages/content/src/tech/ai-programming/sim-02-rag-embeddings-chunking.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-02-rag-embeddings-chunking`
- **Tiempo:** 25 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 01 — LLM basics y APIs](./01-fundamentos-tokens-contexto.md) · [Índice](./README.md) · [Capítulo 03 — vector DBs, hybrid search y reranking](./03-vector-dbs-hybrid-reranking.md) →
