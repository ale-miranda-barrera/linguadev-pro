# Capítulo 19 — Datos y gobernanza: PII, EU AI Act, versionado

> **Focus:** Cómo gestionar datos para sistemas IA sin meterte en problemas: pipelines de datos, PII, versionado de datasets, EU AI Act, compliance.
> **Áreas:** Data governance · Security
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

**Pre-requisitos:**
- Python 3.11+, `pip`/`uv`.
- Fundamentos de RAG: embeddings, vector DB, retrieval (ver [cap 06](./03-vector-dbs-hybrid-reranking.md)).
- Nociones básicas de GDPR (derecho al olvido, DPIA, base de licitud).
- Familiaridad con LangChain o LlamaIndex a nivel de "hola mundo".
- Docker Desktop opcional para levantar Chroma/Postgres localmente.
- Ideal: haber ejecutado alguna vez un pipeline batch (Airflow, Prefect, Dagster o un cron script).

**Glosario mínimo:**
- **PII** (Personally Identifiable Information): datos que identifican directa o indirectamente a una persona. En GDPR se llama "personal data".
- **PHI** (Protected Health Information): PII médica, cubierta por HIPAA en EE. UU.
- **Redaction**: reemplazo de PII por tokens (`[EMAIL]`, `[PHONE]`) o hashing.
- **Pseudonymization / tokenization**: reemplazo reversible con mapping en un vault seguro.
- **Presidio**: framework open-source de Microsoft para detección y anonimización de PII.
- **Data lineage**: trazabilidad de un dato desde su origen hasta su uso en decisión o respuesta.
- **EU AI Act**: Regulación (EU) 2024/1689. En vigor desde agosto 2024, con aplicación escalonada.
- **GPAI** (General Purpose AI): modelo con generalidad significativa. Los que pasan 10^25 FLOPs entran en "systemic risk".
- **Providers vs Deployers**: quien coloca en mercado vs quien usa el sistema en su actividad profesional.
- **NIST AI RMF**: AI Risk Management Framework del NIST (US), voluntario, mapea bien a EU AI Act.
- **ISO 42001**: norma internacional para sistemas de gestión de IA (AI Management System), publicada 2023.
- **Model card / datasheet**: documentación estructurada de un modelo o dataset (Google, HuggingFace, MIT).

**Setup mínimo:**

```bash
# Entorno base
python -m venv .venv && source .venv/bin/activate      # macOS/Linux
# .\.venv\Scripts\Activate.ps1                          # Windows PowerShell

# Stack pipeline + PII + RAG (versiones verificadas a 2026)
pip install --upgrade pip
pip install "presidio-analyzer>=2.2" "presidio-anonymizer>=2.2" \
            "spacy>=3.7" \
            "langchain>=0.3" "langchain-community>=0.3" "langchain-openai>=0.2" \
            "chromadb>=0.5" \
            "openai>=1.50" \
            "unstructured[md,pdf]>=0.15" \
            "python-dateutil"

# Descargar modelo spaCy (motor NER de Presidio)
python -m spacy download en_core_web_lg
python -m spacy download es_core_news_lg          # español

# DVC para versionado de datasets (opcional)
pip install "dvc[s3]>=3.55"

# Orquestador (elige uno; ejemplo con Prefect)
pip install "prefect>=3.0"

# Chroma local en Docker (opcional)
docker run -d -p 8000:8000 --name chroma chromadb/chroma:0.5.15
```

Verifica que Presidio funciona:

```bash
python - <<'PY'
from presidio_analyzer import AnalyzerEngine
a = AnalyzerEngine()
r = a.analyze(text="Call John at john.doe@example.com or +1-555-2020.", language="en")
for e in r: print(e.entity_type, e.start, e.end, e.score)
PY
```

Deberías ver `EMAIL_ADDRESS`, `PHONE_NUMBER`, `PERSON` con scores > 0.7.

---

## 1. El gran cuadro

Un pipeline de datos para IA no es un ETL tradicional con "más pasos". Es un sistema en el que cada decisión (cómo chunkeas, qué embeddings usas, qué PII rediges, dónde guardas metadatos) impacta directamente la **calidad**, la **compliance** y la **auditoría** del producto final. En 2026, ignorar cualquiera de esas tres dimensiones se paga caro: una consulta de un abogado, una multa de una autoridad europea, o un cliente que descubre en un ticket que el asistente le mostró datos de otro usuario. Este capítulo es la guía práctica de cómo montar esos pipelines de forma que el equipo pueda dormir tranquilo cuando llegue el auditor.

El pipeline canónico tiene cinco fases: **ingest → clean → chunk → embed → index**. Ingest extrae texto de fuentes heterogéneas (PDFs, HTML, DOCX, Confluence, Salesforce). Clean deduplica, filtra ruido, redacta PII y normaliza. Chunk divide por unidades semánticas con overlap. Embed vectoriza con un modelo apropiado al dominio e idioma. Index guarda vectores con metadatos (source, tenant, permisos, fecha) en un vector store. Saltar una fase (por ejemplo, "solo subir PDFs a Pinecone y ya") es la causa más común de fallos posteriores: RAG que devuelve resultados irrelevantes, PII leakada, o imposibilidad de borrar datos de un usuario que ejerce el derecho al olvido.

Sobre la gobernanza flotan dos regulaciones inevitables si operas en Europa o con datos europeos. **GDPR** (2018) sigue vigente y colisiona con LLMs de formas nuevas: el derecho al olvido (Art. 17) es prácticamente imposible en modelos entrenados, y "necesario para la base contractual" ya no es una respuesta suficiente para procesamiento automatizado con IA. **EU AI Act** (Regulation 2024/1689) entró en vigor agosto 2024 y su aplicación es escalonada: **2 de febrero 2025** activó las **prácticas prohibidas del Art. 5**, **2 de agosto 2025** los **deberes de GPAI providers**, **2 de agosto 2026** los **deberes de sistemas high-risk y el Art. 50 de transparencia** (chatbots deben identificarse como IA, contenido sintético debe marcarse), y **2 de agosto 2027** cubre modelos GPAI colocados antes de agosto 2025. Las multas del Art. 99 son severas: hasta **35 M EUR o 7% del turnover global** para violaciones del Art. 5, **15 M EUR o 3%** para non-compliance de high-risk / GPAI / transparencia, y **7.5 M EUR o 1%** por información engañosa a autoridades.

La distinción **provider vs deployer** es crítica y muchas empresas la entienden mal. Anthropic y OpenAI son providers de GPAI. Una startup que integra Claude en un producto de scoring crediticio se convierte simultáneamente en **deployer de Claude** y **provider del sistema high-risk resultante**, con obligaciones duplicadas. Y el Art. 25 (**substantial modification**) puede convertir a un fine-tuner en provider del sistema modificado. La cadena de accountability no se resuelve diciendo "usamos APIs de terceros, no somos responsables"; cada actor responde por su parte.

En paralelo a la regulación, la industria consolidó frameworks voluntarios que ayudan a cumplir: **NIST AI RMF 1.0** (2023, expandido con GenAI Profile 2024), **ISO 42001** (AI Management System, 2023, norma auditable tipo ISO 9001), **Model Cards** (Google 2019) y **Datasheets for Datasets** (MIT 2018). Adoptar estos frameworks no exime de compliance regulatorio, pero acorta drásticamente la distancia al cumplimiento y estructura la conversación interna con legal y seguridad.

---

## 2. Fundamentos (nivel básico)

**Analogía útil.** Data governance es la "**ley de tránsito para datos**": sin ella, cada dev toma "atajos" (subir un CSV de clientes a ChatGPT para explorar, dumpear producción a un notebook local) que individualmente parecen inofensivos pero agregados producen accidentes serios (Slack AI 2024, Samsung 2023). Las regulaciones (GDPR, EU AI Act) son los códigos de circulación; los frameworks (NIST, ISO 42001) son la autoescuela; los pipelines gobernados son los carriles señalizados.

### 2.1 El pipeline canónico ingest → clean → chunk → embed → index

Cada fase resuelve un problema distinto y saltar una degrada la calidad del RAG y bloquea auditorías. Vamos por partes.

**Ingest.** Los documentos vienen en formatos heterogéneos: PDFs (a veces escaneados con OCR mediocre), HTML con boilerplate, DOCX con tablas, Markdown con front-matter, Confluence con macros, Sharepoint, Google Drive, Slack, Salesforce. Un parser genérico rompe estructura; conviene tener parsers específicos por formato. Herramientas 2026: **Unstructured** (open + hosted), **LlamaParse**, **Marker** (PDFs académicos), **Docling** (IBM, 2024), **PyMuPDF4LLM**, **AWS Textract** para OCR, **Bedrock Foundation Model Parsing** para PDFs complejos.

**Clean.** Sin limpieza, el índice se llena de ruido: cabeceras/pies de página repetidos, boilerplate legal duplicado, versiones múltiples del mismo doc. Dos operaciones críticas: **dedup** (exacto por hash y near-dup por MinHash/SimHash) y **PII redaction**. Además: filtrar por longitud mínima, idioma correcto, y contenido tóxico si aplica.

**Chunk.** Los embedding models tienen límite de tokens (típicamente 8k). Un PDF de 50 páginas no cabe en un solo embedding, y aunque cupiera, el promedio semántico sería inútil para retrieval fino. Chunking parte el documento en unidades manejables. Fixed-size (500-800 tokens con 10-20% overlap) es el default; **semantic chunking** (por heading, párrafo, sección) es superior cuando la estructura del documento lo permite; **hierarchical chunking** guarda chunks pequeños para retrieval y parent chunks para contexto de generación.

