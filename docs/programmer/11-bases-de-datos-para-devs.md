# Capítulo 11 — Bases de datos para devs

> **Focus:** Lo que un dev senior debe dominar sin ser DBA: índices, EXPLAIN, N+1, pooling, ACID + isolation levels, migraciones zero-downtime, replicación, sharding, backups probados.
> **Áreas:** Databases · Postgres · MySQL · Performance · Data integrity
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- SQL básico: `SELECT`, `JOIN`, `GROUP BY`, `WHERE`.
- Concurrencia y locks a nivel conceptual (ver [Cap 03 — concurrency](./03-concurrencia-y-async.md)).
- Familiaridad con al menos un ORM (SQLAlchemy, Prisma, Hibernate, Django ORM).
- Nociones de client-server y conexiones TCP.
- Saber usar `psql` o `mysql` CLI para queries adhoc.

**Glosario mínimo:**
- **B-tree:** estructura de índice ordenada por defecto; sirve para `=`, `<`, `>`, `BETWEEN`, `ORDER BY`.
- **Hash index:** índice basado en hash; sirve solo para `=`. En Postgres 10+ es WAL-logged.
- **GIN** (Generalized Inverted Index): índice invertido para arrays, JSONB, full-text search.
- **BRIN:** Block Range INdex; barato para tablas grandes ordenadas cronológicamente.
- **Query planner:** el componente que decide cómo ejecutar una query (index scan, seq scan, hash join, nested loop).
- **N+1:** anti-patrón de ORM: 1 query para la lista + N queries para cada elemento.
- **Connection pool:** conjunto reusable de conexiones DB pre-abiertas.
- **PgBouncer:** pooler externo para Postgres en modo transaction/statement.
- **Prepared statement:** query pre-parseada, reusable con parámetros; previene SQL injection.
- **ACID:** Atomicity, Consistency, Isolation, Durability.
- **Isolation levels:** `READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ`, `SERIALIZABLE`.
- **MVCC:** Multi-Version Concurrency Control; readers no bloquean writers y vice versa.
- **SSI:** Serializable Snapshot Isolation (Postgres); serializable sin locks.
- **Deadlock:** dos transacciones esperando locks que se poseen mutuamente.
- **Migration:** cambio de esquema versionado.
- **Zero-downtime migration:** cambio de esquema sin locks largos ni breaking changes.
- **Sharding:** particionado horizontal de datos por clave.
- **Read replica:** copia read-only sincronizada con la primaria.
- **RPO / RTO:** Recovery Point Objective / Recovery Time Objective.

**Setup mínimo:**

```bash
# Postgres 17 (2026 GA desde sept 2024) + MySQL 9 en Docker
docker run -d --name pg17 -p 5432:5432 \
  -e POSTGRES_PASSWORD=devpass postgres:17

docker run -d --name mysql9 -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=devpass mysql:9.1

# Postgres client con features 17
psql "postgresql://postgres:devpass@localhost/postgres"

# pgbench (viene con postgres) para bench sintético
pgbench -i -s 50 mydb              # 5M rows
pgbench -c 20 -j 4 -T 60 mydb      # 20 clientes, 60s

# EXPLAIN de referencia visual — pgAnalyze / depesz
# https://explain.depesz.com

# PgBouncer 1.24+ para pooling
docker run -d --name pgbouncer -p 6432:6432 \
  -e DATABASES_HOST=pg17 -e DATABASES_USER=postgres \
  -e DATABASES_PASSWORD=devpass -e POOL_MODE=transaction \
  edoburu/pgbouncer:1.24
```

---

## 1. El gran cuadro

En 2026 casi ningún backend sobrevive un año sin haber pasado por —al menos— un incidente de DB: un query 100x más lento tras un release, un deadlock que rompe checkouts en Black Friday, una migración que bloquea la tabla `users` 40 minutos, un pool exhausted que devuelve 500 a media hora completa de tráfico. El dev senior no delega esto al DBA (que muchas veces ya no existe): entiende la lógica del planner, sabe leer un `EXPLAIN ANALYZE`, evita el N+1, dimensiona el pool, elige el isolation level correcto y hace migraciones sin downtime.

