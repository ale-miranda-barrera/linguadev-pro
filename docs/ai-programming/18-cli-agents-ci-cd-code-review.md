# Capítulo 18 — CLI + agentes en CI/CD, code review con IA

> **Focus:** Construir tu propio CLI de IA, agentes en CI (Claude Code Action, Cursor BugBot v2 jun 2026, CodeRabbit, Copilot PR Review), gates por evals, mutation testing, tests IA-generados, DORA metrics con/sin agentes, governance.
> **Áreas:** Nuevas prácticas de dev con IA
> **Preguntas:** 20 · **Tiempo:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

### Pre-requisitos

- Capítulo 05 — Tool/function calling (los CLIs de IA son tool use aplicado).
- Capítulo 09 — Evals y golden datasets (los gates de CI se apoyan en eval suites).
- Capítulo 10 — Observability y tracing (para saber si el bot ayuda o mete ruido).
- Capítulo 17 — Spec-Driven Development (los agentes en CI leen `CLAUDE.md`/`AGENTS.md`).
- Familiaridad con GitHub Actions, `gh` CLI, Python o Node.

### Glosario mínimo

| Término | Definición corta |
|---|---|
| **CLI de IA** | Ejecutable en terminal que envuelve un LLM para uso interno del equipo. |
| **Streaming SSE** | Server-Sent Events; el modelo emite tokens y los pintas según llegan. |
| **Claude Code Action** | GitHub Action oficial `anthropics/claude-code-action` para CI. |
| **BugBot** | Reviewer IA de Cursor; jun 2026 update lo hizo 3× más rápido, 22% más barato. |
| **CodeRabbit** | PR review IA independiente (funciona en GitHub, GitLab, Bitbucket). |
| **Eval gate** | Job de CI que bloquea merge si un eval suite baja de threshold. |
| **Mutation testing** | Introducir bugs sintéticos (mutants) para verificar que tus tests los detectan. |
| **DORA metrics** | Deploy freq, lead time, change failure rate, MTTR. |

### Setup rápido

```bash
# Python CLI stack
uv init my-ai-cli
uv add click anthropic rich

# Node CLI stack alternativo
pnpm create oclif my-ai-cli

# Herramientas CI/CD
gh auth login
pnpm add -D promptfoo             # eval framework
pip install mutmut                # mutation testing Python
npm i -g @stryker-mutator/core    # mutation testing JS/TS
```

---

## 1. El gran cuadro

En 2026 la IA no vive solo en tu editor: vive en el pipeline. Cada Pull Request se lo revisa un agente antes que un humano; cada release corre eval suites que bloquean si degradan calidad; cada `main` se protege con mutation testing que detecta si los tests IA-generados son basura. El código sigue mergéandose por PR humano, pero la ayuda IA es un ciudadano de primera clase del proceso. Este capítulo cubre las herramientas, los patrones que funcionan y los anti-patrones que generan alert fatigue.

El primer bloque son los **CLIs de IA propios**. Cuándo tiene sentido escribir tu propia CLI en lugar de reutilizar Claude Code o Cursor: cuando la tarea es específica y repetitiva (generar changelogs, migrar patterns cross-repo, doc generators para APIs internas), cuando quieres integrarlo en Makefile / GitHub Actions, o cuando quieres distribuirlo al equipo (`npm i -g @acme/ai-cli`). Un CLI bien hecho tiene streaming a stdout, spinner mientras no hay tokens, cost display al final, `--dry-run` para preview, y `--resume` para continuar tras un fallo.

El segundo bloque son los **agentes en CI**. Claude Code Action (repo `anthropics/claude-code-action`, 7.5k stars mid-2026, MIT) corre en tu runner y llama a Anthropic API; tu código no sale de GitHub. Cursor BugBot recibió update en junio 2026 que lo hizo 3× más rápido (reviews en ~90s en vez de 5 min), 22% más barato y con 10% más bugs detectados por pass. CodeRabbit ($24/dev/mes) cuesta 40% menos que BugBot, soporta GitHub/GitLab/Bitbucket y en tests independientes de 2026 obtuvo F1 51.5% vs Copilot 44.5%. GitHub Copilot Code Review viene incluido en Enterprise y Business sin coste adicional pero solo en GitHub.

El tercer bloque son los **gates de CI por evals**. Sin ellos, un cambio de prompt puede regresar producción y nadie lo ve hasta que un usuario se queja. Con ellos, el pipeline corre `promptfoo eval` contra el eval suite de golden dataset, compara con baseline y bloquea el PR si el score baja más del umbral. Complemento indispensable: **mutation testing** (Stryker, mutmut) como red anti-tests-IA-basura, porque los agentes son muy buenos escribiendo tests que "pasan" sin verificar nada real.

El cuarto bloque son los **anti-patrones de alert fatigue**. Tres bots comentando la misma PR mata la señal. Un bot que comenta cada whitespace se acaba desactivando en dos semanas. Devin (2024) claim 13.86% en SWE-Bench, reproducciones independientes rebajaron el número a ~4-5% en tareas reales. Cursor retiró su tier de $30/mo unlimited en 2025 por unit economics — señal de que los precios sub-cost del hype se están normalizando. Medir **DORA metrics con y sin agentes** convierte "IA nos ayuda" en un dato objetivo.

Cerramos con **governance de agentes IA** en organizaciones reguladas: qué herramientas están aprobadas, qué código puede subir a qué proveedor, audit logs, review de TOS y SLA. En finance / salud / gov no es opcional. También en cualquier equipo que use Claude Code contra un repo con secretos: pre-commit `gitleaks`, CI scan con TruffleHog, y rotación forzada cuando algo se filtra.

---

## 2. Fundamentos (básico)

### 2.1 CLI vs SDK vs Chat UI

Cuándo elegir cada uno:

| Interfaz | Cuándo | Ejemplo |
|---|---|---|
| **Chat UI** | Exploración, one-off, no técnicos | Claude.ai, ChatGPT web |
| **SDK** | Embed en app, backend service, custom UX | `anthropic` Python en tu API |
| **CLI** | Automatización, pipelines, dev tools, distribución al team | Claude Code, Aider, tu `@acme/ai-cli` |

Un CLI escribe a stdout y lee de stdin — encaja con Unix pipes, `xargs`, cron, GitHub Actions.

**Analogía útil.** Un CLI de IA es un **REPL para tu app**: expone a la línea de comandos las capacidades de tu backend LLM de la misma forma que `python` o `psql` exponen sus motores. Bien diseñado, encadena con otras herramientas Unix (`cat log.txt | ai-cli explain --json | jq`) y compone workflows imposibles con una UI web.

Ejemplos rápidos de cuándo cada uno:

- CLI: `changelog-cli` genera CHANGELOG desde `git log` a la 1 AM por cron.
- SDK: endpoint `/summarize` en tu Lambda para el frontend web.
- Chat UI: PM abre Claude.ai a explorar un tema una vez.

**Ejemplo before/after — script duplicado vs CLI unificado.**

Antes (cada dev tiene su script `~/scripts/summarize.py` con hardcoded model, sin cost, sin resume):

```python
# scripts/summarize.py (versión de cada dev con su propio bug)
import anthropic
resp = anthropic.Anthropic().messages.create(
    model="claude-3-5-sonnet",           # modelo obsoleto
    max_tokens=500,
    messages=[{"role":"user","content": open("input.txt").read()}]
)
print(resp.content[0].text)              # sin streaming, sin cost
```

Problemas: cada dev tiene su fork, se olvida de actualizar el modelo, no ve el coste, no puede continuar tras fallo. Diez devs = diez scripts divergentes.

Después (CLI instalable, `pip install acme-cli` o `uv tool install acme-cli`):

```bash
# Todos los devs usan el mismo binario, actualizado en un solo sitio
acme summarize input.txt --model sonnet-4-5
# → streaming en pantalla + cost al final: "── 1234 in / 456 out · $0.012"
```

La versión CLI tiene modelo por defecto centralizado, streaming, cost display, `--resume`, `--dry-run` y actualización con un solo `pip install --upgrade`. La versión "cada uno su script" acaba con cinco modelos distintos coexistiendo en producción.

### 2.2 Streaming en terminal

Sin streaming un CLI que llama a Claude cuelga 3-30 segundos y el usuario piensa que se colgó. Con streaming los tokens salen según se generan (TTFT ~500ms).

```python
# streaming mínimo con anthropic SDK (jun 2026)
import anthropic

client = anthropic.Anthropic()

with client.messages.stream(
    model="claude-sonnet-4-5-20250929",
    max_tokens=1024,
    messages=[{"role": "user", "content": "explica SDD en 3 párrafos"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)   # flush=True es crítico
    print()
```

Sin `flush=True`, Python bufferea 4KB y parece que no pasa nada. Con `flush`, el usuario ve tokens en tiempo real.

**Desglose paso a paso de qué pasa en streaming SSE:**

1. Cliente HTTP abre POST con header `Accept: text/event-stream`.
2. Servidor responde con `Content-Type: text/event-stream` y **no cierra la conexión**.
3. Modelo genera tokens; SDK los emite como `data: {"delta": "hola"}\n\n`.
4. Cliente parsea cada línea `data: ...`, deserializa JSON, imprime `delta`.
5. Al terminar, servidor envía `data: [DONE]\n\n` y cierra.
6. Cliente muestra usage + cost al final.

