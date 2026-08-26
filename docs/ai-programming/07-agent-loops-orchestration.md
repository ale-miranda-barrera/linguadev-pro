# Capítulo 07 — Loops de agentes: ReAct, orquestación, multi-agent

> **Focus:** Cómo diseñar el loop de un agente: ReAct, planning explícito, límite de pasos, budget, multi-agent (supervisor, swarm, hierarchical), tradeoffs, cuándo NO usar agente.
> **Áreas:** Agentes + herramientas · Cost/Inference · **Preguntas:** 20 · **Tiempo:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar — pre-requisitos, glosario y setup

Antes de escribir tu primer loop necesitas tener claros los caps 04 (Tool use), 05 (Structured outputs) y 06 (MCP). Un agente sin tools bien definidas es un chat con delirios de grandeza. Un agente que no sabe validar el resultado de un tool call es un generador de bucles caros.

**Pre-requisitos:**
- Python 3.11+ (usaremos `asyncio`, `TypedDict`, `dataclass`) o Node 20+.
- Cuenta con crédito en Anthropic o OpenAI (agentes ReAct queman tokens rápido).
- Familiaridad con `try/except`, `async/await` y llamadas HTTP.
- Cap 04–06 leídos: un agente reutiliza esa maquinaria.

**Glosario mínimo (memorízalo antes de seguir):**

| Término | Definición operativa |
|---------|----------------------|
| **Agent** | LLM en loop que decide dinámicamente qué tool llamar hasta terminar. |
| **Workflow** | Pipeline con LLM invocado en pasos predefinidos por código. Determinista. |
| **ReAct** | Thought → Action → Observation → Thought → … Yao et al. 2022. |
| **Iteration / round / step** | Un ciclo completo del loop (Thought + Action + Observation). |
| **Budget** | Límite duro de iteraciones, tokens, coste USD o wall time. |
| **Handoff** | Un agente transfiere control (y contexto) a otro agente. |
| **Supervisor-worker** | Un agente orquesta y delega subtareas a agentes especializados. |
| **Checkpointer** | Persistencia del estado del agente para poder reanudar tras crash. |
| **HITL** | Human-in-the-loop: pausa para aprobación humana. |

**Setup (elige uno de los dos stacks):**

```bash
# Stack A: LangGraph (state machines, checkpointing, supervisor, swarm)
pip install "langgraph>=0.6" "langchain-anthropic>=0.3" "langchain-openai>=0.3" langgraph-checkpoint-sqlite

# Stack B: Anthropic + OpenAI SDKs raw (para entender qué hace LangGraph)
pip install "anthropic>=0.55" "openai>=1.60" "tenacity>=9.0" "rich>=13.9"

# Common: observability y coste
pip install "langsmith>=0.2" "opentelemetry-sdk>=1.30"

# Variables de entorno
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export LANGSMITH_API_KEY=ls_...  # opcional, para tracing
export LANGSMITH_TRACING=true
```

Verifica con un ping rápido:

```python
from anthropic import Anthropic
print(Anthropic().messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=32,
    messages=[{"role": "user", "content": "OK?"}]
).content[0].text)
```

Si eso responde, estás listo. Continúa.

---

## 1. El gran cuadro

Un **agente** es la generalización natural de "LLM + tools": en vez de un único round (`user → LLM → tool → LLM → answer`), el modelo decide en un loop cuántos rounds necesita, qué tools llamar, cuándo terminar. Es autonomía. Es también, si lo diseñas mal, una factura de $80 en una tarde y un servidor colgado. La diferencia con un workflow (donde tú programaste los pasos) es sutil pero crítica: en el workflow el LLM es un componente controlado; en el agente el LLM dirige. La regla de Anthropic en *Building effective agents* (diciembre 2024) es directa: **empieza siempre con un workflow; sube a agente solo cuando la ausencia de estructura te esté costando calidad o mantenimiento**.

El patrón base es **ReAct** (Yao et al., NeurIPS 2022): el modelo alterna Thought (razona qué hacer), Action (llama un tool con args estructurados) y Observation (el resultado que le devolvemos). Casi todo agente moderno es una variante: Claude tool use, OpenAI function calling, LangGraph nodes con LLM, Devin, Cursor Agent, Aider — todos ejecutan ReAct por debajo. Sobre esa base se construyen: **plan-and-execute** (primero un plan, luego ejecutor), **reflection** (auto-crítica y refinamiento), **supervisor-worker** (un jefe delega en especialistas), **swarm** (los agentes se pasan el turno), **debate** (múltiples agentes votan), **state machines** (LangGraph, transiciones explícitas). Ninguno es universalmente superior; cada uno cambia el trade-off entre flexibilidad, coste, latencia y predictibilidad.

Los problemas prácticos son universales y aparecen la primera vez que pones un agente en producción. **Budget**: sin `max_iterations`, `max_cost_usd` y `timeout_global`, un bug o un prompt injection facturan $100 antes de que te enteres. **Detección de loops semánticos**: misma tool con mismos args tres veces = señal roja. **Compresión de contexto**: agentes largos superan 100k tokens; hay que resumir turnos viejos, pinnear decisiones críticas, offloadear tool results grandes. **Checkpointing**: agentes de horas necesitan sobrevivir a deploys. **HITL**: acciones destructivas (`DROP TABLE`, `git push --force`, `stripe.charge`) requieren pausa. **Model routing**: correr Opus en los 20 rounds es tirar el dinero — usa Haiku/mini para pasos triviales.

En 2026 el estado del arte se ha consolidado en dos ejes: **frameworks de orquestación** (LangGraph 0.6+ con checkpointing nativo y supervisor prebuilts, OpenAI Agents SDK con handoffs, CrewAI para role-based) y **agentes de código productivizados** (Claude Code con sub-agentes anidados hasta profundidad 5, Devin, Cursor Background Agents con Firecracker microVMs). LangChain publicó **Deep Agents** en marzo 2026 como plantilla lista para producción sobre LangGraph. Los patrones de Anthropic (*prompt chaining*, *routing*, *parallelization*, *orchestrator-workers*, *evaluator-optimizer*) son ya la taxonomía compartida. Este capítulo te lleva desde el ReAct crudo hasta un supervisor multi-agent con budget, HITL y checkpointing.

Al terminar sabrás decidir cuándo usar agente (poco), cómo controlarlo cuando lo uses (mucho), y cómo evaluar si el que ya tienes en producción está funcionando o quemando dinero en bucle.

---

## 2. Fundamentos (básico)

### 2.1 Agente vs workflow — la decisión que ahorra dinero

**Workflow** = tú programas los pasos; el LLM se invoca en puntos concretos con inputs concretos. Ejemplo: `fetch(url) → llm.extract(html) → db.save(...)`. Predecible, testable con unit tests, barato.

**Agente** = el LLM decide en cada round qué tool llamar. Ejemplo: "investiga qué dice la comunidad de LangGraph 0.6". El LLM decide si buscar en Google, leer GitHub issues, resumir, buscar otra vez. Impredecible pero adaptable.

Regla operativa: **si puedes dibujar el diagrama de flujo en una servilleta, es un workflow**. Si el flujo depende de descubrimientos en runtime, es un agente.

**Ejemplo concreto lado a lado.** Imagina un pipeline de "clasificar un email de soporte y responderlo":

- **Como workflow (bueno para 90% de casos):**
  ```python
  def handle_email(email):
      category = llm.classify(email, categories=["billing", "tech", "sales"])
      template = TEMPLATES[category]
      draft = llm.render(template, email)
      return draft
  ```
  Dibujable en servilleta, testable con 5 unit tests, coste $0.005 por email.

- **Como agente (necesario si el flujo se ramifica en runtime):**
  ```python
  # Necesitas: consultar la DB del usuario, ver su historial, decidir si
  # abrir un ticket, escalar a humano, generar reembolso, etc.
  agent.run("Analiza este email y toma la acción apropiada", tools=[
      lookup_user, list_prev_tickets, check_refund_eligibility,
      create_ticket, escalate_to_human, draft_reply,
  ])
  ```
  No dibujable a priori porque cada usuario requiere ramificaciones distintas. Coste $0.08 por email pero cubre 95% sin humano.

