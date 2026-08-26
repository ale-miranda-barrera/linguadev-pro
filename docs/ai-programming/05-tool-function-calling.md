# Capítulo 05 — Tool / Function calling: schemas, idempotencia y side effects

> **Focus:** Cómo diseñar tools que un LLM llame correctamente: schemas JSON claros, descriptions que guíen al modelo, manejo de errores, idempotencia, side effects, parallel tool calls, structured output vs tools.
> **Áreas:** Agentes y tools · Diseño de APIs para modelos · Seguridad y reliability
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- [Cap 01 — Fundamentos: tokens y contexto](./01-fundamentos-tokens-contexto.md)
- [Cap 04 — Context engineering: memoria y caching](./04-context-memory-caching.md)
- Manejo básico de HTTP y JSON.
- Familiaridad con SDKs de proveedores LLM (Anthropic o OpenAI).

**Glosario mínimo:**
- **Tool / function call:** capacidad del modelo de emitir una llamada estructurada a una función definida por el desarrollador en lugar de responder con texto libre.
- **Tool definition:** metadata que envías al modelo describiendo `name`, `description` y `input_schema` (JSON Schema).
- **tool_use / tool_result:** los dos "content blocks" que viajan en la conversación cuando hay tool calling — el modelo emite `tool_use`, tú respondes con `tool_result`.
- **tool_choice:** parámetro de la API que controla el modo de decisión — `auto`, `required`/`any`, `none`, o específico por nombre.
- **Structured output:** garantía a nivel API de que el output se ajusta a un JSON Schema, sin necesidad de "envolver" en una tool ficticia.
- **Idempotency key:** identificador único por intención que permite reintentar llamadas con side effects sin duplicar.
- **Parallel tool calling:** el modelo emite N tool_use independientes en un mismo turno; tú los ejecutas en paralelo.
- **Side effect:** cualquier acción que muta estado externo (enviar email, cobrar, borrar, hacer POST).

**Setup:**

```bash
# Anthropic SDK (versión estable en agosto 2026)
pip install anthropic==0.121.0

# OpenAI SDK
pip install openai==1.109.0

# Utilidades para el ejemplo del capítulo
pip install pydantic==2.10.0 httpx==0.28.1
```

Variables de entorno:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-proj-...
```

## 1. El gran cuadro

Cuando en 2023 salieron las primeras APIs de function calling (OpenAI, junio 2023), el patrón parecía "un feature más" del LLM. En 2026 es la interfaz principal por la que las apps modernas exponen capacidades al modelo. Todo agente serio — Claude Code, Cursor, Devin, ChatGPT, tu app interna — se construye sobre este primitive: **el modelo decide, en tiempo real, qué función ejecutar y con qué argumentos, dentro de un catálogo que tú definiste**. No es magia — es la extensión natural de generación de texto a "generación de acciones estructuradas".

Por qué importa dominar tool calling en 2026: (1) es el **contrato entre lo determinista (tu código, tus APIs) y lo probabilístico (el LLM)** — todo error de diseño se paga en runtime con bucles, duplicados, o alucinaciones; (2) la calidad de tus tool definitions determina más la accuracy del agente que el modelo elegido — un buen esquema con Haiku puede rendir mejor que un mal esquema con Opus; (3) los proveedores han estandarizado (Anthropic, OpenAI, Google Gemini, Mistral, Groq — todos usan JSON Schema), lo que aprendes es portable; (4) MCP (Cap 06) reutiliza exactamente estos conceptos pero a nivel de protocolo inter-proceso.

Si no lo dominas: escribirás agentes que "casi funcionan" — el modelo llama tools innecesarias, se inventa argumentos, entra en bucles de retry, o gasta tokens en definiciones mal cacheadas. El impacto no es teórico: casos reportados incluyen a Shopify creando 200+ duplicados de tickets por falta de idempotency keys, y equipos gastando cientos de dólares por hora en agentes bucleados. Este capítulo cubre los patrones que separan un agente juguete de uno en producción.

Conexión con lo conocido: si has diseñado APIs REST, ya sabes 80% de esto. Un tool schema es un contrato de API. La description es tu OpenAPI description. tool_choice es como un router. La única diferencia es que el "consumidor" no es un dev humano — es un LLM que interpreta tu contrato en lenguaje natural, por lo que la claridad de la descripción importa 10x más que en una API humana.

## 2. Fundamentos (nivel básico)

### 2.1 Anatomía de una tool definition

Toda tool tiene tres campos obligatorios:

```python
tool = {
    "name": "get_weather",  # snake_case, único por sesión
    "description": (
        "Obtiene el clima ACTUAL de una ciudad. "
        "Úsala cuando el usuario pregunte por temperatura, lluvia, humedad o pronóstico HOY. "
        "NO la uses para pronósticos a >24h (usa `get_forecast` en su lugar). "
        "Devuelve un JSON con temp_c, humidity_pct, conditions."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "city": {
                "type": "string",
                "description": "Nombre de la ciudad en español o inglés, ej: 'Madrid', 'New York'."
            },
            "units": {
                "type": "string",
                "enum": ["celsius", "fahrenheit"],
                "description": "Sistema de unidades para la temperatura."
            }
        },
        "required": ["city"]
    }
}
```

Regla mental: la description es literalmente el prompt de sistema para esa tool. Si un humano nuevo no puede decidir cuándo llamarla leyendo solo la description, el modelo tampoco.

**Analogía útil:** piensa en una tool definition como una **entrada del menú de un restaurante**. El nombre del plato (`get_weather`) es el `name`; la descripción del plato ("hamburguesa de ternera 200g con queso cheddar, no incluye patatas") es la `description`; los checkboxes de personalización (poco hecho / al punto / muy hecho, con o sin cebolla) son el `input_schema` con `enum`. Un menú vago obliga al camarero a preguntar y provoca errores de pedido; un menú claro y completo permite decidir sin ambigüedad. El LLM es tu comensal: lee el menú, elige, y pide con los parámetros correctos.

Compara dos descriptions para la misma tool `search_docs`:

```python
# MAL: 6 palabras, sin contexto
"description": "Busca en la documentación."

# BIEN: 4 líneas con casos POS/NEG y formato de retorno
"description": (
    "Busca en la documentación INTERNA del producto (no en internet). "
    "Úsala cuando el usuario pregunte por endpoints, campos de DB, o APIs propias. "
    "NO la uses para: novedades del mercado, docs de terceros, o preguntas generales. "
    "Devuelve top-5 resultados con {title, url, snippet, score}."
)
```

Con la primera, el modelo la invoca en el 60-70% de los casos donde no aplica; con la segunda, ese ratio cae a <5% en tests empíricos publicados por equipos como Cursor y Sourcegraph.

### 2.2 El loop conversacional con tools

El flujo canónico es:

```
Usuario: "¿Qué clima hace en Madrid?"
   ↓
Modelo: [emite tool_use(name="get_weather", input={"city": "Madrid"})]
   ↓
Tu backend: ejecuta la tool, obtiene {"temp_c": 22, "conditions": "sunny"}
   ↓
Tu backend: envía tool_result al modelo
   ↓
