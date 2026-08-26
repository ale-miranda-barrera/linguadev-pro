# Capítulo 16 — Infra IA en AWS: Bedrock, SageMaker, vLLM

> **Focus:** Deployment de IA en AWS: Bedrock (modelos managed) vs SageMaker (custom + hosting) vs auto-hosted en EC2/EKS con vLLM/TGI. Cuotas, latencia, seguridad (PrivateLink, IAM, Guardrails), costo, Inferentia/Trainium.
> **Áreas:** AI infra en AWS · Cost & inference
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

**Pre-requisitos:**
- AWS account activa con permisos suficientes (o sandbox).
- AWS CLI v2 configurado (`aws configure` con Access Key + Region).
- Fundamentos de VPC, IAM, Security Groups, CloudWatch.
- Python 3.11+ con `boto3` reciente.
- Familiaridad con LLMs, embeddings y RAG (ver [cap 06](./03-vector-dbs-hybrid-reranking.md), [cap 14](./07-agent-loops-orchestration.md)).
- Terraform 1.7+ opcional para infra-as-code.
- Ideal: haber llamado alguna vez la API de Anthropic o OpenAI directamente.

**Glosario mínimo:**
- **Bedrock**: servicio managed de AWS que expone modelos foundation por API (per-token).
- **SageMaker**: plataforma ML end-to-end (training + hosting) con control fino sobre infra.
- **Model Unit (MU)**: unidad de capacidad dedicada de throughput en Bedrock Provisioned Throughput.
- **Inference Profile**: identificador de modelo que enruta requests entre múltiples regiones (`us.*`, `eu.*`, `apac.*`).
- **vLLM**: motor open-source de inferencia LLM con PagedAttention y continuous batching.
- **Inferentia (Inf2) / Trainium (Trn2)**: chips ML custom de AWS (diseñados por Annapurna Labs).
- **HyperPod**: cluster managed persistente de SageMaker para training a gran escala.
- **PrivateLink / VPC Endpoint**: túnel privado dentro de la red AWS para no salir por internet.
- **Karpenter**: autoscaler de nodos flexible para EKS, elige instance type óptimo por pod.
- **JumpStart**: catálogo de modelos pre-empaquetados dentro de SageMaker con deploy 1-click.

**Setup mínimo:**

```bash
# Instalar/actualizar AWS CLI v2
# macOS: brew install awscli
# Windows: descargar MSI oficial
aws --version              # esperado: aws-cli/2.x

# Configurar credenciales
aws configure              # Access Key + Secret + Region (p. ej. us-east-1)

# SDK Python
python -m venv .venv && source .venv/bin/activate
pip install --upgrade boto3 anthropic-bedrock botocore
pip install "langchain-aws>=0.2" "sagemaker>=2.230"

# Solicitar acceso a modelos en Bedrock console (una vez por account/region)
# Console → Bedrock → Model access → Manage model access → Request

# Verificar acceso listando modelos
aws bedrock list-foundation-models --region us-east-1 \
    --query "modelSummaries[?providerName=='Anthropic'].modelId"

# Terraform (opcional)
terraform -version         # esperado: v1.7+
```

Si es tu primera vez con Bedrock, verás que los modelos requieren un **model access request** manual en la consola por región. Sin este paso, `InvokeModel` devuelve `AccessDeniedException` aunque tu IAM sea correcto.

---

## 1. El gran cuadro

AWS ofrece cuatro caminos principales para operar IA en 2026, y elegir el equivocado suele costar entre semanas de re-trabajo y una factura mensual duplicada. **Bedrock** es la vía managed: eliges un modelo del catálogo (Anthropic Claude, Amazon Nova, Meta Llama, Mistral, Cohere, AI21, Stability, y desde 2025 también OpenAI GPT via marketplace) y consumes por token sin gestionar infraestructura. **SageMaker** es la plataforma ML completa: entrenas modelos custom, los hosteas en endpoints con la instancia y el container que decidas, orquestas pipelines, y para training a gran escala usas HyperPod. **EC2 con GPU o EKS + vLLM** es el camino self-managed cuando necesitas máximo control o coste unitario mínimo a volumen enorme. Y **Lambda / Fargate** cubren inferencia CPU-only y orquestación alrededor.

La regla mental que funciona en 2026 es la siguiente. Para **chat/RAG genérico con modelos frontier** (Claude, Nova, Llama), empieza con Bedrock: sin ops, elástico, integrado con Guardrails, IAM y PrivateLink. Para **modelos custom que fine-tuneaste tú mismo**, SageMaker Endpoints o Bedrock Custom Model Import; el primero si necesitas control granular, el segundo si prefieres delegar el serving. Para **training desde cero o fine-tune profundo de modelos grandes**, SageMaker HyperPod ahorra semanas de ops de cluster. Para **volumen enorme sostenido con arquitecturas open** (Llama, Mistral, DeepSeek), EKS + Karpenter + vLLM da coste unitario mínimo pero exige capacidad real de MLOps.

El catálogo de Bedrock creció de forma explosiva entre 2023 y 2026. Los modelos disponibles a fecha del capítulo (verificar disponibilidad regional siempre) incluyen las familias **Anthropic Claude 4.5, 4.6, 4.7, 4.8 y Opus/Sonnet/Fable 5**, **Amazon Nova (Micro, Lite, Pro, Premier)** anunciada en re:Invent 2024, **Meta Llama 3.3 y 4**, **Mistral Large 2 y Mixtral**, **Cohere Command R/R+, Embed, Rerank**, **AI21 Jamba**, **Stability SD3/SDXL**, la familia **Amazon Titan** (con embeddings v2) y modelos importados vía **Custom Model Import** (Llama, Mistral, Flan-T5 fine-tuneados externamente). Bedrock Marketplace (re:Invent 2024) añadió cientos de modelos de HuggingFace y proveedores especializados.

Las **features transversales** clave de Bedrock son: **Knowledge Bases** (RAG managed con OpenSearch Serverless, Aurora pgvector, Pinecone, Redis Enterprise, MongoDB Atlas como stores), **Agents** con multi-agent collaboration y memoria persistente (GA 2024), **Guardrails** con Automated Reasoning checks (GA agosto 2025), **cross-region inference profiles** (`us.*`, `eu.*`, `apac.*` y `Global` desde septiembre 2025) para saltar throttling, **Provisioned Throughput** para SLA garantizado, **Prompt Management** y **Bedrock Studio** para no-code building.

El otro pilar es el **silicio custom de AWS**: **Inferentia2** (Inf2) para inferencia y **Trainium2** (Trn2, con las Trn2 UltraServer anunciadas en re:Invent 2024, "Project Rainier" para Anthropic) para training. La adopción es real: Anthropic entrenó parte de Claude en Trainium2, Snap y Airbnb operan inferencia en Inf2, y el ahorro típico frente a H100/A100 equivalentes es del 40-50% cuando el modelo target está soportado por el Neuron SDK. La restricción es que el ecosistema CUDA sigue siendo mayor, así que no todo modelo o feature está compilado para Neuron.

---

## 2. Fundamentos (nivel básico)

### 2.1 Bedrock vs SageMaker vs EC2/EKS: cuándo cada uno

| Necesidad | Servicio recomendado | Razón |
|---|---|---|
| Chat/RAG con Claude, Nova, Llama del catálogo | **Bedrock** | Managed, per-token, cero ops |
| RAG managed con S3/Confluence/Sharepoint | **Bedrock Knowledge Bases** | Chunking + embedding + storage automáticos |
| Agent con tools + memoria + KB integrada | **Bedrock Agents** | Orquestación managed, multi-agent, integración IAM |
| Fine-tune de modelo custom (no en catálogo) | **SageMaker Training / HyperPod** | Control total del proceso |
| Servir modelo fine-tuneado propio | **SageMaker Endpoint** o **Bedrock Custom Model Import** | Depende de si quieres ops o managed |
| Training desde cero (>7B, semanas) | **SageMaker HyperPod** | Auto-recovery de node failures |
| Volumen enorme sostenido con Llama-70B | **EKS + Karpenter + vLLM** | Coste unitario mínimo si tienes ops |
| Modelo pequeño / inferencia CPU / orquestación | **Lambda** | Serverless, per-invocation |
| Batch processing offline | **SageMaker Batch Transform** | Sin endpoint persistente |

Regla operativa: **empieza en Bedrock hasta que tengas datos que justifiquen migrar.** Muchas startups y enterprises operan en producción con solo Bedrock durante años antes de necesitar auto-hosting.

### 2.2 Ejemplo mínimo: llamada a Claude via Bedrock

```python
# minimal_bedrock.py
import boto3, json

client = boto3.client("bedrock-runtime", region_name="us-east-1")

body = {
    "anthropic_version": "bedrock-2023-05-31",
    "max_tokens": 512,
    "system": "Eres un asistente conciso. Máximo 3 frases.",
    "messages": [
        {"role": "user", "content": "Explica RAG en 3 frases."}
    ],
}

# Cross-region inference profile (recomendado 2026 para saltar throttling regional)
model_id = "us.anthropic.claude-sonnet-4-5-v1:0"   # verificar id exacto en tu region

response = client.invoke_model(
    modelId=model_id,
    body=json.dumps(body),
    contentType="application/json",
    accept="application/json",
)

payload = json.loads(response["body"].read())
print(payload["content"][0]["text"])
print(f"Tokens: in={payload['usage']['input_tokens']}, out={payload['usage']['output_tokens']}")
```