El terreno se divide en cuatro grandes áreas: **modelado y esquema** (elección SQL/NoSQL, PK, tipos, normalización), **rendimiento de queries** (índices, EXPLAIN, joins, N+1), **transacciones y concurrencia** (ACID, isolation levels, deadlocks, MVCC), y **operación** (pooling, migraciones, replicación, sharding, backups). Todo se entrena junto porque en producción se cruzan: un índice mal elegido eleva latencia, satura el pool, dispara timeouts, hace fallar retries, y un dev sin visibilidad de las 4 capas persigue el síntoma equivocado.

Postgres 17 (GA septiembre 2024) es el default recomendado para greenfield en 2026. Sus mejoras clave: EXPLAIN muestra I/O local y uso de memoria, WAL processing duplica el throughput de writes concurrentes, `TidStore` reduce hasta 20x la memoria de VACUUM, y los COPY grandes son ~2x más rápidos. MySQL 9 introdujo tipo `VECTOR` (sin índices ni distance functions inicialmente) y el HyperGraph optimizer para joins más complejos; sigue vigente donde ya está desplegado, especialmente con MySQL 8.4 LTS como base estable. Este capítulo es agnóstico donde se puede y explícito donde importa.

Aterrizaremos las lecciones en el proyecto **LinguaDev Pro**: tabla `users`, `lessons`, `reviews` (FSRS), `attempts`, `payments`; DynamoDB para storage caliente offline sync + Postgres 17 para relaciones y analytics. Los ejercicios finales pasan por: elegir el índice correcto para `reviews.due_at`, arreglar un N+1 en la lista de lecciones, ejecutar una migración zero-downtime para renombrar una columna, medir el impacto de `SERIALIZABLE` vs `READ COMMITTED`.

---

## 2. SQL vs NoSQL desde el POV del dev

### 2.1 La falsa dicotomía

En 2010-2015 el debate era "SQL is dead, NoSQL is the future". La realidad 2026 es que **los sistemas serios son polyglot**: relacional para el 80% donde importan las relaciones y las transacciones; key-value para caché y sesiones (Redis 7.4); document para catálogos y objetos con esquema variable (MongoDB, DynamoDB); columnar para analytics (ClickHouse, Snowflake); vector para embeddings (pgvector, Pinecone, MySQL 9 VECTOR).

Reglas prácticas de elección:

- ✅ **Relacional (Postgres/MySQL)** cuando: hay relaciones N:M, se necesita transaccionalidad ACID entre múltiples entidades, hay reporting con JOINs, la consistencia importa más que el throughput extremo.
- ✅ **Key-value (Redis, DynamoDB simple)** cuando: acceso por clave única, latencia sub-ms, TTL nativo (cache, sesiones, rate limit).
- ✅ **Document (MongoDB, DynamoDB items complejos)** cuando: el esquema varía por documento, escritura pesada de blobs semi-estructurados, no hay JOINs complejos.
- ✅ **Columnar (ClickHouse, BigQuery, DuckDB)** cuando: OLAP puro, agregaciones sobre miles de millones de filas, cargas batch.
- ✅ **Grafo (Neo4j, AGE)** cuando: consultas de N saltos (fraud, social).
- ✅ **Time series (TimescaleDB, InfluxDB)** cuando: métricas / IoT / logs con volumen alto y agregaciones por ventana.

Anti-patrón clásico: elegir MongoDB para app financiera "porque es más flexible" y descubrir que necesitas transacciones multi-doc, JOINs y consistency (MongoDB tiene ACID desde 4.0 pero con caveats).

### 2.2 Modelado inicial

Regla dura: modela primero como Postgres, migra a otro store solo cuando midas dolor real. Postgres cubre relacional + JSONB (document-lite) + full-text search + arrays + `pgvector`. Un stack completo con un solo motor te ahorra 80% de complejidad operativa.

---

## 3. Índices — el 80/20 del performance

### 3.1 B-tree vs Hash vs GIN vs BRIN

El planner elige el tipo según la query. Elegir mal el tipo cuando creas el índice te da un índice que nunca se usa.