**Embed.** Elige embedding según dominio e idioma: `text-embedding-3-large` de OpenAI (multilingüe, 3072 dims), `voyage-3` de Voyage (dominios técnicos), `Cohere Embed v3` (multilingüe, retrieval optimizado), `bge-m3` open-source (100+ idiomas), Amazon `Titan Embeddings v2` (integrado con Bedrock KB). Un mal embedding degrada retrieval sin remedio; ninguna magia de chunking o reranking compensa.

**Index.** Vector store con metadata rica: `source_id`, `doc_hash`, `chunk_id`, `ingestion_run_id`, `permissions`, `tenant`, `date`, `language`. Sin metadata no puedes filtrar por permisos (RAG expone datos privados), borrar en cascada tras un derecho al olvido, ni auditar de dónde vino una respuesta. Vector stores populares: **Pinecone**, **Qdrant**, **Weaviate**, **pgvector** en Postgres/Aurora, **Chroma**, **Milvus**, **Redis Stack**, **OpenSearch/Elasticsearch** con vector fields, **MongoDB Atlas Vector Search**.

Ejemplo mínimo con LangChain:

```python
from langchain_community.document_loaders import UnstructuredMarkdownLoader
from langchain.text_splitter import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma

docs = UnstructuredMarkdownLoader("./policies.md").load()

# Split por headers, luego por tamaño con overlap
header_splitter = MarkdownHeaderTextSplitter(
    headers_to_split_on=[("#", "h1"), ("##", "h2"), ("###", "h3")]
)
md_chunks = header_splitter.split_text(docs[0].page_content)
splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=100)
final_chunks = splitter.split_documents(md_chunks)

emb = OpenAIEmbeddings(model="text-embedding-3-large")
vs = Chroma.from_documents(
    final_chunks, emb, collection_name="policies",
    persist_directory="./chroma_db"
)
```

### 2.2 Orquestadores: Airflow, Prefect, Dagster, Argo

Cuatro herramientas dominan el paisaje 2026. Cada una con un modelo mental distinto:

| Orquestador | Modelo mental | Fortaleza | Cuándo elegirla |
|---|---|---|---|
| **Airflow** | DAG estático de tasks Python | Ecosistema masivo, probado | Ya lo usas y funciona |
| **Prefect 2/3** | Flows dinámicos Pythonic | DX moderno, cloud-first | Workflows cambiantes |
| **Dagster** | Assets con lineage nativo | ML data lineage integrado | Pipelines ML nuevos |
| **Argo Workflows** | DAG de containers K8s | K8s-native, per-step container | Ya estás en Kubernetes |

Para pipelines RAG específicamente, Prefect y Dagster son elecciones modernas por su facilidad de scheduling dinámico y por el modelo asset-based (Dagster) que se alinea con "datasets" como primer ciudadano.

### 2.3 Ejemplo mínimo con Prefect

```python
# ingest_flow.py
from prefect import flow, task
from pathlib import Path

@task
def list_source_files(folder: str) -> list[str]:
    return [str(p) for p in Path(folder).glob("**/*.md")]

@task(retries=3, retry_delay_seconds=10)
def parse_and_clean(path: str) -> dict:
    text = Path(path).read_text(encoding="utf-8")
    # aquí iría PII redaction, dedup, etc.
    return {"source": path, "text": text}

@task
def chunk_and_embed(doc: dict) -> int:
    # aquí iría chunking + embedding + index
    return len(doc["text"])

@flow(name="rag-ingest")
def rag_ingest(folder: str = "./docs"):
    files = list_source_files(folder)
    docs = parse_and_clean.map(files)
    counts = chunk_and_embed.map(docs)
    print(f"Chunks indexados: {sum(counts.result())}")

if __name__ == "__main__":
    rag_ingest("./docs")
```

Este flow se puede desplegar con `prefect deploy` y programar (nightly, o event-driven cuando S3 emite un evento).

**Desglose paso a paso: cómo el orquestador te salva de bugs silenciosos:**

1. **Retries automáticos** (`retries=3, retry_delay_seconds=10`): si S3 falla transitoriamente, no arrastras el error al índice.
2. **Task-level observability**: cada task tiene UI, logs, duración. Un fallo en `parse_and_clean` no bloquea el diagnóstico.
3. **Idempotencia por task**: `parse_and_clean` con el mismo input debe producir el mismo output. Sin esto, un re-run duplica embeddings.
4. **Concurrency limits**: `.map()` paraleliza pero puede saturar la embedding API. Añade `task_runner=ConcurrentTaskRunner(max_workers=4)`.
5. **State transitions visibles**: PENDING → RUNNING → COMPLETED/FAILED. En un cron script Bash, no ves nada de esto.

### 2.4 Presidio: PII detection en 30 líneas

```python
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

text = (
    "Hi, I'm Alice Johnson, my email is alice.j@example.com "
    "and my SSN is 123-45-6789. Call me at +1-415-555-2020."
)

results = analyzer.analyze(text=text, language="en")
anonymized = anonymizer.anonymize(
    text=text, analyzer_results=results,
    operators={
        "EMAIL_ADDRESS": OperatorConfig("replace", {"new_value": "[EMAIL]"}),
        "PHONE_NUMBER": OperatorConfig("replace", {"new_value": "[PHONE]"}),
        "US_SSN":        OperatorConfig("replace", {"new_value": "[SSN]"}),
        "PERSON":        OperatorConfig("mask", {"masking_char": "*", "chars_to_mask": 6, "from_end": False}),
    },
)
print(anonymized.text)
# → "Hi, I'm ****** Johnson, my email is [EMAIL] and my SSN is [SSN]. Call me at [PHONE]."
```

Presidio es extensible: puedes añadir recognizers custom (IDs corporativos, formatos regionales) y usar spaCy modelos en 20+ idiomas.

**Ejemplo: recognizer custom para DNI español (con checksum):**

```python
from presidio_analyzer import Pattern, PatternRecognizer
DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE"

class SpanishDNIRecognizer(PatternRecognizer):
    def __init__(self):
        pattern = Pattern("DNI", r"\b\d{8}[A-Za-z]\b", 0.4)
        super().__init__(supported_entity="ES_DNI", patterns=[pattern],
                         supported_language="es")
    def validate_result(self, pattern_text: str) -> bool:
        num, letter = int(pattern_text[:8]), pattern_text[8].upper()
        return DNI_LETTERS[num % 23] == letter  # checksum oficial

analyzer.registry.add_recognizer(SpanishDNIRecognizer())
```

Con `validate_result`, el score sube a alto solo cuando el checksum es válido; evita false positives con cualquier `12345678X`.

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Dedup con MinHash + LSH

Deduplicar 5 millones de documentos con hash exacto captura duplicados literales (30% típico en corpus corporativos). Los **near-duplicates** (mismo doc con typo, timestamp distinto, sección añadida) requieren MinHash + LSH. La complejidad naïve sería O(n²) = 25 billones de comparaciones para 5M docs; LSH reduce a O(n) probabilístico.

```python
from datasketch import MinHash, MinHashLSH

def minhash_of(text: str, num_perm: int = 128) -> MinHash:
    m = MinHash(num_perm=num_perm)
    # 5-grams de palabras
    tokens = text.lower().split()
    for i in range(len(tokens) - 4):
        m.update(" ".join(tokens[i:i+5]).encode("utf-8"))
    return m

lsh = MinHashLSH(threshold=0.85, num_perm=128)
docs = load_docs()   # tu iterador de docs

# Insertar todos
for doc in docs:
    lsh.insert(doc["id"], minhash_of(doc["text"]))

# Query: para cada doc, ¿hay near-dup previo?
seen = set()
kept = []
for doc in docs:
    m = minhash_of(doc["text"])
    dups = lsh.query(m)
    canonical = min([d for d in dups if d in seen], default=None)
    if canonical is None:
        seen.add(doc["id"])
        kept.append(doc)
    else:
        # decide: mantener el más reciente, guardar el ID descartado para audit
        pass
```

Consideraciones prácticas:
- Threshold Jaccard 0.8-0.9 típico para near-dup textual.
- Al descartar, preserva la versión **más reciente** y guarda IDs eliminados en audit log.
- Considera "canonical URL": el mismo doc en varias ubicaciones debería tener un URL canónico.
- Common Crawl y HuggingFace publican sus pipelines de dedup con MinHash + LSH como referencia.

### 3.2 PII en training vs PII en RAG

Distinción crítica que muchas empresas confunden:

| Vector | PII en training | PII en RAG |
|---|---|---|
| ¿Dónde vive? | En los pesos del modelo | En chunks/embeddings del vector store |
| ¿Se puede borrar? | Prácticamente no (requiere re-training) | Sí, borrando chunks + embeddings |
| ¿Right to erasure viable? | Muy difícil (debate legal ongoing) | Sí, con workflow adecuado |
| Riesgo de leak | Training data extraction attacks | Prompt injection, response leak, authorization gap |
| Defensa principal | Redaction ANTES del training | Redaction ANTES del index + auth en retrieval |

La afirmación "como usamos Claude vía API + RAG, no tenemos riesgo de PII" es peligrosamente incompleta. RAG evita el problema de pesos pero introduce **runtime exposure**: el chunk viaja al vendor LLM (posible log si no activaste zero-retention), aparece en el prompt (posible injection), y puede salir en la respuesta. Además, RAG sin **row-level security en el retrieval** puede devolver chunks a usuarios que no tenían permisos originales sobre el doc (el incidente documentado de Slack AI en 2024 fue exactamente eso).

### 3.3 Defensa en profundidad para PII

Capas mínimas en 2026:

1. **Detection en ingest**: Presidio, AWS Comprehend, Google Cloud DLP, Azure AI Language PII, Bedrock Guardrails PII.
2. **Redaction o pseudonymization**: reemplazar con tokens o hash reversible en vault seguro.
3. **Validation en CI**: tests que fallan si detectan PII no redactada en el índice.
4. **Row-level filtering ANTES del retrieval**: `filter={"tenant_id": user.tenant, "acl": {"$in": user.groups}}` en el vector search.
5. **Response filtering post-generación**: detectar PII en output y bloquear o redactar.
6. **Vendor zero-retention**: contratos con OpenAI/Anthropic/AWS que garanticen no retention.
7. **Right-to-erasure workflow**: mapping `user_id → chunks + embeddings + original files`, cascade delete + re-index.
8. **Audit logging**: cada retrieval y generation registrado con user, query, chunks devueltos.

### 3.4 Versionado de datasets: DVC, LakeFS, Delta Lake

Git funciona para código; no funciona para datasets multi-GB. Herramientas específicas:

| Herramienta | Modelo | Fortaleza | Cuándo |
|---|---|---|---|
| **DVC** | Git-like para data | Pointers en git + blob en S3/GCS | ML models + datasets asociados |
| **LakeFS** | Git-like sobre data lakes | Branches, commits atómicos sobre S3 | Data lake versionado |
| **Delta Lake** | Table format con time travel | ACID transactions, streaming | Analytics + ML sobre Spark |
| **Iceberg** | Table format | Multi-engine (Spark, Trino, Flink) | Enterprise multi-engine |
| **Hudi** | Table format | Upserts eficientes | CDC pipelines |
| **MLflow** | Experiment tracking | Runs + params + datasets | Experimentation ML |
| **W&B Artifacts** | Versioning + lineage | UI + colaboración | Research workflows |

Ejemplo DVC:

```bash
# Inicializar
git init && dvc init
git add .dvc .gitignore && git commit -m "init dvc"

# Configurar remote (S3)
dvc remote add -d s3remote s3://mycompany-ml-datasets/rag
dvc remote modify s3remote region eu-west-1

# Versionar un dataset
dvc add data/rag_corpus_v3/
git add data/rag_corpus_v3.dvc data/.gitignore
git commit -m "add rag_corpus_v3"
dvc push

# Reproducir versión anterior
git checkout <commit_anterior>
dvc pull
# ahora data/rag_corpus_v3/ contiene la versión de ese commit
```

Sin versionado de datasets, EU AI Act **Art. 12 (logging obligations)** es imposible de cumplir para modelos entrenados o fine-tuned: no puedes demostrar con qué datos exactos se entrenó cada versión.

### 3.5 Data lineage: OpenLineage, Marquez, DataHub

Data lineage es la traza desde el dato de origen hasta el dato usado en decisión o respuesta, incluyendo todas las transformaciones. Sin lineage:

- **Debugging es misterio**: no puedes reconstruir de dónde vino un número mal.
- **Compliance falla**: auditoría GDPR y EU AI Act exigen trazabilidad.
- **Impact analysis imposible**: si borro este source, no sabes qué se rompe.
- **Right-to-erasure ineficiente**: no sabes dónde vive el dato del usuario X.

Capas de lineage:

1. **Table lineage**: tabla A alimenta tabla B.
2. **Column lineage**: columna x deriva de x1 + x2.
3. **Transform lineage**: qué código SQL/Python transformó.
4. **Run lineage**: qué corrida específica produjo un dato.

Herramientas:

- **OpenLineage**: especificación abierta.
- **Marquez**: implementación de referencia de OpenLineage.
- **DataHub** (LinkedIn open-source): catálogo + lineage + governance.
- **Amundsen** (Lyft open-source): catálogo con búsqueda.
- **Apache Atlas**: en entornos Hadoop.
- **Datadog Data Streams**, **Monte Carlo**, **Acceldata**: observability comerciales.

Para RAG específicamente: cada chunk lleva `source_id + doc_hash + ingestion_run_id`. Cada respuesta incluye citations con esos IDs. Cada training run registra dataset version. Ese es el lineage mínimo.

### 3.6 EU AI Act: categorías de riesgo

El Regulation 2024/1689 define cuatro categorías:

**Nivel 1 — Unacceptable (prohibidas, Art. 5).** Vigente desde 2 feb 2025. Incluye: social scoring por gobiernos, manipulación subliminal, explotación de vulnerabilidades (menores, discapacidad), categorización biométrica por raza/religión/orientación, real-time remote biometric ID en espacios públicos (con excepciones estrictas para law enforcement), predicción de comportamiento criminal basada en perfilado. **Multa hasta 35 M EUR o 7%** del turnover global.

**Nivel 2 — High-risk (Chapter III, Annex III).** Aplicable desde 2 ago 2026. Sistemas usados en: biometrics, infraestructura crítica, educación (admisiones, evaluación), empleo (hiring, promoción, monitoring), servicios esenciales (credit scoring, health insurance), law enforcement, migración, administración de justicia, procesos democráticos. Obligaciones extensas (§4.2).

**Nivel 3 — Limited (transparency, Art. 50).** Aplicable desde 2 ago 2026. Chatbots deben identificarse como IA salvo que sea obvio; deepfakes y contenido sintético (imagen, audio, texto generado) deben marcarse como tal; emotion recognition debe informar al usuario. **Multa hasta 15 M EUR o 3%.** Nota importante: hay periodo transitorio hasta **2 diciembre 2026** para etiquetado de contenido de sistemas generativos ya en mercado, pero contenido publicado antes del 2 ago 2026 no requiere etiquetado retroactivo.

**Nivel 4 — Minimal.** Sin obligaciones legales, código de conducta voluntario. Ejemplo: filtros de spam, mejora de imagen en cámaras.

Casos aplicados:

| Sistema | Categoría | Razón |
|---|---|---|
| Chatbot FAQ interno | Limited (Art. 50) | Debe declarar "soy IA" |
| Scoring crediticio para préstamos | High-risk (Annex III §5(b)) | Servicios esenciales |
| Juguete que "habla" con niños | High-risk / Unacceptable-adjacent | Menores + safety |
| Feature de mejora de imagen | Minimal | Sin riesgo relevante |
| Herramienta de screening de CV | High-risk (Annex III §4) | Employment |
| Deepfake generator sin marcar | Limited pero infringiendo Art. 50 | Requiere marking |
| Bot chat asistente de compras | Limited (Art. 50) | Debe declarar IA |
| Motor de matching de tutorías educativas | High-risk (Annex III §3) | Educación (admission-adjacent) |
| Predicción de rotación de empleados | High-risk (Annex III §4) | Employment monitoring |
| Sistema de detección de fraude en tarjetas | High-risk (Annex III §5(b)) | Servicios esenciales |

### 3.7 Bajo el capó: cómo un right-to-erasure real funciona end-to-end

Cuando un usuario ejerce Art. 17 GDPR ("borra mis datos"), un pipeline RAG maduro dispara una cascada. Diagrama:

```
User request         Support tool           Backend workflow                  Stores afectados
     │                    │                        │                                   │
     │ "borra mis datos"  │                        │                                   │
     │───────────────────▶│                        │                                   │
     │                    │ crea ticket + user_id  │                                   │
     │                    │───────────────────────▶│                                   │
     │                    │                        │ 1. lookup user en identity DB     │
     │                    │                        │────────────────────────────▶ (Postgres users)
     │                    │                        │ 2. buscar chunks con user_id      │
     │                    │                        │────────────────────────────▶ (Chroma/Pinecone)
     │                    │                        │ 3. delete chunks + embeddings     │
     │                    │                        │────────────────────────────▶ (vector store)
     │                    │                        │ 4. lookup docs originales         │
     │                    │                        │────────────────────────────▶ (S3 originales)
     │                    │                        │ 5. delete originales              │
     │                    │                        │────────────────────────────▶ (S3)
     │                    │                        │ 6. purga caches (Redis, CDN)      │
     │                    │                        │────────────────────────────▶ (Redis)
     │                    │                        │ 7. append audit log inmutable     │
     │                    │                        │────────────────────────────▶ (WORM S3)
     │                    │                        │ 8. notifica al usuario            │
     │◀───────────────────│◀───────────────────────│                                   │
```

**Puntos críticos que se rompen en producción:**

- **Chunks huérfanos**: si el vector store no soporta `where` filter en delete (Chroma antiguo, algunas versiones de Pinecone), tienes que iterar. Costo alto.
- **Backups**: los backups automáticos de tu vector store también contienen los chunks. GDPR permite un tiempo razonable para propagar pero no indefinido; documenta política.
- **Modelos entrenados con esos datos**: aquí GDPR se vuelve intratable. La única defensa es no haber entrenado con PII (ver §4.6).
- **Cache CDN**: si tu API cachea responses con el chunk citado, ese cache debe invalidarse. Fácil de olvidar.
- **Logs**: audit logs de retrieval que citan el chunk contienen indirectamente PII. Depende de jurisdicción: en general, logs de compliance tienen base legal propia (Art. 6(1)(c) GDPR).

**Coste típico documentado (2025-2026):** una empresa mid-market gasta $2k-$8k/año en workflow de right-to-erasure para un pipeline RAG con 10-100M chunks. No es opcional.

### 3.8 Tabla comparativa extendida: vector stores por soporte de governance