### 2.2 Los tres componentes de un loop ReAct

Un loop ReAct tiene tres partes que se repiten:

```
┌─────────────┐
│   THOUGHT   │  El modelo razona: "Necesito X. Voy a llamar tool Y."
└──────┬──────┘
       ▼
┌─────────────┐
│   ACTION    │  Emite tool_call estructurado: search(query="LangGraph 0.6")
└──────┬──────┘
       ▼
┌─────────────┐
│ OBSERVATION │  Tu código ejecuta el tool y devuelve el resultado al modelo.
└──────┬──────┘
       │
       └──► loop hasta que el modelo emita `final_answer` o hit un budget.
```

El "Thought" en modelos modernos suele venir como `thinking` block (Claude extended thinking, GPT reasoning) o como texto libre antes del tool_call. En ambos casos: **verbaliza el razonamiento antes de actuar** = mejor accuracy y trazabilidad.

**Analogía útil:** ReAct es el **diálogo interno de un detective**. Sherlock Holmes no ve una escena y anuncia "el mayordomo lo hizo" — primero verbaliza ("observo barro tipo X, huellas de tacón, olor a tabaco cubano — thought"), luego actúa ("voy a interrogar a la cocinera — action"), luego observa el resultado ("negó nervioso, mencionó al mayordomo — observation"), y vuelve a pensar. Un agente ReAct hace exactamente lo mismo: sin la verbalización, el "razonamiento" se comprime en decisiones opacas de una sola línea; con ella, cada paso es debuggeable y el modelo mismo detecta cuando su plan no encaja con la evidencia.

Mini-ejemplo del "pensamiento" verbalizado (extended thinking de Claude):

```python
resp = client.messages.create(
    model="claude-sonnet-4-5-20250929",
    max_tokens=2048,
    thinking={"type": "enabled", "budget_tokens": 1024},
    tools=TOOLS,
    messages=[{"role": "user", "content": "..."}],
)
for block in resp.content:
    if block.type == "thinking":
        print(f"[THOUGHT] {block.thinking[:200]}...")
    elif block.type == "tool_use":
        print(f"[ACTION] {block.name}({block.input})")
```

### 2.3 Los tres límites duros que nunca deben faltar

Un agente sin límites es una bomba de facturación. Siempre configura:

1. **`max_iterations`** — típicamente 10–30 según tarea. Corta el loop entero.
2. **`max_cost_usd`** — típ. $0.50–$5 por task en producción. Corta cuando se acerca.
3. **`timeout_global_s`** — típ. 300–1800 s. Corta el wall clock.

Adicionales muy recomendables: `timeout_por_tool_s` (30–60 s), `max_tokens_context` (para forzar compresión antes de reventar la ventana), detección de loops semánticos.

### 2.4 Un ReAct mínimo (~40 líneas)

```python
from anthropic import Anthropic

client = Anthropic()

TOOLS = [{
    "name": "get_weather",
    "description": "Devuelve el clima actual de una ciudad.",
    "input_schema": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}]

def run_tool(name, args):
    if name == "get_weather":
        return {"city": args["city"], "temp_c": 15, "cond": "cloudy"}
    return {"error": f"unknown tool {name}"}

def react_loop(user_msg, max_iter=6):
    messages = [{"role": "user", "content": user_msg}]
    for step in range(max_iter):
        resp = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=1024,
            tools=TOOLS,
            messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason == "end_turn":
            return next(b.text for b in resp.content if b.type == "text")
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        tool_results = [{
            "type": "tool_result",
            "tool_use_id": tu.id,
            "content": str(run_tool(tu.name, tu.input)),
        } for tu in tool_uses]
        messages.append({"role": "user", "content": tool_results})
    return "ABORTED: max_iterations reached"

print(react_loop("¿Qué tiempo hace en París?"))
```

Esto es literalmente todo lo que hace un agente básico. El resto del capítulo es "cómo evitar que este loop te arruine".

### 2.5 Cuándo NO usar agente

Casos donde un workflow gana siempre:

- Extraer campos estructurados de un doc (workflow con structured output).
- Clasificar tickets en 5 categorías (single LLM call).
- Generar un email con plantilla + datos (prompt + templating).
- Traducir un texto (single call).
- Cualquier flujo con latencia p95 < 3 s como requisito.

Casos donde el agente aporta:

- Debugging de un stack trace (necesita explorar código, logs, docs).
- Research abierto ("compara 3 opciones de X y recomienda").
- Refactor multi-archivo con verificación (Claude Code, Cursor Agent).
- Investigación con múltiples fuentes web.
- Ejecución de tareas donde no puedes precodificar el árbol de decisiones.

---

## 3. Cómo funciona por dentro (medio)

### 3.1 Anatomía completa de un round

Un round de ReAct con Claude tool use produce esta estructura de mensajes:

```
Turno 1  (user):       "¿En qué carpeta está el config de nginx?"
Turno 2  (assistant):  [thinking?] + [text: "Voy a buscar."] + [tool_use: grep(pattern="nginx.conf", path="/etc")]
Turno 3  (user):       [tool_result: "/etc/nginx/nginx.conf"]
Turno 4  (assistant):  [text: "El config está en /etc/nginx/nginx.conf"]  → stop_reason=end_turn
```

El `stop_reason` te dice qué hacer:
- `end_turn` → terminó, devuelve respuesta.
- `tool_use` → hay tool_calls que ejecutar y devolver.
- `max_tokens` → truncó output; reintenta con más tokens o revisa prompt.
- `stop_sequence` → cadena de stop custom; solo si la configuraste.

### 3.2 Los cinco patrones canónicos de Anthropic

Anthropic (*Building effective agents*, dic 2024) codificó 5 workflows + 1 agent que cubren el 90% de casos:

| Patrón | Cuándo usar | Estructura | Coste típico | Latencia típica |
|--------|-------------|------------|--------------|-----------------|
| **Prompt chaining** | Tarea descomponible en N pasos secuenciales conocidos | `LLM(step1) → gate → LLM(step2) → ...` | N × single call | Suma secuencial |
| **Routing** | Query → clasificar → dispatch a handler especializado | `classifier → { handler_A, handler_B, ... }` | classifier barato + 1 handler | classifier + handler |
| **Parallelization** | Sub-tareas independientes o votación | N × LLM en paralelo → aggregator | N × single call | ≈ max(N) |
| **Orchestrator-workers** | Sub-tareas no conocidas a priori; worker LLMs con contexto propio | orchestrator → dynamic dispatch → workers → sync | orchestrator + N workers | orchestrator + max(workers) |
| **Evaluator-optimizer** | Necesitas iteración con crítica hasta cumplir criterio | generator → evaluator → { refine, accept } | 2-4× base | 2-4× base |
| **Autonomous agent** (freeform) | Sin estructura conocida, decisiones dinámicas | ReAct puro con tools + env + termination | 5-20× workflow | 3-10× workflow |

Anti-patrón: elegir "autonomous agent" cuando tu problema encajaba en routing o chaining. Es lo que pasa cuando alguien lee un tutorial de LangGraph y quiere aplicarlo a todo.

### 3.3 Plan-and-execute vs ReAct puro

**ReAct puro** decide next-step en cada iteración. Pro: adaptable. Contra: puede perder el "big picture" y meterse en callejones.

**Plan-and-execute** hace dos fases: un `planner` (modelo caro, `Opus`/`o1`) produce lista explícita de N pasos; un `executor` (modelo barato, `Haiku`/`mini`) ejecuta cada uno.

```
┌──────────┐   plan (JSON)   ┌────────────┐
│ PLANNER  ├────────────────►│  EXECUTOR  │──► loop N steps
│ (Opus)   │                 │  (Haiku)   │
└──────────┘                 └────────────┘
                                    │
                                    ▼
                          ┌─────────────────┐
                          │  RE-PLAN if     │
                          │  step failed    │
                          └─────────────────┘
```

Ventajas: plan visible antes de gastar tokens (humano puede revisar), ejecutor barato, paralelización posible. Desventajas: rigidez si el plan se equivoca (mitigación: re-plan cada N pasos o al detectar desviación).