| Tipo | Cuándo usarlo | Ejemplo query |
|---|---|---|
| **B-tree** (default) | `=`, `<`, `>`, `BETWEEN`, `ORDER BY`, `LIKE 'prefix%'` | `WHERE created_at > now()-'7d'::interval` |
| **Hash** | Solo igualdad exacta | `WHERE session_token = $1` |
| **GIN** | Arrays, JSONB, full-text (`tsvector`) | `WHERE tags @> ARRAY['ai']` |
| **GiST** | Geometrías, ranges, exclusion constraints | `WHERE geom && ST_MakeEnvelope(...)` |
| **BRIN** | Tablas grandes ordenadas físicamente (append-only logs) | `WHERE ts BETWEEN ...` en tabla de 1B filas |
| **SP-GiST** | Datos con distribución no balanceada | prefijos IP, quad-trees |

```sql
-- ejemplo real LinguaDev Pro
CREATE TABLE reviews (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL,
  card_id      UUID NOT NULL,
  due_at       TIMESTAMPTZ NOT NULL,
  stability    REAL NOT NULL,
  difficulty   REAL NOT NULL,
  reviewed_at  TIMESTAMPTZ,
  tags         TEXT[] DEFAULT '{}'
);

-- Query patrón: "próximas cards del user X que ya vencieron"
CREATE INDEX idx_reviews_due ON reviews (user_id, due_at)
  WHERE reviewed_at IS NULL;

-- Búsqueda por tag: GIN
CREATE INDEX idx_reviews_tags ON reviews USING GIN (tags);
```

### 3.2 Índices parciales — el más barato

Un índice parcial (`WHERE`) solo indexa filas que cumplen la condición. Ocupa menos, se mantiene más rápido, se usa en queries que también incluyen ese predicado.

```sql
-- Solo un puñado de rows son pendientes; el resto no interesa
CREATE INDEX idx_orders_pending ON orders (created_at)
  WHERE status = 'pending';

-- Query que usa el índice
EXPLAIN SELECT * FROM orders
 WHERE status = 'pending' AND created_at < now() - INTERVAL '1 hour';
```

### 3.3 Índices compuestos y orden de columnas

Regla: el orden de las columnas en `CREATE INDEX (a, b, c)` importa. El índice sirve para queries que filtran por `(a)`, `(a, b)`, `(a, b, c)` — no para `(b)` solo o `(b, c)` solo. Pon primero la columna con mayor selectividad y que aparece en `WHERE`; después las de `ORDER BY`.

```sql
-- Bien: user_id primero (selectivo), due_at para el rango + order
CREATE INDEX ON reviews (user_id, due_at);

-- Query planner usará el índice para:
--   WHERE user_id = $1 AND due_at < now() ORDER BY due_at
--   WHERE user_id = $1
-- Pero NO para:
--   WHERE due_at < now()
```

### 3.4 Índices JSONB en Postgres

```sql
-- Documento con campos variables
CREATE TABLE events (id BIGSERIAL PRIMARY KEY, payload JSONB);

-- GIN jsonb_path_ops: más rápido para @> pero limitado
CREATE INDEX ON events USING GIN (payload jsonb_path_ops);

-- Query
SELECT * FROM events WHERE payload @> '{"user_id": "u_42"}';

-- Expression index si siempre buscas por un campo concreto
CREATE INDEX ON events ((payload ->> 'session_id'));
SELECT * FROM events WHERE payload ->> 'session_id' = 'abc';
```

### 3.5 Índices que no se usan

Un índice cuesta writes (cada INSERT/UPDATE debe actualizarlo) + espacio. Un índice que nadie usa es coste puro. Postgres lo dice:

```sql
SELECT schemaname, relname, indexrelname,
       idx_scan, idx_tup_read, idx_tup_fetch
  FROM pg_stat_user_indexes
 WHERE idx_scan = 0
 ORDER BY pg_relation_size(indexrelid) DESC;
```

Índices con `idx_scan = 0` desde hace semanas → candidatos a `DROP INDEX CONCURRENTLY`.

---

## 4. EXPLAIN ANALYZE — señales de alarma

### 4.1 Anatomía

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT r.*, u.email
  FROM reviews r
  JOIN users u ON u.id = r.user_id
 WHERE r.due_at < now()
   AND r.reviewed_at IS NULL
 ORDER BY r.due_at
 LIMIT 100;
```

Salida esperada tipo:

```
Limit  (cost=0.86..123.45 rows=100 width=180) (actual time=0.05..1.2 rows=100 loops=1)
  ->  Nested Loop  (actual time=0.04..1.1 rows=100 loops=1)
        Buffers: shared hit=305
        ->  Index Scan using idx_reviews_due on reviews r
              Index Cond: (due_at < now())
              Filter: (reviewed_at IS NULL)
        ->  Index Scan using users_pkey on users u
              Index Cond: (id = r.user_id)
