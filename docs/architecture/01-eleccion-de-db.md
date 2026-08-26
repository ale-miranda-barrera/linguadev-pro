# Capítulo 01 — Elección de base de datos

> **Focus:** Decidir el motor de almacenamiento por patrón de acceso, consistencia y forma de los datos — no por moda ni por CV-driven development. SQL vs NoSQL, familias especializadas (columnar, grafo, search, time-series, key-value, document, vector), y cuándo Postgres es la respuesta pragmática.
> **Áreas:** db-choice · scalability · resilience
> **Preguntas:** 20 · **Tiempo:** 60 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos SQL: `SELECT`, `JOIN`, índices, `EXPLAIN`.
- Nociones de sistemas distribuidos y del teorema CAP.
- Recomendado: haber leído *Designing Data-Intensive Applications* (Kleppmann), o al menos su capítulo 7 (Transactions).
- Este capítulo es el primero del track, así que no depende de otros.

**Glosario mínimo:**
- **OLTP** (Online Transaction Processing): cargas transaccionales, muchas escrituras pequeñas, lecturas puntuales por PK. Ej. `orders`, `users`.
- **OLAP** (Online Analytical Processing): cargas analíticas, agregaciones sobre millones de filas, escaneos de columnas. Ej. dashboards, cohortes.
- **ACID**: Atomicity, Consistency, Isolation, Durability. Contrato transaccional canónico.
- **BASE**: Basically Available, Soft state, Eventual consistency. El opuesto pragmático para sistemas distribuidos AP.
- **MVCC** (Multi-Version Concurrency Control): forma en que Postgres, Oracle y MySQL/InnoDB permiten lecturas sin bloquear escrituras versionando cada tupla.
- **Partition key / sort key**: en DynamoDB, la clave que determina en qué partición vive el item y el orden dentro de ella.
- **Hot partition**: partición que recibe desproporcionadamente más tráfico que sus vecinas — cuello de botella clásico en DynamoDB y Cassandra.
- **Sharding**: partición horizontal por clave; cada shard es una base de datos autónoma.
- **CDC** (Change Data Capture): capturar los cambios de una DB en un stream (Debezium, DynamoDB Streams, Postgres logical replication).
- **Vector DB**: almacén de embeddings con búsqueda por similitud (ANN — Approximate Nearest Neighbor).

**Setup mínimo (verificado agosto 2026):**

```bash
# Postgres 17 (release oct 2024, LTS de facto en 2026)
docker run --name pg17 -e POSTGRES_PASSWORD=dev \
  -p 5432:5432 -d postgres:17

# DynamoDB Local para práctica
docker run --name ddb -p 8000:8000 -d amazon/dynamodb-local:latest

# Neo4j Community (grafos)
docker run --name neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/devpassword -d neo4j:5.24-community

# Redis 7.4 (default en 2026)
docker run --name redis -p 6379:6379 -d redis:7.4-alpine

# OpenSearch (fork de Elasticsearch, licencia Apache)
docker run --name opensearch -p 9200:9200 \
  -e "discovery.type=single-node" \
  -e "OPENSEARCH_INITIAL_ADMIN_PASSWORD=DevPass!234" \
  -d opensearchproject/opensearch:2.18.0

# AWS CLI v2 (para DynamoDB, S3, etc.)
aws --version
aws configure

# Herramientas útiles
pgcli --version           # cliente Postgres con autocompletar
mongosh --version         # shell MongoDB 8.x
psql -h localhost -U postgres -c "SELECT version();"
```

En 2026, Postgres 17 es el default sensato para OLTP nuevo. Postgres 18 salió en octubre de 2025 con async I/O y otras mejoras — adopción creciente pero 17 sigue dominando. DynamoDB añadió limits per-item mucho más generosos y warm throughput global en 2024. Redis 7.4 introdujo cambios de licencia (SSPL/RSALv2) que causaron el fork **Valkey** (Linux Foundation, 2024) — muchos equipos EU y cloud-agnostic migraron a Valkey en 2025-2026.

---

## 1. El gran cuadro

Elegir base de datos es la decisión más pegajosa de una arquitectura. Cambiar un framework web puede tomar semanas; cambiar una DB en un sistema con años y terabytes de datos toma trimestres. La elección determina límites de throughput, formas de consulta baratas y caras, patrones de fallo, coste operativo y hasta la estructura del equipo (quién sabe operar qué). Y sin embargo, muchas veces se elige por moda, por lo que usa la charla de conferencia que viste, o por lo que ya conocía el arquitecto en su último trabajo. En 2010 media industria migró de Postgres a MongoDB "por escalabilidad"; en 2016 medio mundo volvió a Postgres porque MongoDB no era la bala de plata. El ciclo se repite con cada nueva categoría.

La regla mental correcta es: **elige por patrón de acceso y forma de los datos, no por popularidad**. Empieza preguntándote cuántos writes y reads por segundo, qué queries hay que responder rápido, si necesitas transacciones cross-row, cuál es tu tolerancia a stale reads, y qué forma tienen tus datos (tabular, jerárquica, grafo, texto libre, series temporales, embeddings). Con esas cinco preguntas, el espacio de opciones se reduce dramáticamente. La conversación "SQL vs NoSQL" es una simplificación anticuada — hoy hay al menos ocho familias con papeles distintos, y frecuentemente una arquitectura sana combina dos o tres.

El segundo principio es **prefiere Postgres a menos que tengas razón concreta para no hacerlo**. Postgres 17 (2024) cubre relacional puro, JSONB con GIN, geoespacial (PostGIS), texto completo, series temporales (con Timescale), grafos limitados (con Apache AGE), pub/sub (`LISTEN/NOTIFY`), colas simples (`SELECT FOR UPDATE SKIP LOCKED`), vectores (pgvector con HNSW). Un solo motor te da suficiente potencia para el 80% de startups de las que hoy escribimos. Cuando cruzas ciertos umbrales (millones de eventos/s, embeddings a escala, grafos con billions of edges), aparecen motores especializados que ganan por órdenes de magnitud. Pero la carga de la prueba está en quien quiere abandonar Postgres.

El tercer principio es que **cada motor optimiza para un patrón y penaliza los demás**. DynamoDB da latencia p99 predecible con acceso por PK/SK, pero castiga los scans y no permite joins. Elasticsearch/OpenSearch responden queries de full-text imposibles en SQL, pero nunca deben ser fuente de verdad (perdida de datos documentada en Jepsen). Vector DBs (Pinecone, Weaviate, pgvector, Qdrant) hacen ANN barato, pero no reemplazan una BD relacional. Neo4j resuelve queries de N saltos en milisegundos, pero paga por escalabilidad horizontal. Este capítulo mapea cada familia a los patrones que sirve, y termina con un framework práctico de decisión y ejercicios reproducibles en tu máquina.

