# Capítulo 36 — Artifact Management y Caching

> **Focus:** Cómo servir, versionar y cachear artefactos (imágenes OCI, paquetes, binarios) sin quebrar el pipeline ni la factura. Nexus vs Artifactory vs GHCR/GAR/ECR/GitLab Registry, proxies de paquetes, retention, immutable vs mutable tags, semantic versioning, standard OCI artifacts, build caching (Docker BuildKit, sccache, Bazel remote cache, GHA cache), Nix.
> **Áreas:** Artifact management · Build systems · Cost optimization · Reproducibility
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Docker y container images (cap 05).
- Container security y registries básicos (cap 06).
- CI/CD (caps 02, 04).
- Kubernetes fundamentals si vas a pull imágenes desde clusters (cap 07).
- Git y semver.

**Glosario mínimo:**
- **Artifact repository**: sistema que almacena y sirve paquetes (npm, Maven, PyPI), imágenes OCI, binarios, Helm charts. Nexus, Artifactory, GitHub Packages, GitLab Registry.
- **Container registry**: subclass de artifact repo especializado en imágenes OCI/Docker. Docker Hub, GHCR (GitHub), GAR (Google Artifact Registry), ECR (AWS), ACR (Azure).
- **Proxy repository / remote / virtual**: repo que hace passthrough a upstream público (npmjs.org, PyPI, Docker Hub) y cachea localmente.
- **OCI artifact**: standard de la Open Container Initiative para almacenar cualquier cosa (no solo imágenes) en registries: Helm charts, Cosign signatures, SBOMs, models ML, WASM.
- **Semantic versioning (semver)**: `MAJOR.MINOR.PATCH` con reglas de compatibilidad.
- **Immutable tag**: tag que no puede sobrescribirse (`v1.2.3` siempre = mismo digest).
- **Mutable tag**: tag que puede sobrescribirse (`latest`, `main`, `staging`).
- **Digest**: sha256 del manifest de la imagen. `sha256:abc123...`. Único y verificable.
- **Retention policy**: reglas de expiración/eliminación (por edad, por número de versiones, por tag pattern).
- **Build cache**: reutilización de resultados de builds previos. Docker BuildKit layers, sccache (Rust/C++), Bazel remote cache, Nix binary cache, GitHub Actions cache.
- **Cache mount (`RUN --mount=type=cache`)**: feature BuildKit para persistir directorios de dependencias entre builds sin bakearlos en la imagen.
- **Nix**: package manager funcional y sistema de builds hermético + reproducible.

**Setup mínimo:**

```bash
# 1. Nexus 3.x local (OSS)
docker run -d --name nexus -p 8081:8081 sonatype/nexus3:3.75.0
# admin default password: docker exec nexus cat /nexus-data/admin.password

# 2. JFrog Artifactory OSS (JFrog Container Registry gratis)
docker run -d --name artifactory -p 8082:8082 releases-docker.jfrog.io/jfrog/artifactory-oss:7.98.10

# 3. Verkey: Zot (OSS OCI-only registry)
docker run -d --name zot -p 5000:5000 ghcr.io/project-zot/zot-linux-amd64:v2.1.0

# 4. Docker BuildKit 0.14+ (viene con Docker Desktop 4.28+)
docker buildx version
# buildx v0.15.1

# 5. sccache (Rust/C++ compilation cache)
cargo install sccache

# 6. bazel-remote (Bazel remote cache)
docker run -d --name bazel-remote \
  -v /tmp/bazel-cache:/data \
  -p 9090:8080 -p 9092:9092 \
  buchgr/bazel-remote-cache:v2.4.4

# 7. Nix (package manager)
sh <(curl -L https://nixos.org/nix/install) --daemon
```

---

## 1. El gran cuadro

Un pipeline moderno produce **decenas de artefactos por commit**: imágenes de contenedor por servicio, paquetes internos npm/PyPI/Maven, binarios compilados, Helm charts, SBOMs de seguridad, atestaciones firmadas con Cosign. Multiplicá eso por 50 commits diarios y 30 servicios, y estamos ante **cientos de miles de artefactos al año**. Sin gestión ordenada, dos cosas pasan: (a) la factura de storage y egress del registry se dispara —Docker Hub cambió pricing en 2023 y 2024 empujando a miles de empresas a self-host o cloud alternativos— y (b) los deploys se vuelven no reproducibles: nadie sabe qué se desplegó, con qué dependencias, ni cómo reproducirlo un año después. **Artifact management no es glue; es una función de plataforma de primera clase**.

El landscape 2026 se divide en tres tribus. Los **all-in-one universales**: Sonatype Nexus Repository (OSS gratis + enterprise) y JFrog Artifactory (líder enterprise, todos los formatos: Maven, npm, PyPI, Docker, Helm, Go modules, Cargo, Nuget, CocoaPods, Debian, RPM, Conan). Los **git-integrated**: GitHub Container Registry (GHCR), GitLab Container Registry, Gitea Package Registry — vienen con tu SCM sin infraestructura extra, escalan bien para org pequeña/mediana. Los **cloud-native**: AWS ECR, Google Artifact Registry (GAR, sucesor de GCR), Azure Container Registry (ACR) — imprescindibles cuando tu cluster K8s vive en ese cloud (pull latency, IAM). En 2026 la elección típica es **híbrida**: GHCR o cloud registry para imágenes, Artifactory/Nexus para paquetes lenguaje-specific + proxy de upstreams (npmjs, PyPI, Maven Central).

**OCI artifacts** cambian el juego. La spec OCI (Open Container Initiative) —originalmente para imágenes de contenedor— se generalizó para almacenar **cualquier cosa** con un `mediaType` custom. En 2026 es común publicar Helm charts, firmas Cosign, SBOMs SPDX/CycloneDX, WASM modules, ML models e incluso configuración Kubernetes como OCI artifacts en un registry. La ventaja: un solo sistema (con auth, replication, retention) sirve todo. Herramientas como ORAS (OCI Registry as Storage) ejemplifican el pattern. La consecuencia práctica es que tu "artifact repository" y tu "container registry" convergen en 2026.

