# Capítulo 17 — Spec-Driven Development y repos para agentes

> **Focus:** Spec-Driven Development (SDD), GitHub Spec Kit v0.11 (jun 2026), Amazon Kiro (may 2026), tests como especificación ejecutable, `CLAUDE.md` vs `AGENTS.md`, `.cursor/rules`, agent-ready repos, tipos fuertes, invariantes, commits atómicos, plan→spec→generate loop.
> **Áreas:** Nuevas prácticas de dev con IA
> **Preguntas:** 20 · **Tiempo:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

### Pre-requisitos

- Capítulo 08 — Code agents y computer use (Claude Code, Cursor, Devin).
- Capítulo 09 — Evals y golden datasets (los tests son la spec ejecutable).
- Capítulo 12 — Agent sandboxing y guardrails (para agentes que ejecutan `write` y `bash`).
- Conocimiento básico de git, Markdown, Python o TypeScript.
- CLI de un agente instalada: `npm i -g @anthropic-ai/claude-code` o Cursor IDE.

### Glosario mínimo

| Término | Definición corta |
|---|---|
| **SDD** | Spec-Driven Development. La spec (Markdown estructurado) es el artefacto primario; el código es su output. |
| **Spec Kit** | Toolkit oficial de GitHub para SDD; workflow `/specify` → `/plan` → `/tasks` → `/implement`. |
| **Kiro** | IDE agéntico de AWS (May 2026) construido nativamente sobre SDD; sustituto de Amazon Q Developer. |
| **CLAUDE.md** | Archivo de instrucciones proyecto-local que Claude Code carga automáticamente. |
| **AGENTS.md** | Estándar cross-tool (Codex, Cursor, Gemini CLI) emergente en 2026. |
| **Agent-ready repo** | Codebase estructurada para maximizar la probabilidad de éxito de un agente autónomo. |
| **Invariante** | Propiedad que debe cumplirse siempre; se expresa en tipos, guards, tests y docs. |
| **Regenerabilidad** | Capacidad de reconstruir el código 100% desde la spec sin drift. |

### Setup rápido

```bash
# Instalar Spec Kit (jun 2026)
uvx specify init my-feature

# Alternativa con Node
npx @github/spec-kit init my-feature

# Instalar Claude Code
npm install -g @anthropic-ai/claude-code
claude --version    # >= 1.2 (jun 2026)

# Crear CLAUDE.md base
claude init         # genera CLAUDE.md desde la estructura del repo
```

---

## 1. El gran cuadro

En 2024 el término *vibe coding* (Karpathy) describía a devs escribiendo prompts vagos y aceptando lo que salía. Funcionaba para prototipos pero colapsaba en producción: el agente inventaba APIs, escribía código que compilaba pero no cumplía requisitos, y no había forma de auditar por qué había tomado tal decisión. **Spec-Driven Development (SDD)** es la respuesta industrial a ese caos. La idea central es sencilla y radical: **invertir la relación entre spec y código**. La spec (qué + por qué + criterios de aceptación) es la fuente de verdad; el código es un artefacto derivable. Si la spec cambia, regeneras. Si el código diverge de la spec, es un bug.

En 2025-2026 aparecen dos referentes claros. **GitHub Spec Kit** (open-source, sep 2025 → v0.11 en jun 2026) formaliza el pipeline en cuatro etapas: `/specify` (qué), `/plan` (cómo), `/tasks` (unidades ejecutables), `/implement` (código + tests). Cada etapa es un archivo Markdown que la siguiente lee. **Amazon Kiro** (may 2026, lanzamiento internacional) hace lo mismo desde un IDE agéntico y directamente reemplaza a Amazon Q Developer: nuevas altas bloqueadas desde May 15 2026, EoS de Q Developer en abril 2027. En paralelo, **Kent Beck** publica su serie sobre TDD-para-agentes argumentando que los tests son la especificación ejecutable definitiva cuando el agente hará el 80% del código.

El otro eje del capítulo son los **agent-ready repos**: codebases diseñadas explícitamente para que un LLM las entienda al primer intento. Un repo agent-ready tiene `CLAUDE.md` o `AGENTS.md` en la raíz (contexto proyecto-local), tipos fuertes en lugar de comentarios, módulos con side effects aislados, commits atómicos con títulos descriptivos, y READMEs que funcionan como spec compacta. La diferencia entre un repo agent-ready y uno legacy típico se mide en tokens: en el legacy, Claude Code necesita explorar 40 archivos antes de proponer un diff; en el agent-ready, con 3-5 archivos ya sabe qué hacer.

Un matiz confirmado por Anthropic en mayo 2026 tiene impacto operativo: **Claude Code NO lee `AGENTS.md` nativamente**. Aunque `AGENTS.md` es el estándar cross-tool (Codex, Cursor, Gemini CLI, Windsurf lo consumen), Claude Code sigue leyendo únicamente `CLAUDE.md`. La solución oficial recomendada por Anthropic es un **symlink** (`ln -s AGENTS.md CLAUDE.md`) o un **import** (`@AGENTS.md` dentro de `CLAUDE.md`). En equipos Windows sin Developer Mode, el symlink requiere privilegios elevados; el import es la ruta cross-platform segura.

Finalmente, el capítulo evita el **cargo cult SDD**: escribir specs elaboradas para renombrar variables o fixear typos. La regla de Kent Beck y del propio Spec Kit v0.11 (que añadió *lite mode* explícitamente por feedback en 2026) es que la ceremonia debe ser proporcional al tamaño del cambio. SDD brilla en features nuevas, refactors grandes, migraciones y tareas delegadas a un agente sin supervisión. Para un typo, salta directo al diff.

---

## 2. Fundamentos (básico)

### 2.1 Qué es una spec ejecutable

Una spec ejecutable **no es un documento Word**. Es un artefacto versionable que el agente puede leer, seguir y verificar. En Spec Kit toma forma de tres archivos Markdown:

```
specs/001-user-auth/
├── spec.md      # QUÉ y POR QUÉ (user stories, acceptance criteria)
├── plan.md      # CÓMO (arquitectura, decisiones técnicas, trade-offs)
└── tasks.md     # UNIDADES ejecutables numeradas (T001, T002, ...)
```

Ejemplo mínimo de `spec.md`:

```markdown
# Feature: Login con Google OAuth

## Contexto
Los usuarios actuales se autentican con email + password. Queremos añadir
"Login con Google" para reducir fricción en el onboarding.

## User story
Como visitante nuevo, quiero iniciar sesión con mi cuenta Google
para no tener que recordar otra contraseña.

## Acceptance criteria
- [ ] Botón "Login con Google" visible en /login
- [ ] Redirect a Google OAuth con scope=email,profile
- [ ] Callback en /auth/google/callback crea o recupera usuario
- [ ] Email verificado por Google se marca `emailVerified=true`
- [ ] Se emite JWT con 24h de validez
- [ ] Tests E2E cubren happy path y usuario que cancela

## Out of scope
- Login con Facebook / Apple (feature separada)
- Migración de usuarios existentes email→OAuth (feature futura)
```

Con esto en el repo, `claude "implementa spec 001-user-auth"` produce código anclado a criterios, no inventado.

**Analogía útil.** SDD es a los agentes lo que TDD fue a los devs junior: la disciplina de escribir *primero* el contrato inequívoco, y *después* el código. La diferencia es que ahora el "junior" es un LLM que produce 300 líneas en 20 segundos; sin contrato, ese output es un pozo de bugs difíciles de detectar en review.

**Desglose paso a paso de una spec bien formada:**

1. **Contexto** (2-4 frases): por qué existe esta feature. Sin esto, el agente no puede priorizar trade-offs.
2. **User story** en formato "Como *rol*, quiero *acción* para *beneficio*". Define quién, qué y por qué.
3. **Acceptance criteria** como checklist `- [ ]` verificables *ejecutables*. Prohibido "debe funcionar bien"; sí "responde 200 en < 500 ms al percentil 95".
4. **Out of scope** explícito para limitar la ambición del agente. Un LLM sin límites añade auth, analytics y cache a un endpoint que solo pedías hello-world.
5. **Referencias** a docs internos, ADRs, tickets anteriores.

**Ejemplo before/after — de brief vago a spec ejecutable.**

Prompt inicial que un PM manda al equipo:

```
"Necesitamos exportar reportes en Excel. Que se pueda descargar desde
el dashboard. Hazlo bonito."
```

Un agente con este brief inventa: elige librería (openpyxl, xlsxwriter o pandas), decide formato de columnas, mete un botón dentro del hero del dashboard sin permiso, y probablemente añade envío por email "porque queda mejor". Todos los reviewers pierden horas.

Refactor a spec ejecutable:

```markdown
# Feature 042: Export de reportes en Excel

## Contexto
Finance necesita descargar los reportes mensuales (actualmente PDF-only)
como XLSX para poder pegar fórmulas y hacer pivot en su flujo interno.
El PDF sigue existiendo para stakeholders externos.

## User story
Como usuario Finance, quiero clicar "Export → Excel" en un reporte
para descargar un XLSX con las mismas cifras que el PDF.

## Acceptance criteria
- [ ] Botón "Export → Excel" aparece junto al "Export → PDF" existente
- [ ] Descarga XLSX en < 3 s para reportes de hasta 50k filas (p95)
- [ ] Cabeceras congeladas (freeze pane) en fila 1
- [ ] Formato numérico contable (2 decimales, separador de miles)
- [ ] Nombre de archivo: `report_<yyyy-mm>_<report_id>.xlsx`
- [ ] Cifras coinciden 1:1 con las del PDF equivalente (test de paridad)

## Out of scope
- Envío por email (feature separada 043)
- Export CSV / JSON (ya existe endpoint API)
- Estilos avanzados (colores condicionales, gráficos embebidos)

## Referencias
- ADR-018 (elección librería XLSX): usar openpyxl para consistencia con stack
- Ticket FIN-2211 (petición original de Finance)
```

Ahora el agente sabe qué construir, qué NO tocar y contra qué comparar. Los tests casi se escriben solos leyendo los criterios.

**Ejemplo before/after — acceptance criteria débiles vs fuertes.**

Débiles:

```markdown
- [ ] El endpoint debe ser rápido
- [ ] Manejar errores correctamente
- [ ] Compatibilidad con navegadores modernos
```

Fuertes (verificables por test):

```markdown
- [ ] `POST /reports/export` responde 200 en p95 < 3 s con 50k filas
- [ ] Timeout > 30 s devuelve 504 con body `{ "code": "E_TIMEOUT", "trace_id": "..." }`
- [ ] Compatibilidad probada en Chrome ≥ 120, Firefox ≥ 122, Safari ≥ 17 (Playwright matrix)
```

La versión fuerte permite escribir un test failing por línea. La débil solo permite discusiones en review.

### 2.2 Tests como especificación

En TDD tradicional el ciclo es *red → green → refactor* y lo hace un humano. En SDD moderno el agente hace *green* y *refactor*; tú (o el agente) escribes los tests failing primero. El test es un contrato no-ambiguo, ejecutable y automatizable en un feedback loop.

```python
# tests/test_bereavement_refund.py — spec ejecutable
def test_bereavement_refund_requires_ticket_purchased_before_death():
    """La política de Air Canada (post-2024): NO retroactivo."""
    ticket = Ticket(purchased_at="2024-11-05", passenger="Moffatt")
    death_date = "2024-11-04"
    with pytest.raises(PolicyViolation, match="must be purchased before"):
        request_bereavement_refund(ticket, death_date)
```

El agente lee el test, entiende el contrato, y escribe `request_bereavement_refund` que lo satisface. Si escribe algo que no compila o falla, itera hasta que pasa.

Segundo ejemplo con boundary + negative + happy path juntos:

```python
# tests/test_slug_generator.py
import pytest
from url_shortener.storage import generate_slug, SlugCollision

def test_slug_has_fixed_length():
    assert len(generate_slug()) == 7                  # invariante de tamaño

def test_slug_alphanumeric_only():
    import re
    assert re.fullmatch(r"[a-zA-Z0-9]+", generate_slug())

def test_slug_collision_retries_then_raises():
    with pytest.raises(SlugCollision):
        # simula 10 intentos con seed determinista → fuerza colisión
        for _ in range(10):
            generate_slug(seed=42)
```

El agente ve tres contratos: forma (length), forma (alfabeto) y comportamiento en fallo. Con solo happy-path habría escrito una función que rompe en corner cases.

### 2.3 CLAUDE.md, AGENTS.md, .cursor/rules

Tres archivos con el mismo propósito (dar contexto proyecto-local al agente) pero consumidos por herramientas distintas:

| Archivo | Leído por | Estándar |
|---|---|---|
| `CLAUDE.md` | Claude Code | Anthropic (propietario) |
| `AGENTS.md` | Codex, Cursor, Gemini CLI, Aider, Windsurf, Goose | Cross-tool (`agents.md` spec) |
| `.cursor/rules/*.mdc` | Cursor IDE | Cursor (hierarchical) |

Ejemplo mínimo de `CLAUDE.md`:

```markdown
# CLAUDE.md

Este es un monorepo pnpm (NUNCA usar npm o yarn).

## Comandos que debes correr después de cambios
- `pnpm typecheck`  (obligatorio antes de proponer diff)
- `pnpm test:unit`  (unit tests)
- `pnpm lint --fix` (formato)

## Convenciones
- TypeScript strict, sin `any`. Si necesitas escape, usa `unknown` + narrowing.
- Nombres largos y precisos > cortos abstractos. Prohibido: `data`, `tmp`, `helper`.
- Errores custom: extiende `AppError`, nunca `throw new Error(string)`.

## Directorios que no debes modificar sin ask
- `packages/legacy-*`  (código deprecated en migración)
- `.github/workflows/` (requiere revisión SRE)

## Referencias
- Spec del feature actual: @specs/current/spec.md
- Convenciones cross-tool: @AGENTS.md
```

**Ejemplo before/after — CLAUDE.md inservible vs útil.**

Antes (versión que Claude Code ignora en la práctica):

```markdown
# CLAUDE.md
Este repo usa buenas prácticas de código.
Por favor sé cuidadoso con los cambios.
Escribe código de calidad y testea bien.
```

Zero información accionable. El agente inventará: `npm test` (aunque uses pnpm), `throw new Error(...)` (aunque tengas `AppError`), y meterá `console.log` de debug en producción.

Después (accionable y verificable):

```markdown
# CLAUDE.md
Monorepo pnpm 9. NUNCA `npm` ni `yarn`.

## Comandos (obligatorios antes de proponer diff)
- `pnpm typecheck`
- `pnpm test:unit -- --run`

## Reglas duras
- No `console.log`. Usa `logger.info({ ... }, "msg")`.
- Errores: `throw new AppError({ code, message, cause })`.
- Sin `any`. Escape permitido: `unknown` + narrowing.

## Prohibido tocar sin `ask` explícito
- `.github/workflows/**`
- `packages/legacy-*/**`
```

La diferencia observable: con el "antes", `claude "añade /health"` produce Express + `npm test` (roto). Con el "después", produce el handler correcto, corre `pnpm test:unit` y usa `AppError`.

### 2.4 Repo agent-ready mínimo

Los cinco ingredientes básicos:

1. `README.md` corto con "qué hace, cómo se corre, dónde están los tests".
2. `CLAUDE.md` (o `AGENTS.md` + symlink) con comandos y convenciones.
3. Tipos fuertes activados (`"strict": true` en `tsconfig.json` o `mypy --strict`).
4. Tests con nombres descriptivos que se pueden correr con un comando (`pnpm test`).
5. Commits atómicos con títulos convencionales (`feat:`, `fix:`, `refactor:`).

**Mini-código funcional: generador de esqueleto agent-ready** (útil para bootstrap):

```python
# scripts/bootstrap_agent_ready.py — 12 líneas
from pathlib import Path

FILES = {
    "AGENTS.md": "# AGENTS.md\n\n## Comandos\n- `make test`\n- `make lint`\n",
    "CLAUDE.md": "# CLAUDE.md\n\n@AGENTS.md\n\n## Notas Claude Code\n- Usa Grep tool.\n",
    ".claude/hooks/post-tool-use.sh": "#!/bin/bash\nmake test\n",
    "specs/.gitkeep": "",
}
for path, content in FILES.items():
    p = Path(path); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(content)
print("agent-ready skeleton created")
```

---

## 3. Cómo funciona por dentro (medio)

### 3.1 El pipeline `/specify` → `/plan` → `/tasks` → `/implement`

Cada slash-command en Spec Kit es un template Markdown que el agente interpreta. El flujo con Claude Code:

```
Usuario                    Agente                     Filesystem
   │                          │                            │
   │  /speckit.specify        │                            │
   │──────────────────────────▶                            │
   │                          │  crea specs/001/spec.md    │
   │                          │────────────────────────────▶
   │  (review humano)         │                            │
   │◀─────────────────────────│                            │
   │                          │                            │
   │  /speckit.plan           │                            │
   │──────────────────────────▶                            │
   │                          │  lee spec.md               │
   │                          │◀───────────────────────────│
   │                          │  crea specs/001/plan.md    │
   │                          │────────────────────────────▶
   │  (review humano)         │                            │
   │                          │                            │
   │  /speckit.tasks          │                            │
   │──────────────────────────▶                            │
   │                          │  crea tasks.md (T001..T0N) │
   │                          │────────────────────────────▶
   │                          │                            │
   │  /speckit.implement      │                            │
   │──────────────────────────▶                            │
   │                          │  ejecuta T001, T002...     │
   │                          │  corre tests, itera        │
   │                          │────────────────────────────▶
```

Punto crítico: **entre etapas hay checkpoint humano**. Sin ese review, el agente propaga malentendidos a `plan.md` y luego a `tasks.md` y termina generando código elegante que resuelve el problema equivocado.

**Cómo se propaga un malentendido si saltas los checkpoints.**