Si prefieres el API unificado `Converse` (soporta la misma interfaz para Claude, Nova, Llama, Mistral):

```python
resp = client.converse(
    modelId=model_id,
    system=[{"text": "Eres un asistente conciso."}],
    messages=[{"role": "user", "content": [{"text": "Explica RAG en 3 frases."}]}],
    inferenceConfig={"maxTokens": 512, "temperature": 0.3},
)
print(resp["output"]["message"]["content"][0]["text"])
```

### 2.3 Catálogo de modelos en Bedrock a 2026

Familia por proveedor (verifica siempre disponibilidad y precios en tu región):

- **Anthropic**: Claude Haiku 4.5, Sonnet 4.5, Sonnet 4.6, Opus 4.5, Opus 4.6, Opus 4.7, Opus 4.8, y la nueva serie 5 (Fable 5, Sonnet 5, Opus 5).
- **Amazon**: Nova Micro, Nova Lite, Nova Pro, Nova Premier; Titan Text Express/Lite, Titan Embeddings v2, Titan Image v2.
- **Meta**: Llama 3.3-70B, familia Llama 4 (Scout, Maverick, Behemoth) donde esté disponible.
- **Mistral**: Mistral Large 2, Mistral Small, Mixtral 8x22B.
- **Cohere**: Command R/R+, Embed English/Multilingual v3, Rerank v3.
- **AI21**: Jamba 1.5 Mini/Large.
- **Stability AI**: SD3, SDXL, Stable Image Ultra.
- **OpenAI**: GPT-5.x disponible parcialmente vía Bedrock Marketplace (2025-2026, verificar).
- **DeepSeek, Qwen, Gemma, Falcon**: disponibles en Bedrock Marketplace.
- **Custom Model Import**: sube tu Llama/Mistral fine-tuneado externamente.

### 2.4 Guardrails: safety declarativo

Bedrock Guardrails es una capa de safety que se aplica **antes** y/o **después** de la inferencia, funciona con cualquier modelo del catálogo, y se configura declarativamente. Categorías cubiertas:

- **Denied topics**: temas prohibidos definidos por lenguaje natural.
- **Content filters**: hate, insults, sexual, violence, misconduct, prompt attacks.
- **Sensitive information**: PII detection y redaction (email, phone, SSN, credit card, direcciones).
- **Word filters**: blocklist textual.
- **Contextual grounding**: verifica que la respuesta se sustente en el contexto RAG suministrado (evita alucinaciones).
- **Automated Reasoning checks** (GA agosto 2025): verifica afirmaciones lógicas contra reglas formales.

```python
resp = client.converse(
    modelId=model_id,
    messages=[{"role": "user", "content": [{"text": "..."}]}],
    guardrailConfig={
        "guardrailIdentifier": "my-guardrail-v1",
        "guardrailVersion": "3",
        "trace": "enabled",
    },
)
# Si el guardrail intervino: resp["stopReason"] == "guardrail_intervened"
```

### 2.5 Analogías mentales

- **Bedrock = AWS Elastic Beanstalk para IA.** Managed: eliges modelo del catálogo, consumes por API, AWS gestiona infra y escalado. Cero ops, poco control fino.
- **SageMaker = EC2 con superpoderes ML.** Control completo (elige instancia, container, código), pero tú operas: capacity, deploy, observability.
- **EKS + vLLM = tu propio data center en AWS.** Máximo control, mínimo coste por token a volumen, pero exige MLOps real (SRE, capacity planning, security).
- **Bedrock Knowledge Bases = RAG "para llevar".** Igual que Elastic Beanstalk te ahorra configurar Apache/Nginx, KB te ahorra configurar chunking + embedding + vector store.
- **Bedrock Agents = AWS Step Functions para LLM.** Declarativo, IAM-native, con tools (Lambda) y knowledge integrado. Trade-off: portabilidad limitada.
- **Inference profiles cross-region = CloudFront para LLMs.** Enrutan tu request a la región con capacidad disponible; sin código extra sube availability.
- **Trainium/Inferentia = ARM chips de AWS pero para IA.** Alternativa a NVIDIA (CUDA); mejor $/token si tu modelo compila con Neuron SDK.

### 2.6 Desglose paso a paso: qué pasa cuando invocas Claude en Bedrock

1. **`boto3.client("bedrock-runtime").invoke_model(...)`** firma el request con SigV4 usando tus credenciales AWS.
2. **DNS resolution:** `bedrock-runtime.us-east-1.amazonaws.com` → IP regional. Si hay VPC endpoint (PrivateLink), DNS interno resuelve al endpoint privado; el tráfico nunca sale de AWS.
3. **IAM check:** el service verifica que tu principal (IAM role/user) tenga `bedrock:InvokeModel` con `Resource` matcheando el `modelId`. Sin match → `AccessDeniedException`.
4. **Model access check:** además de IAM, el modelo debe estar habilitado en tu account/region (approve manual en console). Sin approval → `AccessDeniedException` distinto.
5. **Quota check:** verifica que no excedas `TokensPerMinute` ni `RequestsPerMinute` de tu account. Si excedes → `ThrottlingException`.
6. **Routing (si usas inference profile `us.*`):** Bedrock elige la región con mejor capacity en ese momento (us-east-1, us-west-2, us-east-2).
7. **Ejecución del modelo:** prefill + decode. Si `InvokeModelWithResponseStream`, cada token vuelve como chunk SSE.
8. **Guardrail (si configurado):** validación pre-y/o-post con las políticas definidas.
9. **Logging (si `Model Invocation Logging` activo):** input + output se envían a CloudWatch Logs o S3.
10. **Metrics:** `AWS/Bedrock` metrics (`Invocations`, `InvocationLatency`, `Input/OutputTokenCount`) actualizadas.

Nota: pasos 3-4 son la fuente #1 de errores para newcomers. IAM correcto ≠ model access aprobado.

### 2.7 Mini-código: llamada con guardrail + tracing

```python
# bedrock_with_guardrail.py
import boto3, json, time

client = boto3.client("bedrock-runtime", region_name="us-east-1")
MODEL = "us.anthropic.claude-sonnet-4-6"

def ask_guarded(prompt: str) -> dict:
    t0 = time.time()
    resp = client.converse(
        modelId=MODEL,
        system=[{"text": "Eres asistente financiero. Nunca das consejo específico de inversión."}],
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": 500, "temperature": 0.3},
        guardrailConfig={
            "guardrailIdentifier": "financial-advice-guardrail",
            "guardrailVersion": "1",
            "trace": "enabled",
        },
    )
    latency_ms = int((time.time() - t0) * 1000)
    return {
        "text": resp["output"]["message"]["content"][0]["text"] if resp["stopReason"] != "guardrail_intervened" else "[BLOCKED]",
        "stop_reason": resp["stopReason"],
        "input_tokens": resp["usage"]["inputTokens"],
        "output_tokens": resp["usage"]["outputTokens"],
        "latency_ms": latency_ms,
        "guardrail_trace": resp.get("trace", {}).get("guardrail"),
    }

print(ask_guarded("¿Debería invertir todo mi 401k en Nvidia?"))
```

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Bedrock Knowledge Bases (RAG managed)

Bedrock Knowledge Bases (KB) automatiza el pipeline completo de RAG. Apuntas una **datasource** (S3, Confluence, Sharepoint, Salesforce, Web Crawler), eliges el **embedding model** (Titan v2, Cohere Embed v3), configuras el **vector store** (OpenSearch Serverless por default, Aurora pgvector, Pinecone, Redis Enterprise, MongoDB Atlas) y el KB ingresa, chunkea (fixed, hierarchical, semantic o custom), embebe e indexa.

Tabla de decisión del vector store:

| Store | Fortalezas | Debilidades | Cuándo |
|---|---|---|---|
| **OpenSearch Serverless** | Managed AWS-nativo, autoscaling, hybrid search | Cost baseline alto, cold start | Default AWS-first |
| **Aurora pgvector** | SQL familiar, joins, TX | Escalado manual, pgvector ~1M vectors OK | Ya tienes Aurora, corpus mediano |
| **Pinecone** | Managed multi-cloud, filtros ricos | Vendor externo | Alta escala, features avanzadas |
| **Redis Enterprise** | Latencia sub-ms, hybrid | Coste alto por RAM | Baja latencia crítica |
| **MongoDB Atlas** | Docs + vectores en un lugar | Vector search más nuevo | Ya usas Atlas |

Chunking strategies:

- **Fixed size**: tamaño fijo (300-800 tokens) con overlap. Simple pero rompe estructura.
- **Hierarchical**: chunks pequeños con parent chunks contextuales. Recupera chico, expande a parent.
- **Semantic**: divide por sección/párrafo/heading. Mejor para docs bien estructurados.
- **Custom via Lambda**: escribes tu propia función de chunking.

Además, KB soporta **Foundation Model Parsing** (usar Claude o Nova para parsear PDFs complejos con tablas, imágenes, esquemas) para docs difíciles.

### 3.2 Bedrock Agents

Bedrock Agents es un orquestador managed para flujos con tools y knowledge. Anatomía:

- **Instruction**: system prompt del agente (rol, comportamiento).
- **Action Groups**: tools invocables (Lambda con OpenAPI spec, o Return of Control para ejecutar en tu app).
- **Knowledge Bases**: RAG integrado (opcional).
- **Prompt override templates**: personalizas prompts internos si necesitas.
- **Session state**: memoria multi-turn.
- **Multi-agent collaboration** (GA 2024): un supervisor delega a sub-agentes especializados.