Modelo: "En Madrid hace 22°C y está soleado."
```

Cada turno mantiene TODO el historial. Los `tool_use` y `tool_result` son "content blocks" que viven en la conversación como cualquier otro mensaje.

**Desglose paso a paso** de qué manda cada actor:

1. **Turno 1 (user → API):** solo el mensaje del usuario más el catálogo de tools disponibles.
2. **Turno 2 (API → tú):** el modelo responde con `stop_reason=tool_use` y uno o más content blocks `tool_use` con `id`, `name`, `input`.
3. **Turno 3 (tú → API):** appendeas el mensaje del assistant COMPLETO (con los tool_use) al historial y respondes como `user` con `tool_result` referenciando cada `id`.
4. **Turno 4 (API → tú):** el modelo procesa los resultados y emite texto final (`stop_reason=end_turn`) o más `tool_use` si necesita seguir.

Regla dura: **nunca omitas el mensaje del assistant con los `tool_use` del historial** — la API rechaza el request con `invalid_request_error` porque el `tool_use_id` de tu `tool_result` quedaría huérfano.

### 2.3 Ejemplo mínimo funcionando (Anthropic)

```python
import anthropic

client = anthropic.Anthropic()

tools = [{
    "name": "get_weather",
    "description": "Devuelve el clima actual de una ciudad.",
    "input_schema": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"]
    }
}]

def get_weather(city: str) -> dict:
    # En producción: llamar a API real
    return {"temp_c": 22, "conditions": "sunny", "city": city}

messages = [{"role": "user", "content": "¿Qué tiempo hace en Madrid?"}]

# Primera llamada: el modelo decide usar la tool
response = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    tools=tools,
    messages=messages,
)

# Detectar tool_use en el response
if response.stop_reason == "tool_use":
    tool_use = next(b for b in response.content if b.type == "tool_use")
    result = get_weather(**tool_use.input)

    # Segunda llamada: le devolvemos el resultado
    messages.append({"role": "assistant", "content": response.content})
    messages.append({
        "role": "user",
        "content": [{
            "type": "tool_result",
            "tool_use_id": tool_use.id,
            "content": str(result)
        }]
    })

    final = client.messages.create(
        model="claude-sonnet-4-5-20250929",
        max_tokens=1024,
        tools=tools,
        messages=messages,
    )
    print(final.content[0].text)
```

### 2.4 Enums cierran el dominio, strings libres lo abren

Compara:

```json
{"status": {"type": "string", "description": "pending, shipped, delivered"}}
```

vs

```json
{"status": {"type": "string", "enum": ["pending", "shipped", "delivered"]}}
```

Con la primera, el modelo puede pasar `"Shipped"`, `"in transit"`, `"canceled"` (variante de escritura). Con la segunda, la API valida a nivel de grammar-constrained decoding: si el enum tiene 3 valores, solo esos 3 son posibles. Notion reportó pasar de 8% de errores de retry a <0.5% únicamente añadiendo enums donde el dominio era cerrado. Regla: si el dominio es cerrado, usa enum. Nunca lo confíes a la description.

**Mini-ejemplo funcional** — refresh de un enum sobre estados de pedido:

```python
tool_orders = {
    "name": "update_order_status",
    "description": "Cambia el estado de un pedido existente.",
    "input_schema": {
        "type": "object",
        "properties": {
            "order_id": {"type": "string"},
            "status": {
                "type": "string",
                "enum": ["pending", "paid", "shipped", "delivered", "cancelled"],
                "description": "Estado destino; solo transiciones válidas."
            }
        },
        "required": ["order_id", "status"],
        "additionalProperties": False,
    }
}
# Con este schema el modelo NUNCA emitirá `"status": "Sent"` o `"status": "pagado"`.
```

### 2.5 required vs optional

En JSON Schema, `required` marca campos que DEBEN venir. Combinado con `additionalProperties: false`, previenes que el modelo invente campos no declarados. Es tu primera línea de defensa contra alucinaciones estructurales:

```json
{
    "type": "object",
    "properties": {
        "order_id": {"type": "string"},
        "reason": {"type": "string"}
    },
    "required": ["order_id"],
    "additionalProperties": false
}
```

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 tool_choice: los 4 modos

| Modo | Comportamiento | Latencia extra | Coste output | Cuándo usar |
|---|---|---|---|---|
| `auto` (default) | Modelo decide si llamar tool o responder texto | Ninguna | Base | Chat general, la mayoría de casos |
| `none` | Prohíbe tools — solo texto | −5-10% | Base | Cuando quieres respuesta natural sin acciones |
| `required` / `any` | Fuerza a llamar ALGUNA tool (no específica) | +5-15% | +10-20% | Extractores donde output DEBE ser estructurado |
| `{"type": "tool", "name": "X"}` | Fuerza tool específica por nombre | +5-15% | Similar `any` | Pipelines deterministas, extracción con schema fijo |

Ejemplo forzando tool específica (Anthropic):

```python
response = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    tools=tools,
    tool_choice={"type": "tool", "name": "extract_invoice"},
    messages=[{"role": "user", "content": email_body}],
)
```

Equivalente OpenAI:

```python
response = client.chat.completions.create(
    model="gpt-5-2026-06",
    tools=tools,
    tool_choice={"type": "function", "function": {"name": "extract_invoice"}},
    messages=[...]
)
```

### 3.2 Structured output vs tool call ficticia

Hasta mediados de 2024, si querías JSON estructurado, el truco era definir una tool "save_extraction" y forzarla con tool_choice. Desde OpenAI Structured Outputs (agosto 2024) y el modo equivalente de Anthropic, este truco es anti-patrón: gastas tokens de tool definition y confundes semántica (no hay side effect real).

Regla mental — cuándo usar cada uno:

| Situación | Usa | Coste típico | Madurez API |
|---|---|---|---|
| Extraer/formatear datos sin efecto externo | `response_format: json_schema` (structured output) | Base (sin tool tokens) | GA en OpenAI (2024-08), Anthropic (2025) |
| Ejecutar una acción con side effect | Tool | +150-400 tokens de definición | GA en todos los proveedores desde 2023 |
| Modelo decide entre acción o responder | Tool con `tool_choice: auto` | +150-400 tokens | GA |
| Forzar JSON estricto conforme a schema | Structured output (más barato) | Base | GA |

Ejemplo OpenAI structured output:

```python
from pydantic import BaseModel

class Invoice(BaseModel):
    invoice_id: str
    total_amount: float
    currency: str
    items: list[str]

response = client.chat.completions.parse(
    model="gpt-5-2026-06",
    response_format=Invoice,
    messages=[{"role": "user", "content": email_body}],
)
invoice = response.choices[0].message.parsed  # Invoice type-safe
```

Anthropic soporta structured output con schemas equivalentes y grammar-constrained decoding en Sonnet 4.5+.

### 3.3 Parallel tool calling: qué significa realmente

Desde Claude 3.5 Sonnet y GPT-4-1106, los modelos emiten múltiples `tool_use` en un mismo turno cuando detectan independencia semántica. Ejemplo:

```
Usuario: "Dame el perfil, órdenes y tickets de user 123"
   ↓
Modelo emite en un solo turno:
  - tool_use(get_profile, {user_id: 123})
  - tool_use(get_orders, {user_id: 123})
  - tool_use(get_tickets, {user_id: 123})
```

Tu trabajo: ejecutar los 3 en paralelo (`asyncio.gather`, `Promise.all`, goroutines) y devolver los 3 `tool_result` en un solo mensaje.

```python
import asyncio

