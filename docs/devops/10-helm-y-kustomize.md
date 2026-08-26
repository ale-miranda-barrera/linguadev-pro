# Capítulo 10 — Helm y Kustomize

> **Focus:** Los dos package managers dominantes para Kubernetes en 2026. Helm 4 (chart, templates, values, releases, hooks, dependencies, OCI registries) vs Kustomize 5 (bases, overlays, patches strategic/JSON, generators, `kubectl apply -k`). Cuándo elegir cuál, cuándo combinarlos, cuándo evitar ambos.
> **Áreas:** Package management · Templating · GitOps foundations
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos K8s: Deployment, Service, ConfigMap, Secret (ver [cap 07 — kubernetes fundamentals](./07-fundamentos-kubernetes.md)).
- Networking y storage: Services, PVCs, StorageClasses (ver [cap 09 — kubernetes networking y storage](./09-kubernetes-networking-y-storage.md)).
- YAML avanzado (anchors, multi-document, nulls).
- Go templates básicos (sintaxis `{{ }}`, condicionales, loops) — no obligatorio pero acelera.
- Git y prácticas GitOps mínimas: repo por environment, PR review.

**Glosario mínimo:**
- **Helm**: package manager para Kubernetes con templating Go. Proyecto CNCF Graduated.
- **Chart**: unidad de packaging Helm — directorio con `Chart.yaml`, `values.yaml`, `templates/`, `charts/`.
- **Release**: instancia instalada de un chart con un nombre único por namespace.
- **Values**: valores que parametrizan un chart. Se declaran en `values.yaml` y se sobrescriben por CLI o files.
- **Umbrella chart**: chart que depende de otros charts (`dependencies:` en `Chart.yaml`).
- **Hooks**: manifiestos con annotation `helm.sh/hook` que se ejecutan en momentos específicos del release (pre-install, post-upgrade, test).
- **Kustomize**: motor de patching declarativo YAML-native, integrado en `kubectl apply -k`.
- **Base**: conjunto de manifests reusables sin values.
- **Overlay**: directorio que apunta a una base y aplica patches específicos por environment.
- **Strategic Merge Patch**: patch YAML tipo K8s (respeta merge keys).
- **JSON Patch (RFC 6902)**: patch tipo `[{op:replace, path:/spec/replicas, value:5}]`.
- **Generator**: fábrica de ConfigMaps/Secrets con hashes suffix para trigger de rolling update.
- **OCI registry**: registro compatible con Docker Registry API v2 (Docker Hub, GHCR, ECR, GAR) que aloja también charts Helm desde v3.8.

**Setup mínimo:**

```bash
# 1. Helm 4.x (release nov 2025, standard en 2026)
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
# version.BuildInfo{Version:"v4.0.x", ...}

# 2. Kustomize 5.x (standalone) + integrado en kubectl 1.32+
curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash
kustomize version
# kustomize/v5.8.1
kubectl version --client
# Client: v1.32.x (incluye kustomize integrado)

# 3. Helm plugins útiles
helm plugin install https://github.com/databus23/helm-diff       # diff antes de upgrade
helm plugin install https://github.com/jkroepke/helm-secrets      # sops-encrypted values
helm plugin install https://github.com/helm/helm-mapkubeapis      # actualizar APIs deprecadas

# 4. Repos populares
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo add jetstack https://charts.jetstack.io
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# 5. Ver charts como paquetes OCI (Helm 3.8+)
helm push mychart-1.0.0.tgz oci://ghcr.io/my-org/charts
helm install my-release oci://ghcr.io/my-org/charts/mychart --version 1.0.0
```

---

## 1. El gran cuadro

