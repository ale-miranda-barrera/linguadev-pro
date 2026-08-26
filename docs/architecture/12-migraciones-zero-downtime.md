# Capítulo 12 — Migraciones sin downtime: expand-contract, blue/green y strangler fig

> **Focus:** Cambiar el motor de un avión en vuelo. Patrones que hacen que schema migrations, refactors de servicios y sustituciones de dependencias sucedan **sin caída** y con rollback en segundos.
> **Áreas:** Resilience · Microservices · Data
> **Preguntas de práctica:** 24 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- SQL básico y familiaridad con Postgres (o MySQL) a nivel `ALTER TABLE`.
- Conceptos de rolling deploy, health checks y load balancers.
- Nociones de feature flags (LaunchDarkly, Unleash, AppConfig).
- Haber leído [Cap 11 — Lambda serverless en profundidad](./11-lambda-serverless-profundo.md).
- Idealmente experiencia con Flyway o Liquibase.

**Glosario mínimo:**
- **Expand-contract** (a.k.a. **parallel change**, Martin Fowler) — patrón para cambios de schema en pasos que mantienen compatibilidad temporal entre versiones vieja y nueva.
- **Blue/green** — dos entornos completos en paralelo; el switch de tráfico es atómico y el rollback es cambiar el puntero.
- **Canary** — enrutar un porcentaje pequeño de tráfico a la nueva versión y aumentar progresivamente.
- **Strangler Fig** — patrón (Fowler, 2004) para reemplazar un sistema legado incrementalmente redirigiendo por-función a un sistema nuevo hasta apagar el viejo.
- **Dual-write** — durante una migración, la aplicación escribe tanto al modelo viejo como al nuevo.
- **Backfill** — proceso de rellenar datos históricos hacia el modelo nuevo.
- **Feature flag** — interruptor de configuración remoto que desacopla *deploy* de *release*.
- **Transactional outbox** — patrón para emitir eventos de dominio con la misma transacción que actualiza el estado.
- **Cutover** — momento discreto en que el tráfico se corta al sistema viejo y se abre al nuevo.
- **Schema evolution** — capacidad de cambiar el esquema (SQL, Avro, Protobuf) sin romper consumidores existentes.
- **CDC** (Change Data Capture) — replicar cambios de una BD a otra en streaming (Debezium, AWS DMS).

**Setup mínimo:**

```bash
# Postgres 17 en local para practicar
docker run -d --name pg17 -e POSTGRES_PASSWORD=root -p 5432:5432 postgres:17

# Flyway CLI
brew install flyway
flyway -version   # >= 10.x

# Liquibase (alternativa)
brew install liquibase
liquibase --version

# Herramienta de análisis de "migraciones peligrosas" para Rails/otros
gem install strong_migrations

# gh-ost para MySQL online schema change (si aplica)
brew install gh-ost

# pgroll: migraciones expand-contract nativas para Postgres (Xata, 2023)
curl -L https://github.com/xataio/pgroll/releases/latest/download/pgroll.linux.amd64 -o pgroll
chmod +x pgroll && mv pgroll /usr/local/bin/

# Debezium para CDC (opcional, requiere Kafka)
docker run -d --name kafka -p 9092:9092 apache/kafka:3.8.0
```

---

## 1. El gran cuadro

La palabra "migración" cubre tres cosas que se confunden a diario: (a) **schema migration** —añadir/quitar/renombrar columnas, cambiar tipos, dividir tablas—; (b) **service migration** —reemplazar un microservicio, mover un dominio del monolito, cambiar de base de datos—; (c) **API migration** —cambiar contratos que rompen clientes ya desplegados—. Las tres comparten un principio: **el sistema en producción no puede caer**. En 2026, para un producto SaaS de escala moderada, un minuto de downtime es un incidente que aparece en Slack; una hora es una postmortem pública; un día es un artículo en Hacker News. El equipo que sepa cambiar el motor en vuelo es el equipo que puede desplegar 50 veces al día sin miedo.

El patrón raíz es **expand-contract** —también llamado *parallel change*, formulado por Martin Fowler—: introducir el cambio en pasos donde la versión vieja y la nueva del código coexisten sin romperse. Añadir una columna es *expand*; borrar la vieja es *contract*; entre medias hay pasos de escritura dual, backfill y verificación. Aplicado a schema significa que un `RENAME COLUMN` directo —el equivalente al *big bang deploy*— es un anti-patrón; se sustituye por 6 pasos pequeños y reversibles. Aplicado a servicios se llama **strangler fig** (por la higuera australiana que rodea el árbol huésped, crece a su costa, y cuando puede sostenerse sola, el original muere y queda hueco): el sistema nuevo va absorbiendo funcionalidad hasta que el legado se puede apagar. Stripe, Shopify, GitHub, Discord, Netflix y Amazon publicaron artículos sobre migraciones de años usando estos patrones sin downtime perceptible.

