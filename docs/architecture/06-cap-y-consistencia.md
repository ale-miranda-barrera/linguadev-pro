# Capítulo 06 — CAP, PACELC y modelos de consistencia

> **Focus:** CAP sin mitos, PACELC como modelo moderno, jerarquía de consistency models (linearizable → causal → eventual), quorums N/W/R en Dynamo/Cassandra, DynamoDB modes, Spanner TrueTime, isolation levels DB, read-your-writes, CRDTs, fencing tokens y conflict resolution.
> **Áreas:** Db-choice · Scalability · Resilience
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 28 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Nociones básicas de bases de datos (transacciones, ACID).
- Familiaridad con al menos un motor NoSQL (DynamoDB, Cassandra, MongoDB) y uno relacional (Postgres/MySQL).
- Conocimiento previo de [Capítulo 04 — patrones de resiliencia](./04-patrones-de-resiliencia.md) para entender particiones y timeouts.
- Idealmente, haber leído los primeros capítulos de *Designing Data-Intensive Applications* (Kleppmann) — es la referencia canónica.
- Familiaridad con SQL para los ejemplos de isolation levels.

**Glosario mínimo:**
- **CAP theorem** (Brewer 2000, Gilbert-Lynch 2002): en presencia de partición de red, un sistema replicado debe elegir entre consistencia y disponibilidad.
- **PACELC** (Abadi 2010): extiende CAP — incluso sin partición hay trade-off Latencia vs Consistencia.
- **Linearizability**: propiedad de objeto único; cada operación aparece atómica en un punto entre invocación y retorno, respetando real-time.
- **Serializability**: propiedad de transacciones (multi-operación); resultado equivalente a algún orden serial.
- **Strict serializability** o **external consistency**: serializable + linearizable global (lo que ofrece Spanner con TrueTime).
- **Causal consistency**: si E1 causó E2, todos los observadores ven E1 antes que E2.
- **Session guarantees** (Terry et al. 1994): read-your-writes, monotonic reads, monotonic writes, writes-follow-reads.
- **Eventual consistency**: replicas convergen si dejas de escribir.
- **Bounded staleness**: garantía "ves datos con máximo X ms/ops de retraso".
- **Quorum N/W/R**: replicación factor N, writes a W nodos, reads de R nodos. W+R>N garantiza intersección (strong).
- **CRDT**: Conflict-free Replicated Data Type — estructuras que convergen sin coordinación.
- **HLC (Hybrid Logical Clock)**: combina wall-clock + lógica para ordering con clock skew tolerable.
- **Fencing token**: número monotónico devuelto por un lock, validado por el recurso destino.
- **Split-brain**: dos nodos actúan como primary durante una partición, aceptando writes divergentes.

**Setup mínimo:**

```bash
# Postgres 17 + REPEATABLE READ (SSI) local
docker run -d --name pg17 -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev postgres:17-alpine

# Cassandra 5.0 (2024, LTS)
docker run -d --name cass -p 9042:9042 cassandra:5.0

# ScyllaDB (alternativa Cassandra-compat, más performante)
docker run -d --name scylla -p 9042:9042 scylladb/scylla:6.2

# DynamoDB Local
docker run -d --name ddb -p 8000:8000 amazon/dynamodb-local:2.5.4

# CockroachDB (Spanner-like, strict serializable)
docker run -d --name crdb -p 26257:26257 -p 8080:8080 \
  cockroachdb/cockroach:v24.3.0 start-single-node --insecure

# Jepsen (testing consistency claims) — Docker imagen oficial
git clone https://github.com/jepsen-io/jepsen
```

---

## 1. El gran cuadro

**Consistencia en sistemas distribuidos es un espectro, no un interruptor.** La conversación tradicional —"¿es AP o CP?"— es una simplificación que Eric Brewer mismo repudió en 2012 (*CAP Twelve Years Later*). CAP describe un dilema **específico**: cuando hay una **partición de red**, un sistema replicado debe elegir entre **rechazar** requests (consistencia) o **responder con posibles datos stale** (disponibilidad). Fuera de particiones, casi todos los sistemas ofrecen ambas. Y las particiones no son elección: son un hecho de la red. La verdadera pregunta arquitectónica no es "qué letra elegir", sino "qué consistencia necesita cada operación" y "cómo se comporta el sistema cuando la red se rompe".

El segundo eje —introducido por **Daniel Abadi** en 2010 con **PACELC**— añade el trade-off que CAP oculta: incluso **sin** partición, hay un trade-off entre **latencia y consistencia**. Spanner paga ~7-14 ms de latencia por commit para ofrecer external consistency global (TrueTime waits). DynamoDB Global Tables en modo eventual completa writes en < 5 ms locales pero puede ver stale entre regiones. Cassandra con `LOCAL_QUORUM` sacrifica strong consistency por escritura sub-ms. PACELC captura esta realidad: `IF Partition, Availability vs Consistency; ELSE, Latency vs Consistency`. Cassandra es **PA/EL**, Spanner es **PC/EC**, MongoDB con `majority` es **PC/EC**.

El tercer eje es **granularidad de decisión**. El error de junior es "todo Serializable + linearizable" (caro, lento, complejo) o "todo eventual" (bugs sutiles, pérdida de datos). El senior asigna consistency **por operación**: balance bancario en Serializable + strong reads; historial de transacciones en snapshot; notificaciones en eventual + read-your-writes; scoring batch en eventual sin más. Un dashboard de banca real puede combinar 5 bases distintas con 5 niveles distintos, cada uno calibrado al valor y coste de la operación. Este capítulo cubre los modelos formales, los sistemas reales (Cassandra, DynamoDB, Spanner, Cosmos, CockroachDB, Postgres), los patrones prácticos (session guarantees, quorums, CRDTs, HLCs, fencing tokens) y termina con ejercicios verificables sobre **LinguaDev Pro**.

