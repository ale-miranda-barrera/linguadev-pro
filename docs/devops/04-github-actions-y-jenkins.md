# Capítulo 04 — GitHub Actions y Jenkins

> **Focus:** GitHub Actions (workflows, jobs, steps, matrix, secrets, environments). Jenkins pipelines (declarative vs scripted). GitLab CI, CircleCI. Caching. Parallel jobs. Reusable workflows. Artifact passing. Cuándo usar cuál.
> **Áreas:** VCS + CI · CI/CD · DevOps culture
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Git básico: `commit`, `push`, `branch`, `merge`, `rebase` (ver [Cap 03 — Git workflows y branching](./03-git-workflows-y-branching.md)).
- YAML: sintaxis de mapas, listas, anchors, `|` vs `>` para strings multilinea.
- Bash / shell scripting: pipes, redirecciones, variables de entorno, exit codes.
- Cultura DevOps y DORA metrics (ver [Cap 01 — Cultura DevOps y DORA](./01-cultura-devops-y-dora.md)).
- Fundamentos de continuous delivery (ver [Cap 02 — Fundamentos de continuous delivery](./02-fundamentos-de-continuous-delivery.md)).
- Idealmente: haber roto un pipeline en producción una vez (formación esencial de carácter).

**Glosario mínimo:**
- **CI / CD**: Continuous Integration (mergear frecuentemente con builds+tests automáticos) / Continuous Delivery o Deployment (llevar artefacto a producción con o sin aprobación manual).
- **Workflow / Job / Step**: archivo YAML en `.github/workflows/` que contiene jobs (paralelos por default, corren en un runner) que a su vez contienen steps (secuenciales).
- **Runner**: máquina que ejecuta un job. GitHub-hosted (`ubuntu-latest`, `windows-latest`, `macos-latest`) o `self-hosted`.
- **Action**: unidad reutilizable (JS, Docker o composite) invocada con `uses: owner/repo@version`.
- **Artifact vs Cache**: artifact = archivo persistido al final del job, descargable 90 días; cache = contenido indexado por key para reutilizar entre runs.
- **Secret**: valor cifrado (API key, token) inyectado como env var; enmascarado en logs.
- **Environment**: entorno lógico (`staging`, `production`) con protection rules (aprobadores, wait timer, branch restrictions).
- **Reusable workflow / Composite action**: workflow entero invocable desde otro (`uses:` a nivel de job) vs empaquetar 3-8 steps en una acción (`uses:` a nivel de step).
- **Jenkinsfile**: pipeline en Groovy en la raíz del repo, `declarative` o `scripted`.
- **Shared Library**: código Groovy versionado que un Jenkinsfile importa con `@Library('mi-libreria')`.
- **Blue Ocean**: UI moderna de Jenkins (2017); en 2024-2026 la UI clásica moderniza y Blue Ocean queda en mantenimiento.

**Setup mínimo:**

```bash
# gh CLI (2.60+) para operar GHA desde terminal
gh --version && gh auth login
gh workflow list
gh workflow run deploy.yml -f environment=staging
gh run list --limit 5
gh run view <run-id> --log

# act — correr workflows GHA localmente sobre Docker
# brew install act  |  winget install nektos.act
act -j build -W .github/workflows/ci.yml

# Jenkins local con Docker
docker run -d --name jenkins -p 8080:8080 -p 50000:50000 \
  -v jenkins_home:/var/jenkins_home jenkins/jenkins:2.462.3-lts
java -jar jenkins-cli.jar -s http://localhost:8080/ list-jobs
```

---

## 1. El gran cuadro

Un pipeline de CI/CD moderno hace tres cosas: (a) **valida** que cada cambio no rompe la suite (lint, unit, integration, SAST); (b) **construye** artefactos reproducibles y firmados (imágenes de contenedor, binarios, bundles); (c) **entrega** esos artefactos a los entornos (staging, canary, production) con guardarraíles (aprobaciones, migraciones, health checks, rollbacks). Todo lo demás —cache, matrices, notificaciones, badges— es infraestructura al servicio de estos tres verbos. Cuando decides qué herramienta usar (GHA, Jenkins, GitLab CI, CircleCI, Tekton, Buildkite) decides en realidad el modelo de ejecución (managed vs self-hosted), el lenguaje de configuración (YAML declarativo vs Groovy imperativo), el modelo de identidad (OIDC federado vs static secrets) y el ecosistema de integraciones (marketplace vs plugin registry).

**GitHub Actions** (GA en noviembre 2019) se convirtió entre 2020 y 2026 en el CI dominante para código abierto y para empresas asentadas en GitHub. Workflow = archivo YAML en `.github/workflows/`, ejecución sobre VMs efímeras Microsoft-hosted (o runners self-hosted), marketplace con más de 22.000 actions en 2026. Fortalezas: integración nativa con identidad y permisos de GitHub, tokens efímeros (`GITHUB_TOKEN` rotado por run), OpenID Connect federation contra AWS/GCP/Azure, developer experience de zero-friction. Debilidades: debugging remoto lento sin `act` local, reusable workflows con límites (max 4 niveles anidados, no acceden al `matrix` del caller), pricing por minuto se dispara con matrices grandes en repos privados, y self-hosted runners requieren disciplina de seguridad.

**Jenkins** (Hudson en 2005; fork Jenkins en 2011 tras el pleito Oracle-Kawaguchi) sigue siendo en 2026 el CI dominante del enterprise legacy. Arquitectura sin cambios sustanciales: un controller Java coordina agents que ejecutan builds. Fuerza: flexibilidad absoluta con 1.900+ plugins. Debilidades: Groovy es gran superficie de ataque (RCE por deserialización, sandbox escape), mantener un Jenkins productivo consume 0.5-1 FTE de ops, upgrades rompen plugins, deuda técnica en Jenkinsfiles de 800 líneas sin tests. La iniciativa **Jenkins Modernization** (2024-2026) empuja Java 17+ y plantilla declarativa por defecto.