---

## 2. Fundamentos (nivel básico)

### 2.1 ACID en 30 segundos

ACID es el contrato transaccional del modelo relacional, formalizado por Jim Gray en los 70s. Cuatro garantías:

- **Atomicity:** todo o nada. Si una transacción tiene dos UPDATE y uno falla, ninguno queda aplicado.
- **Consistency:** la DB pasa de un estado válido a otro. Constraints, foreign keys, triggers, unique, check — todo se respeta al commit.
- **Isolation:** las transacciones concurrentes no ven estados intermedios de otras. El nivel de isolation controla cuánto exactamente.
- **Durability:** una vez `COMMIT`, sobrevive a un crash (WAL, fsync, replicación sync).

Ejemplo mínimo en Postgres:

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
-- Si algo falla entre BEGIN y COMMIT, ROLLBACK deja todo intacto.
```

Postgres, Oracle, MySQL/InnoDB, SQL Server son ACID nativos. MongoDB desde 4.0 (2018) soporta transacciones multi-documento ACID; DynamoDB añadió `TransactWriteItems` (hasta 100 items, 4 MB) en 2018.

Anti-patrón muy común: **rompes atomicity al mano** cuando actualizas la DB y luego publicas un evento en Kafka. Si el segundo paso falla, tu sistema queda inconsistente. La solución canónica es el **Transactional Outbox Pattern**, que veremos en el capítulo 02.

### 2.2 CAP y PACELC: lo que realmente significan

Eric Brewer publicó el teorema CAP en 2000 y hasta hoy se malinterpreta. La forma canónica: en presencia de particiones de red, un sistema distribuido debe elegir entre **Consistency** y **Availability**. Es una elección durante la partición, no una elección arquitectural permanente.

Kleppmann (2015, *A Critique of the CAP Theorem*) argumenta que CAP oscurece más de lo que aclara. La reformulación práctica es **PACELC** (Abadi 2012):

- **Partition:** cuando hay una partición → elegir A (availability) o C (consistency).
- **Else Latency vs Consistency:** en operación normal → elegir L (baja latencia, replicación async) o C (consistencia estricta, replicación sync).

| Sistema | Durante partición | En operación normal |
|---|---|---|
| Postgres sync replica | CP | EC |
| Cassandra (QUORUM) | AP | EL |
| DynamoDB (eventually consistent reads) | AP | EL |
| DynamoDB (strongly consistent reads) | CP | EC |
| Spanner | CP | EC |
| MongoDB (majority) | CP | EC |
| Redis Sentinel | AP | EL |

"Sacrificar Partition tolerance" no es una opción real: los cables se rompen, los switches fallan, los servidores se pausan por GC. Lo que sí decides es qué hacer cuando ocurre.

### 2.3 Índices: B-tree, Hash, GIN, GiST, BRIN

Postgres ofrece varias familias de índices y elegir mal es la causa #1 de queries lentas:

- **B-tree** (default): equality y range en tipos ordenados (`int`, `timestamp`, `text`). El 90% de los casos.
- **Hash**: solo equality; rara vez preferible a B-tree.
- **GIN** (Generalized Inverted Index): tipos compuestos — JSONB con `@>`, arrays, `tsvector` para full-text.
- **GiST** (Generalized Search Tree): rangos, geo (PostGIS), full-text con ranking.
- **SP-GiST**: espacio particionable — IPs (cidr), quad-trees.
- **BRIN** (Block Range Index): tablas gigantes append-only ordenadas físicamente (típico: logs, eventos). Índice diminuto (~megabytes para tablas de terabytes) porque solo guarda min/max por bloque.

```sql
-- events(id, user_id, tags jsonb, created_at)
CREATE INDEX ix_events_user      ON events (user_id);                       -- B-tree
CREATE INDEX ix_events_tags_gin  ON events USING GIN (tags);                -- containment
CREATE INDEX ix_events_created   ON events (created_at);                    -- range
CREATE INDEX ix_events_created_brin ON events USING BRIN (created_at)       -- si append-only
  WITH (pages_per_range = 128);

-- Queries que se benefician
EXPLAIN ANALYZE SELECT * FROM events WHERE user_id = 42;
EXPLAIN ANALYZE SELECT * FROM events WHERE tags @> '{"country":"AR"}';
EXPLAIN ANALYZE SELECT * FROM events WHERE created_at BETWEEN '2026-01-01' AND '2026-02-01';
```

Regla de oro: **`EXPLAIN ANALYZE` antes de crear el índice y después de crearlo**. Cada índice cuesta en writes y en espacio; no indexes por si acaso.

### 2.4 Niveles de aislamiento y las anomalías

ANSI SQL define cuatro niveles, en orden creciente de aislamiento:

| Nivel | Dirty read | Non-repeatable read | Phantom read | Write skew |
|---|---|---|---|---|
| Read Uncommitted | Posible | Posible | Posible | Posible |
| Read Committed (default Postgres) | No | Posible | Posible | Posible |
| Repeatable Read (Postgres = Snapshot Isolation) | No | No | No | Posible |
| Serializable (Postgres SSI) | No | No | No | No |

- **Dirty read**: leer un valor que otra transacción escribió pero aún no committó.
- **Non-repeatable read**: leer la misma fila dos veces y obtener valores distintos.
- **Phantom read**: `SELECT ... WHERE ...` devuelve nuevas filas en la segunda lectura.
- **Write skew** (Fekete et al. 2005): dos transacciones leen del mismo set, deciden basadas en esa lectura, y escriben cosas que juntas violan una invariante. Ejemplo canónico: dos médicos "de guardia" ven que hay 2 disponibles; ambos se dan de baja al mismo tiempo → 0 disponibles, invariante rota.

Postgres implementa **SSI (Serializable Snapshot Isolation)** desde 9.1 — detecta ciclos de conflicto en runtime y aborta transacciones con `40001 serialization_failure`. La app debe hacer retry. Trade-off: más aislamiento = más aborts y menos throughput.

### 2.5 Postgres como default pragmático

En 2026, la posición defendible por defecto es: **empezar con Postgres, migrar a otra cosa cuando midas dolor real**. Postgres 17 cubre:

- Relacional puro con ACID y SSI.
- JSONB con índices GIN para modelo document-like.
- Full-text search con `tsvector` (no reemplaza Elasticsearch pero cubre 80%).
- Geoespacial con PostGIS.
- Series temporales con extensión **Timescale**.
- Grafos limitados con extensión **Apache AGE**.
- Vectores con **pgvector** (HNSW desde 0.5.0, 2023).
- Pub/sub con `LISTEN`/`NOTIFY` (no reemplaza Kafka pero cubre notificaciones).
- Colas simples con `SELECT ... FOR UPDATE SKIP LOCKED` (Postgres 9.5+).

Empresas que corren Postgres a escala descomunal: Instagram (miles de shards con Django ORM), GitLab, Basecamp, Notion (block store en Postgres), Datadog (metadata). Cuando escuches "Postgres no escala", pide números concretos.

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 DynamoDB: pensar en partition keys

DynamoDB no es "SQL sin SQL". Es un motor **key-value** con soporte de **sort keys** que fuerza a diseñar el schema desde el patrón de acceso hacia atrás (el enfoque **single-table design**, popularizado por Rick Houlihan de AWS).

Reglas duras:
- Toda partición viene indexada por `partition key` (PK) y opcionalmente `sort key` (SK).
- Cada partición soporta **3000 RCUs** y **1000 WCUs** (nov 2023 aumento). Superar → throttling.
- **No hay JOIN**. Modelas relaciones colocando items relacionados en la misma partición y usando `Query` con `KeyConditionExpression`.
- **No hay scans baratos**. `Scan` recorre toda la tabla — evítalo en runtime.

Ejemplo de diseño para LinguaDev Pro — sesiones de estudio de un usuario:

```
Tabla: linguadev
PK: USER#<userId>
SK: SESSION#<isoDate>#<sessionId>