Planning Time: 0.12 ms
Execution Time: 1.35 ms
```

### 4.2 Señales de alarma

- **Seq Scan sobre tabla grande** cuando esperabas Index Scan → falta índice o el planner lo desestima (mala selectividad estimada, `ANALYZE` desactualizado, cast implícito).
- **Rows estimated 1 vs actual 500000** → estadísticas obsoletas: `ANALYZE tabla`. En 2026 el planner de Postgres 17 aprovecha estadísticas extendidas: `CREATE STATISTICS`.
- **Nested Loop con >10k outer rows** → suele indicar mala elección de join; Hash Join o Merge Join escalan mejor.
- **Sort (external merge)** en disco → `work_mem` insuficiente; upéalo o cambia query para evitar sort.
- **Buffers: read >> hit** → cache miss frecuente; datos calientes no caben en `shared_buffers`.
- **Execution time 10x Planning time** en queries triviales → sospecha ausencia de índice.
- **Rows Removed by Filter: N grande** → filtro tras index scan; considera índice más específico.

### 4.3 Postgres 17 EXPLAIN

Añadido en v17: `EXPLAIN (SERIALIZE)` muestra el coste de serializar el resultset a wire. También reporta uso de memoria en operaciones costosas. Ver Postgres 17 release notes (2024).

---

## 5. El problema N+1 y su solución

### 5.1 Cómo aparece

El clásico ORM:

```python
# Django ORM — N+1 involuntario
for lesson in Lesson.objects.filter(user=user):
    print(lesson.title, lesson.author.name)  # 1 query por lesson.author
```

Si hay 100 lessons, 1 query para la lista + 100 queries para cada author. Latencia = 100 × RTT DB. En un pool con RTT 2 ms, son 200 ms extra por request. Con pool ocupado, 500 ms.

### 5.2 Detección

- **Logs del ORM en dev:** `LOGGING_CONFIG` con SQL a stdout.
- **APM (Datadog, New Relic, Sentry Performance):** vista de "duplicate queries".
- **Herramientas dedicadas:** `django-debug-toolbar`, `bullet` (Ruby), `prisma-query-log-analyzer`, `pt-query-digest` (MySQL).

### 5.3 Fixes

```python
# Django: select_related (JOIN, para FK) / prefetch_related (2 queries, para M2M/reverse FK)
Lesson.objects.filter(user=user).select_related('author')

# Prisma
prisma.lesson.findMany({
  where: { userId },
  include: { author: true },   // JOIN a author
});

# SQLAlchemy 2.0
select(Lesson).options(selectinload(Lesson.author)).where(Lesson.user_id == uid)

# Ecto (Elixir)
Repo.all(from l in Lesson, preload: [:author], where: l.user_id == ^uid)
```

Regla: **cada request produce N queries constantes** (independiente del payload). Si crece con el tamaño de resultado, hay N+1.

### 5.4 Cuando SÍ quieres muchas queries

Contra-intuitivo pero real: no siempre un JOIN gigante es mejor. Un JOIN produce productos cartesianos si mal escrito (multiplica filas por relaciones M2M anidadas). Para lecturas con muchos related sets, `prefetch_related` de Django (2 queries + Python-side stitching) suele ser más rápido que `select_related` con muchos JOINs. Mide con `EXPLAIN ANALYZE` y compara.

### 5.5 DataLoader — el patrón GraphQL

En GraphQL cada resolver puede disparar queries. Facebook creó DataLoader (JS, port a otros lenguajes) que **agrupa** requests dentro de un tick del event loop:

```typescript
import DataLoader from 'dataloader';

const userLoader = new DataLoader<string, User>(async (ids) => {
  const rows = await db.query(
    'SELECT * FROM users WHERE id = ANY($1)',
    [ids as string[]],
  );
  const byId = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => byId.get(id) ?? new Error(`user ${id} not found`));
});

