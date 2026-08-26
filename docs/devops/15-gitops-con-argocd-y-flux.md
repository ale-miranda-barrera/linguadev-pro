# Capítulo 15 — GitOps con ArgoCD y Flux

> **Focus:** GitOps como paradigma operacional: Git como fuente única de verdad, agentes en el cluster que hacen pull y reconcilian estado. ArgoCD (Applications, ApplicationSets, App of Apps, sync waves, hooks). Flux v2 (Kustomization, HelmRelease, GitRepository, ImagePolicy). Secretos: SOPS, Sealed Secrets y External Secrets Operator.
> **Áreas:** IaC · deployment · Kubernetes operations
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior

## 0. Antes de empezar

**Pre-requisitos:**
- Kubernetes básico: Pods, Deployments, Services, Ingress, Namespaces, kubectl.
- Helm 3 (charts, values, releases).
- Kustomize (bases, overlays, patches).
- Git avanzado (branches, PRs, revert, tags).
- Nociones de CI/CD (ver [Cap 09 — CI/CD]) y IaC (Caps 12-14).
- Ideal: haber ejecutado alguna vez `kubectl apply -f` desde CI y sentir el pinchazo cuando alguien editó recursos manualmente.

**Glosario mínimo:**
- **GitOps:** paradigma operacional donde Git es la fuente única de verdad y agentes en el cluster reconcilian continuamente estado real vs deseado.
- **OpenGitOps:** grupo de trabajo CNCF (2021) que formaliza los 4 principios: declarativo, versionado/inmutable, pulled automáticamente, reconciliado continuamente.
- **Reconciliation loop:** ciclo en el que el agente compara estado real vs Git y aplica diferencias.
- **Drift:** divergencia entre el estado del cluster y el estado en Git.
- **Application (ArgoCD):** CRD que declara "esta ruta de Git es esta app en este cluster".
- **ApplicationSet (ArgoCD):** generador que produce múltiples Applications desde un template (git, list, cluster, matrix generators).
- **App of Apps (ArgoCD):** patrón donde una Application raíz apunta a un repo con más Applications.
- **Sync wave (ArgoCD):** anotación que ordena la aplicación de recursos en fases.
- **Kustomization (Flux):** CRD equivalente a Application; reconcilia un directorio Kustomize.
- **HelmRelease (Flux):** CRD que instala/actualiza un Helm chart.
- **GitRepository / OCIRepository / Bucket (Flux):** sources declarados como CRD.
- **ImagePolicy / ImageUpdateAutomation (Flux):** actualización automática de tags de imagen mediante commits.
- **SOPS:** herramienta de Mozilla para cifrar archivos YAML/JSON con AWS KMS, GCP KMS, Azure Key Vault, PGP o age.
- **Sealed Secrets:** controller Bitnami que descifra `SealedSecret` con clave privada del cluster.
- **External Secrets Operator (ESO):** operador que sincroniza secretos desde vaults externos (Vault, AWS SM, GCP SM, Azure KV) a `Secret` nativos.
- **Progressive delivery:** despliegue gradual con métricas (canary, blue/green, feature flags). Herramientas: Argo Rollouts, Flagger.

**Setup mínimo:**

```bash
# 1. Cluster local
kind create cluster --name gitops-lab --config - <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  extraPortMappings:
  - { containerPort: 80, hostPort: 80 }
  - { containerPort: 443, hostPort: 443 }
EOF

# 2. Instalar ArgoCD (3.x)
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Password inicial
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d && echo
kubectl port-forward -n argocd svc/argocd-server 8080:443 &
# UI: https://localhost:8080

# 3. Instalar Flux (2.4+) — alternativo
brew install fluxcd/tap/flux
flux install     # instala controllers en flux-system

# 4. CLI de ArgoCD
brew install argocd
argocd login localhost:8080 --username admin --password <pwd> --insecure
```

**Nota versiones 2026:** ArgoCD 3.x (3.3 GA en 2026 con shallow clone y source hydrator optimizado). Flux 2.8 (feb 2026, Helm v4 y optimizaciones monorepo). Ambos son CNCF **graduated** desde 2022. Los ejemplos aquí funcionan en 3.x/2.x recientes.

---

## 1. El gran cuadro

Antes de GitOps, el modelo dominante de despliegue en Kubernetes era **CIOps** (Continuous Integration Ops): un runner de CI (Jenkins, GitLab, GitHub Actions) tras el merge a `main` ejecutaba `kubectl apply -f` o `helm upgrade` contra el cluster. Funcionaba, pero traía tres problemas persistentes: (1) el runner de CI necesitaba **credenciales de admin** al cluster, incrementando la superficie de ataque; (2) si alguien editaba un recurso manualmente (`kubectl edit`, `kubectl scale`), el pipeline no revertía el cambio; el drift persistía; (3) no había una respuesta clara a "¿qué está desplegado ahora mismo en prod?" excepto correr `kubectl get all` en cada namespace y esperar entender la salida.

**Alexis Richardson (Weaveworks)** publicó en 2017 el post que acuñó el término **GitOps**. La idea era invertir el flujo: en vez de que CI empuje al cluster, un agente **dentro** del cluster hace pull del repo Git y aplica lo que allí encuentre. Git se convierte en la fuente única de verdad. Rollback = `git revert`. Auditoría = `git log`. Reconciliación continua elimina el drift automáticamente. En 2021, CNCF formalizó los principios bajo el paraguas **OpenGitOps**: (1) declarativo, (2) versionado e inmutable, (3) pulled automáticamente, (4) reconciliado continuamente. En 2022, tanto **ArgoCD** (Intuit, 2018) como **Flux** (Weaveworks) alcanzaron el estatus de **CNCF Graduated**. En 2026 son las dos implementaciones dominantes.