Trade-offs frente a LangGraph / CrewAI / código custom:

| Aspecto | Bedrock Agents | LangGraph / Custom |
|---|---|---|
| Setup | Declarativo, IAM/Guardrails nativos | Código completo |
| Control fino de prompts internos | Limitado (override templates) | Total |
| Multi-agent | Sí (2024) | Sí, más flexible |
| Portabilidad | Lock-in AWS | Cross-cloud |
| Streaming, tool use avanzado | Nuevos features 2024-2025 cierran gap | Ya tenía todo |

Regla: si tu stack ya está en AWS y la orquestación es "estándar" (planificar, llamar tools, consultar KB), Bedrock Agents cierra el 80% del trabajo. Para grafos complejos con branching custom, sigue ganando LangGraph.

### 3.3 Cross-region inference profiles

Antes de 2024, si Claude 3.5 Sonnet en `us-east-1` estaba throttled, tu request fallaba. Los **inference profiles** de 2024-2025 enrutan entre regiones geográficamente relacionadas:

- `us.anthropic.claude-sonnet-4-5-v1:0` (us-east-1 + us-west-2 + us-east-2)
- `eu.anthropic.claude-sonnet-4-5-v1:0` (eu-west-1 + eu-central-1 + eu-west-3)
- `apac.anthropic.claude-sonnet-4-5-v1:0` (ap-northeast-1 + ap-south-1 + ap-southeast-1)
- `global.anthropic.claude-sonnet-4-5-v1:0` (todas las regiones habilitadas, septiembre 2025)

Beneficios:

- Cuotas efectivas mayores (suma entre regiones del profile).
- Menos throttling en picos.
- Mismo pricing que on-demand regional.

Trade-off crítico: **data residency**. Con `us.*`, los datos pueden procesarse en cualquier región US del profile. Si tu compliance exige región específica, usa modelId regional puro (`anthropic.claude-...` sin prefijo) y acepta las cuotas menores.

Configuración IAM correcta:

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  "Resource": [
    "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-v1:0",
    "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5-v1:0",
    "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-5-v1:0",
    "arn:aws:bedrock:us-east-1:*:inference-profile/us.anthropic.claude-sonnet-4-5-v1:0"
  ]
}
```

### 3.4 Provisioned Throughput vs on-demand: break-even

**On-demand** es pay-per-token con throttling regional. **Provisioned Throughput** compra Model Units (MU), cada uno con throughput fijo (tokens/segundo variables por modelo), con commitment de 1 o 6 meses (6 más barato). SLA de disponibilidad, sin throttling dentro del MU.

Break-even mental:

```
coste_on_demand   = precio_por_MTok × MTok_por_mes
coste_provisioned = 730h × precio_por_MU_hora × n_MUs

Break-even cuando utilización sostenida >60-70% del MU capacity.
```

Ejemplo indicativo (verificar precios actuales, cambian):

- Claude Sonnet 4.5 on-demand: ~$3 in / $15 out por MTok.
- 1 MU (1 mes commitment): ~$32/hora (~$23k/mes).
- Break-even aproximado: >5-8M tokens/día sostenidos.

Patrón híbrido común: **Provisioned para el baseline predecible + cross-region on-demand para bursts.**

### 3.5 SageMaker endpoints: matriz de 4 tipos

| Tipo | Cuándo | Coste | Latencia | Límite |
|---|---|---|---|---|
| **Real-time** | Chat sync always-on | $/instancia-hora | Baja | <60s por request |
| **Serverless Inference** | Tráfico esporádico | Per request + cold start | Media | Modelo <10 GB |
| **Async Inference** | Requests largos, input grande | $/instancia-hora | Encolado, resp en S3 | Hasta 1h, input ~1 GB |
| **Batch Transform** | Dataset completo offline | $/instancia-hora del job | N/A (job) | Sin endpoint persistente |

Para LLMs grandes (Llama 70B+) casi siempre Real-time con GPU. **Multi-Model Endpoints** y **Multi-Container Endpoints** permiten compartir instancia entre modelos. **Inference Recommender** ayuda al right-sizing automático.

### 3.6 SageMaker JumpStart y HyperPod

**JumpStart** es el catálogo de modelos pre-empaquetados dentro de SageMaker: eliges Llama-3.1-70B, click "Deploy" y obtienes endpoint con container correcto (HF TGI, DJL Serving, vLLM), instancia recomendada, artefactos. Ideal para prototipar sin escribir Dockerfile. Fine-tune también con 1-click.

**HyperPod** es el cluster managed persistente para training de largo aliento (días o semanas):

- Instancias P4d, P5, P5e (H100), P5en, y Trn1/Trn2 (Trainium).
- **Auto-recovery**: detecta fallo de nodo → replace automático → resume desde checkpoint.
- **HyperPod EKS** (2024): la variante corriendo sobre Kubernetes, con recipes probadas para Llama, Mistral training.
- Slurm alternativa clásica.
- **Task governance** (2024): compartir cluster entre teams con quotas.
- Networking EFA + storage FSx for Lustre.

Sin HyperPod, un training run de 2 semanas en 64 nodos H100 sufre inevitablemente fallos y hay que reiniciar manualmente. HyperPod convierte eso en operación normal.

### 3.7 Auto-hosting con vLLM en EKS

**vLLM** (UC Berkeley, 2023) es el motor open estándar para servir LLMs con throughput alto. Trucos clave:

- **PagedAttention**: gestión de KV cache paginada (analogía con virtual memory) que elimina la fragmentación y permite batching dinámico eficiente.
- **Continuous batching**: nuevos requests entran mientras otros generan tokens, mantiene GPU saturada.
- **Chunked prefill** (default en vLLM V1): parte prefills largos en chunks pequeños para intercalar con decode, mejorando latencia p99.
- **Prefix caching**: prompts con prefijos comunes (system prompts) reutilizan KV cache.
- **Tensor + pipeline parallelism** para modelos que no caben en 1 GPU.
- **Quantization**: AWQ, GPTQ, FP8, INT8.
- **Multi-LoRA hot-swap**.
- **API OpenAI-compatible**: puedes reemplazar client OpenAI apuntando a tu endpoint vLLM.

Ejemplo de deploy en EKS:

```yaml
# vllm-llama3-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-llama3-70b
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vllm-llama3-70b
  template:
    metadata:
      labels:
        app: vllm-llama3-70b
    spec:
      nodeSelector:
        node.kubernetes.io/instance-type: p5.48xlarge
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.7.3
          args:
            - "--model=meta-llama/Meta-Llama-3.3-70B-Instruct"
            - "--tensor-parallel-size=8"
            - "--enable-prefix-caching"
            - "--enable-chunked-prefill"
            - "--max-model-len=32768"
            - "--dtype=bfloat16"
            - "--api-key=$(VLLM_API_KEY)"
          ports:
            - containerPort: 8000
          resources:
            limits:
              nvidia.com/gpu: 8
              memory: "600Gi"
          env:
            - name: HUGGING_FACE_HUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: hf-token
                  key: token
            - name: VLLM_API_KEY
              valueFrom:
                secretKeyRef:
                  name: vllm-api-key
                  key: key
