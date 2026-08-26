# Capítulo 11 — Lambda y serverless en profundidad

> **Focus:** Entender Lambda al nivel de un ingeniero que ha operado producción con miles de invocaciones/segundo: cold start real, SnapStart, VPC, límites, memory-CPU, cuándo NO usar Lambda, extensiones y observabilidad.
> **Áreas:** Serverless · Scalability · Resilience
> **Preguntas de práctica:** 24 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Haber desplegado al menos una Lambda con SAM/Serverless Framework/CDK.
- Nociones de VPC, ENI, NAT Gateway y Security Groups.
- Familiaridad con SQS, DynamoDB Streams o Kinesis a nivel usuario.
- Python 3.12+ o Node.js 20+ instalados; `aws` CLI configurado.
- Haber leído idealmente [Cap 10 — Arquitectura de seguridad](./10-arquitectura-de-seguridad.md).

**Glosario mínimo:**
- **Cold start** — tiempo agregado por inicializar un nuevo *execution environment* (microVM Firecracker + runtime + código init) antes de ejecutar tu handler.
- **Warm invocation** — invocación que reutiliza un execution environment ya inicializado.
- **Init duration** — métrica CloudWatch que mide la fase de inicialización (visible solo en cold starts).
- **Provisioned Concurrency (PC)** — Lambdas pre-inicializadas y pagas incluso ociosas, garantizan cero cold start.
- **SnapStart** — snapshot del microVM post-init que se restaura en ~200 ms; disponible para Java 11+, Python 3.12+, .NET 8+ (GA para Python/.NET desde noviembre 2024).
- **Firecracker** — hypervisor liviano en Rust que AWS creó para Lambda/Fargate; arranca microVMs en ~125 ms.
- **Hyperplane ENI** — ENIs compartidas por combinación (subnet, security-group); redujeron el "VPC cold start penalty" de 10 s a ~1 s desde 2019.
- **Reserved Concurrency** — límite superior de instancias concurrentes de una función (throttling protector).
- **Function URL** — endpoint HTTPS directo a una Lambda sin API Gateway.
- **Response Streaming** — devolver bytes progresivamente hasta 20 MB con TTFB temprano.
- **Lambda Extension API** — hook para procesos secundarios en el mismo execution environment (observability, secrets).

**Setup mínimo:**

```bash
# SAM CLI (Serverless Application Model) + AWS CLI
brew install aws-sam-cli awscli
sam --version    # >= 1.130

# Node 20 + esbuild para bundling minimal
corepack enable && pnpm add -g esbuild

# Python 3.12 + poetry
pyenv install 3.12.6 && pyenv global 3.12.6
pip install poetry

# Lambda Power Tuning (Step Function estado)
# Deploy desde SAR: https://serverlessrepo.aws.amazon.com/applications/arn:aws:serverlessrepo:us-east-1:451282441545:applications~aws-lambda-power-tuning
aws serverlessrepo create-cloud-formation-change-set \
  --application-id arn:aws:serverlessrepo:us-east-1:451282441545:applications/aws-lambda-power-tuning \
  --stack-name lambda-power-tuning

# Structured logs y tracing para experimentar
pip install aws-lambda-powertools[tracer,parser]

# Observabilidad: OpenTelemetry Lambda layer (opcional)
# arn:aws:lambda:${REGION}:184161586896:layer:opentelemetry-python-0_10_0:1
```

---

## 1. El gran cuadro

Lambda cumplió 12 años en 2026 (GA en 2014) y pasó de curiosidad a pieza central de la arquitectura AWS. Lo que hace especial la última generación es que casi todas las cirujadas antiguas —cold start eterno en Java, penalización de VPC de 10 s, provisioning ineficiente— tienen respuesta oficial: **SnapStart** (Java desde 2022, Python y .NET desde noviembre de 2024, con expansión a 23 regiones adicionales en junio 2025) elimina el cold start Java en el 95% de los casos; **Hyperplane ENI** (2019) redujo el penalty de VPC a ~1 s; **/tmp configurable hasta 10 GB** (2022) desbloqueó procesamiento de archivos grandes; **Response Streaming** (2023) permite TTFB temprano; y **Lambda Layers vs container images** desde 2020 dio elegir empaquetado según el use case. Sin embargo Lambda sigue teniendo trade-offs profundos que un arquitecto debe conocer para tomar decisiones basadas en aritmética y no en marketing.

