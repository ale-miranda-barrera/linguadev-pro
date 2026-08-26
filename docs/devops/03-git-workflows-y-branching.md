# Capítulo 03 — Git workflows y branching strategies

> **Focus:** Trunk-based development (TBD) vs GitHub Flow vs GitFlow, PR review efectivo, protected branches y branch protection rules, code owners, merge queues (GA 2023), squash vs rebase vs merge commit, conventional commits + changelogs automáticos, monorepo vs multirepo, y las herramientas Git avanzadas (bisect, reflog, cherry-pick, hooks) que separan devs seniors de devs junior.
> **Áreas:** VCS · Colaboración · Revisión de código
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Familiaridad básica con Git (clone, commit, push, pull, branch, merge).
- Haber trabajado con al menos un servicio Git remoto (GitHub, GitLab, Bitbucket).
- Haber leído [Cap 01 — Cultura DevOps y DORA](./01-cultura-devops-y-dora.md) y [Cap 02 — Continuous Delivery](./02-fundamentos-de-continuous-delivery.md).
- Alguna experiencia con Pull Requests / Merge Requests como author y reviewer.

**Glosario mínimo:**
- **Branch**: en Git, un *pointer* móvil a un commit. No es una copia del código (a diferencia de SVN).
- **Trunk-based development (TBD)**: modelo con una única rama de larga vida (`main`/`trunk`); feature branches viven <2 días.
- **GitHub Flow**: variante simplificada: `main` + feature branches efímeros + PRs. Sin ramas `develop`, `release`, `hotfix`.
- **GitFlow** (Driessen, 2010): modelo con ramas de larga vida `develop`, `main`, `release/*`, `hotfix/*`, y feature branches.
- **Fast-forward merge**: cuando `main` no divergió, el merge simplemente mueve el pointer (sin commit de merge).
- **Merge commit**: commit especial con 2 padres que une dos branches divergentes.
- **Squash and merge**: colapsa todos los commits del PR en un único commit al mergear.
- **Rebase**: reescribe los commits de tu branch como si empezaran desde el HEAD actual de `main`.
- **Protected branch**: rama con reglas server-side que impiden ciertas operaciones (force push, delete, merge sin approvals).
- **Merge queue**: mecanismo que serializa merges probando cada PR contra `main` actualizado antes de mergear.
- **CODEOWNERS**: archivo que asigna reviewers automáticos por path.
- **Conventional Commits**: convención de formato de mensajes de commit (`type(scope): description`) para generar changelogs y semver automático.
- **Signed commits**: commits con firma criptográfica (GPG, SSH o S/MIME) para verificar autoría.

**Setup mínimo (2026):**

```bash
# Git 2.47+ (verificar)
git --version

# Configuración recomendada
git config --global user.name "Ana Martinez"
git config --global user.email "ana@linguadev.com"
git config --global init.defaultBranch main
git config --global pull.rebase true          # rebase por default en pull
git config --global rerere.enabled true       # recuerda resoluciones de conflict
git config --global rebase.autosquash true    # squash automático con fixup!
git config --global fetch.prune true          # limpia refs remotos borrados

# Firmar commits con SSH (más simple que GPG en 2026)
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true

# GitHub CLI
gh --version                                   # 2.60+
gh auth login

# Herramientas útiles
brew install lazygit                           # TUI para Git
brew install git-delta                         # diff viewer moderno
brew install pre-commit                        # hooks framework
npm i -g @commitlint/cli @commitlint/config-conventional
```

En 2026, Git 2.47 (octubre 2024) trajo mejoras significativas de rendimiento en `git status` para monorepos y stability al partial clone. GitHub deprecó el algoritmo SHA-1 puro; los repos nuevos usan SHA-1 con detección de colisión (SHAttered mitigation) y experimentalmente SHA-256.

---

## 1. El gran cuadro

Git es la infraestructura invisible sobre la que se construye todo el proceso DevOps moderno. Linus Torvalds lo creó en 2005 como respuesta al colapso de la relación entre kernel.org y BitKeeper, con dos objetivos: velocidad extrema y distribuir la fuente de verdad (ningún servidor central obligatorio). Veinte años después, Git es la base sobre la que se apoyan pipelines CI/CD, code review, deployment, incident response, compliance auditing y supply chain security. La estrategia de branching que elija tu equipo determina, más que casi cualquier otra decisión técnica, **cuán rápido puedes iterar** y **cuánto conflicto humano hay** en cada release.

La confusión central de la industria durante años fue asumir que "más branches = más control". GitFlow (Vincent Driessen, 2010) formalizó un modelo con `develop`, `release/*`, `hotfix/*` y `feature/*` que se adoptó masivamente en la primera década del 2010 porque coincidía con el modelo mental de software con versiones (desktop apps, mobile con App Store). Sin embargo, la investigación DORA y la evidencia de empresas Elite (Google, Amazon, Meta, Netflix) mostró consistentemente que **trunk-based development** (una sola rama principal con feature branches <2 días) correlaciona con equipos de alta performance. Vincent Driessen mismo publicó en 2020 una nota diciendo que GitFlow ya no es apropiado para la mayoría de equipos SaaS modernos.

El segundo pilar del capítulo es el **Pull Request como mecanismo de colaboración**. El PR (o Merge Request en GitLab) inventado por GitHub en 2008 se convirtió en el ritual central del desarrollo moderno: cambio propuesto + discusión + CI verde + review + merge. Este flujo, replicado por GitLab, Bitbucket y Azure DevOps, es el mecanismo donde se cristaliza la calidad. Un PR bien diseñado (pequeño, con contexto, con tests, con owner claro) mergea rápido y sin drama; un PR mal diseñado (mega-PR de 3000 líneas cruzando 20 módulos) se estanca semanas y frecuentemente termina abandonado. En 2023 GitHub lanzó **merge queue** (GA en julio 2023) que resuelve un problema técnico persistente: cómo mergear varios PRs a `main` sin romperla, testeando cada uno contra la versión más reciente de `main` en secuencia optimizada.