```
      spec.md            plan.md            tasks.md           código
   ┌───────────┐      ┌───────────┐      ┌───────────┐      ┌───────────┐
   │ "sistema  │  →   │ "usa      │  →   │ T01 setup │  →   │ 800 LoC   │
   │  de tags" │      │  Postgres │      │ Postgres  │      │ Postgres  │
   │           │      │  jsonb"   │      │ jsonb"    │      │ jsonb OK  │
   └───────────┘      └───────────┘      └───────────┘      └───────────┘
        │                  │                  │                  │
        │  ambiguo:        │  amplificado:    │  concretado:     │  ejecutado
        │  ¿multi-tenant?  │  jsonb sin       │  índices GIN     │  y desplegado
        │  ¿jerárquicos?   │  índice          │  omitidos        │  → prod slow
        │                  │                  │                  │
        ▼                  ▼                  ▼                  ▼
   Checkpoint 1        Checkpoint 2       Checkpoint 3       Rollback (caro)
```

La lección: cada checkpoint humano son 5 minutos que ahorran 5 horas de rollback.

### 3.2 Hierarchical loading de rules

Cursor con `.cursor/rules/*.mdc` y Claude Code con `CLAUDE.md` por directorio implementan el mismo patrón: **reglas más específicas overridean generales**.

```
repo/
├── CLAUDE.md                      # Reglas del monorepo
├── packages/
│   ├── frontend/
│   │   └── CLAUDE.md              # Reglas frontend (React, Tailwind, RSC)
│   ├── api/
│   │   └── CLAUDE.md              # Reglas backend (FastAPI, SQLAlchemy)
│   └── shared/
│       └── CLAUDE.md              # Reglas compartidas (Zod schemas)
```

Cuando el agente trabaja dentro de `packages/api/`, Claude Code carga `packages/api/CLAUDE.md` **después** del root, así las convenciones API pueden pisar las generales.

**Precedencia visual con conflicto real:**

```
                    (raíz)
                       │
                       │ "no `any`, TS strict"
                       │ "logger.info(..)"
                       ▼
             ┌─────────────────────┐
             │  CLAUDE.md (root)   │
             └─────────────────────┘
                       │
       ┌───────────────┼──────────────┐
       │               │              │
       ▼               ▼              ▼
   frontend/        api/          scripts/
   "React 19"    "FastAPI"      "any permitido"
   "no server"   "no client"    "print() OK"
                                (override root)
```

El módulo `scripts/` explícitamente relaja las reglas: permite `any` y `print()` porque son one-off scripts. El agente lee la cadena de abajo hacia arriba: primero `scripts/CLAUDE.md` → luego `root/CLAUDE.md`, y la primera regla que aparezca gana.

### 3.3 Tipos fuertes vs comentarios

Los comentarios mienten porque el compilador no los verifica. Los tipos no pueden mentir sin romper el build.

```typescript
// MAL: el comentario puede quedar desactualizado
// data is a user object with id (string) and email
function process(data) {
  return sendEmail(data.email);
}

// BIEN: el tipo es enforced
type User = { id: UserId; email: EmailAddress; emailVerified: boolean };
function process(user: User): Promise<MessageId> {
  return sendEmail(user.email);
}
```

Para agentes, `TypeScript strict`, `mypy --strict`, Rust y Kotlin dan mucha más señal que Python untyped o JavaScript. Un branded type (`type UserId = string & { __brand: 'UserId' }`) previene que el agente pase un `orderId` donde se espera un `userId`.

Ejemplo extendido con branded types que previenen bugs sutiles:

```typescript
// packages/shared/ids.ts — nominal typing en TypeScript estructural
type Brand<T, B> = T & { readonly __brand: B };

export type UserId = Brand<string, 'UserId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type ProductId = Brand<string, 'ProductId'>;

// smart constructors: única forma de crear el tipo
export const userId = (raw: string): UserId => {
  if (!/^usr_[a-zA-Z0-9]{16}$/.test(raw)) {
    throw new InvariantViolation(`invalid UserId: ${raw}`);
  }
  return raw as UserId;
};

// Bug que TypeScript ahora atrapa antes del runtime:
declare function assignOrder(user: UserId, order: OrderId): void;
const uid = userId("usr_abc0123456789def");
const oid = "ord_xyz" as OrderId;

assignOrder(oid, uid);  // ERROR: Argument of type 'OrderId' not assignable to 'UserId'
assignOrder(uid, oid);  // OK: compila
```

El agente que ve esta API no puede confundir orden de argumentos ni pasar un `string` desnudo. En un repo sin brands, ese bug cruza review porque "es un string y funciona en dev".

### 3.4 Invariantes redundantes

Un invariante importante ("un balance nunca es negativo") vive en cuatro sitios:

```typescript
// 1. En el tipo
type NonNegativeAmount = number & { __brand: 'NonNegative' };

// 2. En el guard al construir
function amount(n: number): NonNegativeAmount {
  if (n < 0) throw new InvariantViolation(`amount must be >= 0, got ${n}`);
  return n as NonNegativeAmount;
}

// 3. En el test
test("amount rejects negative values", () => {
  expect(() => amount(-1)).toThrow(InvariantViolation);
});

// 4. En docs machine-readable
/**
 * Representa una cantidad monetaria en centavos.
 * @invariant value >= 0 (garantizado por el constructor `amount()`)
 */
```

Redundancia intencional: si el agente rompe uno, los otros lo pillan.

### 3.5 Naming intencional y magic strings

Tabla de refactor típico que un agente debería aplicar en un repo agent-ready:

| Malo | Bueno | Por qué |
|---|---|---|
| `const d = getData()` | `const rawOrders = fetchPendingOrders()` | Revela intent y estado. |
| `function doHelper(x)` | `function normalizeCustomerAddress(customer)` | El nombre = spec. |
| `if (status === "pending")` | `if (order.status === OrderStatus.Pending)` | Enum tipado; agente no inventa strings. |
| `catch (e) { console.log(e) }` | `catch (err) { logger.error({ err, orderId }, "order sync failed") }` | Estructurado, auditable. |

### 3.6 Docstrings machine-readable

Formato consistente (Google Python, JSDoc/TSDoc, Sphinx) permite al agente parsear parámetros, returns y errores sin adivinar.

```typescript
/**
 * Envía un email de confirmación de pedido.
 *
 * @param orderId - ID del pedido a confirmar.
 * @param customer - Datos del cliente (debe tener email verificado).
 * @returns Message ID devuelto por el proveedor de email.
 * @throws {ValidationError} Si customer.email es null o no está verificado.
 * @throws {ProviderError} Si el proveedor de email responde 5xx.
 * @example
 *   const msgId = await sendOrderConfirmation("ord_123", customer);
 */
export async function sendOrderConfirmation(
  orderId: OrderId,
  customer: VerifiedCustomer,
): Promise<MessageId> { ... }
```

### 3.7 Commits atómicos y su lectura por el agente

Regla: **un commit = un cambio semántico** con título convencional.

```
✅ feat(auth): add Google OAuth callback handler
✅ fix(rag): retry embed call on 429 with exponential backoff
✅ refactor(orders): extract PII redaction to dedicated module
❌ WIP
❌ fixes
❌ update
❌ final version 2 (this time for real)
```

Cuando el agente escanea `git log --oneline -50`, aprende la evolución del repo. Bad commit history = agente con amnesia.

### 3.8 Bajo el capó: cómo un agente "entiende" un repo

Cuando corres `claude "añade endpoint /users"` en un repo grande, por dentro pasan cuatro fases que conviene visualizar:

```
┌──────────────────┐   ┌─────────────────┐   ┌──────────────────┐   ┌──────────────┐
│ 1. Bootstrap     │──▶│ 2. Discovery    │──▶│ 3. Planning      │──▶│ 4. Execution │
│ CLAUDE.md +      │   │ Grep/Glob/Read  │   │ diff mental +    │   │ Edit + tools │
│ tree structure   │   │ (hasta N files) │   │ validation local │   │ + re-verify  │
└──────────────────┘   └─────────────────┘   └──────────────────┘   └──────────────┘
       │                       │                      │                     │
       │ 2-4k tokens           │ 15-60k tokens        │ 3-8k tokens         │ 5-30k tokens
       │ (contexto proyecto)   │ (código relevante)   │ (razonamiento)      │ (diffs + logs)
```

**Fase 1 (Bootstrap).** El agente carga `CLAUDE.md` (o `AGENTS.md` via import), lista el árbol raíz con `ls -la` y detecta el stack (busca `package.json`, `pyproject.toml`, `Cargo.toml`). Un `CLAUDE.md` con comandos exactos y estructura de carpetas evita 20-40k tokens de exploración a ciegas.

**Fase 2 (Discovery).** Aquí es donde repos legacy queman contexto. Sin tipos ni docstrings, el agente lee un archivo, no entiende, lee otro para desambiguar y así en cadena. En un repo agent-ready típico bastan 3-5 lecturas; en uno legacy suele necesitar 15-40. La regla empírica: cada tipo fuerte ahorra ~1 lectura por callsite.

**Fase 3 (Planning).** El modelo escribe internamente un plan (a veces visible con `--verbose`) y valida contra los archivos ya leídos. Si detecta ambigüedad, hace más Grep. Si el plan implica romper una convención (importar `npm` cuando `CLAUDE.md` dice pnpm), el buen agente pregunta antes de escribir.