async def handle_tool_uses(tool_uses: list) -> list[dict]:
    async def run(tool_use):
        fn = TOOL_REGISTRY[tool_use.name]
        result = await fn(**tool_use.input)
        return {
            "type": "tool_result",
            "tool_use_id": tool_use.id,
            "content": str(result),
        }
    return await asyncio.gather(*(run(t) for t in tool_uses))
```

**Cuidado con dependencias latentes:** si `send_email(to=user.email)` necesita el email de `get_user`, no las emitas en paralelo — el modelo las emite en turnos separados. Si tu tool description es genérica, el modelo puede paralelizarlas incorrectamente; sé explícito: `"Requiere haber obtenido el email vía get_user previamente."`.

### 3.4 Errores como resultado vs errores como excepción

Este es el patrón más olvidado en agentes principiantes. Distingue:

- **Errores TÉCNICOS** (timeout, 5xx, network, permission): reintentar puede resolver → devuelve como `is_error: true` (el framework hace backoff).
- **Casos de NEGOCIO** (usuario no existe, orden ya cancelada): parte esperada del flujo → devuelve como resultado estructurado con `success: true` pero payload informativo.

Malo:

```python
def get_user(user_id: str):
    if not db.exists(user_id):
        raise UserNotFoundError()  # → modelo reintenta ciegamente
```

Bueno:

```python
def get_user(user_id: str) -> dict:
    user = db.find(user_id)
    if not user:
        return {
            "found": False,
            "reason": "not_found",
            "suggestion": "Verifica el user_id o busca por email con find_user_by_email."
        }
    return {"found": True, "user": user}
```

Cuando le devuelves al modelo `{"found": false, "suggestion": "..."}`, este razona: "no existe, voy a preguntar al usuario o intentar la alternativa". Cuando le devuelves `is_error`, muchas veces reintenta la misma llamada.

### 3.5 Formato del tool_result: JSON estructurado + paginación

Un `list_orders` que devuelve 500 órdenes en texto libre destroza el contexto. Reglas de oro:

1. **JSON estructurado** > texto libre.
2. **Top-N por defecto** con paginación explícita (`has_more`, `next_cursor`).
3. **Trimming**: si el modelo solo necesita id+status, no envíes payload completo.
4. **Metadata útil**: `total_count`, `filters_applied`.

```python
def list_orders(user_id: str, limit: int = 10, cursor: str = None) -> dict:
    orders, next_cursor = db.list_orders(user_id, limit=limit, after=cursor)
    return {
        "orders": [{"id": o.id, "status": o.status, "total": o.total} for o in orders],
        "total_count": db.count_orders(user_id),
        "has_more": next_cursor is not None,
        "next_cursor": next_cursor,
    }
```

### 3.6 Diagrama ASCII: qué viaja en un round completo con parallel calling

```
Cliente ── request ──► API                             Backend tuyo
                        │
                        ▼
                    [modelo]
                        │
                        ▼ genera tokens hasta stop
   ┌──────────────────────────────────────────┐
   │  response.content = [                    │
   │    {type:"thinking", text:"..."},        │
   │    {type:"text", text:"Voy a consultar"},│
   │    {type:"tool_use", id:A, name:"...",   │
   │      input:{city:"Madrid"}},             │
   │    {type:"tool_use", id:B, name:"...",   │◄── PARALELO
   │      input:{city:"Paris"}}               │
   │  ]                                       │
   │  stop_reason = "tool_use"                │
   └──────────────────────────────────────────┘
                        │
                        ▼
   asyncio.gather(exec(A), exec(B))  ─────────► resultados en <100ms si son APIs concurrentes
                        │
                        ▼
   messages.append({role:"user", content:[
      {type:"tool_result", tool_use_id:A, content:"..."},
      {type:"tool_result", tool_use_id:B, content:"..."}
   ]})
                        │
                        ▼ next request
                    [modelo]
                        │
                        ▼
   response con stop_reason="end_turn" y texto final.
```

### 3.7 Bajo el capó: cómo el modelo "decide" llamar una tool

Aunque desde fuera parece magia, el mecanismo es explicable. Al recibir el request, el servidor concatena tu system prompt + serialización canónica de las tools (JSON Schema convertido a un formato textual con delimitadores especiales, distinto por proveedor) + historial. El modelo entonces genera tokens con un "modo" activado que incluye tokens especiales de tool call en el vocabulario efectivo (Anthropic usa marcadores como `<function_calls>` internamente; OpenAI usa tokens de rol tipo `<tool_call>`).

Cuando el modelo empieza a generar uno de esos tokens especiales, el servidor entra en modo **grammar-constrained decoding** ([guía técnica de llama.cpp](https://github.com/ggerganov/llama.cpp/blob/master/grammars/README.md)): en cada paso solo se muestrean tokens que mantienen el output dentro del JSON Schema declarado. Si el schema dice `enum: ["a","b","c"]`, la máscara de logits pone `-inf` a todo token que rompería la enumeración. Esto es lo que garantiza que Structured Outputs de OpenAI tenga "100% compliance" — no es que el modelo sea perfecto, es que el decodificador impide físicamente generar output inválido.

Para el desarrollador esto tiene tres implicaciones prácticas:

1. **Schemas complejos son más lentos.** Cuanto más restrictivo el schema, más tiempo pasa el decoder filtrando logits. Un schema con 5 propiedades y 3 enums cortos añade típicamente 15-40 ms; uno con `oneOf`/`anyOf` anidados puede añadir >200 ms.
2. **Tools ambiguas confunden más que schemas ambiguos.** La ambigüedad va a la parte de "decidir qué tool" (que es libre generación), no a "cómo llenar el schema" (que está constrained). Por eso invertir en descriptions rinde más que microoptimizar schemas.
3. **La cache de prefijo cubre las tool definitions.** Si envías las mismas 20 tools 100 veces, la conversión a tokens y su procesamiento vía KV-cache se cachea con hits del 90%+ (Anthropic prompt caching, OpenAI automatic prefix caching).

Este entendimiento cambia cómo diseñas: **descriptions largas y precisas + schemas simples con enums** casi siempre bate a **descriptions cortas + schemas complejos**.

## 4. Práctica avanzada (nivel senior)

### 4.1 Idempotencia obligatoria en tools con side effects

Cualquier tool que crea, cobra, envía o borra DEBE ser idempotente. El patrón estándar es `idempotency-key`: el cliente genera un UUID por intención, el servidor persiste `(key → result)` durante 24-48h. Reintentos con la misma key devuelven el mismo resultado sin re-ejecutar.

```python
import uuid
import httpx

class ShipmentTool:
    def __init__(self):
        self._pending_keys: dict[str, str] = {}  # persist en Redis en prod

    def create_shipment(self, order_id: str, carrier: str) -> dict:
        # Generar (o reusar) idempotency key POR INTENCIÓN
        intent = f"ship:{order_id}:{carrier}"
        key = self._pending_keys.setdefault(intent, str(uuid.uuid4()))

        resp = httpx.post(
            "https://api.example.com/shipments",
            json={"order_id": order_id, "carrier": carrier},
            headers={"Idempotency-Key": key},
            timeout=30,
        )
        return resp.json()