Papers relevantes: **Plan-and-Solve** (Wang et al., 2023), **ReWOO** (separa planning de tool execution), **LLM Compiler** (parallel execution).

### 3.4 Reflection / self-critique / evaluator-optimizer

Después del output, pides al modelo (u a otro) que critique. Ganancia típica: **+15–30% accuracy** en tareas complejas; coste **2–4× tokens**.

```
generate ──► critique ──► accept? ──► YES ──► return
                             │
                             NO
                             ▼
                          refine ──► loop (max 3)
```

Paper canónico: **Reflexion** (Shinn et al., 2023). Anthropic lo llama *evaluator-optimizer*. Truco importante: usa **evaluador diferente del generador** (otro modelo o rules deterministas) para evitar sycophancy. En code agents, el "evaluator" natural es correr los tests.

### 3.5 Multi-agent: supervisor-worker, swarm, hierarchical

**Supervisor-worker** (a.k.a. orchestrator-workers): un supervisor recibe la tarea, la descompone, delega en workers especializados con context/tools propios, consolida resultados. LangGraph 0.6+ tiene `langgraph-supervisor` prebuilt.

```
        ┌──────────────┐
        │  SUPERVISOR  │  (Opus/GPT-5)
        └──────┬───────┘
      delega   │   consolida
    ┌──────────┼──────────┐
    ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│ RESEARCH│ │  CODE  │ │ WRITE  │  (Haiku/mini + tools específicas)
└────────┘ └────────┘ └────────┘
```

**Swarm** (OpenAI Swarm 2024 → OpenAI Agents SDK 2025): agentes se pasan control con `handoff` como tool. Sin supervisor central. Simple para N pequeño (2–5 agentes).

**Hierarchical**: supervisors de supervisors. Solo para tareas gigantes tipo research assistant. Empieza siempre con supervisor plano.

**Debate/ensemble**: N agentes generan en paralelo, otro sintetiza o vota. Ganancia 5–15% en tareas ambiguas verificables; coste N×.

### 3.6 Tabla de decisión: qué patrón para qué caso

| Caso | Patrón recomendado |
|------|--------------------|
| Extracción estructurada de docs | Workflow (single call structured output) |
| Query → especialistas de dominio | Routing |
| Research multi-fuente | Orchestrator-workers |
| Onboarding con estados fijos | State machine (LangGraph) |
| Chat de soporte con áreas (triage, tech, billing) | Swarm (2–3 handoffs) |
| Code editing multi-archivo | ReAct + tools + tests como evaluator |
| Análisis matemático crítico | Debate / self-consistency |
| Long-form generation con crítica | Evaluator-optimizer |

### 3.7 Compresión de contexto en agentes largos

Cuando el contexto crece (>50k tokens típicamente), calidad y coste se degradan (paper *Lost in the Middle*, Liu et al.). Estrategias combinadas:

- **Sliding window**: conserva últimos K turnos completos.
- **Summarization**: LLM barato resume turnos viejos periódicamente; resumen guardado como "system note".
- **Pinning**: decisiones críticas o requisitos marcados "no comprimir".
- **Offload**: tool results grandes van a storage externo, se referencian por ID.
- **Selective retrieval**: embeddings del historial, RAG sobre memoria propia.

LangGraph 0.6+ tiene helpers para summarization automática. Claude Code introduce *compaction* automática en sesiones largas.

### 3.8 Model routing para bajar coste sin perder calidad

Regla de Klarna/LangGraph 2026: **Supervisor con Opus/GPT-5; workers con Haiku/mini**. Ahorros de 60–70% sin impacto en routing reliability.

```
Task type              | Recomendado 2026
-----------------------|-------------------------
Planning + big picture | claude-opus-4.5 / gpt-5
Razonamiento complejo  | claude-sonnet-4-5 / gpt-5-mini
Extract / classify     | claude-haiku-4-5 / gpt-5-nano
Summarize / format     | claude-haiku-4-5 / gpt-5-nano
Final polish           | claude-sonnet-4-5
```

Librerías: **RouteLLM**, **Not Diamond**, **Portkey** (gateway con routing declarativo).

### 3.9 Diagrama ASCII: supervisor con checkpointing y HITL

```
                    ┌────────────────┐
                    │   CLIENT / UI  │
                    └────────┬───────┘
                             │  invoke(task, thread_id="user-42")
                             ▼
   ┌───────────────────────────────────────────────────────┐
   │              LangGraph app.invoke()                    │
   │  ┌──────────────────────────────────────────────────┐ │
   │  │  Checkpointer (SQLite/Postgres): thread_id=42   │ │
   │  │  step 0: {task: "...", plan: null, ...}         │◄┼── crash-safe
   │  │  step 1: {plan: [...]}                          │ │
   │  │  step 2: {results: [...], interrupted: HITL}    │ │
   │  └──────────────────────────────────────────────────┘ │
   │                                                        │
   │       START ─► supervisor ─┬─► research_worker ─┐     │
   │                            ├─► code_worker  ────┤     │
   │                            └─► approval_gate    │     │
   │                                    │            │     │
   │                                    ▼            ▼     │
   │                                interrupt()  results   │
   │                                    │            │     │
   │                                    ▼            ▼     │
   │                              (host UI)   ─► finalize  │
   │                                    │            │     │
   │                                    ▼            ▼     │
   │                          Command(resume=...)  END      │
   └───────────────────────────────────────────────────────┘
```

### 3.10 Bajo el capó: por qué un agente cuesta 5-20× más que un workflow

Un workflow con N pasos hace N llamadas al modelo, cada una con un contexto pequeño y bien delimitado. Un agente hace M rondas donde cada ronda re-envía TODO el historial acumulado + la definición de todas las tools + los tool results anteriores. Consecuencias directas:

1. **Crecimiento cuadrático de tokens.** Un agente que hace 10 rondas con 3 tools y ~2 KB de tool results por ronda envía ~50 KB en la ronda 10 (vs ~2 KB por ronda en un workflow lineal). Como el pricing es lineal en tokens y el input suele dominar, el coste crece como Θ(M²).

2. **KV-cache mitiga solo parcialmente.** El prompt caching de Anthropic/OpenAI reduce el coste de re-enviar el prefijo estable (system + tools + turnos previos hasta el último cache breakpoint), pero los tool_results nuevos rompen la cache continuamente. Ratio típico observado: cache hit del 60-85% en agentes con caching bien configurado; 0% sin él.

3. **Latencia acumulativa.** Cada ronda es un round-trip HTTP (100-300 ms) + tokens de generación (500-3000 ms) + ejecución de tool (variable). Un agente de 10 rondas típico tarda 30-90 s wall clock; un workflow equivalente de 3 llamadas tarda 5-10 s.

4. **Model routing es la palanca principal.** Ejemplo real de Klarna (blog 2026): supervisor Opus + workers Haiku ahorra 65% del bill vs Opus en todos los rounds, sin perder task success rate. Regla: usa el modelo caro solo donde el "razonamiento estratégico" añade valor; los pasos mecánicos (extract, format, classify) van con el barato.

5. **Contexto envejece mal.** Papers como *Lost in the Middle* (Liu et al. 2023) muestran que la accuracy en tareas de recall degrada cuando el contexto crece — un agente que acumula 80k tokens de historial rinde peor que uno con 8k tokens compactados. Compression (summarization periódica) y offload (guardar tool results grandes fuera y referenciar por ID) son técnicas obligatorias en agentes de larga vida.

Estos cinco factores explican por qué "un workflow con LLM llamado en pasos concretos" bate casi siempre al "agente freeform que decide todo" en coste, latencia y predictibilidad. El agente gana solo cuando la flexibilidad es lo que aporta valor.

---

## 4. Práctica avanzada (senior)

### 4.1 Trade-offs profundos

| Decisión | Ganas | Pierdes |
|----------|-------|---------|
| Agente sobre workflow | Flexibilidad | Coste 5–20×, latencia 3–10×, tests deterministas |
| Plan-and-execute sobre ReAct | Menos tokens, plan visible, paralelismo | Adaptabilidad si plan falla |
| Supervisor-worker sobre monolito | Aislamiento contexto, especialización, paralelismo | Coordinación overhead, latencia sync |
| Swarm sobre supervisor | Simplicidad para N pequeño | Políticas globales difíciles, ping-pong risk |
| Debate/ensemble | +5–15% accuracy en tareas ambiguas | N× coste, N× latencia |
| Reflection loop | +15–30% quality | 2–4× tokens |
| State machine sobre freeform | Predictibilidad, testabilidad, HITL fácil | Rigidez en flujos exploratorios |
| Context compression | Contexto largo posible | Pérdida de detalle (usa pinning) |

