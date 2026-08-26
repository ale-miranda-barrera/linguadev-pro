# Capítulo 12 — Git y colaboración

> **Focus:** Dominar Git como herramienta de pensamiento del cambio: rebase vs merge, interactive rebase, cherry-pick, reflog, bisect, hooks, worktrees, monorepo vs submodules, conventional commits, PR review efectivo y branch strategies.
> **Áreas:** Version control · Colaboración · CI/CD · DX
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Comandos básicos: `clone`, `add`, `commit`, `push`, `pull`, `branch`, `checkout`, `merge`.
- Nociones de HEAD, index (staging area), working tree.
- Uso de un remoto (GitHub, GitLab, Bitbucket, Codeberg, Gitea).
- CLI cómoda: terminal en Windows (PowerShell, WSL2), macOS o Linux.
- Editor con integración Git: VSCode, Cursor, JetBrains, Zed 0.150+.

**Glosario mínimo:**
- **Commit:** snapshot del árbol de archivos + metadata + puntero al parent.
- **Branch:** referencia mutable a un commit; barata en Git (es un archivo con un hash).
- **HEAD:** puntero a la rama actual (o commit si "detached").
- **Merge:** integra dos historias creando un merge commit con dos parents.
- **Rebase:** reaplica una serie de commits sobre otra base; reescribe hashes.
- **Fast-forward:** merge trivial cuando la rama destino está adelantada respecto a la actual.
- **Cherry-pick:** aplicar un commit específico sobre otra rama.
- **Reflog:** log local de movimientos de refs (HEAD, branches). Salvavidas.
- **Bisect:** búsqueda binaria en la historia para localizar el commit que introdujo un bug.
- **Hook:** script ejecutado por Git en eventos (`pre-commit`, `pre-push`, `commit-msg`).
- **Submodule:** repo Git anidado apuntando a un commit específico de otro repo.
- **Subtree:** contenido de otro repo copiado dentro del actual, sin dependencia externa.
- **Worktree:** directorio adicional apuntando a otra rama del mismo repo, sin clon extra.
- **Conventional Commits:** convención `<type>(<scope>): <subject>` (`feat`, `fix`, `chore`, `refactor`, ...).
- **Trunk-based development:** todos los commits van directo (o casi) a `main`, en ramas cortas.
- **GitFlow:** `main` estable, `develop` integrativo, `feature/*`, `release/*`, `hotfix/*`.
- **GitHub Flow:** `main` + feature branches + PR + deploy.

**Setup mínimo:**

```bash
# 1. Git 2.47+ (git 2.47 y superior salieron a lo largo de 2024-2026)
git --version

# 2. Config básica saludable
git config --global user.name "Ale Miranda"
git config --global user.email "ale@example.com"
git config --global init.defaultBranch main
git config --global pull.rebase true            # pull = fetch + rebase por default
git config --global rebase.autoStash true       # stash automático antes de rebase
git config --global merge.conflictStyle zdiff3  # diff3 mejorado
git config --global rerere.enabled true         # recordar resoluciones de merge
git config --global fetch.prune true            # limpia refs remotas borradas
git config --global log.date iso                # fechas legibles

# 3. Aliases útiles
git config --global alias.st status
git config --global alias.co checkout
git config --global alias.br branch
git config --global alias.lg "log --oneline --graph --decorate --all -30"
git config --global alias.last "log -1 HEAD --stat"

# 4. Firmar commits con SSH (Git 2.34+)
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true

# 5. Herramientas complementarias 2026
pnpm add -D lint-staged husky @commitlint/cli @commitlint/config-conventional
```

---

## 1. El gran cuadro

Git es la herramienta que más usa un dev y la que más mal se enseña. Los tutoriales típicos cubren `add / commit / push` y se detienen. Pero el 90% del trabajo real ocurre en el terreno intermedio: **reescribir historia limpiamente antes de un PR**, **encontrar cuándo se rompió algo con bisect**, **recuperar trabajo perdido con reflog**, **manejar conflictos sin miedo**, **elegir la estrategia de branching adecuada al tamaño y velocidad del equipo**. Todas son habilidades transferibles entre lenguajes, empresas y décadas; ninguna se aprende leyendo docs, solo practicando en un repo real.