Al lado conviven **GitLab CI/CD** (integrado con GitLab, YAML potente con `include`/`extends` y merge trains); **CircleCI** (SaaS con orbs); **Buildkite** (agents self-hosted + control plane SaaS, usado por Shopify y Airbnb); **Tekton** (pipelines como CRDs de Kubernetes, base de OpenShift Pipelines); **ArgoCD** y **Flux** (CD GitOps, no CI); **Spinnaker** (Netflix, multi-cloud); y **Dagger** (SDK programable multi-CI). Regla práctica 2026: en GitHub → GHA + OIDC + ArgoCD; en GitLab → GitLab CI + Auto DevOps; con Jenkins funcional → mantenerlo; para pipelines como recursos K8s → Tekton + Argo Events.

---

## 2. Fundamentos (nivel básico)

### 2.1 Anatomía de un workflow GHA

Un workflow es un archivo YAML dentro de `.github/workflows/`. La jerarquía canónica es:

```
Workflow (archivo YAML)
└── Jobs (paralelos por default)
    └── Steps (secuenciales dentro del job)
        ├── uses: (invoca una action)
        └── run: (ejecuta un shell command)
```

Ejemplo mínimo verificable:

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install deps
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Test
        run: pnpm test --coverage
```

Puntos clave:
- **`name`**: opcional, se muestra en la UI. Si lo omites, GitHub usa el nombre del archivo.
- **`on`**: trigger events. Puede ser string (`on: push`), lista (`on: [push, pull_request]`) o mapa con filtros (`branches`, `tags`, `paths`).
- **`jobs`**: mapa. Cada llave es el ID del job (usado con `needs:` para dependencias).
- **`runs-on`**: tipo de runner. GitHub-hosted: `ubuntu-latest`, `ubuntu-24.04`, `windows-latest`, `macos-14` (Apple Silicon). Self-hosted: `[self-hosted, linux, x64, gpu]` (tags).
- **`steps`**: lista ordenada. Cada step tiene `uses:` (action) o `run:` (shell) y opcionalmente `with:`, `env:`, `if:`, `continue-on-error:`, `timeout-minutes:`, `working-directory:`.

### 2.2 Triggers (`on:`) más usados

- **`push`**: al pushear a un branch/tag. Filtros: `branches`, `branches-ignore`, `tags`, `paths`, `paths-ignore`.
- **`pull_request`**: al abrir/sincronizar/reabrir una PR. Types: `opened`, `synchronize`, `closed`, `ready_for_review`, etc.
- **`schedule`**: cron en **UTC** (gotcha común). `- cron: '0 2 * * *'` = 02:00 UTC diario.
- **`workflow_dispatch`**: botón manual "Run workflow" en la UI. Puede recibir `inputs:` tipados (string, boolean, choice, environment).
- **`workflow_call`**: convierte al workflow en reusable, invocable desde otros con `uses:` a nivel de job.
- **`workflow_run`**: dispara este workflow cuando otro completa (útil para encadenar CI → deploy).
- **`release`**, **`issues`**, **`issue_comment`**, **`discussion`**: para automatizaciones sobre eventos de repo.

### 2.3 Runners

- **GitHub-hosted**: VMs efímeras (una por job), con imagen de Microsoft actualizada mensualmente. Tienen preinstalado: Node 18/20/22, Python 3.10-3.12, Go 1.21+, .NET 6-8, Docker, kubectl, gh, aws, gcloud, azure CLI, Terraform, y ~200 herramientas más. Free tier generoso para OSS (ilimitado en repos públicos). En repos privados: 2000 min/mes en Free, 3000 min/mes en Pro, 50.000 min/mes en Enterprise. Costo adicional: $0.008/min Linux, $0.016/min Windows, $0.08/min macOS.
- **Larger runners** (2023+): SKUs de 4, 8, 16, 32, 64 vCPU con GPU opcional (`ubuntu-latest-16-cores`, `ubuntu-gpu-t4-4-cores`).
- **Self-hosted**: registras un binario `actions/runner` contra tu repo/org/enterprise. Útil para GPU, ARM64, red privada, compliance regulatorio. **Riesgo de seguridad**: nunca corras `pull_request` de forks en un self-hosted runner con acceso a secrets o infra sensible. Usa `Require approval for first-time contributors`.

### 2.4 Anatomía de un Jenkinsfile declarativo

Jenkins declarative es la sintaxis moderna (Jenkins 2.5+, 2017). Estructura fija:

```groovy
// Jenkinsfile
pipeline {
    agent {
        docker {
            image 'node:20-alpine'
            args '-u root'
        }
    }

    environment {
        CI = 'true'
        NODE_ENV = 'test'
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '10'))
        disableConcurrentBuilds()
    }

    stages {
        stage('Install') {
            steps {
                sh 'npm ci'
            }
        }
        stage('Lint & Test') {
            parallel {
                stage('Lint') {
                    steps { sh 'npm run lint' }
                }
                stage('Test') {
                    steps { sh 'npm test -- --ci --coverage' }
                    post {
                        always {
                            junit 'reports/junit.xml'
                        }
                    }
                }
            }
        }
        stage('Build') {
            steps { sh 'npm run build' }
        }
    }

    post {
        success { echo 'Build passed.' }
        failure {
            mail to: 'team@example.com',
                 subject: "FAILED: ${env.JOB_NAME} #${env.BUILD_NUMBER}",
                 body: "See ${env.BUILD_URL}"
        }
        always { cleanWs() }
    }
}
```

Elementos: `agent` (dónde corre; puede ser `any`, `none`, `docker`, `kubernetes`, `label`), `environment` (env vars), `options` (timeout, retención de builds, concurrencia), `stages` (secuenciales por default, `parallel { }` para paralelismo), `post` (siempre corre al final: `success`, `failure`, `unstable`, `changed`, `always`).

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Matrix builds — el patrón más usado y peor entendido

Matrix builds ejecutan el mismo job con múltiples combinaciones de variables. Uso típico: probar contra varios OS, varias versiones de runtime, varias variantes de config.

```yaml
jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false          # no cancela otros jobs si uno falla
      max-parallel: 6           # límite de jobs concurrentes
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: ['18', '20', '22']
        include:
          - os: ubuntu-latest
            node: '22'
            coverage: true       # solo esta combinación sube coverage
        exclude:
          - os: macos-latest
            node: '18'           # skip: costoso y sin valor
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm test
      - if: matrix.coverage
        uses: codecov/codecov-action@v4
