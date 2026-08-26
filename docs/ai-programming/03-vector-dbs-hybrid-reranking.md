# Capítulo 03 — RAG parte 2: vector DBs, hybrid search y reranking

> **Focus:** Cómo elegir vector DB en 2026, dominar HNSW, combinar dense + BM25 con RRF, aplicar rerankers cross-encoder, y evaluar retrieval con recall@K, MRR y NDCG. La segunda mitad del pipeline RAG.
> **Áreas:** Context Engineering · Retrieval · Cost & Inference
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Haber leído el [cap 02 — embeddings y chunking](./02-rag-embeddings-chunking.md). Sabes qué es un embedding, cómo chunkear y por qué la metadata importa.
- Docker instalado (usaremos pgvector y opcionalmente Qdrant en local).
- Python 3.11+ con `psycopg[binary]`, `openai`, `cohere` (opcional para reranking).
- SQL básico (`CREATE TABLE`, `SELECT`, índices).
- Nociones de complejidad algorítmica (`O(log N)` vs `O(N)`).

**Glosario mínimo:**
- **Vector DB** — base de datos especializada en almacenar y buscar vectores por similitud. Pinecone, Qdrant, Weaviate, Milvus, pgvector, Chroma, LanceDB.
- **ANN (Approximate Nearest Neighbor)** — algoritmo que encuentra los k vecinos más cercanos de forma aproximada pero rápida, en vez de exhaustivo (`O(N)`).
- **HNSW (Hierarchical Navigable Small World)** — grafo multi-capa donde cada nodo conecta con vecinos aproximados; búsqueda greedy `O(log N)`. Default de facto en 2026.
- **IVF (Inverted File)** — divide el espacio en clusters con k-means; busca en los top-nprobe clusters. Menos memoria, más lento.
- **BM25** — función de ranking probabilística (extensión de TF-IDF) para retrieval léxico. Sin modelo neural. Muy robusta.
- **Hybrid search** — combinar dense (semántica) + sparse (BM25/SPLADE) para cubrir lo que uno pierde.
- **RRF (Reciprocal Rank Fusion)** — fórmula para combinar rankings sin normalizar scores: `score = Σ 1/(k + rank_i)`. Robusta y parameter-light.
- **Bi-encoder** — codifica query y doc por separado; similitud sobre vectores pre-computados. Rápido, escala.
- **Cross-encoder / reranker** — puntúa el par `(query, doc)` con atención cruzada. Preciso, lento; se usa sobre pocos candidatos.
- **MMR (Maximal Marginal Relevance)** — reordena resultados balanceando relevancia y diversidad.
- **Quantization** — comprimir vectores (`int8`, `binary`) para reducir memoria/storage a cambio de recall.

**Setup:**

```bash
# 1. Postgres con pgvector 0.8+ (HNSW + binary quantization)
docker run -d --name pg \
  -e POSTGRES_PASSWORD=secret -p 5432:5432 \
  pgvector/pgvector:pg17

# 2. Qdrant local (opcional)
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant:v1.13.0

# 3. Python deps
pip install psycopg[binary]==3.2.3 pgvector==0.3.6 \
            openai==1.60.0 cohere==5.13.0 \
            rank-bm25==0.2.2 numpy==2.1.3

export OPENAI_API_KEY="sk-..."
export COHERE_API_KEY="..."       # opcional, para reranker
```

---

## 1. El gran cuadro

En el [cap 02](./02-rag-embeddings-chunking.md) construimos el índice: corpus → chunks → embeddings → guardado. Ahora empieza la parte online, la que ve el usuario en cada request y donde la latencia se paga en experiencia. Este capítulo cubre las cuatro decisiones que dominan la calidad y el coste del retrieval en producción: **elegir vector DB**, **configurar el índice** (HNSW vs IVF, parámetros), **combinar dense con BM25** (hybrid) y **rerankear** con cross-encoder para exprimir precisión.

El paisaje de vector DBs en 2026 se ha estabilizado en cinco perfiles. **pgvector** (Postgres extension 0.8+ con HNSW y binary quantization) domina en stacks que ya tienen Postgres — es la respuesta correcta para el 60% de startups. **Pinecone Serverless** brilla en multi-tenant a escala con namespaces y factura por operación. **Qdrant** ofrece open source con cloud, filtered HNSW muy bueno, sparse + dense + ColBERT en el mismo índice. **Weaviate** aporta multi-tenancy nativa y GraphQL. **Milvus/Zilliz** son enterprise a escala masiva (billones de vectores). Y hay nichos: **LanceDB** (embedded on-disk sin servidor), **Chroma** (dev-friendly), **Turbopuffer** (serverless barato), **Vespa** (Yahoo, potente para search complejo con dense+sparse+ColBERT).

La segunda gran palanca es el **algoritmo de índice**. HNSW ganó la batalla por defecto: recall excelente, latencia baja, inserts online. IVF (con Product Quantization) sigue teniendo lugar en escala 100M+ vectores donde la memoria de HNSW se vuelve prohibitiva. Los parámetros importan: `M`, `ef_construction`, `ef_search` en HNSW; `nlist`, `nprobe` en IVF. No confíes en los defaults sin medir.

La tercera palanca es **hybrid search**. Los dense embeddings capturan semántica pero fallan en exact match: buscar "CVE-2024-3094" recupera chunks genéricos sobre security en vez del documento que contiene el string exacto. BM25 (o SPLADE, aprendido y neural) cubre ese hueco. La fusión canónica es **Reciprocal Rank Fusion (RRF)**: `score = Σ 1/(k + rank_i(doc))` con `k=60`. Es *the boring choice* que gana casi siempre.

La cuarta palanca es **reranking**. Un bi-encoder es rápido pero grueso; devuelve top-50 en 10-100ms. Un cross-encoder (Cohere Rerank 3.5, Voyage rerank-2.5, BGE-reranker-v2-m3, Jina Reranker v2) puntúa cada par `(query, chunk)` con atención cruzada — mucho más preciso pero lento (500-800ms para top-50). El pipeline moderno estándar: **retrieve top-50 hybrid → rerank → top-5 al LLM**. Anthropic Contextual Retrieval (sept 2024) mostró que este pipeline combinado reduce retrieval failure rate del 5.7% al 1.9% (-67% vs baseline).

El objetivo del capítulo es que salgas sabiendo montar el retrieval end-to-end de un RAG serio: pgvector con HNSW, filtered search por metadata, hybrid con BM25 + RRF, rerank con Cohere, evaluación con recall@K y MRR. Y saber cuándo *no* aplica RAG — porque meterlo en todo es antipatrón.

---

## 2. Fundamentos (nivel básico)

### 2.1 ¿Qué necesitas de una vector DB?

Cuatro capacidades mínimas:

1. **Búsqueda ANN por similitud** con cosine / dot / euclidean.
2. **Filtrado por metadata** (`WHERE tenant_id = ? AND updated_at > ?`) idealmente integrado con la búsqueda (filtered HNSW), no post-processing.
3. **Upserts y deletes** por ID para actualización incremental.
4. **Persistencia y backups** — es una base de datos, no un cache.

Extras que separan a las buenas de las excelentes:
- **Namespaces / multi-tenancy nativa** (Pinecone, Weaviate MT, Qdrant collections).
- **Sparse vectors** y hybrid nativo (Qdrant, Weaviate, Pinecone sparse-dense, pgvector + tsvector).
- **Quantization** (`int8`, `binary`) para reducir memoria (Qdrant, Milvus, Weaviate, pgvector 0.7+).
- **Late interaction** ColBERT (Qdrant, Vespa).

### 2.2 Elegir vector DB: el algoritmo de decisión

| Situación | Recomendación |
|---|---|
| Startup seed, <1M chunks, Postgres ya en stack | **pgvector** |
| Multi-tenant SaaS a escala, quieres serverless | **Pinecone Serverless** |
| Necesitas hybrid + sparse + ColBERT en el mismo índice | **Qdrant** |
| Prototipo local sin servidor | **Chroma** o **LanceDB** |
| >100M vectores, presupuesto para ops | **Milvus / Zilliz** |
| Ya tienes Elasticsearch y quieres añadir dense | **Elasticsearch 8.x** |
| Búsqueda muy compleja (dense + sparse + rank fns custom) | **Vespa** |

Regla YAGNI: **empieza con lo que ya tienes**. Pinecone es excelente pero introduce lock-in y coste fijo mensual. pgvector con HNSW aguanta millones de vectores con tuning apropiado.

### 2.3 HNSW en 2 minutos

HNSW (Malkov & Yashunin 2016) construye un **grafo multi-capa** donde:
- La capa más alta tiene pocos nodos, muy conectados: entrada rápida.
- Cada capa inferior es más densa: refinamiento.
- Búsqueda greedy: entra por arriba, baja por conexiones prometedoras hasta la capa 0.

**Analogía útil:** piensa en HNSW como un mapa jerárquico tipo Google Maps con distintos niveles de zoom. En zoom muy bajo (capa superior) ves pocas ciudades gigantes conectadas por autopistas: en 3 saltos llegas a cualquier región. Bajas un nivel de zoom (capa intermedia) y ves ciudades medianas conectadas por carreteras nacionales. Al final aterrizas en zoom máximo (capa 0) donde ves calles y llegas al destino exacto. La búsqueda greedy es "salta a la ciudad más cercana en cada zoom hasta que no puedas acercarte más". Esto convierte un `O(N)` (revisar todos los puntos) en `O(log N)` (revisar solo un camino).

Diagrama del grafo HNSW:

```
       Capa 2 (top, muy escasa)
   ┌───o─────────o─────────o───┐    Búsqueda: entra aquí
   │   │         │         │   │    salta al nodo más cercano
   │   │         │         │   │
       ▼         ▼         ▼
       Capa 1 (media)
   ┌─o─o─o───o─o─o───o─o─o─┐        Refina: baja al vecino
   │ │ │ │   │ │ │   │ │ │ │        más prometedor
       ▼ ▼ ▼   ▼ ▼ ▼   ▼ ▼ ▼
       Capa 0 (densa, todos los vecinos)
   o─o─o─o─o─o─o─o─o─o─o─o─o        Encuentra top-K exactos
   │ │ │ │ │ │ │ │ │ │ │ │ │        dentro del ef_search
```