El tercer pilar son las **herramientas Git avanzadas** que rara vez aparecen en tutoriales pero son cotidianas para devs seniors: `git bisect` para encontrar qué commit introdujo un bug (búsqueda binaria automática), `git reflog` para recuperar branches "perdidos", `git cherry-pick` para portar commits entre branches, `git hooks` para automatizar validaciones locales, y firmas criptográficas para supply chain security. Combinado con convenciones como **Conventional Commits** (formato estandarizado de mensajes que genera changelogs automáticos y versiones semver), y **CODEOWNERS** (asignación automática de reviewers), el flujo Git moderno es una máquina precisa. Al final del capítulo tendrás claridad sobre qué estrategia usar según contexto, cómo diseñar branch protection rules efectivas, y cómo usar Git profundo para diagnosticar y recuperar.

---

## 2. Fundamentos (nivel básico)

### 2.1 Qué es un branch en Git

Un branch en Git es un **pointer** (archivo de <100 bytes) que apunta a un commit específico. NO es una copia del código. Todos los branches comparten los mismos objetos (blobs, trees, commits) en `.git/objects`. Solo cambia qué commit apunta cada branch.

```bash
# Crear branch = crear un archivo con el SHA del commit actual
cat .git/refs/heads/main
# e8c4a3d9b8...

git branch feature/lessons-v2
cat .git/refs/heads/feature/lessons-v2
# e8c4a3d9b8...   (mismo SHA, el branch se creó apuntando aquí)
```

Consecuencias prácticas:
- Crear branches es **instantáneo** (crea un archivo pequeño).
- Cambiar de branch es **rápido** (actualiza working directory).
- Puedes tener cientos de branches sin overhead.
- Diferencia clave vs SVN/CVS donde branches eran copias completas.

**HEAD**: pointer a "dónde estás". Puede apuntar a un branch (normal) o directamente a un commit (*detached HEAD*, peligroso porque commits pueden quedar huérfanos).

### 2.2 Los 3 workflows dominantes

| Workflow | Ramas de largo plazo | Feature branches | Cuándo usar |
|----------|----------------------|------------------|-------------|
| **Trunk-based** | `main` | <2 días, feature flags | SaaS moderno, Elite DORA |
| **GitHub Flow** | `main` | vive lo que dure el PR | Startups, servicios web |
| **GitFlow** | `main` + `develop` + `release/*` + `hotfix/*` | días-semanas | Software con releases versionadas, apps móviles |

Diagrama comparativo:

```
GITFLOW (2010, Driessen):
main    ●────────────●──────●    tags v1.0, v1.0.1
         \          /      /
release/1.0 ●───●──●      /
             \  \  \     /
develop  ●──●─●──●──●───●─●──●
          \  \  \    /
feat1      ●──●─●   /
feat2         ●─●──●

GITHUB FLOW (2011, Scott Chacon):
main ●──●──●──●──●──●──●──●──●
      \   \    \      \
feat1  ●──●     \      \
feat2     ●──●──●       \
feat3                    ●──●

TRUNK-BASED (Elite DORA):
main ●──●──●──●──●──●──●──●──●──●──●──●
      \  \    \     \     \    \
feat1  ●─●     \     \     \    \       (todos <2 días)
feat2     ●─●   \     \     \    \
feat3          ●─●     \     \    \
feat4                   ●─●   \    \
feat5                          ●─●  \
feat6                               ●─●
```

### 2.3 Merge vs rebase vs squash

Cuando tu feature branch está atrás de `main`, tienes 3 opciones para actualizarte y para mergear:

**Merge (crea merge commit):**
```bash
git checkout feature/x
git merge main
# Crea commit con 2 padres
```
- ✅ Preserva historia exacta.
- ❌ Historial se llena de merge commits ("noise").

**Rebase (reescribe historia):**
```bash
git checkout feature/x
git rebase main
# Toma tus commits, mueve HEAD a main, re-aplica commits
```
- ✅ Historial linear, git log limpio.
- ✅ `git bisect` más efectivo.
- ❌ Cambia SHAs (nunca rebases branches compartidas).

**Squash and merge:**
```bash
git checkout main
git merge --squash feature/x
git commit -m "feat(lessons): add v2 algorithm"
# Colapsa todos los commits del feature en 1
```
- ✅ Historial ultra-limpio (1 commit por feature).
- ❌ Pierdes granularidad interna del feature.

**Regla de oro** (Git docs): *"Never rebase a branch that has been pushed and that others may be working on"*. Tu propio feature branch (nadie más lo tiene) = rebase seguro. `main` compartida = NUNCA rebase.

**Recomendación 2026** para trunk-based:
- Rebase local para mantener tu branch al día.
- Squash-and-merge en la UI para mergear el PR (1 commit por feature en `main`).

### 2.4 Ejemplo mínimo: workflow trunk-based

```bash
# 1. Empezar feature
git checkout main
git pull --rebase
git checkout -b feat/lessons-recommendations

# 2. Trabajar (varios commits pequeños)
git commit -m "feat(lessons): add recommendation scoring"
git commit -m "test(lessons): cover recommendation edge cases"

# 3. Antes del PR, rebase para tener commits limpios
git fetch origin
git rebase origin/main
# resolver conflictos si los hay
git push --force-with-lease   # SÍ, force push a TU branch (nadie más la usa)

# 4. Abrir PR
gh pr create --title "feat(lessons): recommendation v2" \
             --body "Ver ADR-042. Detrás del flag 'lesson-rec-v2'."

# 5. Después de aprobado, squash-merge desde la UI
# o desde CLI:
gh pr merge --squash --delete-branch
```

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Anatomía interna de Git

Git tiene 4 tipos de objetos, todos hasheados con SHA-1 (SHA-256 experimental desde Git 2.29):

```
BLOB    - contenido de un archivo (sin nombre, sin permisos)
TREE    - directorio: lista de blobs y trees con nombres y permisos
COMMIT  - snapshot: apunta a un tree + metadata (author, message, parents)
TAG     - referencia con anotación (usualmente para releases)
```

Ejemplo real:

```bash
# Ver un commit descomprimido
git cat-file -p HEAD
# tree 8f7e2a1b3c...
# parent d4c8b9a2...
# author Ana <ana@linguadev.com> 1731668234 +0100
# committer Ana <ana@linguadev.com> 1731668234 +0100
#
# feat(lessons): add v2 algorithm

git cat-file -p 8f7e2a1b3c
# 100644 blob a1b2c3...    README.md
# 040000 tree e5f6g7...    src/
# 100644 blob h8i9j0...    package.json
```

**Refs**: pointers a commits, almacenados en `.git/refs/`:
- `refs/heads/*` — branches locales
- `refs/remotes/origin/*` — remote-tracking branches
- `refs/tags/*` — tags
- `HEAD` — pointer al branch (o commit) actual

**Packfiles**: cuando el repo crece, Git empaqueta objetos en `.git/objects/pack/*.pack` con compresión delta para eficiencia. `git gc` los reorganiza.

### 3.2 Branch protection rules efectivas

Reglas server-side que protegen `main` de operaciones destructivas o revisiones insuficientes:

**En GitHub (Settings → Branches → Add rule):**

```yaml
# Protección típica para main de producción
Branch name pattern: main
Rules:
  - Require pull request before merging
    - Require approvals: 1 (o 2 para código crítico)
    - Dismiss stale approvals when new commits pushed
    - Require review from Code Owners
    - Require conversation resolution before merging
  - Require status checks to pass
    - Require branches to be up to date before merging
    - Required checks: [ci/build, ci/test, ci/lint, security/scan]
  - Require signed commits
  - Require linear history        # obliga a squash o rebase
  - Require deployments to succeed
  - Do not allow bypassing the above settings
  - Restrict who can push (empty = nadie, solo merge de PR)
  - Do not allow force pushes
  - Do not allow deletions
```

Para monorepos, considera diferentes reglas por path via **branch rulesets** (feature 2023-2024 en GitHub):

```yaml
- Pattern: main
- Bypass list: (vacío)
- Target: everything
- Path-based enforcement:
    - /apps/api/**: requiere 2 approvals + code owner @backend
    - /infra/**: requiere approval de @sre-team + status check terraform-plan
    - /docs/**: requiere 1 approval de cualquiera
```

### 3.3 CODEOWNERS: reviewers automáticos

Archivo `.github/CODEOWNERS` (o `CODEOWNERS` en la raíz):

```
# Sintaxis: <patrón> <owners>

# Default: cualquier PR requiere revisión del eng team
*                       @linguadev/eng

# Backend
/apps/api/              @linguadev/backend
/apps/api/auth/         @linguadev/security @linguadev/backend

# Frontend
/apps/web/              @linguadev/frontend

# Infra (bloqueado, requiere SRE)
/infra/                 @linguadev/sre
/.github/workflows/     @linguadev/sre @linguadev/security

# Docs
/docs/                  @linguadev/tech-writers

# Package.json changes touch supply chain → security team
package.json            @linguadev/security
package-lock.json       @linguadev/security
pnpm-lock.yaml          @linguadev/security
```

Combinado con "Require review from Code Owners" en branch protection, GitHub añade automáticamente los owners al PR y bloquea el merge sin su aprobación.

### 3.4 Merge queue (GA 2023)

Problema histórico: si 5 PRs pasan CI simultáneamente contra `main` en el commit X, cuando se mergea el primero (`main` avanza a X+1), los otros 4 fueron probados contra código desactualizado. Cualquiera podría romper `main`.

**Merge queue** (GitHub, GA julio 2023; equivalentes: GitLab Merge Trains 2018, Zuul de OpenStack, Bors de Rust):

```
1. Dev marca PR como "ready to merge" (queue it).
2. GitHub añade el PR a una cola.
3. Sistema hace un merge tentativo con main actual + PR + PRs anteriores en cola.
4. Corre CI en ese merge tentativo.
5. Si CI pasa, mergea a main real.
6. Si CI falla, saca el PR de la cola con feedback.
7. Optimización: puede batchear varios PRs juntos si son independientes.
```

Configuración GitHub:

```yaml
# En branch protection rule
Require merge queue: enabled
Merge method: squash
Build concurrency: 5           # hasta 5 PRs en paralelo
Minimum entries to merge: 1
Maximum entries to merge: 5
Maximum entries to build: 5
Wait time to merge: 5 minutes
```

Resultado: `main` NUNCA está rota. Los devs no pierden tiempo re-testeando manualmente. Adoptado masivamente en proyectos grandes desde 2023: Kubernetes, TypeScript, Next.js, Rust (con Bors, que fue el precursor).

### 3.5 Conventional Commits y changelogs automáticos

Convención (spec 1.0.0, 2019+) que estandariza mensajes de commit:

```
<type>(<scope>): <description>

[body opcional]

[footer opcional]
```

Types canónicos:
- `feat`: nueva feature (→ MINOR en semver)
- `fix`: bug fix (→ PATCH en semver)
- `docs`: solo documentación
- `style`: formato, sin cambio de código
- `refactor`: refactor sin cambio de comportamiento
- `perf`: mejora de performance
- `test`: añadir/corregir tests
- `build`: cambios en build system, deps
- `ci`: cambios en CI
- `chore`: mantenimiento
- `revert`: revierte un commit anterior

**Breaking change**: `feat!:` o `BREAKING CHANGE:` en footer (→ MAJOR en semver).

Ejemplos:

```
feat(lessons): add recommendation v2 algorithm

Implements the scoring described in ADR-042.
Feature is gated behind 'lesson-rec-v2' flag (default OFF).

Refs: #234
```

```
fix(auth): prevent session fixation on login

Regenerate session ID after successful login to prevent
session fixation attacks (OWASP A07:2021).

Fixes: #489
```

```
feat(api)!: remove deprecated /v1 endpoints

BREAKING CHANGE: /v1/* endpoints removed. Migrate to /v2/*.
Deprecation notice was published 2026-06-01.
```

**Herramientas automáticas:**

