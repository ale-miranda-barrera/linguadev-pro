# Capítulo 34 — Feature Flags a escala

> **Focus:** Feature flags como técnica de ingeniería, no como config file. Taxonomía (release, ops, experiment, permission), platforms (LaunchDarkly, Split, Unleash, GrowthBook, PostHog, Flagsmith, ConfigCat, Statsig), targeting rules, OpenFeature standard, testing con flags, kill switches, flag debt y lifecycle.
> **Áreas:** Deployment strategies · Runtime configuration · Experimentation
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Progressive delivery conceptual (cap 33): deploy ≠ release.
- CI/CD maduro (caps 02, 04): sin CI/CD confiable, feature flags amplifican riesgo.
- Observability básico (caps 17, 18): sin métricas por-cohort no podés medir experiments.
- Testing pyramid: unit, integration, E2E.
- JavaScript/TypeScript o Node.js suficiente para leer ejemplos SDK.

**Glosario mínimo:**
- **Feature flag / toggle / switch**: pieza de código `if (isEnabled('flag', user)) { ... } else { ... }` que consulta configuración externa.
- **Deploy vs release**: deploy es "código en producción"; release es "feature visible al usuario". Los flags los desacoplan.
- **Taxonomía Pete Hodgson (2017)**: release, ops, experiment, permission.
- **Targeting rule**: condición que decide el valor del flag por usuario (attributes, segmento, percentage rollout, geo).
- **Local evaluation**: el SDK evalúa flags en memoria contra un ruleset cacheado; latencia sub-µs, sin HTTP por chequeo. Actualización via Server-Sent Events (SSE).
- **Server-side vs Client-side SDK**: server recibe todo el ruleset (secure); client recibe solo el resultado por usuario (evita exponer reglas sensibles).
- **Kill switch**: flag ops permanente que desactiva instantáneamente una feature costosa/riesgosa.
- **Flag debt**: acumulación de flags que ya no cumplen su función pero siguen en código y en el sistema.
- **OpenFeature**: standard CNCF (v1.x en 2026) para API vendor-agnostic de flags. Providers para LaunchDarkly, Split, Unleash, Flagsmith, GrowthBook, ConfigCat.
- **Dark launch**: liberar código a producción con flag OFF para todos, luego habilitar a percentage.
- **Percentage rollout**: activar flag a X% de usuarios de forma determinística (mismo user siempre mismo bucket).

**Setup mínimo:**

```bash
# 1. Unleash self-hosted (opción OSS)
docker run -d --name unleash-db -e POSTGRES_PASSWORD=unleash -e POSTGRES_USER=unleash postgres:17
docker run -d --name unleash \
  -e DATABASE_URL=postgres://unleash:unleash@host.docker.internal:5432/postgres \
  -p 4242:4242 \
  unleashorg/unleash-server:6.4.0
# UI en http://localhost:4242, default admin/unleash4all

# 2. GrowthBook self-hosted (OSS con warehouse-native experiments)
docker run -d --name growthbook -p 3000:3000 -p 3100:3100 growthbook/growthbook:latest

# 3. Node SDK OpenFeature + Unleash provider
npm install @openfeature/server-sdk @openfeature/unleash-provider

# 4. LaunchDarkly SDK (para comparación)
npm install launchdarkly-node-server-sdk

# 5. Flagsmith (otra alternativa OSS)
docker run -d --name flagsmith -p 8000:8000 flagsmith/flagsmith:latest
```

---

## 1. El gran cuadro

Feature flags son la técnica de ingeniería más importante para deploy maduro que muchos equipos siguen implementando ad-hoc con `if (process.env.NEW_CHECKOUT === "true")`. La primera lección de este capítulo es que **feature flags son una plataforma, no un config file**. Facebook nació con flags. Google construyó "Gatekeeper" internamente. Netflix, Airbnb, Uber y GitHub gestionan miles de flags simultáneamente. LaunchDarkly llegó a valoración de más de $3B ofreciendo flags como servicio. En 2026, el ecosistema se divide entre SaaS enterprise (LaunchDarkly, Split, Statsig), plataformas OSS self-host (Unleash 6.x, GrowthBook, Flagsmith, ConfigCat) y el standard **OpenFeature** (CNCF, v1.x GA) que unifica la API para escapar del vendor lock-in.

El principio central es **decouple deploy from release**. En un mundo sin flags, hacer merge de una feature grande significa exponerla inmediatamente a todos. Los equipos evitan mergear features WIP → los branches viven meses → los merges son dolorosos → el trunk queda "sucio". Con flags, `main` puede contener features WIP escondidas detrás de `if (flag('new-checkout', user))`. El deploy va constantemente a producción. El release se hace desde un dashboard: activás para internal employees, luego 5%, luego 25%, luego 100%. Trunk-based development se vuelve viable. Merges pequeños y frecuentes. Feature completeness pasa a ser una decisión de producto, no un bloqueo de ingeniería. **Progressive delivery real** (cap 33) exige flags: sin ellos, "gradual rollout" solo puede hacerse a nivel de infraestructura (canary de tráfico), no a nivel de user cohort.

La taxonomía de Pete Hodgson (Martin Fowler, 2017) sigue siendo la referencia: **release toggles** (temporales, se borran post-launch), **ops toggles** (long-lived, kill switches operacionales), **experiment toggles** (A/B tests, viven durante el experimento), y **permission toggles** (long-lived, gating por tier de usuario). Cada tipo tiene lifecycle distinto y merece tratamiento distinto. Confundirlos genera "flag debt": el conjunto de flags que nadie sabe qué hacen, que llenan el dashboard, que quedan en código con ramas muertas que aumentan complejidad ciclomática. El promedio en empresas maduras es que un release toggle debería morir en semanas; encontrar flags de release del 2021 es señal de deuda técnica de flags.