Dos ejes conceptuales atraviesan el capítulo. El primero: **Git es un DAG (grafo dirigido acíclico) de commits**, no una lista lineal. Cada commit tiene 0 o más parents y un hash SHA-1/SHA-256 que lo identifica. Todas las operaciones (branch, merge, rebase, cherry-pick, revert) son manipulaciones de ese grafo. Entender el modelo mental del DAG hace obvias operaciones que suenan mágicas. El segundo eje: **Git local != remoto**. Casi todo lo que haces (commit, branch, rebase, reflog) es local y reversible. Los comandos peligrosos son los que tocan al remoto compartido (`push --force`, `push :branch`).

El estado 2026 del ecosistema: **Git 2.47+** consolidó mejoras en rendimiento de fetch parcial, mejor soporte para monorepos gigantes (Microsoft/Google), y el motor SHA-256 sigue disponible como opt-in aunque SHA-1 sigue siendo default en la mayoría de servidores. **Trunk-based development** es la práctica dominante en equipos de alto rendimiento medidos por DORA (2019-2024 State of DevOps Report). **Conventional Commits + semantic-release** automatiza changelogs y releases en el 60%+ de OSS repos activos según GitHub State of Open Source 2025. **Signed commits** son cada vez más comunes: GitHub muestra el badge "Verified" y algunos repos serios exigen firma con SSH o GPG.

Este capítulo cubre los patrones que un dev senior debe automatizar: rebase interactivo antes de PR, cherry-pick de hotfix, bisect para regresiones, worktrees para paralelizar tareas, pre-commit hooks para calidad, monorepo vs submodules según team topology. Aterrizaremos en el proyecto **LinguaDev Pro** (monorepo pnpm) con ejercicios de setup de hooks, branch strategy y release automation.

---

## 2. El modelo mental — DAG, referencias y estado local

### 2.1 Ver el grafo

```bash
# Grafo con decoración
git log --oneline --graph --decorate --all -20

# Solo commits reachable desde HEAD
git log --oneline --graph HEAD -20
```

Cada commit tiene:

- Un hash (`sha1` de contenido + metadata) — inmutable.
- 0, 1 o 2+ parents.
- Un árbol (snapshot del working tree).
- Autor, committer, mensaje.

Una **rama** es un archivo bajo `.git/refs/heads/<name>` con un hash dentro. Nada más. Por eso crear una rama es instantáneo:

```bash
cat .git/refs/heads/main
# 3f4a1b2c...

git branch feature/x         # crea archivo refs/heads/feature/x con mismo hash
```

### 2.2 Tres áreas: working tree, index, HEAD

```
[working tree]  <──edit──>  [index / staging]  <──commit──>  [HEAD]
      │                            │                            │
      └────── git status ──────────┴────── git diff --cached ───┘
```

- `git add` mueve del working tree al index.
- `git commit` snapshot del index → nuevo commit → HEAD avanza.
- `git restore --staged <f>` sacar del index sin perder cambios.
- `git restore <f>` descartar cambios en working tree (destructivo).

### 2.3 Detached HEAD

Cuando `HEAD` apunta a un commit específico (no a una rama), estás "detached". Los commits que hagas quedan huérfanos hasta que crees una rama; el GC eventualmente los borra.

```bash
git checkout abc1234       # detached
git log --oneline          # trabajas normal
git switch -c fix/on-the-fly HEAD  # crea rama y los recupera
```

Regla: si te pilla detached por accidente, `git switch -c salvame HEAD` antes de moverte.

---

## 3. Merge vs rebase — cuándo cada uno

### 3.1 Semántica

- **Merge:** integra `feat/x` en `main` creando un merge commit con dos parents. Preserva historia real.
- **Rebase:** reaplica commits de `feat/x` sobre `main` como si acabaras de hacerlos ahora. Historia lineal, hashes nuevos.
- **Squash merge:** compacta todos los commits de la rama en uno solo al integrar.

### 3.2 Regla dura

