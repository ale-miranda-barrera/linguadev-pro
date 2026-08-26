# Capítulo 35 — Database Migrations Zero-Downtime

> **Focus:** Cambios de schema en producción SIN tumbar el servicio. Expand-contract pattern paso a paso, Flyway vs Liquibase vs pgroll vs Atlas, DDL bloqueante vs no-bloqueante en Postgres 17, online schema changes (gh-ost, pt-online-schema-change), backfill de datos, dual-write, rollback strategies, testing con datos prod-like.
> **Áreas:** Database operations · Deployment strategies · SRE
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- SQL sólido: DDL, DML, indexes, transactions, MVCC básico.
- PostgreSQL o MySQL fundamentales.
- CI/CD y feature flags (caps anteriores 33-34): el rollout de schema va acoplado al rollout de código.
- Kubernetes básico (caps 07-09) para desplegar Job/CronJob y migrations en pipelines.
- Progressive delivery mindset: el schema también rollout gradual.

**Glosario mínimo:**
- **Zero-downtime migration**: cambio de schema sin ventana de mantenimiento ni caída de disponibilidad.
- **Expand-contract (parallel change)**: patrón de 3 fases — expand (añadir sin romper), migrate (backfill + doble escritura), contract (limpiar lo viejo).
- **Bloqueante (blocking DDL)**: `ALTER` que toma un `ACCESS EXCLUSIVE` lock y detiene lecturas/escrituras. En Postgres <17 muchos DDL eran bloqueantes; Postgres 17 (2024) mejoró varios.
- **Online schema change**: técnica que crea tabla sombra, copia datos, sincroniza cambios, y hace swap final. gh-ost (GitHub) y pt-online-schema-change (Percona) para MySQL.
- **pgroll**: herramienta OSS de Xata (2023, madura en 2026) que aplica expand-contract automáticamente en PostgreSQL con views versionadas.
- **Flyway**: tool clásico Java de migrations versionadas (V1__init.sql, V2__add.sql). En 2026 v10+ con native executables.
- **Liquibase**: alternative XML/YAML/SQL con changesets. En 2026 v4.30+.
- **Atlas** (Ariga): tool moderno (Go) de schema-as-code, comparación declarativa, migrations generation. Popular en 2026.
- **Backfill**: rellenar columna nueva con datos derivados de columnas existentes.
- **Dual-write**: durante migration, la app escribe a la columna vieja y la nueva simultáneamente.
- **Shadow read / shadow write**: leer/escribir en ambos lados y comparar en background para validar consistencia.
- **CONCURRENTLY** (Postgres): variante de operaciones `CREATE INDEX`, `REINDEX`, `DROP INDEX` que no toman lock exclusivo.

**Setup mínimo:**

```bash
# 1. PostgreSQL 17 local
docker run -d --name pg17 -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17.2-alpine

# 2. Flyway 10+ (CLI)
brew install flyway
# o descarga standalone: https://github.com/flyway/flyway/releases/tag/flyway-10.20.1

# 3. Liquibase 4.30+
brew install liquibase

# 4. pgroll (OSS Xata)
brew install xataio/pgroll/pgroll
# o binary from https://github.com/xataio/pgroll/releases

# 5. Atlas (Ariga)
curl -sSf https://atlasgo.sh | sh

# 6. gh-ost para MySQL (bonus)
brew install gh-ost

# 7. Cliente psql
psql -h localhost -U postgres -c "SELECT version();"
# PostgreSQL 17.2 on aarch64-apple-darwin ...
```

---

## 1. El gran cuadro

Un `ALTER TABLE users ADD COLUMN premium BOOLEAN NOT NULL DEFAULT false` parece inofensivo. En una tabla de 100 millones de filas en Postgres 10, ese comando reescribe la tabla entera, mantiene un `ACCESS EXCLUSIVE` lock por 30 minutos, y todo el servicio queda caído. En Postgres 11+ el `DEFAULT` es virtual (metadata-only), pero `NOT NULL` sigue exigiendo un scan. En Postgres 17 (2024) se mejoró más: `NOT NULL` puede añadirse en dos pasos rápidos usando `NOT VALID` primero. La lección madre de este capítulo: **cada versión de la base tiene reglas diferentes de qué es "seguro" y qué es "bloqueante"; conocerlas es la mitad del trabajo**. La otra mitad es aplicar patrones universales como **expand-contract** que funcionan en cualquier motor.

Zero-downtime migration importa porque la alternativa —ventanas de mantenimiento— es cada vez menos aceptable. Un e-commerce que "para" el checkout una hora por semana pierde ventas. Un banco no puede. Una app global con usuarios en 24 zonas horarias no tiene "ventana" real. Además, los deploys son cada vez más frecuentes: en un equipo con CI/CD maduro (cap 02), el pipeline empuja código 20 veces por día. Si cada schema change exige downtime, el schema queda congelado y los devs empiezan a hacer trampas horrorosas (guardar JSON en columnas TEXT, evitar `JOIN`s por miedo a añadir foreign keys, mantener columnas con nombres viejos por décadas). **Progressive delivery del código (cap 33-34) sin progressive delivery del schema es una farsa**: si tu servicio hace canary del 5% pero el schema change bloquea 30 min, el rollout es imposible.

