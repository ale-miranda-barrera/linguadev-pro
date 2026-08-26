# Capítulo 02 — Mensajería, eventos y microservicios

> **Focus:** SQS/SNS/EventBridge/Kafka/Kinesis, delivery semantics, orquestación vs coreografía, sagas, DDD bounded contexts, cuándo dividir y cuándo NO, patrones de resiliencia y anti-patrones del "distributed monolith".
> **Áreas:** messaging · microservices · resilience · ddd
> **Preguntas:** 20 · **Tiempo:** 60 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- [Cap 01 — Elección de base de datos](./01-eleccion-de-db.md): ACID, CAP/PACELC, CDC.
- Nociones de HTTP, REST, códigos de estado, retries y timeouts.
- Familiaridad con al menos una nube (AWS, GCP, Azure) — usaremos AWS como referencia principal.
- Recomendado: haber leído *Building Microservices* (Newman) o *Enterprise Integration Patterns* (Hohpe & Woolf).

**Glosario mínimo:**
- **Queue:** cola point-to-point, 1 productor a N consumidores compitiendo, cada mensaje se entrega a **un** consumidor (SQS, RabbitMQ classic, Kafka con consumer group).
- **Topic:** pub/sub, 1 productor a N suscriptores, **cada suscriptor** recibe una copia (SNS, Kafka topics con múltiples consumer groups).
- **At-most-once:** máximo una entrega. Puede perder mensajes.
- **At-least-once:** mínimo una entrega. Puede duplicar → requiere idempotencia.
- **Exactly-once:** una y solo una. Prácticamente imposible sin coordinación específica (Kafka EOS dentro de Kafka; fuera requiere idempotencia).
- **DLQ (Dead Letter Queue):** cola destino para mensajes que fallan tras N reintentos.
- **Bounded context** (DDD): frontera lingüística/semántica donde un modelo tiene sentido.
- **Saga:** transacción distribuida como secuencia de pasos locales con compensaciones si algo falla.
- **Choreography vs Orchestration:** eventos que fluyen sin coordinador central (coreografía) vs orquestador explícito (orchestrator).
- **Idempotency key:** identificador único que permite tratar reintentos como no-ops.
- **Backpressure:** mecanismo para que un consumidor lento indique al productor "ve más lento".
- **Sidecar:** proceso auxiliar que corre junto al servicio (Envoy en un pod K8s, por ejemplo).

**Setup mínimo (agosto 2026):**

```bash
# AWS CLI v2 configurado
aws configure

# LocalStack para simular AWS local (SQS, SNS, EventBridge)
docker run --rm -it -p 4566:4566 -p 4571:4571 \
  -e SERVICES=sqs,sns,eventbridge,lambda,dynamodb \
  localstack/localstack:3.8

# Kafka 3.9 (con KRaft — sin Zookeeper desde 3.5)
docker run -d --name kafka -p 9092:9092 \
  -e KAFKA_ENABLE_KRAFT=yes \
  -e KAFKA_CFG_NODE_ID=1 \
  -e KAFKA_CFG_PROCESS_ROLES=broker,controller \
  bitnami/kafka:3.9

# RabbitMQ 4.x con management UI
docker run -d --hostname rmq --name rabbit \
  -p 5672:5672 -p 15672:15672 \
  rabbitmq:4-management

# Herramientas CLI
awslocal --version                # awslocal apunta a LocalStack
kcat -b localhost:9092 -L         # antes kafkacat, sigue en 2026
rabbitmqadmin --help              # dentro del contenedor
```

En 2026, Kafka 3.9 (dic 2024) es KRaft-only (sin Zookeeper), tiered storage estable, y **KIP-848** (nuevo consumer group protocol) mejora rebalance latencies dramáticamente. **EventBridge Pipes** (GA 2022, muy adoptado 2024-2026) elimina glue Lambdas entre SQS/DDB Streams/Kinesis y destinos. RabbitMQ 4 (2024) introdujo **Streams** como alternativa a Kafka con retención larga.

---

## 1. El gran cuadro

La mensajería asíncrona es lo que separa un sistema que se cae cuando un componente lento tiene un mal día, de uno que absorbe la variación y sigue funcionando. En un mundo de request-response síncrono, si tu servicio de pagos tarda 3 segundos, tu API tarda 3 segundos. Si tu proveedor de mail cae 10 minutos, tu checkout está roto durante 10 minutos. La mensajería mueve el problema: el pago se encola, el mail se encola, y los componentes lentos consumen a su ritmo. A cambio pagas complejidad — consistencia eventual, mensajes duplicados, ordenación no trivial, observabilidad más difícil — pero ganas desacoplamiento operacional que ningún patrón síncrono te da.

Los microservicios, por su parte, son una decisión organizacional más que técnica. Un monolito bien modularizado (con **bounded contexts** claros en el sentido de DDD) puede escalar hasta cientos de ingenieros. Basecamp corre un monolito Rails con miles de miles de líneas y un equipo pequeño. Shopify corre un "modular monolith" que escaló a billones de dólares en GMV. Muchos equipos que "adoptaron microservicios" en 2015-2018 pasaron los años siguientes migrando de vuelta a monolitos modulares porque descubrieron que habían roto el monolito por líneas incorrectas y terminaron con un **distributed monolith**: todos los costes de red y complejidad, sin ninguna de las ventajas de despliegue independiente.

La regla mental correcta es que microservicios deben resolver problemas **de la organización o de la carga**, no problemas técnicos abstractos. ¿Tenéis equipos que se pisan constantemente en el mismo repo? ¿Un componente tiene escalado radicalmente distinto del resto (búsqueda con GPU vs API CRUD)? ¿Necesitas rollout independiente por razones de compliance? Esas son razones. "Es mejor arquitectura" no lo es. Y cuando decides microservicios, el 80% del trabajo real es la mensajería entre ellos, no la lógica interna: contratos, versionado, retries, DLQs, sagas, observability, autenticación service-to-service.

Este capítulo cubre los cimientos de mensajería (queue vs topic, delivery semantics, DLQ), las tecnologías principales (SQS, SNS, EventBridge, Kafka, Kinesis, RabbitMQ), los patrones distribuidos (saga con coreografía vs orquestación, transactional outbox, idempotencia), y los patrones de dominio (bounded contexts, service discovery, contract testing, framework de decisión "cuándo dividir"). Al final tendrás las herramientas para diseñar sistemas asíncronos sin repetir los errores clásicos de la industria 2015-2022.

---

## 2. Fundamentos (nivel básico)

### 2.1 Queue vs Topic

Ambos mueven mensajes entre procesos, pero el modelo semántico difiere:

**Queue (point-to-point):** un mensaje va a **exactamente uno** de los N consumidores. Los consumidores compiten. Uso: reparto de trabajo.

```
Producer → [ Queue ] → Consumer A
                  ↘  Consumer B     ← cada mensaje va a A o B, no a los dos
                  ↘  Consumer C
```