- ✅ **Rebase local** para limpiar tus commits **antes** de abrir el PR.
- ✅ **Merge** (o squash-merge) para integrar el PR a `main`.
- ❌ **Nunca rebase de commits ya pusheados a rama compartida** — reescribes historia que otros ya tienen, y les rompes el `pull`. Regla de oro: *"rebase is for local, merge is for public"*.
- ✅ **Squash-merge** cuando la rama tiene "wip", "fix typo", "another fix" y quieres un commit atómico y limpio en `main`.
- ✅ **Merge commit** cuando quieres preservar la agrupación de commits del PR como unidad (ej. en repos con release notes generadas del log).

### 3.3 Merge fast-forward vs no-ff

```bash
# Fast-forward: si main no divergió, avanza el puntero (no crea merge commit)
git merge feat/x

# Forzar merge commit siempre (deja rastro del PR en el grafo)
git merge --no-ff feat/x
```

Equipos que usan squash-merge en GitHub/GitLab suelen configurar el default.

### 3.4 pull.rebase = true

```bash
git config --global pull.rebase true
```

Con esto, `git pull` en tu rama de trabajo hace `fetch + rebase` en vez de `fetch + merge`. Historia local limpia. `rebase.autoStash = true` hace stash automático de cambios sin commitear antes de rebase.

---

## 4. Rebase interactivo — la superpower

### 4.1 Casos de uso

Antes de abrir un PR quieres:

- Fusionar 3 commits "fix typo" en el commit real.
- Reordenar commits para que el mensaje cuente una historia.
- Editar un mensaje viejo.
- Eliminar un commit con secretos que se coló.
- Partir un commit gigante en varios lógicos.

### 4.2 Ejemplo end-to-end

```bash
git log --oneline
# a1b2c3d fix typo
# 9e8f7d6 add tests
# 5c4b3a2 wip
# 7f8e9d0 add lesson generator
# 3d2c1b0 main

# Iniciar rebase interactivo sobre los últimos 4 commits
git rebase -i HEAD~4
```

Se abre el editor con:

```
pick 7f8e9d0 add lesson generator
pick 5c4b3a2 wip
pick 9e8f7d6 add tests
pick a1b2c3d fix typo
```

Cambia a:

```
pick 7f8e9d0 add lesson generator
squash 5c4b3a2 wip
squash a1b2c3d fix typo
pick 9e8f7d6 add tests
```

Al guardar, Git combina 1+2+3 en un commit, te pide reescribir el mensaje, y luego aplica el 4.

### 4.3 Comandos disponibles

| Comando | Efecto |
|---|---|
| `pick` | Mantener el commit tal cual |
| `reword` (`r`) | Mantener contenido, editar mensaje |
| `edit` (`e`) | Parar en el commit para editar contenido |
| `squash` (`s`) | Fusionar con el commit anterior, combinando mensajes |
| `fixup` (`f`) | Como squash pero descarta el mensaje |
| `drop` (`d`) | Eliminar el commit |
| `exec` (`x`) | Ejecutar comando shell entre commits (útil para test) |

### 4.4 Autosquash

```bash
# Crea commits fixup automáticos
git commit --fixup=abc123
git commit --fixup=abc123

# En el rebase, Git los mueve y aplica solos
git rebase -i --autosquash HEAD~10
```

Configura `git config --global rebase.autoSquash true` para default on.

### 4.5 Salir de rebase

- `git rebase --continue` tras resolver conflictos.
- `git rebase --skip` para descartar el commit conflictivo.
- `git rebase --abort` para volver al estado pre-rebase.

---

## 5. Cherry-pick, revert, reflog, bisect — el kit del bombero

### 5.1 Cherry-pick — moverse un commit

```bash
# Aplicar el commit abc1234 sobre la rama actual
git cherry-pick abc1234

# Múltiples commits
git cherry-pick abc1234 def5678

# Rango
git cherry-pick abc..def

# Sin commitear (deja los cambios en el index)
git cherry-pick -n abc1234
```

Uso clásico: hotfix aplicado a `main` que también necesita ir a `release/1.5`.

Anti-patrón: cherry-pick sistemático entre ramas largas → historia duplicada, conflictos crecientes. Si necesitas eso, replantea la branch strategy.

### 5.2 Revert — deshacer sin reescribir