El patrón central es **expand-contract** (Parallel Change de Danilo Sato). En vez de "renombrar `column_old` a `column_new`", que exige atomicidad y coordina con deploys, hacés tres fases: (1) **expand**: añadir `column_new` en paralelo, sin borrar nada; (2) **migrate**: la app escribe en ambas columnas (dual-write), y un backfill rellena filas históricas de `column_new` desde `column_old`; (3) **contract**: eliminar `column_old` una vez que nada la usa. Cada fase es un deploy independiente y reversible. Entre fase 1 y fase 3 pueden pasar días o semanas. La app puede rollback a versiones anteriores sin problema porque `column_old` sigue existiendo. Es más lento en calendario, pero es zero-downtime.

En 2026 el toolchain se divide en tres tribus. Los **veteranos**: Flyway (Java, versionado ordinal, muy adoptado en JVM shops) y Liquibase (XML/YAML/SQL, más features enterprise, DBAs lo aman). Los **modernos declarativos**: Atlas (Go, schema-as-code, diff automático), Sqitch (perl, dependencies explícitas). Los **especialistas en zero-downtime**: **pgroll** (Xata, aplica expand-contract automáticamente para Postgres usando views y triggers), **gh-ost** (GitHub, para MySQL, hace shadow table + replication events), **pt-online-schema-change** (Percona, MySQL clásico). Postgres 17 (2024) redujo dramáticamente la necesidad de trucos gracias a mejoras en DDL no bloqueante, pero **operaciones inherentemente pesadas** (backfill de tablas grandes, rewrite completo) siguen exigiendo orquestación. Este capítulo cubre teoría del expand-contract, DDL bloqueante vs no-bloqueante en Postgres 17, comparativa de tools, backfill patterns, rollback strategies, testing con datos prod-like, y un ejemplo integral sobre LinguaDev Pro.

---

## 2. Expand-contract: el patrón universal (nivel básico)

### 2.1 Las tres fases

Escenario: renombrar `users.name` a `users.full_name`.

**Fase 1: Expand.** Añadir sin romper.

```sql
-- deploy schema #1: solo añade la nueva columna
ALTER TABLE users ADD COLUMN full_name TEXT;
-- ojo: sin NOT NULL, sin DEFAULT en tabla grande
-- (Postgres 17 permite DEFAULT metadata-only pero seamos conservadores)
```

Deploy de código simultáneo: la app **sigue leyendo/escribiendo `name`**. `full_name` existe pero nadie la usa aún.

**Fase 2: Migrate (dual-write + backfill).**

Deploy schema/código #2:

```sql
-- backfill de filas históricas en lotes
DO $$
DECLARE
  batch_size INT := 5000;
  updated INT;
BEGIN
  LOOP
    UPDATE users
    SET full_name = name
    WHERE full_name IS NULL AND id IN (
      SELECT id FROM users WHERE full_name IS NULL LIMIT batch_size
    );
    GET DIAGNOSTICS updated = ROW_COUNT;
    EXIT WHEN updated = 0;
    PERFORM pg_sleep(0.1);  -- throttle
    COMMIT;
  END LOOP;
END $$;
```

Cambio de código: la app escribe en **ambas** columnas:

```typescript
async function updateUser(id: string, name: string) {
  await db.query(
    `UPDATE users SET name = $1, full_name = $1 WHERE id = $2`,
    [name, id]
  );
}
```

Deploy #3 (cambio en reads): la app **lee** de `full_name`.

```typescript
async function getUser(id: string) {
  const row = await db.query(
    `SELECT id, COALESCE(full_name, name) AS name FROM users WHERE id = $1`,
    [id]
  ).then(r => r.rows[0]);
  return row;
}
```

`COALESCE` es cinturón de seguridad si el backfill aún no completó.

**Fase 3: Contract.** Limpiar lo viejo.

Deploy #4 (código deja de tocar `name`), y luego deploy #5:

```sql
-- una vez confirmado que ninguna versión de la app usa `name`
ALTER TABLE users DROP COLUMN name;
```

En total: **5 deploys separados** para un rename. Es tedioso pero es zero-downtime y siempre reversible. En cada punto podés hacer rollback al deploy anterior sin corrupción.

### 2.2 Regla mental para cada tipo de cambio

| Cambio | Estrategia zero-downtime |
|---|---|
| Añadir columna nullable | 1 deploy — safe siempre |
| Añadir columna NOT NULL | expand-contract: nullable primero, backfill, add NOT NULL (con NOT VALID → VALIDATE en Postgres 17) |
| Renombrar columna | expand-contract completo (5 deploys) |
| Renombrar tabla | expand-contract con views o triggers |
| Cambiar tipo de columna | expand-contract (nueva columna, cast, swap) |
| Añadir index | `CREATE INDEX CONCURRENTLY` |
| Eliminar columna | expand-contract: código deja de usarla, luego DROP |
| Añadir FK | añadir `NOT VALID`, `VALIDATE CONSTRAINT` después |
| Añadir unique constraint | crear unique index CONCURRENTLY, luego promover |
| Cambiar column default | 1 deploy — safe en Postgres 11+ |
| Recrear tabla | shadow table + swap (pgroll, gh-ost) |

### 2.3 Trampas frecuentes en expand-contract

- **Rollback mid-migration**: si estás en fase 2 (dual-write) y hacés rollback al código de fase 0, las escrituras nuevas se perdieron. Solución: nunca rollback antes de completar la fase actual.
- **Backfill lock**: un `UPDATE` masivo en una sola transacción bloquea toda la tabla. Siempre por lotes con `LIMIT` y `COMMIT` intermedio.
- **Long-running transactions**: en Postgres, un transaction abierto una hora bloquea autovacuum y hincha el WAL. Backfills en background con `BEGIN/COMMIT` cortos.
- **Assumption de que `COALESCE` es gratis**: puede desactivar uso de índice en la columna vieja. Analizá `EXPLAIN`.
- **Olvidarse de eliminar la columna vieja**: la fase 3 nunca llega y quedás con schema debt.