**Topic (pub/sub):** un mensaje va a **todos** los suscriptores. Uso: notificación fan-out.

```
Producer → [ Topic ] → Subscriber A
                   ↘  Subscriber B     ← cada mensaje va a A y B y C
                   ↘  Subscriber C
```

Tecnologías por familia:

| Familia | Ejemplos |
|---|---|
| Queue puro | SQS, RabbitMQ (queues clásicas), Celery+Redis |
| Topic puro | SNS |
| Topic + consumer groups (=queue por group) | Kafka, Kinesis, Pulsar, RabbitMQ Streams |
| Router de eventos | EventBridge (topic con reglas de filtrado y muchos destinos) |

Kafka merece nota especial: un topic Kafka con **N consumer groups** actúa como pub/sub (cada group recibe todos los mensajes) y **dentro de un consumer group** cada mensaje va a un solo consumidor (competencia). Es la topología más flexible.

### 2.2 At-most-once vs at-least-once vs exactly-once

La verdad incómoda: **exactly-once end-to-end no existe** en sistemas distribuidos generales (imposible por FLP + partitions). Lo que sí existe es "efecto exactly-once" combinando at-least-once con idempotencia.

| Semantic | Cuándo la eliges | Coste |
|---|---|---|
| At-most-once | Métricas, logs, hearbeats — perder es aceptable | Barato, sin ack |
| At-least-once | **Default para todo lo demás.** Pedidos, pagos, notificaciones | Requires idempotencia en consumer |
| Exactly-once (limited) | Dentro de Kafka con EOS, DynamoDB TransactWriteItems | Costo alto de coordinación |

SQS y RabbitMQ son at-least-once por default: el broker entrega, espera ack. Si el consumer muere antes de ack, redelivery. Puedes procesar el mismo mensaje 2 veces si la red o el consumer fallan entre "trabajé el mensaje" y "hice ack".

Kafka introduce **Exactly-Once Semantics (EOS)** desde 0.11 (2017) via idempotent producer + transactional consumer, pero solo dentro de Kafka (produce+consume+produce). Cruzando a otra DB o servicio, sigues necesitando idempotencia.

### 2.3 Idempotencia — el patrón universal en eventos

Idempotencia significa que ejecutar N veces produce el mismo efecto que ejecutar una vez. Con at-least-once, es la única defensa correcta contra duplicados. Formas de implementarla:

**1. Dedup con message-id + tabla de ya-procesados:**

```python
import boto3, hashlib

table = boto3.resource('dynamodb').Table('processed_events')

def handler(event, context):
    for record in event['Records']:
        msg_id = record['messageId']
        # Intenta insertar con condición: solo si no existe
        try:
            table.put_item(
                Item={'msg_id': msg_id, 'ts': int(time.time()), 'ttl': int(time.time()) + 86400},
                ConditionExpression='attribute_not_exists(msg_id)'
            )
        except table.meta.client.exceptions.ConditionalCheckFailedException:
            # Ya procesado, skip
            continue

        procesar(json.loads(record['body']))
```

**2. Operaciones idempotentes por diseño (UPSERT, SET, REPLACE):**

```sql
INSERT INTO user_settings (user_id, theme)
VALUES ($1, $2)
ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme;
```

**3. Optimistic locking con versión:**

```sql
UPDATE orders
SET status = 'SHIPPED', version = version + 1
WHERE id = $1 AND version = $2;
-- Filas afectadas = 0 → otro proceso ya avanzó, ignorar
```

**4. HTTP `Idempotency-Key` header (Stripe, Square, PayPal):**

```http
POST /v1/charges
Idempotency-Key: 5f1c9c96-3e6b-4b6a-9e5f-1abcdefabcde

{"amount": 2000, "currency": "usd"}
```

Stripe guarda la respuesta bajo esa key durante 24h. Retries con la misma key devuelven la misma respuesta sin cobrar dos veces.

### 2.4 Dead Letter Queue (DLQ)

Cuando un consumer falla N veces procesando el mismo mensaje, hay dos opciones malas: (a) descartarlo silenciosamente — pierdes datos, (b) reintentar infinito — bloqueas la queue con **poison message**. La opción sana es **DLQ**: tras N reintentos, mover el mensaje a una cola separada para inspección manual o retry batchado.

```yaml
# CloudFormation — SQS con DLQ
Resources:
  MainQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: linguadev-events
      VisibilityTimeout: 60
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt DLQ.Arn
        maxReceiveCount: 5     # tras 5 fallos → DLQ

  DLQ:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: linguadev-events-dlq
      MessageRetentionPeriod: 1209600   # 14 días máximo
```

Reglas de oro con DLQ:
- **Alertas** en `DLQ ApproximateNumberOfMessagesVisible > 0`. Mensajes en DLQ = bug o incidente activo.
- **Runbook** para debugear: qué es el mensaje, por qué falló, cómo reprocesar.
- **Redrive** con `StartMessageMoveTask` API (AWS 2023) que mueve mensajes de DLQ de vuelta a la main.
- **No solo swallow** — si mensajes acaban en DLQ sin monitorización, es equivalente a perderlos.

### 2.5 Retry con exponential backoff + jitter

Retry naïve (fixed delay) causa **thundering herd**: cuando un downstream se recupera, todos los clientes reintentan simultáneamente y lo tumban de nuevo. AWS publicó *"Exponential Backoff and Jitter"* (Marc Brooker, 2015) con la solución canónica.

```python
import random, time

def retry_with_backoff(fn, max_attempts=5, base_delay=0.1, cap=30.0):
    last_exc = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except TransientError as e:
            last_exc = e
            # "Full jitter" — random en [0, cap_delay]
            delay = min(cap, base_delay * (2 ** attempt))
            sleep_time = random.uniform(0, delay)
            time.sleep(sleep_time)
    raise last_exc
```

Tres variantes documentadas por AWS:
- **Exponential backoff** (sin jitter): retries siguen sincronizados. Malo.
- **Full jitter**: `random(0, delay)`. Mejor throughput agregado.
- **Equal jitter**: `delay/2 + random(0, delay/2)`. Compromiso.

**Full jitter** es el default sensato en 2026.

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 SQS vs SNS vs EventBridge vs Kafka vs Kinesis

Cinco tecnologías con papeles distintos. La confusión es común porque todas "mueven mensajes".

| Tech | Modelo | Retención | Throughput | Ordering | Coste típico |
|---|---|---|---|---|---|
| **SQS Standard** | Queue | 14 días max | ~ilimitado | Best-effort | Muy bajo |
| **SQS FIFO** | Queue ordenada | 14 días | 3000 msg/s por MessageGroupId (2024) | Estricto por group | Bajo |
| **SNS** | Topic pub/sub | No retiene | Muy alto | No | Muy bajo |
| **EventBridge** | Router con reglas | No retiene (Archive opcional) | 400+ eventos/s por default, sube | No | Medio |
| **Kafka (MSK, Confluent)** | Log distribuido | Ilimitada (tiered storage) | Millones/s | Estricto por partition | Alto ops + hardware |
| **Kinesis Data Streams** | Log AWS-native | 7-365 días | 1MB/s por shard | Por shard | Medio |