```bash
# Crea un nuevo commit que deshace los cambios de abc1234
git revert abc1234

# Revert de merge commit (necesita -m para elegir el mainline parent)
git revert -m 1 <merge_sha>
```

`revert` es seguro en ramas públicas — no reescribe historia. Contraste con `reset` (destructivo).

### 5.3 Reset — con precaución

```bash
git reset --soft HEAD~1    # deshace commit, deja cambios staged
git reset --mixed HEAD~1   # deshace commit, deja cambios en working tree (default)
git reset --hard HEAD~1    # PELIGRO: descarta commit y cambios
```

Regla: **nunca `--hard` sin verificar con `git status` y sin considerar `stash`**.

### 5.4 Reflog — el salvavidas

Reflog registra cada movimiento de HEAD y refs durante ~90 días (config). Incluso commits "perdidos" siguen en el objeto DB hasta GC.

```bash
git reflog
# 3f4a1b2 HEAD@{0}: reset: moving to HEAD~1
# 7f8e9d0 HEAD@{1}: commit: add lesson generator
# 5c4b3a2 HEAD@{2}: checkout: moving from main to feat/x

# Recuperar el commit "perdido"
git reset --hard HEAD@{1}

# O crearle una rama
git branch rescue HEAD@{1}
```

Historias reales: dev hace `git reset --hard`, `git rebase --abort` mal timing, `git branch -D` sobre la rama equivocada. En todos, reflog recupera si no ha pasado `git gc`.

### 5.5 Bisect — búsqueda binaria del bug

Encontrar el commit que introdujo un bug en 1000 commits: binaria en log₂(1000) ≈ 10 pasos.

```bash
git bisect start
git bisect bad HEAD                    # HEAD tiene el bug
git bisect good v1.2.0                 # v1.2.0 funcionaba

# Git salta al commit del medio; pruebas
# ... corres tests ...
git bisect bad     # o good, según

# Al terminar
git bisect reset
```

Automatización con script:

```bash
git bisect start HEAD v1.2.0
git bisect run pnpm test:critical
```

Git ejecuta el script en cada iteración; exit code 0 = good, 1-124/126-127 = bad, 125 = skip. En ~10 pasos localiza el commit exacto.

### 5.6 git blame y log -S — arqueología

`git blame` muestra quién tocó cada línea y en qué commit:

```bash
git blame -L 40,80 packages/api/src/auth.ts
```

Añade `-w` para ignorar cambios de whitespace, `-C` para detectar código movido de otro archivo. En VSCode/JetBrains hay integraciones inline (GitLens).

**`git log -S "<string>"`** (pickaxe) encuentra commits que **añadieron o quitaron** una string dada. Perfecto para "¿cuándo se introdujo esta constante mágica?":

```bash
git log -S "SECRET_TIMEOUT_MS" --source --all
```

**`git log -G "<regex>"`** parecido pero con regex sobre el diff completo.

Combinación para investigar CVEs o regresiones:

```bash
git log --all --oneline -S "vulnerable_function" -- '*.py'
git show <sha>            # ve el diff que introdujo la línea
git blame <sha>^ -- file  # ve quién tocó justo antes
```

### 5.7 Force push seguro — `--force-with-lease`

`git push --force` sobreescribe la rama remota sin comprobar nada. Si alguien pusheó entretanto, borras su trabajo. **Nunca** en 2026.

`git push --force-with-lease` solo fuerza si el remoto está donde tú lo viste la última vez:

```bash
git push --force-with-lease origin feat/x
```

Aún mejor con `--force-if-includes` (Git 2.30+), que además exige que hayas hecho fetch reciente:

```bash
git push --force-with-lease --force-if-includes origin feat/x
```

Regla dura: **nunca force push a `main`, `master`, `develop`, `release/*`**. Config del remoto puede prohibirlo (`push.followTags`, GitHub branch protection).

---

## 6. Hooks y calidad del commit

### 6.1 Hooks nativos vs husky vs pre-commit

Los hooks están en `.git/hooks/` como scripts ejecutables. Por seguridad, Git no los versiona (`.git/` no se pushea). Soluciones:

- **husky (JS/Node):** copia hooks a `.git/hooks` on install. Standard en frontend/full-stack.
- **pre-commit (Python, Yelp):** framework poliglota; hooks declarativos en YAML.
- **lefthook (Go):** rápido, poliglota, sin dependencias runtime.