// En cualquier resolver
const user = await userLoader.load(userId);
```

Si 100 resolvers piden users durante el mismo request tick, se hace **una** query con `IN (...)` en lugar de 100.

---

## 6. Connection pooling — los números correctos

### 6.1 Por qué importa

Abrir una conexión Postgres cuesta ~10 ms + memoria (5-10 MB/conn) + un backend process. Sin pool, cada request paga ese coste. Con pool bien dimensionado, reusas conexiones y evitas saturar el DB.

### 6.2 Fórmulas útiles

**Little's Law aplicado:**

```
conexiones_necesarias ≈ throughput (req/s) × latencia_media (s)
```

Ejemplo: 500 req/s × 40 ms = 20 conexiones activas de media. Con burst, dimensiona a 2-3x.

**Regla clásica (HikariCP wiki):**

```
pool_size = ((core_count × 2) + effective_spindle_count)
```

Para Postgres en SSD moderno, ~10-30 conexiones por app instance suele ser sano. **Más no es mejor**: pasar de 20 a 200 conexiones típicamente empeora la latencia por contención de locks internos y context switches.

### 6.3 PgBouncer para el fanout

Postgres tolera bien decenas de conexiones directas, pero cientos o miles saturan. La solución 2026 sigue siendo **PgBouncer** (o **pgcat**, **Odyssey**) delante:

```
[app instances] ── conexiones cortas ──> [pgbouncer, pool_mode=transaction] ── conexiones largas ──> [postgres]
```

Modos:

- **session:** cliente mantiene la conexión durante toda su sesión. Equivalente a no-pool para el cliente.
- **transaction:** conexión al DB devuelta al pool tras cada `COMMIT`/`ROLLBACK`. **El más común en 2026**. Rompe: `SET`, prepared statements, `LISTEN/NOTIFY`, temp tables entre transacciones.
- **statement:** conexión devuelta tras cada query. Rompe transacciones multi-statement.

### 6.4 Prepared statements con PgBouncer

Antes: incompatibles con transaction pooling. Desde **PgBouncer 1.21+** (2023) hay soporte para prepared statements en modo transaction. Requiere activar `max_prepared_statements` y compatibilidad del driver. Ejemplo:

```ini
# pgbouncer.ini
pool_mode = transaction
max_prepared_statements = 200
```

### 6.5 Pool exhausted — qué hacer

Síntomas: latencia p99 disparada, timeouts al pedir conexión, error `sorry, too many clients already`. Causas típicas:

- Transacciones largas retentas por app (bug de código no cerrando conexión).
- N+1 amplificando el uso de pool.
- Deadlock que mantiene conexión bloqueada.
- Slow query que satura.

Debugging:

```sql
SELECT pid, state, wait_event_type, wait_event,
       now() - query_start AS duration, query
  FROM pg_stat_activity
 WHERE state <> 'idle'
 ORDER BY duration DESC;

-- Terminar query bloqueante
SELECT pg_cancel_backend(pid);       -- soft
SELECT pg_terminate_backend(pid);    -- hard
```

---

## 7. ACID, isolation levels y deadlocks

### 7.1 Los 4 isolation levels del standard SQL

| Level | Dirty read | Non-repeatable read | Phantom read |
|---|---|---|---|
| READ UNCOMMITTED | Sí | Sí | Sí |
| READ COMMITTED | No | Sí | Sí |
| REPEATABLE READ | No | No | Sí (excepto Postgres SI) |
| SERIALIZABLE | No | No | No |

**Postgres** implementa READ COMMITTED (default), REPEATABLE READ (snapshot isolation, previene phantoms), SERIALIZABLE (SSI — Serializable Snapshot Isolation). No hay READ UNCOMMITTED real (se comporta como READ COMMITTED).

**MySQL/InnoDB** default es REPEATABLE READ.

### 7.2 Elegir el level

- ✅ **READ COMMITTED (default):** correcto para 95% de OLTP. Cada query ve datos commiteados en el instante de arrancar.
- ✅ **REPEATABLE READ:** cuando dentro de una transacción necesitas ver la misma snapshot en múltiples queries.
- ✅ **SERIALIZABLE:** cuando la corrección lo exige y no puedes razonar todas las races. Postgres SSI aborta transacciones en conflicto con `serialization_failure` (SQLSTATE 40001) → **hay que retry en la app**.

### 7.3 SSI en Postgres — patrón de retry

```python
from psycopg import errors
import time, random

