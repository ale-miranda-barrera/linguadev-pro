# Capítulo 39 — Incident Response y on-call sostenible

> **Focus:** Incident Response profesional: clasificación SEV1/SEV2/SEV3, on-call rotations equitativas, comparación PagerDuty vs Opsgenie vs incident.io vs Rootly (Grafana OnCall archivado marzo 2026), escalation policies, Incident Commander (NIMS/ICS adaptado), war room protocols y ChatOps, post-mortem blameless, action items con follow-through, on-call compensation, cap 50% de toil (SRE Book), error budget policies como escudo del equipo.
> **Áreas:** Reliability · SRE · Team health
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos SRE: SLI, SLO, SLA, error budget (ver [cap 01 — cultura DevOps y DORA](./01-cultura-devops-y-dora.md)).
- Observability: Prometheus, Grafana, tracing, logs (ver [cap 17](./17-prometheus-y-metrics.md), [cap 18](./18-grafana-y-dashboards.md), [cap 19](./19-logging-elk-loki.md)).
- Chaos engineering básico (ver [cap 38](./38-chaos-engineering-en-practica.md)) para game days.
- Familiaridad con Slack (o Teams) y bots.
- Conceptos de alerting: alerts vs notifications vs pages.

**Glosario mínimo:**
- **Incident**: cualquier evento no planificado que degrada el servicio para usuarios.
- **SEV1 / SEV2 / SEV3**: niveles de severidad. SEV1 = catastrófico (servicio caído, data loss), SEV2 = crítico (feature core degradada), SEV3 = degradado (impacto parcial).
- **MTTR** (Mean Time To Restore/Recover): promedio real de tiempo entre detección y resolución.
- **MTTA** (Mean Time To Acknowledge): promedio entre alerta disparada y ack humano.
- **MTTD** (Mean Time To Detect): promedio entre inicio del problema y detección.
- **On-call**: rotación de guardia; una persona (primary) responde en primer lugar, con secondary y manager como escalación.
- **Runbook**: procedimiento paso a paso vinculado a un alert específico. Ver secc. 2.1.
- **Alert fatigue**: degradación de la respuesta humana cuando hay demasiadas alertas ruidosas.
- **Actionable alert**: alerta que requiere acción humana urgente; el resto son logs/dashboards.
- **Incident Commander (IC)**: rol único que coordina la respuesta durante un incident. Inspirado en NIMS/ICS (bomberos, FEMA).
- **War room**: canal dedicado (Slack) donde ocurre la coordinación del incident.
- **ChatOps**: ejecutar operaciones desde el chat (bots) para dejar audit trail y visibility.
- **Blameless post-mortem**: análisis del incident enfocado en sistemas y procesos, no en personas.
- **Error budget**: presupuesto de errores permitido por el SLO (ej: 99.9% SLO = 43.2 min downtime/mes = error budget de 43.2 min).
- **Error budget policy**: reglas que gobiernan qué se hace cuando el budget se agota (ej: freeze de releases).
- **Toil**: trabajo manual, repetitivo, sin valor duradero. SRE Book recomienda cap 50%.

**Setup mínimo:**

```bash
# 1. Cuenta PagerDuty (trial) o Opsgenie o incident.io
# https://www.pagerduty.com  |  https://www.atlassian.com/software/opsgenie  |  https://incident.io

# 2. Slack workspace con permisos para instalar apps
# Instalar: PagerDuty for Slack, incident.io bot, o similar

# 3. Prometheus + Alertmanager configurados
kubectl -n monitoring get pods | grep alertmanager
# alertmanager-kube-prom-alertmanager-0   2/2   Running

# 4. Ejemplo webhook para PagerDuty events API v2
export PD_ROUTING_KEY="R01AB..."
curl -X POST https://events.pagerduty.com/v2/enqueue \
  -H 'Content-Type: application/json' \
  -d '{
    "routing_key": "'"$PD_ROUTING_KEY"'",
    "event_action": "trigger",
    "payload": {
      "summary": "TEST alert",
      "severity": "warning",
      "source": "test-cli"
    }
  }'
```

---

## 1. El gran cuadro

**Incident Response** no es lo que hacés cuando algo se rompe; es la **infraestructura organizacional** que determina si tu equipo sobrevive a los años. En un mundo donde los sistemas distribuidos fallan constantemente y la disponibilidad es una expectativa contractual (SLAs, SLOs), la calidad de tu respuesta a incidents es tan importante como la calidad de tu arquitectura. Un equipo con excelente código y pésimo IR tiene 2-3x más MTTR, 5x más burnout y turnover, y termina siendo reemplazado. Un equipo con código promedio y excelente IR mantiene disponibilidad respetable, retiene gente y aprende de cada incidente. La diferencia está en **procesos, herramientas, roles y cultura**, no en la habilidad técnica individual.

Los pilares del IR moderno son cinco: (1) **alerting disciplinado** con el principio de "toda alerta debe requerir acción humana urgente" (Google SRE Book), evitando la **alert fatigue** que hace que el equipo ignore Slack; (2) **on-call sostenible** con rotaciones de 6-8+ personas, compensación explícita, cap de toil <50% del tiempo (SRE Book), y hand-off ritualizado; (3) **estructura de respuesta** con **Incident Commander** (rol único que coordina, no debugea) inspirado en NIMS/ICS y adaptado por Google, PagerDuty y otros; (4) **ChatOps + war rooms** para dejar audit trail y compartir contexto sin ambigüedad; (5) **post-mortems blameless** obligatorios con action items tracked, transformando cada incident en aprendizaje organizacional.

El landscape de herramientas 2026 se consolidó tras el archivo de **Grafana OnCall** (marzo 2026, Grafana Labs discontinuó activamente el desarrollo). **PagerDuty** sigue siendo el líder enterprise con **PagerDuty AIOps** (Event Intelligence) para deduplicación y correlación automática de alertas; **Opsgenie** (Atlassian, 2018) es la opción natural para equipos en Jira/Confluence, aunque el roadmap se ha ralentizado visiblemente post-adquisición; **incident.io** (fundada 2020, focus en post-incident) crece rápido en startups y scale-ups con excelente UX; **Rootly** compite en el mismo espacio con AIOps-style de correlación y summarización con LLMs; **BigPanda** lidera correlación AIOps upstream para grandes empresas. La elección práctica: PagerDuty si necesitás enterprise features + Event Intelligence; Opsgenie si vivís en Jira; incident.io/Rootly si valorás UX moderna y AI-assisted incident response.

