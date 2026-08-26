# Capítulo 13 — Docker y contenedores en la práctica

> **Focus:** Escribir Dockerfiles idiomáticos (multi-stage, layer cache, non-root), entender la diferencia entre imagen, contenedor y volumen, dominar redes de Docker, `docker-compose` para desarrollo y hardening básico de seguridad.
> **Áreas:** Contenedores · Runtime · Dev-loop · Seguridad de imágenes
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior

## 0. Antes de empezar

**Pre-requisitos:**
- Línea de comandos Linux/macOS/WSL2 razonablemente cómoda (`cd`, `ls`, `chmod`, `curl`, `tar`).
- Git y una app propia sencilla (Node, Python, Go o Java) para experimentar.
- Nociones básicas de red TCP/IP y de HTTP (puertos, hostnames, DNS).
- Familiaridad con variables de entorno y con `12-factor` (recomendado leer [12factor.net](https://12factor.net)).
- Instalado localmente: **Docker Engine 27+** o **Docker Desktop** (Mac/Windows), o **Podman 5+** si prefieres el ecosistema Red Hat.

**Glosario mínimo:**
- **Imagen**: plantilla inmutable con filesystem por capas + metadata (`Dockerfile` compilado). Se identifica por `nombre:tag` y por `digest` (SHA256).
- **Contenedor**: instancia en ejecución de una imagen; añade una capa read-write encima. Tiene su propio PID namespace, network namespace, cgroup, etc.
- **Layer**: cada instrucción (`RUN`, `COPY`, `ADD`) crea un layer inmutable que se cachea por hash de la instrucción y de los inputs.
- **Dockerfile**: receta declarativa para construir una imagen (`FROM`, `RUN`, `COPY`, `USER`, `ENTRYPOINT`, `CMD`, …).
- **BuildKit**: motor de build moderno (default desde Docker 23, marzo 2023). Añade paralelismo entre stages, `--mount=type=cache`, `--mount=type=secret` y cache remoto.
- **Multi-stage build**: `Dockerfile` con varios `FROM`; los stages intermedios se descartan, la imagen final solo lleva lo copiado desde ellos.
- **Distroless**: familia de imágenes de Google (`gcr.io/distroless/*`) sin shell ni package manager; superficie de ataque mínima.
- **OCI (Open Container Initiative)**: estándar de formato de imagen y runtime que garantiza interoperabilidad entre Docker, Podman, containerd, CRI-O, nerdctl.
- **containerd**: runtime low-level (CNCF graduated) usado por Docker Engine internamente y por Kubernetes (default desde K8s 1.24, tras remover `dockershim` en 2022).
- **Registry**: servicio HTTP que aloja imágenes (Docker Hub, GHCR, ECR, GCR, Harbor, JFrog Artifactory).
- **SBOM (Software Bill of Materials)**: inventario de todos los componentes que hay dentro de una imagen (SPDX o CycloneDX). Requisito de SLSA y de muchas normativas de supply chain.

**Setup mínimo (verifica todo antes de seguir):**

```bash
# 1. Docker Engine y compose disponibles
docker version --format '{{.Server.Version}}'   # >= 27
docker compose version                          # >= v2.27

# 2. BuildKit activo (default; comprueba)
docker buildx version
DOCKER_BUILDKIT=1 docker build --help | head -5

# 3. Ver arquitectura del host (importa para multi-arch)
docker info --format '{{.Architecture}} / {{.OSType}}'

# 4. Ping a Docker Hub y a GHCR
docker pull hello-world && docker run --rm hello-world
docker pull ghcr.io/distroless/static:nonroot

# 5. Herramientas complementarias que usaremos en el capítulo
brew install hadolint trivy dive syft cosign 2>/dev/null || \
  echo "En Linux: instala hadolint, trivy, dive, syft y cosign desde sus releases GitHub"
```

Si `hello-world` no imprime "Hello from Docker!", corrige el daemon antes de continuar. Si estás en Windows, asegura WSL2 backend (`Settings → General → Use the WSL 2 based engine`).

---

## 1. El gran cuadro

Un contenedor **no es una VM ligera**. Una VM emula hardware, arranca un kernel propio y consume gigabytes; un contenedor comparte el kernel del host y solo aísla procesos con primitivas del kernel Linux: **namespaces** (PID, network, mount, UTS, IPC, user, cgroup) y **cgroups** (limitan CPU, memoria, IO, PIDs). Todo lo demás —incluyendo el rootfs— es una serie de layers apilados con overlayfs. Esto explica por qué un contenedor arranca en 50 ms y una VM en 30 s: no hay boot, es un `fork+exec` con namespaces nuevos.

La consecuencia práctica es que la **imagen** es la unidad de deploy, no el binario. Todo lo que necesita tu app para correr —libraries, runtime, certificados, timezone data— vive dentro. Ese empaquetado hermético habilita **portabilidad** ("corre igual en mi laptop, en CI y en producción") y **reproducibilidad** ("el mismo `Dockerfile` + mismo commit produce el mismo digest"). Ambas propiedades se rompen fácilmente si haces `latest`, `apt-get install sin pinnear`, o descargas binarios sin verificar hash. Buena parte del capítulo se dedica precisamente a preservarlas.

El ecosistema en 2026 está estabilizado alrededor del estándar OCI. **Docker Engine 27+/29+** sigue siendo la referencia en desarrollo (Docker Desktop dominante en Mac/Windows). En producción con Kubernetes, la mayoría de clusters usan **containerd 2.x** o **CRI-O** como runtime; `dockershim` fue removido en K8s 1.24 (mayo 2022). **Podman 5** (Red Hat) es la alternativa daemonless y rootless por default para servidores. **BuildKit** es el motor de build por defecto desde Docker 23; añade paralelismo, cache montable y build cross-platform. Nada de esto rompe compatibilidad: tus imágenes OCI corren en cualquiera de los cuatro.

En seguridad, el tsunami post-Log4Shell (dic 2021) empujó **supply chain hygiene** al primer plano: scanning de CVEs (Trivy, Grype), generación de **SBOM** (syft), firma de imágenes (**cosign** / Sigstore) y **SLSA** como framework. Firmar y verificar imágenes es hoy una expectativa razonable en cualquier equipo que se tome producción en serio, no un extra. Este capítulo cubre todo el ciclo: escribir Dockerfiles correctos, construirlos eficientemente, ejecutarlos con `docker-compose` para dev, y endurecerlos para prod.

---

## 2. Fundamentos: imagen, layer, cache (nivel junior)

### 2.1 Anatomía de un Dockerfile mínimo

Empecemos con un ejemplo Node.js **anti-idiomático** típico de tutoriales viejos:

```dockerfile
# ❌ Todo mal: layer cache roto, root user, imagen enorme
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD npm start
```

Problemas: cada cambio en `src/` invalida el cache y reinstala `node_modules` (3-10 min); el `build context` copia todo (`node_modules`, `.git`, `.env`, `dist`); corre como root; usa `shell form` en `CMD` (SIGTERM no propaga); imagen pesa 900 MB.

La versión idiomática y comentada:

```dockerfile
# syntax=docker/dockerfile:1.7-labs
# ✅ Fundamentos aplicados: cache order, non-root, exec form, healthcheck
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Usuario no privilegiado (uid/gid 1001 estable, no dependemos del /etc/passwd default)
RUN groupadd --system --gid 1001 app \
 && useradd  --system --uid 1001 --gid app --home-dir /app --shell /sbin/nologin app

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app . .

USER app
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
```

Cuatro reglas se aplican aquí:

1. **Layer cache order:** dependencies primero (`package*.json` → `npm ci`), código después. Un cambio en `src/` no reinstala `node_modules`.
2. **`npm ci` en lugar de `npm install`**: exige lockfile presente, no lo modifica, es determinístico y más rápido en CI.
3. **`USER app` no root**: reduce dramáticamente el blast radius si tu app tiene una RCE (ver §4.3).
4. **`CMD` en exec form** (`JSON array`): tu proceso es PID 1 y recibe `SIGTERM` directamente (ver §4.4).

### 2.2 `.dockerignore` es obligatorio

Sin `.dockerignore`, `docker build .` envía TODO el directorio al daemon como **build context**. Un `node_modules` local de 400 MB se transfiere en cada build aunque `COPY` filtre después. Ejemplo mínimo para Node:

```gitignore
# .dockerignore
node_modules
npm-debug.log*
.git
.gitignore
.env
.env.*
!.env.example
dist
build
coverage
.vscode
.idea
.DS_Store
*.md
!README.md
Dockerfile*
docker-compose*.yml
```

Verifica antes/después con `docker build .` mirando la línea *"Sending build context to Docker daemon X MB"*. Un context razonable son unos pocos MB, no cientos.

### 2.3 Layer cache: la regla de oro

Docker cachea cada layer basándose en (a) la instrucción exacta y (b) para `COPY`/`ADD`, el hash SHA256 de los archivos copiados. Consecuencia: **ordena de menos cambiante a más cambiante**. Para casi cualquier stack:

```
FROM base
apt-get / apk / yum de OS deps        ← cambia poco
COPY manifiesto de deps (package.json, requirements.txt, go.mod)
RUN instala deps                       ← cachea mientras no cambie el manifest
COPY resto del código                  ← cambia mucho
RUN build (compile, transpile, bundle)
CMD ["arranque"]
```

### 2.4 Ejercicio rápido — mide tu cache

```bash
# 1. Primer build (todo miss)
time docker build -t miapp:v1 .

# 2. Cambia una línea en src/index.js y rebuild
sed -i 's/hola/hola mundo/' src/index.js
time docker build -t miapp:v2 .

# El segundo build debería tardar segundos si el cache está bien ordenado
```

Si el segundo build vuelve a instalar deps, tu `COPY . .` está por delante del `RUN npm ci`. Fix: separa como en §2.1.

---

## 3. Multi-stage builds, BuildKit y tamaño (nivel mid)

### 3.1 Multi-stage: compilar vs ejecutar

Una imagen Go compilada con la toolchain estándar pesa ~1.2 GB. Con multi-stage y `distroless`, baja a **< 15 MB**:

```dockerfile
# syntax=docker/dockerfile:1.7-labs

# ---------- Stage 1: build ----------
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/api ./cmd/api

# ---------- Stage 2: runtime ----------
FROM gcr.io/distroless/static:nonroot
COPY --from=build --chown=nonroot:nonroot /out/api /api
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/api"]
```

Notas: `distroless/static:nonroot` viene con user 65532, sin shell, sin `ls`, sin `cat`. Perfecto para binarios estáticos (Go, Rust compilados con `--target=x86_64-unknown-linux-musl`). Para Java existe `distroless/java`; para Node, `distroless/nodejs`; para Python compilado, `distroless/cc`.

### 3.2 Elegir base image: trade-offs reales

| Base | Tamaño | libc | Shell | Cuándo usar |
|---|---|---|---|---|
| `scratch` | 0 B | ninguna | no | Binarios 100% estáticos (Go, Rust musl) |
| `distroless/static` | ~2 MB | glibc mínima | no | Binarios estáticos que necesitan CA certs, tzdata |
| `distroless/base` / `cc` | ~15-20 MB | glibc completa | no | Binarios dinámicos, C/C++, Python compilado |
| `alpine` | ~5 MB | **musl** | `ash` | Cuando musl no rompe (Go OK, Node/Python cuidado) |
| `debian:slim` / `bookworm-slim` | ~30-80 MB | glibc | `bash` | Node/Python/Ruby dev-friendly |
| `debian` / `ubuntu` | ~200-800 MB | glibc | full | Solo si necesitas herramientas para build |

El error clásico: migrar Node de `node:20` a `node:20-alpine` y que rompan native addons (bcrypt, sharp, sqlite3, canvas). Alpine usa **musl**, no glibc; muchos binarios pre-compilados solo existen para glibc. Alternativa segura: `node:20-slim` (Debian slim) — ~180 MB, glibc, compatible con todo.

### 3.3 BuildKit: features imprescindibles en 2026

Activo por default en Docker 23+ (2023) y Docker Desktop. Escribe siempre `# syntax=docker/dockerfile:1.7-labs` (o superior) en la primera línea para acceder a features modernas.

**Cache mounts** (persisten entre builds sin quedar en la imagen):

```dockerfile
RUN --mount=type=cache,target=/root/.npm npm ci
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
```

**Secret mounts** (no persisten en layers):

```dockerfile
# Uso: DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc .
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,mode=0400 \
    npm ci
```

**Cross-platform builds** con `buildx`:

```bash
# Crea builder multi-arch (una sola vez)
docker buildx create --name multi --use --bootstrap

# Build y push simultáneo para amd64 + arm64
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/tuorg/miapp:1.4.2 \
  --cache-from type=registry,ref=ghcr.io/tuorg/miapp:cache \
  --cache-to   type=registry,ref=ghcr.io/tuorg/miapp:cache,mode=max \
  --push .
```

Esto genera una **manifest list** OCI: al hacer `docker pull` desde un Mac M-series o un servidor Graviton, Docker resuelve automáticamente al binario `arm64`; desde un x86 estándar, al `amd64`.

### 3.4 `COPY` vs `ADD`: usa `COPY`

`ADD` tiene dos features "mágicas" que suelen ser bugs: (1) extrae automáticamente `.tar.gz` locales; (2) descarga desde URL. Ambas rompen intuición y no permiten verificar hash. Regla industrial (`hadolint DL3020`): **usa `COPY` siempre; para descargas, `RUN curl -fsSL --output ... && sha256sum -c ...`**.

### 3.5 Verifica y auditea tu imagen

```bash
# Historial de layers (tamaño por instrucción)
docker history miapp:v1

# Análisis interactivo (permite explorar qué archivo mete cada layer)
dive miapp:v1

# Inspección detallada
docker image inspect miapp:v1 --format '{{.Size}} {{.Config.User}} {{.Config.Cmd}}'

# Diff entre dos versiones
docker image inspect miapp:v1 miapp:v2 --format '{{.Id}} {{.Size}}'
```

`dive` es especialmente útil: te dice el "efficiency score" y qué layers meten basura.

---

## 4. Runtime, redes, volúmenes y signals (nivel mid → senior)

### 4.1 Volumes vs bind mounts vs tmpfs

Tres mecanismos, tres propósitos:

| Tipo | Sintaxis `-v` | Ubicación | Cuándo |
|---|---|---|---|
| **Named volume** | `-v pgdata:/var/lib/postgresql/data` | `/var/lib/docker/volumes/…` gestionado | Persistencia de datos (DB, uploads) |
| **Bind mount** | `-v "$(pwd)/src:/app/src"` | path del host | Dev con hot-reload; configs desde host |
| **tmpfs** | `--tmpfs /tmp:size=64m` | RAM | Secrets efímeros, scratch space |

Setup típico de dev en `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: linguadev
    volumes:
      - pgdata:/var/lib/postgresql/data   # persistente
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    build: ./api
    volumes:
      - ./api/src:/app/src                 # bind mount para hot-reload
      - /app/node_modules                  # anonymous volume evita que node_modules del host tape el de la imagen
    environment:
      DATABASE_URL: postgres://postgres:dev@db:5432/linguadev
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "3000:3000"
    read_only: true                        # rootfs read-only también en dev
    tmpfs:
      - /tmp:size=64m
      - /app/.cache:size=32m

volumes:
  pgdata:
```

Dos verdades incómodas: (1) `depends_on` sin `condition: service_healthy` solo garantiza que el container está *arrancado*, no *listo*; siempre añade healthcheck a servicios stateful; (2) bind mounts en Docker Desktop (Mac/Windows) tienen overhead I/O significativo — para proyectos grandes usa `:cached`/`:delegated` o mueve al backend VZ + VirtioFS.

### 4.2 Redes de Docker: la brújula

- **bridge (default `docker0`)**: legacy, **sin DNS discovery** entre contenedores. Evítalo salvo scripting ad-hoc.
- **user-defined bridge**: recomendado. `docker network create mynet`. Docker embebe un DNS resolver (`127.0.0.11`) que resuelve nombres de contenedor y de servicio de compose. Aislamiento por red.
- **host**: el contenedor comparte el network namespace del host. `--publish` no funciona. Performance marginalmente mejor, pierdes aislamiento. Útil para probes / discovery.
- **none**: sin red. Batch jobs herméticos.
- **overlay**: multi-host (Swarm).
- **macvlan/ipvlan**: contenedor con IP/MAC propia en la LAN física (raro fuera de infra específica).

Compose crea automáticamente un **user-defined bridge** por proyecto. Por eso `db:5432` funciona desde el servicio `api` sin `-p`: la comunicación intra-red usa los puertos **internos**. `--publish HOST:CONTAINER` solo mapea al host para acceso *externo*.

### 4.3 Non-root, capabilities, read-only rootfs

Un compromiso de la app corriendo como root dentro del contenedor combinado con un misconfig del runtime (`--privileged`, `docker.sock` montado, bugs de `runc` como CVE-2019-5736) puede escalar al host. Defense-in-depth apilando:

```bash
docker run \
  --user 1001:1001 \
  --read-only \
  --tmpfs /tmp:size=64m \
  --cap-drop=ALL \
  --cap-add=NET_BIND_SERVICE \
  --security-opt=no-new-privileges:true \
  --security-opt seccomp=/etc/docker/seccomp-default.json \
  --pids-limit=200 \
  --memory=512m --memory-swap=512m --cpus=1.0 \
  -p 8080:8080 \
  miapp:1.4.2
```

Cada flag hace algo concreto: `--cap-drop=ALL` elimina todas las capabilities de Linux (por default un contenedor lleva ~14); `--cap-add=NET_BIND_SERVICE` te permite escuchar en puertos < 1024 sin ser root; `--pids-limit` frena fork bombs; los límites de memoria/CPU vienen de cgroups. En K8s todo esto vive en el `securityContext` del Pod.

### 4.4 `ENTRYPOINT` vs `CMD` y signal handling

**Exec form (JSON array) siempre**. Shell form (`CMD npm start`) envuelve el comando en `/bin/sh -c`, y `sh` se convierte en PID 1; los signals van a PID 1 y `sh` **no los reenvía** por defecto. Consecuencia: `SIGTERM` de `docker stop` no llega a tu proceso, el daemon espera `--stop-grace-period` (default 10 s) y luego `SIGKILL`. Conexiones DB drop-eadas, requests en vuelo perdidas, logs feos.

Reglas:

| Instrucción | Exec form | Shell form |
|---|---|---|
| `ENTRYPOINT` | `["node","index.js"]` PID 1 = node | `node index.js` PID 1 = sh |
| `CMD` args default | `["--config","prod.yaml"]` | igual problema |

Cuando `docker run img arg1 arg2` recibe args: **sustituyen** `CMD`, se **anexan** a `ENTRYPOINT`. Combinación idiomática:

```dockerfile
ENTRYPOINT ["python", "app.py"]
CMD ["--config", "prod.yaml"]
```

`docker run miapp --debug` ejecuta `python app.py --debug` (perdiendo el `--config prod.yaml`).

Si tu binario forkea hijos o necesitas zombie reaping, añade `tini`:

```dockerfile
RUN apt-get install -y tini
ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/index.js"]
```

Y en tu app (Node), implementa un handler decente:

```javascript
// src/graceful.js
const server = require('./server');

async function shutdown(signal) {
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  server.close(async () => {
    await require('./db').end();     // cierra pool DB
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 25_000); // failsafe si algo cuelga
}

for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => shutdown(s));
```

### 4.5 Debugging containers en producción

Con imagen full: `docker exec -it <container> bash`. Con **distroless** o alpine sin bash: no hay shell. Opciones modernas:

- **`docker debug`** (Docker Desktop 4.27+/Docker 25+): attach un container de debugging temporal con toolkit.
- **`kubectl debug`** (K8s 1.25+): **ephemeral containers** que se pegan al Pod compartiendo network/PID namespace.
- **Distroless `:debug` tag**: variantes con `busybox` (solo temporal, no producción normal).
- **`nsenter`** desde el host: `sudo nsenter -t $(docker inspect -f '{{.State.Pid}}' web) -a` entra a todos los namespaces del contenedor.
- **`docker cp`** para extraer core dumps y analizarlos offline con `gdb` o `delve`.
- **Continuous profiling** (pyroscope, parca) sin exec.

---

## 5. Seguridad de imágenes y supply chain (nivel senior)

### 5.1 Scanning: CVEs, config y Dockerfile lint

Pipeline mínimo defensivo en tres capas:

```bash
# 1. Lint del Dockerfile (best practices, DL rules)
hadolint Dockerfile

# 2. Escanear la imagen construida (CVEs)
trivy image --severity HIGH,CRITICAL --exit-code 1 miapp:1.4.2

# 3. Lint de configuración de la imagen (non-root, healthcheck, no latest, no ADD con URL)
dockle miapp:1.4.2

# 4. Generar SBOM (SPDX)
syft miapp:1.4.2 -o spdx-json > miapp-1.4.2.spdx.json

# 5. Firmar la imagen (keyless con OIDC)
cosign sign --yes ghcr.io/tuorg/miapp:1.4.2

# 6. Adjuntar la SBOM firmada como attestation
cosign attest --predicate miapp-1.4.2.spdx.json \
  --type spdxjson \
  ghcr.io/tuorg/miapp:1.4.2
```

En CI GitHub Actions:

```yaml
# .github/workflows/build.yml
name: build-and-scan
on:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write
  id-token: write          # requerido por cosign keyless

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Lint Dockerfile
        uses: hadolint/hadolint-action@v3.1.0
        with: { dockerfile: Dockerfile }

      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.sha }}
            ghcr.io/${{ github.repository }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Trivy scan (fail on HIGH/CRITICAL)
        uses: aquasecurity/trivy-action@0.24.0
        with:
          image-ref: ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
          severity: HIGH,CRITICAL
          exit-code: '1'
          ignore-unfixed: true

      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          image: ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
          format: spdx-json

      - name: Install cosign
        uses: sigstore/cosign-installer@v3

      - name: Sign image (keyless)
        run: cosign sign --yes ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
```

### 5.2 Secrets: nunca en el Dockerfile

`ENV DATABASE_PASSWORD=super-secret-123` **se hornea en la imagen** y es visible con `docker history` o `docker inspect`. `ARG` es igual de peligroso (queda en el history). Reglas duras:

- **Build-time secrets**: `RUN --mount=type=secret,id=x,target=/tmp/x` (BuildKit).
- **Runtime secrets**: `docker run -e VAR=...`, `docker run --env-file .env`, Docker/Swarm secrets, o inyección desde un secret manager (Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault) vía sidecar o CSI driver.
- **En K8s**: `Secret` objects (base64, **no** encriptados por default en etcd; habilita KMS encryption), o mejor External Secrets Operator.
- **Rotación regular** y auditoría con GitHub secret scanning + git-secrets como pre-commit.

### 5.3 Tags inmutables, digests y admission control

`:latest` es *rolling*: el mismo tag apunta a distintos digests con el tiempo. Rollback es imposible sin conocer el digest anterior. Prácticas:

- **Semver** (`myapp:1.4.2`) para libraries y bases estables.
- **Git SHA** (`myapp:git-abc123f` o `myapp:sha-abc123f`) para deploys de app — determinístico y trazable.
- **Pinning por digest**: `image: ghcr.io/org/app@sha256:e3b0c...` — inmutable de por vida.
- **Bloquea `:latest`** con admission controllers en K8s: **Kyverno** o **Gatekeeper** con políticas que rechacen imágenes sin digest o con tag mutable.

### 5.4 Docker Hub rate limits y registry propio

Desde nov 2020: **100 pulls/6h por IP anónima**, 200/6h con cuenta free. En CI con IPs compartidas (Actions runners, GitLab shared runners) el límite se agota rápido y los pipelines fallan con `429 Too Many Requests`. Opciones:

- Autenticar (`docker login`) con cuenta Pro / Team.
- **Pull-through cache** propio (Harbor, JFrog Artifactory, Nexus) que sirve como espejo.
- Migrar imágenes propias a **GHCR / ECR / GCR / ACR** (baratos o gratis).
- Servir bases desde `gcr.io/distroless`, `quay.io`, `public.ecr.aws` — no aplican los límites de Docker Hub.

### 5.5 Podman, containerd y el ecosistema OCI

- **Podman 5** (Red Hat): daemonless, rootless por default, CLI compatible (`alias docker=podman` funciona en la mayoría de casos). Corre las mismas imágenes OCI que Docker.
- **containerd 2.x**: runtime low-level usado por Docker Engine y por Kubernetes desde 1.24 (2022). CLI directo con `nerdctl`.
- **CRI-O**: runtime específico para K8s, integrado con el ecosistema Red Hat/OpenShift.
- **Docker Desktop 4.x** en 2026 experimenta con containerd embebido en el daemon (Docker 29 lo tiene como opcional).

La regla: **el formato OCI garantiza que tu imagen corre en cualquier runtime**. La elección es política/operacional (licencia, rootless, sysadmin comfort), no técnica.

---

## 6. Ejemplo completo: `linguadev-pro` en Docker

Aplicamos lo aprendido al monorepo real. Estructura simplificada:

```
linguadev-pro/
├── apps/pwa/          # Next.js 15
├── packages/api/      # Node 20 + Fastify (para dev; en prod Lambdas)
├── docker/
│   ├── pwa.Dockerfile
│   ├── api.Dockerfile
│   └── docker-compose.yml
└── .dockerignore
```

### 6.1 Dockerfile de la API (Node 20)

```dockerfile
# syntax=docker/dockerfile:1.7-labs
# docker/api.Dockerfile
ARG NODE_VERSION=20.17

FROM node:${NODE_VERSION}-slim AS base
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @lingua/api...

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/api    packages/api
RUN pnpm --filter @lingua/api build \
 && pnpm deploy --filter @lingua/api --prod /out/api

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 1001 app \
 && useradd  --system --uid 1001 --gid app --home-dir /app --shell /sbin/nologin app

COPY --from=build --chown=app:app /out/api /app

USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```

### 6.2 `docker-compose.yml` para dev

```yaml
# docker/docker-compose.yml
name: linguadev

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: lingua
      POSTGRES_PASSWORD: dev_only_password
      POSTGRES_DB: linguadev
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U lingua -d linguadev"]
      interval: 3s
      timeout: 2s
      retries: 10

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      retries: 10

  api:
    build:
      context: ..
      dockerfile: docker/api.Dockerfile
      cache_from:
        - type=registry,ref=ghcr.io/linguadev/api:cache
    environment:
      DATABASE_URL: postgres://lingua:dev_only_password@db:5432/linguadev
      REDIS_URL: redis://redis:6379
      NODE_ENV: development
    volumes:
      - ../packages/api/src:/app/src:cached
      - /app/node_modules
    depends_on:
      db:    { condition: service_healthy }
      redis: { condition: service_healthy }
    ports:
      - "3000:3000"
    read_only: true
    tmpfs:
      - /tmp:size=64m
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true

volumes:
  pgdata:
```

### 6.3 Comandos de trabajo diario

```bash
# Levantar todo con logs bonitos
docker compose -f docker/docker-compose.yml up --build

# Solo la DB (para correr la API fuera de docker mientras iteras)
docker compose -f docker/docker-compose.yml up -d db redis

# Ver logs de la API en vivo
docker compose logs -f api

# Ejecutar migraciones
docker compose exec api node dist/scripts/migrate.js

# Reset del volumen de DB (destructivo)
docker compose down -v && docker compose up -d db

# Auditar tamaño y layers de la imagen final
docker build -f docker/api.Dockerfile -t lingua-api:local .
dive lingua-api:local
```

---

## 7. Cheatsheet y anti-patrones

### Reglas de oro

- ✅ **`.dockerignore` siempre.** Antes que cualquier otra optimización.
- ✅ **Layer cache order**: deps antes que código.
- ✅ **`npm ci`, `pip install --no-cache-dir --require-hashes`, `go mod download` con lockfile.**
- ✅ **Multi-stage build** con base minimalista (`distroless`, `slim`, `alpine`).
- ✅ **`USER` non-root** con UID/GID explícitos (1001+).
- ✅ **`CMD` / `ENTRYPOINT` en exec form** (JSON array).
- ✅ **`HEALTHCHECK`** para servicios expuestos.
- ✅ **Tags versionados o SHA**, nunca `:latest` en producción.
- ✅ **Pinning por digest** (`@sha256:…`) para imágenes de terceros críticas.
- ✅ **Trivy + hadolint + dockle** en CI, con `--exit-code 1` en HIGH/CRITICAL.
- ✅ **Firma con `cosign`** y publica SBOM (`syft`).
- ✅ **Secrets fuera del Dockerfile**: BuildKit `--mount=type=secret` o secret manager en runtime.
- ✅ **Compose con healthcheck + `service_healthy`** para dependencies.
- ✅ **Registry propio o pull-through cache** para evitar rate limits de Docker Hub.
- ✅ **`read_only: true` + `tmpfs`** también en dev, para paridad con prod.

### Anti-patrones

- ❌ `FROM ubuntu` sin motivo (~800 MB → usa slim/alpine/distroless).
- ❌ `COPY . .` antes del `RUN` que instala deps.
- ❌ `RUN apt-get install ... && apt-get install ...` en múltiples layers (une con `&&`, `--no-install-recommends`, `rm -rf /var/lib/apt/lists/*`).
- ❌ `CMD npm start` (shell form): PID 1 = sh, no propaga signals.
- ❌ `USER root` implícito (por defecto).
- ❌ `ADD` cuando basta `COPY`.
- ❌ `ENV PASSWORD=xxx` o `ARG SECRET=xxx`.
- ❌ `:latest` en producción.
- ❌ `docker run --privileged` a menos que sepas exactamente por qué.
- ❌ Montar `/var/run/docker.sock` en un contenedor sin defensa (root al host).
- ❌ `docker system prune -a --volumes` en dev con datos importantes (borra volúmenes no montados en ese momento).
- ❌ Ignorar `depends_on: condition: service_healthy` y usar `sleep 10` en el entrypoint.
- ❌ Bind mounts en Docker Desktop Mac/Windows sobre `node_modules` grandes (I/O muerto — usa anonymous volume).
- ❌ Confiar en "imagen oficial" sin escanear (nginx, postgres oficiales han tenido CVEs high).

### Tabla de decisión: base image

| App | Base recomendada 2026 |
|---|---|
| Go / Rust static | `gcr.io/distroless/static:nonroot` |
| Go / Rust dynamic | `gcr.io/distroless/base:nonroot` |
| Node.js server | `node:20-slim` (o `distroless/nodejs20` si maduro para tu stack) |
| Python API | `python:3.12-slim` con `USER app`, o `distroless/python3` si funciona |
| Java 21+ | `eclipse-temurin:21-jre` o `distroless/java21` |
| Static site | `nginxinc/nginx-unprivileged:alpine` o `caddy:alpine` |
| CLI tool | `alpine:3.20` |

---

## 8. Casos reales 2020-2026

**Docker Hub rate limits (nov 2020):** Docker introdujo límites de pulls anónimos (100/6h por IP). Rompió miles de pipelines en un fin de semana. Aceleró la migración a GHCR/ECR y adopción de pull-through caches (Harbor, Nexus, JFrog).

**Docker Desktop pricing enterprise (ago 2021):** Docker Inc. anunció licenciamiento pagado para empresas de >250 empleados o >10 M USD de revenue. Muchas orgs migraron a **Rancher Desktop**, **Podman Desktop**, **Colima** (Mac) o **OrbStack**.

**dockershim removal en K8s 1.24 (may 2022):** Kubernetes eliminó el shim para hablar con Docker Engine. Clusters migraron a **containerd** (mayoritario) o **CRI-O**. No afectó a las imágenes en sí (OCI); sí a operadores que dependían de `docker` en los nodos.

**Log4Shell (dic 2021):** vulnerabilidad crítica en `log4j` (CVSS 10.0). Millones de imágenes con la versión vulnerable en producción. Wake-up call que empujó SBOM, scanning continuo y **SLSA** (Google) como framework de supply chain.

**runc CVE-2019-5736:** un container malicioso podía sobrescribir el binario de runc del host y ganar root. Fix rápido, pero el evento consolidó la práctica de correr **rootless** siempre que sea posible.

**Docker Engine 27 (jun 2024) → 28 (feb 2025) → 29 (2026):** cadencia trimestral, mejoras en BuildKit, cache remoto, y containerd embebido (opcional en 29 como experimento).

**Docker Scout (2023+):** Docker Inc. lanzó su producto de análisis de imágenes y policy engine, competencia directa de Trivy/Snyk. Integrado en Docker Desktop.

**Podman en producción (2022-2026):** Red Hat empujó fuerte en RHEL/Fedora; Podman 5 (2024) consolidó compose compatibility y rootless. Muchas orgs Linux migraron.

**Docker Build Cloud (2024):** BuildKit hosteado con caché compartida y builders multi-arch nativos, apuntando a builds de CI < 30 s incluso en repos grandes.

---

## 9. Ejercicios prácticos

### Ejercicio 1 — Reduce una imagen Node de 900 MB a < 200 MB

**Objetivo:** aplicar multi-stage + slim + `.dockerignore` + layer order.

**Setup:** un proyecto Node cualquiera con `package.json`, `src/`, `dist/`.

**Pasos:**
1. Parte del Dockerfile "anti-idiomático" del §2.1 y mide con `docker images`.
2. Añade `.dockerignore` con `node_modules`, `.git`, `.env*`, `dist`.
3. Migra base a `node:20-slim`.
4. Reordena: `package*.json` → `RUN npm ci --omit=dev` → `COPY . .`.
5. Convierte a multi-stage: stage `build` (con dev deps y compile) + stage `runtime` (solo prod deps + `dist/`).
6. Añade `USER app` y `HEALTHCHECK`.
7. Compara `docker images` antes/después.

**Criterios de éxito:**
- [ ] `.dockerignore` reduce build context a < 10 MB.
- [ ] Imagen final < 200 MB.
- [ ] Rebuild tras cambio en `src/` en < 15 s.
- [ ] `docker inspect` muestra `User: "app"` (no vacío).
- [ ] `HEALTHCHECK` presente; `docker ps` muestra `(healthy)` tras arrancar.

**Bonus:** cambia base a `gcr.io/distroless/nodejs20-debian12:nonroot` y verifica que aún funciona.

---

### Ejercicio 2 — Docker Compose con healthchecks reales

**Objetivo:** montar un stack API + Postgres + Redis donde la API espere al `service_healthy` de sus dependencies.

**Setup:** carpeta con `Dockerfile` de una API mínima y un `docker-compose.yml` vacío.

**Pasos:**
1. Escribe `docker-compose.yml` con servicios `db` (postgres:16-alpine), `redis` (redis:7-alpine) y `api` (build local).
2. Añade `healthcheck` a `db` con `pg_isready` y a `redis` con `redis-cli ping`.
3. En `api`, declara `depends_on` con `condition: service_healthy` para ambos.
4. Añade `read_only: true`, `cap_drop: [ALL]`, `tmpfs: /tmp`.
5. Arranca con `docker compose up` y observa el orden.
6. Prueba borrar el healthcheck de `db` y comprueba que la API arranca antes que Postgres esté listo (verás errores de conexión).

**Criterios de éxito:**
- [ ] `docker compose up` arranca `db`+`redis`, espera al `healthy`, luego arranca `api`.
- [ ] `docker inspect api` muestra `ReadonlyRootfs: true`.
- [ ] `docker exec api touch /etc/foo` falla; `docker exec api touch /tmp/foo` funciona.
- [ ] Sin el `healthcheck`, la API loguea `ECONNREFUSED` los primeros segundos.

**Bonus:** añade un servicio `migrate` con `restart: "no"` y `depends_on: { db: { condition: service_healthy } }` que corra las migraciones una vez.

---

### Ejercicio 3 — Escaneo de vulnerabilidades y SBOM en CI

**Objetivo:** integrar Trivy y syft en un pipeline GitHub Actions.

**Setup:** repo con `Dockerfile` y GitHub Actions habilitado.

**Pasos:**
1. Copia el workflow de §5.1 a `.github/workflows/build.yml`.
2. Ajusta el nombre del repo/imagen.
3. Introduce a propósito una dependency vulnerable (`express@4.17.1` en Node, `flask==0.12` en Python) para forzar un HIGH.
4. Empuja y observa que el job **falle** en el paso Trivy.
5. Corrige, empuja de nuevo, confirma verde.
6. Descarga el SBOM del artifact del workflow y ábrelo.

**Criterios de éxito:**
- [ ] `hadolint` corre y pasa (Dockerfile sin warnings HIGH).
- [ ] `trivy` falla con CVE HIGH/CRITICAL y pasa cuando se corrige.
- [ ] SBOM SPDX-JSON generado y descargable.
- [ ] Imagen firmada con cosign verificable con `cosign verify --certificate-identity-regexp='...' ghcr.io/…`.

**Bonus:** añade `dockle` como paso adicional y arregla los warnings.

---

### Ejercicio 4 — Signals y graceful shutdown

**Objetivo:** demostrar la diferencia entre shell form y exec form.

**Setup:** app Node/Python con handler de `SIGTERM` que loguea "cerrando…".

**Pasos:**
1. Escribe la app con handler que loguea al recibir `SIGTERM` y sale con exit 0.
2. Dockerfile A: `CMD node index.js` (shell form).
3. Dockerfile B: `CMD ["node", "index.js"]` (exec form).
4. Corre A: `docker run -d --name a img-a`; envía stop: `time docker stop a`. Observa logs con `docker logs a`.
5. Corre B: mismo test. Compara.
6. Añade `STOPSIGNAL SIGINT` a la B y prueba `docker stop --time=2 b`.

**Criterios de éxito:**
- [ ] Con shell form, `docker stop` tarda ~10 s (grace period → SIGKILL) y no hay log "cerrando".
- [ ] Con exec form, `docker stop` tarda < 1 s y hay log "cerrando…".
- [ ] `docker inspect a` vs `b` muestra distinto `Path` y `Args` (uno con `/bin/sh -c`).

**Bonus:** añade `tini` como init y verifica que se comporta como exec form.

---

### Ejercicio 5 — Publicación multi-arch a GHCR con `buildx`

**Objetivo:** publicar tu imagen para `linux/amd64` y `linux/arm64` en un solo build.

**Setup:** cuenta GitHub con `GHCR_TOKEN` (o usa el `GITHUB_TOKEN` en Actions).

**Pasos:**
1. Crea builder: `docker buildx create --name multi --use --bootstrap`.
2. `docker login ghcr.io -u tuusuario --password-stdin < token.txt`.
3. `docker buildx build --platform linux/amd64,linux/arm64 --tag ghcr.io/tuusuario/miapp:1.0.0 --push .`.
4. Verifica la manifest list: `docker buildx imagetools inspect ghcr.io/tuusuario/miapp:1.0.0`.
5. Desde un Mac M-series, `docker pull` y comprueba que baja `arm64`.
6. Automatízalo en GitHub Actions con `docker/build-push-action@v6`.

**Criterios de éxito:**
- [ ] `imagetools inspect` muestra 2 manifests (amd64 + arm64).
- [ ] `docker pull` selecciona automáticamente la arch correcta.
- [ ] La imagen arm64 corre en Mac M-series sin `qemu` warnings.
- [ ] El pipeline de Actions completa el build+push en < 5 min con cache.

**Bonus:** añade `--cache-to type=registry,ref=…:cache,mode=max` y comprueba que el segundo build tarda < 1 min.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales de dev a staff. Cubren: layer cache y orden de instrucciones, multi-stage y `distroless`, non-root user y hardening, `ENTRYPOINT` vs `CMD` (exec vs shell form), volumes vs bind mounts vs tmpfs, `.dockerignore` y build context, networking bridge/user-defined/host y DNS interno, trade-offs de base images (alpine/musl vs slim/glibc), `docker-compose` con healthcheck y `service_healthy`, scanning (Trivy, Snyk, hadolint, Dockle) y SBOM/cosign, signal handling y PID 1, Docker Hub rate limits, secrets en Dockerfile (nunca), `docker system prune` y sus riesgos, Podman/containerd/CRI-O y OCI, `COPY` vs `ADD`, BuildKit y builds multi-arch, debugging en producción con `docker debug` / ephemeral containers, tag `:latest` vs digests, y dev/prod parity 12-factor.

- **Fuente:** [`packages/content/src/tech/programmer/sim-13-docker-and-containers.json`](../../packages/content/src/tech/programmer/sim-13-docker-and-containers.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-13-docker-and-containers`
- **Tiempo:** 25 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 12 — Git y colaboración](./12-git-y-colaboracion.md) · [Índice](./README.md) · [Capítulo 14 — Linux y shell →](./14-linux-y-shell.md)