def in_serializable(conn, work):
    for attempt in range(5):
        try:
            with conn.transaction() as tx:
                conn.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                return work(tx)
        except errors.SerializationFailure:
            time.sleep(0.05 * (2 ** attempt) + random.random() * 0.05)
    raise RuntimeError("serialization retry budget exhausted")
```

### 7.4 Deadlocks — causa raíz típica

Dos transacciones adquieren locks en **orden distinto**:

```
Tx1: UPDATE users SET ... WHERE id = 'a';   -- lock a
Tx2: UPDATE users SET ... WHERE id = 'b';   -- lock b
Tx1: UPDATE users SET ... WHERE id = 'b';   -- espera lock b
Tx2: UPDATE users SET ... WHERE id = 'a';   -- espera lock a → deadlock
```

Postgres detecta el ciclo, mata una transacción y devuelve `40P01 deadlock_detected`. Prevención:

- **Ordena siempre los locks igual** (por PK ascendente).
- Usa `SELECT ... FOR UPDATE` en batch ordenado.
- Considera `SELECT ... FOR UPDATE SKIP LOCKED` para queues (workers no compiten).

### 7.5 SELECT FOR UPDATE SKIP LOCKED — pattern queue en Postgres

```sql
BEGIN;
SELECT id, payload
  FROM jobs
 WHERE status = 'pending'
 ORDER BY id
 LIMIT 10
 FOR UPDATE SKIP LOCKED;

-- procesar los 10
UPDATE jobs SET status = 'done' WHERE id = ANY($1);
COMMIT;
```

Con `SKIP LOCKED`, worker 2 salta las filas que worker 1 ya tiene lockeadas y procesa otras. Escala linealmente sin queues externas para volúmenes modestos.

### 7.6 MVCC y bloat

Postgres implementa MVCC (Multi-Version Concurrency Control): cada `UPDATE` no sobrescribe, crea una nueva versión de la fila (tuple) y marca la vieja como "invisible" al terminar todas las transacciones que aún la ven. **VACUUM** recupera esas tuplas muertas.

Problema: una transacción larga (hora+) bloquea la limpieza de todas las tuplas creadas durante su vida. Aparece **bloat**: la tabla física crece aunque el conteo de filas no cambia. Índices también.

Diagnóstico:

```sql
SELECT relname,
       n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / GREATEST(n_live_tup, 1), 2) AS dead_ratio,
       last_autovacuum
  FROM pg_stat_user_tables
 ORDER BY n_dead_tup DESC
 LIMIT 20;
```

Regla: `dead_ratio > 20%` sostenido = revisar autovacuum settings o cazar la transacción larga con `pg_stat_activity`. Postgres 17 hizo VACUUM hasta ~20x más eficiente en memoria con la nueva estructura TidStore (ver release notes).

### 7.7 Prepared statements y SQL injection

**Nunca concatenes strings a SQL**. Vulnerable, lento y feo.

```python
# HORROR
cur.execute(f"SELECT * FROM users WHERE email = '{email}'")

# BIEN — parametrizado
cur.execute("SELECT * FROM users WHERE email = %s", (email,))
```

Los drivers en 2026 (psycopg3, node-postgres, mysql2, JDBC) usan **prepared statements** por defecto o con flag: la query se envía una vez y se ejecuta con parámetros. Elimina injection y ahorra parsing en llamadas repetidas.

---

## 8. Migraciones zero-downtime

### 8.1 Regla dura

Cualquier release en producción con más de 10 usuarios activos requiere migraciones sin locks largos y sin breaking changes. En Postgres, una migración naïve tipo:

```sql
-- BLOQUEA lectura y escritura a la tabla durante el rewrite
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
```

En una tabla de 100 M de filas puede tardar 20 minutos con la tabla bloqueada. Downtime asegurado.

### 8.2 Patrones seguros

**Añadir columna nullable + default (Postgres 11+ es fast):**

```sql
-- Postgres 11+: NO reescribe la tabla si el default es constante
ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free';

-- Backfill en batches
UPDATE users SET plan = 'free' WHERE plan IS NULL AND id BETWEEN 1 AND 10000;
-- (repetir en cursor)

