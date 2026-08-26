# Capítulo 01 — Cultura DevOps y métricas DORA

> **Focus:** Qué ES DevOps realmente (cultura, no herramientas), CALMS framework, las 4 métricas DORA que la industria usa para medir performance, mitos comunes (velocidad vs estabilidad), "you build it you run it", blameless postmortems, error budgets, y por qué la mayoría de "transformaciones DevOps" fracasan por razones organizacionales, no técnicas.
> **Áreas:** Cultura DevOps · Métricas DORA · Prácticas de equipos elite
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Haber trabajado al menos en un equipo con procesos de release (semanales, mensuales, ad-hoc).
- Nociones básicas de qué es un pipeline CI/CD (aunque sea Jenkins clásico).
- Alguna experiencia con Git en equipo (branches, PRs, code review).
- Familiaridad con la idea de "producción" vs "staging" vs "dev".
- Ideal: leer previamente cualquier caso público de post-mortem (Cloudflare, GitLab, AWS) para contexto.

**Glosario mínimo:**
- **DevOps**: cultura + prácticas + herramientas que unen Development y Operations bajo responsabilidad compartida por todo el ciclo de vida del software. **NO** es un puesto de trabajo ni un stack tecnológico.
- **CALMS**: framework de 5 pilares (Culture, Automation, Lean, Measurement, Sharing) propuesto por Damon Edwards y John Willis (2010) para evaluar madurez DevOps.
- **DORA**: DevOps Research and Assessment, grupo fundado por Nicole Forsgren, Jez Humble y Gene Kim; adquirido por Google Cloud en 2018. Publica el *State of DevOps Report* anual.
- **Deployment Frequency**: cuán a menudo despliegas a producción (métrica DORA de *throughput*).
- **Lead Time for Changes**: tiempo desde `git commit` hasta código corriendo en producción.
- **Change Failure Rate (CFR)**: % de deploys que causan rollback, hotfix o incidente (métrica de *stability*).
- **MTTR / MTTX**: Mean Time To Restore/Recover. Tiempo desde inicio de incidente hasta restauración del servicio.
- **Blameless postmortem**: análisis post-incidente centrado en causas sistémicas, sin atribuir culpa individual. Práctica popularizada por Etsy y Google SRE.
- **Toil**: trabajo operativo manual, repetitivo, sin valor duradero. Google SRE define un cap del 50% del tiempo de un SRE.
- **Error budget**: la fracción de "no cumplir SLO" que el equipo puede gastar antes de congelar features. Convierte estabilidad en decisión política, no técnica.
- **Westrum culture types**: taxonomía de culturas organizacionales (Pathological / Bureaucratic / Generative) creada por el sociólogo Ron Westrum; usada por DORA como predictor de performance.

**Setup mínimo (para instrumentar tus propias métricas DORA):**

```bash
# Verificar herramientas base (2026)
git --version               # 2.47+ recomendado
gh --version                # GitHub CLI 2.60+ para queries API
jq --version                # 1.7+ para parsear JSON

# Instalar Four Keys (implementación open-source de DORA)
# Google publica una versión de referencia con BigQuery + Cloud Run
git clone https://github.com/dora-team/fourkeys.git
cd fourkeys

# Alternativa liviana: usar el API de GitHub para calcular las 4 métricas
# Deployment Frequency: contar deploys a producción (workflows con environment=production)
gh api "/repos/OWNER/REPO/deployments?environment=production&per_page=100" | jq 'length'

# Lead Time: diff entre merge_commit_sha date y deployment.created_at
gh api "/repos/OWNER/REPO/pulls?state=closed&base=main" \
  --jq '.[] | {merged_at, sha: .merge_commit_sha}'

# Change Failure Rate: buscar issues con label "incident" o "rollback" en últimos 30d
gh issue list --label incident --state all --limit 200 --json createdAt,closedAt

# MTTR: para cada incident, closedAt - createdAt
```

En 2026, herramientas SaaS como **LinearB**, **Sleuth**, **Faros** y **Cortex** calculan las 4 métricas DORA automáticamente conectándose a GitHub/GitLab, Jira/Linear y tu sistema de deployment. El *State of DevOps Report 2024* (publicado por Google Cloud en octubre 2024) es la referencia con benchmarks actualizados.

---

## 1. El gran cuadro

DevOps no es un puesto de trabajo, no es Jenkins, no es Kubernetes, no es "automatización". DevOps es una **respuesta cultural** al problema del "muro" que separaba a los desarrolladores (que querían empujar cambios rápido) de los operadores (que querían estabilidad y calma). Patrick Debois acuñó el término en 2009 durante los **DevOpsDays** de Ghent, Bélgica, después de que Flickr presentara la famosa charla *"10+ Deploys Per Day: Dev and Ops Cooperation"* (Velocity 2009, John Allspaw y Paul Hammond). La solución al muro no fue una herramienta nueva; fue eliminar el muro. Contratar "un ingeniero DevOps" para que "haga el DevOps" del equipo recrea el silo con un nombre nuevo, y es probablemente el antipatrón más común de la industria en 2026.

La razón por la que este capítulo abre el track de DevOps no es sentimentalismo: es que las **métricas dicen exactamente lo mismo**. El libro *Accelerate* (Nicole Forsgren, Jez Humble, Gene Kim, 2018) analizó estadísticamente miles de equipos y encontró que las prácticas técnicas correlacionan con la performance del equipo (throughput + stability), pero las **prácticas culturales** (colaboración, aprendizaje continuo, seguridad psicológica, autonomía) tienen efecto igual o mayor. Un equipo con Kubernetes y sin cultura Westrum "generativa" queda estancado en Medium. Un equipo con máquinas físicas y cultura fuerte puede ser Elite. Esto no es opinión: son datos de 30.000+ equipos globales encuestados durante 8+ años del *State of DevOps Report*.