En 2026, tres tensiones dominan el debate: **on-call como derecho vs obligación** (cada vez más empresas europeas remuneran explícitamente el on-call —Alemania por ley—, mientras que muchas empresas americanas lo consideran "parte del trabajo"), **AI en incident response** (LLMs para resumir Slack threads, sugerir hipótesis, generar drafts de post-mortems —incident.io, Rootly, PagerDuty AIOps lideran—) y **error budget policies como shield del equipo** (el SLO define disponibilidad esperada; cuando se agota el budget, la política es freeze de releases hasta recuperar —protege a los engineers de ser presionados a shippear sobre un servicio ya frágil—). Este capítulo cubre las prácticas con templates concretos: runbooks, escalation policies JSON, post-mortem template, error budget policy, y termina con ejercicios sobre **LinguaDev Pro**.

---

## 2. Alerting, runbooks y clasificación de severidades (nivel básico)

### 2.1 El principio de alertas accionables

**Google SRE Book, capítulo 6:** *"every page should require intelligence to handle. If it can be handled by a script, it should be handled by a script."*

Regla operativa: por cada alerta configurada, aplicar los **4 filtros**:

1. **¿Requiere acción humana?** Si no, automatizar (ej: reiniciar pod que se queda colgado → HPA/Deployment lo hace).
2. **¿Requiere acción URGENTE?** Si puede esperar mañana en horario laboral, es ticket, no page.
3. **¿Tiene runbook?** Si no, no es accionable —el humano no sabe qué hacer.
4. **¿Está atado a un SLO?** Si el problema no impacta el objetivo de negocio, ¿por qué pagar el sueño de alguien?

Estudios PagerDuty 2022+: teams con >10 pages/semana/persona tienen 3x más burnout, MTTR 2x mayor (por ignoración) y 5x más turnover. **Menos es más en alerting.**

Ejemplo de alerting bien configurado en Prometheus (Alertmanager):

```yaml
# alerts/linguadev-slo.yaml
groups:
  - name: linguadev-api-slo
    interval: 30s
    rules:
      # SLO: 99.9% availability, error budget 43.2 min/mes
      - alert: LinguadevApiHighErrorBudgetBurn
        expr: |
          (
            sum(rate(http_requests_total{job="linguadev-api",code=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{job="linguadev-api"}[5m]))
          ) > (14.4 * 0.001)
          and
          (
            sum(rate(http_requests_total{job="linguadev-api",code=~"5.."}[1h]))
            /
            sum(rate(http_requests_total{job="linguadev-api"}[1h]))
          ) > (14.4 * 0.001)
        for: 2m
        labels:
          severity: page
          slo: availability
          service: linguadev-api
        annotations:
          summary: "linguadev-api burning error budget 14.4x baseline (2h to consume monthly)"
          runbook: "https://runbooks.linguadev.app/api-error-budget-burn"
          dashboard: "https://grafana.linguadev.app/d/api-slo"
```

Multi-window multi-burn-rate (SRE Book cap 5): dispara solo cuando el burn es sostenido, evitando falsos positivos por picos aislados.

### 2.2 Runbook: estructura obligatoria

Un runbook útil sigue este template. **Si un alert no tiene runbook, no está terminado.**

```markdown
# Runbook: linguadev-api-error-budget-burn

## Header
- **Alert:** LinguadevApiHighErrorBudgetBurn
- **Severity:** SEV2 (paginable)
- **Owner team:** platform-api@linguadev.app
- **Last reviewed:** 2026-08-01
- **Related post-mortems:** 2026-06-15, 2026-04-02

## Context
La tasa de 5xx del API excede 14.4x el baseline permitido por el SLO 99.9%.
Impacto: usuarios ven errors al cargar lessons o AI chat.
Impacto de negocio: churn de sesión, si dura >30 min impacta DAU.

## Diagnosis (ejecutar en orden)

### 1. ¿Qué endpoint está fallando?
```
# Grafana dashboard "API Errors by Endpoint"
https://grafana.linguadev.app/d/api-errors

# Prometheus query
sum by (path) (rate(http_requests_total{job="linguadev-api",code=~"5.."}[5m]))
```

### 2. ¿Es un deploy reciente?
```
kubectl -n prod rollout history deployment/linguadev-api
argocd app get linguadev-api
```
Si hay deploy en los últimos 30min, **considerar rollback**:
```
argocd app rollback linguadev-api <prev-revision>
```

### 3. ¿Dependency down?
- OpenAI status: https://status.openai.com
- Postgres: `kubectl -n prod exec -it postgres-0 -- pg_isready`
- Redis: `kubectl -n prod exec -it redis-0 -- redis-cli ping`

### 4. ¿Saturación de recursos?
```
kubectl -n prod top pods -l app=linguadev-api
kubectl -n prod describe hpa linguadev-api
```

## Remediation

### Opción A: rollback (si es deploy reciente)
```
argocd app rollback linguadev-api <prev-revision>
```

### Opción B: escalar (si es saturación)
```
kubectl -n prod scale deployment/linguadev-api --replicas=20
```

### Opción C: degradar (si es dependency externa)
Activar feature flag `chaos.fallbackOnlyMode=true` en Unleash.

## Escalation
- 15 min sin mitigar → escalar a secondary + IC.
- 30 min → tag CTO + iniciar comunicación externa (status page).

## References
- [SLO doc](https://wiki.linguadev.app/slo/api)
- [Architecture diagram](https://wiki.linguadev.app/arch/api)
```

**Regla operativa:** el runbook vive en Git (versionado), es linkeado desde el alert, y **cada post-mortem revisa si el runbook usado fue útil**; si no, action item de actualizarlo.

### 2.3 Clasificación de severidades

Sin taxonomía compartida, "urgente" significa cosas distintas para cada persona. Adoptá una escala explícita:

| Severidad | Ejemplo | Response |
|---|---|---|
| **SEV1** | Servicio principal down (todos usuarios), data loss, security breach | Todos hands-on, comms cliente inmediatas, war room, IC obligatorio |
| **SEV2** | Feature core degradada (subset users), performance severa | On-call + IC, war room, updates cada 30 min |
| **SEV3** | Feature secundaria degradada, workaround existe | On-call trabaja durante horario laboral extendido, updates cada 2h |
| **SEV4** | Bug menor, cosmético, no bloquea | Ticket, prioridad normal |

Documentá en tu wiki con ejemplos concretos para cada nivel. Cuando entra una alerta, la primera pregunta es: **¿qué SEV es?** El IC lo declara, y cambia según evolucione.

### 2.4 Auditoría de alerts: proyecto continuo

Cada trimestre, revisá todos los alerts. Preguntas:

- ¿Cuántas veces disparó en los últimos 90 días?
- Del total, ¿cuántas fueron actionable (requirieron acción real)?
- **Actionable rate = actionable / total**. Si <60%, hay ruido; auditar y ajustar.
- ¿Cuál es el MTTA promedio? Si sube, es señal de fatiga.

Script SQL sobre PagerDuty exports:

```sql
SELECT
  alert_name,
  COUNT(*) AS total_pages,
  SUM(CASE WHEN resolved_via_action = true THEN 1 ELSE 0 END) AS actionable,
  ROUND(100.0 * SUM(CASE WHEN resolved_via_action THEN 1 ELSE 0 END) / COUNT(*), 1) AS actionable_pct,
  AVG(ttl_ack_seconds) AS avg_mtta_seconds
FROM pd_incidents
WHERE created_at >= NOW() - INTERVAL '90 days'
GROUP BY alert_name
HAVING COUNT(*) > 5
ORDER BY actionable_pct ASC;
```

Los alerts con `actionable_pct < 40%` son candidatos a eliminar o reajustar.

---

## 3. On-call sostenible: rotaciones, escalation, herramientas 2026 (nivel medio)

### 3.1 Reglas de rotación sostenible

Basado en Google SRE Book, PagerDuty On-Call Handbook, y consultas 2024-2026:

- **Tamaño mínimo de rotación: 6-8 personas.** Con <6, cada persona está on-call 1 semana de cada 4-6 → burnout garantizado.
- **Ratio de work-time on-call: 25% máximo.** SRE Book recomienda esto; algunas empresas top van a 12.5%.
- **50% cap on toil.** Del tiempo total (on-call + interruption + tickets manuales), no más de 50% debe ser toil; el resto debe ser proyecto/mejora.
- **Follow-the-sun para 24/7 crítico.** Rotaciones regionales (US, EU, APAC) evitan pages nocturnos.
- **Hand-off ritualizado.** 15-30 min al inicio/fin: incidents activos, work-in-progress, blocking issues.
- **Compensation explícita.** Alemania obliga por ley (BAG 2019+); EE.UU. deja al mercado, pero teams top pagan bonus/day-off por semana on-call.
- **Post-oncall recovery.** Al menos 1 día sin meetings tras una semana on-call.

Anti-patrones:

- ❌ Rotación de 2 personas ("Alice pares, Bob impares"). Vacaciones/enfermedad = colapso.
- ❌ El "senior siempre on-call". Concentra conocimiento y burnout.
- ❌ On-call sin compensación explícita. Genera resentimiento.
- ❌ Pages en horario laboral que interrumpen deep work sin ack de coste.

### 3.2 Escalation policies

Diseño canónico (adaptable a PagerDuty, Opsgenie, incident.io):

```
Nivel 0 — Primary on-call: ack en 5 min
   ↓ (no ack)
Nivel 1 — Secondary on-call: ack en 10 min más
   ↓ (no ack)
Nivel 2 — Manager on-call: ack en 15 min más
   ↓ (no ack)
Nivel 3 — VP Engineering: ack en 30 min más (rare)
```

En PagerDuty API (JSON):

```json
{
  "escalation_policy": {
    "name": "LinguaDev API Platform",
    "description": "Standard 5-10-15-30 escalation",
    "num_loops": 2,
    "escalation_rules": [
      {
        "escalation_delay_in_minutes": 5,
        "targets": [
          { "type": "schedule_reference", "id": "SCH_PRIMARY_API" }
        ]
      },
      {
        "escalation_delay_in_minutes": 10,
        "targets": [
          { "type": "schedule_reference", "id": "SCH_SECONDARY_API" }
        ]
      },
      {
        "escalation_delay_in_minutes": 15,
        "targets": [
          { "type": "schedule_reference", "id": "SCH_MANAGER_ONCALL" }
        ]
      },
      {
        "escalation_delay_in_minutes": 30,
        "targets": [
          { "type": "user_reference", "id": "PVP123" }
        ]
      }
    ]
  }
}
```

Schedule de una rotación semanal follow-the-sun:

```json
{
  "schedule": {
    "name": "LinguaDev API Primary — Follow the Sun",
    "time_zone": "UTC",
    "schedule_layers": [
      {
        "name": "US layer",
        "start": "2026-08-01T00:00:00Z",
        "rotation_virtual_start": "2026-08-01T00:00:00Z",
        "rotation_turn_length_seconds": 604800,
        "users": [
          { "user": { "id": "P_US_ALICE", "type": "user_reference" } },
          { "user": { "id": "P_US_BOB",   "type": "user_reference" } },
          { "user": { "id": "P_US_CAROL", "type": "user_reference" } }
        ],
        "restrictions": [
          {
            "type": "weekly_restriction",
            "start_time_of_day": "14:00:00",
            "duration_seconds": 32400,
            "start_day_of_week": 1
          }
        ]
      },
      {
        "name": "EU layer",
        "start": "2026-08-01T00:00:00Z",
        "users": [
          { "user": { "id": "P_EU_DAVE",  "type": "user_reference" } },
          { "user": { "id": "P_EU_EVE",   "type": "user_reference" } },
          { "user": { "id": "P_EU_FRANK", "type": "user_reference" } }
        ],
        "restrictions": [
          {
            "type": "weekly_restriction",
            "start_time_of_day": "07:00:00",
            "duration_seconds": 25200,
            "start_day_of_week": 1
          }
        ]
      },
      {
        "name": "APAC layer",
        "start": "2026-08-01T00:00:00Z",
        "users": [
          { "user": { "id": "P_APAC_GRACE", "type": "user_reference" } },
          { "user": { "id": "P_APAC_HANK",  "type": "user_reference" } }
        ]
      }
    ]
  }
}
```

Los layers se superponen: la que corresponda por hora local prima. Al no cubrir 24h, cae al layer siguiente.

### 3.3 Herramientas 2026: PagerDuty, Opsgenie, incident.io, Rootly

**Grafana OnCall (Grafana Labs 2022-2026):** archivado en **marzo 2026**. Grafana Labs anunció que la comunidad open-source no alcanzó tracción suficiente y recomienda migrar a alternativas. Si tu stack aún lo usa, planificar migración.

| Herramienta | Fortalezas 2026 | Ideal para |
|---|---|---|
| **PagerDuty** | Líder enterprise, AIOps (Event Intelligence) para dedup/correlación, ecosistema rich | Enterprises, teams grandes, alta compliance |
| **Opsgenie** (Atlassian) | Integración Jira/Confluence nativa | Teams que viven en Atlassian; roadmap se ha ralentizado |
| **incident.io** | UX moderna, focus post-incident, LLM-assisted, timeline automático | Startups/scale-ups, teams que valoran UX |
| **Rootly** | AIOps summarization, Slack-first, incident automation | Similar a incident.io, fuerte en Slack |
| **BigPanda** | Correlación AIOps upstream (miles de alertas → incidents) | Enterprises con observability distribuida |
| **AlertOps** | Rotaciones complejas, precios competitivos | Teams medianos |

**PagerDuty Event Intelligence (AIOps):** en 2026 es feature madura. Deduplica alertas relacionadas (500 alertas del mismo problema → 1 incident), correlaciona por servicio/tópico, y sugiere probable root cause basado en incidents pasados. Precio adicional, pero para teams con >100 alerts/día es esencial.

**Ejemplo Python: crear un incident desde código:**