Parámetros:
- **`M`** — conexiones por nodo en la capa 0. Rango típico 8-64; sweet spot 16-32. Más = mejor recall + más memoria.
- **`ef_construction`** — candidatos evaluados al construir. Rango 100-400. Más = mejor grafo, build más lento.
- **`ef_search`** — candidatos evaluados en query. Rango 40-500. **Se puede cambiar por query sin re-construir** — es tu knob de tuning.

Ejemplo en pgvector:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
    id BIGSERIAL PRIMARY KEY,
    doc_id TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding vector(1536) NOT NULL,
    metadata JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX chunks_hnsw_idx
    ON chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

CREATE INDEX chunks_meta_idx ON chunks USING GIN (metadata);

-- En query time (por sesión, no persistente)
SET hnsw.ef_search = 100;

SELECT id, text, 1 - (embedding <=> $1) AS score
FROM chunks
WHERE metadata->>'tenant_id' = 'acme'
  AND updated_at > NOW() - INTERVAL '90 days'
ORDER BY embedding <=> $1
LIMIT 10;
```

`<=>` es el operador de distancia coseno en pgvector; `1 - dist` te da similitud en `[0, 1]`.

**Mini-ejemplo — buscar en pgvector desde Python en 15 líneas:**

```python
import psycopg
from pgvector.psycopg import register_vector
import numpy as np

def buscar_pgvector(dsn: str, query_vec: np.ndarray, tenant: str, k: int = 5):
    with psycopg.connect(dsn) as conn:
        register_vector(conn)
        with conn.cursor() as cur:
            cur.execute("SET LOCAL hnsw.ef_search = 100")
            cur.execute("""
                SELECT id, text, 1 - (embedding <=> %s) AS sim
                FROM chunks
                WHERE metadata->>'tenant_id' = %s
                ORDER BY embedding <=> %s
                LIMIT %s
            """, (query_vec, tenant, query_vec, k))
            return cur.fetchall()
```

Nota clave: `SET LOCAL hnsw.ef_search` cambia el parámetro solo para esta transacción. En producción, un pool con `application_name` distinto por endpoint permite tener `ef_search` alto para queries críticas y bajo para autocompletado.

### 2.4 BM25 en 2 minutos

BM25 (Robertson & Zaragoza 2009) es una fórmula probabilística que puntúa `(query, doc)` en base a:
- **TF** (term frequency): cuántas veces aparece el término en el doc, saturado por parámetro `k1`.
- **IDF** (inverse doc frequency): términos raros pesan más.
- **Normalización de longitud** por parámetro `b`.

Es rápida, sin modelo neural, sin training, muy robusta, y sigue siendo baseline duro de batir. Todas las vector DBs modernas la soportan (algunas nativa, otras vía Elasticsearch/Opensearch/tsvector).

Ejemplo simple en Python con `rank-bm25`:

```python
from rank_bm25 import BM25Okapi

corpus = [
    "El motor FSRS-6 ajusta stability y difficulty por tarjeta.",
    "La PWA usa Service Worker e IndexedDB para offline.",
    "El backend serverless corre en AWS Lambda.",
]
tokenized = [doc.lower().split() for doc in corpus]
bm25 = BM25Okapi(tokenized)

query = "repetición espaciada".split()
scores = bm25.get_scores(query)   # array de scores por doc
```

BM25 recupera bien tokens exactos, IDs, siglas, nombres propios. Es lo que salva a los embeddings cuando el usuario pregunta por "CVE-2024-3094" o "SKU-99881".

**Analogía útil:** BM25 es como buscar en el índice alfabético de un libro. Sabes exactamente qué palabra buscar, y el índice te dice en qué páginas aparece con qué frecuencia. Es tonto pero preciso: si el término existe en el corpus, lo encuentras. Los embeddings son como preguntarle a un bibliotecario que ha leído todos los libros: entiende sinónimos y contexto, pero puede olvidar dónde vio exactamente ese código de barras.

**Mini-ejemplo — desglose paso a paso de la fórmula BM25:**

```python
import math
from collections import Counter

def bm25_score(query: list[str], doc: list[str], corpus: list[list[str]], k1=1.5, b=0.75):
    N = len(corpus)
    avg_dl = sum(len(d) for d in corpus) / N
    dl = len(doc)
    doc_tf = Counter(doc)
    score = 0.0
    for term in query:
        # DF: en cuántos docs aparece el term
        df = sum(1 for d in corpus if term in d)
        # IDF: términos raros pesan más
        idf = math.log((N - df + 0.5) / (df + 0.5) + 1)
        # TF saturado: 3 apariciones no valen 3x que 1
        tf = doc_tf.get(term, 0)
        tf_component = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avg_dl))
        score += idf * tf_component
    return score

# Ejemplo trivial
corpus = [
    "el gato come pescado".split(),
    "el perro come carne".split(),
    "el gato duerme mucho".split(),
]
q = "gato pescado".split()
for i, d in enumerate(corpus):
    print(f"doc[{i}] score = {bm25_score(q, d, corpus):.3f}")
# doc[0] score = ~1.4  (contiene ambos términos)
# doc[2] score = ~0.5  (solo "gato")
# doc[1] score = ~0.0  (ninguno)
```

Los parámetros por defecto (`k1=1.5`, `b=0.75`) son universales y rara vez merecen tuning. `k1` controla saturación de TF (subirlo penaliza menos repetición); `b` controla normalización de longitud (0 = ignorar longitud, 1 = normalizar por completo).

### 2.5 Hybrid = dense + sparse fusionados con RRF

Los dos rankings (dense y BM25) tienen escalas distintas (cosine `[-1, 1]`, BM25 `0-30+`). Sumarlos crudos hace que uno domine. **RRF** los combina usando solo el rank posicional:

```python
def reciprocal_rank_fusion(rankings: list[list[str]], k: int = 60) -> list[tuple[str, float]]:
    """rankings = lista de listas de doc_ids ordenadas por relevancia (mejor primero)."""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)
```

Uso:
```python
dense_ranking = ["doc42", "doc7", "doc19"]       # top-K de vector search
bm25_ranking  = ["doc19", "doc42", "doc55"]      # top-K de BM25
fused = reciprocal_rank_fusion([dense_ranking, bm25_ranking])
```

Ventajas: parameter-free (solo `k`, robusto), invariante a escalas, gana en benchmarks (Cormack et al. 2009). Es el default de Elasticsearch 8.8+, Weaviate, Vespa y de la mayoría de la literatura reciente.

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 HNSW vs IVF: cuándo elegir cada uno

| Aspecto | HNSW | IVF (con PQ) |
|---|---|---|
| Recall | Muy alto | Alto (dependiente de nprobe) |
| Latencia | Baja, estable | Media |
| Memoria | Alta (grafo en RAM) | Menor (con PQ) |
| Build time | Alto | Medio (requiere k-means training) |
| Updates | Online (append al grafo) | Requiere re-training periódico |
| Escalado | <100M vectores | 100M-10B vectores |

Regla 2026: HNSW es el default correcto en el 90% de casos. IVF-PQ solo si tienes >100M vectores y la RAM de HNSW no cabe en el nodo. Todas las vector DBs modernas usan HNSW por defecto.

### 3.2 Parámetros HNSW: ganancias con retornos decrecientes

Ejemplo empírico sobre 5M vectores de 1536 dims:

| M | ef_construction | ef_search | Recall@10 | Memoria overhead | Build time | Latencia P50 query | Latencia P95 |
|---|---|---|---|---|---|---|---|
| 8 | 100 | 40 | 89% | 320 MB | 12 min | 2.1 ms | 5.4 ms |
| 16 | 100 | 40 | 92% | 640 MB | 20 min | 2.6 ms | 6.0 ms |
| 16 | 200 | 100 | 96% | 640 MB | 45 min | 4.2 ms | 9.0 ms |
| 32 | 200 | 100 | 97% | 1.3 GB | 90 min | 5.8 ms | 12 ms |
| 32 | 400 | 200 | 98% | 1.3 GB | 3 h | 9.5 ms | 22 ms |
| 64 | 500 | 500 | 98.5% | 2.5 GB | 3-5 h | 18 ms | 45 ms |

Sweet spot típico: **M=16-32, ef_construction=200**. `ef_search` es tu knob dinámico — súbelo (100-500) para queries críticas, bájalo (40-80) para queries triviales.

Nota importante: `ef_search` MUY alto no mejora recall más allá del techo del grafo. Si con `ef_search=500` sigues perdiendo recall vs exhaustivo, el problema está en `M`/`ef_construction`, no en `ef_search`. Reconstruye con parámetros más altos.

**Bajo el capó — por qué HNSW funciona:**

El truco matemático de HNSW es una propiedad probabilística de los grafos "small-world" (mundo pequeño). En un grafo aleatorio con `N` nodos, si cada nodo tiene `k` conexiones bien elegidas, la distancia media entre dos nodos cualesquiera es `O(log_k N)`. Es el mismo principio que "seis grados de separación": con solo 5-6 saltos puedes conectar dos personas cualesquiera del planeta.

HNSW añade dos ideas sobre esto:
1. **Multi-capa jerárquica:** cada nodo se asigna aleatoriamente a una capa `l ∼ Geometric(1/M)`. Las capas altas son escasas (pocos nodos), las bajas densas. Esto crea "autopistas" en capas altas para saltos largos, y "calles" en capas bajas para refinamiento local. Sin esto, el grafo tendría demasiadas búsquedas en zonas locales.
2. **Vecinos heurísticos, no k-NN puros:** al insertar un nodo, no se conecta simplemente a sus `M` vecinos más cercanos. Se aplica una heurística que garantiza diversidad: prefiere conectarse a vecinos que representan direcciones distintas del espacio. Esto evita "clústers cerrados" donde la búsqueda se queda atrapada.

La consecuencia práctica: `M` alto mejora recall porque hay más caminos posibles pero cuesta memoria (O(M) por nodo). `ef_construction` alto durante el build mejora la calidad del grafo pero no afecta memoria final. `ef_search` en query controla cuántos candidatos se mantienen en la cola prioritaria: cero coste en memoria, todo en latencia.

Comparado con IVF (que particiona el espacio en clusters y busca en `nprobe` de ellos), HNSW no necesita re-training cuando insertas datos nuevos — solo añades el nodo al grafo. Por eso IVF pierde en workloads con updates continuos y HNSW ganó como default.

### 3.3 Filtered search: pre, post e integrado

**Post-filtering (el bug clásico):**
```python
# MAL: retrieve top-100 global, filtra en la app
results = index.search(query_vec, k=100)
filtered = [r for r in results if r.metadata["tenant_id"] == "acme"]
top_k = filtered[:5]      # quizá solo hay 2 relevantes
```

Si el filtro es restrictivo (tenant con 0.1% de los docs), el top-100 global casi no contiene chunks del tenant y `top_k` queda pobre.

**Pre-filtering (brute force):**
```python
# Solo eficiente si el subset es pequeño
subset = [c for c in all_chunks if c.metadata["tenant_id"] == "acme"]
top_k = exact_search(subset, query_vec, k=5)
```

**Integrated (filtered HNSW) — la solución moderna:**
```sql
-- pgvector 0.7+, Qdrant, Weaviate, Pinecone
SELECT id, text FROM chunks
WHERE metadata->>'tenant_id' = 'acme'
  AND updated_at > '2025-01-01'