Items por usuario:
  PK=USER#123  SK=PROFILE                    (item de perfil)
  PK=USER#123  SK=SESSION#2026-08-13#s1      (sesión 1 del día)
  PK=USER#123  SK=SESSION#2026-08-13#s2      (sesión 2)
  PK=USER#123  SK=CARD#fsrs-42               (estado FSRS de una card)
```

Queries baratas:
- "Perfil del usuario 123" → `Query PK=USER#123 AND SK=PROFILE`.
- "Todas las sesiones de agosto de 123" → `Query PK=USER#123 AND begins_with(SK, "SESSION#2026-08")`.
- "Todas las cards del usuario 123" → `Query PK=USER#123 AND begins_with(SK, "CARD#")`.

Query cara (no hacer): "Todos los usuarios que estudiaron ayer" → requiere `Scan` o **GSI** (Global Secondary Index) con distinto PK.

Anti-patrón mortal: **hot partition**. Si tu PK es `TENANT#big-customer` y el 90% del tráfico va ahí, esa partición se satura y throttlea a todos. Fix: añade sufijo/prefijo de shard (`TENANT#big-customer#shard-<0-15>`) y agrega en la app.

```python
import boto3
from boto3.dynamodb.conditions import Key

ddb = boto3.resource('dynamodb', region_name='eu-west-1')
tabla = ddb.Table('linguadev')

# Query eficiente: partition key + range en sort key
resp = tabla.query(
    KeyConditionExpression=Key('PK').eq('USER#123')
        & Key('SK').begins_with('SESSION#2026-08')
)
for item in resp['Items']:
    print(item['SK'], item.get('scoreAvg'))

# Anti-patrón: scan filtrando
# resp = tabla.scan(FilterExpression=Attr('country').eq('AR'))
# Recorre toda la tabla — cara y lenta.
```

### 3.2 Familias de motores y cuándo cada una

| Familia | Motor típico | Ganas | Pierdes | Cuándo elegirlo |
|---|---|---|---|---|
| Relacional OLTP | Postgres, MySQL | ACID, joins, madurez | Escalar horizontalmente cuesta | Default para casi todo transaccional |
| Document | MongoDB, DocumentDB | Schema flexible, nested | Consistency cross-doc históricamente débil | Datos jerárquicos, schema evoluciona rápido |
| Key-value | Redis, DynamoDB, Valkey | Latencia p99 predecible | No joins, no queries complejas | Cache, session, contadores, hot data |
| Wide-column | Cassandra, ScyllaDB, BigTable | Escritura masiva, multi-region | Consistencia eventual, no joins | Time-series masiva, feeds, IoT |
| Columnar OLAP | BigQuery, Snowflake, Redshift, ClickHouse | Agregaciones sobre TB | Latencia por query alta (segundos) | Analytics, dashboards, cohortes |
| Search | Elasticsearch, OpenSearch, Meilisearch | Full-text ranking, facetado | No transaccional (Jepsen doc.) | Búsqueda, log aggregation (con caveats) |
| Time-series | InfluxDB, Timescale, QuestDB | Compresión >10x, ventanas, downsample | No genérico | Métricas, telemetría, IoT |
| Grafo | Neo4j, Neptune, Memgraph | Queries N saltos O(1) por hop | Escalar horizontal caro | Recomendación, fraude, social graph |
| Vector | pgvector, Pinecone, Weaviate, Qdrant | ANN sobre embeddings | Uso especializado | RAG, similitud semántica, recomendación IA |

### 3.3 Columnar (OLAP) vs OLTP: no mezclar

OLTP y OLAP tienen patrones opuestos. Meterlos en el mismo motor causa dolor:

- OLTP: writes pequeños, muchos, latencia baja. Row-oriented. Indices B-tree.
- OLAP: escans de columnas enteras, agregaciones, latencia alta aceptable. Columnar. Compresión.

Un `SELECT AVG(price) FROM orders WHERE created_at > '2025-01-01'` sobre 500M rows en Postgres tumba tu OLTP. En BigQuery o ClickHouse toma segundos y no compite con el OLTP.

Patrón industrial 2026: **CDC** con Debezium o DynamoDB Streams → Kafka → sink a data warehouse (Snowflake/BigQuery/Redshift/Databricks). Alternativa moderna: **zero-ETL** (AWS lanzó zero-ETL de DynamoDB, RDS, y Aurora a Redshift en 2023-2024) que elimina el pipeline manual.

```sql
-- ClickHouse: 10B filas, agregación en <1s con MergeTree
CREATE TABLE events (
    ts        DateTime,
    user_id   UInt64,
    country   LowCardinality(String),
    revenue   Decimal64(2)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (country, user_id, ts);

SELECT country, sum(revenue) AS total, count() AS n
FROM events
WHERE ts >= toDateTime('2026-01-01')
GROUP BY country
ORDER BY total DESC;
-- <1s sobre 10B filas en cluster modesto.
```