```

Sin `include`/`exclude`: 3 OS × 3 Node = 9 jobs. Con `exclude` (macos+18): 8 jobs. Con `include`: 8 jobs, pero uno con `coverage: true`.

**Anti-patrón**: matrices explosivas. 5 OS × 5 runtimes × 3 databases × 2 arquitecturas = 150 jobs. En repo privado con Ubuntu = 150 × 5 min × $0.008 = **$6.00 por push**. Multiplícalo por 200 PRs/mes: $1.200/mes solo en CI.

**Regla**: usa matriz completa en `push: main` y en `release`. En `pull_request` usa un subconjunto (una versión de runtime, un OS).

### 3.2 Artifacts vs Cache — casi todos los confunden

| Aspecto | **Artifact** | **Cache** |
|---|---|---|
| **Propósito** | Compartir archivos entre jobs del mismo workflow, o descargar como resultado. | Reutilizar contenido entre workflow runs (typically deps). |
| **Indexado por** | Nombre + workflow run ID. | Key (string) + optional restore-keys. |
| **Retención** | 90 días default (config 1-400 días). | 7 días desde último acceso, o cuando se llena la cuota (10 GB/repo). |
| **Máximo** | 10 GB/artifact (v4). | 10 GB/repo (branch-scoped en fetch). |
| **Compresión** | Zip (auto). | Zstd (default), sin cambios visibles. |
| **Descarga fuera del workflow** | Sí (UI o API). | No, solo dentro del workflow. |
| **Casos de uso** | Binarios buildados, screenshots de e2e, reports, deploy bundle. | `node_modules`, `~/.m2`, `~/.cargo`, Docker layers. |

Ejemplo combinado:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Cache pnpm store
        uses: actions/cache@v4
        with:
          path: ~/.local/share/pnpm/store
          key: pnpm-${{ runner.os }}-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            pnpm-${{ runner.os }}-

      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: apps/web/dist/
          retention-days: 7

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Download build artifact
        uses: actions/download-artifact@v4
        with:
          name: dist
          path: ./dist
      - run: ls -la ./dist
```

**Gotcha crítico**: `actions/upload-artifact@v3` fue **deprecated el 30 nov 2024** y removido. Usa `@v4` (paralelo, más rápido, no acumula en el mismo artifact — cada upload crea uno inmutable).

### 3.3 Secrets y OpenID Connect (OIDC) federation

**Antes (mal patrón)**: guardas `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` como secrets del repo. Riesgos: rotación manual, blast radius si se filtran, no auditables por acción.

**Ahora (patrón correcto 2026)**: OIDC federation. GitHub emite un JWT firmado con claims (`repository`, `ref`, `workflow`, `job_workflow_ref`, `environment`) que AWS/GCP/Azure verifican para emitir credenciales temporales.

```yaml
# Configuración one-time en AWS: crear un OIDC provider apuntando a
# https://token.actions.githubusercontent.com
# y un IAM Role con trust policy que valide los claims.

permissions:
  id-token: write          # requerido para OIDC
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-linguadev-deploy
          aws-region: us-east-1
          role-session-name: gha-${{ github.run_id }}

      - run: aws sts get-caller-identity
      - run: aws s3 sync ./dist s3://linguadev-web/ --delete
      - run: aws cloudfront create-invalidation --distribution-id ${{ vars.CF_DIST_ID }} --paths '/*'
```

Trust policy AWS (extracto):

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
    },
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:mi-org/linguadev-pro:environment:production"
    }
  }
}
```

Cero secrets en el repo. Rotación automática por STS. Auditoría por CloudTrail correlacionable con `run_id`.

### 3.4 Comparación GHA vs Jenkins vs GitLab CI vs CircleCI

| Aspecto | **GitHub Actions** | **Jenkins** | **GitLab CI** | **CircleCI** |
|---|---|---|---|---|
| **Modelo** | SaaS + self-hosted runners | 100% self-hosted (CloudBees SaaS exists) | Integrado con GitLab (SaaS o self-hosted) | SaaS principalmente |
| **Config** | YAML declarativo | Groovy (declarative o scripted) | YAML declarativo con `include`/`extends` | YAML con orbs |
| **Ecosistema** | Marketplace 22.000+ actions | 1.900+ plugins | Componentes CI + Auto DevOps | Orbs registry |
| **Reutilización** | Reusable workflows + composite actions | Shared Libraries (Groovy) | `include:` remoto, extends, componentes CI (2024+) | Orbs, executors compartidos |
| **Matrix builds** | Nativo (`strategy.matrix`) | Vía plugin o loop en Groovy | `parallel: matrix:` | `parallelism: N` + splitting |
| **Cache** | `actions/cache@v4` | Plugin `pipeline-utility-steps` o `stash`/`unstash` | `cache:` (por job) | `save_cache` / `restore_cache` |
| **Artifact** | `actions/upload/download-artifact@v4` | `archiveArtifacts` | `artifacts:` | `store_artifacts` |
| **Secrets** | Encrypted + OIDC federation | Credentials plugin + vault plugin | Masked variables + vault + OIDC | Contexts + OIDC |
| **Approvals** | Environment protection rules | `input` step | Manual jobs + protected environments | Approval jobs |
| **UX debug** | Logs por step, re-run failed only | Blue Ocean, Console output | Trace en Job UI | Insights + rerun with SSH |
| **Precio (privado)** | Free tier + $0.008/min Linux | Costo de infra + FTE ops | Free tier + minutos extras | Free tier + performance/scale plans |
| **Curva** | Baja | Alta (Groovy + plugin lore) | Media | Baja-Media |
| **Fortaleza** | Ecosistema + integración GitHub | Flexibilidad total | Todo-en-uno con GitLab | Performance + Docker layers |
| **Debilidad** | Reusable workflows con límites; vendor lock-in | Ops burden; seguridad Groovy | Requiere GitLab; menor marketplace | Menor market share reciente |

**Regla 2026**: si estás en GitHub → GHA. Si estás en GitLab → GitLab CI. Si tienes Jenkins funcionando y auditado → mantenlo hasta que haya un driver de negocio para migrar. CircleCI queda relegado a nichos que valoran su performance en Docker layer caching.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Reusable workflows — DRY entre repos

Un reusable workflow es un workflow completo con `on: workflow_call:` que otros workflows invocan con `uses:` a nivel de job. Diferencia con composite actions: reusable workflows corren en **su propio runner** (job independiente), composite actions corren **en el mismo runner** que el step que las invoca.

```yaml
# .github/workflows/reusable-node-ci.yml (en el repo mi-org/ci-workflows)
name: Reusable Node CI