```

Alternativas: **TensorRT-LLM** (NVIDIA, mejor performance en H100 con setup complejo), **TGI** (HuggingFace, alternativa madura), **SGLang** (RadixAttention), **LMDeploy** (Shanghai AI Lab), **Ollama** (dev local, no prod).

### 3.8 Inferentia, Trainium, EKS + Karpenter

**Inferentia2** (Inf2) instancias para inferencia: Inf2.xlarge (1 chip, 32 GB HBM), hasta Inf2.48xlarge (12 chips, 384 GB). Buena disponibilidad y ~40-50% ahorro vs H100 equivalente cuando el modelo compila con Neuron SDK.

**Trainium2** (Trn2) instancias para training: Trn2.48xlarge (16 chips, ~1.3 TB HBM), y **Trn2 UltraServer** (64 chips) anunciada en re:Invent 2024. **Project Rainier** es el mega-cluster de Trainium2 dedicado a Anthropic para el entrenamiento de futuras generaciones de Claude.

Neuron SDK: `torch_neuronx` compila modelos PyTorch para Neuron. `transformers-neuronx` optimiza LLMs específicos. La lista de modelos soportados crece cada trimestre (Llama, Mistral, Qwen, DeepSeek, Stable Diffusion, muchos otros).

**EKS + Karpenter** para GPU:

```yaml
# karpenter-gpu-nodepool.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu-flexible
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["p5", "p5e", "p4de", "g6e", "g5"]
        - key: karpenter.k8s.aws/instance-gpu-count
          operator: In
          values: ["4", "8"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: topology.kubernetes.io/zone
          operator: In
          values: ["us-east-1a", "us-east-1b", "us-east-1c", "us-east-1d"]
      taints:
        - key: nvidia.com/gpu
          effect: NoSchedule
  limits:
    cpu: 10000
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
```

Karpenter elige el instance type más barato que satisfaga los requisitos del pod y hace consolidation cuando hay capacidad ociosa. Fundamental para GPUs escasas.

### 3.9 Bajo el capó — cómo Bedrock enruta tu request

Cuando invocas Bedrock, el request atraviesa una arquitectura managed compleja. Entenderla ayuda a diagnosticar latencia y coste.

**Frontend (regional API endpoint).** Cada región tiene un endpoint público (`bedrock-runtime.us-east-1.amazonaws.com`) y opcionalmente uno privado via VPC endpoint. Detrás hay una fleet de proxies HTTP/2 que validan SigV4, hacen IAM authz, y aplican rate limiting por account.

**Routing layer.** Si tu `modelId` es un inference profile (`us.anthropic.claude-...`), el layer consulta capacity en cada región del profile y enruta a la mejor. Si es un modelId regional puro (`anthropic.claude-...`), va directo. El routing es "sticky" por breve tiempo para maximizar cache hits regionales (importante para prompt caching).

**Model serving fleet.** Cada modelo corre en clusters dedicados de GPUs (H100, H200, Trn2 según modelo). Anthropic y otros vendors operan sus modelos como Bedrock-hosted; AWS opera Nova y Titan en su propia infra. Los clusters usan vLLM / TensorRT-LLM / motor propio según vendor.

**Cross-region inference.** Cuando `us-east-1` está en throttling, el routing layer redirecciona el request a `us-west-2` o `us-east-2` transparente. El coste se factura al account (no a la región de destino). Data residency: los tokens pueden procesarse en cualquier región del profile, así que apps con GDPR estricto deben usar `eu.*` o modelId regional puro.

**Guardrails pipeline.** Si configurado, se aplican filtros pre-inferencia (denied topics, PII detection en input) y/o post (content filter en output). Cada filter añade 20-100ms de latencia. Los `Automated Reasoning checks` (GA agosto 2025) usan una capa aparte con solvers formales — pueden añadir 100-500ms.

**Provisioned Throughput** funciona reservando **Model Units** — capacity dedicada dentro del cluster del modelo. Un MU garantiza X TPS y Y max concurrent requests. Precio: fixed hourly, independiente del uso. Break-even: >60-70% utilización sostenida durante el commit (1 o 6 meses).

**Model Invocation Logging.** Opcional. Si activado, `input` + `output` + `usage` van a CloudWatch Logs o S3 en 5-30s. Útil para auditoría/debug; peligroso para PII sin sampling + filtering. En prod suele activarse con sampling 1-5%.

**Model access request.** Antes de que tu account pueda usar un modelo (Claude, Nova, etc), debes solicitar acceso manual en la Console. Este es un check de AWS (compliance, use case validation) además del IAM. Sin approval, `AccessDeniedException` con mensaje distinto al de IAM insuficiente.

### 3.10 Comparativa exhaustiva pricing Bedrock (agosto 2026)

| Modelo | Input $/MTok | Output $/MTok | Provisioned MU $/h | TPS típico | Ctx |
|---|---:|---:|---:|---:|---:|
| Claude Opus 4.7 | 5.00 | 25.00 | ~$60 | 55-80 | 1M |
| Claude Sonnet 4.6 | 3.00 | 15.00 | ~$32 | 80-120 | 1M |
| Claude Haiku 4.5 | 1.00 | 5.00 | ~$14 | 130-180 | 400K |
| Amazon Nova Pro | 0.80 | 3.20 | ~$18 | 90-130 | 300K |
| Amazon Nova Lite | 0.06 | 0.24 | ~$4 | 180-260 | 300K |
| Amazon Nova Micro | 0.035 | 0.14 | ~$2 | 250-350 | 128K |
| Meta Llama 3.3-70B | 0.72 | 0.72 | ~$21 | 40-80 | 128K |
| Mistral Large 2 | 2.00 | 6.00 | ~$25 | 60-90 | 128K |
| Cohere Command R+ | 2.50 | 10.00 | ~$28 | 70-100 | 128K |
| Amazon Titan Embed v2 | 0.02 | — | ~$1 | 5000+ chars/s | 8K |

*Verificar precios actuales; cambian trimestralmente. MU rates son aproximaciones para 1-mo commitment.*

### 3.11 Ejemplo avanzado — Bedrock Agent con multi-KB, tools y session state

Ejemplo de un agente de soporte que consulta 2 knowledge bases (docs producto + FAQs), llama a tool Lambda para verificar estado del pedido, y mantiene session state entre turnos:

```python
# bedrock_agent_invoke.py — cliente completo de Bedrock Agent
import boto3, uuid, json

runtime = boto3.client("bedrock-agent-runtime", region_name="us-east-1")

AGENT_ID       = "AGENTID12"
AGENT_ALIAS_ID = "ALIAS1234"
SESSION_ID     = str(uuid.uuid4())    # persiste multi-turn state

def ask_agent(user_input: str, session_id: str = SESSION_ID) -> dict:
    resp = runtime.invoke_agent(
        agentId=AGENT_ID,
        agentAliasId=AGENT_ALIAS_ID,
        sessionId=session_id,
        enableTrace=True,                # trazas de razonamiento del agente
        inputText=user_input,
        sessionState={                    # inject contexto adicional
            "sessionAttributes": {"customer_tier": "gold", "region": "EU"},
            "promptSessionAttributes": {"idioma": "es"},
        },
    )

    # invoke_agent devuelve un EventStream — hay que consumir chunks
    output_text = ""
    citations = []
    trace_events = []
    for event in resp["completion"]:
        if "chunk" in event:
            output_text += event["chunk"]["bytes"].decode("utf-8")
            for c in event["chunk"].get("attribution", {}).get("citations", []):
                citations.append(c)
        if "trace" in event:
            trace_events.append(event["trace"])

    return {"text": output_text, "citations": citations, "trace": trace_events}

# Turn 1
r1 = ask_agent("¿Cuál es el estado de mi pedido #12345?")
print("Turn 1:", r1["text"])

# Turn 2 (mismo session, agente recuerda contexto)
r2 = ask_agent("¿Y cuándo llegará?")
print("Turn 2:", r2["text"])
```

Configuración del agente (via `bedrockagent` client o Terraform):
- **Instruction:** system prompt del agente.
- **Action groups:** 1+ Lambda con OpenAPI spec + Return-of-Control opcional.
- **Knowledge bases:** IDs de las KBs a consultar.
- **Prompt override templates:** personaliza el prompt interno de orchestration/RAG/tool use.

Trade-off vs LangGraph custom: menos control fino, pero cero ops de orchestration.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 PrivateLink para Bedrock (VPC Endpoint)

Para que Bedrock nunca cruce Internet, se crean VPC Endpoints (Interface Endpoints) por servicio:

- `com.amazonaws.<region>.bedrock` (control plane)
- `com.amazonaws.<region>.bedrock-runtime` (inference)
- `com.amazonaws.<region>.bedrock-agent-runtime` (agents)
- `com.amazonaws.<region>.bedrock-agent` (agent management)

```hcl
# terraform: VPC endpoint para bedrock-runtime
resource "aws_vpc_endpoint" "bedrock_runtime" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.bedrock_endpoint.id]
  private_dns_enabled = true
  tags = { Name = "bedrock-runtime-endpoint" }
}
```

Y una IAM policy que **exige** el uso del endpoint:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "bedrock:InvokeModel",
    "Resource": "arn:aws:bedrock:us-east-1::foundation-model/anthropic.*",
    "Condition": {
      "StringEquals": {
        "aws:SourceVpce": "vpce-0abcdef1234567890"
      }
    }
  }]
}
```

Complementa con SCP a nivel de Organización para prohibir Bedrock desde fuera del endpoint globalmente.

### 4.2 IAM least privilege para Bedrock

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSonnetOnly",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:us-*::foundation-model/anthropic.claude-sonnet-4-5*",
        "arn:aws:bedrock:us-east-1:*:inference-profile/us.anthropic.claude-sonnet-4-5*"
      ]
    },
    {
      "Sid": "DenyModelCustomization",
      "Effect": "Deny",
      "Action": [
        "bedrock:CreateModelCustomizationJob",
        "bedrock:DeleteFoundationModelAgreement",
        "bedrock:PutFoundationModelEntitlement"
      ],
      "Resource": "*"
    }
  ]
}
```

Anti-patrón: `bedrock:*` con `Resource: "*"` da acceso a todos los modelos, admin, custom models. Fuera de sandboxes, nunca.

### 4.3 Observabilidad LLM en Bedrock

El stack recomendado en 2026:

1. **CloudWatch Metrics** (namespace `AWS/Bedrock`): `Invocations`, `InvocationLatency`, `InputTokenCount`, `OutputTokenCount`, `InvocationClientErrors`, `InvocationServerErrors` por modelo.
2. **Model Invocation Logging** (opcional): inputs/outputs completos a S3 o CloudWatch Logs. Útil para debugging y compliance; peligroso para PII sin control.
3. **X-Ray**: distributed tracing.
4. **CloudWatch Alarms** sobre error rate, latencia p95/p99, coste por 1k invocaciones.
5. **Capa LLM-específica**: **Langfuse**, **Helicone**, **Datadog LLM Observability**, **Braintrust**, **Weave** para atribución por feature/tenant/user, evaluaciones online, trazas prompt→response con costs.
6. **OpenTelemetry GenAI conventions**: spec estándar para instrumentar cross-vendor.

### 4.4 Break-even auto-host vs Bedrock

Modelo de costes simplificado para Llama 3.3-70B:

```
Bedrock on-demand:  $X/MTok × MTok_mes
Auto-host (EKS):    $Y/hora × 730h × n_replicas × factor_utilización
                    + ~$Z/mes ops (SRE 0.2 FTE + security review + capacity planning)
