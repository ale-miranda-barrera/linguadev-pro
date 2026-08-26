# Capítulo 07 — Event Sourcing y CQRS

> **Focus:** Los eventos como fuente de verdad, la separación entre el modelo de escritura y el de lectura, y por qué "exactly-once" es un mito bien vendido.
> **Áreas:** messaging · microservices · scalability
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 28 min · **Pass:** 75%
> **Nivel:** Medio → Avanzado (senior/staff)

## 0. Antes de empezar

**Pre-requisitos:**
- Conocer el CRUD tradicional (INSERT/UPDATE/DELETE) y por qué pierde historia.
- Nociones de mensajería asíncrona: broker, topic, partition, consumer group.
- Idealmente haber leído [Cap 06 — CAP y consistencia](./06-cap-y-consistencia.md); el trade-off availability/consistency aparece en cada decisión de este capítulo.
- Familiaridad con al menos un motor de mensajería (Kafka, RabbitMQ, SQS).

**Glosario mínimo:**
- **Event Sourcing (ES):** persistir los cambios de estado como una secuencia inmutable de eventos; el estado actual se calcula (fold) sobre esa secuencia.
- **CQRS:** *Command Query Responsibility Segregation*, separar el modelo de escritura del modelo de lectura.
- **Event Store:** base de datos append-only especializada en eventos (EventStoreDB, Marten, Axon Server, o Kafka usado como log).
- **Projection / read model:** vista desnormalizada construida consumiendo eventos, optimizada para queries.
- **Snapshot:** foto materializada del estado de un agregado tras N eventos, para acortar el replay.
- **Upcaster:** función que traduce un evento con schema viejo a la representación actual al leerlo.
- **Outbox pattern:** persistir el evento a publicar en la misma transacción que el cambio de dominio, para eliminar el *dual write problem*.
- **Idempotencia:** propiedad de que aplicar la misma operación N veces produce el mismo resultado que aplicarla 1 vez.
- **Exactly-once processing:** garantía efectiva lograda con *at-least-once delivery* + consumers idempotentes.
- **DCB (Dynamic Consistency Boundary):** feature moderno (Axon 5.x, 2026) que permite escribir eventos consultando streams múltiples con optimistic locking, más flexible que los agregados clásicos.

**Setup mínimo:**

```bash
# Kafka local (KRaft, sin ZooKeeper) para experimentar
docker run -d --name kafka -p 9092:9092 \
  -e KAFKA_ENABLE_KRAFT=yes \
  -e KAFKA_CFG_PROCESS_ROLES=broker,controller \
  -e KAFKA_CFG_NODE_ID=1 \
  -e KAFKA_CFG_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 \
  -e KAFKA_CFG_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093 \
  -e KAFKA_CFG_ADVERTISED_LISTENERS=PLAINTEXT://localhost:9092 \
  -e KAFKA_CFG_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  -e ALLOW_PLAINTEXT_LISTENER=yes \
  bitnami/kafka:3.9

# EventStoreDB (rebrand: KurrentDB desde 2025; imagen 24.10.x)
docker run -d --name eventstore -p 2113:2113 -p 1113:1113 \
  eventstore/eventstore:24.10.13-jammy \
  --insecure --run-projections=All --enable-atom-pub-over-http

# Postgres + Debezium para outbox / CDC
docker run -d --name postgres -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  postgres:16 -c wal_level=logical

# Herramientas de línea
brew install kcat            # productor/consumidor Kafka rápido
pnpm add -D @eventstore/db-client
pnpm add -D kafkajs zod
```

---

## 1. El gran cuadro

El CRUD tradicional guarda el **estado actual** y pierde la **historia**: cuando un usuario cambia su email, la fila `users(email)` se sobrescribe y la información previa desaparece salvo que alguien haya montado auditoría manual. Event Sourcing invierte el modelo: la fuente de verdad es una **secuencia inmutable de eventos** (`UserRegistered`, `EmailChanged`, `EmailChanged`, `AccountClosed`), y el estado actual es una **proyección derivable** en cualquier momento. La consecuencia inmediata es que ganas audit log gratis, time travel, capacidad de reconstruir vistas nuevas retroactivamente y una integración natural con arquitecturas event-driven; el coste es complejidad conceptual, schema evolution difícil y latencia adicional en las lecturas.

CQRS, formalizado por Greg Young alrededor de 2010, es un patrón **ortogonal**: separa el modelo de escritura (comandos que validan invariantes) del modelo de lectura (proyecciones desnormalizadas optimizadas por query). Puedes hacer CQRS sin Event Sourcing (dos modelos sincronizados por CDC o events sencillos) y puedes hacer Event Sourcing sin CQRS (leer directamente los agregados reconstruidos), pero ambos combinan muy bien: los comandos generan eventos, las proyecciones consumen esos eventos para materializar tablas de lectura. En 2026 la conjunción `ES + CQRS + streaming platform` es la arquitectura por defecto de sistemas donde la auditoría, la trazabilidad y la capacidad de generar nuevas vistas históricamente relevantes son requisitos duros (banca, health, aviación, marketplaces con disputas, cualquier producto donde "¿cómo llegamos a este estado?" es una pregunta legítima).

La tercera pata del capítulo es el reconocimiento profesional de un límite físico: **exactly-once delivery no existe en sistemas distribuidos con fallos** (Two Generals Problem, Akkoyunlu 1975). Lo que Kafka ofrece desde 2017 (EOS, *Exactly-Once Semantics*) es exactly-once *processing* **dentro** de Kafka (leer, procesar, escribir a otro topic atómicamente). Los side effects externos (cargar una tarjeta en Stripe, enviar un email, invocar una Lambda) quedan fuera de esa transacción y **deben** ser idempotentes por diseño. Este malentendido está detrás de cargos duplicados, emails triplicados y bugs de finanzas que han costado a empresas millones. Todo el capítulo gira en torno a esa asimetría entre "lo que Kafka garantiza" y "lo que tu sistema realmente necesita garantizar".

El impacto acumulado se traduce en cinco decisiones que aparecerán una y otra vez en el resto del texto: cómo estructurar el event store (EventStoreDB/Kurrent, Kafka como log, Postgres con Marten), cómo diseñar los agregados y sus boundaries, cómo publicar los eventos sin el *dual write problem* (outbox), cómo hacer los consumers idempotentes (dedup table, natural upserts, idempotency keys) y cómo evolucionar el schema sin romper años de historia. En LinguaDev Pro este patrón encaja de manera natural en el motor FSRS: cada review es un evento inmutable, los parámetros stability/difficulty son proyección, y añadir un nuevo dashboard (por ejemplo, churn analysis) es cuestión de escribir un consumer sobre el log existente, no de migrar tablas.