ORDER BY embedding <=> $1
LIMIT 5;
```

El índice HNSW explora dinámicamente el grafo hasta encontrar top-K que pasan el filtro. Weaviate lo tiene desde 2022, Qdrant siempre, Pinecone lo soporta, pgvector desde 0.7. Es la respuesta correcta para multi-tenancy y filtros estructurados.

### 3.4 Reranking: por qué mejora tanto

Un **bi-encoder** produce embeddings pre-computables e indexables. Es rápido (10-100ms para top-50 sobre millones) pero grueso: los top-50 contienen los correctos pero mezclados con ruido.

Un **cross-encoder** toma `[CLS] query [SEP] doc [SEP]` y ejecuta atención cruzada completa entre todos los tokens. Produce un score directo. Es preciso pero lento: cada par requiere un forward pass, así que no se puede pre-computar. Sobre top-50 es viable (~500ms); sobre 10M imposible.

El pipeline canónico:

```
Query → Embed → Vector search (top-50 en 50ms)
           ↓
        BM25 (top-50 en 20ms)
           ↓
        RRF fusion (top-50)
           ↓
        Cross-encoder rerank (top-50 → scored en 500ms)
           ↓
        Top-5-10 al LLM
```

Rerankers 2026 relevantes:

| Reranker | Provider | Multi-lingüe | Notas |
|---|---|---|---|
| **Cohere Rerank 3.5** | Cohere API | Sí (100+) | Calidad top comercial, refresco 2024 |
| **Voyage rerank-2.5** | Voyage API | Sí | Comercial, ligero (`rerank-2.5-lite`) |
| **BGE-reranker-v2-m3** | Open (HF) | Sí | Multi-lingüe, self-host viable |
| **Jina Reranker v2** | Open + API | Sí | Ligero, buen balance |
| **mxbai-rerank** | Open (HF) | Solo EN | Alternativa open competitiva |

Ejemplo con Cohere:

```python
import cohere

co = cohere.Client()

def rerank(query: str, docs: list[str], top_k: int = 5) -> list[tuple[int, float]]:
    resp = co.rerank(
        model="rerank-english-v3.0",     # o "rerank-multilingual-v3.0"
        query=query,
        documents=docs,
        top_n=top_k,
    )
    return [(r.index, r.relevance_score) for r in resp.results]
```

Ganancias publicadas: Anthropic Contextual Retrieval (2024) mostró que añadir rerank al pipeline hybrid + contextual llevó failure rate de 3.7% a 1.9% (-49% adicional). En muchos benchmarks el reranker sube recall@5 entre 10 y 25 puntos.

### 3.5 Query expansion, rewriting y HyDE

Queries cortas ("refund policy?") retornan pocos resultados. Tres técnicas:

**Query expansion:** el LLM genera N variantes del query, retrieve en paralelo, RRF.

```python
def expand_query(query: str, llm) -> list[str]:
    prompt = f"""Da 3 reformulaciones diversas de este query:
Query: {query}
Reformulaciones:"""
    resp = llm.chat.completions.create(model="gpt-4o-mini",
        messages=[{"role":"user","content":prompt}])
    return [line.strip("- ").strip() for line in resp.choices[0].message.content.split("\n") if line.strip()]
```

**Query rewriting:** el LLM reformula con contexto de conversación previa. Crítico en chats multi-turno.

**HyDE (Hypothetical Document Embeddings, Gao et al. 2022):** el LLM genera una respuesta ficticia detallada al query, embed esa (más rica), search.

```python
def hyde_search(query: str, llm, embed_fn, index):
    hypothetical = llm.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role":"user","content":f"Escribe un párrafo respondiendo: {query}"}]
    ).choices[0].message.content
    vec = embed_fn(hypothetical)
    return index.search(vec, k=10)
```

Trade-off: HyDE añade una LLM call (~500ms + coste). Funciona bien en algunos dominios donde el modelo "sabe" aproximar; alucina en otros. Bench en tu dataset.

### 3.6 MMR: reordenar por diversidad

Cuando el top-10 tiene 7 chunks casi idénticos (por ejemplo, 7 versiones del mismo doc), MMR reordena:

```
MMR = argmax_d [λ · sim(query, d) - (1-λ) · max_{d' ∈ selected} sim(d, d')]
```

Con `λ=0.5-0.7` balancea relevancia y diversidad. Está en LangChain (`max_marginal_relevance_search`), LlamaIndex (`MMRPostprocessor`) y Haystack. No sustituye al dedup en ingesta (que baja carga) — se complementan.

### 3.7 Evaluación: recall@K, MRR, NDCG

Métricas para separar señal de ruido en iteración:

- **Recall@K:** ¿al menos un chunk relevante está en top-K? (binaria por query, luego se promedia)
- **Precision@K:** % de chunks en top-K que son relevantes.
- **MRR (Mean Reciprocal Rank):** `1/rank` del primer relevante, promediado. Captura orden.
- **NDCG (Normalized Discounted Cumulative Gain):** métrica con relevance graded (no binaria); recompensa poner los MÁS relevantes primero.
- **Hit rate:** any-relevant en top-K.

Ejemplo mínimo:

```python
def recall_at_k(eval_set: list[dict], search_fn, k: int) -> float:
    hits = 0
    for item in eval_set:                 # {"query": "...", "gt_ids": {"chunk-42"}}
        results = search_fn(item["query"], k=k)
        result_ids = {r.id for r in results}
        if result_ids & item["gt_ids"]:
            hits += 1
    return hits / len(eval_set)

def mrr(eval_set, search_fn, k):
    total = 0.0
    for item in eval_set:
        results = search_fn(item["query"], k=k)
        for rank, r in enumerate(results, start=1):
            if r.id in item["gt_ids"]:
                total += 1.0 / rank
                break
    return total / len(eval_set)
```

Herramientas 2026: **Ragas**, **TruLens**, **DeepEval**, **Langfuse**, **Braintrust**, **Arize Phoenix**. Todas exponen métricas de retrieval separadas de generación, cosa crítica para debuggear en qué capa está el fallo.

### 3.8 Bajo el capó: comparativa de estrategias de fusion

RRF es el default recomendado, pero conviene entender las alternativas y por qué RRF gana en la mayoría de casos. Aquí una implementación de tres estrategias comparadas:

```python
def fusion_rrf(rankings: list[list[str]], k: int = 60) -> dict[str, float]:
    """Reciprocal Rank Fusion. Ignora scores, usa solo posición."""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return scores

def fusion_weighted_sum(
    rankings_with_scores: list[list[tuple[str, float]]],
    weights: list[float],
) -> dict[str, float]:
    """Weighted sum de scores normalizados a [0,1] con min-max scaling."""
    combined: dict[str, float] = {}
    for ranking, w in zip(rankings_with_scores, weights):
        if not ranking:
            continue
        max_s = max(s for _, s in ranking)
        min_s = min(s for _, s in ranking)
        rng = max_s - min_s or 1e-9
        for doc_id, score in ranking:
            norm = (score - min_s) / rng
            combined[doc_id] = combined.get(doc_id, 0.0) + w * norm
    return combined

def fusion_borda(rankings: list[list[str]]) -> dict[str, float]:
    """Borda count: cada ranking contribuye (N - rank) puntos."""
    all_docs = set()
    for r in rankings:
        all_docs.update(r)
    N = len(all_docs)
    scores: dict[str, float] = {doc: 0.0 for doc in all_docs}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking):
            scores[doc_id] += N - rank
    return scores


# Ejemplo comparativo
dense_ranking = [("doc42", 0.89), ("doc7", 0.82), ("doc19", 0.71), ("doc55", 0.65)]
bm25_ranking  = [("doc19", 25.4), ("doc42", 18.2), ("doc99", 12.1), ("doc7", 8.5)]

# RRF (necesita solo IDs)
rrf_scores = fusion_rrf([[d for d,_ in dense_ranking], [d for d,_ in bm25_ranking]])
# Weighted sum (necesita scores normalizados)
ws_scores = fusion_weighted_sum([dense_ranking, bm25_ranking], weights=[0.6, 0.4])
# Borda
borda_scores = fusion_borda([[d for d,_ in dense_ranking], [d for d,_ in bm25_ranking]])