### 3.4 Grafo: cuándo Neo4j gana claramente

Los grafos ganan cuando tus queries recorren **relaciones de profundidad variable**. En SQL, un "amigo de un amigo" es un JOIN. Un "amigo hasta 5 niveles" son 5 JOINs con crecimiento combinatorio. En Cypher (Neo4j):

```cypher
// "Personas a hasta 3 saltos de Ana"
MATCH (a:Person {name: 'Ana'})-[:KNOWS*1..3]->(p:Person)
RETURN DISTINCT p.name, length(shortestPath((a)-[:KNOWS*]-(p))) AS dist
ORDER BY dist;
```

Complejidad: O(edges recorridos), no O(rows × joins). Casos claros: recomendación, detección de fraude (patrones cíclicos), redes sociales, ontologías, dependencias de código, IAM (quién tiene acceso a qué vía qué grupos).

Si tienes JOIN de 5+ tablas siempre presentes y depth es variable → considera grafo. Si tienes SELECT/INSERT normales → sigue con Postgres.

### 3.5 Search: por qué Elasticsearch no debe ser source of truth

Elasticsearch/OpenSearch responden queries imposibles en SQL: fuzzy match, ranking BM25, facetas, agregaciones sobre texto. Empresas indexan documentos de fuentes de verdad (Postgres, DynamoDB) hacia ES con CDC.

Anti-patrón: usar ES como **única** fuente. Kyle Kingsbury (**Jepsen**) publicó análisis (2015, 2020) mostrando que ES perdía datos bajo split-brain — hoy es más robusto pero sigue no-transaccional, sin ACID, y con reindexaciones que pueden requerir reconstruir desde una fuente autoritativa. **Regla:** la verdad vive en tu OLTP; ES es un índice derivado.

```json
// OpenSearch — mapping tipico
PUT /articles
{
  "mappings": {
    "properties": {
      "title":   { "type": "text", "analyzer": "spanish" },
      "body":    { "type": "text", "analyzer": "spanish" },
      "tags":    { "type": "keyword" },
      "score":   { "type": "float" },
      "created_at": { "type": "date" }
    }
  }
}

// Query full-text con filtro estructurado
GET /articles/_search
{
  "query": {
    "bool": {
      "must":   [{ "match": { "body": "spaced repetition FSRS" } }],
      "filter": [
        { "term": { "tags": "learning" } },
        { "range": { "created_at": { "gte": "2026-01-01" } } }
      ]
    }
  },
  "size": 20
}
```

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Multi-tenancy: schema-per-tenant vs shared-schema

Tres opciones en orden creciente de aislamiento:

| Patrón | Aislamiento | Coste operativo | Cuándo |
|---|---|---|---|
| Shared schema, `tenant_id` en cada tabla | Bajo (RLS ayuda) | Bajo | SaaS con miles de tenants pequeños |
| Schema por tenant | Medio | Medio (migrations por schema) | Decenas o centenas de tenants |
| DB por tenant | Alto | Alto | Enterprise, regulados, ~decenas |

Postgres soporta **Row-Level Security (RLS)** que permite forzar `WHERE tenant_id = current_tenant()` a nivel de motor. Bien usado, es una defensa fuerte contra bugs de aplicación que filtran datos entre tenants.

```sql
CREATE TABLE users (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  UUID NOT NULL,
    email      TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON users
    USING (tenant_id = current_setting('app.current_tenant')::uuid);

-- La app hace, en cada conexión:
SET app.current_tenant = '3f6b...';
-- Todas las queries subsiguientes ven solo su tenant.
```

### 4.2 UUID vs autoincrement

Debate eterno. Trade-offs:

- **BIGSERIAL / SERIAL**: pequeño (8/4 bytes), inserts en orden (locality de B-tree), predecible (ID = 1000 ⇒ probablemente número 1000). Contra: expone escala, colisión imposible en 1 DB pero fatal al mergear datasets.
- **UUID v4**: aleatorio, generable en el cliente, mergeable. Contra: 16 bytes, inserts causan **splits aleatorios de B-tree** → fragmentación e IO amplificado.
- **UUID v7** (RFC 9562, 2024): timestamp + random. Combina orden temporal con globalidad. **Recomendación 2026 por defecto** — Postgres 17 no tiene función nativa (llega en 18) pero cualquier lib genera.

```python
# UUIDv7 en Python (uuid_utils, uuid7)
from uuid_utils import uuid7
print(str(uuid7()))
# 018f1a2b-3c4d-7e8f-9a0b-c1d2e3f4a5b6
# Los primeros bits vienen del timestamp → orden temporal preservado.
```

### 4.3 Migraciones sin downtime (expand/contract)

La regla es: **nunca hagas migraciones destructivas en un solo deploy**. El patrón canónico es **expand-and-contract** (Blue-Green schema):

1. **Expand**: añade la nueva columna/tabla, ambos coexisten.
2. **Migrate**: backfill en batches sin bloquear (usa `NOT VALID` en constraints, `CONCURRENTLY` en índices).
3. **Cutover**: cambia la app para escribir/leer del nuevo formato.
4. **Contract**: elimina la columna/tabla vieja cuando estés seguro (semanas después).

```sql
-- Renombrar 'email' a 'user_email' sin downtime
-- Paso 1: expand — nueva columna
ALTER TABLE users ADD COLUMN user_email TEXT;

-- Paso 2: backfill en batches
UPDATE users SET user_email = email WHERE id BETWEEN 1 AND 10000;
-- ... repetir ...

-- Paso 3: sync con trigger mientras deploy la nueva versión de la app
CREATE OR REPLACE FUNCTION sync_email() RETURNS TRIGGER AS $$
BEGIN
    NEW.user_email := COALESCE(NEW.user_email, NEW.email);
    NEW.email      := COALESCE(NEW.email, NEW.user_email);
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_email BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION sync_email();

-- Paso 4: deploy app que usa user_email
-- Paso 5: contract — semanas después
DROP TRIGGER trg_sync_email ON users;
ALTER TABLE users DROP COLUMN email;
```

**Añadir un índice sin bloquear**:

```sql
CREATE INDEX CONCURRENTLY ix_users_email ON users(email);
-- CONCURRENTLY toma más tiempo pero no bloquea writes.
-- Si falla, deja un índice inválido — hay que DROP y reintentar.
```

### 4.4 Connection pooling: el bottleneck invisible