| Vector store | Filter en delete | Row-level ACL nativo | Audit log integrado | Multi-tenant seguro | Backup GDPR-aware |
|---|---|---|---|---|---|
| **Pinecone** | Sí (namespace + metadata filter) | Namespaces (aislamiento) | Vía CloudWatch/Datadog | Sí (namespaces) | Configurable |
| **Qdrant** | Sí (payload filter) | Vía payload + app-side check | Logs de servidor | Sí (collections) | Snapshots granulares |
| **Weaviate** | Sí (where filter) | Multi-tenancy nativo (v1.20+) | Sí (Kafka out) | Sí, first-class | Sí |
| **Chroma** | Sí (v0.5+) | Manual app-side | Manual | Débil (collections) | Manual |
| **pgvector** | Sí (SQL WHERE) | RLS de Postgres | Postgres logs / pgAudit | Sí (schemas / RLS) | pg_dump estándar |
| **Milvus** | Sí (expr filter) | Vía RBAC | Sí (audit log) | Sí (databases) | Sí |
| **OpenSearch** | Sí (query DSL) | Fine-grained access control | Sí | Sí (indices) | Snapshots |
| **MongoDB Atlas VS** | Sí (query) | RBAC + views | Atlas audit | Sí | Sí |
| **Redis Stack** | Sí (FT.SEARCH filter) | ACL | Vía enterprise | Débil | Manual |

Para producción regulada, **pgvector + RLS** o **Weaviate con multi-tenancy** son las opciones con menor overhead de compliance.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Timeline completo EU AI Act

| Fecha | Fase |
|---|---|
| **1 ago 2024** | Reglamento en vigor |
| **2 feb 2025** | Capítulo II: prácticas prohibidas Art. 5 + AI literacy |
| **2 ago 2025** | Capítulo V: obligaciones GPAI, penalties framework, autoridades nacionales |
| **2 ago 2026** | Capítulo III: obligaciones sistemas high-risk + Art. 50 transparency + AI Office con poderes plenos |
| **2 dic 2026** | Fin del periodo transitorio de marking para GPAI ya en mercado |
| **2 ago 2027** | Modelos GPAI colocados antes de 2 ago 2025 deben cumplir |

En 2026 (fecha de este capítulo), el enforcement de Art. 50 y high-risk está **activo**. Los primeros casos test probablemente sean chatbots sin disclosure y deepfakes sin marking, siguiendo el patrón de GDPR (primero small violations para setup precedente, luego escalation).

### 4.2 Obligaciones para high-risk providers (Chapter III)

Diez pilares textuales (Arts. 8-21):

1. **Risk management system**: identificación, evaluación y mitigación continua de riesgos.
2. **Data governance**: calidad de training/validation/test data, bias testing, representatividad.
3. **Technical documentation** (Annex IV): arquitectura, algoritmos, training data, limitaciones, foreseeable misuse.
4. **Automatic logging**: registros para auditabilidad.
5. **Transparency + instructions for use**: deployers deben entender el sistema.
6. **Human oversight** (Art. 14): un humano puede supervisar, intervenir y anular.
7. **Accuracy, robustness, cybersecurity** (Art. 15): métricas y protecciones.
8. **Quality management system**: proceso interno (mapea bien a ISO 42001).
9. **Conformity assessment**: interna para la mayoría, third-party para biometrics. Registro obligatorio en EU database (Art. 71) ANTES de colocar en mercado.
10. **Post-market monitoring** + reporte de incidentes graves.

Providers no-EU deben appointar authorized representative en EU (Art. 22).

### 4.3 GPAI: obligaciones y systemic risk

**Todos los GPAI providers** (Art. 53) deben:

- Documentación técnica del modelo (Annex XI).
- Info + docs para downstream providers (Annex XII).
- Policy de copyright compliance (respeto a opt-outs de text and data mining, Directive 2019/790 Art. 4(3)).
- Resumen público del training data (template Commission).

**GPAI con systemic risk** (Art. 51 y 55): superan el threshold de **10^25 FLOPs** de compute usado en training (aprox class GPT-4, Claude Sonnet, Gemini 1.5). Obligaciones adicionales:

- Model evaluation con adversarial testing (red teaming).
- Risk assessment y mitigación de systemic risks.
- Tracking y reporte de incidentes serios.
- Cybersecurity para el modelo y su infra.

**Open source exemption parcial** (Art. 53(2)): modelos liberados free y open están exentos de documentación técnica e info para downstream, **pero NO de systemic risk obligations si califican, ni de copyright policy, ni de resumen de training data**.

Cumplir con el **Code of Practice** (voluntario, publicado 2024, actualizado 2025) confiere **presunción de conformidad**. Anthropic, OpenAI, Google y varios más lo firmaron; Meta rechazó por "over-reach".

### 4.4 Providers vs Deployers: cadena de accountability

Un actor puede tener múltiples roles a lo largo de la cadena. Ejemplo típico:

- **Anthropic**: provider de GPAI (Claude).
- **Startup SaaS que ofrece "sales insights" con Claude API**: deployer de Claude Y provider del sistema resultante (obligaciones duplicadas).
- **Empresa cliente que usa las insights para decisiones de hiring**: deployer del sistema high-risk.

Cada rol tiene obligaciones distintas. Deployers (Art. 26):

- Seguir instrucciones del provider.
- Human oversight.
- Monitor performance.
- Log-keeping (6 meses mínimo).
- DPIA si procesa personal data.
- Informar a trabajadores si aplica en workplace.
- Transparency a affected persons.

**Substantial modification** (Art. 25): quien modifica sustancialmente un sistema high-risk (fine-tune profundo, cambio de intended purpose) **asume rol de provider** del sistema modificado.

### 4.5 Estructura de multas Art. 99

| Tier | Violación | Multa (whichever higher) |
|---|---|---|
| **Tier 1** | Prácticas prohibidas Art. 5 | **35 M EUR o 7% turnover global** |
| **Tier 2** | Non-compliance Chapter III (high-risk), V (GPAI), IV (Art. 50 transparency) | **15 M EUR o 3%** |
| **Tier 3** | Info engañosa a autoridades | **7.5 M EUR o 1%** |

Para SMEs y startups aplica **whichever is LOWER** para evitar destruction of business. Multas nacionales adicionales pueden acumularse. GPAI providers específicos (Art. 101) pueden ser multados por non-cooperation con AI Office.

### 4.6 GDPR + AI: el problema irresoluble del derecho al olvido

GDPR Art. 17 da al individuo el derecho a que sus datos personales sean borrados. Con un modelo entrenado, esto es **prácticamente imposible**: los datos están difundidos en billones de pesos y no hay técnica production-ready para borrar información específica sin re-training. Debate legal ongoing; posiciones actuales:

- Autoridades tienden a exigir que se **evite el training con PII** desde el inicio.
- **Machine unlearning** es campo de investigación activa pero no production-ready para LLMs frontier.
- Con RAG, el problema es tractable: borra chunks + embeddings + original + re-index.

Regla de oro: **si puedes evitar PII en training, evítala**. Redacta agresivamente antes de que entre en el dataset.

### 4.7 Frameworks complementarios: NIST AI RMF, ISO 42001

- **NIST AI RMF 1.0** (2023, GenAI Profile 2024): framework voluntario US, cuatro funciones (Govern, Map, Measure, Manage). Mapea bien a Chapter III de EU AI Act.
- **ISO/IEC 42001** (2023): primera norma internacional para AI Management System, auditable estilo ISO 9001. Cubre el "quality management system" requerido por EU AI Act.
- **ISO/IEC 23894** (2023): guidance sobre risk management de IA.
- **ISO/IEC 42005** (2025): AI system impact assessment.
- **Model cards** (Google 2019): documentación estructurada de modelo (intended use, limitations, metrics, ethical considerations). Adoptado por HuggingFace, Meta, muchos.
- **Datasheets for datasets** (MIT 2018): documentación estructurada de dataset (motivation, composition, collection, uses).

Adoptar estos frameworks no exime de EU AI Act pero **acelera compliance** y estructura la conversación con legal, security y auditores.

### 4.8 Anti-patrones frecuentes

| ❌ Antipatrón | ✅ Alternativa |
|---|---|
| "Solo subir PDFs a Pinecone y ya" | Pipeline canónico 5 fases con metadata |
| Regex casero para PII | Presidio / Comprehend / DLP con NER |
| "No entrenamos, no hay riesgo PII" | Defense in depth también para RAG |
| Encryption at rest sustituyendo redaction | Redaction PLUS encryption |
| Git para datasets multi-GB | DVC / LakeFS / Delta Lake |
| Sin data lineage | OpenLineage + citations con source_id |
| "Todo es minimal risk" sin análisis | Clasificar formalmente cada sistema en las 4 categorías EU AI Act |
| Ignorar substantial modification (Art. 25) | Auditar cuándo fine-tune convierte deployer en provider |
| RAG sin row-level filtering por permisos | Filter en retrieval antes de recuperar |
| Sin audit log de retrieval y generation | Log de user + query + chunks devueltos |
| Sin right-to-erasure workflow | Mapping user_id → chunks + cascade delete |
| "Legal se ocupa de compliance, no yo" | AI Act obliga a providers técnicos también |

---

## 5. Ejemplo práctico completo: pipeline RAG con PII redaction, chunking, embeddings y lineage

Objetivo: pipeline Python que ingesta docs Markdown desde S3, aplica Presidio PII redaction, chunkea jerárquicamente, embebe con OpenAI, indexa en Chroma con metadatos de lineage y audit log. Reproducible localmente.

**Por qué este stack.**
- **Prefect**: retries + observability sin salir de Python.
- **Presidio**: PII detection open-source, extensible, multi-idioma.
- **LangChain splitters**: chunking jerárquico maduro sin escribir el algoritmo desde cero.
- **Chroma**: vector store simple para local, misma interfaz que Pinecone en LangChain (fácil migración).
- **Audit log JSONL local**: en prod se sustituye por CloudWatch / DataHub, pero el shape del record es el mismo.