```

**Anti-patrón clásico:** generar la key como `hash(payload + timestamp_minute)`. Rompe cobros legítimos duplicados (dos cafés del mismo cliente en el mismo minuto se rechazan). La key debe reflejar **intención única**, no contenido.

### 4.2 Retry policy inteligente por tipo de error

No todos los errores merecen retry. Clasifica:

```python
from enum import Enum

class ErrorKind(Enum):
    TRANSIENT = "transient"      # retry con backoff
    AUTH = "auth"                # NO retry — devolver al modelo con retryable:false
    NOT_FOUND = "not_found"      # resultado estructurado, no error
    VALIDATION = "validation"    # error al modelo con detalles

def classify(status_code: int) -> ErrorKind:
    if status_code in (429, 500, 502, 503, 504):
        return ErrorKind.TRANSIENT
    if status_code in (401, 403):
        return ErrorKind.AUTH
    if status_code == 404:
        return ErrorKind.NOT_FOUND
    if status_code == 400:
        return ErrorKind.VALIDATION
    return ErrorKind.TRANSIENT  # default conservador
```

### 4.3 Dry-run mode y permission tiers

Para acciones destructivas (`delete_s3_bucket`, `drop_database`), diseño canónico:

```
Tools clasificadas por riesgo:
  READ (list, get, describe)          → auto-execute
  WRITE reversible (create, update)   → auto-execute + audit log
  DESTRUCTIVE (delete, drop, forcepush)→ dry-run + confirmación humana
```

Implementación del dry-run:

```python
def delete_s3_bucket(bucket_name: str, dry_run: bool = True) -> dict:
    if dry_run:
        objects = s3.list_objects(bucket_name)
        return {
            "dry_run": True,
            "would_delete": bucket_name,
            "objects_count": len(objects),
            "estimated_data_gb": sum(o.size for o in objects) / 1e9,
            "confirm_with": "delete_s3_bucket(bucket_name='...', dry_run=False)"
        }
    # Ejecución real solo si dry_run=False Y el usuario aprobó
    ...
```

### 4.4 Prompt caching de tool definitions

Si tu agente enviá 20+ tool definitions (~4000 tokens) en cada request, cachearlas ahorra ~85-90% del coste del prefijo. Anthropic requiere marcado explícito:

```python
response = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    system=[
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
    ],
    tools=[
        *tools,
        # marca el último tool como cache breakpoint
        {**tools[-1], "cache_control": {"type": "ephemeral"}}
    ],
    messages=messages,
)
```

TTL default: 5 min; extendido a 1h con `"cache_control": {"type": "ephemeral", "ttl": "1h"}`. OpenAI cachea automáticamente prefijos ≥1024 tokens sin necesidad de marcarlos.

### 4.5 Secrets fuera del prompt

Regla dura: los tokens/credenciales NUNCA van como parámetro de tool ni en el prompt. Diseño correcto:

```python
# MAL
tools = [{"name": "send_slack",
          "input_schema": {"properties": {
              "channel": {"type": "string"},
              "slack_token": {"type": "string"}  # expone al modelo
          }}}]

# BIEN
tools = [{"name": "send_slack",
          "input_schema": {"properties": {
              "channel": {"type": "string"},
              "text": {"type": "string"}
              # token se inyecta server-side desde vault, ligado a session
          }}}]

def send_slack(channel: str, text: str, *, session: Session):
    token = vault.get_slack_token(session.user_id)  # servidor resuelve
    slack.post(channel, text, token=token)
```

Motivos: (1) el modelo puede loggear/filtrar el token, (2) prompt injection puede extraerlo, (3) rotación y revocación son imposibles si vive en prompts.

### 4.6 Anti-patrón: tools genéricas tipo `query(sql)` o `execute(tool_name, args)`

Dos ejemplos comunes de mal diseño:

- `execute_registered_tool(name, args)` con registro dinámico — el modelo NO sabe qué tools existen si no están en el contexto. Alucina nombres y argumentos.
- `query(sql: string)` — expone superficie de inyección SQL, permite dropping tables, imposible de auditar.

En su lugar: MCP para discovery dinámico con schemas comunicados al modelo, o tool routing (clasificador barato al inicio de la sesión carga subset de 10-20 tools relevantes).

### 4.7 Streaming de tool calls con UX pulida

La API emite eventos SSE granulares. Cuando el modelo empieza a emitir un `tool_use`, puedes actualizar UI **antes** de tener el input completo:

```python
with client.messages.stream(
    model="claude-sonnet-4-5-20250929",
    tools=tools,
    messages=messages,
    max_tokens=2048,
) as stream:
    for event in stream:
        if event.type == "content_block_start":
            if event.content_block.type == "tool_use":
                print(f"[UI] Ejecutando {event.content_block.name}...")
        elif event.type == "input_json_delta":
            # stream del input parcial (JSON delta)
            print(event.partial_json, end="", flush=True)
        elif event.type == "message_stop":
            final = stream.get_final_message()
```

Cursor y Claude Code muestran "Reading src/foo.ts...", "Running npm test" en tiempo real gracias a este patrón.

### 4.8 Cuándo NO usar tools

Añadir tools innecesarias suma tokens en cada request, latencia (un turno extra), y confusión al modelo (más opciones que evaluar). Guía de decisión:

| Necesitas... | Solución |
|---|---|
| Información externa (fecha, DB, API) | Tool |
| Side effect (email, cobro, delete) | Tool |
| Cálculo pesado con precisión (bignum, floats) | Tool o code interpreter |
| Aritmética trivial (2+2, IVA) | Confía en el modelo |
| Fecha actual | Tool si necesitas precisión de segundos; si no, incluye en system prompt |
| Convertir unidad simple (km→mi) | Confía en el modelo |

## 5. Ejemplo práctico completo — agente de clima + email con confirmación

Vamos a construir un agente que: (1) consulta el clima de una ciudad, (2) redacta un email con recomendaciones, (3) requiere confirmación humana antes de enviar. Cubre parallel tools, idempotencia, dry-run, y errores estructurados.

**Decisiones de diseño (por qué antes del qué):**

- **3 tools en vez de 1 "send_weather_email":** granularidad fina permite reusar `get_weather` en otros flujos y separa la lectura (auto) de la escritura (HITL). Regla general — una tool = una intención, no un macro.
- **`draft_email` separado de `send_email`:** el modelo puede iterar el borrador con el usuario ("hazlo más corto") sin arriesgar envíos. Y el `draft_id` sirve como idempotency key natural.
- **`confirmed_by_human` como flag booleano en `send_email`:** hace explícito en el schema que la acción requiere consentimiento, disuadiendo al modelo de inventar `True` sin haber preguntado.
- **Errores estructurados vs is_error:** ciudad inexistente = negocio (`found: False`); timeout de red = técnico (`is_error: True`). El modelo reacciona muy distinto ante cada uno.
- **Open-Meteo sin API key:** el ejemplo debe funcionar cross-machine sin credenciales; en producción usarías OpenWeather, Weatherstack, etc.

```python
"""
weather_email_agent.py — agente Anthropic con 3 tools y confirmación humana.
Ejecutar: python weather_email_agent.py
Requiere: pip install anthropic==0.121.0 httpx==0.28.1
"""
import os
import uuid
import json
import httpx
import anthropic

client = anthropic.Anthropic()
MODEL = "claude-sonnet-4-5-20250929"