### 4.2 Detección de loops semánticos (más allá de max_iter)

`max_iterations` corta el gasto pero no detecta el problema. Añade:

```python
import hashlib

class LoopDetector:
    def __init__(self, max_repeat=3):
        self.max_repeat = max_repeat
        self.call_hashes = {}

    def _hash(self, tool_name, args):
        payload = f"{tool_name}:{sorted(args.items())}"
        return hashlib.sha1(payload.encode()).hexdigest()

    def register(self, tool_name, args):
        h = self._hash(tool_name, args)
        self.call_hashes[h] = self.call_hashes.get(h, 0) + 1
        if self.call_hashes[h] >= self.max_repeat:
            raise LoopDetected(f"tool {tool_name} llamado {self.max_repeat}× con mismos args")

class LoopDetected(Exception): pass
```

Al detectar: inyecta mensaje "estás en un loop, prueba otra estrategia" o corta con partial result. En LangGraph puedes hacerlo como interceptor en un nodo.

### 4.3 Budget tracking + cost caps

Instrumenta cada llamada al modelo:

```python
PRICING_PER_MTOK = {  # $ por millón de tokens (verifica en tu proveedor)
    "claude-opus-4-5":    {"in": 15.00, "out": 75.00, "cache_read": 1.50},
    "claude-sonnet-4-5":  {"in":  3.00, "out": 15.00, "cache_read": 0.30},
    "claude-haiku-4-5":   {"in":  0.80, "out":  4.00, "cache_read": 0.08},
}

def estimate_cost(usage, model):
    p = PRICING_PER_MTOK[model]
    return (usage.input_tokens * p["in"]
          + usage.output_tokens * p["out"]
          + getattr(usage, "cache_read_input_tokens", 0) * p["cache_read"]) / 1_000_000

class BudgetGuard:
    def __init__(self, max_usd=1.0):
        self.max_usd = max_usd
        self.spent = 0.0
    def add(self, usage, model):
        self.spent += estimate_cost(usage, model)
        if self.spent >= self.max_usd:
            raise BudgetExceeded(f"gastado ${self.spent:.4f} de ${self.max_usd}")

class BudgetExceeded(Exception): pass
```

Emite además métricas OpenTelemetry (`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.request.model`) con dimensiones `agent_id`, `session_id`, `tenant_id`, `feature_id` para poder facturar por uso y detectar outliers en Grafana.

### 4.4 Timeouts jerárquicos

```python
import asyncio

async def with_timeout(coro, seconds, name):
    try:
        return await asyncio.wait_for(coro, timeout=seconds)
    except asyncio.TimeoutError:
        return {"error": f"timeout {seconds}s en {name}"}  # NUNCA lanzar; devolver estructurado
```

Estructura:
- **Tool-level**: 5 s API rápida, 30 s scraping, 60–300 s deep computation.
- **Step-level**: 60–120 s por iteración del agente.
- **Session-level**: 300–1800 s hard cap.

Al hit un tool timeout, devuelve al modelo `{"error": "timeout"}` para que decida siguiente paso. Solo el session timeout corta la sesión.

### 4.5 Checkpointing y resumibilidad

Long-running agents necesitan sobrevivir a deploys y crashes. LangGraph 0.6+ con `SqliteSaver` o `PostgresSaver`:

```python
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import StateGraph

graph = StateGraph(MyState)
# ... nodos y edges ...
app = graph.compile(checkpointer=SqliteSaver.from_conn_string("checkpoints.db"))

# thread_id identifica la sesión
config = {"configurable": {"thread_id": "user-123-task-456"}}

# Ejecuta; si crashea, otro proceso puede resumir con el mismo thread_id
result = app.invoke({"input": "..."}, config)
```

Regla: si tu agente tarda >5 min, checkpointing es obligatorio.

### 4.6 HITL (human-in-the-loop) sin matar productividad

Clasifica acciones por riesgo:

| Riesgo | Ejemplo | Política |
|--------|---------|----------|
| Read-only | `search`, `fetch`, `read_file` | Auto |
| Write reversible | `create_pr_draft`, `add_comment` | Auto + log |
| Write irreversible / destructive | `deploy`, `DROP TABLE`, `stripe.charge`, `git push --force` | HITL obligatorio |

LangGraph 0.6+ con `interrupt()`:

```python
from langgraph.types import interrupt, Command

def deploy_node(state):
    approval = interrupt({"action": "deploy", "diff": state["diff"]})
    if approval == "approve":
        return {"deployed": True}
    return {"deployed": False, "reason": "rejected"}
```

El graph pausa; tu UI muestra al humano; humano manda `Command(resume="approve")`; graph continúa desde el checkpoint. Bulk-approve por política evita spam.

### 4.7 Evaluación de agentes (evals)

Agentes tienen múltiples "caminos correctos". Métricas:

- **Task success rate** (LLM-as-judge o humano). Objetivo canónico.
- **Steps to completion** (menos = mejor, típicamente).
- **Cost per task** ($ medio).
- **Latency p50/p95**.
- **Failure taxonomy**: tool_error, loop, giving_up, wrong_answer, timeout.

Stack recomendado 2026: **Braintrust**, **LangSmith**, **Phoenix (Arize)** o **Anthropic Inspect** (open source). CI: correr subset de evals en cada PR; bloqueo si regresión >5%.

### 4.8 Latencia percibida

Un agente de 30–60 s se siente eterno sin feedback. Combina:

1. **Streaming** de tokens (`stream=True`).
2. **Status updates semánticos** ("Consultando GitHub…", "Analizando 12 archivos…").
3. **Intermediate outputs** (drafts parciales).
4. **Eager first answer**: modelo rápido responde algo mientras el grande profundiza.
5. **Optimistic UI**.

Perplexity, ChatGPT, Claude Code invirtieron mucho aquí. La percepción se puede duplicar con feedback bueno.

### 4.9 Anti-patrones (los que ves en producción y duelen)

- **Agente sin `max_iterations`**. Factura $80 en un loop nocturno. Todos hemos pasado por eso una vez; nadie dos.
- **Mismo modelo top-tier en 20 rounds**. Bill 5× de lo necesario; ninguna ganancia de calidad.
- **`tool_choice="any"` con tools destructivas sin HITL**. Un prompt injection = catástrofe.
- **No detectar loops semánticos**. Agente pasa 10 iteraciones llamando `list_pages` con mismos args.
- **Multi-agent innecesario**. 5 agentes cuando 1 workflow bastaba: coordinación overhead, latencia sync, coste.
- **Sub-agentes que devuelven al padre 50k tokens de output raw**. Anulas el beneficio de contexto aislado.
- **No trazas ni evals**. "Me parece que va mejor" no es una métrica.
- **HITL en todo**. Mata productividad. Solo destructive.
- **State machine para tareas exploratorias**. Rigidez donde necesitabas flexibilidad.
- **Freeform agent para onboarding con 5 pasos fijos**. Rediseña como state machine.

---

## 5. Ejemplo práctico completo — ReAct agent con budget, loop detection y trazas

Vamos a construir un agente ReAct real (~100 líneas) con dos tools, todos los guardrails, y coste calculado por sesión. Luego lo migramos a LangGraph con supervisor.

**Decisiones de diseño (por qué antes del qué):**