```python
# rag_pipeline.py
from __future__ import annotations
import hashlib, json, os, uuid, logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from prefect import flow, task, get_run_logger
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig
from langchain.text_splitter import (
    MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter,
)
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_core.documents import Document

logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------
# Setup engines (una vez)
# ---------------------------------------------------------------
_analyzer = AnalyzerEngine()
_anonymizer = AnonymizerEngine()
_pii_operators = {
    "EMAIL_ADDRESS": OperatorConfig("replace", {"new_value": "[EMAIL]"}),
    "PHONE_NUMBER":  OperatorConfig("replace", {"new_value": "[PHONE]"}),
    "US_SSN":        OperatorConfig("replace", {"new_value": "[SSN]"}),
    "CREDIT_CARD":   OperatorConfig("replace", {"new_value": "[CC]"}),
    "IP_ADDRESS":    OperatorConfig("replace", {"new_value": "[IP]"}),
    "PERSON":        OperatorConfig("replace", {"new_value": "[NAME]"}),
    "LOCATION":      OperatorConfig("replace", {"new_value": "[LOC]"}),
    "DATE_TIME":     OperatorConfig("keep"),         # fechas suelen no ser PII
}

# Audit log en archivo local (en prod: CloudWatch, ELK, DataHub)
AUDIT_LOG = Path("./audit.log.jsonl")

def audit(event: str, **fields: Any) -> None:
    fields.update({
        "event": event,
        "ts": datetime.now(timezone.utc).isoformat(),
    })
    with AUDIT_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(fields, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------

@task
def list_sources(folder: str) -> list[str]:
    files = sorted(str(p) for p in Path(folder).glob("**/*.md"))
    audit("list_sources", folder=folder, count=len(files))
    return files


@task(retries=2, retry_delay_seconds=5)
def load_and_hash(path: str) -> dict[str, Any]:
    # Retry por si S3 / FS falla transitoriamente
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError) as e:
        # Errores no-retriables: fallar rápido, no gastar retries
        audit("load_error", source=path, error=str(e))
        raise
    # Hash SHA256 sirve como identidad y para detectar drift (mismo path, distinto contenido)
    h = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return {"source": path, "raw": text, "doc_hash": h}


@task
def redact_pii(doc: dict[str, Any], language: str = "en") -> dict[str, Any]:
    # 1. Analyze: encuentra entidades PII con scores
    findings = _analyzer.analyze(text=doc["raw"], language=language)
    # 2. Anonymize: aplica operators (replace, mask, hash)
    anonymized = _anonymizer.anonymize(
        text=doc["raw"], analyzer_results=findings, operators=_pii_operators,
    )
    doc["text"] = anonymized.text
    # Guardamos entidades como metadata (sin texto original) para auditoría
    doc["pii_entities"] = [
        {"type": f.entity_type, "start": f.start, "end": f.end, "score": f.score}
        for f in findings
    ]
    # Verificación intermedia: si detectas 0 entidades en texto que sabías tenía PII, algo va mal
    # Ejemplo: cambio de idioma sin cambiar language= → recall cae a ~10%
    audit(
        "redact_pii",
        source=doc["source"],
        doc_hash=doc["doc_hash"],
        entities_found=len(findings),
        entity_types=sorted({f.entity_type for f in findings}),
    )
    return doc


@task
def chunk_hierarchical(
    doc: dict[str, Any], parent_size: int = 1500, child_size: int = 350, overlap: int = 60,
) -> list[Document]:
    """Chunking jerárquico: parents grandes + children pequeños ligados por parent_id."""
    header_splitter = MarkdownHeaderTextSplitter(
        headers_to_split_on=[("#", "h1"), ("##", "h2"), ("###", "h3")]
    )
    parent_splitter = RecursiveCharacterTextSplitter(
        chunk_size=parent_size, chunk_overlap=overlap
    )
    child_splitter = RecursiveCharacterTextSplitter(
        chunk_size=child_size, chunk_overlap=overlap // 3
    )

    header_chunks = header_splitter.split_text(doc["text"])
    parents = parent_splitter.split_documents(header_chunks)

    documents: list[Document] = []
    for parent in parents:
        parent_id = str(uuid.uuid4())
        for child_text_doc in child_splitter.split_documents([parent]):
            meta = {
                # Lineage
                "source_id": doc["source"],
                "doc_hash": doc["doc_hash"],
                "parent_id": parent_id,
                "parent_text": parent.page_content,
                "chunk_id": str(uuid.uuid4()),
                "ingestion_run_id": os.environ.get("PREFECT_FLOW_RUN_ID", "local"),
                # Governance
                "pii_redacted": True,
                "pii_entity_types": ",".join(
                    sorted({e["type"] for e in doc["pii_entities"]})
                ),
                # Content
                "language": "en",
                "headers": {
                    k: v for k, v in (child_text_doc.metadata or {}).items()
                    if k.startswith("h")
                },
            }
            documents.append(Document(page_content=child_text_doc.page_content, metadata=meta))

    audit(
        "chunk_hierarchical",
        source=doc["source"], doc_hash=doc["doc_hash"],
        n_parents=len(parents), n_children=len(documents),
    )
    return documents


@task
def embed_and_index(
    chunks: list[Document], collection: str = "docs", persist_dir: str = "./chroma_db",
) -> int:
    if not chunks:
        return 0
    emb = OpenAIEmbeddings(model="text-embedding-3-large")
    vs = Chroma(
        collection_name=collection, embedding_function=emb, persist_directory=persist_dir,
    )
    ids = [c.metadata["chunk_id"] for c in chunks]
    vs.add_documents(chunks, ids=ids)
    audit(
        "embed_and_index",
        collection=collection, indexed=len(chunks),
        embedding_model="text-embedding-3-large",
    )
    return len(chunks)


# ---------------------------------------------------------------
# Flow principal + workflow de derecho al olvido
# ---------------------------------------------------------------

@flow(name="rag-ingest-governed")
def rag_ingest(folder: str = "./docs", collection: str = "docs") -> int:
    log = get_run_logger()
    files = list_sources(folder)
    total = 0
    for f in files:
        doc = load_and_hash(f)
        doc = redact_pii(doc, language="en")
        chunks = chunk_hierarchical(doc)
        n = embed_and_index(chunks, collection=collection)
        log.info(f"{f}: {n} chunks indexed")
        total += n
    log.info(f"TOTAL indexed: {total}")
    return total


@flow(name="right-to-erasure")
def erase_source(source_id: str, collection: str = "docs", persist_dir: str = "./chroma_db"):
    """Borra todos los chunks + embeddings asociados a un source específico."""
    emb = OpenAIEmbeddings(model="text-embedding-3-large")
    vs = Chroma(
        collection_name=collection, embedding_function=emb, persist_directory=persist_dir,
    )
    # Chroma soporta where filter en delete
    vs.delete(where={"source_id": source_id})
    audit("right_to_erasure", source_id=source_id, collection=collection)


if __name__ == "__main__":
    rag_ingest("./docs")
```

**Cómo probarlo localmente:**

```bash
# 1) Preparar docs de prueba
mkdir -p ./docs
cat > ./docs/policy.md <<'EOF'
# Refund policy

If you're not satisfied, contact us at support@example.com or +1-555-2020.
Our customer Alice Johnson opened a case regarding order #12345.
EOF

# 2) Ejecutar
export OPENAI_API_KEY="sk-..."
python rag_pipeline.py

# 3) Inspeccionar audit log
cat audit.log.jsonl | python -m json.tool -

# 4) Verificar PII redactada en el índice (query manual)
python - <<'PY'
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma
vs = Chroma(collection_name="docs", embedding_function=OpenAIEmbeddings(model="text-embedding-3-large"), persist_directory="./chroma_db")
for doc in vs.similarity_search("refund policy contact", k=3):
    print(doc.page_content)
    print("meta:", {k: v for k, v in doc.metadata.items() if k in ("source_id", "pii_entity_types", "parent_id")})
    print("---")
PY

# 5) Ejercer derecho al olvido
python - <<'PY'
from rag_pipeline import erase_source
erase_source("./docs/policy.md")
PY
```

**Qué demuestra el ejemplo:**

- Cinco fases del pipeline canónico.
- PII redaction obligatoria antes del index.
- Chunking jerárquico con parent_id para expandir contexto.
- Metadata rica con lineage (source_id, doc_hash, parent_id, ingestion_run_id).
- Audit log con timestamp de cada operación.
- Workflow de right-to-erasure via cascade delete por metadata filter.

En producción se sustituyen: Chroma → Pinecone/Qdrant/pgvector, audit local → CloudWatch/DataHub/OpenLineage, Presidio local → Presidio Kubernetes deployment o AWS Comprehend, Prefect local → Prefect Cloud / Airflow / Dagster.

**Manejo de errores comunes durante primer run:**

- `spaCy model not found: en_core_web_lg`: falta el modelo. `python -m spacy download en_core_web_lg`.
- `openai.RateLimitError`: OpenAI rate limit. Solución: `OpenAIEmbeddings(request_timeout=60, max_retries=5)`.
- `Chroma: sqlite3.OperationalError: database is locked`: dos procesos escribiendo. Usa `persist_directory` distinto o migra a Chroma HTTP server.
- Audit log crece rápido en corpus grande: rota diario (`audit.log.jsonl.2026-08-13`) o usa CloudWatch Logs con retention.
- `pii_entities` vacío en texto claramente con PII: revisa `language` param; español requiere `es_core_news_lg` y `language="es"`.