La elección entre ArgoCD y Flux se reduce a filosofía y ergonomía. **ArgoCD** trae una UI web muy pulida, un CLI potente, ApplicationSets como generador flexible y una experiencia excelente para operadores. Es la opción por default de la mayoría de plataformas Kubernetes managed (OpenShift GitOps, EKS Blueprints). **Flux** es más minimalista, más "Unix-y", CRDs muy compuestas y una integración natural con GitHub PRs para automatización de imágenes. Elegir uno u otro rara vez es una decisión determinante; ambos cumplen los 4 principios y son perfectamente producción-ready. La regla informal: ArgoCD si valoras UI y operadores no-K8s-natives; Flux si valoras minimalismo y automation-first.

Un mito frecuente es equiparar "GitOps" a "kubectl apply desde CI". No lo es: sin **agent en el cluster** que reconcilia periódicamente, no cumples los principios. Otro mito: "GitOps solo sirve para Kubernetes". Es cierto que las implementaciones populares son K8s-native (ArgoCD y Flux operan sobre CRDs), pero los principios aplican también a IaC. Herramientas como **Atlantis** (Terraform), **env0**, **Spacelift** proponen GitOps para infra no-K8s. **Crossplane** (Cap 16) lleva GitOps a provisionar cloud desde K8s.

Finalmente, el capítulo más delicado de GitOps son los **secretos**. Commitear `Secret` en claro es no-go. Las tres soluciones dominantes en 2026: **SOPS** (encripta el YAML entero con KMS/age, se descifra en el cluster con un plugin de Kustomize), **Sealed Secrets** (encripta con la pública del controller; el cluster descifra con la privada), y **External Secrets Operator** (Git no guarda el valor sino una referencia; el operador lo sincroniza desde un vault externo). Cada una tiene su nicho. La regla operativa: **ESO + vault externo** para la mayoría; SOPS si necesitas que todo viva en Git; Sealed Secrets si necesitas cero dependencias externas.

---

## 2. Principios GitOps, ArgoCD Applications básicas (nivel básico)

### 2.1 Los 4 principios (OpenGitOps v1.0)

1. **Declarativo:** describes el estado deseado del sistema (manifiestos YAML, charts Helm, Kustomize bases), no los pasos para llegar allí.
2. **Versionado e inmutable:** el estado vive en Git. Cada cambio es un commit trazable. Rollback = `git revert`.
3. **Pulled automáticamente:** el sistema pide (pull) su configuración; no la recibe empujada. El pull lo hace un agente dentro del ambiente controlado.
4. **Reconciliado continuamente:** software agents compara estado deseado (Git) vs real (cluster) y corrige divergencias sin intervención humana.

**Consecuencias operativas:**
- Nunca haces `kubectl apply` a mano en producción. Todo cambio va vía PR.
- Nunca haces `kubectl edit` en un recurso gestionado por GitOps: será revertido.
- Emergency break glass sigue existiendo pero es excepcional, con post-mortem y commit posterior.
- CI ya no necesita credenciales del cluster: su trabajo es construir imágenes, correr tests, hacer merges. El deploy lo hace el agente.

### 2.2 Estructura de repo para GitOps

Dos escuelas dominantes:

**Environments as branches** (esquema Flux clásico, en desuso en 2026):
- `main` → dev
- `staging` → staging cluster
- `prod` → prod cluster

Cambios promocionados entre entornos vía merge. Problema: fricción alta, cherry-picks confusos, difícil ver diff entre entornos.

**Environments as folders** (esquema recomendado 2026):

```
gitops-repo/
  base/
    linguadev-api/
      deployment.yaml
      service.yaml
      kustomization.yaml
  overlays/
    dev/
      linguadev-api/
        kustomization.yaml   # apunta a ../../base/linguadev-api + patches
        patches.yaml
    staging/
    prod/
  apps/
    dev/
      root-application.yaml
    staging/
    prod/
```

Todos los entornos viven en `main`. La promoción es un PR que edita el overlay del siguiente entorno (típicamente cambia una tag de imagen o un value). El diff es explícito.

### 2.3 Una Application básica en ArgoCD

```yaml
# apps/dev/linguadev-api.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: linguadev-api-dev
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io   # cleanup al borrar
spec:
  project: default
  source:
    repoURL: https://github.com/linguadev/gitops
    targetRevision: main
    path: overlays/dev/linguadev-api
  destination:
    server: https://kubernetes.default.svc
    namespace: linguadev-dev
  syncPolicy:
    automated:
      prune: true         # borra recursos no presentes en Git
      selfHeal: true      # revierte cambios manuales
      allowEmpty: false
    syncOptions:
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground
      - PruneLast=true
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

Puntos clave:

- `syncPolicy.automated.selfHeal: true` es el que garantiza reconciliación: si alguien `kubectl edit`, ArgoCD revierte en cuestión de segundos.
- `prune: true` borra recursos que ya no existen en Git.
- `syncOptions.CreateNamespace=true` crea el namespace si no existe.
- `finalizer` asegura que al borrar la Application, los recursos hijo también se borran.

Aplicar:

```bash
kubectl apply -f apps/dev/linguadev-api.yaml
argocd app sync linguadev-api-dev
argocd app get linguadev-api-dev
argocd app diff linguadev-api-dev
```

### 2.4 Push vs Pull en detalle

**Push (CIOps):**

```
GitHub -> Actions runner -> kubectl apply -> cluster
              (has cluster credentials)
```

Riesgos: runner con credentials, no reconciliation, firewall inbound al cluster.

**Pull (GitOps):**

```
GitHub                                cluster
   ^                                    |
   |___pull cada 3min___(ArgoCD)________|
                        agent
```

Ventajas: credentials nunca salen del cluster; el cluster solo hace **outbound** a Git (más simple con firewalls corporativos); reconciliación automática detecta drift; el mismo modelo funciona en clusters air-gapped (con un git mirror interno).

### 2.5 Instalación inicial de ArgoCD y primer sync

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Espera a que esté ready
kubectl wait --for=condition=available deployment --all -n argocd --timeout=5m

# Obtener password inicial
ARGOCD_PWD=$(kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d)
echo "admin / $ARGOCD_PWD"

# Login CLI
kubectl port-forward -n argocd svc/argocd-server 8080:443 &
argocd login localhost:8080 --username admin --password "$ARGOCD_PWD" --insecure

# Crear Application declarativa desde repo público de ejemplo
argocd app create guestbook \
  --repo https://github.com/argoproj/argocd-example-apps.git \
  --path guestbook \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace default \
  --sync-policy automated \
  --auto-prune \
  --self-heal

argocd app sync guestbook
argocd app wait guestbook --health
```