**Regla mental:**

- **SQS**: encolar trabajo entre servicios propios. Simple, barato, sin infra.
- **SNS**: fan-out simple (1 evento → N consumers). Frecuente combinar SNS→SQS para dar retención al consumer.
- **EventBridge**: bus corporativo con **reglas de filtrado ricas**, integraciones nativas con 200+ servicios AWS y SaaS (Datadog, Stripe, Zendesk). Ideal para arquitecturas event-driven cross-servicio.
- **Kafka**: log de eventos con **retención larga y replay**. Streaming, CDC, analytics. Coste operacional alto — considera **MSK Serverless** o **Confluent Cloud**.
- **Kinesis**: alternativa AWS-native a Kafka. Menos features, menos ops. Buena si te importa integración fácil con Lambda/Firehose.

**Ejemplo SNS→SQS fan-out en CloudFormation:**

```yaml
Resources:
  UserRegisteredTopic:
    Type: AWS::SNS::Topic
    Properties: { TopicName: user-registered }

  EmailQueue:
    Type: AWS::SQS::Queue
    Properties: { QueueName: email-worker }

  AnalyticsQueue:
    Type: AWS::SQS::Queue
    Properties: { QueueName: analytics-worker }

  EmailSubscription:
    Type: AWS::SNS::Subscription
    Properties:
      TopicArn: !Ref UserRegisteredTopic
      Protocol: sqs
      Endpoint: !GetAtt EmailQueue.Arn
      RawMessageDelivery: true

  AnalyticsSubscription:
    Type: AWS::SNS::Subscription
    Properties:
      TopicArn: !Ref UserRegisteredTopic
      Protocol: sqs
      Endpoint: !GetAtt AnalyticsQueue.Arn
      RawMessageDelivery: true

  # IAM policies para que SNS pueda enviar a las SQS (elidido)
```

### 3.2 Kafka partitions — el corazón del throughput

Kafka **paraleliza por partición**. Un topic con 1 partición procesa secuencialmente por 1 consumer. Con 12 particiones, hasta 12 consumers dentro de un consumer group procesan en paralelo, con ordering **garantizado por key** (mismo key → siempre misma partition → siempre mismo consumer, en orden).

```
Topic: orders (12 particiones)
Consumer group: order-processor (4 workers)

Partition 0, 4, 8  → Worker 1
Partition 1, 5, 9  → Worker 2
Partition 2, 6, 10 → Worker 3
Partition 3, 7, 11 → Worker 4
```

Elegir bien la **partition key** es crítico:

```python
from confluent_kafka import Producer

p = Producer({'bootstrap.servers': 'localhost:9092'})

# Key = order_id → todos los eventos de una orden en la misma partición → orden preservado
p.produce('orders', key=order_id, value=json.dumps(event))
p.flush()
```

Anti-patrón: key = `country` en un sistema con un país que domina el tráfico → **hot partition**, un consumer sobrecargado y otros ociosos. Igual que en DynamoDB.

Reglas de dimensionamiento (Kafka 3.9):
- Empezar con **partitions = 2-3× max consumers concurrentes**.
- **Aumentar partitions es fácil**, disminuir requiere recrear el topic.
- Retención por tiempo o por tamaño; **tiered storage** (KIP-405, GA 3.6) permite offload a S3 y retención "infinita" a coste bajo.
- **KIP-848** (Kafka 3.7-3.9, estable en 2026) elimina rebalance stop-the-world del consumer group — rebalances incrementales.

### 3.3 EventBridge Pipes — la joya subestimada

EventBridge Pipes (GA 2022) elimina el "glue Lambda" que muchos escribíamos para conectar SQS → destino, DynamoDB Streams → destino, Kinesis → destino. Es un ETL managed source→enrichment→target sin código.

```yaml
# SAM template — pipe de DynamoDB Streams a EventBridge con filtro
Resources:
  UserEventsPipe:
    Type: AWS::Pipes::Pipe
    Properties:
      RoleArn: !GetAtt PipeRole.Arn
      Source: !GetAtt UsersTable.StreamArn
      SourceParameters:
        DynamoDBStreamParameters:
          StartingPosition: LATEST
          BatchSize: 10
        FilterCriteria:
          Filters:
            - Pattern: '{"eventName": ["INSERT", "MODIFY"]}'
      Target: !GetAtt EventBus.Arn
      TargetParameters:
        EventBridgeEventBusParameters:
          Source: "linguadev.users"
          DetailType: "UserChanged"
```

Casos de uso reales 2024-2026:
- DynamoDB Streams → EventBridge (con filter que solo envía `MODIFY` de campos específicos).
- SQS FIFO → Step Functions con enrichment previo.
- MSK / self-managed Kafka → Lambda con filtering pattern nativo.

### 3.4 Ordering: cuándo importa y cuándo pagas por ello

Ordering es caro. Antes de exigir orden estricto, pregúntate: **¿realmente lo necesito?**

- **No lo necesitas** en la mayoría de eventos independientes (`UserLoggedIn`, `PageViewed`, notificaciones push).
- **Lo necesitas** cuando dos eventos son causales y aplicarlos fuera de orden produce estado inválido: `OrderCreated` antes de `OrderShipped`, o `AccountDebited` antes de `AccountCredited`.

Soluciones si necesitas order:

- **SQS FIFO** con `MessageGroupId` — orden estricto dentro del group. Throughput 3000 msg/s por group (2024 aumento), suficiente para la mayoría.
- **Kafka** con partition key = ID de la entidad — todos sus eventos en misma partition, orden garantizado.
- **En destino**: aceptar out-of-order y ordenar por `event_id` monotónico (LSN, timestamp lógico) antes de aplicar.

Anti-patrón: exigir ordering global cross-servicio. Casi nunca necesario, y limita throughput dramáticamente.

### 3.5 Bounded contexts — dividir por dominio, no por capa

**Eric Evans** (*Domain-Driven Design*, 2003) formalizó **bounded context**: una frontera dentro de la cual un modelo tiene un significado consistente. `Order` en el contexto de "carrito" ≠ `Order` en el contexto de "logística" ≠ `Order` en el contexto de "facturación". Cada contexto puede tener su modelo (schema, agregados, invariantes) sin obligación de compartirlo.

Anti-patrón enorme de microservicios 2015-2020: dividir por **capa técnica** (`user-api`, `user-db`, `user-frontend`, `user-cache`) en lugar de por **capacidad de negocio** (`identity`, `billing`, `catalog`). Resultado: cada feature requiere cambios en 5 servicios coordinados → distributed monolith.