---

## 3. DDL bloqueante vs no-bloqueante en Postgres 17 (nivel medio)

### 3.1 Reglas de lock

Postgres usa `ACCESS EXCLUSIVE` para la mayoría de `ALTER TABLE`. Este lock bloquea **lecturas y escrituras**. Duración = tiempo del ALTER. Para tablas grandes, milisegundos vs minutos importa.

**Operaciones seguras (metadata-only, milisegundos):**

- `ALTER TABLE t ADD COLUMN c TYPE` (nullable, sin default) — safe siempre.
- `ALTER TABLE t ADD COLUMN c TYPE DEFAULT x` — safe desde Postgres 11.
- `ALTER TABLE t ALTER COLUMN c SET DEFAULT x` — safe.
- `ALTER TABLE t DROP COLUMN c` — safe (marca lógica, no reescribe).
- `ALTER TABLE t RENAME COLUMN a TO b` — safe (metadata).
- `ALTER TABLE t RENAME TO t2` — safe.
- `CREATE INDEX CONCURRENTLY` — sin lock exclusivo, más lento.
- `DROP INDEX CONCURRENTLY` — sin lock exclusivo (desde Postgres 9.2).
- `ALTER TABLE t VALIDATE CONSTRAINT c` — solo lock `SHARE UPDATE EXCLUSIVE`, lee.
- `REINDEX INDEX CONCURRENTLY` — Postgres 12+.
- `REINDEX TABLE CONCURRENTLY` — Postgres 12+.

**Operaciones peligrosas (rewrite completo):**

- `ALTER TABLE t ADD COLUMN c TYPE NOT NULL DEFAULT x` — antes de Postgres 11 rewrite; desde Postgres 11 depende del tipo.
- `ALTER TABLE t ALTER COLUMN c TYPE nuevo_tipo` — rewrite si cambio de storage.
- `ALTER TABLE t ADD CONSTRAINT ... CHECK ...` — valida al añadir; usar `NOT VALID`.
- `ALTER TABLE t ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES ...` — valida al añadir; usar `NOT VALID`.

### 3.2 Mejoras Postgres 17 (2024)

Postgres 17 (release septiembre 2024) trajo mejoras relevantes:

- **NOT NULL en dos pasos rápido**: `ALTER TABLE t ADD CONSTRAINT c NOT NULL c NOT VALID` seguido de `ALTER TABLE t VALIDATE CONSTRAINT c`. La primera es metadata-only; la segunda scan sin lock exclusivo.
- **`MERGE` mejorado** para dual-write más eficiente.
- **Vacuum mejoras** que reducen bloat post-migration.
- **Streaming replication con logical decoding** más rápido, útil para migrations con réplicas.
- **`pg_createsubscriber`** para promociones más rápidas de standby.

Ejemplo: añadir `email NOT NULL` a tabla de 500M filas.

Antes (Postgres <17):

```sql
-- BLOQUEA la tabla mientras scan/rewrite (10+ min)
ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
```

Con Postgres 17 (patrón zero-downtime):

```sql
-- 1. Añadir nullable (metadata-only, <1s)
ALTER TABLE users ADD COLUMN email TEXT;

-- 2. Backfill en batches (background)
--    (ver sección 2.1)

-- 3. Añadir constraint NOT VALID (metadata-only, <1s)
ALTER TABLE users ADD CONSTRAINT users_email_nn CHECK (email IS NOT NULL) NOT VALID;

-- 4. Validar sin lock exclusivo (scan, minutos, tráfico sigue)
ALTER TABLE users VALIDATE CONSTRAINT users_email_nn;

-- 5. Opcional: promover a NOT NULL "verdadero"
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
-- Postgres 17 usa la constraint validada, evita re-scan
```

### 3.3 CREATE INDEX CONCURRENTLY

Regla de oro: **siempre `CONCURRENTLY` en producción**.

```sql
-- BAD (bloquea escrituras durante minutos)
CREATE INDEX idx_users_email ON users(email);

-- GOOD (no bloquea escrituras, tarda más)
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
```

Trade-off: `CONCURRENTLY` no puede correr dentro de una transacción, no puede ser parte de un migration atómico, y si falla queda un index inválido que hay que dropear con `DROP INDEX CONCURRENTLY`. Herramientas como Atlas y pgroll gestionan esto automáticamente.

### 3.4 FK con NOT VALID

Escenario: añadir `orders.user_id REFERENCES users(id)`.

```sql
-- 1. Añadir FK sin validar (metadata-only, <1s)
ALTER TABLE orders
  ADD CONSTRAINT orders_user_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id)
  NOT VALID;

-- 2. Validar en background (lock SHARE UPDATE EXCLUSIVE, no bloquea reads/writes)
ALTER TABLE orders VALIDATE CONSTRAINT orders_user_id_fk;
```

Nuevas filas se validan contra la FK; las históricas se validan en paso 2 sin downtime.

---

## 4. Herramientas: Flyway, Liquibase, Atlas, pgroll (nivel avanzado)

### 4.1 Flyway 10+

Versionado ordinal. Archivos `V<version>__<name>.sql` en `src/main/resources/db/migration/`. Ejecución idempotente basada en `flyway_schema_history` table.