```bash
# Validar commits localmente (commitlint)
npm i -D @commitlint/{cli,config-conventional}
echo "module.exports = {extends: ['@commitlint/config-conventional']}" > commitlint.config.js

# Hook con Husky
npm i -D husky
npx husky init
echo 'npx --no -- commitlint --edit "$1"' > .husky/commit-msg

# Generar changelog + version bump automático (release-please de Google)
# .github/workflows/release-please.yml
name: release-please
on:
  push:
    branches: [main]
jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          release-type: node
```

Cada commit con `feat:` genera un bump minor; `fix:` patch; `feat!:` major. Release-please abre un PR con changelog generado y bump de versión. Merge → tag + release automáticos.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 git bisect: encontrar el commit culpable

Cuando un bug aparece y no sabes qué commit lo introdujo, `git bisect` hace búsqueda binaria automática:

```bash
# 1. Marcar el commit malo (actual) y uno bueno conocido
git bisect start
git bisect bad HEAD
git bisect good v2.140      # tag/commit donde funcionaba

# Git hace checkout de un commit intermedio
# 2. Probar (manual o automático)
npm test          # o el script que reproduce el bug

# 3. Marcar según el resultado
git bisect good   # si el commit está OK
# o
git bisect bad    # si el bug ya estaba

# Git elige el siguiente commit intermedio, iterando log(N) veces
# Al final:
# 8f7a1b2c... is the first bad commit

# 4. Terminar bisect
git bisect reset
```

**Bisect automático** (para tests reproducibles):

```bash
git bisect start HEAD v2.140
git bisect run npm test
# Git ejecutará npm test en cada commit intermedio y decidirá good/bad
# por el exit code (0 = good, ≠0 = bad)
```

Con 128 commits entre bueno y malo, bisect encuentra el culpable en **7 iteraciones** (log2 128 = 7). En un repo grande, es mágico.

### 4.2 git reflog: la red de seguridad

`git reflog` es el historial local de movimientos de HEAD. **Sobrevive incluso a operaciones destructivas** durante ~90 días (configurable con `gc.reflogExpire`).

Escenario típico: haces `git reset --hard` accidentalmente y "pierdes" commits.

```bash
# Ver historial de HEAD
git reflog
# HEAD@{0} reset: moving to HEAD~5
# HEAD@{1} commit: fix(api): typo
# HEAD@{2} commit: feat(api): new endpoint
# HEAD@{3} pull: Fast-forward
# ...

# Recuperar el estado antes del reset
git reset --hard HEAD@{1}
# o
git checkout HEAD@{1}
```

Escenario "borré un branch":

```bash
git branch -D feat/lessons-v2
# Deleted branch feat/lessons-v2 (was 8f7a1b2c).

# Reflog tiene el SHA
git branch feat/lessons-v2 8f7a1b2c
# Restaurado
```

Regla: **Git rara vez pierde datos**. Si sientes que perdiste algo, revisa reflog primero.

### 4.3 git cherry-pick: portar commits selectivamente

Casos de uso legítimos:
- Aplicar un hotfix urgente a `main` y también a `release/1.x`.
- Recuperar un commit específico de un branch abandonado.
- Backportar una feature entre ramas de largo plazo (típico en OSS con múltiples versiones soportadas).

```bash
# Cherry-pick de un commit
git checkout release/1.x
git cherry-pick 8f7a1b2c

# Cherry-pick de rango
git cherry-pick a1b2c3..d4e5f6

# Cherry-pick sin auto-commit (para editar)
git cherry-pick -n 8f7a1b2c
```

**Anti-patrón**: cherry-pick abusivo entre feature branches largas. Genera commits duplicados con SHAs distintos, dificulta merge/rebase. Prefiere rebase interactivo cuando sea posible.

### 4.4 Git hooks: automatización local

Hooks son scripts que Git ejecuta en momentos específicos. Viven en `.git/hooks/` (locales, no versionados) o gestionados por **pre-commit** (framework Python, cross-language).

**pre-commit.com** (estándar 2020+):

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-added-large-files
        args: [--maxkb=500]

  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.20.0
    hooks:
      - id: gitleaks          # detecta secretos leaked

  - repo: https://github.com/pre-commit/mirrors-eslint
    rev: v9.13.0
    hooks:
      - id: eslint

  - repo: https://github.com/commitizen-tools/commitizen
    rev: v3.30.0
    hooks:
      - id: commitizen        # valida conventional commits
        stages: [commit-msg]
```

Instalar:

```bash
pipx install pre-commit
pre-commit install               # instala los hooks git
pre-commit install --hook-type commit-msg
pre-commit run --all-files       # correr contra todo el repo
```

Hooks server-side (GitHub App, GitLab push rules): validan lo que llega al servidor. Los locales son sugerencia; los server-side son ley.

### 4.5 Signed commits: supply chain security

Firmar commits verifica que fueron autorizados por quien dice ser. Especialmente crítico tras casos como **XZ Utils backdoor (marzo 2024)**, donde un mantainer legítimo fue comprometido y push malicioso pasó "verificado".

**SSH signing** (recomendado 2026, más simple que GPG):

```bash
# Configurar
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true

# Añadir en GitHub: Settings → SSH keys → Signing key
# (distinta del auth key, aunque puede ser el mismo file)

# Firmar y verificar
git commit -m "feat: signed commit"
git log --show-signature
# gpg: Signature made ...
# gpg: Good signature from "Ana <ana@linguadev.com>" [ultimate]
```

**Sigstore gitsign** (2024+, keyless):

```bash
# Firma con OIDC (Google/GitHub identity) → cert efímero → Rekor transparency log
brew install sigstore/tap/gitsign

git config --global gpg.x509.program gitsign
git config --global gpg.format x509
git config --global commit.gpgsign true