```python
# lib/incident_client.py
import requests
import os

class PagerDutyClient:
    def __init__(self):
        self.routing_key = os.environ["PD_ROUTING_KEY"]

    def trigger(self, summary: str, severity: str, source: str, custom_details: dict = None):
        payload = {
            "routing_key": self.routing_key,
            "event_action": "trigger",
            "dedup_key": f"{source}:{summary[:80]}",  # dedup por source+summary
            "payload": {
                "summary": summary,
                "severity": severity,      # critical|error|warning|info
                "source": source,
                "component": "linguadev-api",
                "custom_details": custom_details or {}
            }
        }
        r = requests.post(
            "https://events.pagerduty.com/v2/enqueue",
            json=payload,
            timeout=10
        )
        r.raise_for_status()
        return r.json()

    def resolve(self, dedup_key: str):
        payload = {
            "routing_key": self.routing_key,
            "event_action": "resolve",
            "dedup_key": dedup_key
        }
        requests.post("https://events.pagerduty.com/v2/enqueue", json=payload).raise_for_status()

# Uso desde una app
client = PagerDutyClient()
client.trigger(
    summary="Payment service — 5xx > 5%",
    severity="critical",
    source="linguadev-api-us-east-1",
    custom_details={"error_rate": "6.2%", "affected_endpoint": "/checkout"}
)
```

### 3.4 ChatOps y el war room

**ChatOps** = ejecutar operaciones desde el chat (Slack/Teams) con bots autorizados. Beneficios:

- **Todo queda logged** (timeline gratis).
- **Visibility** — todo el equipo ve qué se hace.
- **Auditability** — quién ejecutó qué y cuándo.
- **Knowledge sharing** — juniors aprenden viendo.
- **Peer review implícito** — menos errores.

Comandos típicos:

```
/pd ack INC-12345         # ack en PagerDuty
/pd resolve INC-12345
/deploy rollback prod-v42
/db query "SELECT count(*) FROM sessions WHERE created_at > now() - interval '5m'"
/incident sev 2 "API 5xx spike"
/statuspage post "investigating elevated errors"
```

**Protocolo de war room:**

1. Al declarar incident (SEV1/SEV2), el bot crea automáticamente:
   - Canal `#inc-YYYYMMDD-<slug>` (Slack channel).
   - Video call bridge (Zoom, Meet).
   - Ticket en Jira/Linear.
   - Statuspage post en modo "investigating".
   - Incident doc (Google Docs, Confluence, o incident.io).
2. IC pinnea mensaje con: hipótesis actuales, próximos pasos, roles asignados.
3. Todo el debug ocurre **en el canal**, no en DMs.
4. Scribe mantiene el pinned message actualizado.
5. Al resolver, el bot cierra el canal en 7 días (archive), publica timeline al channel público de incidents, y schedule del post-mortem en 5 días.

Ejemplo de bot custom (Node.js) que gestiona el ciclo:

```javascript
// incidents-bot/index.js
const { App } = require('@slack/bolt');
const { Octokit } = require('@octokit/rest');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

app.command('/incident', async ({ command, ack, respond, client }) => {
  await ack();
  const [action, sev, ...rest] = command.text.split(' ');
  if (action !== 'declare') {
    return respond('Usage: /incident declare <SEV1|SEV2|SEV3> <title>');
  }
  const title = rest.join(' ');
  const date = new Date().toISOString().slice(0, 10);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const channelName = `inc-${date}-${slug}`;

  // Crear canal
  const { channel } = await client.conversations.create({ name: channelName });

  // Invitar on-call
  await client.conversations.invite({
    channel: channel.id,
    users: process.env.ONCALL_USER_IDS.split(',').join(',')
  });

  // Pinned template
  const templateMsg = await client.chat.postMessage({
    channel: channel.id,
    text: `*Incident:* ${title}\n*Severity:* ${sev}\n*IC:* TBD\n*Ops Lead:* TBD\n*Comms:* TBD\n\n*Timeline:*\n- ${new Date().toISOString()} declared`
  });
  await client.pins.add({ channel: channel.id, timestamp: templateMsg.ts });

  // Crear GitHub issue para post-mortem
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  await octokit.issues.create({
    owner: 'linguadev',
    repo: 'incidents',
    title: `Post-mortem: ${title} (${date})`,
    body: `Related channel: #${channelName}\n\n_Complete post-mortem within 5 business days._`,
    labels: ['post-mortem', sev.toLowerCase()],
  });

  await respond({ text: `Incident declared. Join <#${channel.id}>` });
});

(async () => { await app.start(); console.log('Incident bot running'); })();
```

---

## 4. Incident Commander, error budgets y post-mortems (nivel avanzado)

### 4.1 El rol de Incident Commander (IC)

**Origen:** el **Incident Command System** (ICS) del **NIMS** (National Incident Management System, FEMA) usado por bomberos y policía desde los años 70. Adaptado a tech por Google (SRE Book cap 14) y PagerDuty.

**Regla clave:** el IC **coordina, no debugea**. Su función es tener visión de 30k pies y tomar decisiones. Si el IC se pone a debugear, deja de coordinar → caos.

Roles durante un incident (para SEV1/SEV2 grande, personas distintas; para SEV2 pequeño, una persona puede cubrir varios):

- **Incident Commander (IC):** coordina, delega, decide, comunica.
- **Ops Lead:** dirige el debug técnico, ejecuta comandos.
- **Comms Lead:** actualiza status page, support, ejecutivos.
- **Scribe:** mantiene timeline y decisions log en el canal/doc.
- **Subject Matter Expert (SME):** llamado ad-hoc para expertise específico.

Facultades del IC durante el incident:

- ✅ Declarar SEV y actualizarlo.
- ✅ Decidir rollback vs fix forward.
- ✅ Activar DR (ver [cap 37](./37-disaster-recovery-y-backups.md)).
- ✅ Degradar servicios (activar feature flags de fallback).
- ✅ Escalar a management sin permiso previo.
- ✅ Iniciar comms externa.

Anti-patrones:

- ❌ El IC debe ser el "más senior técnicamente" — no; debe ser el mejor **coordinador entrenado**.
- ❌ El IC debe ser un ejecutivo — no; ejecutivos raramente tienen entrenamiento IR.
- ❌ Rotar IC cada 15 min en incidents largos sin handoff — genera pérdida de contexto.

Entrenamiento IC: **tabletop exercises** (simulacros escritos), **game days** (chaos engineering con roles definidos, ver [cap 38](./38-chaos-engineering-en-practica.md)), sombras a incidents reales (shadow-then-lead).

### 4.2 Error budgets como política

**Concepto:** el SLO define el nivel de disponibilidad esperado. El **error budget** es `100% - SLO`. Si SLO=99.9%, el error budget es 0.1% ≈ **43.2 min de downtime por mes**.

**Error budget policy** (Google SRE Book cap 3-4): reglas escritas que gobiernan qué se hace al consumir el budget. Ejemplo:

```markdown
# LinguaDev API — Error Budget Policy