### Extendiendo el ejemplo

Tres mejoras para llevar el pipeline de demo a producción:

**Mejora 1 — Dedup con MinHash antes del chunking.** Un corpus corporativo típico tiene 20-40% de near-duplicates. Sin dedup, embebes lo mismo N veces, aumentas coste y contaminas retrieval con top-k redundante.

```python
from datasketch import MinHash, MinHashLSH

lsh = MinHashLSH(threshold=0.85, num_perm=128)
_seen: set[str] = set()

@task
def dedupe_check(doc: dict) -> dict | None:
    m = MinHash(num_perm=128)
    for token in doc["text"].split():
        m.update(token.encode("utf-8"))
    if lsh.query(m):
        audit("dedup_skipped", source=doc["source"], doc_hash=doc["doc_hash"])
        return None    # skip
    lsh.insert(doc["source"], m)
    return doc
```

Inserta este task entre `redact_pii` y `chunk_hierarchical`. Mide impacto: en Klarna documentaron 32% menos chunks embebidos y mejor precision@5.

**Mejora 2 — Row-level filter en retrieval por tenant.** El bug de Slack AI 2024 fue exactamente esto. Añade `tenant_id` y `acl_groups` en metadata, y filtra en cada query:

```python
def secure_search(query: str, user):
    return vs.similarity_search(
        query, k=5,
        filter={"$and": [
            {"tenant_id": user.tenant_id},
            {"acl_groups": {"$in": user.groups}},
        ]},
    )
```

Test obligatorio: crea 2 tenants con docs distintos y verifica que user_A jamás recupera chunks de tenant_B, incluso con queries diseñadas para hacerlo (prompt injection).

**Mejora 3 — Lineage a OpenLineage / DataHub.** Sustituye el `audit()` local por eventos OpenLineage:

```python
from openlineage.client import OpenLineageClient, RunEvent, Job, Run
client = OpenLineageClient.from_environment()  # lee OPENLINEAGE_URL

def emit_lineage(job_name: str, inputs: list[str], outputs: list[str], run_id: str):
    client.emit(RunEvent(
        eventType="COMPLETE", eventTime=datetime.utcnow().isoformat(),
        run=Run(runId=run_id), job=Job(namespace="rag", name=job_name),
        inputs=[{"namespace": "s3", "name": i} for i in inputs],
        outputs=[{"namespace": "chroma", "name": o} for o in outputs],
        producer="rag_pipeline",
    ))
```

En Marquez / DataHub UI ves el grafo completo `S3 doc → chunks → embeddings → chroma collection`. Auditor GDPR/EU AI Act lo pide en 15 minutos, no en 15 días.

---

## 6. Cheatsheet, reglas mentales y anti-patrones

### 6.1 Tabla de decisión rápida

| Necesidad | Herramienta / técnica |
|---|---|
| Orquestador para RAG batch | Prefect o Dagster (moderno); Airflow si legacy |
| Orquestador para pipelines K8s heterogéneos | Argo Workflows |
| PII detection general | Microsoft Presidio |
| PII managed AWS | AWS Comprehend + Bedrock Guardrails PII |
| PII multi-idioma con edge cases | Google Cloud DLP (100+ info types) |
| Dedup exacto | SHA256 hash |
| Dedup near-dup a escala | MinHash + LSH (datasketch, Spark MinHashLSH) |
| Versionado dataset | DVC (ML), LakeFS (data lake), Delta Lake (analytics) |
| Data lineage | OpenLineage + Marquez, DataHub, Amundsen |
| Framework compliance voluntario | NIST AI RMF (US), ISO 42001 (internacional) |
| Documentación de modelo | Model cards (Google/HuggingFace) |
| Documentación de dataset | Datasheets for Datasets (MIT) |

### 6.2 Reglas mentales

- **Un pipeline sin las 5 fases (ingest→clean→chunk→embed→index) tiene bugs latentes.**
- **PII en RAG requiere defense in depth**: detection + redaction + row-level filter + response filter + audit + zero-retention con vendor.
- **PII en training es prácticamente irreversible**: mejor no dejarla entrar.
- **Versiona todo lo que impacte reproducibilidad**: dataset, embedding model, chunking params, code.
- **Lineage no es overhead: es prerequisito de compliance.**
- **Clasifica formalmente cada feature en categorías EU AI Act.** No hacerlo no te exime.
- **Si fine-tuneas, revisa Art. 25 (substantial modification)**: puedes convertirte en provider high-risk.
- **Provider vs deployer: puedes ser ambos simultáneamente.**
- **10^25 FLOPs es el threshold GPAI systemic risk.** Aplica si entrenaste algo de esa escala.
- **Registro EU database (Art. 71) antes de mercado** para high-risk. No después.

### 6.3 Anti-patrones ✅/❌

✅ Pipeline con 5 fases explícitas y metadata rica.
✅ Presidio (u equivalente managed) en ingest, no en query time.
✅ Dedup con hash + MinHash antes de embed.
✅ Chunking jerárquico o semántico, con overlap.
✅ Metadata con `source_id`, `doc_hash`, `permissions`, `tenant`, `ingestion_run_id`.
✅ Row-level filter en retrieval por tenant/ACL.
✅ Audit log de retrieval y generation.
✅ Right-to-erasure workflow probado.
✅ DVC/LakeFS/Delta Lake para versionar datasets.
✅ Data lineage con OpenLineage + Marquez o equivalente.
✅ Model cards y datasheets publicados para modelos internos.
✅ Clasificación EU AI Act formal por sistema.
✅ Conformity assessment antes de mercado para high-risk.

❌ "Solo subir PDFs a Pinecone y ya."
❌ Regex casero para email/phone como toda la defensa PII.
❌ "No entrenamos, no hay riesgo PII" (RAG tiene runtime exposure).
❌ Encriptación como sustituto de redaction.
❌ Fixed-size chunks de 500 caracteres sin overlap.
❌ Metadata mínima (`{"page": 5}` y ya).
❌ RAG sin row-level filtering por permisos (leak entre tenants).
❌ Sin audit log de retrieval/generation.
❌ Sin workflow right-to-erasure.
❌ Git con LFS para datasets multi-GB.
❌ Ignorar categorías EU AI Act ("nosotros somos minimal").
❌ Fine-tune sustancial sin evaluar substantial modification.
❌ "Legal se ocupa de compliance, no yo." Los deberes de Art. 15 y 12 son técnicos.

---

## 7. Casos reales industria 2026

### 7.1 Slack AI incident (2024): authorization gap en retrieval

**Qué pasó.** En agosto 2024, Slack AI presentó un incidente público: usuarios descubrieron que el asistente podía recuperar y resumir mensajes de canales privados y DMs de otros usuarios dentro del mismo workspace mediante prompts diseñados.

**Cómo se detectó.** Investigadores de PromptArmor publicaron un PoC en un blog técnico. El bug se hizo viral en Hacker News y forzó respuesta oficial en 48h.

**Cómo se arregló.** Slack añadió filtros de permisos a nivel de retrieval y deshabilitó temporalmente ciertas funciones de resumen cross-channel. El postmortem oficial reconoció que el vector store tenía metadata de canal pero la query no filtraba por acceso del user solicitante.

**Qué aprendió la industria.** Row-level filtering en el retrieval es prerrequisito de RAG multi-tenant, no un nice-to-have. Todos los principales vector stores (Pinecone, Weaviate, pgvector, Qdrant) publicaron guías dedicadas en 2024-2025 sobre este patrón.

### 7.2 Samsung ChatGPT ban (2023): PII exfiltration via vendor

**Qué pasó.** En abril 2023, tres incidentes documentados internos en Samsung Electronics: ingenieros pegaron código propietario de semiconductores y transcripciones de reuniones confidenciales en ChatGPT.

**Cómo se detectó.** Auditoría interna de seguridad tras rumor filtrado; Samsung confirmó públicamente los incidentes.

**Cómo se arregló.** Ban interno inmediato de ChatGPT y competidores. Meses después, Samsung anunció desarrollo de su LLM interno con retention off contractual con OpenAI/Anthropic para APIs.

**Qué aprendió la industria.** El "shadow AI" (uso individual de tools consumer) es un vector real. Respuesta industrial: **AI gateways** internos con PII detection y validación antes de enviar a vendor LLMs. Enterprise plans de OpenAI/Anthropic con zero-retention (opt-in) crecieron 300% en 2023-2024.

### 7.3 OpenAI conversation title leak (marzo 2023): rate-limit + Redis cache bug

**Qué pasó.** El 20 de marzo 2023, un bug en el Redis cache de ChatGPT (upgrade de biblioteca redis-py) causó que ~1.2% de usuarios plus vieran títulos (y en algunos casos primeros mensajes) de conversaciones de otros usuarios. Duró ~9 horas antes de que OpenAI apagara el servicio.

**Cómo se detectó.** Tweets de usuarios afectados; escalada rápida en soporte OpenAI.

**Cómo se arregló.** OpenAI reforzó aislación por sesión, publicó postmortem público detallado, notificó a usuarios EU dentro del plazo GDPR 72h.

**Qué aprendió la industria.** Infra convencional (Redis, caches, sesiones) sigue siendo vector de leak incluso cuando el modelo hace bien su trabajo. Auditoría de infra, no solo del modelo. También reforzó la importancia de zero-retention agreements para casos enterprise.

### 7.4 Multa GDPR a chatbot bancario europeo (2024-2025)

**Qué pasó.** Un banco europeo (jurisdicción no publicada por confidencialidad procesal) recibió multa multi-millonaria por decisiones automatizadas de crédito basadas en modelo que no podía demostrar **data lineage** completo.