Postgres cuesta caro por conexión: ~10 MB de backend por conexión + fork(). Superar `max_connections` (default 100, típico 200-500) tumba la DB. En serverless (Lambda, Vercel Functions), miles de instances abriendo conexión = catastrophic thundering herd.

Solución: **pooler**. Los dos estándar en 2026:

- **PgBouncer**: pooler ligero en C, modos `session`, `transaction`, `statement`. `transaction` mode es el default para apps modernas — permite miles de clientes con decenas de backends.
- **RDS Proxy / Aurora**: pooler gestionado con failover integrado.
- **Supabase Supavisor**: pooler cloud-native, Elixir, alternativa a PgBouncer.

```ini
# pgbouncer.ini
[databases]
linguadev = host=127.0.0.1 port=5432 dbname=linguadev

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
pool_mode = transaction         ; clave para escalar
max_client_conn = 10000         ; clientes concurrentes
default_pool_size = 25          ; backends reales al Postgres
reserve_pool_size = 5
```

Caveats de `transaction mode`: no puedes usar `SET LOCAL` fuera de transacción, no funcionan prepared statements (a menos que uses `pgbouncer.protocol = extended` o Postgres 17+ que soporta protocol-level prepared statements en transaction pooling).

### 4.5 Vector DBs y la nueva categoría 2023-2026

Con el boom de LLMs, los embeddings se volvieron un tipo de dato de primer orden. Un embedding es un vector de floats (típico 384, 768, 1536, 3072 dims) que representa el significado semántico. Búsqueda por similitud (coseno, dot product, L2) sobre millones de embeddings requiere **ANN** (Approximate Nearest Neighbor) porque exact es O(N).

Opciones en 2026:
- **pgvector** (extensión Postgres): HNSW desde 0.5.0. Perfecto si ya usas Postgres y N < 10-100M vectores.
- **Pinecone**: SaaS puro, muy fácil, caro a escala.
- **Weaviate**: open source, con módulos que hacen embedding en el servidor.
- **Qdrant** (Rust): rápido, filtros ricos, escalable.
- **Milvus**: para escala masiva (billones de vectores).
- **OpenSearch / Elasticsearch**: soporte de KNN nativo — buena opción si ya lo tienes.

```sql
-- pgvector 0.8 en Postgres 17
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE docs (
    id        BIGSERIAL PRIMARY KEY,
    content   TEXT,
    embedding vector(1536)         -- OpenAI text-embedding-3-small
);

-- Índice HNSW (mejor recall que IVFFlat, coste más caro de build)
CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Query top-5 más similares
SELECT id, content, 1 - (embedding <=> $1) AS similarity
FROM docs
ORDER BY embedding <=> $1
LIMIT 5;
-- $1 es el embedding de la query, precomputado.
```

Regla mental: **empieza con pgvector**, migra a Qdrant/Pinecone/Milvus cuando midas límite (>10M vectores o latencia p99 no aceptable).

### 4.6 Consistent hashing y sharding

Cuando una tabla no cabe en un nodo, hay que particionar horizontalmente. Estrategias:

- **Range partitioning**: por rango de PK (users 1-1M en shard A, 1M-2M en B). Riesgo: hot shard si el tráfico es reciente.
- **Hash partitioning**: `hash(pk) % N`. Distribuye bien pero al añadir nodos se rehashea todo → **consistent hashing** (Karger 1997) minimiza el movimiento.
- **Directory-based**: tabla de lookup tenant→shard. Flexible, extra hop.

**Consistent hashing** ubica nodos y keys en un anillo. Añadir/quitar nodo mueve solo la fracción de keys entre el nodo entrante/saliente y su vecino. Usado en DynamoDB, Cassandra, Redis Cluster, Riak, Memcached con Ketama.

### 4.7 Change Data Capture (CDC) — patrón universal

CDC captura los cambios de una DB como stream de eventos. Es el pegamento de arquitecturas modernas: sincroniza search index, feed data warehouse, dispara notificaciones, hidrata caches.

- **Postgres**: logical replication (`wal2json`, `pgoutput`) + Debezium.
- **MySQL**: binlog + Debezium.
- **DynamoDB**: Streams nativo (24h de retention) o **DynamoDB Kinesis Data Stream** para retención más larga.
- **MongoDB**: Change Streams.

Diferencia crítica: CDC lee del **transaction log** (después del commit) → captura orden correcto y no compite con OLTP. Contrasta con "polling la tabla" que es propenso a perder cambios.

### 4.8 Event Sourcing: cuándo vale la pena

Event Sourcing (Fowler, Vernon) guarda **eventos inmutables** como fuente de verdad, y deriva el estado actual replayeando. Ganas: audit trail perfecto, viajes en el tiempo, múltiples read models optimizados (CQRS).

Coste: complejidad enorme. Schema evolution de eventos, snapshots para no replayear millones, coordinación con proyecciones eventualmente consistentes. **Anti-patrón muy común**: adoptar Event Sourcing porque suena bien, pagar la complejidad, no usar realmente el audit trail.

Regla: úsalo cuando el **audit trail es requisito de negocio** (banca, medical, compliance) o cuando necesitas **múltiples views ricos** del mismo estado. En otro caso, transactional outbox + CDC te da 80% del valor con 20% del coste.

---

## 5. Ejemplo práctico completo: elegir DB para LinguaDev Pro

Aplicamos el framework al proyecto real. Necesitamos almacenar:

1. **Usuarios y auth** (~100k iniciales, crecimiento moderado).
2. **Sesiones de estudio y respuestas** (write-heavy, patrón `USER#id → SESSION#date`).
3. **Estado FSRS de cada card por usuario** (millones de rows, hot path en reviews).
4. **Contenido del curso** (packs de inglés, quizzes) — read-heavy, casi inmutable.
5. **Búsqueda de contenido** (full-text sobre lecciones, ejercicios).
6. **Embeddings de ejercicios para similitud semántica** (RAG interno para "ejercicios parecidos a este").
7. **Métricas y analytics** (streak, avg score por día — para dashboards).

**Paso 1: elegir DB por bloque.**

| Bloque | DB elegida | Por qué |
|---|---|---|
| Users, sesiones, cards, contenido | Postgres 17 (RDS o Neon) | ACID, joins, RLS multi-tenant si futuro, JSONB para settings, coste bajo |
| Cache de sesión y rate-limit | Valkey/Redis | Latencia sub-ms, TTL nativo |
| Búsqueda | Postgres full-text con `tsvector` inicialmente, migrar a OpenSearch si <p95 |
| Embeddings | pgvector en el mismo Postgres | Consistencia con el resto, no justifica motor aparte |
| Analytics | Vista materializada en Postgres + CDC a ClickHouse cuando crezcamos | Empezar simple |
| Session store PWA offline | IndexedDB en el cliente, sync con Postgres | Offline-first del PWA |