on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: '20'
      run-e2e:
        type: boolean
        default: false
      working-directory:
        type: string
        default: '.'
    secrets:
      NPM_TOKEN:
        required: false
    outputs:
      version:
        description: 'Version built'
        value: ${{ jobs.build.outputs.version }}

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.pkg.outputs.version }}
    defaults:
      run:
        working-directory: ${{ inputs.working-directory }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node-version }}
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test
      - id: pkg
        run: echo "version=$(jq -r .version package.json)" >> $GITHUB_OUTPUT
      - if: inputs.run-e2e
        run: pnpm test:e2e
```

Invocación desde otro repo:

```yaml
# .github/workflows/ci.yml (en linguadev-pro)
jobs:
  ci-web:
    uses: mi-org/ci-workflows/.github/workflows/reusable-node-ci.yml@v2
    with:
      node-version: '20'
      run-e2e: true
      working-directory: apps/web
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Límites**: máximo 4 niveles de anidamiento; el reusable workflow no ve el `matrix` del caller; no puedes pasar todos los secrets con `inherit` a menos que uses `secrets: inherit`.

### 4.2 Composite actions — DRY dentro del mismo repo

Ideal para reutilizar 3-8 steps sin promoverlos a workflow entero.

```yaml
# .github/actions/setup-project/action.yml
name: 'Setup Project'
description: 'Checkout, setup Node, install pnpm, install deps con cache'
inputs:
  node-version:
    description: 'Node version'
    required: false
    default: '20'
outputs:
  cache-hit:
    description: 'Whether pnpm cache was hit'
    value: ${{ steps.cache.outputs.cache-hit }}
runs:
  using: 'composite'
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
      with:
        version: 9
    - uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}
        cache: 'pnpm'
    - id: cache
      run: pnpm install --frozen-lockfile
      shell: bash
```

Uso:

```yaml
- uses: ./.github/actions/setup-project
  with:
    node-version: '22'
```

### 4.3 Self-hosted runners con Actions Runner Controller (ARC)

**Actions Runner Controller** (ARC) es el operador oficial que corre self-hosted runners en Kubernetes con autoscaling. GA en 2023, madurez en 2026.

```yaml
# runner-scaleset.yaml
apiVersion: actions.github.com/v1alpha1
kind: AutoscalingRunnerSet
metadata:
  name: linguadev-runners
  namespace: arc-runners
spec:
  githubConfigUrl: https://github.com/mi-org/linguadev-pro
  githubConfigSecret: gha-runner-token
  minRunners: 1
  maxRunners: 20
  runnerScaleSetName: linux-x64
  template:
    spec:
      containers:
        - name: runner
          image: ghcr.io/actions/actions-runner:2.320.0
          resources:
            requests: { cpu: '2', memory: '4Gi' }
            limits: { cpu: '4', memory: '8Gi' }
```

En el workflow:

```yaml
jobs:
  build:
    runs-on: linux-x64          # matchea runnerScaleSetName
```

**Ventajas**: autoscaling por demanda, pods efímeros (no state leak), aislamiento por namespace, integración con node selectors (GPU pools, ARM64).

**Gotcha de seguridad**: los self-hosted runners **nunca** deben ejecutar `pull_request` de forks. Habilita en Settings → Actions: `Fork pull request workflows from outside collaborators: Require approval for first-time contributors`.

### 4.4 Merge queue — Serialización correcta del merge

**GitHub Merge Queue** (GA junio 2023, adopción masiva 2024-2026) resuelve el problema clásico "PR verde individualmente pero rompe main tras merge concurrente".

```yaml
# .github/workflows/merge-queue.yml
name: Merge Queue Checks
on:
  merge_group:
    types: [checks_requested]

jobs:
  ci:
    uses: ./.github/workflows/reusable-node-ci.yml
```

Configuración en Settings → Branches → main → Require merge queue. La queue crea branches efímeros `gh-readonly-queue/main/pr-N-abc123` que integran los PRs en orden y solo mergea si el pipeline pasa. Latencia adicional: 3-8 min por PR, pero elimina el "revert Friday".

### 4.5 Jenkins Shared Libraries

Shared Libraries son código Groovy versionado en un repo separado, importable desde cualquier Jenkinsfile.

```
mi-org/jenkins-shared-lib/
├── vars/
│   ├── nodeBuild.groovy         # step DSL: nodeBuild()
│   └── deployToK8s.groovy
├── src/
│   └── com/miorg/pipelines/
│       └── DeployUtils.groovy   # clases Groovy
└── resources/
    └── com/miorg/templates/
        └── notify.html
```

`vars/nodeBuild.groovy`:

```groovy
def call(Map config = [:]) {
    def nodeVersion = config.nodeVersion ?: '20'
    def coverage = config.coverage ?: false
    pipeline {
        agent {
            docker { image "node:${nodeVersion}-alpine" }
        }
        stages {
            stage('Install') { steps { sh 'npm ci' } }
            stage('Lint')    { steps { sh 'npm run lint' } }
            stage('Test') {
                steps {
                    script {
                        if (coverage) sh 'npm test -- --coverage'
                        else          sh 'npm test'
                    }
                }
            }
            stage('Build')   { steps { sh 'npm run build' } }
        }
    }
}
```

Uso desde Jenkinsfile:

```groovy
@Library('jenkins-shared-lib@v3') _

nodeBuild(nodeVersion: '22', coverage: true)
```

Equivalente conceptual a reusable workflows en GHA, con más potencia (Groovy Turing-complete) y más peligro (RCE por deserialization, sandbox escapes históricos como CVE-2018-1000861).