---

## 2. CAP, PACELC y el mito de las tres letras

### 2.1 CAP: la formulación correcta

Eric Brewer (2000, PODC keynote) planteó la conjetura; Gilbert y Lynch (2002, MIT) la probaron formalmente para un modelo restringido (linearizabilidad + total availability). La formulación **correcta**:

> Cuando ocurre una **partición de red** (P), un sistema replicado debe elegir entre garantizar **Consistencia** (C, específicamente linearizabilidad) o **Availability** (A, cada request no-fallado recibe respuesta).

Malentendidos comunes:

- ❌ "Elige 2 de 3 letras siempre". Falso: en operación normal (sin partición), casi todos los sistemas ofrecen C+A.
- ❌ "CAP es sobre escalabilidad". Falso: es sobre consistencia y availability durante particiones.
- ❌ "Cassandra es AP, MongoDB es CP". Simplista: la mayoría de sistemas son **tunables**. Cassandra con `W+R>N` se acerca a C; MongoDB con `readPreference=secondary` es AP.

Brewer mismo escribió en 2012 (*CAP Twelve Years Later*): "the only real question is what to do during a partition, and the answer depends on the specific requirements of each operation".

### 2.2 PACELC: la extensión moderna

Daniel Abadi (2010) publicó *Consistency Tradeoffs in Modern Distributed Database System Design*: PACELC captura el trade-off que CAP oculta.

> **IF** Partition (P) **THEN** Availability vs Consistency; **ELSE** (L) Latency vs Consistency.

Clasificación práctica:

| Sistema | En partición | Sin partición | Notación |
|---|---|---|---|
| Cassandra (default) | Availability | Latency | **PA/EL** |
| DynamoDB (eventual) | Availability | Latency | **PA/EL** |
| DynamoDB Global Tables (MRSC 2025+) | Consistency | Consistency | **PC/EC** |
| Spanner | Consistency | Consistency | **PC/EC** |
| CockroachDB | Consistency | Consistency | **PC/EC** |
| MongoDB (majority) | Consistency | Consistency | **PC/EC** |
| MongoDB (secondary reads) | Availability | Latency | **PA/EL** |
| Riak (default) | Availability | Latency | **PA/EL** |

Esto captura la realidad mejor que CAP puro: incluso sin partición, elegir consistencia fuerte cuesta latencia (RTT quorum, TrueTime waits, replication ack).

### 2.3 Los sistemas son tunables

En 2026, prácticamente ningún motor serio es "AP puro" o "CP puro". La configuración por operación es la norma:

- **Cassandra**: `ONE / QUORUM / ALL / LOCAL_QUORUM / EACH_QUORUM` por query.
- **DynamoDB**: `ConsistentRead=true/false` por request; MRSC para Global Tables (2025+).
- **MongoDB**: `readConcern` (`local`, `majority`, `linearizable`, `snapshot`) + `writeConcern` (`{w: 1|majority|<num>}`).
- **Cosmos DB**: 5 niveles nombrados — strong, bounded staleness, session, consistent prefix, eventual.
- **CockroachDB / Spanner**: default strict serializable; opciones para follower reads con bounded staleness.

La pregunta correcta: **¿qué consistencia necesita esta operación?** No: "¿qué logo tiene la DB?".

---

## 3. Jerarquía de consistency models

### 3.1 Del más fuerte al más débil

```
Linearizability (Herlihy-Wing 1990)
    ↓
Sequential (Lamport 1979)
    ↓
Causal (Lamport 1978, Ahamad et al. 1995)
    ↓
Session guarantees (Terry et al. 1994)
    ├── Read-your-writes
    ├── Monotonic reads
    ├── Monotonic writes
    └── Writes-follow-reads
    ↓
Eventual consistency (Vogels 2008)
```

- **Linearizability** (single-object): cada op aparece atómica en un punto entre invocación y retorno, respetando real-time. Es lo que la mayoría de gente imagina cuando dice "strong consistency".
- **Sequential**: todos los observadores ven las ops en un mismo orden, no necesariamente real-time. Más débil que linearizable.
- **Causal**: preserva happens-before. Si E1 causó E2, todos los observadores ven E1 antes que E2. Ops concurrentes pueden verse en distinto orden.
- **Session guarantees**: garantías más débiles pero suficientes para gran parte de UX. Read-your-writes evita el bug "edité mi perfil y no lo veo".
- **Eventual**: eventualmente convergen si dejas de escribir. Sin garantía de tiempo.

### 3.2 Linearizability vs Serializability: dimensiones ortogonales

Es la confusión #1 en entrevistas. Son propiedades **distintas**:

| Propiedad | Alcance | Qué garantiza |
|---|---|---|
| **Linearizability** | Objeto único | Operaciones atómicas en real-time |
| **Serializability** | Transacciones multi-op | Equivalente a algún orden serial |
| **Strict serializability** | Ambas | Serializable + real-time |

- Postgres `SERIALIZABLE` (SSI) es **serializable** pero **NO linearizable**. Puede reordenar transacciones committed a distintos wall-clocks.
- Spanner es **strict serializable** (external consistency) — combina ambas.
- Un register linearizable con transacciones no serializable es posible (dirty writes multi-key).