El cold start es la métrica que más obsesiona y peor se entiende. Tiene tres fases medibles: (1) sandbox init con Firecracker (~100-200 ms, AWS optimiza continuamente y tú no controlas); (2) runtime init (JVM 2-5 s sin SnapStart, Node/Python 100-400 ms, Go/Rust 20-80 ms); (3) function init (tu código *top-level*: `import`, crear pools de conexión, cargar modelos). El 90% de las veces el problema está en la fase 3 y se resuelve con **bundling agresivo** (esbuild + tree-shaking + SDK v3 modular), **mover inicialización a top-level** para amortizarla en warm, y **subir memoria** —a más memoria, más CPU proporcional, INIT y parse más rápidos, muchas veces más barato en agregado porque bajan los ms facturados—. La regla empírica que se repite en el mundo real: nunca dejes 128 MB por defecto sin haber medido.

El otro gran malentendido es "Lambda es siempre más barato". A **500 req/s sostenidas 24/7**, Lambda cuesta típicamente 3-5x más que Fargate con Savings Plan porque estás alquilando capacidad efectiva permanente y pagando el markup del servicio. El caso público de Prime Video en 2023 —migraron un pipeline audio/video de Lambda + Step Functions a un monolito en ECS y bajaron 90% el coste— fue polémico pero real y no una anomalía. Lambda gana cuando la carga es *bursty*, *event-driven* con fuentes AWS nativas, *glue code* entre servicios AWS, o cuando el equipo es pequeño y el overhead operacional de contenedores no está amortizado. Este capítulo cubre las cinco áreas críticas (cold start, VPC, límites, memoria/CPU, event sources) más el ecosistema circundante (Response Streaming, Function URL, EventBridge Pipes, Step Functions, Extension API) y aterriza todo en decisiones concretas para LinguaDev Pro.

---

## 2. Anatomía del cold start (nivel medio)

### 2.1 Las tres fases

```
   [ Firecracker microVM ]  init sandbox               ~100-200 ms  (AWS)
   [ Runtime init         ]  arranca Node/JVM/Python   50 ms - 5 s  (elegible por lenguaje)
   [ Function init        ]  tu código top-level       0 - varios s (100% en tu control)
   [ Invoke handler       ]  ejecución por request     tu latencia normal
```

Solo la última fase se factura por cada request; las tres primeras se facturan como **Init Duration** en cold start.

### 2.2 CloudWatch: cómo aislarlo

```sql
-- CloudWatch Logs Insights
fields @timestamp, @initDuration, @duration, @memorySize, @maxMemoryUsed
| filter @type = "REPORT"
| stats avg(@initDuration) as avgInit,
        pct(@initDuration, 99) as p99Init,
        count(*) as total,
        sum(strcontains(@message, "Init Duration") = 1 ? 1 : 0) as coldStarts
  by bin(1h)
```

Regla de dedo: si `p99 total - p99 warm > 400 ms` de forma sostenida, tienes un problema de cold start que vale la pena resolver.

### 2.3 Bundling agresivo (Node.js)

Anti-patrón: `require('aws-sdk')` importa todo v2 (>40 MB). Patrón correcto con SDK v3 + esbuild:

```typescript
// src/handler.ts
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

// Top-level: se ejecuta 1 vez por microVM (fase 3 init)
const ddb = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = JSON.parse(event.body ?? "{}");
  await ddb.send(new PutItemCommand({
    TableName: process.env.TABLE!,
    Item: {
      pk: { S: `USER#${body.userId}` },
      sk: { S: `EVENT#${Date.now()}` },
      payload: { S: JSON.stringify(body) },
    },
  }));
  return { statusCode: 202, body: "" };
};
```

Y el build con esbuild:

```bash
esbuild src/handler.ts \
  --bundle \
  --minify \
  --target=node20 \
  --platform=node \
  --format=cjs \
  --external:@aws-sdk/* \
  --outfile=dist/handler.js

# Con SDK v3 modular, un handler típico pesa 200-800 KB.
# Con v2 pesa 20-40 MB. Diferencia de 500 ms - 2 s en init.
```

Con `--external:@aws-sdk/*` aprovechas que el runtime `nodejs20.x` incluye AWS SDK v3 preinstalado; el bundle final baja aún más.

### 2.4 Bundling en Python: solo lo necesario

```bash
# Requirements minimalista
pip install --target=./package \
  --platform manylinux2014_x86_64 \
  --python-version 3.12 \
  --only-binary=:all: \
  boto3 pydantic aws-lambda-powertools

# Zip sin bytecode compilado, sin tests
cd package && zip -r ../handler.zip . -x '*.pyc' '*__pycache__*' 'tests/*' && cd ..
zip -g handler.zip handler.py
```

Un truco cifrado en oro: mover `boto3` a un **layer** compartido entre funciones. No es cold start (boto3 ya está en el runtime), pero **si necesitas versión específica**, un layer evita duplicarlo en cada zip.

### 2.5 Subir memoria = subir CPU (y a menudo bajar coste)

Lambda asigna CPU proporcional a memoria:
- **128 MB** → ~1/12 de vCPU (throttled)
- **1024 MB** → ~0.5 vCPU
- **1769 MB** → **1 vCPU completo**
- **3538 MB** → 2 vCPU
- **10240 MB** (máximo) → ~6 vCPU

Si el trabajo es CPU-bound (JSON parsing pesado, criptografía, procesamiento de imágenes), doblar memoria puede reducir el tiempo a la mitad y dejar el coste **igual o menor**. Herramienta oficial: **AWS Lambda Power Tuning** (Alex Casalboni, AWS Serverless Hero) ejecuta la función con distintas memorias y grafica cost vs latencia.

```json
// Input al Step Function de Power Tuning
{
  "lambdaARN": "arn:aws:lambda:eu-west-1:123456789012:function:ingest-v3",
  "powerValues": [256, 512, 1024, 1536, 1769, 2048, 3008],
  "num": 100,
  "payload": { "sampleEvent": true },
  "parallelInvocation": true,
  "strategy": "balanced"
}
```

Sale con el punto óptimo. Aplícalo por función; el default 128 MB casi nunca es el mejor.

---

## 3. SnapStart en 2026 (nivel medio → avanzado)

SnapStart fue el punto de inflexión para el cold start. Toma un snapshot del microVM Firecracker **después** de la fase 3 (post-init) y lo restaura en ~200-500 ms cuando un cold start es necesario. Es **gratis** (no pagas snapshot ni almacenamiento adicional).

### 3.1 Runtimes soportados en 2026

- **Java 11, 17, 21, 25** (introducido 2022, primer runtime soportado).
- **Python 3.12, 3.13** (GA noviembre 2024).
- **.NET 8, 9** (GA noviembre 2024).

No soportado: Node.js, Go, Ruby, Rust, custom runtimes, container images. Estos runtimes ya son suficientemente rápidos en init (100-400 ms) o requieren aproximación distinta.

### 3.2 SAM template con SnapStart Java

```yaml
# template.yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Resources:
  IngestFn:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: ld-ingest
      Runtime: java21
      Handler: com.linguadev.ingest.Handler::handleRequest
      MemorySize: 1769
      Timeout: 15
      CodeUri: ./target/ingest-1.0.0.jar
      SnapStart:
        ApplyOn: PublishedVersions   # requiere versión publicada
      AutoPublishAlias: live
      DeploymentPreference:
        Type: Canary10Percent5Minutes
        Alarms:
          - !Ref P99LatencyAlarm
      Architectures: [arm64]        # Graviton, 20% mejor price/perf
      Environment:
        Variables:
          JAVA_TOOL_OPTIONS: "-XX:+TieredCompilation -XX:TieredStopAtLevel=1"
```

Puntos: (1) `ApplyOn: PublishedVersions` es obligatorio; `$LATEST` no soporta SnapStart. (2) `AutoPublishAlias: live` hace que SAM publique nueva versión en cada deploy y desplace tráfico al alias con canary. (3) Arm64 (Graviton) + SnapStart es la combinación ideal en 2026.

### 3.3 CRaC hooks para recursos no serializables

Al snapshotear el microVM, quedan cosas atrapadas que no deberían: conexiones abiertas, tokens JWT del pool con expiración, timestamps que ya no valen, seeds de PRNG que ahora son deterministas. Java expone la API **CRaC** (Coordinated Restore at Checkpoint) para reinicializar:

```java
package com.linguadev.ingest;

import org.crac.Context;
import org.crac.Core;
import org.crac.Resource;
import java.security.SecureRandom;

public class HandlerLifecycle implements Resource {
    private SecureRandom prng;
    private DataSource ds;

    public HandlerLifecycle() {
        Core.getGlobalContext().register(this);
        this.prng = new SecureRandom();       // se snapshottea con estado
        this.ds = createDataSource();          // pool con conns abiertas
    }

    @Override
    public void beforeCheckpoint(Context<? extends Resource> ctx) {
        // Cerrar recursos antes del snapshot
        ((HikariDataSource) ds).close();
    }

    @Override
    public void afterRestore(Context<? extends Resource> ctx) {
        // Reinicializar tras el restore
        this.prng = new SecureRandom();         // nueva entropía real
        this.ds = createDataSource();           // nuevo pool
    }

    private DataSource createDataSource() { /* ... */ }
}
```

Coca-Cola FEMSA reportó públicamente 60% de ahorro al reemplazar Provisioned Concurrency con SnapStart en cargas variables.

### 3.4 SnapStart Python: qué cambia

En Python la ganancia depende de qué haces en el import + `@app.on_start`. Un ejemplo con Powertools y Lambda handler:

```python
# handler.py
import os
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import APIGatewayHttpResolver
import psycopg2