```
db/migration/
  V1__init_schema.sql
  V2__add_users_full_name.sql
  V3__backfill_full_name.sql
  V4__drop_users_name.sql
```

`V2__add_users_full_name.sql`:

```sql
ALTER TABLE users ADD COLUMN full_name TEXT;
```

Configuración `flyway.toml` (v10 format):

```toml
[environments.production]
url = "jdbc:postgresql://prod-db.linguadev.internal:5432/linguadev"
user = "flyway_migrator"
password = "${FLYWAY_PASSWORD}"

[flyway]
environment = "production"
locations = ["filesystem:./db/migration"]
schemas = ["public"]
lockRetryCount = 10
validateMigrationNaming = true
outOfOrder = false
```

Ejecución en pipeline CI:

```yaml
# .github/workflows/migrate.yml
- name: Flyway migrate
  uses: docker://redgate/flyway:10.20.1
  with:
    args: -url=$DB_URL -user=$DB_USER -password=$DB_PASSWORD migrate
```

Ventajas: simplicidad, versionado claro, huge community. Contras: no diff declarativo, no expand-contract automático (lo hacés a mano).

### 4.2 Liquibase 4.30+

Alternativa con changesets XML/YAML/JSON/SQL, más features enterprise:

```yaml
# db/changelog/db.changelog-master.yaml
databaseChangeLog:
  - changeSet:
      id: 2026-08-add-full-name
      author: alice
      preConditions:
        onFail: MARK_RAN
        - not:
            - columnExists:
                tableName: users
                columnName: full_name
      changes:
        - addColumn:
            tableName: users
            columns:
              - column: { name: full_name, type: TEXT }
      rollback:
        - dropColumn:
            tableName: users
            columnName: full_name
```

Ventajas vs Flyway: preConditions, rollback declarativo, contextos (por environment), compatibilidad multi-database. Contras: verbose, curva de aprendizaje.

Ejecución:

```bash
liquibase --changeLogFile=db/changelog/db.changelog-master.yaml \
  --url=jdbc:postgresql://localhost:5432/linguadev \
  --username=liquibase --password=$LIQUIBASE_PASSWORD \
  update
```

### 4.3 Atlas (Ariga) — schema-as-code

Filosofía distinta: **declarás el estado deseado**, Atlas genera el diff/migration:

```hcl
# schema.hcl
schema "public" {}

table "users" {
  schema = schema.public
  column "id" {
    type = uuid
    null = false
  }
  column "email" {
    type = text
    null = false
  }
  column "full_name" {
    type = text
    null = true
  }
  primary_key {
    columns = [column.id]
  }
  index "users_email_idx" {
    unique  = true
    columns = [column.email]
  }
}
```

Diff y apply:

```bash
# genera migration SQL comparando el schema actual con el HCL
atlas migrate diff add_full_name \
  --dir "file://db/migrations" \
  --to "file://schema.hcl" \
  --dev-url "docker://postgres/17/dev"

# aplica
atlas migrate apply \
  --dir "file://db/migrations" \
  --url "postgres://user:pass@prod-db:5432/linguadev?sslmode=require"
```

Atlas también tiene **linter** (`atlas migrate lint`) que detecta operaciones bloqueantes antes de aplicar. Muy popular en 2026 por schema-as-code + CI integration.

### 4.4 pgroll — expand-contract automático para Postgres

**pgroll** (Xata, 2023, maduro en 2026) es el especialista. Aplica expand-contract automáticamente usando **views versionadas** por schema Postgres:

```json
{
  "name": "26_add_full_name",
  "operations": [
    {
      "add_column": {
        "table": "users",
        "column": {
          "name": "full_name",
          "type": "text",
          "nullable": false
        },
        "up": "COALESCE(name, '')",
        "down": "full_name"
      }
    }
  ]
}
```

Ejecución:

```bash
# 1. Inicializar pgroll (crea metadata schema)
pgroll init --postgres-url "postgres://user:pass@localhost/linguadev"

# 2. Start migration (expand)
pgroll start 26_add_full_name.json --complete=false

# 3. Ambas versiones del schema conviven en views:
#    - schema public_v25 (old, sin full_name)
#    - schema public_v26 (new, con full_name)
# Apps viejas apuntan a public_v25, apps nuevas a public_v26
# Triggers mantienen sincronía bidireccional durante el rollout

# 4. Cuando todos los deploys son la versión nueva, contract
pgroll complete
```

Ventajas: expand-contract "gratis", zero-downtime real, rollback simple (`pgroll rollback`). Contras: introduce complejidad (views + triggers), curva de aprendizaje, no todos los casos son expresables.

### 4.5 gh-ost (MySQL online schema change)

Para MySQL, `gh-ost` de GitHub es el standard. Crea shadow table, copia datos, aplica binlog events, swap final:

```bash
gh-ost \
  --host=prod-db.linguadev.internal \
  --database=linguadev \
  --table=users \
  --alter="ADD COLUMN full_name TEXT" \
  --allow-on-master \
  --initially-drop-ghost-table \
  --initially-drop-socket-file \
  --max-load="Threads_running=25" \
  --critical-load="Threads_running=100" \
  --chunk-size=5000 \
  --exact-rowcount \
  --throttle-additional-flag-file=/tmp/gh-ost.throttle \
  --panic-flag-file=/tmp/gh-ost.panic \
  --hooks-path=/etc/gh-ost/hooks \
  --execute
```