Ejemplo concreto:

```
T=10: tx1 commit (write X)
T=11: tx2 begin
T=12: tx2 read X → puede devolver "not-found" en un sistema serializable pero NO linearizable
```

Postgres SSI permite esto: las dos tx están serialized en algún orden, pero no en el orden temporal real. Spanner con TrueTime lo evita.

### 3.3 Session guarantees: el sweet spot pragmático

**Terry et al.** (Bayou, 1994) publicaron el paper canónico. Cuatro garantías por sesión de cliente:

1. **Read-your-writes**: después de escribir, tus lecturas ven ese write.
2. **Monotonic reads**: nunca ves "el tiempo yendo atrás" (un valor viejo tras haber visto uno nuevo).
3. **Monotonic writes**: tus writes se aplican en el orden que los enviaste.
4. **Writes-follow-reads**: si leíste V y luego escribes, tu write ocurre después de V.

**La mayoría de apps web sólo necesitan las dos primeras.** Y son baratas de implementar:

- Sticky routing por sesión (cookie/JWT → siempre al mismo shard/replica).
- Tras un write, forzar reads al primary por N segundos (o hasta que la LSN alcance).
- Client-side: pasar `X-LastWrite-LSN` en el header, el server verifica que la replica ha alcanzado.

Cosmos DB expone "Session" como uno de sus 5 niveles nombrados — es probablemente el más usado en producción real.

### 3.4 Bounded staleness

Modelo pragmático: "ves datos con máximo K operaciones **o** T tiempo de retraso". Cosmos DB lo ofrece nombrado; implementable en Postgres/MySQL con lag-aware routing.

Ventaja sobre eventual: **SLA cuantificable**. El dashboard sabe que si el lag es < 5 s, sus datos son < 5 s viejos. Sin bounded staleness, el lag puede subir a minutos silenciosamente y el dashboard mentiría sin alerta.

---

## 4. Quorums N/W/R en Dynamo y Cassandra

### 4.1 La fórmula fundamental

En un sistema estilo Dynamo (Cassandra, Riak, DynamoDB por dentro):

- **N** = replication factor (número de réplicas).
- **W** = número de réplicas que deben confirmar un write antes de devolver éxito.
- **R** = número de réplicas consultadas en un read.

**La regla:** `W + R > N` **garantiza** que cualquier read overlap con al menos un nodo que tiene el último write, dando **strong consistency** (aproximada — ver §4.3).

Ejemplo con N=3:

| W | R | W+R | Consistencia | Availability | Latencia |
|---|---|---|---|---|---|
| 3 | 1 | 4 | Strong | Write frágil (1 nodo caído → fail) | Write lenta |
| 1 | 3 | 4 | Strong | Read frágil | Read lenta |
| 2 (QUORUM) | 2 (QUORUM) | 4 | Strong | Tolera 1 caído | Balanceado |
| 1 | 1 | 2 | Eventual | Máxima | Mínima |

**Cassandra QUORUM** = `ceil(RF/2) + 1`. Con RF=3, QUORUM=2. Con RF=5, QUORUM=3.

### 4.2 CQL: elegir consistency level por query

```sql
-- Cassandra 5.0 CQL
CONSISTENCY QUORUM;
SELECT balance FROM accounts WHERE user_id = ?;

-- O por statement en el driver:
PreparedStatement ps = session.prepare(
    "SELECT balance FROM accounts WHERE user_id = ?"
).setConsistencyLevel(DefaultConsistencyLevel.QUORUM);

-- Multi-DC: LOCAL_QUORUM (solo el DC local) vs EACH_QUORUM (todos los DC)
CONSISTENCY LOCAL_QUORUM;
```

Para lecturas críticas cross-DC: `EACH_QUORUM` (todos los DC deben responder). Para lecturas de baja criticidad: `LOCAL_ONE` (más rápido, sirve del DC más cercano).

### 4.3 Trampas de W+R>N

- **Read repair asíncrono**: Cassandra puede devolver stale y **luego** reparar en background. NO es strong consistency estricta.
- **Hinted handoff**: si un nodo está caído, el write se guarda como "hint" en otro nodo y se replica cuando vuelva. Durante la ventana, W puede "cumplirse" sin todas las réplicas reales.
- **Para linearizabilidad real**: Cassandra ofrece **LWT (Lightweight Transactions)** con Paxos por partición — cuestan ~4x en latencia. Sintaxis: `INSERT ... IF NOT EXISTS`, `UPDATE ... IF col = ?`.

```sql
-- LWT: strong linearizable, pero caro
UPDATE accounts SET balance = 100 WHERE user_id = ? IF balance = 150;
```

### 4.4 DynamoDB: strong vs eventual reads

DynamoDB por default lee de una réplica cualquiera (**eventually consistent**, lag típico < 1 s). Con `ConsistentRead=true` va al leader.

**Coste:**

| Modo | RCU | Latencia | Availability |
|---|---|---|---|
| Eventual (default) | 1 RCU / read | ~5 ms | Alta |
| Strongly Consistent | 2 RCU / read | ~10-15 ms | Menor (leader necesario) |
| Transactional | 2 RCU / read | ~15-20 ms | Menor |

**Regla:** default a eventual; consistent sólo donde el bug de stale read es demostrable y crítico. Anti-patrón: `ConsistentRead=true` por todos lados "por seguridad" → factura 2x sin valor real.