La implementación 2026 tiene tres capas: (1) **la platform** (LaunchDarkly, Unleash, GrowthBook, etc.) que hostea flags, targeting rules y streaming updates; (2) **el SDK** en cada servicio que hace local evaluation con cache in-memory (evita HTTP por chequeo); (3) **la instrumentación** en la app: cada flag check produce evento telemetry para que el dashboard muestre "cuántos usuarios vieron variant A vs B" y para experimentation analysis. **Server-side vs client-side SDK** tienen modelos de seguridad distintos: server-side recibe *todo* el ruleset (seguro porque el server nunca lo expone); client-side (browser, mobile) recibe *solo* el resultado evaluado para ese usuario (evita exponer reglas sensibles como "power users get X"). En 2026 la arquitectura recomendada añade un **relay proxy / server-side evaluation en edge** (LaunchDarkly Relay, Unleash Edge) para reducir latencia y no exponer keys a clients. Este capítulo cubre taxonomía, platforms concretas, código real con SDK OpenFeature + LaunchDarkly + Unleash, targeting rules avanzadas, testing y erradicación de flag debt.

---

## 2. Taxonomía de flags y patrones de código (nivel básico)

### 2.1 Los 4 tipos de flag y su lifecycle

| Tipo | Propósito | Lifetime | Owner |
|---|---|---|---|
| **Release toggle** | Ocultar feature WIP hasta lanzamiento | días–semanas | Producto/dev |
| **Ops toggle** | Kill switch / control operacional | permanente | SRE/Ops |
| **Experiment toggle** | A/B test | duración del experimento | Product/Data |
| **Permission toggle** | Gating por tier/rol | permanente o largo | Producto |

Naming convention recomendada:

```
rel-checkout-v2-2026-q4     # release
ops-recommendations-off     # ops kill
exp-checkout-color          # experiment
perm-admin-panel            # permission
```

Al crear un flag, el metadata mínimo:

- **Tipo** (uno de los 4).
- **Owner** (equipo/persona).
- **Fecha estimada de eliminación** (si aplica).
- **Ticket JIRA/Linear** asociado.
- **Kill switch behavior** documentado (qué pasa si se apaga).

### 2.2 Pattern de código base

Server-side (Node/TS):

```typescript
import { OpenFeature } from '@openfeature/server-sdk';
import { UnleashProvider } from '@openfeature/unleash-provider';

await OpenFeature.setProviderAndWait(
  new UnleashProvider({
    url: process.env.UNLEASH_URL!,
    clientKey: process.env.UNLEASH_TOKEN!,
    appName: 'linguadev-api',
    refreshInterval: 15,
  })
);

export async function renderCheckout(user: User): Promise<Response> {
  const client = OpenFeature.getClient();
  const evalContext = {
    targetingKey: user.id,
    email: user.email,
    country: user.country,
    tier: user.subscriptionTier,
  };

  const useNewCheckout = await client.getBooleanValue(
    'rel-checkout-v2-2026-q4',
    false,          // default value si el flag no responde
    evalContext
  );

  if (useNewCheckout) {
    return renderCheckoutV2(user);
  }
  return renderCheckoutV1(user);
}
```

Notá cuatro cosas clave:

1. **Default value** obligatorio (`false`): si el SDK no puede resolver (offline, error de red), el código sigue funcionando con la versión "vieja".
2. **Evaluation context** con `targetingKey` (identificador único) y attributes.
3. **Async** en OpenFeature (algunos providers son sync).
4. Cero llamadas HTTP por chequeo: el SDK hace local evaluation contra un ruleset cacheado.

### 2.3 Client-side SDK (React/Next 2026)

```typescript
import { OpenFeature, OpenFeatureProvider, useFlag } from '@openfeature/react-sdk';
import { LaunchDarklyClientProvider } from '@openfeature/launchdarkly-client-provider';

async function bootstrap(user: User) {
  await OpenFeature.setProviderAndWait(
    new LaunchDarklyClientProvider(process.env.NEXT_PUBLIC_LD_CLIENT_KEY!, {
      streaming: true,
    })
  );
  await OpenFeature.setContext({
    targetingKey: user.id,
    email: user.email,
    country: user.country,
    tier: user.subscriptionTier,
  });
}

function CheckoutPage() {
  const { value: useNewCheckout } = useFlag('rel-checkout-v2-2026-q4', false);
  return useNewCheckout ? <CheckoutV2 /> : <CheckoutV1 />;
}

export default function App({ user }: { user: User }) {
  return (
    <OpenFeatureProvider>
      <CheckoutPage />
    </OpenFeatureProvider>
  );
}
```

**Advertencia crítica client-side:** el SDK client recibe solo el resultado ya evaluado por el server, nunca el ruleset. Esto evita exponer targeting rules confidenciales ("premium users get discount X"). Si tu vendor te ofrece "client SDK que descarga todas las reglas" para performance, pensá si querés que un usuario abra devtools y vea qué features tienen otros users.

### 2.4 Trampas frecuentes