---

## 2. Fundamentos de Event Sourcing (nivel medio)

### 2.1 De CRUD a event log

En un modelo CRUD tradicional, la operación *"el usuario cambia su nombre"* se traduce en un `UPDATE users SET name = 'Ale' WHERE id = 42`. El estado nuevo aplasta al viejo. Con Event Sourcing la misma operación se materializa como un evento inmutable persistido en append-only:

```json
{
  "streamId": "user-42",
  "eventNumber": 7,
  "eventType": "UserNameChanged",
  "eventId": "b1e6…",
  "occurredAt": "2026-08-13T09:12:33Z",
  "data": { "previousName": "Alejandro", "newName": "Ale", "reason": "typo-fix" },
  "metadata": { "correlationId": "req-9f…", "causationId": "cmd-3d…", "userId": "42" }
}
```

Cuando quieres el estado actual del usuario, cargas todos los eventos del stream `user-42` y aplicas el fold:

```ts
type UserState = { id: string; name: string; email: string; closed: boolean };

function apply(state: UserState, event: DomainEvent): UserState {
  switch (event.eventType) {
    case 'UserRegistered':
      return { id: event.data.id, name: event.data.name, email: event.data.email, closed: false };
    case 'UserNameChanged':
      return { ...state, name: event.data.newName };
    case 'EmailChanged':
      return { ...state, email: event.data.newEmail };
    case 'AccountClosed':
      return { ...state, closed: true };
    default:
      return state;
  }
}

function rebuild(events: DomainEvent[]): UserState {
  return events.reduce(apply, {} as UserState);
}
```

Ganancia inmediata: puedes reconstruir el estado a **cualquier punto pasado** truncando el array por `occurredAt`. Puedes añadir mañana un dashboard "usuarios que cambiaron nombre más de 3 veces" sin migración: escribes un consumer sobre el log existente. Y puedes debuggear un bug en producción replicando los eventos exactos que llevaron al estado inconsistente.

### 2.2 Aggregate boundary

El agregado (DDD) es la unidad de consistencia. Todos los eventos de un mismo agregado van al mismo stream, y al aplicar un comando se cargan **todos** los eventos, se calcula el estado, se valida la invariante, se emiten los nuevos eventos y se persisten con optimistic locking (versión esperada). Ejemplo canónico en Node/TypeScript sobre EventStoreDB (`@eventstore/db-client` 6.x, compatible con Kurrent 24.10):

```ts
import { EventStoreDBClient, jsonEvent, START, FORWARDS, StreamNotFoundError } from '@eventstore/db-client';

const client = EventStoreDBClient.connectionString`esdb://localhost:2113?tls=false`;

type AccountState = { balance: number; closed: boolean; version: bigint };

async function loadAccount(id: string): Promise<AccountState> {
  const streamName = `account-${id}`;
  let state: AccountState = { balance: 0, closed: false, version: -1n };
  try {
    for await (const resolved of client.readStream(streamName, { direction: FORWARDS, fromRevision: START })) {
      const e = resolved.event!;
      state = applyAccount(state, e.type, e.data as any);
      state.version = e.revision;
    }
  } catch (err) {
    if (!(err instanceof StreamNotFoundError)) throw err;
  }
  return state;
}

function applyAccount(state: AccountState, type: string, data: any): AccountState {
  switch (type) {
    case 'AccountOpened': return { balance: 0, closed: false, version: state.version };
    case 'MoneyDeposited': return { ...state, balance: state.balance + data.amount };
    case 'MoneyWithdrawn': return { ...state, balance: state.balance - data.amount };
    case 'AccountClosed':  return { ...state, closed: true };
    default: return state;
  }
}

export async function withdraw(accountId: string, amount: number, correlationId: string) {
  const state = await loadAccount(accountId);
  if (state.closed) throw new Error('AccountClosed');
  if (state.balance < amount) throw new Error('InsufficientFunds');

  const event = jsonEvent({
    type: 'MoneyWithdrawn',
    data: { amount },
    metadata: { correlationId, causationId: correlationId },
  });

  await client.appendToStream(`account-${accountId}`, event, {
    expectedRevision: state.version, // optimistic concurrency
  });
}
```

Reglas duras para elegir el boundary:

- Un agregado debe caber en una sola transacción y **cambiar por completo o no cambiar**.
- Las invariantes que deben mantenerse siempre (`balance >= 0`, `orderItems.length <= 100`) viven dentro del agregado.
- Si dos entidades necesitan orden mutuo estricto, considera unirlas en el mismo agregado.
- Si un agregado crece indefinidamente (500k eventos), o lo particionas en agregados menores (`Account` + `AccountLedger[year]`) o introduces snapshots.

### 2.3 CQRS y proyecciones

Con CQRS separas dos caminos:

- **Write side:** recibe comandos, valida invariantes, produce eventos, los persiste.
- **Read side:** consume esos eventos, actualiza proyecciones (tablas SQL, índices Elastic, cache Redis, S3+Athena).

La proyección puede tener múltiples formas simultáneas: una tabla `account_summary` para el dashboard, un índice Elasticsearch `account_transactions` para búsqueda, un materialized view `daily_balances` para reporting. Todas se derivan del mismo log.

```ts
// Projection worker: consume el stream $all y actualiza Postgres
import { EventStoreDBClient, START, ALL } from '@eventstore/db-client';
import { Client as Pg } from 'pg';

const es = EventStoreDBClient.connectionString`esdb://localhost:2113?tls=false`;
const pg = new Pg({ connectionString: process.env.PG_URL });
await pg.connect();

const CHECKPOINT = 'account_summary';

async function loadCheckpoint(): Promise<bigint> {
  const r = await pg.query('SELECT position FROM projection_checkpoint WHERE name=$1', [CHECKPOINT]);
  return r.rows[0]?.position ? BigInt(r.rows[0].position) : 0n;
}