pt-online-schema-change (Percona) es alternativa similar.

### 4.6 Tabla comparativa 2026

| Tool | DB | Modelo | Zero-downtime | Learning curve | 2026 momentum |
|---|---|---|---|---|---|
| **Flyway 10+** | Multi | Versionado SQL | Manual expand-contract | Baja | Alto (established) |
| **Liquibase 4.30+** | Multi | Changesets YAML/XML/SQL | Manual | Media | Alto (enterprise) |
| **Atlas** | Multi | Schema-as-code declarativo | Auto lint + manual | Media | Muy alto (creciendo) |
| **pgroll** | Postgres | Expand-contract automático | Automático | Media-alta | Alto (Xata backing) |
| **gh-ost** | MySQL | Shadow table + binlog | Automático | Alta (ops) | Estable |
| **pt-online-schema-change** | MySQL | Shadow table + triggers | Automático | Alta | Legacy pero vivo |
| **Sqitch** | Multi | Dependencies explícitas | Manual | Alta | Nicho |
| **Bytebase** | Multi | UI + GitOps + review | Manual + linter | Baja (UI) | Alto (empresas medianas) |

Recomendación 2026:

- Postgres + startup / product team + quieren zero-downtime out-of-the-box → **pgroll**.
- Postgres/MySQL + necesitan schema-as-code + CI lint → **Atlas**.
- JVM shop existente con Flyway histórico → **Flyway 10+** actualizado.
- Enterprise con DBAs, preConditions, contexts → **Liquibase**.
- MySQL grande, no-Postgres → **gh-ost** para operaciones pesadas.

---

## 5. Ejemplo práctico: LinguaDev Pro — renombrar `users.name` → `full_name` con pgroll

Escenario real: LinguaDev Pro empezó con `users.name TEXT`. El producto ahora requiere `full_name` con soporte de nombres compuestos. Tabla tiene 8M filas. Necesitamos zero-downtime.

### Paso 1: instalar pgroll y baseline

```bash
# Instalar pgroll
brew install xataio/pgroll/pgroll

# Init metadata schema
pgroll init \
  --postgres-url "postgres://linguadev:pass@prod-db.linguadev.internal:5432/linguadev"

# Baseline: tomar snapshot del schema actual
pgroll baseline v0 \
  --postgres-url "postgres://..."
```

### Paso 2: crear migration JSON

`migrations/01_add_full_name.json`:

```json
{
  "name": "01_add_full_name",
  "operations": [
    {
      "add_column": {
        "table": "users",
        "column": {
          "name": "full_name",
          "type": "text",
          "nullable": true
        },
        "up": "name",
        "down": "full_name"
      }
    }
  ]
}
```

`up` define cómo llenar `full_name` desde `name` (backfill automático + trigger para new writes). `down` define reversa.

### Paso 3: start (fase expand)

```bash
pgroll start migrations/01_add_full_name.json --complete=false \
  --postgres-url "postgres://..."

# pgroll:
# - crea schema public_v1
# - crea view users en public_v1 con nueva columna
# - crea triggers bidireccionales entre public.users y public_v1.users
# - backfill en batches automático
```

### Paso 4: deploy código nuevo apuntando a `public_v1`

En la app, config de conexión:

```typescript
// packages/api/src/db.ts
import { Pool } from 'pg';

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: 'linguadev-api',
});

// setear search_path según version del código
export async function withSchema<T>(v: string, fn: (client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query(`SET search_path TO ${v}, public`);
    return await fn(client);
  } finally {
    client.release();
  }
}

// código nuevo (v1):
export async function getUser(id: string) {
  return withSchema('public_v1', async (c) => {
    const r = await c.query('SELECT id, full_name FROM users WHERE id = $1', [id]);
    return r.rows[0];
  });
}
```

Deploys viejos (v0) siguen apuntando a `public` y ven `users.name`. Deploys nuevos (v1) apuntan a `public_v1` y ven `users.full_name`. Triggers mantienen ambos sincronizados.

### Paso 5: rollout gradual con canary

Usar Argo Rollouts (cap 33) o feature flag (cap 34) para desplegar v1 gradualmente. Durante días, versiones v0 y v1 conviven en producción, cada una viendo "su" schema.

### Paso 6: complete (fase contract)

Una vez que todas las apps corren v1:

```bash
pgroll complete --postgres-url "postgres://..."

# pgroll:
# - elimina schema public_v0 (o rename para history)
# - promueve public_v1 al schema principal
# - elimina triggers de compatibilidad
# - column `name` es eliminada
```

### Paso 7: rollback en caso de problema

Antes de `complete`:

```bash
pgroll rollback --postgres-url "postgres://..."
# Elimina public_v1, triggers, deja public intacto
```

Después de `complete`: no hay rollback fácil, ejecutá una migration inversa.

### Paso 8: verificación e2e

```sql
-- Verificar sincronía durante la fase expand
SELECT id, name, full_name FROM public.users WHERE full_name IS NULL LIMIT 10;
-- Debería ir a 0 con el tiempo

-- Post-complete: `name` no existe
\d public.users
-- Column "name" no debería aparecer
```

### Paso 9: alternativa 100% manual (sin pgroll)

Mismo escenario con expand-contract manual + Flyway:

```sql
-- V10__add_full_name_nullable.sql
ALTER TABLE users ADD COLUMN full_name TEXT;

-- V11__backfill_full_name.sql
DO $$
DECLARE
  batch_size INT := 5000;
  updated INT;
BEGIN
  LOOP
    UPDATE users
    SET full_name = name
    WHERE full_name IS NULL AND id IN (
      SELECT id FROM users WHERE full_name IS NULL LIMIT batch_size
    );
    GET DIAGNOSTICS updated = ROW_COUNT;
    EXIT WHEN updated = 0;
    PERFORM pg_sleep(0.1);
    COMMIT;
  END LOOP;
END $$;

-- V12__add_full_name_not_null.sql (después de dual-write en app)
ALTER TABLE users
  ADD CONSTRAINT users_full_name_nn CHECK (full_name IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_full_name_nn;
ALTER TABLE users ALTER COLUMN full_name SET NOT NULL;

-- V13__drop_name.sql (después de deploy que deja de leer name)
ALTER TABLE users DROP COLUMN name;
```

5 deploys separados en semanas. Cada migration es reversible con manual `DROP COLUMN` / re-add.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Expand-contract siempre** para cambios que romperían atomicidad deploy-schema.
- ✅ **Backfill por lotes** (`LIMIT` + `COMMIT` intermedio), nunca en una transacción monolítica.
- ✅ **`CREATE INDEX CONCURRENTLY`** siempre en producción.
- ✅ **`ADD CONSTRAINT ... NOT VALID`** + `VALIDATE CONSTRAINT` para checks y FKs.
- ✅ **Postgres 17+**: aprovechá mejoras de NOT NULL en dos pasos.
- ✅ Elegí una tool y estandarizala (Flyway, Liquibase, Atlas, pgroll).
- ✅ **Atlas lint** o equivalente en CI para detectar DDL bloqueante antes de merge.
- ✅ **Migration por PR** separado del código que la usa (rollback independiente).
- ✅ **Test en staging con dataset prod-like** (misma cantidad de filas, misma distribución).
- ✅ **Feature flag** en la app para leer nueva columna gradualmente (COALESCE al principio).
- ✅ **Monitoring durante migration**: lag de replicación, tamaño WAL, tiempo de locks.
- ✅ **Runbook por migration**: qué hacer en cada fase y cómo rollback.
- ✅ **Nunca DROP en la misma release** que añade — separá en el tiempo.
- ✅ **Documentar assumptions**: "esta migration asume que app v2.1+ está deployada".
- ✅ Para MySQL grande: **gh-ost** o **pt-osc**.
- ✅ Para Postgres complejo: **pgroll** para expand-contract automático.

### Anti-patrones

- ❌ `ALTER TABLE ... ALTER COLUMN c TYPE bigint` en tabla grande en horario pico (rewrite bloqueante).
- ❌ Backfill en una sola transacción con 100M rows (long-running txn, WAL bloat, autovacuum bloqueado).
- ❌ `CREATE INDEX` sin `CONCURRENTLY`.
- ❌ `ADD FK` sin `NOT VALID`.
- ❌ Migration que borra columna en mismo deploy que la crea (imposible rollback).
- ❌ `ALTER TABLE ... ADD COLUMN c NOT NULL DEFAULT complex_func()` (rewrite forzado).
- ❌ Migrations dentro de `POST_DEPLOY` hook sin locks control (dos deploys concurrentes → race).
- ❌ Confundir "schema migration" con "data migration" en la misma pipeline.
- ❌ Deploy de app v2 que asume schema v2 antes de aplicar migration v2 (constraint violation crash).
- ❌ Migration test solo con `10 rows` de fixture (no detecta lock timeouts).
- ❌ Perder history de `flyway_schema_history` / `databasechangelog` al restaurar backups.
- ❌ Migrations en producción sin snapshot previo del volumen (cap 09).

### Checklist pre-migration

1. [ ] ¿Es un cambio bloqueante en esta versión de Postgres/MySQL?
2. [ ] ¿Está la tabla grande (>1M rows)?
3. [ ] ¿Necesito expand-contract o es one-shot safe?
4. [ ] ¿Tengo backfill script probado en staging?
5. [ ] ¿Backfill en batches con throttle?
6. [ ] ¿Snapshot del volumen tomado?
7. [ ] ¿Feature flag para leer nueva columna?
8. [ ] ¿Alertas activas para lag de replicación y WAL size?
9. [ ] ¿Runbook con pasos de rollback?
10. [ ] ¿PR de migration separado del PR de código?
11. [ ] ¿Migration linter (Atlas / squawk) pasó?
12. [ ] ¿Dry-run en staging con dataset prod-like?

---

## 7. Casos reales industria 2023-2026

**GitHub gh-ost (2016, sigue vivo 2026):** GitHub open-sourceó gh-ost para MySQL. Documentaron que migraron sus tablas más grandes (bilions rows) con downtime cero. **Lección:** para MySQL a escala, shadow-table + binlog es la técnica standard.

**Xata pgroll (2023-2026):** Xata (backed by ex-Elastic team) creó pgroll para llevar la técnica gh-ost al mundo Postgres nativo. En 2026 madura y adoptada por empresas mid-size. **Lección:** el gap "MySQL tiene gh-ost, Postgres no" se cerró.

**Airbnb migrations culture (blog posts 2019-2024):** Airbnb tiene playbook interno para schema changes. Cada migration requiere PR con "safety review" documentando expand-contract. **Lección:** disciplina cultural + tooling + review humano son la trilogía.

**Shopify (MySQL zero-downtime):** Shopify corre miles de migrations por semana. Usan `ghostferry` (fork de gh-ost) + herramientas internas. Documentaron caso de migrar tabla de 10B rows sin downtime. **Lección:** a escala, las migrations son una función de plataforma dedicada.

