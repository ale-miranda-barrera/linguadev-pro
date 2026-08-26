# Capítulo 02 — Fundamentos de Continuous Delivery

> **Focus:** Las tres "C" que todos confunden (CI, CD-Delivery, CD-Deployment), pipeline stages con principio *fail fast*, artefactos inmutables + build-once-deploy-many, environment parity, trunk-based vs GitFlow, feature flags para desacoplar deploy de release, rollback vs roll-forward, canary/blue-green/rolling, y por qué la pirámide de tests es la base de todo.
> **Áreas:** VCS + CI · Deployment · Prácticas de release
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Haber leído [Cap 01 — Cultura DevOps y DORA](./01-cultura-devops-y-dora.md).
- Familiaridad básica con Git (branches, merges, PRs).
- Nociones de qué es Docker/una imagen de contenedor (aunque sea nivel introductorio).
- Alguna experiencia con al menos un servicio CI (Jenkins, GitHub Actions, GitLab CI, CircleCI).
- Conocer la diferencia entre unit test, integration test y E2E test.

**Glosario mínimo:**
- **Continuous Integration (CI)**: práctica de mergear cambios a la rama principal varias veces al día, con build + test automáticos en cada merge. Foco: *integrar* frecuentemente.
- **Continuous Delivery (CD1)**: cada cambio que pasa CI está SIEMPRE listo para producción; el push final es manual (aprobación humana).
- **Continuous Deployment (CD2)**: cada cambio que pasa CI se despliega AUTOMÁTICAMENTE a producción sin intervención humana.
- **Deployment pipeline**: cadena automatizada de stages (build → test → deploy) que un cambio recorre desde commit hasta producción.
- **Artefacto**: binario/imagen inmutable producto de un build (jar, docker image, zip). Regla de oro: build-once, deploy-many.
- **Environment parity**: staging debe ser tan parecida a producción como sea económicamente viable (mismo runtime, mismo config, datos comparables).
- **Feature flag**: mecanismo runtime para activar/desactivar código sin redeploy. Permite desacoplar deploy (código en prod) de release (feature visible a usuarios).
- **Trunk-based development (TBD)**: todos los devs commitean a una única rama principal (`main`/`trunk`), con branches cortas (<2 días).
- **Rollback**: revertir a la versión previa cuando algo falla. Estrategia "hacia atrás".
- **Roll-forward**: desplegar un fix hacia adelante en lugar de revertir. Estrategia "hacia adelante".
- **Blue-green deployment**: dos environments idénticos (blue = prod actual, green = nueva versión); cutover instantáneo.
- **Canary deployment**: rollout gradual a un pequeño % del tráfico (5% → 25% → 50% → 100%) con análisis automático de métricas.

**Setup mínimo (2026):**

```bash
# Verificar herramientas base
git --version                 # 2.47+
docker --version              # 27+
gh --version                  # GitHub CLI 2.60+ (para GHA local testing)

# Instalar herramientas de test rápidas
npm i -g @playwright/test     # E2E moderno
pipx install pytest-xdist     # tests en paralelo Python

# Simular pipeline localmente con act (ejecuta GHA workflows en Docker)
brew install act              # macOS
# En Windows: choco install act-cli

# Herramientas de feature flags
npm i @openfeature/server-sdk # estándar CNCF
npm i unleash-client          # Unleash open-source
```

En 2026 el estándar CNCF para feature flags es **OpenFeature** (graduated a CNCF Incubating en 2023, camino a Graduated). Todos los vendors (LaunchDarkly, Split, Unleash, GrowthBook, Flagd) exponen SDKs compatibles con OpenFeature.

---

## 1. El gran cuadro

Continuous Delivery es la disciplina técnica que permite lo que la cultura DevOps predica: que un cambio pueda ir desde `git commit` hasta producción con seguridad, rapidez y sin drama humano. Jez Humble y David Farley formalizaron el término en el libro *Continuous Delivery* (2010), definiéndolo como *"la capacidad de llevar cambios de todo tipo — features, cambios de configuración, bug fixes, experimentos — a producción, o a manos de usuarios, de forma segura y rápida y sustentable"*. La palabra clave es **sustentable**: no es "cómo hacer un deploy heroico exitoso", es "cómo hacer que cualquier deploy sea aburrido, siempre".

La confusión más común es entre las tres "C": Continuous Integration, Continuous Delivery y Continuous Deployment. CI es sobre **integración frecuente** (todos merger a `main` varias veces al día), CD-Delivery es sobre **estar siempre listo para desplegar** (aunque el botón lo aprieta un humano), y CD-Deployment es sobre **desplegar automáticamente sin humano** cuando CI pasa verde. Cada nivel requiere el anterior: no puedes tener CD1 sin CI robusto, y CD2 sin CD1 + observability + auto-rollback es suicidio. La mayoría de equipos deberían apuntar a **CD1 sólido** antes de aspirar a CD2. Amazon y Netflix hacen CD2 en muchos servicios; empresas reguladas (banca, salud) frecuentemente se quedan en CD1 por compliance, y está bien.

El segundo pilar del capítulo es el **deployment pipeline como código**. La idea, popularizada por Humble/Farley (2010) y madurada con GitHub Actions, GitLab CI, Jenkinsfile y Tekton, es que el pipeline se define en YAML/DSL versionado en el repo junto al código, no en clicks de UI. Beneficios: versionable, revisable en PRs, reproducible, mismo pipeline en fork/clone. La secuencia canónica de stages sigue el principio **fail fast**: lint (segundos) → unit tests (minutos) → build → integration tests (5-10 min) → security scans → E2E (10-30 min) → deploy. Cosas rápidas y baratas primero. Cuando algo falla, obtienes feedback en el minuto correcto, no en la media hora incorrecta.