En un minuto tienes tu primer despliegue GitOps funcionando.

---

## 3. ApplicationSets, App of Apps, Flux (nivel medio)

### 3.1 ApplicationSet: multiplicar Applications

Un problema real: tienes 30 microservicios, 3 entornos, 2 regiones. Crear 180 Applications a mano no escala. **ApplicationSet** genera Applications desde un template + un generator.

**List generator** (más simple):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: linguadev-services-dev
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - service: api
            namespace: linguadev-dev
          - service: worker
            namespace: linguadev-dev
          - service: ingester
            namespace: linguadev-dev
  template:
    metadata:
      name: '{{service}}-dev'
    spec:
      project: default
      source:
        repoURL: https://github.com/linguadev/gitops
        targetRevision: main
        path: 'overlays/dev/{{service}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: '{{namespace}}'
      syncPolicy:
        automated: { prune: true, selfHeal: true }
        syncOptions: [ CreateNamespace=true ]
```

**Git generator** (descubre carpetas automáticamente): perfecto para folders-per-app.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: linguadev-services-auto
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/linguadev/gitops
        revision: main
        directories:
          - path: overlays/prod/*
  template:
    metadata:
      name: '{{path.basename}}-prod'
    spec:
      source:
        repoURL: https://github.com/linguadev/gitops
        targetRevision: main
        path: '{{path}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: 'linguadev-prod'
      syncPolicy:
        automated: { prune: true, selfHeal: true }
```

Añades una nueva carpeta bajo `overlays/prod/` → una nueva Application aparece. Cero touch a ArgoCD.