**Fase 4 (Execution).** Aplica Edits, dispara hooks `post-tool-use` que corren typecheck + tests, y si algún exit code es `2` (convención de Claude Code), el output vuelve al contexto como feedback. Un loop bien afinado converge en 2-4 iteraciones; sin hooks, el agente escribe y "espera lo mejor".

**Consecuencia práctica.** Cada anti-patrón del repo (comentarios obsoletos, `any`, magic strings, dead code) multiplica lecturas en Fase 2. Un refactor "make it agent-ready" no es cosmética: es reducir latencia y coste real por tarea.

**Loop de convergencia con hooks (visualizado):**

```
   ┌──────────────────────────────────────────────────────────┐
   │                    Agente principal                       │
   └───────────────┬─────────────────────────────▲────────────┘
                   │ Edit tool                    │ stdout (exit 2)
                   ▼                              │
        ┌────────────────────┐          ┌────────────────────┐
        │ .claude/hooks/     │─── run ─▶│ pnpm typecheck     │
        │ post-tool-use.sh   │          │ pnpm test:unit     │
        └────────────────────┘          └──────────┬─────────┘
                                                   │
                                        pass       │      fail
                                   ┌───────────────┴──────────┐
                                   ▼                          ▼
                              exit 0                     exit 2 + stdout
                              (silencio)                (feedback al LLM)
```

Con hooks, el agente cierra el loop sin humano. Sin hooks, cada iteración pide input; el ciclo se rompe y los devs aceptan diffs sin validar.

---

## 4. Práctica avanzada (senior)

### 4.1 Cuándo aplicar SDD y cuándo saltárselo

Matriz de decisión basada en Spec Kit v0.11 y Kent Beck:

| Contexto | ¿SDD? | Razón |
|---|---|---|
| Feature nueva de tamaño medio-grande | Sí, completo | Máximo retorno; ambigüedad alta. |
| Refactor arquitectural | Sí, completo | Impacto amplio; documentación es el output. |
| Delegación a agente autónomo sin supervisión | Sí, obligatorio | Sin spec el agente inventa. |
| Migración de módulo (patrón claro) | Lite (skip `/plan`) | Repetible; `/tasks` basta. |
| Bug fix con reproducción clara | No | Test failing es la spec. |
| Rename de variable / typo | No | Overhead > valor. |
| Spike / prototype exploratorio | No | La spec emerge al final. |
| Hotfix producción a las 3 AM | No | Fix rápido, spec después. |

Klarna documentó en 2025 que forzar SDD en cambios pequeños les redujo velocity un 30%; esa fricción es la razón de que Spec Kit v0.11 introdujera *lite mode*.

### 4.2 Anti-patrones frecuentes

- **Cargo cult SDD**: spec de 200 líneas para renombrar `getUsr` → `getUser`. Consecuencia: equipo abandona el proceso.
- **Spec sin acceptance criteria**: descripción narrativa sin `- [ ]` verificables. El agente no sabe cuándo terminó.
- **Skip `/plan`**: saltar de spec a tasks sin plan arquitectural. El agente elige librerías incompatibles con tu stack.
- **CLAUDE.md sin comandos**: "usa buenas prácticas" en vez de `pnpm test:unit`. El agente adivina y falla.
- **Módulos con side effects ocultos**: `import "./analytics"` que arranca un tracker global. El agente cambia un import y rompe métricas.
- **Comentarios como spec**: `// this function must not be called on Sundays` sin código que lo enforze. Nadie lee comentarios; el agente menos.
- **Dead code sin cleanup**: agente modifica funciones que nadie llama pensando que importan. Correr `ts-prune` / `vulture` mensual.
- **Commits WIP masivos**: `git log` inutil; agente sin memoria histórica.
- **Un solo `CLAUDE.md` gigante en la raíz**: 5000 líneas ilegibles. Mejor jerarquía por package.
- **AGENTS.md sin bridge a Claude Code**: si tu equipo usa varios agentes, Claude Code se queda sin contexto. Symlink o import.

### 4.3 Monorepo vs polyrepo desde el POV del agente

En 2026, con contextos de 200K+ tokens (Claude Sonnet 4.5) y 1M+ tokens (Gemini 2.5 Pro), el monorepo gana casi siempre para agentes:

**Monorepo** (`pnpm workspaces` + turbo/nx):
- Agente ve relaciones cross-package (cambio en `@app/shared` afecta `@app/api`).
- Refactor cross-package trivial: renombrar función y todos sus callers en una sola sesión.
- Un `CLAUDE.md` raíz + overrides por package.
- Contra: repo grande, indexación inicial cara.

**Polyrepo**:
- Aislamiento fuerte, deploys independientes.
- Contra: el agente no ve dependencias cross-repo; refactors coordinated dolorosos; contexto fragmentado.

Si eliges polyrepo, invierte en `AGENTS.md` detallado en cada repo listando integraciones esperadas.

### 4.4 Regenerabilidad vs artesanía

Ideal aspiracional: código regenerable 100% desde spec. Realidad: hay optimizaciones, edge cases, workarounds de librerías bugged que no viven bien en spec. La estrategia sana es tratar spec + código como un par que se actualiza junto:

- Cambio de comportamiento → actualiza `spec.md`, `tests`, código en un solo PR.
- Optimización interna sin cambio de contrato → solo código.
- Bug fix → añade test failing (extensión de spec), luego fix.

Si el drift se vuelve grande (spec dice X, código hace Y), la spec deja de ser útil. Mejor borrarla y regenerar que dejarla mentir.

### 4.5 Agente que se corrige contra tests

Loop automatizado con hooks de Claude Code (`.claude/hooks/post-tool-use.sh`):

```bash
#!/usr/bin/env bash
# Se ejecuta después de cada Edit/Write del agente.
if git diff --quiet --exit-code -- '*.ts' '*.tsx'; then
  exit 0    # no hubo cambios en TS
fi
pnpm typecheck 2>&1 | tee /tmp/tsc.log
if [ ${PIPESTATUS[0]} -ne 0 ]; then
  echo "TYPECHECK FAILED — output above returned to agent"
  exit 2    # exit 2 devuelve stdout al agente
fi
pnpm test:unit --run 2>&1 | tee /tmp/test.log
[ ${PIPESTATUS[0]} -ne 0 ] && exit 2
```

Con esto, cada vez que el agente edita, corre tests; si fallan, el output vuelve al contexto y el agente itera.

### 4.6 AGENTS.md como estándar cross-tool + Claude Code

Setup recomendado por Anthropic (may 2026) para equipos multi-tool:

```bash
# 1. AGENTS.md es la fuente de verdad
cat > AGENTS.md <<'EOF'
# AGENTS.md

Instrucciones para todos los agentes (Codex, Cursor, Claude Code, Gemini CLI).
...
EOF

# 2a. Opción symlink (Unix / Mac / Windows con Developer Mode)
ln -s AGENTS.md CLAUDE.md

# 2b. Opción import (cross-platform, funciona en Windows sin admin)
cat > CLAUDE.md <<'EOF'
# CLAUDE.md

@AGENTS.md

## Extensiones específicas Claude Code
- Usa Read tool antes de Edit tool.
- Prefiere Grep tool sobre Bash grep.
EOF
```

La confusión típica de 2026: creer que Claude Code lee `AGENTS.md` como fallback. **No lo hace** (confirmado docs Anthropic mayo 2026). Sin symlink o import, tu contexto AGENTS.md se pierde.

---

## 5. Ejemplo práctico completo step-by-step

**Objetivo**: preparar un repo Python vacío para trabajar con Claude Code usando SDD real. Al terminar tendrás: `CLAUDE.md`, `AGENTS.md` con symlink/import, una `spec.md` para un feature, tests failing y código generado por el agente que los hace pasar.

### Paso 1 — Estructura base

**Por qué antes del código.** Sin estructura pre-definida, el agente inventa una (a veces `app/`, a veces `lib/`, a veces flat). Dedicar 30 segundos a crear directorios evita 5 minutos de refactor posterior y da al agente un mapa mental estable.

```bash
mkdir url-shortener && cd url-shortener
git init
uv init --python 3.12
uv add fastapi pytest httpx pydantic
uv add --dev mypy ruff                       # tipos + lint desde día 1
mkdir -p src/url_shortener tests specs/001-shorten

# Verificación intermedia:
uv run python -c "import fastapi; print(fastapi.__version__)"
# Si falla → deps no instaladas; abortar aquí y arreglar antes de seguir
```

### Paso 2 — Crear AGENTS.md (fuente de verdad)

`AGENTS.md`:

```markdown
# AGENTS.md — url-shortener

Servicio Python 3.12 + FastAPI + Pydantic para acortar URLs.

## Setup
- `uv sync` para instalar deps
- `uv run pytest -q` para tests
- `uv run ruff check src tests` para lint
- `uv run mypy src` para tipos (strict)

## Convenciones
- Todos los handlers async
- Pydantic v2 (`BaseModel`, no dict). Sin dicts sueltos.
- Errores: `raise HTTPException(status_code=..., detail=...)`
- Nombres: snake_case funciones, PascalCase modelos.

## Estructura
- `src/url_shortener/api.py` — routes FastAPI
- `src/url_shortener/storage.py` — persistence (in-memory por ahora)
- `src/url_shortener/models.py` — Pydantic models
- `tests/` — pytest, un archivo por módulo

## Comando antes de commit
`uv run pytest && uv run mypy src && uv run ruff check src tests`
```