### 6.2 Setup husky + lint-staged + commitlint

```bash
pnpm add -D husky lint-staged @commitlint/{cli,config-conventional}
pnpm exec husky init

# .husky/pre-commit
echo "pnpm exec lint-staged" > .husky/pre-commit

# .husky/commit-msg
echo 'pnpm exec commitlint --edit "$1"' > .husky/commit-msg
```

`package.json`:

```json
{
  "lint-staged": {
    "*.{ts,tsx,js,jsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml,yaml}": ["prettier --write"]
  }
}
```

`commitlint.config.js`:

```js
module.exports = { extends: ['@commitlint/config-conventional'] };
```

Ahora cada commit corre lint + format en archivos staged, y el mensaje se valida contra conventional commits.

### 6.3 pre-push hook — última línea

```bash
# .husky/pre-push
#!/usr/bin/env bash
pnpm test:unit --run || {
  echo "Tests fail. Fix them or use --no-verify (risky)."
  exit 1
}
```

Regla: **hooks NO deben ser lentos**. Si tu pre-commit tarda 30 s, el equipo lo desactivará. Corre solo tests/lint sobre archivos staged, delega el full suite a CI.

### 6.4 Skip cuando sea legítimo

```bash
git commit --no-verify        # salta hooks
git push --no-verify
```

Solo en emergencias: hotfix a las 3 AM con producción caída. Nunca por hábito.

---

## 7. Conventional Commits + release automation

### 7.1 Formato

```
<type>(<scope>): <subject>

<body>

<footer>
```

Tipos comunes: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `ci`, `build`, `revert`.

Ejemplos:

```
feat(reviews): add SM-2 scheduler fallback
fix(auth): prevent race in token refresh
chore(deps): bump prisma to 5.22
refactor(api): split userService into commands and queries
```

Breaking changes:

```
feat(api)!: remove /v1/reviews endpoint

BREAKING CHANGE: clients must migrate to /v2/reviews
```

### 7.2 semantic-release / changesets

**semantic-release** (Node) lee los commits desde el último release, deduce el bump semver (`fix` → patch, `feat` → minor, `!` o `BREAKING CHANGE` → major), genera CHANGELOG.md, tag, GitHub release, publish a npm.

**changesets** (Atlassian, popular en monorepos): cada PR añade un `.changeset/<name>.md` describiendo el cambio; en release, combina todos y bumpa versiones por paquete.

En LinguaDev Pro (monorepo pnpm), `changesets` encaja bien:

```bash
pnpm add -D @changesets/cli @changesets/changelog-github
pnpm exec changeset init

# En cada PR
pnpm changeset          # elige paquetes y tipo de bump

# En release
pnpm changeset version   # aplica los bumps, actualiza CHANGELOG
pnpm publish -r
```

### 7.3 Trailers de commit

Metadata estructurada en el body:

```
feat(auth): add oauth2 flow

Signed-off-by: Ale Miranda <ale@example.com>
Co-authored-by: Juan Perez <juan@example.com>
Reviewed-by: Maria Gomez <maria@example.com>
Refs: #123
```

`Co-authored-by` es reconocido por GitHub y atribuye el commit a múltiples autores. `Signed-off-by` es requerido en proyectos como el kernel de Linux (Developer Certificate of Origin).

---

## 8. Branch strategies — GitFlow vs trunk vs GitHub Flow

### 8.1 GitFlow (Vincent Driessen, 2010)

Ramas: `main` (producción), `develop` (integración), `feature/*`, `release/*`, `hotfix/*`.

- ✅ Encaja con releases planificados y versionado clásico (desktop apps, libs con releases mensuales).
- ❌ Overhead alto: 5 tipos de ramas, merges dobles. En 2020 el propio Driessen publicó nota diciendo que GitFlow **no encaja para web moderno con CD**. Recomienda GitHub Flow / trunk-based ahí.

### 8.2 Trunk-based development

Todos los cambios van a `main` en ramas muy cortas (horas, no días). PRs pequeños. Feature flags para desactivar features incompletas en producción. **DORA / State of DevOps Report 2019-2024:** trunk-based correlaciona con equipos elite (deploy varias veces al día, lead time <1 h, MTTR <1 h, low change failure).

