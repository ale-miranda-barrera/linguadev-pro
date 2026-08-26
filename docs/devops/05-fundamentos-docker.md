# Capítulo 05 — Fundamentos de Docker y best practices de imágenes

> **Focus:** Qué es realmente un contenedor (namespaces + cgroups), cómo escribir Dockerfiles de producción, cache de capas, multi-stage builds, imágenes minimales, seguridad de runtime y BuildKit moderno con builds multi-arch.
> **Áreas:** Containers · Build systems · Local orchestration
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Línea de comandos Unix cómoda (`ls`, `chmod`, `chown`, `find`, pipes).
- Conocer un lenguaje de aplicación (Node, Python o Go) suficiente para compilar un binario o servir HTTP.
- Nociones de CI/CD y un pipeline de deploy (ver [cap 04](./04-github-actions-y-jenkins.md)).
- Idea general de qué es una VM: virtualización de hardware y hypervisors.

**Glosario mínimo:**
- **Namespace (Linux)**: primitiva del kernel (2002+) que aísla recursos por proceso. Tipos: `pid`, `net`, `mnt`, `uts`, `ipc`, `user`, `cgroup`.
- **cgroup v2**: control groups unificados; limitan y miden CPU, memoria, IO por grupo de procesos. Kernel 4.5+ para v2, estándar en 2026.
- **OCI (Open Container Initiative)**: estándares de imagen (`image-spec`), runtime (`runtime-spec`) y distribución (`distribution-spec`).
- **containerd**: runtime de contenedores CNCF graduado; usado por Docker Engine, Kubernetes (CRI) y muchos otros.
- **BuildKit**: motor de build de Docker (2018+), con grafo concurrente, cache remoto, mount caches y frontend Dockerfile v1.
- **Buildx**: plugin CLI de Docker sobre BuildKit para builds multi-plataforma (linux/amd64, linux/arm64, linux/arm/v7).
- **Multi-stage build**: Dockerfile con múltiples `FROM`; solo el último stage entra a la imagen final.
- **Distroless**: familia de imágenes de Google (`gcr.io/distroless/*`) con solo el runtime + tu app; sin shell, sin package manager.
- **SBOM**: Software Bill of Materials; lista firmable de componentes de una imagen (más en [cap 06](./06-container-security-y-registries.md)).

**Setup mínimo (Docker Engine 29, agosto 2026):**

```bash
# 1. Verificar versiones
docker version --format '{{.Server.Version}} · buildkit {{.Server.BuildkitVersion}}'
# Esperado en 2026-08: Server 29.6.x · buildkit 0.32.x

# 2. Activar containerd image store (recomendado desde Docker 25+)
sudo mkdir -p /etc/docker
cat <<'EOF' | sudo tee /etc/docker/daemon.json
{
  "features": { "containerd-snapshotter": true },
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sudo systemctl restart docker

# 3. Configurar builder buildx multi-arch con QEMU
docker buildx create --name multi --driver docker-container --use --bootstrap
docker buildx inspect --bootstrap

# 4. Probar build minimal
mkdir /tmp/hello && cd /tmp/hello
cat <<'EOF' > Dockerfile
FROM scratch
COPY hello /hello
ENTRYPOINT ["/hello"]
EOF
```

Todo lo que sigue asume Docker Engine 29.x, BuildKit 0.32.x y Buildx v0.18+. Si trabajas con versiones anteriores algunas features (native ImageVolume, `RUN --mount=type=cache` sharing modes, sboms integrados en buildx) pueden variar.

---

## 1. El gran cuadro

En 2013 Solomon Hykes empaquetó namespaces + cgroups + un formato de imagen apilable + un CLI usable y llamó al resultado **Docker**. Los primitives del kernel llevaban años en producción en Google (Borg, LMCTFY) y en LXC, pero la fricción era enorme. Docker convirtió "un proceso aislado en Linux" en tres comandos (`build`, `push`, `run`) y desató una década de reorganización de la industria: registries, orquestadores (Kubernetes, Nomad, ECS), pipelines CI/CD basados en imágenes, distribución de software, telemetría, seguridad supply chain. Trece años después el ecosistema es maduro pero también fragmentado. Ya no basta con `docker build .`: hay que decidir base image, multi-stage vs single stage, cache remoto, user namespace, escaneo de vulnerabilidades, firma con cosign, SBOM y arquitecturas múltiples.