- **`if (flag === "true")`** en vez de boolean: al cambiar a string variant rompe.
- **Sin default value** o default `null`: producción cae si el SDK no responde en cold start.
- **Chequear flags dentro de un loop** hot: usá local eval sí, pero cachear el resultado por request.
- **Hardcodear el `targetingKey`** con `user.email` (que puede cambiar) en vez de `user.id` estable.
- **Confundir flag ops con flag release**: apagar un flag "release" viejo en incident no ayuda si nadie sabe qué hace.

---

## 3. Platforms comparadas: LaunchDarkly, Unleash, GrowthBook, PostHog (nivel medio)

### 3.1 Tabla comparativa 2026

| Vendor | Pricing | Self-host | Foco | OpenFeature |
|---|---|---|---|---|
| **LaunchDarkly** | $$$ per-seat + MAU | Enterprise on-prem | Flags premier, enterprise | Sí (v1.x provider oficial) |
| **Split** | $$$ per-seat + MAU | Enterprise on-prem | Flags + Experiments statistical | Sí |
| **Unleash 6.x** | Free OSS + $ cloud | Sí (default) | Flags simplicity, developer-first | Sí (provider oficial) |
| **GrowthBook** | Free OSS + $ cloud | Sí | Flags + warehouse-native experiments | Sí |
| **PostHog** | Free OSS + $ cloud | Sí | Product analytics + flags + experiments | Sí |
| **Flagsmith** | Free OSS + $ cloud | Sí | Flags + segments + remote config | Sí |
| **ConfigCat** | $ per-seat | Sí (Enterprise) | Flags simple + affordable | Sí |
| **Statsig** | Free tier + $$$ | No | Product analytics + flags + experiments | Sí |
| **Harness FF** | $$ | Enterprise on-prem | Flags integrado con CI/CD Harness | Sí |

### 3.2 LaunchDarkly (server SDK)

```typescript
import * as LaunchDarkly from 'launchdarkly-node-server-sdk';

const client = LaunchDarkly.init(process.env.LD_SDK_KEY!, {
  streamUri: 'https://stream.launchdarkly.com',
  eventsUri: 'https://events.launchdarkly.com',
  offline: false,
});

await client.waitForInitialization({ timeout: 5 });

export async function shouldShowNewCheckout(user: User): Promise<boolean> {
  return client.variation(
    'rel-checkout-v2-2026-q4',
    { key: user.id, email: user.email, custom: { tier: user.subscriptionTier, country: user.country } },
    false
  );
}

// Cierre en shutdown
process.on('SIGTERM', () => client.close());
```

Ventajas: SDK maduro en 20+ lenguajes, streaming SSE con failover polling, edge relay (LaunchDarkly Relay Proxy) para reducir egress a la cloud, integraciones enterprise (Datadog, PagerDuty, Slack, Jira, SSO SAML, RBAC, audit log).

Desventaja: pricing MAU-based se dispara con userbase grande. Precios reales en 2026 rondan $10-50k/mes en escalas medianas.

### 3.3 Unleash 6.x (OSS + cloud)

```typescript
import { initialize } from 'unleash-client';

const unleash = initialize({
  url: 'https://unleash.linguadev.internal/api/',
  appName: 'linguadev-api',
  customHeaders: { Authorization: process.env.UNLEASH_TOKEN! },
  refreshInterval: 15,
  metricsInterval: 60,
  environment: process.env.NODE_ENV,
});

unleash.on('ready', () => console.log('Unleash ready'));

export function shouldShowNewCheckout(user: User): boolean {
  return unleash.isEnabled('rel-checkout-v2-2026-q4', {
    userId: user.id,
    properties: { tier: user.subscriptionTier, country: user.country },
  });
}
```

**Unleash 6** (2025-2026) trajo: environments oficiales, project scoping, custom activation strategies como código, service accounts para automation, personal access tokens, y el famoso `Unleash Edge` (proxy edge Rust para reducir latencia y bandwidth).

Ejemplo `Unleash Edge` deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: unleash-edge
  namespace: platform
spec:
  replicas: 3
  selector:
    matchLabels: { app: unleash-edge }
  template:
    metadata:
      labels: { app: unleash-edge }
    spec:
      containers:
        - name: edge
          image: unleashorg/unleash-edge:19.10.0
          args: ["edge"]
          env:
            - name: UPSTREAM_URL
              value: https://unleash.linguadev.internal/api
            - name: TOKENS
              valueFrom:
                secretKeyRef: { name: unleash-edge-tokens, key: tokens }
          ports: [{ containerPort: 3063 }]
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits:   { cpu: 500m, memory: 256Mi }
```

Las apps client-side apuntan a `unleash-edge.platform` en vez de al servidor central: latencia sub-ms, hasta 10x menos carga en el server principal.

### 3.4 GrowthBook (OSS warehouse-native)

Ventaja diferencial: para experimentation analysis, GrowthBook consulta directamente tu warehouse (Snowflake, BigQuery, Redshift, ClickHouse). No duplica eventos ni depende de que el SDK envíe telemetría.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: growthbook-config
data:
  datasource.yaml: |
    type: postgres
    host: warehouse.linguadev.internal
    database: analytics
    schema: events
    identifierTypes:
      - type: user_id
        query: SELECT user_id FROM users
    experiments:
      table: experiments_exposures
      timestampColumn: event_ts
      variantIdColumn: variation_id
```

SDK:

```typescript
import { GrowthBook } from '@growthbook/growthbook';

const gb = new GrowthBook({
  apiHost: 'https://growthbook.linguadev.internal',
  clientKey: process.env.GROWTHBOOK_KEY!,
  attributes: { id: user.id, country: user.country, tier: user.subscriptionTier },
});
await gb.init({ streaming: true });

const useNewCheckout = gb.getFeatureValue('rel-checkout-v2-2026-q4', false);
```

### 3.5 PostHog (product analytics + flags combinados)

PostHog 2026 combina flags con analytics en un solo producto. Si ya usás PostHog para eventos, añadir flags es 5 minutos:

```typescript
import { PostHog } from 'posthog-node';

const posthog = new PostHog(process.env.POSTHOG_KEY!, {
  host: 'https://us.i.posthog.com',
});

const useNewCheckout = await posthog.isFeatureEnabled(
  'rel-checkout-v2-2026-q4',
  user.id,
  { personProperties: { tier: user.subscriptionTier, country: user.country } }
);
```

Ventaja: cohort analysis nativo. "Muestrame conversion rate por variante" es un dashboard, no una consulta ad-hoc.

### 3.6 OpenFeature: el standard que evita vendor lock-in

**OpenFeature** (CNCF Incubating, v1.x GA en 2024, maduro en 2026) provee la API vendor-agnostic:

```typescript
import { OpenFeature } from '@openfeature/server-sdk';
import { LaunchDarklyProvider } from '@openfeature/launchdarkly-server-provider';

// Cambiar de vendor = cambiar solo el provider
await OpenFeature.setProviderAndWait(new LaunchDarklyProvider(process.env.LD_KEY!));
// await OpenFeature.setProviderAndWait(new UnleashProvider({...}));
// await OpenFeature.setProviderAndWait(new FlagsmithProvider({...}));

const client = OpenFeature.getClient();
const enabled = await client.getBooleanValue('rel-checkout-v2', false, { targetingKey: user.id });
```

En 2026 OpenFeature soporta providers para LaunchDarkly, Split, Unleash, Flagsmith, GrowthBook, ConfigCat, PostHog, Statsig, Harness, CloudBees. **Recomendación:** siempre codeá contra OpenFeature aunque hoy uses un vendor específico; migrar en el futuro será cambiar el provider, no todo el codebase.

---

## 4. Targeting rules avanzadas, gradual rollout y kill switches (nivel avanzado)

### 4.1 Percentage rollout determinístico

El SDK hashea `targetingKey + flag-name` con un algoritmo consistente (Murmur, xxHash). Con 25% de rollout, `user-id-123` cae siempre en el mismo bucket → siempre el mismo variant. Al subir a 50%, los users del 25% previo siguen viendo la misma variante + un 25% nuevo se une.

En Unleash configurás con `gradualRolloutUserId` strategy:

```json
{
  "name": "rel-checkout-v2-2026-q4",
  "strategies": [
    {
      "name": "gradualRolloutUserId",
      "parameters": { "percentage": "25", "groupId": "rel-checkout-v2" }
    }
  ]
}
```

En LaunchDarkly, la UI permite el "percentage rollout" directamente. En GrowthBook y PostHog similar.

### 4.2 Targeting rules complejas (LaunchDarkly ejemplo)

Escenario: activar `rel-checkout-v2` a:
- 100% de internal employees (email termina en `@linguadev.com`).
- 25% de external users en US.
- 5% de external users worldwide.
- Usuarios con `beta_user: true` en su perfil.

Rules (representación conceptual):

```yaml
targeting:
  rules:
    - description: internal employees
      clauses:
        - attribute: email
          op: endsWith
          values: ["@linguadev.com"]
      variation: on
    - description: US external users
      clauses:
        - attribute: country
          op: in
          values: ["US"]
        - attribute: email
          op: endsWith
          values: ["@linguadev.com"]
          negate: true
      variation: on
      rolloutPercentage: 25
    - description: beta users
      clauses:
        - attribute: betaUser
          op: equals
          values: [true]
      variation: on
  defaultRule:
    variation: on
    rolloutPercentage: 5
  fallthrough: off
```

Reglas evaluadas en orden. Primera que matchea gana.

### 4.3 Segments reutilizables

Un **segment** es una lista de users o condiciones que se referencia desde varios flags:

```yaml
segment:
  name: paying-premium-users
  clauses:
    - attribute: subscriptionTier
      op: in
      values: ["premium", "enterprise"]
    - attribute: subscriptionStatus
      op: equals
      values: ["active"]
    - attribute: mrr
      op: greaterThan
      values: [50]
```

Reutilizado desde 20 flags. Cambiar la definición del segment (agregar `subscriptionTier: "team"`) aplica a los 20 flags atomically.

### 4.4 Kill switch pattern

Un flag ops permanente que apaga una feature costosa bajo carga:

```typescript
export async function getRecommendations(user: User): Promise<Recommendation[]> {
  const client = OpenFeature.getClient();
  const enabled = await client.getBooleanValue('ops-recommendations-enabled', true, {
    targetingKey: user.id,
  });

  if (!enabled) {
    return getCachedFallbackRecommendations();
  }

  try {
    return await callRecommendationML(user);
  } catch (err) {
    logger.error('recommendations ML failed', err);
    return getCachedFallbackRecommendations();
  }
}
```

En incident con recommendation ML colapsado, SRE apaga el flag desde el dashboard: latencia baja instantáneamente, y todos los users ven cached results en lugar de errores.