**Paso 2: schema Postgres inicial.**

```sql
-- Extensiones
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Tabla de usuarios
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         CITEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    level         TEXT CHECK (level IN ('A1','A2','B1','B2','C1','C2')),
    settings      JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabla de sesiones de estudio
CREATE TABLE study_sessions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at    TIMESTAMPTZ NOT NULL,
    ended_at      TIMESTAMPTZ,
    score_avg     NUMERIC(4,2),
    pack_id       TEXT NOT NULL
);
CREATE INDEX ix_sessions_user_started ON study_sessions (user_id, started_at DESC);

-- Estado FSRS por card por usuario
CREATE TABLE card_states (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_id       TEXT NOT NULL,
    stability     REAL NOT NULL,
    difficulty    REAL NOT NULL,
    due_at        TIMESTAMPTZ NOT NULL,
    last_review   TIMESTAMPTZ,
    reps          INT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, card_id)
);
-- Query hot: "cards vencidas hoy para user X"
CREATE INDEX ix_cards_due ON card_states (user_id, due_at)
    WHERE due_at IS NOT NULL;

-- Contenido del curso (mostly read)
CREATE TABLE exercises (
    id            TEXT PRIMARY KEY,
    pack_id       TEXT NOT NULL,
    level         TEXT NOT NULL,
    prompt        TEXT NOT NULL,
    prompt_tsv    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', prompt)) STORED,
    embedding     vector(1536),
    metadata      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_ex_prompt_fts    ON exercises USING GIN (prompt_tsv);
CREATE INDEX ix_ex_embedding_hnsw ON exercises USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ix_ex_pack           ON exercises (pack_id, level);
```

**Paso 3: query hot path — cards vencidas.**

```sql
-- Cards vencidas para el usuario ordenadas por urgencia
SELECT card_id, stability, difficulty, due_at
FROM card_states
WHERE user_id = $1 AND due_at <= now()
ORDER BY due_at
LIMIT 20;

-- EXPLAIN ANALYZE verifica que usa ix_cards_due:
-- Index Scan using ix_cards_due  cost=0.42..8.44
```

**Paso 4: full-text search del contenido.**

```sql
SELECT id, prompt, ts_rank(prompt_tsv, plainto_tsquery('english', $1)) AS rank
FROM exercises
WHERE prompt_tsv @@ plainto_tsquery('english', $1)
  AND level IN ('B1', 'B2')
ORDER BY rank DESC
LIMIT 20;
```

**Paso 5: búsqueda semántica ("ejercicios parecidos a este").**

```sql
-- $1 = embedding del ejercicio actual (1536 dims)
SELECT id, prompt, 1 - (embedding <=> $1) AS similarity
FROM exercises
WHERE id <> $2                       -- excluye el actual
  AND pack_id = $3
ORDER BY embedding <=> $1
LIMIT 5;
```

**Paso 6: migración futura a OpenSearch cuando crezca.**

```python
# Job de sync con CDC (Debezium)
# Postgres logical replication → Kafka → sink connector → OpenSearch
# Cuando el schema cambia, versionamos el índice: exercises_v2 y hacemos reindex + alias swap.
```

**Paso 7: DynamoDB entra cuando el hot path lo justifique.**

Si `card_states` crece a >100M rows y Postgres se vuelve el cuello de botella (bench p99 > 50 ms con pool saturado), consideramos migrar SOLO card_states a DynamoDB con schema:

```
PK: USER#<uuid>   SK: CARD#<cardId>
Attributes: stability, difficulty, due_at (ISO), reps
GSI1: PK=USER#<uuid>   SK1=DUE#<due_at_iso>   → query "cards vencidas ordenadas"
```

Regla: **no premature-optimize**. Postgres aguanta muchísimo antes de justificar mudanza.

---

## 6. Cheatsheet, reglas mentales y anti-patrones

### Reglas de oro

- ✅ **Empieza con Postgres.** Cambia cuando midas dolor.
- ✅ **Elige por patrón de acceso**, no por popularidad de la charla más reciente.
- ✅ **Modela desde las queries** (particularmente en DynamoDB).
- ✅ **Un motor por familia de problema.** Cache es Redis, no un `LIMIT 1 OFFSET N`.
- ✅ **CDC para propagar cambios** a search, warehouse, notificaciones.
- ✅ **RLS en Postgres** para multi-tenancy con defensa en profundidad.
- ✅ **UUIDv7** como ID default en 2026.
- ✅ **Expand/contract** para migraciones sin downtime.
- ✅ **Connection pooler** (PgBouncer, RDS Proxy) antes de que la DB caiga.
- ✅ **`EXPLAIN ANALYZE`** antes y después de cada índice.
- ✅ **pgvector** primero para embeddings; migra a Qdrant/Pinecone si escala lo exige.
- ✅ **Serializable** cuando tienes invariantes cross-row (banca, inventario).

### Anti-patrones

- ❌ Elegir DB porque "es lo que usa Netflix" (survivorship bias).
- ❌ Elasticsearch como source of truth (Jepsen documented pérdida bajo particiones).
- ❌ DynamoDB con partition key single-value que se convierte en hot partition.
- ❌ `SELECT COUNT(*)` sobre tablas gigantes en OLTP — usa `pg_stat_all_tables.n_live_tup` o counter incremental.
- ❌ Índices "por si acaso" — cada uno cuesta en writes.
- ❌ 300 conexiones directas a Postgres desde Lambda sin RDS Proxy.
- ❌ Migración destructiva en un solo deploy (`DROP COLUMN`).
- ❌ Consistent-eventual reads donde el user espera "read your writes".
- ❌ MongoDB para datos altamente relacionales — obligas a implementar joins en la app.
- ❌ Event Sourcing "porque suena bien" sin necesidad real de audit trail.
- ❌ Serializable como default global — cae throughput 3-5x sin necesidad.
- ❌ Cache-aside sin invalidación pensada — sirves datos stale y culpas al usuario.

### Tabla de decisión rápida