async function run() {
  const from = await loadCheckpoint();
  for await (const resolved of es.subscribeToAll({ fromPosition: from > 0n ? { commit: from, prepare: from } : START })) {
    const ev = resolved.event;
    if (!ev || !ev.type.startsWith('Account')) continue;
    await pg.query('BEGIN');
    try {
      await handle(ev.streamId, ev.type, ev.data as any);
      await pg.query(
        `INSERT INTO projection_checkpoint(name, position) VALUES ($1,$2)
         ON CONFLICT (name) DO UPDATE SET position = EXCLUDED.position`,
        [CHECKPOINT, resolved.commitPosition!.toString()],
      );
      await pg.query('COMMIT');
    } catch (err) {
      await pg.query('ROLLBACK');
      throw err;
    }
  }
}
```

Consecuencias intrínsecas del patrón:

- **Eventual consistency:** el usuario hace un cambio, refresca y ve datos viejos por 100 ms a 3 s. Es característica, no bug.
- **Rebuild de proyección** es un consumer nuevo desde `START` de la posición 0 del log. Blue-green: construyes la nueva mientras la vieja sirve tráfico, cambias cuando alcances el tail.
- **UX aware:** optimistic UI que muestra el resultado del comando de inmediato + version token para saber cuándo el read side alcanzó ese comando.

### 2.4 Snapshots

Cuando un agregado tiene 500 000 eventos, replay en cada carga es inviable. Solución: cada N eventos (100, 1000, 10 000 según agregado) o cada X tiempo, persiste el estado calculado en un store separado. Al cargar, tomas el último snapshot y aplicas solo los eventos posteriores.

```ts
type Snapshot<T> = { state: T; version: bigint; takenAt: string };

async function loadWithSnapshot(id: string): Promise<AccountState> {
  const snap = await snapshotStore.latest<AccountState>(`account-${id}`);
  let state = snap?.state ?? { balance: 0, closed: false, version: -1n };
  const from = snap ? snap.version + 1n : START;
  for await (const r of client.readStream(`account-${id}`, { direction: FORWARDS, fromRevision: from })) {
    state = applyAccount(state, r.event!.type, r.event!.data as any);
    state.version = r.event!.revision;
  }
  return state;
}
```

Los snapshots son **optimización cacheada**, no source of truth. El log de eventos sigue siendo inmutable y auditable; los snapshots pueden invalidarse y regenerarse cuando cambia el shape del agregado. Axon Framework tiene `SnapshotTriggerDefinition`; EventStoreDB/Kurrent lo hace vía projections dedicadas.

### 2.5 Event vs Command

Confundir estos dos rompe la semántica del sistema.

| Aspecto | Command | Event |
|---|---|---|
| Naming | Imperativo: `PlaceOrder`, `SendEmail` | Pretérito: `OrderPlaced`, `EmailSent` |
| Semántica | Intención — todavía no ha pasado | Hecho — ya pasó, inmutable |
| Destino | UN handler (validación + decisión) | N consumers pueden reaccionar |
| Puede fallar | Sí (rechazo por invariante) | No, ya es historia |
| Transporte | Queue / RPC / command bus | Topic pub/sub |

Un topic `SendEmail` (nombre imperativo) al que se subscriben dos consumers enviará el email **dos veces**. El nombre correcto para un topic pub/sub es `EmailRequested` (evento) o mejor: define un command `SendEmail` con un único handler, y emite `EmailSent` cuando termine.

---

## 3. Event store, delivery y patrones intermedios (nivel senior)

### 3.1 EventStoreDB (Kurrent), Axon y Kafka como event log

Tres familias dominantes en 2026:

- **EventStoreDB / KurrentDB** (rebrand del 2025, versión 24.10 actual): base de datos append-only especializada, streams por agregado, projections built-in, catch-up subscriptions, contrato HTTP + gRPC. Ideal para dominios event-sourced puros. Añadió en 24.2 conectores HTTP sink, OpenTelemetry exporter y catch-up subscription mode change sin drops.
- **Axon Framework** (JVM, versión estable 4.10 en producción, 5.1-RC2 avanzando en 2026 con soporte DCB, Spring Boot 4.x y replay status mejorado): framework Java/Kotlin que abstrae command bus, event store, saga manager y query bus. Backend puede ser Axon Server, JPA, EventStoreDB.
- **Kafka como event log**: cuando ya tienes Kafka, KRaft (sin ZooKeeper desde 2.8, producción-ready desde 3.5) permite usarlo como store *event-sourced-like*. Necesitas complementar con un state store (RocksDB de Kafka Streams, materialización en Postgres) para reconstrucciones eficientes.

Ejemplo Java con Axon 4.10 mostrando el estilo agregado + command handler + event sourced state:

```java
@Aggregate
public class OrderAggregate {

    @AggregateIdentifier
    private String orderId;
    private OrderStatus status;
    private Money total;

    protected OrderAggregate() {}

    @CommandHandler
    public OrderAggregate(PlaceOrderCommand cmd) {
        if (cmd.items().isEmpty()) throw new IllegalArgumentException("empty order");
        AggregateLifecycle.apply(new OrderPlacedEvent(
                cmd.orderId(), cmd.customerId(), cmd.items(), Instant.now()));
    }

    @CommandHandler
    public void handle(PayOrderCommand cmd) {
        if (status != OrderStatus.PLACED) throw new IllegalStateException("not payable");
        AggregateLifecycle.apply(new OrderPaidEvent(orderId, cmd.paymentReference(), Instant.now()));
    }

    @EventSourcingHandler
    public void on(OrderPlacedEvent e) {
        this.orderId = e.orderId();
        this.status = OrderStatus.PLACED;
        this.total = e.items().stream().map(Item::total).reduce(Money.ZERO, Money::add);
    }

    @EventSourcingHandler
    public void on(OrderPaidEvent e) {
        this.status = OrderStatus.PAID;
    }
}
```

Axon replay-friendly: `TrackingEventProcessor` gestiona catch-up subscriptions con checkpoints y permite `resetTokens()` para rebuild de proyecciones.

### 3.2 El *dual write problem* y el outbox pattern

Si en tu handler haces `INSERT en Postgres` y luego `producer.send(kafkaEvent)`, tienes dos sistemas distintos sin transacción común. Escenarios:

- Postgres commit OK → Kafka send falla → **evento perdido**.
- Kafka send OK → Postgres rollback → **evento fantasma**.

Solución: **outbox pattern** (Chris Richardson). Dentro de la misma transacción local escribes tanto la fila de dominio como una fila en la tabla `outbox`. Un processor asíncrono (o Debezium leyendo el WAL) lee la outbox y publica a Kafka, marcando como enviado.

```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL,
  status TEXT NOT NULL,
  total_cents BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE outbox (
  id BIGSERIAL PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id  UUID NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  headers       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);