Requisitos: buenos tests, CI rápido (<10 min), cultura de PR review activa, feature flags.

### 8.3 GitHub Flow

Simplificación: `main` + feature branches + PR + merge + deploy. Sin `develop`, sin `release`. Cada merge a `main` puede deployarse (o deploya automáticamente). Estándar de facto en 2026 para SaaS.

### 8.4 Elegir

| Equipo | Estrategia | Por qué |
|---|---|---|
| SaaS con CD | Trunk / GitHub Flow | Deploy alto, lead time bajo |
| Lib publicada con versiones | Trunk + tags | Semver de releases |
| App móvil con submissions a store | GitFlow ligero o release branch | Ventanas de release |
| Regulado (banca, health) | Release branch + approvals | Compliance |
| Monorepo grande con equipos independientes | Trunk + folder ownership | Menos merges pesados |

### 8.5 Tags vs branches para releases

- **Branches** son mutables (avanzan).
- **Tags** son inmutables (apuntan a un commit fijo). Perfectos para versionar releases.

```bash
git tag -a v1.5.0 -m "release 1.5.0"
git push origin v1.5.0

# Tag firmado
git tag -s v1.5.0 -m "release 1.5.0"
```

Semantic-release y changesets crean tags automáticamente.

### 8.6 PR review efectivo

Estudios (Microsoft Research 2018, Google 2020) muestran que los code reviews se estancan cuando:

- **PR gigante** (>500 líneas cambiadas). Recomendación: <200 líneas net; parte en PRs stack.
- **Sin descripción**. Añade *why*, *what*, *how tested*, *screenshots* si UI.
- **Sin CI verde**. Nunca pides review con CI rojo (pierdes credibilidad).
- **Mezcla scopes** (`feat + refactor + rename`). Separa.
- **Sin auto-review previo**. Antes de pedir revisor, revisa tu propio diff.

Checklist reviewer (5-15 min por PR):

- ✅ Nombre y tipo de cambio quedan claros del título/descripción.
- ✅ Los tests cubren el happy path y al menos un error path.
- ✅ Errores manejados (ver [Cap 10](./10-error-handling-y-recovery.md)).
- ✅ No hay secretos ni PII en el diff.
- ✅ Docs / CHANGELOG actualizados si aplica.
- ✅ Cambios de esquema DB tienen migración (ver [Cap 11](./11-bases-de-datos-para-devs.md)).
- ✅ Feature flag si feature grande.
- ✅ Backwards compat considerada.

Convención: usa nits/suggestions vs blocking comments. Herramientas como Reviewable, GitHub required reviewers + CODEOWNERS agilizan flujo. En 2026, **Copilot Code Review**, **Cursor Review**, **Coderabbit** dan primer pase automático que atrapa lint, typos, bugs obvios; el humano se enfoca en diseño e intención.

### 8.7 Signed commits — GPG y SSH

Un commit tiene autor pero **no está firmado por defecto**. Cualquiera puede impersonar con `git config user.email tuyo@dominio`. Firmar demuestra origen.

**GPG** era el clásico. Complejo: gestionar keyring, subir clave pública a GitHub.

**SSH signing** (Git 2.34+, 2021) reusa tus llaves SSH. Mucho más simple:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

Sube la clave pública SSH a GitHub → Settings → SSH and GPG keys → "New SSH key" con type "Signing Key". Commits nuevos aparecen con badge **Verified**. Repos regulados suelen exigir firma.

### 8.8 git rerere — recordar resoluciones

Reused Recorded Resolution. Cuando resuelves un conflicto en un rebase largo, Git guarda tu resolución. La próxima vez que aparezca el mismo conflicto (ej. rebases repetidos de una feature branch de larga vida), Git lo aplica solo.

```bash
git config --global rerere.enabled true
```

Especialmente útil en refactorings grandes que impactan muchas ramas en vuelo.

---

## 9. Worktrees, monorepo vs submodules vs subtree, LFS

### 9.1 Worktrees — múltiples ramas sin clones extra