## SLO
- 99.9% availability, rolling 30 days
- Error budget: 43.2 min/mes

## Consumption tiers
### Verde: <50% consumed
- Business as usual. Deploys normales.

### Amarillo: 50-75% consumed
- IC de la semana revisa incidents recientes con el equipo.
- Considerar postponer features de alto riesgo.

### Naranja: 75-95% consumed
- FREEZE de features no críticos.
- Solo bug fixes y deploys de reliability.
- Retrospectiva urgente de root causes.

### Rojo: >95% consumed
- FREEZE total de deploys (excepto rollback y hot-fix).
- Todo el equipo dedica 50%+ del tiempo a reliability.
- Reunión con product para replantear roadmap.

### Budget agotado
- FREEZE hasta el próximo reset del rolling window.
- Post-mortem executive-level.
- Consideración de bajar el SLO (con business owner).

## Overrides
- Security patches: siempre permitidos.
- Compliance-mandated changes: permitidos con IC sign-off.
```

**Función crítica:** el error budget policy es el **shield del equipo**. Cuando el business quiere pushar features y el budget está agotado, la política dice "no". Sin política escrita, cada incident se vuelve negociación. Con política, es proceso.

Query Prometheus para tracker de consumo:

```promql
# Error budget consumed (%) — rolling 30 days
1 - (
  (
    sum(rate(http_requests_total{job="linguadev-api",code!~"5.."}[30d]))
    /
    sum(rate(http_requests_total{job="linguadev-api"}[30d]))
  )
  /
  0.999   # SLO 99.9%
)
```

### 4.3 Post-mortem blameless: template y proceso

**Blameless** = focus en sistemas y procesos, no en personas. **Regla:** en un post-mortem, no aparece "Alice pushed the bad code"; aparece "El deploy pipeline no requirió staging validation para hot-fixes".

Template canónico (Google, PagerDuty, GitLab):

```markdown
# Post-mortem: [Título breve del incident]

## Metadata
- **Fecha del incident:** 2026-08-13
- **Duración:** 13:24 UTC → 14:47 UTC (83 min)
- **Severity:** SEV2
- **Incident Commander:** alice@linguadev.app
- **Author:** bob@linguadev.app
- **Reviewed by:** carol@ (SRE lead), dave@ (product)
- **Status:** Final (published 2026-08-18)

## Summary
Dos párrafos que respondan: ¿qué pasó, cuánto duró, qué causó, cómo se resolvió, qué impacto tuvo?

## Impact
- Usuarios afectados: ~12,400 (33% del DAU durante la ventana)
- Requests fallidos: 187,000 (12% del total del período)
- Business impact estimado: $2,100 (basado en $0.014/user-hour avg)
- SLO impact: consumió 34% del error budget mensual

## Timeline (UTC)
- 13:24 — Deploy v4.21 automático (Argo CD sync)
- 13:26 — Prometheus alert `HighErrorRate` dispara
- 13:26 — PagerDuty page a primary on-call (alice)
- 13:29 — Alice ack, abre #inc-20260813-api-500s
- 13:31 — IC declarado SEV2 (Bob toma IC, Alice Ops Lead)
- 13:35 — Root cause hipótesis: nuevo endpoint /v2/hint con query lenta
- 13:42 — Confirmed: query hace full table scan
- 13:44 — Decisión: rollback v4.21 → v4.20
- 13:47 — Rollback en progreso (Argo CD)
- 13:51 — Rollback complete, error rate cae
- 14:03 — Error rate en baseline
- 14:47 — Post-monitor 30min, incident cerrado

## Root cause (5 whys)
1. ¿Por qué disparó el alert? Rate de 5xx superó 5% en 5 min.
2. ¿Por qué había 5xx? Endpoint /v2/hint devolvía 500 tras 30s.
3. ¿Por qué 30s? Query hacía full scan de tabla `activity_log` (25M rows).
4. ¿Por qué full scan? Faltaba índice en columna `user_id` (nueva query no lo consideró).
5. ¿Por qué no se detectó en review? El PR no incluyó EXPLAIN ANALYZE y CI no lo verificó.

## What went well
- MTTA 3 min (alert config bueno).
- Runbook actualizado facilitó rollback en 5 min.
- IC bien coordinado, war room limpio.

## What went wrong
- Feature deployed a prod sin canary staging.
- PR review no detectó falta de índice.
- Statuspage se actualizó tarde (14:20 en vez de 13:35).

## Where we got lucky
- Alert disparó rápido (podría no haber si el 5xx era 3%).
- Alice estaba disponible; secondary estaba fuera (fue Follow-the-sun US layer, EU layer no habría cubierto hasta 14:00).

## Action items
| ID | Descripción | Owner | Due | Ticket |
|----|-------------|-------|-----|--------|
| AI-1 | Añadir requisito de EXPLAIN ANALYZE en template PR de queries | dave | 2026-08-25 | LIN-4521 |
| AI-2 | CI gate: query lint (sqllint) que detecte full scans potenciales | eve | 2026-09-10 | LIN-4522 |
| AI-3 | Añadir canary staging obligatorio en pipeline API | frank | 2026-09-01 | LIN-4523 |
| AI-4 | Runbook: sección "actualizar statuspage" con comando exacto | alice | 2026-08-20 | LIN-4524 |
| AI-5 | Auditar índices faltantes en `activity_log` y otras tablas grandes | grace | 2026-08-30 | LIN-4525 |