-- Solo entonces marca NOT NULL con CHECK previo NOT VALID (rápido)
ALTER TABLE users ADD CONSTRAINT plan_not_null CHECK (plan IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT plan_not_null;   -- rápido, sin lock exclusivo
```

**Renombrar columna sin downtime — expand/contract:**

```
1. Añade columna nueva (nullable).
2. Deploy código que ESCRIBE en ambas (vieja y nueva) y lee de la vieja.
3. Backfill: copia vieja → nueva.
4. Deploy código que ESCRIBE en ambas y lee de la nueva.
5. Deploy código que solo usa la nueva.
6. Drop columna vieja.
```

Cinco deploys, cero downtime.

**CREATE INDEX CONCURRENTLY:**

```sql
-- Sin CONCURRENTLY: bloquea writes durante minutos
-- Con: 2-3x más lento pero sin lock exclusivo
CREATE INDEX CONCURRENTLY idx_reviews_due ON reviews (due_at);
```

Un `CREATE INDEX CONCURRENTLY` que falla deja el índice en estado `INVALID`; hay que `DROP INDEX` y reintentar.

### 8.3 Herramientas 2026

- **pg-osc / pg_repack:** rewrite de tablas grandes online.
- **gh-ost** (GitHub, MySQL): schema change online sin locks largos.
- **Sqitch / Flyway / Alembic / Prisma Migrate:** versionado de migraciones.
- **Reshape** (Postgres, experimental): expand/contract automatizado.

---

## 9. Replicación, sharding, backups

### 9.1 Replicación read/write

Postgres soporta:

- **Streaming replication:** primaria envía WAL a réplicas. Réplicas son consultables (`hot_standby=on`). Lag típico: ms bajo carga normal, segundos bajo write burst.
- **Logical replication:** publicaciones/suscripciones a nivel tabla. Útil para migrar entre versiones mayores, sharding, ETL.

Regla: **el lag de réplica no es cero**. Si un usuario POST-ea y hace GET inmediato leyendo de réplica, puede no ver su propio dato (*read-your-writes*). Soluciones:

- Read-after-write consistente por sesión: por N segundos tras write, lee de primaria.
- Session tokens con timestamp de write mínimo aceptable.
- `pg_current_wal_lsn()` en write, `pg_last_wal_replay_lsn()` en réplica; espera si lag > umbral.

### 9.2 Sharding — cuándo y cómo

Sharding parte los datos por clave (user_id, tenant_id, geo) entre múltiples DBs. Es la última carta: cuadruplica complejidad operativa (cross-shard queries, rebalancing, migraciones globales, atomicidad).

Regla: intenta primero **scaling vertical** (más RAM/CPU), luego **read replicas** para carga de lectura, luego **partitioning declarativo** (Postgres native), y solo entonces sharding. Postgres 16+ soporta partitioning nativo por RANGE, LIST y HASH; Citus (extensión) da sharding declarativo con SQL.

### 9.3 Backups — probar el restore

*"Un backup que no has probado restaurar no es un backup, es esperanza"* — SRE folk wisdom, cita informal atribuida a múltiples SRE talks.

Estrategia mínima:

- **Base backup** semanal (`pg_basebackup` o snapshot EBS).
- **WAL archiving continuo** para PITR (Point In Time Recovery).
- **Retention:** 30 días típico; ajusta según GDPR/regulatorio.
- **RPO** (max data perdida): normalmente 5 min.
- **RTO** (max tiempo caído): normalmente 1 h.
- **Restore test mensual** en entorno paralelo. Métrica: tiempo real observado.

Herramientas: **pgBackRest**, **Barman**, **WAL-G**, snapshots managed (RDS, Aurora, Cloud SQL).

### 9.4 Ejemplo LinguaDev Pro

```bash
# Backup con pgBackRest a S3
pgbackrest --stanza=linguadev --type=full backup

# Restore hasta un timestamp específico (PITR)
pgbackrest --stanza=linguadev \
  --type=time \
  --target="2026-08-13 09:15:00+00" \
  --target-action=promote \
  restore
```

Verificar: la primera vez que ejecutas el restore en producción **debe ser un simulacro**, no un incidente real.

### 9.5 Paginación keyset vs offset

Ofrecer paginación con `LIMIT ... OFFSET N` es tentador pero se degrada linealmente: para servir la página 1000 con 20 items, Postgres tiene que **descartar** 20.000 filas ya materializadas.

```sql
-- Offset — mala escalabilidad
SELECT * FROM reviews ORDER BY id LIMIT 20 OFFSET 20000;

-- Keyset — usa el índice, coste constante
SELECT * FROM reviews WHERE id > $last_id ORDER BY id LIMIT 20;
```

El cliente envía el `last_id` de la página anterior como cursor. Escala perfectamente incluso a millones de filas siempre que el `ORDER BY` tenga índice.

Cuando el orden es por columna no-única (ej. `created_at`) usa clave compuesta como cursor: `WHERE (created_at, id) > ($ts, $id)`. Es lo que Instagram, Twitter y todos los feeds a escala hacen.

### 9.6 Outbox pattern — dual-write correcto

Anti-patrón: en la misma request escribes a la DB y también publicas evento a Kafka. Si el evento se publica pero la transacción rollbackea, tienes ghost event. Si commit y luego el publish falla, tienes lost event.

**Outbox** resuelve escribiendo el evento a una tabla `outbox` en la **misma transacción** que el cambio de dominio. Un poller aparte (o `logical decoding` con Debezium) relaya de la tabla al broker.

```sql
BEGIN;
  UPDATE users SET plan = 'pro' WHERE id = 'u_42';
  INSERT INTO outbox (aggregate_id, type, payload)
    VALUES ('u_42', 'UserUpgraded', '{"plan":"pro"}'::jsonb);
COMMIT;
```

El relay marca `sent_at` tras publish. Si el proceso muere entre commit y publish, el poller reintenta. Consumers deben ser idempotentes (ver Cap 10).

### 9.7 UUID como PK — trade-offs

`BIGSERIAL` (auto-increment 8-byte int) es compacto (8 bytes), ordenado, denso: perfecto para B-tree. `UUID v4` es aleatorio (16 bytes), pero los inserts en índices B-tree con UUID aleatorio causan **write amplification** y fragmentación.

Compromiso 2026: **UUID v7** (RFC 9562, aprobado 2024). Prefijo timestamp + randomness → monotónicamente creciente, B-tree friendly, sigue siendo globalmente único y no filtra secuencia.

```sql
-- Postgres 17 con extensión pg_uuidv7 o generado en app
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT uuidv7(),  -- si tienes la función
  ...
);
```

Regla: UUID v7 para IDs distribuidos que atraviesan cliente/servidor; BIGSERIAL para ID interno cuando no expones y no necesitas unicidad global.

### 9.8 Full-text search — Postgres vs Elasticsearch

Postgres tiene FTS built-in con `tsvector` + GIN. Suficiente para catálogos hasta millones de docs con queries simples. Ejemplo:

```sql
ALTER TABLE lessons ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))
  ) STORED;