```typescript
// AWS SDK v3 (2026 usa v3.700+)
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({ region: 'eu-west-1' });

// Read eventual (default, barato)
const res1 = await ddb.send(new GetItemCommand({
  TableName: 'Reviews',
  Key: { userId: { S: 'u123' }, reviewId: { S: 'r456' } },
}));

// Read strong (2x coste, para read-after-write crítico)
const res2 = await ddb.send(new GetItemCommand({
  TableName: 'Reviews',
  Key: { userId: { S: 'u123' }, reviewId: { S: 'r456' } },
  ConsistentRead: true,
}));
```

### 4.5 DynamoDB Global Tables: MREC vs MRSC (2025+)

Desde **junio 2025**, AWS ofrece **Multi-Region Strong Consistency (MRSC)** para Global Tables, con **RPO=0** (cero pérdida de datos entre regiones). Antes, Global Tables sólo ofrecía **MREC** (Multi-Region Eventual Consistency).

| Modo | Consistencia cross-región | RPO | Latencia write | Uso |
|---|---|---|---|---|
| **MREC** (default) | Eventual (LWW por timestamp) | segundos | Local (~5 ms) | Cart, feed, perfiles |
| **MRSC** (2025+) | Strong (linearizable global) | 0 | RTT cross-region | Balance, inventario, financiero |

**Importante:** el modo se elige **al crear** la tabla; no se puede cambiar después. MRSC requiere 3 regiones (2 replicantes + 1 witness). MREC sigue soportando 2+ regiones.

Elección típica:
- MREC para features donde "última wins" es aceptable y pérdida de datos concurrentes es tolerable (perfiles, cart).
- MRSC para invariantes de negocio (balance ≥ 0, stock ≥ 0, email único).

---

## 5. Spanner, TrueTime y external consistency

### 5.1 El problema del ordering global

Ordenar eventos en un sistema distribuido es difícil porque **"tiempo real" es una ilusión**: NTP tiene drift residual, VMs se pausan, redes tienen skew. Confiar en `System.currentTimeMillis()` local es fuente de bugs sutiles (LWW con clock skew → pérdida silenciosa de datos).

Lamport (1978) propuso **logical clocks** — happens-before relation. Fidge/Mattern (1988) extendieron a **vector clocks** para detectar concurrencia. Kulkarni (2014) publicó **Hybrid Logical Clocks (HLC)** — combinan wall-clock con lógica.

### 5.2 Spanner: TrueTime + Paxos + external consistency

Google publicó Spanner en 2012 (OSDI). Innovación clave: **TrueTime API**.

- **TrueTime**: retorna un intervalo `[earliest, latest]` con la garantía "el tiempo real está en algún punto de este intervalo". Infraestructura: **GPS receivers + atomic clocks** en cada datacenter. Incertidumbre típica: **~7 ms**.
- **Commit wait**: Spanner espera `latest - earliest` (típicamente 7-14 ms) antes de confirmar un commit. Garantiza que ningún observador puede ver este commit "antes" de que ocurriera realmente.
- **Resultado**: **external consistency** (= strict serializability), globalmente.

En 2026, Google Cloud sigue evolucionando Spanner — la documentación de **Spanner Omni** (self-managed, 2026) implementa una versión software del TrueTime API para entornos on-prem.

**Trade-off**: cada commit paga ~7-14 ms mínimo. Para muchos casos merece la pena; para otros no.

### 5.3 CockroachDB, YugabyteDB: Spanner-like open source

Sin acceso a GPS/atomic clocks, estas DBs usan **HLC** + **intervalos de incertidumbre**. Ofrecen serializable strict aproximado, con latencia mayor cuando la incertidumbre es alta.

```sql
-- CockroachDB 24.3: serializable strict por default
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE user_id = 'A';
UPDATE accounts SET balance = balance + 100 WHERE user_id = 'B';
COMMIT;
-- Si otra tx concurrente causa conflicto, CockroachDB devuelve
-- ERROR 40001 SerializationFailure → cliente reintenta
```

### 5.4 Vector clocks vs HLC en la práctica

- **Vector clocks**: precisos pero pesados si N clientes es grande (cada operación lleva vector de N enteros).
- **HLC**: combinan wall-clock (limitado por NTP) + lógica (para desempate). Metadata compacta (16 bytes típicamente). Adopción: MongoDB 3.6+, CockroachDB, YugabyteDB.

---

## 6. Isolation levels en DB relacional

### 6.1 ANSI SQL: los 4 niveles

Berenson et al. (SIGMOD 1995, *A Critique of ANSI SQL Isolation Levels*) formalizaron los 4 fenómenos y los 4 niveles:

| Nivel | Dirty read | Non-repeatable read | Phantom read | Lost update |
|---|---|---|---|---|
| **READ UNCOMMITTED** | ✅ posible | ✅ | ✅ | ✅ |
| **READ COMMITTED** | ❌ | ✅ posible | ✅ | ✅ |
| **REPEATABLE READ** | ❌ | ❌ | ✅ posible | ✅ posible |
| **SERIALIZABLE** | ❌ | ❌ | ❌ | ❌ |

### 6.2 Postgres: SSI (Serializable Snapshot Isolation)

Postgres 9.1+ implementa **SSI** (Cahill 2008) — es serializable **real** con overhead ~3-5% vs REPEATABLE READ, detectando conflictos y abortando una tx.

```sql
-- Postgres 17
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT balance FROM accounts WHERE user_id = 'A';
-- ... lógica ...
UPDATE accounts SET balance = balance - 100 WHERE user_id = 'A';
COMMIT;
-- Puede devolver ERROR 40001 SerializationFailure → retry loop en el cliente
```