**Stripe migrations (blog post 2019, sigue relevante):** Stripe describió su approach: expand-contract, dual-write, backfill scripts revisados por 2 DBAs, alertas. **Lección:** en fintech, el rigor no es opcional.

**Notion Postgres migration (2024):** Notion migró parte de su stack de MySQL a Postgres. Documentaron uso de logical replication + expand-contract cross-database. **Lección:** las técnicas escalan incluso para cross-DB migrations.

**Robinhood 2020 outage post-mortem:** post-mortem público mencionó una migration mal ejecutada que causó cascada. **Lección:** un DBA experimentado no es suficiente; el proceso (review, staging test, runbook) es lo que previene incidents.

**Datadog Postgres tune (2023 blog):** Datadog compartió cómo tunean `maintenance_work_mem`, `autovacuum` settings y `checkpoint_timeout` para hacer migrations más rápidas sin afectar prod. **Lección:** tuning de Postgres es parte del zero-downtime toolkit.

**Atlas (Ariga) rise 2023-2026:** Atlas creció rápido como schema-as-code para Go/Postgres/MySQL. Adoptado por HashiCorp, Aptio, y otras. Con `atlas migrate lint` detecta issues bloqueantes en CI. **Lección:** llevar schema al mismo rigor que "code as code" es la tendencia 2026.

**Bytebase (2023-2026):** Bytebase (OSS + cloud) provee UI + review workflow para migrations. Popular en empresas medianas que quieren governance sin construir tooling propio. **Lección:** governance de schema changes es problema resuelto con productos.

**PlanetScale Vitess (MySQL sharded):** PlanetScale se construyó sobre Vitess con "branch-based" schema changes. Merge de una branch aplica gh-ost internamente. **Lección:** DBaaS modernos abstraen el problema al nivel de UI.

**Postgres 17 adoption (2024-2026):** empresas migrando de PG 14/15 a PG 17 reportan que muchas migrations que antes requerían downtime ya no lo requieren. **Lección:** vale la pena actualizar la DB por sí mismo — el nuevo DDL no bloqueante paga la migración.

---

## 8. Ejercicios prácticos

### Ejercicio 1: expand-contract manual con Flyway

**Objetivo:** aplicar expand-contract completo para renombrar `email` a `contact_email` con Flyway 10+.

**Setup:** Postgres 17 local, Flyway CLI, tabla `users(id, email)` con 100k rows sembradas.

**Pasos:**
1. `V1__init.sql` crea la tabla + seed.
2. `V2__add_contact_email.sql` añade la columna nullable.
3. `V3__backfill_contact_email.sql` con `DO $$ ... $$` en batches.
4. Modificar la app para escribir en ambas columnas.
5. `V4__contact_email_not_null.sql` con `NOT VALID` + `VALIDATE`.
6. Modificar la app para leer solo `contact_email`.
7. `V5__drop_email.sql`.

**Criterios de éxito:**
- [ ] Todas las 100k filas tienen `contact_email` no-null tras `V3`.
- [ ] Sin errores durante los `V*` aplicados.
- [ ] `flyway info` muestra los 5 migrations.
- [ ] Rollback documentado por cada `V*`.

**Bonus:** correr `atlas migrate lint` sobre los `.sql` y ver qué warnings da.

---

### Ejercicio 2: pgroll expand-contract automático

**Objetivo:** hacer el mismo rename con pgroll y comparar la experiencia.

**Setup:** Postgres 17, pgroll instalado, mismo dataset.

**Pasos:**
1. `pgroll init`.
2. Crear `01_rename_email.json` con `rename_column` operation.
3. `pgroll start --complete=false`.
4. Verificar que existen `public` y `public_v1` schemas.
5. Simular app "vieja" con `SET search_path TO public` insertando filas.
6. Simular app "nueva" con `SET search_path TO public_v1` insertando filas.
7. Verificar que ambas ven los datos correctamente (triggers sincronizan).
8. `pgroll complete`.

**Criterios de éxito:**
- [ ] Ambas apps operan simultáneamente durante fase expand.
- [ ] Datos consistentes en `public.email` y `public_v1.contact_email`.
- [ ] Post-complete, solo `contact_email` existe.
- [ ] `pgroll rollback` (antes de complete) reverse limpio.

**Bonus:** intentar `pgroll rollback` después de complete y documentar por qué no funciona.

---

### Ejercicio 3: `CREATE INDEX CONCURRENTLY` bajo carga

**Objetivo:** observar el impacto de `CREATE INDEX` vs `CREATE INDEX CONCURRENTLY` bajo carga.

**Setup:** Postgres 17, tabla de 5M rows, load generator (`pgbench` o script custom).

**Pasos:**
1. Correr `pgbench -c 20 -T 60` en background como load.
2. En otra sesión: `CREATE INDEX idx_users_email ON users(email);`. Medir tiempo.
3. Observar `pg_stat_activity`: ¿bloqueos?
4. `DROP INDEX idx_users_email`.
5. `CREATE INDEX CONCURRENTLY idx_users_email ON users(email);`. Medir tiempo.
6. Observar `pg_stat_activity` de nuevo.

**Criterios de éxito:**
- [ ] Version sin CONCURRENTLY: pgbench muestra caída de tps.
- [ ] Version con CONCURRENTLY: pgbench tps normal.
- [ ] Version con CONCURRENTLY tarda más wall-clock.
- [ ] Sin errores en la app durante ambas.