print("RRF   :", sorted(rrf_scores.items(),   key=lambda x: -x[1])[:3])
print("W-Sum :", sorted(ws_scores.items(),    key=lambda x: -x[1])[:3])
print("Borda :", sorted(borda_scores.items(), key=lambda x: -x[1])[:3])
```

Trade-offs observados en benchmarks (Cormack et al., BEIR):

- **RRF**: robusto, invariante a escalas, sin hiperparámetros más que `k=60` (rara vez merece tuning). Gana en la mayoría de benchmarks. Único punto ciego: si un método es MUY superior al otro (por ejemplo dense >> BM25 en un dominio), RRF diluye la ventaja porque solo usa posición.
- **Weighted sum**: puede ganar cuando los pesos están bien calibrados (dominio conocido, eval propio). Pero es frágil: cambia el rango de scores del reranker (nueva versión de Cohere Rerank) y todos los pesos hay que recalibrar.
- **Borda count**: alternativa simple, sensible al tamaño de los rankings (docs que solo aparecen en uno reciben 0 del otro). Menos común en producción.

Regla dura: **empieza con RRF k=60**. Si evaluación propia demuestra ganancia clara con weighted sum, adopta pero pon en CI el eval que la valida — es fácil que se degrade en silencio con cambios upstream.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Multi-tenancy a escala

Tres patrones para SaaS B2B con muchos tenants:

| Patrón | Cardinalidad | Aislamiento | Coste típico |
|---|---|---|---|
| Shared index + filter | <100 tenants | Débil (depende del filter) | Bajo |
| Namespaces / MT nativa | <100k tenants | Fuerte | Medio |
| Índice físico por tenant | <100 tenants premium | Total (data residency) | Alto |

**Anti-patrón:** crear 10.000 índices individuales en Pinecone/Qdrant cobrando por índice — factura de $500k/mes. **Correcto:** namespaces (Pinecone Serverless) o Weaviate Multi-Tenancy (v1.20+), donde el aislamiento es lógico dentro de una infra compartida.

Diseño híbrido común: tenants grandes con índice dedicado (data residency, compliance) + tenants chicos en índice compartido con filter obligatorio.

**Regla dura:** el filter `tenant_id` debe aplicarse **a nivel de infra** (row-level security en pgvector, namespaces obligatorios en Pinecone), no a nivel de aplicación. Un bug en un endpoint no puede filtrar cross-tenant.

### 4.2 Debug de retrieval failures

Query específica falla: "muéstrame la política de reembolso de suscripciones anuales" → RAG dice "no encontré info" pero el chunk existe. Playbook de debug:

1. **Verificar existencia:** `SELECT * FROM chunks WHERE doc_id = 'refund-policy-2024'`.
2. **Embed manual y calcula similitud** con el embedding del chunk esperado:
   ```python
   q = embed(query)
   c = embed(chunk_text)
   print(f"cosine = {np.dot(q, c):.3f}")
   ```
   Si < 0.3, el modelo no captura la semántica → probar hybrid o query expansion.
3. **BM25 puro** con keywords ("reembolso", "suscripción anual"). Si sale, el problema está en la fusión (RRF, umbrales).
4. **Verificar filtros:** ¿algún `WHERE` descarta el chunk? (fechas, tenant, permisos).
5. **Reranker scores:** ¿el reranker despriorizó el chunk correcto?
6. **Chunking:** ¿el chunk contiene la respuesta o quedó partido?
7. **Log tracing** con IDs por capa: Langfuse, Arize Phoenix, TruLens muestran top-K con scores en cada etapa.

Sin tracing es imposible; con tracing el fallo se localiza en minutos.

### 4.3 Coste operativo: palancas

500 QPS con Cohere Rerank ($2/1000 requests) = **$2.6M/mes solo rerank**. Palancas:

- **Semantic cache** (§4.5) — 30-70% ahorro en workloads head-skewed.
- **Reducir candidatos rerank** de 50 a 20 (40% menos coste).
- **Self-host** BGE-reranker-v2 en GPU propia: <$0.10/1000 (20x más barato). Break-even ~$10k/mes.
- **Rerank-lite** o modelos más pequeños.
- **Skip rerank** cuando el bi-encoder ya está confiado (top-1 score alto).
- **Routing:** clasificar intent y solo aplicar rerank a queries complejas.
- **Prompt caching** (cap 04) hasta 90% descuento en input del LLM downstream.
- **Batching** para requests offline (50% descuento típico).
- **Tier por usuario:** capar features expensivas a paid tiers.

### 4.4 SPLADE vs BM25 en la parte sparse

**BM25:** probabilístico, sin modelo neural, sin training, muy rápido y robusto. Baseline duro. Tuneable (`k1`, `b`).

**SPLADE (Formal et al. 2021):** modelo tipo BERT que produce vectores sparse sobre el vocabulario con activaciones learned. Aprende a expandir queries ("cat" → cat, kitten, feline) y docs. Supera a BM25 en BEIR benchmarks pero requiere inference (GPU/CPU), más storage, y DBs que soporten sparse learned nativo (Vespa, Qdrant, Pinecone sparse-dense hybrid).

Recomendación: **empezar con BM25** en hybrid. Migrar a SPLADE si el eval propio muestra ganancia y aceptas ops extra. En Anthropic Contextual Retrieval, BM25 en hybrid fue suficiente para llegar a los mejores números.

### 4.5 Semantic cache y sus caveats

Muchas queries se repiten semánticamente ("¿cómo cambio mi contraseña?", "reset password", "olvidé mi clave"). El semantic cache guarda `(query_embedding, response)` y devuelve directo si un nuevo query supera un umbral de similitud.

```python
import numpy as np

class SemanticCache:
    def __init__(self, embed_fn, threshold=0.93):
        self.embed = embed_fn
        self.threshold = threshold
        self.entries: list[tuple[np.ndarray, str]] = []

    def get(self, query: str) -> str | None:
        q = self.embed(query)
        for cached_vec, response in self.entries:
            sim = float(np.dot(q, cached_vec))
            if sim >= self.threshold:
                return response
        return None

    def set(self, query: str, response: str) -> None:
        self.entries.append((self.embed(query), response))
```

Caveats críticos:
- **Umbral** — muy bajo → falsos positivos (respuesta incorrecta); muy alto → hits raros. Calibrar con eval.
- **TTL e invalidación dirigida** — cuando cambia un doc fuente, invalidar entradas que dependen de él. TTL global es plan B, no primary.
- **Scope por tenant/user** — nunca compartir cache cross-tenant.
- **No cachear queries con contexto único** (user_id, timestamps, live data).

Herramientas: **GPTCache**, **Redis LangCache**, **Portkey**, **Helicone**, **LiteLLM**. Ver [cap 04](./04-context-memory-caching.md) para tratamiento completo.

### 4.6 Agentic retrieval: cuando single-shot no basta

Query compleja: "compara los términos de reembolso entre nuestra política de 2023 y la nueva de 2024, y dime qué cambia para clientes enterprise". Un solo retrieve no basta. **Agentic RAG:**

1. LLM analiza query, planea sub-búsquedas.
2. `retrieve("refund policy 2023 enterprise")` → razona.
3. `retrieve("refund policy 2024 enterprise")` → razona.
4. Compara, sintetiza respuesta.

Patrones: Self-RAG (Asai et al. 2023), Corrective RAG (Yan et al. 2024), ReAct, Reflection. Frameworks: **LangGraph**, **LlamaIndex Agent Runner**, **CrewAI**. Trade-off: latencia y coste multiplicativos vs single-shot. Aplicar selectivamente con un router.

### 4.7 Cuando NO usar RAG

- **Datos ultra-frescos** (order status, live prices, ticket state) → tool call, no RAG.
- **Lógica determinista** (cálculos, transformaciones) → código tradicional.
- **Corpus pequeño y estable** (<50k tokens) → system prompt + prompt caching.
- **Task que requiere info global del corpus** (resúmenes ejecutivos, análisis de tendencias) → long-context o hierarchical summarization.
- **Necesitas consistencia total** → rules engine + LLM validation.
- **Estilo/formato específico** → fine-tuning más apropiado.

Los productos serios combinan: RAG + tools + code + fine-tuning + long-context según intent. RAG solo es una capa.

---

## 5. Ejemplo práctico completo: pgvector local + hybrid BM25 + rerank Cohere

Vamos a construir el pipeline end-to-end sobre pgvector con Docker, añadir BM25 con `tsvector` de Postgres, fusionar con RRF y rerankear con Cohere.

**Por qué este stack:** pgvector + `tsvector` es el "boring" pero ganador para el 60% de startups: no añade dependencias nuevas si ya tienes Postgres, soporta filtered HNSW nativo, y BM25 vía `tsvector` es competitivo con Elasticsearch para volúmenes moderados (<50M chunks). Cohere Rerank 3.5 es la elección comercial más equilibrada en 2026: multilingüe fuerte, latencia razonable, precio predecible. Si vas a escala mayor, la migración natural es: pgvector → Qdrant (para sparse learned), Cohere → BGE-reranker-v2 self-hosted (para >$10k/mes).

### Paso 1: levantar pgvector

```bash
docker run -d --name pg \
  -e POSTGRES_PASSWORD=secret \
  -p 5432:5432 \
  pgvector/pgvector:pg17