## Attachments
- [Grafana dashboard snapshot](./attachments/2026-08-13-grafana.png)
- [Full Slack timeline export](./attachments/2026-08-13-slack.log)
- [Rollback commit](https://github.com/linguadev/api/commit/abc123)
```

**Proceso obligatorio:**

- **Todo SEV1 y SEV2:** post-mortem obligatorio, publicado <5 días laborales.
- **SEV3:** opcional, recomendado si hay learnings novedosos.
- **Review meeting:** presentar al equipo en 1h dentro de 10 días.
- **Action items:** tracked en Jira/Linear con owner + due, revisados en próximo IR review mensual.

**Anti-patrones:**

- ❌ Post-mortem con "root cause: human error".
- ❌ Action items sin owner ni fecha ("mejorar el monitoring").
- ❌ No hacer review — el documento se archiva sin lectura.
- ❌ Culpar al on-call que estaba solo con contexto limitado.
- ❌ Nunca cerrar action items — se acumulan y pierden significado.

### 4.4 IR review mensual: cerrar el loop

Reunión mensual de 60 min con SREs + engineering managers:

- Revisar todos los incidents del mes: MTTR, SEV distribution.
- Estado de action items: cerrados, en progreso, blocked.
- Trends: ¿qué servicios tienen más incidents?
- Alert fatigue metrics: actionable rate, MTTA.
- Error budget status por servicio.
- Decisiones estratégicas: freeze, replantear SLO, contratar.

Output publicado a toda la org (transparencia).

---

## 5. Ejemplo práctico: sistema de IR completo para LinguaDev Pro

### Paso 1: alerting con SLO burn-rate

```yaml
# prometheus/rules/linguadev-api-slo.yaml
groups:
  - name: linguadev-api-slo
    rules:
      - alert: LinguadevApiErrorBudgetBurnFast
        expr: |
          (1 - (sum(rate(http_requests_total{job="linguadev-api",code!~"5.."}[1h])) / sum(rate(http_requests_total{job="linguadev-api"}[1h])))) > (14.4 * 0.001)
          and
          (1 - (sum(rate(http_requests_total{job="linguadev-api",code!~"5.."}[5m])) / sum(rate(http_requests_total{job="linguadev-api"}[5m])))) > (14.4 * 0.001)
        for: 2m
        labels:
          severity: page
          service: linguadev-api
        annotations:
          summary: "linguadev-api fast burn (2h to consume monthly budget)"
          runbook: "https://runbooks.linguadev.app/api-burn-fast"
```

### Paso 2: routing en Alertmanager → PagerDuty

```yaml
# alertmanager/config.yaml
route:
  receiver: pagerduty-api
  group_by: [alertname, service]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - match:
        severity: page
        service: linguadev-api
      receiver: pagerduty-api
    - match:
        severity: ticket
      receiver: slack-ops-tickets

receivers:
  - name: pagerduty-api
    pagerduty_configs:
      - service_key: R01AB_LINGUADEV_API_KEY
        severity: '{{ .CommonLabels.severity }}'
        details:
          runbook: '{{ .CommonAnnotations.runbook }}'
          dashboard: '{{ .CommonAnnotations.dashboard }}'
  - name: slack-ops-tickets
    slack_configs:
      - api_url: https://hooks.slack.com/services/...
        channel: '#ops-tickets'
```

### Paso 3: escalation policy en PagerDuty (Terraform)

```hcl
# terraform/pagerduty.tf
resource "pagerduty_escalation_policy" "linguadev_api" {
  name        = "LinguaDev API — 5/10/15/30"
  description = "Primary → Secondary → Manager → VP"
  num_loops   = 2

  rule {
    escalation_delay_in_minutes = 5
    target {
      type = "schedule_reference"
      id   = pagerduty_schedule.primary.id
    }
  }
  rule {
    escalation_delay_in_minutes = 10
    target {
      type = "schedule_reference"
      id   = pagerduty_schedule.secondary.id
    }
  }
  rule {
    escalation_delay_in_minutes = 15
    target {
      type = "user_reference"
      id   = data.pagerduty_user.manager_oncall.id
    }
  }
}

resource "pagerduty_service" "api" {
  name                    = "linguadev-api"
  auto_resolve_timeout    = 14400
  acknowledgement_timeout = 600
  escalation_policy       = pagerduty_escalation_policy.linguadev_api.id
  alert_creation          = "create_alerts_and_incidents"

  incident_urgency_rule {
    type    = "constant"
    urgency = "high"
  }
}
```

### Paso 4: bot de incident declaration (ver secc 3.4)

Deploy en el cluster con secrets seguros:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: incidents-bot
  namespace: sre
spec:
  replicas: 1
  selector:
    matchLabels: { app: incidents-bot }
  template:
    metadata:
      labels: { app: incidents-bot }
    spec:
      containers:
        - name: bot
          image: ghcr.io/linguadev/incidents-bot:2026.08
          envFrom:
            - secretRef: { name: incidents-bot-secrets }
```

### Paso 5: statuspage automation

```python
# lib/statuspage.py
import requests, os

def post_incident(name: str, status: str, message: str, impact="minor"):
    r = requests.post(
        f"https://api.statuspage.io/v1/pages/{os.environ['SP_PAGE_ID']}/incidents",
        headers={"Authorization": f"OAuth {os.environ['SP_TOKEN']}"},
        json={
            "incident": {
                "name": name,
                "status": status,   # investigating|identified|monitoring|resolved
                "impact_override": impact,
                "body": message,
                "component_ids": [os.environ["SP_API_COMPONENT"]]
            }
        }
    )
    r.raise_for_status()
    return r.json()

def update_incident(incident_id: str, status: str, message: str):
    r = requests.patch(
        f"https://api.statuspage.io/v1/pages/{os.environ['SP_PAGE_ID']}/incidents/{incident_id}",
        headers={"Authorization": f"OAuth {os.environ['SP_TOKEN']}"},
        json={"incident": {"status": status, "body": message}}
    )
    r.raise_for_status()
```

### Paso 6: post-mortem template en Git

```bash
# En cada incident, crear archivo desde template
cp docs/incidents/TEMPLATE.md docs/incidents/2026-08-13-api-500s.md
# Editar, review, publicar
```

### Paso 7: métricas de IR mensuales (Python)

```python
# scripts/ir_metrics.py
"""Genera reporte mensual: MTTR, MTTA, alert fatigue, budget usage."""
import os, csv, sys
from datetime import datetime, timedelta
from statistics import mean, median

import requests

PD_TOKEN = os.environ["PD_API_TOKEN"]
BASE = "https://api.pagerduty.com"
HEADERS = {"Authorization": f"Token token={PD_TOKEN}", "Accept": "application/vnd.pagerduty+json;version=2"}

def fetch_incidents(since: datetime, until: datetime):
    incidents = []
    offset = 0
    while True:
        r = requests.get(f"{BASE}/incidents",
                         params={"since": since.isoformat(), "until": until.isoformat(),
                                 "limit": 100, "offset": offset},
                         headers=HEADERS)
        r.raise_for_status()
        data = r.json()
        incidents.extend(data["incidents"])
        if not data.get("more"):
            break
        offset += 100
    return incidents

def report(month_start: datetime):
    month_end = month_start.replace(day=28) + timedelta(days=4)
    month_end = month_end.replace(day=1)
    incs = fetch_incidents(month_start, month_end)

    mtta = []
    mttr = []
    by_service = {}

    for inc in incs:
        created = datetime.fromisoformat(inc["created_at"].rstrip("Z"))
        acked = next((datetime.fromisoformat(la["at"].rstrip("Z"))
                      for la in inc.get("acknowledgements", [])), None)
        resolved = datetime.fromisoformat(inc["last_status_change_at"].rstrip("Z")) \
            if inc["status"] == "resolved" else None
        if acked:
            mtta.append((acked - created).total_seconds() / 60)
        if resolved:
            mttr.append((resolved - created).total_seconds() / 60)

        svc = inc["service"]["summary"]
        by_service.setdefault(svc, {"count": 0, "sev": {}})
        by_service[svc]["count"] += 1
        sev = inc.get("urgency", "unknown")
        by_service[svc]["sev"][sev] = by_service[svc]["sev"].get(sev, 0) + 1

    print(f"IR Report {month_start:%Y-%m}")
    print(f"Total incidents: {len(incs)}")
    print(f"MTTA (min): mean={mean(mtta):.1f} median={median(mtta):.1f}" if mtta else "MTTA: n/a")
    print(f"MTTR (min): mean={mean(mttr):.1f} median={median(mttr):.1f}" if mttr else "MTTR: n/a")
    print("\nBy service:")
    for svc, d in sorted(by_service.items(), key=lambda x: -x[1]["count"]):
        print(f"  {svc}: {d['count']} ({d['sev']})")

if __name__ == "__main__":
    month = datetime.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else datetime.utcnow().replace(day=1)
    report(month)
```

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Cada alert accionable tiene runbook** vinculado.
- ✅ **Actionable rate >60%**; auditar cada trimestre.
- ✅ **Rotación mínima 6-8** personas, cap toil <50%.
- ✅ **Compensación explícita** por on-call.
- ✅ **Escalation 5/10/15/30** min como default.
- ✅ **IC coordina, no debugea**.
- ✅ **War room en Slack** con ChatOps y timeline pinneado.
- ✅ **Post-mortem blameless obligatorio** para SEV1/SEV2.
- ✅ **Action items con owner+fecha**, tracked en Jira/Linear.
- ✅ **Error budget policy escrita** que actúa como shield.
- ✅ **IR review mensual** con métricas y trends.
- ✅ **Statuspage** actualizada cada 30 min durante SEV1.
- ✅ **Hand-off ritualizado** al cambiar semana.

### Anti-patrones

- ❌ Alert sin runbook.
- ❌ Rotación de 2-3 personas.
- ❌ On-call sin compensación.
- ❌ IC que se pone a debugear.
- ❌ Debug por DMs (sin trail).
- ❌ Post-mortem "root cause: human error".
- ❌ Action items sin owner ni due date.
- ❌ Sin error budget policy escrita.
- ❌ Statuspage silenciosa durante SEV1.
- ❌ Ignorar alert fatigue metrics.
- ❌ Culpar al on-call en el review.
- ❌ Grafana OnCall (archivado marzo 2026): migrar a alternativa.

### Tabla decisión herramienta

| Contexto | Recomendación 2026 |
|---|---|
| Enterprise + AIOps + compliance | **PagerDuty** |
| Vivimos en Atlassian | **Opsgenie** |
| Startup/scale-up, UX + AI-assisted | **incident.io** |
| Slack-first + AI summarization | **Rootly** |
| Correlación masiva upstream | **BigPanda** |
| Antes usábamos Grafana OnCall | Migrar (archivado 03/2026) |

---

## 7. Casos reales industria 2011-2026

**Google SRE Book (2016) y Workbook (2018):** el manifiesto. Ben Treynor Sloss formalizó Site Reliability Engineering en Google. Capítulos 6 (Monitoring), 8 (Release Engineering), 14 (Managing Incidents) y 15 (Postmortem Culture) definen la ortodoxia moderna. Lectura obligada.

**PagerDuty On-Call Handbook (2015+):** documento público con templates de runbook, escalation, y post-mortem. Referencia gratuita para equipos que empiezan. En 2026 sigue actualizado con secciones sobre AIOps y AI-assisted response.

**GitLab public post-mortems (2017+):** la política de radical transparency de GitLab incluye publicar post-mortems completos en su blog. El famoso "2017-01-31 Database Incident" (6h de datos perdidos, backups fallando silenciosamente) es la lectura obligada de todo SRE.

**Slack outage Jan 2021:** 24h de degradación por saturación de sesiones + dependencies internas. Post-mortem público destacó falta de chaos testing regular en la arquitectura de sesiones. Referencia para "por qué el chaos matters".

**Facebook Oct 2021 (6h global outage):** BGP misconfig tumbó Facebook, WhatsApp, Instagram simultáneamente. Recuperación tardó por dependencias circulares: hasta las tarjetas de acceso físico a datacenters dependían de sistemas caídos. Post-mortem oficial destacó que **ingenieros tuvieron que ir físicamente con angle grinders**.

**AWS US-EAST-1 múltiples 2021-2024:** cada outage AWS produce ola de post-mortems públicos de empresas afectadas. En 2024 hubo el evento de EC2/EBS con timeline transparente por parte de AWS y muchas empresas usaron ese caso como game day retrospectivo.

**Datadog Mar 2023 (24h+ outage):** ironía suprema (un observability provider down). Post-mortem detalló dependency cross-region inesperada. Datadog implementó "cell-based architecture" post-incident.

**Netflix incident culture:** aunque menos publicitados, Netflix mantiene culture de blameless review con game days chaos regulares. Charity Majors (Honeycomb) y Nora Jones (ex-Netflix, fundadora Jeli acquired by PagerDuty 2023) llevan lecciones a la industria.

**Grafana OnCall 2022-2026:** Grafana Labs open-sourceó OnCall como alternativa a PagerDuty en 2022. En **marzo 2026** anunció archivar el proyecto por falta de tracción sostenida. Consecuencia práctica: teams que lo adoptaron deben migrar (incident.io, Rootly, PagerDuty).

**PagerDuty AIOps:** desde 2020 PagerDuty compró Rundeck, Catalytic, Jeli (2023). En 2026 su suite incluye correlación, sugerencias de root cause con ML y summarización de timelines con LLM. Alemania (BAG 2019+): on-call es tiempo de trabajo compensable si exige respuesta inmediata; presión sobre modelos "on-call gratis" en EEUU.

---

## 8. Ejercicios prácticos

### Ejercicio 1: escribir runbook para un alert real

**Objetivo:** producir un runbook completo siguiendo el template.

**Setup:**
- Alert existente en tu sistema (o inventá uno realista para LinguaDev API).
- Acceso a Grafana + Prometheus.

**Pasos:**
1. Identificar el alert (ej: `LinguadevApiHighErrorBudgetBurn`).
2. Escribir header con owner y last-reviewed.
3. Escribir context: qué mide, impacto en negocio.
4. Diagnosis: 3-5 pasos concretos, con queries y comandos copy-pasteable.
5. Remediation: 2-3 opciones con comandos exactos.
6. Escalation criteria y contactos.
7. Peer review con otro engineer.
8. Merge a `runbooks/` repo.

**Criterios de éxito:**
- [ ] Runbook publicado en Git, linkeable desde alert.
- [ ] Peer review documentado.
- [ ] Ejecutar el runbook en un game day o incident real dentro de 30 días.
- [ ] Feedback capturado y runbook iterado.

**Bonus:** convertir el runbook en formato interactivo (Notebook, script bash con menú).

---

### Ejercicio 2: auditar alerts y calcular actionable rate

**Objetivo:** detectar alert fatigue en tu sistema.

**Setup:**
- Acceso a PagerDuty API o equivalente.
- Últimos 90 días de historial de incidents.

**Pasos:**
1. Exportar todos los incidents del período.
2. Marcar cada uno como `actionable` (requirió acción real) o `noise` (self-resolved, falsa alarma).
3. Calcular `actionable_pct` por alert.
4. Ordenar por peor actionable_pct.
5. Para cada alert con <40%: decidir eliminar, ajustar threshold, o mover a ticketing.
6. Presentar plan al equipo y aplicar cambios.

**Criterios de éxito:**
- [ ] Análisis con datos por alert (spreadsheet o dashboard).
- [ ] Plan de cambios con owner por alert.
- [ ] Reducción medible de pages/semana en el siguiente mes.
- [ ] Documentar en wiki: "Alert Audit Q3 2026".

**Bonus:** automatizar el reporte mensual con script Python (secc. 5, paso 7).

---

### Ejercicio 3: game day IC (simulacro)

**Objetivo:** practicar el rol de Incident Commander sin incident real.

**Setup:**
- Equipo mínimo 4 personas.
- Cluster staging.
- Scenario preparado (ej: "las API responden 500 desde us-east-1, staging").

**Pasos:**
1. Facilitator declara scenario a las 10:00.
2. Elegir IC (rotar entre participantes).
3. IC declara SEV, abre war room, asigna roles.
4. Debug simulado durante 30 min.
5. IC decide mitigación (ej: rollback simulado, feature flag).
6. Facilitator declara "resolved" a los 35 min.
7. Debrief inmediato: qué funcionó, qué no.
8. Escribir mini post-mortem (30 min).

**Criterios de éxito:**
- [ ] Todos los roles asignados y ejecutados.
- [ ] Timeline mantenido por el Scribe.
- [ ] IC no se puso a debugear (peer review).
- [ ] Post-mortem mini publicado.
- [ ] Cada participante rota IC al menos 1 vez en el mes.

**Bonus:** grabar la sesión y usarla para onboarding de nuevos on-callers.

---

### Ejercicio 4: implementar error budget policy

**Objetivo:** dejar escrita y adoptada la política.

**Setup:**
- SLO definido para al menos 1 servicio crítico.
- Buy-in inicial de product owner.

**Pasos:**
1. Calcular error budget mensual (min de downtime = `(1 - SLO) * 30 * 24 * 60`).
2. Definir tiers (verde/amarillo/naranja/rojo) con % budget consumed.
3. Definir acciones por tier (freeze, review, replan).
4. Escribir política siguiendo template (secc. 4.2).
5. Presentar a product y engineering.
6. Publicar en wiki con firma de leadership.
7. Instrumentar Grafana dashboard con status del budget.

**Criterios de éxito:**
- [ ] Documento publicado y firmado.
- [ ] Dashboard visible en Grafana.
- [ ] Simulacro: "si estuviéramos hoy en rojo, ¿qué haríamos?".
- [ ] Al menos 1 decisión en el mes siguiente usando la política.

**Bonus:** integrar el status del budget en Slack (bot que anuncia semanalmente).

---

### Ejercicio 5 (avanzado): post-mortem completo de un incident real

**Objetivo:** producir un post-mortem blameless publicable.

**Setup:**
- Incident real reciente (SEV2 o mayor).
- Datos: alerts, Slack logs, Grafana screenshots, commits, deploys.
- 2h dedicadas.

**Pasos:**
1. Reconstruir timeline (Slack export, PagerDuty history).
2. Aplicar 5 whys al root cause.
3. Redactar sections: summary, impact, timeline, root cause, what went well/wrong, where we got lucky.
4. Listar action items con owner + due date.
5. Peer review con 2 engineers (uno del equipo, uno de fuera).
6. Ejecutar review meeting de 1h.
7. Publicar en wiki público.
8. Trackear action items en Jira/Linear con label `post-mortem`.

**Criterios de éxito:**
- [ ] Documento publicado en <5 días laborales.
- [ ] Zero blame language (peer review lo verifica).
- [ ] Todos los action items con owner + due.
- [ ] Review meeting realizada.
- [ ] Follow-up 30 días después: status action items.

**Bonus:** publicar externalmente (blog) con datos anonimizados si aporta a la comunidad.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [Google SRE Book (free online)](https://sre.google/books/).
- [PagerDuty On-Call Handbook](https://response.pagerduty.com).
- [PagerDuty Incident Response Documentation](https://response.pagerduty.com/oncall/).
- [incident.io Response Docs](https://incident.io).
- [Rootly Documentation](https://docs.rootly.com/).
- [Etsy Debriefing Facilitation Guide (John Allspaw)](https://extfiles.etsy.com/DebriefingFacilitationGuide.pdf).

**Herramientas 2026:**
- **PagerDuty** — enterprise leader + AIOps.
- **Opsgenie** — Atlassian ecosystem.
- **incident.io** — modern UX + LLM-assisted.
- **Rootly** — Slack-first + AI.
- **BigPanda** — AIOps correlation upstream.
- **AlertOps** — mid-market alternative.
- ~~**Grafana OnCall**~~ — archivado marzo 2026, migrar.

**Referencias adicionales:**
- Charity Majors, Liz Fong-Jones, George Miranda — *Observability Engineering* (O'Reilly 2022).
- Betsy Beyer et al. — *The Site Reliability Workbook* (O'Reilly 2018).
- Alex Ewerlöf — *"On-Call Compensation"* series (Medium 2020-2024).
- NIST SP 800-61 — Computer Security Incident Handling Guide.

**Siguientes pasos:**
- Auditá tus alerts esta semana; calculá actionable rate.
- Escribí (o revisá) 1 runbook por semana durante 1 mes.
- Programá un **IC training game day** en los próximos 30 días.
- Redactá tu **error budget policy** y publicalá.
- Continuá con [Cap 40 — FinOps y optimización de costos](./40-cost-optimization-finops.md) para completar la trinidad Reliability/DR/Cost.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales sobre runbooks obligatorios, principio de alertas accionables, alert fatigue metrics, clasificación SEV1/2/3, rotaciones on-call sostenibles (6-8 personas, follow-the-sun, compensación), comparación PagerDuty vs Opsgenie vs incident.io vs Rootly (con nota sobre Grafana OnCall archivado marzo 2026), escalation policies, rol de Incident Commander (NIMS/ICS), war rooms y ChatOps, post-mortem blameless template, error budget policies como shield, IR review mensual, y anti-patrones comunes.

- **Fuente:** [`packages/content/src/tech/devops/sim-39-incident-response-and-oncall.json`](../../packages/content/src/tech/devops/sim-39-incident-response-and-oncall.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-39-incident-response-and-oncall`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 38 — Chaos Engineering en práctica](./38-chaos-engineering-en-practica.md) · [Índice](./README.md) · [Capítulo 40 — Cost Optimization y FinOps →](./40-cost-optimization-finops.md)