- **Escribimos el ReAct desde cero antes que usar LangGraph:** entender el loop crudo evita el "cargo cult programming" con frameworks. Si sabes qué hace `graph.compile()` internamente, decides con criterio cuándo introducir un framework.
- **`Budget` como dataclass con `check()` explícito:** las excepciones controlan flujo mejor que retornos condicionales cuando quieres cortar en cualquier punto del loop. Y `BudgetExceeded` como excepción custom es fácil de catchear arriba.
- **`LoopGuard` por hash de `(name, args)` en vez de LRU cache:** un hash puro detecta "misma llamada N veces" independientemente de cuándo ocurrió. Un LRU por tiempo perdería el patrón si el modelo intercala otras tools.
- **Pricing hardcoded en constante:** para el ejemplo es aceptable; en prod cargarías desde un servicio de billing o config externa que se actualiza sin redeploy.
- **`system` prompt con "responde sin tool_use cuando tengas suficiente":** clave para que el modelo termine — sin esta pista, algunos modelos siguen llamando tools "por si acaso".
- **Trace estructurada:** cada step registra token counts, cost incremental, y stop_reason. Es la base para observabilidad y para el ejercicio 5 (evals).

### 5.1 ReAct crudo con guardrails (Python puro)

```python
"""
research_agent.py — ReAct con budget, loop detection, cost tracking.
"""
import asyncio, hashlib, json, time
from dataclasses import dataclass, field
from anthropic import Anthropic

MODEL = "claude-sonnet-4-5-20250929"
PRICING = {"in": 3.00, "out": 15.00, "cache_read": 0.30}  # $/Mtok

# ---------- Tools ----------
def tool_search(query: str) -> dict:
    fake_db = {
        "langgraph": {"version": "0.6", "release": "2026-02", "features": ["supervisor prebuilt", "durability"]},
        "e2b": {"version": "1.4", "p50_ms": 78, "isolation": "Firecracker microVM"},
    }
    for k, v in fake_db.items():
        if k in query.lower():
            return v
    return {"error": "not found"}

def tool_calc(expression: str) -> dict:
    try:
        allowed = "0123456789+-*/(). "
        if any(c not in allowed for c in expression):
            return {"error": "chars not allowed"}
        return {"result": eval(expression)}
    except Exception as e:
        return {"error": str(e)}

TOOLS_SPEC = [
    {"name": "search", "description": "Busca info sobre un tema tech.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "calc", "description": "Calcula una expresión aritmética simple.",
     "input_schema": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}},
]
TOOL_FNS = {"search": tool_search, "calc": tool_calc}

# ---------- Guardrails ----------
class BudgetExceeded(Exception): pass
class LoopDetected(Exception): pass

@dataclass
class Budget:
    max_iter: int = 8
    max_usd: float = 0.25
    max_wall_s: float = 60.0
    started_at: float = field(default_factory=time.time)
    iters: int = 0
    spent_usd: float = 0.0
    def check(self):
        if self.iters >= self.max_iter: raise BudgetExceeded(f"max_iter={self.max_iter}")
        if self.spent_usd >= self.max_usd: raise BudgetExceeded(f"cost ${self.spent_usd:.4f}")
        if time.time() - self.started_at >= self.max_wall_s: raise BudgetExceeded("wall_time")
    def add_cost(self, usage):
        c = (usage.input_tokens * PRICING["in"]
           + usage.output_tokens * PRICING["out"]) / 1_000_000
        self.spent_usd += c

@dataclass
class LoopGuard:
    max_repeat: int = 3
    seen: dict = field(default_factory=dict)
    def register(self, name, args):
        h = hashlib.sha1(f"{name}:{json.dumps(args, sort_keys=True)}".encode()).hexdigest()
        self.seen[h] = self.seen.get(h, 0) + 1
        if self.seen[h] >= self.max_repeat:
            raise LoopDetected(f"{name}({args}) x{self.max_repeat}")

# ---------- Loop ----------
def react(user_msg: str, budget: Budget, loop_guard: LoopGuard) -> dict:
    client = Anthropic()
    messages = [{"role": "user", "content": user_msg}]
    system = ("Eres un asistente de research. Usa las tools cuando aporten. "
              "Cuando tengas suficiente info, responde directamente sin tool_use.")
    trace = []
    while True:
        budget.iters += 1
        budget.check()
        resp = client.messages.create(
            model=MODEL, max_tokens=1024, system=system,
            tools=TOOLS_SPEC, messages=messages,
        )
        budget.add_cost(resp.usage)
        trace.append({"step": budget.iters, "stop": resp.stop_reason,
                      "in": resp.usage.input_tokens, "out": resp.usage.output_tokens,
                      "cost_usd": round(budget.spent_usd, 6)})
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason == "end_turn":
            text = next((b.text for b in resp.content if b.type == "text"), "")
            return {"answer": text, "trace": trace, "cost_usd": round(budget.spent_usd, 6)}
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        results = []
        for tu in tool_uses:
            loop_guard.register(tu.name, tu.input)
            out = TOOL_FNS[tu.name](**tu.input)
            results.append({"type": "tool_result", "tool_use_id": tu.id, "content": json.dumps(out)})
        messages.append({"role": "user", "content": results})

if __name__ == "__main__":
    try:
        out = react(
            "¿Qué versión de LangGraph es la actual y cuál es el p50 de creación de sandbox en e2b? Suma esos dos ms si aplica.",
            Budget(max_iter=6, max_usd=0.10, max_wall_s=30),
            LoopGuard(max_repeat=3),
        )
        print(json.dumps(out, indent=2, ensure_ascii=False))
    except (BudgetExceeded, LoopDetected) as e:
        print(f"ABORTED: {e}")
```

Ejecuta:

```bash
python research_agent.py
```

Salida esperada (los números exactos varían):

```json
{
  "answer": "LangGraph está en 0.6 y e2b crea sandboxes en 78 ms de mediana. La suma pedida es 78 ms más el timing de LangGraph (no aplica).",
  "trace": [
    {"step": 1, "stop": "tool_use", "in": 512, "out": 89, "cost_usd": 0.001871},
    {"step": 2, "stop": "tool_use", "in": 634, "out": 76, "cost_usd": 0.003191},
    {"step": 3, "stop": "end_turn", "in": 745, "out": 112, "cost_usd": 0.005096}
  ],
  "cost_usd": 0.005096
}
```

Aprendiste: budget hard cap, cost tracking, loop detection, trace estructurada. Esto es la base de todo agente serio.

### 5.2 Migración a LangGraph con supervisor y checkpointing

Cuando el agente crece a multi-role, LangGraph aporta state machine + checkpointing + HITL nativo:

```python
"""
supervisor_agent.py — supervisor con 2 workers y checkpointing.
"""
from typing import Annotated, Literal
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.sqlite import SqliteSaver
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, AIMessage

class State(TypedDict):
    task: str
    research: str
    code: str
    final: str

opus = ChatAnthropic(model="claude-opus-4-5-20250929", max_tokens=512)
haiku = ChatAnthropic(model="claude-haiku-4-5-20250929", max_tokens=512)

def supervisor(state: State) -> dict:
    prompt = (f"Tarea: {state['task']}\n"
              "Decide siguiente paso: 'research', 'code' o 'done'. Responde solo la palabra.")
    dec = opus.invoke([HumanMessage(prompt)]).content.strip().lower()
    return {"next": dec if dec in ("research", "code", "done") else "done"}

def research_worker(state: State) -> dict:
    r = haiku.invoke([HumanMessage(f"Investiga y resume en 2 frases: {state['task']}")]).content
    return {"research": r}

def code_worker(state: State) -> dict:
    ctx = state.get("research", "")
    c = haiku.invoke([HumanMessage(f"Con este contexto:\n{ctx}\nEscribe pseudocódigo (máx 10 líneas) para: {state['task']}")]).content
    return {"code": c}

def finalize(state: State) -> dict:
    text = f"# Research\n{state.get('research','')}\n\n# Code\n{state.get('code','')}"
    return {"final": text}

def route(state) -> Literal["research", "code", "done"]:
    return state.get("next", "done")

graph = StateGraph(State)
graph.add_node("supervisor", supervisor)
graph.add_node("research", research_worker)
graph.add_node("code", code_worker)
graph.add_node("finalize", finalize)
graph.add_edge(START, "supervisor")
graph.add_conditional_edges("supervisor", route, {"research": "research", "code": "code", "done": "finalize"})
graph.add_edge("research", "supervisor")
graph.add_edge("code", "supervisor")
graph.add_edge("finalize", END)

app = graph.compile(checkpointer=SqliteSaver.from_conn_string("agent_ckpt.db"))
config = {"configurable": {"thread_id": "demo-1"}, "recursion_limit": 12}
out = app.invoke({"task": "Diseña un scheduler cron simple en Python"}, config)
print(out["final"])
```