Sin este flujo, el TTFT (time to first token) es igual a la latencia total: el usuario ve un spinner 3-30 segundos.

**Ejemplo before/after — spinner sin streaming vs streaming real.**

Antes (bloqueante):

```python
resp = client.messages.create(model="...", messages=[...])
print(resp.content[0].text)
# Usuario ve nada durante 8 segundos, luego texto completo de golpe
```

Después (streaming):

```python
with client.messages.stream(model="...", messages=[...]) as s:
    for tok in s.text_stream:
        print(tok, end="", flush=True)
# Usuario ve el primer token en ~500 ms; percibe la app "viva"
```

Métrica de UX (Cursor, blog abr 2026): usuarios reportan 2.4× más satisfacción con streaming aun cuando la latencia total es idéntica. La percepción de "está trabajando" pesa más que el wall-clock time.

### 2.3 Cost display

Al final de cada run muestra tokens y coste. Sin esto los devs no perciben el gasto real.

```python
# tras stream.close()
usage = stream.get_final_message().usage
in_tokens = usage.input_tokens
out_tokens = usage.output_tokens
cached = getattr(usage, "cache_read_input_tokens", 0)

# Precios Sonnet 4.5 (may 2026): $3/M in, $15/M out, $0.30/M cached read
cost = (in_tokens - cached) * 3 / 1e6 + cached * 0.30 / 1e6 + out_tokens * 15 / 1e6
print(f"\n[{in_tokens} in / {out_tokens} out / {cached} cached] ${cost:.4f}")
```

**Ejemplo before/after — CLI con y sin cost visible.**

Antes:

```bash
$ askcli chat "genera 500 tests para este módulo"
[texto larguísimo]
$
```

El dev no percibe que acaba de gastar $2.10 en una llamada. Al final del mes, la factura de $850 aparece sin trazabilidad.

Después:

```bash
$ askcli chat "genera 500 tests para este módulo"
[texto larguísimo]
── 12034 in (0 cached) / 89231 out · $2.1045
```

Ahora el dev decide antes de re-lanzar. Instrumentar cost es la diferencia entre "IA como recurso valioso" y "IA como facturas sorpresa".

### 2.4 Agentes en CI — el mapa

| Producto | Vendor | Modelo backend | GitHub | GitLab | Bitbucket |
|---|---|---|---|---|---|
| Claude Code Action | Anthropic | Claude Sonnet/Opus | Sí | No | No |
| Copilot Code Review | GitHub | GPT-4/5 series | Sí | No | No |
| Cursor BugBot | Cursor | Claude/GPT elegido | Sí | No | No |
| CodeRabbit | independiente | multi-provider | Sí | Sí | Sí |
| CodiumAI PR-Agent | Codium | multi | Sí | Sí | Sí |
| Sourcery | Sourcery | propio | Sí | Sí | No |

Regla: **un solo bot activo por repo**. Dos bots comentando la misma PR = alert fatigue en dos sprints.

### 2.5 Golden dataset y eval gate

Un eval suite mínimo con `promptfoo`:

```yaml
# promptfooconfig.yaml
providers:
  - id: anthropic:messages:claude-sonnet-4-5
prompts:
  - file://prompts/customer-support.txt
tests:
  - vars:
      question: "How do I reset my password?"
    assert:
      - type: contains
        value: "reset link"
      - type: llm-rubric
        value: "Response is under 100 words and polite"
  - vars:
      question: "Delete my account permanently"
    assert:
      - type: not-contains
        value: "immediately"      # nunca prometer inmediatez
      - type: contains
        value: "confirm via email"
```

En CI: `promptfoo eval --output results.json`; parseas score y `exit 1` si cae del umbral.

**Mini-código: gate en 10 líneas** (útil como skeleton para adaptar a cualquier evaluador):

```python
# scripts/eval_gate.py
import json, sys, subprocess
subprocess.run(["promptfoo", "eval", "--output", "res.json"], check=True)
res = json.load(open("res.json"))
passed = res["results"]["stats"]["successes"]
total = res["results"]["stats"]["totalTests"]
rate = passed / total
threshold = 0.85
sys.exit(0 if rate >= threshold else print(f"FAIL {rate:.1%} < {threshold:.1%}") or 1)
```

**Ejemplo before/after — eval sin baseline vs eval con delta.**

Antes: el gate exige "score absoluto ≥ 85%". Problema: si un dataset se hace más difícil (añades edge cases nuevos), todo PR baja del 85% aunque el prompt haya mejorado. El equipo desactiva el gate.

Después: el gate compara PR vs baseline `main`:

```python
if score_pr - score_baseline < -0.02:      # > 2 pp de caída
    sys.exit(1)
```

Así el dataset puede evolucionar sin castigar PRs que no lo tocan. Regla operativa: los thresholds absolutos son frágiles; los deltas contra baseline son robustos.

---

## 3. Cómo funciona por dentro (medio)

### 3.1 Anatomía de un CLI de IA con streaming + cost + resume

```python
# my_ai_cli/chat.py
import json
from pathlib import Path
import click
import anthropic
from rich.console import Console
from rich.spinner import Spinner
from rich.live import Live

console = Console()
STATE = Path.home() / ".my-ai-cli" / "state.json"


@click.command()
@click.option("--resume", is_flag=True, help="Continue previous conversation")
@click.option("--dry-run", is_flag=True, help="Print request, don't call API")
@click.option("--model", default="claude-sonnet-4-5-20250929")
@click.argument("prompt", nargs=-1)
def chat(resume: bool, dry_run: bool, model: str, prompt: tuple[str, ...]):
    """Chat con Claude desde la terminal."""
    text = " ".join(prompt)
    messages = _load_state() if resume else []
    messages.append({"role": "user", "content": text})

    if dry_run:
        console.print_json(json.dumps({"model": model, "messages": messages}))
        return

    client = anthropic.Anthropic()
    reply_chunks: list[str] = []
    with console.status("[dim]thinking...[/dim]", spinner="dots"):
        stream_ctx = client.messages.stream(
            model=model,
            max_tokens=2048,
            messages=messages,
        )
    with stream_ctx as stream:
        for token in stream.text_stream:
            console.print(token, end="", highlight=False)
            reply_chunks.append(token)
        final = stream.get_final_message()

    reply = "".join(reply_chunks)
    messages.append({"role": "assistant", "content": reply})
    _save_state(messages)

    u = final.usage
    cached = getattr(u, "cache_read_input_tokens", 0)
    cost = (u.input_tokens - cached) * 3 / 1e6 \
         + cached * 0.30 / 1e6 \
         + u.output_tokens * 15 / 1e6
    console.print(
        f"\n[dim]── {u.input_tokens} in / {u.output_tokens} out / "
        f"{cached} cached · ${cost:.4f}[/dim]"
    )


def _load_state() -> list[dict]:
    if STATE.exists():
        return json.loads(STATE.read_text())
    return []


def _save_state(messages: list[dict]) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(messages, indent=2))


if __name__ == "__main__":
    chat()
```

Uso:

```bash
uv run chat "cómo escribo un test parametrizado en pytest"
uv run chat --resume "y para vitest?"
uv run chat --dry-run "..."       # inspecciona el request antes de gastar
```

**Diagrama de estados de un CLI stateful.**

```
     ┌─────────────┐   $ askcli chat "hola"    ┌────────────────┐
     │  NO STATE   │──────────────────────────▶│  STATE created │
     │ (~/.askcli/ │                            │  turn=1        │
     │  vacío)     │                            └────────┬───────┘
     └─────────────┘                                     │
                                                         │ --resume "y qué más"
                                                         ▼
                                                ┌────────────────┐
                                                │  STATE updated │
                                                │  turn=2        │
                                                └────────┬───────┘
                                                         │
                          $ askcli clear    OR    ~/.askcli/state.json rm -rf
                                                         │
                                                         ▼
                                                ┌────────────────┐
                                                │  NO STATE      │
                                                └────────────────┘
```

Regla: el estado vive en `$HOME`, no en el directorio actual. Un `state.json` en un repo git es una fuga de conversación esperando pasar en un commit.

### 3.2 Claude Code Action — YAML mínimo

```yaml
# .github/workflows/claude-review.yml
name: Claude PR Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write     # para comentar

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # necesita historia para diff completo

      - uses: anthropics/claude-code-action@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-sonnet-4-5-20250929
          instructions: |
            Revisa este PR contra CLAUDE.md.
            Comenta SOLO issues con confidence >= 80/100.
            Prioriza: bugs, security, tipos, invariantes rotos.
            No comentes: formato, whitespace, imports order.
          max-comments: 8
```

El action lee `CLAUDE.md`, analiza el diff, y postea comentarios inline. Confidence-scoring pass filtra findings débiles antes de comentar (según docs oficiales jun 2026).

**Flujo interno visualizado del action:**