# ============================================================
# Tools definitions
# ============================================================
TOOLS = [
    {
        "name": "get_weather",
        "description": (
            "Obtiene el clima actual de una ciudad. Úsala cuando el usuario "
            "pregunte por temperatura, lluvia o condiciones climáticas HOY. "
            "Devuelve JSON con temp_c, humidity_pct, conditions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "Nombre de ciudad"},
            },
            "required": ["city"],
            "additionalProperties": False,
        },
    },
    {
        "name": "draft_email",
        "description": (
            "Redacta un borrador de email (NO lo envía). "
            "Úsala cuando tengas contenido claro para el email. "
            "Devuelve el borrador con un draft_id que puedes pasar a send_email."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "format": "email"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
            "additionalProperties": False,
        },
    },
    {
        "name": "send_email",
        "description": (
            "ENVÍA un email previamente redactado. Acción DESTRUCTIVA e IRREVERSIBLE. "
            "Debe llamarse solo tras confirmación humana explícita. "
            "Requiere un draft_id obtenido de draft_email. "
            "Usa idempotency key para no duplicar envíos."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "draft_id": {"type": "string"},
                "confirmed_by_human": {
                    "type": "boolean",
                    "description": "Debe ser true; el humano ya aprobó."
                },
            },
            "required": ["draft_id", "confirmed_by_human"],
            "additionalProperties": False,
        },
    },
]

# ============================================================
# Tool implementations
# ============================================================
_drafts: dict[str, dict] = {}
_sent_idempotency: dict[str, dict] = {}

def get_weather(city: str) -> dict:
    """Consulta clima real via Open-Meteo (sin API key)."""
    try:
        geo = httpx.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": city, "count": 1},
            timeout=10,
        ).json()
        if not geo.get("results"):
            return {"found": False, "reason": "unknown_city", "city": city}
        lat, lon = geo["results"][0]["latitude"], geo["results"][0]["longitude"]
        w = httpx.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": lat, "longitude": lon, "current_weather": True},
            timeout=10,
        ).json()["current_weather"]
        return {
            "found": True,
            "city": city,
            "temp_c": w["temperature"],
            "wind_kmh": w["windspeed"],
            "conditions_code": w["weathercode"],
        }
    except httpx.TimeoutException:
        # Error TÉCNICO — señalizar como is_error para retry
        raise
    except Exception as e:
        return {"found": False, "reason": "api_error", "detail": str(e)}

def draft_email(to: str, subject: str, body: str) -> dict:
    draft_id = f"draft_{uuid.uuid4().hex[:8]}"
    _drafts[draft_id] = {"to": to, "subject": subject, "body": body}
    return {
        "draft_id": draft_id,
        "preview": {"to": to, "subject": subject, "body_first_100": body[:100]},
        "next_step": "Muestra el preview al usuario y pídele confirmación explícita."
    }

def send_email(draft_id: str, confirmed_by_human: bool) -> dict:
    if not confirmed_by_human:
        return {
            "sent": False,
            "reason": "human_confirmation_required",
            "hint": "Debes obtener confirmación EXPLÍCITA del usuario antes."
        }
    if draft_id not in _drafts:
        return {"sent": False, "reason": "unknown_draft", "draft_id": draft_id}
    # Idempotency: si ya fue enviado, devolvemos el mismo resultado
    if draft_id in _sent_idempotency:
        return {**_sent_idempotency[draft_id], "idempotent_replay": True}
    # Envío real (aquí simulado)
    draft = _drafts[draft_id]
    result = {"sent": True, "message_id": f"msg_{uuid.uuid4().hex[:12]}", "to": draft["to"]}
    _sent_idempotency[draft_id] = result
    return result

TOOL_FNS = {"get_weather": get_weather, "draft_email": draft_email, "send_email": send_email}

# ============================================================
# Loop del agente con confirmación humana
# ============================================================
def run_agent(user_message: str, max_iterations: int = 10):
    messages = [{"role": "user", "content": user_message}]

    for iteration in range(max_iterations):
        response = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            tools=TOOLS,
            messages=messages,
        )

        # Si el modelo respondió texto final, terminamos
        if response.stop_reason == "end_turn":
            text = "".join(b.text for b in response.content if b.type == "text")
            print(f"\n[AGENT] {text}")
            return text

        if response.stop_reason != "tool_use":
            print(f"[WARN] stop_reason inesperado: {response.stop_reason}")
            return None

        # Ejecutar TODOS los tool_use en paralelo (aquí secuencial por simplicidad)
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        messages.append({"role": "assistant", "content": response.content})
        results = []
        for tu in tool_uses:
            print(f"[TOOL] {tu.name}({json.dumps(tu.input)})")

            # HUMAN-IN-THE-LOOP para acciones destructivas
            if tu.name == "send_email" and tu.input.get("confirmed_by_human"):
                draft = _drafts.get(tu.input["draft_id"], {})
                print(f"\n[CONFIRM] Enviar email a {draft.get('to')}?")
                print(f"          Asunto: {draft.get('subject')}")
                print(f"          Body:   {draft.get('body')[:200]}...")
                confirm = input("[HUMAN] Confirma envío? (y/n): ").strip().lower()
                if confirm != "y":
                    results.append({"type": "tool_result", "tool_use_id": tu.id,
                                    "content": json.dumps({"sent": False,
                                                            "reason": "user_declined"})})
                    continue

            try:
                out = TOOL_FNS[tu.name](**tu.input)
                results.append({"type": "tool_result", "tool_use_id": tu.id,
                                "content": json.dumps(out)})
            except httpx.TimeoutException:
                results.append({"type": "tool_result", "tool_use_id": tu.id,
                                "content": "timeout", "is_error": True})

        messages.append({"role": "user", "content": results})

    print("[WARN] Alcanzado max_iterations")

if __name__ == "__main__":
    run_agent(
        "Mira el clima en Madrid y mándale un email a alice@example.com "
        "con una recomendación de ropa según el tiempo."
    )
```

Puntos a observar:
- **Parallel tools**: el modelo puede emitir `get_weather` y otros en paralelo, aunque aquí las ejecutamos secuencialmente por simplicidad.
- **HITL** en `send_email`: input humano antes de ejecutar la acción destructiva.
- **Idempotencia**: `send_email` con mismo `draft_id` devuelve el resultado previo sin re-enviar.
- **Errores estructurados**: "ciudad no encontrada" es `{"found": false, ...}`, no excepción.
- **Errores técnicos**: timeout va como `is_error: true` para que el modelo decida (retry o fallback).

### 5.1 Verificaciones intermedias que deberías añadir en producción

Tras cada paso clave, añade asserts o logs estructurados que permitan reconstruir la sesión en un incidente:

```python
# Tras cada tool call
for tu in tool_uses:
    assert tu.id, "tool_use sin id — bug del SDK"
    assert tu.name in TOOL_FNS, f"tool desconocida: {tu.name}"
    logger.info("tool_call", extra={
        "session_id": session_id,
        "tool_name": tu.name,
        "input_keys": list(tu.input.keys()),  # sin values (PII)
        "iteration": iteration,
    })

# Tras el ciclo completo
assert len(messages) % 2 == 0 or messages[-1]["role"] == "assistant", \
    "historial malformado — assistant y tool_result deben alternar"