El otro pilar es **caching de builds**. Un build "cold" de una app grande puede tardar 20 minutos; "warm" (con cache) 30 segundos. La diferencia es la diferencia entre pipelines usables e imposibles. Tres tecnologías dominan 2026: **Docker BuildKit** con `cache mount` (`RUN --mount=type=cache,target=/root/.npm`) y remote cache backends (registry, S3, GHA); **sccache** para compilación Rust/C++/CUDA distribuida; **Bazel remote cache** para monorepos Bazel (`bazel-remote` server o BuildBuddy hosted). **GitHub Actions cache** es el pattern para pipelines públicos con cache scoped al repo. Y sobre todo esto, **Nix** ofrece builds herméticos + reproducibles + cache binario compartido — el santo grial de reproducibilidad, con curva de aprendizaje empinada pero adopción creciente. Este capítulo cubre registries comparados, retention y coste, immutable tags con semver, OCI artifacts, BuildKit avanzado, sccache/Bazel/Nix, y un ejemplo end-to-end sobre LinguaDev Pro.

---

## 2. Registries comparados: Nexus, Artifactory, GHCR, GAR, ECR (nivel básico)

### 2.1 Tabla comparativa

| Registry | Tipo | Formatos soportados | Self-host | Pricing 2026 | Fuerte en |
|---|---|---|---|---|---|
| **Nexus Repository 3.x** | Universal | 20+ (Maven, npm, PyPI, Docker, Helm, Go, Cargo, Nuget, Debian, RPM...) | Sí (OSS + Pro) | OSS free, Pro $$ | JVM ecosystem, on-prem enterprise |
| **JFrog Artifactory** | Universal | 30+ | Sí (OSS + Cloud + Enterprise) | Free tier + Cloud $$ + Enterprise $$$ | Enterprise, GA de todos los formatos, replication |
| **GitHub Container Registry (GHCR)** | OCI | OCI (imágenes, Helm, Cosign, SBOM) | No (SaaS) | Free tier generoso + paid por storage/egress | Ya en GitHub, PATs, gratuito público |
| **GitHub Packages** | Multi | npm, Maven, RubyGems, Nuget, Docker | No | Igual | Integrado con Actions |
| **GitLab Package/Container Registry** | Multi | npm, Maven, PyPI, Composer, RubyGems, Nuget, Debian, Docker, Helm, Terraform, Conan | Sí (self-hosted GitLab) | Included en GitLab plan | GitLab-first orgs |
| **Google Artifact Registry (GAR)** | Universal | OCI, Maven, npm, PyPI, apt, yum, Go | No | Cloud pricing por GB + egress | Ya en GCP, GKE integration |
| **AWS ECR** | OCI | OCI (+ Helm) | No (SaaS) | Cloud pricing | EKS integration, IAM |
| **AWS ECR Public** | OCI público | OCI | No | Free public | Distribución pública de imágenes |
| **Azure Container Registry (ACR)** | OCI | OCI (+ Helm) | No | Cloud pricing | AKS integration |
| **Harbor** | OCI | OCI + Helm | Sí (OSS CNCF Graduated) | Free | Self-host K8s-native, replication multi-region |
| **Zot** | OCI | OCI puro | Sí (OSS) | Free | Simple, ligero, spec-compliant |
| **Gitea Package Registry** | Multi | 20+ | Sí (OSS) | Free | Self-hosted Git + packages en un binario |
| **Distribution (docker/distribution)** | OCI | OCI | Sí (OSS) | Free | Baseline, referencia spec |

### 2.2 Cuándo elegir cuál

- **Startup en cloud, ya en GitHub**: **GHCR** para imágenes, GitHub Packages para paquetes. Cero infra.
- **Empresa en AWS + EKS**: **ECR** para imágenes (IAM + pull latency), + Nexus/Artifactory self-host para paquetes lenguaje-específicos.
- **Empresa en GCP + GKE**: **GAR** que soporta todos los formatos (OCI + Maven + npm + PyPI + apt + yum + Go). Reemplazó Container Registry (GCR) en 2023.
- **Empresa Azure + AKS**: **ACR**.
- **Empresa on-prem o multi-cloud**: **JFrog Artifactory** (universal, replication, licencias enterprise) o **Sonatype Nexus** (OSS + Pro, JVM-centric).
- **K8s multi-region con replication y policies**: **Harbor** (CNCF Graduated, replication built-in, vulnerability scanning).
- **Solo OCI, quiero lo mínimo**: **Zot** (spec-compliant, mínima superficie).
- **GitLab shop**: **GitLab Container Registry** viene integrado, sin infra extra.

### 2.3 Ejemplo Nexus con proxy y hosted

Nexus 3.x típicamente configurado con tres tipos de repos por formato:

1. **hosted**: donde tu equipo publica (`linguadev-npm-releases`).
2. **proxy**: passthrough cacheado a upstream (`npmjs-proxy` → `https://registry.npmjs.org`).
3. **group**: agregador que resuelve en orden (`npm-all` = `hosted + proxy`).

Config vía API REST (para GitOps):

```yaml
# nexus-config.yaml — para nexus-cli o script
repositories:
  - name: npm-proxy
    format: npm
    type: proxy
    remoteUrl: https://registry.npmjs.org
    storage:
      blobStoreName: default
      strictContentTypeValidation: true
    negativeCache:
      enabled: true
      timeToLive: 1440
    httpClient:
      autoBlock: true
      blocked: false
  - name: linguadev-npm-releases
    format: npm
    type: hosted
    storage:
      writePolicy: ALLOW_ONCE   # immutable
      blobStoreName: default
  - name: npm-all
    format: npm
    type: group
    group:
      memberNames: [linguadev-npm-releases, npm-proxy]
```

En tu app:

```
# .npmrc
registry=https://nexus.linguadev.internal/repository/npm-all/
//nexus.linguadev.internal/repository/npm-all/:_authToken=${NPM_TOKEN}
```