El otro eje es **cómo cambias el pointer** cuando llega el cutover. **Blue/green** mantiene dos entornos completos y flipea atómicamente (AWS CodeDeploy, Lambda aliases, ALB target groups); ventaja: rollback en un click; coste: 2x infra durante la transición. **Canary** enruta 1% → 10% → 50% → 100% y automatiza el rollback si los SLIs se degradan (Flagger, Argo Rollouts, Kayenta de Netflix). **Rolling update** —default en Kubernetes y ECS— reemplaza tasks progresivamente sin duplicar infra; requiere health checks correctos y graceful shutdown. **Feature flags** desacoplan deploy de release: puedes tener el código en producción con la feature apagada y encenderla para 5% de usuarios en producción sin redeploy.

Este capítulo cubre expand-contract en detalle (con SQL real para Postgres 17), dual-write y backfill, feature flags, strangler fig, transactional outbox, evolución de contratos API y eventos, cutovers atómicos y rollback en segundos. Termina con ejercicios verificables aplicables a **LinguaDev Pro**, donde estamos migrando el catálogo de ejercicios de la primera generación (Postgres monolítico) a un modelo separado por dominio (Postgres shard + DynamoDB para hot-path + OpenSearch para búsqueda).

---

## 2. Expand-contract paso a paso (nivel medio)

### 2.1 El anti-patrón que hay que erradicar

```sql
-- BIG BANG (anti-patrón): rompe rolling deploy en producción
ALTER TABLE users ADD COLUMN last_login_at timestamptz NOT NULL DEFAULT now();
```

Problemas concretos:
1. Durante el rolling deploy, las réplicas viejas de la app no conocen la columna y sus `INSERT` sin la columna fallan por `NOT NULL`.
2. En Postgres <11 el `DEFAULT` reescribe toda la tabla (bloqueo `AccessExclusiveLock` largo).
3. Si algo va mal, el rollback del schema es otra migración destructiva.

### 2.2 La versión correcta (Postgres 11+)

Cinco pasos, cada uno seguro individualmente y reversible:

```sql
-- PASO 1 (expand): columna nullable. En PG 11+ es instantáneo (fast path).
ALTER TABLE users ADD COLUMN last_login_at timestamptz NULL;

-- PASO 2 (deploy): el código nuevo empieza a ESCRIBIR last_login_at.
--    Las réplicas viejas siguen sin escribirlo (queda NULL). OK.

-- PASO 3 (backfill): rellenar en batches idempotentes.
--    Ver §5 para el patrón completo.
DO $$
DECLARE
  last_id bigint := 0;
  batch   int    := 5000;
  rows    int;
BEGIN
  LOOP
    WITH cte AS (
      SELECT id FROM users
      WHERE id > last_id AND last_login_at IS NULL
      ORDER BY id
      LIMIT batch
    )
    UPDATE users u SET last_login_at = COALESCE(u.updated_at, u.created_at)
    FROM cte
    WHERE u.id = cte.id;
    GET DIAGNOSTICS rows = ROW_COUNT;
    EXIT WHEN rows = 0;
    SELECT MAX(id) INTO last_id FROM users WHERE id > last_id AND last_login_at IS NOT NULL LIMIT batch;
    PERFORM pg_sleep(0.1); -- self-throttling
  END LOOP;
END $$;

-- PASO 4 (opcional, validar antes de SET NOT NULL): CHECK NOT VALID
--   evita full-scan bloqueante; VALIDATE hace el scan sin bloquear escrituras.
ALTER TABLE users
  ADD CONSTRAINT users_last_login_at_notnull
  CHECK (last_login_at IS NOT NULL) NOT VALID;

ALTER TABLE users
  VALIDATE CONSTRAINT users_last_login_at_notnull;

-- PASO 5 (contract): promocionar a NOT NULL sin scan.
--   En Postgres 12+, si existe CHECK válido, SET NOT NULL no re-escanea.
ALTER TABLE users ALTER COLUMN last_login_at SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT users_last_login_at_notnull;
```

Cada paso es un commit separado en tu tool de migración (Flyway/Liquibase/pgroll). Entre cada uno hay al menos un deploy exitoso del código.

### 2.3 Índice sin bloquear escrituras