### 4.6 Anti-patrones que rompen equipos

1. **Secrets en `env:` global**: expone el secret a todos los steps, incluidos steps de terceros. Restringe scope al step que lo necesita.
2. **Uso de `@main` o `@master` en `uses:`**: te dispara la lotería cuando el maintainer sube una versión con bug. Pin a SHA (`uses: actions/checkout@a5ac7e51b41094c92402da3b24376905380afc29`) para actions no oficiales; a `@v4` (tag) para las oficiales.
3. **Reusable workflow que llama a otro reusable que llama a otro...**: rompes el límite de 4 niveles y debugging es imposible.
4. **`fail-fast: false` en producción**: si un job falla, deja correr los otros. Útil en tests, peligroso en deploys secuenciales.
5. **Ignorar `permissions:`**: por default un workflow tiene `contents: write` en clásicos. Endurece con `permissions: read-all` a nivel workflow y `permissions: contents: write` solo en jobs que lo necesitan.
6. **Cache que crece indefinidamente**: caches con key basado en timestamp o commit SHA nunca se reutilizan y llenan la cuota de 10 GB. Usa `hashFiles('**/pnpm-lock.yaml')`.
7. **Jenkinsfile de 800 líneas sin tests**: la solución es Shared Libraries + tests unitarios con `JenkinsPipelineUnit`.
8. **Jenkins agents con acceso a producción**: el controller nunca debe tener credenciales de deploy. Usa CyberArk/Vault + OIDC.
9. **Correr e2e en cada push a un feature branch**: costoso y no aporta señal. Corre e2e en `pull_request` a `main` y en `merge_group`.
10. **No usar concurrency**: dos deploys al mismo entorno se pisan. Usa `concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: false }`.

---

## 5. Ejemplo práctico completo — Pipeline Node/pnpm con matrix, reusable workflow, OIDC y ArgoCD

Este pipeline demuestra los patrones canónicos para una app Node del monorepo LinguaDev Pro: lint + type-check + tests unitarios en matriz, build multiplataforma, publicación de imagen a GHCR con SBOM, deploy a staging con OIDC contra AWS y trigger de ArgoCD.

**Reusable workflow** (`.github/workflows/reusable-node.yml`):

```yaml
name: Reusable Node Build & Test

on:
  workflow_call:
    inputs:
      workspace:
        type: string
        required: true
      run-e2e:
        type: boolean
        default: false
    outputs:
      image-tag:
        description: 'Docker image tag pushed'
        value: ${{ jobs.build-image.outputs.tag }}

permissions:
  contents: read
  packages: write
  id-token: write

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: ['20', '22']
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter ${{ inputs.workspace }} lint
      - run: pnpm --filter ${{ inputs.workspace }} typecheck
      - run: pnpm --filter ${{ inputs.workspace }} test -- --coverage
      - if: matrix.node == '22'
        uses: actions/upload-artifact@v4
        with:
          name: coverage-${{ inputs.workspace }}
          path: ${{ inputs.workspace }}/coverage/

  build-image:
    needs: test
    runs-on: ubuntu-latest
    outputs:
      tag: ${{ steps.meta.outputs.tags }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}/${{ inputs.workspace }}
          tags: |
            type=sha,prefix=sha-
            type=ref,event=branch
            type=semver,pattern={{version}}
      - uses: docker/build-push-action@v6
        with:
          context: ${{ inputs.workspace }}
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          provenance: true
          sbom: true
```

**Workflow orquestador** (`.github/workflows/ci-cd.yml`):

```yaml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
        default: staging

concurrency:
  group: cicd-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  ci-web:
    uses: ./.github/workflows/reusable-node.yml
    with:
      workspace: apps/web
      run-e2e: true

  ci-api:
    uses: ./.github/workflows/reusable-node.yml
    with:
      workspace: services/api
      run-e2e: false

  deploy-staging:
    if: github.ref == 'refs/heads/main'
    needs: [ci-web, ci-api]
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: https://staging.linguadev.pro
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-staging-deploy
          aws-region: us-east-1
          role-session-name: gha-${{ github.run_id }}
      - name: Update image tags in GitOps repo
        env:
          WEB_TAG: ${{ needs.ci-web.outputs.image-tag }}
          API_TAG: ${{ needs.ci-api.outputs.image-tag }}
        run: |
          git config user.name  "gha-bot"
          git config user.email "gha-bot@linguadev.pro"
          git clone https://x-access-token:${{ secrets.GITOPS_PAT }}@github.com/mi-org/gitops-config.git
          cd gitops-config
          yq -i ".spec.template.spec.containers[0].image = \"${WEB_TAG}\"" \
                envs/staging/web-deployment.yaml
          yq -i ".spec.template.spec.containers[0].image = \"${API_TAG}\"" \
                envs/staging/api-deployment.yaml
          git commit -am "chore(staging): bump images to ${{ github.sha }}"
          git push
      - name: Trigger ArgoCD sync
        run: |
          curl -sSf -H "Authorization: Bearer ${{ secrets.ARGOCD_TOKEN }}" \
               -X POST https://argocd.linguadev.pro/api/v1/applications/staging/sync

  smoke-tests:
    needs: deploy-staging
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:smoke -- --base-url=https://staging.linguadev.pro
      - if: failure()
        run: |
          echo "::warning::Smoke tests failed; consider rollback"
```

**Puntos clave demostrados**:
- Reusable workflow con inputs y outputs.
- Matrix (`node: ['20', '22']`) con `fail-fast: false`.
- Cache pnpm por `hashFiles('pnpm-lock.yaml')`.
- Cache de Docker layers vía `type=gha`.
- Artifact de coverage con `upload-artifact@v4`.
- OIDC federation contra AWS (cero secrets estáticos).
- Environment `staging` con URL declarada (aparece en la UI).
- Concurrency por branch con `cancel-in-progress` solo en PRs.
- Patrón GitOps: CI actualiza manifests en un repo separado; ArgoCD reconcilia.

---

## 6. Cheatsheet + reglas + anti-patrones

### 6.1 Cheatsheet GitHub Actions