**Por qué AGENTS.md primero.** Es el estándar cross-tool (Codex, Cursor, Gemini CLI). Escribirlo primero fuerza a pensar en convenciones antes de código, y cualquier agente futuro las respeta sin duplicar reglas.

### Paso 3 — Bridge para Claude Code

**Por qué el bridge.** Claude Code no lee `AGENTS.md` nativamente (confirmado docs Anthropic mayo 2026). Sin bridge, todo el contexto que escribiste se pierde para el agente que probablemente usarás más.

En Windows sin Developer Mode:

```bash
cat > CLAUDE.md <<'EOF'
# CLAUDE.md

@AGENTS.md

## Notas específicas Claude Code
- Usa el Grep tool para buscar código, no bash grep.
- Antes de proponer un diff grande, corre `uv run pytest -q` y pega el output.
EOF
```

En Linux/Mac o Windows con Developer Mode:

```bash
ln -s AGENTS.md CLAUDE.md
# Verificación:
ls -la CLAUDE.md          # debe mostrar "CLAUDE.md -> AGENTS.md"
```

**Manejo de errores comunes.** Si `ln -s` falla con "operation not permitted" en Windows, no insistas: usa la opción import. Si `@AGENTS.md` no resuelve (Claude Code < 1.2), actualiza: `npm i -g @anthropic-ai/claude-code@latest`.

### Paso 4 — Escribir spec del primer feature

**Por qué escribir spec antes de tests.** Los tests son la spec ejecutable, pero un test sin contexto de negocio ("por qué GET /:slug devuelve 307 y no 302") es ambiguo. La spec da el *por qué*; los tests dan el *cómo verificarlo*.

`specs/001-shorten/spec.md`:

```markdown
# Feature 001: Shorten URL

## User story
Como usuario, envío una URL larga a POST /shorten y recibo un slug corto
que redirige a la URL original al hacer GET /:slug.

## Acceptance criteria
- [ ] POST /shorten acepta JSON `{ "url": "https://..." }`
- [ ] Valida que url es HTTP(S) válida; rechaza otras con 400
- [ ] Genera slug de 7 chars [a-zA-Z0-9]
- [ ] Persiste (slug, url, created_at) en storage in-memory
- [ ] Responde 201 con `{ "slug": "abc1234", "short_url": "http://host/abc1234" }`
- [ ] GET /:slug con slug existente responde 307 redirect a url original
- [ ] GET /:slug con slug inexistente responde 404
- [ ] La misma URL enviada dos veces devuelve el mismo slug (idempotente)

## Out of scope
- Auth de usuarios
- Custom aliases
- Analytics / click tracking
- Expiración
```

### Paso 5 — Escribir tests failing (spec ejecutable)

**Por qué failing primero.** Un test que empieza en verde no prueba nada: quizá siempre fue verde. Ver `5 failed` antes de tocar código confirma que los tests **detectan la ausencia** de la funcionalidad; solo entonces sirven como contrato ejecutable.

`tests/test_shorten.py`:

```python
import pytest
from fastapi.testclient import TestClient
from url_shortener.api import app

client = TestClient(app)


def test_shorten_returns_201_with_slug():
    r = client.post("/shorten", json={"url": "https://example.com/very/long"})
    assert r.status_code == 201
    body = r.json()
    assert "slug" in body and len(body["slug"]) == 7
    assert body["short_url"].endswith(body["slug"])


def test_shorten_rejects_non_http():
    r = client.post("/shorten", json={"url": "ftp://example.com"})
    assert r.status_code == 400


def test_shorten_is_idempotent():
    url = "https://example.com/idempotent"
    r1 = client.post("/shorten", json={"url": url})
    r2 = client.post("/shorten", json={"url": url})
    assert r1.json()["slug"] == r2.json()["slug"]


def test_redirect_existing_slug():
    r = client.post("/shorten", json={"url": "https://example.com/redirect-me"})
    slug = r.json()["slug"]
    r2 = client.get(f"/{slug}", follow_redirects=False)
    assert r2.status_code == 307
    assert r2.headers["location"] == "https://example.com/redirect-me"


def test_unknown_slug_returns_404():
    r = client.get("/unknown", follow_redirects=False)
    assert r.status_code == 404
```

Corres `uv run pytest -q` → 5 tests failing (no existe `api.py`). Perfecto.

**Verificación intermedia.** Si en lugar de 5 failures ves un `ImportError`, es que `pyproject.toml` no tiene el package registrado. Añade:

```toml
[tool.setuptools.packages.find]
where = ["src"]
```

y re-corre. **Nunca** avances si los tests no fallan de la forma esperada: el agente confiaría en un contrato roto.

### Paso 6 — Lanzar Claude Code

**Por qué prompt explícito con archivos.** Un prompt vago ("implementa la feature") gasta tokens en discovery. Referenciar spec + tests concretos ancla al agente a un contrato conocido.

```bash
claude "Lee specs/001-shorten/spec.md y los tests en tests/test_shorten.py. \
Implementa src/url_shortener/api.py, models.py y storage.py hasta que \
todos los tests pasen. Respeta AGENTS.md. Corre uv run pytest después de cada cambio."
```

El agente:
1. Lee `AGENTS.md`, `spec.md`, `test_shorten.py`.
2. Crea `models.py` con `ShortenRequest` y `ShortenResponse` (Pydantic).
3. Crea `storage.py` con dict in-memory y método `get_or_create`.
4. Crea `api.py` con las dos rutas.
5. Corre `uv run pytest` → probablemente 1 test falla (typo en slug length).
6. Itera hasta 5/5 verde.

**Output exacto esperado tras la última iteración:**

```
============================= test session starts ==============================
platform darwin -- Python 3.12.3, pytest-8.2.0, pluggy-1.5.0
collected 5 items

tests/test_shorten.py::test_shorten_returns_201_with_slug PASSED         [ 20%]
tests/test_shorten.py::test_shorten_rejects_non_http PASSED              [ 40%]
tests/test_shorten.py::test_shorten_is_idempotent PASSED                 [ 60%]
tests/test_shorten.py::test_redirect_existing_slug PASSED                [ 80%]
tests/test_shorten.py::test_unknown_slug_returns_404 PASSED              [100%]

============================== 5 passed in 0.42s ===============================
```

**Manejo de errores durante el agente.** Si tras 3 iteraciones sigue rojo, para al agente (Ctrl+C) e inspecciona: normalmente el error es una ambigüedad en la spec (por ejemplo, no dijiste si `slug` es case-sensitive). Corrige la spec, no fuerces al agente a adivinar.

### Paso 7 — Verificación humana

**Por qué revisar aunque los tests pasen.** Los tests cubren *contratos*, no arquitectura. El agente pudo haber puesto el storage como global mutable (funciona pero no thread-safe), inventado un endpoint extra, o metido `print()` como logging.

```bash
uv run pytest -v          # 5 passed
uv run mypy src           # no errors
uv run ruff check src     # no issues
git status                # ver el diff
git diff src/             # revisar antes de commit
```

### Paso 8 — Commit atómico

```bash
git add specs/ src/ tests/ AGENTS.md CLAUDE.md
git commit -m "feat(shorten): implement POST /shorten and GET /:slug per spec 001"
```

Resultado: en ~15 minutos tienes un feature completo, con spec versionada, tests que la ejecutan y código regenerable si cambias la spec.

### Paso 9 — Extendiendo el ejemplo

Tres mejoras naturales que refuerzan hábitos SDD:

**Mejora 1 — Persistencia real (Redis).** Actualiza `specs/001-shorten/spec.md` añadiendo el criterio `- [ ] Los slugs persisten tras reiniciar el proceso`. Corre `claude "regenera storage.py para usar Redis manteniendo la misma interfaz get_or_create"`. Los tests siguen siendo los mismos (no dependen de la implementación) y validan que el contrato se respeta. Aquí ves regenerabilidad en acción: la spec cambió, el código se regeneró, los tests siguen siendo el ancla.

**Mejora 2 — Feature 002 con dependency del 001.** Crea `specs/002-analytics/spec.md`: "cada visita a GET /:slug incrementa contador atómico". Escribe test failing:

```python
def test_click_counter_increments():
    r = client.post("/shorten", json={"url": "https://example.com/x"})
    slug = r.json()["slug"]
    client.get(f"/{slug}"); client.get(f"/{slug}")
    stats = client.get(f"/stats/{slug}").json()
    assert stats["clicks"] == 2
```

Observa cómo el agente reutiliza el storage sin romperlo. Si lo rompe, los tests del feature 001 fallan y el hook `post-tool-use` te avisa.

**Mejora 3 — Hook automatizado.** Añade `.claude/hooks/post-tool-use.sh` que corre `uv run pytest -q && uv run mypy src` tras cada edit. Con esto el loop se cierra: agente edita → hook verifica → si falla, el output vuelve al contexto sin humano en medio. En 2026 los equipos que usan hooks reportan 40-60% menos tiempo por feature.

### Paso 10 — Variaciones y edge cases