```sql
-- CREATE INDEX bloquea escrituras (default). CONCURRENTLY no.
CREATE INDEX CONCURRENTLY idx_users_last_login_at
  ON users (last_login_at DESC)
  WHERE last_login_at IS NOT NULL;

-- Si falla, el índice queda INVALID; hay que dropearlo y reintentar.
SELECT indexrelid::regclass, indisvalid
FROM pg_index WHERE indexrelid = 'idx_users_last_login_at'::regclass;
```

`CREATE INDEX CONCURRENTLY` toma más tiempo (~2x) pero no bloquea; obligatorio en tablas grandes en producción.

### 2.4 pgroll: hacer expand-contract declarativo

Xata liberó `pgroll` en 2023 (OSS). Permite declarar la migración como intent y ejecuta expand-contract con views:

```json
{
  "name": "add_last_login_at",
  "operations": [
    {
      "add_column": {
        "table": "users",
        "column": {
          "name": "last_login_at",
          "type": "timestamptz",
          "nullable": true
        },
        "up": "COALESCE(updated_at, created_at)",
        "down": "NULL"
      }
    }
  ]
}
```

Correr:

```bash
pgroll start migrations/001_add_last_login_at.json
# crea la columna nueva + view "public.users" apuntando al nuevo schema
# clientes nuevos pueden usarla; clientes viejos ven la view vieja
pgroll complete    # tras deploy exitoso: promociona
# pgroll rollback  # si algo va mal antes de complete
```

Es una capa por encima de Postgres que hace las migraciones seguras por defecto. No sustituye entender los pasos, pero elimina errores.

---

## 3. Rename de columna: el "hello world" avanzado (nivel medio → avanzado)

Renombrar `user_email` → `primary_email` en una tabla de 100M rows con 5 servicios que la leen. Secuencia de 6 pasos:

```sql
-- 1. ADD COLUMN nullable con el nombre nuevo
ALTER TABLE users ADD COLUMN primary_email text NULL;

-- 2. Deploy: código escribe en AMBAS columnas (dual-write), lee de la vieja
```
```python
def save_user(u):
    conn.execute("""
        INSERT INTO users (id, user_email, primary_email)
        VALUES (%s, %s, %s)
        ON CONFLICT (id) DO UPDATE SET
          user_email    = EXCLUDED.user_email,
          primary_email = EXCLUDED.primary_email
    """, (u.id, u.email, u.email))
```
```sql
-- 3. Backfill: rellenar primary_email desde user_email
UPDATE users SET primary_email = user_email
WHERE primary_email IS NULL AND id BETWEEN $1 AND $2;

-- 4. Deploy: código lee de primary_email con fallback a user_email
--    (por si el backfill falló en algún registro)
```
```python
def get_email(u):
    return u.primary_email or u.user_email
```
```sql
-- 5. Deploy: código solo usa primary_email. Ya nadie lee user_email.
--    Verificar en pg_stat_user_tables que idx sobre user_email tiene 0 seq/idx scans.

-- 6. Contract: drop de la columna vieja
ALTER TABLE users DROP COLUMN user_email;
```

Cada paso es reversible **hasta** el paso 6. La disciplina: no llegar al paso 6 sin ≥1 semana de operación en paso 5 sin errores.

### 3.1 ¿Y si hay 5 servicios usando la tabla?

Los pasos 2, 4, 5 se hacen **por servicio**, no globalmente. Cada servicio despliega la nueva versión; hay una ventana de días o semanas donde algunos servicios están en paso 4 y otros en 5. Es aceptable porque **ambas columnas siguen presentes y sincronizadas**.

### 3.2 Cambio de tipo de columna

Mismo patrón, más cuidado. Ejemplo: `age smallint` → `age_range enum('under18', '18-24', ...)`:

1. `ADD COLUMN age_range age_range_enum NULL;`
2. Deploy: dual-write derivando `age_range` de `age`.
3. Backfill.
4. Deploy: lecturas usan `age_range`.
5. Deploy: eliminar toda referencia a `age`.
6. `DROP COLUMN age;`

---

## 4. Feature flags como safety net (nivel medio)

### 4.1 Deploy != Release

El insight principal: puedes desplegar código nuevo sin activar la funcionalidad. La activación es un config remoto, cambiable en segundos y sin CI.

```typescript
// wrap del código nuevo en flag
const useNewCheckout = await flags.isEnabled('checkout-v2', { userId: user.id });

if (useNewCheckout) {
  return await checkoutV2(user, cart);
}
return await checkoutV1(user, cart);
```

Rollback: `checkout-v2 = OFF` desde el dashboard del provider. Segundos, sin redeploy.

### 4.2 Targeting rico