# Al commitear, se abre browser para OIDC login
git commit -m "feat: sigstore signed"
# Firma queda en Rekor (immutable log público)
```

En branch protection: "Require signed commits" bloquea PRs con commits no firmados.

### 4.6 Monorepo vs multirepo (polyrepo)

**Monorepo**: un solo repo para múltiples proyectos.
- Ejemplos: Google (unificado desde 2000s), Meta, Twitter/X, Uber, Airbnb, Shopify, Babel, React (Meta), Next.js (Vercel).
- Herramientas 2026: **Nx** (JS/TS + otros), **Turborepo** (Vercel), **Bazel** (Google), **Buck2** (Meta 2024), **Pants** (Twitter/Toolchain), **Rush** (Microsoft).

**Multirepo (polyrepo)**: un repo por proyecto/microservicio.
- Ejemplos: Netflix, Amazon (mayoritariamente).

Trade-offs:

| Aspecto | Monorepo | Multirepo |
|---------|----------|-----------|
| Refactor cross-project | ✅ 1 PR atómico | ❌ N PRs coordinados |
| Ownership claro | ⚠️ requiere CODEOWNERS | ✅ un equipo = un repo |
| Build/CI velocidad | ❌ requiere caching agresivo | ✅ scope pequeño natural |
| Dep versioning | ✅ single version por dep | ❌ dep hell posible |
| Onboarding | ⚠️ overwhelming | ✅ scope pequeño |
| Herramientas | Nx, Turbo, Bazel obligatorias | Estándar |

**LinguaDev Pro** es monorepo (pnpm workspaces). Los ejemplos del capítulo aplican.

### 4.7 Anti-patrones documentados

**"Long-lived feature branches"**: rama de un dev que vive semanas o meses. Cuando se intenta mergear, conflictos masivos ("merge hell") y regresiones difíciles de trackear. Elite performers no lo permiten (>2 días es smell).

**"Master es sagrado, nadie toca"**: cuando el fear del merge lleva a batches enormes. Signal de que CI/CD no es confiable. Fix: mejorar tests, no ralentizar deploys.

**"Force push a shared branches"**: `git push --force` a `main` o `develop` **destruye** trabajo de otros devs. Siempre `--force-with-lease` (solo pushea si nadie más pusheó desde tu último fetch). Nunca a branches compartidas.

**"Commits gigantes sin scope"**: `git commit -m "fixes"` con 50 archivos tocados. Imposible de reviewear, de bisectar, de revertir. Regla: 1 commit = 1 idea coherente.

**"Merge commit por default"**: `git config merge.ff false` global. Genera merge commits innecesarios. Fast-forward cuando aplique es más limpio.

**"Rebase de branches compartidas"**: rebase de `main` o cualquier branch compartida. Cambia SHAs, rompe clones de otros devs. **NUNCA**.

**"CODEOWNERS abandonado"**: file existe pero owners son equipos que se disolvieron o personas que se fueron. PRs se bloquean indefinidamente. Auditar trimestralmente.

**"Signed commits opcionales"**: si no está enforced en branch protection, ~5% del equipo lo hace y el resto no. Sin enforcement, cero valor de seguridad.

---

## 5. Ejemplo práctico completo: workflow trunk-based end-to-end

**Contexto.** Equipo de 8 devs en LinguaDev Pro (monorepo pnpm). Migran de GitFlow a trunk-based con merge queue, conventional commits, CODEOWNERS, signed commits.

**Paso 1 — Configurar branch protection en `main`:**

```bash
# Via GitHub API (o UI: Settings → Branches → Add rule)
gh api -X PUT "repos/linguadev/linguadev-pro/branches/main/protection" \
  -f "required_status_checks[strict]=true" \
  -f "required_status_checks[contexts][]=ci/build" \
  -f "required_status_checks[contexts][]=ci/test" \
  -f "required_status_checks[contexts][]=ci/lint" \
  -f "required_status_checks[contexts][]=security/scan" \
  -f "enforce_admins=true" \
  -f "required_pull_request_reviews[required_approving_review_count]=1" \
  -f "required_pull_request_reviews[dismiss_stale_reviews]=true" \
  -f "required_pull_request_reviews[require_code_owner_reviews]=true" \
  -f "required_linear_history=true" \
  -f "required_signatures=true" \
  -f "allow_force_pushes=false" \
  -f "allow_deletions=false"
```

**Paso 2 — Crear CODEOWNERS:**

```
# .github/CODEOWNERS
*                                    @linguadev/eng

/packages/api/                       @linguadev/backend
/packages/api/auth/                  @linguadev/security @linguadev/backend
/packages/web/                       @linguadev/frontend
/packages/content/                   @linguadev/content-team
/packages/mobile/                    @linguadev/mobile

/infra/                              @linguadev/sre
/.github/workflows/                  @linguadev/sre @linguadev/security
/docs/                               @linguadev/tech-writers

package.json                         @linguadev/security
pnpm-lock.yaml                       @linguadev/security
```

**Paso 3 — Configurar conventional commits + release-please:**

```bash
# En el repo
pnpm add -Dw @commitlint/cli @commitlint/config-conventional husky
pnpm exec husky init
echo 'pnpm exec commitlint --edit "$1"' > .husky/commit-msg
```

```javascript
// commitlint.config.js
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'feat', 'fix', 'docs', 'style', 'refactor', 'perf',
      'test', 'build', 'ci', 'chore', 'revert',
    ]],
    'scope-enum': [2, 'always', [
      'api', 'web', 'mobile', 'content', 'infra', 'ci', 'deps',
    ]],
    'header-max-length': [2, 'always', 100],
  },
};
```

```yaml
# .github/workflows/release-please.yml
name: release-please
on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          release-type: node
          config-file: .release-please-config.json
          manifest-file: .release-please-manifest.json
```

```json
// .release-please-config.json (monorepo)
{
  "packages": {
    "packages/api": {"release-type": "node"},
    "packages/web": {"release-type": "node"},
    "packages/mobile": {"release-type": "node"}
  },
  "plugins": [{"type": "node-workspace"}],
  "changelog-sections": [
    {"type": "feat", "section": "Features"},
    {"type": "fix", "section": "Bug Fixes"},
    {"type": "perf", "section": "Performance"},
    {"type": "revert", "section": "Reverts"},
    {"type": "docs", "section": "Documentation", "hidden": false},
    {"type": "refactor", "section": "Code Refactoring", "hidden": true}
  ]
}
```

**Paso 4 — Habilitar merge queue:**

```bash
gh api -X PUT "repos/linguadev/linguadev-pro/branches/main/protection" \
  --field "required_pull_request_reviews[require_last_push_approval]=false" \
  --field "merge_queue[merge_method]=SQUASH" \
  --field "merge_queue[max_entries_to_build]=5" \
  --field "merge_queue[max_entries_to_merge]=5" \
  --field "merge_queue[min_entries_to_merge]=1" \
  --field "merge_queue[wait_time_to_merge]=5"