```

Reglas empíricas 2026:

- <10M tokens/día → Bedrock casi seguro gana.
- 10-100M tokens/día → depende de utilización real y capacidad ops.
- >100M tokens/día sostenido → self-hosting suele ganar si tienes MLOps.
- Modelos NO en catálogo → self-host o Bedrock Custom Model Import.
- Compliance/latencia especial → decisión caso a caso.

Nunca ignores el **coste del engineering time**: mantener EKS + vLLM + observability puede costar 1-3 SREs/MLOps, cuyo salario puede exceder el ahorro de infra.

### 4.5 Anti-patrones frecuentes

| ❌ Antipatrón | ✅ Alternativa |
|---|---|
| Montar SageMaker Endpoint para servir Claude | Bedrock (managed, cero ops) |
| Usar Bedrock para modelo custom no soportado | SageMaker o Bedrock Custom Model Import |
| `bedrock:*` con `Resource: "*"` | Least privilege por modelo ARN |
| Sin cross-region inference profile | Usar `us.*` / `eu.*` para saltar throttling |
| Fixed nodegroup GPU sin autoscaling | Karpenter con instance types flexibles |
| CloudWatch Metrics como única observabilidad | + Langfuse/Datadog LLM Obs para atribución |
| Provisioned Throughput sin medir utilización | Empezar on-demand + cross-region, migrar si sostenido |
| HF Transformers naïve para servir LLM en prod | vLLM/TGI/TensorRT-LLM (5-20× throughput) |
| Ignorar quota H100 y esperar disponibilidad | Capacity Blocks / Reservations con antelación |
| Data en logs sin filtrado PII | Bedrock Guardrails PII + logging sampling |

### 4.6 GPU quotas y Capacity Blocks

Realidad 2023-2026: H100/A100 son escasas. AWS gestiona con:

- **Service Quotas** por instance family (default 0 para cuentas nuevas). Solicitar aumento con lead time (días a semanas).
- **On-Demand Capacity Reservations**: reservas capacidad sin descuento.
- **Savings Plans / RIs**: descuento a cambio de commitment 1-3 años.
- **EC2 Capacity Blocks for ML** (re:Invent 2023): reservas de 1-14 días con antelación para training runs.
- **Multi-region strategy**: `us-west-2`, `us-east-2`, `eu-west-1` suelen tener mejor disponibilidad que `us-east-1`.
- **Alternatives**: Inferentia/Trainium (mejor disponibilidad), Bedrock (elimina el problema).

---

## 5. Ejemplo práctico completo: Bedrock Knowledge Base con Aurora pgvector (Terraform + Python)

Objetivo: montar RAG managed sobre docs en S3 con Bedrock KB + Aurora Serverless v2 (PostgreSQL con pgvector), y ejecutar `RetrieveAndGenerate`.

**Parte 1: Terraform (infra).**

```hcl
# providers.tf
terraform {
  required_version = ">= 1.7"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
}
provider "aws" { region = var.region }

variable "region"           { default = "us-east-1" }
variable "kb_name"          { default = "docs-kb" }
variable "s3_bucket_docs"   {}
variable "aurora_password"  { sensitive = true }

# 1) Aurora Serverless v2 (PostgreSQL 16) con pgvector
resource "aws_rds_cluster" "kb" {
  cluster_identifier          = "bedrock-kb-cluster"
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned"
  engine_version              = "16.4"
  database_name               = "bedrockkb"
  master_username             = "kbadmin"
  master_password             = var.aurora_password
  skip_final_snapshot         = true
  storage_encrypted           = true
  enable_http_endpoint        = true       # Data API para KB
  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 8
  }
}

resource "aws_rds_cluster_instance" "kb" {
  identifier          = "bedrock-kb-instance"
  cluster_identifier  = aws_rds_cluster.kb.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.kb.engine
  engine_version      = aws_rds_cluster.kb.engine_version
}

# 2) Secret para credenciales (Bedrock KB lo requiere)
resource "aws_secretsmanager_secret" "aurora" {
  name = "bedrock-kb-aurora-creds"
}
resource "aws_secretsmanager_secret_version" "aurora" {
  secret_id = aws_secretsmanager_secret.aurora.id
  secret_string = jsonencode({
    username = "kbadmin",
    password = var.aurora_password
  })
}

# 3) IAM role para el KB
data "aws_iam_policy_document" "kb_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "kb" {
  name               = "bedrock-kb-role"
  assume_role_policy = data.aws_iam_policy_document.kb_trust.json
}

resource "aws_iam_role_policy" "kb" {
  role = aws_iam_role.kb.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = "arn:aws:bedrock:${var.region}::foundation-model/amazon.titan-embed-text-v2:0"
      },
      {
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::${var.s3_bucket_docs}",
          "arn:aws:s3:::${var.s3_bucket_docs}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "rds-data:ExecuteStatement",
          "rds-data:BatchExecuteStatement"
        ]
        Resource = aws_rds_cluster.kb.arn
      },
      {
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.aurora.arn
      }
    ]
  })
}

# 4) Knowledge Base
resource "aws_bedrockagent_knowledge_base" "docs" {
  name     = var.kb_name
  role_arn = aws_iam_role.kb.arn
  knowledge_base_configuration {
    type = "VECTOR"
    vector_knowledge_base_configuration {
      embedding_model_arn = "arn:aws:bedrock:${var.region}::foundation-model/amazon.titan-embed-text-v2:0"
    }
  }
  storage_configuration {
    type = "RDS"
    rds_configuration {
      resource_arn           = aws_rds_cluster.kb.arn
      credentials_secret_arn = aws_secretsmanager_secret.aurora.arn
      database_name          = "bedrockkb"
      table_name             = "bedrock_integration.kb_docs"
      field_mapping {
        primary_key_field = "id"
        vector_field      = "embedding"
        text_field        = "chunks"
        metadata_field    = "metadata"
      }
    }
  }
}

# 5) DataSource S3
resource "aws_bedrockagent_data_source" "s3" {
  name              = "s3-docs-source"
  knowledge_base_id = aws_bedrockagent_knowledge_base.docs.id
  data_source_configuration {
    type = "S3"
    s3_configuration {
      bucket_arn = "arn:aws:s3:::${var.s3_bucket_docs}"
    }
  }
  vector_ingestion_configuration {
    chunking_configuration {
      chunking_strategy = "HIERARCHICAL"
      hierarchical_chunking_configuration {
        overlap_tokens = 60
        level_configurations {
          max_tokens = 1500
        }
        level_configurations {
          max_tokens = 300
        }
      }
    }
  }
}

output "kb_id" { value = aws_bedrockagent_knowledge_base.docs.id }
```

Antes de aplicar, hay que crear el schema pgvector una vez en Aurora:

```sql
-- ejecutar via psql o RDS Data API
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA bedrock_integration;
CREATE TABLE bedrock_integration.kb_docs (
    id         uuid PRIMARY KEY,
    embedding  vector(1024),           -- titan-embed-text-v2 = 1024 dims
    chunks     text,
    metadata   json
);
CREATE INDEX ON bedrock_integration.kb_docs
    USING hnsw (embedding vector_cosine_ops);
```

**Parte 2: Ingest y query desde Python.**

```python
# rag_bedrock_kb.py
import boto3, time

REGION = "us-east-1"
KB_ID = "XXXXXXXX"    # output de terraform
DS_ID = "YYYYYYYY"    # aws bedrock-agent list-data-sources
MODEL = "us.anthropic.claude-sonnet-4-5-v1:0"

agent = boto3.client("bedrock-agent", region_name=REGION)
runtime = boto3.client("bedrock-agent-runtime", region_name=REGION)

# 1) Lanzar ingestion job (parsea S3, chunkea, embebe, indexa)
job = agent.start_ingestion_job(knowledgeBaseId=KB_ID, dataSourceId=DS_ID)
job_id = job["ingestionJob"]["ingestionJobId"]
print(f"Ingestion job: {job_id}")

# 2) Polling hasta completion
while True:
    st = agent.get_ingestion_job(
        knowledgeBaseId=KB_ID, dataSourceId=DS_ID, ingestionJobId=job_id
    )["ingestionJob"]["status"]
    print(f"  status: {st}")
    if st in ("COMPLETE", "FAILED"):
        break
    time.sleep(15)

# 3) RetrieveAndGenerate: KB hace RAG + LLM en una llamada
resp = runtime.retrieve_and_generate(
    input={"text": "¿Cuál es la política de reembolsos para pedidos internacionales?"},
    retrieveAndGenerateConfiguration={
        "type": "KNOWLEDGE_BASE",
        "knowledgeBaseConfiguration": {
            "knowledgeBaseId": KB_ID,
            "modelArn": f"arn:aws:bedrock:{REGION}::inference-profile/{MODEL}",
            "retrievalConfiguration": {
                "vectorSearchConfiguration": {
                    "numberOfResults": 8,
                    "overrideSearchType": "HYBRID"     # dense + sparse cuando el store lo soporta
                }
            },
            "generationConfiguration": {
                "inferenceConfig": {
                    "textInferenceConfig": {
                        "maxTokens": 800, "temperature": 0.2, "topP": 0.9
                    }
                },
                "promptTemplate": {
                    "textPromptTemplate": (
                        "Eres un asistente que responde SOLO con base en el contexto. "
                        "Si el contexto no contiene la respuesta, di literalmente "
                        "'No encontrado en la documentación'. Cita los fragmentos.\n\n"
                        "Contexto:\n$search_results$\n\nPregunta: $query$"
                    )
                }
            }
        }
    },
)