Los providers modernos (LaunchDarkly, Unleash, Flagsmith, AWS AppConfig, ConfigCat) permiten targeting por: hash de userId (canary), geografía, plan de suscripción, cohorte A/B, atributos custom.

```yaml
# Unleash (open-source) - estrategia de rollout
strategy:
  name: gradualRolloutUserId
  parameters:
    percentage: 10
    groupId: checkout-v2
constraints:
  - contextName: plan
    operator: IN
    values: [premium, business]
  - contextName: country
    operator: NOT_IN
    values: [KP, IR]
```

Cambias `percentage: 25` → efecto en <60 s en todos los clientes conectados (SSE/streaming).

### 4.3 Ciclo de vida de un flag

El **peor** anti-patrón: acumular 500 flags que llevan años activos. El código se convierte en spaghetti condicional. Reglas:

- **Owner obligatorio** por flag.
- **Expiry date obligatorio** (típicamente 2-4 semanas post-launch).
- **Cleanup automático:** el dashboard alerta flags "stale" (>N días al 100% sin cambios) y hay un proceso quincenal de PR para removerlos.
- **Naming semántico:** `experiment-*` (A/B), `release-*` (gradual rollout de feature), `kill-*` (interruptor de emergencia), `ops-*` (operacional, ej. degradar a modo read-only).

### 4.4 Kill switch para dependencias externas

Un flag "de operación" útil: `ops.openai.enabled`. Si OpenAI está caído, con un toggle sirves respuestas cacheadas o degradas graciosamente sin redeploy.

```python
if flags.is_enabled("ops.openai.enabled", default=True):
    resp = openai.chat.completions.create(...)
else:
    resp = fallback_static_response(cache_key)
```

---

## 5. Backfill correcto (nivel avanzado)

El backfill es la parte donde más migraciones han saturado producciones. Reglas duras:

1. **Chunks pequeños** (1000-10000 rows) con predicate por PK.
2. **Self-throttling:** `pg_sleep(0.1-0.5)` entre chunks; ajustar si sube el replication lag.
3. **Idempotencia:** `WHERE columna_nueva IS NULL`.
4. **Resumable:** checkpoint del último `id` procesado en una tabla auxiliar.
5. **Monitorización activa:** replication lag, IO wait, latencia p99 de la app.
6. **Horario off-peak** cuando sea posible.

### 5.1 Script de backfill Python profesional

```python
# backfill.py
import os
import time
import logging
import psycopg2
from psycopg2.extras import RealDictCursor

log = logging.getLogger(__name__)
BATCH = 5000
SLEEP_S = 0.2
LAG_CEILING_MB = 100  # si el lag sube de aquí, dormir más

def get_replication_lag_mb(conn) -> float:
    with conn.cursor() as c:
        c.execute("""
          SELECT COALESCE(EXTRACT(EPOCH FROM (now() - reply_time)),0) AS lag_s,
                 COALESCE(pg_wal_lsn_diff(sent_lsn, replay_lsn),0)/1024/1024 AS lag_mb
          FROM pg_stat_replication ORDER BY lag_mb DESC LIMIT 1
        """)
        row = c.fetchone()
        return float(row[1] if row else 0)

def get_checkpoint(conn) -> int:
    with conn.cursor() as c:
        c.execute("SELECT last_id FROM backfill_checkpoint WHERE job = 'users_email' FOR UPDATE")
        row = c.fetchone()
        return int(row[0]) if row else 0

def save_checkpoint(conn, last_id: int):
    with conn.cursor() as c:
        c.execute("""
          INSERT INTO backfill_checkpoint (job, last_id, updated_at)
          VALUES ('users_email', %s, now())
          ON CONFLICT (job) DO UPDATE SET last_id=EXCLUDED.last_id, updated_at=now()
        """, (last_id,))

def run():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    processed = 0
    last_id = get_checkpoint(conn)
    log.info("resuming from id=%d", last_id)

    while True:
        with conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute("""
              WITH batch AS (
                SELECT id FROM users
                WHERE id > %s AND primary_email IS NULL
                ORDER BY id LIMIT %s
              )
              UPDATE users u SET primary_email = u.user_email
              FROM batch WHERE u.id = batch.id
              RETURNING u.id
            """, (last_id, BATCH))
            rows = c.fetchall()

        if not rows:
            conn.commit()
            log.info("done, total=%d", processed)
            return

        last_id = max(r["id"] for r in rows)
        save_checkpoint(conn, last_id)
        conn.commit()
        processed += len(rows)

        lag = get_replication_lag_mb(conn)
        sleep = SLEEP_S * (1 + max(0, lag / LAG_CEILING_MB))
        log.info("processed=%d last_id=%d lag_mb=%.1f sleep=%.2fs",
                 processed, last_id, lag, sleep)
        time.sleep(sleep)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    run()
```