CREATE INDEX outbox_unsent_idx ON outbox (id) WHERE published_at IS NULL;
```

```ts
// Command handler node/pg
await pg.query('BEGIN');
try {
  await pg.query('INSERT INTO orders(id, customer_id, status, total_cents, updated_at) VALUES ($1,$2,$3,$4,now())',
                 [orderId, customerId, 'PLACED', totalCents]);
  await pg.query(
    `INSERT INTO outbox(aggregate_type, aggregate_id, event_type, payload, headers)
     VALUES ('Order', $1, 'OrderPlaced', $2::jsonb, $3::jsonb)`,
    [orderId, JSON.stringify(payload), JSON.stringify({ correlationId })],
  );
  await pg.query('COMMIT');
} catch (err) {
  await pg.query('ROLLBACK');
  throw err;
}
```

Publicación: **Debezium** leyendo el WAL de Postgres es la implementación de referencia en 2026 (Kafka Connect, near real-time, sin polling). Alternativa low-tech: un job cada 500 ms `SELECT ... WHERE published_at IS NULL FOR UPDATE SKIP LOCKED LIMIT 100`, produce a Kafka, `UPDATE outbox SET published_at = now()`.

Consecuencias: la outbox garantiza **at-least-once** delivery hacia Kafka. Combinada con consumers idempotentes obtienes exactly-once *processing* efectivo.

### 3.3 Schema evolution y upcasters

Los eventos viven **para siempre**. Un `OrderPlacedV1` de 2023 sigue en el log en 2026. Reglas de compatibilidad (Avro/Protobuf con Schema Registry):

- Añadir campo opcional con default: **backward-compatible** (readers viejos lo ignoran, nuevos usan el default).
- Renombrar campo: **breaking** (usa aliases en Avro).
- Cambiar tipo: **breaking**, salvo widening estricto.
- Remover campo con default: **forward-compatible** solamente.

Cuando el shape del evento cambia lo suficiente, la técnica canónica es el **upcaster**: al leer un evento viejo, se transforma al schema actual antes de entregarlo al handler. Axon lo expone con `EventUpcaster`; en un event store custom es una función de mapeo por versión.

```ts
type StoredEvent = { type: string; version: number; data: any };

function upcast(evt: StoredEvent): StoredEvent {
  if (evt.type === 'OrderPlaced' && evt.version === 1) {
    // v1 tenía "total" en unidades enteras; v2 usa cents
    return {
      type: 'OrderPlaced',
      version: 2,
      data: { ...evt.data, totalCents: Math.round(evt.data.total * 100) },
    };
  }
  return evt;
}
```

Nunca reescribas eventos viejos in-place: destruyes auditoría. El upcaster mantiene la historia intacta y traduce en lectura.

### 3.4 El mito de exactly-once y las estrategias que sí funcionan

Dos Generales (Akkoyunlu 1975): no existe algoritmo que garantice consenso en canal no confiable. Corolario: **exactly-once delivery de red es imposible**. Lo que la industria llama "exactly-once" en 2026 es una de estas dos cosas:

- **Kafka EOS** (0.11+, `processing.guarantee=exactly_once_v2`): atomicidad de leer-procesar-escribir dentro de Kafka via idempotent producer + transactions. **No** cubre side effects externos.
- **At-least-once + consumer idempotente**: la solución universal cuando hay side effects externos (HTTP, DB no-Kafka, email).

Mecanismos válidos de deduplicación en el consumer:

1. **Dedup table**: `(event_id → processed_at)` guardado en la misma transacción que el side effect.
2. **Natural idempotency**: modelar la operación como upsert o SET absoluto (`SET balance = X`) en vez de delta.
3. **Idempotency-Key externa**: pasar el `event_id` como `Idempotency-Key` a Stripe / PayPal / cualquier API seria que soporte dedup.
4. **State machine con versión**: `UPDATE order SET status = 'PAID' WHERE id = X AND status = 'PLACED'` — segundo intento no-op.

Anti-patrón clásico: confiar en el offset de Kafka como identifier de negocio. Los offsets son metadatos del broker, no del evento; reasignaciones de partición y replay los invalidan.

```ts
// Consumer idempotente con dedup table + side effect en tx
async function handleCharge(event: ChargeUserEvent) {
  await pg.query('BEGIN');
  try {
    const dup = await pg.query('INSERT INTO processed_events(event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
                               [event.id]);
    if (dup.rowCount === 0) {
      await pg.query('ROLLBACK');
      return; // ya procesado
    }
    await pg.query('UPDATE accounts SET balance = balance - $1 WHERE user_id = $2', [event.amount, event.userId]);
    await stripe.paymentIntents.create({ amount: event.amount, currency: 'usd', customer: event.userId }, {
      idempotencyKey: event.id, // clave para Stripe
    });
    await pg.query('COMMIT');
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err; // Kafka reintentará
  }
}
```

### 3.5 Partitioning y ordering en Kafka

Kafka garantiza orden **por partición**, no global. La partition key define el grupo de ordering. Regla: la key = la entidad sobre la que necesitas orden. Para eventos de orden (`OrderPlaced → OrderPaid → OrderShipped`), la key debe ser `order_id`. Los eventos de la misma orden aterrizan en la misma partición y consumer, orden preservado; distintas orders se reparten para paralelismo.

Errores clásicos:

- `partition_key = timestamp` → hotspot en la última partición.
- Sin key (round-robin) → orden roto entre eventos que dependen unos de otros.
- `partition_key = user_id` cuando lo que importa es el orden dentro de una orden concreta.

Un cambio de partition key en un topic existente es una **migración dolorosa**: hay que crear topic nuevo, republicar y switchear consumers. Elige bien desde el día uno.

---

## 4. Patrones avanzados (nivel staff)

### 4.1 Sagas y procesos de larga duración

Una operación de negocio que cruza varios agregados/servicios (reserva de viaje = flight + hotel + car + payment) no puede ser una transacción distribuida (2PC casi nunca es viable). Se modela como **saga**: una secuencia de pasos donde cada paso local commit y, si algo falla, se ejecutan **compensaciones** hacia atrás.

Dos estilos:

- **Choreography**: cada servicio reacciona a eventos del resto. Bajo acoplamiento pero flow implícito, debugging disperso, compensaciones caóticas. Escala mal a >3-4 pasos.
- **Orchestration**: un director central (Temporal, Cadence, AWS Step Functions, Camunda 8) mantiene el estado del proceso, invoca cada paso, maneja timeouts, ejecuta compensaciones declarativas. Overhead extra pero flow explícito, versionable y observable.

Ejemplo con Temporal (TypeScript SDK 1.11 en 2026):

```ts
// bookTravelWorkflow.ts
import { proxyActivities, ApplicationFailure } from '@temporalio/workflow';
import type * as acts from './activities';