El tercer pilar es el conjunto de patrones que permiten **desacoplar el riesgo del deploy** del cambio de comportamiento visible: feature flags (deploy y release son cosas distintas), canary deployments (rollout gradual con abort automático), blue-green (cutover instantáneo con posibilidad de "regreso"), y rollback vs roll-forward como estrategias complementarias. Con estos patrones, deployar código roto no es un desastre; es un evento auto-contenido que se detecta en minutos y se revierte en segundos. Al final del capítulo tendrás un modelo mental claro de cómo diseñar tu pipeline de commit-a-prod, con vocabulario preciso para discutir trade-offs con seniors, arquitectos y auditores.

---

## 2. Fundamentos (nivel básico)

### 2.1 Las tres "C": CI vs CD vs CD

Distinción precisa (fuente: Humble & Farley 2010, canonizada por Martin Fowler):

| Práctica | Qué implica | Prueba de que la haces |
|----------|-------------|------------------------|
| **CI** — Continuous Integration | Devs mergean a `main` **varias veces al día**; cada merge dispara build + tests automáticos; `main` está SIEMPRE verde. | `main` no está roto >10 min típicamente; nadie tiene branch >48h. |
| **CD1** — Continuous Delivery | Cada cambio que pasa CI produce un artefacto **desplegable a producción en cualquier momento**. El push a prod es manual (botón). | Cualquier commit reciente puede ir a prod con 1 click, sin trabajo adicional. |
| **CD2** — Continuous Deployment | Cada cambio que pasa CI se despliega a producción **automáticamente**, sin humano. | El pipeline llega a prod sin aprobación manual. |

Errores comunes:
- ❌ "Tenemos CI/CD porque usamos GitHub Actions" — GHA es una herramienta; CI/CD es una práctica.
- ❌ "CI y CD son sinónimos" — CI se enfoca en INTEGRACIÓN; CD en DELIVERY/DEPLOYMENT.
- ❌ "CD siempre significa Deployment" — en la mayoría de contextos enterprise significa Delivery.
- ❌ "Hacemos CI porque el pipeline corre en cada PR" — CI requiere merge frecuente a `main`, no correr tests en branches largas.

### 2.2 Pipeline stages canónicos con fail fast

Un pipeline moderno sigue un orden dictado por *cost × probability of failure*:

```
1. Checkout code                    [segundos]
2. Install deps + cache             [10-30s con cache]
3. Lint + format check              [segundos]
4. Static analysis / type check     [10-60s]
5. Unit tests                       [1-3 min]
6. Build artifact (binary/image)    [1-5 min]
7. Integration tests                [3-10 min]
8. Security scans (SAST + SCA)      [2-5 min]
9. Push artifact to registry        [1 min]
10. Deploy to staging               [1-2 min]
11. Smoke tests / E2E               [5-20 min]
12. Deploy to production            [1-2 min]
13. Post-deploy validation          [5-10 min]
```

**Principio fail fast**: si el linter falla en 5s, no gastes 15 min en E2E. Los stages baratos van primero. Los stages caros solo corren si los baratos pasan.

**Ejemplo mínimo GitHub Actions:**

```yaml
name: CI/CD
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm type-check
      - run: pnpm test:unit
      - run: pnpm build
      - run: pnpm test:integration
      - uses: aquasecurity/trivy-action@0.24.0
        with: { scan-type: fs, ignore-unfixed: true }
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
```

### 2.3 Pipeline as Code: el principio fundacional

Antes (dark ages): pipelines definidos en Jenkins UI, click-based. Problemas: no versionable, no code-reviewable, imposible replicar en dev/fork, "quien lo hizo se fue".

Ahora: pipeline definido en el mismo repo, junto al código:

- **GitHub Actions**: `.github/workflows/*.yml`
- **GitLab CI**: `.gitlab-ci.yml`
- **Jenkins**: `Jenkinsfile` (Groovy)
- **CircleCI**: `.circleci/config.yml`
- **Tekton**: CRDs Kubernetes `Task` y `Pipeline`

Beneficios:
- ✅ Versionable (git blame para ver quién cambió el pipeline).
- ✅ Reviewable en PRs (cambios al pipeline pasan el mismo scrutiny que código).
- ✅ Reproducible (fork del repo = pipeline funcional).
- ✅ Testeable localmente (`act` para GHA, `gitlab-runner exec` para GitLab).

### 2.4 Ejemplo mínimo: contrato "build-once, deploy-many"

Un patrón que separa buenos pipelines de malos: el **mismo artefacto** promociona de dev → staging → prod. Nunca se recompila. La configuración por environment se inyecta en runtime (env vars, ConfigMap, secrets).

```yaml
# Bad: se compila para cada environment (diferentes artefactos)
build-dev:
  script: docker build -t app:dev .
build-staging:
  script: docker build -t app:staging .
build-prod:
  script: docker build -t app:prod .

# Good: build once, deploy many
build:
  script:
    - docker build -t app:${{ github.sha }} .
    - docker push registry/app:${{ github.sha }}

deploy-dev:
  script: kubectl set image deploy/app app=registry/app:${{ github.sha }}
deploy-staging:
  script: kubectl set image deploy/app app=registry/app:${{ github.sha }}
deploy-prod:
  script: kubectl set image deploy/app app=registry/app:${{ github.sha }}
```

El artefacto que probaste en staging es EXACTAMENTE el que va a prod. Cero sorpresas por "compilación distinta".

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 La test pyramid: la base económica del CI