Regla mental de Newman: **cada microservicio debe ser desplegable independientemente**. Si cambiar una feature requiere deploy coordinado de N servicios, están mal divididos. La división correcta sigue las líneas del **ubiquitous language** del dominio.

Ejemplo para LinguaDev Pro:

Bounded contexts sanos:
- **Identity**: signup, login, tokens, sesiones.
- **Learning**: cards, FSRS, reviews, packs.
- **Content**: creación y curación de ejercicios y packs.
- **Progress & Analytics**: streaks, dashboards, cohortes.
- **Billing** (futuro): planes, suscripciones, invoices.

Cada uno puede ser un servicio (o un módulo dentro de un modular monolith). Un cambio en el algoritmo FSRS no toca Identity ni Billing.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Saga: choreography vs orchestration

Una **saga** implementa una transacción distribuida como secuencia de pasos locales, cada uno con su **compensación** si un paso posterior falla. Nunca 2PC (dos fases). Dos estilos:

**Choreography (coreografía):** cada servicio reacciona a eventos publicados por otros. No hay coordinador central.

```
BookingCreated → payment.charge → PaymentSucceeded → inventory.reserve → StockReserved → shipping.plan
                                        │
                                        └── PaymentFailed → booking.cancel
```

Pros: bajo acoplamiento, sin single point of failure lógico, natural para event-driven.
Cons: **el flujo se dispersa entre servicios** — nadie tiene la vista completa. Debugging complejo. Riesgo de ciclos.

**Orchestration (orquestación):** un servicio (orchestrator) llama secuencialmente a otros y decide compensaciones.

```
Orchestrator:
  step 1: payment.charge()      → on fail: STOP
  step 2: inventory.reserve()   → on fail: payment.refund()
  step 3: shipping.plan()       → on fail: inventory.release(), payment.refund()
```

Pros: **flujo explícito en un solo lugar**, testeable end-to-end, más fácil de observar.
Cons: acoplamiento con el orchestrator, riesgo de "god service".

**Herramientas en 2026:**
- **AWS Step Functions** — orchestrator serverless con `Standard` (long-running, hasta 1 año) y `Express` (< 5 min, alto throughput).
- **Temporal** — durable execution abierto, muy adoptado 2023-2026 (Coinbase, Snap, HashiCorp).
- **Camunda** — BPMN engine tradicional.
- **Zeebe** — cloud-native workflow engine.

Regla: **para procesos con >3 pasos y compensaciones complejas, prefiere orchestration** (más mantenible). Para flujos simples de 2-3 eventos, choreography basta.

Ejemplo mínimo en Step Functions:

```json
{
  "Comment": "Saga de checkout",
  "StartAt": "ChargePayment",
  "States": {
    "ChargePayment": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:eu-west-1:123:function:charge",
      "Retry": [{ "ErrorEquals": ["States.TaskFailed"], "MaxAttempts": 3, "IntervalSeconds": 2, "BackoffRate": 2 }],
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "FailSaga" }],
      "Next": "ReserveInventory"
    },
    "ReserveInventory": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:eu-west-1:123:function:reserve",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "RefundPayment" }],
      "Next": "PlanShipping"
    },
    "PlanShipping": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:eu-west-1:123:function:plan",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "ReleaseInventory" }],
      "End": true
    },
    "RefundPayment":     { "Type": "Task", "Resource": "arn:aws:lambda:eu-west-1:123:function:refund", "Next": "FailSaga" },
    "ReleaseInventory":  { "Type": "Task", "Resource": "arn:aws:lambda:eu-west-1:123:function:release", "Next": "RefundPayment" },
    "FailSaga":          { "Type": "Fail", "Error": "SagaFailed", "Cause": "See execution log" }
  }
}
```

### 4.2 Transactional Outbox — el patrón anti-dual-write

Problema clásico:

```python
# BUG: puede quedar inconsistente
db.execute("INSERT INTO orders VALUES (...)")   # ok
kafka.publish("order.created", event)           # falla → DB tiene la orden, nadie sabe
```

Si el paso 2 falla, tienes una orden sin evento. Si el paso 1 falla después del ack de Kafka (no en este ejemplo pero en variantes), publicas eventos sin datos. 2PC (XA transactions) resuelve pero es prohibitivo.

**Solución canónica: Transactional Outbox.**

1. En la misma transacción que escribe la orden, escribe también una fila en tabla `outbox`.
2. Un **relay** (worker separado o CDC) lee `outbox` y publica al broker.
3. Marca fila `outbox` como publicada (o borra) tras confirmar publicación.

```sql
CREATE TABLE outbox (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate    TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);
CREATE INDEX ix_outbox_pending ON outbox (created_at) WHERE published_at IS NULL;

-- La app hace todo en una transacción
BEGIN;
INSERT INTO orders (id, user_id, total) VALUES ($1, $2, $3);
INSERT INTO outbox (aggregate, event_type, payload)
VALUES ('order', 'OrderCreated', jsonb_build_object('id', $1, 'user_id', $2, 'total', $3));
COMMIT;
```

**Relay opción A: worker que hace polling.**

```python
def relay_loop():
    while True:
        with conn.transaction():
            rows = conn.execute("""
                SELECT id, event_type, payload FROM outbox
                WHERE published_at IS NULL
                ORDER BY created_at
                LIMIT 100
                FOR UPDATE SKIP LOCKED
            """).fetchall()
            for row in rows:
                try:
                    kafka.publish(row.event_type, row.payload)
                    conn.execute("UPDATE outbox SET published_at = now() WHERE id = $1", row.id)
                except Exception as e:
                    log.error("publish failed", exc_info=e)
                    break
        time.sleep(1)
```

**Relay opción B: CDC con Debezium + Postgres logical replication.** Debezium lee del WAL y publica cada INSERT en `outbox` directamente a Kafka. Sin polling, mínima latencia, es la opción escalable.

Empresas que documentan Outbox en producción: Trivago, Zalando, N26, Netflix, Uber. Es el patrón que **debes conocer** en cualquier arquitectura microservicios con estado.

### 4.3 Distributed monolith — el peor de dos mundos

Anti-patrón donde tienes microservicios que son un monolito por debajo:

- **Deploys acoplados**: cada release requiere coordinar N servicios.
- **Shared database**: dos servicios leen/escriben la misma tabla → cualquier cambio de schema los afecta a ambos.
- **Chatty services**: una request de usuario dispara 30 llamadas internas HTTP → latencia acumulativa horrible.
- **Compartir librería con lógica de dominio**: bumpear la lib requiere re-deploy de todos los consumidores.
- **Frontends que orquestan**: el mobile app llama 8 APIs y hace joins en cliente porque no hay BFF.

Síntomas medibles:
- Change lead time no mejoró tras "microservicios".
- Un incidente en un servicio tumba varios.
- No podéis hacer feature flag por servicio.
- Cada equipo espera a los demás para releases.