El segundo pilar del capítulo son las **cuatro métricas DORA**, que se convirtieron en el lenguaje común de la industria para medir performance de ingeniería. Dos miden *throughput* — Deployment Frequency y Lead Time for Changes — y dos miden *stability* — Change Failure Rate y Failed Deployment Recovery Time (antes llamada MTTR). El insight contraintuitivo que estableció DORA: los equipos Elite son mejores en **ambos ejes simultáneamente**. El viejo mito "si vas rápido rompes cosas" es estadísticamente falso. Los equipos que despliegan varias veces al día también fallan menos y se recuperan más rápido, porque batches pequeños son más fáciles de diagnosticar y revertir.

El tercer pilar es la práctica de **error budgets** popularizada por Google SRE, que convierte la tensión eterna entre "features rápido" y "estabilidad" en una decisión política manejada por datos. Si el SLO de disponibilidad es 99.9%, el error budget es 0.1% (~43 min/mes). Si te lo gastas, se congelan features hasta recuperarte. Esto elimina la eterna discusión "dev quiere features, ops quiere estabilidad" porque el número decide. Combinado con **blameless postmortems** (Etsy 2012, Google SRE Book 2016), forma la base cultural de equipos de alto rendimiento sostenible. Al final del capítulo tendrás vocabulario común con cualquier equipo DevOps senior del mundo, herramientas para medir tu propio equipo, y capacidad para diagnosticar por qué la mayoría de transformaciones DevOps fracasan.

---

## 2. Fundamentos (nivel básico)

### 2.1 Qué ES y qué NO ES DevOps

DevOps es tres cosas en orden estricto: **cultura**, **prácticas**, **herramientas**. Cambiar el orden es el error más común. Instalar GitLab + Kubernetes + ArgoCD sin cambiar cómo los devs y ops trabajan juntos produce lo que Gene Kim llama *"DevOps theater"*: teatro de DevOps. La cultura precede.

Definición operativa (compatible con Amazon, Google, Netflix, Etsy):

> DevOps es una forma de organizar equipos donde **quien construye el software también lo opera en producción**, con responsabilidad compartida sobre el ciclo completo (desde la idea hasta el retiro del sistema), soportada por prácticas de entrega continua y automatización.

Anti-patrones frecuentes que **NO** son DevOps:

- "Contratamos un DevOps engineer" → recrea el silo bajo otro nombre.
- "Tenemos un equipo DevOps" → mismo silo, mismo problema.
- "Migramos a Kubernetes" → tecnología sin cambio cultural.
- "Automatizamos deploys" → uno de los cinco pilares de CALMS, no la totalidad.
- "Hacemos daily standups con ops" → colaboración de superficie sin cambio en la ownership.

Modelos que **SÍ** son DevOps:

- **Amazon "two-pizza teams"** (2003): cada equipo dueño de su servicio end-to-end, incluida rotación on-call. Werner Vogels lo formalizó en 2006 con *"you build it, you run it"*.
- **Google SRE** (2003+): SREs comparten la ownership operativa con equipos de producto usando error budgets como contrato. Cuando un SRE gasta >50% en toil, el trabajo se devuelve al equipo de producto.
- **Netflix Freedom & Responsibility**: equipos autónomos, chaos engineering, cero tolerancia a MTTR alto.
- **Etsy**: publicó *"Continuous Deployment"* en 2011, blameless postmortems como norma.

### 2.2 El framework CALMS

**CALMS** (Damon Edwards + John Willis, 2010) es el modelo de 5 pilares más citado para evaluar madurez DevOps:

| Letra | Pilar | Qué significa en la práctica |
|-------|-------|------------------------------|
| **C** | Culture | Devs y ops en el mismo equipo, misión compartida, sin blame. |
| **A** | Automation | Cualquier tarea manual repetitiva se automatiza (build, test, deploy, provisioning, on-call playbooks). |
| **L** | Lean | Value stream mapping, WIP limits, batches pequeños, eliminar waste (heredado del Toyota Production System). |
| **M** | Measurement | Métricas objetivas (DORA, SLIs) para decidir, no opiniones ni HIPPO ("highest paid person's opinion"). |
| **S** | Sharing | Knowledge base pública, brown bags, blameless postmortems, ADRs (Architecture Decision Records). |

El diagnóstico honesto es que la mayoría de las empresas puntúan alto en **A** (automation) y bajo en **C**, **L** y **S**. Ese perfil se llama coloquialmente *"CI/CD sin cambio cultural"* o *"DevOps de fachada"*. Los efectos son visibles: pipelines verdes pero devs que dicen "eso no es mi problema, lo cambia ops"; deploys automatizados pero release trains mensuales; dashboards por doquier pero decisiones tomadas por HIPPO.

### 2.3 Ejemplo mínimo: reservar un lote de features vs deploy continuo

Considera dos equipos con la misma velocidad de features:

**Equipo A (batch mensual):**
- 200 cambios acumulados durante 30 días.
- Release nocturno de un viernes.
- Testing manual en QA durante la semana previa.
- Cuando algo rompe en producción: 2 días para identificar cuál de los 200 cambios fue el culpable.
- Rollback: revertir 200 cambios (imposible sin perder features útiles).

**Equipo B (deploy continuo):**
- 1 cambio deploya inmediatamente después del merge.
- Feature flags para desacoplar deploy de release.
- Canary automático al 5% del tráfico durante 10 min con analysis de métricas.
- Cuando algo rompe: el cambio culpable es EL último merge. Rollback trivial (redeploy del build previo o desactivar el flag).

El equipo B no es "más rápido" — hace el mismo trabajo. Es **radicalmente más seguro** porque el tamaño del batch determina el riesgo. Esta es la intuición detrás de la métrica DORA de Deployment Frequency: no es vanidad; es señal de que la infraestructura + cultura permiten reducir el batch a 1.

### 2.4 Las 4 métricas DORA (introducción)