logger = Logger()
tracer = Tracer()
app = APIGatewayHttpResolver()

# Top-level: se pre-warma en el snapshot
db_url = os.environ["DB_URL"]
conn = psycopg2.connect(db_url)

@app.get("/hello")
@tracer.capture_method
def hello():
    return {"msg": "world"}

@logger.inject_lambda_context
def handler(event, context):
    return app.resolve(event, context)
```

Con SnapStart activo, el `psycopg2.connect` se realiza una vez durante el snapshot; en cada cold start restore, la conexión probablemente está muerta (idle timeout) — necesitas un chequeo `conn.closed` y reconectar. Este es el equivalente informal del CRaC hook.

---

## 4. Provisioned Concurrency: cuándo (nivel medio)

PC mantiene N *execution environments* pre-warm y ya inicializados. **Elimina el cold start** completamente pero **pagas por hora aunque no invoques**.

### 4.1 Modelo de coste

- Función 512 MB, PC=50 unidades 24/7 en eu-west-1: ~$105/mes solo de PC.
- Cada invocación adicional cuesta menos ($0.0000097222/GB-s vs $0.0000166667 sin PC).

Si tu carga es *predecible con picos*, PC es económico cuando lo activas por *schedule*:

```hcl
resource "aws_appautoscaling_target" "pc" {
  max_capacity       = 200
  min_capacity       = 10
  resource_id        = "function:${aws_lambda_function.api.function_name}:live"
  scalable_dimension = "lambda:function:ProvisionedConcurrency"
  service_namespace  = "lambda"
}

resource "aws_appautoscaling_scheduled_action" "morning_ramp" {
  name               = "ramp-9am"
  service_namespace  = "lambda"
  resource_id        = aws_appautoscaling_target.pc.resource_id
  scalable_dimension = aws_appautoscaling_target.pc.scalable_dimension
  schedule           = "cron(45 8 ? * MON-FRI *)"
  scalable_target_action { min_capacity = 100, max_capacity = 200 }
}

resource "aws_appautoscaling_scheduled_action" "night_wind_down" {
  name               = "wind-down-19"
  service_namespace  = "lambda"
  resource_id        = aws_appautoscaling_target.pc.resource_id
  scalable_dimension = aws_appautoscaling_target.pc.scalable_dimension
  schedule           = "cron(0 19 ? * MON-FRI *)"
  scalable_target_action { min_capacity = 10, max_capacity = 50 }
}
```

### 4.2 PC vs SnapStart (decisión concreta)

| Caso | Recomendación |
| --- | --- |
| Java/Python/.NET con cold start >2s | **SnapStart** (gratis, resuelve 90% del gap) |
| Latencia p99 estricta < 100 ms garantizada | **PC** (SnapStart hace 200-500 ms mínimo) |
| Node.js/Go con cold start problemático | **PC** con schedule; SnapStart no aplica |
| Traffic 24/7 alto y sostenido | Reconsidera: probablemente Fargate |
| Traffic bursty impredecible | Baseline SnapStart; PC solo si SLA lo exige |

---

## 5. Lambda en VPC: overhead histórico y actual (nivel medio)

### 5.1 El "VPC cold start penalty" pre-2019

Antes de 2019 cada nuevo microVM en VPC creaba una ENI dedicada (proceso lento de EC2 API, 5-15 s). Lambdas en VPC eran famosas por p99 de 10+ segundos en cold.

### 5.2 Hyperplane ENI (2019+)

Desde 2019 AWS gestiona un pool de ENIs compartidas por combinación única `(subnet, security-group)`. El microVM se attachea a una ENI existente en ms. Cold start penalty en VPC bajó a **~1 s adicional en la primera invocación** de una combinación nueva, y **~0 ms** cuando ya hay ENI disponible.

Implicaciones que siguen vigentes:

1. **Necesitas subnets con IPs libres suficientes.** Cada ejecución concurrente consume una IP. Lambda escalando a 1000 concurrentes en subnet /27 → `Insufficient free IP addresses`. **Diseña /24 o /23 por AZ** para producción.
2. **Multi-AZ es obligatorio.** Configura la Lambda en subnets de al menos 2 AZs para HA.
3. **VPC endpoints > NAT gateway** para servicios AWS. NAT cuesta ~$45/mes fijo + $0.045/GB; Gateway endpoints (S3, DynamoDB) son **gratis**; Interface endpoints (KMS, Secrets Manager, STS) cuestan poco.

### 5.3 RDS Proxy es casi obligatorio si vas contra Postgres/MySQL

Lambda puede escalar a 1000+ instancias concurrentes; cada una abriendo conexión a Postgres = **thundering herd** de conexiones cortas. Postgres default `max_connections=100`. Se satura en segundos.

```hcl
resource "aws_db_proxy" "linguadev" {
  name                   = "ld-pg-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = data.aws_subnets.private.ids
  vpc_security_group_ids = [aws_security_group.proxy.id]
  require_tls            = true
  idle_client_timeout    = 1800

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "REQUIRED"
    secret_arn  = aws_secretsmanager_secret.pg_creds.arn
  }
}