**IMPORTANTE:** en Postgres, `REPEATABLE READ` es en realidad **Snapshot Isolation** (no el REPEATABLE READ de ANSI). Permite write skew. Sólo `SERIALIZABLE` es SSI.

Retry loop:

```typescript
async function withSerializableRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn();
      await db.query('COMMIT');
      return result;
    } catch (err) {
      await db.query('ROLLBACK');
      // 40001 = serialization_failure; 40P01 = deadlock_detected
      if ((err as any).code === '40001' && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, Math.random() * 50 * attempt));  // jitter
        continue;
      }
      throw err;
    }
  }
  throw new Error('max retries exceeded');
}
```

### 6.3 Lost update: la anomalía más común

Con READ COMMITTED (default en Postgres), dos tx concurrentes:

```sql
-- tx1: read 100, minus 30, write 70
-- tx2 (concurrent): read 100, minus 50, write 50
-- Result: 50 (perdimos 30€)
```

Soluciones (por preferencia):

1. **UPDATE atómico** con expresión en la DB:

```sql
UPDATE accounts SET balance = balance - 30 WHERE user_id = 'A';
```

2. **SELECT ... FOR UPDATE** (lock pesimista):

```sql
BEGIN;
SELECT balance FROM accounts WHERE user_id = 'A' FOR UPDATE;
-- otra tx bloquea aquí hasta commit
UPDATE accounts SET balance = ? WHERE user_id = 'A';
COMMIT;
```

3. **SERIALIZABLE** (SSI) con retry.

4. **Optimistic locking** con versión:

```sql
UPDATE accounts SET balance = ?, version = version + 1
WHERE user_id = 'A' AND version = ?;
-- si affected_rows = 0 → conflict, reintenta con nueva version
```

### 6.4 MySQL InnoDB: comportamiento peculiar

MySQL `REPEATABLE READ` (default InnoDB) **no** previene lost update sin `FOR UPDATE`. Es un bug histórico documentado. Regla: en MySQL usar `FOR UPDATE` explícito o subir a `SERIALIZABLE` para operaciones críticas.

---

## 7. CRDTs, fencing tokens y patrones prácticos

### 7.1 CRDTs: convergencia sin coordinación

**Conflict-free Replicated Data Types** (Shapiro et al., INRIA 2011) son estructuras que garantizan **convergencia matemática** sin coordinación. Cada réplica aplica ops localmente; al sincronizar, el merge es determinista y sin conflictos.

Familias:

- **State-based (CvRDTs)**: envían estado completo; merge es `join` sobre semi-lattice.
- **Op-based (CmRDTs)**: envían operaciones commutativas.

Ejemplos:

| CRDT | Uso |
|---|---|
| G-Counter | Contador sólo suma (likes, views) |
| PN-Counter | Contador suma y resta |
| LWW-Register | Valor con timestamp, último gana |
| OR-Set | Set con add y remove |
| RGA / YATA / LSEQ | Texto colaborativo |

Implementaciones production-ready 2026:

- **Yjs** (JavaScript): base de tldraw, JupyterLab collab, Linear, Rocicorp Zero.
- **Automerge**: peer-to-peer, offline-first.
- **Redis CRDBs** (Redis Enterprise): active-active geo-distribution.
- **Azure Cosmos DB**: expone CRDTs para conflict resolution custom.

Yjs mínimo (Node + WebSocket sync):

```ts
// yjs-doc.ts
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const ydoc = new Y.Doc();
const provider = new WebsocketProvider('wss://collab.linguadev.app', 'session-42', ydoc);

const ytext = ydoc.getText('note');
ytext.observe((event) => {
  console.log('changes:', event.changes.delta);
});

// Cliente escribe
ytext.insert(0, 'Hola desde offline');
// Cuando reconecta, Yjs sincroniza automáticamente con merge sin conflictos
```

**Limitación:** no toda estructura tiene CRDT natural. Listas ordenadas son difíciles; conteo con "límite máximo" (stock ≥ 0) no es CRDT viable (no commuta).

### 7.2 Fencing tokens: locks distribuidos seguros

Martin Kleppmann publicó (2016) el análisis definitivo *How to do distributed locking*. Redlock (Redis distributed lock) es **inseguro** sin fencing tokens. Escenario:

1. Worker A adquiere lock (TTL 10 s).
2. Worker A se pausa 15 s por GC.
3. Lock expira. Worker B adquiere.
4. Worker A despierta, cree tener el lock, escribe.
5. Conflicto silencioso.

**Solución:** cada adquisición devuelve un **fencing token** (número monotónicamente creciente). El **recurso destino** valida el token: rechaza escrituras con token menor al último visto.

```
Worker A: lock() → token=17 → GC pause → intenta escribir con token=17
Worker B: lock() → token=18 → escribe con token=18 → recurso guarda "last=18"
Worker A: escribe con token=17 → recurso REJECT ("token stale, last=18")
```

Zookeeper (zxid) y etcd (revision) exponen fencing tokens nativamente. **Redis Redlock no**, salvo que lo implementes por encima.

En LinguaDev Pro, si un worker procesa reviews con lock por `userId`, el patrón sería:

```python
# pseudo-código
token = etcd_client.acquire_lock(f"review-worker/{user_id}", ttl=30)
try:
    process_reviews(user_id, fencing_token=token)  # DB valida token
finally:
    etcd_client.release_lock(f"review-worker/{user_id}", token)
```

Y en la DB:

```sql
UPDATE reviews SET processed = TRUE, processor_token = $1
WHERE user_id = $2 AND (processor_token IS NULL OR processor_token < $1);
```