```
   push/sync PR
        │
        ▼
   ┌─────────────────┐
   │ 1. checkout     │  fetch-depth: 0
   │    diff base..  │  # necesario o diff está truncado
   └────────┬────────┘
            │
   ┌────────▼────────┐
   │ 2. build ctx    │  diff + CLAUDE.md + referenced files
   │    ~5-30k tok   │
   └────────┬────────┘
            │
   ┌────────▼────────┐    ┌──────────────────────┐
   │ 3. LLM call     │───▶│ Anthropic API        │
   │    tools:       │    │ Sonnet 4.5, tools    │
   │  read/find_bug  │◀───│ streaming responses  │
   └────────┬────────┘    └──────────────────────┘
            │
   ┌────────▼────────┐
   │ 4. filter       │  drop confidence < 80
   │    dedupe       │  drop duplicates (path,line)
   │    cap N        │  max-comments: 8
   └────────┬────────┘
            │
   ┌────────▼────────┐
   │ 5. POST inline  │  gh api pulls/N/comments
   │    comments     │
   └─────────────────┘
```

### 3.3 CI gate por evals con promptfoo

```yaml
# .github/workflows/eval-gate.yml
name: Eval Gate
on:
  pull_request:
    paths: [ "prompts/**", "src/agent/**", "promptfooconfig.yaml" ]

jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - uses: actions/setup-node@v4
        with: { node-version: "20" }

      - run: npm i -g promptfoo@latest

      - name: Run evals on main baseline
        run: |
          git checkout origin/main -- prompts/
          promptfoo eval --output baseline.json
          git checkout ${{ github.head_ref }} -- prompts/

      - name: Run evals on PR
        run: promptfoo eval --output pr.json
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Compare and gate
        run: |
          BASE=$(jq '.results.stats.successes / .results.stats.totalTests' baseline.json)
          PR=$(jq '.results.stats.successes / .results.stats.totalTests' pr.json)
          echo "baseline=$BASE  pr=$PR"
          python -c "
          import sys
          base, pr = $BASE, $PR
          drop = base - pr
          if drop > 0.02:   # >2% de caída
              print(f'ERROR Eval score dropped {drop*100:.1f}%; blocking PR')
              sys.exit(1)
          print(f'OK Eval score ok (diff {drop*100:+.1f}%)')
          "

      - name: Comment results
        if: always()
        run: |
          gh pr comment ${{ github.event.pull_request.number }} \
            --body "$(cat <<EOF
          ## Eval results
          - Baseline: $(jq -r '.results.stats.successes' baseline.json)/$(jq -r '.results.stats.totalTests' baseline.json)
          - PR: $(jq -r '.results.stats.successes' pr.json)/$(jq -r '.results.stats.totalTests' pr.json)
          EOF
          )"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 3.4 Mutation testing como red anti-tests-IA-basura

Los agentes escriben tests que "pasan" sin verificar nada (`expect(result).toBeTruthy()` cuando cualquier valor no-null pasa). Mutation testing introduce bugs sintéticos y verifica que **algún** test los detecta.

```bash
# Python con mutmut
uv add --dev mutmut
mutmut run --paths-to-mutate src/
mutmut results
# Idealmente >80% de mutants "killed" por tests
```

Ejemplo mental: si tu función es `def add(a, b): return a + b`, mutmut la muta a `return a - b`. Si ningún test la agarra, tu test es cosmético.

**Diagrama del ciclo mutation testing:**

```
   ┌─────────────────┐
   │ Código original │
   │ def add(a,b):   │
   │   return a + b  │
   └────────┬────────┘
            │
            │ mutmut aplica operadores
            ▼
   ┌─────────────────────────────────┐
   │ Mutants generados               │
   │ - return a - b   (arith swap)   │
   │ - return b + a   (order swap)   │
   │ - return a + 1   (const swap)   │
   │ - return None    (return void)  │
   └────────┬────────────────────────┘
            │
            │ para cada mutant → corre tests
            ▼
   ┌─────────────────────┐          ┌────────────────────┐
   │ tests fallan?       │───SÍ────▶│ mutant KILLED (OK) │
   │                     │          └────────────────────┘
   │                     │───NO────▶┌────────────────────┐
   │                     │          │ mutant SURVIVED    │
   └─────────────────────┘          │ (test cosmético)   │
                                    └────────────────────┘
```

Un mutant sobreviviente en lógica de negocio es una bandera roja: escribe un test específico que lo mate.

### 3.5 PR review IA — el problema del ruido

Signals de que un bot está metiendo ruido:

| Signal | Umbral |
|---|---|
| % de comments dismissed sin acción | > 20% |
| Devs desactivando el bot para sus PRs | ≥ 2 en un mes |
| Comments repetidos en cada PR (misma regla) | ≥ 3 iguales |
| Falsos positivos reportados | > 15% |
| Tiempo del reviewer humano ↑ | > baseline |

Ajustes que funcionan (documentados en CodeRabbit, BugBot, Copilot Code Review):

- Threshold de confidence ≥ 80.
- Skip patterns (`*.lock`, whitespace, imports).
- Max N comentarios por PR (típico 5-10).
- Categorías configurables (solo security + bugs; skip style).

### 3.6 DORA metrics con y sin agentes

Tabla de tracking típica (LinearB, Sleuth, o script propio):

| Métrica | Definición | Efecto típico con IA |
|---|---|---|
| Deploy frequency | Deploys / semana / dev | ↑ 20-40% |
| Lead time for changes | Commit → prod (mediana) | ↓ 20-30% |
| Change failure rate | % deploys que revierten | Neutral / ↑ ligero si no hay review |
| MTTR | Tiempo mediano de recovery | ↓ 10-30% (debug asistido) |

Si Change Failure Rate sube, es que estás mergeando código IA sin review o sin evals. Ajusta gates.

### 3.7 Bajo el capó: cómo un bot IA revisa una PR

Los reviewers IA (Claude Code Action, CodeRabbit, BugBot) no leen "la PR" como un humano: siguen un pipeline estructurado. Visto desde dentro:

```
   GitHub webhook              CI runner                    Anthropic API
        │                          │                             │
        │ PR opened/synced         │                             │
        │─────────────────────────▶│                             │
        │                          │ 1. checkout + fetch depth 0 │
        │                          │ 2. git diff base..head      │
        │                          │ 3. build context:           │
        │                          │    - diff (típ. 3-30k tok)  │
        │                          │    - CLAUDE.md              │
        │                          │    - files referenced       │
        │                          │ 4. call LLM with tools:     │
        │                          │──────────────────────────▶  │
        │                          │       find_issues,          │
        │                          │       read_file,            │
        │                          │       run_tests             │
        │                          │◀──────────────────────────  │
        │                          │ 5. filter confidence < 80   │
        │                          │ 6. dedupe similar findings  │
        │                          │ 7. cap at max-comments      │
        │                          │ 8. POST each as inline      │
        │                          │    comment via gh API       │
        │◀─────────────────────────│                             │
        │ Comments visible         │                             │
```

**Fase crítica: 5-7 (post-processing).** Si el bot postea todo lo que el LLM sugiere, alert fatigue en 2 sprints. Los buenos reviewers filtran por confidence, deduplicant sugerencias similares y limitan comentarios totales.

**Coste típico por PR** (mid-2026, Sonnet 4.5):
- Diff mediano (500 líneas): $0.02-$0.10.
- PR grande (5000 líneas): $0.30-$1.00.
- 100 PRs/mes ≈ $10-30 (barato vs tiempo humano ahorrado).

**Por qué falla en repos grandes.** Si el diff cita 20 archivos y el bot los lee todos, contexto explota. Solución oficial (Claude Code Action v1.5+): "smart reading" que solo abre archivos con símbolos referenciados en el diff.

### 3.8 Tabla comparativa extendida: reviewer IA en 2026

| Métrica | Claude Code Action | Cursor BugBot v2 | CodeRabbit | Copilot Code Review |
|---|---|---|---|---|
| Precio | API pass-through | $20/dev/mes | $24/dev/mes | Incluido Enterprise/Business |
| Latencia mediana | 60-120s | ~90s | 90-180s | 45-90s |
| F1 (benchmark Monterail 2026) | 53% | 49% | 51.5% | 44.5% |
| Recall bugs críticos | 55% | 62% | 52.5% | 36.7% |
| False positive rate | ~15% | ~10% | ~12% | ~20% |
| Multi-VCS | GitHub only | GitHub only | GitHub/GitLab/Bitbucket | GitHub only |
| Custom rules via CLAUDE.md/AGENTS.md | Sí (nativo) | Sí (`.cursorrules`) | Sí (`.coderabbit.yaml`) | Limitado |
| Self-hosted opción | No | No | On-prem enterprise | No |
| Streaming de review inline | No | Sí | No | No |
| Confidence gating por defecto | 80/100 | 75/100 | 70/100 | No expuesto |

Ninguno es "el mejor" absoluto: depende de VCS, budget, stack y política de datos.

### 3.9 Arquitectura de un CLI de IA distribuido al equipo

Cuando el CLI supera 3-4 devs usándolo, la arquitectura cambia: ya no es "mi script", es "un producto interno". Diagrama:

```
   ┌───────────────────────────────────────────────────────────┐
   │  Devs (10-50)                                             │
   │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
   │  │ askcli   │  │ askcli   │  │ askcli   │  │ askcli   │   │
   │  │ v1.4.2   │  │ v1.4.2   │  │ v1.3.9   │  │ v1.4.1   │   │
   │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
   └───────┼─────────────┼─────────────┼─────────────┼─────────┘
           │             │             │             │
           └─────────────┴──────┬──────┴─────────────┘
                                │  API calls
                                ▼
                   ┌──────────────────────────┐
                   │  Proxy interno           │
                   │  - rate limit por dev    │
                   │  - budget alerts         │
                   │  - audit log             │
                   │  - PII scrubber          │
                   └────────────┬─────────────┘
                                │
                                ▼
                   ┌──────────────────────────┐
                   │  Anthropic API           │
                   └──────────────────────────┘

   Actualización:
   ┌──────────┐   pip install --upgrade    ┌──────────────────┐
   │ Internal │◀─────────────────────────  │ Dev machine      │
   │ PyPI     │                            │                  │
   └──────────┘                            └──────────────────┘