resource "aws_db_proxy_default_target_group" "linguadev" {
  db_proxy_name = aws_db_proxy.linguadev.name
  connection_pool_config {
    max_connections_percent      = 90
    max_idle_connections_percent = 50
  }
}
```

La Lambda conecta al **proxy endpoint** con IAM auth; el proxy multiplexa a la BD real con pool que respira. Elimina el thundering herd sin cambiar código.

### 5.4 Cuando puedes evitar VPC

Si tu Lambda solo habla con DynamoDB, S3, EventBridge, Secrets Manager, KMS y SQS —todos accesibles vía Internet-facing pero con IAM— **no metas la Lambda en VPC**. Evitas complejidad, evitas consumo de IPs, mantienes el cold start más simple.

---

## 6. Límites, patrones y ecosistema (nivel medio → avanzado)

### 6.1 Límites que hay que conocer

| Límite | Valor 2026 | Workaround |
| --- | --- | --- |
| Timeout máximo | 900 s (15 min) | Step Functions, Fargate |
| Payload sync request | 6 MB | Pre-signed S3 URL |
| Payload sync response | 6 MB (o 20 MB con Response Streaming) | Streaming, S3 pre-signed |
| Payload async | 256 KB | S3 event source |
| Payload event source SQS | 6 MB (con batch) | Split en producer |
| `/tmp` | 512 MB - 10 GB (configurable) | Configurar en template |
| Memoria | 128 MB - 10240 MB | Ajustar por load |
| Env vars | 4 KB (todas combinadas) | Parameter Store / SM |
| Concurrent executions (regional) | 1000 default, subible | Support ticket |
| Deployment package (zip directo) | 50 MB zipped, 250 MB unzipped | Container image (10 GB) |

### 6.2 Response Streaming (2023+)

Permite responder progresivamente hasta 20 MB con TTFB temprano. Útil para: streaming de LLM completions, SSE, generación incremental de PDFs/imágenes, JSON grandes.

```javascript
// Node.js con Function URL
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    const metadata = {
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream" },
    };
    responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);

    const openai = new OpenAI();
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: event.body }],
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      responseStream.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
    responseStream.write("data: [DONE]\n\n");
    responseStream.end();
  }
);
```

AWS re:Invent 2023 mostró ahorros de ~3 s de TTFB en respuestas de 10 MB.

### 6.3 Function URL vs API Gateway

**Function URL** (2022) da un endpoint HTTPS directo `https://<hash>.lambda-url.eu-west-1.on.aws/`. Es gratis, low-latency. Bueno para: webhooks internos, backends de sitios estáticos con auth simple.

**API Gateway HTTP** añade: routing, JWT authorizer, WAF, throttling per-route, request validation, custom domain con TLS gestionado. Bueno para APIs públicas serias.

Regla: si no necesitas nada de API Gateway, Function URL es más simple y ~5 ms más rápido.

### 6.4 EventBridge Pipes: point-to-point sin código de plumbing

EventBridge Pipes (GA diciembre 2022) conecta **una** fuente con **un** target aplicando filtrado + enriquecimiento sin escribir una Lambda "puente". Fuentes: SQS, Kinesis, DynamoDB Streams, MQ, MSK. Targets: cualquier destino EventBridge (Lambda, Step Functions, SQS, EventBus, API destinations, etc.).