**Reglas para kill switches:**
- **Default value = TRUE (feature ON)**: si el flag desaparece, la app sigue funcionando.
- **Documentar en runbook** qué hace el kill switch.
- **Testear en staging** que apagar el flag efectivamente cambia comportamiento.
- **Alertas conectadas**: cuando el flag se apaga, notificar en Slack automáticamente.
- **Auditoría**: log de quién apagó/prendió con timestamp.

### 4.5 Testing con flags

Tres estrategias combinadas:

**A) Unit tests con flag mock:**

```typescript
import { OpenFeature } from '@openfeature/server-sdk';
import { InMemoryProvider } from '@openfeature/in-memory-provider';

describe('renderCheckout', () => {
  beforeEach(async () => {
    await OpenFeature.setProviderAndWait(
      new InMemoryProvider({
        'rel-checkout-v2-2026-q4': {
          defaultVariant: 'on',
          variants: { on: true, off: false },
          disabled: false,
        },
      })
    );
  });

  it('renders v2 when flag is on', async () => {
    const res = await renderCheckout(mockUser);
    expect(res).toContain('CheckoutV2');
  });
});
```

**B) Integration tests con ambos paths:**

Correr la test suite dos veces, una con `flag=on` y otra con `flag=off`. En CI:

```yaml
strategy:
  matrix:
    flag_state: [on, off]
steps:
  - name: Run tests
    run: pnpm test
    env:
      FEATURE_REL_CHECKOUT_V2: ${{ matrix.flag_state }}
```

**C) E2E en staging con flag activado**: previo a lanzar a producción, staging tiene el flag ON al 100% durante 24-72h para catch bugs de integración con datos reales.

### 4.6 Flag debt: erradicación sistemática

Después de meses, el dashboard tiene 200 flags. La mitad no se sabe qué hacen. Anti-patrón. Estrategias 2026:

1. **Flag expiration reminders**: LaunchDarkly, Unleash, GrowthBook tienen "flag age" alerts. Un release toggle con más de 60 días dispara ticket automático.
2. **Code scanner**: `linter` custom o herramientas como [`piranha`](https://github.com/uber/piranha) (Uber OSS) detectan y eliminan código muerto de flags eliminados.
3. **Ownership obligatorio**: no se crea flag sin owner assigned. Cada semana un dashboard muestra flags sin actividad y quién los dueña.
4. **"Delete week" trimestral**: sprint dedicado a limpiar flags viejos. Genera changelog visible.
5. **Distinguir tipos en el naming**: `rel-`, `ops-`, `exp-`, `perm-` prefijos automatizan reglas de expiración.

En un LinguaDev-scale org (100 devs, 500 servicios): esperá 200-500 flags activos, con >70% ops/permission (long-lived) y <30% release (short-lived). Si los release toggles superan el 60% del total, tenés flag debt.

---

## 5. Ejemplo práctico: LinguaDev Pro checkout v2 con Unleash + Edge + OpenFeature

Rollout gradual del nuevo checkout: 0% → internal employees → 5% external → 25% US → 100%.

### Paso 1: crear flag en Unleash

Via API (para GitOps):

```bash
curl -X POST https://unleash.linguadev.internal/api/admin/projects/default/features \
  -H "Authorization: $UNLEASH_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "rel-checkout-v2-2026-q4",
    "description": "New checkout flow with reduced steps (Q4 2026 launch)",
    "type": "release",
    "impressionData": true
  }'

# Añadir strategies para el ambiente production
curl -X POST https://unleash.linguadev.internal/api/admin/projects/default/features/rel-checkout-v2-2026-q4/environments/production/strategies \
  -H "Authorization: $UNLEASH_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "userWithId",
    "parameters": { "userIds": "@linguadev.com" },
    "constraints": [
      { "contextName": "email", "operator": "STR_ENDS_WITH", "values": ["@linguadev.com"] }
    ]
  }'
```

### Paso 2: desplegar Unleash Edge cerca de las apps

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: unleash-edge
  namespace: platform
spec:
  replicas: 3
  selector: { matchLabels: { app: unleash-edge } }
  template:
    metadata: { labels: { app: unleash-edge } }
    spec:
      containers:
        - name: edge
          image: unleashorg/unleash-edge:19.10.0
          args: ["edge"]
          env:
            - name: UPSTREAM_URL
              value: https://unleash.linguadev.internal/api
            - name: TOKENS
              valueFrom:
                secretKeyRef: { name: unleash-edge-tokens, key: tokens }
          ports: [{ containerPort: 3063 }]
---
apiVersion: v1
kind: Service
metadata:
  name: unleash-edge
  namespace: platform
spec:
  selector: { app: unleash-edge }
  ports: [{ port: 80, targetPort: 3063 }]
```

### Paso 3: integrar OpenFeature + Unleash provider en la API

```typescript
// packages/api/src/flags.ts
import { OpenFeature, EvaluationContext } from '@openfeature/server-sdk';
import { UnleashProvider } from '@openfeature/unleash-provider';

let initialized = false;

export async function initFlags() {
  if (initialized) return;
  await OpenFeature.setProviderAndWait(
    new UnleashProvider({
      url: process.env.UNLEASH_EDGE_URL!,  // apunta a unleash-edge, no al server
      clientKey: process.env.UNLEASH_CLIENT_TOKEN!,
      appName: 'linguadev-api',
      environment: process.env.NODE_ENV || 'development',
      refreshInterval: 15,
    })
  );
  initialized = true;
}

export async function getBooleanFlag(
  key: string,
  defaultValue: boolean,
  ctx: EvaluationContext
): Promise<boolean> {
  const client = OpenFeature.getClient();
  return client.getBooleanValue(key, defaultValue, ctx);
}

// packages/api/src/routes/checkout.ts
import { getBooleanFlag } from '../flags';

router.get('/checkout', async (req, res) => {
  const useV2 = await getBooleanFlag('rel-checkout-v2-2026-q4', false, {
    targetingKey: req.user.id,
    email: req.user.email,
    country: req.user.country,
    tier: req.user.subscriptionTier,
  });

  if (useV2) {
    return renderCheckoutV2(req, res);
  }
  return renderCheckoutV1(req, res);
});
```

### Paso 4: rollout gradual desde el dashboard

Progresión típica:

1. **Semana 1**: 100% internal employees (`email STR_ENDS_WITH "@linguadev.com"`). Bug bash interno.
2. **Semana 2**: internal + 5% external worldwide (`gradualRolloutUserId percentage=5`). Métricas: conversion rate v1 vs v2.
3. **Semana 3**: + 25% en US. Segmentación por país.
4. **Semana 4**: 50% global.
5. **Semana 5**: 100%.
6. **Semana 6+**: **eliminar el flag** del código y del dashboard.

### Paso 5: métricas de exposición y experimentación

Unleash con `impressionData: true` emite un evento cada vez que se evalúa el flag:

```typescript
unleash.on('impression', (event) => {
  analytics.track('feature-flag-evaluated', {
    flag: event.featureName,
    variant: event.variant,
    userId: event.context.userId,
    country: event.context.properties?.country,
    result: event.enabled,
  });
});
```

En GrowthBook/PostHog: la instrumentación viene built-in. Se cruza en el warehouse con eventos de business (`orders_completed`, `revenue`) para calcular conversion rate por variante.

### Paso 6: kill switch bonus

Añadir flag ops-checkout-v2-kill que fuerza fallback a v1 incluso si el release toggle está ON. Para incidents:

```typescript
const killSwitch = await getBooleanFlag('ops-checkout-v2-kill', false, ctx);
const useV2 = !killSwitch && (await getBooleanFlag('rel-checkout-v2-2026-q4', false, ctx));
```

Kill switch OFF por default; en incident SRE lo prende y todos los users vuelven a v1 sin redeploy.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Deploy y release son eventos distintos**. Los flags implementan la separación.
- ✅ Codeá contra **OpenFeature** para evitar vendor lock-in.
- ✅ Naming prefixado por tipo: `rel-`, `ops-`, `exp-`, `perm-`.
- ✅ Owner y fecha de eliminación obligatorios al crear un flag.
- ✅ **Default value** siempre explícito (no `null` ni `undefined`).
- ✅ `targetingKey` = `user.id` estable, no email ni session.
- ✅ Kill switches con default `TRUE` (feature ON, apagable en incident).
- ✅ Percentage rollout determinístico (mismo user → mismo bucket).
- ✅ Segments reutilizables para lógica repetida.
- ✅ **Sunset policy** para release toggles: eliminá tras rollout completo.
- ✅ Unleash Edge / LaunchDarkly Relay para reducir latencia y bandwidth.
- ✅ Testing en CI con matrix `flag=on` y `flag=off`.
- ✅ Impression data → warehouse para experiment analysis.
- ✅ Dashboard con "flag age" alerts (>60 días = ticket automático).
- ✅ Auditoría de cambios: quién, cuándo, por qué.
- ✅ Client-side SDK recibe evaluación, no ruleset.
- ✅ Piranha (Uber) o linters custom para code cleanup post-flag-removal.

### Anti-patrones

- ❌ `if (process.env.NEW_CHECKOUT === "true")` como "sistema de flags".
- ❌ Un solo namespace de flags sin prefixes ni tipos.
- ❌ Flag sin owner asignado.
- ❌ Release toggles de 2 años (flag debt).
- ❌ SDK sin default value → cold start hace caer producción.
- ❌ Chequear flag en un loop hot sin cachear por request.
- ❌ Client SDK descargando ruleset entero (exposición de reglas sensibles).
- ❌ Kill switch con default OFF (si el flag muere, la feature muere).
- ❌ Rollout con `Math.random()` (cada request bucket distinto, no estable).
- ❌ Testing solo un path del flag.
- ❌ Cambiar el `targetingKey` mid-experiment (invalida cohorts).
- ❌ Mezclar experiment analysis en el mismo servicio de flags sin warehouse-native tool.

### Tabla decisión "qué platform"

| Situación | Recomendación |
|---|---|
| Enterprise, budget alto, integraciones SSO/RBAC/audit | LaunchDarkly |
| OSS, self-host mandatory (data residency, on-prem) | Unleash 6.x |
| Ya tenés warehouse, querés experiments nativos | GrowthBook |
| Ya tenés PostHog para analytics | PostHog Feature Flags |
| Pequeño equipo, budget bajo, sencillez | ConfigCat |
| Product-led growth, experimentation focused | Split o Statsig |
| Ya usás Harness CI | Harness Feature Flags |
| Necesitás segments + remote config OSS | Flagsmith |

---

## 7. Casos reales industria 2023-2026

**Facebook / Meta (Gatekeeper, desde 2000s):** Facebook creó el pattern moderno de feature flags con Gatekeeper. Todo cambio de producto va detrás de un flag. Rollout típico: 1%, 10%, 50%, 100% con métricas por cohort. **Lección:** la escala solo es viable con flags como plataforma central.

**Google (Experiments framework):** Google decide qué ver en Google Search / Google News mediante miles de experiments simultáneos. Statistical rigor con guardrails. **Lección:** experimentation platform > A/B test tool.

**Netflix:** cada suggestion en el home es resultado de flags + experiments. Estilo Kayenta (cap 33) + heavy flags. **Lección:** progressive delivery + experimentation son la misma disciplina.

**GitHub (flags como práctica cultural):** GitHub tiene playbook público sobre gradual rollout. Prácticamente cada feature pasa por dogfooding → staff → open beta → GA. **Lección:** la disciplina de flags es cultural, no solo técnica.

**LaunchDarkly (customer stories 2024-2026):** Microsoft, Atlassian, IBM, IEEE reportan reducción de deploy incidents del 40-70% después de estandarizar flags. **Lección:** el ROI es medible en MTTR y en velocity.

**Airbnb (Feature Flag Framework interno + migración a Split):** Airbnb inicialmente construyó "Trebuchet" internamente, luego migraron a Split.io por experimentation rigor. Blog posts públicos documentan el trade-off. **Lección:** build vs buy en flags dependía en 2019; en 2026 buy es default sensato (OSS o SaaS).

**GitLab (Unleash self-host):** GitLab.com corre Unleash self-host para sus flags. Flags versionados en git, deploys via GitOps. **Lección:** OSS self-host es viable si tenés ops maturity.

**Notion + Statsig (2024):** Notion adoptó Statsig por experimentation focus. Blog post detalla ROI en velocity. **Lección:** experimentation-first tools están ganando cuota vs flags-only.

**Uber Piranha (2019, sigue vivo 2026):** Uber open-sourceó Piranha para automated flag cleanup en Java/Kotlin/Swift/JavaScript. Elimina código muerto post-flag-removal automáticamente. **Lección:** flag debt es problema real, y hay tooling maduro para resolverlo.

**GrowthBook adoption (2023-2026):** empresas como Zapier, Cypress, Notion Data, adoptaron GrowthBook por warehouse-native experiments. Data teams no quieren duplicar eventos en un vendor. **Lección:** warehouse-native es la tendencia 2026 para experimentation.

**OpenFeature standardización (2023-2026):** industria empujando fuerte OpenFeature (Dynatrace, Red Hat, Snyk, IBM, GO Feature Flag). En 2026 la mayoría de flag platforms tiene provider oficial. **Lección:** codeá contra OpenFeature; el switching cost será menor cuando necesites cambiar vendor.

**Post-mortem clásico: flag olvidado causa outage.** Documentado en múltiples empresas 2020-2024: un flag ops apagado en un incident pasado, olvidado en estado OFF, causa que meses después una feature nueva no funcione porque asume ese flag ON. **Lección:** los flags ops necesitan revisión periódica igual que las alertas.

---

## 8. Ejercicios prácticos

### Ejercicio 1: setup Unleash self-hosted + primer flag

**Objetivo:** correr Unleash, crear un flag booleano, evaluar desde un script Node.

**Setup:** Docker instalado, Node 20+.

**Pasos:**
1. Correr Unleash 6.x + Postgres con Docker Compose.
2. Login (admin/unleash4all) y crear proyecto `linguadev`.
3. Crear flag `rel-hello-world` de tipo `release`.
4. Añadir strategy `default` en environment `development`.
5. Generar API token (client).
6. Script Node `npm i unleash-client` que evalúa el flag e imprime resultado.
7. Toggle desde la UI y ver el cambio en 15s.

**Criterios de éxito:**
- [ ] Unleash UI accessible en `localhost:4242`.
- [ ] Flag creado con owner y descripción.
- [ ] Script evalúa `true`/`false` según toggle.
- [ ] Cambio en UI se refleja en <15s en el script.

**Bonus:** añadir strategy `gradualRolloutUserId` al 30% y correr el script con 100 userIds para verificar que ~30% da true.

---

### Ejercicio 2: OpenFeature + Unleash provider en API real

**Objetivo:** integrar OpenFeature en la API de LinguaDev Pro con Unleash como provider.

**Setup:** repo linguadev-pro clonado, Unleash corriendo.

**Pasos:**
1. `pnpm add @openfeature/server-sdk @openfeature/unleash-provider` en `packages/api`.
2. Crear `src/flags.ts` con `initFlags()` y `getBooleanFlag()`.
3. Añadir el flag a una ruta existente (`/checkout` u otra).
4. Levantar API con env vars.
5. Hacer requests con diferentes usuarios y verificar comportamiento.
6. Verificar en el dashboard de Unleash que aparecen impressions.

**Criterios de éxito:**
- [ ] `initFlags()` termina sin errores.
- [ ] Requests con user con `email @linguadev.com` obtienen `true`.
- [ ] Requests con user external obtienen `false` (o según strategy).
- [ ] Impressions visibles en Unleash dashboard.

**Bonus:** cambiar el provider a LaunchDarkly (o GrowthBook) sin tocar la lógica de negocio.

---

### Ejercicio 3: percentage rollout determinístico

**Objetivo:** verificar que el mismo user siempre cae en el mismo bucket cuando cambias el %.

**Setup:** Unleash con flag `exp-checkout-color` strategy `gradualRolloutUserId percentage=25`.

**Pasos:**
1. Script Node que evalúa el flag para 1000 userIds fijos (1..1000).
2. Contar cuántos dan `true`.
3. Cambiar a `percentage=50` en la UI.
4. Reejecutar. Ver cuántos dan `true`.
5. **Verificar que los users que daban `true` al 25% siguen dando `true` al 50%.**

**Criterios de éxito:**
- [ ] ~250 users true al 25%.
- [ ] ~500 users true al 50%.
- [ ] 100% de los users del primer set siguen en el segundo set (superset).

**Bonus:** verificar con `Math.random()` que no es determinístico y por qué es antipatrón.

---

### Ejercicio 4: kill switch con OpenFeature + fallback

**Objetivo:** implementar `ops-recommendations-enabled` con default TRUE y fallback cached en caso OFF.

**Setup:** API con endpoint `/recommendations` que llama a un ML mock.

**Pasos:**
1. Crear flag `ops-recommendations-enabled` tipo `ops` en Unleash, ON por default.
2. Modificar `/recommendations` para consultar el flag; si OFF, devolver cache.
3. Correr requests durante 30s con carga (`hey -z 30s ...`).
4. Apagar el flag desde la UI.
5. Verificar que en <15s todas las requests devuelven cache.
6. Volver a prender. Verificar retorno a ML.

**Criterios de éxito:**
- [ ] Con flag ON: llama ML.
- [ ] Con flag OFF: devuelve cache.
- [ ] Transición en <15s.
- [ ] Sin errores/500 durante la transición.
- [ ] Log muestra la fuente (`ml` o `cache`) por request.

**Bonus:** añadir métrica Prometheus `recommendations_source_total{source="cache|ml"}` para observabilidad.

---

### Ejercicio 5 (bonus): flag debt cleanup con Piranha

**Objetivo:** eliminar código muerto de un flag "release" que ya se lanzó al 100%.

**Setup:** codebase con `if (getBooleanFlag('rel-x', false, ...)) { newPath() } else { oldPath() }` en 5 lugares.

**Pasos:**
1. Instalar Piranha (o script equivalente para tu lenguaje).
2. Configurar la regla: flag `rel-x` treated as `true`.
3. Ejecutar Piranha sobre el codebase.
4. Verificar que:
   - Los `if` fueron eliminados.
   - `newPath()` quedó como código principal.
   - `oldPath()` fue eliminado si no se usa en otro lado.
5. Correr tests para verificar que no rompió nada.
6. Eliminar el flag del dashboard Unleash.

**Criterios de éxito:**
- [ ] 5 llamadas al flag eliminadas.
- [ ] Código simplificado.
- [ ] Tests pasan.
- [ ] Flag eliminado del dashboard.
- [ ] Commit describe el cleanup.

**Bonus:** medir la reducción de complejidad ciclomática con SonarQube antes/después.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [openfeature.dev](https://openfeature.dev) — spec v1.x + providers.
- [docs.getunleash.io](https://docs.getunleash.io) — Unleash 6.x.
- [docs.launchdarkly.com](https://docs.launchdarkly.com) — LaunchDarkly SDK y arquitectura.
- [docs.growthbook.io](https://docs.growthbook.io) — GrowthBook + warehouse.
- [posthog.com/docs/feature-flags](https://posthog.com/docs/feature-flags) — PostHog flags.
- [flagsmith.com/docs](https://docs.flagsmith.com) — Flagsmith OSS.

**Referencias fundacionales:**
- Pete Hodgson, "Feature Toggles" en [martinfowler.com](https://martinfowler.com/articles/feature-toggles.html) (2017, sigue siendo la referencia).
- James Governor (RedMonk), "Towards Progressive Delivery" (2018).

**Herramientas complementarias:**
- **Piranha** (Uber, OSS) — automated flag cleanup.
- **OpenFeature Operator** (K8s) — sidecar pattern.
- **flagd** (OpenFeature reference implementation) — daemon local.
- **launchdarkly-relay-proxy** — edge caching enterprise.
- **unleash-edge** — Rust edge proxy para Unleash.

**Referencias adicionales:**
- Adam Zimman, "*Feature Flag Best Practices*" (O'Reilly report, gratuito).
- KubeCon EU/NA 2024-2025 sessions sobre OpenFeature.
- Split.io "*The Definitive Guide to Feature Management*".

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Auditá tus "flags actuales": ¿tienen owner? ¿tipo? ¿fecha de expiración?
- Migrá 1 servicio a OpenFeature (elegí provider según context).
- Documentá kill switches en runbook con instrucciones para SRE de guardia.
- Continuá con [cap 35 — Database migrations zero-downtime](./35-database-migrations-zero-downtime.md) que aborda el otro gran bloqueo de progressive delivery: los cambios de schema.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales sobre feature flags a escala. Cubren: definición y taxonomía (release/ops/experiment/permission), LaunchDarkly arquitectura y SDK, comparación de vendors (Unleash, GrowthBook, PostHog, ConfigCat, Statsig, Flagsmith), targeting rules complejas, segments reutilizables, percentage rollout determinístico, kill switches, testing con flags, OpenFeature standard y providers, client vs server-side SDK, flag debt y lifecycle, Unleash Edge / LaunchDarkly Relay, experimentation warehouse-native.

- **Fuente:** [`packages/content/src/tech/devops/sim-34-feature-flags-at-scale.json`](../../packages/content/src/tech/devops/sim-34-feature-flags-at-scale.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-34-feature-flags-at-scale`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 33 — Progressive Delivery: Flagger y Argo Rollouts](./33-progressive-delivery-flagger-argo-rollouts.md) · [Índice](./README.md) · [Capítulo 35 — Database Migrations Zero-Downtime →](./35-database-migrations-zero-downtime.md)