# Antes de enviar email
draft = _drafts.get(tu.input["draft_id"])
assert draft, f"draft_id inexistente: {tu.input['draft_id']}"
assert "@" in draft["to"], f"email destino inválido: {draft['to']}"
```

### 5.2 Extendiendo el ejemplo (mejoras para producción)

El ejemplo cubre lo básico pero un uso real necesita al menos:

1. **Idempotency key server-side de verdad.** Cambia `_sent_idempotency` (dict en memoria) por Redis con TTL 48h. Estructura: `SETEX idem:send_email:{draft_id} 172800 {message_id}`. Así múltiples réplicas del backend nunca duplican envíos, incluso durante deploys blue/green:

   ```python
   import redis
   r = redis.Redis(host="cache", decode_responses=True)

   def send_email(draft_id, confirmed_by_human):
       key = f"idem:send:{draft_id}"
       cached = r.get(key)
       if cached:
           return {"sent": True, "message_id": cached, "idempotent_replay": True}
       # ... envío real ...
       r.setex(key, 172800, msg_id)  # 48h TTL
   ```

2. **Retry con backoff exponencial para timeouts.** Envolver `httpx.get` con `tenacity.retry(stop=stop_after_attempt(3), wait=wait_exponential(1, 8))`. Cuando timeout se acaba, devolver `{"found": False, "reason": "weather_api_unavailable"}` para que el modelo pueda al menos redactar un email diciendo "no pude consultar el clima" en vez de bucle infinito.

3. **Prompt caching en tools + system.** Con 20+ requests/día del mismo agente, marca `cache_control` en el último tool y en el system prompt. Ahorro típico observado por Anthropic: 85-90% del coste del prefijo, ~50% del coste total en agentes conversacionales largos.

4. **Observabilidad estructurada.** Emite OpenTelemetry spans con atributos `gen_ai.tool.name`, `gen_ai.tool.status`, `gen_ai.usage.input_tokens`. Herramientas: Langfuse, Braintrust, Phoenix (Arize). Sin esto, cuando el jefe pregunte "¿cuánto costó el agente de clima este mes?" no tendrás respuesta desagregada.

5. **Tests contra un modelo real con `tool_choice="any"`.** Grabar 20 conversaciones golden y verificar en CI que el modelo elige la tool correcta en cada paso; regresión >10% bloquea el merge. Ver Cap 09.

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Description = system prompt de la tool**: 3-5 líneas mínimo, con casos negativos.
- ✅ **Enums para dominios cerrados**, siempre.
- ✅ **Idempotency keys en toda tool con side effect**.
- ✅ **Errores de negocio como resultado, errores técnicos como is_error**.
- ✅ **JSON estructurado en tool_result**, con paginación explícita.
- ✅ **Structured output cuando no hay side effect**, no tool ficticia.
- ✅ **Parallel tool calling** por defecto; solo desactívalo si tus tools tienen dependencias latentes que el modelo no capta.
- ✅ **Prompt caching** para system + tools cuando envías el mismo prefijo repetidamente.
- ✅ **Secrets fuera del prompt**, resueltos server-side.
- ✅ **Human-in-the-loop** para acciones destructivas o irreversibles.

### Anti-patrones

- ❌ Description "Busca cosas" — el modelo no sabe cuándo llamarla.
- ❌ `type: string` cuando debería ser `enum` — el modelo inventa variantes.
- ❌ Tool con side effect sin idempotency key.
- ❌ Lanzar excepción `UserNotFoundError` en lugar de `{"found": false}`.
- ❌ `execute(tool_name, args)` genérica con schemas ocultos al modelo.
- ❌ Tokens en `input_schema` (o en el system prompt).
- ❌ Tool de aritmética trivial (los modelos modernos son fiables aquí).
- ❌ tool_result como texto libre gigante sin estructura ni paginación.
- ❌ Hash-de-payload como idempotency key (rompe operaciones legítimas iguales).
- ❌ `auto-approve all` en agentes con acceso a producción.

### Árbol de decisión: tool vs structured output vs prompt-only

```
¿Necesitas ejecutar un side effect (email, cobro, DB write)?
  SÍ → Tool + idempotency + HITL si es destructivo
  NO → ¿Necesitas datos externos (API, DB read)?
        SÍ → Tool
        NO → ¿Necesitas JSON estricto de output?
              SÍ → response_format: json_schema (structured output)
              NO → Prompting normal