**Verificable:** en cualquier momento puedes matar el proceso; al relanzarlo, resume desde el checkpoint. `SELECT count(*) FROM users WHERE primary_email IS NULL` decrece hasta 0.

### 5.2 Herramientas dedicadas cuando el volumen lo justifica

- **pg_repack** — reorganiza tablas grandes sin `AccessExclusiveLock`.
- **gh-ost** (GitHub, MySQL) — online schema change basado en binlog, no en triggers.
- **pt-online-schema-change** (Percona, MySQL) — el clásico, basado en triggers.
- **AWS DMS** — replicación con transformación in-flight, útil para migraciones cross-DB.
- **Spark / EMR / AWS Batch** — cuando el backfill implica cómputo pesado (embeddings, features derivadas).

---

## 6. Blue/green y canary bien hechos (nivel medio)

### 6.1 Blue/green en Lambda con aliases

```yaml
# SAM template
Resources:
  ApiFn:
    Type: AWS::Serverless::Function
    Properties:
      # ...
      AutoPublishAlias: live
      DeploymentPreference:
        Type: Canary10Percent5Minutes    # 10% durante 5 min, luego 100%
        Alarms:
          - !Ref P99LatencyAlarm
          - !Ref Error5xxAlarm
        Hooks:
          PreTraffic: !Ref PreTrafficFn   # smoke tests antes de subir tráfico
          PostTraffic: !Ref PostTrafficFn # verificación tras el shift

  P99LatencyAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      MetricName: Duration
      Namespace: AWS/Lambda
      Statistic: p99
      Threshold: 800
      EvaluationPeriods: 2
      Period: 60
      ComparisonOperator: GreaterThanThreshold
      Dimensions:
        - Name: FunctionName
          Value: !Ref ApiFn
```

Tipos preconfigurados en CodeDeploy: `Canary10Percent5Minutes`, `Canary10Percent15Minutes`, `Canary10Percent30Minutes`, `Canary10PercentXMinutes`, `Linear10PercentEvery1Minute`, `Linear10PercentEvery2Minutes`, `AllAtOnce`.

### 6.2 Blue/green en ECS

CodeDeploy con ECS crea un nuevo *Task Set*, verifica health del nuevo target group, y cambia el listener del ALB del target group Blue al Green. Si algo va mal antes del switch: no hay impacto. Rollback tras el switch: revertir el listener.

```json
{
  "deploymentController": { "type": "CODE_DEPLOY" },
  "deploymentConfiguration": {
    "minimumHealthyPercent": 100,
    "maximumPercent": 200
  }
}
```

### 6.3 Canary automatizado con Flagger (Kubernetes)

Flagger (Flux CD project) es el estándar OSS para canary con análisis de métricas. Un `Canary` object:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: bff
  namespace: linguadev-prod
spec:
  targetRef: { apiVersion: apps/v1, kind: Deployment, name: bff }
  service:
    port: 8080
    gateways: [istio-ingress/public]
    hosts: [api.linguadev.pro]
  analysis:
    interval: 1m
    threshold: 5           # 5 fallos consecutivos → rollback
    maxWeight: 50          # canary crece hasta 50% antes del switch final
    stepWeight: 10
    metrics:
    - name: request-success-rate
      thresholdRange: { min: 99 }
      interval: 1m
    - name: request-duration
      thresholdRange: { max: 500 }
      interval: 1m
    webhooks:
    - name: acceptance-tests
      type: pre-rollout
      url: http://tests/run
      metadata: { curl: "curl -s https://api.linguadev.pro/health" }
    - name: load-test
      type: rollout
      url: http://tests/load