| Métrica | Categoría | Elite | High | Medium | Low |
|---------|-----------|-------|------|--------|-----|
| **Deployment Frequency** | Throughput | On-demand (varias/día) | Diaria a semanal | Semanal a mensual | Mensual a semestral |
| **Lead Time for Changes** | Throughput | <1 hora | 1 día - 1 semana | 1 semana - 1 mes | 1-6 meses |
| **Change Failure Rate** | Stability | 0-15% | 16-30% | 16-30% | 46-60% |
| **Failed Deployment Recovery Time** | Stability | <1 hora | <1 día | 1 día - 1 semana | 1 semana - 1 mes |

*Rangos aproximados según el patrón consistente del State of DevOps Report entre 2019 y 2024; algunas categorías se han renombrado o consolidado a lo largo de los años (por ejemplo "Elite" y "High" se fusionaron temporalmente en 2022 y se volvieron a separar en 2023-2024).*

Insight fundamental: los Elite son mejores en **las cuatro simultáneamente**. No hay trade-off.

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 De dónde salen las métricas: definiciones operativas

DORA es un framework de *medición*, pero cada métrica requiere definiciones operativas para tu contexto. Errores comunes:

**Deployment Frequency**: ¿qué cuenta como "deploy"?
- ✅ Un artefacto llegando a un ambiente `production`.
- ❌ Un merge a `main` (eso es integration, no deployment).
- ✅ Un canary al 5% cuenta (aunque no sea 100% del tráfico).
- ⚠️ Un feature flag rollout NO es un deployment (es un release, categoría diferente).

**Lead Time for Changes**: reloj empieza cuándo, termina cuándo.
- Start: `git commit` que ENTRA a `main` (no el primer commit del branch).
- End: el commit sirviendo tráfico en producción (no en staging).
- Fórmula: `deployed_at - merged_at` por commit, medir mediana + p90.

**Change Failure Rate**: qué cuenta como "fallo".
- ✅ Rollback ejecutado (manual o automático).
- ✅ Hotfix desplegado <24h después.
- ✅ Incident con severity ≥ SEV3 causado por el deploy.
- ❌ Bug reportado 2 semanas después (eso es un bug latente, no un deployment failure).

**Failed Deployment Recovery Time** (2024+, antes "MTTR"):
- Se mide SOLO cuando hubo un failed deployment.
- Start: momento en que el deploy fallido produce el impacto medible.
- End: servicio restaurado (rollback completado o fix desplegado + verificado).

Google renombró "MTTR" a "Failed Deployment Recovery Time" en el State of DevOps Report 2024 porque MTTR se confundía con métricas de reliability generales (no necesariamente causadas por deploys).

### 3.2 Instrumentación real con GitHub Actions + Prometheus

Para medir tu propia Deployment Frequency y Lead Time, instrumenta el pipeline:

```yaml
# .github/workflows/deploy-prod.yml
name: Deploy Production
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Compute lead time
        id: lead
        run: |
          # commit time (autor original)
          COMMIT_TIME=$(git log -1 --format=%ct)
          # merge time (cuando entra a main)
          MERGE_TIME=$(git log -1 --format=%ct HEAD)
          NOW=$(date +%s)
          LEAD_SEC=$((NOW - COMMIT_TIME))
          echo "lead_seconds=$LEAD_SEC" >> $GITHUB_OUTPUT
          echo "Lead time: ${LEAD_SEC}s"

      - name: Deploy
        run: ./scripts/deploy-prod.sh

      - name: Emit DORA metrics
        run: |
          curl -X POST https://pushgateway.internal/metrics/job/dora \
            --data-binary @- <<EOF
          # TYPE dora_deployment_total counter
          dora_deployment_total{env="production",service="linguadev"} 1
          # TYPE dora_lead_time_seconds gauge
          dora_lead_time_seconds{env="production"} ${{ steps.lead.outputs.lead_seconds }}
          EOF
```

Consultas PromQL para dashboards Grafana:

```promql
# Deployment Frequency por semana
sum(increase(dora_deployment_total{env="production"}[7d]))

# Lead Time p50 y p90 durante 30 días
histogram_quantile(0.50, rate(dora_lead_time_seconds_bucket[30d]))
histogram_quantile(0.90, rate(dora_lead_time_seconds_bucket[30d]))

# Change Failure Rate: deploys que dispararon rollback / total deploys
sum(increase(dora_deployment_failure_total[30d]))
  /
sum(increase(dora_deployment_total[30d]))
```

### 3.3 Westrum: la variable oculta que predice performance

El sociólogo británico **Ron Westrum** (2004) clasificó culturas organizacionales según cómo circula la información:

```
              PATHOLOGICAL       BUREAUCRATIC         GENERATIVE
              (poder)            (reglas)             (performance)
              -----------        ------------         ------------
Cooperation   low                modest               high
Messengers    "shot"             ignored              trained
Blame         "scapegoating"     "justice"            inquiry
Novelty       crushed            problem              implemented
Failure       concealment        mercy                inquiry
```

El *State of DevOps Report* usa el cuestionario Westrum como predictor. Empresas con cultura **generativa** puntúan Elite en DORA con mucha mayor frecuencia. Empresas patológicas (donde matar al mensajero es norma) casi nunca escalan más allá de Medium, sin importar cuánto Kubernetes tengan.

Test rápido para tu equipo:
1. ¿Cuando alguien reporta un problema en producción, lo primero es "¿quién lo causó?" o "¿qué falló en el sistema?"?
2. ¿La información fluye lateral entre equipos, o requiere escalar a jefes?
3. ¿Los failures son oportunidades de aprender, o razones para castigar?

Las respuestas predicen tus DORA mejor que tu stack tecnológico.

### 3.4 Blameless postmortem: el mecanismo cultural