| Necesidad | Primera opción | Si escala falla |
|---|---|---|
| Datos transaccionales con relaciones | Postgres 17 | Sharding, Aurora, CockroachDB |
| Cache con TTL | Valkey/Redis | KeyDB, DragonflyDB |
| Sesión web / rate limit | Redis | ElastiCache, MemoryDB |
| Search full-text | Postgres FTS | OpenSearch |
| Analytics/agregaciones | Postgres + view materializada | ClickHouse, BigQuery, Snowflake |
| Series temporales | Timescale (ext Postgres) | InfluxDB, QuestDB |
| Grafos con queries N-saltos | Neo4j | Neptune (managed) |
| Embeddings ANN | pgvector | Qdrant, Pinecone, Milvus |
| Key-value baja latencia p99 | DynamoDB | Cassandra, ScyllaDB |
| Feed de eventos infinito | Kafka | (Kafka rara vez se sustituye) |

---

## 7. Casos reales industria 2024-2026

**Redis license change y fork Valkey (marzo 2024).** Redis Inc. cambió licencia de BSD a SSPL/RSALv2. La Linux Foundation forkeó a **Valkey** con AWS, Google Cloud, Oracle y otros como sponsors. En 2025-2026 Valkey se estableció como default cloud-neutral; AWS ElastiCache y Google MemoryStore ofrecen Valkey desde 2024. **Lección:** licencias importan para dependencias core. Diseña con abstracción para poder cambiar.

**GitHub outage por Postgres migration (2024).** GitHub documentó incidentes durante migración a Postgres 14 (desde MySQL con Vitess). Rollbacks parciales, consistency issues en secondaries. **Lección:** las migraciones de motor son proyectos multi-mes con planes de rollback exhaustivos.

**Discord — trillones de mensajes a ScyllaDB (2022, referenciado 2024).** Discord migró de Cassandra a ScyllaDB (compatible C* API, Rust en lugar de JVM). Redujo nodos de 177 a 72, mejoró p99. **Lección:** hay ganancias reales al reescribir componentes en Rust cuando la carga es masiva y la latencia manda.

**Notion — block store en Postgres (documentado 2021, escalado en 2023-2024).** Sharding manual con Vitess-like layer. Cada bloque es una fila; miles de millones de bloques. **Lección:** Postgres escala muy lejos con ingeniería seria.

**Figma — CRDTs sobre RDS (2023).** Documentado en "How Figma's multiplayer technology works". Metadata en Postgres, CRDT operations sincronizados. **Lección:** el modelo de datos correcto reduce el problema de concurrencia a mate.

**pgvector adoption boom (2023-2025).** Con LLMs y RAG, pgvector se volvió la opción default en startups con Postgres. Supabase, Neon, RDS, Aurora, Azure Postgres soportan pgvector nativamente en 2026. **Lección:** el ecosistema Postgres crece con extensiones — es una plataforma, no solo una DB.

**AWS zero-ETL Aurora/DynamoDB → Redshift (2023-2024).** Antes se necesitaba Debezium + Kafka + sink connector; hoy es un click en la consola. **Lección:** hyperscaler integrations comen tooling middleware.

**CockroachDB pricing change (2024).** CRDB cambió su Enterprise gating (2024), causando fricción con adopters. Algunos migraron a Postgres+partitioning o Aurora DSQL. **Lección:** vendor lock-in con databases distribuidas requiere due diligence sobre trayectoria de licencias.

**Aurora DSQL (preview 2024, GA 2025).** Postgres-compatible distribuida activa-activa multi-region con serializable isolation global — competencia directa a Spanner en AWS. Adopción creciente en fintechs multi-región 2026.

**Postgres 17 (sept 2024) y 18 (oct 2025).** 17 introdujo mejoras enormes en `VACUUM`, incremental backups, MERGE con `RETURNING`. 18 añadió async I/O, UUIDv7 nativo. **Lección:** mantente al día — cada release cierra brechas históricas.

**MongoDB Atlas Search y Vector Search (2024).** MongoDB integró search y vector como servicios nativos en Atlas — hueco competitivo con pgvector + OpenSearch. **Lección:** las plataformas convergen a "todo en uno" para bajar fricción operativa.

---

## 8. Ejercicios prácticos

### Ejercicio 1: modelar `card_states` en Postgres y DynamoDB

**Objetivo:** implementar la tabla de estado FSRS en ambos motores y comparar patrones de acceso.

**Setup:**
- Docker con Postgres 17 y DynamoDB Local.
- Python 3.13 con `psycopg[binary]` y `boto3`.

**Pasos:**
1. Crea `card_states` en Postgres con PK `(user_id, card_id)` y el índice parcial `ix_cards_due`.
2. Crea la misma tabla en DynamoDB con schema single-table (`PK=USER#<id>`, `SK=CARD#<cardId>`).
3. Añade GSI en DynamoDB para query "cards vencidas ordenadas": `GSI1PK=USER#<id>`, `GSI1SK=DUE#<iso>`.
4. Inserta 100k cards de un usuario ficticio en ambos.
5. Ejecuta la query "cards vencidas hoy limit 20" 1000 veces en cada uno; mide p50, p95, p99.
6. Documenta el schema DynamoDB en un diagrama ASCII.

**Criterios de éxito:**
- [ ] Ambos esquemas responden la query en p95 < 20 ms local.
- [ ] `EXPLAIN ANALYZE` de Postgres confirma uso del índice parcial.
- [ ] Query DynamoDB usa `Query`, no `Scan`.
- [ ] Documento explica trade-offs de cada opción.

**Bonus:** simula 10 usuarios concurrentes escribiendo `updateCard` y verifica que no hay corrupción.

---

### Ejercicio 2: full-text search con Postgres vs OpenSearch

**Objetivo:** medir hasta qué tamaño de dataset Postgres FTS es competitivo.

**Setup:**
- Postgres 17 y OpenSearch 2.18 en Docker.
- Dataset: 500k párrafos en inglés (puedes usar el corpus de Wikipedia simple o generar sintético).

**Pasos:**
1. Carga el corpus en `exercises` con `tsvector` GIN index.
2. Carga el mismo corpus en OpenSearch con analyzer english.
3. Ejecuta 1000 queries con `plainto_tsquery` en Postgres y `match` en OpenSearch.
4. Compara p50/p95/p99 y calidad relativa de ranking.
5. Documenta cuándo cada motor gana.

**Criterios de éxito:**
- [ ] Postgres FTS responde p95 < 100 ms en el dataset.
- [ ] OpenSearch tiene mejor ranking con BM25 y highlighting.
- [ ] Documento razona el umbral aproximado (probablemente ~1-10M docs) donde OpenSearch se justifica.