```hcl
resource "aws_pipes_pipe" "ddb_to_es" {
  name     = "ddb-to-es"
  role_arn = aws_iam_role.pipe.arn
  source   = aws_dynamodb_table.exercises.stream_arn
  target   = aws_cloudwatch_event_bus.domain.arn

  source_parameters {
    dynamodb_stream_parameters {
      starting_position                = "LATEST"
      batch_size                       = 10
      maximum_batching_window_in_seconds = 2
    }
    filter_criteria {
      filter {
        pattern = jsonencode({
          eventName = ["INSERT", "MODIFY"]
          dynamodb  = { NewImage = { type = { S = ["EXERCISE"] } } }
        })
      }
    }
  }

  enrichment = aws_lambda_function.enrich.arn
  enrichment_parameters {
    input_template = <<EOT
{
  "id": <$.dynamodb.NewImage.id.S>,
  "type": <$.dynamodb.NewImage.type.S>,
  "eventTime": <$.dynamodb.ApproximateCreationDateTime>
}
EOT
  }

  target_parameters {
    event_bridge_event_bus_parameters {
      source        = "linguadev.exercises"
      detail_type   = "exercise.upserted"
    }
  }
}
```

Elimina 3 Lambdas de glue típicas de un pipeline stream → transform → publish.

### 6.5 Step Functions vs Lambda chaining

Si tienes 3+ Lambdas encadenadas (`fn1 → fn2 → fn3`) con lógica de retry, branching, timeouts largos o parallelism:

- **Chain a mano**: acumulas complejidad de retry, timeouts, DLQ propios; observabilidad fragmentada.
- **Step Functions Standard**: workflow declarativo, retry/catch nativos, hasta 1 año de duración, historial de ejecución completo, ~$25 por millón de transitions.
- **Step Functions Express**: hasta 5 min, más barato ($1/millón), sin historial persistente. Ideal para orquestación de alta frecuencia.

```json
{
  "Comment": "Ingest de ejercicio + generación de audio TTS",
  "StartAt": "Validate",
  "States": {
    "Validate": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:eu-west-1:123:function:validate",
      "Retry": [{ "ErrorEquals": ["States.Timeout"], "MaxAttempts": 2 }],
      "Next": "TTSAndStore"
    },
    "TTSAndStore": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "GenerateAudio",
          "States": {
            "GenerateAudio": {
              "Type": "Task",
              "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
              "Parameters": {
                "FunctionName": "polly-async",
                "Payload": { "text.$": "$.text", "taskToken.$": "$$.Task.Token" }
              },
              "End": true
            }
          }
        },
        {
          "StartAt": "PersistExercise",
          "States": {
            "PersistExercise": {
              "Type": "Task",
              "Resource": "arn:aws:states:::dynamodb:putItem",
              "Parameters": {
                "TableName": "exercises",
                "Item.$": "$.item"
              },
              "End": true
            }
          }
        }
      ],
      "Next": "Publish"
    },
    "Publish": {
      "Type": "Task",
      "Resource": "arn:aws:states:::events:putEvents",
      "Parameters": {
        "Entries": [{
          "EventBusName": "domain",
          "Source": "linguadev.exercises",
          "DetailType": "exercise.created",
          "Detail.$": "$"
        }]
      },
      "End": true
    }
  }
}
```

Ganas: retries declarativos, Parallel/Map nativos, visualización, historial. Pierdes: 25 ms de overhead por transition. Justificable si el proceso tiene ≥3 pasos con lógica.

---

## 7. Event sources: SQS, DynamoDB Streams, Kinesis (nivel avanzado)

### 7.1 SQS + Lambda

Reglas de oro:

1. **Idempotencia obligatoria.** SQS Standard es *at-least-once*; puedes recibir el mismo mensaje 2+ veces.
2. **`reportBatchItemFailures: true`** — fallos individuales sin reprocesar todo el batch.
3. **Visibility timeout ≥ 6x function timeout** — evita solapes.
4. **DLQ configurado** — para el "poison message" tras N intentos.
5. **Reserved Concurrency** si necesitas rate-limitar el downstream (RDS, API externa).

Ejemplo Python con Powertools:

```python
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, process_partial_response
from aws_lambda_powertools.utilities.idempotency import idempotent_function, DynamoDBPersistenceLayer, IdempotencyConfig
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord

persistence = DynamoDBPersistenceLayer(table_name="idempotency-store")
config = IdempotencyConfig(event_key_jmespath="messageId", expires_after_seconds=3600)
processor = BatchProcessor(event_type=EventType.SQS)

@idempotent_function(data_keyword_argument="record", config=config, persistence_store=persistence)
def process_one(record: SQSRecord):
    body = record.json_body
    # tu lógica idempotente
    return f"processed:{record.message_id}"

def record_handler(record: SQSRecord):
    return process_one(record=record)

def handler(event, context):
    return process_partial_response(
        event=event, record_handler=record_handler,
        processor=processor, context=context
    )
```

El decorator `@idempotent_function` guarda un hash del `messageId` en DynamoDB; una reentrega devuelve el resultado cacheado sin reejecutar la lógica.

### 7.2 SQS FIFO