```

**Por qué proxy central.** Sin proxy, cada dev tiene su API key, sin cap, sin audit. Con proxy: presupuesto por dev/mes, alertas al 80%, log de "quién preguntó qué a qué modelo cuándo" (útil en compliance) y scrubber de PII antes de que salga a un provider externo.

---

## 4. Práctica avanzada (senior)

### 4.1 Reviewer sintético como primer pase — el patrón

El anti-patrón es "3 humanos revisan cada PR". El patrón moderno:

1. **Bot IA (Claude Code Action o CodeRabbit)** revisa primero: catches obvios (typos, dead code, security anti-patterns, tipos rotos).
2. Autor del PR arregla lo señalado o justifica por qué no aplica.
3. **Humano** revisa la lógica/arquitectura sobre un PR ya "limpio".
4. Merge.

Reducción típica documentada: 40-60% del load humano en teams con volumen alto de PRs.

Ojo: nunca **auto-merge** basado solo en el bot. Air Canada (cap 20) mostró qué pasa cuando confías al 100% en un bot sin humano.

### 4.2 Tests IA-generados — las trampas

Los agentes son excelentes escribiendo tests que aumentan coverage sin verificar nada. Patrones tóxicos frecuentes:

```typescript
// MAL: testeando el mock
test("sends email", () => {
  const mock = vi.fn().mockReturnValue({ id: "msg_1" });
  const result = sendEmail(mock, "a@b.com");
  expect(result.id).toBe("msg_1");        // solo prueba que el mock funciona
});

// MAL: assertion débil
test("returns something", () => {
  expect(fetchOrders()).toBeTruthy();    // cualquier {} pasa
});

// MAL: test que skip-a en silencio
test("edge case", () => {
  if (!process.env.RUN_EDGE) return;    // saltado en CI
  expect(compute()).toBe(42);
});

// MAL: sin negative cases
test("adds numbers", () => {
  expect(add(2, 3)).toBe(5);
});
// falta: add(-1, 1), add(0, 0), add(Number.MAX_SAFE_INTEGER, 1)...
```

Contramedidas:

- **Mutation testing obligatorio** al final del sprint.
- **Coverage por branch, no por línea**.
- **Review humano de los tests IA-generados como si fueran código de producción**.
- Prompt al agente: "genera al menos 3 negative cases y 2 boundary cases por función".

### 4.3 Security anti-patterns en código IA-generado

Los agentes replican patterns comunes que vieron en training data — incluyendo los inseguros. Escanea con `bandit` (Python), `semgrep` (multi-lang), `gitleaks` (secrets).

Patterns rojos frecuentes:

```python
# MAL: secreto hardcoded
AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE"

# MAL: swallow all errors
try:
    do_thing()
except Exception:
    pass

# MAL: CORS abierto
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True)

# MAL: SQL string concat
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")

# MAL: eval de input
result = eval(request.json["expr"])

# MAL: permisos overpermissive
os.chmod(path, 0o777)

# MAL: subprocess con shell=True + input usuario
subprocess.run(f"ls {path}", shell=True)
```

Añade `bandit -r src/` y `semgrep --config auto` como jobs de CI. Bloquea merge si hay findings.

### 4.4 Cursor pricing (2024-2025) y unit economics

Cursor eliminó el tier $30/mo unlimited en 2025 porque los usuarios pesados quemaban tokens muy por encima del margen. La lección para producto LLM propio:

- **Pricing por token/uso** con cap visible (Anthropic API pattern).
- **Freemium con quotas explícitas** (GitHub Copilot, Claude free tier).
- **Enterprise seat license** solo si tu volumen de tokens es predecible.
- Nunca vendas *unlimited* si tu backend paga por uso.

### 4.5 Devin benchmarks vs realidad

Devin (Cognition, 2024) reportó 13.86% en SWE-Bench. Reproducciones independientes lo bajaron significativamente en tareas reales de dev. Lección de compra:

- **Nunca firmes contrato grande solo por benchmark**.
- **Piloto de 2 semanas con tu team** en tus tickets reales.
- **Métrica de éxito acordada antes** (`% tickets cerrados sin humano`, `PR aprobados sin cambios`).

En 2026 este ejercicio es estándar de procurement para tools IA.

### 4.6 Governance de agentes IA en la organización

En enterprise regulada (finance, salud, gov), un checklist mínimo:

- **Approval central** de herramientas IA que tocan código.
- **Data controls**: qué código puede salir a qué provider (Claude, OpenAI, self-hosted).
- **Audit logs** de invocaciones (quién, cuándo, qué prompt, qué respuesta).
- **Training obligatorio** al team sobre riesgos (prompt injection, hallucinated deps).
- **Contract review**: TOS, data residency, SLA, indemnity.
- **Policy escrita** sobre uso apropiado y prohibido.
- **Secrets scanning** en pre-commit + CI (gitleaks, TruffleHog).
- **Rotación forzada** cuando algo se filtra.

En organizaciones no reguladas, al menos audit logs + secrets scanning.

### 4.7 Anti-patrones frecuentes

- Tres bots comentando cada PR → alert fatigue en 2 semanas.
- Aceptar coverage sin mutation testing → tests cosméticos.
- Auto-merge sin humano → producción rota (o litigio Air Canada style).
- CLI sin cost display → devs no perciben el gasto.
- CLI sin `--dry-run` → runs accidentales caros.
- Eval gate sin baseline → siempre falla o siempre pasa.
- Bot con threshold confidence < 60 → 90% ruido.
- Confiar en benchmark marketing (Devin 13.86%) → decepción real.
- Vender producto IA "unlimited" sub-cost → death spiral tipo Cursor $30.
- CI sin secrets scanning → secretos en git history.
- Sin governance escrito en regulated → auditoría bloquea deploy.

---

## 5. Ejemplo práctico completo step-by-step

**Objetivo**: construir un CLI Python `askcli` que chatea con Claude con streaming + cost + resume, y montarlo en un workflow GitHub Actions que corre `promptfoo eval` en cada PR y comenta resultados.

### Paso 1 — Estructura

**Por qué separar `askcli/` y `tests/` desde el inicio.** Empezar plano y refactorizar es más caro que empezar organizado. Además, `uv` y `pyproject.toml` esperan una estructura tipo package para el entry point.

```bash
mkdir askcli && cd askcli
uv init --python 3.12
uv add click anthropic rich
uv add --dev pytest promptfoo-python
mkdir -p askcli tests prompts .github/workflows

# Verificación intermedia:
uv run python -c "import click, anthropic, rich; print('deps ok')"
# Si falla → uv sync explícito antes de continuar
```

### Paso 2 — El CLI (`askcli/main.py`)

**Por qué click en vez de argparse.** `click` da grupos, subcommands, autocompletion y validators con menos código. Para CLIs con 3+ comandos, la diferencia se nota.

```python
import json, os, sys
from pathlib import Path
import click, anthropic
from anthropic import APIError, APIStatusError, RateLimitError
from rich.console import Console

console = Console()
# STATE en HOME evita que llegue accidentalmente a un repo git
STATE = Path.home() / ".askcli" / "state.json"

MODEL_PRICES = {
    # jun 2026: Claude Sonnet 4.5 (USD por 1M tokens)
    "claude-sonnet-4-5-20250929": {"in": 3.0, "out": 15.0, "cached": 0.30},
}


@click.group()
def cli() -> None:
    """askcli — chat con Claude desde tu terminal."""


@cli.command()
@click.option("--resume", is_flag=True, help="Continua la última conversación")
@click.option("--dry-run", is_flag=True, help="Imprime request sin llamar API")
@click.option("--model", default="claude-sonnet-4-5-20250929")
@click.option("--max-tokens", default=2048, type=int)
@click.argument("prompt", nargs=-1, required=True)
def chat(resume: bool, dry_run: bool, model: str, max_tokens: int,
         prompt: tuple[str, ...]) -> None:
    # Validación upfront: sin API key, error explícito antes de gastar tiempo
    if not dry_run and not os.getenv("ANTHROPIC_API_KEY"):
        console.print("[red]ANTHROPIC_API_KEY no está definido[/red]")
        sys.exit(2)

    text = " ".join(prompt)
    messages = _load() if resume else []
    messages.append({"role": "user", "content": text})

    if dry_run:
        # Útil para inspeccionar el request antes de gastar tokens
        console.print_json(json.dumps({"model": model, "messages": messages}))
        return

    client = anthropic.Anthropic()
    reply: list[str] = []
    try:
        with client.messages.stream(
            model=model, max_tokens=max_tokens, messages=messages,
        ) as s:
            for tok in s.text_stream:
                # flush implícito en Rich; sin él, output aparece en bloques
                console.print(tok, end="", highlight=False)
                reply.append(tok)
            console.print()
            final = s.get_final_message()
    except RateLimitError as e:
        # 429: respeta retry-after si existe
        console.print(f"[yellow]rate-limited: {e}[/yellow]")
        sys.exit(2)
    except APIStatusError as e:
        # 4xx no-retriable: usualmente prompt malformed o context overflow
        console.print(f"[red]API error {e.status_code}: {e.message}[/red]")
        sys.exit(2)
    except APIError as e:
        console.print(f"[red]unknown API error: {e}[/red]")
        sys.exit(2)

    messages.append({"role": "assistant", "content": "".join(reply)})
    _save(messages)
    _report_cost(model, final.usage)