Beneficios: (1) instalar `express` va al proxy la primera vez, luego lo sirve local (mucho más rápido y sin bandwidth público); (2) `linguadev-shared-utils` internal se publica al hosted; (3) un solo `registry` URL en `.npmrc`.

### 2.4 Ejemplo Artifactory con virtual + remote

Arquitectura análoga en Artifactory: **local** (tu hosted), **remote** (proxy), **virtual** (aggregator). Config vía UI o `jfrog rt` CLI:

```bash
jfrog rt config-repo virtual-npm.json --url https://artifactory.linguadev.com \
  --user admin --apikey $JFROG_API_KEY
```

`virtual-npm.json`:

```json
{
  "key": "npm",
  "rclass": "virtual",
  "packageType": "npm",
  "repositories": ["npm-releases", "npm-remote"],
  "defaultDeploymentRepo": "npm-releases",
  "artifactoryRequestsCanRetrieveRemoteArtifacts": true
}
```

### 2.5 GHCR ejemplo con GitHub Actions

Login + push en un workflow:

```yaml
name: Build and Push
on:
  push:
    branches: [main]
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write        # para OIDC / Cosign
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Extract metadata (tags, labels)
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/linguadev-api
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,prefix=sha-,format=short
            type=raw,value=latest,enable={{is_default_branch}}
      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          platforms: linux/amd64,linux/arm64
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

GHCR expone las imágenes en `ghcr.io/<org>/<name>:<tag>`. Con `packages: write` los tokens de Actions tienen permisos automáticos.

---

## 3. Immutable tags, semver y retention (nivel medio)

### 3.1 Immutable vs mutable

Regla básica: **`latest`, `main`, `staging` son mutables** (necesariamente); **cualquier versión (`v1.2.3`, `sha-abc123`) es immutable**. Nunca sobreescribas un tag versionado.

Anti-patrón clásico: alguien "fixea" `v1.2.3` reemplazando la imagen. Los deploys que ya pulearon esa versión cargan una cosa; los nuevos cargan otra. Debugging imposible.

Registries maduros (Harbor, ECR, GAR, Artifactory) tienen **tag immutability** setting a nivel de repo o pattern. En GHCR/ECR se hace vía policy.

Ejemplo ECR con tag mutability:

```bash
aws ecr create-repository \
  --repository-name linguadev/api \
  --image-tag-mutability IMMUTABLE
```

En Harbor:

```yaml
apiVersion: goharbor.io/v1beta1
kind: HarborProject
metadata:
  name: linguadev
spec:
  metadata:
    - key: "reuse_sys_cve_allowlist"
      value: "true"
    - key: "auto_scan"
      value: "true"
  immutableTagRules:
    - scope:
        include: ["**"]
        exclude: []
      tag:
        include: ["v*", "release-*"]
        exclude: ["latest", "main", "staging"]
```

### 3.2 Semantic versioning aplicado a artefactos

Semver formal: `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILDMETADATA]`.

- **MAJOR**: cambios breaking API/contract.
- **MINOR**: features backward-compatible.
- **PATCH**: bug fixes backward-compatible.
- **PRERELEASE**: `1.0.0-alpha.3`, `1.0.0-rc.1`.
- **BUILD**: `1.0.0+sha.abc123`.

Ejemplo para LinguaDev Pro API:

```
linguadev/api:2.4.1
linguadev/api:2.4                       # rolling minor
linguadev/api:2                         # rolling major
linguadev/api:2.5.0-rc.1                # release candidate
linguadev/api:2.5.0-beta.2+sha.abc123   # pre-release con build metadata
linguadev/api:sha-abc123                # commit hash (immutable único)
linguadev/api:latest                    # último de main (evitar en prod)
```

Practica en pipeline: al mergear a `main`, tag `sha-<hash>` + `latest`. Al taggear release `v2.4.1` en git, publicar `2.4.1`, `2.4`, `2`, y (opcional) mover `latest`. **Deploy en prod SOLO por digest o por semver exacto (`2.4.1`)**, jamás `latest`.

En Kubernetes:

```yaml
containers:
  - name: api
    image: ghcr.io/linguadev/api:2.4.1@sha256:abc123def456...   # exact digest
    imagePullPolicy: IfNotPresent
```

### 3.3 Retention policies

Sin retention, el registry crece sin límite y las facturas explotan. Ejemplo Nexus retention:

```yaml
# Cleanup Policy en Nexus
name: cleanup-old-snapshots
format: docker
mode: delete
criteria:
  lastBlobUpdated: 90        # eliminar blobs no accedidos hace 90 días
  lastDownloaded: 180
  regex: ".*-snapshot|.*-alpha|.*-beta"   # solo tags matching
```

Ejemplo Artifactory retention:

```json
{
  "cleanup_policies": [
    {
      "key": "old-untagged",
      "description": "Delete untagged images >30 days",
      "criteria": {
        "package_types": ["docker"],
        "included_repositories": ["linguadev-docker-local"],
        "condition": "last_downloaded",
        "value": 30,
        "unit": "days",
        "keep_last_n_versions": 10
      }
    }
  ]
}
```

Ejemplo GHCR con retention API:

```yaml
# .github/workflows/registry-cleanup.yml
- uses: snok/container-retention-policy@v2
  with:
    image-names: linguadev-api
    cut-off: two weeks ago UTC
    account-type: org
    org-name: linguadev
    keep-at-least: 20
    untagged-only: true
    token: ${{ secrets.PAT }}
```

Ejemplo ECR lifecycle:

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Keep last 30 versioned tags",
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["v"],
        "countType": "imageCountMoreThan",
        "countNumber": 30
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Untagged >7 days",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 7
      },
      "action": { "type": "expire" }
    }
  ]
}
```

**Reglas mentales:**