- **Orden garantizado** dentro de un `MessageGroupId`.
- **Exactly-once dentro de la deduplicación window** (5 min).
- Throughput: 300 msg/s por grupo, hasta 3000 con batching y *high-throughput mode*.
- Diseño típico: `MessageGroupId = userId` → orden por usuario, paralelismo entre usuarios.

### 7.3 DynamoDB Streams / Kinesis: el poison pill que bloquea el shard

A diferencia de SQS, **un fallo en Streams/Kinesis bloquea el shard** hasta agotar retries. Sin configuración: retries **infinitos** → shard congelado.

```yaml
# SAM: event source de DynamoDB Streams protegido
Events:
  StreamEvent:
    Type: DynamoDB
    Properties:
      Stream: !GetAtt ExercisesTable.StreamArn
      StartingPosition: TRIM_HORIZON
      BatchSize: 100
      MaximumBatchingWindowInSeconds: 2
      MaximumRetryAttempts: 5           # no infinito
      MaximumRecordAgeInSeconds: 3600    # descartar registros viejos
      BisectBatchOnFunctionError: true   # divide para aislar el poison
      ParallelizationFactor: 5           # 5 batches concurrentes por shard
      DestinationConfig:
        OnFailure:
          Destination: !GetAtt PoisonQueue.Arn
```

Retention de Streams es **fija 24h**; Kinesis es configurable hasta 7 días (default 24h) o 365 días con *long-term storage*. Para replay/rebuild de un índice de OpenSearch, Kinesis + retention alta es más robusto.

### 7.4 Elección: SQS vs Streams vs Kinesis vs EventBridge

| Necesidad | Elige |
| --- | --- |
| Queue, unordered, retry por mensaje independiente | **SQS Standard** |
| Orden estricto por clave, throughput moderado | **SQS FIFO** |
| Log-oriented, orden por shard, replay | **Kinesis** o **DynamoDB Streams** |
| Muchos consumidores desacoplados, filtering en broker | **EventBridge** |
| Pipeline point-to-point con transform | **EventBridge Pipes** |

---

## 8. Lambda Extensions y observabilidad (nivel avanzado)

La **Extension API** (2020) permite correr procesos externos dentro del mismo microVM Lambda. Un extension puede:

- Enviar telemetría (metrics, traces, logs) a Datadog/New Relic/Grafana sin latencia extra en el path del handler.
- Precargar secretos desde SM/Vault y exponerlos por Unix socket local (evita cold-start hit de descargarlos síncronamente).
- Bufferear logs y enviarlos batched al colector.

Ejemplo: layer de AWS Parameters and Secrets Extension:

```yaml
Layers:
  - !Sub arn:aws:lambda:${AWS::Region}:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension:12
Environment:
  Variables:
    PARAMETERS_SECRETS_EXTENSION_HTTP_PORT: 2773
```

Y en el handler:

```python
import os, requests, json

def get_secret(name):
    r = requests.get(
        f"http://localhost:{os.environ['PARAMETERS_SECRETS_EXTENSION_HTTP_PORT']}/secretsmanager/get?secretId={name}",
        headers={"X-Aws-Parameters-Secrets-Token": os.environ["AWS_SESSION_TOKEN"]},
        timeout=1,
    )
    return json.loads(r.json()["SecretString"])
```

El extension mantiene una cache local; la primera lectura tarda ~50 ms, las siguientes son ~1 ms sin llamar a Secrets Manager.

Para tracing distribuido, la **OpenTelemetry Lambda layer** exporta a cualquier backend compatible OTLP sin bloquear el handler.

---

## 9. Aplicación a LinguaDev Pro

LinguaDev Pro corre 90% del backend en Lambda. Decisiones concretas basadas en este capítulo:

### 9.1 Función por función

| Función | Runtime | Memoria | PC? | SnapStart | En VPC? |
| --- | --- | --- | --- | --- | --- |
| `api-http` (BFF) | Node 20 (arm64) | 1024 | Schedule 9-19h | N/A | No |
| `speech-eval` (usa OpenAI) | Python 3.12 | 1769 | No | Sí | No |
| `exercise-ingest` (DB write) | Python 3.12 | 512 | No | Sí | Sí (RDS Proxy) |
| `nightly-billing` | Python 3.12 | 3008 | No | No | Sí |
| `sse-stream` (Response Streaming) | Node 20 | 1024 | No | N/A | No |

### 9.2 Elecciones justificadas

- `api-http` en Function URL detrás de CloudFront (sin API Gateway) para minimizar latencia.
- `speech-eval` con SnapStart Python + Presidio preloaded en top-level → cold start ~400 ms en lugar de 2 s.
- `exercise-ingest` en VPC con RDS Proxy; batch size 25 desde SQS + `reportBatchItemFailures` + DLQ.
- `nightly-billing` corre 1x/día → cold start no importa, memoria alta para procesar batch rápido.
- `sse-stream` usa Response Streaming para enviar tokens del LLM al cliente conforme llegan.