pip install psycopg[binary]==3.2.3 pgvector==0.3.6 openai==1.60.0 cohere==5.13.0
```

**Verificación intermedia:**
```bash
docker exec pg psql -U postgres -c "SELECT version();"    # confirma Postgres 17
docker exec pg psql -U postgres -c "CREATE EXTENSION vector; SELECT '[1,2,3]'::vector;"
```
Si el `CREATE EXTENSION` falla, la imagen `pgvector/pgvector:pg17` no está instalada correctamente.

### Paso 2: esquema con embedding + full-text search

**Decisiones de diseño clave:**
- **`text_tsv` como columna GENERADA STORED**: Postgres calcula el tsvector automáticamente en cada INSERT/UPDATE y lo indexa. No tienes que mantenerlo en sync desde la aplicación.
- **`to_tsvector('spanish', ...)`**: define stemming, stopwords y lowercasing para español. Cambia si tu corpus es otro idioma; para inglés usa `'english'`, para multilingüe considera `'simple'` (sin stemming) o instala una extensión custom.
- **`m=16, ef_construction=200`**: valores conservadores que dan recall ~96% en la mayoría de corpus. Sube a `m=32` si el corpus crece a millones y la latencia lo permite.
- **Índice separado en `tenant_id`**: acelera filtros comunes. En pgvector 0.7+, los filtros van al índice HNSW mismo (filtered search integrado).

```sql
-- init.sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
    id BIGSERIAL PRIMARY KEY,
    doc_id TEXT NOT NULL,
    doc_title TEXT NOT NULL,
    text TEXT NOT NULL,
    text_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('spanish', text)) STORED,
    embedding VECTOR(1536) NOT NULL,
    tenant_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chunks_embedding
    ON chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

CREATE INDEX idx_chunks_tsv ON chunks USING GIN (text_tsv);
CREATE INDEX idx_chunks_tenant ON chunks (tenant_id);
CREATE INDEX idx_chunks_updated ON chunks (updated_at);
```

Aplícalo:
```bash
docker exec -i pg psql -U postgres -d postgres < init.sql
```

### Paso 3: pipeline en Python

```python
# rag_hybrid.py
import psycopg
from psycopg.rows import dict_row
from pgvector.psycopg import register_vector
from openai import OpenAI
import cohere
import numpy as np

DSN = "host=localhost port=5432 user=postgres password=secret dbname=postgres"
client = OpenAI()
co = cohere.Client()