**Qué ganaste con LangGraph:**
- `recursion_limit` = tu `max_iterations`.
- `checkpointer` = puedes matar el proceso y resumir con mismo `thread_id`.
- State machine explícita = testable, visualizable (`app.get_graph().draw_mermaid()`).
- Add `interrupt()` en `code` node = HITL sin escribir infra.

### 5.3 Comprobación

```bash
python research_agent.py       # ReAct puro con guardrails
python supervisor_agent.py     # Supervisor multi-worker con checkpoint
ls agent_ckpt.db               # verifica que se creó el checkpoint DB
```

### 5.4 Verificaciones intermedias que deberías añadir

En el loop ReAct, añade asserts después de cada paso crítico:

```python
# Tras cada call al modelo
assert resp.stop_reason in ("end_turn", "tool_use", "max_tokens"), \
    f"stop_reason inesperado: {resp.stop_reason}"
assert resp.usage.input_tokens > 0, "usage.input_tokens=0 → SDK issue"

# Tras appendear tool_uses
tool_use_ids = {b.id for b in resp.content if b.type == "tool_use"}
tool_result_ids = {r["tool_use_id"] for r in results}
assert tool_use_ids == tool_result_ids, \
    f"tool_use_ids no coinciden con tool_result_ids: {tool_use_ids} vs {tool_result_ids}"

# Log estructurado para observabilidad
logger.info("agent_step", extra={
    "session_id": session_id, "iter": budget.iters,
    "stop": resp.stop_reason,
    "cost_usd_cumulative": round(budget.spent_usd, 6),
    "tokens_in": resp.usage.input_tokens,
    "tokens_out": resp.usage.output_tokens,
    "cache_read": getattr(resp.usage, "cache_read_input_tokens", 0),
})
```

### 5.5 Extendiendo el ejemplo (mejoras para producción)

El ejemplo cubre la base pero un uso real necesita al menos:

1. **Prompt caching de tools + system.** Marca los últimos bloques como `cache_control: ephemeral`. Impacto real: 60-85% de reducción de coste input en agentes que corren >5 iteraciones. Ver Cap 04 y Cap 13.

2. **Async tool execution con `asyncio.gather`.** Si el modelo emite 3 tool_uses en paralelo, ejecutarlos secuencialmente añade latencia innecesaria. Cambia el loop a `async` y usa `asyncio.gather(*(TOOL_FNS[tu.name](**tu.input) for tu in tool_uses))`.

3. **Persistencia + resumibilidad.** Sustituye el `messages: list` en memoria por Postgres/DynamoDB con schema `{session_id, step, role, content_json}`. Un handler `/resume?session_id=X` reconstruye el estado y sigue el loop. Si tu agente tarda >5 min, esto es obligatorio (deploy blue/green destruiría el trabajo).

4. **Streaming de thoughts al usuario.** En agentes >5 s, muestra al usuario qué está haciendo:

   ```python
   with client.messages.stream(...) as stream:
       for event in stream:
           if event.type == "content_block_start" and event.content_block.type == "tool_use":
               yield f"[status] Ejecutando {event.content_block.name}...\n"
           elif event.type == "text":
               yield event.text
   ```

5. **Modelo dinámico por paso.** El primer step (planning) usa Opus; los steps de extract/format usan Haiku. Router simple: si el prompt del step tiene <500 tokens y no requiere razonamiento, Haiku; si no, Sonnet. Ver §3.8.

6. **Circuit breaker por tenant.** Un tenant con bug repetitivo puede quemar tu bill. Añade `if tenant.tokens_last_hour > 1_000_000: raise TenantThrottled(...)` antes de llamar a la API.

7. **Interrupciones limpias.** Cuando el usuario cierra el navegador, cancela la task activa (asyncio `cancel()`), persiste estado parcial en el checkpoint, y libera locks. Sin esto tienes "agentes zombie" gastando tokens sin destinatario.

---

## 6. Cheatsheet, reglas mentales y anti-patrones

### 6.1 Reglas mentales

- ✅ **Empieza con workflow**, sube a agente solo cuando lo pidas justificar.
- ✅ Siempre `max_iterations` + `max_cost_usd` + `timeout`. Sin excepción.
- ✅ **Model routing**: supervisor con caro, workers con barato.
- ✅ **Sub-agentes** para aislar contextos que viven solos.
- ✅ **HITL** en destructivas siempre.
- ✅ **Stream** thought/status al usuario en agentes >5 s.
- ✅ **Checkpointing** en agentes >5 min.
- ✅ **Trazas** con dimensiones ricas (agent_id, tenant_id, session_id, cost).
- ✅ **Loop detection** semántico además de max_iter.
- ✅ **Evals** en CI antes de cambiar prompts o modelos.

### 6.2 Cheatsheet ✅/❌

| ✅ Haz | ❌ No hagas |
|--------|------------|
| Workflow determinista cuando el flujo es conocido | Agente freeform "porque suena moderno" |
| `max_iter=10–30`, `max_usd=$1–5` | Correr sin límites en tu laptop principal |
| Haiku para pasos triviales, Opus para planning | Mismo Sonnet/Opus en los 20 rounds |
| Tags XML/JSON en context: `<research>`, `<user_input>` | Concat brutal de todo en un string |
| Sub-agente cuando la tarea aísla contexto <20k tok | Sub-agentes para todo, coord overhead explota |
| Timeouts jerárquicos (tool < step < session) | Solo timeout global |
| Reflection con evaluador **distinto** (tests, otro modelo) | Reflection con el mismo prompt (sycophancy) |
| Streaming + status updates | Spinner infinito sin info |
| Checkpointing en long-running | Perder 60 min de progreso por un deploy |
| Instrumentación OpenTelemetry por request | Bill agregado sin dimensiones = imposible optimizar |

### 6.3 Tabla de decisión: ¿agente o workflow?

| Pregunta | Sí → | No → |
|----------|------|------|
| ¿Puedo dibujar el flujo antes de correr? | Workflow | Agente |
| ¿Latencia p95 < 3 s requerido? | Workflow | Agente OK |
| ¿Los pasos son <5 conocidos? | Workflow | Agente |
| ¿Necesito tests deterministas? | Workflow | Agente + evals estadísticos |
| ¿Coste por request debe ser <$0.01? | Workflow | Agente típ. $0.05–2 |

### 6.4 Reglas de model routing (2026)

| Paso | Modelo |
|------|--------|
| Supervisor / planning | `claude-opus-4-5` o `gpt-5` |
| Razonamiento intermedio | `claude-sonnet-4-5` |
| Extract / classify / format | `claude-haiku-4-5` o `gpt-5-nano` |
| Final polish user-facing | `claude-sonnet-4-5` |

---

## 7. Casos reales industria 2026

**LangGraph en producción (2026).**
- **Qué pasó:** Uber, Klarna, LinkedIn, Replit y AppFolio movieron agentes de POC a producción con LangGraph 0.6+. Klarna publicó que su asistente de shopping usa state machine con LLM en nodos + supervisor-worker para features avanzadas.
- **Cómo se detectó tracción:** conferencia LangChain Interrupt 2025 con case studies públicos de cada empresa; posts técnicos con métricas concretas de ahorro.
- **Lección industria:** recomendación oficial de LangChain 2026: **supervisor con GPT-4o/Opus, workers con GPT-4o-mini/Haiku → 60-70% ahorro sin degradar routing**. Regla estable en el ecosistema.

**LangChain Deep Agents (marzo 2026).** Plantilla lista sobre LangGraph con checkpointing, HITL, supervisor prebuilt y compaction automática. "Si LangGraph es el motor, Deep Agents es el coche prebuilt". Reduce el time-to-first-agent-in-prod de semanas a días para equipos que no quieren armar la infra desde cero.

**Claude Code sub-agentes anidados (2026).** Desde agosto 2026, Claude Code soporta sub-agentes anidados hasta profundidad 5 y *Dynamic Workflows* (un lead puede planificar y fan-outear decenas o cientos de sub-agentes paralelos). Ideal para research masivo o análisis de repos grandes.