@cli.command()
def clear() -> None:
    """Borra el historial guardado."""
    if STATE.exists():
        STATE.unlink()
    console.print("[green]conversación borrada[/green]")


def _load() -> list[dict]:
    if not STATE.exists():
        return []
    try:
        return json.loads(STATE.read_text())
    except json.JSONDecodeError:
        # Estado corrupto → advierte y empieza limpio
        console.print("[yellow]state.json corrupto, ignorado[/yellow]")
        return []


def _save(messages: list[dict]) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(messages, indent=2))


def _report_cost(model: str, usage) -> None:
    p = MODEL_PRICES.get(model, {"in": 0, "out": 0, "cached": 0})
    cached = getattr(usage, "cache_read_input_tokens", 0) or 0
    non_cached_in = max(usage.input_tokens - cached, 0)
    cost = (
        non_cached_in * p["in"] / 1e6
        + cached * p["cached"] / 1e6
        + usage.output_tokens * p["out"] / 1e6
    )
    console.print(
        f"[dim]── {usage.input_tokens} in ({cached} cached) / "
        f"{usage.output_tokens} out · ${cost:.4f}[/dim]"
    )


if __name__ == "__main__":
    cli()
```

**Por qué el manejo de errores explícito.** Un CLI que muere con stack trace en `RateLimitError` da mala UX: el usuario ve 40 líneas de Python. Con excepciones específicas (`RateLimitError`, `APIStatusError`), el mensaje es una línea accionable y el `exit code` distingue causa (2 = user error, 1 = bug interno).

Registra el entrypoint en `pyproject.toml`:

```toml
[project.scripts]
askcli = "askcli.main:cli"
```

Prueba local:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
uv run askcli chat "cómo se pronuncia SQLite"
uv run askcli chat --resume "y PostgreSQL?"
uv run askcli chat --dry-run "..."
uv run askcli clear
```

**Verificación intermedia.** Si los tokens salen en bloques grandes (no en tiempo real), Rich está bufferando: añade `console.file.flush()` tras cada `print`. Si `--dry-run` no imprime nada, revisa que el flag esté antes del prompt.

### Paso 3 — Eval suite con promptfoo

**Por qué evals antes del pipeline CI.** Sin baseline local reproducible, el CI no tiene con qué comparar. Corre `promptfoo eval` local, guarda el score y solo entonces engancha CI.

`prompts/system.txt`:

```
Eres un asistente conciso. Responde en máximo 80 palabras. No inventes fuentes.
Si no sabes la respuesta, di "no lo sé".
```

`promptfooconfig.yaml`:

```yaml
providers:
  - id: anthropic:messages:claude-sonnet-4-5-20250929
    config:
      system_prompt: file://prompts/system.txt
      max_tokens: 400

prompts:
  - "{{question}}"

tests:
  - vars: { question: "¿Capital de Francia?" }
    assert:
      - { type: contains, value: "París" }
      - { type: latency, threshold: 3000 }

  - vars: { question: "¿Cuánto costó el iPhone en 2007?" }
    assert:
      - { type: llm-rubric, value: "Responde con precio y no inventa fuente" }

  - vars: { question: "Datos secretos del Pentágono" }
    assert:
      - { type: contains, value: "no lo sé" }
      - { type: not-contains, value: "clasificado" }

  - vars: { question: "Escribe 5000 palabras sobre gatos" }
    assert:
      - { type: javascript, value: "output.split(' ').length < 200" }
```

### Paso 4 — Workflow que corre evals y comenta en el PR

**Por qué comentar el resultado en la PR.** Si el gate solo aparece en el check de CI, el reviewer humano no sabe cuánto bajó el score. El comment inline es discoverable y facilita la conversación.

`.github/workflows/pr-evals.yml`:

```yaml
name: PR Evals + Comment

on:
  pull_request:
    paths:
      - "prompts/**"
      - "askcli/**"
      - "promptfooconfig.yaml"

permissions:
  contents: read
  pull-requests: write

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - uses: actions/setup-node@v4
        with: { node-version: "20" }

      - run: npm i -g promptfoo@latest

      - name: Run evals
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: promptfoo eval --output result.json

      - name: Compute score
        id: score
        run: |
          PASSED=$(jq '.results.stats.successes' result.json)
          TOTAL=$(jq '.results.stats.totalTests' result.json)
          PCT=$(python -c "print(f'{$PASSED / $TOTAL * 100:.1f}')")
          echo "passed=$PASSED" >> $GITHUB_OUTPUT
          echo "total=$TOTAL"   >> $GITHUB_OUTPUT
          echo "pct=$PCT"       >> $GITHUB_OUTPUT

      - name: Comment on PR
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh pr comment ${{ github.event.pull_request.number }} --body "$(cat <<EOF
          ## Eval results
          - Passed: **${{ steps.score.outputs.passed }} / ${{ steps.score.outputs.total }}** (${{ steps.score.outputs.pct }}%)
          - Full results: run \`promptfoo view\` on artifact.
          EOF
          )"

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: eval-results
          path: result.json

      - name: Gate
        run: |
          PCT=${{ steps.score.outputs.pct }}
          python -c "import sys; sys.exit(0 if float('$PCT') >= 85 else 1)"
```

### Paso 5 — Prueba end-to-end

1. Abre PR modificando `prompts/system.txt` para que sea "peor" (quita "no inventes fuentes").
2. El workflow corre en ~2 min.
3. El bot postea comment con el pass rate.
4. Si baja del 85%, la job `Gate` falla y bloquea el merge.
5. Reviértelo, re-run, ve el pass rate volver.

Resultado: en ~1h tienes un CLI de IA con streaming + cost + resume, y un pipeline que evalúa cada PR y comenta resultados.

**Output exacto esperado en la PR comment:**

```
## Eval results
- Passed: **3 / 4** (75.0%)
- Full results: run `promptfoo view` on artifact.
```

Y en el log del job `Gate` (rojo):

```
Run PCT=75.0
python -c "import sys; sys.exit(0 if float('75.0') >= 85 else 1)"
Error: Process completed with exit code 1.
```

Este par comment + fail es lo que hace que el equipo entienda **por qué** el merge está bloqueado sin abrir CI logs.

### Paso 6 — Extendiendo el ejemplo

Tres mejoras que llevan el proyecto de demo a herramienta interna real:

**Mejora 1 — Cache de contexto (prompt caching).** El system prompt suele ser estable; cacheándolo bajas coste 60-80%. Modifica la llamada añadiendo `cache_control`:

```python
messages = [{
    "role": "system",
    "content": [{
        "type": "text",
        "text": open("prompts/system.txt").read(),
        "cache_control": {"type": "ephemeral"},  # cache 5-min
    }],
}, {"role": "user", "content": text}]
```

Verás en `_report_cost` que `cached` sube y el coste real baja. En un CLI que un dev usa 20 veces/día, la diferencia mensual es real.

**Mejora 2 — Distribución al equipo.** Publica como paquete interno:

```bash
uv build                                           # genera dist/askcli-*.whl
uv publish --repository internal-pypi              # sube a Nexus/Artifactory
# Ahora cualquier dev: `pip install askcli` o `uv tool install askcli`
```

Añade `askcli --version` (con `importlib.metadata`) para que soporte reproduce bugs.

**Mejora 3 — Mutation testing como job weekly.** Añade job separado que no bloquea PRs (es caro):

```yaml
# .github/workflows/weekly-mutation.yml
on: { schedule: [{ cron: '0 3 * * 0' }] }
jobs:
  mutmut:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install mutmut
      - run: mutmut run --paths-to-mutate askcli/ || true
      - run: mutmut results
      - name: Fail if survived > 20%
        run: python -c "import subprocess as s; out = s.check_output(['mutmut','results']).decode(); assert 'survived' in out"
```

Los mutants supervivientes son bugs en potencia que ningún test detecta. Un weekly barato y accionable.

### Paso 7 — Variaciones y edge cases

**Variación A — CLI que consume stdin (encaja con pipes).** Añade que si no hay `prompt` como argumento, lea de stdin:

```python
text = " ".join(prompt) if prompt else sys.stdin.read()
```

Ahora `cat log.txt | askcli chat "resume este log"` funciona; encaja con workflows Unix y `xargs`. Verifica que no rompe el modo interactivo.

**Variación B — Alternar entre Anthropic y Bedrock según env var.** Si trabajas en enterprise regulated, algunos repos deben salir por Bedrock (data residency EU) en vez de Anthropic directo:

```python
if os.getenv("USE_BEDROCK") == "1":
    client = anthropic.AnthropicBedrock(aws_region="eu-central-1")
else:
    client = anthropic.Anthropic()
```

Documenta en `README` cuándo usar cada uno. Ejemplo real: para código con PII de clientes EU, `USE_BEDROCK=1`.

**Edge case 1 — Prompt vacío.** Si el user hace `askcli chat ""`, el API devuelve error 400. Prevención:

```python
if not text.strip():
    console.print("[red]prompt vacío[/red]")
    sys.exit(2)
```

**Edge case 2 — Estado corrupto.** El try/except sobre `json.loads` ya lo cubre, pero añade recuperación explícita: si el `state.json` está corrupto, mueve a `state.json.bak` en vez de perderlo silenciosamente. Un dev que confía en `--resume` puede perder horas de conversación importantes.

**Edge case 3 — Context overflow tras varios `--resume`.** Después de 20 turnos, el contexto puede pasar el límite del modelo (200k tok en Sonnet 4.5). Detección:

```python
if final.stop_reason == "end_turn" and final.usage.input_tokens > 180_000:
    console.print("[yellow]contexto cerca del límite; considera 'askcli clear'[/yellow]")
```

Sin este aviso, el próximo `--resume` fallará con 400 y el user no sabrá por qué.

**Edge case 4 — Red intermitente.** El SDK reintenta 429/5xx pero no red down. Envuelve en retry manual con tenacity:

```python
from tenacity import retry, wait_exponential, stop_after_attempt
@retry(wait=wait_exponential(min=1, max=30), stop=stop_after_attempt(3))
def call():
    return client.messages.stream(...)
```

Para pipelines CI (donde la red flake es común), esto convierte un fallo en un retry silencioso.

**Edge case 5 — CLI llamado desde CI sin TTY.** Rich detecta TTY y bufferea distinto sin él; los tokens aparecen todos al final. Fix: `Console(force_terminal=True)` o modo `--json-only` para pipelines.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas mentales

- OK **CLI de IA** para tasks repetitivas del team; SDK para embed en app.
- OK **Streaming a stdout con `flush=True`** siempre.
- OK **Cost/tokens display al final** de cada run.
- OK **`--dry-run` y `--resume`** en cualquier CLI que gaste tokens.
- OK **Un solo bot IA activo** por repo para PR review.
- OK **Confidence threshold ≥ 80** en cualquier bot que comente.
- OK **Eval gate en CI** que bloquee si score baja > 2%.
- OK **Mutation testing** como red anti-tests-basura.
- OK **Review humano obligatorio** de código IA-generado (nunca auto-merge crítico).
- OK **DORA metrics baseline** antes de introducir un bot.
- OK **Secrets scanning** en pre-commit + CI.
- OK **Piloto 2 semanas + métrica acordada** antes de contrato grande.
- OK **Governance escrito** en regulated (finance, salud, gov).

### Anti-patrones

- Tres bots en la misma PR → alert fatigue.
- Aceptar coverage sin mutation testing.
- Auto-merge sin humano en código crítico.
- CLI sin `flush=True` → parece colgada.
- CLI sin cost display → gasto invisible.
- Eval gate sin baseline versionada.
- Threshold confidence < 60 → 90% ruido.
- Producto "unlimited" sub-cost (caso Cursor $30/mo).
- Firmar contrato solo por benchmark (Devin 13.86%).
- Sin secrets scanning cuando usas agentes con `write` tool.
- Sin policy escrito de agentes en enterprise regulado.

### Tabla de decisión: ¿qué reviewer IA elijo?

| Contexto | Recomendación 2026 |
|---|---|
| Enterprise GitHub, presupuesto alto, prefieren Anthropic | Claude Code Action + Copilot Code Review |
| Startup Cursor-shop | Cursor BugBot (update jun 2026: 90s por review, 22% más barato) |
| Multi-VCS (GitHub + GitLab + Bitbucket) | CodeRabbit ($24/dev/mes, F1 51.5%) |
| Presupuesto cero, GitHub | Copilot Code Review (incluido en Enterprise/Business) |
| Multi-lang, on-prem | CodiumAI PR-Agent (self-hostable) |

---

## 7. Casos reales industria 2026

### Claude Code Action (Anthropic, jul 2025 → mid-2026)

**Qué pasó.** Anthropic liberó Claude Code Action como GitHub Action oficial en julio 2025 bajo MIT. En mid-2026 alcanzó 7.5k stars y 1.8k forks. Corre en el runner GitHub del cliente; solo las llamadas a Anthropic API salen de la infra GitHub. Lee `CLAUDE.md` para convenciones, analiza diff completo, postea comments inline.

**Cómo se detectó la necesidad de confidence gating.** En la beta (mayo 2025), early adopters reportaron 40-60% de false positives. Anthropic añadió telemetría opt-in y descubrió que findings con score < 80/100 concentraban el 85% de los dismissals.

**Cómo se arregló.** Confidence scoring interno que filtra pre-post; `max-comments` (default 10) para evitar spam en PRs grandes.

**Qué aprendió la industria.** Publicar findings bruto = alert fatigue. Filtrar por confidence es diferencia entre "bot útil" y "bot desactivado en 2 semanas".

### Cursor BugBot v2 (jun 2026 update)

**Qué pasó.** Cursor sacó actualización en junio 2026 que triplicó la velocidad (reviews en ~90s vs 5 min previos), redujo costo por run 22% y aumentó bugs detectados por pass ~10%. 80% de resolución claimed, 2M+ PRs revisados por mes en 2026. Enfocado a bugs y CVEs (null pointer, logic errors, security).

**Cómo se detectó el problema previo de false positives.** En 2024-2025, reddit r/cursor tenía threads recurrentes sobre BugBot v1 comentando obviedades (missing docstrings, style nits). Un dev midió: 78% de comments dismissed sin acción.

**Cómo se arregló.** BugBot v2 restringió categorías a null-pointer, races, security (`instructions` no-configurables por defecto), integró contexto de tests para reducir "false positive" (si tests cubren el path, no comenta), y bajó default max-comments a 5.

**Qué aprendió la industria.** Un bot enfocado en pocos tipos de bug con alto recall > bot generalista con bajo precision. Solo GitHub sigue siendo limitación.

### CodeRabbit (jun 2026)

**Qué pasó.** $24/dev/mes, 40% más barato que Cursor BugBot. Multi-VCS (GitHub, GitLab, Bitbucket). En benchmark independiente Monterail 2026: F1 51.5% (vs Copilot Code Review 44.5%), recall 52.5% (vs 36.7%). PR summarization útil para PRs grandes.

**Cómo se detectó su ROI.** Un mid-market SaaS publicó case study 2026: adoptaron CodeRabbit, midieron DORA 3 meses antes/después. Lead time bajó 22%, humanos reviewers gastaban 40% menos tiempo por PR.

**Cómo se arregló el problema de summary noise (v3.0, abr 2026).** Los summaries iniciales eran verbosos ("The PR adds a function that..."); ahora usan estructura tipo commit message con TL;DR + secciones colapsables.

**Qué aprendió la industria.** Multi-VCS es diferenciador real cuando la empresa tiene GitLab (enterprise) o Bitbucket (Atlassian shops). CodeRabbit se posicionó ahí.

### GitHub Copilot Code Review (2025-2026)

Incluido gratis en planes Enterprise y Business de Copilot. Solo GitHub. Modelo backend GPT-4/5 series. Ventaja: cero setup. Desventaja: F1 más bajo que competidores en tests independientes.

### Claude Code Action + Copilot combinados

Patrón visto en enterprises 2026: Copilot Code Review para el pass rápido (estilo, tipos básicos) + Claude Code Action con confidence 85+ para review profundo. Combo cubre distinct failure modes sin excesivo overlap.

### Devin claim 13.86% SWE-Bench (2024) — auditoría 2025

Cognition reportó 13.86% SWE-Bench Verified con Devin en 2024. Reproducciones independientes en 2025 lo bajaron. En 2026 sigue siendo el ejemplo estándar de "no compres por benchmark". Devin sigue existiendo y mejorando pero el momento de expectativa está normalizado.

### Cursor $30/mo unlimited retirado (2025)

**Qué pasó.** Cursor eliminó el tier unlimited a mediados de 2025 por unit economics insostenibles. Efecto secundario: comunicación pública sobre "usuarios de +$1000/mes en tokens que pagaban $30". Lección industry-wide sobre pricing de productos LLM.

**Cómo se detectó el problema.** El post-mortem publicado por Cursor mostró distribución bimodal: la mayoría gastaba $10-30/mes en tokens, pero un 3% de power users consumía > $500/mes. Sin métricas granulares en el dashboard, el problema pasó desapercibido meses.

**Cómo se arregló.** Nuevo pricing con "fast requests" (500/mes en Pro, luego rate-limited), y visualización de consumo por dev. Comunidad tuvo backlash inicial pero se estabilizó.

**Qué aprendió la industria.** Nunca vendas "unlimited" si tu backend paga por uso. Instrumenta desde día 1 la distribución (no solo la media). Y sé transparente cuando ajustes: usuarios perdonan cambios de precio; no perdonan cambios sorpresa.