```yaml
# Triggers
on:
  push: { branches: [main], tags: ['v*'], paths: ['src/**'] }
  pull_request: { types: [opened, synchronize, reopened] }
  schedule: [{ cron: '0 2 * * *' }]         # UTC
  workflow_dispatch: { inputs: { env: { type: choice, options: [dev, prod] } } }
  workflow_call: { inputs: {}, secrets: {}, outputs: {} }
  merge_group: {}

# Permissions (least privilege)
permissions: read-all
# o
permissions:
  contents: read
  packages: write
  id-token: write            # OIDC federation
  pull-requests: write       # comentar en PRs

# Concurrency
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

# Job con matrix
jobs:
  test:
    strategy:
      fail-fast: false
      max-parallel: 5
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [20, 22]
        include: [{ os: ubuntu-latest, node: 22, coverage: true }]
        exclude: [{ os: macos-latest, node: 20 }]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4         # tag ok en oficiales
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }}, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
        env: { CI: true }

# Expressions
${{ github.actor }}                # quien disparó
${{ github.ref_name }}             # nombre del branch/tag
${{ github.sha }}                  # commit SHA
${{ github.event_name }}           # push, pull_request, ...
${{ github.event.pull_request.number }}
${{ secrets.MI_SECRET }}
${{ vars.MI_VAR }}                 # variables no-secretas (repo/org/env)
${{ inputs.mi-input }}             # en workflow_call / dispatch
${{ needs.build.outputs.version }} # output de otro job
${{ steps.pkg.outputs.version }}   # output de otro step
${{ matrix.os }}                   # valor de la matriz

# Condicionales
if: github.ref == 'refs/heads/main' && github.event_name == 'push'
if: success() && !cancelled()
if: failure()
if: always()

# Environments (approvals)
environment:
  name: production
  url: https://linguadev.pro
```

### 6.2 Cheatsheet Jenkins declarative

```groovy
pipeline {
  agent { kubernetes { yamlFile 'k8s/pod.yaml' } }
  parameters {
    choice(name: 'ENV', choices: ['staging', 'production'], description: '')
    booleanParam(name: 'SKIP_TESTS', defaultValue: false, description: '')
  }
  environment {
    AWS_REGION = 'us-east-1'
    IMAGE_TAG  = "${env.GIT_COMMIT.take(7)}"
  }
  options {
    timeout(time: 45, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '20'))
    disableConcurrentBuilds()
    ansiColor('xterm')
  }
  triggers {
    cron('H 2 * * *')                  // H = hash pattern (Jenkins spread load)
    pollSCM('H/5 * * * *')
  }
  stages {
    stage('Checkout') {
      steps { checkout scm }
    }
    stage('Parallel Checks') {
      parallel {
        stage('Lint') { steps { sh 'pnpm lint' } }
        stage('Test') {
          when { not { expression { params.SKIP_TESTS } } }
          steps { sh 'pnpm test -- --ci' }
          post { always { junit 'reports/*.xml' } }
        }
      }
    }
    stage('Build & Push') {
      steps {
        withCredentials([usernamePassword(
          credentialsId: 'ghcr',
          usernameVariable: 'U', passwordVariable: 'P'
        )]) {
          sh '''
            echo "$P" | docker login ghcr.io -u "$U" --password-stdin
            docker build -t ghcr.io/mi-org/app:${IMAGE_TAG} .
            docker push ghcr.io/mi-org/app:${IMAGE_TAG}
          '''
        }
      }
    }
    stage('Deploy') {
      when { branch 'main' }
      input { message 'Deploy to prod?' ok 'Yes' submitter 'sre-team' }
      steps { sh "helm upgrade app charts/app --set image.tag=${IMAGE_TAG}" }
    }
  }
  post {
    always  { cleanWs() }
    failure { slackSend channel: '#alerts', message: "FAILED: ${env.BUILD_URL}" }
  }
}
```

### 6.3 Reglas de oro (`✅` hacer / `❌` evitar)

- ✅ **Pin actions con SHA** para actions de terceros (`uses: acme/foo@sha256`).
- ❌ **Nunca uses** `@main` o `@master` en actions no oficiales.
- ✅ **OIDC federation** contra AWS/GCP/Azure. Cero secrets estáticos.
- ❌ **No metas** `AWS_SECRET_ACCESS_KEY` en repo secrets si puedes evitarlo.
- ✅ **Permissions mínimos** por default (`permissions: read-all`) y elevar por job.
- ❌ **No dejes** el `GITHUB_TOKEN` con permisos por default en repos nuevos (revisa Settings).
- ✅ **Cache con `hashFiles`** sobre el lockfile.
- ❌ **No caches** con key basado en `github.sha` o timestamp (cero reutilización).
- ✅ **Concurrency group** por branch + `cancel-in-progress: true` en PRs.
- ❌ **No canceles** deploys a producción en curso.
- ✅ **Reusable workflows** para el mismo patrón de CI en múltiples repos.
- ❌ **No anides** reusable workflows más de 2 niveles en la práctica.
- ✅ **Composite actions** para 3-8 steps repetidos dentro del mismo repo.
- ❌ **No abuses** de composite actions para lógica compleja (usa un action JS o Docker).
- ✅ **Merge queue** en repos con >5 PRs/día contra el mismo branch.
- ❌ **No mezcles** GHA con Jenkins en el mismo pipeline sin razón concreta.
- ✅ **Environments** con protection rules para staging y production.
- ❌ **No apruebes** tu propio deploy (habilita "prevent self-review").

### 6.4 Tabla de decisión: GHA vs Jenkins vs GitLab CI vs CircleCI