```

**Paso 5 — Configurar signed commits en el equipo:**

Enviar guide interno:

```markdown
# Setup de signed commits (obligatorio desde 2026-11-01)

1. Genera una key SSH (o usa la existente):
   ssh-keygen -t ed25519 -C "ana@linguadev.com"

2. Añade a GitHub como SIGNING KEY (no auth key):
   Settings → SSH and GPG keys → Add SSH key → Type: Signing Key

3. Configura Git localmente:
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/id_ed25519.pub
   git config --global commit.gpgsign true
   git config --global tag.gpgsign true

4. Verifica:
   git commit --allow-empty -m "test: signed commit"
   git log -1 --show-signature
```

**Paso 6 — Workflow diario de un dev:**

```bash
# 1. Actualizar
git checkout main
git pull --rebase

# 2. Crear feature branch (nombre descriptivo)
git checkout -b feat/api-recommendations-v2

# 3. Trabajar con commits pequeños y conventional
git add packages/api/src/recommendations/
git commit -m "feat(api): add scoring algorithm v2"
# commitlint valida el mensaje

git add packages/api/tests/
git commit -m "test(api): cover recommendations edge cases"

# 4. Antes del PR, rebase para actualizar y limpiar
git fetch origin
git rebase -i origin/main
# (opcional) squash de commits WIP con 'fixup!'

git push --force-with-lease origin feat/api-recommendations-v2

# 5. Abrir PR
gh pr create \
  --title "feat(api): recommendations v2" \
  --body "$(cat <<'EOF'
## Summary
Implements new scoring algorithm per ADR-042.

## Changes
- New `RecommendationScorerV2` class
- Feature-flagged via `lesson-rec-v2` (default OFF)
- Unit + integration tests

## Test plan
- [x] Unit tests pass (+ new coverage: 96%)
- [x] Integration tests with test data
- [x] Manual smoke: `/api/lessons/recommendations` with flag ON

Refs: #234
EOF
)"

# 6. Automáticamente:
# - CODEOWNERS asigna @linguadev/backend como reviewer
# - CI corre (build/test/lint/security scan)
# - Se requiere 1 approval

# 7. Después de approval:
gh pr merge --auto --squash --delete-branch
# --auto: mergea cuando todos los checks pasen y CODEOWNERS aprueben
# Se añade a merge queue automáticamente

# 8. Merge queue procesa:
# - Toma el PR + main actual + PRs previos en cola
# - Corre CI en ese merge tentativo
# - Si pasa → mergea a main real
# - release-please detecta 'feat:' → abre PR con bump minor + changelog
```

Este setup produce: `main` siempre verde, historial linear, changelogs y versiones automáticas, ownership claro, commits firmados, y ~15 min de commit a merge.

---

## 6. Cheatsheet y anti-patrones

### Cheatsheet: comandos Git avanzados

```
git bisect start HEAD v2.140              # buscar culpable entre HEAD y v2.140
git bisect run npm test                   # automático con test script

git reflog                                # ver movimientos de HEAD
git reset --hard HEAD@{1}                 # volver 1 movimiento atrás

git cherry-pick 8f7a1b2c                  # portar un commit
git cherry-pick -n 8f7a1b2c               # sin auto-commit

git rebase -i HEAD~5                      # rebase interactivo últimos 5
git rebase --autosquash HEAD~5            # squash automático con fixup!
git commit --fixup=8f7a1b2c               # marcar como fixup del commit X

git push --force-with-lease               # force push seguro (solo si nadie más pusheó)
git switch --detach HEAD~3                # detached HEAD explícito (safer)

git log --oneline --graph --all           # visualizar grafo
git log --follow -p FILE                  # historial de un archivo (incluso renames)
git log --grep="fix.*login"               # buscar en messages
git log -S"getUserPlan"                   # buscar cuándo apareció/desapareció un string

git diff --stat main..HEAD                # summary de cambios vs main
git diff --word-diff                      # diff a nivel palabra

git blame -L 42,60 file.js                # blame de líneas 42-60
git blame -w -M -C file.js                # ignora whitespace, detecta moves