print("\nRespuesta:", resp["output"]["text"])
print("\nCitations:")
for c in resp.get("citations", []):
    for ref in c.get("retrievedReferences", []):
        print(" -", ref["location"], "→", ref["content"]["text"][:120], "...")
```

**Notas prácticas:**

- El ingestion job tarda minutos a horas según volumen de S3.
- Cada re-ingest solo procesa docs nuevos/cambiados (KB detecta hashes).
- Titan Embeddings v2 tiene 1024 dims por default (configurables a 512 o 256 para bajar coste).
- Aurora Serverless v2 con capacidad mínima 0.5 ACU tiene coste base ~$40/mes; considerar OpenSearch Serverless si no quieres esa capacidad ociosa.
- Para custom parsing de PDFs complejos, activa **Foundation Model Parsing** en el data source config.

### 5.1 Por qué cada decisión — narrativa

- **Por qué Aurora Serverless v2 y no OpenSearch Serverless:** OpenSearch baseline es ~$700/mes ocioso; Aurora Serverless v2 con `min_capacity=0.5` es ~$40/mes ocioso. Para PoCs y corpus <1M vectores, Aurora gana. Para escala (>10M vectores, hybrid search, alta concurrencia), OpenSearch es superior.
- **Por qué HIERARCHICAL chunking en lugar de FIXED:** hierarchical produce chunks pequeños (300 tokens) para retrieval preciso, pero al hacer match expande a parent chunks (1500 tokens) para dar contexto al LLM. Mejor recall + mejor grounding vs FIXED.
- **Por qué Titan Embeddings v2 y no Cohere:** Titan v2 tiene 1024 dims default (configurable a 512 o 256 para reducir coste de storage/query). Sin salir de AWS: latencia menor, no cross-account IAM.
- **Por qué `enable_http_endpoint = true` (Data API):** Bedrock KB requiere Aurora Data API para query, no puede usar TCP directo. Sin este flag, la creación del KB falla con error críptico.
- **Por qué IAM role separado para el KB:** Bedrock asume este rol para: leer S3, invocar Titan Embed, escribir/leer Aurora, leer Secrets. Least-privilege: no le des `bedrock:*` ni `s3:*`.

### 5.2 Manejo de errores en el ingest job

Un ingest job puede fallar por múltiples causas. Manejo robusto:

```python
def ingest_and_wait(kb_id: str, ds_id: str, timeout_sec: int = 3600) -> dict:
    """Lanza ingest, espera, propaga errores útiles."""
    start = agent.start_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id)
    job_id = start["ingestionJob"]["ingestionJobId"]
    deadline = time.time() + timeout_sec

    while time.time() < deadline:
        job = agent.get_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id, ingestionJobId=job_id)["ingestionJob"]
        status = job["status"]
        stats = job.get("statistics", {})
        print(f"[{status}] scanned={stats.get('numberOfDocumentsScanned', 0)} "
              f"indexed={stats.get('numberOfNewDocumentsIndexed', 0)} "
              f"failed={stats.get('numberOfDocumentsFailed', 0)}")

        if status == "COMPLETE":
            if stats.get("numberOfDocumentsFailed", 0) > 0:
                print(f"[WARN] {stats['numberOfDocumentsFailed']} docs fallaron; ver failure reasons")
            return job
        if status == "FAILED":
            # failureReasons expone causa: PDF corrupto, embedding quota, permisos
            raise RuntimeError(f"Ingest FAILED: {job.get('failureReasons')}")
        time.sleep(15)
    raise TimeoutError(f"Ingest didn't complete in {timeout_sec}s")
```

Errores más comunes:
- `ACCESS_DENIED` al S3 → IAM role del KB no tiene `s3:GetObject` sobre el bucket.
- `THROTTLING` sobre Titan Embed → sube quota o reduce paralelismo de ingest.
- `INTERNAL_SERVER_ERROR` con documentos individuales → PDF corrupto, imagen sin OCR, etc. Ver `failureReasons` por doc.
- Aurora `TABLE_NOT_FOUND` → falta crear `bedrock_integration.kb_docs` con schema exacto.

### 5.3 Verificación intermedia — smoke tests post-deploy

```bash
# 1) Comprobar KB status
aws bedrock-agent get-knowledge-base --knowledge-base-id $KB_ID \
  --query 'knowledgeBase.status'  # esperado: ACTIVE

# 2) Comprobar tabla poblada
psql -h $AURORA_HOST -U kbadmin -d bedrockkb -c \
  "SELECT COUNT(*), MAX(LENGTH(chunks)) FROM bedrock_integration.kb_docs;"
# esperado: count > 0, chunks razonables (~300-1500 chars)

# 3) Retrieve directo (sin generate) — verifica que la búsqueda funciona
aws bedrock-agent-runtime retrieve \
  --knowledge-base-id $KB_ID \
  --retrieval-query '{"text":"política de reembolsos"}' \
  --retrieval-configuration '{"vectorSearchConfiguration":{"numberOfResults":5}}'

# 4) RetrieveAndGenerate end-to-end
aws bedrock-agent-runtime retrieve-and-generate \
  --input '{"text":"¿cuál es la política de reembolsos internacional?"}' \
  --retrieve-and-generate-configuration file://config.json
```

Sin los 4 checks, no sabes si el KB está sano.

### 5.4 Extendiendo el ejemplo — 3 mejoras para producción

**Mejora 1: metadata filters para multi-tenancy.** Si tu KB sirve a N clientes, cada chunk lleva `metadata: {tenant_id: "cliente_a"}` y en el query filtras. Sin esto, un cliente ve docs de otro.

```python
resp = runtime.retrieve_and_generate(
    input={"text": query},
    retrieveAndGenerateConfiguration={
        "type": "KNOWLEDGE_BASE",
        "knowledgeBaseConfiguration": {
            "knowledgeBaseId": KB_ID,
            "modelArn": f"arn:aws:bedrock:{REGION}::inference-profile/{MODEL}",
            "retrievalConfiguration": {
                "vectorSearchConfiguration": {
                    "numberOfResults": 8,
                    "filter": {"equals": {"key": "tenant_id", "value": current_tenant}},
                }
            },
        }
    }
)
```

**Mejora 2: Guardrails con contextual grounding.** Añade un guardrail que verifica que la respuesta se sustente en el retrieval; si no, refresa o marca "no encontrado". Reduce alucinaciones drásticamente.

```python
# En retrieveAndGenerateConfiguration, dentro de generationConfiguration:
"guardrailConfiguration": {
    "guardrailId": "kb-grounding-guardrail",
    "guardrailVersion": "1"
}
# El guardrail se configura con contextualGroundingPolicy: {grounding: 0.75, relevance: 0.6}
```

**Mejora 3: Streaming del RetrieveAndGenerate.** La versión síncrona espera hasta la respuesta completa (~3-8s). Streaming (`retrieve_and_generate_stream`) devuelve chunks:

```python
resp = runtime.retrieve_and_generate_stream(input={"text": q}, retrieveAndGenerateConfiguration={...})
for event in resp["stream"]:
    if "output" in event:
        print(event["output"]["text"], end="", flush=True)
    if "citation" in event:
        # Emitir citations al UI progresivamente
        pass
```

UX percibida: TTFT ~800ms en vez de 5s.

---

## 6. Cheatsheet, reglas mentales y anti-patrones

### 6.1 Árbol de decisión rápido

```
¿Necesitas modelo del catálogo Bedrock (Claude/Nova/Llama/Mistral)?
├─ SÍ → Bedrock
│   ├─ RAG? → Bedrock Knowledge Bases
│   ├─ Agent con tools? → Bedrock Agents
│   ├─ Compliance / latencia especial? → PrivateLink + region regional
│   └─ Throttling on-demand? → Cross-region inference profile o Provisioned
└─ NO
    ├─ ¿Modelo fine-tuneado propio de arquitectura soportada?
    │   └─ Bedrock Custom Model Import (Provisioned Throughput)
    ├─ ¿Necesitas training desde cero o fine-tune largo?
    │   └─ SageMaker HyperPod
    ├─ ¿Modelo open-weights, volumen alto sostenido?
    │   └─ EKS + Karpenter + vLLM
    └─ ¿Prototipo rápido con modelo open?
        └─ SageMaker JumpStart (deploy 1-click)