- Retener **por número + edad**, no solo por edad (evita perder la última versión estable).
- **Untagged siempre expira rápido** (subproducto de builds abortados).
- Tags `latest`/`main`/`staging` nunca expiran.
- **Semver releases** (`v*`): retener las últimas N (>=30) para poder rollback.
- **Snapshot/alpha/beta**: expirar agresivamente (>7 días).
- **Auditar coste mensual**: revisar top repos por storage y por egress.

### 3.4 Storage y bandwidth: la letra chica

Docker Hub cambió pricing agresivamente en 2023-2024. Muchos migraron a GHCR/GAR/ECR. Costes a considerar en 2026:

- **Storage**: `~$0.02-0.10/GB/mes` según registry. Imagen 1GB × 50 versiones × 30 repos = 1.5 TB → $30-150/mes solo storage.
- **Egress**: `$0-0.15/GB` según pull location. Pull cross-region de imágenes grandes es costoso — usar registries en la misma región del cluster.
- **Rate limits**: Docker Hub cuenta pulls anónimos y autenticados. Muchos K8s clusters fueron rate-limited en 2020-2021 al no autenticar. Fix: proxy a través de tu registry (Artifactory/Nexus) o usar pull-through cache.

Optimizaciones:

- **Multi-arch manifests** en vez de una imagen por arquitectura (no duplican layers comunes).
- **Distroless base images** (Google) → imágenes 10x más pequeñas.
- **Layer sharing**: base común entre servicios evita duplicar layers.
- **Chainguard Images** (2023-2026) → imágenes minimalistas con vulnerabilities cero.
- **Pull-through cache** en cluster (Harbor proxy) → los nodos pull local, no cross-region.

---

## 4. OCI artifacts, BuildKit avanzado, sccache, Bazel, Nix (nivel avanzado)

### 4.1 OCI artifacts: no solo imágenes

La spec OCI generalizada permite subir **cualquier cosa** al registry:

- **Helm charts** (Helm 3.8+): `helm push mychart.tgz oci://ghcr.io/linguadev/charts`.
- **Cosign signatures**: `cosign sign ghcr.io/linguadev/api:v1.2.3`.
- **SBOMs (SPDX/CycloneDX)**: `cosign attach sbom --sbom=api.spdx.json ghcr.io/linguadev/api:v1.2.3`.
- **WASM modules**.
- **ML models** (Kubeflow, KServe).
- **Configs Kubernetes** con Kustomize o Helm.
- **Cualquier archivo arbitrario** con **ORAS**.

Ejemplo ORAS (OCI Registry as Storage):

```bash
# Subir un artefacto custom (ej: un binario firmado)
oras push ghcr.io/linguadev/mycli:v1.0.0 \
  --artifact-type application/vnd.linguadev.cli.v1+tar \
  ./mycli-linux-amd64.tar.gz:application/vnd.oci.image.layer.v1.tar+gzip

# Pull
oras pull ghcr.io/linguadev/mycli:v1.0.0

# Inspeccionar
oras discover -o tree ghcr.io/linguadev/mycli:v1.0.0
```

Beneficio: **un solo sistema** (registry con auth, retention, replication) sirve imágenes, charts, firmas, y binarios. En 2026 el pattern es standard.

### 4.2 Docker BuildKit 0.14+ con cache mounts

Sin cache mount:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
```

Cada build sin cache reinstala `node_modules`. Con cache mount:

```dockerfile
# syntax=docker/dockerfile:1.9
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=cache,id=pnpm-metadata,target=/pnpm/metadata \
    corepack enable pnpm && \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN --mount=type=cache,target=/app/.next/cache \
    pnpm build

FROM gcr.io/distroless/nodejs20-debian12 AS runtime
WORKDIR /app
COPY --from=build /app/.next /app/.next
COPY --from=build /app/public /app/public
COPY --from=build /app/package.json /app/package.json
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
```

`cache mount` persiste el directorio **entre builds** sin bakearlo en la imagen final (no bloat).

**Remote cache** para compartir entre CI runners:

```bash
docker buildx build \
  --cache-from type=registry,ref=ghcr.io/linguadev/api-cache:main \
  --cache-to type=registry,ref=ghcr.io/linguadev/api-cache:main,mode=max \
  --push \
  -t ghcr.io/linguadev/api:$(git rev-parse --short HEAD) .
```

`mode=max` guarda todos los layers intermedios (más storage, mejor hit rate). `mode=min` solo layers finales.

En GitHub Actions con GHA cache:

```yaml
- uses: docker/build-push-action@v6
  with:
    context: .
    push: true
    tags: ghcr.io/linguadev/api:${{ github.sha }}
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

GHA cache es scoped al repo, 10GB por defecto (compartido con todo el cache).

### 4.3 sccache: compilation cache para Rust/C++/CUDA

sccache intercepta llamadas a `rustc`, `gcc`, `clang`, `nvcc` y cachea outputs por hash de inputs + flags.

Setup local:

```bash
cargo install sccache
export RUSTC_WRAPPER=sccache
cargo build   # primera vez: full compile
cargo build   # segunda vez: cache hits, muy rápido
sccache --show-stats
```

Remote cache con S3:

```bash
export SCCACHE_BUCKET=linguadev-sccache
export SCCACHE_REGION=us-east-1
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export RUSTC_WRAPPER=sccache
cargo build
```

Otras backends: GCS, Redis, memcached, Azure Blob, WebDAV.

En CI:

```yaml
- name: Setup sccache
  uses: mozilla-actions/sccache-action@v0.0.6
- name: Configure sccache
  run: |
    echo "SCCACHE_GHA_ENABLED=true" >> $GITHUB_ENV
    echo "RUSTC_WRAPPER=sccache" >> $GITHUB_ENV
- name: Build
  run: cargo build --release
```

Impacto típico en Rust monorepos: 60-90% de time saving en incrementales.

### 4.4 Bazel remote cache

Bazel ya cachea local; con remote cache **múltiples devs y CI runners comparten**.

`bazel-remote` server (Docker):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bazel-remote
  namespace: build-infra