Este capítulo cubre la base: qué es realmente un contenedor, por qué el orden de instrucciones en un Dockerfile decide si tu build tarda 5 segundos o 5 minutos, cómo un `FROM node:20-alpine` puede ser peor que `distroless/nodejs20` para producción, cuándo `ENTRYPOINT` conviene sobre `CMD`, y por qué correr como root sigue siendo la vulnerabilidad #1 en contenedores en 2026 (los estudios de Sysdig 2025 y Snyk State of Open Source 2026 lo repiten cada año). El capítulo cierra con BuildKit avanzado (mount caches, secrets, SSH, multi-arch con QEMU) y con `docker compose` frente a Podman/Nerdctl.

El **stack de contenedores 2026** se ve así de arriba hacia abajo: CLI (Docker, Podman, Nerdctl) → API/daemon (dockerd, podman remote, containerd shim) → runtime OCI (runc, crun, youki, gVisor, kata) → kernel Linux con namespaces + cgroups v2 + seccomp + apparmor/selinux. Kubernetes usa containerd + runc por defecto; Docker Desktop en Mac/Windows corre una VM Linux ligera. Elegir bien la capa donde se juega tu abstracción (Dockerfile vs Buildpacks vs Nix vs Ko) es una decisión arquitectónica, no cosmética.

---

## 2. Qué es realmente un contenedor (nivel básico)

Un contenedor **no es una VM**. Una VM emula hardware, arranca un kernel completo y consume gigabytes de RAM base. Un contenedor es **un proceso Linux normal** al que el kernel le ha aplicado varios namespaces (para que no vea otros procesos, red, filesystem, hostname del host), cgroups (para limitar CPU, RAM, IO) y capabilities restringidas. Comparte el kernel del host: por eso arranca en milisegundos y usa ~50 MB de memoria adicional en lugar de 1-2 GB.

Las siete namespaces relevantes:

| Namespace | Aísla | Comando de inspección |
|---|---|---|
| `pid` | árbol de procesos (PID 1 dentro del contenedor) | `ps aux` |
| `net` | interfaces, iptables, sockets | `ip a`, `ss -tlnp` |
| `mnt` | tabla de mounts, rootfs propio | `cat /proc/mounts` |
| `uts` | hostname, domain | `hostname` |
| `ipc` | System V IPC, POSIX message queues | `ipcs` |
| `user` | mapeo UID/GID host↔contenedor | `id`, `cat /proc/self/uid_map` |
| `cgroup` | vista del árbol cgroup | `cat /proc/self/cgroup` |

Y los tres pilares complementarios:

1. **cgroups v2** limitan recursos: `--memory=512m --cpus=1.5` traduce a `memory.max` y `cpu.max` en `/sys/fs/cgroup`.
2. **Capabilities**: root está partido en ~40 privilegios finos (`CAP_NET_ADMIN`, `CAP_SYS_TIME`…). Los contenedores solo reciben un subconjunto por defecto.
3. **Seccomp + AppArmor/SELinux**: filtros de syscalls y MAC por perfil. Docker aplica un `default.json` seccomp que bloquea ~40 syscalls peligrosas.

Puedes verlo tú mismo desde el host:

```bash
# En terminal 1
docker run --rm -it --name demo alpine sh -c "sleep 3600"

# En terminal 2 (host)
PID=$(docker inspect --format '{{.State.Pid}}' demo)
sudo ls -l /proc/$PID/ns/
# Verás: pid, net, mnt, uts, ipc, user, cgroup como symlinks a inodes distintos al del host

# Comparar el rootfs
sudo ls /proc/$PID/root/
# Verás el filesystem alpine, no el de tu host
```

Este es el momento "aha": no hay magia. Es un proceso con vistas restringidas. La imagen es solo un tarball apilado de layers (union filesystem: overlayfs por defecto en 2026) que se monta como rootfs cuando arranca.