**Perplexity y agentes con status updates.**
- **Qué pasó:** Perplexity muestra "Reading N sources" con contadores actualizados en vivo mientras el agente busca.
- **Cómo se detectó impacto:** encuestas UX internas de la compañía compartidas en blogs — latencia real 15-30 s se siente <10 s por feedback constante.
- **Lección industria:** en agentes conversacionales, la percepción de latencia se puede reducir 50-60% solo mejorando el feedback intermedio. Streaming + status updates + optimistic UI son "gratis" comparados con cambiar de modelo.

**Devin (Cognition, 2024-2025).**
- **Qué pasó:** Cognition lanzó Devin en marzo 2024 anunciando SWE-Bench 13.86%; en semanas la comunidad replicó el benchmark con resultados más modestos y polémica pública sobre metodología.
- **Cómo se detectó:** posts de terceros comparando runs y benchmarks alternativos (SWE-Bench Verified).
- **Cómo se arregló:** Cognition publicó SWE-Bench Verified con protocolo más estricto (18% con GPT-5, ~30% con configuraciones optimizadas). Cambió el marketing a "útil para tareas largas rutinarias" en vez de "reemplazará ingenieros".
- **Lección:** los benchmarks de agentes son frágiles — nunca confíes en un número publicitario sin ver metodología reproducible.

**AutoGPT postmortem (2023) → lecciones 2026.** Los notorios loops que consumían $100+ (usuarios reportaron facturas de $200 tras dejarlo corriendo overnight) motivaron todas las heurísticas modernas: max_iter obligatorio, detección de repeticiones semánticas, budget kill-switch. Ningún framework serio ships sin esto en 2026.

**Klarna asistente shopping.** Reemplazó ~700 agentes de soporte humano según su comunicado de prensa 2024. Arquitectura: state machine con nodos LLM + evaluator-optimizer para respuestas críticas. Publicó ahorros ($40M/año estimados) y latencias en su blog. Nota: el 2025 hubo backlash — Klarna anunció que "necesitan más humanos" nuevamente, ilustrando que el agente reemplaza pero no elimina la operación humana.

**Devin benchmarks polémica 2025.**
- **Qué pasó:** varias organizaciones evaluaron Devin y otros agentes de código contra "tasks reales" (no SWE-Bench). Los ratios de éxito reportados fueron mucho menores que los marketing numbers (12-20% en tasks de complejidad media).
- **Cómo se detectó:** SWE-Bench Verified (Anthropic + colaboradores) publicó metodología rigurosa; researcher Bill Zorn compartió evals independientes en su blog.
- **Cómo se arregló:** la industria adoptó SWE-Bench Verified y SWE-Bench Multimodal como estándares comunes; muchos vendors dejaron de publicar sus propios benchmarks internos y se sometieron a los públicos.
- **Lección:** un benchmark reproducible con protocol público es mejor que un número más alto sin metodología. Aplicar a evals internas: publica el dataset y el evaluator, no solo el score.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — ReAct mínimo con budget

**Objetivo:** Implementar un ReAct básico con budget de coste.

**Setup:** `pip install anthropic` + API key.

**Pasos:**
1. Copia `research_agent.py` de la sección 5.1.
2. Reduce `max_usd=0.02` y `max_iter=3`.
3. Ejecuta y verifica que aborta con `BudgetExceeded`.
4. Añade un tercer tool `wikipedia_search(topic)` mock que devuelve texto largo.
5. Observa cómo cambia el coste por round.

**Criterios de éxito:**
- [ ] El agente aborta correctamente al pasar budget.
- [ ] La trace muestra `cost_usd` creciendo por step.
- [ ] Cambiar `max_iter` cambia el corte esperado.

**Hints:**
- Con `max_usd=0.02` y Sonnet, un solo round de tool_use consume ~$0.01-0.02 — verás el corte en el step 1 o 2.
- Añade el nombre del modelo a la trace (`{"model": MODEL, ...}`) para debugging.
- Si tu mock devuelve texto largo, `input_tokens` del siguiente round crece — mide antes y después.

**Solución de referencia (esbozo):**
```python
def tool_wikipedia_search(topic: str) -> dict:
    return {"topic": topic, "content": "..." * 2000}  # ~6k chars fake

TOOLS_SPEC.append({
    "name": "wikipedia_search",
    "description": "Busca en Wikipedia por topic.",
    "input_schema": {"type": "object",
                     "properties": {"topic": {"type": "string"}},
                     "required": ["topic"]}
})
TOOL_FNS["wikipedia_search"] = tool_wikipedia_search
# El primer call ya te acerca al max_usd por el tamaño del tool_result.
```

**Bonus:** Añade streaming (`stream=True`) y muestra tokens en vivo.

---

### Ejercicio 2 — Detector de loops semánticos

**Objetivo:** Provocar y detectar un loop.

**Setup:** El script de ejercicio 1.

**Pasos:**
1. Modifica `tool_search` para que siempre devuelva `{"error": "retry"}`.
2. Fuerza al system prompt: "Si search da error, reintenta con la misma query".
3. Ejecuta: el agente debería llamar `search` con misma query varias veces.
4. Verifica que `LoopGuard` lo detecta y aborta.
5. Ajusta `max_repeat=2` y confirma corte más temprano.

**Criterios de éxito:**
- [ ] `LoopDetected` se dispara con misma tool+args.
- [ ] La trace muestra el step donde se detectó.
- [ ] Con `max_repeat=5` el corte ocurre después.

**Hints:**
- La normalización del args importa: `sorted(args.items())` es OK para dicts flat, pero para nested usa `json.dumps(args, sort_keys=True)` para determinismo.
- Considera detectar "loop de output" también: hash del texto emitido por el assistant en cada iteración; si se repite 2 veces, es señal de estancamiento.
- Al detectar loop, inyecta un mensaje `"[system: llevas 3 llamadas a X con mismos args; prueba otra estrategia o termina"` antes de decidir cortar.

**Solución de referencia (esbozo):**
```python
# En el loop, tras cada assistant response:
text_out = "".join(b.text for b in resp.content if b.type == "text")
h = hashlib.sha1(text_out.encode()).hexdigest()
seen_outputs[h] = seen_outputs.get(h, 0) + 1
if seen_outputs[h] >= 2:
    raise LoopDetected("output repetido — modelo estancado")
```

**Bonus:** Detección por hash del **output** del modelo (mismo texto 2 veces = loop).

---

### Ejercicio 3 — Supervisor-worker con LangGraph

**Objetivo:** Correr `supervisor_agent.py` y añadir un tercer worker.

**Setup:** `pip install "langgraph>=0.6" langchain-anthropic langgraph-checkpoint-sqlite`.

**Pasos:**
1. Ejecuta el script de sección 5.2.
2. Verifica que `agent_ckpt.db` se crea.
3. Añade nodo `test_worker` que genera 3 casos de test para el pseudocódigo.
4. Enruta desde `supervisor` a `test` cuando decida `"test"`.
5. Verifica el nuevo flow en `app.get_graph().draw_mermaid()`.

**Criterios de éxito:**
- [ ] El graph tiene 5 nodos incluyendo `test`.
- [ ] Ejecutando con `thread_id="demo-2"`, luego matando y reiniciando, resume desde el checkpoint.
- [ ] `state["test"]` contiene los casos generados.

**Hints:**
- El nodo `test_worker` debe hacer append al state dict, no reemplazar — LangGraph mergea shallow.
- El `route()` es una función pura que lee `state` y devuelve la clave del mapa `add_conditional_edges`.
- Para simular crash: `KeyboardInterrupt` en medio del run; luego relanza `app.invoke({}, config)` con el mismo `thread_id`.

**Solución de referencia (esbozo):**
```python
def test_worker(state: State) -> dict:
    code = state.get("code", "")
    tests = haiku.invoke([HumanMessage(f"Genera 3 test cases pytest para:\n{code}")]).content
    return {"tests": tests}
graph.add_node("test", test_worker)
# supervisor debe devolver {"next": "test"} en algún punto
graph.add_edge("test", "supervisor")
```

**Bonus:** Añade `interrupt()` en `code_worker` para HITL. Simula aprobación con `Command(resume="approve")`.