Mike Cohn (2009) formalizó la **test pyramid**:

```
              /\
             /  \
            / E2E\           pocos (5-20)
           /------\          lentos (min/test)
          / Integ  \         frágiles
         /----------\
        /            \
       /  Unit tests  \      muchos (1000s)
      /                \     rápidos (ms/test)
     /------------------\    aislados
```

Justificación económica:
- Unit test: <10ms, 100% deterministic, 100 tests = 1s.
- Integration test: 100-1000ms, requiere DB/Redis/service, 100 tests = 1-2 min.
- E2E test: 5-30s, requiere stack completo + browser, 20 tests = 10-15 min.

Antipatrón "ice cream cone": muchos E2E, pocos unit tests. Costo total de CI se dispara, feedback loop lento, tests frágiles (flaky). Muy común en 2010-2015; ahora considerado deuda técnica.

**Test doubles:** para aislar unit tests, se usan:
- **Stub**: retorna valor pre-programado.
- **Mock**: verifica que un método fue llamado con args esperados.
- **Fake**: implementación simplificada (ej: SQLite en vez de Postgres).
- **Spy**: envoltorio que registra llamadas para inspección.

### 3.2 Artifact management: el registro es la fuente de verdad

Un pipeline maduro produce **artefactos inmutables** en un registro central:

| Tipo | Registro | Ejemplos |
|------|----------|----------|
| Docker images | OCI registry | Docker Hub, GHCR, ECR, GCR, Harbor, JFrog |
| Java JARs | Maven repo | Nexus, Artifactory, Maven Central |
| npm packages | npm registry | npmjs.com, GitHub Packages |
| Python wheels | PyPI-compat | PyPI, DevPI, Artifactory |
| Binaries | Generic | S3, GCS, Artifactory generic |

Reglas:
- ✅ Cada build produce un artefacto con **tag inmutable** (ej: SHA de commit, versión semver).
- ✅ **Nunca** sobrescribas un tag existente. Si necesitas "moving tag" (`latest`, `stable`), es alias, no reemplazo.
- ✅ Retention policy: staging artifacts 30 días, prod artifacts 1-2 años.
- ✅ Firmar artefactos con cosign/Sigstore (supply chain security).

**Ejemplo Docker + GHCR:**

```yaml
- name: Login GHCR
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- name: Build & push (inmutable tag + moving tag)
  uses: docker/build-push-action@v6
  with:
    context: .
    push: true
    tags: |
      ghcr.io/linguadev/api:${{ github.sha }}
      ghcr.io/linguadev/api:main-latest
    provenance: true     # SLSA v1 attestation (2024+)
    sbom: true           # genera SBOM automáticamente
```

### 3.3 Environment parity: el principio 12-factor #10

El *12-factor app* (Heroku, 2011) postula: **staging debe ser tan cercana a producción como sea económicamente viable**. Divergencias comunes que rompen esto:

| Divergencia | Riesgo | Mitigación |
|-------------|--------|------------|
| Staging usa SQLite; prod usa Postgres | Bug del driver aparece en prod | Mismo Postgres en ambos, docker-compose o Testcontainers |
| Staging con 1 réplica; prod con 20 | Bug de concurrencia no aparece en staging | Staging con ≥2 réplicas mínimo |
| Staging con datos sintéticos triviales; prod con 10M rows | Query lenta descubre en prod | Staging con snapshot anonimizado de prod (masked PII) |
| Staging sin CDN; prod con CDN | Cache issues invisibles | Staging con misma cadena de red |
| Staging deploya distinto que prod | Config drift | Mismos scripts/Helm charts, solo values distintos |

**Herramientas modernas para reducir el gap:**
- **Testcontainers** (2024+): spinning containers reales en tests (Postgres, Kafka, Redis) en lugar de mocks.
- **LocalStack**: emula AWS localmente.
- **Ephemeral environments**: cada PR obtiene un environment temporal (Vercel Preview Deployments, Argo Rollouts, Namespace-per-PR en K8s).

### 3.4 Feature flags: desacoplar deploy de release

**Insight fundamental**: deployar código a producción y hacer ese código VISIBLE a usuarios son dos cosas distintas. Los feature flags permiten:

1. Deployar código en cualquier momento con la feature OFF.
2. Activar la feature para 1% de usuarios (canary).
3. Activar para 25% si métricas OK.
4. Activar para 100%.
5. Si algo falla en cualquier paso: desactivar el flag en segundos (no rollback de deploy).

**Taxonomía de flags** (Pete Hodgson, 2017):

| Tipo | Vida | Ejemplo |
|------|------|---------|
| **Release** | corta (días-semanas) | "Nueva UI del dashboard" |
| **Ops** | media (meses) | "Circuit breaker a Stripe" |
| **Experiment** | corta (días) | A/B test de copy |
| **Permission** | larga (permanente) | Feature enterprise vs free |

**Ejemplo con OpenFeature (estándar CNCF):**

```typescript
import { OpenFeature, EvaluationContext } from '@openfeature/server-sdk';
import { UnleashProvider } from '@openfeature/unleash-provider';

OpenFeature.setProvider(new UnleashProvider({
  url: process.env.UNLEASH_URL,
  appName: 'linguadev-api',
}));

const client = OpenFeature.getClient();

async function getUserPlan(userId: string) {
  const ctx: EvaluationContext = {
    targetingKey: userId,
    country: await getUserCountry(userId),
  };

  const useNewAlgo = await client.getBooleanValue(
    'new-scoring-algorithm',
    false,           // default si el proveedor falla
    ctx,
  );

  return useNewAlgo ? scoreV2(userId) : scoreV1(userId);
}
```