**Variación A — Agente en Cursor en lugar de Claude Code.** El mismo repo funciona con Cursor apuntando a `AGENTS.md`. Regla de portabilidad: si tu setup requiere Claude Code para funcionar, tienes un vendor-lock indeseado. Prueba `cursor .` y pídele "implementa spec 001-shorten"; debe converger igual sin tocar `CLAUDE.md`.

**Variación B — Feature con dependencia externa mockeable.** Añade a `spec.md`: "el slug se envía a un webhook `POST $WEBHOOK_URL` con payload `{ slug, url }`". Test con `respx` (mock HTTPX):

```python
import respx, httpx

@respx.mock
def test_webhook_called_on_shorten(monkeypatch):
    monkeypatch.setenv("WEBHOOK_URL", "https://hook.example.com")
    route = respx.post("https://hook.example.com").mock(return_value=httpx.Response(200))
    client.post("/shorten", json={"url": "https://example.com/x"})
    assert route.called
    assert route.calls.last.request.content  # contiene slug + url
```

Un agente sin este test podría "olvidar" el webhook porque la spec lo menciona en prosa; con el test failing, no.

**Edge case 1 — URLs muy largas (> 8 KB).** El body puede exceder el límite default de FastAPI. Test:

```python
def test_shorten_rejects_url_too_long():
    long_url = "https://example.com/" + "a" * 8100
    r = client.post("/shorten", json={"url": long_url})
    assert r.status_code == 413  # Payload Too Large
```

El agente ajusta límite en FastAPI (`max_body_size`) y devuelve 413 en vez de 500.

**Edge case 2 — Colisión de slug bajo carga.** Con 7 chars alfanuméricos hay ~78^7 ≈ 1.7e13 combinaciones, pero bajo carga alta las colisiones ocurren. Test:

```python
def test_slug_collision_retries():
    from url_shortener.storage import generate_slug
    seen = set()
    for _ in range(1000):
        s = generate_slug()
        assert s not in seen
        seen.add(s)
```

Si el agente implementó `generate_slug` con `random.choices` sin retry, este test falla eventualmente. Forzarlo revela el bug antes de producción.

**Edge case 3 — Concurrencia en storage in-memory.** Con `TestClient` sincrónico no lo pillas; usa `httpx.AsyncClient` + `asyncio.gather`:

```python
import asyncio, httpx

@pytest.mark.asyncio
async def test_concurrent_shorten_no_collisions():
    async with httpx.AsyncClient(app=app, base_url="http://test") as ac:
        results = await asyncio.gather(*[
            ac.post("/shorten", json={"url": f"https://ex.com/{i}"})
            for i in range(100)
        ])
    slugs = [r.json()["slug"] for r in results]
    assert len(set(slugs)) == 100  # todos únicos
```

Si el storage no es thread-safe (dict + no lock), este test flakes. La solución (asyncio.Lock o Redis) queda documentada como decisión.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas mentales

- ✅ **La spec es el artefacto primario** en features medium-large; el código es su output.
- ✅ **`AGENTS.md` como fuente de verdad**, `CLAUDE.md` como bridge (symlink o `@import`).
- ✅ **Checkpoint humano entre `/specify`, `/plan`, `/tasks`, `/implement`**.
- ✅ **Tipos fuertes > comentarios**. `strict: true` siempre.
- ✅ **Invariante en 4 sitios**: tipo + guard + test + docstring.
- ✅ **Naming intencional**; prohibido `data`, `helper`, `tmp`, `util`.
- ✅ **Commits atómicos** con títulos convencionales (`feat:`, `fix:`, `refactor:`).
- ✅ **Prune código muerto** mensualmente (`ts-prune`, `vulture`, `deadcode`).
- ✅ **README por package** = qué, cómo, invariantes, comando de tests.
- ✅ **Hierarchical `CLAUDE.md`** en monorepos; más específica overridea.
- ✅ **Lite mode SDD** (skip `/plan`) para tareas repetibles.
- ✅ **Hook `PostToolUse`** que corre tests y devuelve output al agente.

### Anti-patrones

- ❌ Aplicar SDD a todo (cargo cult) → equipo abandona el proceso.
- ❌ Spec sin acceptance criteria verificables → agente inventa el "done".
- ❌ CLAUDE.md sin comandos concretos → agente adivina `npm test`.
- ❌ AGENTS.md sin bridge a Claude Code → contexto perdido.
- ❌ Módulos con side effects ocultos → agente rompe cosas sin verlo.
- ❌ Comentarios como spec → mienten, agente confía y falla.
- ❌ Dead code sin cleanup → agente modifica lo muerto.
- ❌ Un CLAUDE.md monolítico 5000 líneas → ilegible; agente ignora la mitad.
- ❌ Commits WIP masivos → git log inutil como memoria.
- ❌ Polyrepo sin AGENTS.md detallado → refactor cross-repo doloroso.

### Tabla de decisión: ¿aplico SDD?

| Señal | Puntos |
|---|---|
| Feature nueva ≥ 3 días de trabajo | +3 |
| Delegación a agente autónomo | +3 |
| Cambia contrato público (API, schema) | +2 |
| Ambigüedad alta / múltiples stakeholders | +2 |
| Refactor arquitectural | +2 |
| Bug fix con test reproducible | +0 |
| Rename / typo / format | -3 |
| Spike exploratorio | -2 |
| Hotfix urgente | -3 |

Total ≥ 3 → SDD completo. Entre 0 y 2 → lite mode. Negativo → skip.

---

## 7. Casos reales industria 2026

### GitHub Spec Kit v0.11 (jun 2026)