```

### 6.2 Reglas mentales

- **Empieza en Bedrock hasta que tus datos justifiquen migrar.**
- **Usa cross-region inference profiles por defecto** salvo restricción de data residency.
- **IAM least privilege siempre**: por modelo ARN, con Deny explícito de admin.
- **VPC endpoint (PrivateLink) para toda producción**: nunca dejes Bedrock salir por Internet.
- **Guardrails desde el día 1**: safety no se retrofit.
- **Karpenter > Cluster Autoscaler** para GPU workloads en EKS.
- **vLLM > HF Transformers naïve** para servir LLMs en producción (5-20× throughput).
- **Provisioned Throughput solo cuando la utilización sostenida lo justifique** (>60-70%).
- **Trainium/Inferentia son la opción sensible al bolsillo** si tu modelo compila con Neuron.
- **Observabilidad LLM ≠ CloudWatch solo**: añade capa LLM-specific (Langfuse/Datadog LLM Obs).

### 6.3 Anti-patrones ✅/❌

✅ Empezar con Bedrock + cross-region inference profile + PrivateLink.
✅ IAM policy con modelo ARN específico y Deny de admin.
✅ Bedrock Knowledge Bases para RAG estándar corporativo.
✅ Multi-region setup para GPUs escasas.
✅ Capacity Blocks para training programado.
✅ vLLM con `--enable-prefix-caching --enable-chunked-prefill`.
✅ Karpenter con instance types flexibles para GPU.
✅ Guardrails con contextual grounding para KB.
✅ Model Invocation Logging con sampling para bajar coste.
✅ Langfuse/Datadog LLM Obs para atribución por feature/user/tenant.

❌ `bedrock:*` con `Resource: "*"` fuera de sandboxes.
❌ Bedrock sin VPC endpoint en producción regulada.
❌ SageMaker Endpoint para servir Claude (Bedrock lo hace mejor).
❌ Servir Llama-70B con HF Transformers naïve.
❌ Nodegroup GPU fijo sin autoscaling flexible.
❌ Solicitar quota GPU 3 días antes del sprint.
❌ Provisioned Throughput "por si acaso" con utilización <30%.
❌ Ignorar cross-region profiles y sufrir throttling.
❌ Logs completos de invocación sin filtrado PII.
❌ Ignorar TOS y compliance de data residency (`eu.*` vs regional puro).

---

## 7. Casos reales industria 2026

### 7.1 Anthropic + AWS: Project Rainier y Trainium2 UltraServer (2024-2026)
- **Qué pasó:** en re:Invent 2024, AWS y Anthropic anunciaron **Project Rainier**, un mega-cluster de Trainium2 UltraServer (cientos de miles de chips Trn2) dedicado al training de futuras generaciones de Claude. En 2026 se confirmó que parte de Claude 4.7/4.8 se entrenó en este cluster.
- **Cómo se detectó necesidad:** Anthropic requería ~5× la capacity de compute anual para las siguientes generaciones; H100 supply constraints + costes justificaron el commitment.
- **Cómo se arregló:** partnership multi-año, Anthropic invierte ~$4B de crédito AWS + AWS dedica capacity de Trn2 UltraServer.
- **Aprendizaje industrial:** demostración pública más ambiciosa de silicio custom AWS. Confirma que Trainium2 es viable para frontier training (no sólo inferencia barata). La disponibilidad de Trn2 para el resto mejora en 2026; el ecosistema Neuron sigue expandiéndose (más modelos soportados por trimestre).

### 7.2 Coca-Cola FEMSA — Lambda SnapStart 60% ahorro (2025)
- **Qué pasó:** Coca-Cola FEMSA (embotelladora más grande de LatAm) deployó chatbot interno para 100k+ empleados en Lambda; latencia p99 sufría por cold starts (~2-4s con SDK boto3 + boto3 client init).
- **Cómo se detectó:** telemetry de CloudWatch mostraba cold start rate ~15% con TTFT p99 =4.5s.
- **Cómo se arregló:** habilitaron **Lambda SnapStart** (originalmente para Java, extendido a Python en 2025) que hace snapshot del runtime post-init. Cold start bajó a ~150-300ms.
- **Resultado:** TTFT p99 cayó a ~1.5s; coste bajó ~60% (menos concurrent executions para el mismo throughput porque las requests terminan antes).
- **Aprendizaje:** SnapStart es el arreglo dominante 2025-2026 para chatbots Lambda con cold start crítico. Trade-off: snapshots consumen storage; requiere init idempotente.

### 7.3 Perplexity — híbrido Bedrock + self-host (2024-2026)
- **Qué pasó:** Perplexity necesitaba servir billones de queries/año con costes sostenibles.
- **Cómo se arregló:** híbrido — Bedrock (Claude Sonnet/Opus) para queries frontier donde calidad manda; self-hosted vLLM en EKS para Sonar (modelo destilado propio) para volumen search.
- **Aprendizaje:** cada carga en su sitio; ningún vendor único. Patrón "polyglot LLM infra" es el default en apps de escala.

### 7.4 Rocket Mortgage y Kone — Bedrock Knowledge Bases en producción (2024-2025)
- **Qué pasó:** Rocket Mortgage tenía miles de documentos regulatorios/producto que agentes hipotecarios debían consultar en tiempo real; Kone (fabricante de elevadores) tenía manuales técnicos multi-idioma para técnicos de campo.
- **Cómo se arregló:** ambos adoptaron Bedrock Knowledge Bases con OpenSearch Serverless. Chunking hierarchical, embeddings Titan v2, retrieval hybrid con re-ranking. Citations trazables al doc fuente por compliance.
- **Aprendizaje:** Bedrock KB elimina meses de trabajo de RAG custom para casos "estándar" (corpus <100k docs, updates semanales, español + inglés). Fine-tune queda relegado a estilo/tono muy idiosincrático.

### 7.5 Snap y Airbnb — Inferentia2 para ahorro a escala (2024-2026)
- **Qué pasó:** Snap operaba modelos de visión (filters, recommendation) en G5 (NVIDIA A10); coste escalaba superlinealmente con user base.
- **Cómo se detectó:** analysis mostró ~40% ahorro potencial migrando a Inf2 para los modelos que compilan con Neuron.
- **Cómo se arregló:** migración de modelos elegibles a Inf2.xlarge / Inf2.48xlarge. Airbnb migró embeddings (billones/año) a Inf2 con ahorro similar.
- **Aprendizaje:** cuando (a) modelo con arquitectura soportada por Neuron SDK y (b) volumen suficiente para amortizar esfuerzo de compilación (semanas a mes de MLOps), Inferentia gana 40-50% consistentemente.

### 7.6 Deloitte y Vodafone — observabilidad LLM con Datadog + CloudWatch (2025)
- **Qué pasó:** enterprises con Bedrock necesitaban visibilidad por feature/user/tenant, no sólo metrics infra.
- **Cómo se arregló:** stack de dos capas — CloudWatch Metrics + Model Invocation Logging para infra; Datadog LLM Observability (o Langfuse/Braintrust) para atribución por caso de uso.
- **Aprendizaje:** observability LLM ≠ observability infra. Enterprises 2026 operan **dos capas**: AWS-native (billing, quotas, safety) + LLM-specific (feature/user attribution, evals online, trace prompt→response).

---

## 8. Ejercicios prácticos

### 8.1 Ejercicio: llamada mínima a Bedrock desde Python

**Objetivo.** Ejecutar tu primera llamada a Bedrock con Claude o Nova y medir latencia + tokens.

**Setup.**
- AWS account con acceso a Bedrock activado en tu región.
- Model access request aprobado para Anthropic o Amazon Nova.
- Python 3.11+ con `boto3` reciente.

**Pasos.**
1. Configurar credenciales AWS (`aws configure` o env vars).
2. Solicitar model access en la consola (una vez).
3. Escribir el script del §2.2 adaptado a tu región.
4. Ejecutar 20 requests con distintos prompts.
5. Medir latencia (p50, p95) y coste estimado.
6. Probar la misma llamada con cross-region inference profile (`us.*`) y comparar latencia y throttling.

**Criterios de aceptación.**
- [ ] Al menos 20 llamadas exitosas.
- [ ] Latencias registradas y comparadas regional vs profile.
- [ ] Cálculo de coste correcto (input y output tokens).
- [ ] Sin `AccessDeniedException` por model access no solicitado.

**Bonus.** Añadir un Bedrock Guardrail simple (denied topic "invertir en criptomonedas") y verificar que `stopReason == "guardrail_intervened"` cuando aplica.

**Hints:**
- Si obtienes `AccessDeniedException` con mensaje sobre "model access", ve a Console → Bedrock → Model access → Request access.
- Si obtienes `AccessDeniedException` distinto (IAM), verifica que tu principal tenga `bedrock:InvokeModel` con `Resource` matcheando el modelId (incluyendo inference profile ARN si usas `us.*`).
- Cross-region profiles requieren IAM que permita AMBOS: los foundation models regionales Y el inference-profile ARN.

---

### 8.2 Ejercicio: montar Bedrock Knowledge Base con Aurora pgvector

**Objetivo.** Ejecutar end-to-end el §5 con un corpus real propio.

**Setup.**
- Bucket S3 con 20-100 PDFs/MD/HTML de tu dominio.
- Terraform 1.7+.
- Aurora quota disponible.

**Pasos.**
1. Aplicar el Terraform del §5 con tu bucket S3.
2. Crear schema pgvector via RDS Data API.
3. Crear el data source, lanzar ingestion job.
4. Verificar en Aurora que la tabla se pobló.
5. Ejecutar el script Python de `RetrieveAndGenerate` con 5 preguntas de dominio.
6. Comparar respuestas con y sin el promptTemplate custom.

**Criterios de aceptación.**
- [ ] Ingestion job completa en estado COMPLETE.
- [ ] `SELECT COUNT(*) FROM bedrock_integration.kb_docs` > 0.
- [ ] Respuestas incluyen citations con `location` correcto.
- [ ] Prompt "responde solo con contexto" impide alucinación sobre pregunta out-of-domain.

**Bonus.** Añadir metadata filters (por tipo de documento) al request `retrieve_and_generate`.

---

### 8.3 Ejercicio: PrivateLink + IAM least privilege

**Objetivo.** Encapsular Bedrock en tu VPC y forzar IAM least privilege.

**Setup.**
- VPC con subnets privadas.
- Cuenta con Lambda o EC2 en subnets privadas.

**Pasos.**
1. Crear VPC endpoint `com.amazonaws.<region>.bedrock-runtime`.
2. Configurar security group del endpoint (443 desde workloads).
3. Habilitar Private DNS.
4. Adjuntar IAM policy con `aws:SourceVpce` condition.
5. Desde una Lambda en la subnet privada, invocar Claude y verificar que funciona.
6. Desde una máquina fuera del VPC con las mismas credenciales, verificar `AccessDenied`.

**Criterios de aceptación.**
- [ ] Lambda en VPC invoca correctamente.
- [ ] Llamada desde fuera del VPC devuelve error.
- [ ] IAM policy usa Resource específico por modelo.
- [ ] SCP a nivel Organization (bonus).

**Bonus.** Añadir CloudTrail data event para `InvokeModel` y verificar que se registra con `vpcEndpointId`.

---

### 8.4 Ejercicio: deploy vLLM en EKS con Karpenter

**Objetivo.** Servir Llama 3.3-70B en EKS con vLLM y observar throughput vs setup naive.

**Setup.**
- EKS cluster con Karpenter instalado (>=v1).
- HuggingFace token con acceso a Llama.
- Al menos 1 instancia H100/A100 en cuota (p5.48xlarge o p4de.24xlarge).

**Pasos.**
1. Instalar Karpenter y crear NodePool con instance types flexibles (§3.8).
2. Instalar `nvidia-device-plugin` daemonset.
3. Crear Secret con HF token.
4. Aplicar Deployment vLLM del §3.7.
5. Exponer via Service + Ingress.
6. Ejecutar benchmark con `wrk` o `locust`: 100 requests concurrent, mismo prompt.
7. Medir requests/segundo y latencia p99.
8. Repetir con `--enable-prefix-caching --enable-chunked-prefill` desactivados.

**Criterios de aceptación.**
- [ ] Pod vLLM pasa a Ready.
- [ ] Karpenter provisiona el nodo automáticamente.
- [ ] Benchmark con prefix caching muestra ≥30% más throughput que sin él.
- [ ] Métricas Prometheus expuestas.

**Bonus.** Añadir HPA (Horizontal Pod Autoscaler) basado en la métrica `vllm:num_requests_running` y probar burst.

---

### 8.5 Ejercicio: análisis break-even Bedrock vs auto-host

**Objetivo.** Producir un análisis TCO comparativo con tus propias asunciones.

**Setup.**
- Estimación de tokens/día (input y output) para tu app.
- Precios actuales de Bedrock para tu modelo target.
- Precios de instancia p5.48xlarge o p4de en tu región.

**Pasos.**
1. Modelar coste Bedrock on-demand para 3 escalones: 1M, 10M, 100M tokens/día.
2. Modelar coste auto-host EKS + vLLM para los mismos escalones (throughput estimado por p5.48xlarge con Llama-70B: ~1500 tokens/segundo agregados).
3. Añadir coste de ops (0.2-1 SRE FTE según nivel).
4. Añadir riesgo de idle (auto-host paga aunque no uses).
5. Producir gráfico coste mensual vs volumen.
6. Identificar break-even.

**Criterios de aceptación.**
- [ ] Tabla comparativa con 3 escalones.
- [ ] Break-even calculado y justificado.
- [ ] Consideración explícita de ops cost.
- [ ] Recomendación con datos, no "porque sí".

**Bonus.** Repetir con Inferentia2 (Inf2.48xlarge) y comparar los tres caminos.

---

### 8.6 Ejercicio RETO: Terraform Bedrock KB + IAM least privilege + PrivateLink + observability full-stack

**Objetivo.** Producir infra IaC production-ready: Bedrock KB con Aurora pgvector, PrivateLink, IAM least privilege por modelo, guardrails, Model Invocation Logging con sampling, y observability con Langfuse.

**Setup.**
- AWS account con quotas GPU en Aurora Serverless v2 y Titan Embed disponible.
- Terraform 1.7+.
- Langfuse cloud o self-hosted.
- S3 con 50+ docs de tu dominio.

**Pasos:**
1. **Terraform:** aplicar el §5 completo + VPC endpoint `bedrock-runtime` + `bedrock-agent-runtime` + `s3` gateway endpoint + `secretsmanager` interface endpoint.
2. **IAM:** policy explícita con `bedrock:InvokeModel` sólo para `anthropic.claude-sonnet-4-6*` y `anthropic.claude-haiku-4-5*`, con `aws:SourceVpce` condition. Deny explícito de `bedrock:CreateModelCustomizationJob` y otras admin actions.
3. **Guardrails:** crear guardrail con contextual grounding (grounding=0.75, relevance=0.6) + PII redaction (email, phone, credit card).
4. **Model Invocation Logging:** habilitar con 5% sampling a S3 lifecycle-managed (30d hot, 90d IA, delete).
5. **Langfuse:** wrappea las llamadas con `@observe` tags por `feature`, `user_id`, `tenant_id`. Verifica dashboards.
6. **Smoke test:** desde Lambda dentro del VPC, invoca KB con RetrieveAndGenerate. Verifica logs de guardrail, CloudWatch metrics, Langfuse trace.
7. **Negative test:** desde EC2 fuera del VPC con las mismas credenciales, verifica `AccessDenied` por `aws:SourceVpce` condition.

**Criterios:**
- [ ] Terraform aplica sin errores; `terraform plan` idempotent en 2ª ejecución.
- [ ] IAM policy pasa `iam-access-analyzer` sin findings de over-privilege.
- [ ] KB retrieveAndGenerate funciona desde VPC; falla desde fuera con IAM correcto.
- [ ] Guardrail dispara en query out-of-context ("¿cuál es la capital de Marte?" → "No encontrado").
- [ ] PII redaction confirma que emails/teléfonos se redactan en output.
- [ ] Langfuse dashboards muestran: coste por tenant, hit rate del retrieval, latency p99.
- [ ] Model Invocation Logging genera archivos S3 con 5% de las invocaciones (verifica sampling).

**Hints:**
- Combina `aws:SourceVpce` con `aws:PrincipalTag` para forzar que sólo roles específicos usen el endpoint privado.
- Aurora Serverless v2 con `min_capacity: 0.5` sigue costando ~$40/mes ocioso; para producción considera `min_capacity: 1.0` si necesitas latencia predecible.
- Guardrail `contextual grounding` requiere que el KB retrieval devuelva `nRAG chunks`; si el retrieval devuelve 0, siempre "intervenida".

---

## 9. Recursos y siguientes pasos

**Documentación oficial:**
- AWS Bedrock: `https://docs.aws.amazon.com/bedrock/`
- AWS Bedrock — Knowledge Bases: `https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html`
- AWS Bedrock — Agents: `https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html`
- AWS Bedrock — Guardrails: `https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html`
- AWS Bedrock — Cross-region inference: `https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html`
- AWS SageMaker: `https://docs.aws.amazon.com/sagemaker/`
- AWS SageMaker — HyperPod: `https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod.html`
- AWS Neuron SDK: `https://awsdocs-neuron.readthedocs-hosted.com/`
- Karpenter: `https://karpenter.sh`
- vLLM: `https://docs.vllm.ai/`
- TensorRT-LLM: `https://nvidia.github.io/TensorRT-LLM/`
- HuggingFace TGI: `https://github.com/huggingface/text-generation-inference`