---

### Ejercicio 4 — Model routing para bajar coste

**Objetivo:** Reducir coste 3–5× con model routing.

**Setup:** Script del ejercicio 1 con logging del coste total.

**Pasos:**
1. Corre 10 ejecuciones con `MODEL="claude-opus-4-5-20250929"`. Anota coste total.
2. Cambia a `claude-haiku-4-5-20250929` para llamadas donde el prompt es corto (<200 tokens de entrada).
3. Deja Opus solo para la última síntesis.
4. Corre 10 ejecuciones. Anota coste total.
5. Calcula ratio de ahorro.

**Criterios de éxito:**
- [ ] Ahorro observado ≥ 3×.
- [ ] Calidad subjetiva de respuestas no degrada (revisión manual de 3 casos).
- [ ] Trace muestra qué modelo se usó en cada round.

**Hints:**
- Precios approx 2026: Opus 4.5 = $15/$75 per Mtok; Haiku 4.5 = $0.80/$4 per Mtok. Ratio ~18× — el ahorro es real.
- Define "simple" como `stop_reason=="tool_use" AND len(prev_text)<200` — el planning ocurre principalmente en respuestas largas.
- Añade columna `model` a tu trace y agrupa el cost por modelo para ver la distribución.

**Solución de referencia (esbozo):**
```python
def choose_model(messages, iter):
    if iter == 0:  # planning inicial
        return "claude-opus-4-5-20250929"
    last = messages[-1] if messages else {}
    if isinstance(last.get("content"), list) and any(
        b.get("type") == "tool_result" and len(str(b.get("content", ""))) < 500
        for b in last["content"]
    ):
        return "claude-haiku-4-5-20250929"  # extract/format
    return "claude-sonnet-4-5-20250929"  # default reasoning
```

**Bonus:** Implementa un router que clasifique el paso ("simple" vs "reasoning") con Haiku antes de decidir el modelo del step.

---

### Ejercicio 5 — Evals de agente

**Objetivo:** Medir mejora al cambiar un prompt.

**Setup:** `pip install braintrust` (o usa CSV local).

**Pasos:**
1. Define 10 tareas golden con expected output.
2. Corre tu agente sobre cada una; guarda `answer`, `steps`, `cost`.
3. Escribe evaluator LLM-as-judge que devuelva `{score: 0-5, reason: str}`.
4. Cambia el system prompt (por ejemplo, añade "sé conciso").
5. Corre otra vez; compara scores promedio, steps promedio, cost promedio.

**Criterios de éxito:**
- [ ] 10 casos con score numérico.
- [ ] Delta claro entre las dos versiones del prompt.
- [ ] Reporte muestra: winner, ties, losers.

**Hints:**
- Usa un modelo DISTINTO del que evalúas para juzgar (Opus juzga a Sonnet; Sonnet juzga a Haiku). Auto-evaluación sufre sycophancy.
- Añade "confidence": 0-1 al output del judge; descarta scores con confidence <0.7 para reducir ruido.
- Fixa la seed / temperature=0 en runs; sin esto el mismo prompt puede scorear distinto entre ejecuciones.

**Solución de referencia (esbozo):**
```python
JUDGE_PROMPT = """Evalúa esta respuesta de un agente. Devuelve JSON:
{"score": 0-5, "reason": str, "confidence": 0-1}
Tarea: {task}
Expected: {expected}
Actual: {actual}"""

def judge(task, expected, actual):
    resp = opus.invoke([HumanMessage(JUDGE_PROMPT.format(
        task=task, expected=expected, actual=actual))]).content
    return json.loads(resp)
```

**Bonus:** Integra en GitHub Actions: PR bloquea si score baja >5%.

---

### Ejercicio 6 (RETO) — Multi-agent supervisor con handoff y HITL real

**Objetivo:** construir un supervisor con 3 workers (research, code, review) donde el `review` puede `interrupt()` para HITL antes de devolver al supervisor.

**Setup:** `pip install "langgraph>=0.6" langchain-anthropic`.

**Pasos:**
1. Define el `StateGraph` con nodos `supervisor`, `research`, `code`, `review`, `finalize`.
2. `supervisor` decide next entre `research`, `code`, `review`, `done` con opinión razonada (loguéala).
3. `review` invoca `interrupt({"reason": "human-approval", "content": state["code"]})`.
4. Simula humano: `Command(resume="approve")` o `Command(resume="reject")`.
5. Si rechaza, vuelve a `code` con feedback; si aprueba, va a `finalize`.
6. Persiste con `SqliteSaver`; mata el proceso durante `interrupt` y verifica que resume.

**Criterios de éxito:**
- [ ] Supervisor loguea razón de cada decisión.
- [ ] `interrupt()` pausa el graph; el checkpoint refleja `interrupted=True`.
- [ ] `resume="reject"` re-entra en `code` con el feedback del humano en el state.
- [ ] Un ciclo completo (research → code → review → reject → code → review → approve → finalize) funciona end-to-end.

**Hints:**
- El feedback del humano se pasa a través del state: en `review`, guarda `state["review_feedback"] = ...` antes de decidir next.
- Un supervisor mal diseñado entra en loop infinito entre research y code — añade `state["iterations"]` y fuerza `done` tras N pasos.
- Para debugging visual: `print(app.get_graph().draw_mermaid())` genera el diagrama que puedes pegar en mermaid.live.

---

## 9. Recursos y siguientes pasos

**Papers fundacionales:**
- Yao et al., *ReAct: Synergizing Reasoning and Acting* — https://arxiv.org/abs/2210.03629
- Shinn et al., *Reflexion: Language Agents with Verbal Reinforcement Learning* — https://arxiv.org/abs/2303.11366
- Wang et al., *Plan-and-Solve Prompting* — https://arxiv.org/abs/2305.04091
- Du et al., *Improving Factuality via Multi-Agent Debate* — https://arxiv.org/abs/2305.14325
- Wang et al., *Self-Consistency* — https://arxiv.org/abs/2203.11171
- Liu et al., *Lost in the Middle* — https://arxiv.org/abs/2307.03172

**Guías industry:**
- Anthropic, *Building Effective Agents* (dic 2024) — https://www.anthropic.com/research/building-effective-agents
- Anthropic, *Claude Code Sub-agents & Hooks* — https://docs.anthropic.com/en/docs/claude-code
- OpenAI, *Agents SDK docs*
- LangGraph, *Multi-agent supervisor* — https://reference.langchain.com/python/langgraph-supervisor
- LangGraph, *Checkpointing* — https://langchain-ai.github.io/langgraph/concepts/persistence/

**Frameworks 2026:**
- LangGraph 0.6+ y **Deep Agents** (marzo 2026)
- OpenAI Agents SDK (handoffs, sessions, tracing)
- CrewAI (role-based crews)
- Microsoft AutoGen (conversation-first)

**Observability & evals:**
- LangSmith · Braintrust · Phoenix (Arize) · Langfuse
- Anthropic Inspect (open source) · promptfoo
- OpenTelemetry GenAI Semantic Conventions

**Siguientes pasos en tu roadmap:**
- Cap 08 — Code agents & computer use (Claude Code, Cursor, Aider, sandboxing).
- Cap 09 — Evals, datasets, LLM-as-judge (mide todo lo del cap 07).
- Cap 11 — Prompt injection & OWASP LLM Top 10 (sin esto, tu agente es un exploit esperando).
- Cap 12 — Sandboxing & guardrails (donde ejecutan de verdad los agentes).

---

## 10. Preguntas de práctica (20)

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-07-agent-loops-orchestration.json`](../../packages/content/src/tech/ai-programming/sim-07-agent-loops-orchestration.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-07-agent-loops-orchestration`

Cubren: ReAct, max_iterations, budget, workflow vs agent, plan-and-execute, reflection, supervisor-worker, state machines, model routing, timeouts, swarm/handoffs, detección de loops, sub-agentes, compresión de contexto, cost tracking, checkpointing, HITL, evals, latencia percibida, debate/ensemble.

---

## Navegación

[← Capítulo 06](./06-mcp-model-context-protocol.md) · [Índice](./README.md) · [Capítulo 08 →](./08-code-agents-computer-use.md)