Situación: estás en `feat/x` con work-in-progress; llega hotfix urgente. Antes:

```bash
git stash          # o commit temporal
git switch main
# fix, commit, push
git switch feat/x
git stash pop      # esperando conflictos
```

Con worktree:

```bash
git worktree add ../repo-hotfix main    # crea otro dir con main checked out
cd ../repo-hotfix
# fix, commit, push sin tocar tu wip
cd -
git worktree remove ../repo-hotfix
```

Cada worktree comparte el `.git` (objetos), pero tiene su propio HEAD e index. Comando `git worktree list`. Ideal para: hotfixes, revisar PR de un compañero sin perder tu contexto, correr tests largos en paralelo en otra rama. En 2026 se usa mucho con agentes IA para trabajos paralelos (ver `worktrunk.dev`, herramienta específica para agentes).

### 9.2 Monorepo vs polyrepo

**Monorepo** (Google, Meta, Uber, muchos startups): un solo repo con múltiples paquetes/apps. Ventajas: atomic changes cross-package, refactor global, shared tooling. Desventajas: repo gigante (Google usa Piper, no git), build/test selectivo obligatorio.

**Polyrepo:** un repo por servicio/paquete. Ventajas: aislamiento, ownership claro. Desventajas: cambios cross-repo son coordinación manual con múltiples PRs.

Herramientas monorepo 2026: **Nx**, **Turborepo**, **pnpm workspaces**, **Bazel** (grandes), **Lerna** (deprecated 2022 aunque revivió). LinguaDev Pro usa pnpm workspaces + Turborepo (o similar).

### 9.3 Submodules vs subtree

**Submodule:** referencia a un commit específico de otro repo. Se ve como un pointer en el repo padre.

```bash
git submodule add https://github.com/foo/bar libs/bar
git submodule update --init --recursive
```

Ventaja: dependencia de código fuente versionada. Desventaja: workflow doloroso (fetch/pull dobles, updates olvidados, PRs cross-repo).

**Subtree:** copia el contenido de otro repo dentro del actual como si fuera propio.

```bash
git subtree add --prefix=libs/bar https://github.com/foo/bar main --squash
git subtree pull --prefix=libs/bar https://github.com/foo/bar main --squash
```

Ventaja: quien clona no ve nada raro, no hay `.gitmodules`. Desventaja: contribuir upstream requiere `git subtree push`, menos común.

**En 2026:** para código propio, prefiere **monorepo con workspaces** (pnpm/yarn) sobre submodules. Submodules solo cuando la dependencia es genuinamente externa y estable (ej. dependencias de compilador con vendoring).

### 9.4 Git LFS

Git guarda blobs binarios completos en cada versión → repos se vuelven gigantes con PSDs, videos, modelos ML. **Git LFS (Large File Storage)** guarda un puntero en git y el binario real en un backend (GitHub LFS, S3, Artifactory).

```bash
git lfs install
git lfs track "*.psd" "*.mp4" "*.onnx"
git add .gitattributes
git add design.psd
git commit -m "add design"
```

En 2026 alternativas: **git-annex**, **dvc** (para ML datasets/models). LFS sigue siendo el default en GitHub/GitLab.

### 9.5 Sparse checkout + partial clone

Repos gigantes (monorepo con GBs de historia) hacen `clone` doloroso. Dos ayudas en 2026 muy maduras:

**Partial clone** — no descarga blobs históricos, solo cuando se necesitan:

```bash
git clone --filter=blob:none https://github.com/foo/bar.git
```

**Sparse checkout** — solo materializa parte del árbol:

```bash
git clone --filter=blob:none --sparse https://github.com/foo/bar.git
cd bar
git sparse-checkout set packages/api packages/shared
```

Con esto trabajas solo con dos folders de un monorepo con 500 paquetes. Microsoft usa esto internamente para su fork gigante de Chromium; VFS for Git es el linaje. Ver `git sparse-checkout --help` para el modo `cone` (más rápido, más restrictivo) vs `no-cone` (más flexible).

### 9.6 `.gitignore` vs `.git/info/exclude` vs `skip-worktree`