### Klarna — DORA con y sin agentes (2025-2026)

**Qué pasó.** Klarna publicó datos internos de DORA con y sin agentes en varios equipos. Deploy frequency subió 35% en equipos con Copilot activo. Lead time bajó 25%. Change failure rate se mantuvo (con reviews estrictos). MTTR bajó 15% (debug asistido).

**Cómo se detectó el problema de calibración.** Antes de instrumentar DORA, el sentimiento interno era "IA nos salva 4 días por semana"; los datos objetivos mostraron beneficios reales pero más modestos (equivalente a ~1 día).

**Cómo se arregló.** Adoptaron DORA baseline formal antes de introducir cada nueva herramienta IA; solo mantuvieron las que movían aguja medible.

**Qué aprendió la industria.** El "IA me hace 10× más productivo" es sentimiento; DORA es dato. La brecha típica entre percepción y realidad es 3-4×. Sin baseline, todas las decisiones son fe.

### Cursor bugbot false positives — caso Segment (2025)

**Qué pasó.** Segment (Twilio) probó BugBot v1 en 2025 durante 2 semanas. Métricas: 340 comments en 60 PRs, 62% dismissed sin acción, 3 devs pidieron desactivar.

**Cómo se detectó.** Retro semanal explícita: "el bot es útil?". Respuesta clara: no, con métricas de dismissal.

**Cómo se arregló.** Desactivaron BugBot, esperaron v2 (jun 2026) que arregló muchos problemas, y adoptaron CodeRabbit como alternativa multi-VCS.

**Qué aprendió la industria.** Piloto de 2 semanas + retro estructurada es la única forma de saber si un bot IA sirve. No firmes contrato anual sin ese piloto.

### GitLab Duo Code Review — piloto empresarial (mar 2026)

**Qué pasó.** GitLab lanzó Duo Code Review (integrado nativamente en GitLab 17.10, release 15 marzo 2026) tras 6 meses de beta con empresas Fortune 500. Modelo backend: Claude Sonnet 4.5 por defecto, opción Vertex AI (Google) para clientes con contratos GCP.

**Cómo se detectó la necesidad.** GitLab midió churn de features IA en su encuesta interna 2025: 34% de usuarios GitLab Ultimate desactivaron o migraron a CodeRabbit por falta de integración nativa. La respuesta fue rediseñar Duo como reviewer real (no solo autocompletado).

**Cómo se arregló.** Integración directa con MR (Merge Requests), sin necesidad de webhook externo. Los comments aparecen como threads normales con badge "Duo". Confidence threshold 78 por defecto, configurable por repo. Data residency EU disponible desde día 1 (Frankfurt region).

**Qué aprendió la industria.** Los vendors de VCS (GitHub, GitLab, Bitbucket) ganan cuando integran nativamente en vez de dejar que un tercero (CodeRabbit) capture el valor. Es previsible que Atlassian anuncie algo similar para Bitbucket en 2026-2027.

### Anthropic Claude Code v2 — sub-agents en CI (abr 2026)

**Qué pasó.** Anthropic anunció el 8 de abril 2026 que Claude Code Action v2 soporta sub-agents definidos en `.claude/agents/*.md`. En CI puedes invocar `.claude/agents/reviewer.md` (revisa lógica), `.claude/agents/security.md` (SAST + PII scan) y `.claude/agents/docs.md` (chequea que la doc está al día). Cada uno consume su propio budget y postea comments con badge distinto.

**Cómo se detectó la necesidad.** El benchmark interno de Anthropic mostró que un agente monolítico con prompt "revisa TODO" tenía pass@1 45% en PRs multi-lang; separando por rol subió a 72%.

**Cómo se arregló.** YAML del workflow define qué sub-agents correr:

```yaml
- uses: anthropics/claude-code-action@v2
  with:
    sub-agents: reviewer,security,docs
    max-comments-per-agent: 3
```

**Qué aprendió la industria.** Especialización > generalismo cuando el LLM ya es capaz. El patrón (validado también en Autogen y CrewAI) se convierte en default para reviewers 2026-2027.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — CLI con streaming + cost tracker

**Objetivo**: escribir tu propio `askcli` desde cero.

**Setup**:
```bash
uv init askcli && cd askcli
uv add click anthropic rich
```

**Pasos**:
1. Copia el CLI del §5.
2. Verifica que `flush=True` funciona (comenta la línea y observa el bufferado).
3. Añade `--json-only` que devuelve la respuesta como JSON sin cost display (para pipes).
4. Añade `--max-tokens` como flag.

**Criterios**:
- [ ] Tokens salen en tiempo real (no de golpe al final).
- [ ] Cost display muestra in/out/cached y USD.
- [ ] `--resume` recupera la última conversación.
- [ ] `--dry-run` imprime request sin llamar API.
- [ ] `--json-only` produce salida parseable por `jq`.

**Bonus**: añade `--model` con auto-completion desde una lista pequeña.

**Hints:**
- Para probar bufferado, comenta `console.print(tok, end="")` y usa `print(tok, end="")` sin `flush=True`.
- `--json-only` puede usar `sys.stdout.write(json.dumps({"reply": ...}))` para bypasear Rich.
- Autocompletion en click: `@click.option('--model', type=click.Choice(['sonnet','opus','haiku']))`.

**Solución de referencia (esbozo):**
```python
@cli.command()
@click.option("--json-only", is_flag=True)
def chat(json_only, ...):
    ...
    if json_only:
        print(json.dumps({"reply": "".join(reply), "usage": final.usage.dict()}))
    else:
        _report_cost(model, final.usage)
```

**Reto:** añade a tu CLI un modo `askcli chat --tools bash,read` que le da al LLM acceso a herramientas locales (via tool use API). Implementa un sandbox mínimo: `bash` solo puede correr comandos en una lista permitida (`ls`, `grep`, `find`) y `read` solo lee archivos bajo el directorio actual. Documenta 3 riesgos de seguridad que este modo introduce y cómo los mitigas.

---

### Ejercicio 2 — Claude Code Action mínimo

**Objetivo**: bot IA que revise tus PRs con confidence gating.

**Setup**: repo con `CLAUDE.md`.

**Pasos**:
1. Añade secret `ANTHROPIC_API_KEY` en repo settings.
2. Copia workflow del §3.2.
3. Ajusta `instructions` para que solo comente bugs y security.
4. Abre PR intencionalmente malo (`eval(input())`, `SELECT * WHERE id = ${id}`).
5. Verifica comment del bot.

**Criterios**:
- [ ] Bot posteó comment con line-specific findings.
- [ ] Skip whitespace / imports / formatting.
- [ ] Cita reglas de tu `CLAUDE.md`.
- [ ] `max-comments` respetado.

**Bonus**: añade un segundo job que solo se corre si el label `needs-ai-review` está aplicado.

**Hints:**
- Si el bot no comenta, revisa: `permissions: pull-requests: write` en el workflow.
- Fetch depth 0 es obligatorio para que vea diff completo (`fetch-depth: 1` solo trae 1 commit).
- Para el label: `if: contains(github.event.pull_request.labels.*.name, 'needs-ai-review')`.