**Bonus:** añade query con typo tolerance (`pg_trgm` vs OpenSearch fuzzy).

---

### Ejercicio 3: RLS multi-tenant con Postgres

**Objetivo:** implementar RLS que garantiza aislamiento entre tenants.

**Setup:**
- Postgres 17.
- Cliente en cualquier lenguaje.

**Pasos:**
1. Crea tabla `users(id, tenant_id, email)` con RLS enabled.
2. Crea policy que filtra por `current_setting('app.current_tenant')`.
3. Crea rol `app_user` con `USAGE` en el schema pero **sin bypass** RLS.
4. En la conexión de la app, ejecuta `SET LOCAL app.current_tenant = ...` al principio de cada request.
5. Prueba que un tenant nunca ve datos del otro (intento explícito con `WHERE`).
6. Prueba que un bug en la app (olvidar el SET) resulta en 0 rows visibles, no en leak.

**Criterios de éxito:**
- [ ] Query desde tenant A retorna solo rows de tenant A.
- [ ] Query sin `SET` retorna 0 rows (defensa segura por default).
- [ ] Intento explícito de `WHERE tenant_id = 'otro'` retorna 0 rows.
- [ ] Test automatizado que verifica los tres escenarios.

**Bonus:** añade policy diferente para admins que sí ven todos los tenants.

---

### Ejercicio 4: pgvector para búsqueda semántica

**Objetivo:** construir "ejercicios parecidos a este" usando embeddings y pgvector.

**Setup:**
- Postgres 17 con pgvector 0.8.
- API de embeddings (OpenAI, Cohere, Voyage, o local con Ollama + nomic-embed-text).

**Pasos:**
1. Crea `exercises` con columna `embedding vector(1536)`.
2. Genera embeddings para 10k ejercicios y bulk-insert.
3. Crea índice HNSW.
4. Implementa endpoint `/exercises/:id/similar` que devuelve top-5.
5. Mide latencia con y sin índice; documenta el trade-off.

**Criterios de éxito:**
- [ ] Query devuelve resultados semánticamente coherentes (revisa 20 casos a mano).
- [ ] Con índice HNSW, p95 < 50 ms.
- [ ] Sin índice, p95 aumenta 10-100x (evidencia de la necesidad).
- [ ] Documento explica el trade-off recall vs latencia de `ef_search`.

**Bonus:** combina búsqueda vectorial + filtro (`WHERE level = 'B1'`) y verifica que el índice se usa correctamente.

---

### Ejercicio 5: migración expand/contract sin downtime

**Objetivo:** renombrar una columna en producción sin interrumpir tráfico.

**Setup:**
- Postgres 17 con una tabla `orders(id, customer_email)`.
- App simulada haciendo INSERT/SELECT continuo.

**Pasos:**
1. Bajo carga simulada, añade columna `user_email` (expand).
2. Backfill en batches de 10k con `sleep 100ms` entre batches.
3. Añade trigger que sincroniza `email` ↔ `user_email` en INSERT/UPDATE.
4. Deploy "nueva versión" de la app que lee/escribe `user_email`.
5. Espera 24h simuladas (o inmediato en el test).
6. Elimina el trigger y la columna vieja (contract).
7. Verifica que en ningún momento hubo errores en la app simulada.

**Criterios de éxito:**
- [ ] Cero requests fallidos durante toda la migración.
- [ ] Backfill no bloquea writes (verifica con `pg_stat_activity`).
- [ ] `CREATE INDEX CONCURRENTLY` no bloquea.
- [ ] Documento con checklist de rollback en cada paso.

**Bonus:** aplica el patrón para cambiar el tipo de `id` de `BIGSERIAL` a `UUID`.

---

## 9. Recursos y siguientes pasos

**Libros canónicos:**
- Martin Kleppmann — *Designing Data-Intensive Applications* (2017). Capítulos 3, 5, 7, 9. La biblia.
- Alex Petrov — *Database Internals* (2019). Estructuras internas de motores.
- Rick Houlihan — talks de AWS re:Invent sobre DynamoDB single-table design (2018-2020, siguen vigentes).
- Bruce Momjian — *PostgreSQL: Introduction and Concepts* (clásico).

**Docs oficiales imprescindibles:**
- PostgreSQL docs, capítulo 11 (Indexes) y 13 (Concurrency Control).
- DynamoDB Developer Guide — sections "Best Practices for Designing and Architecting" y "Choosing the Right Partition Key".
- OpenSearch documentation, especialmente Text Analysis y KNN.
- pgvector README y benchmarks.

**Referencia académica:**
- Cahill et al. — *Serializable Isolation for Snapshot Databases* (2008) — la base de SSI de Postgres.
- Berenson et al. — *A Critique of ANSI SQL Isolation Levels* (1995).
- Karger et al. — *Consistent Hashing* (1997).
- Fekete et al. — write skew formalization.

**Blogs y newsletters 2026:**
- Kyle Kingsbury — [jepsen.io](https://jepsen.io) para análisis de correctness distribuida.
- Andy Pavlo — CMU 15-445/15-721 (YouTube, gratuito) — el curso académico de referencia.
- Postgres Weekly, DB Weekly, Bytes Newsletter.
- Marc Brooker (AWS) — blog sobre sistemas distribuidos.
- [use-the-index-luke.com](https://use-the-index-luke.com) — SQL performance para pragmáticos.

**Siguientes pasos:**
- Implementa al menos dos de los ejercicios en tu proyecto real.
- Aprende a leer `EXPLAIN ANALYZE` con detalle — es la herramienta #1 de optimización.
- Lee el próximo capítulo: [Cap 02 — Mensajería y microservicios](./02-mensajeria-y-microservicios.md), donde veremos CDC, Kafka, y cómo mantener consistencia entre bloques sin 2PC.

---

## 10. Preguntas de práctica (20)

Este simulacro cubre 20 escenarios sobre elección de DB, desde vocabulario básico (ACID, CAP) hasta patrones avanzados (event sourcing, sharding, consistent hashing). Incluye trade-offs de OLTP vs OLAP, cuándo grafo/search/time-series/vector justifican su motor propio, connection pooling, migraciones sin downtime, y un framework final de decisión.

- **Fuente:** [`packages/content/src/tech/architecture/sim-01-db-choice.json`](../../packages/content/src/tech/architecture/sim-01-db-choice.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-01-db-choice`
- **Tiempo:** 60 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

[Índice](./README.md) · [Cap 02 →](./02-mensajeria-y-microservicios.md)