**Trade-off**: feature flags añaden complejidad (2 code paths simultáneos, deuda si no se limpian). Regla: cada flag debe tener owner + fecha de eliminación. Flag debt es real.

### 3.5 Trunk-based development vs GitFlow

**GitFlow** (Vincent Driessen, 2010): ramas de largo plazo `develop`, `release/*`, `hotfix/*`, `feature/*`. Diseñado para software con releases versionadas (desktop, mobile app stores).

**Trunk-based development** (TBD): una sola rama de largo plazo (`main`). Feature branches vivan <2 días. Cambios incompletos van detrás de feature flags.

Estado 2026:
- Elite performers según DORA usan TBD ~80% del tiempo.
- GitFlow persiste en: shrink-wrapped software, mobile apps con release cadence lenta, industrias muy reguladas.
- SaaS moderno usa TBD casi universalmente.

Diagrama comparativo:

```
GitFlow:                              Trunk-based:
                                      
main    ●───────────●────●            main ●──●──●──●──●──●──●──●
         \         /    /                   \  \    \    \
develop   ●──●──●─●──●──●─●                  ●  ●    ●    ●     (features
           \  \  \   /                                            <2 días)
feat1       ●──●─●
feat2          ●─●
release/1.0        ●──●
hotfix/1.0.1        ●──●
```

TBD requiere: CI robusto, tests confiables, feature flags. GitFlow tolera menos madurez técnica a cambio de más overhead ceremonial.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Rollback vs roll-forward: cuándo cada uno

**Rollback**: revertir al artefacto/deployment previo. Rápido (segundos si automatizado). Requiere que la nueva versión no haya hecho cambios irreversibles (migraciones DB expansivas, mensajes enviados).

**Roll-forward**: desplegar un fix hacia adelante. Más lento (minutos). Necesario cuando:
- Migración DB ya expandió schema (rollback dejaría el schema inconsistente).
- Mensajes ya se enviaron a un broker externo.
- La versión previa tiene un bug crítico distinto.

**Regla de oro** (Fowler): rollback es la opción default cuando es posible. Roll-forward requiere disciplina de tener CI ultra-rápido (fix + build + deploy <15 min).

**Compatibilidad de schema (expand-contract pattern)**: para hacer rollback seguro, cada migración debe ser:
1. **Expand**: añadir columna nueva, mantener la vieja (backward compatible).
2. Deploy código que escribe en ambas y lee de la nueva.
3. Backfill datos viejos → nueva columna.
4. Deploy código que solo usa la nueva.
5. **Contract**: eliminar columna vieja.

Esto garantiza que en cualquier momento puedes hacer rollback a la versión anterior sin romper el schema.

### 4.2 Blue-green vs Canary vs Rolling: trade-offs

| Estrategia | Cost | Risk | Speed | Cuándo usar |
|-----------|------|------|-------|-------------|
| **Blue-Green** | Alto (2x infra) | Bajo | Instantáneo cutover | Cuando puedes duplicar; DBs stateless. Fintech, healthcare. |
| **Canary** | Bajo (5% extra) | Muy bajo | 15-60 min gradual | Servicios de alto tráfico con observability madura. Netflix, Uber. |
| **Rolling** | Ninguno | Medio | Minutos | Default de Kubernetes. Servicios stateless con probes bien configurados. |
| **Recreate** | Ninguno | Alto (downtime) | Segundos | Batch/cron, servicios internos con downtime tolerable. |
| **Shadow** | Alto (2x compute) | Cero | N/A (no sirve tráfico) | Validar refactors mayores enviando tráfico real duplicado a nueva versión. |

**Ejemplo canary con Argo Rollouts:**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api
spec:
  replicas: 20
  strategy:
    canary:
      steps:
      - setWeight: 5             # 5% del tráfico a canary
      - pause: {duration: 5m}    # espera 5 min
      - analysis:                # promotion criteria
          templates:
          - templateName: error-rate-check
      - setWeight: 25
      - pause: {duration: 10m}
      - analysis:
          templates:
          - templateName: error-rate-check
          - templateName: latency-check
      - setWeight: 50
      - pause: {duration: 15m}
      - setWeight: 100
  selector:
    matchLabels: {app: api}
  template:
    metadata:
      labels: {app: api}
    spec:
      containers:
      - name: api
        image: ghcr.io/linguadev/api:v2.147
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: error-rate-check
spec:
  metrics:
  - name: error-rate
    interval: 1m
    successCondition: result[0] < 0.02   # <2% de errores
    failureLimit: 3
    provider:
      prometheus:
        address: http://prometheus.monitoring:9090
        query: |
          sum(rate(http_requests_total{status=~"5..",service="api-canary"}[2m]))
            /
          sum(rate(http_requests_total{service="api-canary"}[2m]))