Cura: **volver a un modular monolith** (Shopify, DHH escribieron sobre esto). Delimita módulos con bounded contexts internos, DB por módulo si tienes disciplina, deploy único. Cuando midas dolor real de escalado/organizacional, extrae **un** servicio con criterio, no diez.

### 4.4 Backpressure en pipelines async

Consumer lento + producer rápido = OOM latente en algún buffer. Estrategias:

- **Bounded queue que bloquea** al producer (`BlockingQueue.put()` en Java, canales bounded en Go).
- **Drop policy**: descartar mensajes viejos o nuevos según el caso.
- **Sampling**: procesar 1 de cada N (métricas de alta cardinalidad).
- **Request-N** (Reactive Streams / Flow API): consumer pide N explícitamente al publisher.
- **Kafka consumer poll model**: consumer decide cuándo consumir. Sin push descontrolado.

En 2026, si diseñas un servicio nuevo pregúntate siempre: **"¿qué pasa si mi downstream es 10× más lento durante 1 hora?"** — sin respuesta clara, tienes bug latente.

### 4.5 Contract testing — el problema silencioso

Un servicio consumidor asume que el productor devolverá cierto shape. Cuando el productor cambia el shape sin avisar → consumidor rompe en producción. Tests unitarios de cada uno pasan; el fallo aparece en integración real.

Solución: **contract testing** con **Pact** o **Spring Cloud Contract**. El consumer declara qué espera; el test corre contra el productor y falla si no cumple.

```javascript
// Pact — consumer test
const { Pact } = require('@pact-foundation/pact');
const provider = new Pact({ consumer: 'web-app', provider: 'user-service' });

provider.addInteraction({
  state: 'user 123 exists',
  uponReceiving: 'a request for user 123',
  withRequest: { method: 'GET', path: '/users/123' },
  willRespondWith: {
    status: 200,
    body: { id: Pact.Matchers.like(123), email: Pact.Matchers.term({...}) }
  }
});
```

El contract se sube al Pact Broker; el CI del productor lo verifica en cada build → los productores no pueden mergear cambios que rompen consumidores sin darse cuenta.

Regla mental: **APIs internas también son APIs**. Versionado, contratos, deprecation.

### 4.6 Schema evolution (Avro, Protobuf, JSON Schema)

Kafka y streams de larga vida obligan a pensar en **compatibilidad hacia atrás**. Un consumer viejo debe poder leer un mensaje nuevo (backward compat) y viceversa (forward compat).

Reglas de compatibility en **Confluent Schema Registry** (Avro):
- **Backward** (default): nuevo schema puede leer mensajes producidos con el viejo. Regla: no eliminar campos required, no cambiar tipos, añadir campos opcionales OK.
- **Forward**: viejo schema puede leer mensajes producidos con el nuevo.
- **Full**: ambos.

Anti-patrones:
- Renombrar un campo (rompe todo).
- Cambiar tipo de `int` a `string`.
- Eliminar un campo required.

En Protobuf: cada campo tiene tag numérico, y **nunca se reutiliza** un tag ni se cambia tipo — usa `reserved` para prevenir.

```protobuf
syntax = "proto3";
message User {
  int64 id = 1;
  string email = 2;
  reserved 3;                    // eliminado, no reutilizar
  string display_name = 4;       // nuevo campo, opcional por default en proto3
  optional string phone = 5;
}
```

### 4.7 Service discovery — cómo se encuentran

En 2026 las opciones dominan:

- **DNS** (más simple): `user-service.internal.linguadev.local` resuelve a la IP del pod actual. Route53 + service-mesh o directo.
- **Kubernetes native**: cada Service tiene DNS `svc-name.namespace.svc.cluster.local`.
- **Service mesh** (Istio, Linkerd, AWS App Mesh): sidecar Envoy hace routing, load balancing, mTLS, retries, circuit breaking. Pod se registra automáticamente.
- **Consul, etcd**: registry externo con TTL.
- **AWS Cloud Map**: registry gestionado, integra con ECS/EKS.

**Sidecar pattern**: cada pod corre 2 contenedores, el app + un sidecar que maneja concerns cross-cutting (telemetría, auth, retries). Es la topología default con service mesh.

### 4.8 Service-to-service auth

**No confíes en la red interna.** Zero Trust asume que el atacante puede estar dentro del VPC.

Opciones canónicas:
- **mTLS** con service mesh: cada servicio tiene cert. Rotación automática. Istio/Linkerd/AWS App Mesh lo hacen transparente.
- **JWT/OAuth2 service tokens** (client credentials grant): cada servicio pide token al IdP con scopes específicos. El consumer valida signature.
- **AWS IAM roles** (para servicios AWS-native): SigV4, sin contraseñas, rotación automática.
- **API keys**: viable para llamadas simples pero difícil de rotar.

Regla: **no compartas creds entre servicios**. Cada uno con su identidad, sus scopes, su auditabilidad.

---

## 5. Ejemplo práctico completo: pipeline de eventos para LinguaDev Pro

**Contexto.** Cuando un usuario completa una sesión de estudio, queremos:
1. Persistir la sesión en DynamoDB (source of truth).
2. Actualizar el streak diario.
3. Enviar notificación push si el usuario tiene la app cerrada.
4. Alimentar analytics (BigQuery/Athena) para dashboards de retención.
5. Reprocesar automáticamente el algoritmo FSRS para cards revisadas.

Diseño: single write a DynamoDB + DynamoDB Streams → EventBridge Pipes → EventBridge bus → múltiples destinos con reglas.

**Paso 1 — Tabla y streams en SAM.**

```yaml
Resources:
  SessionsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: linguadev-sessions
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - { AttributeName: PK, AttributeType: S }
        - { AttributeName: SK, AttributeType: S }
      KeySchema:
        - { AttributeName: PK, KeyType: HASH }
        - { AttributeName: SK, KeyType: RANGE }
      StreamSpecification:
        StreamViewType: NEW_AND_OLD_IMAGES
```

**Paso 2 — Bus + Pipes.**

```yaml
  LinguaBus:
    Type: AWS::Events::EventBus
    Properties: { Name: linguadev-bus }

  SessionsPipe:
    Type: AWS::Pipes::Pipe
    Properties:
      RoleArn: !GetAtt PipeRole.Arn
      Source: !GetAtt SessionsTable.StreamArn
      SourceParameters:
        DynamoDBStreamParameters:
          StartingPosition: LATEST
          BatchSize: 10
          MaximumBatchingWindowInSeconds: 5
        FilterCriteria:
          Filters:
            - Pattern: |
                {"eventName": ["INSERT"], "dynamodb": {"NewImage": {"type": {"S": ["session_completed"]}}}}
      Target: !GetAtt LinguaBus.Arn
      TargetParameters:
        EventBridgeEventBusParameters:
          Source: linguadev.sessions
          DetailType: SessionCompleted
```

**Paso 3 — Reglas y destinos.**