**Qué pasó.** GitHub liberó Spec Kit como toolkit oficial open-source (MIT) en febrero 2026. En junio 2026 alcanzó v0.11 con 111k stars, 55+ releases y adopción por 30+ agentes (Copilot, Claude Code, Cursor, Gemini CLI, Codex CLI, Qwen CLI, Tabnine, Mistral, Goose, Windsurf). Comandos: `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, `/speckit.implement`. Instalación: `uvx specify init <project>`.

**Cómo se detectó el problema del overhead.** En abril 2026, equipos que aplicaban Spec Kit a todo (incluyendo bug fixes triviales) empezaron a reportar en discusiones GitHub que la ceremonia les costaba más tiempo que el fix mismo. El issue #2847 con 800+ reacciones documentó el patrón.

**Cómo se arregló.** La v0.11 introdujo *lite mode* (`--lite` en `specify init`) que salta `/plan` y usa una spec.md abreviada. Los templates ahora vienen con un flag `[minor]` que sugiere lite automáticamente.

**Qué aprendió la industria.** La ceremonia debe escalar con el tamaño del cambio; imponer el proceso completo mata adopción. El precedente lo confirmó Klarna en 2025.

### Amazon Kiro (may 2026)

**Qué pasó.** Lanzamiento internacional el 7 de mayo 2026 como reemplazo total de Amazon Q Developer. Nuevas altas de Q Developer bloqueadas desde May 15 2026, EoS full en abril 2027. Kiro trata las "specs" como entidad de primera clase en el IDE, generando requirements estructurados antes de código. Los modelos Claude Opus 4.6+ están **exclusivamente** en Kiro (no en Q Developer), model cutoff May 29 2026.

**Cómo se detectó la necesidad.** Métricas internas AWS de Q Developer mostraban que 35% del código generado necesitaba refactor mayor en < 1 sprint (post-mortems clasificaban "drift de arquitectura" y "edge cases ignorados" como causas top). El vibe coding funcionaba en demos pero no en producción.

**Cómo se arregló.** Kiro fuerza el pipeline spec-first: sin `spec.md` aprobada, el botón "Generate" está deshabilitado. Los requirements se guardan como parte del código (versionados).

**Qué aprendió la industria.** Un hyperscaler apostando a SDD como default (no como opción) valida el patrón. Otros vendors (JetBrains, Replit) anunciaron features similares en Q3 2026.

### Kent Beck — TDD 2.0 para agentes (2025-2026)

Kent Beck publicó una serie argumentando que SDD es la evolución natural de TDD: el humano escribe tests que definen el "qué"; el agente escribe código que satisface el "cómo". Añade dos conceptos: **regenerabilidad** (código regenerable 100% desde spec + tests) y **spec como contract** (el test es el contrato ejecutable no-ambiguo entre humano y agente).

### Anthropic — CLAUDE.md vs AGENTS.md (may 2026)

En mayo 2026 Anthropic confirmó oficialmente en docs que **Claude Code no lee AGENTS.md nativamente**. La solución recomendada es symlink `ln -s AGENTS.md CLAUDE.md` (Unix / Windows con Developer Mode) o import `@AGENTS.md` dentro de un `CLAUDE.md` mínimo (cross-platform). Esta clarificación resolvió el issue GitHub #6235 con 5,200+ reacciones.

### Klarna — force-SDD failure y ajuste (2025)

**Qué pasó.** Klarna adoptó SDD interno en toda la organización en 2025; documentaron 30% de reducción en velocity porque el equipo aplicaba ceremonia completa a cambios triviales.

**Cómo se detectó.** Sprint retros consecutivos citaban "spec overhead" como top blocker. Métricas DORA cayeron: lead time subió 45% para PRs pequeños.

**Cómo se arregló.** En Q4 2025 relajaron el proceso: SDD completo para features y refactors; lite / skip para bug fixes y cambios de estilo. Publicaron matriz de decisión interna (posteriormente la base del §4.1 de este capítulo).

**Qué aprendió la industria.** GitHub Spec Kit v0.11 (jun 2026) incorporó lite mode citando este tipo de feedback. Regla generalizable: cualquier proceso nuevo debe tener un "exit valve" para casos triviales.

### Anthropic — Claude Code sub-agents (feb 2026)

**Qué pasó.** Anthropic introdujo sub-agents en Claude Code: agentes especializados definidos en `.claude/agents/*.md` (por ejemplo `.claude/agents/reviewer.md`, `.claude/agents/tester.md`) que se pueden invocar desde el agente principal para delegar tareas.

**Cómo se detectó la necesidad.** Users con repos grandes reportaban que un único agente perdía foco al orquestar spec + código + tests + docs. Métrica interna Anthropic: pass@1 caía del 70% al 45% en tareas > 4 pasos.

**Cómo se arregló.** Sub-agents con contexto aislado: cada uno ve solo lo relevante para su rol. El principal orquesta, los especialistas ejecutan. Pass@1 subió a 63% en tareas multi-step.

**Qué aprendió la industria.** Delegación explícita > un solo prompt gigante. Similar al patrón multi-actor de Autogen (Microsoft, 2023) pero integrado en CLI.

### Shopify — plantillas SDD internas (mar 2026)

**Qué pasó.** Shopify publicó (en su ingeniería blog el 12 de marzo 2026) el patrón "spec templates" que usaron internamente durante 2025: cada equipo tiene 3-5 templates de spec por tipo de cambio (nueva ruta REST, migración de tabla, endpoint GraphQL, event handler). El agente rellena el template en vez de escribir prosa libre.

**Cómo se detectó la necesidad.** Auditoría interna 2025 encontró que 60% de las specs generadas por agentes tenían formatos incompatibles; los reviewers gastaban 15-20 minutos por PR solo para entender la estructura.

**Cómo se arregló.** Templates versionados en `.spec-templates/`. Comando `sdd new rest-endpoint` clona el template y el agente rellena huecos marcados con `<< ... >>`. Tiempo de review cayó a < 5 minutos por PR.

**Qué aprendió la industria.** Structure > freedom cuando el agente escribe la spec. GitHub Spec Kit v0.11 adoptó una idea similar con `template: minor|standard|full`.

### JetBrains AI Assistant — spec-mode (Q2 2026)

**Qué pasó.** JetBrains añadió en IntelliJ/PyCharm/WebStorm 2026.2 (release 24 abril 2026) un "Spec Mode" que integra el pipeline de Spec Kit dentro del IDE. Al abrir un archivo `spec.md`, el IDE muestra un panel lateral con checkboxes de acceptance criteria y un botón "Generate implementation" que dispara el agente.

**Cómo se detectó la necesidad.** Encuesta State of Developer Ecosystem 2025 (JetBrains) reveló que 47% de devs usaban agentes pero solo 12% con SDD; la fricción principal era "no está integrado en mi IDE".

**Cómo se arregló.** Integración nativa: los checkboxes de la spec se convierten en breakpoints de tests, y el IDE bloquea el commit si algún criterio no tiene test asociado.

**Qué aprendió la industria.** SDD gana adopción cuando reduce fricción, no cuando la aumenta. Los IDEs son el punto natural de integración.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — CLAUDE.md desde cero

**Objetivo**: escribir un `CLAUDE.md` que cambie el comportamiento del agente de forma observable.

**Setup**: repo cualquiera tuyo con Node o Python.

**Pasos**:
1. Corre `claude "añade un endpoint /health que devuelva 200"` sin `CLAUDE.md`. Guarda el diff.
2. Crea `CLAUDE.md` con: comandos exactos (`pnpm test:health`), estructura de directorios, formato de errores.
3. Borra el diff anterior y repite el prompt.
4. Compara ambos diffs.

**Criterios de éxito**:
- [ ] El segundo diff usa exactamente tu comando (`pnpm test:health`).
- [ ] Respeta la estructura de directorios que definiste.
- [ ] Usa el formato de errores custom que documentaste.

**Bonus**: añade una regla ("no uses console.log") y verifica que el agente la respeta.

**Hints:**
- Si el agente ignora tu comando, revisa: ¿está el `CLAUDE.md` en la raíz del repo (no en subcarpeta)? ¿tiene formato Markdown con headers?
- Usa `claude --verbose` para ver qué archivos leyó al arrancar.
- Fuerza reload si estabas en una sesión larga: `/clear` o reinicia el proceso.

**Solución de referencia (esbozo):**
```markdown
# CLAUDE.md
## Comandos obligatorios
- Tests: `pnpm test:health`
- Lint: `pnpm lint`

## Estructura de directorios
- `src/routes/` — endpoints Express
- `src/errors/` — clases AppError, ValidationError

## Formato de errores
Nunca `throw new Error(string)`. Siempre:
`throw new AppError({ code: 'E_UPSTREAM', message: '...', cause })`
```

**Reto:** convierte tu `CLAUDE.md` en una jerarquía de 3 niveles (root + `src/api/CLAUDE.md` + `src/scripts/CLAUDE.md`) donde `scripts/` explícitamente relaja reglas (permite `any`, `print`). Demuestra con un diff en cada carpeta que Claude Code respeta la precedencia.

---

### Ejercicio 2 — Bridge AGENTS.md ↔ CLAUDE.md

**Objetivo**: montar `AGENTS.md` como fuente de verdad con bridge a Claude Code.

**Setup**: repo con `AGENTS.md` que ya tiene contexto útil.

**Pasos**:
1. Verifica que Claude Code **no** lee `AGENTS.md`: prompt "cuál es el comando de tests" sin CLAUDE.md; el agente adivinará.
2. Opción A: `ln -s AGENTS.md CLAUDE.md` (Windows requiere Developer Mode o admin).
3. Opción B (cross-platform): crea `CLAUDE.md` con `@AGENTS.md` como primera línea.
4. Repite el prompt.

**Criterios**:
- [ ] Después del bridge, el agente cita el comando exacto de `AGENTS.md`.
- [ ] `git status` muestra `CLAUDE.md` como symlink o archivo con `@AGENTS.md`.
- [ ] Al modificar `AGENTS.md`, el cambio se refleja sin tocar `CLAUDE.md`.

**Bonus**: añade una regla en `AGENTS.md` y verifica que Codex/Cursor la respetan también.

**Hints:**
- En Windows, si `ln -s` falla, usa PowerShell como admin o directamente la Opción B.
- La primera línea del `CLAUDE.md` con `@AGENTS.md` es la más importante: Claude Code hace inclusión textual.
- Para debuggear, imprime el prompt final del agente con `claude --print-prompt` (flag debug).

**Solución de referencia (esbozo, Opción B):**
```markdown
# CLAUDE.md
@AGENTS.md

## Overrides específicos Claude Code
- Prefiere Grep tool sobre bash grep.
- Antes de proponer un diff > 100 líneas, resume el plan primero.
```

**Reto:** en el mismo repo, prueba el bridge con **tres agentes distintos** en paralelo: Claude Code, Cursor y Aider. Escribe una tabla comparando qué archivo leyó cada uno, cuántos tokens de contexto cargaron al arrancar (usa `--verbose` o equivalentes) y si respetaron una regla específica ("nunca uses `any`"). Publica la tabla como ADR interno.

---

### Ejercicio 3 — Spec Kit end-to-end

**Objetivo**: correr el flujo completo `/specify` → `/plan` → `/tasks` → `/implement`.

**Setup**:
```bash
uvx specify init counter-api
cd counter-api
```

**Pasos**:
1. `/speckit.specify Un contador HTTP con POST /inc, POST /dec y GET /value. Persiste en Redis.`
2. Revisa `specs/001-*/spec.md`. Añade acceptance criteria si faltan.
3. `/speckit.plan` → revisa `plan.md`. Verifica que eligió Redis client razonable.
4. `/speckit.tasks` → revisa `tasks.md`. Deben ser unidades chicas ordenadas.
5. `/speckit.implement` → deja que ejecute; revisa que corre tests entre tasks.

**Criterios**:
- [ ] Tres archivos Markdown en `specs/001-*/`.
- [ ] Cada task de `tasks.md` referencia un acceptance criteria de `spec.md`.
- [ ] Tests generados cubren happy path y al menos 2 edge cases.
- [ ] `docker-compose up redis && pytest` pasa 100%.

**Bonus**: cambia un acceptance criteria en `spec.md`, corre `/speckit.implement` de nuevo y verifica que el agente **solo** modifica lo afectado (regenerabilidad parcial).

**Hints:**
- Si `/speckit.plan` genera algo raro, edita a mano y re-corre `/speckit.tasks`. La cadena es humana entre etapas.
- Fuerza dependencia explícita entre tasks (`T003 depends on T001`) para que el agente respete orden.
- Testea con `--lite` en Spec Kit v0.11+ para tareas pequeñas.

**Solución de referencia (tasks.md típico):**
```markdown
- [ ] T001: Setup Redis client + connection retry [AC: idempotencia]
- [ ] T002: POST /inc → INCR key [AC: contador atómico]
- [ ] T003: POST /dec → DECR key [depends: T001]
- [ ] T004: GET /value → devuelve int actual [AC: read consistency]
- [ ] T005: Tests contra Redis en docker-compose
```

**Reto:** compara `/speckit.implement` con `/speckit.implement --lite`. Mide (a) tokens totales, (b) tiempo total, (c) número de bugs detectados en review. Documenta cuándo lite es adecuado y cuándo el modo completo justifica el overhead.

---

### Ejercicio 4 — Refactor "make it agent-ready"

**Objetivo**: convertir un módulo legacy en agent-ready y medir la diferencia.

**Setup**: elige un módulo Python o TypeScript de un proyecto tuyo con al menos 300 LoC, comentarios abundantes y tipos débiles.

**Pasos**:
1. Baseline: `claude "añade validación de email"` → cuenta tokens y minutos.
2. Refactor: añade tipos strict, elimina `any`/`Any`, renombra variables abstractas, extrae side effects, añade docstrings machine-readable.
3. Añade `CLAUDE.md` local al módulo.
4. Repite el prompt idéntico.

**Criterios**:
- [ ] Tokens del segundo run < 60% del primero.
- [ ] Tiempo del segundo run < mitad del primero.
- [ ] Diff propuesto compila al primer intento.
- [ ] No aparece `any` / `Any` en el nuevo código.

**Bonus**: mide con `claude --verbose` los archivos leídos antes y después; deberían caer al menos 50%.

**Hints:**
- Empieza por añadir tipos: es lo que más reduce lecturas del agente.
- Elimina comentarios que digan "what" (redundante con tipos). Mantén los que digan "why".
- Extrae side effects a un módulo `effects/` y deja los puros como default.

**Reto:** grafica en un scatter plot (token count vs tiempo) 10 tareas ejecutadas antes y después del refactor. Publica el gráfico como evidencia del ROI del refactor "make it agent-ready" para justificar tiempo de equipo dedicado a ello.

---

### Ejercicio 5 — Hook de auto-verificación

**Objetivo**: automatizar que cada Edit del agente corre tests + typecheck y le devuelve errores.

**Setup**: repo con `pytest` o `vitest` configurado.

**Pasos**:
1. Crea `.claude/hooks/post-tool-use.sh` (o `.ps1` en Windows).
2. Detecta si el cambio afectó `.py`/`.ts`.
3. Corre typecheck y tests.
4. Si falla, `exit 2` para devolver output al agente.
5. Prompt que fuerce edit erróneo: `claude "añade una función que rompa los tests intencionalmente"`.

**Criterios**:
- [ ] El hook se dispara automáticamente tras cada Edit.
- [ ] Cuando tests fallan, el agente ve el output y itera sin humano.
- [ ] Cuando tests pasan, el hook es silencioso.

**Bonus**: añade también lint y format autofix al hook.

**Hints:**
- Exit code 0 = todo bien (silencioso); exit code 2 = devuelve stdout al agente; exit code 1 = error real (aborta la sesión).
- Filtra por tipo de archivo modificado: si solo cambió `.md`, no corras tests.
- En Windows usa `.claude/hooks/post-tool-use.ps1` con `$LASTEXITCODE = 2`.

**Solución de referencia:**
```bash
#!/usr/bin/env bash
# post-tool-use.sh — corre solo si tocó código
CHANGED=$(git diff --name-only)
echo "$CHANGED" | grep -qE '\.(ts|tsx|py)$' || exit 0
uv run pytest -q 2>&1 || { echo "TESTS FAILED"; exit 2; }
uv run mypy src 2>&1 || { echo "TYPES FAILED"; exit 2; }
exit 0
```

**Reto:** añade a tu hook (a) presupuesto de tiempo (si tests toman > 30 s, corre solo los relacionados con archivos modificados usando `pytest --lf` + `--picked`) y (b) cache de resultados (skip si el hash del archivo no cambió). Mide el efecto en tiempo total de una sesión de 20 iteraciones.

---

### Ejercicio 6 (Reto) — Regenerabilidad total desde spec

**Objetivo**: demostrar regenerabilidad *completa*: borra el código de un feature y regenéralo desde spec + tests solamente. El resultado debe pasar todos los tests originales.

**Setup**: repo con al menos un feature completo (usa el del §5) y spec + tests versionados en git.

**Pasos**:
1. `git rm -rf src/url_shortener/` y commit.
2. Verifica: `uv run pytest` → 5 failing.
3. `claude "Los tests en tests/ y la spec en specs/001-shorten/ describen la implementación. Regenerarla desde cero en src/url_shortener/. No leas git history."`
4. Deja iterar hasta 5/5.
5. Compara con `git diff HEAD~1 -- src/` la implementación original vs la regenerada.

**Criterios**:
- [ ] 5/5 tests verde sin humano tocando código.
- [ ] Implementación regenerada respeta AGENTS.md (naming, tipos, estructura).
- [ ] Diff con original muestra diferencias cosméticas mínimas (< 20% de líneas cambian el mismo comportamiento).
- [ ] Coste total en tokens documentado (`claude --report-cost`).

**Bonus**: repite el ejercicio con Cursor o Gemini CLI y compara: token count, tiempo, calidad. Documenta cuál regeneró mejor.

**Por qué es reto**: expone honestamente si tu spec + tests son suficientes o si el equipo depende de contexto tribal no escrito. Un fallo aquí indica gaps en la spec, no en el agente.

**Reto stretch:** regenera **dos veces con seeds/temperaturas distintas** (o dos agentes distintos) y compara semánticamente ambas implementaciones. Si divergen en cosas no cubiertas por tests (ej: manejo de logging), extiende la spec para reducir esa varianza. Repite hasta que dos regeneraciones sean funcionalmente idénticas dentro de un margen aceptable.

---

### Ejercicio 7 — Templates de spec por tipo de cambio

**Objetivo**: crear 3 templates reutilizables de spec para tu repo (inspirado en Shopify §7).

**Setup**: repo cualquiera con al menos 2 features implementadas.

**Pasos**:
1. Analiza specs pasadas y extrae 3 patrones (por ejemplo: `rest-endpoint`, `db-migration`, `event-handler`).
2. Crea `.spec-templates/rest-endpoint.md` con placeholders `<< nombre_endpoint >>`, `<< payload_schema >>`, etc.
3. Documenta en `AGENTS.md` que las nuevas specs deben partir del template correspondiente.
4. Aplica el template a una feature nueva y mide tiempo de escritura de spec vs. escribirla de cero.

**Criterios:**
- [ ] Los 3 templates cubren > 70% de los tipos de cambio históricos del repo.
- [ ] El template tiene checkboxes de acceptance criteria pre-poblados con lo estándar (auth, rate limit, logging).
- [ ] Tiempo de escritura de spec baja al menos 40%.

**Hints:**
- Empieza por copiar una spec pasada y sustituir las partes específicas por placeholders.
- Un buen template obliga a pensar en observabilidad y errores, no solo en happy path.
- Versiona los templates: cambios al template deben ir a un PR revisado por el equipo.

**Reto:** integra los templates con un CLI (`bash scripts/new-spec.sh rest-endpoint "user profile"`) que crea la carpeta `specs/NNN-user-profile/` con `spec.md` del template. Mide adopción en 2 sprints.

---

## 9. Recursos + siguientes pasos

### Docs oficiales

- GitHub Spec Kit — https://github.com/github/spec-kit
- GitHub Blog — Spec-Driven Development (2025-2026) — https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/
- Amazon Kiro — https://aws.amazon.com/kiro/
- Anthropic — Claude Code docs — https://docs.anthropic.com/en/docs/claude-code
- AGENTS.md spec — https://agents.md/
- Cursor Rules — https://docs.cursor.com/context/rules

### Frameworks y herramientas

- `uvx specify` — Spec Kit CLI (Python)
- `ts-prune` (TypeScript), `vulture` (Python), `deadcode` (JS) — detectar código muerto
- `pnpm workspaces` + `turbo` — monorepo
- `mypy --strict`, `pyright`, `tsc --strict` — tipos enforcement
- `ruff`, `eslint`, `biome` — lint

### Lectura recomendada

- Kent Beck — "TDD in the Age of AI Agents" (blog series 2025-2026)
- Anthropic — "Building effective agents" (dec 2024)
- Martin Fowler — Domain-Driven Design (base para modules aislados)

### Siguientes pasos

- Capítulo 18 → llevar los agentes al CI/CD (Claude Code Action, CodeRabbit, Cursor bugbot).
- Capítulo 19 → gobernanza de datos y compliance (EU AI Act aplica al código que generas).
- Capítulo 20 → UX de productos IA.

---

## 10. Preguntas de práctica (20)

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-17-spec-driven-development-agent-ready-repos.json`](../../packages/content/src/tech/ai-programming/sim-17-spec-driven-development-agent-ready-repos.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-17-spec-driven-development-agent-ready-repos`

---

## Navegación

[← Capítulo 16](./16-ai-infra-aws-bedrock-sagemaker.md) · [Índice](./README.md) · [Capítulo 18 →](./18-cli-agents-ci-cd-code-review.md)