```

Si el error rate del canary supera 2% durante 3 intervalos consecutivos, Argo Rollouts hace rollback automático.

### 4.3 Progressive delivery: el siguiente paso

**Progressive delivery** (James Governor, RedMonk, 2018) = canary + feature flags + observability + automated analysis. La secuencia:

1. Deploy artefacto con feature OFF (canary al 5% del tráfico).
2. Análisis automático: error rate, latencia, business metrics.
3. Si OK: activar flag para 1% de usuarios INTERNOS.
4. Si OK: 10% usuarios reales.
5. Si OK: 50%.
6. Si OK: 100%.
7. En cualquier paso: abort automático + notificación.

En 2024-2026 el patrón está estandarizado con:
- **Argo Rollouts** (CNCF Graduated 2024).
- **Flagger** (con Istio/Linkerd/NGINX).
- **LaunchDarkly Guardrails** (SaaS).

### 4.4 Anti-patrones documentados

**"Snowflake staging"**: staging que se creó una vez y evolucionó divergente de prod. Bugs aparecen en prod que "no salían en staging". Solución: staging reproducible via IaC.

**"Deploy Friday" freeze**: prohibir deploys los viernes. Signal de que los deploys dan miedo. La solución NO es evitar viernes; es hacer deploys tan seguros que cualquier día sea igual. Charity Majors (Honeycomb) escribió *"Deploys Are the ##1 Problem"* argumentando el punto.

**"Un pipeline gigante monolítico"**: un solo pipeline de 45 minutos que rebuilda todo. Solución: pipelines por servicio (monorepo) o pipelines paralelos.

**"Testing en producción" sin observability**: canary sin métricas para decidir promoción = ruleta rusa. Requisito previo: dashboards + alertas + SLIs bien definidos.

**"Feature flags eternos"**: flags que llevan 3 años en el código. Solución: registro de flags con owner + expiry date; herramientas como Split o LaunchDarkly muestran "stale flags" para eliminar.

**"Rollback prohibido por management"**: "no podemos hacer rollback porque el CEO ya anunció la feature". Anti-patrón cultural. El rollback debe ser una decisión técnica, no política.

### 4.5 Métricas para el pipeline mismo

Un pipeline es un producto: debe tener SLIs propios.

| SLI del pipeline | Target razonable |
|------------------|------------------|
| PR → merge tiempo (p90) | <24h |
| Pipeline duración (p90) | <15 min |
| Success rate | >95% |
| Flaky test rate | <1% |
| Rollback frequency | <5% de deploys |

Herramientas 2026 para monitorear: **Buildkite Analytics**, **Datadog CI Visibility**, **CircleCI Insights**, **GitHub Actions Insights** (built-in).

---

## 5. Ejemplo práctico completo: pipeline commit-a-prod para LinguaDev

**Contexto.** Tienes un servicio Node.js/TypeScript en un monorepo pnpm (LinguaDev API). Objetivo: pipeline que deploye a prod en <15 min desde merge, con canary automático 5% → 25% → 100% y rollback automático si el error rate supera 2%.

**Paso 1 — Workflow de PR (validation):**

```yaml
# .github/workflows/pr.yml
name: PR validation
on: pull_request

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo lint type-check test:unit build
      - name: Integration tests con Testcontainers
        run: pnpm turbo test:integration
      - uses: aquasecurity/trivy-action@0.24.0
        with: { scan-type: fs, ignore-unfixed: true, severity: HIGH,CRITICAL }
      - name: Comment PR con cobertura
        uses: davelosert/vitest-coverage-report-action@v2
```

**Paso 2 — Workflow de deploy (main):**

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

concurrency:
  group: deploy-prod
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.meta.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        run: |
          IMAGE=ghcr.io/linguadev/api:${{ github.sha }}
          echo "image=$IMAGE" >> $GITHUB_OUTPUT
      - name: Build & push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.image }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: true
          sbom: true

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-kubectl@v4
      - name: Configure kubectl (OIDC to AWS)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/github-actions-staging
          aws-region: us-east-1
      - run: aws eks update-kubeconfig --name staging
      - run: kubectl set image deploy/api api=${{ needs.build.outputs.image }} -n api
      - run: kubectl rollout status deploy/api -n api --timeout=5m
      - name: Smoke tests
        run: |
          npm i -g newman
          newman run tests/postman/smoke.json --env-var host=https://api.staging.linguadev.com

  deploy-prod:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: production   # requiere approval según settings del env
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/github-actions-prod
          aws-region: us-east-1
      - run: aws eks update-kubeconfig --name prod
      - name: Update Rollout (Argo)
        run: |
          kubectl -n api argo rollouts set image api api=${{ needs.build.outputs.image }}
      - name: Watch rollout
        run: |
          kubectl -n api argo rollouts get rollout api --watch --timeout 30m
```

**Paso 3 — Argo Rollout con analysis:**

```yaml
# k8s/api/rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: api, namespace: api }
spec:
  replicas: 20
  revisionHistoryLimit: 5
  strategy:
    canary:
      canaryService: api-canary
      stableService: api-stable
      trafficRouting:
        istio:
          virtualService: { name: api-vs, routes: [primary] }
      steps:
      - setWeight: 5
      - pause: {duration: 5m}
      - analysis:
          templates: [{templateName: error-rate}, {templateName: latency-p99}]
      - setWeight: 25
      - pause: {duration: 10m}
      - analysis:
          templates: [{templateName: error-rate}, {templateName: latency-p99}]
      - setWeight: 50
      - pause: {duration: 10m}
      - setWeight: 100
```

**Paso 4 — AnalysisTemplate con PromQL:**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: { name: error-rate, namespace: api }
spec:
  metrics:
  - name: error-rate
    interval: 1m
    successCondition: result[0] < 0.02
    failureLimit: 3
    provider:
      prometheus:
        address: http://prometheus.monitoring:9090
        query: |
          sum(rate(http_requests_total{
            service="api-canary", status=~"5.."
          }[2m]))
            /
          sum(rate(http_requests_total{service="api-canary"}[2m]))
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: { name: latency-p99, namespace: api }
spec:
  metrics:
  - name: latency
    interval: 1m
    successCondition: result[0] < 0.5    # <500ms p99
    failureLimit: 3
    provider:
      prometheus:
        address: http://prometheus.monitoring:9090
        query: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{
              service="api-canary"
            }[2m])) by (le)
          )