```yaml
  StreakRule:
    Type: AWS::Events::Rule
    Properties:
      EventBusName: !Ref LinguaBus
      EventPattern: { source: ["linguadev.sessions"], "detail-type": ["SessionCompleted"] }
      Targets:
        - Id: StreakLambda
          Arn: !GetAtt UpdateStreakFunction.Arn

  PushRule:
    Type: AWS::Events::Rule
    Properties:
      EventBusName: !Ref LinguaBus
      EventPattern:
        source: ["linguadev.sessions"]
        "detail-type": ["SessionCompleted"]
        detail: { notify: [true] }
      Targets:
        - Id: PushQueue
          Arn: !GetAtt PushQueue.Arn
          DeadLetterConfig: { Arn: !GetAtt PushDLQ.Arn }
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 }

  AnalyticsRule:
    Type: AWS::Events::Rule
    Properties:
      EventBusName: !Ref LinguaBus
      EventPattern: { source: ["linguadev.sessions"] }
      Targets:
        - Id: Firehose
          Arn: !GetAtt AnalyticsFirehose.Arn
```

**Paso 4 — Consumer idempotente para push.**

```python
import boto3, json, os, time

ddb = boto3.resource('dynamodb')
processed = ddb.Table(os.environ['PROCESSED_TABLE'])
sns = boto3.client('sns')

def handler(event, context):
    for record in event['Records']:
        body = json.loads(record['body'])
        msg_id = body['id']
        try:
            processed.put_item(
                Item={'msg_id': msg_id, 'ts': int(time.time()), 'ttl': int(time.time()) + 86400},
                ConditionExpression='attribute_not_exists(msg_id)'
            )
        except processed.meta.client.exceptions.ConditionalCheckFailedException:
            continue  # ya procesado, skip

        detail = body['detail']
        user_id = detail['user_id']
        token = fetch_push_token(user_id)
        sns.publish(
            TargetArn=token,
            Message=json.dumps({'default': f"¡Racha de {detail['streak']} días!"})
        )
    return {'statusCode': 200}
```

**Paso 5 — Saga con Step Functions para "upgrade a Premium".**

```yaml
  UpgradeSaga:
    Type: AWS::StepFunctions::StateMachine
    Properties:
      RoleArn: !GetAtt SagaRole.Arn
      StateMachineType: STANDARD
      DefinitionString: !Sub |
        {
          "StartAt": "ChargeStripe",
          "States": {
            "ChargeStripe": {
              "Type": "Task", "Resource": "${ChargeArn}",
              "Retry": [{ "ErrorEquals": ["TransientError"], "MaxAttempts": 3, "IntervalSeconds": 2, "BackoffRate": 2 }],
              "Catch":  [{ "ErrorEquals": ["States.ALL"], "Next": "FailSaga" }],
              "Next": "ActivatePlan"
            },
            "ActivatePlan": {
              "Type": "Task", "Resource": "${ActivateArn}",
              "Catch":  [{ "ErrorEquals": ["States.ALL"], "Next": "RefundStripe" }],
              "Next": "SendWelcomeEmail"
            },
            "SendWelcomeEmail": {
              "Type": "Task", "Resource": "${EmailArn}",
              "Retry": [{ "ErrorEquals": ["States.ALL"], "MaxAttempts": 5, "IntervalSeconds": 5, "BackoffRate": 2 }],
              "End": true
            },
            "RefundStripe": { "Type": "Task", "Resource": "${RefundArn}", "Next": "FailSaga" },
            "FailSaga":     { "Type": "Fail", "Error": "UpgradeFailed" }
          }
        }
```

**Discusión y trade-offs:**

- Single write a DynamoDB + Streams elimina el dual-write y hace innecesario transactional outbox aquí (DynamoDB Streams **es** el WAL).
- Pipes reemplaza glue Lambdas.
- EventBridge Rules permiten evolucionar destinos sin cambiar el productor.
- DLQ y retry policy en cada rule.
- Idempotencia en el consumer con `ConditionExpression`.
- Step Functions absorbe la lógica de la saga en un solo lugar (visual, testeable, observable en consola).
- Falta: contract tests entre productor y consumidores, tracing con X-Ray o OTel, budget alerts en EventBridge invocations.

---

## 6. Cheatsheet, reglas mentales y anti-patrones

### Reglas de oro

- ✅ **At-least-once + idempotencia** = efecto exactly-once. Es la fórmula default.
- ✅ **DLQ + alertas** en toda cola de producción.
- ✅ **Exponential backoff con full jitter** en todos los retries.
- ✅ **Transactional outbox** en cualquier "write DB + publish event" con estado.
- ✅ **Bounded contexts** para dividir servicios, no líneas técnicas.
- ✅ **Modular monolith primero**, microservicios cuando la organización lo justifique.
- ✅ **EventBridge Pipes** en lugar de glue Lambdas.
- ✅ **Step Functions o Temporal** para sagas complejas.
- ✅ **Contract testing** con Pact o similar en boundaries entre servicios.
- ✅ **Schema Registry** con reglas de compatibilidad (backward, forward, full).
- ✅ **mTLS o service tokens** — no confiar en la red interna.
- ✅ **Ordering solo donde importa**, y por partition key.
- ✅ **Circuit breakers** en llamadas cross-service (Hystrix legacy, Resilience4j, Polly).
- ✅ **Métricas por queue**: age of oldest message, depth, DLQ depth, throughput.

### Anti-patrones

- ❌ **Dual write** DB + broker sin outbox — inconsistencia garantizada.
- ❌ **Ignorar DLQ** — mensajes se pierden silenciosamente.
- ❌ **Retry sin jitter** — thundering herd tumba tu downstream.
- ❌ **Compartir DB entre microservicios** — distributed monolith.
- ❌ **Dividir por capa técnica** (`user-api`, `user-worker`, `user-cron`) en lugar de dominio.
- ❌ **Chatty services**: 20 hops HTTP para una request de usuario.
- ❌ **Orquestador dios** con la lógica de negocio de medio sistema.
- ❌ **Exactly-once end-to-end** como asunción — no existe fuera de Kafka EOS.
- ❌ **Ordering global cross-servicio** — pagas latencia sin necesidad real.
- ❌ **Partition key hot** (país con volumen dominante, tenant enterprise).
- ❌ **Renombrar campos** de eventos sin plan de evolución.
- ❌ **Versionar APIs con `v2`, `v3`, `v4`** sin plan de deprecation.
- ❌ **Kafka porque suena bien** cuando SQS + SNS cubre el caso con 100× menos ops.

### Tabla de decisión: qué broker/patrón