- **`.gitignore`:** ignora archivos que **nunca deberían** trackearse. Se versiona en el repo. Compartido con el equipo.
- **`.git/info/exclude`:** como gitignore pero **local, no versionado**. Para basura personal (`.DS_Store`, notas privadas).
- **`git update-index --skip-worktree <file>`:** para archivos **ya trackeados** que localmente quieres modificar sin que Git te lo note (config de dev local, credenciales fake). Peligroso: fácil olvidar; el archivo real cambió pero `git status` limpio.
- **`git update-index --assume-unchanged <file>`:** parecido pero pensado para perf en checkouts grandes, no para hide cambios.

Regla: no uses `assume-unchanged` como sustituto de `.gitignore`. No uses `skip-worktree` en repos con muchos devs; usa **overlay configs** (`config.local.json` en gitignore).

### 9.7 Ejemplo LinguaDev Pro — workflow completo

Setup base del monorepo pnpm de LinguaDev Pro:

```bash
# 1. Init repo con hooks
git init && pnpm install
pnpm add -D husky lint-staged @commitlint/{cli,config-conventional} @changesets/cli
pnpm exec husky init
pnpm exec changeset init

# 2. .gitignore base
cat > .gitignore <<'EOF'
node_modules/
dist/
.next/
.turbo/
.env
.env.local
*.log
.DS_Store
.vscode/settings.json
.idea/
coverage/
EOF

# 3. .gitattributes para LF consistente en Windows/macOS/Linux
cat > .gitattributes <<'EOF'
* text=auto eol=lf
*.png binary
*.jpg binary
*.pdf binary
EOF

# 4. Branch protection en GitHub (via UI o gh)
gh api repos/OWNER/linguadev-pro/branches/main/protection \
  --method PUT \
  -F required_status_checks.strict=true \
  -F required_status_checks.contexts[]="ci/test" \
  -F required_pull_request_reviews.required_approving_review_count=1 \
  -F enforce_admins=true \
  -F required_linear_history=true \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

Workflow diario:

```bash
# Rama corta para un cambio pequeño
git switch -c feat/reviews-sm2-fallback

# Trabajo iterativo con commits pequeños
git add -p         # stage por hunks
git commit -m "feat(reviews): add SM-2 fallback when FSRS state missing"

# Antes de push, autoclean con rebase interactivo
git fetch origin
git rebase -i origin/main

# Changeset del cambio
pnpm changeset

# Push y PR
git push -u origin feat/reviews-sm2-fallback
gh pr create --fill
```

### 9.8 Git como forensics — CVE archaeology

Cuando aparece un CVE en una dep transitiva, quieres saber: ¿desde qué versión de mi app estoy expuesto?

```bash
# Encuentra cuándo se añadió la dep vulnerable
git log --all --oneline -S '"vulnerable-lib":' -- package.json pnpm-lock.yaml

# Diff del commit
git show <sha> -- pnpm-lock.yaml | grep -A2 vulnerable-lib

# ¿En qué tags aparece?
git tag --contains <sha>
```

Combina con `npm audit`, `pnpm audit`, `snyk test` para inventario continuo. En CI:

```yaml
# .github/workflows/audit.yml (ejemplo)
- run: pnpm audit --audit-level=high
- run: pnpm outdated || true
```

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales de equipos. Cubren: rebase interactivo (squash, edit, reorder), cherry-pick uso y abuso, bisect para regresiones, hooks pre-commit vs pre-push, merge strategies (ff, no-ff, squash), reflog como salvavidas, worktrees, resolución sistemática de conflictos, `git blame` y `log -S` como forensics, force push seguro, submodules vs subtree vs monorepo, conventional commits + changelog, signed commits (GPG/SSH), sparse checkout + partial clone, `.gitignore` vs `.git/info/exclude` vs `skip-worktree`, detached HEAD, revert vs reset, `rerere`, trailers en commits y arqueología de CVE.

- **Fuente:** [`packages/content/src/tech/programmer/sim-12-git-and-collaboration.json`](../../packages/content/src/tech/programmer/sim-12-git-and-collaboration.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-12-git-and-collaboration`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 11 — bases de datos para devs](./11-bases-de-datos-para-devs.md) · [Capítulo 13 — docker y contenedores →](./13-docker-y-contenedores.md) · [Índice](./README.md)