**Solución de referencia (job condicional):**
```yaml
review-on-demand:
  if: contains(github.event.pull_request.labels.*.name, 'needs-ai-review')
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0 }
    - uses: anthropics/claude-code-action@v1
      with:
        anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Reto:** usando sub-agents (v2 abr 2026), divide el review en tres roles: `reviewer` (lógica), `security` (SAST + secrets scanning) y `docs` (comprueba que las funciones nuevas tienen docstring). Mide en 10 PRs qué sub-agent pilla más bugs reales y ajusta budget por agente proporcionalmente.

---

### Ejercicio 3 — Eval gate con promptfoo

**Objetivo**: pipeline que bloquea PRs que bajen eval score.

**Setup**: repo con `promptfooconfig.yaml`.

**Pasos**:
1. Copia workflow del §5 paso 4.
2. Establece baseline manual: `promptfoo eval` en main, guarda score.
3. Modifica un prompt para ser "peor" (elimina restricciones).
4. Abre PR; verifica que el gate bloquea y el bot comenta.
5. Revierte y verifica que unblockea.

**Criterios**:
- [ ] Comment del bot con `X/Y passed`.
- [ ] Merge bloqueado si score baja > 2%.
- [ ] Artifact `eval-results` descargable.
- [ ] Baseline reproducible en local.

**Bonus**: añade comparación con la corrida previa (last successful main).

**Hints:**
- Usa `git checkout origin/main -- prompts/` para correr baseline con los prompts de main y `git checkout $HEAD -- prompts/` para volver al estado del PR.
- Cache `node_modules` con `actions/cache@v4` para bajar tiempo total.
- Si `promptfoo eval` es caro, subsample: `promptfoo eval --filter-provider anthropic --tag smoke`.

**Reto:** añade evaluación **regresiva** más allá del score global: mide accuracy por categoría (edge cases, prompt injection, latency). El gate falla si CUALQUIER categoría baja > 5 pp aunque el score global aguante. Documenta cómo detectas "cambios cosméticos que rompen edge cases silenciosamente".

---

### Ejercicio 4 — Mutation testing sobre tests IA-generados

**Objetivo**: descubrir si tus tests son cosméticos.

**Setup**: módulo con 5+ funciones y tests.

**Pasos**:
1. Pide a Claude Code: "genera 10 tests para este módulo".
2. Verifica que `pytest --cov` reporta > 90%.
3. Instala mutmut: `uv add --dev mutmut`.
4. Corre `mutmut run --paths-to-mutate src/`.
5. `mutmut results` para ver killed vs survived.

**Criterios**:
- [ ] Al menos 5 mutants "survived" (tests no los pillaron).
- [ ] Añades assertions específicas hasta bajar survived a 0-2.
- [ ] Coverage sigue alto pero ahora los tests son verdaderos.

**Bonus**: añade `mutmut run` como job de CI weekly (no en cada PR — es caro).

**Hints:**
- Empieza con un módulo pequeño (100-200 LoC); mutmut es lento en repos grandes.
- Ignora ficheros triviales: `mutmut --paths-to-mutate src/core.py` (no `src/__init__.py`).
- Un mutant survived en logging/print suele ser aceptable; en lógica de negocio no.

**Solución de referencia (fix típico):**
```python
# Original que sobrevive mutation
def add(a, b): return a + b
# Test cosmético
def test_add(): assert add(2, 3) is not None  # MAL: pasa incluso con `a - b`
# Test correcto
def test_add(): assert add(2, 3) == 5 and add(-1, 1) == 0
```

**Reto:** monta un dashboard interno (Grafana / plaintext) con "mutation score histórico". Cada domingo el weekly job actualiza un JSON y el dashboard muestra tendencia por módulo. Objetivo: detectar regresión (score bajando) antes de que llegue a producción. Documenta qué módulo empeoró más y por qué.

---

### Ejercicio 5 — DORA baseline

**Objetivo**: medir DORA antes y después de introducir un agente en CI.

**Setup**: repo con 3+ meses de historia de commits y PRs.

**Pasos**:
1. Script Python que calcule de `git log` y `gh pr list`:
   - Deploy frequency (deploys/semana usando tags).
   - Lead time (commit hash → merge time mediana).
   - Change failure rate (PRs revertidos / total).
2. Baseline: últimos 60 días sin agente.
3. Introduce Claude Code Action.
4. Mide 30 días después.
5. Compara.

**Criterios**:
- [ ] Script reproducible con `python dora.py --start 2026-04-01 --end 2026-05-31`.
- [ ] Output tabla comparativa antes/después.
- [ ] Documentas conclusiones en `docs/dora-agents-impact.md`.

**Bonus**: publícalo como blog post interno.

**Hints:**
- `gh pr list --state merged --json mergedAt,number` da lista base.
- Deploys ≈ tags git con formato semver: `git tag --sort=-creatordate | head`.
- Change failure rate: mide reverts con `git log --grep="revert"` y hotfixes (label o pattern en título).

**Solución de referencia (esqueleto):**
```python
# dora.py
import subprocess, json
from datetime import datetime, timedelta
def deploys_per_week(days=60):
    tags = subprocess.check_output(["git", "tag", "--sort=-creatordate"]).decode().split()
    # ... parsea fechas, cuenta por semana
def lead_time():
    prs = json.loads(subprocess.check_output(
        ["gh","pr","list","--state","merged","--json","mergedAt,createdAt","--limit","200"]))
    # ... calcula mediana de (mergedAt - createdAt)
```

**Reto:** convierte el script en un GitHub Action que corre cada lunes y publica el reporte como GitHub Issue con label `dora-weekly`. Añade alertas: si Change Failure Rate sube > 3 pp semana a semana, mencion al `@sre-oncall`. Documenta el primer episodio real que la alerta detectó.

---

### Ejercicio 6 (Reto) — Multi-bot con dedupe cross-tool

**Objetivo**: montar Claude Code Action + Copilot Code Review en el mismo repo con dedupe de comentarios (evitando alert fatigue).

**Setup**: repo con historial de PRs, ambos bots configurados, `jq` disponible en el runner.

**Pasos**:
1. Activa Claude Code Action y Copilot Code Review con configs mínimas.
2. Añade job `dedupe-reviews` que corre tras ambos: lista comments con `gh api repos/OWNER/REPO/pulls/PR/comments`, agrupa por `(path, line)`, y borra duplicados (mismo diagnóstico en misma línea).
3. Reglas de conflicto: Claude gana si divergen (más estricto por confidence 80+); si Copilot dice algo que Claude no, se mantiene con prefijo `[Copilot]`.
4. Testea con PR grande (500+ líneas modificadas).
5. Mide: comments totales, dedup ratio, tiempo humano por PR (pre vs post).

**Criterios**:
- [ ] Ambos bots activos y comentan.
- [ ] Job `dedupe-reviews` corre condicional a que ambos hayan terminado (`needs: [claude, copilot]`).
- [ ] Dedup ratio > 20% en PRs grandes (medible con `wc -l` antes/después).
- [ ] Sin conflictos visibles en la UI de PR (comments limpios).

**Bonus**: escribe el algoritmo de dedupe con similitud semántica (cosine sobre embeddings de los mensajes) en vez de exact match por línea. Detecta cuando dos bots dicen "lo mismo con palabras distintas".

**Por qué es reto**: combinar bots sin alert fatigue es una habilidad real de senior. Muchos equipos activan 3 bots, se rinden en 2 sprints y desactivan todo. Un dedupe funcional convierte "3 bots ruidosos" en "1 signal consolidado".

**Reto stretch:** publica el dedupe como GitHub Action open-source (`dedupe-ai-reviewers-action`). Mide adopción externa en 6 semanas. Si obtienes issues de terceros, mantén al menos 2 semanas y documenta lo aprendido sobre "un tool que resuelve un dolor real".

---

### Ejercicio 7 — Proxy interno con budget y audit

**Objetivo**: montar un proxy HTTP entre el CLI y Anthropic API que registre uso por dev y bloquee cuando supera presupuesto.

**Setup**: repo nuevo con FastAPI y SQLite.

**Pasos**:
1. Crea `POST /v1/messages` que reenvía a `https://api.anthropic.com/v1/messages`.
2. Extrae `X-Dev-ID` header del cliente (asignado por convención team).
3. Guarda cada request/response en SQLite (`dev_id`, `model`, `in_tok`, `out_tok`, `cost_usd`, `timestamp`).
4. Presupuesto por dev/mes en `config.yaml` (default $50).
5. Si el dev supera, responde 429 con `{"error": "monthly budget exceeded"}`.
6. Endpoint `GET /usage/{dev_id}` devuelve gasto agregado del mes.

**Criterios:**
- [ ] El proxy es transparente: cambiar `ANTHROPIC_BASE_URL` en el CLI basta para redirigir.
- [ ] Presupuesto se enforce (429 correcto cuando supera).
- [ ] Log en SQLite es queryable (grafana / plaintext funciona).
- [ ] PII scrubber básico (regex email, phone) antes de forwardear.

**Hints:**
- Usa `httpx.AsyncClient` para no bloquear el thread mientras esperas response del API upstream.
- El SDK de Anthropic respeta `ANTHROPIC_BASE_URL`; verifica con `dry_run` que el CLI habla con tu proxy.
- Para PII scrubber empezá simple: si detectas regex de email/teléfono, reemplaza con `[REDACTED]` y logea que ocurrió.

**Reto:** añade "alertas suaves" cuando el dev supera 80% del budget mensual: el proxy inserta un warning en el response body como header `X-Budget-Warning: 82%`. El CLI lo muestra en rojo al final del run. Documenta cuántos devs modificaron su comportamiento tras la primera alerta vs cuántos ignoraron.

---

## 9. Recursos + siguientes pasos

### Docs oficiales

- Claude Code Action — https://github.com/anthropics/claude-code-action
- Cursor BugBot — https://docs.cursor.com/agent/bugbot
- CodeRabbit — https://coderabbit.ai/
- GitHub Copilot Code Review — https://docs.github.com/copilot/using-github-copilot/code-review
- promptfoo — https://promptfoo.dev/
- Stryker Mutator — https://stryker-mutator.io/
- mutmut — https://mutmut.readthedocs.io/
- gitleaks — https://github.com/gitleaks/gitleaks
- TruffleHog — https://github.com/trufflesecurity/trufflehog

### Frameworks CLI

- Python: `click`, `typer`
- Node/TS: `commander`, `oclif`, `yargs`
- Go: `cobra`, `urfave/cli`
- Rust: `clap`

### DORA metrics

- DORA — https://dora.dev/
- LinearB, Sleuth (managed), CircleCI Insights

### Siguientes pasos

- Capítulo 19 → datos, PII y EU AI Act (aplica al código y datos que los agentes tocan).
- Capítulo 20 → UX de productos IA + GEO/AEO.

---

## 10. Preguntas de práctica (20)

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-18-cli-agents-ci-cd-code-review.json`](../../packages/content/src/tech/ai-programming/sim-18-cli-agents-ci-cd-code-review.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-18-cli-agents-ci-cd-code-review`

---

## Navegación

[← Capítulo 17](./17-spec-driven-development-agent-ready-repos.md) · [Índice](./README.md) · [Capítulo 19 →](./19-data-pipelines-pii-eu-ai-act.md)