```

**Paso 5 — Feature flag para desacoplar deploy y release:**

```typescript
// src/api/lessons.ts
import { OpenFeature } from '@openfeature/server-sdk';

const client = OpenFeature.getClient('linguadev-api');

export async function getLessonRecommendations(userId: string) {
  const useNewAlgo = await client.getBooleanValue(
    'lesson-rec-v2',
    false,                            // safe default
    { targetingKey: userId },
  );

  return useNewAlgo
    ? await recommendV2(userId)       // nuevo, detrás del flag
    : await recommendV1(userId);      // el estable
}
```

En la UI de Unleash/LaunchDarkly:
- Toggle flag ON para 1% de usuarios internos.
- Observar métricas 24h.
- 10% → observar → 50% → 100%.
- Si algo va mal en cualquier paso: toggle OFF (segundos).

**Paso 6 — Rollback manual (si autoanálisis no detecta):**

```bash
# Rollback del Rollout a versión previa
kubectl -n api argo rollouts undo api

# O apagar el feature flag
unleash-cli feature-toggles disable lesson-rec-v2 --project linguadev
```

Con este setup, un merge a `main` llega a producción en ~12-15 min, con canary automático que aborta si algo va mal. El feature flag permite activar la feature de forma independiente y gradual.

---

## 6. Cheatsheet y anti-patrones

### Cheatsheet: pipeline mínimo defendible

```
STAGE                    FALLA RÁPIDO?   TIEMPO OBJETIVO
─────────────────────────────────────────────────────────
Lint + format            ✅ segundos     <30s
Type check               ✅ segundos     <60s
Unit tests               ✅ minutos      <3 min
Build artifact           ⚠️ minutos      <5 min
Integration tests        ⚠️ minutos      <10 min
SAST + SCA               ⚠️ minutos      <5 min
Deploy staging           ⚠️ minutos      <2 min
E2E smoke                ⚠️ minutos      <15 min
Deploy prod (canary)     ✅ minutos      <30 min total
Post-deploy validation   ✅ minutos      <10 min
─────────────────────────────────────────────────────────
TOTAL commit → prod       <90 min (ideal <30 min)
```

### Tabla decisión: qué estrategia de deploy usar

| Escenario | Estrategia recomendada |
|-----------|------------------------|
| Servicio stateless, tráfico alto, buena observability | Canary con auto-analysis |
| Servicio stateless, tráfico bajo, sin observability madura | Rolling |
| App con schema DB que cambió | Expand-contract + rolling |
| Servicio crítico, cero downtime, compliance | Blue-Green |
| Refactor mayor sin cambios de comportamiento | Shadow traffic |
| Cambio experimental, quiero medir | Feature flag + A/B |
| Batch job / cron | Recreate |

### ✅ Buenas prácticas

- ✅ Pipeline as code, versionado en el repo.
- ✅ Build once, deploy many (mismo artefacto de dev a prod).
- ✅ Environment parity (staging tan cerca de prod como sea posible).
- ✅ Feature flags para desacoplar deploy de release.
- ✅ Trunk-based development si tienes CI robusto.
- ✅ Canary + auto-analysis para servicios de alto tráfico.
- ✅ Rollback como default; roll-forward como excepción documentada.
- ✅ Expand-contract migrations para schemas evolutivos.
- ✅ Observability antes que CD2 (dashboards + alertas + SLIs).
- ✅ Retention policy explícita de artefactos y logs de pipeline.

### ❌ Anti-patrones

- ❌ Recompilar por environment (`build-dev`, `build-prod` separados).
- ❌ Pipeline monolítico de 45 min sin paralelización.
- ❌ Tests E2E arriba de la pirámide (ice cream cone).
- ❌ "Snowflake staging" divergente de prod.
- ❌ Deploy Friday freeze permanente (síntoma de que los deploys dan miedo).
- ❌ Feature flags sin owner + expiry (flag debt).
- ❌ CD2 sin observability + auto-rollback (ruleta rusa).
- ❌ GitFlow en un SaaS 2026 (usualmente overkill).
- ❌ Rollback prohibido por management (antipatrón cultural).
- ❌ Migraciones DB no reversibles sin plan.

---

## 7. Casos reales de industria (2024-2026)

**Amazon (2024): despliegue continuo agregado**. Werner Vogels (re:Invent 2024) reafirma que Amazon en agregado despliega cada pocos segundos a través de miles de servicios micro. Cada two-pizza team es dueño de su pipeline. La cifra concreta "cada 11.7 segundos" viene de 2011; la práctica sigue escalando y ha sido citada como referencia por Google, Netflix, Uber en talks recientes.

**Facebook / Meta (2024)**: dos deploys diarios del monolito principal ("www"), con gradual rollout automático a través de sus propias herramientas internas. Publicaron *"Continuous Deployment at Scale"* originalmente en 2017; el modelo sigue vigente, ahora extendido con machine learning para detectar regresiones sutiles en el canary.

**Netflix Spinnaker + progressive delivery**. Spinnaker sigue siendo la plataforma de referencia para deploys multi-cloud con canary automático. Netflix contribuye continuamente al proyecto. En 2024-2025 Netflix añadió integración nativa con Kayenta (canary analysis basado en Mann-Whitney) para promociones automáticas basadas en estadística.

**GitLab 17 (2024)**: publicado en mayo 2024. Trajo mejoras a merge trains (concurrencia optimizada), ingegración nativa con OpenFeature via GitLab Feature Flags. En 2025 GitLab 17.6-18 añadió soporte para runners autoscaling en Kubernetes con Karpenter, reduciendo costos de CI 40-60% típicamente.

**GitHub Actions Merge Queue GA (2023-2024)**: Merge queue pasó a GA en julio 2023, se estabilizó a lo largo de 2024. Permite que múltiples PRs se prueben en secuencia (batches) contra `main` actualizado, garantizando que `main` nunca esté roto. Adoptado masivamente por proyectos OSS grandes (Kubernetes, TypeScript, Next.js).

**ArgoCD 2.13 (2024) → 2.14 (2025)**: ArgoCD se consolidó como el estándar GitOps CD. Adición de "sync waves" mejoradas y notifications avanzadas. Argo Rollouts 1.8 (2024) incluye soporte nativo para OpenFeature-triggered rollouts (rollback si feature flag detecta anomalías).

**Tekton 0.60+ (2024-2025)**: Tekton Pipelines evolucionó con "custom tasks" y mejor integración con Sigstore para provenance attestations SLSA v1. Adoptado por Red Hat OpenShift Pipelines como base.

**LaunchDarkly Guardrails (2024)**: LaunchDarkly lanzó "Guardrails" — feature flags con integración a métricas Datadog/Prometheus que abortan el rollout si SLOs se degradan. Compitiendo directamente con Argo Rollouts pero en la capa de flag.

**Prime Video Lambda → ECS (2023-2024)**: Amazon Prime Video documentó en un post viral (marzo 2023) su migración de un sistema serverless (Lambda + Step Functions) a monolito en ECS por razones de costo y latencia. Caso frecuentemente citado como refutación al "serverless siempre gana". Contexto importante para decisiones de deployment architecture.

**Basecamp / 37signals "leaving the cloud" (2023-2025)**: DHH publicó extensivamente su migración de AWS a colocation. Trajo el concepto "cloud exit" al mainstream. En 2025 Basecamp reportó ahorros de $2M/año. Signal claro de que "cloud siempre" no es axioma; hay contextos donde on-prem gana en TCO y rendimiento.

**Airbnb pipeline modernization (2024)**: Airbnb migró de un CI legacy a Bazel + custom orchestrator, reduciendo tiempo de build medio de 45min a 8min. Publicaron post técnico en su engineering blog. Modelo de referencia para monorepos grandes.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — Auditar el pipeline actual (45 min)

**Objetivo:** identificar los stages más lentos y las oportunidades de fail-fast.

**Setup:**
- Acceso al pipeline actual (GHA, GitLab CI, Jenkins).
- Últimas 20 ejecuciones para promediar.

**Pasos:**
1. Listar todos los stages con su duración promedio.
2. Identificar el stage más lento (top 1).
3. Identificar qué stages están mal ordenados (rápidos después de lentos).
4. Proponer reordenamiento fail-fast.
5. Medir tiempo total antes/después.

**Criterios de aceptación:**
- [ ] Tabla con stages ordenados por duración.
- [ ] PR abierto con reordenamiento propuesto.
- [ ] Métrica de tiempo total antes vs después.

**Bonus:** paralelizar los stages que sean independientes (unit + lint + type check pueden ir en paralelo).

---

### Ejercicio 2 — Implementar build-once-deploy-many (2h)

**Objetivo:** garantizar que el artefacto de staging es EXACTAMENTE el mismo que va a prod.

**Setup:**
- Pipeline existente con builds separados por env.
- Registro Docker (GHCR, ECR o similar).

**Pasos:**
1. Refactorizar el pipeline para tener un único stage `build` que produzca `image:${SHA}`.
2. Los stages `deploy-staging` y `deploy-prod` deben usar el MISMO tag.
3. Configuración por environment via env vars / ConfigMap, no via build args.
4. Testear que el mismo SHA que pasó por staging llega a prod.

**Criterios de aceptación:**
- [ ] Único build stage en el pipeline.
- [ ] Tag inmutable (SHA).
- [ ] Verificado con `docker inspect` que las capas son idénticas en staging y prod.
- [ ] Config externa (12-factor #3).

**Bonus:** añadir cosign para firmar el artefacto y verificar la firma en el deploy.

---

### Ejercicio 3 — Setup canary con Argo Rollouts en local (3h)

**Objetivo:** desplegar un servicio Node.js en un cluster Kind con canary progresivo.

**Setup:**
- kind (Kubernetes local): `kind create cluster`
- Instalar Argo Rollouts: `kubectl create ns argo-rollouts && kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml`
- Instalar Prometheus (Helm chart).

**Pasos:**
1. Crear un servicio HTTP simple con métricas (`/metrics` endpoint).
2. Definir un Rollout CRD con steps 10% → 50% → 100%.
3. Definir AnalysisTemplate con un check de error rate PromQL.
4. Deploy v1.
5. Deploy v2 (con un bug: /health devuelve 500 con probabilidad 30%).
6. Observar que Argo Rollouts detecta el bug y hace rollback automático.

**Criterios de aceptación:**
- [ ] Rollout v1 pasa 100%.
- [ ] Rollout v2 aborta durante el step 10% por error rate alto.
- [ ] `kubectl argo rollouts get rollout` muestra el rollback.
- [ ] Log de decisión visible en el evento del CRD.

**Bonus:** añadir un AnalysisTemplate de latencia p99.

---

### Ejercicio 4 — Feature flag con OpenFeature (1h)

**Objetivo:** implementar un feature flag y hacer un release gradual.

**Setup:**
- Node.js 22 + TypeScript.
- Cuenta gratis en Unleash Cloud o Unleash local en Docker.
- SDK: `npm i @openfeature/server-sdk @openfeature/unleash-provider`.

**Pasos:**
1. Configurar OpenFeature con provider Unleash.
2. Crear un flag `new-checkout-flow` en Unleash.
3. En código, wrappear una función con `client.getBooleanValue`.
4. Habilitar el flag para 10% de usuarios.
5. Verificar en logs que 10% del tráfico usa la nueva ruta.
6. Progresar a 50%, luego 100%.
7. Documentar el flag con owner + expiry date.

**Criterios de aceptación:**
- [ ] Código deploya con flag OFF por default.
- [ ] Métricas muestran ~10% rate en el primer paso.
- [ ] Toggle en Unleash surte efecto en <30s sin redeploy.
- [ ] Flag registrado con owner + due date de cleanup.

**Bonus:** integrar targeting por país (usar `EvaluationContext` con `country`).

---

### Ejercicio 5 — Expand-contract migration (2h)

**Objetivo:** ejecutar una migración de esquema sin downtime.

**Setup:**
- PostgreSQL local (Docker).
- Servicio simple que usa un ORM (Prisma, Drizzle, TypeORM).
- Tabla `users` con columna `full_name` que quieres separar en `first_name` + `last_name`.

**Pasos:**
1. **Expand**: migración añade `first_name` + `last_name` (nullable).
2. Deploy código v1: lee `full_name`, escribe en `full_name` + `first_name` + `last_name`.
3. Backfill: script que llena `first_name`/`last_name` de todas las filas viejas.
4. Deploy código v2: lee `first_name`/`last_name`, escribe solo en esos.
5. Verificar 24h que nadie escribe `full_name`.
6. **Contract**: migración drop `full_name`.

**Criterios de aceptación:**
- [ ] Ninguno de los 6 pasos requiere downtime.
- [ ] En cualquier paso puedes hacer rollback al paso anterior sin romper.
- [ ] Verificas con test que app v1 y v2 pueden convivir simultáneamente.

**Bonus:** ejecutar el backfill con throttling (max 100 rows/s) para no saturar la DB.

---

## 9. Recursos y siguientes pasos

**Libros:**
- *Continuous Delivery* — Jez Humble & David Farley (2010). La biblia. Sigue vigente en 2026.
- *Continuous Delivery Pipelines: How to Build Better Software Faster* — Dave Farley (2021).
- *The DevOps Handbook* — Kim/Humble/Debois/Willis (2016, 2ª ed 2021).
- *Grokking Continuous Delivery* — Christie Wilson (2022). Introducción moderna.

**Papers y artículos:**
- *"Continuous Deployment at Scale"* — Facebook Engineering (2017; sigue relevante).
- *"10+ Deploys Per Day"* — John Allspaw & Paul Hammond, Velocity 2009.
- Martin Fowler blog: `martinfowler.com/bliki/ContinuousDelivery.html`, `FeatureToggle.html`, `BlueGreenDeployment.html`, `CanaryRelease.html`.
- *"Progressive Delivery"* — James Governor, RedMonk (2018).
- *"The Phoenix Project"* explica narrativamente los conceptos.

**Herramientas de referencia (todas open-source, salvo indicado):**
- **CI**: GitHub Actions, GitLab CI, Jenkins, CircleCI, Buildkite, Tekton, Drone.
- **CD**: Argo CD, Flux, Spinnaker, Harness, Octopus Deploy.
- **Progressive delivery**: Argo Rollouts, Flagger, LaunchDarkly Guardrails (SaaS).
- **Feature flags**: Unleash (OSS), OpenFeature (spec), LaunchDarkly (SaaS), Split (SaaS), GrowthBook (OSS + SaaS).
- **Artifact registries**: Harbor, JFrog Artifactory, Sonatype Nexus, GHCR, ECR, GCR.

**Documentación viva:**
- CNCF Landscape → CI/CD y Continuous Integration/Deployment cells: `landscape.cncf.io`.
- OpenFeature spec: `openfeature.dev`.
- Argo project docs: `argoproj.github.io`.

**Siguientes pasos en este track:**
- [← Cap 01 — Cultura DevOps y DORA](./01-cultura-devops-y-dora.md)
- [Cap 03 — Git workflows y branching](./03-git-workflows-y-branching.md): el mecanismo de colaboración que hace posible TBD.
- [Cap 04 — GitHub Actions y Jenkins](./04-github-actions-y-jenkins.md): la implementación concreta.
- Más adelante: Cap 32 (Blue/Green/Canary), Cap 33 (Progressive Delivery avanzado), Cap 34 (Feature Flags a escala).

---

## 10. Preguntas de práctica

20 preguntas cubren: CI vs CD-Delivery vs CD-Deployment, pipeline stages y fail fast, pipeline as code, artifact management y build-once, semver, release cadence, gates y approvals, rollback vs roll-forward, blue-green, canary, feature flags, test pyramid, trunk-based development, cache strategies, matrix builds, secrets en CI, database migrations, progressive delivery, monorepo CI, GitOps.

Ruta en la app: `/programming/devops/sim/devops-sim-02-continuous-delivery-fundamentals`

JSON: [`packages/content/src/tech/devops/sim-02-continuous-delivery-fundamentals.json`](../../packages/content/src/tech/devops/sim-02-continuous-delivery-fundamentals.json)

---

## Navegación

← [Cap 01](./01-cultura-devops-y-dora.md) · [Índice](./README.md) · [Cap 03 →](./03-git-workflows-y-branching.md)
