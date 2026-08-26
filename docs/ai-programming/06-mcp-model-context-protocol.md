# Capítulo 06 — MCP profundo: crear un server, primitives y transports

> **Focus:** Model Context Protocol — qué es y por qué, primitives (resources/tools/prompts + sampling/roots/elicitation), transports (stdio y Streamable HTTP), autenticación con OAuth 2.1, arquitectura Host/Client/Server, quién lo soporta en 2026.
> **Áreas:** Agentes y tools · Interoperabilidad · Protocolos abiertos
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- [Cap 05 — Tool / Function calling](./05-tool-function-calling.md) — MCP es una capa protocolar sobre los conceptos de tool calling.
- Familiaridad con JSON-RPC 2.0.
- Conocimiento básico de OAuth 2.0/2.1 para la sección de auth.

**Glosario mínimo:**
- **Host:** la aplicación IA que el usuario abre (Claude Desktop, Cursor, VS Code, Windsurf, ChatGPT Desktop). Es "quien" mantiene la conversación con el LLM.
- **Client:** componente embebido en el host, uno por server conectado, que habla JSON-RPC con el server.
- **Server:** proceso separado que expone capacidades (tools, resources, prompts) al host.
- **Primitive:** unidad expuesta por el server — resource, tool, prompt (cliente-facing) o sampling, roots, elicitation (server-facing).
- **Transport:** cómo viajan los mensajes JSON-RPC — stdio para local, Streamable HTTP para remoto.
- **Capability:** feature negociada en el handshake `initialize` entre client y server.
- **Reference server:** implementación oficial de Anthropic (filesystem, git, memory, sequential-thinking) que demuestra patrones canónicos.

**Setup (Python — FastMCP):**

```bash
pip install "mcp[cli]"==1.13.0
pip install anthropic==0.121.0
```

**Setup (TypeScript):**

```bash
npm install @modelcontextprotocol/sdk@^1.13.0
npm install -D tsx typescript
```

**Setup (inspector para debug):**

```bash
npx @modelcontextprotocol/inspector node build/server.js
```

## 1. El gran cuadro

En noviembre de 2024, Anthropic anunció MCP con una analogía que se volvió canónica: **"MCP es el USB-C para las integraciones de IA"**. La motivación es el problema clásico N×M: sin un protocolo, cada aplicación de IA (Claude Desktop, Cursor, VS Code, un agente propio) tenía que reimplementar la integración con cada fuente de datos y capacidad (GitHub, Slack, Postgres, filesystem, Jira, Notion). Con N clientes y M servicios, se necesitan N×M integraciones. Con MCP, se reduce a N+M: escribes un server MCP para tu servicio una vez, y funciona con cualquier cliente compatible.