git clean -fdx                            # limpiar untracked (peligroso, incluye ignored)
git clean -fd --dry-run                   # ver qué se limpiaría
```

### Tabla decisión: qué workflow usar

| Contexto | Workflow |
|----------|----------|
| SaaS moderno, equipo maduro, CI robusto | Trunk-based + feature flags |
| Startup pequeña, servicios web | GitHub Flow |
| Mobile app con App Store releases | GitFlow (o TBD + release branches al momento del release) |
| Software con múltiples versiones soportadas (OSS libraries) | Trunk-based + release/x.y branches para backports |
| Software desktop con releases versionadas | GitFlow o similar |
| Equipo pequeño con CI poco maduro | GitHub Flow (menos complejo que GitFlow) |

### ✅ Buenas prácticas

- ✅ Trunk-based si tu CI es confiable (elite DORA).
- ✅ Commits pequeños, atómicos, con mensaje Conventional Commits.
- ✅ Feature branches <2 días; si necesitas más, feature flag y mergea WIP.
- ✅ Branch protection en `main`: reviews + status checks + linear history + signed commits + no force push.
- ✅ CODEOWNERS actualizado (auditar trimestralmente).
- ✅ Merge queue si tu equipo tiene ≥5 devs mergeando frecuentemente.
- ✅ Signed commits obligatorios (SSH signing o Sigstore gitsign).
- ✅ Pre-commit hooks para gitleaks, linters, formato.
- ✅ `git rerere` habilitado (recuerda resoluciones de conflict).
- ✅ Reflog es tu red de seguridad — antes de reset --hard, respira.

### ❌ Anti-patrones

- ❌ Long-lived feature branches (>2 días).
- ❌ Force push a branches compartidas.
- ❌ Rebase de branches compartidas.
- ❌ `git commit -m "fixes"` con 50 archivos.
- ❌ GitFlow por default en SaaS 2026.
- ❌ CODEOWNERS abandonado con equipos disueltos.
- ❌ Signed commits sin enforcement en branch protection.
- ❌ Cherry-pick abusivo entre branches largas.
- ❌ `main` sin protection (cualquiera pushea directo).
- ❌ Squash indiscriminado que borra historia útil de features grandes complejos.

---

## 7. Casos reales de industria (2024-2026)

**GitHub Merge Queue GA (julio 2023, madurez 2024)**: pasó de beta a GA en julio 2023. En 2024 se estabilizó y añadió soporte para path-based rules. Adoptado por proyectos grandes: Kubernetes (~90% de PRs via merge queue), TypeScript, Next.js, Vercel, Shopify. Reduce dramáticamente los "green main was broken" incidents.

**GitLab 17 (mayo 2024) → 18 (mayo 2025)**: Merge trains (equivalente de merge queue) recibieron mejoras de concurrencia y observability. GitLab 17.6 añadió "merge request analytics" con métricas DORA nativas. En 2025 GitLab 18 introdujo AI-assisted code review con auto-summarization de MRs grandes.

**Kubernetes migration to Prow → merge queue (2023-2024)**: Kubernetes históricamente usó Prow (test orchestrator custom) con "tide" (predecesor conceptual de merge queue). En 2024 migró parcialmente a GitHub merge queue para reducir infra custom.

**XZ Utils backdoor (marzo 2024)**: uno de los casos de supply chain más importantes del año. Un maintainer legítimo (Jia Tan) fue "socialmente ingeniado" durante 2+ años y logró introducir un backdoor en xz-utils que afectaba OpenSSH via systemd. Detectado casualmente por Andres Freund (Microsoft) por regresión de performance en pruebas Postgres. Refuerza importancia de: signed commits verificables (SLSA + Sigstore), reproducible builds, code review con múltiples ojos independientes.

**GitHub Actions provenance attestations (mayo 2024)**: GitHub añadió soporte nativo para generar SLSA v1 provenance attestations desde workflows, sin herramientas externas. Combinado con Sigstore/Rekor para verificabilidad pública. Adoptado por npm en agosto 2024 (provenance visible en npmjs.com).

**Sigstore gitsign (2023-2024)**: keyless signing con OIDC + certs efímeros + Rekor transparency log. Alternativa a GPG/SSH signing sin gestión de keys. Adoptado por proyectos CNCF (Sigstore graduó en 2023).

**GitHub CLI 2.60+ (2024-2025)**: mejoras significativas en `gh copilot` (LLM-powered command help), `gh api` con soporte GraphQL nativo, `gh pr create --draft --auto-fill` que rellena title/body del último commit. En 2025 se añadió `gh models` para probar modelos IA desde CLI.

**Nx 20+ / Turborepo 2.x (2024)**: herramientas de monorepo maduran. Nx 20 (2024) introdujo "affected commands" mejorados con cache remoto federado. Turborepo 2.0 (mayo 2024) simplificó API y añadió mejor soporte para lenguajes no-JS.

**Rust merge queue con Bors (histórico, sigue en 2026)**: Rust ha usado Bors (bors-ng, homu) desde ~2013 como precursor conceptual del merge queue. Cada PR se prueba against `master` + otros PRs pendientes antes de mergear. GitHub Merge Queue moderno es esencialmente la generalización de este patrón. Rust sigue usando Bors en algunos repos por customización.

**Deprecación de SHA-1 puro en GitHub (2024)**: GitHub y otros hosts implementaron detección de colisión SHA-1 (SHAttered mitigation) por default. Git SHA-256 sigue experimental en 2026, con adopción baja por incompatibilidad de tooling.

**Conventional Commits en 90%+ de proyectos OSS grandes (2024)**: adopción prácticamente universal en proyectos con release automation (release-please, semantic-release, changesets). Google, Angular, ESLint, Prettier, VSCode adoptaron el estándar.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — Instrumentar branch protection en un repo (30 min)

**Objetivo:** aplicar reglas de protección a `main` en un repo real.

**Setup:**
- Un repo GitHub (puede ser un fork/personal).
- Permisos de admin.
- GitHub CLI configurado.

**Pasos:**
1. Habilitar via UI o API: PR obligatorio, 1 approval, dismiss stale, code owner review, status checks (agrega 2 falsos que crearás), linear history, signed commits, no force push, no deletions.
2. Crear un CODEOWNERS mínimo (`* @tu-usuario`).
3. Intentar hacer un push directo a `main` — debe fallar.
4. Crear un PR sin approvals — verificar que no se puede mergear.
5. Documentar todos los settings en un `docs/branch-protection.md`.

**Criterios de aceptación:**
- [ ] `git push origin main` desde local es rechazado.
- [ ] PR sin approvals no puede ser mergeado.
- [ ] PR sin CODEOWNERS review no puede ser mergeado.
- [ ] Commit sin firma es rechazado.
- [ ] Documentado en el repo.

**Bonus:** añade merge queue y prueba con 3 PRs simultáneos.

---

### Ejercicio 2 — Setup conventional commits + release-please (1h)

**Objetivo:** automatizar changelog y versionado.

**Setup:**
- Repo Node.js.
- pnpm/npm.

**Pasos:**
1. Instalar commitlint + husky.
2. Configurar hook `commit-msg`.
3. Añadir workflow `release-please.yml`.
4. Hacer 5 commits: 2 `feat`, 2 `fix`, 1 `feat!` (breaking).
5. Mergear → verificar que release-please abre PR con bump apropiado.
6. Mergear ese PR → verificar tag + release + changelog.

**Criterios de aceptación:**
- [ ] Commits que no cumplen convención son rechazados localmente.
- [ ] Release-please genera PR con bump MAJOR por el `feat!`.
- [ ] CHANGELOG.md se genera automáticamente.
- [ ] Tag Git creado.
- [ ] GitHub Release publicado.

**Bonus:** integrar con GHA para publicar a npm registry en el mismo workflow.

---

### Ejercicio 3 — Bisect para encontrar un bug (45 min)

**Objetivo:** usar `git bisect` para encontrar el commit culpable de un bug.

**Setup:**
- Un repo con historial de al menos 50 commits.
- Un test unitario o script que reproduce el bug (exit 0 = OK, ≠0 = bug).
- Identificar un commit "bueno conocido" (ej: hace 30 commits).

**Pasos:**
1. `git bisect start HEAD <commit-bueno>`.
2. Ejecutar `git bisect run <script-test>`.
3. Esperar a que bisect encuentre el culpable.
4. Verificar manualmente el commit culpable.
5. Terminar con `git bisect reset`.

**Criterios de aceptación:**
- [ ] Bisect completó en <10 iteraciones para 128 commits.
- [ ] Commit culpable identificado.
- [ ] Documentado en un post-mortem interno.

**Bonus:** hazlo con test flaky manejando el caso "skip" (`git bisect skip`).

---

### Ejercicio 4 — Setup signed commits (30 min)

**Objetivo:** que todos tus commits futuros estén firmados y verificados.

**Setup:**
- SSH key existente o nueva (`ssh-keygen -t ed25519`).
- Cuenta GitHub.

**Pasos:**
1. Añadir la SSH key como **Signing Key** (además de Auth Key) en GitHub.
2. Configurar Git para SSH signing.
3. Habilitar `commit.gpgsign` y `tag.gpgsign`.
4. Hacer un commit test.
5. Verificar con `git log --show-signature` local.
6. Push y verificar el badge "Verified" en GitHub.

**Criterios de aceptación:**
- [ ] Commits nuevos muestran "Verified" en GitHub.
- [ ] `git log --show-signature` muestra "Good signature".
- [ ] Tag nuevo también firmado.

**Bonus:** configurar branch protection "Require signed commits" y verificar que rechaza PRs con commits no firmados.

---

### Ejercicio 5 — Migrar un proyecto de GitFlow a Trunk-based (variable, 1-2 días)

**Objetivo:** planificar y ejecutar la migración de un equipo real.

**Setup:**
- Un proyecto donde actualmente usan GitFlow.
- Buy-in del tech lead + eng manager.

**Pasos:**
1. Documentar el estado actual: DORA metrics, tiempo de release, merge conflicts frecuentes.
2. Escribir ADR justificando la migración (usa plantilla del [Cap 01](./01-cultura-devops-y-dora.md)).
3. Fase 1: acortar feature branches (target <5 días).
4. Fase 2: introducir feature flags para features grandes.
5. Fase 3: eliminar `develop` — todo va a `main` directo.
6. Fase 4: eliminar `release/*` — cada commit a `main` es "releasable".
7. Documentar el nuevo flujo en un `docs/git-workflow.md`.
8. Retrospectiva a los 30 días.

**Criterios de aceptación:**
- [ ] ADR aprobado por el equipo.
- [ ] Feature flags implementados con OpenFeature.
- [ ] Branches `develop` y `release/*` eliminadas.
- [ ] DORA metrics comparadas antes/después.
- [ ] Retrospectiva documentada.

**Bonus:** publica el post-mortem de la migración en un blog interno.

---

## 9. Recursos y siguientes pasos

**Libros:**
- *Pro Git* — Scott Chacon & Ben Straub (2ª ed, gratis online en `git-scm.com/book`). La referencia.
- *Git for Teams* — Emma Jane Hogbin Westby (2015).
- *Continuous Delivery* — Humble & Farley (cap sobre version control es la base).

**Papers/artículos:**
- *"A successful Git branching model"* — Vincent Driessen (2010), + nota 2020 diciendo "ya no aplica a la mayoría".
- Martin Fowler blog: `martinfowler.com/articles/branching-patterns.html`.
- GitHub docs: About Merge queues, About Protected branches, About CODEOWNERS.
- Conventional Commits spec: `conventionalcommits.org`.
- OpenSSF Scorecard (rate the security posture of a repo).

**Herramientas de referencia:**
- **Git UI**: lazygit (CLI), Fork, GitKraken, GitLens (VSCode extension).
- **Diff/merge**: git-delta, difftastic, meld.
- **Monorepo**: Nx, Turborepo, Bazel, Buck2, Pants, Rush, Moonrepo, Lerna (legacy).
- **Release automation**: release-please (Google), semantic-release, changesets (frontend), commitizen.
- **Signing**: SSH signing (nativo Git), Sigstore gitsign, GPG (legacy).
- **Hooks**: pre-commit (Python), husky (JS), lefthook (multi-lang).

**Documentación viva:**
- Git docs: `git-scm.com/doc`.
- GitHub docs: `docs.github.com`.
- GitLab docs: `docs.gitlab.com`.

**Siguientes pasos en este track:**
- [← Cap 02 — Continuous Delivery](./02-fundamentos-de-continuous-delivery.md)
- [Cap 04 — GitHub Actions y Jenkins](./04-github-actions-y-jenkins.md): implementación técnica.
- Más adelante: Cap 22 (DevSecOps con secret scanning), Cap 24 (Supply Chain Security con SLSA/Sigstore).

---

## 10. Preguntas de práctica

20 preguntas cubren: merge vs rebase, qué es un branch, GitFlow, GitHub Flow, PR review process, protected branches, signed commits, git bisect, cherry-pick, git hooks, monorepo vs polyrepo, git submodules, git reset vs revert, conventional commits, merge queues, git reflog, squash and merge, Git LFS (large files), supply chain security en Git, trunk-based development at scale.

Ruta en la app: `/programming/devops/sim/devops-sim-03-git-workflows-and-branching`

JSON: [`packages/content/src/tech/devops/sim-03-git-workflows-and-branching.json`](../../packages/content/src/tech/devops/sim-03-git-workflows-and-branching.json)

---

## Navegación

← [Cap 02](./02-fundamentos-de-continuous-delivery.md) · [Índice](./README.md) · [Cap 04 →](./04-github-actions-y-jenkins.md)