Etsy publicó *"Blameless PostMortems and a Just Culture"* en 2012 (John Allspaw). Google SRE Book lo canonizó (2016, cap 15). El principio: dado un incidente, asumimos que **cualquier persona con el mismo contexto, en el mismo momento, con las mismas herramientas, habría cometido el mismo error**. La conclusión no es "castigar al humano" sino "arreglar el sistema que permitió el error".

Estructura mínima de post-mortem blameless:

```markdown
## Incident #INC-2026-047 — DB connection pool exhaustion

**Impact:** 12 min de errores 503 en /api/lessons; ~4.2% de requests afectados.
**Detected by:** alert AL-042 (error rate >2% durante 3 min) — Sat 2026-11-08 03:14 UTC.
**Resolved:** 03:26 UTC (12 min).
**Failed deployment recovery time:** 12 min.
**Change failure attribution:** SÍ, deploy prev-15min introdujo query lenta.

### Timeline (UTC)
- 03:00 — deploy v2.147 (batch update: cache-warming query).
- 03:14 — alert AL-042 dispara.
- 03:16 — IC (Ana) declarada; canal #inc-047 abierto.
- 03:19 — hipótesis: pool DB saturado (dashboard muestra 100/100 activas).
- 03:22 — rollback iniciado (v2.146).
- 03:26 — métricas recuperadas.

### What went well
- Alert AL-042 disparó en 3 min (SLI cumplido).
- Rollback script ejecutó en <2 min (auto).
- ChatOps mantuvo comms limpias.

### What went badly
- La query nueva se testeó en staging con 10 conns, pero pool prod = 100 y saturó.
- El pool metric no tenía alert propio; solo detectamos vía error rate.

### Root causes (systemic)
1. **Falta de load test con perfil de conexiones prod-like.**
2. **Ausencia de alert sobre pool utilization.**
3. **Deploy Sat 03:00 UTC coincidió con pico regional APAC.**

### Action items
- [ ] AI-1: Añadir alert pool_utilization > 80% (owner: SRE, due 2026-11-15)
- [ ] AI-2: Añadir load test con 100 conn en pipeline pre-prod (owner: DB team)
- [ ] AI-3: Evitar deploys Sat 00:00-06:00 UTC salvo hotfix (owner: releases)
```

Ninguna sección dice "Fulanito no debió mergear". Todas las conclusiones son *sistémicas*.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Error budgets como contrato dev-ops

Google SRE Book capítulo 3: si el SLO es 99.9% disponibilidad mensual, el error budget es **0.1% = 43.2 min/mes**. Este número se convierte en un contrato explícito:

**Política de error budget** (ejemplo textual):

```
1. Mientras el error budget del mes esté por encima del 50%, el equipo
   dev puede desplegar features libremente.

2. Cuando el error budget cae por debajo del 50%, todos los deploys
   requieren aprobación del SRE lead.

3. Cuando el error budget se agota (0% restante), FREEZE:
   solo deploys de reliability, seguridad o rollback.

4. El freeze se levanta cuando el budget del window (30 días rolling)
   vuelve por encima del 30%.

5. El error budget se calcula sobre la unión de todos los SLIs con
   peso proporcional al impacto de negocio.
```

Esto elimina la eterna guerra "dev vs ops" porque el número decide. Ni management ni el hero del equipo pueden overridear. Netflix, Google, Spotify, Booking.com usan variantes de este patrón.

### 4.2 Toil budget: el 50% de Google SRE

Google define **toil** como trabajo operativo que es: manual, repetitivo, automatizable, tactical, sin valor duradero, y que escala linealmente con el servicio. Ejemplos: aprobar manualmente cada deploy, ejecutar runbooks copy-paste, resetear passwords ad-hoc, ajustar quota tickets.

La regla: **si un SRE gasta >50% de su tiempo en toil, es un smell**. Acciones:
1. Devolver responsabilidad operativa al equipo de producto (el "you build it you run it" real).
2. Automatizar el runbook (idealmente convertirlo en self-service).
3. Hiring adicional (último recurso).

Toil bajo lleva a burnout y turnover; toil alto lleva a heroísmo y falta de mejora estructural. El toil budget es tan importante como el error budget.

### 4.3 Trade-offs de cada nivel DORA

Ir de Low → Medium → High → Elite tiene costos reales que rara vez se discuten:

| Nivel | Beneficios | Costos reales |
|-------|-----------|---------------|
| Low → Medium | Reducción de outages, batches menores | Necesitas CI que funciona; inversión ~1-2 devs full-time durante 6-12 meses |
| Medium → High | Rollbacks triviales, mejor calidad de vida on-call | Feature flags obligatorios; observability madura; ~$50-200k/año en tooling |
| High → Elite | Deploys sin miedo, moral alta del equipo | Test coverage alto; canary + rollback automáticos; chaos engineering; requiere equipo de plataforma dedicado |

Anti-patrón: **saltar Medium → Elite sin construir Medium primero**. Instalar ArgoCD + progressive delivery sin tests de integración confiables produce el peor de los mundos: deploys frecuentes que rompen frecuentemente, sin capacidad de diagnóstico rápido.

### 4.4 Anti-patrones DevOps documentados

**"NoOps"**: falacia popularizada por analistas ~2012. La idea de que la cloud + PaaS elimina la necesidad de operaciones. La realidad: operaciones se transforma (menos rack&stack, más SRE + FinOps + platform engineering), pero no desaparece. Google, Netflix, Amazon tienen más "operadores" que nunca — solo con títulos distintos.

**"DevSecOps como team separado"**: repite el error de "DevOps team". Security como responsabilidad compartida es la propuesta; centralizarla vuelve al modelo pre-DevOps.

**"Platform team que hace deploys por ti"**: platform engineering (Team Topologies, Skelton & Pais, 2019) propone plataformas *self-service* que los equipos de producto usan autónomamente. Si el platform team se convierte en "los que hacen deploy por ti", es ops rebautizado.