La analogía técnica más precisa no es USB-C sino LSP (Language Server Protocol, Microsoft 2016). Antes de LSP, un servidor de lenguaje (autocompletado, go-to-definition, refactoring) tenía que reescribirse para cada editor. Con LSP, un solo Rust Analyzer funciona en VS Code, Vim, Sublime, Emacs, JetBrains. MCP hace lo mismo pero para "conectar aplicaciones host de IA a proveedores de contexto y capacidades". La spec vive en [modelcontextprotocol.io](https://modelcontextprotocol.io) con SDKs oficiales en TypeScript, Python, Java, Kotlin, C#, Rust, Swift y Go.

Por qué importa en 2026: **MCP dejó de ser "cosa de Anthropic" para ser el estándar de facto cross-vendor**. OpenAI lo integró oficialmente en su Agents SDK y en ChatGPT (marzo 2025). Google DeepMind lo soporta. Todos los IDEs mayores (Cursor, Windsurf, Zed, VS Code Copilot, JetBrains AI) lo integran. Vendors como Linear, Sentry, Notion, Stripe, Cloudflare, Atlassian publicaron sus MCP servers oficiales con OAuth. Existe un registro público (mcp.so, glama.ai, el oficial de Anthropic) con miles de servers. Si construyes un producto de IA en 2026 y no consideras MCP, estás fuera del mainstream.

Sin MCP: reescribirás integraciones ya resueltas, tu app quedará aislada del ecosistema, y no aprovecharás la separación de concerns entre lógica del agente y proveedores de contexto/capacidades. Con MCP: expones tus datos internos una vez, y son accesibles desde Claude Desktop, Cursor, ChatGPT sin cambios; consumes el ecosistema (github MCP, postgres MCP, filesystem MCP) sin reimplementarlo.

Este capítulo cubre los internals: arquitectura Host/Client/Server, las 6 primitives (resources, tools, prompts + sampling, roots, elicitation), los transports (stdio local, Streamable HTTP remoto), autenticación OAuth 2.1, versionado de spec, seguridad, y un ejemplo end-to-end de crear tu propio MCP server en Python con FastMCP y conectarlo a Claude Desktop.

## 2. Fundamentos (nivel básico)

### 2.1 Arquitectura Host / Client / Server

```
┌─────────────────────────────────────────────────────┐
│  HOST (Claude Desktop, Cursor, ChatGPT Desktop...)  │
│                                                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐             │
│  │ Client1 │  │ Client2 │  │ Client3 │  ← 1 por server
│  └────┬────┘  └────┬────┘  └────┬────┘             │
└───────┼────────────┼────────────┼──────────────────┘
        │ stdio/HTTP │ stdio      │ HTTP
        ▼            ▼            ▼
   ┌──────────┐ ┌─────────┐ ┌──────────┐
   │ Server:  │ │ Server: │ │ Server:  │
   │filesystem│ │  github │ │ postgres │
   └──────────┘ └─────────┘ └──────────┘
```

- El **host** es la app IA — mantiene la conversación con el LLM.
- Los **clients** (uno por server) son componentes internos del host que hablan JSON-RPC con los servers.
- Los **servers** son procesos separados que exponen primitives.

Esta separación es intencional: cada server corre en su propio proceso, lo que da aislamiento de fallos, seguridad (un server malicioso no ejecuta en el proceso del host), y libertad de lenguaje (un server puede estar en Rust, otro en Python, otro en Node).

**Analogía útil:** MCP funciona como **USB-C para aplicaciones de IA** (analogía oficial de Anthropic). El host es tu portátil, cada client es un puerto USB-C, y cada server es un dispositivo (monitor, disco externo, teclado). El "protocolo" garantiza que enchufes un monitor Dell en un puerto de un MacBook sin drivers especiales. Análogamente: enchufas un GitHub MCP server en Claude Desktop, Cursor o ChatGPT — todos entienden el mismo protocolo y muestran las mismas tools. Antes de USB-C tenías HDMI, VGA, DVI, DisplayPort, Thunderbolt, cada uno con su cable; antes de MCP tenías integraciones custom, plugins, extensions, cada una con su API.

**Analogía técnica alternativa:** MCP es a las apps de IA lo que **LSP (Language Server Protocol)** es a los editores. Un solo `rust-analyzer` funciona en VS Code, Vim, Zed, JetBrains porque hablan LSP. Un solo `github-mcp-server` funciona en Claude Desktop, Cursor, ChatGPT porque hablan MCP. La estandarización mata el N×M.

### 2.2 Las 3 primitives cliente-facing

MCP separa explícitamente qué expone un server, con semántica clara:

| Primitive | Qué es | Análogo REST | Quién invoca |
|---|---|---|---|
| **Resources** | Datos de solo lectura, identificados por URI | GET | Usuario (via picker) o modelo |
| **Tools** | Acciones ejecutables con side effects | POST | Modelo (durante razonamiento) |
| **Prompts** | Templates parametrizables reusables | (no aplica) | Usuario (via slash-command) |

Ejemplo mental para un server GitHub MCP:
- **Resource:** `github://repo/pr/123` — leer contenido de un PR (URI-addressable).
- **Tool:** `create_issue(title, body)` — crear un issue (side effect).
- **Prompt:** `analyze_pr(pr_url)` — template "analiza este PR buscando X, Y, Z", el usuario lo invoca desde un menú del host.

**Ejemplo concreto de las 3 primitives coexistiendo** (server Postgres):

```python
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("postgres-analytics")

@mcp.resource("postgres://schema/{table}")
def get_schema(table: str) -> str:
    """Devuelve el DDL de la tabla — RESOURCE porque es lectura por URI."""
    return db.execute(f"SHOW CREATE TABLE {table}").fetchone()[0]

@mcp.tool()
def run_analytics_query(sql: str) -> dict:
    """Ejecuta SELECT sobre el warehouse — TOOL porque el modelo decide cuándo/qué."""
    if not sql.strip().lower().startswith("select"):
        return {"error": "solo SELECT permitidas"}
    return {"rows": db.execute(sql).fetchall()[:100]}

@mcp.prompt()
def analyze_query_perf(query: str) -> list[dict]:
    """PROMPT invocable por el usuario desde /analyze_query_perf en el host."""
    return [{"role": "user", "content": f"EXPLAIN ANALYZE la siguiente query "
                                        f"y sugiere índices:\n\n{query}"}]
```

Diferencia UX en el host: los **resources** aparecen en un @-picker para que el usuario los adjunte manualmente; las **tools** se ejecutan por decisión del modelo dentro del razonamiento; los **prompts** aparecen como slash-commands o menús que el usuario invoca directamente.

### 2.3 Las 3 primitives server → client (menos conocidas)

MCP también permite al server pedir cosas al host:

| Primitive | Qué hace | Ejemplo |
|---|---|---|
| **Sampling** | Server pide al host que ejecute un LLM completion | Server "summarize_doc" pide al host que llame al modelo del usuario |
| **Roots** | Host informa al server qué directorios/URIs son el workspace | Filesystem server sabe qué carpetas puede tocar |
| **Elicitation** | Server pide input al usuario en runtime (spec 2025-06-18) | Server "deploy_prod" pide confirmación con un form |

Estas primitives evitan que cada server tenga que traer su propio API key de LLM (sampling), definir manualmente sus boundaries de acceso (roots), o construir UI propia (elicitation).

### 2.4 Ejemplo mínimo: MCP server en Python con FastMCP

FastMCP (incluido en el paquete `mcp` oficial desde 2025) da un DX pythonico:

```python
# server.py
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("hello-world")

@mcp.tool()
def add(a: int, b: int) -> int:
    """Suma dos números enteros."""
    return a + b

@mcp.resource("greeting://{name}")
def greeting(name: str) -> str:
    """Devuelve un saludo personalizado."""
    return f"Hola, {name}!"

if __name__ == "__main__":
    mcp.run()  # stdio transport por defecto
```

Ejecutas con `python server.py` — se comunica por stdio.

### 2.5 Registrar el server en Claude Desktop

Cada cliente MCP tiene su forma de registrar servers. Claude Desktop usa un JSON:

```json
{
  "mcpServers": {
    "hello-world": {
      "command": "python",
      "args": ["/absolute/path/to/server.py"]
    }
  }
}
```

Ubicaciones:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Tras editar, reinicia Claude Desktop. Verás las tools/resources del server disponibles.

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Transports: stdio vs Streamable HTTP

MCP soporta dos transports principales en 2026:

**Stdio (proceso local):**
- El host spawnaea el server como subproceso.
- Mensajes JSON-RPC por stdin/stdout.
- Sin overhead, sin auth, sin puertos.
- Ideal para tools locales: filesystem, git, sqlite.

**Streamable HTTP (introducido spec 2025-03-26):**
- Reemplazó el diseño anterior HTTP+SSE que tenía dos endpoints separados y problemas con proxies/load balancers.
- Un solo endpoint `/mcp` maneja request/response Y streaming.
- Soporta sessions, resumability, y OAuth 2.1.
- Recomendado para servers remotos (Linear, Notion, Sentry oficiales lo usan).

Comparativa ampliada:

| Aspecto | Stdio | Streamable HTTP |
|---|---|---|
| Latencia p50 | <1 ms (pipe local) | 20-200 ms (red) |
| Auth | Ninguna (local) | OAuth 2.1 con PKCE |
| Escalado | 1 usuario / 1 proceso | Multiusuario, horizontal |
| Concurrencia | 1 sesión | N sesiones simultáneas |
| Debugging | stderr logs | HTTP logs + traces + inspector |
| Uso típico | filesystem, git, local tools | Vendors, SaaS integrations |
| Deployment | Spawn del host | Docker, k8s, Cloudflare Workers, Lambda |
| Persistencia | Estado en memoria del proceso | Sessions con `Mcp-Session-Id` header |
| Coste hosting | 0 | Compute + egress |
| Madurez (2026) | GA desde spec 2024-11-05 | GA desde spec 2025-03-26 |
| Reconexión | N/A | Resumability con event IDs |

### 3.2 El handshake `initialize` y capability negotiation

Toda conexión MCP empieza con un `initialize` request. Cliente y server anuncian:
- Qué **versión de spec** entienden (`2025-06-18`, `2025-11-25`, etc.).
- Qué **capabilities** soportan (tools, resources, prompts, sampling, roots, elicitation, subscribe).

Ejemplo (JSON-RPC simplificado):

```json
// Cliente → Server
{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {},
      "elicitation": {}
    },
    "clientInfo": { "name": "claude-desktop", "version": "1.5.0" }
  }
}

// Server → Cliente
{
  "jsonrpc": "2.0", "id": 1, "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "prompts": {}
    },
    "serverInfo": { "name": "my-server", "version": "1.0.0" }
  }
}
```

Esto habilita evolución no-breaking: un cliente nuevo con features nuevas puede seguir hablando con un server viejo, respetando lo que el server declaró.

### 3.3 Diferencia práctica entre Resources y Tools

Escenario: MCP server para GitHub. Tienes:
- `get_pull_request(pr_id)` — consulta info.
- `merge_pull_request(pr_id)` — hace merge.
- Contenido de archivos de un PR por URI `github://repo/pr/123/files/foo.ts`.

Clasificación correcta:
- **Contenido de archivos** → RESOURCE (URI-addressable, solo lectura).
- **get_pull_request** → puede ser RESOURCE (`github://repo/pr/123`) o TOOL — depende de si tiene URI natural.
- **merge_pull_request** → TOOL (side effect).

Por qué importa la distinción: el host trata resources y tools diferente en UX. Cursor y Claude Desktop muestran **resources en un picker @-mention** para que el usuario los adjunte manualmente. Tools se ejecutan por decisión del modelo. Regla: side effect → tool; solo lectura con URI natural → resource.

### 3.4 Sampling — server pide LLM al host

Escenario: escribes un MCP server con una tool `summarize_document(doc_id)` que necesita generar texto. ¿El server trae su propio cliente de OpenAI y su API key?

**No** — usa **sampling**, capability opcional del server que pide al HOST ejecutar un completion. Ventajas:
- El server no maneja API keys.
- El billing es del usuario, no del server.
- El modelo elegido es el del usuario.
- El usuario mantiene control (aprueba/rechaza/edita).

```python
# En un MCP server con FastMCP
@mcp.tool()
async def summarize_document(ctx: Context, doc_id: str) -> str:
    doc_text = load_document(doc_id)
    # Server pide al host que llame al modelo
    result = await ctx.session.create_message(
        messages=[{"role": "user",
                   "content": {"type": "text", "text": f"Resume:\n\n{doc_text}"}}],
        max_tokens=500,
    )
    return result.content.text
```

### 3.5 Elicitation — server pide input al usuario (spec 2025-06-18)

Escenario: tu tool `create_deployment(env)` requiere confirmación humana ("¿deployar a prod?") o parámetros adicionales. Antes de 2025 tenías que hacer UI propia. Con **elicitation**:

```python
@mcp.tool()
async def create_deployment(ctx: Context, env: str) -> str:
    if env == "production":
        # Server pide al cliente que solicite input al usuario
        result = await ctx.session.elicit(
            message="Confirma deploy a PRODUCCIÓN",
            requestedSchema={
                "type": "object",
                "properties": {
                    "confirmed": {"type": "boolean"},
                    "reason": {"type": "string"}
                },
                "required": ["confirmed"]
            }
        )
        if not result.get("confirmed"):
            return "Deploy cancelado por el usuario."
    return deploy(env)
```

El cliente renderiza UI nativa (form, dialog) apropiada al host. Añadida en spec 2025-06-18, ya soportada por Claude Desktop, Cursor y ChatGPT.

### 3.6 Roots — el workspace comunicado al server

Escenario: filesystem MCP server. En Claude Code el usuario abre `/Users/x/proj-a` y otro proyecto en `/Users/x/proj-b`. Quieres que el server sepa qué directorios son parte del workspace y NO acceda fuera.

Solución: **roots**. El cliente informa al server los URIs (típicamente `file://`) que forman el workspace. El server:
- Valida cada `read_file` contra los roots.
- Enumera contenido solo dentro de los roots.
- Escucha notifications cuando el usuario cambia de workspace.

Es la primitive de seguridad para servers que operan sobre datos locales.

### 3.7 Diagrama ASCII: ciclo de vida completo de una sesión MCP

```
tiempo ▼
   ┌─────────┐                                            ┌─────────┐
   │  HOST   │                                            │ SERVER  │
   └────┬────┘                                            └────┬────┘
        │  spawn (stdio) o HTTP connect                       │
        ├────────────────────────────────────────────────────►│
        │                                                     │
        │  initialize {protocolVersion, capabilities}         │
        ├────────────────────────────────────────────────────►│
        │  ◄────────── result {version, capabilities} ────────┤
        │                                                     │
        │  notifications/initialized                          │
        ├────────────────────────────────────────────────────►│
        │                                                     │
        │  tools/list                                         │
        ├────────────────────────────────────────────────────►│
        │  ◄────────── result {tools: [...]} ─────────────────┤
        │                                                     │
        │  tools/call {name:"query", args:{...}}              │
        ├────────────────────────────────────────────────────►│
        │                                                     │  (server ejecuta,
        │  ◄────── notifications/progress {50%} ──────────────┤   emite progreso)
        │  ◄────── notifications/progress {100%} ─────────────┤
        │  ◄────── result {content: [...]} ───────────────────┤
        │                                                     │
        │  (server pide sampling al host)                     │
        │  ◄────────── sampling/createMessage ────────────────┤
        │  ──── result {content: llm_output} ────────────────►│
        │                                                     │
        │  shutdown / SIGTERM                                 │
        ├────────────────────────────────────────────────────►│
        │                                                     │  (cleanup, exit)
```

### 3.8 Bajo el capó: cómo se ensamblan tools MCP en el prompt del LLM

Cuando el host recibe `tools/list` del server, no envía el schema al modelo directamente. Convierte cada tool MCP a la representación nativa del proveedor:

- **En Anthropic:** cada tool MCP se serializa como bloque de tool definition estándar del SDK Anthropic. El host inyecta un prefijo al `name` (típicamente `<server>__<tool>` como `github__create_issue`) para evitar colisiones cuando hay múltiples servers activos.
- **En OpenAI (Agents SDK):** conversión a `type: "function"` con `function.name`, `function.description`, `function.parameters` (el JSON Schema del `inputSchema`).
- **En Gemini:** conversión a `FunctionDeclaration` con equivalencias de tipos.

El coste en tokens es no despreciable: 20 tools MCP típicas ~= 3000-6000 tokens de prefijo. Por eso:

1. **Prompt caching es crítico.** Anthropic marca el bloque de tools como cacheable; hits del 90%+ en agentes conversacionales.
2. **Tool budget importa.** Con >30 tools totales (sumadas de todos los servers), la accuracy de selección degrada según papers de 2024-2025. Práctica común 2026: **tool-routing** — un clasificador barato (Haiku, gpt-nano) al inicio decide qué subset de 5-10 tools cargar para esta conversación.
3. **Namespacing evita ambigüedad.** Si `filesystem` y `github` ambos exponen `search`, sin prefijo el modelo elige mal el 30-40% de las veces. Con `filesystem__search` y `github__search` la ambigüedad desaparece.

El transport (stdio vs HTTP) es transparente al modelo — solo cambia latencia y modo de auth. El modelo ve exactamente el mismo schema.

Un detalle relevante para debugging: **cada call a `tools/call` es un round-trip JSON-RPC completo**, no un stream. Si tu tool tarda 30 s, ese round-trip bloquea 30 s (con `notifications/progress` opcional para UX). Streamable HTTP no significa que las tools streamen output — significa que la conexión HTTP soporta múltiples respuestas en flight; las tools individuales siguen siendo request/response.

## 4. Práctica avanzada (nivel senior)

### 4.1 Errores comunes al escribir un server

Cuatro bugs canónicos de primera implementación:

1. **Crash al recibir request desconocido** — implementa handlers robustos que devuelvan JSON-RPC error, no lancen excepción sin controlar.
2. **tool_result como string enorme sin estructura** — devuelve `content: [{type: "text", text: "..."}]` o `image`, `resource`; nunca strings raw gigantes.
3. **Procesos zombie tras reiniciar el cliente** — implementa handler de SIGTERM/close para cleanup (cerrar DB, sockets).
4. **Logs contaminando stdout y rompiendo el protocolo** — con stdio transport, TODO log va a **stderr**. Cualquier `console.log` o `print` a stdout rompe el parseo JSON-RPC del cliente. Regla dura: en stdio, logs a stderr.

En Python:

```python
import logging
import sys

# CORRECTO: stderr
logging.basicConfig(stream=sys.stderr, level=logging.INFO)

# INCORRECTO: rompe el protocolo stdio
# print("debug info")  ← NUNCA
```

En Node:

```javascript
console.error("debug info");  // OK (stderr)
// console.log("...")  ← ROMPE stdio
```

### 4.2 Autenticación en servers remotos con OAuth 2.1

Spec MCP 2025-03-26 estandarizó OAuth 2.1 con PKCE para servers HTTP remotos. Elementos:

1. **Discovery** — server publica metadata OAuth en endpoint conocido (`/.well-known/oauth-authorization-server`).
2. **Dynamic Client Registration** — cliente MCP puede registrarse dinámicamente si el server lo permite (RFC 7591).
3. **PKCE obligatorio** — protege contra intercept del authorization code.
4. **Bearer tokens** en `Authorization` header.
5. **Scopes** declarados por el server, expuestos al usuario en consent screen.
6. **Resource Indicators** (RFC 8707) — requerido desde spec 2025-06-18.

Los servers oficiales de Linear, Notion, Sentry en 2026 usan este flow. Cloudflare publicó guías para deployar MCP servers en Workers con OAuth. Anthropic actualizó Claude Desktop y Cursor para abrir el browser en el flow OAuth y volver al app con el token.

**Anti-patrón:** API keys estáticas en la config del cliente. Frágiles (rotación dolorosa, exposición si se filtra el JSON) y sin scopes finos.

### 4.3 Prompt primitive: cuándo aprovecharla

Muchos equipos ignoran los prompts. Escenario típico donde brillan: tu equipo tiene 4 flujos comunes ("summarize this PR", "draft release notes", "security review file", "analyze SQL query"). Los usuarios copipegan templates largos cada vez.

Solución: exponer como PROMPTS en un MCP server. Cada prompt declara nombre, description, argumentos parametrizables. El host los muestra al usuario como slash-commands o menús. El usuario elige, el host aplica el template con los args, y el resultado se inserta como turno del usuario.

```python
@mcp.prompt()
def analyze_pr(pr_url: str, focus: str = "security") -> list[dict]:
    """Analiza un PR con foco especificado."""
    return [
        {"role": "user", "content": f"""
Analiza el siguiente PR con foco en {focus}:

{pr_url}

Provee:
1. Resumen de cambios
2. Riesgos identificados
3. Recomendaciones
"""}
    ]
```

Claude Desktop y Cursor exponen los prompts como slash-commands. Reduce copy-paste y mantiene templates centralizados en git.

### 4.4 Composición: múltiples servers activos + namespacing

Escenario: Claude Code con 5 MCP servers activos (filesystem, git, github, postgres, jira). Cada uno expone `list`, `search`, `create`. El modelo se confunde.

Soluciones:
1. **Host namespacing** — la mayoría de hosts prefijan tool names con el server (`github__create_issue`).
2. **Nombres específicos por convención** — `search_issues`, `search_pull_requests` en vez de `search`.
3. **Descripciones discriminantes** — dejar claro en la description qué contexto cubre cada tool.
4. **Tool budget** — con >30 tools, degradación de selection accuracy. Considera dividir en sub-agentes o rotar servers activos por contexto.

### 4.5 Notifications y streaming (progress + messages)

Para tools long-running (`run_test_suite()` de minutos), el cliente puede pedir progreso enviando en `_meta.progressToken`. El server emite `notifications/progress` con `{progressToken, progress, total}`. El cliente muestra progress bar.

```python
@mcp.tool()
async def run_tests(ctx: Context) -> str:
    total = 100
    for i in range(total):
        await run_single_test(i)
        await ctx.report_progress(i, total)  # notification al cliente
    return f"Passed {total} tests"
```

También: `notifications/message` con severity para logs, `notifications/resources/updated` para changes en resources, `tools/list_changed` para cambios en el catálogo de tools.

### 4.6 Seguridad: sandboxing y allow-list de servers

Modelo de seguridad de MCP:

1. **Aislamiento** — stdio da proceso separado por default.
2. **Allow-list** — enterprises aprueban lista corta de servers de vendors confiables.
3. **Sandboxing adicional** — Docker, gVisor, App Sandbox del OS para servers de terceros.
4. **OAuth scopes revisados** — evitar servers que piden scopes excesivos.
5. **Human-in-the-loop** para acciones destructivas o high-value.
6. **Logging/audit** de tool calls.
7. **Network egress control** (proxy) para prevenir exfiltración.

En 2025 hubo reportes de MCP servers maliciosos en marketplaces no oficiales exfiltrando datos. Anthropic añadió permission prompts más granulares en Claude Desktop 2025. OWASP tiene guía específica de LLM+MCP en su LLM Top 10.

### 4.7 Versionado del protocolo

MCP versiona por fecha: `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`. Cada release documenta 'Changes since previous version'. El handshake `initialize` negocia la versión más alta común.

Historia relevante:
- **2024-11-05:** primera spec pública.
- **2025-03-26:** Streamable HTTP + OAuth 2.1 authorization framework.
- **2025-06-18:** Elicitation, Structured Tool Output, Resource Links in tool results, MCP-Protocol-Version header required, removed JSON-RPC batching.
- **2025-11-25:** ajustes de compatibilidad y refinamientos.

Un server viejo sigue funcionando con clientes nuevos porque el cliente respeta las capabilities anunciadas.

## 5. Ejemplo práctico completo — MCP server SQLite con FastMCP + Claude Desktop

Vamos a crear un MCP server que expone una base SQLite: 1 tool `query`, 1 resource `schema://tables`, 1 prompt `explain_table`. Luego lo registramos en Claude Desktop.

**Decisiones de diseño (por qué antes del qué):**

- **SQLite en `~/mcp-demo.db`:** cero setup, cross-OS, un solo archivo. En prod usarías Postgres/DuckDB, pero SQLite mantiene el ejemplo enfocado en MCP, no en infra de DB.
- **`query` como TOOL (no resource):** el SQL cambia según intención del modelo — es acción, no lectura URI-addressable. Y solo permite `SELECT` para evitar side effects destructivos.
- **`schema://tables` como RESOURCE:** el schema es contenido estático URI-addressable — encaja perfecto con la semántica REST/GET.
- **`explain_table` como PROMPT:** el usuario lo invoca desde slash-commands cuando quiere una investigación estructurada; el modelo no lo elige por su cuenta.
- **Whitelist explícita de keywords vs Regex genérico:** rechazar `INSERT|UPDATE|DELETE|DROP|ALTER` con `startswith("select")` es más simple y auditable que un parser SQL completo. Sabiendo que hay bypass posible (`SELECT * FROM (INSERT ...)` en algunos dialectos), documentamos que este server es demo.
- **Logs a stderr desde el minuto 1:** en stdio transport, `print` a stdout rompe el protocolo. Es el bug canónico del 80% de servers primerizos.

### 5.1 El server

```python
# sqlite_mcp_server.py
"""
MCP server que expone una BD SQLite.
Ejecutar: python sqlite_mcp_server.py
Requiere: pip install "mcp[cli]"==1.13.0
"""
import sqlite3
import json
import sys
import logging
from pathlib import Path
from mcp.server.fastmcp import FastMCP

# LOGS SIEMPRE A STDERR — stdout es del protocolo JSON-RPC
logging.basicConfig(stream=sys.stderr, level=logging.INFO)
logger = logging.getLogger("sqlite-mcp")

DB_PATH = Path.home() / "mcp-demo.db"
mcp = FastMCP("sqlite-demo")

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Semilla la BD con datos demo si no existe."""
    if DB_PATH.exists():
        return
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER,
                             total REAL, created_at TEXT);
        INSERT INTO customers VALUES (1, 'Alice', 'alice@example.com'),
                                     (2, 'Bob', 'bob@example.com');
        INSERT INTO orders VALUES (1, 1, 42.50, '2026-08-01'),
                                  (2, 1, 15.00, '2026-08-05'),
                                  (3, 2, 99.90, '2026-08-10');
    """)
    conn.commit()
    conn.close()
    logger.info(f"Initialized {DB_PATH}")

# ============================================================
# TOOL: query — read-only SELECT
# ============================================================
@mcp.tool()
def query(sql: str, limit: int = 50) -> dict:
    """
    Ejecuta una query SELECT sobre la BD. NO permite INSERT/UPDATE/DELETE.
    Devuelve rows como lista de dicts + metadata.

    Args:
        sql: query SELECT válida
        limit: máximo de filas a devolver (default 50)
    """
    sql_lower = sql.strip().lower()
    if not sql_lower.startswith("select"):
        return {"error": "solo se permiten queries SELECT", "sql": sql}
    if any(kw in sql_lower for kw in ["insert", "update", "delete", "drop", "alter"]):
        return {"error": "keywords de modificación no permitidas", "sql": sql}

    conn = get_conn()
    try:
        cursor = conn.execute(sql)
        rows = [dict(r) for r in cursor.fetchmany(limit)]
        total_shown = len(rows)
        # Detectar si hay más
        has_more = cursor.fetchone() is not None
        return {
            "rows": rows,
            "count": total_shown,
            "has_more": has_more,
            "columns": [d[0] for d in cursor.description] if cursor.description else [],
        }
    except sqlite3.Error as e:
        return {"error": str(e), "sql": sql}
    finally:
        conn.close()

# ============================================================
# RESOURCE: schema://tables — lista de tablas y columnas
# ============================================================
@mcp.resource("schema://tables")
def list_schema() -> str:
    """Devuelve el schema de la BD como JSON."""
    conn = get_conn()
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    schema = {}
    for t in tables:
        cols = conn.execute(f"PRAGMA table_info({t['name']})").fetchall()
        schema[t["name"]] = [{"name": c["name"], "type": c["type"]} for c in cols]
    conn.close()
    return json.dumps(schema, indent=2)

# ============================================================
# PROMPT: explain_table — template para analizar una tabla
# ============================================================
@mcp.prompt()
def explain_table(table_name: str) -> list[dict]:
    """Genera un prompt para explicar una tabla de la BD."""
    return [
        {"role": "user", "content": {
            "type": "text",
            "text": f"""Consulta el resource schema://tables y la tabla '{table_name}'
usando la tool query. Luego:
1. Describe el propósito de la tabla.
2. Muestra un ejemplo de 3 filas.
3. Sugiere 2 queries útiles."""
        }}
    ]

if __name__ == "__main__":
    init_db()
    logger.info("Starting MCP server (stdio transport)...")
    mcp.run()
```

### 5.2 Registrar en Claude Desktop

Edita `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sqlite-demo": {
      "command": "python",
      "args": ["/absolute/path/to/sqlite_mcp_server.py"]
    }
  }
}
```

Reinicia Claude Desktop.

### 5.3 Debugging con MCP Inspector

Antes de conectar a Claude Desktop, prueba con el inspector oficial:

```bash
npx @modelcontextprotocol/inspector python sqlite_mcp_server.py
```

Se abre una web UI donde:
- Ves las tools/resources/prompts que el server expone.
- Puedes invocar cada tool manualmente con args.
- Ves el JSON-RPC crudo por debajo.
- Diagnósticas errores de handlers.

### 5.4 Uso desde Claude Desktop

En Claude Desktop, escribe:

> "Consulta la tabla customers de la BD sqlite-demo y dime cuántos clientes hay."

El modelo:
1. Detecta la tool `query` disponible via MCP.
2. La llama con `SELECT count(*) FROM customers`.
3. Recibe el resultado y responde.

También puedes:
- Adjuntar el resource `schema://tables` desde el picker @-mention.
- Invocar el prompt `explain_table` desde slash-commands.

### 5.5 Extender a HTTP remoto

Cambiar a Streamable HTTP para exponerlo remotamente:

```python
if __name__ == "__main__":
    init_db()
    # HTTP en puerto 8000 con endpoint /mcp
    mcp.run(transport="streamable-http", host="0.0.0.0", port=8000)
```

Registro en cliente:

```json
{
  "mcpServers": {
    "sqlite-remote": {
      "url": "https://my-server.example.com/mcp"
    }
  }
}
```

Para producción real: añadir OAuth 2.1 (Anthropic tiene templates y Cloudflare guías).

### 5.6 Verificaciones intermedias que deberías añadir

Antes de conectar a Claude Desktop, ejecuta estas comprobaciones en orden:

```bash
# 1. Sintaxis del server
python -c "import sqlite_mcp_server"  # sin errores = OK

# 2. Arranca en modo debug (no bloquea leyendo stdin)
python -c "from sqlite_mcp_server import mcp; print([t for t in mcp._tool_manager.list_tools()])"

# 3. Prueba con MCP inspector (esencial antes de Claude Desktop)
npx @modelcontextprotocol/inspector python sqlite_mcp_server.py

# 4. Verifica que logs van a stderr, no a stdout
python sqlite_mcp_server.py 2>/tmp/mcp.err &
sleep 1 && kill $!
cat /tmp/mcp.err  # deberías ver "Initialized ...", "Starting MCP server..."
```

En el código, añade asserts estratégicos:

```python
@mcp.tool()
def query(sql: str, limit: int = 50) -> dict:
    assert isinstance(sql, str), f"sql debe ser str, no {type(sql)}"
    assert 1 <= limit <= 1000, f"limit fuera de rango: {limit}"
    logger.info("query_start", extra={"sql_preview": sql[:80], "limit": limit})
    # ... resto ...
```

### 5.7 Extendiendo el ejemplo (mejoras para producción)

El server básico funciona pero un uso real necesita:

1. **Auth y multitenancy.** Cambia a `transport="streamable-http"` y añade middleware ASGI que valide JWT en `Authorization: Bearer` y aísle la DB por `tenant_id` extraído del token. Usa `Mcp-Session-Id` header para mantener contexto entre requests del mismo usuario.

2. **Read replicas para queries pesadas.** El `query` tool actual usa la única conexión. En prod:

   ```python
   READONLY_CONN = create_engine("postgresql://readonly@replica/db",
                                 pool_size=10, pool_pre_ping=True)

   @mcp.tool()
   def query(sql, limit=50):
       with READONLY_CONN.connect() as conn:
           # SET statement_timeout evita queries eternas
           conn.execute(text("SET statement_timeout = '15s'"))
           # ... resto ...
   ```

3. **Progress notifications en queries lentas.** Aprovecha `ctx.report_progress()` para mostrar barra de progreso mientras la query se ejecuta:

   ```python
   @mcp.tool()
   async def query(ctx: Context, sql: str, limit: int = 50) -> dict:
       await ctx.report_progress(0, 100, "Parsing SQL...")
       # ... ejecución ...
       await ctx.report_progress(100, 100, "Done")
       return {...}
   ```

4. **Row-level security con roots.** El cliente MCP puede declarar `roots` (por ejemplo `postgres://analytics_db/tenants/42`); el server valida cada query contra el prefijo permitido antes de ejecutar.

5. **Elicitation para queries destructivas.** Si en el futuro añades `INSERT`/`UPDATE`, usa `ctx.session.elicit()` para pedir confirmación antes de mutar; el usuario ve un dialog nativo del host y decide.

6. **Cache de schema.** El resource `schema://tables` no cambia entre queries; cachéalo con TTL 60s para evitar hits repetidos al `sqlite_master`. En Postgres, invalida via `LISTEN/NOTIFY` cuando alguien hace `ALTER TABLE`.

7. **Tests automatizados del server.** El SDK oficial provee `mcp.client.stdio.stdio_client` para escribir tests end-to-end:

   ```python
   async def test_query_returns_rows():
       async with stdio_client(server_params) as (read, write):
           async with ClientSession(read, write) as session:
               await session.initialize()
               result = await session.call_tool("query", {"sql": "SELECT 1 AS x"})
               assert result.content[0].text.startswith('{"rows"')
   ```

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **stdio para local, Streamable HTTP para remoto** — nunca uses HTTP+SSE viejo.
- ✅ **Logs a stderr en stdio transport**, siempre.
- ✅ **Declara solo las capabilities que usas** en `initialize`.
- ✅ **Side effect → tool; solo lectura con URI → resource; template usuario-invocable → prompt.**
- ✅ **OAuth 2.1 con PKCE para servers remotos multiuser.**
- ✅ **Roots para delimitar workspace** en servers que tocan filesystem.
- ✅ **Elicitation** para input runtime del usuario (mejor que UI propia).
- ✅ **Sampling** cuando el server necesita LLM (no traigas tu propia API key).
- ✅ **Prompt names y tool names específicos** — `search_issues`, no `search`.
- ✅ **Reference servers de Anthropic como plantillas** — filesystem, git, memory, sequential-thinking.

### Anti-patrones

- ❌ Poner `console.log`/`print` a stdout en un server stdio (rompe protocolo).
- ❌ Hardcodear API keys en el server (usa sampling o env vars).
- ❌ Un solo server MCP con 50+ tools (divide en sub-agentes o servers).
- ❌ Ejecutar servers untrusted in-process del cliente (usa aislamiento).
- ❌ Reinventar UI cuando puedes usar elicitation.
- ❌ Exponer todo como tool (usa resources para lecturas URI-addressable).
- ❌ Servers sin cleanup en SIGTERM (procesos zombie).
- ❌ Confiar en API keys estáticas para servers remotos (usa OAuth).
- ❌ Reescribir integraciones que ya existen en el ecosistema (mira mcp.so primero).

### Árbol de decisión: ¿MCP o tool calling directo?

```
¿Vas a compartir la integración con múltiples hosts?
  SÍ → MCP (portabilidad = valor)
  NO → ¿Consumes integraciones del ecosistema (github, postgres, etc.)?
        SÍ → MCP (aprovecha lo hecho)
        NO → ¿Es integración interna muy específica?
              SÍ → Tool calling directo (menos overhead)
              NO → MCP por defecto (menos lock-in a futuro)
```

## 7. Casos reales de la industria (2026)

1. **Anthropic anuncia MCP (25 nov 2024)**.
   - **Qué pasó:** blog post "Introducing the Model Context Protocol" con la analogía LSP/USB-C. Publicación simultánea de spec + SDKs Python/TypeScript + 5 reference servers (filesystem, git, github, sqlite, memory).
   - **Cómo se detectó su tracción:** Claude Desktop empezó a soportarlo el mismo día; en 2 semanas la comunidad publicó 200+ servers en `awesome-mcp-servers`.
   - **Lección industria:** un protocolo abierto con reference implementations serias tiene lift-off inmediato; sin SDKs de calidad, no hay adopción.

2. **OpenAI adopta MCP en Agents SDK (marzo 2025)**.
   - **Qué pasó:** OpenAI integró MCP nativamente en el Agents SDK y ChatGPT (agosto 2025 para desktop). Se unió al steering committee del protocolo.
   - **Impacto:** eliminó la incertidumbre "esto es solo cosa de Anthropic". A partir de aquí Google DeepMind, Microsoft, Meta empezaron a soportarlo.
   - **Lección:** cuando un competidor adopta tu protocolo, dejas de ser propietario y te vuelves estándar. Anthropic ganó al ceder gobernanza.

3. **Streamable HTTP reemplaza HTTP+SSE (spec 2025-03-26)** — resuelve problemas con proxies y load balancers. Cloudflare, Vercel, Neon publican guías de deployment. La versión anterior tenía dos endpoints separados (POST para request, GET+SSE para respuestas); rompía en muchas infraestructuras con reverse proxies estrictos y balanceadores L7. La nueva usa un solo endpoint `/mcp` con content-negotiation.

4. **Elicitation y Structured Tool Output (spec 2025-06-18)** — permite servers pedir input al usuario con schemas y devolver output tipado. Eliminó la necesidad de que cada server construyera UI propia para confirmaciones.

5. **Vendors mayores publican MCP servers oficiales (2025-2026)** — Linear, Sentry, Notion, Stripe, Cloudflare, Atlassian, GitLab, Neon, Supabase, PayPal, Square. Todos con OAuth 2.1. Consecuencia: la integración con SaaS es cuestión de 30 segundos (`claude mcp add ...`) en vez de escribir plugin.

6. **Claude Desktop Extensions (2025)** — instalación drag-and-drop de MCP servers empaquetados como `.dxt`. Cloudflare permite deploy en su edge network con OAuth completo.

7. **MCP SDK Python 1.13+ (2026)** — FastMCP como interfaz principal, soporte completo de sampling/elicitation/roots. Ergonomía tipo Flask/FastAPI.

8. **LangChain publica `langchain-mcp-adapters` (2025)** — LlamaIndex también. MCP y frameworks de agentes son complementarios: MCP para el transporte de tools, LangGraph para la orquestación del loop.

9. **Incidente Anthropic filesystem MCP con permisos laxos (2025 Q2)**.
   - **Qué pasó:** algunos usuarios de Claude Desktop configuraron el filesystem server con root `/` en macOS. Un prompt injection en un archivo README leído por el modelo intentó `write_file("~/.ssh/authorized_keys", "...")`.
   - **Cómo se detectó:** un researcher publicó proof-of-concept en Twitter; Anthropic respondió en 48h.
   - **Cómo se arregló:** hardening del filesystem reference server con validación estricta de roots + Claude Desktop añadió warnings prominentes al configurar roots amplios. Documentation actualizada con "never use / as root".
   - **Lección:** roots son la primitive de seguridad — no son opcionales, no son "para más tarde". Configurar el root correctamente es responsabilidad compartida host + server.

10. **Servers MCP maliciosos en marketplaces no oficiales (2025-2026)**.
    - **Qué pasó:** varios marketplaces third-party (no `mcp.so` ni el registry oficial) alojaron servers que exfiltraban tokens de otros servers activos vía sampling calls encubiertos.
    - **Cómo se detectó:** análisis de tráfico de un dev que notó llamadas HTTP a dominios sospechosos desde su Claude Desktop.
    - **Cómo se arregló:** Anthropic añadió consent screens explícitos y permission prompts granulares en Claude Desktop 2025.11. OWASP publicó guía específica LLM+MCP en el Top 10 LLM.
    - **Lección industria:** allow-list de servers para entornos enterprise; sandboxing adicional (Docker, gVisor) para servers de terceros; audit log de tool calls es obligatorio en compliance-sensitive.

## 8. Ejercicios prácticos

### Ejercicio 1 — Tu primer MCP server en Python

**Objetivo:** crear y correr un MCP server "hello world" con FastMCP.

**Pasos:**
1. Instala `pip install "mcp[cli]"==1.13.0`.
2. Crea `hello.py` con una tool `add(a, b)` y un resource `greeting://{name}`.
3. Corre con `python hello.py`.
4. Debugea con `npx @modelcontextprotocol/inspector python hello.py`.

**Criterios de éxito:**
- [ ] Inspector muestra la tool y el resource.
- [ ] Puedes invocar `add(2, 3)` y obtener 5.
- [ ] Puedes leer `greeting://Ale` y obtener "Hola, Ale!".

**Hints:**
- Si el inspector no muestra tus primitives, casi siempre es un `print` a stdout rompiendo el protocolo. Redirige stderr a un archivo (`python hello.py 2>/tmp/mcp.err`) y revisa.
- `mcp.run()` bloquea leyendo stdin — no lo llames sin transport listo; el inspector se encarga.
- Los type hints Python (`a: int, b: int`) se convierten automáticamente a JSON Schema en FastMCP.

**Solución de referencia (esbozo):**
```python
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("hello")

@mcp.tool()
def add(a: int, b: int) -> int:
    """Suma dos enteros."""
    return a + b

@mcp.resource("greeting://{name}")
def greeting(name: str) -> str:
    return f"Hola, {name}!"

if __name__ == "__main__":
    mcp.run()
```

**Bonus:** añade validación con Pydantic al input de `add`.

### Ejercicio 2 — Registrar en Claude Desktop

**Objetivo:** hacer que Claude Desktop use tu server.

**Pasos:**
1. Localiza `claude_desktop_config.json` según tu OS.
2. Añade tu server en `mcpServers`.
3. Reinicia Claude Desktop.
4. Verifica que aparece en el menú de tools.
5. Pídele algo que use la tool: "usa la tool add para sumar 12 y 30".

**Criterios de éxito:**
- [ ] El server aparece conectado en Claude Desktop.
- [ ] Claude llama la tool y obtiene resultado correcto.
- [ ] Logs del server salen por stderr, no rompen la comunicación.

**Hints:**
- La ruta debe ser ABSOLUTA (`/Users/tu/proj/hello.py`), no relativa. Claude Desktop no expande `~`.
- Si tienes `venv`, usa el intérprete del venv: `"command": "/Users/tu/proj/.venv/bin/python"`.
- Revisa el log del host (macOS: `~/Library/Logs/Claude/mcp*.log`) si algo falla; suele decir exactamente el error.

**Solución de referencia (esbozo):**
```json
{
  "mcpServers": {
    "hello": {
      "command": "/Users/tu/venv/bin/python",
      "args": ["/absolute/path/to/hello.py"],
      "env": {}
    }
  }
}
```

### Ejercicio 3 — Server con Streamable HTTP + auth simple

**Objetivo:** exponer tu server por HTTP con un header Bearer básico.

**Pasos:**
1. Cambia `mcp.run(transport="streamable-http", port=8000)`.
2. Añade middleware que valida `Authorization: Bearer <token>` con un token hardcoded.
3. Registra en Claude Desktop con `url` en vez de `command`.
4. Verifica que sin token, la conexión falla; con token, funciona.

**Criterios de éxito:**
- [ ] Server responde en http://localhost:8000/mcp.
- [ ] Requests sin auth fallan con 401.
- [ ] Requests con auth funcionan.

**Hints:**
- FastMCP acepta middleware ASGI si expones `mcp.streamable_http_app()` en vez de `mcp.run()`.
- El header exacto que envía Claude Desktop es `Authorization: Bearer <token>` — no `X-API-Key`.
- Prueba primero con `curl` antes de conectar el host: `curl -H "Authorization: Bearer test" http://localhost:8000/mcp`.

**Solución de referencia (esbozo):**
```python
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

class BearerAuth(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        auth = request.headers.get("authorization", "")
        if auth != "Bearer test-token-123":
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)

app = mcp.streamable_http_app()
app.add_middleware(BearerAuth)
# uvicorn.run(app, host="0.0.0.0", port=8000)
```

**Bonus:** implementa OAuth 2.1 con discovery real.

### Ejercicio 4 — Server con elicitation

**Objetivo:** usar elicitation para pedir confirmación al usuario.

**Pasos:**
1. Crea tool `delete_item(item_id)`.
2. Antes de borrar, llama `ctx.session.elicit()` pidiendo confirmación.
3. Solo borra si el usuario confirma.
4. Prueba en Claude Desktop.

**Criterios de éxito:**
- [ ] Cliente muestra dialog de confirmación.
- [ ] Cancelar aborta el delete.
- [ ] Confirmar ejecuta.

**Hints:**
- Elicitation requiere `capabilities.elicitation` en el handshake — FastMCP lo negocia automáticamente al usar `ctx.session.elicit()`.
- Si el host no soporta elicitation, cae en un resultado `null` o un error específico — maneja ambos casos.
- El schema del elicitation es JSON Schema estándar; los hosts renderizan `boolean` como toggle, `enum` como radio, `string` como input.

**Solución de referencia (esbozo):**
```python
@mcp.tool()
async def delete_item(ctx: Context, item_id: str) -> str:
    result = await ctx.session.elicit(
        message=f"¿Confirmar borrado de {item_id}?",
        requestedSchema={
            "type": "object",
            "properties": {"confirm": {"type": "boolean"}},
            "required": ["confirm"],
        }
    )
    if not (result and result.get("confirm")):
        return "cancelled"
    # ... borrado real ...
    return f"deleted {item_id}"
```

### Ejercicio 5 — Consumir un server oficial

**Objetivo:** conectar y usar el filesystem MCP server oficial de Anthropic.

**Pasos:**
1. Añade a `claude_desktop_config.json`:
   ```json
   {"mcpServers": {"filesystem": {
     "command": "npx",
     "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/tu/proj"]
   }}}
   ```
2. Reinicia Claude Desktop.
3. Pídele leer un archivo del proyecto.
4. Explora sus tools y resources.

**Criterios de éxito:**
- [ ] Ves los archivos del proyecto en el @-picker.
- [ ] Claude puede leer y buscar archivos.
- [ ] Verifica que respeta los roots (no accede fuera de `/Users/tu/proj`).

**Hints:**
- NUNCA pongas `/` o `~` como root — usa una carpeta específica del proyecto.
- Puedes pasar múltiples roots como argumentos posicionales: `["-y", "@modelcontextprotocol/server-filesystem", "/path1", "/path2"]`.
- Test de seguridad: pídele "lee /etc/passwd"; el server debe rechazar por estar fuera del root.

**Bonus:** añade otros reference servers (git, memory, sequential-thinking).

### Ejercicio 6 (RETO) — MCP server end-to-end con resource + tool + prompt + sampling

**Objetivo:** construir un server MCP `docs-assistant` completo que combine los 3 primitives cliente-facing más `sampling` para llamar al LLM del host.

**Setup:** `pip install "mcp[cli]==1.13.0"` + una carpeta local con markdowns tuyos.

**Pasos:**
1. **Resource** `docs://index` — devuelve JSON con `[{path, title, summary}]` de todos los `.md` en la carpeta.
2. **Tool** `search_docs(query: str)` — grep case-insensitive en los archivos; devuelve top-5 con snippets ±100 caracteres.
3. **Tool** `summarize_doc(path: str)` — usa `ctx.session.create_message()` (sampling) para pedir al host que genere un summary de 3 frases del contenido.
4. **Prompt** `explore_topic(topic: str)` — template que le pide al modelo: "Consulta docs://index, busca con search_docs, summariza los top-3 con summarize_doc".
5. Verifica en el inspector y luego en Claude Desktop.

**Criterios de éxito:**
- [ ] Los 3 primitives aparecen en el inspector.
- [ ] `summarize_doc` usa sampling y devuelve texto generado por el modelo del host.
- [ ] El prompt encadena las 3 primitives en una sesión coherente.
- [ ] Log del server muestra las llamadas sampling con `session.create_message` correctamente formateadas.

**Hints:**
- Para sampling, tu `@mcp.tool()` debe ser `async` y aceptar `ctx: Context` como primer argumento.
- Si el host no soporta sampling, `ctx.session.create_message()` lanza excepción — captura y devuelve fallback "resumen no disponible".
- Un buen `explore_topic` divide el trabajo en 3 pasos claros, no en un solo prompt gigante — el modelo trabaja mejor con estructura.

## 9. Recursos y siguientes pasos

### Referencias oficiales (2026)

- [modelcontextprotocol.io](https://modelcontextprotocol.io) — spec y docs oficiales.
- [MCP Specification 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/changelog) — elicitation, structured tool output.
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog) — última spec estable.
- [Anthropic — Introducing MCP (nov 2024)](https://www.anthropic.com/news/model-context-protocol) — anuncio original.
- [Reference servers repo](https://github.com/modelcontextprotocol/servers) — filesystem, git, github, memory, sequential-thinking, postgres, sqlite, puppeteer, brave-search, fetch, google-drive, slack.

### Papers y blogs relevantes

- ForgeCode — MCP 2025-06-18 Spec Update: AI Security, Structured Output, and User Elicitation.
- Elastic — The current state of MCP.
- Cloudflare Blog — Deploying MCP servers on Workers.

### Tools recomendadas 2026

- **`@modelcontextprotocol/sdk` 1.13+** (TypeScript) — SDK oficial.
- **`mcp[cli]` 1.13+** (Python) — SDK oficial con FastMCP.
- **`@modelcontextprotocol/inspector`** — debugger UI para tus servers.
- **mcp.so, glama.ai** — registries para descubrir servers.
- **awesome-mcp-servers** (GitHub) — curated list de la comunidad.
- **Cloudflare Workers + MCP** — hosting fácil de servers remotos.

### Qué leer después

- **[Cap 07 — Agent loops](./07-agent-loops-orchestration.md)** — cómo orquestar agentes que consumen múltiples MCP servers.
- **[Cap 08 — Code agents](./08-code-agents-computer-use.md)** — Claude Code, Cursor y su uso de MCP.
- **[Cap 12 — Sandboxing y guardrails](./12-agent-sandboxing-guardrails.md)** — seguridad para servers MCP untrusted.

## 10. Preguntas de práctica

- **JSON de preguntas:** [`packages/content/src/tech/ai-programming/sim-06-mcp-model-context-protocol.json`](../../packages/content/src/tech/ai-programming/sim-06-mcp-model-context-protocol.json)
- **Ruta en la app:** `/programming/ai-programming/sim/ai-programming-sim-06-mcp-model-context-protocol`
- **20 preguntas** cubriendo: qué es MCP, primitives, transports, resources vs tools, sampling, elicitation, roots, auth OAuth 2.1, ecosistema 2026, versionado, seguridad, composición.

## Navegación

← [Cap 05 — Tool / Function calling](./05-tool-function-calling.md) · [Índice](./README.md) · [Cap 07 — Agent loops](./07-agent-loops-orchestration.md) →