Escribir YAML plano funciona para un servicio en un environment. Cuando multiplicás por 20 servicios y 5 environments (dev, staging, prod-us, prod-eu, dr), aparece el problema **DRY (Don't Repeat Yourself) aplicado a config**: 100 manifests casi idénticos, diffs sutiles que se olvidan cuando alguien actualiza dev pero no prod, y bugs que solo aparecen en el environment que nadie tocó en semanas. La respuesta del ecosistema Kubernetes son dos herramientas con filosofías opuestas: **Helm** (templating) y **Kustomize** (patching). Ambas están en su versión mayor moderna en 2026 —Helm 4 lanzado en KubeCon NA nov 2025, Kustomize 5.x integrado en kubectl 1.32+— y ambas son "correctas": la elección depende de si preferís un DSL potente con curva o YAML puro con menos poder.

**Helm** toma el enfoque de los package managers clásicos: un `Chart` es un paquete versionado con metadata, dependencias y una interfaz pública (`values.yaml`). Los `templates/` son manifests YAML con placeholders Go template (`{{ .Values.replicaCount }}`), y `helm install` renderiza + aplica al cluster. Helm mantiene un **historial de releases** en Secrets del namespace, permite `helm rollback` a revisiones anteriores, ejecuta **hooks** en fases específicas del ciclo (pre-install, post-upgrade, test), soporta **dependencies** entre charts (umbrella charts), y distribuye paquetes vía **OCI registries** (desde v3.8). Es la lingua franca para redistribuir aplicaciones third-party: cuando querés instalar Prometheus, Ingress-Nginx, cert-manager o Postgres en tu cluster, el chart Helm oficial es la vía natural.

**Kustomize** rechaza el templating: su premisa es "no inventés un lenguaje encima de YAML; que YAML se combine con YAML". Un **base** contiene manifests genéricos; cada **overlay** los referencia y aplica **patches** (strategic merge o JSON Patch RFC 6902). No hay `{{ if }}`, no hay loops, no hay funciones. Esto lo hace ilegible para lógica compleja, pero **trivial** para casos comunes: "en prod, replicas=10; en dev, replicas=1". Un `kustomization.yaml` funciona como archivo declarativo con `resources`, `patches`, `configMapGenerator`, `secretGenerator`, `images`, `namespace`, etc. Está integrado nativamente en `kubectl -k` desde 1.14 y en 2026 madura con soporte first-class para OCI generators y mejor interop con Helm 4.

La decisión práctica en 2026 no es binaria. La mayoría de equipos serios **combinan** las dos: **Helm** para consumir/publicar charts third-party y reusables entre proyectos; **Kustomize** para "envolver" esos charts con overlays por environment sin inflar `values.yaml` con condicionales enrevesados. GitOps tools como **ArgoCD** y **FluxCD** soportan ambos nativamente y también el patrón "Helm render → Kustomize patch → apply". Vas a ver también alternativas emergentes: **Helmfile** (declarar releases Helm), **cdk8s** (definir manifests con TypeScript/Python), **Jsonnet** (Grafana Labs), **Pulumi/CDK8s** para infra-as-real-code. Pero Helm + Kustomize sigue siendo el 80% del mundo.

El impacto de elegir mal es concreto: charts Helm mal diseñados generan `values.yaml` de 800 líneas que nadie entiende, upgrades que rompen porque cambió el nombre de una key, hooks que corren en órdenes inesperados y bloquean el release. Kustomize mal usado degenera en overlays anidados 4 niveles con patches que se pisan y nadie sabe qué campo gana. Este capítulo cubre las mecánicas, las trampas, y ejercicios prácticos aplicables a **LinguaDev Pro**.

---

## 2. Helm: chart, templates, values, releases (nivel básico)

### 2.1 Estructura de un chart

`helm create linguadev-api` genera:

```
linguadev-api/
├── Chart.yaml           # metadata del chart
├── values.yaml          # valores por default
├── values.schema.json   # (opcional) JSON Schema para validar values
├── charts/              # dependencias (sub-charts)
├── templates/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── hpa.yaml
│   ├── serviceaccount.yaml
│   ├── _helpers.tpl     # helper templates reusables
│   ├── NOTES.txt        # texto mostrado post-install
│   └── tests/
│       └── test-connection.yaml
└── .helmignore          # patterns a excluir del packaging
```

**`Chart.yaml`** declara metadata y dependencias:

```yaml
apiVersion: v2
name: linguadev-api
description: LinguaDev Pro API service
type: application
version: 1.3.2           # SemVer del chart
appVersion: "2.1.0"      # SemVer de la app empaquetada
keywords:
  - linguadev
  - api
maintainers:
  - name: Ale Miranda
    email: ale.miranda.barrera@gmail.com
dependencies:
  - name: postgresql
    version: "16.4.5"
    repository: "https://charts.bitnami.com/bitnami"
    condition: postgresql.enabled
```

### 2.2 Templates y values

**`values.yaml`** es la interfaz pública:

```yaml
replicaCount: 3

image:
  repository: ghcr.io/linguadev/api
  tag: "2.1.0"
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 80
  targetPort: 8080

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

env:
  - name: LOG_LEVEL
    value: info
  - name: RATE_LIMIT
    value: "100"

autoscaling:
  enabled: false
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

ingress:
  enabled: false
  className: nginx
  hosts:
    - host: api.linguadev.app
      paths:
        - path: /
          pathType: Prefix

postgresql:
  enabled: true
  auth:
    username: linguadev
    database: linguadev
```

**`templates/deployment.yaml`** usa esos valores con Go templates + Sprig:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "linguadev-api.fullname" . }}
  labels:
    {{- include "linguadev-api.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "linguadev-api.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
      labels:
        {{- include "linguadev-api.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .Values.service.targetPort }}
          {{- with .Values.env }}
          env:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 30
```

**`templates/_helpers.tpl`** define reusables:

```gotpl
{{- define "linguadev-api.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "linguadev-api.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "linguadev-api.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "linguadev-api.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "linguadev-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "linguadev-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "linguadev-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
```

### 2.3 Comandos esenciales

```bash
# Preview del YAML renderizado (sin aplicar)
helm template my-release ./linguadev-api --values custom-values.yaml

# Lint del chart
helm lint ./linguadev-api

# Install
helm install my-release ./linguadev-api \
  --namespace prod --create-namespace \
  --values values-prod.yaml \
  --set image.tag=2.1.1

# Diff antes de upgrade (con plugin helm-diff)
helm diff upgrade my-release ./linguadev-api --values values-prod.yaml

# Upgrade
helm upgrade my-release ./linguadev-api --values values-prod.yaml --atomic --wait

# Rollback a revisión anterior
helm history my-release
helm rollback my-release 3

# Uninstall (mantiene historia si --keep-history)
helm uninstall my-release
```

**Server-Side Apply por default en Helm 4:** desde nov 2025, Helm 4 usa SSA en lugar de client-side merge, alineándose con la dirección de la API. Esto reduce ghost conflicts con otros controllers (ArgoCD, kubectl) y hace los three-way merges más predecibles.

### 2.4 Values: layering y overrides

Orden de precedencia (más bajo → más alto gana):

1. `values.yaml` del chart.
2. `--values file1.yaml` (múltiples archivos, aplicados en orden).
3. `--set key=value` en CLI.
4. `--set-string key=stringVal`.
5. `--set-file key=@path/to/file` (contenido de un archivo).

Ejemplo layered para 3 environments:

```
helm/
├── linguadev-api/         # chart
└── environments/
    ├── values-base.yaml
    ├── values-dev.yaml
    ├── values-staging.yaml
    └── values-prod.yaml
```

```bash
helm upgrade --install linguadev-api ./helm/linguadev-api \
  -n prod \
  -f helm/environments/values-base.yaml \
  -f helm/environments/values-prod.yaml \
  --set image.tag=$CI_COMMIT_SHA \
  --atomic --wait
```

---

## 3. Helm avanzado: hooks, dependencies, OCI, tests (nivel medio)

### 3.1 Hooks: eventos del release

Los hooks son manifests con annotation `helm.sh/hook` que se ejecutan en momentos específicos:

| Hook | Cuándo |
|---|---|
| `pre-install` | Antes de instalar |
| `post-install` | Después de instalar |
| `pre-upgrade` / `post-upgrade` | Antes/después de upgrade |
| `pre-delete` / `post-delete` | Antes/después de uninstall |
| `pre-rollback` / `post-rollback` | Antes/después de rollback |
| `test` | Con `helm test <release>` |

Ejemplo de migración de DB antes del upgrade:

```yaml
# templates/migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: "{{ .Release.Name }}-db-migrate-{{ .Release.Revision }}"
  annotations:
    "helm.sh/hook": pre-upgrade,pre-install
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: ["npm", "run", "migrate:up"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ include "linguadev-api.fullname" . }}-db
                  key: url
```

`hook-weight` ordena hooks del mismo evento (más bajo primero). `hook-delete-policy` controla cuándo se limpia el Job.

**Test hook** para smoke test post-install:

```yaml
# templates/tests/test-connection.yaml
apiVersion: v1
kind: Pod
metadata:
  name: "{{ .Release.Name }}-test-connection"
  annotations:
    "helm.sh/hook": test
spec:
  restartPolicy: Never
  containers:
    - name: curl
      image: curlimages/curl:8.10.1
      command: ['curl', '--fail', 'http://{{ include "linguadev-api.fullname" . }}/healthz']
```

Ejecutar: `helm test my-release`.

### 3.2 Dependencies y umbrella charts

Un **umbrella chart** compone múltiples sub-charts. `Chart.yaml`:

```yaml
apiVersion: v2
name: linguadev-platform
version: 1.0.0
dependencies:
  - name: linguadev-api
    version: "1.3.2"
    repository: "file://../linguadev-api"
  - name: linguadev-web
    version: "0.8.1"
    repository: "file://../linguadev-web"
  - name: postgresql
    version: "16.4.5"
    repository: "https://charts.bitnami.com/bitnami"
    condition: postgresql.enabled
    alias: db
  - name: redis
    version: "20.6.1"
    repository: "https://charts.bitnami.com/bitnami"
    condition: redis.enabled
```

`values.yaml` del umbrella pasa values a sub-charts:

```yaml
linguadev-api:
  replicaCount: 3
  image:
    tag: "2.1.0"

linguadev-web:
  replicaCount: 2

db:                    # alias en lugar de "postgresql"
  enabled: true
  auth:
    username: linguadev
    database: linguadev
  primary:
    persistence:
      size: 20Gi

redis:
  enabled: false
```

Descargar dependencias:

```bash
helm dependency update ./linguadev-platform
# genera charts/*.tgz
```

### 3.3 OCI registries (Helm 3.8+, standard en 2026)

Charts como paquetes OCI reusan la infra de container registries (auth, replicación, RBAC):

```bash
# Login
helm registry login ghcr.io -u USERNAME -p $GITHUB_TOKEN

# Package + push
helm package ./linguadev-api
helm push linguadev-api-1.3.2.tgz oci://ghcr.io/alemi/charts

# Pull o install directo
helm show chart oci://ghcr.io/alemi/charts/linguadev-api --version 1.3.2
helm install my-release oci://ghcr.io/alemi/charts/linguadev-api --version 1.3.2
```

Registries populares soportados: GHCR, ECR, GAR, Harbor, Docker Hub, Artifactory. La era de "chart-releaser + GitHub Pages" está siendo reemplazada por OCI, más seguro y con firmas cosign.

### 3.4 Values schema y validación

`values.schema.json` (JSON Schema) valida los values antes del render:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["image", "replicaCount"],
  "properties": {
    "replicaCount": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "image": {
      "type": "object",
      "required": ["repository", "tag"],
      "properties": {
        "repository": { "type": "string" },
        "tag": { "type": "string", "pattern": "^v?\\d+\\.\\d+\\.\\d+.*$" },
        "pullPolicy": { "enum": ["Always", "IfNotPresent", "Never"] }
      }
    },
    "autoscaling": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean" },
        "minReplicas": { "type": "integer", "minimum": 1 },
        "maxReplicas": { "type": "integer", "minimum": 1 }
      }
    }
  }
}
```

`helm install` falla si los values no cumplen. Feedback rápido para consumidores del chart.

### 3.5 Trampas comunes en Helm

- **Whitespace y `{{-`/`-}}`**: los trim marks eliminan whitespace circundante. Renderizado mal indentado causa YAML inválido. Debug: `helm template . --debug`.
- **`required "msg" .Values.x`**: forces failure si `x` es nil. Preferilo sobre "el value ausente termina como string vacío".
- **`default "fallback" .Values.opt`**: usa fallback si nil o vacío.
- **`nindent N`**: newline + indent N espacios. `indent N` no añade newline al inicio.
- **Rollback con hooks**: los hooks también corren en rollback, cuidado con migraciones DB que no soportan downgrade.
- **`--wait --atomic`**: `--atomic` deshace el upgrade si falla (bueno en CI/CD). `--wait` bloquea hasta que todos los recursos estén Ready.
- **Chart repos deprecados**: `stable/` y `incubator/` fueron eliminados en 2020. Usá repos oficiales de cada vendor u OCI.

---

## 4. Kustomize: bases, overlays, patches (nivel medio-avanzado)

### 4.1 Estructura clásica

```
kustomize/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   └── configmap.yaml
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml
    │   └── patch-replicas.yaml
    ├── staging/
    │   ├── kustomization.yaml
    │   └── patch-resources.yaml
    └── prod/
        ├── kustomization.yaml
        ├── patch-replicas.yaml
        ├── patch-resources.yaml
        └── configmap-override.yaml
```

**`base/kustomization.yaml`:**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
  - configmap.yaml

commonLabels:
  app.kubernetes.io/name: linguadev-api
  app.kubernetes.io/managed-by: kustomize

commonAnnotations:
  documentation: https://linguadev.app/docs
```

**`base/deployment.yaml`** (manifiesto puro, sin placeholders):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: linguadev-api
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: linguadev-api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: linguadev-api
    spec:
      containers:
        - name: api
          image: ghcr.io/linguadev/api:latest
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
```

**`overlays/prod/kustomization.yaml`:**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: linguadev-prod

resources:
  - ../../base

images:
  - name: ghcr.io/linguadev/api
    newTag: "2.1.0"

replicas:
  - name: linguadev-api
    count: 5

patches:
  - path: patch-resources.yaml
    target:
      kind: Deployment
      name: linguadev-api

configMapGenerator:
  - name: app-config
    behavior: merge
    literals:
      - LOG_LEVEL=warn
      - ENVIRONMENT=production

secretGenerator:
  - name: app-secrets
    envs:
      - secrets.env

commonAnnotations:
  environment: production
```

**`overlays/prod/patch-resources.yaml`** (Strategic Merge Patch):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: linguadev-api
spec:
  template:
    spec:
      containers:
        - name: api
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi
```

Renderizar y aplicar:

```bash
kubectl apply -k overlays/prod
# o para preview:
kubectl kustomize overlays/prod
kustomize build overlays/prod > /tmp/prod-render.yaml
```

### 4.2 Patch types

**Strategic Merge Patch** (default): YAML tipo K8s que se mergea con el original usando merge keys (`name` en containers, etc.). Fácil de leer, limitado a operaciones que K8s reconoce.

**JSON Patch RFC 6902**: operaciones explícitas `op: replace|add|remove|move|copy|test` con `path` JSON Pointer:

```yaml
# overlays/prod/patch-json.yaml
- op: replace
  path: /spec/replicas
  value: 10
- op: add
  path: /spec/template/spec/containers/0/env/-
  value:
    name: FEATURE_FLAG_X
    value: "true"
- op: remove
  path: /spec/template/spec/containers/0/env/2
```

Referenciar en `kustomization.yaml`:

```yaml
patches:
  - path: patch-json.yaml
    target:
      group: apps
      version: v1
      kind: Deployment
      name: linguadev-api
```

**Diff conceptual:**

| Aspecto | Strategic Merge | JSON Patch |
|---|---|---|
| Legibilidad | ✅ YAML familiar | ❌ Sintaxis abstracta |
| Precisión | ❌ Ambigüedad en arrays | ✅ Exacto |
| Añadir/quitar array items | Difícil | Trivial (`add /path/-`) |
| Cambiar campos escalares | Fácil | Fácil |

Usá strategic para 80% de casos; JSON Patch cuando necesitás precisión (borrar un item de un array por índice, replace atómico).

### 4.3 Generators: ConfigMap y Secret con hash

Un problema clásico: cambiar un ConfigMap **no dispara** rolling restart del Deployment. Kustomize resuelve esto con **generators** que añaden un hash suffix al nombre; cuando el contenido cambia, el nombre cambia, y el Deployment (que referencia el nombre) hace rolling update.

```yaml
# overlays/prod/kustomization.yaml
configMapGenerator:
  - name: nginx-conf
    files:
      - nginx.conf
    options:
      disableNameSuffixHash: false

secretGenerator:
  - name: api-keys
    envs:
      - secrets.env
    type: Opaque

generatorOptions:
  disableNameSuffixHash: false
  labels:
    generated-by: kustomize
```

Genera `nginx-conf-abc12345` (hash del contenido). El Deployment que hace `envFrom: configMapRef: name: nginx-conf` debe usar el nombre generado; Kustomize lo actualiza automáticamente en todas las referencias.

### 4.4 Componentes (v3+, GA 2020)

`Component` es un patrón para features reusables cross-overlays:

```yaml
# components/monitoring/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
resources:
  - servicemonitor.yaml
patches:
  - target: { kind: Deployment }
    patch: |-
      - op: add
        path: /spec/template/metadata/annotations
        value:
          prometheus.io/scrape: "true"
          prometheus.io/port: "8080"
```

```yaml
# overlays/prod/kustomization.yaml
components:
  - ../../components/monitoring
  - ../../components/istio-sidecar
```

Cada componente se aplica en orden; útil para toggles opcionales.

### 4.5 Cuándo Kustomize brilla y cuándo no

**Brilla:**
- Multiples environments del mismo app (dev/staging/prod).
- Multi-tenant: un base + overlay por tenant.
- Combinaciones puntuales (cambio de replicas, image tag, resources).
- Workflows GitOps donde cada environment es un branch/directorio.

**Sufre:**
- Lógica condicional compleja ("si feature X, añadí estos 5 recursos").
- Charts para redistribución third-party (sin versionado como paquete).
- Loops sobre listas dinámicas.
- Overlays anidados 4+ niveles con patches contradictorios.

---

## 5. Helm vs Kustomize: cuándo cada uno, cuándo combinar

### 5.1 Tabla comparativa

| Aspecto | Helm 4 | Kustomize 5 |
|---|---|---|
| Filosofía | Templating | Patching |
| Learning curve | Media-alta (Go templates + Sprig) | Baja (YAML puro) |
| Versionado | ✅ SemVer del chart | ❌ (solo Git commits) |
| Distribución | ✅ OCI, tarballs, repos | ❌ (Git submodules o remote bases) |
| Rollback | ✅ `helm rollback` con historial | ❌ (kubectl rollout undo, no built-in) |
| Hooks | ✅ pre/post-install/upgrade | ❌ (no built-in) |
| Dependencies | ✅ umbrella charts | Parcial (remote bases) |
| Cambios simples per-env | Verbose (`values-*.yaml`) | Trivial (overlay) |
| Third-party consumption | ✅ el standard | ❌ (bases raras) |
| Multi-tenant | Complejo (values gigantes) | ✅ overlay por tenant |
| GitOps ArgoCD/Flux | ✅ soportado | ✅ soportado |
| SSA (Server-Side Apply) | ✅ default en Helm 4 | Parcial (via kubectl) |

### 5.2 Combinar: Helm render → Kustomize patch

Patrón productivo: consumir un chart Helm de terceros (Bitnami Postgres, ingress-nginx) y aplicarle overlays Kustomize por environment. Sintaxis Kustomize (v4.1+):

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

helmCharts:
  - name: ingress-nginx
    repo: https://kubernetes.github.io/ingress-nginx
    version: 4.11.3
    releaseName: ingress-nginx
    namespace: ingress-nginx
    valuesFile: values-prod.yaml

patches:
  - path: patch-nginx-resources.yaml
    target:
      kind: Deployment
      name: ingress-nginx-controller
```

```bash
kubectl kustomize --enable-helm overlays/prod | kubectl apply -f -
```

Ventajas: Kustomize maneja el diff entre environments; Helm maneja versionado del chart upstream.

### 5.3 Alternativas emergentes

- **Helmfile**: declara múltiples releases Helm en un YAML (`helmfile.yaml`), útil para multi-cluster.
- **cdk8s**: define manifests con TypeScript/Python/Go, compila a YAML.
- **Jsonnet + tanka**: usado por Grafana Labs a escala.
- **Timoni** (2024): sucesor conceptual de Helm basado en CUE en lugar de Go templates.
- **Kro** (Kubernetes Resource Orchestrator, AWS 2024): compone recursos con dependencias.

Ninguna ha desplazado a Helm+Kustomize en 2026, pero vale monitorearlas.

---

## 6. Ejemplo práctico completo: LinguaDev Pro multi-env

Aplicación real: `api`, `web` y `worker` de LinguaDev Pro con Helm charts internos + overlays Kustomize por environment.

### Layout

```
linguadev-pro/
├── helm/
│   ├── linguadev-api/          # chart
│   ├── linguadev-web/          # chart
│   └── linguadev-worker/       # chart
└── kustomize/
    ├── base/
    │   └── kustomization.yaml  # helmCharts
    └── overlays/
        ├── dev/
        ├── staging/
        └── prod/
```

### `kustomize/base/kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

helmCharts:
  - name: linguadev-api
    releaseName: api
    namespace: linguadev
    version: 1.3.2
    repo: oci://ghcr.io/alemi/charts
    valuesFile: values-base.yaml
  - name: linguadev-web
    releaseName: web
    namespace: linguadev
    version: 0.8.1
    repo: oci://ghcr.io/alemi/charts
    valuesFile: values-base.yaml
  - name: linguadev-worker
    releaseName: worker
    namespace: linguadev
    version: 0.5.0
    repo: oci://ghcr.io/alemi/charts
    valuesFile: values-base.yaml

commonLabels:
  app.kubernetes.io/part-of: linguadev-pro
```

### `kustomize/overlays/prod/kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: linguadev-prod

resources:
  - ../../base

replicas:
  - name: api
    count: 5
  - name: web
    count: 3
  - name: worker
    count: 8

images:
  - name: ghcr.io/linguadev/api
    newTag: "2.1.0"
  - name: ghcr.io/linguadev/web
    newTag: "1.4.0"
  - name: ghcr.io/linguadev/worker
    newTag: "0.5.3"

patches:
  - path: patch-hpa.yaml
    target: { kind: HorizontalPodAutoscaler }
  - path: patch-network-policy.yaml
    target: { kind: NetworkPolicy, name: default-deny }

configMapGenerator:
  - name: app-config
    behavior: merge
    literals:
      - LOG_LEVEL=warn
      - RATE_LIMIT=1000
      - FEATURE_NEW_FSRS=true

secretGenerator:
  - name: api-secrets
    files:
      - openai-key=secrets/openai-prod.key
      - db-password=secrets/db-prod.password
    type: Opaque
```

### CI/CD (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy prod
on:
  push:
    branches: [main]
    paths: ['kustomize/**', 'helm/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-kubectl@v4
        with:
          version: 'v1.32.0'
      - uses: azure/setup-helm@v4
        with:
          version: 'v4.0.0'
      - name: Login OCI registry
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | \
            helm registry login ghcr.io -u ${{ github.actor }} --password-stdin
      - name: Configure kubectl
        run: aws eks update-kubeconfig --name linguadev-prod --region us-east-1
      - name: Diff
        run: kubectl kustomize --enable-helm kustomize/overlays/prod | \
             kubectl diff -f - || true
      - name: Apply
        run: kubectl kustomize --enable-helm kustomize/overlays/prod | \
             kubectl apply -f - --server-side --field-manager linguadev-cd
```

---

## 7. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ Usá **Helm** para consumir/publicar third-party (Postgres, Nginx, cert-manager).
- ✅ Usá **Kustomize** para overlays por environment de tus propios apps.
- ✅ Combiná: `helmCharts` en un `kustomization.yaml` cuando tenga sentido.
- ✅ `values.schema.json` en todo chart público.
- ✅ `--atomic --wait` en CI/CD para `helm upgrade`.
- ✅ `helm diff upgrade` antes de aplicar en producción.
- ✅ Hooks con `hook-delete-policy` para no acumular Jobs.
- ✅ `_helpers.tpl` para labels/selectors reusables (evita drift).
- ✅ `checksum/config` annotation en Deployment para trigger rolling update al cambiar ConfigMap.
- ✅ OCI registries en 2026, no chart-releaser + GitHub Pages.
- ✅ Kustomize `commonLabels` para trazabilidad.
- ✅ Version pinning explícito en chart dependencies (nunca `~` o `*`).
- ✅ Server-Side Apply por default (Helm 4 lo hace).

### Anti-patrones

- ❌ `values.yaml` con 500+ líneas: signo de chart mal diseñado.
- ❌ Lógica condicional profunda en templates (`{{ if }}{{ else if }}{{ else }}`).
- ❌ Hooks que corren en rollback y rompen (migraciones sin down).
- ❌ Overlays Kustomize anidados 4 niveles.
- ❌ Mismo campo modificado por strategic patch **y** JSON patch (orden indefinido).
- ❌ `helm install --force` en producción (borra + recrea todo).
- ❌ Compartir un release Helm entre múltiples equipos (accountability perdida).
- ❌ Ignorar `values.schema.json` (users descubren errores en runtime).
- ❌ Charts sin `NOTES.txt` (users no saben qué hacer después).
- ❌ `latest` como tag de imagen (rompe rolling updates y GitOps).
- ❌ Meter secretos plaintext en `values.yaml` en Git (usar helm-secrets + sops).

### Tabla decisión rápida

| Necesidad | Helm | Kustomize |
|---|---|---|
| Instalar Prometheus, Postgres, etc. | ✅ | ❌ |
| Publicar tu app para otros | ✅ | ❌ |
| 4 environments del mismo app | ❌ | ✅ |
| Multi-tenant (100 clientes) | ❌ | ✅ |
| Rollback con historial | ✅ | ❌ |
| Hooks (migrations, tests) | ✅ | ❌ |
| YAML puro sin DSL | ❌ | ✅ |
| CI/CD simple con `kubectl -k` | ❌ | ✅ |
| Overlays sobre charts third-party | Combinado | Combinado |

---

## 8. Casos reales industria 2023-2026

**Helm 4 launch (KubeCon NA nov 2025):** Helm 4 introdujo Server-Side Apply por default, WASM plugins (portables cross-OS) y mejor OCI story. Migración desde Helm 3 mayormente compatible pero con breaking changes en algunos APIs de plugins. **Lección:** planeá upgrade a Helm 4 en 2026; el ROI en SSA vale la pena.

**Kustomize 5.8.1 (feb 2026):** mejoras significativas en `helmCharts` interop con Helm 4 y fix de propagación de namespace en generators. **Lección:** mantener Kustomize y Helm actualizados juntos, breaking rare pero real.

**Bitnami charts crisis (2024):** Broadcom (owner de VMware) cambió licencias de charts Bitnami en 2024, generando incertidumbre sobre continuidad. Comunidad forkeó a Bitnami-Compat y otras alternativas. **Lección:** dependencia en charts third-party es riesgo de supply chain; mirroreá charts críticos en tu OCI privado.

**Reddit migración a Kustomize (2022+):** Reddit publicó sobre uso extensivo de Kustomize para multi-region/multi-tenant. Base compartida + overlay por region. **Lección:** Kustomize escala para deploys homogéneos con variaciones puntuales.

**ArgoCD 2.10+ Helm 4 support (2026):** ArgoCD añadió soporte de Helm 4 y OCI directo en Application specs. **Lección:** GitOps tools se han estandarizado en Helm+Kustomize como primitivas.

**Chart releaser deprecado (2024+):** el patrón "chart-releaser + GitHub Pages" cedió terreno a OCI. Muchos charts migrados a `oci://ghcr.io/vendor/charts`. **Lección:** OCI es el futuro; migrá.

**Sopstools + helm-secrets (2024+):** patrón productivo: values encriptados con sops en Git, decrypt en CI/CD. Alternativa a SealedSecrets/External-Secrets. **Lección:** nunca commiteés secrets plaintext, ni "provisional".

**Timoni + CUE (2024+):** Stefan Prodan (creador de Flux) publicó Timoni como alternativa Helm basada en CUE en lugar de Go templates. Adopción en growing early. **Lección:** el espacio sigue evolucionando; Helm domina pero no es final.

**AWS EKS Blueprints con Kustomize (2023+):** AWS publicó ecosistema de blueprints usando Kustomize por defecto. **Lección:** cloud vendors validan Kustomize como enterprise-ready.

**Kubernetes 1.32 y kubectl apply -k (2026):** kubectl 1.32 incluye Kustomize v5.5.x integrado. `kubectl apply -k` es first-class. **Lección:** no necesitás binario Kustomize separado para casos simples.

---

## 9. Ejercicios prácticos

### Ejercicio 1: Crear y publicar un chart Helm en GHCR

**Objetivo:** empaquetar un chart y publicarlo como OCI en GitHub Container Registry.

**Setup:**
- Helm 4.x instalado.
- Cuenta GitHub con PAT (`write:packages`).

**Pasos:**
1. `helm create linguadev-api`.
2. Edita `values.yaml` con `image.repository`, `service.port`, etc.
3. Añade `values.schema.json` con validaciones básicas.
4. `helm lint ./linguadev-api`.
5. `helm template test ./linguadev-api > /tmp/render.yaml` y revisá.
6. `helm package ./linguadev-api` → genera `linguadev-api-0.1.0.tgz`.
7. `helm registry login ghcr.io -u YOUR_USER --password-stdin` con PAT.
8. `helm push linguadev-api-0.1.0.tgz oci://ghcr.io/YOUR_USER/charts`.
9. Verifica en GitHub Packages.
10. En otro cluster: `helm install test oci://ghcr.io/YOUR_USER/charts/linguadev-api --version 0.1.0`.

**Criterios de éxito:**
- [ ] `helm lint` sin errores.
- [ ] `values.schema.json` valida y falla con values incorrectos.
- [ ] Chart visible en GHCR.
- [ ] Install desde OCI produce Pods Ready.

**Bonus:** firma el chart con `cosign sign`.

---

### Ejercicio 2: Migrar de raw manifests a Kustomize base + overlays

**Objetivo:** tomar un manifest monolítico y convertirlo a base + 3 overlays (dev/staging/prod).

**Setup:**
- Un `all.yaml` con Deployment + Service + ConfigMap actual.

**Pasos:**
1. Crea `base/` con los manifests split y `kustomization.yaml`.
2. `kubectl apply -k base/ --dry-run=client -o yaml` para verificar.
3. Crea `overlays/dev` con `replicas: 1`, image tag `latest-dev`.
4. Crea `overlays/staging` con `replicas: 2`, resources reducidos.
5. Crea `overlays/prod` con `replicas: 5`, HPA, `LOG_LEVEL=warn`.
6. `kubectl diff -k overlays/prod` en cluster staging para verificar cambios.
7. Aplica: `kubectl apply -k overlays/dev`.

**Criterios de éxito:**
- [ ] Cada overlay produce YAML distinto.
- [ ] `commonLabels` presentes en todos los recursos.
- [ ] ConfigMap con hash suffix (regenerado al cambiar contenido).
- [ ] `apply -k` sin errores en cluster.

**Bonus:** añade un `Component` reusable para monitoring y aplícalo solo en prod.

---

### Ejercicio 3: Hook Helm de migración de DB antes de upgrade

**Objetivo:** correr una migración de DB automáticamente antes de cada `helm upgrade`.

**Setup:**
- Un chart existente con app que usa Postgres.
- Comando `npm run migrate:up` disponible en la imagen.

**Pasos:**
1. Crea `templates/migration-job.yaml` con annotations `pre-upgrade,pre-install` y `hook-delete-policy`.
2. `hook-weight: -5` para que corra antes de otros hooks del mismo evento.
3. `backoffLimit: 3` y `restartPolicy: Never`.
4. Referencia el mismo `Secret` de DB URL que el Deployment.
5. `helm install my-release ./chart` → verifica que el Job corre + succeeds.
6. Bump `appVersion` y `helm upgrade my-release ./chart` → nuevo Job.
7. Simula fallo (comando con exit 1) → verifica que `--atomic` rollbackea.

**Criterios de éxito:**
- [ ] Job aparece en `kubectl get jobs -l "helm.sh/hook=pre-upgrade"`.
- [ ] Job desaparece al succeeded gracias a `hook-delete-policy`.
- [ ] Con fallo simulado + `--atomic`, release revierte.
- [ ] `helm history` refleja las revisiones.

**Bonus:** añade un `test` hook con `curl /healthz` y ejecutá `helm test`.

---

### Ejercicio 4: Combinar Helm chart + Kustomize overlays

**Objetivo:** consumir un chart Helm de terceros y aplicarle patches por environment con Kustomize.

**Setup:**
- Chart Bitnami `redis` o `postgresql`.
- Kustomize 5.x con `--enable-helm`.

**Pasos:**
1. Crea `overlays/prod/kustomization.yaml` con `helmCharts:` apuntando al chart Bitnami.
2. Provee `valuesFile: values-prod.yaml` con auth y persistence básica.
3. Añade `patches:` para override resources del container principal.
4. `kubectl kustomize --enable-helm overlays/prod` → verificá render.
5. `kubectl apply -k overlays/prod --enable-helm`.

**Criterios de éxito:**
- [ ] Render incluye recursos del chart + patches aplicados.
- [ ] Los patches modifican el StatefulSet del chart Helm.
- [ ] Deploy exitoso en cluster.
- [ ] Diff entre overlays dev/prod es solo lo intencional.

**Bonus:** añade un `configMapGenerator` con hash suffix y verifica rolling update al cambiar.

---

### Ejercicio 5 (bonus): Values schema + validación en CI

**Objetivo:** un chart con `values.schema.json` que rechaza values inválidos en el pipeline.

**Setup:**
- Chart existente.
- CI (GitHub Actions).

**Pasos:**
1. Escribí `values.schema.json` con `required`, `type`, `pattern`.
2. En CI, correlá `helm lint --strict ./chart` y `helm template ... --values invalid.yaml` esperando failure.
3. Añade job que valida contra los 3 environments (`values-dev.yaml`, `values-staging.yaml`, `values-prod.yaml`).
4. Documentá los required en `NOTES.txt` y en `README.md` del chart.

**Criterios de éxito:**
- [ ] Values inválidos hacen fallar CI.
- [ ] Values válidos pasan.
- [ ] Schema documenta cada key con `description`.
- [ ] `NOTES.txt` guía al user post-install.

**Bonus:** genera docs automáticas del schema con `helm-docs`.

---

## 10. Recursos + siguientes pasos

**Docs oficiales:**
- [helm.sh/docs](https://helm.sh/docs) — Helm 4 docs.
- [kustomize.io](https://kustomize.io) y [kubectl.docs.kubernetes.io/references/kustomize](https://kubectl.docs.kubernetes.io/references/kustomize).
- [artifacthub.io](https://artifacthub.io) — search engine CNCF de charts.
- [helm.sh/blog/helm-4](https://helm.sh/blog) — release notes 2025-2026.

**Plugins Helm:**
- **helm-diff** — diff antes de upgrade.
- **helm-secrets** — sops-encrypted values.
- **helm-mapkubeapis** — actualizar APIs deprecadas.
- **helm-unittest** — tests unitarios de templates.
- **helm-docs** — generar README.md del chart.

**Charts de referencia:**
- **Bitnami** (postgresql, redis, kafka).
- **ingress-nginx** oficial.
- **cert-manager**.
- **kube-prometheus-stack**.
- **grafana**.

**Herramientas relacionadas:**
- **Helmfile** — declarar múltiples releases.
- **Timoni** — alternativa basada en CUE.
- **cdk8s** — TypeScript/Python/Go para manifests.
- **ArgoCD** / **FluxCD** — GitOps con Helm + Kustomize.

**Referencias:**
- Butcher, "*Learning Helm*" (O'Reilly, 2ª ed 2024).
- Kubernetes SIG-Apps talks (KubeCon 2024-2026).
- InfoQ y CNCF blogs sobre Helm 4.

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Auditá tu Helm charts: ¿tienen schema? ¿NOTES? ¿hooks bien delete-policy?
- Migrá 1 environment a Kustomize overlays.
- Publica un chart interno en tu OCI registry.
- Continuá con [cap 11 — Kubernetes Security](./11-kubernetes-security.md) para asegurar los deployments.

---

## 10.5 Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre Helm y Kustomize, dificultades junior → staff. Cubren: problema DRY de config, estructura de chart, templating con Sprig, releases y rollback, hooks con weight y delete-policy, dependencies y umbrella charts, OCI registries, values schema, Kustomize bases y overlays, strategic vs JSON patches, generators con hash, componentes, cuándo combinar Helm + Kustomize, y trade-offs frente a alternativas.

- **Fuente:** [`packages/content/src/tech/devops/sim-10-helm-and-kustomize.json`](../../packages/content/src/tech/devops/sim-10-helm-and-kustomize.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-10-helm-and-kustomize`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 09 — Kubernetes Networking y Storage](./09-kubernetes-networking-y-storage.md) · [Índice](./README.md) · [Capítulo 11 — Kubernetes Security →](./11-kubernetes-security.md)