spec:
  replicas: 3
  selector:
    matchLabels: { app: bazel-remote }
  template:
    metadata:
      labels: { app: bazel-remote }
    spec:
      containers:
        - name: bazel-remote
          image: buchgr/bazel-remote-cache:v2.4.4
          args:
            - --dir=/data
            - --max_size=200         # 200 GB
            - --s3.endpoint=s3.us-east-1.amazonaws.com
            - --s3.bucket=linguadev-bazel-cache
            - --s3.access_key_id_file=/secrets/aws-access-key
            - --s3.secret_access_key_file=/secrets/aws-secret-key
            - --grpc_port=9092
            - --http_address=:8080
          ports:
            - { name: http, containerPort: 8080 }
            - { name: grpc, containerPort: 9092 }
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: aws-creds, mountPath: /secrets, readOnly: true }
      volumes:
        - name: data
          emptyDir: {}
        - name: aws-creds
          secret: { secretName: bazel-remote-aws }
```

En `.bazelrc`:

```
build --remote_cache=grpc://bazel-remote.build-infra.svc.cluster.local:9092
build --remote_upload_local_results=true
build --disk_cache=/tmp/bazel-disk-cache
build --experimental_remote_cache_compression=true
```

Alternativa hosted: **BuildBuddy** ($, con UI de análisis + RBE remote execution).

### 4.5 Nix: builds herméticos + reproducibles

Nix es paradigma distinto. Cada paquete es una función pura `(inputs) → output`. El hash del cierre determina si algo cambió. Build cache (binary cache) es global (`cache.nixos.org` o self-hosted).

Ejemplo `flake.nix` para LinguaDev Pro API:

```nix
{
  description = "LinguaDev Pro API";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        api = pkgs.buildNpmPackage {
          pname = "linguadev-api";
          version = "2.4.1";
          src = ./.;
          npmDepsHash = "sha256-XXXXX...";  # nix-prefetch
          nodejs = pkgs.nodejs_20;
          buildPhase = "npm run build";
          installPhase = ''
            mkdir -p $out/bin
            cp -r dist $out/
            echo "#!/bin/sh\nexec ${pkgs.nodejs_20}/bin/node $out/dist/index.js" > $out/bin/api
            chmod +x $out/bin/api
          '';
        };
      in {
        packages.default = api;
        devShells.default = pkgs.mkShell {
          buildInputs = [ pkgs.nodejs_20 pkgs.pnpm pkgs.postgresql_17 ];
        };
      });
}
```

Build:

```bash
nix build .#default
# Result en ./result
```

Binary cache self-hosted con **attic** o **cachix**:

```bash
# Cachix (hosted)
cachix push linguadev result

# Attic (self-host)
attic push linguadev result
```

Los devs y CI que confían en `linguadev.cachix.org` ni compilan — descargan artefactos ya construidos. **Reproducibilidad de build a 5 años vista** es factible con Nix; imposible con Docker "raw".

Adoption en 2026: Nix es **nicho pero creciente**. Empresas como Modus Create, Determinate Systems, y muchos infra-hard teams (blockchain, security research, embedded) lo estandarizaron. Docker BuildKit + `nix` en `Dockerfile` es el compromise común para orgs que quieren determinismo Nix sin migrar todo el toolchain.

---

## 5. Ejemplo práctico: LinguaDev Pro pipeline completo

Pipeline end-to-end: push a `main` → build con BuildKit cache → sign con Cosign → publish OCI (imagen + SBOM + firma) → deploy vía Argo CD → retention automática.

### Paso 1: Dockerfile con multi-stage + cache mount

```dockerfile
# syntax=docker/dockerfile:1.9
ARG NODE_VERSION=20-alpine
ARG BASE_IMAGE=gcr.io/distroless/nodejs20-debian12

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store,sharing=locked \
    corepack enable pnpm && \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN --mount=type=cache,target=/app/.turbo \
    --mount=type=cache,target=/app/.next/cache \
    pnpm build

FROM ${BASE_IMAGE} AS runtime
WORKDIR /app
COPY --from=build /app/.next /app/.next
COPY --from=build /app/public /app/public
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
USER 1000
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
```

### Paso 2: workflow GHA con GHCR + Cosign + SBOM + cache

```yaml
name: build-and-publish
on:
  push:
    branches: [main]
    tags: ['v*']

concurrency:
  group: build-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write
      attestations: write
    steps:
      - uses: actions/checkout@v4

      - uses: sigstore/cosign-installer@v3
      - uses: anchore/sbom-action/download-syft@v0

      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/linguadev-api
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=sha,prefix=sha-,format=short
            type=raw,value=latest,enable={{is_default_branch}}

      - id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: |
            type=gha
            type=registry,ref=ghcr.io/${{ github.repository_owner }}/linguadev-api-cache:main
          cache-to: |
            type=gha,mode=max
            type=registry,ref=ghcr.io/${{ github.repository_owner }}/linguadev-api-cache:main,mode=max
          provenance: mode=max
          sbom: true

      - name: Sign image with Cosign (keyless OIDC)
        env:
          COSIGN_EXPERIMENTAL: "1"
          DIGEST: ${{ steps.build.outputs.digest }}
        run: |
          echo "${{ steps.meta.outputs.tags }}" | while read -r tag; do
            [ -n "$tag" ] && cosign sign --yes "$tag@$DIGEST"
          done

      - name: Generate SBOM (SPDX)
        run: |
          syft ghcr.io/${{ github.repository_owner }}/linguadev-api@${{ steps.build.outputs.digest }} \
            -o spdx-json > sbom.spdx.json

      - name: Attach SBOM to image
        env:
          COSIGN_EXPERIMENTAL: "1"
        run: |
          cosign attest --yes --predicate sbom.spdx.json --type spdxjson \
            ghcr.io/${{ github.repository_owner }}/linguadev-api@${{ steps.build.outputs.digest }}
```

### Paso 3: retention automática mensual

```yaml
# .github/workflows/registry-cleanup.yml
name: registry-cleanup
on:
  schedule:
    - cron: '0 3 1 * *'   # 1er del mes 3am
  workflow_dispatch:

jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - name: Delete old untagged images (>14 days)
        uses: snok/container-retention-policy@v2
        with:
          image-names: linguadev-api,linguadev-api-cache,linguadev-web
          cut-off: two weeks ago UTC
          account-type: org
          org-name: linguadev
          keep-at-least: 30
          untagged-only: true
          token: ${{ secrets.CLEANUP_PAT }}
      - name: Delete pre-release tags >30 days
        uses: snok/container-retention-policy@v2
        with:
          image-names: linguadev-api
          cut-off: one month ago UTC
          account-type: org
          org-name: linguadev
          filter-tags: '*-alpha*,*-beta*,*-rc*'
          keep-at-least: 5
          token: ${{ secrets.CLEANUP_PAT }}
```

### Paso 4: pull en K8s con digest pinning

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: linguadev-api
  namespace: prod
spec:
  template:
    spec:
      imagePullSecrets:
        - name: ghcr-pull
      containers:
        - name: api
          image: ghcr.io/linguadev/linguadev-api:2.4.1@sha256:9f7c...
          imagePullPolicy: IfNotPresent
```

Digest garantiza que el pod recibe **exactamente** el artefacto verificado en CI (aunque alguien reetiquete `2.4.1`, el sha256 no coincidirá y el pull fallará).

### Paso 5: Nexus como proxy npm/PyPI/Docker (self-host)

Complemento: correr Nexus 3.75 en cluster con proxies a npmjs, PyPI, Docker Hub, Maven Central.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: nexus
  namespace: platform
spec:
  serviceName: nexus
  replicas: 1
  selector: { matchLabels: { app: nexus } }
  template:
    metadata: { labels: { app: nexus } }
    spec:
      containers:
        - name: nexus
          image: sonatype/nexus3:3.75.0
          ports:
            - { name: http, containerPort: 8081 }
            - { name: docker, containerPort: 5000 }
          resources:
            requests: { cpu: 500m, memory: 2Gi }
            limits:   { cpu: 2, memory: 8Gi }
          volumeMounts:
            - { name: data, mountPath: /nexus-data }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3
        resources: { requests: { storage: 200Gi } }