const { bookFlight, bookHotel, bookCar, chargeCustomer, refund, cancelFlight, cancelHotel, cancelCar } =
  proxyActivities<typeof acts>({ startToCloseTimeout: '30s', retry: { maximumAttempts: 5 } });

export async function bookTravelWorkflow(input: TravelRequest): Promise<TravelResult> {
  const flight = await bookFlight(input.flight);
  try {
    const hotel = await bookHotel(input.hotel);
    try {
      const car = await bookCar(input.car);
      try {
        const receipt = await chargeCustomer(input.customerId, flight.price + hotel.price + car.price);
        return { flight, hotel, car, receipt };
      } catch (err) {
        await cancelCar(car.id); throw err;
      }
    } catch (err) {
      await cancelHotel(hotel.id); throw err;
    }
  } catch (err) {
    await cancelFlight(flight.id);
    throw new ApplicationFailure('BookingFailed', 'BookingFailed', true, [String(err)]);
  }
}
```

Netflix migró de choreography a Conductor precisamente por caos operacional en flows complejos; Uber usa Cadence/Temporal para 100+ workflows críticos.

### 4.2 Projection rebuild sin downtime

Cuando añades una proyección nueva o cambias el shape de una existente, el approach canónico es **blue-green rebuild**: creas un consumer group nuevo, offset earliest, construye el nuevo store completo mientras el viejo sigue sirviendo. Cuando alcanza el tail (lag sub-segundo), atomic switch de tráfico y elimina el viejo.

```yaml
# Kubernetes: dos deployments de la misma proyección, distinto suffix
apiVersion: apps/v1
kind: Deployment
metadata: { name: account-projection-v2 }
spec:
  replicas: 4
  selector: { matchLabels: { app: account-projection, version: v2 } }
  template:
    metadata: { labels: { app: account-projection, version: v2 } }
    spec:
      containers:
      - name: worker
        image: linguadev/account-projection:2.0.0
        env:
        - { name: KAFKA_GROUP_ID,    value: "account-projection-v2" }
        - { name: KAFKA_AUTO_OFFSET, value: "earliest" }
        - { name: PG_TABLE,          value: "account_summary_v2" }
```

Cambio del alias del servicio (Kubernetes Service `selector: version=v2`) es la atomic switch. Con Kafka retention adecuada (`retention.ms=-1` para topics compacted o meses de retention para no-compacted) esto es rutina, no proyecto.

### 4.3 Compacted topics y materialized views

`cleanup.policy=compact` en un topic Kafka retiene **al menos** el último valor por key. Ideal para "log as database": user profiles, feature flags, configs. Un consumer que lee desde `earliest` obtiene el estado actual, no la historia completa.

```bash
kafka-topics.sh --bootstrap-server localhost:9092 --create --topic user-profiles \
  --partitions 12 --replication-factor 3 \
  --config cleanup.policy=compact \
  --config min.compaction.lag.ms=60000 \
  --config delete.retention.ms=86400000
```

Tombstones (`value=null`) marcan deletion. Kafka Streams `KTable` está construido sobre este mecanismo. Trade-off: pierdes historial detallado (para audit conserva un topic paralelo no compactado).

### 4.4 Dead letter queues y poison messages

Un evento con schema roto puede colgar la partición eternamente si el consumer entra en crash-loop. El patrón canónico es el **DLQ**: tras N reintentos, mueve el evento a un topic `orders-events-dlq` con metadatos (error, attempts, timestamp), alerta al equipo y sigue procesando.

```ts
async function safeHandle(event: any) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await handle(event); }
    catch (err) {
      await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
    }
  }
  await dlqProducer.send({
    topic: 'orders-events-dlq',
    messages: [{ key: event.id, value: JSON.stringify({ event, error: 'max-retries', ts: Date.now() }) }],
  });
  metrics.dlqCounter.inc({ topic: 'orders-events' });
}
```

AWS SQS tiene DLQ nativo (`RedrivePolicy.maxReceiveCount`). RabbitMQ tiene `x-dead-letter-exchange`. Kafka requiere implementación (Spring Kafka `DeadLetterPublishingRecoverer`, o custom). Regla: la DLQ debe tener alerta activa; cualquier valor > 0 es incidente.

### 4.5 Backpressure y consumer lag

Producer a 100k eventos/s, consumer a 10k/s → lag crece indefinidamente. Estrategias:

- Escalar consumers (más particiones + más instancias en el mismo group).
- Batching en el consumer (agrupar N eventos en una llamada batch a la API externa).
- Priority tiering (topics separados según SLA).
- Rate limiting en el producer si el downstream no aguanta y no se puede escalar (ej. cuota fija en API externa).

Observabilidad obligatoria: métrica `consumer_lag` como SLI crítico. Kafka Exporter + Prometheus + Grafana + HPA de Kubernetes escalando por lag (KEDA con `kafka` scaler).

### 4.6 Choreography vs orchestration revisitado

Regla operativa de Sam Newman: *orchestration para procesos con estado y decisiones, choreography para eventos de notificación*. Un event `EmailRequested` con 5 consumers reaccionando (log, analytics, retry-if-bounce, dashboard, backup) es choreography saludable. Un flow "reserve → pay → confirm → notify → escalate" con compensaciones es orchestration; escrito con choreography acaba siendo un monolito distribuido invisible.

### 4.7 DCB, la evolución del agregado clásico

Axon 5.x (RC en 2026) introduce **Dynamic Consistency Boundary**: en vez de agregados con boundary fijo (todos los eventos del stream `user-42`), el command handler consulta múltiples streams con optimistic locking basado en posiciones. Permite modelar invariantes cross-agregado sin unificar streams. Ejemplo: garantizar unicidad de email global sin encerrar todos los usuarios en un agregado gigante. Es un patrón emergente que soluciona el clásico dolor de "no puedo hacer esto porque cruzaría boundaries de agregado".

---

## 5. Ejemplo práctico completo: reviews FSRS event-sourced en LinguaDev Pro

Cada review de una tarjeta en LinguaDev Pro puede modelarse como evento. El estado FSRS (stability, difficulty, next review) es proyección.

**Paso 1: definir eventos.**

```ts
// packages/api/src/events/review.ts
import { z } from 'zod';