**Papers y blogs:**
- PagedAttention (SOSP 2023): "Efficient Memory Management for Large Language Model Serving with PagedAttention".
- AWS re:Invent 2024 keynotes: anuncios de Trainium2 UltraServer, Nova, Bedrock Marketplace.
- AWS Financial Services blog: arquitecturas Bedrock + PrivateLink.
- Anthropic + AWS partnership announcements 2023-2025.

**Herramientas complementarias:**
- **AWS Pricing Calculator** con secciones específicas de Bedrock, SageMaker.
- **AWS Cost Explorer** con filtro por servicio.
- **AWS Trusted Advisor**: chequeos de seguridad y coste.
- **IAM Access Analyzer** para revisar policies.
- **Wiz / Prisma Cloud / Prowler** para auditoría cloud security.
- **Langfuse, Datadog LLM Observability, Braintrust, Weave** para observabilidad LLM.

**Siguientes pasos:**
- [Cap 15 — prompting vs RAG vs fine-tuning](./15-prompting-vs-rag-vs-finetuning.md) — decides qué desplegar aquí.
- [Cap 17 — LLMOps y CI/CD para IA](./18-cli-agents-ci-cd-code-review.md) — pipelines y deploys.
- [Cap 18 — observabilidad LLM](./10-llm-observability-tracing.md) — profundizar la capa 2.
- [Cap 19 — data pipelines, PII, EU AI Act](./19-data-pipelines-pii-eu-ai-act.md) — gobernanza de lo que sirve tu Bedrock/SageMaker.

---

## 10. Preguntas de práctica

Simulacro completo de 20 preguntas con explicaciones, casos reales y referencias:

- JSON del simulacro: `packages/content/src/tech/ai-programming/sim-16-ai-infra-aws-bedrock-sagemaker.json`
- Ruta en la app: `/tech/ai-programming/simulacro/16-ai-infra-aws-bedrock-sagemaker`

Tiempo: 25 min. Pass: 75%. Cubre las áreas de AI infra en AWS y cost/inference.

---

## Navegación

← [Cap 15 — prompting vs RAG vs fine-tuning](./15-prompting-vs-rag-vs-finetuning.md) · [Índice AI programming](./README.md) · [Cap 17 — LLMOps y CI/CD para IA →](./18-cli-agents-ci-cd-code-review.md)