**Cómo se detectó.** Denuncia de un cliente rechazado que ejerció Art. 22 GDPR ("explícame la decisión"). El banco no pudo reconstruir qué datos alimentaron el modelo ni justificar la lógica.

**Cómo se arregló.** El banco tuvo que suspender el modelo, montar lineage retroactivo (DataHub) y re-entrenar con dataset auditable. Coste total documentado: ~15× la multa original.

**Qué aprendió la industria.** Lineage no es opcional en high-risk. Anticipando EU AI Act Art. 12 (logging obligations) y Art. 13 (transparency), los bancos europeos aceleraron adopción de OpenLineage / DataHub durante 2024-2025.

### 7.5 Firma del Code of Practice GPAI (2024-2025)

**Qué pasó.** La EU Commission publicó el Code of Practice para GPAI providers en 2024, con actualizaciones 2025. Firmaron Anthropic, OpenAI, Google, Microsoft, Mistral y varios más. Meta rechazó por considerarlo "over-reach".

**Cómo se detectó la brecha.** GPAI providers necesitaban ruta para conformity antes de agosto 2025 (fecha aplicabilidad Chapter V). Sin un Code, cada empresa habría hecho su interpretación individual.

**Cómo se arregló.** El Code establece prácticas comunes (documentación técnica formato Annex XI, copyright policy, resumen público de training data). Cumplir confiere **presunción de conformidad**.

**Qué aprendió la industria.** Firmar es apuesta estratégica: reduce riesgo legal individual pero cede algo de flexibilidad. Meta apuesta por litigar en caso de multa; los firmantes apuestan por certeza operativa.

### 7.6 EU AI Act — fases de aplicación y multas Art. 99

**Qué pasó (timeline).** El Reglamento (EU) 2024/1689 entró en vigor el **1 agosto 2024**. Aplicación escalonada:

- **2 feb 2025**: Art. 5 prácticas prohibidas + AI literacy vigentes.
- **2 ago 2025**: obligaciones GPAI providers, penalties framework, autoridades nacionales.
- **2 ago 2026** *(fecha de este capítulo)*: high-risk systems + Art. 50 transparency + AI Office con poderes plenos.
- **2 dic 2026**: fin del periodo transitorio de marking de contenido sintético.
- **2 ago 2027**: modelos GPAI colocados antes de ago 2025 deben cumplir.

**Cómo se detectó la necesidad de escalonamiento.** El primer draft (2021) proponía aplicación inmediata; industry pushback (especialmente sobre GPAI, categoría añadida tras GPT-4) forzó negociación de fases.

**Cómo funcionan las multas Art. 99.**
- Tier 1 (prácticas prohibidas Art. 5): 35M EUR o **7%** turnover global.
- Tier 2 (high-risk / GPAI / Art. 50): 15M EUR o **3%**.
- Tier 3 (info engañosa a autoridades): 7.5M EUR o **1%**.

**Qué aprendió la industria.** Comparado con GDPR (max 4% turnover), EU AI Act es más severo en Tier 1. Las primeras multas 2026-2027 probablemente sean sobre Art. 50 (chatbots sin disclosure) como testcase, por analogía con los primeros casos GDPR.

### 7.7 Klarna data governance overhaul (2025)

**Qué pasó.** Tras el rollback parcial del chatbot autónomo (ver cap 20), Klarna publicó datos internos: sin gobernanza formal de datos, los pipelines RAG tenían chunks con PII (nombres, transactions, historiales de pago) y no había proceso claro de right-to-erasure.

**Cómo se detectó.** Auditoría preparatoria EU AI Act (agosto 2026 deadline). El gap fue tan grande que Klarna decidió parar deploys de nuevas features IA por 3 meses para consolidar.

**Cómo se arregló.** Adoptaron: (1) Presidio en ingest con recognizers custom para IDs suecos y europeos; (2) row-level filtering por tenant + acl; (3) DataHub para lineage; (4) workflow de right-to-erasure con 30 días SLA. Costo interno documentado: ~8 FTE-meses.

**Qué aprendió la industria.** Gobernanza no es un feature que añades tarde: es infraestructura. Retrofit cuesta 5-10× más que build-in desde el inicio. Klarna publicó el postmortem como guía interna que después filtró a la comunidad.

---

## 8. Ejercicios prácticos

### 8.1 Ejercicio: pipeline canónico end-to-end

**Objetivo.** Implementar el pipeline del §5 con tu propio corpus (mínimo 20 docs) y verificar cada fase.

**Setup.**
- Corpus de 20+ documentos Markdown/PDF/HTML propios (o del cap 06 si no tienes).
- Python con stack del §0.
- OpenAI API key (o usar Titan embeddings vía Bedrock).

**Pasos.**
1. Preparar el corpus en `./docs`.
2. Correr `rag_pipeline.py` del §5 adaptado.
3. Inspeccionar `audit.log.jsonl`.
4. Verificar en el vector store: contar chunks, verificar metadata.
5. Ejecutar 5 queries y verificar que los resultados incluyen `source_id` y `parent_id`.
6. Ejercer right-to-erasure sobre un source y verificar que desaparece.

**Criterios de aceptación.**
- [ ] Pipeline corre sin errores.
- [ ] Audit log tiene entries para cada fase.
- [ ] Metadata en chunks incluye lineage completo.
- [ ] Queries devuelven citations trazables.
- [ ] Right-to-erasure funciona: query sobre source borrado devuelve 0.

**Bonus.** Añadir dedup MinHash antes del embed y medir % de duplicados.

**Hints:**
- Si Presidio no detecta nada, revisa que descargaste el modelo spaCy correcto para el idioma.
- Chroma con `persist_directory` guarda en SQLite: para inspeccionar, `sqlite3 chroma_db/chroma.sqlite3 "SELECT count(*) FROM embeddings"`.
- El audit log en JSONL es fácilmente procesable con `jq`: `jq -s 'group_by(.event) | map({event: .[0].event, count: length})' audit.log.jsonl`.

**Solución de referencia (verificación de right-to-erasure):**
```python
before = vs.similarity_search("policy", k=10, filter={"source_id": "./docs/policy.md"})
erase_source("./docs/policy.md")
after = vs.similarity_search("policy", k=10, filter={"source_id": "./docs/policy.md"})
assert len(before) > 0 and len(after) == 0  # borrado efectivo
```

---

### 8.2 Ejercicio: PII redaction en múltiples idiomas

**Objetivo.** Extender Presidio a español y validar detección en corpus mixto.

**Setup.**
- Presidio + spaCy `es_core_news_lg`.
- 10 textos en español con PII (nombres, emails, DNIs, teléfonos, direcciones).

**Pasos.**
1. Descargar spaCy español.
2. Configurar Presidio con NLP engine español.
3. Añadir recognizer custom para DNI español (regex + checksum).
4. Correr detección en los 10 textos.
5. Anonimizar y verificar.
6. Medir precision/recall vs ground truth (etiquetado manual).

**Criterios de aceptación.**
- [ ] Recall ≥ 90% en emails y teléfonos.
- [ ] Recall ≥ 70% en nombres.
- [ ] Custom recognizer para DNI español funciona con checksum.
- [ ] Documentado precision/recall.

**Bonus.** Añadir recognizer para IBAN y CIF español.

**Hints:**
- Cambia `AnalyzerEngine(nlp_engine_provider=...)` para usar el motor spaCy español.
- Precision/recall requiere ground truth: etiqueta 10 textos manualmente en un CSV `text,entity_type,start,end`.
- Para IBAN, usa `python-stdnum` (validación robusta con checksum mod 97).

**Solución de referencia (recognizer DNI):** ver §2.4 (`SpanishDNIRecognizer`). Extiéndelo con IBAN copiando el patrón + `validate_result` que verifique mod 97.

---

### 8.3 Ejercicio: dedup MinHash sobre corpus real

**Objetivo.** Deduplicar un corpus de 10k+ docs con MinHash + LSH y medir impacto.

**Setup.**
- Corpus 10k+ documentos con duplicados esperados (ejemplo: dump de páginas web o docs corporativos).
- `datasketch` instalado.

**Pasos.**
1. Baseline: contar docs y calcular hashes exactos.
2. Reportar % de duplicados exactos.
3. Aplicar MinHash + LSH con threshold Jaccard 0.85.
4. Contar clusters near-dup.
5. Elegir política de retención (más reciente / con mejor score / manual).
6. Producir corpus deduplicado y comparar tamaño pre/post.

**Criterios de aceptación.**
- [ ] Dedup completa en tiempo razonable (linear).
- [ ] Reporte con % dup exacto y % near-dup.
- [ ] Política de retención justificada.
- [ ] Log de descartes con IDs preservados.

**Bonus.** Repetir con threshold 0.90 y 0.75 y comparar.

**Hints:**
- `num_perm=128` es sweet spot (más = más lento, menos = menos preciso).
- Para 10k+ docs, procesa en batch y usa `lsh.insert_session` para atomicidad.
- Log de descartes: guarda `(kept_id, dropped_id, jaccard_estimate)` en CSV para audit.

**Solución de referencia (esbozo):** ver código completo en §3.1 del capítulo (MinHash + LSH). Añade tras `lsh.query(m)`:
```python
if dups:
    dropped_log.append({"kept": dups[0], "dropped": doc["id"], "sim": lsh_estimate})
```

---

### 8.4 Ejercicio: versionado con DVC y experimento reproducible

**Objetivo.** Versionar el corpus del §8.1 y demostrar reproducibilidad.

**Setup.**
- DVC + backend S3 (o MinIO local).
- Git.