```

## 7. Casos reales de la industria (2026)

1. **Shopify — incidente idempotencia (2024, referenciado en post-mortems 2025)**.
   - **Qué pasó:** el agente de soporte automático encolaba re-envíos silenciosos de `create_ticket` cuando la API tardaba >5s. Un pico de latencia un sábado por la noche disparó ~200 duplicados sobre ~80 conversaciones únicas.
   - **Cómo se detectó:** el equipo de moderación humana marcó "spam" en tickets aparentemente duplicados; el on-call de datos correlacionó timestamps y descubrió el patrón de retries del agente.
   - **Cómo se arregló:** header `Idempotency-Key` obligatorio en toda tool POST/DELETE, generado como UUID por intención lógica (no por hash de payload). El `RetryWrapper` fue reescrito para preservar la key entre intentos.
   - **Lección para la industria:** todo framework serio (LangChain, LlamaIndex, DSPy) incluye desde 2025 helpers `idempotent_tool()` que fuerzan la política.

2. **Notion — enum migration (2024)**.
   - **Qué pasó:** el agente de bloques permitía `block_type` como string libre; el modelo generaba variantes tipo `"Header"`, `"H1"`, `"heading_1"`, `"heading-1"` para el mismo concepto.
   - **Cómo se detectó:** el equipo notó 8% de tool calls fallando con `422 Unprocessable Entity`; el trace de errores mostró variantes de escritura como causa raíz.
   - **Cómo se arregló:** migración de `type: string` a `enum: ["paragraph", "heading_1", "heading_2", ..., "code"]` con 22 valores documentados. Un script de rewrite convirtió calls antiguos a la nomenclatura canónica.
   - **Lección:** errores caen a <0.5%; publicado en su blog de AI Engineering. Enums no son solo validación — son documentación ejecutable del dominio.

3. **Anthropic Sonnet 4.5 (sep 2025) y Sonnet 4.6 (2026)**: parallel tool calling nativo desde Sonnet 3.5; Sonnet 4.5 lidera OSWorld (61.4%) para computer use y mantiene focus más de 30h en tareas agénticas. Sonnet 4.6 añade major improvement en resistencia a prompt injection según system card oficial. Impacto: agentes multi-tool ejecutan hasta 4× más rápido gracias a parallelization.

4. **OpenAI Structured Outputs (agosto 2024)**: introducción de `response_format: json_schema` con `strict: true`, reportando 100% de schema compliance. Convirtió el patrón "tool falsa para JSON" en anti-patrón oficial. Migración típica reportada por early adopters: −30% coste tokens y −20% latencia p95 al eliminar la fake tool.

5. **Cursor — tool description redesign (2024)**.
   - **Qué pasó:** el agente llamaba `run_terminal` para tareas triviales (leer un archivo, buscar un símbolo) cuando había tools especializadas más baratas.
   - **Cómo se detectó:** telemetría de tool usage mostró 40% de calls a `run_terminal` con comandos redundantes tipo `cat file.ts`.
   - **Cómo se arregló:** rediseño de descriptions añadiendo secciones "NO uses esta tool cuando..." y elevando la especificidad de `read_file`, `grep_search`. Resultado: −30% de llamadas innecesarias, latencia media por prompt −800 ms.
   - **Lección:** el catálogo de tools no es solo un menú — es un sistema jerárquico donde tools especializadas deben ser preferidas explícitamente en las descriptions.

6. **Anthropic SDK 0.121.0 (agosto 2026)**: introduce `mid-conversation-tool-changes-2026-07-01` beta que permite añadir/remover tools dinámicamente sin reiniciar la sesión — clave para agentes de larga vida que rotan capacidades según fase.

7. **Vercel v0 — hallucinated schema keys (2025)**.
   - **Qué pasó:** al generar componentes React, el agente inventaba props (`shadow="glow"` en un `<Card>` que no la soportaba).
   - **Cómo se detectó:** usuarios reportaban componentes rotos; el equipo añadió un post-tool validator que comparaba props emitidas contra el schema real del componente.
   - **Cómo se arregló:** convertir cada componente en una tool con `additionalProperties: false` estricto; el modelo ahora solo emite props declaradas.
   - **Lección:** `additionalProperties: false` no es paranoia — es la única barrera real contra "hallucinated fields" en outputs estructurados.

## 8. Ejercicios prácticos

### Ejercicio 1 — Tool description quirúrgica

**Objetivo:** convertir una tool ambigua en una que el modelo llama correctamente.

**Setup:**
```python
tool_malo = {
    "name": "lookup",
    "description": "Busca info.",
    "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}}
}
```

**Pasos:**
1. Reescribe la description en 4-6 líneas explicando qué hace, cuándo usarla, cuándo NO, y qué devuelve.
2. Añade `description` a cada parámetro.
3. Renombra la tool a algo específico (`search_documentation`, `find_customer`, etc.).
4. Prueba con 3 prompts distintos: uno donde deba llamarla, uno donde NO, uno ambiguo.

**Criterios de éxito:**
- [ ] La description menciona explícitamente cuándo NO usar la tool.
- [ ] En el prompt "NO", el modelo no la llama.
- [ ] En el prompt ambiguo, el modelo pregunta al usuario antes de llamarla.

**Hints:**
- Formato canónico de description: 1 línea de qué hace + 1 línea de cuándo SÍ + 1 línea de cuándo NO + 1 línea de qué devuelve.
- Un nombre bueno es un verbo específico: `search_customer_by_email` mejor que `find` o `lookup`.
- Prueba con `tool_choice="auto"` para dar libertad al modelo; si con `required` le fuerzas siempre, no mides bien la calidad de la description.

**Solución de referencia (esbozo):**
```python
tool_bueno = {
    "name": "search_customer_by_email",
    "description": (
        "Busca un cliente en el CRM interno usando su email exacto. "
        "Úsala cuando el usuario proporcione un email y quiera info del cliente. "
        "NO la uses para: búsquedas por nombre (usa search_customer_by_name), "
        "listar todos los clientes (usa list_customers), o buscar en HubSpot externo. "
        "Devuelve {customer_id, name, email, plan, created_at} o {found: false}."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "email": {
                "type": "string",
                "format": "email",
                "description": "Email exacto del cliente, case-insensitive."
            }
        },
        "required": ["email"],
        "additionalProperties": False,
    }
}
```

**Bonus:** añade `enum` a algún parámetro que tenga dominio cerrado.

### Ejercicio 2 — Idempotency key correcta

**Objetivo:** implementar una tool `create_ticket` idempotente.

**Pasos:**
1. Escribe `create_ticket(title, description) -> dict` que llame a un endpoint POST.
2. Genera `idempotency_key` como UUID por INTENCIÓN (persistir en un dict local).
3. Llama la tool 3 veces con los mismos args; verifica que solo se crea 1 ticket.
4. Llama la tool 3 veces con args distintos (`title` diferente); verifica que se crean 3.

**Criterios de éxito:**
- [ ] Reintentos con misma intención = 1 ticket.
- [ ] Intenciones distintas = N tickets.
- [ ] La key NO es un hash de payload.

**Hints:**
- "Intención" en soporte técnico ≈ (usuario, título, primer minuto de creación) — no confundas con "payload idéntico".
- El server debe devolver la MISMA respuesta ante misma key, no un 409. Si devuelve 409, el cliente no sabe si el original tuvo éxito.
- Para el bonus con Redis: `SET NX EX 86400` es la primitiva atómica que necesitas.

**Solución de referencia (esbozo):**
```python
import uuid, redis
r = redis.Redis(decode_responses=True)

def create_ticket(title: str, description: str, intent_id: str = None) -> dict:
    # intent_id lo genera el orchestrator, no el server; una intención distinta = otro id
    intent_id = intent_id or f"{title}:{int(time.time() // 60)}"
    idem_key = f"idem:ticket:{intent_id}"
    # Reserva atómica; si ya existe, devuelve el resultado cacheado
    if not r.set(idem_key, "PENDING", nx=True, ex=86400):
        return json.loads(r.get(idem_key) or "{}")
    resp = httpx.post(TICKETS_URL, json={"title": title, "description": description},
                     headers={"Idempotency-Key": intent_id}, timeout=30)
    result = resp.json()
    r.setex(idem_key, 86400, json.dumps(result))
    return result
```

**Bonus:** persiste las keys en Redis con TTL 24h.

### Ejercicio 3 — Errores estructurados vs excepciones

**Objetivo:** diseñar `get_order(order_id)` con manejo correcto de errores.

**Pasos:**
1. Implementa la tool con 4 casos: éxito, no encontrado, permisos denegados, timeout.
2. Éxito → `{"order": {...}}`.
3. No encontrado → `{"found": false, "suggestion": "..."}`.
4. Permisos → `{"error": "permission_denied", "retryable": false}` con `is_error: true`.
5. Timeout → raise excepción (`is_error: true` automático).
6. Prueba cada caso con el modelo y observa cómo reacciona.

**Criterios de éxito:**
- [ ] No encontrado: el modelo sugiere alternativa o pregunta al usuario.
- [ ] Permisos: el modelo NO reintenta.
- [ ] Timeout: el framework reintenta con backoff.

**Hints:**
- Estructura recomendada del payload: `{"found": bool, "reason": str | None, "suggestion": str | None, "data": dict | None}`.
- "Permisos denegados" no es transient: envíalo como `is_error: true` PERO con description clara para que el modelo no reintente ("permission_denied — no reintentar; escala al humano").
- Los timeouts son los únicos que deben propagarse como excepción sin capturar dentro del tool.

**Solución de referencia (esbozo):**
```python
def get_order(order_id: str, *, session) -> dict:
    if not session.can_read_order(order_id):
        return {"error": "permission_denied", "retryable": False,
                "suggestion": "escala al equipo de soporte"}  # + is_error:true al empaquetar
    try:
        order = db.get_order(order_id, timeout=5)
    except TimeoutError:
        raise  # deja que el framework lo marque is_error y reintente
    if not order:
        return {"found": False, "suggestion": "verifica el ID; usa search_orders_by_user"}
    return {"found": True, "order": order.to_dict()}