| Situación | Recomendación 2026 |
|---|---|
| Repo en GitHub, equipo <30 personas, sin compliance especial | **GitHub Actions** con OIDC + ArgoCD |
| Repo en GitLab (self-hosted o SaaS) | **GitLab CI/CD** con Auto DevOps + Merge Trains |
| Enterprise con Jenkins funcional y auditado hace años | **Mantener Jenkins**; modernizar con Shared Libraries + Jenkins Modernization |
| Air-gapped, on-prem, sin acceso a marketplace SaaS | **Jenkins** o **Tekton** (Kubernetes-native) |
| Necesitas pipelines como CRDs de Kubernetes | **Tekton** + Argo Events |
| GPU builds, Windows XP, hardware exótico | **Jenkins** con agents dedicados o **GHA self-hosted** con ARC |
| Startup con foco en velocidad de iteración | **GitHub Actions** o **CircleCI** |
| Empresa con 200+ repos y patrón CI compartido | **GHA reusable workflows** o **Jenkins Shared Libraries** en repo central |
| CD GitOps declarativo | **ArgoCD** o **Flux** (GHA/Jenkins hacen CI, no CD) |
| Necesitas SDK programable en TypeScript/Go/Python | **Dagger** (compila a GHA, Jenkins, GitLab, CircleCI) |

---

## 7. Casos reales industria 2024-2026

**1. Microsoft — GitHub.com sobre GHA (dogfooding).** El monorepo Rails de `github/github` corre miles de workflows/día en larger runners de 16-core, con reusable workflows compartidos y merge queue desde su GA (jun 2023). Sin merge queue, el gap "PR verde" → "main verde" era ~4h por conflictos concurrentes; con merge queue, ~35 min y ~40 PRs/hora de throughput.

**2. Netflix — Jenkins + Spinnaker.** Netflix mantuvo (2015-2024) un Jenkins con 4.000+ jobs. Reemplazaron el orquestador de deploys por **Spinnaker** (open source, 2015) con canary analysis automatizado (Kayenta) y chaos testing (ChAP). En 2024-2025 migran CI a Bazel + BuildBarn interno, pero Spinnaker sigue vivo para CD.

**3. Shopify — Buildkite + Rails monolith.** Shopify corre >150.000 builds/día en Buildkite (agents self-hosted, control plane SaaS). Un solo test suite del monolito Ruby lleva 60.000+ tests paralelizados. Migración desde CircleCI en 2018-2019 motivada por control sobre agents Kubernetes-native y costo a escala.

**4. Airbnb — GHA + monorepo Node.** Airbnb migró de Buildkite a GHA (2022-2024) para muchos repos frontend, aprovechando path filters para minimizar builds en el monorepo Nx, con reusable workflows publicados en un repo shared para estandarizar CI de packages TypeScript.

**5. HashiCorp — GHA + ArgoCD.** HashiCorp usa GHA para CI de sus productos OSS (Terraform, Vault, Consul), con un reusable workflow `hashicorp/actions-shared/.github/workflows/product-ci.yml@v1`. Deploy interno via ArgoCD sobre AWS EKS multi-region con OIDC federation.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — Workflow básico con cache y artifact (nivel junior)

**Objetivo**: crear un workflow que instale deps con cache, corra tests y suba coverage como artifact.

**Setup**:
- Repo con un proyecto Node/pnpm (usa un workspace de LinguaDev, por ejemplo `apps/web`).
- Configura `package.json` con `test:coverage` que emita a `coverage/`.

**Pasos**:
1. Crea `.github/workflows/exercise-01.yml` con trigger `on: [push, pull_request]`.
2. Un job `test` en `ubuntu-latest`.
3. Steps: checkout, setup pnpm v9, setup Node 20 con `cache: 'pnpm'`.
4. Instala con `pnpm install --frozen-lockfile`.
5. Corre `pnpm --filter web test:coverage`.
6. Sube `apps/web/coverage/` como artifact `coverage-web` con retención 7 días.
7. Push a un branch, verifica que el workflow corre y que el artifact es descargable desde la UI.

**Criterios de aceptación**:
- [ ] El workflow corre exitosamente en el primer push.
- [ ] En el segundo push (sin cambios en `pnpm-lock.yaml`), el step de install muestra `cache hit`.
- [ ] El artifact `coverage-web` aparece en la UI y contiene `lcov.info`.
- [ ] Total run time <3 min tras cache hit.

**Bonus**: agrega un step con `codecov/codecov-action@v4` que suba el coverage a Codecov (requiere `CODECOV_TOKEN` para repos privados).

### Ejercicio 2 — Matrix build con exclusiones (nivel mid)

**Objetivo**: probar la app contra combinaciones de OS/Node minimizando costo.

**Pasos**:
1. Crea `.github/workflows/exercise-02.yml` con `strategy.matrix`.
2. Combinaciones: `os: [ubuntu-latest, macos-latest, windows-latest]`, `node: [18, 20, 22]`.
3. **Exclude** `windows-latest + node 18` (obsoleto en Windows) y `macos-latest + node 18`.
4. **Include** una combinación extra `os: ubuntu-latest, node: 22, coverage: true`.
5. Con `fail-fast: false` y `max-parallel: 5`.
6. En el step de test, usa `if: matrix.coverage` para correr solo en la combinación marcada.
7. Añade `timeout-minutes: 15` por job.

**Criterios de aceptación**:
- [ ] El workflow lanza exactamente 7 jobs (9 combinaciones - 2 exclude).
- [ ] Con `fail-fast: false`, si un job falla los demás siguen corriendo.
- [ ] Solo un job sube coverage.
- [ ] Un job que exceda 15 min es cancelado con exit code apropiado.

**Bonus**: mide el costo total en minutos y calcula el ahorro vs matriz completa (9 jobs).

### Ejercicio 3 — Reusable workflow + composite action (nivel senior)

**Objetivo**: extraer un pipeline repetido a componentes reutilizables.

**Pasos**:
1. Crea `.github/actions/setup-project/action.yml` como composite action que hace checkout, setup pnpm, setup Node con cache, e install.
2. Crea `.github/workflows/reusable-node-ci.yml` con `on: workflow_call`, inputs `workspace: string`, `node-version: string = '20'`.
3. Este reusable usa la composite action y luego corre `pnpm --filter ${{ inputs.workspace }} lint && test && build`.
4. Emite output `version` leyendo `package.json` con `jq`.
5. Crea `.github/workflows/ci-web.yml` y `.github/workflows/ci-api.yml` que invocan el reusable con distintos `workspace`.
6. Verifica que la composite se usa y que el output `version` propaga a un job downstream.