```

Flagger observa las métricas por Prometheus; si degradan, revierte automáticamente. Alternativas: Argo Rollouts (más ligado a Argo CD), Kayenta (statistical significance canary, Netflix).

### 6.4 SLIs para decisiones automáticas

Un buen canary no usa "el promedio de latencia" sino SLIs bien diseñados:

- **Success rate** = `2xx + 3xx / total` (>99% típico).
- **Latency p99** de la nueva versión vs baseline (aumenta ≥20% → rollback).
- **Saturation** — CPU, memoria, throttling metrics.
- **Business KPIs** — checkout conversion, session length, revenue-per-user si aplica.

Sin SLIs claros pre-deploy, el canary es teatro.

---

## 7. Strangler Fig: reemplazar sistemas legados (nivel avanzado)

Martin Fowler describió el patrón en 2004 tras ver higueras estranguladoras en Queensland. La estrategia práctica:

1. **Identificar seams** (uniones): endpoints, tablas, dominios que se pueden aislar sin romper el resto.
2. **Poner un proxy delante** del sistema legado (API Gateway, service mesh, reverse proxy).
3. **Implementar el primer seam en el sistema nuevo** con la misma interfaz externa.
4. **Rutear el tráfico de ese seam al nuevo** (feature flag por endpoint o por %).
5. **Iterar seam por seam** hasta que el legado quede vacío.
6. **Apagar el legado.**

### 7.1 Ejemplo real: catálogo de ejercicios en LinguaDev Pro

Legado (v1): un único servicio `content-monolith` en Postgres con 30 endpoints REST. Objetivo: separar `exercises`, `assessments` y `feedback` en tres servicios independientes con storage por-dominio.

Fase 0 — proxy delante:

```nginx
# api.linguadev.pro fronting Postgres monolith
location /api/v1/ {
  proxy_pass http://content-monolith.internal:8080;
}
```

Fase 1 — nuevo `exercises-svc` con la misma interfaz externa; rutear canary al 5%:

```yaml
# Istio VirtualService
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: { name: exercises-strangler }
spec:
  hosts: [api.linguadev.pro]
  http:
  - match:
    - uri: { prefix: /api/v1/exercises }
    route:
    - destination: { host: exercises-svc, subset: v2 }
      weight: 5
    - destination: { host: content-monolith }
      weight: 95
  - match: { uri: { prefix: /api/v1/ } }
    route:
    - destination: { host: content-monolith }
```

Fase 2 — subir a 25%, 50%, 100% con canary automatizado. Cuando el 100% de `/exercises` va al nuevo, remover el código de `exercises` del monolito.

Fase 3 — repetir para `assessments`, luego `feedback`. Cuando el monolito ya no tiene endpoints activos, apagarlo.

### 7.2 El problema real: los datos

El código es la parte fácil. El schema compartido es donde se atascan las migraciones. Estrategias:

- **Empezar por dominios de baja escritura y baja acoplación** (analytics, notifications). Deja el core transaccional para después.
- **CDC (Debezium, AWS DMS)** desde la tabla compartida a la nueva BD durante el periodo dual-write.
- **API síntesis:** si el nuevo servicio necesita datos que aún viven en el legado, expone una API interna, no comparta la tabla.
- **Anti-Corruption Layer** (DDD): capa de traducción entre modelos viejo y nuevo para que el nuevo no herede la deuda semántica.

### 7.3 Casos públicos

- **Shopify** — migración de secciones del monolito Rails a servicios de forma continuada durante años (blog: *"Deconstructing the Monolith"*).
- **Discord** — de MongoDB a Cassandra con dual-write por meses hasta el cutover.
- **GitHub** — migración de MySQL con `gh-ost` en TB de datos.
- **Amazon** — Prime Video migró un pipeline audio/video de Lambda + Step Functions a un monolito en ECS (documentado en 2023) reduciendo 90% el coste; el mismo equipo hizo el camino inverso también en otros servicios. La respuesta no es dogmática; es medida.

---

## 8. Transactional outbox y evolución de eventos (nivel avanzado)

### 8.1 El problema del "dual write"

Actualizar la BD y publicar un evento a Kafka/EventBridge en dos transacciones separadas es un anti-patrón: si la publicación falla tras el commit, el evento se pierde; si el commit falla tras publicar, hay evento fantasma.

### 8.2 Outbox pattern

Escribe el evento a una tabla `outbox` **en la misma transacción** que el cambio de estado. Un proceso separado (relay/CDC) lee la tabla y publica al broker con at-least-once.

```sql
BEGIN;
UPDATE exercises SET version = version + 1, title = $1 WHERE id = $2;
INSERT INTO outbox (id, aggregate_id, type, payload, created_at)
VALUES (gen_random_uuid(), $2, 'exercise.updated', $3::jsonb, now());
COMMIT;
```

Y el relay:

```python
def relay_loop():
    while True:
        rows = pg.execute("""
          SELECT id, type, payload FROM outbox
          WHERE published_at IS NULL
          ORDER BY created_at
          LIMIT 200
          FOR UPDATE SKIP LOCKED
        """).fetchall()
        for r in rows:
            try:
                eventbridge.put_events(Entries=[{
                    "EventBusName": "domain",
                    "Source": "linguadev.exercises",
                    "DetailType": r["type"],
                    "Detail": json.dumps(r["payload"]),
                }])
                pg.execute("UPDATE outbox SET published_at=now() WHERE id=%s", (r["id"],))
            except Exception:
                log.exception("publish failed")
                break