### 9.3 Coste sanity-check

Con ~500 req/s en horario diurno (10h/día) y ~50 req/s el resto:

- **Todo Lambda:** ~$1200/mes solo en compute.
- **`api-http` en ECS Fargate con Savings Plan** (2 tasks 1 vCPU / 2 GB, con autoscaling a 6 en pico): ~$180/mes.

Racional: `api-http` mueve a Fargate; el resto queda en Lambda porque son event-driven o bursty. Aritmética antes que dogma.

---

## 10. Ejercicios prácticos

### 10.1 Medir tu cold start real (30 min)

**Objetivo:** graficar cold start por percentil de tu Lambda actual.

```bash
aws logs start-query \
  --log-group-name /aws/lambda/tu-funcion \
  --start-time $(date -u -d '24 hours ago' +%s) \
  --end-time $(date -u +%s) \
  --query-string 'fields @initDuration, @duration | filter @type="REPORT" | stats avg(@initDuration), pct(@initDuration, 50), pct(@initDuration, 99) by bin(1h)'
```

**Verde:** tienes tabla horaria con avg/p50/p99 de init duration y sabes cuántos cold starts sufres al día.

### 10.2 Optimizar bundling Node (45 min)

**Objetivo:** reducir el zip de tu handler ≥50%.

Pasos: migrar cualquier `require('aws-sdk')` v2 a v3 modular; añadir esbuild con `--external:@aws-sdk/*`; comparar `unzip -l antes.zip` vs `después.zip`.

**Verde:** el nuevo zip pesa menos de la mitad y `initDuration` p50 baja ≥30% en el próximo día tras deploy.

### 10.3 Aplicar Lambda Power Tuning (30 min)

**Objetivo:** encontrar el sweet spot de memoria para tu Lambda.

Deploy del state machine desde SAR, invocar con tu payload real, comparar el output. Actualizar la memoria de la función al valor `balanced`.

**Verde:** captura del gráfico `cost vs speed` + PR aplicando el nuevo `MemorySize` con racional en la descripción.

### 10.4 Activar SnapStart en una Lambda Python (45 min)

**Objetivo:** medir la mejora al activar SnapStart en una función Python existente.

Requiere runtime `python3.12` o `python3.13` y publicar versiones (SnapStart no funciona sobre `$LATEST`). Migrar el alias, medir 24h antes y después.

**Verde:** `initDuration` p99 baja ≥60% y las métricas de restore aparecen en CloudWatch (`RestoreDuration`).

### 10.5 Migrar de "Lambda chain" a Step Functions (90 min)

**Objetivo:** convertir un flujo de 4 Lambdas encadenadas (invoke → invoke → invoke) a un Step Function Express con retry declarativo.

**Verde:** el ASL del state machine cabe en <50 líneas, elimina las 3 llamadas SDK `invoke` intermedias, y una prueba de fallo simulado del paso 2 provoca retry automático.

### 10.6 Configurar RDS Proxy para tu Lambda contra Postgres (60 min)

**Objetivo:** eliminar el thundering herd de conexiones.

Provisionar RDS Proxy (Terraform arriba), migrar la connection string de la Lambda al endpoint del proxy, activar IAM auth. Correr `wrk -c 200 -t 8` durante 2 minutos y observar `pg_stat_activity`.

**Verde:** conexiones en Postgres se mantienen bajo 30 mientras el proxy multiplexa 200 clientes concurrentes de la Lambda.

### 10.7 Simulacro oficial

Cuando termines los ejercicios, resuelve el simulacro con los 24 escenarios reales:

[`packages/content/src/tech/architecture/sim-11-lambda-serverless-deep.json`](../../packages/content/src/tech/architecture/sim-11-lambda-serverless-deep.json) — **id:** `architecture-sim-11-lambda-serverless-deep`.

Cubre cold start, SnapStart, PC, VPC/Hyperplane, límites de payload/timeout, memory-CPU, Lambda vs Fargate, event sources (SQS/Streams/Kinesis), Reserved Concurrency, DLQ, Response Streaming y más. Aspira al 75% o más antes de pasar al Cap 12.

---

## Navegación

- Anterior: [Cap 10 — Arquitectura de seguridad](./10-arquitectura-de-seguridad.md)
- Siguiente: [Cap 12 — Migraciones zero-downtime →](./12-migraciones-zero-downtime.md)
- [Índice](./README.md)