| Necesidad | Recomendación 2026 |
|---|---|
| Encolar trabajo entre 2 servicios propios | SQS Standard |
| Fan-out simple (evento → N consumers) | SNS → N SQS |
| Bus con reglas de filtrado ricas | EventBridge |
| Streaming, log inmutable con replay | Kafka (MSK Serverless si posible) |
| Pipeline serverless con transformaciones | Kinesis + Firehose, o EventBridge Pipes |
| Orquestar workflow con pasos y compensaciones | Step Functions Standard, o Temporal |
| Workflow corto de alto throughput | Step Functions Express |
| Ordering estricto por entidad | Kafka con partition key, o SQS FIFO con MessageGroupId |
| Notificaciones push/email | SNS o servicio dedicado (SES, Twilio) |
| Job scheduler con cron | EventBridge Scheduler (2022+) |
| CDC de DynamoDB | Streams → Pipes → destino |
| CDC de Postgres | Debezium → Kafka |

### Framework de decisión: ¿debería dividir en microservicios?

Divide **solo si** al menos dos de las siguientes:

1. Equipos distintos se pisan constantemente en el mismo repo.
2. Un componente tiene escalado radicalmente distinto (ej. ML con GPU).
3. Requisitos de compliance/isolation diferentes.
4. Lifecycle de deploy distinto (backend web mensual vs ETL nocturno).
5. Stack técnico incompatible (ej. Rust para hot path, Python para ML).

No divide si:
- "Es la buena práctica" (no lo es sin contexto).
- Equipo <20 personas y sin fricción real.
- No has invertido en observabilidad distribuida.
- No tienes CI/CD por servicio.

---

## 7. Casos reales industria 2024-2026

**Amazon Prime Video — vuelta a monolito (marzo 2023, referenciado 2024-2026).** El equipo publicó un case study famoso reduciendo costes 90% al consolidar un pipeline serverless de microservicios en una aplicación monolítica en ECS. Puntualización: era una arquitectura específica del pipeline de monitoreo, no una crítica general a serverless. **Lección:** el paradigma no vence al contexto. Mide.

**Uber — DoMA (2020, escalado 2024).** Uber documentó su transición de "arquitectura de microservicios" (~2500 servicios) a un enfoque más modular llamado *Domain-Oriented Microservices Architecture*. **Lección:** miles de servicios sin bounded contexts correctos crea acoplamiento invisible.

**Shopify — modular monolith (documentado 2019, refinado hasta 2026).** Shopify corre uno de los monolitos Rails más grandes del mundo (miles de miles de LoC) con **componentización interna** (packwerk). **Lección:** el monolito no es el problema; la falta de modularidad lo es.

**Klarna — outages de comunicación async (2024).** Publicaron postmortems de incidentes donde retries mal configurados amplificaron cascadas de fallos entre servicios. **Lección:** circuit breakers, timeouts jerárquicos y budgets de reintentos deben coexistir.

**AWS re:Invent 2023 — EventBridge Pipes anuncios y adopción masiva 2024-2025.** Pipes eliminó una categoría entera de Lambdas "glue" que muchas empresas mantenían. **Lección:** el ecosistema del hyperscaler te ahorra código si sabes qué existe.

**Kafka 3.9 (dic 2024) — KRaft-only.** Zookeeper deprecated. Tiered storage estable, KIP-848 mejora rebalance. **Lección:** operar Kafka es más simple en 2026 que hace 5 años; el argumento "es demasiada complejidad" pierde fuerza.

**Temporal.io — adopción enterprise (2023-2026).** Coinbase, Snap, HashiCorp, DoorDash usan Temporal para workflows durables. Alternativa fuerte a Step Functions cuando quieres cloud-agnostic. **Lección:** durable execution es una categoría propia que ganó tracción.

**Stripe — idempotency keys en toda su API.** Documentado en Stripe blog. Base de por qué su API es confiable para retries de clientes. **Lección:** exigir `Idempotency-Key` en toda API pública es best practice, no over-engineering.

**Basecamp — Rails monolith HEY.com (2020, referenciado 2024).** DHH publicó extensivamente sobre por qué Basecamp/HEY corren un monolito con equipo pequeño y velocidad alta. **Lección:** para muchos productos, el monolito modular es la elección más productiva.

**Segment — de microservicios a "macroservicios" (2018, referenciado en 2024).** Segment publicó "Goodbye Microservices: From 100s of problem children to 1 superstar." Consolidaron destinos en un monolito por costes de ops y complejity. **Lección:** el péndulo oscila; medir tu caso.

**Meta — Aloha (Async workflows, 2023).** Meta publicó sobre su motor de workflows async interno. Escala a billones de workflows/día. **Lección:** a escala, workflows async con checkpointing es infra crítica.

**AWS Step Functions Express + Distributed Map (2024).** Distributed Map procesa datasets S3 gigantes en paralelo con checkpointing. Reemplaza patrones de "Lambda dispara N Lambdas en fanout" con management explícito. **Lección:** los servicios cloud absorben patrones que antes escribíamos a mano.

---

## 8. Ejercicios prácticos

### Ejercicio 1: SQS + DLQ + idempotencia

**Objetivo:** montar una cola SQS con DLQ, un consumer idempotente, y provocar el flujo a DLQ.

**Setup:**
- LocalStack o cuenta AWS de sandbox.
- Python 3.13 con `boto3`.
- DynamoDB local para tabla `processed_events`.

**Pasos:**
1. Crea SQS Main + SQS DLQ con `maxReceiveCount=3`.
2. Escribe consumer en Python que dedup con `ConditionExpression` en DynamoDB.
3. Publica 100 mensajes; 10 con mismo `id` (duplicados) y 5 con payload que hace fallar el consumer.
4. Verifica que solo se procesan 90 únicos y que 5 acaban en DLQ tras 3 intentos.
5. Redrive de la DLQ con `StartMessageMoveTask`.

**Criterios de éxito:**
- [ ] Duplicados detectados sin re-procesar.
- [ ] Mensajes venenosos acaban en DLQ tras exactamente 3 receives.
- [ ] Alarma CloudWatch en `ApproximateNumberOfMessagesVisible` de la DLQ configurada.
- [ ] Redrive mueve los mensajes de vuelta a Main y esta vez los procesa (fix aplicado).

**Bonus:** añade Xray tracing en Lambda para ver los retries en la timeline.

---

### Ejercicio 2: Transactional Outbox con Postgres + Kafka

**Objetivo:** implementar dual-write correcto con outbox y relay.

**Setup:**
- Postgres 17 y Kafka 3.9 en Docker.
- Node.js o Python con cliente de Kafka.

**Pasos:**
1. Crea tabla `outbox` con columnas `(id, aggregate, event_type, payload, published_at)`.
2. Implementa endpoint `POST /orders` que hace `INSERT orders + INSERT outbox` en la misma transacción.
3. Escribe worker relay que hace `SELECT ... FOR UPDATE SKIP LOCKED`, publica a Kafka, y actualiza `published_at`.
4. Simula un crash del worker entre publish y update — verifica que en el siguiente ciclo el mensaje se re-publica (at-least-once).
5. Verifica en consumer Kafka que se detectan duplicados por `id` (idempotencia downstream).