export const CardCreated = z.object({
  type: z.literal('CardCreated'), version: z.literal(1),
  data: z.object({ cardId: z.string(), userId: z.string(), front: z.string(), back: z.string(), createdAt: z.string() }),
});

export const CardReviewed = z.object({
  type: z.literal('CardReviewed'), version: z.literal(1),
  data: z.object({
    cardId: z.string(), userId: z.string(),
    grade: z.enum(['again','hard','good','easy']),
    elapsedDays: z.number(), reviewedAt: z.string(),
    prevStability: z.number(), prevDifficulty: z.number(),
    nextStability: z.number(), nextDifficulty: z.number(),
    nextReviewAt: z.string(),
  }),
});

export type ReviewEvent = z.infer<typeof CardCreated> | z.infer<typeof CardReviewed>;
```

**Paso 2: command handler con outbox en DynamoDB (LinguaDev usa AWS serverless).**

```ts
// packages/api/src/handlers/reviewCard.ts
import { DynamoDBClient, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { fsrsSchedule } from '../fsrs';

const ddb = new DynamoDBClient({ region: 'eu-west-1' });

export async function reviewCard(input: { cardId: string; userId: string; grade: Grade }) {
  const current = await loadCard(input.cardId);
  const next = fsrsSchedule(current, input.grade, new Date());

  const event = {
    eventId: crypto.randomUUID(),
    streamId: `card#${input.cardId}`,
    type: 'CardReviewed', version: 1,
    data: {
      cardId: input.cardId, userId: input.userId, grade: input.grade,
      elapsedDays: next.elapsedDays,
      prevStability: current.stability, prevDifficulty: current.difficulty,
      nextStability: next.stability, nextDifficulty: next.difficulty,
      reviewedAt: new Date().toISOString(),
      nextReviewAt: next.nextReviewAt.toISOString(),
    },
  };

  await ddb.send(new TransactWriteItemsCommand({
    TransactItems: [
      {
        Put: { TableName: 'CardEvents', Item: marshall({
          pk: event.streamId, sk: `${Date.now()}#${event.eventId}`,
          eventId: event.eventId, type: event.type, version: event.version, data: event.data,
        }) },
      },
      {
        Update: {
          TableName: 'CardState',
          Key: marshall({ pk: `card#${input.cardId}` }),
          UpdateExpression: 'SET stability = :s, difficulty = :d, nextReviewAt = :n, version = :v',
          ConditionExpression: 'attribute_not_exists(version) OR version = :expected',
          ExpressionAttributeValues: marshall({
            ':s': next.stability, ':d': next.difficulty,
            ':n': next.nextReviewAt.toISOString(),
            ':v': current.version + 1, ':expected': current.version,
          }),
        },
      },
      {
        Put: { TableName: 'Outbox', Item: marshall({
          pk: 'PENDING', sk: `${Date.now()}#${event.eventId}`,
          eventId: event.eventId, payload: event,
        }) },
      },
    ],
  }));
}
```

`TransactWriteItemsCommand` en DynamoDB da atomicidad ACID sobre las 3 tablas: event log, state y outbox.

**Paso 3: outbox worker (Lambda con DynamoDB Streams).**

```ts
// packages/api/src/handlers/outboxWorker.ts
import { KafkaProducer } from '../infra/kafka';

const producer = new KafkaProducer(process.env.KAFKA_BROKERS!.split(','));

export const handler = async (event: any) => {
  for (const rec of event.Records) {
    if (rec.eventName !== 'INSERT') continue;
    const image = rec.dynamodb.NewImage;
    const payload = JSON.parse(image.payload.S);
    await producer.send({
      topic: 'card-events',
      key: payload.streamId,
      value: JSON.stringify(payload),
      headers: { eventId: payload.eventId, type: payload.type },
    });
  }
};
```

**Paso 4: proyección `churn analysis` sobre 3 años de eventos.**

Un consumer nuevo, offset earliest, construye `churn_users` (users que dejaron de hacer reviews). Blue-green: rebuild completo → switch. No requiere migrar DynamoDB.

**Paso 5: verificar exactly-once effective.**

Test manual: crash del outbox worker en medio de un batch. DynamoDB Streams reentrega. El consumer downstream tiene dedup por `eventId`. Cero cargos duplicados, cero eventos perdidos.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ Los eventos son la **fuente de verdad**; el estado es proyección.
- ✅ Comandos = imperativo, con un handler; eventos = pretérito, con N consumers.
- ✅ Aggregate boundary = unidad de consistencia + invariantes.
- ✅ **Outbox pattern** para toda escritura que produzca evento externo.
- ✅ Consumers **idempotentes** siempre: dedup table, natural upsert o Idempotency-Key.
- ✅ Kafka EOS es dentro-de-Kafka; los side effects externos exigen idempotencia end-to-end.
- ✅ Snapshots cada N eventos si el agregado crece.
- ✅ Schema evolution con Avro/Protobuf + Schema Registry, backward-compatible por default.
- ✅ Upcasters, nunca reescribir eventos in-place.
- ✅ Partition key = entidad que preserva orden que necesitas.
- ✅ Compacted topics para "log as database".
- ✅ DLQ con alerta activa.
- ✅ Blue-green rebuild para proyecciones nuevas.
- ✅ Orchestration para flows con estado; choreography para notificaciones.
- ✅ Version token en respuestas para que la UI sepa cuándo el read side te alcanzó.

### Anti-patrones

- ❌ Publicar directo a Kafka desde el handler sin outbox (*dual write problem*).
- ❌ Confiar en "exactly-once delivery" para side effects externos.
- ❌ Usar offset de Kafka como identifier de negocio para dedup.
- ❌ Reescribir eventos viejos in-place cuando cambia el schema.
- ❌ Topic `SendEmail` (imperativo) con múltiples consumers.
- ❌ Agregado con 500k eventos sin snapshots.
- ❌ Choreography para flows de 5+ pasos con compensaciones.
- ❌ CDC exponiendo el schema físico interno como si fueran business events.
- ❌ Global ordering exigido y resuelto con `partitions=1` (mata paralelismo).
- ❌ Consumer que crashea eternamente por un poison message sin DLQ.

### Tabla de decisión: qué event store usar

| Situación | Elección típica |
|---|---|
| Sistema greenfield event-sourced puro | EventStoreDB / KurrentDB 24.10 |
| JVM stack, DDD estricto, sagas complejas | Axon Framework 4.10 (o 5.x cuando GA) |
| Ya tienes Kafka y quieres reutilizar | Kafka como log + Kafka Streams / KSQL |
| Postgres-first, quieres event store embebido | Marten (.NET) o custom con `outbox` + `event_log` |
| Serverless AWS puro | DynamoDB con transaction writes + DynamoDB Streams |
| Multi-tenant SaaS, muchos streams pequeños | EventStoreDB o Postgres con jsonb |

---

## 7. Casos reales industria 2020-2026

**LinkedIn Databus / Kafka:** LinkedIn creó Kafka como "commit log for the enterprise"; Jay Kreps ("The Log", 2013) es la base filosófica del ES moderno. En 2026 Kafka corre sin ZooKeeper (KRaft producción-ready desde 3.5).

**Uber trip lifecycle:** cada trip es máquina de estados event-sourced (`TripRequested → DriverAssigned → TripStarted → TripCompleted`). Cassandra guarda proyecciones per user/driver/city; la saga usa Temporal (ex-Cadence).

**Netflix Keystone:** 100M+ events/día. Migró de choreography a Conductor por caos operacional. Cualquier equipo materializa nuevas views on demand desde earliest.

**Stripe webhooks:** cada webhook incluye `event.id` y Stripe soporta `Idempotency-Key`. Caso canónico de "at-least-once + idempotencia end-to-end".

**Debezium en Shopify, Segment, Materialize:** el CDC log-based es la implementación de referencia del outbox en 2026. Debezium 2.7 mejora Postgres logical replication y añade MongoDB Change Streams v2.

**Kurrent/EventStoreDB 24.10 (2026):** rebrand desde EventStore Ltd. Añade HTTP sink, X.509 auth, OpenTelemetry, mejores métricas de sink connectors y throughput concurrente.

**Axon 5.x (RC 2026):** introduce Dynamic Consistency Boundary, replay status mejorado, Spring Boot 4.x, métricas integradas. Cambio grande: ya no todo diseño pasa por agregados con boundary fijo.

**Kafka Streams `exactly_once_v2`:** desde Kafka 3.0 es la garantía por defecto Kafka-a-Kafka; sigue sin cubrir side effects externos.

---

## 8. Ejercicios prácticos

### Ejercicio 1: modelar el dominio de reviews FSRS como stream de eventos

**Objetivo:** definir eventos, comando y proyección para el flujo de review de una tarjeta.

**Setup:**
- Repositorio `linguadev-pro` clonado.
- Node 20+, pnpm 9+, Docker.

**Pasos:**
1. Levanta EventStoreDB local con Docker (`eventstore/eventstore:24.10.13-jammy --insecure --run-projections=All`).
2. Define en TypeScript los eventos `CardCreated`, `CardReviewed`, `CardSuspended`, `CardResumed` con Zod.
3. Implementa `reviewCard(command)` que carga el stream `card-<id>`, valida invariantes (no revisar tarjeta suspendida), calcula next FSRS y appendea el evento con `expectedRevision` para optimistic locking.
4. Implementa una proyección Postgres `card_state (card_id PK, stability, difficulty, next_review_at, updated_at)` consumiendo `$all` con checkpoint persistido.
5. Añade test de integración que crea 100 tarjetas y ejecuta 5 reviews cada una; verifica que la proyección tiene 100 filas con el `next_review_at` correcto.

**Criterios de éxito:**
- [ ] Optimistic locking rechaza escrituras con `expectedRevision` incorrecto (test explícito).
- [ ] La proyección persiste checkpoint y sobrevive a reinicio sin duplicar.
- [ ] Rebuild desde `START` produce el mismo estado que el incremental.
- [ ] Métricas: `events_appended_total`, `projection_lag_seconds`.

**Bonus:** añade snapshot cada 500 reviews y mide diferencia de latencia de carga con y sin snapshot.

---

### Ejercicio 2: outbox pattern con Postgres + Debezium

**Objetivo:** publicar eventos a Kafka sin *dual write problem*.

**Setup:**
- Postgres 16 con `wal_level=logical`.
- Kafka Connect 3.9 con plugin Debezium 2.7.
- Topic `card-events`.

**Pasos:**
1. Crea tablas `cards`, `card_reviews` y `outbox` (esquema del §3.2).
2. Handler que en una sola transacción hace `INSERT/UPDATE` en cards y `INSERT` en outbox.
3. Configura Debezium Postgres connector con `table.include.list=public.outbox` y `transforms=outbox` usando `EventRouter` SMT (Single Message Transform) que extrae `aggregate_id` como key y `payload` como value.
4. Simula 1000 comandos concurrentes con `pgbench` custom.
5. Verifica en Kafka con `kcat -C -b localhost:9092 -t card-events -o beginning -c 1000` que llegaron todos, sin fantasmas ni perdidos.

**Criterios de éxito:**
- [ ] `SELECT COUNT(*) FROM cards` = número de eventos en el topic.
- [ ] Al matar `docker kill kafka` durante el load, tras levantar de nuevo se publica el backlog.
- [ ] Lag Debezium < 1 s en estado estable.
- [ ] Alarma configurada si lag > 30 s.

**Bonus:** añade cleanup periódico de la outbox (`DELETE FROM outbox WHERE created_at < now() - interval '7 days'`) sin afectar Debezium.

---

### Ejercicio 3: consumer idempotente con dedup table

**Objetivo:** garantizar exactly-once effective ante at-least-once delivery.

**Setup:**
- Consumer Node/TypeScript con `kafkajs`.
- Postgres con tabla `processed_events (event_id UUID PRIMARY KEY, processed_at TIMESTAMPTZ)`.

**Pasos:**
1. Implementa consumer que lee del topic `card-events`.
2. En cada mensaje, dentro de una transacción: `INSERT INTO processed_events(event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`. Si `rowCount == 0`, skip (ya procesado).
3. Si el insert tuvo éxito, ejecuta el side effect (por ejemplo, envío de email vía SES simulado con log).
4. Fuerza duplicación manual: `kcat -P -t card-events` reenviando el mismo evento tres veces.
5. Verifica que el side effect se ejecutó exactamente una vez.

**Criterios de éxito:**
- [ ] Enviando 3 duplicados del mismo `eventId`, side effect ejecuta 1 vez.
- [ ] Bajo carga (10k msgs), latencia p99 < 50 ms.
- [ ] Test con crash del consumer entre insert y commit → sin duplicación tras restart.
- [ ] Cleanup job elimina entries > 7 días.

**Bonus:** cambia el side effect a `stripe.paymentIntents.create({...}, { idempotencyKey: event.id })` (usa Stripe test mode) y observa cómo Stripe rechaza el duplicado del lado externo.

---

### Ejercicio 4: rebuild de proyección blue-green

**Objetivo:** cambiar el shape de una proyección sin downtime.

**Setup:**
- Sistema del Ejercicio 1 en marcha, sirviendo tráfico.
- Nueva proyección `card_state_v2` con columnas adicionales (`retention_prob`, `review_count`).

**Pasos:**
1. Crea `card_state_v2` con el nuevo schema.
2. Despliega un consumer nuevo (`account-projection-v2`) con `groupId=card-projection-v2` y `auto.offset.reset=earliest`.
3. Observa que consume desde el inicio del log y va materializando `card_state_v2`.
4. Cuando el lag < 1 s, cambia el selector del Service Kubernetes o el alias del BFF para leer de `card_state_v2`.
5. Deja el `v1` corriendo 24 h por seguridad, después elimina.

**Criterios de éxito:**
- [ ] Tráfico servido continuamente durante el rebuild (0 5xx atribuibles a la migración).
- [ ] `SELECT COUNT(*) FROM card_state_v2` = `SELECT COUNT(*) FROM card_state` tras alcanzar tail.
- [ ] Rollback trivial: cambiar selector a `v1` en <10 s si algo falla.
- [ ] Dashboard con lag de ambas proyecciones durante la ventana.

**Bonus:** documenta el runbook completo con comandos y criterios de rollback.

---

### Ejercicio 5 (bonus): saga con Temporal

**Objetivo:** implementar la reserva multi-servicio de LinguaDev Pro (suscripción + provisioning + welcome email) como saga orquestada.

**Setup:**
- Temporal server local (`temporalio/auto-setup:1.24`).
- SDK TypeScript 1.11.

**Pasos:**
1. Define activities: `createSubscription`, `provisionAccount`, `sendWelcomeEmail`, y sus compensaciones `refundSubscription`, `deprovisionAccount`.
2. Implementa el workflow con try/catch anidado (patrón del §4.1).
3. Fuerza fallo en `sendWelcomeEmail` (por ejemplo, SES throttle) y verifica que las compensaciones ejecutan en orden inverso.
4. Configura retries automáticos (`retry: { maximumAttempts: 5, backoffCoefficient: 2 }`).
5. Observa el workflow en la UI de Temporal (`localhost:8233`).

**Criterios de éxito:**
- [ ] Happy path: subscription creada, cuenta provisionada, email enviado.
- [ ] Failure path: fallo en step N → compensaciones N-1, N-2, … 1 ejecutadas en orden.
- [ ] Estado del workflow visible en la UI (activities, retries, compensations).
- [ ] Test que corta el worker en medio y verifica que resume tras restart.

**Bonus:** añade una versión de choreography con Kafka events y compara: líneas de código, debugging, tiempo para explicar el flow a un nuevo miembro del equipo.

---

## 9. Recursos + siguientes pasos

**Libros y papers:**
- Vaughn Vernon — *Implementing Domain-Driven Design*, cap. 8 y 12.
- Martin Kleppmann — *Designing Data-Intensive Applications*, caps. 4, 7 y 11.
- Chris Richardson — *Microservices Patterns*, caps. 4, 6, 7.
- Greg Young — *CQRS Documents* (2010) y charlas de Greg Young en QCon.
- Jay Kreps — *The Log: What every software engineer should know* (LinkedIn Engineering, 2013).

**Frameworks y motores:**
- [KurrentDB / EventStoreDB 24.10](https://www.kurrent.io/) — event store especializado.
- [Axon Framework](https://www.axoniq.io/) — JVM, 4.10 estable y 5.x en RC.
- [Marten](https://martendb.io/) — .NET sobre Postgres.
- [Apache Kafka 3.9](https://kafka.apache.org/) con KRaft.
- [Debezium 2.7](https://debezium.io/) — CDC log-based referencia.
- [Temporal 1.24](https://temporal.io/) — orchestration de workflows.
- [Confluent Schema Registry](https://docs.confluent.io/platform/current/schema-registry/) — Avro/Protobuf enforcement.

**Blogs y charlas:**
- Ongaro et al. — papers de Kafka Streams EOS v2.
- Kleppmann — *Turning the database inside out* (Strange Loop 2015).
- Neha Narkhede — *Exactly-Once Semantics Are Possible*.
- Gunnar Morling — Debezium blog sobre outbox pattern.
- Confluent Docs — *Schema Evolution and Compatibility*.
- AWS SQS Docs — Dead-letter queues.

**Siguientes pasos:**
- Aplica los ejercicios sobre LinguaDev Pro.
- Lee [Cap 08 — consenso y coordinación](./08-consenso-y-coordinacion.md) para entender por qué el leader election y las cotas de FLP condicionan Kafka, EventStoreDB y todo sistema que dependa de quorum.
- Explora [Cap 09 — patrones cloud-native](./09-patrones-cloud-native.md) para orquestar consumers, outbox workers y sagas en Kubernetes con GitOps.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades mid → staff. Cubren: qué es Event Sourcing frente a CDC, trampas de CQRS y read models eventuales, el mito de exactly-once y Kafka EOS, outbox pattern, schema evolution y upcasters, consumers idempotentes, partitioning y ordering en Kafka, snapshots en agregados grandes, rebuild de proyecciones sin downtime, DLQ y poison messages, event vs command, offset management, choreography vs orchestration, fat vs thin events, compacted topics y KTable, backpressure y consumer lag, ordering cross-aggregate, CDC con Debezium, granularidad de eventos y cuándo async event-driven no es la elección correcta.

- **Fuente:** [`packages/content/src/tech/architecture/sim-07-event-sourcing-and-cqrs.json`](../../packages/content/src/tech/architecture/sim-07-event-sourcing-and-cqrs.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-07-event-sourcing-and-cqrs`
- **Tiempo:** 28 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 06 — CAP y consistencia](./06-cap-y-consistencia.md) · [Índice](./README.md) · [Capítulo 08 — consenso y coordinación →](./08-consenso-y-coordinacion.md)