CREATE INDEX ON lessons USING GIN (search_tsv);

SELECT id, title, ts_rank(search_tsv, plainto_tsquery('english', 'past perfect')) AS rank
  FROM lessons
 WHERE search_tsv @@ plainto_tsquery('english', 'past perfect')
 ORDER BY rank DESC
 LIMIT 20;
```

Elasticsearch/OpenSearch cuando: multi-idioma con analyzers avanzados, sugerencias/typo tolerance, agregaciones facetadas, escala de decenas de millones de docs con queries complejas, o quieres separar el ciclo de datos analytics/logs (Kibana). Coste: infra separada + sync (ETL o Debezium + connectors).

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales de producción. Cubren: elección B-tree/hash/GIN/BRIN, leer `EXPLAIN ANALYZE`, N+1 y detección, connection pooling numbers, isolation levels y phantoms, deadlocks y ordering de locks, JSONB indexes, partial indexes, MVCC bloat y VACUUM, migraciones online (expand/contract), Postgres SSI, paginación keyset vs offset, `SELECT FOR UPDATE SKIP LOCKED` como queue, read replicas y lag, 2PC vs saga, outbox pattern, diferencias Postgres/MySQL, full-text search, UUID como PK y backup/restore probados.

- **Fuente:** [`packages/content/src/tech/programmer/sim-11-databases-for-devs.json`](../../packages/content/src/tech/programmer/sim-11-databases-for-devs.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-11-databases-for-devs`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 10 — error handling y recovery](./10-error-handling-y-recovery.md) · [Capítulo 12 — git y colaboración →](./12-git-y-colaboracion.md) · [Índice](./README.md)