**Criterios de éxito:**
- [ ] No hay ningún caso donde `orders` tenga rows sin evento correspondiente en Kafka.
- [ ] Bajo crash del relay entre publish y update, hay duplicados pero no pérdidas.
- [ ] Consumer dedup impide efectos duplicados.
- [ ] Métrica de lag (rows en `outbox` con `published_at IS NULL`) instrumentada.

**Bonus:** cambia el relay a Debezium con Postgres logical replication y compara latencia.

---

### Ejercicio 3: Saga con Step Functions

**Objetivo:** modelar la saga de upgrade a Premium de LinguaDev Pro con compensaciones.

**Setup:**
- AWS SAM o Terraform.
- 4 Lambdas: `charge`, `activate`, `email`, `refund`.

**Pasos:**
1. Define state machine `STANDARD` con estados `ChargeStripe → ActivatePlan → SendWelcomeEmail`.
2. Añade `Catch` en cada estado con compensación al anterior.
3. Añade retry en `ChargeStripe` con 3 attempts, backoff 2s, rate 2.
4. Simula fallo en `ActivatePlan` — verifica que `RefundStripe` se ejecuta.
5. Simula fallo transitorio en `ChargeStripe` — verifica retry y éxito.

**Criterios de éxito:**
- [ ] La ejecución termina en estado consistente en 100% de casos (payment=cobrado ↔ plan=activo).
- [ ] Log de ejecución en Step Functions muestra el path correcto (incluyendo compensaciones).
- [ ] Retry no dispara compensación en fallo transitorio.
- [ ] `Fail` state produce alarma CloudWatch.

**Bonus:** añade `ParallelState` que llama a `email` y `analytics` en paralelo tras `ActivatePlan`.

---

### Ejercicio 4: Kafka partitions y consumer groups

**Objetivo:** entender ordering por partition y rebalance behavior.

**Setup:**
- Kafka 3.9 en Docker.
- 2+ consumers en un mismo group.

**Pasos:**
1. Crea topic `user-events` con 6 particiones.
2. Publica 1000 mensajes con `key = user_id % 100`.
3. Lanza 2 consumers del mismo group; observa distribución de partitions.
4. Añade un tercer consumer — observa rebalance (con KIP-848 el rebalance es incremental, mucho menos disruptivo).
5. Simula que 1 consumer se cae — observa reasignación de sus partitions.
6. Verifica que el orden es estricto por key (todos los eventos de `user_id=42` en orden).

**Criterios de éxito:**
- [ ] 2 consumers reparten las 6 partitions 3-3.
- [ ] Con 3 consumers, reparten 2-2-2.
- [ ] Con caída de uno, los otros absorben sus partitions.
- [ ] Bajo alta carga, throughput escala con el número de consumers (hasta N=partitions).

**Bonus:** implementa un consumer con lógica que hace commit manual por batch y verifica at-least-once en caso de crash.

---

### Ejercicio 5: Contract testing con Pact

**Objetivo:** proteger un boundary entre `web-app` y `user-service` con contract test.

**Setup:**
- Pact Foundation JS o Java client.
- Pact Broker (Docker o SaaS).

**Pasos:**
1. En `web-app` (consumer), declara interaction esperada: `GET /users/:id → 200 { id, email, display_name }`.
2. El test genera un pact file y lo sube al broker.
3. En `user-service` (provider), config `verify:pacts` en CI que descarga los pacts y los verifica.
4. Modifica `user-service` para renombrar `display_name` a `displayName` sin coordinar.
5. Verifica que el CI del provider falla al verificar el pact.

**Criterios de éxito:**
- [ ] Pact file publicado en broker tras test consumer.
- [ ] CI del provider descarga pacts y los verifica en cada build.
- [ ] Cambio breaking rompe CI del provider antes de merge.
- [ ] Documento explica cómo evolucionar el contrato compat (añadir campo sin eliminar el viejo, deprecation).

**Bonus:** integra con GitHub Actions y añade un webhook del broker que verifica en cada push del provider.

---

## 9. Recursos y siguientes pasos

**Libros canónicos:**
- Sam Newman — *Building Microservices* (2ª ed., 2021).
- Eric Evans — *Domain-Driven Design* (2003).
- Vaughn Vernon — *Implementing Domain-Driven Design* (2013).
- Gregor Hohpe & Bobby Woolf — *Enterprise Integration Patterns* (2003). Sigue siendo referencia.
- Chris Richardson — *Microservices Patterns* (2018).
- Martin Kleppmann — *Designing Data-Intensive Applications* (2017), cap. 11 (Stream Processing).

**Docs y whitepapers:**
- AWS EventBridge Pipes docs y "Amazon EventBridge Best Practices".
- Confluent Kafka documentation — especialmente Exactly-Once Semantics.
- Google Cloud Pub/Sub docs (comparación mental útil).
- Marc Brooker — *"Exponential Backoff and Jitter"* (AWS Architecture Blog, 2015).
- Chris Richardson — [microservices.io](https://microservices.io) — catálogo de patrones.

**Herramientas:**
- **Temporal.io** para workflows durables.
- **Debezium** para CDC.
- **Pact** para contract testing.
- **kcat** (antes kafkacat) para inspeccionar Kafka.
- **OpenTelemetry** para distributed tracing.
- **AWS Distro for OpenTelemetry (ADOT)** en Lambda.

**Blogs y talks:**
- Netflix TechBlog — patrones de resiliencia y sagas.
- Uber Engineering — DoMA y evolución de arquitectura.
- Shopify Engineering — modular monolith (Kirsten Westeinde talks).
- DHH — sobre monolitos y The Majestic Monolith.
- Adam Wiggins — Twelve-Factor App (sigue vigente en 2026).

**Siguientes pasos:**
- Implementa al menos dos ejercicios en tu propio proyecto (LinguaDev Pro es ideal).
- Aprende a leer el Kafka consumer lag y a interpretarlo (es la métrica #1).
- Lee el próximo capítulo: [Cap 03 — Serverless y networking](./03-serverless-y-networking.md), donde veremos Lambda cold starts, VPC, CloudFront y edge.

---

## 10. Preguntas de práctica (20)

Cubre 20 escenarios sobre mensajería y microservicios, con dificultades junior → staff. Temas: queue vs topic, at-least-once vs exactly-once, DLQ, bounded contexts, SNS/SQS vs Kafka, cuándo NO dividir en microservicios, saga vs 2PC, patrones de API Gateway, partitions de Kafka, idempotencia universal, contract testing, service discovery, choreography vs orchestration, backpressure, distributed monolith, schema evolution, sync vs async, versionado de APIs, y framework final "cuándo microservicios".

- **Fuente:** [`packages/content/src/tech/architecture/sim-02-messaging-and-microservices.json`](../../packages/content/src/tech/architecture/sim-02-messaging-and-microservices.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-02-messaging-and-microservices`
- **Tiempo:** 60 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Cap 01](./01-eleccion-de-db.md) · [Índice](./README.md) · [Cap 03 →](./03-serverless-y-networking.md)