**"Métricas DORA como KPI de management"**: si CEO exige "5 deploys por día" como target, los equipos gamifican (chunks artificiales, deploys triviales que no aportan valor). DORA son *health indicators*, no OKRs para bonus. Nicole Forsgren lo advirtió explícitamente en varias charlas.

### 4.5 SPACE framework: el sucesor 2021

En 2021, Forsgren + Storey publicaron *"The SPACE of Developer Productivity"* (ACM Queue) argumentando que DORA cubre bien delivery pero no engagement/experiencia. SPACE es un framework multidimensional:

- **S**atisfaction & well-being
- **P**erformance
- **A**ctivity
- **C**ommunication & collaboration
- **E**fficiency & flow

La recomendación: usa DORA para *delivery health* y SPACE para *team health*. Ambos juntos. En 2026 la industria está adoptando SPACE lentamente; muchas herramientas SaaS (LinearB, Sleuth, Faros) ofrecen paneles combinados.

### 4.6 Cultura como código: ADRs, DoD, runbooks vivos

En equipos maduros, la cultura no se predica en all-hands; se codifica:

- **ADRs (Architecture Decision Records)**: documento markdown en el repo con contexto, decisión y consecuencias. Popularizado por Michael Nygard (2011). Cada decisión arquitectónica queda en Git, versionada, referible.
- **Definition of Done (DoD)**: checklist compartida de qué significa "hecho" (unit + integration tests, docs actualizados, ADR si aplica, feature flag para rollback, dashboard nuevo).
- **Runbooks vivos**: markdown en el repo del servicio, linkado desde cada alert. Se actualizan durante los post-mortems.

Código de ejemplo — plantilla ADR:

```markdown
# ADR-042 — Adoptar trunk-based development

Status: Accepted
Date: 2026-11-15
Deciders: Ana (eng lead), Luis (SRE), Marta (product)

## Context
Estamos en GitFlow con branches `develop`, `release/*`, `hotfix/*`. Lead
time (medida DORA) es 8 días mediana. Los merges de `develop` a `main`
generan conflictos semanales que consumen ~4h/semana del equipo.

## Decision
Migrar a trunk-based development con feature flags:
- `main` es la única rama de largo plazo.
- Feature branches viven <2 días.
- Todo cambio incompleto va detrás de un feature flag.
- Deploys automáticos a producción desde `main` tras CI verde.

## Consequences
+ Lead time esperado <1 día (elite DORA).
+ Elimina merge hell semanal.
- Requiere disciplina de feature flags (deuda potencial).
- Requiere CI robusto (test coverage debe crecer de 62% a >80%).

## Related
- ADR-039 (feature flags con OpenFeature)
- Postmortem INC-2026-032 (merge conflict causó rollback)
```

---

## 5. Ejemplo práctico completo: instrumentando DORA end-to-end

**Contexto.** Eres tech lead de un equipo de 6 devs en LinguaDev Pro. Nunca han medido DORA. El objetivo: implementar en 4 semanas un dashboard Grafana con las 4 métricas, sin comprar SaaS.

**Paso 1 — Instrumentar el deploy pipeline (GitHub Actions + Pushgateway).**

```yaml
# .github/workflows/deploy.yml
name: Deploy Production
on:
  push:
    branches: [main]

env:
  PUSHGATEWAY: https://pushgateway.linguadev.internal

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.build.outputs.image }}
      commit_time: ${{ steps.meta.outputs.commit_time }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - id: meta
        run: |
          COMMIT_TIME=$(git log -1 --format=%ct)
          echo "commit_time=$COMMIT_TIME" >> $GITHUB_OUTPUT

      - id: build
        run: |
          IMAGE=ghcr.io/linguadev/api:${{ github.sha }}
          docker build -t $IMAGE .
          docker push $IMAGE
          echo "image=$IMAGE" >> $GITHUB_OUTPUT

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Deploy
        id: deploy
        run: |
          DEPLOY_START=$(date +%s)
          kubectl set image deploy/api api=${{ needs.build.outputs.image }}
          kubectl rollout status deploy/api --timeout=5m
          DEPLOY_END=$(date +%s)
          echo "duration=$((DEPLOY_END - DEPLOY_START))" >> $GITHUB_OUTPUT
          echo "end=$DEPLOY_END" >> $GITHUB_OUTPUT

      - name: Emit DORA metrics
        run: |
          LEAD=$((${{ steps.deploy.outputs.end }} - ${{ needs.build.outputs.commit_time }}))
          cat <<EOF | curl --data-binary @- $PUSHGATEWAY/metrics/job/deploy/instance/${{ github.sha }}
          # TYPE dora_deployment_total counter
          dora_deployment_total{service="api",env="prod"} 1
          # TYPE dora_lead_time_seconds gauge
          dora_lead_time_seconds{service="api"} $LEAD
          # TYPE dora_deploy_duration_seconds gauge
          dora_deploy_duration_seconds{service="api"} ${{ steps.deploy.outputs.duration }}
          EOF
```

**Paso 2 — Registrar rollbacks para calcular CFR y Recovery Time.**

```bash
#!/usr/bin/env bash
# scripts/rollback.sh — emite métrica DORA al hacer rollback
set -euo pipefail

REASON=${1:-unspecified}
FROM_SHA=$(kubectl get deploy api -o jsonpath='{.metadata.annotations.sha}')
ROLLBACK_START=$(date +%s)

kubectl rollout undo deploy/api
kubectl rollout status deploy/api --timeout=5m

ROLLBACK_END=$(date +%s)
DURATION=$((ROLLBACK_END - ROLLBACK_START))

curl --data-binary @- "$PUSHGATEWAY/metrics/job/rollback/instance/$FROM_SHA" <<EOF
# TYPE dora_deployment_failure_total counter
dora_deployment_failure_total{service="api",reason="$REASON"} 1
# TYPE dora_recovery_time_seconds gauge
dora_recovery_time_seconds{service="api"} $DURATION
EOF

echo "Rollback complete. Duration: ${DURATION}s. Reason: $REASON."
```

**Paso 3 — Recording rules Prometheus.**

```yaml
# prometheus/rules/dora.yml
groups:
  - name: dora
    interval: 30s
    rules:
      # Deployment Frequency: deploys/día en 7d rolling
      - record: dora:deployment_frequency:7d
        expr: sum(increase(dora_deployment_total[7d])) / 7

      # Change Failure Rate: fallos / total en 30d rolling
      - record: dora:change_failure_rate:30d
        expr: |
          sum(increase(dora_deployment_failure_total[30d]))
          /
          sum(increase(dora_deployment_total[30d]))

      # Lead Time p50 y p90 en 30d
      - record: dora:lead_time_p50:30d
        expr: quantile_over_time(0.5, dora_lead_time_seconds[30d])
      - record: dora:lead_time_p90:30d
        expr: quantile_over_time(0.9, dora_lead_time_seconds[30d])

      # Recovery Time p50 en 30d
      - record: dora:recovery_time_p50:30d
        expr: quantile_over_time(0.5, dora_recovery_time_seconds[30d])
```

**Paso 4 — Dashboard Grafana (JSON abreviado).**

```json
{
  "title": "DORA Metrics — LinguaDev API",
  "panels": [
    {
      "title": "Deployment Frequency (deploys/day)",
      "targets": [{ "expr": "dora:deployment_frequency:7d" }],
      "thresholds": { "steps": [
        {"value": 0.03, "color": "red"},
        {"value": 0.14, "color": "yellow"},
        {"value": 1.0, "color": "green"}
      ]}
    },
    {
      "title": "Lead Time (p50)",
      "targets": [{ "expr": "dora:lead_time_p50:30d" }],
      "unit": "s",
      "thresholds": { "steps": [
        {"value": 3600, "color": "green"},
        {"value": 86400, "color": "yellow"},
        {"value": 604800, "color": "red"}
      ]}
    },
    {
      "title": "Change Failure Rate",
      "targets": [{ "expr": "dora:change_failure_rate:30d" }],
      "unit": "percentunit"
    },
    {
      "title": "Recovery Time (p50)",
      "targets": [{ "expr": "dora:recovery_time_p50:30d" }],
      "unit": "s"
    }
  ]
}
```

**Paso 5 — Ritual mensual "DORA review".**

- Primer lunes del mes, 30 min con el equipo entero.
- Revisar las 4 métricas del mes.
- Un post-mortem "meta": ¿qué mejoró, qué empeoró, por qué?
- 1-2 action items concretos (no genéricos). Ejemplo: "reducir p90 de tests unit de 8min a 3min" en vez de "mejorar CI".

Al cabo de 6 meses típicamente ves: Deployment Frequency +2x, Lead Time -50%, CFR se estabiliza (a veces empeora primero al medir honestamente), Recovery Time -40%.

---

## 6. Cheatsheet y anti-patrones

### Cheatsheet: qué medir y con qué target

```
DEPLOYMENT FREQUENCY
  meta: on-demand (varias/día)  → Elite
  cómo: contar deploys a env=production por semana / 7
  smell: <1/mes = batch hell

LEAD TIME (commit → prod)
  meta: <1h (Elite), <1 día (High)
  cómo: (deploy_time - commit_time) por commit, mediana + p90
  smell: >1 semana = pipeline lento o gates manuales

CHANGE FAILURE RATE
  meta: <15%
  cómo: (rollbacks + hotfixes + incidents deploy-related) / total deploys
  smell: >30% → mejorar tests + canary + observability

RECOVERY TIME
  meta: <1h
  cómo: rollback_complete - impact_start
  smell: >1 día = falta rollback automatizado o playbooks débiles
```

### Tabla de decisión: ¿qué priorizo?

| Situación actual | Prioridad 1 | Prioridad 2 |
|------------------|-------------|-------------|
| CFR >45%, Deploy Freq mensual | CI + test coverage (base) | Reducir batch size |
| CFR <15%, Recovery >1 día | Automatizar rollback | Canary + auto-abort |
| Deploy diario, Lead Time 5 días | Merge queue + trunk-based | Reducir revisiones lentas |
| Elite en todo, moral baja | SPACE framework, revisar toil | Rotación on-call sostenible |

### ✅ Buenas prácticas

- ✅ Medir las 4 DORA como *health indicators*, no como OKRs de bonus.
- ✅ Blameless postmortem para TODO SEV1/SEV2, publicar internamente.
- ✅ Error budget policy escrita, aprobada por eng + product.
- ✅ "You build it, you run it" con on-call rotation limitada (max 1 semana/mes/persona).
- ✅ Runbooks vivos linkados desde cada alert, actualizados en cada incident.
- ✅ ADRs para toda decisión con impacto arquitectónico.
- ✅ DoD que incluye tests, docs, feature flag, dashboard.
- ✅ Toil audit trimestral: ¿qué toil eliminamos, qué toil nuevo apareció?

### ❌ Anti-patrones

- ❌ Contratar "un DevOps engineer" para "hacer el DevOps del equipo".
- ❌ "Equipo DevOps" separado de dev y ops (silo rebautizado).
- ❌ CI/CD sin blameless culture (deploys frecuentes con blame frecuente = burnout).
- ❌ DORA como KPI de bonus (gamificación garantizada).
- ❌ MTTR como métrica global de reliability (usa DORA Recovery Time solo para deploys).
- ❌ "NoOps" — la operación no desaparece, se transforma.
- ❌ Postmortems que empiezan con "quién causó esto" en vez de "qué del sistema permitió esto".
- ❌ Freeze permanente de deploys "para estabilizar" (aumenta batch, aumenta riesgo, es circular).

---

## 7. Casos reales de industria (2024-2026)

**State of DevOps Report 2024 (Google Cloud, octubre 2024)**: primer reporte tras la reestructuración de DORA dentro de Google Cloud. Introduce Failed Deployment Recovery Time reemplazando MTTR. Confirma persistencia del gap Elite vs Low: los Elite despliegan ~1000x más frecuentemente y recuperan ~450x más rápido. Añade dimensión de bienestar del equipo (heredado de SPACE) mostrando correlación entre burnout y baja performance.

**Amazon deploys en 2024**: Werner Vogels sigue citando en talks (re:Invent 2024) que Amazon en agregado despliega cada pocos segundos a través de miles de servicios. Cada two-pizza team es dueño de su servicio, con rotación on-call. Este modelo se documentó por primera vez en 2011 (11.7 segundos) y sigue vigente escalado.

**Netflix Chaos Engineering 2024**: la plataforma ChAP (Chaos Automation Platform) sigue operativa; Netflix publica trimestralmente resultados internos de chaos tests. El principio "assume failure" está tan integrado que los devs incluyen chaos hypotheses en cada diseño de servicio nuevo.

**Google SRE — "Toil Reduction" 2023-2025**: varias publicaciones internas y externas (SREcon) muestran que el foco 2024-2026 en Google SRE está en "self-service platforms" para que los equipos de producto reduzcan sus tickets a SRE. La métrica clave es "tickets/servicio/mes" — donde <1 es el target.

**Etsy Blameless Postmortems (histórico + evolución 2024)**: sigue publicando post-mortems públicos ocasionalmente en su engineering blog. En 2024 añadieron una sección de "systemic improvements landed" trackeada trimestralmente — cerrando el loop del post-mortem con acciones verificables.

**GitLab post-mortem 2017 (referencia clásica)**: rm -rf accidental en producción, 6 horas de datos perdidos. Publicaron post-mortem público en tiempo real. Sigue siendo el mejor ejemplo de "cómo comunicar durante y después de un incident" en la industria. Referencia obligatoria en cualquier training de IR.

**Cloudflare postmortems 2023-2024**: Cloudflare publica post-mortems públicos detallados de cada incident mayor, incluyendo el incident de junio 2024 (BGP route leak) y noviembre 2024 (workers latency spike). Referencia comparativa vs empresas que ocultan (Equifax 2017, Uber 2016 breach).

**Encuesta Puppet State of DevOps 2024**: aunque descontinuada oficialmente en 2021, en 2024 hubo un revival independiente. Confirma que empresas que dicen "hacer DevOps" pero puntúan bajo en Westrum generativo permanecen en Low/Medium DORA. La cultura sigue siendo el predictor #1.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — Auditar tu DORA actual (30 min)

**Objetivo:** obtener números reales de tu equipo para las 4 métricas del último trimestre.

**Setup:**
- Acceso al repo (GitHub, GitLab o Bitbucket).
- Acceso al sistema de tickets (Jira, Linear, GitHub Issues).
- Hoja de cálculo o notebook Jupyter.

**Pasos:**
1. Listar todos los deploys a producción del último trimestre (usa API de tu CI o log de deployments).
2. Para cada deploy, calcular: `deploy_time - merge_time` = lead time por deploy.
3. Contar deploys/semana = Deployment Frequency.
4. Listar incidents SEV1/SEV2 del trimestre y marcar cuáles fueron causados por un deploy.
5. Change Failure Rate = incidents deploy-related / total deploys.
6. Para cada incident deploy-related: `resolved_time - impact_start` = Recovery Time.

**Criterios de aceptación:**
- [ ] Tienes número absoluto para las 4 métricas.
- [ ] Identificas en qué nivel DORA cae tu equipo (Low/Medium/High/Elite).
- [ ] Documentas 3 hallazgos concretos (ej: "el 40% del lead time viene de code review").

**Bonus:** grafica Deployment Frequency vs Change Failure Rate mensual y busca correlación (¿son inversos, positivos, sin relación?).

---

### Ejercicio 2 — Diseñar el error budget del proyecto (45 min)

**Objetivo:** escribir la primera error budget policy formal de tu equipo.

**Setup:**
- 1-2h uninterrupted con el eng lead o SRE senior.
- Documento markdown en el repo.

**Pasos:**
1. Definir el SLI principal del servicio (ej: "% de requests a `/api/*` con status<500 y latencia<500ms").
2. Definir el SLO mensual (ej: 99.9%).
3. Calcular error budget: `(1 - SLO) * total_events_month`.
4. Definir las 3 zonas: verde (>50% budget), amarillo (<50%), rojo (0%).
5. Definir la acción por zona (ej: rojo = freeze de features).
6. Definir el escalation path (¿quién levanta el freeze?).
7. Reunir con producto y obtener aprobación por escrito.

**Criterios de aceptación:**
- [ ] Documento existe en el repo (`docs/slo-policy.md`).
- [ ] Producto lo aprobó (comment en PR o email).
- [ ] Dashboard con burn rate está deployado.
- [ ] Alertas configuradas para transiciones amarillo/rojo.

**Bonus:** implementa multi-window burn rate alerts (Google SRE workbook cap 5).

---

### Ejercicio 3 — Blameless postmortem de un incident reciente (60 min)

**Objetivo:** escribir un post-mortem siguiendo las reglas blameless para un incident real (o simulado con un caso público).

**Setup:**
- Elegir un incident real de tu equipo (o usar el caso público GitLab 2017 como práctica).
- Plantilla de post-mortem (usa la de §3.4 como base).

**Pasos:**
1. Reconstruir timeline (UTC, con precisión de minutos).
2. Cuantificar impacto (usuarios afectados, revenue, duración).
3. Listar "what went well" (mínimo 3).
4. Listar "what went badly" (mínimo 3).
5. Identificar root causes SISTÉMICAS (mínimo 2). Regla: si aparece "Fulano hizo X" reescribir a "el sistema permitió X".
6. Listar action items con owner + due date. Regla: máximo 5, específicos y verificables.
7. Compartir con el equipo entero.

**Criterios de aceptación:**
- [ ] Ninguna sección atribuye culpa individual.
- [ ] Cada root cause es sistémica, no humana.
- [ ] Cada action item tiene owner + due date + criterio de "done".
- [ ] El post-mortem se compartió públicamente (interno).

**Bonus:** 30 días después, publica un update de status de los action items.

---

### Ejercicio 4 — Diagnosticar cultura Westrum del equipo (30 min)

**Objetivo:** aplicar el cuestionario Westrum a tu equipo y ubicarlo en el espectro.

**Setup:**
- Cuestionario Westrum (7 preguntas, disponible en el libro *Accelerate* o State of DevOps Report).
- Encuesta anónima (Google Forms, Typeform).

**Pasos:**
1. Enviar cuestionario a todo el equipo (dev + ops + product) — anónimo.
2. Compilar respuestas (score 1-7 por pregunta, mediana + rango).
3. Ubicar en el espectro Pathological / Bureaucratic / Generative.
4. Identificar la pregunta con peor score (donde más margen hay).
5. Discutir en retrospectiva 1 acción concreta para mejorar esa dimensión.

**Criterios de aceptación:**
- [ ] Al menos 70% del equipo respondió.
- [ ] Tienes score numérico por pregunta.
- [ ] Identificaste 1 acción concreta (no genérica) para el próximo sprint.

**Bonus:** repite el cuestionario cada 6 meses y grafica evolución.

---

### Ejercicio 5 — Reducir toil documentado (2 semanas)

**Objetivo:** identificar 1 fuente de toil y automatizarla.

**Setup:**
- Log de tickets operativos del último mes.
- 1 dev + 1 SRE dispuestos a colaborar.

**Pasos:**
1. Categorizar tickets del último mes por tipo (top 10).
2. Elegir el más repetitivo y automatizable (ej: "resetear password", "aumentar quota", "restart pod").
3. Diseñar la automatización: self-service via ChatOps? Runbook one-click? PR bot?
4. Implementar (max 1 sprint).
5. Medir 4 semanas después: ¿cuántos tickets de ese tipo llegaron? (Target: -80%).

**Criterios de aceptación:**
- [ ] Automatización deployada y usada.
- [ ] Reducción medida (número absoluto).
- [ ] Documentado en un ADR + runbook actualizado.
- [ ] Presentado en un brown bag para diseminar el patrón.

**Bonus:** calcula el ROI (horas de toil eliminadas × costo hora × 12 meses vs horas invertidas en la automatización).

---

## 9. Recursos y siguientes pasos

**Libros fundacionales:**
- *The Phoenix Project* — Gene Kim, Kevin Behr, George Spafford (2013). Novela empresarial que introduce los conceptos DevOps de forma narrativa. Lectura recomendada #1.
- *The DevOps Handbook* — Gene Kim, Jez Humble, Patrick Debois, John Willis (2016; 2nd ed 2021). Manual técnico. Complemento a Phoenix Project.
- *Accelerate: The Science of Lean Software and DevOps* — Nicole Forsgren, Jez Humble, Gene Kim (2018). Base estadística de DORA.
- *Site Reliability Engineering* — Google (2016; free online). Capítulos 1-6 son lectura obligatoria.
- *The Site Reliability Workbook* — Google (2018; free online). Ejercicios prácticos, especialmente cap 5 (SLO) y cap 15 (postmortem).
- *Team Topologies* — Matthew Skelton, Manuel Pais (2019). Framework para diseñar equipos plataforma vs producto vs stream-aligned.

**Reportes anuales:**
- *State of DevOps Report* — Google Cloud (2019+). Free download.
- *Accelerate State of DevOps Report* — DORA (mismo). Publicado octubre 2024, próximo octubre 2025.
- *Puppet State of DevOps* (histórico 2011-2021, revival 2024).

**Charlas clave (YouTube, todas free):**
- John Allspaw + Paul Hammond, *10+ Deploys Per Day* (Velocity 2009). El origen documental de DevOps.
- Werner Vogels, *You Build It, You Run It* (varias). El modelo Amazon.
- Nicole Forsgren, *Accelerate: The Data Behind DevOps*.
- Jez Humble, *Continuous Delivery* (múltiples versiones).

**Herramientas open-source para instrumentar DORA:**
- **Four Keys** — Google (https://github.com/dora-team/fourkeys). Referencia de implementación con BigQuery.
- **DevLake** — Apache incubator project. Data platform para DORA + SPACE.
- **Sleuth** (SaaS, tiene free tier).
- **LinearB** (SaaS).

**Siguientes pasos en este track:**
- [Cap 02 — Fundamentos de Continuous Delivery](./02-fundamentos-de-continuous-delivery.md): CI vs CD vs Continuous Deployment, pipelines, feature flags.
- [Cap 03 — Git workflows y branching](./03-git-workflows-y-branching.md): trunk-based, GitFlow, PR reviews, merge queues.
- [Cap 04 — GitHub Actions y Jenkins](./04-github-actions-y-jenkins.md): el "cómo" técnico de los pipelines.

---

## 10. Preguntas de práctica

20 preguntas cubren: definición cultural de DevOps, CALMS, las 4 métricas DORA, mitos velocidad vs estabilidad, "you build it you run it", deploy frequency, lead time, blameless postmortem, toil, error budgets, continuous delivery vs deployment, trunk-based, feature flags, shift-left, IaC, chaos engineering, incident response, on-call sustainability, MTTR/recovery time, continuous learning.

Ruta en la app: `/programming/devops/sim/devops-sim-01-devops-culture-and-dora`

JSON: [`packages/content/src/tech/devops/sim-01-devops-culture-and-dora.json`](../../packages/content/src/tech/devops/sim-01-devops-culture-and-dora.json)

---

## Navegación

[Índice](./README.md) · [Cap 02 →](./02-fundamentos-de-continuous-delivery.md)