---

## 3. Anatomía de un Dockerfile (nivel básico)

Un Dockerfile es una **receta declarativa**: cada instrucción produce (habitualmente) una layer del filesystem final. Las 12 instrucciones que realmente se usan en producción:

```dockerfile
# 1. Base image — SIEMPRE fijar tag o digest
FROM node:20.18.1-alpine3.20@sha256:...
# 2. Metadata legible por máquinas (opencontainers labels)
LABEL org.opencontainers.image.source="https://github.com/miorg/miapp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="miapp-api"
# 3. Variables de build (no persisten en runtime)
ARG APP_VERSION=0.0.0
# 4. Variables de runtime (persisten)
ENV NODE_ENV=production PORT=8080
# 5. Directorio de trabajo (se crea si no existe)
WORKDIR /app
# 6. Copiar solo lo necesario primero (para cache)
COPY package.json package-lock.json ./
# 7. Ejecutar comando en build (crea layer nueva)
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
# 8. Copiar el resto del código
COPY src ./src
# 9. Cambiar a usuario no-root
USER node
# 10. Documentar puerto (metadata, NO abre el puerto)
EXPOSE 8080
# 11. Health check nativo Docker
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
# 12. Proceso PID 1 en exec form (recibe SIGTERM correctamente)
ENTRYPOINT ["node", "src/server.js"]
```

Reglas hard-earned:

- **Siempre exec form** (`["cmd", "arg"]`) y no shell form (`cmd arg`). Con shell form el PID 1 es `/bin/sh -c`, no tu proceso, y `SIGTERM` de Kubernetes no llega a tu app.
- **Fijar la base** con tag específico + digest (`node:20.18.1-alpine3.20@sha256:...`). `latest` es una bomba de tiempo.
- **`COPY` sobre `ADD`**: `ADD` hace tar extraction y descarga URLs, dos features de las que te arrepentirás. Usa `COPY` para todo y `curl`/`wget` explícitos para descargas.
- **Un `RUN` por operación lógica** con `&& \` para encadenar comandos que deben compartir layer (`apt-get update && apt-get install -y ... && rm -rf /var/lib/apt/lists/*`). No dejes cache de apt en la imagen.
- **`EXPOSE` es documentación**, no publica el puerto. La publicación real se hace con `-p` en `docker run` o con Service en Kubernetes.

---

## 4. Cache de layers y orden de instrucciones (nivel medio)

BuildKit calcula un hash por instrucción a partir de sus entradas (base + comando + contexto). Si un hash coincide con un layer previamente construido, se reutiliza; si no, se rebuildan **esa layer y todas las posteriores**. Consecuencia práctica: **coloca lo que cambia menos arriba y lo que cambia más abajo**.

Anti-ejemplo (build cae al full reinstall en cada cambio de código):

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .              # copia código + package.json en una layer
RUN npm ci            # cualquier cambio en un .ts invalida esta layer
CMD ["node", "src/server.js"]
```

Versión correcta:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY src ./src        # cambios de código no invalidan npm ci
CMD ["node", "src/server.js"]
```

**Medición real** (repo Node 200 MB, 900 deps, MacBook M3):

| Cambio | Sin optimizar | Con orden + `--mount=cache` |
|---|---|---|
| Primera build | 78 s | 82 s |
| Cambio en `src/server.ts` | 74 s | 4 s |
| Cambio en `package.json` (una dep nueva) | 76 s | 22 s |

El `RUN --mount=type=cache,target=/root/.npm` (feature de BuildKit) preserva el cache de npm entre builds independientes; no forma parte de la layer, no se sube al registry, y cambia el juego para lenguajes con cache pesado (Maven `~/.m2`, Go `/root/.cache/go-build`, pip `~/.cache/pip`, cargo `~/.cargo/registry`).

**Modos de mount cache** (BuildKit 0.14+):

- `sharing=shared` (default): múltiples builds concurrentes usan el mismo cache.
- `sharing=private`: se crea uno por build. Útil si el gestor no es thread-safe.
- `sharing=locked`: builds toman lock secuencial.

Y para exportar cache a un registry remoto (imprescindible en CI):

```bash
docker buildx build \
  --cache-to   type=registry,ref=ghcr.io/miorg/miapp:cache,mode=max \
  --cache-from type=registry,ref=ghcr.io/miorg/miapp:cache \
  -t ghcr.io/miorg/miapp:$(git rev-parse --short HEAD) \
  --push .
```

`mode=max` guarda **todas** las layers intermedias en el cache remoto; `mode=min` solo el final. En CI grandes `max` ahorra minutos por build a costa de espacio.

---

## 5. Multi-stage builds e imágenes minimales (nivel medio)

Un Dockerfile con un solo `FROM` empaqueta el compilador, las dev-deps, el árbol de fuentes y hasta los tests. Eso son cientos de MB innecesarios en producción y una superficie de ataque enorme. Los **multi-stage builds** (introducidos en Docker 17.05, 2017) permiten construir en un stage "grueso" y copiar solo los artefactos al stage "delgado" final.

Ejemplo Go compilando a binario estático + `FROM scratch`:

```dockerfile
# syntax=docker/dockerfile:1.9
FROM --platform=$BUILDPLATFORM golang:1.23.4-alpine AS builder
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=${APP_VERSION}" \
    -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
COPY --from=builder /out/server /server
USER nonroot:nonroot
ENTRYPOINT ["/server"]
```

Tamaños medidos:

| Base | Tamaño imagen |
|---|---|
| `golang:1.23` (build + run) | 940 MB |
| `alpine:3.20` + binario | 12 MB |
| `distroless/static-debian12:nonroot` + binario | 4.9 MB |
| `scratch` + binario static | 3.8 MB |

**Cuándo elegir cada base:**

- **`scratch`** para binarios estáticos (Go con `CGO_ENABLED=0`, Rust con `x86_64-unknown-linux-musl`, Zig). Cero attack surface, pero necesitas incluir CA certs y `/etc/passwd` a mano.
- **`distroless/static-debian12:nonroot`**: static binaries con CA certs, tzdata, nsswitch y usuario nonroot ya presentes. Estándar de facto para Go en 2026.
- **`distroless/base-debian12`, `distroless/cc-debian12`**: para binarios dinámicos que necesitan glibc o libgcc.
- **`distroless/nodejs20-debian12`, `distroless/python3-debian12`**: runtimes de lenguaje. No hay shell; para debug usa la variante `:debug` con busybox.
- **`alpine:3.20`**: útil cuando necesitas shell y `apk` en runtime. Cuidado con musl vs glibc: algunos módulos nativos de Node (bcrypt, sharp, node-canvas) tienen wheels solo glibc.
- **`ubuntu:24.04` / `debian:12-slim`**: solo cuando dependes de librerías del sistema. Añade 30-80 MB base y muchas más CVEs.

Alternativa moderna: **Chainguard Images** (`cgr.dev/chainguard/*`), imágenes firmadas con cosign, SBOM incluido, actualización de CVEs diaria. Popularidad creciente en 2026 para regulated industries.

---

## 6. ENTRYPOINT vs CMD, ARG vs ENV, señales y PID 1 (nivel medio)

**ENTRYPOINT vs CMD** confunde a todo el mundo. La regla operativa:

- `ENTRYPOINT` = comando **fijo** (no se sobreescribe con args de `docker run`).
- `CMD` = **argumentos por defecto** al ENTRYPOINT (o comando por defecto si no hay ENTRYPOINT). Sí se sobreescribe.

Combinaciones:

```dockerfile
# Patrón "app tuya": binario fijo, args configurables
ENTRYPOINT ["/server"]
CMD ["--port", "8080", "--log-level", "info"]
# docker run img                → /server --port 8080 --log-level info
# docker run img --port 9000    → /server --port 9000   (CMD sobrescrito)
# docker run --entrypoint sh img → sh (ENTRYPOINT sobrescrito para debug)
```

**ARG vs ENV**:

- `ARG` existe **solo en build**. No aparece en `docker inspect` ni en el proceso runtime.
- `ENV` persiste en runtime, visible con `printenv`.
- `ARG` **antes** de `FROM` es especial: solo válido para el `FROM` propio.
- **Peligroso**: pasar secretos por `ARG` los deja **visibles en la layer**. Usa `RUN --mount=type=secret,id=npm_token` en su lugar.

Ejemplo secreto seguro:

```bash
export NPM_TOKEN=abc123
docker buildx build \
  --secret id=npm_token,env=NPM_TOKEN \
  -t miapp .
```

```dockerfile
RUN --mount=type=secret,id=npm_token \
    npm config set //registry.npmjs.org/:_authToken=$(cat /run/secrets/npm_token) && \
    npm ci && \
    npm config delete //registry.npmjs.org/:_authToken
```

El secret nunca queda en ninguna layer.

**Señales y PID 1**: Kubernetes envía `SIGTERM` al PID 1 en `terminationGracePeriodSeconds`. Si tu PID 1 es `sh -c "node server.js"`, `sh` ignora SIGTERM por defecto y tu app se queda hasta el SIGKILL a los 30 s. Soluciones:

1. **Exec form siempre**: `ENTRYPOINT ["node", "server.js"]`.
2. **Init system ligero** como [`tini`](https://github.com/krallin/tini) o Docker's `--init`. Recomendado para procesos que hacen fork o generan zombies.
3. **Handler explícito en tu app**: en Node `process.on('SIGTERM', ...)`, en Python `signal.signal(signal.SIGTERM, ...)`.

En Kubernetes 1.34 hay una `terminationGracePeriodSeconds` por container (además del pod-level), útil para sidecars que necesitan más tiempo que el main.

---

## 7. Usuario no-root, capabilities y read-only filesystem (nivel medio-avanzado)

Correr como root sigue siendo el finding #1 de auditorías de contenedores en 2026. La superficie de ataque cuando `runc` tiene un CVE (`CVE-2019-5736`, `CVE-2024-21626`) es escapada de contenedor con privilegios de root en el host. La mitigación básica cuesta 4 líneas en un Dockerfile:

```dockerfile
FROM alpine:3.20
RUN addgroup -g 10001 app && \
    adduser -u 10001 -G app -s /sbin/nologin -D app
COPY --chown=app:app server /home/app/server
USER 10001:10001
ENTRYPOINT ["/home/app/server"]
```

Nota: usar **UID numérico** (`USER 10001:10001`) en lugar de nombre (`USER app`) permite a Kubernetes validar `runAsNonRoot: true`, que solo funciona si el UID es != 0.

**Read-only rootfs** en runtime (opción de Docker/K8s, no del Dockerfile):

```bash
docker run --read-only --tmpfs /tmp --tmpfs /run miapp:latest
```

Equivalente en Kubernetes:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
    add: ["NET_BIND_SERVICE"]  # solo si necesitas bind < 1024
  seccompProfile:
    type: RuntimeDefault
```

Este bloque son los **Pod Security Standards** perfil `restricted` de Kubernetes 1.25+ prácticamente al pie de la letra. Es el mínimo aceptable en producción regulada.

**Bind a puertos < 1024 sin root**: dos opciones limpias.

1. Cambia tu app para escuchar en `:8080` y publica el `:80` a nivel de Service/Ingress.
2. Añade `CAP_NET_BIND_SERVICE` con capabilities.drop=ALL. Menos "root-como-solución", más "privilegio mínimo".

---

## 8. HEALTHCHECK y optimización de tamaño (nivel avanzado)

`HEALTHCHECK` es una instrucción Dockerfile a menudo olvidada. Docker/`compose`/Swarm y algunos orquestadores la usan; Kubernetes la **ignora** en favor de sus probes propias (más flexibles). Aun así en dev y con `compose` es imprescindible:

```dockerfile
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ready || exit 1
```

`start-period` es el "período de gracia": fallos durante ese tiempo no cuentan. Fija tres endpoints:

- `/live` para liveness (¿el proceso responde?). No consulta dependencias.
- `/ready` para readiness (¿estoy listo para tráfico? DB pool inicializado, migraciones ok).
- `/startup` para arranques lentos (ver [cap 08 — Kubernetes workloads](./08-kubernetes-workloads.md)).

**Anti-patrón clásico**: liveness que hace `SELECT 1` a la DB. La primera vez que la DB parpadea, Kubernetes reinicia **todos** tus pods (thundering herd). La liveness debe ser *lo más barata y local posible*.

**Optimización de tamaño — checklist**:

1. **Base minimal** (§5).
2. **Multi-stage** para dejar deps de compilación fuera.
3. **`.dockerignore`** riguroso: sin `node_modules`, `.git`, `dist`, `.env`, `coverage`, docs, tests.
4. **Un solo `RUN`** para instalaciones que deban compartir cache limpio: `apt-get update && apt-get install -y --no-install-recommends x y z && rm -rf /var/lib/apt/lists/*`.
5. **Sin `apt-get upgrade`** (invalida cache y añade binarios sin control). Actualiza cambiando la base.
6. **Ordenar layers**: pesadas y estables arriba; ligeras y volátiles abajo.
7. **`docker sbom` / `syft`** para auditar qué acabó dentro.
8. **`dive`** o `docker history --no-trunc` para ver por qué tu imagen pesa X.

Ejemplo `.dockerignore` para monorepo pnpm:

```gitignore
**/node_modules
**/dist
**/.next
**/coverage
**/.turbo
.git
.github
*.md
!README.md
.env*
.vscode
.idea
.DS_Store
Dockerfile*
docker-compose*.yml
```

En un repo real de LinguaDev Pro este `.dockerignore` cambia el build context de 480 MB a 6 MB. La diferencia se paga en cada `docker build`.

---

## 9. BuildKit avanzado, multi-arch, Compose y alternativas (nivel avanzado)

**BuildKit** es el motor por defecto en Docker 23+. Aporta ejecución paralela del DAG, mount caches, secrets, SSH forwarding, frontends (Dockerfile v1.9, Buildpacks, HCL), y export cache remoto.

Habilitar features nuevas por línea inicial:

```dockerfile
# syntax=docker/dockerfile:1.9
```

Esta directiva descarga el frontend actualizado desde `docker/dockerfile` en el registry y garantiza que sintaxis como `COPY --link`, `RUN --mount=type=bind,from=...` y heredocs (`<<EOF`) funcionen aunque el daemon sea más viejo.

**Heredocs en Dockerfile 1.9**:

```dockerfile
RUN <<EOF
apk add --no-cache curl jq
curl -sSL https://example.com/install.sh | sh
apk del curl
EOF