### 7.3 Split-brain: el escenario de pesadilla

Multi-master async con partición → ambos aceptan writes divergentes irreconciliables. Soluciones producción:

1. **Single-writer con failover rápido** (Aurora, Patroni, ProxySQL): un solo primary a la vez, failover con **fencing** (STONITH — Shoot The Other Node In The Head).
2. **Consensus** (Spanner, CockroachDB, YugabyteDB, TiDB): cada write requiere mayoría global. Paga latencia (RTT quorum).
3. **CRDT modeling** para operaciones commutativas (balance como PN-Counter suma correctamente).
4. **Application-level conflict resolution** (Riak siblings): la app decide qué hacer con versions concurrentes.

**GitHub Orchestrator octubre 2018**: split-brain famoso; 40 s de writes divergentes cross-región requirieron 24 h de reconciliación manual. Post-mortem público de lectura obligada.

### 7.4 Anti-entropy con Merkle trees

En Dynamo/Cassandra, réplicas divergen y necesitan sincronizarse periódicamente. Comparar row-by-row es O(N). **Merkle trees** (Ralph Merkle 1979) permiten O(log N):

- Cada hoja: hash de un rango de datos.
- Cada nodo interno: hash de la concatenación de sus hijos.
- Comparar roots: iguales → réplicas idénticas. Distintas → descender por subárboles divergentes hasta encontrar keys concretas que difieren.

Cassandra `nodetool repair` usa Merkle trees. Git internamente es un Merkle DAG. Bitcoin usa Merkle root para SPV clients.

---

## 8. Casos reales industria (2007-2026)

**Amazon Dynamo (SOSP 2007)**: el paper canónico. Amazon eligió **A sobre C** explícitamente para el shopping cart: "siempre writeable" era requisito para Black Friday. Cart pequeño puede quedar con siblings (ítems duplicados) reconciliados con "unión" — mejor que perder el cart entero.

**Google Spanner (OSDI 2012)**: primer sistema production con external consistency global. TrueTime + Paxos por partición + wound-wait locking. Cambió el paradigma "no puedes tener strong consistency global sin latencia prohibitiva".

**Cassandra clock skew bugs (Aphyr / Jepsen, 2013)**: Kyle Kingsbury mostró pérdida silenciosa de datos en Cassandra con LWW bajo particiones + clock skew. Consecuencia: la industria adoptó vector clocks / HLCs en nuevos sistemas.

**GitHub MySQL Orchestrator (oct 2018)**: split-brain en failover automático promocionó dos primaries. Reconciliación manual bloqueó writes 24 h. Post-mortem público — hoy GitHub usa Vitess-inspired routing.

**MongoDB Jepsen (2013-2020)**: sucesivas rondas de Jepsen descubrieron bugs de consistencia (write concern majority mal implementado, causal consistency incorrecto). MongoDB los corrigió; 4.0+ pasó tests más estrictos.

**Redis Redlock debate (Kleppmann vs Antirez, 2016)**: Kleppmann publicó *How to do distributed locking* demostrando que Redlock sin fencing tokens no es un mutex correcto. Antirez respondió; el debate público es material educativo canónico.

**Facebook TAO (ATC 2013)**: expusieron su modelo per-object sequential + read-your-writes — suficiente para social graph, más barato que linearizable. Ejemplo real de "consistencia por operación".

**CockroachDB / YugabyteDB (2016-2020)**: implementaciones open source de Spanner-like con HLC. Adopción en fintech y empresas que quieren strict serializable sin depender de GCP.

**AWS DynamoDB Global Tables MRSC GA (jun 2025)**: por primera vez, DynamoDB ofrece linearizabilidad cross-región con RPO=0. Cambia el trade-off histórico para aplicaciones críticas geo-distribuidas.

**Amazon Aurora (2015+)**: separó compute de storage compartido. Elimina replication lag conceptualmente (las réplicas leen del mismo storage layer) pero introduce sus propios trade-offs. Respuesta comercial al problema de lag.

**Instagram MongoDB migration**: bugs de timeline por replica lag les llevó a migrar partes a Cassandra. Publicaron el proceso en su tech blog.

**Discord Cassandra 5 billion messages (2022+)**: publicaron cómo particionaron con `(channel_id, bucket)` para evitar hot partitions. Migración a ScyllaDB en 2022 por performance.

**Cloudflare CRDBs / Durable Objects (2021+)**: exposición pública de CRDTs para state distribuido a escala. Modelo de programación para apps que quieren "single-object linearizable con geo-distribución".