```

**Debezium** hace exactamente esto leyendo el WAL de Postgres (sin necesidad de tabla outbox explícita) — patrón *outbox via CDC*.

### 8.3 Evolución de eventos

Los consumidores del evento están desacoplados y desplegados en momentos distintos. Reglas para no romperlos:

- **Aditivo por defecto:** añade campos nuevos, no renombres ni elimines los existentes.
- **Versión en el `type`:** `exercise.updated.v2` cuando el schema cambia de forma incompatible; publica `v1` y `v2` en paralelo durante la transición.
- **Schema registry** (Avro/Protobuf con Confluent Schema Registry) — enforcement de compatibilidad backward/forward en el momento de publicar.
- **Nunca cambies la semántica de un campo existente.** Si `price` pasaba de céntimos a USD decimal, es un campo nuevo (`price_usd`), no un cambio de tipo.

```json
{
  "type": "exercise.updated.v2",
  "schemaVersion": 2,
  "id": "ex_01H...",
  "title": "Present Perfect vs Past Simple",
  "difficultyLevel": "B1",     // añadido en v2
  "createdAt": "2026-08-13T10:00:00Z"
}
```

---

## 9. Cutover atómico y rollback en segundos (nivel avanzado)

Migrar de Postgres self-hosted a Aurora, o de MongoDB a DynamoDB, culmina en un momento discreto: el **cutover**. Es la fase más delicada.

### 9.1 Runbook del cutover

Estructura probada:

1. **T-24h**: comunicar a stakeholders + freeze de deploys al legado.
2. **T-1h**: ensayo final en staging con datos representativos.
3. **T-15min**: bajar el tráfico de escritura a modo read-only (flag `ops.readonly=true`).
4. **T-5min**: esperar drenado de writes in-flight (queue vacía, `pg_stat_activity` sin queries INSERT/UPDATE).
5. **T-2min**: verificar `pg_stat_replication` → `replay_lsn == sent_lsn` (lag = 0).
6. **T-1min**: checksums de las tablas críticas — `SELECT md5(string_agg(row::text, ',' ORDER BY id)) FROM tabla` — o comparaciones sample con `pgcompare`.
7. **T-0**: cambiar `connection_string` en AppConfig / Parameter Store / service discovery. Rolling restart (o hot-reload si la app lo soporta) apunta al nuevo endpoint.
8. **T+30s**: reactivar escrituras (`ops.readonly=false`).
9. **T+15min**: monitor de SLIs. Si algo se desvía, `ops.readonly=true` + revertir connection string.
10. **T+24h**: postmortem público del cutover con métricas.

### 9.2 Cambiar el connection string sin redeploy

AppConfig o Parameter Store + un extension Lambda que refresca la config in-process cada 30 s:

```python
# usando AWS AppConfig SDK
import boto3, threading, time, json
_cfg = {}
_lock = threading.Lock()

def refresh():
    ac = boto3.client("appconfigdata")
    session = ac.start_configuration_session(
        ApplicationIdentifier="linguadev",
        EnvironmentIdentifier="prod",
        ConfigurationProfileIdentifier="db",
        RequiredMinimumPollIntervalInSeconds=15,
    )["InitialConfigurationToken"]
    while True:
        r = ac.get_latest_configuration(ConfigurationToken=session)
        if r["Configuration"]:
            with _lock:
                _cfg.update(json.loads(r["Configuration"].read()))
        session = r["NextPollConfigurationToken"]
        time.sleep(r["NextPollIntervalInSeconds"])

threading.Thread(target=refresh, daemon=True).start()

def get_db_url():
    with _lock:
        return _cfg.get("db_url")
```

Cambio de valor en AppConfig → propagación a todas las instancias en <30 s → nuevas conexiones van al Aurora. Rollback = editar el valor y esperar el poll.

### 9.3 Verificación de consistencia post-cutover

Comparar row counts, checksums sample, y métricas del negocio:

```sql
-- Ambas DBs conectadas via FDW
SELECT
  (SELECT count(*) FROM legacy.users) AS legacy_count,
  (SELECT count(*) FROM public.users) AS aurora_count,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id))
   FROM (SELECT id FROM legacy.users ORDER BY id LIMIT 10000) t) AS legacy_hash,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id))
   FROM (SELECT id FROM public.users ORDER BY id LIMIT 10000) t) AS aurora_hash;