**Bonus:** simular fallo mid-CONCURRENTLY (kill del comando) y usar `DROP INDEX CONCURRENTLY IF EXISTS` para limpiar.

---

### Ejercicio 4: backfill en batches con throttle

**Objetivo:** escribir un backfill que rellena una columna nueva sin saturar la DB.

**Setup:** tabla `orders(id, user_id, amount)` con 10M rows, columna nueva `amount_usd DECIMAL`.

**Pasos:**
1. `ALTER TABLE orders ADD COLUMN amount_usd DECIMAL;`.
2. Script (bash o Node) que ejecuta:
   ```sql
   WITH batch AS (
     SELECT id FROM orders WHERE amount_usd IS NULL LIMIT 5000 FOR UPDATE SKIP LOCKED
   )
   UPDATE orders SET amount_usd = amount * $1 WHERE id IN (SELECT id FROM batch);
   ```
   con throttle de 100ms entre iteraciones.
3. Monitorear `pg_stat_activity`, `pg_locks` y CPU durante execución.
4. Verificar que no hay long-running transactions.
5. Al terminar, `SELECT count(*) FROM orders WHERE amount_usd IS NULL` debe ser 0.

**Criterios de éxito:**
- [ ] Backfill completa sin errores.
- [ ] No hay transaction >1s durante la ejecución.
- [ ] CPU < 60% durante backfill.
- [ ] `pg_locks` no muestra locks agresivos.

**Bonus:** hacer el backfill resumible (guardar last processed id en tabla `migration_state`).

---

### Ejercicio 5 (bonus): Atlas lint en CI

**Objetivo:** configurar `atlas migrate lint` en GitHub Actions para bloquear PRs con DDL peligroso.

**Setup:** repo con `db/migrations/*.sql`, Atlas instalado.

**Pasos:**
1. `atlas migrate diff init --dir file://db/migrations --to file://schema.hcl --dev-url docker://postgres/17/dev`.
2. Crear PR con una migration "mala": `ALTER TABLE users ALTER COLUMN email TYPE varchar(100);` (rewrite).
3. Configurar workflow:
   ```yaml
   - uses: ariga/atlas-action/migrate/lint@v1
     with:
       dir: 'file://db/migrations'
       dev-url: 'docker://postgres/17/dev'
       config: 'file://atlas.hcl'
   ```
4. Verificar que el PR falla con warning "column type change requires table rewrite".
5. Corregir con expand-contract y confirmar que pasa.

**Criterios de éxito:**
- [ ] Lint detecta el rewrite y comenta en el PR.
- [ ] Migration corregida pasa.
- [ ] Workflow bloquea merge hasta que pasa.

**Bonus:** añadir regla custom "no ALTER TABLE ADD COLUMN NOT NULL sin DEFAULT" al lint.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [postgresql.org/docs/17](https://www.postgresql.org/docs/17/) — Postgres 17 DDL reference.
- [flywaydb.org](https://flywaydb.org) — Flyway 10+.
- [liquibase.org](https://www.liquibase.org) — Liquibase 4.30+.
- [atlasgo.io](https://atlasgo.io) — Atlas.
- [pgroll.com](https://xata.io/docs/pgroll) — pgroll docs.
- [github.com/github/gh-ost](https://github.com/github/gh-ost) — gh-ost MySQL.

**Referencias fundacionales:**
- Danilo Sato, "Parallel Change" en martinfowler.com (2014, sigue siendo la referencia).
- "Migrations for Zero Downtime" — Stripe engineering blog.
- "Online DDL for MySQL at Shopify" — Shopify engineering blog.

**Herramientas complementarias:**
- **squawk** — linter open source para migrations Postgres.
- **pg_repack** — reorganización de tablas sin lock.
- **Bytebase** — UI + review workflow para migrations.
- **Debezium** — CDC para dual-write cross-database.
- **PlanetScale** — DBaaS con schema branching (MySQL).

**Referencias adicionales:**
- Bytebase blog: "Top Open Source Postgres Migration Tools 2026".
- Xata blog: "Introducing pgroll".
- KubeCon 2024-2025: sessions sobre database operations en K8s.

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Auditá tus migrations históricas: ¿cuántas eran bloqueantes?
- Instalá `atlas migrate lint` o `squawk` en CI para todas las próximas migrations.
- Documentá el runbook para la próxima migration crítica.
- Continuá con [cap 36 — Artifact Management y Caching](./36-artifact-management-y-caching.md) para el otro pilar operacional: cómo servir imágenes, dependencias y cache reproducibles.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales de zero-downtime schema migrations. Cubren: expand-contract paso a paso, DDL bloqueante vs no-bloqueante en Postgres 17, `CREATE INDEX CONCURRENTLY`, `NOT VALID` + `VALIDATE CONSTRAINT`, comparativa Flyway/Liquibase/Atlas/pgroll, backfill en batches con throttle, dual-write patterns, rollback strategies, testing con dataset prod-like, gh-ost para MySQL, casos de tablas grandes, y anti-patrones típicos.

- **Fuente:** [`packages/content/src/tech/devops/sim-35-database-migrations-zero-downtime.json`](../../packages/content/src/tech/devops/sim-35-database-migrations-zero-downtime.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-35-database-migrations-zero-downtime`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 34 — Feature Flags a escala](./34-feature-flags-at-scale.md) · [Índice](./README.md) · [Capítulo 36 — Artifact Management y Caching →](./36-artifact-management-y-caching.md)