**Criterios de aceptación**:
- [ ] La composite action está en `.github/actions/setup-project/action.yml`.
- [ ] El reusable workflow tiene `on: workflow_call` con inputs tipados.
- [ ] Dos workflows caller invocan al reusable con distintos inputs.
- [ ] Un job downstream lee `needs.<job>.outputs.version` y lo imprime.
- [ ] Refactorizar la composite (cambiar Node 20 a 22 default) impacta ambos callers sin editar los callers.

**Bonus**: publica el reusable workflow en un repo separado (`mi-org/ci-workflows`) e invócalo con `uses: mi-org/ci-workflows/.github/workflows/reusable-node-ci.yml@v1` desde LinguaDev Pro.

### Ejercicio 4 — OIDC federation con AWS + deploy S3 (nivel senior)

**Objetivo**: eliminar secrets estáticos de AWS usando OpenID Connect.

**Setup**:
- Cuenta AWS con permisos para crear IAM.
- Bucket S3 `linguadev-web-staging`.

**Pasos**:
1. En AWS IAM, crea un **OIDC provider** apuntando a `https://token.actions.githubusercontent.com` con audience `sts.amazonaws.com`.
2. Crea un **IAM Role** `gha-linguadev-deploy` con trust policy que condicione `sub` a `repo:tu-org/linguadev-pro:ref:refs/heads/main`.
3. Adjunta al role una policy con permisos `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` sobre el bucket.
4. En `.github/workflows/deploy-staging.yml`, agrega `permissions: id-token: write, contents: read`.
5. Usa `aws-actions/configure-aws-credentials@v4` con `role-to-assume: arn:aws:iam::ACCOUNT:role/gha-linguadev-deploy`.
6. Verifica identidad con `aws sts get-caller-identity`.
7. Corre `aws s3 sync ./dist s3://linguadev-web-staging --delete`.
8. Elimina cualquier `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` de repo secrets.

**Criterios de aceptación**:
- [ ] `aws sts get-caller-identity` muestra el role asumido con session name que incluye `run_id`.
- [ ] El sync funciona y actualiza el bucket.
- [ ] En CloudTrail, `AssumeRoleWithWebIdentity` está registrado con el JWT claims del workflow.
- [ ] No hay AWS credentials estáticas en repo secrets.

**Bonus**: restringe el trust policy adicionalmente a `environment: staging` y crea un environment de GitHub con manual approval antes del deploy.

### Ejercicio 5 — Jenkinsfile declarativo con Shared Library (nivel senior)

**Objetivo**: extraer lógica común de un Jenkinsfile a una Shared Library reutilizable.

**Setup**: Jenkins 2.462+ LTS con Pipeline: Shared Groovy Libraries plugin.

**Pasos**:
1. Repo `jenkins-shared-lib` con `vars/nodeBuild.groovy` que recibe `Map config` con `nodeVersion`, `runTests`.
2. En Jenkins → Manage → System → Global Pipeline Libraries, registra la lib con Git SCM.
3. En el repo de la app, `Jenkinsfile` con `@Library('jenkins-shared-lib@v1') _` y llamada `nodeBuild(nodeVersion: '20', runTests: true)`.
4. Trigger el pipeline y verifica que resuelve correctamente.

**Criterios**:
- [ ] La lib está versionada con tags Git.
- [ ] El Jenkinsfile no repite lógica; solo invoca `nodeBuild(...)`.
- [ ] Bumpear la versión de la lib impacta a todos los consumidores.

**Bonus**: agrega tests unitarios con `JenkinsPipelineUnit`.

---

## 9. Recursos y siguientes pasos

**Docs oficiales**:
- GitHub Actions — https://docs.github.com/actions
- GitHub Actions Marketplace — https://github.com/marketplace?type=actions
- Jenkins User Documentation — https://www.jenkins.io/doc/
- Jenkins Pipeline Syntax — https://www.jenkins.io/doc/book/pipeline/syntax/
- GitLab CI/CD Reference — https://docs.gitlab.com/ee/ci/yaml/
- CircleCI Configuration Reference — https://circleci.com/docs/configuration-reference/
- Tekton Docs — https://tekton.dev/docs/
- ArgoCD Docs — https://argo-cd.readthedocs.io/

**Herramientas complementarias**:
- `act` (nektos/act) — correr workflows GHA localmente.
- `actionlint` — linter para workflows GHA.
- `zizmor` — auditor de seguridad para workflows GHA (2024+).
- `JenkinsPipelineUnit` — testing framework para Jenkinsfiles.
- Dagger — SDK programable multi-CI.

**Libros y guías**:
- *"Continuous Delivery with Docker and Jenkins"* — Rafal Leszko (3rd ed. 2022).
- *"Automating DevOps with GitLab CI/CD Pipelines"* — Christopher Cowell et al. (Packt 2023).
- GitHub Actions Cookbook — Michael Kaufmann (O'Reilly 2024).

**Siguientes capítulos del track**:
- [Cap 05 — Fundamentos Docker](./05-fundamentos-docker.md) para entender qué construyen tus pipelines.
- [Cap 15 — GitOps con ArgoCD y Flux](./15-gitops-con-argocd-y-flux.md) para completar la parte CD del ciclo.
- [Cap 11 — Kubernetes Security](./11-kubernetes-security.md) para endurecer los deploys que salen de tu pipeline.

---

## 10. Preguntas de práctica

- **20 preguntas** (junior → mid → senior) sobre GHA workflow syntax, Jenkins declarative vs scripted, matrix builds con include/exclude, reusable workflows, composite actions, secrets y OIDC, self-hosted runners con ARC, artifacts vs cache, Shared Libraries, ArgoCD como capa CD, y comparativa GHA/Jenkins/GitLab/CircleCI.
- **Tiempo estimado:** 30 min · **Pass:** 75% (15/20).
- **Fuente:** [`packages/content/src/tech/devops/sim-04-github-actions-and-jenkins.json`](../../packages/content/src/tech/devops/sim-04-github-actions-and-jenkins.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-04-github-actions-and-jenkins`

---

## Navegación

← [Cap 03](./03-git-workflows-y-branching.md) · [Índice](./README.md) · [Cap 05 →](./05-fundamentos-docker.md)