COPY <<EOF /etc/motd
Bienvenido a miapp v${APP_VERSION}
EOF
```

**Build multi-arch con Buildx + QEMU** (imprescindible en 2026 con Apple Silicon en dev y ARM Graviton en prod):

```bash
docker run --privileged --rm tonistiigi/binfmt --install all
docker buildx create --use --name multi \
  --driver docker-container --platform linux/amd64,linux/arm64
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/miorg/miapp:1.4.2 \
  --provenance=true --sbom=true \
  --push .
```

`--provenance=true` genera un [SLSA v1.2](https://slsa.dev) provenance attestation en el registry (BuildKit 0.14+, mandatorio para varios frameworks de supply chain, ver [cap 06](./06-container-security-y-registries.md)). `--sbom=true` produce un SBOM SPDX incluido en el manifest.

**docker compose v2** (rewrite en Go, `docker compose` sin guion) es el estándar para dev local y CI ligera:

```yaml
# compose.yaml
name: linguadev
services:
  api:
    build:
      context: ./services/api
      target: runtime
      cache_from:
        - type=registry,ref=ghcr.io/miorg/api:cache
    environment:
      DATABASE_URL: postgres://app:app@db:5432/app
    depends_on:
      db:
        condition: service_healthy
    ports: ["8080:8080"]
    develop:
      watch:
        - path: ./services/api/src
          action: sync
          target: /app/src
        - path: ./services/api/package.json
          action: rebuild
  db:
    image: postgres:16.4-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes: ["db-data:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 5s
      retries: 10
volumes:
  db-data:
```

`develop.watch` (Compose 2.22+) hace hot-reload de archivos sin rebuild completo. Reemplaza casi por completo `docker-compose up --build` en el ciclo interior de dev.

**Alternativas a Docker en 2026**:

- **Podman 5.x** (Red Hat): daemonless, rootless nativo, compatible con Dockerfile y `podman-compose`. `podman play kube` genera manifests Kubernetes desde pods. Excelente en RHEL/Fedora y para envs regulados.
- **Nerdctl** (containerd): CLI casi idéntico a Docker pero directamente sobre containerd. Se combina con `lima` en macOS para reemplazar Docker Desktop.
- **Rancher Desktop / OrbStack / Colima**: alternativas a Docker Desktop en macOS/Windows con menor footprint.
- **Buildpacks (`pack` CLI)** y **`ko`** (Go) generan imágenes sin escribir Dockerfile. Útiles en pipelines de plataforma.

Compose sigue siendo el más simple para dev; Podman ha ganado terreno en regulated industries; Kubernetes (ver [cap 07](./07-fundamentos-kubernetes.md)) es lo que usarás en producción.

---

## 10. Ejercicios verificables

Trabaja los seis en orden. Todos son verificables con comandos objetivos.

**Ejercicio 1 — Multi-stage < 20 MB.** Toma cualquier app Node de LinguaDev Pro (`services/api`). Escribe un Dockerfile multi-stage con `node:20-alpine` como builder y `gcr.io/distroless/nodejs20-debian12:nonroot` como runtime. Objetivo: `docker images miapp:test --format '{{.Size}}'` < 200 MB. Extra: repite con `services/worker` (Go) apuntando a `distroless/static-debian12:nonroot` y objetivo < 15 MB.

**Ejercicio 2 — Cache order.** Duplica un Dockerfile en dos versiones: `bad.Dockerfile` (que hace `COPY . .` antes de `npm ci`) y `good.Dockerfile` (con orden optimizado). Mide con `time docker buildx build -f X --load .` primera build y build tras `touch src/server.ts`. Documenta ratio de mejora. Debe ser >10x en el cambio pequeño.

**Ejercicio 3 — Non-root + read-only + seccomp.** Ejecuta tu imagen con:
```bash
docker run --rm --read-only --tmpfs /tmp \
  --cap-drop=ALL --cap-add=NET_BIND_SERVICE \
  --security-opt=no-new-privileges \
  --user 10001:10001 miapp:test
```
Debe arrancar y responder a `curl :8080/health`. Si falla, arréglalo (probablemente escribes en un path no permitido).

**Ejercicio 4 — Multi-arch push.** Con `docker buildx` construye y sube `ghcr.io/miorg/miapp:multi` para `linux/amd64,linux/arm64`. Verifica con `docker buildx imagetools inspect ghcr.io/miorg/miapp:multi` que aparecen las dos plataformas en el manifest list.

**Ejercicio 5 — Secretos sin filtración.** Añade una dep desde un registry privado usando `--secret id=npm_token`. Después de build corre `docker history --no-trunc miapp:test | grep -i token`. Debe devolver 0 líneas. Repite con la versión insegura (`ARG NPM_TOKEN`) y confirma que el token aparece en el history.

**Ejercicio 6 — Compose develop watch.** Escribe un `compose.yaml` para tu API y su Postgres con `develop.watch` para hot-reload. Cambia un archivo en `src/`; el sync debe ocurrir en <2 s sin rebuild. Cambia `package.json`; debe rebuildear automáticamente.

**Referencia al simulacro:**

- Path del JSON: [`packages/content/src/tech/devops/sim-05-docker-fundamentals.json`](../../packages/content/src/tech/devops/sim-05-docker-fundamentals.json)
- ID interno: `devops-sim-05-docker-fundamentals`

Corre el simulacro solo cuando termines los ejercicios; el objetivo es diagnóstico, no memorización.

---

## Navegación

- Prev: [Cap 04 — GitHub Actions y Jenkins](./04-github-actions-y-jenkins.md)
- Next: [Cap 06 — Container security y registries →](./06-container-security-y-registries.md)