def embed(text: str) -> np.ndarray:
    """Embed defensivo con retry en 429/5xx.

    En producción usar backoff exponencial + jitter (ver cap 01 §5).
    """
    from openai import RateLimitError, APIError
    import time
    for attempt in range(3):
        try:
            r = client.embeddings.create(model="text-embedding-3-small", input=text)
            return np.array(r.data[0].embedding, dtype="float32")
        except (RateLimitError, APIError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def get_conn():
    conn = psycopg.connect(DSN, row_factory=dict_row)
    register_vector(conn)
    return conn


def ingest(chunks: list[dict]) -> None:
    """chunks = [{doc_id, doc_title, text, tenant_id}, ...]"""
    with get_conn() as conn, conn.cursor() as cur:
        for c in chunks:
            vec = embed(c["text"])
            cur.execute("""
                INSERT INTO chunks (doc_id, doc_title, text, embedding, tenant_id)
                VALUES (%s, %s, %s, %s, %s)
            """, (c["doc_id"], c["doc_title"], c["text"], vec, c["tenant_id"]))
        conn.commit()


def dense_search(query: str, tenant_id: str, k: int = 50) -> list[dict]:
    q_vec = embed(query)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SET LOCAL hnsw.ef_search = 100")
        cur.execute("""
            SELECT id, doc_id, doc_title, text,
                   1 - (embedding <=> %s) AS score
            FROM chunks
            WHERE tenant_id = %s
              AND updated_at > NOW() - INTERVAL '365 days'
            ORDER BY embedding <=> %s
            LIMIT %s
        """, (q_vec, tenant_id, q_vec, k))
        return cur.fetchall()


def bm25_search(query: str, tenant_id: str, k: int = 50) -> list[dict]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, doc_id, doc_title, text,
                   ts_rank_cd(text_tsv, plainto_tsquery('spanish', %s)) AS score
            FROM chunks
            WHERE tenant_id = %s
              AND text_tsv @@ plainto_tsquery('spanish', %s)
            ORDER BY score DESC
            LIMIT %s
        """, (query, tenant_id, query, k))
        return cur.fetchall()


def rrf_fuse(rankings: list[list[dict]], k: int = 60) -> list[dict]:
    """Fusiona múltiples rankings con RRF preservando la info del chunk."""
    scores: dict[int, float] = {}
    lookup: dict[int, dict] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking, start=1):
            cid = item["id"]
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
            lookup[cid] = item
    ordered = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [{**lookup[cid], "rrf_score": s} for cid, s in ordered]


def rerank_cohere(query: str, candidates: list[dict], top_k: int = 5) -> list[dict]:
    if not candidates:
        return []
    resp = co.rerank(
        model="rerank-multilingual-v3.0",
        query=query,
        documents=[c["text"] for c in candidates],
        top_n=top_k,
    )
    return [
        {**candidates[r.index], "rerank_score": r.relevance_score}
        for r in resp.results
    ]


def hybrid_rerank(query: str, tenant_id: str, top_k: int = 5) -> list[dict]:
    """Pipeline canónico: dense + BM25 → RRF → rerank.

    Verificación intermedia útil en dev:
    - Si `dense` está vacío pero `sparse` tiene resultados, sospecha que
      la query es muy corta o solo términos específicos → dense no captura.
    - Si `sparse` está vacío pero `dense` tiene resultados, la query es
      semántica pura → BM25 no matchea keywords exactas.
    - Si ambos vacíos, revisa el filtro (tenant, updated_at).
    """
    dense = dense_search(query, tenant_id, k=50)
    sparse = bm25_search(query, tenant_id, k=50)

    # Log defensivo: en producción manda a Langfuse/Datadog
    print(f"[retrieval] dense={len(dense)} sparse={len(sparse)}")
    assert dense or sparse, f"Ambos retrievers vacíos para query={query!r}"

    fused = rrf_fuse([dense, sparse])[:50]        # top-50 hybrid
    reranked = rerank_cohere(query, fused, top_k=top_k)
    return reranked


# --- Uso ---
if __name__ == "__main__":
    # Ingest de ejemplo
    ingest([
        {"doc_id": "fsrs", "doc_title": "FSRS", "tenant_id": "linguadev",
         "text": "El motor FSRS-6 ajusta stability y difficulty por tarjeta según la respuesta del usuario."},
        {"doc_id": "arch", "doc_title": "Architecture", "tenant_id": "linguadev",
         "text": "El backend serverless corre en AWS Lambda con DynamoDB y sincroniza con IndexedDB del cliente."},
        {"doc_id": "pwa", "doc_title": "PWA", "tenant_id": "linguadev",
         "text": "La PWA usa Service Worker para offline y notificaciones push."},
    ])

    query = "¿cómo funciona la repetición espaciada?"
    results = hybrid_rerank(query, tenant_id="linguadev", top_k=3)
    for i, r in enumerate(results, start=1):
        print(f"{i}. [{r['rerank_score']:.3f}] {r['doc_title']} — {r['text'][:80]}...")
```

### Paso 4: probar y medir

```bash
python rag_hybrid.py
```

Salida esperada:
```
1. [0.892] FSRS — El motor FSRS-6 ajusta stability y difficulty por tarjeta...
2. [0.234] Architecture — El backend serverless corre en AWS Lambda...
3. [0.187] PWA — La PWA usa Service Worker para offline...
```

### Paso 5: instrumentar recall@K

Añade un eval set y mide:

```python
EVAL_SET = [
    {"query": "¿cómo funciona la repetición espaciada?", "gt_ids": {"fsrs"}},
    {"query": "dónde está el backend", "gt_ids": {"arch"}},
]

def recall_at_k(eval_set, tenant, k=5):
    hits = 0
    for item in eval_set:
        results = hybrid_rerank(item["query"], tenant, top_k=k)
        result_docs = {r["doc_id"] for r in results}
        if result_docs & item["gt_ids"]:
            hits += 1
    return hits / len(eval_set)

print(f"Recall@5: {recall_at_k(EVAL_SET, 'linguadev', k=5):.2%}")
```

### Paso 6: extendiendo el ejemplo

Tres mejoras concretas que llevan este pipeline a producción defendible:

**1. Query rewriting con LLM chico** — reescribe la query del usuario en 2-3 variantes antes de retrieval y fusionalas con RRF. Ganancia típica: +5-10 puntos de recall@5 en queries mal formuladas.

```python
def query_rewrite(query: str) -> list[str]:
    from anthropic import Anthropic
    r = Anthropic().messages.create(
        model="claude-haiku-4-5", max_tokens=200, temperature=0.3,
        messages=[{"role":"user","content":
            f"Genera 2 reformulaciones diversas de esta pregunta, una por línea:\n{query}"}])
    variants = [line.strip("- ").strip() for line in r.content[0].text.split("\n") if line.strip()]
    return [query] + variants[:2]

def hybrid_rerank_v2(query: str, tenant: str, top_k: int = 5):
    all_rankings = []
    for q in query_rewrite(query):
        all_rankings.append(dense_search(q, tenant, k=30))
        all_rankings.append(bm25_search(q, tenant, k=30))
    fused = rrf_fuse(all_rankings)[:50]
    return rerank_cohere(query, fused, top_k=top_k)
```

**2. Self-hosted BGE-reranker-v2 con `sentence-transformers`** — a partir de $10k/mes en Cohere, el break-even de GPU propia se cumple:

```python
from sentence_transformers import CrossEncoder

# Carga una sola vez al arrancar el servicio
reranker = CrossEncoder("BAAI/bge-reranker-v2-m3", max_length=512, device="cuda")

def rerank_bge(query: str, candidates: list[dict], top_k: int = 5) -> list[dict]:
    if not candidates:
        return []
    pairs = [(query, c["text"]) for c in candidates]
    scores = reranker.predict(pairs, batch_size=32, show_progress_bar=False)
    ranked = sorted(zip(candidates, scores), key=lambda x: -x[1])
    return [{**c, "rerank_score": float(s)} for c, s in ranked[:top_k]]
```

En una L4 (~$0.60/h en Runpod) proceses ~200 pares/s. A 500 QPS y top-50 candidates, necesitas ~5 L4 → $2.2k/mes vs $13k/mes de Cohere para el mismo volumen.

**3. MMR post-rerank para diversificar** — cuando el top-5 tiene 4 versiones casi idénticas del mismo doc:

```python
def mmr(query_vec: np.ndarray, candidates: list[dict], k: int = 5, lambda_: float = 0.7):
    """Maximal Marginal Relevance sobre lista pre-rerankeada."""
    if not candidates:
        return []
    docs_vecs = np.array([embed(c["text"]) for c in candidates])
    docs_vecs /= np.linalg.norm(docs_vecs, axis=1, keepdims=True)
    query_vec = query_vec / np.linalg.norm(query_vec)

    selected: list[int] = []
    remaining = list(range(len(candidates)))
    while len(selected) < k and remaining:
        best_idx, best_score = None, -np.inf
        for i in remaining:
            rel = float(docs_vecs[i] @ query_vec)
            div = 0.0 if not selected else max(float(docs_vecs[i] @ docs_vecs[j]) for j in selected)
            score = lambda_ * rel - (1 - lambda_) * div
            if score > best_score:
                best_score, best_idx = score, i
        selected.append(best_idx)
        remaining.remove(best_idx)
    return [candidates[i] for i in selected]
```

Otras extensiones naturales:
- Semantic cache con Redis LangCache (30-70% ahorro en workloads FAQ).
- Migrar a Qdrant si necesitas sparse learned (SPLADE) nativo.
- Tracing con Langfuse por cada capa (dense/sparse/rerank/final).
- Quantization: `int8` con Cohere/Qdrant reduce storage 4x manteniendo recall.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Empieza con pgvector** si ya tienes Postgres. Migra a Pinecone/Qdrant/Weaviate cuando duela.
- ✅ **HNSW con M=16-32, ef_construction=200** como default. Ajusta `ef_search` por query.
- ✅ **Hybrid dense + BM25 fusionado con RRF (k=60)** como baseline.
- ✅ **Rerank top-50 → top-5** con Cohere Rerank 3.5 o BGE-reranker-v2-m3.
- ✅ **Filtered search integrado** en el índice, no post-processing.
- ✅ **Multi-tenancy con namespaces** o MT nativa; filter a nivel de infra.
- ✅ **Tracing por capa** con Langfuse/Arize desde el día 1.
- ✅ **Eval set 200-500 queries** con ground truth; recall@K y MRR en CI.
- ✅ **Quantization** (`int8` con Cohere/Qdrant, binary + rerank) a partir de 10M+ vectores.
- ✅ **Semantic cache** cuando el workload es head-skewed.
- ✅ **Router de queries** para elegir entre RAG, tool, long-context según intent.

### Anti-patrones

- ❌ Post-filtering con `WHERE` en la app después de retrieve top-100.
- ❌ Sumar scores cosine y BM25 crudos (escalas incompatibles).
- ❌ Multiplicar rankings ("multiplicar por 0" elimina candidatos válidos).
- ❌ Un índice separado por cada uno de 10.000 tenants (factura carísima).
- ❌ Un solo índice compartido sin filter obligatorio a nivel de infra (cross-tenant leaks).
- ❌ Confiar en los defaults de HNSW sin medir.
- ❌ Meter todo en RAG cuando el dato es live (tool call es la respuesta).
- ❌ Subir K a 100 y esperar que el LLM ignore el ruido.
- ❌ Cambiar de embedding model sin `embedding_model_version` en metadata.
- ❌ Iterar sin eval set (cada cambio es adivinar).
- ❌ 50 queries de eval "manual"; la varianza domina la señal.
- ❌ LLM-as-judge sobre output final como única métrica.

### Tabla de decisión: vector DB

| Perfil | Elegir |
|---|---|
| Startup seed, Postgres ya en stack, <5M chunks | pgvector 0.8+ |
| Multi-tenant SaaS, serverless preferido | Pinecone Serverless |
| Necesitas hybrid + sparse learned + ColBERT | Qdrant |
| Multi-tenancy nativa fuerte, GraphQL | Weaviate |
| Escala 100M+ vectores, presupuesto ops | Milvus / Zilliz |
| Embedded, sin servidor, on-disk | LanceDB |
| Dev prototype rápido | Chroma |
| Search complejo con multi-signal ranking | Vespa |
| Serverless barato con reads pesados | Turbopuffer |

### Tabla de decisión: cuándo aplicar cada capa

| Situación | Aplicar |
|---|---|
| Query menciona IDs, códigos, siglas | Hybrid con BM25 (imprescindible) |
| Recall@5 bajo, recall@50 alto | Rerank cross-encoder |
| Top-K con muchos duplicados | Dedup en ingesta + MMR post-rerank |
| Queries repetitivas (soporte, FAQ) | Semantic cache |
| Queries multi-hop / comparativas | Agentic retrieval con planner |
| Corpus estable + queries frecuentes al mismo doc | Long-context + prompt caching (cap 04) |

---

## 7. Casos reales industria 2024-2026

**Anthropic — Contextual Retrieval + Rerank (sept 2024):**
- *Qué pasó:* Anthropic publicó blog + código open combinando Contextual Embeddings + Contextual BM25 + Rerank. La combinación llevó retrieval failure rate del 5.7% al 1.9% (-67%).
- *Cómo se detectó la ganancia:* eval interno sobre docs corporativos con 500 queries anotadas mostró que solo dense era 5.7% failed; añadir contextual embeddings bajó a 3.7%; hybrid con BM25 a 2.9%; rerank final a 1.9%.
- *Cómo se implementó:* Claude Haiku genera 50-100 tokens de contexto por chunk aprovechando prompt caching. Cohere Rerank 3 o Voyage rerank como capa final.
- *Qué aprendió la industria:* el failure rate se compone: cada capa arregla una clase distinta de fallos. Sin eval por capa, es imposible saber cuál añadir. Adoptado ampliamente en 2025.

**Supabase — pgvector 0.8 con HNSW y binary quantization (2024-2026):**
- *Qué pasó:* Supabase publicó case studies mostrando que pgvector aguanta workloads que muchos habían migrado a Pinecone.
- *Cómo se detectó el over-engineering:* startups YC 2023-2024 reportaron facturas de Pinecone de $2-8k/mes para volúmenes que en pgvector cuestan $200/mes de RDS.
- *Cómo se arregló:* back-migration masiva. Supabase documentó el patrón "pg17 + pgvector 0.8 + HNSW + binary quantization" como stack de referencia.
- *Qué aprendió la industria:* elegir DB especializada por vector search es prematuro hasta 10M+ chunks o requerimientos específicos (multi-tenancy a escala, sparse learned nativo). YAGNI aplica también aquí.

**Pinecone Serverless (2024):**
- *Qué pasó:* Pinecone cambió de "pod-hour" a "operación + storage" con namespaces por tenant. Antes: pagabas $70/mes por pod idle; ahora: pagas solo por queries.
- *Cómo se detectó el problema base:* startups con tráfico esporádico (B2B enterprise, freemium con conversion baja) pagaban por capacidad ociosa 90% del tiempo.
- *Cómo se arregló:* nuevo pricing + namespaces (aislamiento lógico dentro de un índice físico compartido, hasta millones de tenants por índice).
- *Qué aprendió la industria:* multi-tenancy nativa a nivel de vector DB debería ser un criterio de selección de infra, no un afterthought.

**Perplexity — reranking en producción (2024-2026):**
- *Qué pasó:* publicaron que Cohere Rerank + hybrid + query rewriting agresivo es central en su stack. Después migraron parte de inference LLM a Groq/Cerebras.
- *Cómo se detectó la palanca:* baseline con solo dense retrieval daba answers pobres para queries multi-facetadas; añadir hybrid + rerank subió user satisfaction significativamente.
- *Cómo se arregló:* pipeline "expand → dense + BM25 → RRF → rerank → sonata al LLM". Cost mitigation vía Groq/Cerebras para el LLM step.
- *Qué aprendió la industria:* combinar retrieval quality (Cohere) + inference speed (Groq) es más rentable que optimizar una sola dimensión.

**Cursor — indexado de código + rerank (2024-2026):**
- *Qué pasó:* AST chunking con tree-sitter + embeddings de código (voyage-code-3 o propios) + BM25 con Zoekt para símbolos + reranker + prompt caching.
- *Cómo se detectó la palanca:* eval interna sobre queries de "encuentra la función que hace X" mostró que AST chunking + hybrid subía recall 15-20 puntos sobre chunking naive.
- *Cómo se arregló:* migración a tree-sitter chunking, integración de Zoekt (Google, para code search), y reindex incremental por `git diff`.
- *Qué aprendió la industria:* para código, el pipeline domina. Ni el mejor embedder de código puede compensar chunks que cortan funciones a la mitad.

**Weaviate Multi-Tenancy at Scale (2024-2025):**
- *Qué pasó:* case studies con 50k+ tenants en clusters compartidos.
- *Cómo se detectó la necesidad:* SaaS B2B con miles de workspaces pequeños generaban millones de shards individuales, saturando memoria.
- *Cómo se arregló:* patrón "activate/deactivate tenant" — cuando un tenant no ha tenido actividad en X días, se hiberna (metadata en disco, no en RAM). Al primer query se rehidrata en ~1s.
- *Qué aprendió la industria:* multi-tenancy no es "un flag en la config", es una decisión arquitectónica que afecta scheduling, cache y billing.

**Cohere int8 y binary embeddings (2024):**
- *Qué pasó:* Cohere publicó int8 (reducción 4x storage) y binary (32x) con recall casi idéntico si se combina con reranking en top-K.
- *Cómo se detectó la ganancia:* benchmarks internos sobre BEIR mostraron que binary + rerank recuperaba >95% del recall de float32.
- *Cómo se implementó:* pipeline "búsqueda inicial en binary (rapidísima) → top-100 → refinar con float32 → rerank".
- *Qué aprendió la industria:* quantization no es "menos calidad": bien combinada con rerank, es coste-negativa (menos storage, misma calidad).

**Qdrant binary quantization + reranking:** documentó reducciones de coste 40x manteniendo recall >95%. Tendencia clara 2024-2026 hacia embeddings comprimidos por defecto.

**Naver Search — SPLADE en producción a escala web (2023+):** muestra que SPLADE es viable production-grade, no solo académico. Corre con throughput de miles de QPS en su motor de búsqueda coreano.

**Voyage AI verticales (2024-2026):**
- *Qué pasó:* Voyage lanzó `voyage-law-2`, `voyage-finance-2`, `voyage-code-3` — modelos pre-fine-tuneados por dominio.
- *Cómo se detectó la ganancia:* firms legales que probaron voyage-law-2 vs text-embedding-3-large sobre corpus de contratos vieron mejoras de recall@10 del 10-20 puntos.
- *Qué aprendió la industria:* fine-tune por dominio del proveedor es a menudo mejor que fine-tune propio con datasets chicos (<10k pares).

**Turbopuffer (2024-2026):** vector DB serverless que factura solo por reads (no por storage ni idle). Adoptada por apps con tráfico bursty (weekly digests, batch reports) donde otras DBs son 10x más caras.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Montar pgvector + HNSW local y medir recall

**Objetivo:** Tener pgvector corriendo en Docker, indexar 5000-10000 chunks reales y medir recall@10 con un eval set de 50 queries.

**Setup:**
- Docker.
- Corpus con ≥5000 chunks (usa el corpus del ejercicio 3 del cap 02 o descarga uno público).
- Python 3.11+ con `psycopg`, `pgvector`, `openai`.

**Pasos:**
1. Levanta pgvector con `docker run pgvector/pgvector:pg17`.
2. Crea la tabla `chunks` con índice HNSW (`m=16, ef_construction=200`).
3. Embed e ingesta con batches de 100.
4. Construye eval set de 50 queries con ground truth (`{query, gt_chunk_ids}`).
5. Mide recall@10 con `ef_search=40, 100, 400`.
6. Documenta trade-off latencia vs recall.

**Criterios de éxito:**
- [ ] `docker ps` muestra pgvector corriendo.
- [ ] `SELECT COUNT(*) FROM chunks` retorna ≥5000.
- [ ] Recall@10 reportado para 3 valores de `ef_search`.
- [ ] Latencia P50 y P95 medidas en cada configuración.

**Bonus:** Añade filtered search con `metadata->>'category' = ?` y mide el impacto.

**Hints:**
- `EXPLAIN ANALYZE SELECT ... ORDER BY embedding <=> ...` te dice si Postgres está usando el índice HNSW o cayendo a scan secuencial.
- Latencia sube con `ef_search`; recall también. Grafica ambos para ver la curva sweet-spot.
- Para medir P95: ejecuta cada query 20+ veces y quédate con el percentil 95.

**Solución de referencia (esbozo):**
```python
import time
for ef in [40, 100, 400]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(f"SET LOCAL hnsw.ef_search = {ef}")
    latencias, hits = [], 0
    for item in eval_set:
        t0 = time.perf_counter()
        results = dense_search(item["query"], k=10)
        latencias.append((time.perf_counter() - t0) * 1000)
        if item["gt_id"] in {r["id"] for r in results}:
            hits += 1
    latencias.sort()
    print(f"ef={ef}  R@10={hits/len(eval_set):.2%}  "
          f"P50={latencias[len(latencias)//2]:.1f}ms  P95={latencias[int(len(latencias)*0.95)]:.1f}ms")
```

---

### Ejercicio 2: Hybrid search con BM25 + RRF

**Objetivo:** Añadir BM25 sobre el mismo corpus del ejercicio 1 y comparar recall@10 dense-solo vs hybrid.

**Setup:**
- El pgvector del ejercicio 1.
- Añade columna `text_tsv TSVECTOR` generada con `to_tsvector('spanish', text)`.
- Índice GIN sobre `text_tsv`.

**Pasos:**
1. Modifica el esquema (usa `ALTER TABLE ... ADD COLUMN ... GENERATED`).
2. Crea `bm25_search()` con `ts_rank_cd + plainto_tsquery('spanish', ...)`.
3. Implementa `rrf_fuse(rankings, k=60)` en Python.
4. Compara recall@10 en 3 configuraciones sobre el mismo eval set:
   - dense-only
   - BM25-only
   - hybrid RRF
5. Identifica al menos 3 queries donde hybrid gana claramente.

**Criterios de éxito:**
- [ ] Los 3 pipelines corren sin errores.
- [ ] Tabla comparativa con recall@10 de las 3 configuraciones.
- [ ] Análisis cualitativo de 3 queries donde hybrid > dense.
- [ ] Análisis de 1 query donde BM25 > dense (típicamente con IDs o siglas).

**Bonus:** Añade una query con un CVE o un SKU en el corpus y confirma que hybrid lo encuentra donde dense falla.

**Hints:**
- Casos donde hybrid gana claramente: (a) queries con IDs/códigos, (b) queries con siglas raras (JWT, RRF), (c) queries con nombres propios poco comunes.
- Casos donde dense gana: (a) queries en un idioma diferente al del corpus, (b) queries parafraseadas usando sinónimos, (c) queries conceptuales sin keywords específicas.
- `k=60` en RRF es el default de Cormack 2009 y suele funcionar bien; no lo tuneés a menos que tengas eval sólido.

**Solución de referencia (esbozo):**
```python
def compare_configs(queries, gt_ids):
    for name, search_fn in [("dense", dense_only), ("bm25", bm25_only), ("hybrid", hybrid_rrf)]:
        hits = sum(1 for q, gt in zip(queries, gt_ids)
                   if gt in {r["doc_id"] for r in search_fn(q, k=10)})
        print(f"{name:<8} R@10 = {hits/len(queries):.2%}")

# Casos hybrid > dense: guarda los queries + top-K de cada uno para ver diferencias
```

---

### Ejercicio 3: Añadir reranker Cohere y medir mejora

**Objetivo:** Rerankear top-50 hybrid → top-5 con Cohere Rerank 3.5 y medir mejora en recall@5 y MRR.

**Setup:**
- El pipeline hybrid del ejercicio 2.
- API key de Cohere (free tier tiene requests limitados suficientes para test).
- `pip install cohere==5.13.0`.

**Pasos:**
1. Implementa `rerank_cohere(query, candidates, top_k=5)`.
2. Encadena: `dense → bm25 → RRF top-50 → rerank → top-5`.
3. Sobre el mismo eval set, mide recall@5 y MRR:
   - hybrid solo (top-5)
   - hybrid + rerank (top-5)
4. Reporta diferencia y latencia añadida.
5. Analiza 5 queries donde rerank cambia el orden (top-1 pre-rerank ≠ top-1 post-rerank).

**Criterios de éxito:**
- [ ] Recall@5 y MRR reportados para las 2 configuraciones.
- [ ] Latencia P50 y P95 con y sin rerank.
- [ ] 5 queries analizadas mostrando cambio de orden.
- [ ] Coste estimado por 1000 queries.

**Bonus:** Prueba también BGE-reranker-v2-m3 self-hosted con `sentence-transformers` y compara calidad + latencia + coste.

**Hints:**
- Rerank tarda 300-800ms para top-50; súbelo al log de tracing por request.
- Coste Cohere Rerank 3.5: ~$2/1000 requests. Multiplícalo por tu QPS × 86400 × 30 para el mensual.
- Rerank tiene retornos decrecientes: subir de top-10 a top-50 no siempre mejora recall@5, pero triplica latencia.

**Solución de referencia (esbozo):**
```python
def mrr(eval_set, search_fn, k=5):
    total = 0.0
    for item in eval_set:
        results = search_fn(item["query"], k=k)
        for rank, r in enumerate(results, start=1):
            if r["doc_id"] in item["gt_ids"]:
                total += 1.0 / rank
                break
    return total / len(eval_set)

r5_no_rerank = recall_at_k(eval_set, lambda q,k: hybrid_search(q, k=k)[:5], k=5)
r5_rerank    = recall_at_k(eval_set, lambda q,k: hybrid_rerank(q, top_k=5), k=5)
print(f"R@5 sin rerank: {r5_no_rerank:.2%}  con rerank: {r5_rerank:.2%}")
```

---

### Ejercicio 4: Debug de retrieval failure con tracing

**Objetivo:** Encontrar por qué una query específica no recupera el chunk correcto y arreglarlo.

**Setup:**
- El pipeline del ejercicio 3.
- Elegir 3 queries donde el chunk esperado NO aparece en top-5.

**Pasos:**
1. Para cada query fallida, ejecuta el playbook §4.2:
   - Verifica que el chunk existe.
   - Embed manual y calcula similitud coseno.
   - Prueba BM25 puro.
   - Verifica filtros.
   - Verifica reranker.
2. Diagnostica en qué capa falla.
3. Propón fix concreto (chunk size, contextual retrieval, expandir query, cambiar embedding model, etc.).
4. Implementa el fix y remide.

**Criterios de éxito:**
- [ ] 3 queries fallidas diagnosticadas con capa identificada.
- [ ] Fix concreto propuesto y aplicado en cada caso.
- [ ] Recall@5 post-fix ≥ pre-fix.
- [ ] Documentación por escrito de cada diagnóstico.

**Bonus:** Añade instrumentación con Langfuse o Arize Phoenix para tracing automático.

**Hints:**
- Playbook mental: (a) ¿existe el chunk? (b) ¿lo encuentra dense? (c) ¿BM25? (d) ¿el reranker lo mata? (e) ¿el filtro lo descarta?
- Un fallo típico: chunk correcto tiene cosine 0.4 con la query. El modelo no captura el dominio → probar rewriting o expandir con contextual retrieval.
- Otro: chunk parte la respuesta en dos por chunking → merge de chunks adyacentes o parent-child chunking.

**Solución de referencia (esbozo):**
```python
def debug_query(query: str, expected_doc_id: str):
    # Fase 1: existe?
    chunk = get_chunk_by_doc(expected_doc_id)
    if not chunk: return "El chunk no existe → problema de ingesta"
    # Fase 2: similitud dense
    sim = float(embed(query) @ np.array(chunk["embedding"]))
    print(f"cosine(q, chunk) = {sim:.3f}")
    if sim < 0.3: return "Embedding no captura → rewriting o mejor modelo"
    # Fase 3: rank en dense
    dense_top = dense_search(query, k=50)
    rank = next((i for i,r in enumerate(dense_top,1) if r["doc_id"]==expected_doc_id), None)
    print(f"rank dense: {rank}")
    # Fase 4: BM25
    bm25_top = bm25_search(query, k=50)
    rank_bm = next((i for i,r in enumerate(bm25_top,1) if r["doc_id"]==expected_doc_id), None)
    print(f"rank BM25: {rank_bm}")
    # Continúa: RRF, rerank, filtros...
```

---

### Ejercicio 5 (bonus): Semantic cache sobre el pipeline

**Objetivo:** Implementar semantic cache que ahorre 30%+ de calls al reranker manteniendo calidad.

**Setup:**
- Redis local (`docker run -p 6379:6379 redis:7-alpine`) o simplemente in-memory.
- El pipeline del ejercicio 3.
- Log de queries anteriores (simula con 200 queries repetitivas).

**Pasos:**
1. Implementa `SemanticCache` (código en §4.5).
2. Antes de llamar al reranker, verifica cache con umbral 0.93.
3. Simula tráfico con 200 queries donde ~40% son variaciones semánticas.
4. Mide: hit rate, latencia con/sin cache, falsos positivos manuales sobre muestra.
5. Ajusta umbral hasta hit rate > 30% con falsos positivos < 5%.

**Criterios de éxito:**
- [ ] Hit rate ≥ 30% en el tráfico simulado.
- [ ] Falsos positivos < 5% en muestra de 50 hits inspeccionados.
- [ ] Latencia P50 con cache ≤ 30% de sin cache en hits.
- [ ] TTL implementado (verificar que entries expiran).

**Bonus:** Añade invalidación dirigida por `doc_id` — cuando marcas un doc como "actualizado", invalida entradas de cache que dependían de él.

**Hints:**
- Umbrales <0.90 dan hit rate alto pero muchos FP; >0.95 hit rate bajísimo. El sweet spot 0.92-0.94 depende del modelo de embedding.
- Para simular tráfico realista: toma 40 queries base y genera 5 variantes semánticas de cada una con un LLM.
- Guarda en cada entry los `doc_ids` que se usaron para responder → invalidación dirigida sin barrer todo.

**Solución de referencia (esbozo):**
```python
# Simular tráfico
base_qs = [...40 queries base...]
traffic = []
for q in base_qs:
    variants = llm_expand(q, n=5)         # 5 variantes semánticas
    traffic.extend(variants)
random.shuffle(traffic)  # 200 queries, ~40% overlap semántico

cache = SemanticCache(threshold=0.92)
hits = 0
for q in traffic:
    if cache.get(q):
        hits += 1
    else:
        r = hybrid_rerank(q, tenant="x")
        cache.set(q, r, doc_ids=[c["doc_id"] for c in r])
print(f"Hit rate: {hits/len(traffic):.2%}")
```

---

### Ejercicio 6 (Reto): A/B test de dos configuraciones de retrieval en producción

**Objetivo:** Diseñar y ejecutar un A/B test que decide si vale la pena migrar de "hybrid+RRF" a "hybrid+RRF+rerank" en producción, con muestreo válido y análisis estadístico.

**Setup:**
- Producto con >100 queries/día reales.
- Métricas de negocio identificables (thumbs up/down, click-through en el resultado, tiempo en la página).
- Stateful assignment por user_id (mismo user siempre ve la misma variante).

**Pasos:**
1. Implementa router A/B: 50% de queries van a variante A (baseline hybrid), 50% a variante B (con rerank).
2. Loguea por query: `variant`, `latency_ms`, `cost_usd`, `user_feedback` (si aplica).
3. Ejecuta 2 semanas mínimo, con ≥1000 queries por variante.
4. Analiza: mean latency, cost per query, feedback rate, statistical significance con t-test o Mann-Whitney U.
5. Decide con criterios pre-registrados (no post-hoc): "adoptamos B si mejora feedback ≥5% con p<0.05 y latencia P95 ≤ +50%".

**Criterios de éxito:**
- [ ] Asignación estable por user_id (hash mod 2).
- [ ] ≥1000 queries por variante logueadas con contexto completo.
- [ ] Test estadístico documentado (p-value, tamaño de efecto, IC 95%).
- [ ] Decisión final con justificación numérica.

**Hints:**
- Sin stateful assignment (por user), un mismo user oscila entre variantes y no puedes medir su experiencia coherente.
- El p-value solo importa junto con tamaño de efecto. Un p=0.001 con efecto +0.5% no es útil.
- Cuidado con "peeking": si miras el test cada día y decides cuando p<0.05, tu tasa real de falsos positivos es mucho mayor. Fija el N por adelantado.

**Solución de referencia (esbozo):**
```python
import hashlib
from scipy.stats import mannwhitneyu

def assign_variant(user_id: str) -> str:
    h = int(hashlib.sha256(user_id.encode()).hexdigest(), 16)
    return "B" if h % 2 == 0 else "A"

def route(query, user_id):
    variant = assign_variant(user_id)
    fn = hybrid_rerank if variant == "B" else hybrid_search
    t0 = time.perf_counter()
    result = fn(query)
    latency = time.perf_counter() - t0
    log_to_db(variant, query, user_id, latency, cost_of(result))
    return result

# Analysis
scores_A = get_feedback_scores("A")   # e.g. [1, 0, 1, 1, 0, ...]
scores_B = get_feedback_scores("B")
stat, p = mannwhitneyu(scores_A, scores_B)
print(f"A mean={np.mean(scores_A):.3f}  B mean={np.mean(scores_B):.3f}  p={p:.4f}")
```

---

## 9. Recursos + siguientes pasos

**Vector DBs oficiales:**
- [pgvector GitHub](https://github.com/pgvector/pgvector) — extension, releases, ejemplos.
- [Supabase — pgvector HNSW](https://supabase.com/blog/increase-performance-pgvector-hnsw) — case study.
- [Pinecone docs](https://docs.pinecone.io/) — Serverless, namespaces, hybrid.
- [Qdrant docs](https://qdrant.tech/documentation/) — hybrid, quantization, ColBERT.
- [Weaviate docs](https://weaviate.io/developers/weaviate) — multi-tenancy, hybrid.
- [Milvus docs](https://milvus.io/docs) — enterprise scale.
- [LanceDB](https://lancedb.github.io/lancedb/) — embedded on-disk.
- [Vespa docs](https://docs.vespa.ai/) — search complejo enterprise.

**Rerankers:**
- [Cohere Rerank](https://docs.cohere.com/docs/rerank-overview) — API + modelos.
- [Voyage Rerank](https://docs.voyageai.com/docs/reranker) — modelos generales y verticales.
- [BGE-reranker (BAAI)](https://huggingface.co/BAAI/bge-reranker-v2-m3) — open, multi-lingüe.
- [Jina Reranker](https://jina.ai/reranker/) — open + API.
- [sentence-transformers Cross-Encoders](https://www.sbert.net/examples/applications/cross-encoder/README.html) — para fine-tune propio.

**Fusion + query techniques:**
- [Cormack et al. — RRF paper](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [Gao et al. — HyDE](https://arxiv.org/abs/2212.10496)
- [Asai et al. — Self-RAG](https://arxiv.org/abs/2310.11511)
- [Anthropic — Building effective agents](https://www.anthropic.com/research/building-effective-agents)

**Eval & observability:**
- [Ragas docs](https://docs.ragas.io/) — métricas RAG.
- [TruLens](https://www.trulens.org/) — tracing + eval.
- [Langfuse](https://langfuse.com/docs) — obs + eval.
- [Arize Phoenix](https://phoenix.arize.com/) — open source LLM obs.
- [Braintrust](https://www.braintrust.dev/) — experiment tracking.

**Frameworks:**
- [LangGraph](https://langchain-ai.github.io/langgraph/) — agentic RAG stateful.
- [LlamaIndex](https://docs.llamaindex.ai/) — router query engine, agent runner.
- [LiteLLM](https://docs.litellm.ai/) — proxy con caching + routing.

**Siguientes pasos:**
- Lee el [cap 04 — context engineering, memoria y caching](./04-context-memory-caching.md): ya recuperas bien; ahora hay que gestionar el contexto que llega al LLM.
- Lee el [cap 09 — evals y LLM-as-judge](./09-evals-datasets-llm-judge.md) para instrumentar eval continuo en CI.
- Lee el [cap 11 — OWASP LLM Top 10](./11-prompt-injection-owasp-llm.md) para prevenir prompt injection via chunks recuperados.
- Aplica los ejercicios sobre LinguaDev Pro: indexa `docs/` y `packages/content/` como corpus real.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales sobre vector DBs, retrieval y reranking. Cubren: elección de vector DB (pgvector, Pinecone, Qdrant, Weaviate, Milvus, LanceDB), HNSW vs IVF y sus parámetros, filtered search integrado, hybrid dense + BM25 con RRF, reranking cross-encoder vs bi-encoder, query expansion y HyDE, MMR, recall vs precision, cost optimization (quantization, semantic cache, self-hosting), multi-tenancy a escala, debug de retrieval failures, SPLADE vs BM25, rerankers multilingües y verticales, evaluación (recall@K, MRR, NDCG, Ragas), agentic RAG multi-hop, y cuándo NO usar RAG.

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-03-vector-dbs-hybrid-reranking.json`](../../packages/content/src/tech/ai-programming/sim-03-vector-dbs-hybrid-reranking.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-03-vector-dbs-hybrid-reranking`
- **Tiempo:** 25 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 02 — embeddings y chunking](./02-rag-embeddings-chunking.md) · [Índice](./README.md) · [Capítulo 04 — context engineering, memoria y caching](./04-context-memory-caching.md) →