**Figma (2021 blog *How Figma's multiplayer technology works*)**: NO usan CRDTs; usan un servidor central autoritativo con OT-like para tener control fino. Buena lectura para entender cuándo CRDTs **no** son la respuesta.

**Kubernetes etcd (2013+)**: base de coordination service para K8s. Ofrece fencing tokens (revision) usados por leader election y locks distribuidos correctos.

**Yjs adoption wave (2020-2026)**: Linear, tldraw, JupyterLab, Rocicorp Zero — CRDTs para colaboración local-first mainstream.

---

## 9. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Consistency por operación**, no por sistema.
- ✅ **PACELC** como marco mental, no CAP simplista.
- ✅ **Session guarantees** (read-your-writes, monotonic reads) como mínimo para UX.
- ✅ **Quorum W+R>N** cuando necesitas strong con multi-región de Cassandra.
- ✅ **DynamoDB ConsistentRead=true** sólo donde el bug es demostrable.
- ✅ **DynamoDB MRSC** para invariantes de negocio cross-región (2025+).
- ✅ **Postgres SERIALIZABLE con retry loop** para operaciones financieras.
- ✅ **HLC o vector clocks** para ordering distribuido, nunca wall-clock puro.
- ✅ **Fencing tokens** para todo lock distribuido; Redlock **no** es suficiente.
- ✅ **CRDTs** para colaboración offline-first cuando la operación commuta.
- ✅ **Jepsen** como referencia para claims de consistency.
- ✅ **Test bajo particiones** (Toxiproxy, Chaos Mesh) antes de confiar.
- ✅ **Idempotency-key** para toda API que muta estado externo.

### Anti-patrones

- ❌ "Cassandra es AP" como afirmación absoluta.
- ❌ Todo `ConsistentRead=true` "por seguridad" (factura 2x sin valor).
- ❌ Wall-clock del cliente para conflict resolution (LWW puro con clock skew).
- ❌ Redlock sin fencing tokens (Kleppmann 2016).
- ❌ Multi-master async para datos con invariantes (balance, stock).
- ❌ Postgres `REPEATABLE READ` esperando ANSI (es SI, permite write skew).
- ❌ MySQL InnoDB `REPEATABLE READ` sin `FOR UPDATE` para lost update.
- ❌ "Todo Serializable" (waste de recursos).
- ❌ "Todo eventual" (bugs sutiles, pérdida de datos).
- ❌ Sharding por `created_at` (hot partition garantizada).
- ❌ Confundir isolation levels con consistency models.
- ❌ Aceptar claims de vendors sin auditar con Jepsen-like tests.

### Tabla de decisión: operación → consistency

| Operación | Consistency recomendada | Motor típico |
|---|---|---|
| Balance bancario (autorización) | Serializable + linearizable | Postgres SSI / Spanner |
| Historial de transacciones | Snapshot + read-your-writes | Postgres / DynamoDB |
| Feed de notificaciones | Eventual + monotonic reads | Cassandra / DynamoDB |
| Contador de likes | Eventual (CRDT G-Counter) | Redis CRDBs / Cassandra |
| Editor colaborativo | CRDT (Yjs) | S3 + Yjs / Cosmos |
| Search index (catálogo) | Eventual (~1 s refresh) | Elasticsearch / OpenSearch |
| Scoring batch nocturno | Eventual sin más | S3 + Parquet |
| Email uniqueness (signup) | Serializable / consenso | Postgres / Spanner |
| Stock decrement (checkout) | Serializable + FOR UPDATE | Postgres |
| Session/user profile | Session (read-your-writes) | DynamoDB / Redis |
| Multi-region inventario | MRSC (DynamoDB 2025+) | DynamoDB Global Tables |

---

## 10. Ejercicios prácticos

### Ejercicio 1: implementar retry loop SERIALIZABLE en LinguaDev Pro

**Objetivo:** endpoint `POST /reviews` que actualiza el nivel del usuario usando SERIALIZABLE + retry en Postgres.

**Setup:**
- Postgres 17 local con schema `users(id, level, review_count)` y `reviews`.
- Cliente Node/Prisma o SQL crudo.

**Pasos:**
1. Implementa el endpoint que en una transacción: (a) inserta la review, (b) recalcula `review_count`, (c) actualiza `level` según lógica FSRS.
2. Usa `ISOLATION LEVEL SERIALIZABLE`.
3. Envuelve en `withSerializableRetry` (código en §6.2).
4. Test de carga con k6: 100 clientes concurrentes escribiendo reviews al mismo usuario.
5. Verifica que no hay lost updates: `review_count == COUNT(reviews)`.
6. Mide qué % de tx generan `40001` y cuántos retries en promedio.

**Criterios de éxito:**
- [ ] `review_count` siempre coincide con `COUNT(reviews)` tras el load test.
- [ ] Nivel calculado correctamente sin skew.
- [ ] Retry rate < 10% bajo carga normal, sin fallos permanentes.
- [ ] Métricas `postgres_serialization_failure_total` en Prometheus.

**Bonus:** compara con `REPEATABLE READ` (SI) — muestra que permite write skew y pierde updates.

---

### Ejercicio 2: session guarantees con read-your-writes

**Objetivo:** implementar routing sticky por sesión para evitar el bug "edité mi perfil y no lo veo".

**Setup:**
- Postgres primary + 2 read replicas con replication async.
- PgBouncer o middleware Node personalizado.

**Pasos:**
1. Después de un write (POST/PUT/DELETE), guarda `lastWriteLSN` en la sesión (cookie o Redis).
2. Antes de un read en la misma sesión: consulta `pg_last_wal_replay_lsn()` en cada replica.
3. Si alguna replica tiene LSN ≥ lastWriteLSN, sirve desde ahí; si no, sirve desde primary.
4. Test manual: edita perfil, recarga inmediatamente 10 veces → debe ver los cambios siempre.
5. Sin la lógica: reproduce el bug con toxiproxy inyectando lag en la replicación.

**Criterios de éxito:**
- [ ] Read-your-writes garantizado por sesión.
- [ ] % de reads al primary < 20% en operación normal.
- [ ] Métrica `linguadev.replica.read_your_writes.primary_fallback` en Prometheus.
- [ ] Test automatizado que reproduce el bug sin la lógica y lo evita con ella.

**Bonus:** implementar monotonic reads (nunca ver "tiempo yendo atrás") con sticky routing por sesión.

---

### Ejercicio 3: DynamoDB Global Tables MRSC vs MREC comparativa

**Objetivo:** entender el trade-off práctico entre MREC (eventual) y MRSC (strong) en 2 regiones.

**Setup:**
- Cuenta AWS con permisos para DynamoDB Global Tables.
- Cliente en 2 regiones (us-east-1 y eu-west-1).

**Pasos:**
1. Crea dos tablas: `Reviews-MREC` (eventual) y `Reviews-MRSC` (strong consistency).
2. Escribe en us-east-1, lee inmediatamente desde eu-west-1.
3. Mide lag para MREC (típicamente < 1 s).
4. Mide latencia de write en MRSC vs MREC (MRSC paga RTT cross-región).
5. Simula partición (bloquear tráfico entre regiones con security groups temporalmente):
   - MREC: writes locales siguen; leen stale.
   - MRSC: writes fallan (no hay quorum).
6. Documenta el comparativo.

**Criterios de éxito:**
- [ ] Métricas de latencia p50/p99 para write y read en ambos modos.
- [ ] Comportamiento durante partición documentado.
- [ ] Coste comparado (MRSC es ~2x el de MREC en RCUs de reads).
- [ ] Recomendación por tabla en `docs/data-model.md`.

**Bonus:** simula un escenario financiero (transferencia entre users en regiones distintas) — muestra por qué MRSC es la única opción viable.

---

### Ejercicio 4: CRDT con Yjs para notas colaborativas offline

**Objetivo:** añadir a LinguaDev Pro un módulo de notas por usuario que funcione offline y sincronice con merge sin conflictos.

**Setup:**
- Yjs 13+ instalado.
- Server WebSocket `y-websocket` o `hocuspocus`.

**Pasos:**
1. Crea `docs.linguadev/notes/:userId` como Y.Doc.
2. Cliente PWA usa `y-indexeddb` para persistir offline.
3. Cuando hay conexión, `y-websocket` sincroniza con el server.
4. Test: dos ventanas del navegador editando simultáneamente offline → reconectar → merge sin pérdida.
5. Test extremo: 3 clientes offline 1 hora, cada uno haciendo 50 ediciones → converger.
6. Documenta el garbage collection de vectores (Yjs 13+ tiene autoGC).

**Criterios de éxito:**
- [ ] Ediciones offline persistidas en IndexedDB.
- [ ] Merge tras reconexión sin conflictos manuales.
- [ ] Tamaño del CRDT crece sub-lineal con ediciones.
- [ ] Test E2E con Playwright que reproduce el escenario 3 clientes.

**Bonus:** integra Awareness API de Yjs para mostrar cursores de otros usuarios en tiempo real.

---

### Ejercicio 5: fencing tokens con etcd para worker distribuido

**Objetivo:** worker que procesa reviews en batch por usuario debe garantizar exclusión con fencing tokens (no Redlock).

**Setup:**
- etcd 3.5+ local.
- Worker Python o Go que procesa reviews.

**Pasos:**
1. Adquiere lock en etcd con `client.lock("review-worker/{user_id}")` — devuelve una revision (fencing token).
2. Al procesar, incluye el token en cada `UPDATE`:
   ```sql
   UPDATE reviews SET processed = TRUE, processor_token = $1
   WHERE user_id = $2 AND (processor_token IS NULL OR processor_token < $1);
   ```
3. Simula un GC pause en el worker A (con `time.sleep(30)`).
4. Worker B adquiere el lock (revision mayor) y procesa.
5. Worker A despierta y sus UPDATEs fallan silenciosamente (WHERE no match).
6. Verifica: cada review procesada exactamente 1 vez, con el token correcto.

**Criterios de éxito:**
- [ ] Sin duplicaciones de procesamiento.
- [ ] Métrica `linguadev.worker.stale_token_reject_total` en Prometheus.
- [ ] Test que reproduce el escenario GC pause.
- [ ] Documentar por qué Redlock plain no vale (referencia a Kleppmann).

**Bonus:** implementar el mismo patrón con Consul o Zookeeper para comparar.

---

## 11. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades junior → staff. Cubren: CAP theorem correcto (Brewer 2012 revisado), PACELC de Abadi, quorums N/W/R en Dynamo/Cassandra, jerarquía de consistency models (linearizable → causal → eventual), read-your-writes y session guarantees, CRDTs (Yjs, Automerge, Redis CRDBs), LWW y clock skew (vector clocks/HLC), split-brain en multi-master y soluciones (single-writer, consensus, CRDT), DynamoDB strong vs eventual y coste, sharding (hot partition, consistent hashing, range sharding), isolation levels (lost update, phantom, SSI en Postgres), eventual consistency apropiada por caso de uso, idempotency + deduplication con Idempotency-Key, fencing tokens (Redlock inseguro, etcd/Zookeeper), causal consistency práctica (COPS, Facebook TAO), bounded staleness (Cosmos DB), conflict resolution strategies (LWW, CRDT, siblings, custom merge), linearizability vs serializability (ortogonales), replica lag y sus riesgos, choosing consistency per operation (banking architecture), y anti-entropy con Merkle trees.

- **Fuente:** [`packages/content/src/tech/architecture/sim-06-cap-and-consistency.json`](../../packages/content/src/tech/architecture/sim-06-cap-and-consistency.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-06-cap-and-consistency`
- **Tiempo:** 28 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 05 — observabilidad y escala](./05-observabilidad-y-escala.md) · [Capítulo 07 — event sourcing y CQRS →](./07-event-sourcing-y-cqrs.md) · [Índice](./README.md)