```

Devs configuran `.npmrc`, `pip.conf`, y `~/.docker/config.json` para pasar por Nexus. Bandwidth público → cero después del primer pull.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Immutable tags**: `v1.2.3` nunca se reescribe. Deployment pinning por semver o digest.
- ✅ **Semver disciplined**: MAJOR/MINOR/PATCH significan algo concreto.
- ✅ **Retention policies** desde día 1 (untagged, prereleases, releases retenidas).
- ✅ **Proxy de upstreams públicos** (npmjs, PyPI, Docker Hub) via Nexus/Artifactory.
- ✅ **Digest pinning en K8s producción** (`image@sha256:...`).
- ✅ **BuildKit cache mounts** para `pnpm store`, `pip cache`, `.next/cache`, `.turbo`.
- ✅ **Remote cache** (`type=gha` o `type=registry`) para compartir cache CI runners.
- ✅ **sccache** en compilaciones Rust/C++.
- ✅ **Bazel remote cache** en monorepos Bazel.
- ✅ **Multi-arch manifests** (amd64 + arm64) desde un solo build.
- ✅ **Distroless / Chainguard images** para runtime slim y secure.
- ✅ **OCI artifacts** para Helm charts, SBOMs, signatures — un solo registry.
- ✅ **Cosign sign + SBOM attest** en cada push.
- ✅ **Nexus/Artifactory con virtual repos** = un solo endpoint para hosted + remote.
- ✅ **Auditar coste mensual**: storage + egress por repo, alertas si crecimiento anómalo.
- ✅ **Nix** cuando la reproducibilidad extrema es requisito (blockchain, security, embedded).

### Anti-patrones

- ❌ `image: linguadev/api:latest` en producción.
- ❌ Sobrescribir tag `v1.2.3` con "hotfix" en vez de `v1.2.4`.
- ❌ Sin retention → registry con TB de basura.
- ❌ Pull directo a `docker.io/library/*` sin proxy (rate limits + coste).
- ❌ `Dockerfile` sin multi-stage → imágenes 5x más grandes.
- ❌ `RUN npm install` sin cache mount → cada build reinstala todo.
- ❌ Cache-to `mode=min` cuando `mode=max` cabe (hit rate mucho peor).
- ❌ Bazel local cache only, sin remote → cada CI runner rebuild-a todo.
- ❌ Sin firmar imágenes → supply chain vulnerable.
- ❌ Registries en distinta región del cluster → egress caro + latency alta.
- ❌ Publicar imágenes intermedias de CI en el mismo repo que releases (contamina).
- ❌ Confundir "cache image" (`api-cache`) con "runtime image" (`api`).
- ❌ Sin `imagePullPolicy: IfNotPresent` + digest → pull en cada restart.
- ❌ Semver arbitrario: bump MAJOR por bug fix.
- ❌ Publicar `latest` desde branches feature.

### Tabla decisión "qué registry"

| Situación | Recomendación |
|---|---|
| Startup + GitHub + no infra | GHCR + GitHub Packages |
| AWS + EKS | ECR (imágenes) + Artifactory/Nexus (paquetes) |
| GCP + GKE | GAR (universal) |
| Azure + AKS | ACR |
| On-prem enterprise | JFrog Artifactory o Nexus Pro |
| Multi-region K8s con replication | Harbor (CNCF) |
| GitLab shop | GitLab Registry integrated |
| Solo OCI puro, minimal | Zot |
| Público distribution | Docker Hub o ECR Public |

---

## 7. Casos reales industria 2023-2026

**Docker Hub pricing crisis (2023-2024):** Docker anunció cambios de pricing y rate limits que empujaron a miles de empresas a self-hostear o migrar a GHCR/GAR/ECR. **Lección:** dependencia en un solo registry público es riesgo estratégico.

**Chainguard Images (2023-2026):** startup que publica imágenes con **cero CVEs conocidos**, minimalistas, firmadas. Adoptadas en producción por Google, Microsoft, Anthropic. **Lección:** minimalismo + supply chain trust está reemplazando "instalar todo con apt".

**Sonatype 2024 State of Software Supply Chain:** reporte anual muestra que >90% de vulnerabilities vienen de dependencias transitivas. Proxies con vulnerability scanning (Nexus Firewall, Artifactory Xray) son cada vez más adoptados. **Lección:** el registry es también línea de defensa security.

**JFrog Xray + SBOM automation:** Artifactory publica SBOMs de todos los artefactos, integrable con security tools. Adoptado por empresas fintech y health con compliance strict. **Lección:** compliance (SOC2, ISO 27001) exige trazabilidad de artefactos.

**Bazel + BuildBuddy adoption (Uber, Stripe, Snap):** empresas con monorepos gigantes usan BuildBuddy hosted o self-host bazel-remote. Times de build cortados 10x. **Lección:** invertir en cache infra paga en velocity.

**Nix at Determinate Systems, Modus Create, Anduril (2024-2026):** empresas con requisitos extremos de reproducibilidad estandarizaron Nix. Determinate Systems ofrece Nix "batteries included" (Determinate Nix). **Lección:** Nix está saliendo del nicho hacker.

**GHCR default en open source 2024-2026:** proyectos OSS grandes (kubernetes, prometheus, argo, flux) publican en GHCR por su tier gratis y por integración con GitHub Actions. **Lección:** GHCR es "el nuevo Docker Hub" para OSS.

**Harbor CNCF Graduated (2020, sigue vivo 2026):** Harbor es el registry OCI self-hosted más adoptado en enterprises K8s. Replication multi-region built-in, vulnerability scanning con Trivy. **Lección:** Harbor es la "opción safe" para K8s enterprise sin querer pagar Artifactory.

**Google Artifact Registry migration desde Container Registry (2023-2024):** Google deprecó GCR en favor de GAR (más formatos, mejor pricing, más features). **Lección:** cloud registries evolucionan; monitorear roadmap del vendor.

**Kubernetes 1.28+ deprecates in-tree Docker (2023-2024):** K8s ya requiere containerd o CRI-O. Imágenes que asumen "Docker daemon" en el nodo son legacy. **Lección:** OCI standard es lo que importa, no Docker específicamente.

**Zot como referencia OCI spec (2024-2026):** Zot creció rápido como registry OSS minimalista pero 100% spec-compliant. Usado en air-gapped environments. **Lección:** para casos edge, "less is more" gana.

**Cargo remote registries (Rust ecosystem 2024-2026):** cargo ya soporta registries alternativos maduros; muchas empresas Rust estandarizaron Cloudsmith, JFrog Artifactory, o self-host. **Lección:** el ecosystem-per-language madura hacia lo que Maven/npm tuvieron años.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Nexus 3 con proxy npm + hosted internal

**Objetivo:** montar Nexus, configurar proxy a `registry.npmjs.org`, publicar un paquete interno.

**Setup:** Docker, Node 20+.

**Pasos:**
1. Correr Nexus 3.75.
2. Login `admin` con password de `/nexus-data/admin.password`.
3. Crear repo `npm-proxy` (proxy → `https://registry.npmjs.org`).
4. Crear repo `linguadev-npm-releases` (hosted, writePolicy: allow once).
5. Crear repo `npm-all` (group con ambos).
6. Configurar `.npmrc` global para apuntar a `npm-all`.
7. `npm install express` — verificar que aparece en `npm-proxy/express/`.
8. `npm publish` un paquete `@linguadev/utils@0.1.0`.
9. Verificar que aparece en `linguadev-npm-releases/`.
10. Intentar `npm publish` `@linguadev/utils@0.1.0` de nuevo → debe fallar (immutable).

**Criterios de éxito:**
- [ ] Nexus UI accesible.
- [ ] `npm install express` cachea en Nexus.
- [ ] `@linguadev/utils@0.1.0` publica y se puede instalar.
- [ ] Re-publish falla con "Repository does not allow updating assets".

**Bonus:** configurar cleanup policy: eliminar versiones alpha/beta > 30 días.

---

### Ejercicio 2: BuildKit multi-stage con cache mounts

**Objetivo:** construir la app LinguaDev con Dockerfile optimizado y medir tiempo warm vs cold.

**Setup:** Docker Desktop 4.28+ o Docker CE con buildx.

**Pasos:**
1. Escribir `Dockerfile` con multi-stage + `RUN --mount=type=cache,target=/pnpm/store`.
2. Cold build: `docker buildx build --no-cache -t api:cold .`. Medir tiempo.
3. Warm build (sin cambios): `docker buildx build -t api:warm .`. Medir tiempo.
4. Modificar un archivo `.ts` (no `package.json`) y rebuild.
5. Modificar `package.json` (añadir dep) y rebuild.
6. Comparar tiempos.

**Criterios de éxito:**
- [ ] Cold build completa (por ejemplo, 90-180s).
- [ ] Warm build (por ejemplo, 5-15s).
- [ ] Cambio en `.ts` sin cambiar deps: `deps` stage cache hit, `build` stage rebuild.
- [ ] Cambio en `package.json`: `deps` rebuild + `build` rebuild pero cache mount hit → sigue rápido.
- [ ] Imagen final < 200MB (con distroless).

**Bonus:** publicar cache en GHCR con `cache-to type=registry,ref=...` y verificar que otro runner lo consume.

---

### Ejercicio 3: firmar imagen con Cosign + adjuntar SBOM

**Objetivo:** firmar una imagen con Cosign keyless (OIDC GitHub) y adjuntar SBOM.

**Setup:** GitHub repo con Actions habilitado, `cosign`, `syft` instalados.

**Pasos:**
1. Push imagen a GHCR desde workflow (paso 2 anterior).
2. `cosign sign --yes ghcr.io/OWNER/api@sha256:...` con `id-token: write` permission.
3. `syft ghcr.io/OWNER/api@sha256:... -o spdx-json > sbom.json`.
4. `cosign attest --yes --predicate sbom.json --type spdxjson ghcr.io/OWNER/api@sha256:...`.
5. Verificar con `cosign verify ghcr.io/OWNER/api@sha256:... --certificate-identity-regexp ... --certificate-oidc-issuer https://token.actions.githubusercontent.com`.
6. Descargar SBOM: `cosign download attestation ghcr.io/OWNER/api@sha256:...`.

**Criterios de éxito:**
- [ ] Signature aparece en el registry (`.sig` tag).
- [ ] SBOM attestation aparece (`.att` tag).
- [ ] `cosign verify` pasa con OIDC identity correcto.
- [ ] SBOM descargable y parseable.

**Bonus:** añadir `admission controller` (Kyverno) que rechaza pods con imágenes no firmadas.

---

### Ejercicio 4: retention automática en GHCR

**Objetivo:** configurar workflow que borra untagged >14 días y prereleases >30 días, keep-at-least 30.

**Setup:** repo con múltiples imágenes en GHCR.

**Pasos:**
1. Crear PAT con `read:packages` + `delete:packages`.
2. Guardar como secret `CLEANUP_PAT`.
3. Crear `.github/workflows/registry-cleanup.yml` con `snok/container-retention-policy@v2`.
4. Ejecutar `workflow_dispatch` manual y observar output.
5. Verificar en `Packages` que las imágenes borradas desaparecieron.

**Criterios de éxito:**
- [ ] Workflow completa sin errores.
- [ ] Untagged >14 días eliminados.
- [ ] `keep-at-least: 30` respetado.
- [ ] Prereleases (`*-alpha*`, `*-beta*`, `*-rc*`) > 30 días eliminados.

**Bonus:** medir GB liberados antes/después con GitHub API.

---

### Ejercicio 5 (bonus): Nix flake para reproducibilidad

**Objetivo:** empaquetar el mismo servicio con Nix y publicar en `cachix` (o `attic`).

**Setup:** Nix con flakes habilitadas, cuenta Cachix.

**Pasos:**
1. Crear `flake.nix` con `buildNpmPackage`.
2. `nix build .#default`.
3. `cachix push linguadev result`.
4. Desde otra máquina: `cachix use linguadev` + `nix build github:linguadev/api#default`.
5. Comparar hashes de los binarios finales.

**Criterios de éxito:**
- [ ] Build es hermético (falla si intenta acceder a internet fuera de deps declaradas).
- [ ] Hash de resultado es idéntico entre máquinas.
- [ ] Segunda máquina descarga desde cachix (no compila).

**Bonus:** dockerizar el output Nix con `pkgs.dockerTools.buildImage`.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [help.sonatype.com/en/sonatype-nexus-repository.html](https://help.sonatype.com/en/sonatype-nexus-repository.html) — Nexus 3.x.
- [jfrog.com/help/r/jfrog-artifactory-documentation](https://jfrog.com/help/r/jfrog-artifactory-documentation) — Artifactory.
- [docs.github.com/en/packages](https://docs.github.com/en/packages) — GHCR + GitHub Packages.
- [cloud.google.com/artifact-registry/docs](https://cloud.google.com/artifact-registry/docs) — GAR.
- [docs.aws.amazon.com/AmazonECR](https://docs.aws.amazon.com/AmazonECR) — ECR.
- [goharbor.io/docs](https://goharbor.io/docs) — Harbor.
- [docs.docker.com/build/buildkit](https://docs.docker.com/build/buildkit/) — BuildKit.
- [github.com/mozilla/sccache](https://github.com/mozilla/sccache) — sccache.
- [bazel.build/remote/caching](https://bazel.build/remote/caching) — Bazel remote.
- [nixos.org/guides](https://nixos.org/guides/) — Nix.

**Standards:**
- [opencontainers.org](https://opencontainers.org) — spec OCI.
- [oras.land](https://oras.land) — OCI Registry as Storage.
- [sigstore.dev](https://www.sigstore.dev) — Cosign.

**Herramientas complementarias:**
- **Trivy / Grype** — vulnerability scanning de imágenes.
- **Kyverno / OPA Gatekeeper** — admission control ("solo firmado se despliega").
- **Chainguard Images** — imágenes minimal + zero CVEs.
- **BuildBuddy** — Bazel remote cache + RBE hosted.
- **Cachix / Attic** — Nix binary cache.
- **Turborepo** — cache para monorepos JS.
- **Determinate Nix** — Nix con "batteries included".

**Referencias adicionales:**
- Sonatype State of Software Supply Chain (report anual).
- KubeCon 2024-2025: sessions sobre OCI y supply chain.
- Chainguard blog: security best practices para containers.

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Auditá tu registry: retention configurada, tags immutable, digest pinning en prod.
- Migrá 1 pipeline a BuildKit remote cache y medí time savings.
- Continuá con [cap 37 — Disaster Recovery y Backups](./37-disaster-recovery-y-backups.md) para el pilar de resiliencia.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales de artifact management y build caching. Cubren: comparación Nexus/Artifactory/GHCR/GAR/ECR/Harbor/Zot, proxy vs hosted vs virtual/group, immutable vs mutable tags, semver disciplined, retention policies, storage y bandwidth cost, OCI artifacts standard, BuildKit cache mounts + remote cache backends, sccache, Bazel remote cache, GitHub Actions cache, Nix flakes y binary cache, digest pinning en K8s, y anti-patrones frecuentes.

- **Fuente:** [`packages/content/src/tech/devops/sim-36-artifact-management-and-caching.json`](../../packages/content/src/tech/devops/sim-36-artifact-management-and-caching.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-36-artifact-management-and-caching`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 35 — Database Migrations Zero-Downtime](./35-database-migrations-zero-downtime.md) · [Índice](./README.md) · [Capítulo 37 — Disaster Recovery y Backups →](./37-disaster-recovery-y-backups.md)