**Matrix generator:** combina generators (cluster × app, por ejemplo). Útil para multi-cluster / multi-region.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: linguadev-multi
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - env: dev
                - env: staging
                - env: prod
          - git:
              repoURL: https://github.com/linguadev/gitops
              revision: main
              directories:
                - path: overlays/{{env}}/*
  template:
    metadata:
      name: '{{env}}-{{path.basename}}'
    spec:
      source:
        repoURL: https://github.com/linguadev/gitops
        path: '{{path}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: 'linguadev-{{env}}'
      syncPolicy:
        automated: { prune: true, selfHeal: true }
```

### 3.2 App of Apps

Patrón donde una Application raíz apunta a un repo/folder con más Applications. Bootstrap del cluster en una sola aplicación.

```yaml
# apps/root.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/linguadev/gitops
    targetRevision: main
    path: apps/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated: { prune: true, selfHeal: true }
```

`apps/prod/` contiene 30 archivos YAML de Applications. El día que provisionas un cluster nuevo, aplicas la root Application y ArgoCD genera todo el resto. **Bootstrap declarativo completo.**

### 3.3 Sync waves y hooks

**Sync waves** ordenan la aplicación de recursos en fases:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: linguadev-prod
  annotations:
    argocd.argoproj.io/sync-wave: "-2"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: db-config
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  annotations:
    argocd.argoproj.io/sync-wave: "0"
---
apiVersion: batch/v1
kind: Job
metadata:
  name: post-deploy-smoke
  annotations:
    argocd.argoproj.io/sync-wave: "1"
    argocd.argoproj.io/hook: PostSync
```

Waves negativas primero. Con hooks (`PreSync`, `Sync`, `PostSync`, `SyncFail`) ejecutas Jobs de migración o smoke tests.

### 3.4 Health checks personalizados

ArgoCD viene con health checks para recursos K8s estándar (Deployment, StatefulSet, Service, Ingress...). Para CRDs custom, defines un health check Lua en el ConfigMap `argocd-cm`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.customizations.health.linguadev.dev_ContentSync: |
    hs = {}
    if obj.status ~= nil and obj.status.phase ~= nil then
      if obj.status.phase == "Ready" then
        hs.status = "Healthy"
        hs.message = "Content synchronized"
        return hs
      end
      if obj.status.phase == "Failed" then
        hs.status = "Degraded"
        hs.message = obj.status.message or "Sync failed"
        return hs
      end
    end
    hs.status = "Progressing"
    hs.message = "Waiting for sync"
    return hs
```

### 3.5 Flux v2: enfoque alternativo

Flux 2 (rewrite 2020, GitOps Toolkit) descompone la funcionalidad en controllers:

- **source-controller:** materializa fuentes (GitRepository, HelmRepository, OCIRepository, Bucket).
- **kustomize-controller:** aplica Kustomization CRDs.
- **helm-controller:** gestiona HelmRelease CRDs.
- **notification-controller:** alertas a Slack/Discord/Teams.
- **image-reflector-controller** + **image-automation-controller:** actualiza tags automáticamente.

Instalación:

```bash
flux install --namespace=flux-system
flux check
```

**Bootstrap con GitHub** (genera repo con manifests del propio Flux):

```bash
flux bootstrap github \
  --owner=linguadev \
  --repository=fleet-infra \
  --branch=main \
  --path=./clusters/prod \
  --personal
```

Ahora Flux se auto-gestiona: cualquier update del controller es un commit en el repo.

**GitRepository + Kustomization:**

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: linguadev-app
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/linguadev/gitops
  ref:
    branch: main
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: linguadev-api-prod
  namespace: flux-system
spec:
  interval: 5m
  path: ./overlays/prod/linguadev-api
  prune: true
  sourceRef:
    kind: GitRepository
    name: linguadev-app
  targetNamespace: linguadev-prod
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: linguadev-api
      namespace: linguadev-prod
  timeout: 2m
```

**HelmRelease:**

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: bitnami
  namespace: flux-system
spec:
  interval: 10m
  url: https://charts.bitnami.com/bitnami
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: postgres
  namespace: linguadev-prod
spec:
  interval: 5m
  chart:
    spec:
      chart: postgresql
      version: '15.x'
      sourceRef:
        kind: HelmRepository
        name: bitnami
        namespace: flux-system
  values:
    auth:
      existingSecret: postgres-credentials
    primary:
      persistence:
        enabled: true
        size: 20Gi
```

**Image automation** (Flux exclusive, muy potente):

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: linguadev-api
  namespace: flux-system
spec:
  image: ghcr.io/linguadev/api
  interval: 1m
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: linguadev-api
  namespace: flux-system
spec:
  imageRepositoryRef: { name: linguadev-api }
  policy:
    semver: { range: '>=1.0.0 <2.0.0' }
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: linguadev-api
  namespace: flux-system
spec:
  interval: 5m
  sourceRef: { kind: GitRepository, name: linguadev-app }
  git:
    commit:
      author:
        email: fluxbot@linguadev.dev
        name: fluxbot
      messageTemplate: 'chore(images): update {{ .AutomationObject }}'
    push: { branch: main }
  update: { path: ./overlays/prod, strategy: Setters }
```

Y en el Deployment:

```yaml
containers:
  - name: api
    image: ghcr.io/linguadev/api:1.2.3 # {"$imagepolicy": "flux-system:linguadev-api"}
```

Cuando el CI publica una nueva tag semver, Flux hace commit al repo actualizando el manifiesto, y luego se reconcilia solo. **Zero-touch deploys tras merge del código.**

### 3.6 Comparación ArgoCD vs Flux (2026)

| Área | ArgoCD 3.x | Flux 2.8+ |
|---|---|---|
| UI web | Sí, muy pulida | No (dashboard third-party: Weave GitOps, Capacitor) |
| CLI | `argocd` completo | `flux` completo |
| Multi-tenancy | AppProjects, RBAC integrado | Tenants con OCIRepository y RBAC K8s |
| Multi-cluster | Native (registra clusters) | Native (fleet architecture) |
| Helm | Vía Application | `HelmRelease` CRD nativo |
| Kustomize | Nativo | `Kustomization` CRD nativo |
| Image updates | Argo CD Image Updater (add-on) | `ImageUpdateAutomation` built-in |
| Progressive delivery | Argo Rollouts (integrado) | Flagger (integrado) |
| Bootstrap | Manual o helm/manifests | `flux bootstrap` en 1 comando |
| Learning curve | Baja gracias a UI | Media, todo CLI |
| Comunidad | Muy grande | Grande |

Regla: si el equipo valora UI y control humano, **ArgoCD**. Si prioriza automation-first y minimalismo, **Flux**. Ambos son sólidos; no hay decisión equivocada.

---

## 4. Secretos, progressive delivery, seguridad (nivel avanzado)

### 4.1 El problema de los secretos en Git

`Secret` normal (base64 sin cifrado real) commitado en Git es no-go: cualquiera con acceso al repo lee los valores. Las tres soluciones:

- **SOPS** — encripta el archivo entero (YAML/JSON/ENV) con KMS/age/PGP. Git guarda el ciphertext. El controller descifra en el cluster.
- **Sealed Secrets** — controller genera par pública/privada; la pública encripta un `SealedSecret` que se commitea; el controller lo descifra a `Secret` normal.
- **External Secrets Operator (ESO)** — Git guarda referencias (`ExternalSecret`); el operador sincroniza valores reales desde Vault/AWS SM/GCP SM/Azure KV.

### 4.2 SOPS + Kustomize

Instalación:

```bash
brew install sops age
age-keygen -o age.key   # genera par
export SOPS_AGE_KEY_FILE=$(pwd)/age.key
export SOPS_AGE_RECIPIENTS=$(grep 'public key:' age.key | sed 's/.*: //')
```

`.sops.yaml` en la raíz del repo:

```yaml
creation_rules:
  - path_regex: secrets/.*\.enc\.yaml$
    encrypted_regex: '^(data|stringData)$'
    age: 'age1qzw...longpublickey...'
```

Crear un `Secret` cifrado:

```bash
cat > secrets/api-keys.yaml <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: api-keys
type: Opaque
stringData:
  OPENAI_API_KEY: sk-...
  ANTHROPIC_API_KEY: sk-ant-...
YAML

sops -e secrets/api-keys.yaml > secrets/api-keys.enc.yaml
rm secrets/api-keys.yaml
```

El fichero `.enc.yaml` es seguro para commitear: solo `data`/`stringData` van cifrados.

**En ArgoCD** necesitas el plugin `argocd-vault-plugin` o `helm-secrets` (Kustomize+SOPS). Configuras el plugin y en la Application declaras:

```yaml
spec:
  source:
    plugin:
      name: kustomize-sops
```

**En Flux** es built-in vía `decryption.provider: sops`:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: linguadev-prod
spec:
  path: ./overlays/prod
  decryption:
    provider: sops
    secretRef:
      name: sops-age
  sourceRef: { kind: GitRepository, name: linguadev-app }
```

El secret `sops-age` en el namespace de Flux tiene la clave privada.

### 4.3 Sealed Secrets

```bash
# Instalar controller
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.28.0/controller.yaml

# CLI
brew install kubeseal

# Sellar un secret
kubectl create secret generic api-keys \
  --from-literal=OPENAI_API_KEY=sk-... \
  --dry-run=client -o yaml > secret.yaml

kubeseal -o yaml < secret.yaml > sealed-secret.yaml
rm secret.yaml
```

`sealed-secret.yaml` es un `SealedSecret` (CRD) con el ciphertext. Solo el controller de ese cluster puede descifrarlo (clave privada). Al commitear y ArgoCD/Flux aplicar, el controller genera el `Secret` nativo.

**Gotchas:**
- La clave privada del controller vive en el cluster; hay que **backupearla** (si la pierdes, no puedes descifrar).
- Sealed Secrets sella para un cluster+namespace específicos (o con scope namespace-wide/cluster-wide). Migrar entre clusters requiere re-sealing.
- No integra con vaults externos.

### 4.4 External Secrets Operator (ESO) — el estándar 2026

Modelo: Git guarda referencias, el operador sincroniza valores reales desde un vault externo en tiempo real.

Instalar:

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace
```

**Ejemplo con AWS Secrets Manager:**

```yaml
apiVersion: external-secrets.io/v1
kind: SecretStore
metadata:
  name: aws-sm
  namespace: linguadev-prod
spec:
  provider:
    aws:
      service: SecretsManager
      region: eu-west-1
      auth:
        jwt:
          serviceAccountRef:
            name: eso-sa   # SA con IAM Role for Service Accounts
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: api-keys
  namespace: linguadev-prod
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-sm
    kind: SecretStore
  target:
    name: api-keys        # genera este Secret en el cluster
    creationPolicy: Owner
  data:
    - secretKey: OPENAI_API_KEY
      remoteRef:
        key: linguadev/prod/openai-api-key
    - secretKey: ANTHROPIC_API_KEY
      remoteRef:
        key: linguadev/prod/anthropic-api-key
```

En Git solo vive la referencia (la key en AWS SM), no el valor. Rotación en AWS SM se refleja en el cluster automáticamente (`refreshInterval`).

**Providers soportados 2026:** AWS Secrets Manager, AWS Parameter Store, GCP Secret Manager, Azure Key Vault, HashiCorp Vault, Akeyless, 1Password, Bitwarden, Doppler, Infisical, y +40 más.

**Ventajas ESO:**
- Un solo modelo de secretos para toda la organización, agnóstico del cloud.
- Rotación automática visible.
- Auditoría centralizada en el vault.
- Cero secretos (ni cifrados) en Git.

**Recomendación 2026:** ESO por default. SOPS si necesitas todo en Git por regulación. Sealed Secrets si cero dependencias externas es un requisito duro.

### 4.5 Progressive delivery con Argo Rollouts / Flagger

Los recursos Kubernetes estándar (Deployment) hacen rolling update básico. Para canary con métricas, blue/green con validación o análisis con Prometheus, se usan **Argo Rollouts** (comunidad ArgoCD) o **Flagger** (comunidad Flux). Ambos definen CRDs que sustituyen o envuelven al Deployment.

**Argo Rollouts canary con analysis:**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: linguadev-api
spec:
  replicas: 10
  selector:
    matchLabels: { app: linguadev-api }
  template:
    metadata: { labels: { app: linguadev-api } }
    spec:
      containers:
        - name: api
          image: ghcr.io/linguadev/api:1.4.0
  strategy:
    canary:
      canaryService: linguadev-api-canary
      stableService: linguadev-api-stable
      trafficRouting:
        alb:
          ingress: linguadev-api
          servicePort: 80
      steps:
        - setWeight: 10
        - pause: { duration: 2m }
        - analysis:
            templates: [{ templateName: success-rate }]
            args: [{ name: service-name, value: linguadev-api-canary }]
        - setWeight: 25
        - pause: { duration: 5m }
        - setWeight: 50
        - pause: { duration: 5m }
        - setWeight: 75
        - pause: { duration: 5m }
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate
      interval: 30s
      count: 5
      successCondition: result[0] >= 0.99
      failureLimit: 2
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(http_requests_total{service="{{args.service-name}}",code!~"5.."}[1m]))
            /
            sum(rate(http_requests_total{service="{{args.service-name}}"}[1m]))
```

Si el analysis falla (2 fallos consecutivos), Argo Rollouts **aborta y revierte** automáticamente al estable. Sin este patrón, un deploy malo se cuela y saltan las alertas cuando ya está en producción con 100% del tráfico.

**Flagger** ofrece equivalente para Flux, con la misma filosofía.

### 4.6 Multi-tenancy y RBAC

**ArgoCD Projects** limitan qué repos, namespaces y clusters puede usar un grupo de Applications:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-content
  namespace: argocd
spec:
  description: Content team apps
  sourceRepos:
    - https://github.com/linguadev/content-*
  destinations:
    - namespace: content-*
      server: https://kubernetes.default.svc
  clusterResourceWhitelist: []       # no permite cluster-wide
  namespaceResourceBlacklist:
    - group: ''
      kind: ResourceQuota
  roles:
    - name: developer
      policies:
        - p, proj:team-content:developer, applications, sync, team-content/*, allow
        - p, proj:team-content:developer, applications, get, team-content/*, allow
      groups:
        - linguadev:content-team
```

**Flux tenants** usan un ServiceAccount por tenant y `Kustomization.spec.serviceAccountName` para limitar el blast radius.

### 4.7 Seguridad y validaciones

- **Signed commits** en Git (GPG/SSH) + branch protection con required signatures.
- **Admission controllers** (Kyverno, OPA Gatekeeper) para bloquear manifests inseguros.
- **Policy as code** en el pipeline pre-merge (Conftest, Kubeconform, Datree).
- **Signed images** con Cosign; verificar en el cluster con `sigstore-policy-controller`.
- **Cluster egress restringido:** solo Git, registry, KMS.
- **Backup del estado ArgoCD/Flux:** las CRDs viven en el cluster; si el cluster se pierde, el bootstrap desde Git recupera todo. Pero backup de `argocd-cm`, `argocd-secret`, `sealed-secrets` privada.

---

## 5. Ejemplo práctico completo: LinguaDev Pro deploy con ArgoCD + ESO

Aplicamos todo a un caso concreto: deployar el API de LinguaDev Pro en un cluster EKS con ArgoCD, ESO conectado a AWS Secrets Manager, y Argo Rollouts para canary.

### Estructura del repo

```
gitops-repo/
  bootstrap/
    argocd-install.yaml
    argocd-cm-patch.yaml
    app-projects.yaml
  base/
    linguadev-api/
      deployment.yaml
      service.yaml
      hpa.yaml
      rollout.yaml
      analysis-template.yaml
      external-secret.yaml
      service-account.yaml
      kustomization.yaml
  overlays/
    dev/
      linguadev-api/
        kustomization.yaml
        patch-replicas.yaml
    staging/
      linguadev-api/
        kustomization.yaml
        patch-replicas.yaml
    prod/
      linguadev-api/
        kustomization.yaml
        patch-replicas.yaml
  apps/
    root.yaml
    applicationset.yaml
```

### `base/linguadev-api/rollout.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: linguadev-api
  labels: { app: linguadev-api }
spec:
  replicas: 3
  selector:
    matchLabels: { app: linguadev-api }
  template:
    metadata:
      labels: { app: linguadev-api }
    spec:
      serviceAccountName: linguadev-api
      containers:
        - name: api
          image: ghcr.io/linguadev/api:1.0.0
          ports:
            - containerPort: 8080
              name: http
          envFrom:
            - secretRef:
                name: api-keys
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          readinessProbe:
            httpGet: { path: /health, port: http }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /health, port: http }
            initialDelaySeconds: 15
            periodSeconds: 10
  strategy:
    canary:
      canaryService: linguadev-api-canary
      stableService: linguadev-api-stable
      steps:
        - setWeight: 10
        - pause: { duration: 2m }
        - analysis:
            templates: [{ templateName: success-rate }]
            args: [{ name: service-name, value: linguadev-api-canary }]
        - setWeight: 50
        - pause: { duration: 5m }
```

### `base/linguadev-api/external-secret.yaml`

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: api-keys
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-sm
    kind: ClusterSecretStore
  target:
    name: api-keys
    creationPolicy: Owner
  data:
    - secretKey: OPENAI_API_KEY
      remoteRef:
        key: linguadev/${ENV}/openai
    - secretKey: DYNAMO_TABLE
      remoteRef:
        key: linguadev/${ENV}/dynamo-table
```

### `base/linguadev-api/kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - service-account.yaml
  - external-secret.yaml
  - rollout.yaml
  - service.yaml
  - hpa.yaml
  - analysis-template.yaml
commonLabels:
  app: linguadev-api
  managed-by: argocd
```

### `overlays/prod/linguadev-api/kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: linguadev-prod
resources:
  - ../../../base/linguadev-api
patches:
  - path: patch-replicas.yaml
images:
  - name: ghcr.io/linguadev/api
    newTag: 1.4.2
replacements:
  - source:
      kind: ConfigMap
      name: env-config
      fieldPath: data.ENV
    targets:
      - select: { kind: ExternalSecret, name: api-keys }
        fieldPaths: [ spec.data.0.remoteRef.key, spec.data.1.remoteRef.key ]
```

### `apps/applicationset.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: linguadev-services
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - env: dev
                - env: staging
                - env: prod
          - git:
              repoURL: https://github.com/linguadev/gitops
              revision: main
              directories: [{ path: 'overlays/{{env}}/*' }]
  template:
    metadata:
      name: '{{env}}-{{path.basename}}'
      namespace: argocd
    spec:
      project: '{{env}}'
      source:
        repoURL: https://github.com/linguadev/gitops
        targetRevision: main
        path: '{{path}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: 'linguadev-{{env}}'
      syncPolicy:
        automated: { prune: true, selfHeal: true }
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
        retry:
          limit: 5
          backoff: { duration: 5s, factor: 2, maxDuration: 3m }
```

### Bootstrap end-to-end

```bash
# 1. Cluster
kubectl config use-context eks-linguadev-prod

# 2. Instalar ArgoCD
kubectl apply -k bootstrap/

# 3. Instalar Argo Rollouts
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# 4. Instalar External Secrets Operator
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace

# 5. Aplicar root App of Apps
kubectl apply -f apps/root.yaml

# 6. Ver estado
argocd app list
argocd app get prod-linguadev-api
```

Al hacer merge en el repo con una nueva tag de imagen, el ApplicationSet re-sincroniza; el Rollout hace canary con analysis; si Prometheus dice que success rate cae, Argo aborta y revierte. **Deploy declarativo end-to-end.**

---

## 6. Cheatsheet + reglas mentales + antipatrones

### Reglas de oro

- ✅ Git es la fuente ÚNICA de verdad. Nada de `kubectl edit` en prod.
- ✅ Los 4 principios OpenGitOps completos: declarativo + versionado + pull + reconciliado.
- ✅ Environments as folders, no environments as branches.
- ✅ `selfHeal: true` obligatorio en Applications gestionadas.
- ✅ `prune: true` para evitar acumulación de basura.
- ✅ App of Apps para bootstrap declarativo del cluster.
- ✅ ApplicationSet con git generator: cero touch al añadir apps.
- ✅ Sync waves para orden estricto (Namespace → CRDs → Deployments → Jobs post).
- ✅ Progressive delivery (Argo Rollouts / Flagger) para deploys críticos.
- ✅ Secretos: ESO por default; SOPS si todo en Git; Sealed Secrets como fallback.
- ✅ Signed commits + branch protection sobre `main`.
- ✅ Cluster egress restringido: solo Git, registry y KMS/vault.
- ✅ AppProjects para multi-tenancy y RBAC.
- ✅ Backup de `argocd-secret`, claves de Sealed Secrets, config de SOPS.
- ✅ Runbook para "cluster totalmente perdido → restore desde Git".

### Antipatrones

- ❌ `kubectl apply` desde CI (CIOps, no GitOps).
- ❌ Commitear `Secret` con `data` en base64 sin cifrado real.
- ❌ Environments as branches (fricción alta, promocionar es dolor).
- ❌ Application sin `selfHeal` (deja drift persistir).
- ❌ Sync automático desactivado por defecto (pierdes el valor de reconciliación).
- ❌ Manifests con `latest` como tag de imagen (impide rollback preciso).
- ❌ Editar recursos en el cluster para "arreglar rápido" sin PR posterior.
- ❌ CI con credenciales admin del cluster (superficie de ataque).
- ❌ ArgoCD y app en el mismo cluster sin proyecto separado (mismo RBAC).
- ❌ Sealed Secrets sin backup de la privada (pérdida catastrófica).
- ❌ SOPS con age keys en el repo (obvio pero pasa).
- ❌ Ignorar `Comparison` en la UI de ArgoCD ("OutOfSync" persistente).
- ❌ Deploy en prod sin canary/analysis para servicios críticos.
- ❌ Un solo ApplicationSet gigante para toda la organización (blast radius enorme).

### Tabla comparativa rápida

| Necesidad | ArgoCD | Flux |
|---|---|---|
| UI web para operadores | Nativa | Requiere Weave GitOps u otro |
| Automatización imagen | Argo CD Image Updater (add-on) | Nativa |
| Progressive delivery | Argo Rollouts (mismo umbrella) | Flagger |
| Multi-cluster | Registras clusters | Fleet CRDs |
| Multi-tenancy | AppProjects | Tenants (SAs + Kustomizations) |
| Secretos SOPS | Plugin | Nativo |
| CNCF status | Graduated | Graduated |
| Curva | Baja (gracias UI) | Media (CLI-first) |

---

## 7. Casos reales industria 2020-2026

**Intuit ArgoCD (2018-2026):** Intuit creó ArgoCD como parte de Argo Project (junto con Argo Workflows, Rollouts, Events). Gestiona TurboTax y otras propiedades sobre >200 clusters. ArgoCD llegó a CNCF graduated en 2022. Referencia canónica de GitOps a escala enterprise.

**Weaveworks fin de operaciones (feb 2024):** la empresa que acuñó "GitOps" y creó Flux cerró tras 10 años. Flux siguió vivo (proyecto CNCF con múltiples maintainers). Lección: la salud de un OSS project no depende de una sola empresa; los CNCF projects graduated tienen governance distribuido.

**GitLab Auto DevOps + Kubernetes agent:** GitLab pivotó de push a pull con el "GitLab Agent" para clusters. Empujó GitOps al mainstream de sus users. En 2026, muchas empresas usan GitLab CI para build + ArgoCD/Flux para deploy.

**Red Hat OpenShift GitOps (basado en ArgoCD):** Red Hat empaqueta ArgoCD como operador oficial en OpenShift. Prueba de que GitOps es asumido como default operacional en plataformas enterprise Kubernetes.

**Adobe, Deutsche Telekom, Volvo (2022-2026):** case studies públicos de migración a GitOps con Flux o ArgoCD. Patrón común: reducción drástica de outages por drift, tiempo medio a recovery (MTTR) mejorado 5-10x.

**Bitnami Sealed Secrets (2017-2026):** proyecto pequeño pero widely used. VMware/Broadcom mantiene la organización Bitnami; hubo dudas 2024 sobre continuidad. Comunidad ha asumido más peso, releases siguen. Lección: siempre mira el bus factor de los deps críticos.

**External Secrets Operator (2020-2026):** proyecto CNCF sandbox, con 40+ providers en 2026. Reemplazó al deprecated `external-secrets` original en muchas organizaciones. Estándar de facto para secretos en GitOps.

**Progressive delivery mainstream (2023-2026):** Argo Rollouts y Flagger salen del nicho y se vuelven parte del stack estándar en fintech, e-commerce, cualquier servicio con SLO estricto. Lección: rolling deploy simple ya no es suficiente para servicios críticos.

**Flux 2 → OCI artifacts (2024):** Flux añadió soporte para OCIRepository (helm charts, manifests como OCI artifacts en registry en lugar de git). Permite pipelines más rápidos y control de versionado en registry.

**Multi-cluster fleet management:** Rancher Fleet, ArgoCD ApplicationSets, Flux Fleet Manager compiten por gestionar 100s-1000s clusters con GitOps. Uso típico: edge (retail, IoT), telco 5G, plataformas SaaS multi-tenant.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Bootstrap ArgoCD y primera Application

**Objetivo:** desplegar ArgoCD en un cluster local y sincronizar una Application declarativa.

**Setup:** kind o k3d instalado; kubectl.

**Pasos:**
1. `kind create cluster --name gitops-lab`.
2. Instalar ArgoCD (`kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml`).
3. Obtener password admin y hacer `port-forward` al UI.
4. Crear una Application declarativa (YAML) apuntando a `https://github.com/argoproj/argocd-example-apps.git`, path `guestbook`.
5. Aplicar el YAML y verificar sync en la UI.
6. Editar manualmente el Deployment (`kubectl scale deployment guestbook-ui --replicas=5`) y ver cómo ArgoCD lo revierte.

**Criterios de éxito:**
- [ ] ArgoCD accesible en `https://localhost:8080`.
- [ ] Application `guestbook` synced y healthy.
- [ ] Cambio manual revertido en <60 s por `selfHeal`.
- [ ] UI muestra la diff entre estado deseado y actual.

**Bonus:** protege la UI con OIDC (Dex) o con TLS custom.

---

### Ejercicio 2: App of Apps para bootstrap declarativo

**Objetivo:** crear una Application raíz que genere otras 3 Applications, todo desde Git.

**Setup:** repo Git accesible desde el cluster (público o con SSH deploy key).

**Pasos:**
1. Crea repo `gitops-lab/` con carpetas `apps/` y `overlays/dev/`.
2. Escribe 3 Applications hijo en `apps/` (por ejemplo: guestbook, nginx, otro chart Helm).
3. Escribe `apps/root.yaml` que apunte a `apps/`.
4. Aplica `root.yaml` con `kubectl apply -f`.
5. Verifica que las 3 Applications hijo aparecen automáticamente en la UI.
6. Añade una 4ª Application, commit + push → aparece sin tocar el cluster.

**Criterios de éxito:**
- [ ] Root Application creada.
- [ ] 3 Applications hijo synced.
- [ ] Añadir 4ª sin tocar el cluster.
- [ ] `argocd app tree root` muestra la jerarquía.
- [ ] Borrar root también borra los hijos (finalizers).

**Bonus:** convierte el App of Apps en un ApplicationSet con git generator.

---

### Ejercicio 3: Secretos con External Secrets Operator + AWS SM

**Objetivo:** montar ESO en el cluster y sincronizar un secreto desde AWS Secrets Manager sin commitear ningún valor sensible.

**Setup:** cuenta AWS, IAM Role for Service Accounts (IRSA) o keys locales para lab.

**Pasos:**
1. Instalar ESO vía Helm.
2. Crear un secreto en AWS SM: `aws secretsmanager create-secret --name linguadev/dev/api --secret-string '{"OPENAI":"sk-..."}'`.
3. Crear `ClusterSecretStore` con provider AWS SM.
4. Crear `ExternalSecret` que sincronice `linguadev/dev/api` a un `Secret` llamado `api-keys`.
5. `kubectl get secret api-keys -o yaml` — verifica que el valor está presente.
6. Modifica el valor en AWS SM y observa que se refresca en <1 h (o baja `refreshInterval`).

**Criterios de éxito:**
- [ ] ESO controller running.
- [ ] `SecretStore` conectado a AWS SM (status Ready).
- [ ] `Secret api-keys` generado con los valores correctos.
- [ ] Rotación en AWS SM se refleja en el cluster.
- [ ] Cero secretos en Git.

**Bonus:** integra con IAM Role for Service Accounts (IRSA) para eliminar credenciales locales.

---

### Ejercicio 4: Canary con Argo Rollouts + análisis Prometheus

**Objetivo:** deployar un servicio con canary automático que se revierta si el error rate sube.

**Setup:** cluster con Prometheus y kube-state-metrics; app expuesta con métricas.

**Pasos:**
1. Instalar Argo Rollouts.
2. Convertir tu Deployment a `Rollout` con canary strategy.
3. Definir `AnalysisTemplate` con métrica Prometheus (error rate).
4. Deployar v1 → verificar OK.
5. Deployar v2 con bug intencionado (500s).
6. Observar canary → analysis falla → revert automático.
7. Deployar v3 (fix) → canary pasa → 100% tráfico.

**Criterios de éxito:**
- [ ] Rollout progresa en steps (10 → 25 → 50 → 100%).
- [ ] Analysis se ejecuta en pauses.
- [ ] v2 falla y se revierte a v1 automáticamente.
- [ ] v3 completa con success.
- [ ] Métricas visibles en Prometheus y kubectl argo rollouts.

**Bonus:** añade `experimentTemplates` para comparar dos variantes con tráfico paralelo.

---

### Ejercicio 5 (bonus): Fleet management con ApplicationSet matrix

**Objetivo:** deployar 3 apps × 3 entornos = 9 Applications con un único ApplicationSet.

**Setup:** repo con overlays `dev/`, `staging/`, `prod/` para 3 apps.

**Pasos:**
1. Estructura de repo:
   ```
   overlays/dev/{api,worker,ui}
   overlays/staging/{api,worker,ui}
   overlays/prod/{api,worker,ui}
   ```
2. Crear ApplicationSet con matrix generator (list de envs × git generator de directorios).
3. Aplicar y verificar que aparecen 9 Applications.
4. Añadir una nueva app (`recomender`) con overlays en los 3 envs y observar que aparecen 3 nuevas Applications automáticamente.
5. Borrar el ApplicationSet: todas las Applications hijos se limpian.

**Criterios de éxito:**
- [ ] 9 Applications generadas automáticamente.
- [ ] Añadir app genera 3 nuevas sin editar el ApplicationSet.
- [ ] Borrar ApplicationSet elimina todas las hijas.
- [ ] Cada Application está en el project correcto (dev/staging/prod).
- [ ] AppProject enforcement funciona (dev no puede aplicar en prod).

**Bonus:** añade cluster generator para deployar a 2 clusters distintos por entorno.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [ArgoCD Docs](https://argo-cd.readthedocs.io/).
- [Flux Docs](https://fluxcd.io/docs/).
- [OpenGitOps Principles v1.0](https://opengitops.dev/).
- [Argo Rollouts](https://argoproj.github.io/argo-rollouts/).
- [Flagger](https://flagger.app/).
- [External Secrets Operator](https://external-secrets.io/).
- [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets).
- [SOPS](https://github.com/getsops/sops).

**Libros y guías:**
- Alexis Richardson — *GitOps: What You Need to Know* (Weaveworks).
- Billy Yuen, Alexander Matyushentsev, Todd Ekenstam, Jesse Suen — *GitOps and Kubernetes* (Manning, 2021).
- Christian Hernandez — *Multi-Cluster Kubernetes* (Packt, 2022).
- Google Cloud — *Deploy at Scale with GitOps*.

**Cursos y comunidad:**
- KubeCon + CloudNativeCon (tracks GitOps anuales).
- Argo Community Meetings (semanales).
- Flux Community Meetings.
- CNCF TAG App Delivery.

**Alternativas y contexto:**
- **Fleet** (Rancher/SUSE) — GitOps optimizado para edge.
- **Jenkins X** — GitOps con foco en preview environments.
- **Kargo** (Akuity, 2024+) — promoción de artefactos entre stages con GitOps.
- **Kluctl** — alternativa a Kustomize+Helm+GitOps en un solo tool.

**Siguientes pasos:**
- Implementa GitOps en tu cluster de LinguaDev Pro.
- Migra secretos de manifiestos a ESO + AWS SM.
- Convierte deploys críticos a Argo Rollouts con analysis Prometheus.
- Configura signed commits + branch protection sobre `main`.
- Lee [Cap 16 — Pulumi, CDK y IaC moderna](./16-pulumi-cdk-y-iac-moderna.md) para extender la mentalidad GitOps al provisioning con Crossplane.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre principios GitOps, push vs pull, Applications, ApplicationSets, App of Apps, sync waves, Flux (Kustomization, HelmRelease, ImagePolicy), gestión de secretos (SOPS, Sealed Secrets, ESO), progressive delivery, RBAC y comparativa ArgoCD vs Flux. Dificultades junior → mid → senior.

- **Fuente:** [`packages/content/src/tech/devops/sim-15-gitops-with-argocd-flux.json`](../../packages/content/src/tech/devops/sim-15-gitops-with-argocd-flux.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-15-gitops-with-argocd-flux`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 14 — Cloud fundamentals y multi-cloud](./14-cloud-fundamentals-y-multi-cloud.md) · [Índice](./README.md) · [Capítulo 16 — Pulumi, CDK y IaC moderna →](./16-pulumi-cdk-y-iac-moderna.md)