```

Si diverge: NO abras escrituras al nuevo, investiga el gap.

---

## 10. Ejercicios prácticos

### 10.1 Aplicar expand-contract a una columna (60 min)

**Objetivo:** en Postgres local, añadir columna `deleted_at` a una tabla `events` de 5M rows sin bloqueo perceptible.

```bash
docker exec -it pg17 psql -U postgres -c "CREATE TABLE events (id bigserial PRIMARY KEY, payload jsonb, created_at timestamptz DEFAULT now());"
# Poblar 5M rows con generate_series + jsonb_build_object
```

Realizar los 5 pasos del §2.2 midiendo `LOCKS` con `pg_locks` durante cada uno.

**Verde:** ningún `AccessExclusiveLock` supera 100 ms, la app puede seguir queryando durante todo el proceso, y al final la columna es `NOT NULL` con constraint validado.

### 10.2 Rename column con dual-write en Node (90 min)

**Objetivo:** implementar los 6 pasos del §3 con una API Node.js + Postgres funcionando; simular 3 versiones desplegadas simultáneamente.

**Verde:** al final del proceso hay tres commits atómicos aplicables en secuencia; entre cada uno la app en cualquiera de las 3 versiones anteriores sigue respondiendo 200 OK.

### 10.3 Configurar Flyway con expand-contract (45 min)

**Objetivo:** ejemplo end-to-end de una migración añadir-backfill-notnull en Flyway con 3 archivos separados.

```
migrations/
  V20260813_1400__add_last_login_nullable.sql
  V20260813_1500__backfill_last_login.sql
  V20260813_1600__validate_and_set_notnull.sql
```

**Verde:** `flyway migrate` avanza los 3 pasos, y entre cada uno hay ventana de deploys de la app.

### 10.4 Blue/green de una Lambda con canary (60 min)

**Objetivo:** desplegar una función SAM con `Canary10Percent5Minutes` y una alarma que dispare rollback.

Inyecta un bug en la nueva versión (throwar `Error`) y observa que CodeDeploy revierte automáticamente al alcanzar el threshold de la alarma en <10 min.

**Verde:** captura del historial de deploy en CodeDeploy mostrando `Deployment failed → rolled back`.

### 10.5 Feature flag kill switch (30 min)

**Objetivo:** integrar Unleash (o AWS AppConfig) y envolver una llamada a OpenAI en un flag `ops.openai.enabled`.

**Verde:** con el flag OFF, la respuesta del endpoint viene del fallback estático en <50 ms; con el flag ON, viene de OpenAI. El toggle refleja en menos de 60 s sin redeploy.

### 10.6 Backfill resumable de 10M rows (75 min)

**Objetivo:** correr el script del §5.1 sobre una tabla de 10M rows, matarlo a la mitad, relanzarlo y verificar que resume sin duplicar trabajo.

**Verde:** `SELECT count(*) WHERE columna IS NULL` decrece monotónicamente hasta 0, y los logs muestran que tras el kill el `last_id` en checkpoint es correcto.

### 10.7 Transactional outbox con Debezium (120 min)

**Objetivo:** montar Postgres + Kafka + Debezium (con Docker Compose) y observar cómo los cambios en una tabla `orders` se replican como eventos a un topic Kafka con at-least-once.

**Verde:** un `INSERT` en Postgres aparece como mensaje en el topic Kafka en <1 s; matando Debezium y reiniciándolo, no se pierden eventos ni se duplican gracias al offset persistido.

### 10.8 Strangler Fig con Istio (90 min)

**Objetivo:** en un cluster kind, deployar `legacy-monolith` (responde `/api/v1/*`) y `exercises-svc-v2` (responde `/api/v1/exercises`); configurar VirtualService que rutee `/exercises` primero al 10% al v2 y el resto al legacy.

**Verde:** `hey -n 1000 https://.../api/v1/exercises` reporta ~10% de responses con header `x-served-by: v2` y ~90% con `x-served-by: legacy`.

### 10.9 Simulacro oficial

Cuando termines los ejercicios, resuelve el simulacro con los 24 escenarios reales de migraciones:

[`packages/content/src/tech/architecture/sim-12-migrations-zero-downtime.json`](../../packages/content/src/tech/architecture/sim-12-migrations-zero-downtime.json) — **id:** `architecture-sim-12-migrations-zero-downtime`.

Cubre blue/green, canary, rolling, expand-contract, dual-write, feature flags, backfill, cutover, rollback, schema evolution, Strangler Fig y transactional outbox. Aspira al 75% o más antes de pasar al Cap 13.

---

## Navegación

- Anterior: [Cap 11 — Lambda serverless en profundidad](./11-lambda-serverless-profundo.md)
- Siguiente: [Cap 13 — Chaos y testing en producción →](./13-chaos-y-testing-en-produccion.md)
- [Índice](./README.md)