**Pasos.**
1. Init DVC con remote S3/MinIO.
2. Versionar corpus como `data/corpus_v1/` con `dvc add`.
3. Commit metadata en git.
4. Modificar corpus (añadir 5 docs).
5. Versionar como `data/corpus_v2/`.
6. Volver a `v1` con `git checkout` + `dvc pull`.
7. Re-ejecutar el pipeline con v1 y con v2, guardar índices Chroma separados.
8. Comparar retrieval sobre query común.

**Criterios de aceptación.**
- [ ] Dos versiones del corpus en DVC.
- [ ] Rollback funciona correctamente.
- [ ] Índices separados por versión.
- [ ] Diferencias de retrieval documentadas.

**Bonus.** Añadir tag git por versión (`v1`, `v2`) y demostrar reproducibilidad total (mismo git tag → mismo dataset).

**Hints:**
- MinIO local es la forma más rápida de simular S3 sin cuenta AWS: `docker run -p 9000:9000 minio/minio server /data`.
- `dvc pull` requiere `dvc.lock` en git para saber qué revision del blob traer.
- Reproducibilidad total = same git commit → same DVC blob hash → same corpus.

**Solución de referencia (verificación):**
```bash
git checkout v1 && dvc pull && md5sum data/corpus_v1/*.md > /tmp/v1.md5
git checkout v2 && dvc pull && md5sum data/corpus_v2/*.md > /tmp/v2.md5
git checkout v1 && dvc pull && md5sum data/corpus_v1/*.md > /tmp/v1b.md5
diff /tmp/v1.md5 /tmp/v1b.md5   # debe estar vacío (idéntico)
```

---

### 8.5 Ejercicio: análisis compliance EU AI Act de tu producto

**Objetivo.** Producir análisis formal de compliance para 3 features de tu producto.

**Setup.**
- Lista de 3 features con IA (existentes o planeadas).
- Acceso al texto del EU AI Act (`https://eur-lex.europa.eu/eli/reg/2024/1689/oj`).

**Pasos.**
1. Para cada feature, clasificar en las 4 categorías (unacceptable / high-risk / limited / minimal).
2. Justificar la clasificación citando artículos concretos (Anexo III, Art. 5, Art. 50).
3. Determinar rol: provider, deployer, o ambos.
4. Listar obligaciones aplicables por feature.
5. Identificar gaps actuales vs obligaciones.
6. Priorizar gaps según deadline (2 feb 2025 / 2 ago 2025 / 2 ago 2026 / 2 ago 2027).
7. Producir plan de remediación con owner y fecha.

**Criterios de aceptación.**
- [ ] 3 features clasificadas con cita textual.
- [ ] Rol determinado con justificación.
- [ ] Lista de obligaciones concretas.
- [ ] Gap analysis con severity.
- [ ] Plan de remediación.

**Bonus.** Añadir análisis complementario NIST AI RMF (funciones Govern/Map/Measure/Manage) y mapeo a ISO 42001 clauses.

**Hints:**
- Empieza por descartar categorías: la mayoría de features son limited o minimal; high-risk es Annex III específico.
- Para deployer vs provider: pregunta "¿modifico sustancialmente el modelo?". Si sí, eres provider por Art. 25.
- Para el gap analysis, usa formato RACI: quién Responsible, Accountable, Consulted, Informed.

**Solución de referencia (plantilla):**
```markdown
## Feature: Chatbot FAQ interno
- Categoría: Limited (Art. 50)
- Rol: Deployer (usamos Claude API sin modificar)
- Obligaciones aplicables:
  1. Disclosure "Estás hablando con IA" (Art. 50(1))
  2. Marking machine-readable si genera contenido (Art. 50(2))
- Gaps actuales:
  - [ ] Sin disclosure en UI actual → high severity, fix antes 2 ago 2026
  - [ ] Sin log de conversaciones para auditoría → medium
- Owner: @ale · Deadline: 2026-07-15
```

---

### 8.6 Ejercicio (Reto): pipeline audit-ready end-to-end

**Objetivo**: montar un pipeline production-ready que un auditor externo pueda inspeccionar en 30 minutos y firmar como compliant con EU AI Act Art. 12 (logging) + Art. 13 (transparency) + GDPR Art. 17 (right-to-erasure).

**Setup**:
- Todo lo de §5 (pipeline base con Presidio + Chroma + audit log).
- Prefect Cloud o self-hosted.
- OpenLineage server (Marquez) o DataHub local.
- 100+ docs con PII distribuida realistamente.

**Pasos**:
1. Extiende el pipeline con dedup MinHash + lineage OpenLineage (ver §5 Extendiendo).
2. Añade row-level filter por `tenant_id` en retrieval y test que valida aislamiento.
3. Implementa `erase_user(user_id)` que borra en cascada: chunks, embeddings, originales S3, caches, y notifica al usuario. SLA: < 30 días.
4. Genera reportes semanales automáticos:
   - Total de docs indexados, breakdown por PII entity_type detectada.
   - Right-to-erasure requests procesadas y tiempo mediano.
   - Retrievals con score bajo (posible drift).
5. Añade dashboard Marquez que muestra grafo `S3 → chunks → embeddings → collections`.
6. Simulacro de auditoría: pide a un colega revisar 30 min y darte findings.

**Criterios**:
- [ ] Auditor puede reconstruir de dónde vino cualquier chunk en < 5 min.
- [ ] Right-to-erasure funciona end-to-end y hay evidencia en audit log.
- [ ] Test automatizado impide leaks cross-tenant.
- [ ] Reportes semanales generados automáticamente.
- [ ] Grafo de lineage visible en UI.
- [ ] Documentación NIST AI RMF (Govern/Map/Measure/Manage) escrita.

**Bonus**: certifica el sistema contra ISO 42001 (audit interno; certificación formal cuesta ~15k€ pero el proceso interno se puede hacer solo).

**Por qué es reto**: junta gobernanza, técnica y proceso. Muchos equipos tienen las piezas pero no el todo. Un auditor externo detecta gaps que uno interno normaliza.

---

## 9. Recursos y siguientes pasos

**Regulación y frameworks:**
- EU AI Act (Regulation 2024/1689): `https://eur-lex.europa.eu/eli/reg/2024/1689/oj`
- EU AI Office: `https://digital-strategy.ec.europa.eu/en/policies/ai-office`
- Guidelines Art. 50 (Commission): `https://digital-strategy.ec.europa.eu/en/policies/guidelines-transparency-ai-generated-content`
- artificialintelligenceact.eu (tracker de la comunidad).
- NIST AI RMF: `https://www.nist.gov/itl/ai-risk-management-framework`
- ISO/IEC 42001:2023 (AI Management System).
- GDPR: `https://gdpr-info.eu`
- Model cards paper: Mitchell et al. 2019.
- Datasheets for Datasets paper: Gebru et al. 2018.

**Herramientas PII:**
- Microsoft Presidio: `https://microsoft.github.io/presidio/`
- AWS Comprehend PII: `https://docs.aws.amazon.com/comprehend/latest/dg/pii.html`
- Google Cloud DLP: `https://cloud.google.com/dlp`
- Azure AI Language PII: `https://learn.microsoft.com/en-us/azure/ai-services/language-service/personally-identifiable-information/overview`
- Bedrock Guardrails PII: `https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html`

**Herramientas pipeline y orquestación:**
- Apache Airflow: `https://airflow.apache.org`
- Prefect: `https://prefect.io`
- Dagster: `https://dagster.io`
- Argo Workflows: `https://argoproj.github.io/workflows`
- Unstructured: `https://unstructured.io`
- LlamaParse: `https://cloud.llamaindex.ai`

**Versionado y lineage:**
- DVC: `https://dvc.org`
- LakeFS: `https://lakefs.io`
- Delta Lake: `https://delta.io`
- Apache Iceberg: `https://iceberg.apache.org`
- OpenLineage: `https://openlineage.io`
- Marquez: `https://marquezproject.ai`
- DataHub: `https://datahubproject.io`
- Amundsen: `https://amundsen.io`

**Papers y referencias:**
- Carlini et al. (2021), "Extracting Training Data from Large Language Models".
- OWASP LLM Top 10: `https://owasp.org/www-project-top-10-for-large-language-model-applications/`
- Rajaraman & Ullman, "Mining of Massive Datasets" cap. 3 (LSH).

**Siguientes pasos:**
- [Cap 11 — OWASP LLM Top 10](./11-prompt-injection-owasp-llm.md) — vectores de ataque adicionales.
- [Cap 20 — UX productos IA + GEO/AEO](./20-ai-product-ux-geo-aeo.md) — Art. 50 aplicado a UX.
- [Cap 16 — Infra AWS Bedrock/SageMaker](./16-ai-infra-aws-bedrock-sagemaker.md) — donde implementas PrivateLink + Guardrails.
- [Cap 15 — prompting vs RAG vs fine-tuning](./15-prompting-vs-rag-vs-finetuning.md) — datos de entrenamiento requieren aún más cuidado que los de RAG.

---

## 10. Preguntas de práctica

Simulacro completo de 20 preguntas con explicaciones, casos reales y referencias:

- JSON del simulacro: `packages/content/src/tech/ai-programming/sim-19-data-pipelines-pii-eu-ai-act.json`
- Ruta en la app: `/tech/ai-programming/simulacro/19-data-pipelines-pii-eu-ai-act`

Tiempo: 25 min. Pass: 75%. Cubre las áreas de data governance y security.

---

## Navegación

← [Cap 18 — Observabilidad LLM](./10-llm-observability-tracing.md) · [Índice AI programming](./README.md) · [Cap 20 — UX productos IA + GEO/AEO →](./20-ai-product-ux-geo-aeo.md)