```

### Ejercicio 4 — Parallel tool calling verificado

**Objetivo:** confirmar que el modelo emite tools en paralelo cuando son independientes.

**Pasos:**
1. Define 3 tools: `get_weather(city)`, `get_currency_rate(pair)`, `get_time(timezone)`.
2. Envía prompt: "Dime el clima en París, el tipo EUR/USD y la hora en Tokyo."
3. Loggea los `tool_use` blocks del response.
4. Verifica que los 3 vienen en un solo turno.

**Criterios de éxito:**
- [ ] `response.content` contiene 3 bloques `tool_use` en un solo turno.
- [ ] Los ejecutas con `asyncio.gather`.
- [ ] Los 3 `tool_result` van en un solo mensaje.

**Hints:**
- Si el modelo NO paraleliza, revisa las descriptions — el modelo detecta dependencia si dicen cosas como "requiere el resultado de X". Sé explícito con "independiente de".
- `asyncio.gather` mantiene el orden del input; `tool_use_id` es lo que asocia resultado con llamada, no la posición.
- Speedup esperado en tools I/O-bound (APIs HTTP): ~3× para 3 tools independientes; en tools CPU-bound sin `run_in_executor`, casi 1× (bloqueo GIL).

**Solución de referencia (esbozo):**
```python
import asyncio
async def run_all(tool_uses):
    async def one(tu):
        fn = TOOLS[tu.name]
        out = await fn(**tu.input)
        return {"type": "tool_result", "tool_use_id": tu.id, "content": json.dumps(out)}
    return await asyncio.gather(*(one(tu) for tu in tool_uses))
# messages.append({"role": "user", "content": await run_all(tool_uses)})
```

**Bonus:** mide el speedup vs ejecutarlas secuencialmente.

### Ejercicio 5 — Human-in-the-loop para acción destructiva

**Objetivo:** integrar confirmación humana en `delete_project(id)`.

**Pasos:**
1. Implementa `delete_project(project_id, dry_run=True)` que devuelve preview de qué se borraría.
2. Solo con `dry_run=False` Y `confirmed_by_human=True` ejecuta el delete real.
3. En el loop del agente, cuando detectes `dry_run=False`, muestra preview al usuario y pide input.
4. Prueba con un prompt agresivo tipo "borra todos los proyectos test-*".

**Criterios de éxito:**
- [ ] Sin confirmación, la tool devuelve preview.
- [ ] Con confirmación humana, ejecuta.
- [ ] El agente muestra el preview antes de pedir input.

**Hints:**
- Empieza con `dry_run` default `True` — la seguridad debe ser el camino sin fricción.
- El `confirmed_by_human` no puede venir del modelo; inspecciónalo en el orchestrator y sobreescríbelo con `False` si no vino de UI real.
- Preview debe incluir un COUNT ("borrarás 47 proyectos"), no solo un listado — el humano evalúa mejor volumen que enumeración.

**Solución de referencia (esbozo):**
```python
def delete_project(project_id: str, dry_run: bool = True, confirmed_by_human: bool = False):
    matches = db.find_projects(project_id)
    if dry_run or not confirmed_by_human:
        return {"dry_run": True, "would_delete_count": len(matches),
                "sample": [m.name for m in matches[:5]],
                "confirm_with": "delete_project(project_id='...', dry_run=False, confirmed_by_human=True)"}
    for m in matches: db.delete_project(m.id)
    return {"deleted": len(matches)}
```

**Bonus:** añade "bulk approve" para hasta N deletes del mismo tipo.

### Ejercicio 6 (RETO) — Compilador de tools desde OpenAPI

**Objetivo:** convertir un fragmento de OpenAPI 3.1 en tools JSON Schema compatibles con Anthropic y OpenAI.

**Pasos:**
1. Parte de un `openapi.json` con 3-5 endpoints (GET, POST, DELETE).
2. Escribe `openapi_to_tools(spec) -> list[dict]` que genere una tool por operation, mapeando `operationId → name`, `summary/description → description`, y `parameters + requestBody → input_schema`.
3. Ejecuta un agente contra las tools generadas.
4. Añade prefijo de servicio al `name` (`stripe__create_customer`) para evitar colisiones al combinar múltiples APIs.

**Criterios de éxito:**
- [ ] Las tools generadas pasan validación de JSON Schema Draft 2020-12.
- [ ] El agente invoca al menos 2 operaciones distintas correctamente en un flujo end-to-end.
- [ ] Los `parameters` de path y query se combinan correctamente en el `input_schema`.

**Hints:**
- `additionalProperties: false` en cada schema para prevenir campos inventados.
- Enriquece `description` con "GET" o "POST" y el path — ayuda al modelo a razonar sobre semántica REST.
- Herramienta ya existente para inspirarte: `openapi-mcp-server` (open source, 2025).

## 9. Recursos y siguientes pasos

### Referencias oficiales (2026)

- [Anthropic — Tool use overview](https://docs.claude.com/en/docs/build-with-claude/tool-use) — la referencia canónica.
- [Anthropic — Building effective agents (dic 2024)](https://www.anthropic.com/research/building-effective-agents) — patrones workflow vs agent.
- [OpenAI — Function calling guide](https://platform.openai.com/docs/guides/function-calling) — spec de OpenAI.
- [OpenAI — Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs) — el reemplazo de tools ficticias para JSON.
- [JSON Schema — Draft 2020-12](https://json-schema.org/) — la spec de schemas.

### Papers y blogs relevantes

- Yao et al. 2022 — ReAct: Reasoning + Acting (base conceptual de agentes con tools).
- Stripe — Idempotent Requests guide (el patrón canónico).
- Liu et al. 2023 — Lost in the Middle (por qué el orden del contexto importa).
- Anthropic — Prompt caching whitepaper (2024).

### Tools recomendadas 2026

- **Anthropic SDK 0.121.0+** — soporta mid-conversation tool changes.
- **OpenAI SDK 1.109+** — structured outputs con `client.chat.completions.parse()`.
- **Vercel AI SDK 5+** — streaming de tool calls first-class para React/Next.
- **Instructor** — DX Pythonica sobre structured outputs (útil para validación con Pydantic).
- **Braintrust / LangSmith / Langfuse** — observabilidad de tool calls en producción.

### Qué leer después

- **[Cap 06 — MCP](./06-mcp-model-context-protocol.md)** — cómo escalar tools cross-host con el protocolo estándar.
- **[Cap 07 — Agent loops](./07-agent-loops-orchestration.md)** — orquestación cuando tienes muchas tools y decisiones.
- **[Cap 11 — Prompt injection](./11-prompt-injection-owasp-llm.md)** — cómo defender tools contra inputs adversariales.

## 10. Preguntas de práctica

- **JSON de preguntas:** [`packages/content/src/tech/ai-programming/sim-05-tool-function-calling.json`](../../packages/content/src/tech/ai-programming/sim-05-tool-function-calling.json)
- **Ruta en la app:** `/programming/ai-programming/sim/ai-programming-sim-05-tool-function-calling`
- **20 preguntas** cubriendo: description design, enums, tool_choice, idempotencia, error handling, parallel tools, structured output, dry-run, streaming, retry policy, granularidad, timeouts, secrets, observabilidad.

## Navegación

← [Cap 04 — Context memory & caching](./04-context-memory-caching.md) · [Índice](./README.md) · [Cap 06 — MCP profundo](./06-mcp-model-context-protocol.md) →
