# Capítulo 11 — Kubernetes Security

> **Focus:** Asegurar el cluster desde el pod hasta la API. RBAC (Role, ClusterRole, ServiceAccount, tokens efímeros), Pod Security Standards (privileged/baseline/restricted), NetworkPolicies default-deny, admission controllers (validating vs mutating), OPA Gatekeeper 3.18 + Kyverno 1.13, image pull secrets, encryption at rest, Trivy operator, security contexts, seccomp y AppArmor.
> **Áreas:** Kubernetes security · Policy-as-code · Container hardening
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos K8s (ver [cap 07](./07-fundamentos-kubernetes.md)) y workloads (ver [cap 08](./08-kubernetes-workloads.md)).
- Networking y NetworkPolicies (ver [cap 09](./09-kubernetes-networking-y-storage.md)).
- Helm/Kustomize para desplegar policy engines (ver [cap 10](./10-helm-y-kustomize.md)).
- Fundamentos de container security: user namespaces, capabilities Linux, cgroups.
- Cripto básica: TLS, JWT/OIDC, KMS conceptual.

**Glosario mínimo:**
- **RBAC** (Role-Based Access Control): sistema de autorización basado en roles con `Role`, `ClusterRole`, `RoleBinding`, `ClusterRoleBinding`.
- **ServiceAccount** (SA): identidad de un Pod ante la API de Kubernetes. Cada namespace tiene un `default` SA automático.
- **Bound Service Account Token**: JWT firmado por el cluster con `aud`, `exp` y `iss`. Reemplazó los tokens infinitos legacy en K8s 1.24+.
- **PSA** (Pod Security Admission): controller nativo que aplica los **Pod Security Standards** por namespace via label. Reemplazó a PodSecurityPolicy (removido en 1.25).
- **PSS** (Pod Security Standards): 3 profiles predefinidos — `privileged`, `baseline`, `restricted`.
- **Admission controller**: código que intercepta requests a la API server. Puede ser **validating** (aprobar/rechazar) o **mutating** (modificar).
- **OPA Gatekeeper 3.18**: policy engine basado en Rego (Open Policy Agent), enforced vía admission webhook.
- **Kyverno 1.13**: policy engine YAML-native, no requiere DSL. Admission + generation + mutation.
- **Trivy Operator**: escaneo continuo de vulnerabilidades e configs inseguras, montado como CRDs.
- **Seccomp** (secure computing): filtro de syscalls por proceso.
- **AppArmor** / **SELinux**: MAC (Mandatory Access Control) del kernel.
- **Encryption at rest**: cifrado de Secrets y otros recursos en etcd usando `EncryptionConfiguration` con KMS.
- **imagePullSecret**: credenciales para pull de imágenes desde registries privados.

**Setup mínimo:**

```bash
# 1. Cluster local con audit logging para debug de RBAC/PSA
cat > audit-policy.yaml <<'YAML'
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: Metadata
YAML

# 2. Kyverno 1.13
helm repo add kyverno https://kyverno.github.io/kyverno/
helm install kyverno kyverno/kyverno \
  -n kyverno --create-namespace \
  --version 3.3.4 \
  --set admissionController.replicas=3 \
  --set backgroundController.replicas=1

# 3. OPA Gatekeeper 3.18
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm install gatekeeper gatekeeper/gatekeeper \
  -n gatekeeper-system --create-namespace \
  --version 3.18.1 \
  --set replicas=3

# 4. Trivy Operator (Aqua) para escaneo continuo
helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm install trivy-operator aqua/trivy-operator \
  -n trivy-system --create-namespace \
  --version 0.24.1 \
  --set trivy.ignoreUnfixed=true

# 5. Utilidades
brew install kubectl-who-can        # descubrir "quién puede X"
kubectl krew install access-matrix  # matriz de permisos
kubectl krew install rakkess        # revisar SA effective perms
```

---

## 1. El gran cuadro

La seguridad de Kubernetes no es una feature: es una **superficie compuesta** por seis planos que interactúan. El **plano de identidad** decide quién puede hacer qué contra la API (RBAC + ServiceAccounts + OIDC/IAM); el **plano de admisión** valida y muta requests antes de que lleguen a etcd (PSA + OPA Gatekeeper + Kyverno + admission webhooks custom); el **plano del workload** define qué privilegios corren dentro de cada Pod (securityContext, seccomp, AppArmor, capabilities); el **plano de red** aísla los pods entre sí (NetworkPolicies default-deny + service mesh mTLS); el **plano de secrets** protege credenciales at-rest y en tránsito (encryption con KMS, external-secrets, sealed-secrets); y el **plano de supply chain** verifica qué imágenes entran (image scanning con Trivy, sigstore/cosign signatures, SBOM). Un incidente típico —"un container escapó a root en el nodo"— casi siempre atraviesa varios planos: una imagen sin escanear que corría con `privileged: true` porque no había PSA que lo bloqueara, con un ServiceAccount con acceso `secrets` cluster-wide porque `cluster-admin` fue el path of least resistance en un manifest legacy. En 2026, tratar seguridad como checklist independientes es la garantía de tener huecos.

El **RBAC** de Kubernetes es simple en concepto pero peligroso en detalle. Hay dos ejes ortogonales: **scope** (`Role` es namespace-local; `ClusterRole` es cluster-wide) y **binding** (`RoleBinding` y `ClusterRoleBinding` conectan un Role/ClusterRole con subjects: usuarios, grupos o ServiceAccounts). El anti-patrón crónico es asignar `cluster-admin` a todo por "practicidad": cada Pod que corre con esos permisos es un potential blast radius de todo el cluster. Desde K8s 1.24, los tokens de ServiceAccount son **bound tokens** —JWTs firmados con audience, expiration y issuer— que reemplazaron los legacy long-lived tokens en Secrets. En cloud, el patrón moderno es **IRSA** (IAM Roles for Service Accounts en EKS), **Workload Identity** (GKE, AKS): el SA se traduce a IAM del cloud vía OIDC, evitando credentials estáticas.

Los **Pod Security Standards** (PSS, GA en 1.25) reemplazaron a **PodSecurityPolicy** (removido 1.25) con tres profiles: `privileged` (permisivo, cualquier cosa), `baseline` (bloquea escalation obvia — `hostPID`, `hostNetwork`, capabilities peligrosas), `restricted` (endurecido — `runAsNonRoot`, `seccompProfile: RuntimeDefault`, drop de todas las capabilities). Se aplican por **namespace label**: `pod-security.kubernetes.io/enforce=restricted`. PSA no cubre todo: para casos como "todas las imágenes deben venir de nuestro registry" o "cada Pod debe tener label `team`", necesitás **OPA Gatekeeper** (Rego DSL, más rico y maduro) o **Kyverno** (YAML-native, generación de recursos, mutación, más fácil de leer). En 2026, Kyverno 1.13 evalúa policies simples en 1-3 ms; Gatekeeper 3.18 en 0.5-2 ms con Rego compilado; ambos maduros y confiables. La elección depende más del equipo (¿toleran Rego?) que de la capacidad.

Los **secrets** de K8s son base64-encoded, **no cifrados por default**. Sin `EncryptionConfiguration` en el API server que enganche a un KMS (AWS KMS, GCP KMS, Azure Key Vault, HashiCorp Vault), un compromise de etcd expone todos los secrets en claro. En 2026, el patrón productivo es **External Secrets Operator** (ESO) para sincronizar secrets desde Vault/AWS Secrets Manager/GCP Secret Manager, o **Sealed Secrets** de Bitnami para GitOps encriptando en el cliente. **Trivy Operator** de Aqua (open source) escanea imágenes y configs continuamente, generando CRDs `VulnerabilityReport`, `ConfigAuditReport`, `ExposedSecretReport`. Complementá con **cosign** (sigstore) para firmar imágenes y **admission** con Kyverno `verifyImages` para rechazar imágenes no firmadas.

El impacto de estos controles es medible. Post-mortem de incidentes reales (Tesla 2018 cryptojacking, Capital One 2019, Colonial Pipeline 2021) muestran patrones repetitivos: credenciales estáticas expuestas, containers privilegiados sin necesidad, ausencia de segmentación de red, secrets sin cifrar, imágenes sin verificar. Aplicar los seis planos —RBAC least-privilege, PSA restricted por default, NetworkPolicies default-deny, encryption at rest con KMS, image signing y scanning, policy-as-code con Kyverno/Gatekeeper— reduce dramáticamente el blast radius. Este capítulo cubre cada uno con manifests reales aplicables a **LinguaDev Pro**.

---

## 2. RBAC y ServiceAccounts (nivel básico)

### 2.1 Los cuatro objetos RBAC

- **Role**: permisos dentro de un namespace.
- **ClusterRole**: permisos cluster-wide o para recursos non-namespaced (Nodes, PVs, StorageClasses).
- **RoleBinding**: adjunta un Role o ClusterRole a subjects dentro de un namespace.
- **ClusterRoleBinding**: adjunta un ClusterRole a subjects cluster-wide.

Manifest típico:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: linguadev
  name: config-reader
rules:
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [get, list, watch]
  - apiGroups: [""]
    resources: [secrets]
    resourceNames: [api-config]         # scope adicional por nombre
    verbs: [get]
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: linguadev-api
  namespace: linguadev
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: linguadev-api-config-reader
  namespace: linguadev
subjects:
  - kind: ServiceAccount
    name: linguadev-api
    namespace: linguadev
roleRef:
  kind: Role
  name: config-reader
  apiGroup: rbac.authorization.k8s.io
```

**Verbs principales:** `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection`. El comodín `*` existe pero es anti-patrón fuera de dev.

### 2.2 ServiceAccounts y bound tokens

Cada namespace tiene un SA `default`. Si un Pod no especifica `serviceAccountName`, hereda `default` con sus permisos. Anti-patrón clásico: bindear `cluster-admin` al `default` "para probar" y olvidarlo.

Desde K8s 1.24+:
- Los tokens de SA son **bound tokens** con `aud`, `exp`, `iss` firmados.
- El kubelet monta un token vía `Projected Volume` (renovable, expira en ~1h por default).
- No se crean Secrets automáticos con tokens legacy.

Verificar identidad de un Pod:

```bash
kubectl exec -n linguadev linguadev-api-abc -- \
  cat /var/run/secrets/kubernetes.io/serviceaccount/token | \
  cut -d. -f2 | base64 -d | jq
# {
#   "aud": ["https://kubernetes.default.svc"],
#   "exp": 1755123456,
#   "iss": "https://oidc.eks.us-east-1.amazonaws.com/...",
#   "kubernetes.io": { "namespace": "linguadev", "serviceaccount": {"name": "linguadev-api"} },
#   "sub": "system:serviceaccount:linguadev:linguadev-api"
# }
```

Comandos para auditar permisos:

```bash
# ¿Puede este SA hacer X?
kubectl auth can-i list pods \
  --namespace linguadev \
  --as=system:serviceaccount:linguadev:linguadev-api

# Matrix completa
kubectl krew install access-matrix
kubectl access-matrix --namespace linguadev --sa linguadev-api

# ¿Quién puede X?
kubectl who-can delete secrets --namespace prod
```

### 2.3 Least privilege patterns

**Regla de oro:** empezá con `Role` (namespace-scoped), añade solo verbs necesarios, sin `*`. Elevá a `ClusterRole` solo si es indispensable.

**Anti-patrones comunes:**

- ❌ `verbs: ["*"]` en producción.
- ❌ `resources: ["*"]` cross-namespace.
- ❌ Bind `cluster-admin` al `default` SA.
- ❌ ServiceAccounts compartidos entre workloads distintos.
- ❌ Tokens long-lived en Secrets (legacy pre-1.24).

**Patrón correcto:**

```yaml
# ClusterRole reusable (no se cambia con cada namespace)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pod-log-viewer
rules:
  - apiGroups: [""]
    resources: [pods, pods/log]
    verbs: [get, list, watch]
---
# RoleBinding namespace-específico usando el ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: sre-log-viewer
  namespace: linguadev
subjects:
  - kind: Group
    name: oidc:sre-team          # grupos de OIDC provider
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: pod-log-viewer
  apiGroup: rbac.authorization.k8s.io
```

### 2.4 IRSA / Workload Identity (cloud)

En EKS, el patrón standard es **IRSA** (IAM Roles for Service Accounts): el SA se anota con un ARN de IAM role; los Pods obtienen credenciales AWS temporales vía OIDC sin secrets estáticos.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: linguadev-api
  namespace: linguadev
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/linguadev-api-s3-writer
```

El Pod recibe env vars `AWS_ROLE_ARN` y `AWS_WEB_IDENTITY_TOKEN_FILE`, y el SDK AWS los usa automáticamente para `sts:AssumeRoleWithWebIdentity`.

GKE tiene **Workload Identity** (`iam.gke.io/gcp-service-account` annotation). AKS tiene **Azure Workload Identity** (2023 GA).

---

## 3. Pod Security Standards y admission (nivel medio)

### 3.1 Los 3 profiles

| Profile | Uso | Restringe |
|---|---|---|
| `privileged` | Sistemas de infra (CNI, storage drivers) | Nada |
| `baseline` | Apps normales de negocio | `hostNetwork`, `hostPID`, `hostIPC`, `hostPath`, capabilities peligrosas, `privileged`, host ports |
| `restricted` | Aplicaciones endurecidas | Todo lo de `baseline` + `runAsNonRoot`, `seccompProfile: RuntimeDefault`, drop de todas las capabilities, sin volume types inseguros |

Aplicar profile en un namespace con labels:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: linguadev
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.32
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

Tres modos:
- `enforce`: bloquea el Pod si no cumple.
- `audit`: lo permite pero registra evento.
- `warn`: lo permite y avisa al user en el CLI.

### 3.2 Security context: manifest compliant restricted

Ejemplo Pod que pasa `restricted`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: linguadev-api
  namespace: linguadev
spec:
  serviceAccountName: linguadev-api
  automountServiceAccountToken: true
  securityContext:
    runAsUser: 65532
    runAsGroup: 65532
    runAsNonRoot: true
    fsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: api
      image: ghcr.io/linguadev/api:2.1.0
      imagePullPolicy: IfNotPresent
      ports:
        - containerPort: 8080
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 65532
        capabilities:
          drop: [ALL]
        seccompProfile:
          type: RuntimeDefault
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 512Mi
      volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: cache
          mountPath: /var/cache
  volumes:
    - name: tmp
      emptyDir: {}
    - name: cache
      emptyDir: {}
```

Piezas clave:
- `runAsNonRoot: true` + `runAsUser` explícito no-root.
- `readOnlyRootFilesystem: true` con `emptyDir` para paths que la app necesita escribir.
- `allowPrivilegeEscalation: false` (bloquea `setuid`).
- `capabilities.drop: [ALL]` — la app no necesita capabilities Linux.
- `seccompProfile: RuntimeDefault` — filtra syscalls peligrosos.

### 3.3 Admission controllers: validating y mutating

Cada request a la API pasa por: **authentication** → **authorization (RBAC)** → **admission**. La admission tiene dos fases:

1. **Mutating admission**: puede modificar el objeto (inyectar sidecars, defaults). Ej: Istio inyecta el sidecar Envoy.
2. **Validating admission**: puede aprobar/rechazar. Ej: PSA rechaza Pods `privileged`.

Los webhooks externos se registran con `ValidatingAdmissionWebhookConfiguration` y `MutatingAdmissionWebhookConfiguration`:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: kyverno-policy-validating-webhook-cfg
webhooks:
  - name: validate.kyverno.svc-fail
    admissionReviewVersions: ["v1"]
    sideEffects: None
    timeoutSeconds: 10
    failurePolicy: Fail            # Fail = si el webhook down, rechaza (fail-closed)
    clientConfig:
      service:
        name: kyverno-svc
        namespace: kyverno
        path: /validate
      caBundle: <base64-CA>
    rules:
      - apiGroups: [""]
        apiVersions: [v1]
        operations: [CREATE, UPDATE]
        resources: [pods]
```

`failurePolicy: Fail` (recomendado en policies críticas) vs `Ignore` (permite todo si webhook cae, riesgo de bypass).

### 3.4 Kyverno 1.13: YAML-native policy engine

Kyverno usa YAML puro (no DSL). Policy que exige `runAsNonRoot`:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-run-as-non-root
spec:
  validationFailureAction: Enforce      # o Audit
  background: true
  rules:
    - name: check-runAsNonRoot
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [linguadev, linguadev-prod]
      validate:
        message: "runAsNonRoot must be true"
        pattern:
          spec:
            =(securityContext):
              runAsNonRoot: true
            containers:
              - name: "*"
                =(securityContext):
                  runAsNonRoot: true
```

Policy que rechaza imágenes no venidas del registry propio:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: only-approved-registries
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-registry
      match:
        any:
          - resources:
              kinds: [Pod]
      validate:
        message: "Only images from ghcr.io/linguadev/* are allowed"
        pattern:
          spec:
            containers:
              - image: "ghcr.io/linguadev/*"
```

Policy que **muta** (añade label `owner` faltante):

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-owner-label
spec:
  rules:
    - name: add-owner
      match:
        any:
          - resources:
              kinds: [Deployment, StatefulSet, DaemonSet]
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              +(owner): "platform-team"
```

Policy que **genera** un NetworkPolicy por cada Namespace nuevo:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: default-deny-per-namespace
spec:
  rules:
    - name: generate-default-deny
      match:
        any:
          - resources:
              kinds: [Namespace]
      generate:
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny
        namespace: "{{ request.object.metadata.name }}"
        data:
          spec:
            podSelector: {}
            policyTypes: [Ingress, Egress]
```

**Kyverno verificando firma de imagen** (cosign):

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-signatures
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-cosign
      match:
        any:
          - resources:
              kinds: [Pod]
      verifyImages:
        - imageReferences:
            - "ghcr.io/linguadev/*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/linguadev/*"
                    issuer: "https://token.actions.githubusercontent.com"
```

### 3.5 OPA Gatekeeper 3.18: Rego para el reino

Gatekeeper usa **Rego** (lenguaje de OPA). Más powerful, mayor curva. Un constraint tiene dos partes: `ConstraintTemplate` (definición) y `Constraint` (instancia).

**ConstraintTemplate:**

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              items: { type: string }
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels
        violation[{"msg": msg}] {
          required := input.parameters.labels
          provided := input.review.object.metadata.labels
          missing := required[_]
          not provided[missing]
          msg := sprintf("missing required label: %v", [missing])
        }
```

**Constraint** (aplicación):

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: ns-must-have-team
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: [Namespace]
  parameters:
    labels: ["team", "cost-center", "environment"]
```

### 3.6 Kyverno vs Gatekeeper en 2026

| Aspecto | Kyverno 1.13 | Gatekeeper 3.18 |
|---|---|---|
| Sintaxis | YAML nativo | Rego (DSL) |
| Learning curve | Baja | Alta |
| Performance validación simple | 1-3 ms | 0.5-2 ms |
| Mutating admission | ✅ nativo | ❌ (requiere gatekeeper-mutation experimental) |
| Generation (crear otros recursos) | ✅ | ❌ |
| Image signature verification | ✅ nativo con `verifyImages` | Requiere OPA integration |
| Ecosistema testing | Kyverno-cli | conftest / rego |
| CNCF | Incubating | Graduated (OPA) |

**Regla práctica 2026:** para equipos sin experiencia previa en Rego, **Kyverno** es la elección default (YAML familiar, cubre 95% de casos). Para equipos con OPA ya en uso (Istio AuthorizationPolicy, application policies en Rego), **Gatekeeper** compone mejor.

---

## 4. Secrets, encryption, image supply chain (nivel avanzado)

### 4.1 Secrets: el problema

Un `Secret` de K8s es base64-encoded, **no cifrado**. En etcd se guarda en claro por default. Comprometé etcd → tenés todos los secrets. Fixes:

1. **Encryption at rest**: cifrar en API server antes de escribir a etcd.
2. **External Secrets**: no guardar en K8s, sincronizar desde Vault/AWS/GCP/Azure.
3. **Sealed Secrets**: cifrar cliente-side con clave pública del cluster (GitOps-friendly).

### 4.2 EncryptionConfiguration con KMS

`/etc/kubernetes/encryption-config.yaml` (montado en API server):

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources: [secrets, configmaps]
    providers:
      - kms:
          apiVersion: v2
          name: aws-kms
          endpoint: unix:///var/run/kms-plugin/socket.sock
          cachesize: 1000
          timeout: 3s
      - identity: {}      # fallback, sin cifrar
```

Con `aws-encryption-provider` (sidecar en control plane) + KMS CMK. En EKS con **Envelope Encryption** activado en la creación del cluster, esto es transparente:

```bash
aws eks create-cluster \
  --name linguadev-prod \
  --encryption-config resources=secrets,provider={keyArn=arn:aws:kms:us-east-1:...}
```

Rotar clave: rewrapear con `kubectl get secrets -A -o json | kubectl replace -f -` (fuerza re-write) tras cambiar la config.

### 4.3 External Secrets Operator

Sincroniza secrets desde Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, 1Password.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secrets
  namespace: linguadev
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: eso-sa           # con IRSA
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: linguadev
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets
    kind: SecretStore
  target:
    name: db-credentials             # Secret K8s que crea
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: prod/linguadev/db
        property: password
    - secretKey: url
      remoteRef:
        key: prod/linguadev/db
        property: connection_url
```

Ventaja: la fuente de verdad vive en Vault/SM con auditoría, rotación y versionado; K8s solo tiene una copia efímera sincronizada.

### 4.4 Sealed Secrets (Bitnami)

Para GitOps donde el manifest **es** el source of truth, plaintext no es opción. `kubeseal` cifra con clave pública del controller:

```bash
# Crear Secret plaintext
kubectl create secret generic api-key \
  --from-literal=OPENAI_KEY=sk-... \
  --dry-run=client -o yaml > secret.yaml

# Sellarlo
kubeseal --format yaml < secret.yaml > sealed-secret.yaml

# Commit sealed-secret.yaml al repo (safe)
git add sealed-secret.yaml
```

El `SealedSecret` en el cluster se desencripta a `Secret` real por el controller.

### 4.5 Image supply chain

Piezas:

1. **SBOM** (Software Bill of Materials): generar con `syft` o buildkit.
2. **Vulnerability scan**: Trivy, Grype, Snyk.
3. **Signature**: cosign (sigstore) firma la imagen.
4. **Attestation**: SLSA provenance attesta cómo se buildeó.
5. **Admission**: Kyverno o Sigstore Policy Controller verifica signatures en el cluster.

**Trivy Operator** (deploy visto en §0) genera reports:

```bash
kubectl get vulnerabilityreports -A
# NAMESPACE   NAME                                CRITICAL  HIGH  MEDIUM  ...
# linguadev   pod-linguadev-api-abc-api           0         2     15
# linguadev   pod-linguadev-web-def-web           1         5     22

kubectl get vulnerabilityreport pod-linguadev-api-abc-api -n linguadev -o yaml | \
  yq '.report.vulnerabilities[] | select(.severity == "CRITICAL")'
```

Reports adicionales:
- `configauditreports` — configs inseguras (containers root, sin resources limits, etc.).
- `exposedsecretreports` — secrets hardcoded en imágenes.
- `sbomreports` — SBOM completo.

**Firma con cosign:**

```bash
# Sign (keyless usando GitHub OIDC en GHA)
cosign sign ghcr.io/linguadev/api:2.1.0 --yes

# Verify
cosign verify ghcr.io/linguadev/api:2.1.0 \
  --certificate-identity-regexp="https://github.com/linguadev/.*" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com"
```

**Attestation SBOM:**

```bash
syft ghcr.io/linguadev/api:2.1.0 -o cyclonedx-json > sbom.json
cosign attest --predicate sbom.json --type cyclonedx ghcr.io/linguadev/api:2.1.0
```

### 4.6 Seccomp y AppArmor profiles

**Seccomp** filtra syscalls. Default de K8s desde 1.27 es `Unconfined` (permite todo). Cambiar a `RuntimeDefault` (perfil sensato del container runtime) o custom profile:

```yaml
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  # o custom:
  #   type: Localhost
  #   localhostProfile: profiles/my-app.json
```

Perfiles custom en `/var/lib/kubelet/seccomp/profiles/my-app.json`.

**AppArmor** (Linux MAC): activar por annotation (K8s 1.30+ como native field):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-pod
spec:
  containers:
    - name: app
      image: ghcr.io/linguadev/api:2.1.0
      securityContext:
        appArmorProfile:
          type: Localhost
          localhostProfile: k8s-apparmor-linguadev
```

Perfil en cada nodo: `/etc/apparmor.d/k8s-apparmor-linguadev`.

---

## 5. Ejemplo práctico completo: hardening de LinguaDev Pro

Aplicación al proyecto real: namespace productivo con RBAC least-privilege, PSA restricted, Kyverno policies, encryption at rest y NetworkPolicies default-deny.

### Paso 1: Namespace con PSA restricted

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: linguadev-prod
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.32
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
    team: platform
    cost-center: engineering
    environment: production
```

### Paso 2: SA + Role específicos

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: linguadev-api
  namespace: linguadev-prod
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/linguadev-api-prod
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: linguadev-prod
  name: linguadev-api
rules:
  - apiGroups: [""]
    resources: [configmaps]
    resourceNames: [app-config, feature-flags]
    verbs: [get, watch, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: linguadev-api
  namespace: linguadev-prod
subjects:
  - kind: ServiceAccount
    name: linguadev-api
    namespace: linguadev-prod
roleRef:
  kind: Role
  name: linguadev-api
  apiGroup: rbac.authorization.k8s.io
```

### Paso 3: Deployment hardened

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: linguadev-api
  namespace: linguadev-prod
  labels: { owner: platform-team }
spec:
  replicas: 3
  selector:
    matchLabels: { app: linguadev-api }
  template:
    metadata:
      labels: { app: linguadev-api }
    spec:
      serviceAccountName: linguadev-api
      automountServiceAccountToken: true
      securityContext:
        runAsUser: 65532
        runAsNonRoot: true
        fsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: api
          image: ghcr.io/linguadev/api@sha256:abc123...    # digest, no tag
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 8080 }]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            capabilities: { drop: [ALL] }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          envFrom:
            - secretRef: { name: db-credentials }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: {}
      imagePullSecrets:
        - name: ghcr-pull
```

### Paso 4: Kyverno policies base

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: baseline-security
spec:
  validationFailureAction: Enforce
  rules:
    - name: require-image-digest
      match:
        any: [{ resources: { kinds: [Pod] } }]
      validate:
        message: "Images must be pinned by digest (@sha256:...) not tag"
        pattern:
          spec:
            containers:
              - image: "*@sha256:*"
    - name: verify-cosign
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [linguadev-prod]
      verifyImages:
        - imageReferences: ["ghcr.io/linguadev/*"]
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/linguadev/*"
                    issuer: "https://token.actions.githubusercontent.com"
    - name: no-privileged
      match:
        any: [{ resources: { kinds: [Pod] } }]
      validate:
        message: "Privileged containers not allowed"
        deny:
          conditions:
            all:
              - key: "{{ request.object.spec.containers[*].securityContext.privileged }}"
                operator: AnyIn
                value: [true]
```

### Paso 5: External Secrets desde AWS Secrets Manager

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: prod-aws
  namespace: linguadev-prod
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef: { name: eso-sa }
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: linguadev-prod
spec:
  refreshInterval: 30m
  secretStoreRef: { name: prod-aws, kind: SecretStore }
  target:
    name: db-credentials
    template:
      engineVersion: v2
      data:
        DATABASE_URL: "postgres://{{ .username }}:{{ .password }}@{{ .host }}:5432/linguadev"
  data:
    - { secretKey: username, remoteRef: { key: prod/linguadev/db, property: username } }
    - { secretKey: password, remoteRef: { key: prod/linguadev/db, property: password } }
    - { secretKey: host,     remoteRef: { key: prod/linguadev/db, property: host } }
```

### Paso 6: Trivy Operator y auditar

```bash
# Ver vulnerabilidades altas/críticas del namespace
kubectl get vulnerabilityreports -n linguadev-prod \
  -o json | jq '.items[] | {name:.metadata.name, critical:.report.summary.criticalCount}'

# Ver config issues (no runAsNonRoot, etc.)
kubectl get configauditreports -n linguadev-prod

# Ver secrets expuestos en imágenes
kubectl get exposedsecretreports -n linguadev-prod
```

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **RBAC least-privilege**: comienza con `Role` namespace, verbs específicos, `resourceNames` cuando aplicable.
- ✅ **SA per workload**: nunca compartas SAs entre apps distintas.
- ✅ **Bound tokens** (K8s 1.24+): nunca uses legacy long-lived tokens.
- ✅ **IRSA/Workload Identity** en cloud: no metas AWS keys en Secrets.
- ✅ **PSA restricted** en todos los namespaces de aplicaciones.
- ✅ **`runAsNonRoot: true`**, `readOnlyRootFilesystem`, `drop: [ALL]`, `seccomp: RuntimeDefault`.
- ✅ **NetworkPolicies default-deny** por namespace + allows explícitos (ver [cap 09](./09-kubernetes-networking-y-storage.md)).
- ✅ **Encryption at rest** con KMS para etcd.
- ✅ **External Secrets** o **Sealed Secrets**, nunca plaintext en Git.
- ✅ **Image digests** (`@sha256:`), no tags.
- ✅ **Cosign** para signatures + Kyverno `verifyImages`.
- ✅ **Trivy Operator** con alerting en critical/high.
- ✅ **`failurePolicy: Fail`** en admission webhooks críticos.
- ✅ **Audit logs** habilitados y forwarded a SIEM.

### Anti-patrones

- ❌ `cluster-admin` a `default` SA.
- ❌ `verbs: ["*"]` en policies productivas.
- ❌ Containers corriendo como `root` (UID 0) sin razón.
- ❌ `privileged: true` fuera de infra especial.
- ❌ `hostNetwork: true` en apps.
- ❌ Mountear el socket Docker (`/var/run/docker.sock`) en Pods.
- ❌ Plaintext secrets en `values.yaml` commiteados a Git.
- ❌ Imagen `:latest` en producción.
- ❌ Admission webhook con `failurePolicy: Ignore` en policy de seguridad.
- ❌ `automountServiceAccountToken: true` cuando el Pod no habla con la API.
- ❌ Ignorar reports de Trivy porque "son muchos".
- ❌ Bind directo a users individuales (usar Groups OIDC).

### Tabla de referencia PSS

| Restricción | baseline | restricted |
|---|---|---|
| `privileged: true` | ❌ | ❌ |
| `hostNetwork/hostPID/hostIPC` | ❌ | ❌ |
| `hostPath` volumes | ❌ | ❌ |
| Cap `SYS_ADMIN`, `NET_ADMIN`, etc. | ❌ | ❌ |
| `runAsNonRoot: true` requerido | ✅ opcional | ❌ obligatorio |
| `seccompProfile: RuntimeDefault` | ✅ opcional | ❌ obligatorio |
| `drop: [ALL]` capabilities | ✅ opcional | ❌ obligatorio |
| `allowPrivilegeEscalation: false` | ✅ opcional | ❌ obligatorio |

---

## 7. Casos reales industria 2023-2026

**Tesla cryptojacking (2018, aún ref):** cluster Kubernetes expuesto sin auth, atacantes instalaron mineros. **Lección:** RBAC y auth desde el día 1; nunca dejes API server público sin OIDC/mTLS.

**Capital One (2019):** IAM role mal configurado + SSRF → leak de 100M records. Aunque no era K8s puro, subrayó la importancia de least-privilege en IAM roles asociados a workloads. **Lección:** IRSA/Workload Identity con roles mínimos, revisados regularmente.

**Kubernetes RBAC misuse study (2022, Aqua Security):** analizando clusters públicos, ~50% tenían RBAC excesivo, muchos con `cluster-admin` binding evitable. **Lección:** auditá con `rakkess` / `access-matrix` mensualmente.

**Kubescape / kube-bench findings (2023-2024):** herramientas CIS Benchmark reportaron que ~70% de clusters productivos fallan al menos 20 controles. Top: no encryption at rest, no NetworkPolicies, containers root. **Lección:** correr benchmarks en CI, no dejar drift.

**Log4Shell (dic 2021):** vulnerabilidad crítica en Log4j afectó miles de imágenes. **Lección:** SBOMs + escaneo continuo con Trivy detecta la próxima Log4Shell en horas, no días.

**Sigstore adoption (2023-2026):** Google, Chainguard, Red Hat empujando sigstore/cosign como standard. GitHub Container Registry integró cosign nativo 2023. **Lección:** firmá tus imágenes; verificá con admission.

**Chainguard Images (2023+):** distros minimalistas basadas en Wolfi con 0 CVEs y actualizaciones diarias. Adopción growing en Fortune 500. **Lección:** el base image importa; distroless o Wolfi reducen surface dramáticamente.

**PodSecurityPolicy removed (K8s 1.25, dic 2022):** PSP fue removido; muchos clusters migraron a PSA o adoptaron Kyverno/Gatekeeper. **Lección:** las APIs evolucionan; policy-as-code externo es más flexible que builtins.

**Kubernetes CVE-2024-1097 (Ingress-Nginx path traversal, 2024):** vuln crítica en el controller Ingress-Nginx que permitía leak de secrets. Parchada rápidamente pero clusters no actualizados quedaron expuestos. **Lección:** patch management de add-ons es tan crítico como del control plane.

**Kyverno vs Gatekeeper adoption 2026:** ambos productivos y confiables; Kyverno ganó share por YAML-native (más accesible), Gatekeeper mantiene enterprises con OPA-existing. **Lección:** elegí el que tu equipo pueda mantener.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Crear un SA con Role mínimo y validar permisos

**Objetivo:** un Pod que solo puede `get` un ConfigMap específico; nada más.

**Setup:**
- Cluster K8s cualquiera + kubectl.

**Pasos:**
1. Crea Namespace `rbac-lab`.
2. Crea ConfigMap `app-config` con un valor de prueba.
3. Crea SA `restricted-app`.
4. Crea Role que permita `get` solo sobre `configmaps` con `resourceNames: [app-config]`.
5. Bind con RoleBinding.
6. Crea Pod con `serviceAccountName: restricted-app` y `curl` a `https://kubernetes.default/api/v1/namespaces/rbac-lab/configmaps/app-config` con el token del SA.
7. Verifica que **puede** leer `app-config` pero **no** listar todos ni acceder Secrets.
8. Corré `kubectl auth can-i --as=system:serviceaccount:rbac-lab:restricted-app list configmaps -n rbac-lab` → debe dar `no`.

**Criterios de éxito:**
- [ ] Pod obtiene `app-config` (200).
- [ ] Pod obtiene 403 al leer otros configmaps.
- [ ] `kubectl auth can-i` refleja los permisos exactos.
- [ ] `kubectl access-matrix --sa restricted-app` muestra solo la línea permitida.

**Bonus:** habilitá audit logging y verifica que se registra el 403.

---

### Ejercicio 2: PSA restricted end-to-end

**Objetivo:** un namespace con `enforce=restricted` que rechaza un Pod inseguro y acepta uno compliant.

**Setup:**
- K8s 1.32+.

**Pasos:**
1. Crea Namespace con label `pod-security.kubernetes.io/enforce: restricted`.
2. Intentá crear un Pod con `runAsUser: 0` y `privileged: true` → debe fallar.
3. Ajusta a `runAsNonRoot: true`, `runAsUser: 65532`, `readOnlyRootFilesystem: true`, `drop: [ALL]`, `seccomp: RuntimeDefault` → debe aceptar.
4. Corré `kubectl get events -n <ns>` y revisa el mensaje de rechazo.
5. Cambia el label a `audit` en lugar de `enforce`, repite → ahora acepta pero registra.

**Criterios de éxito:**
- [ ] Pod inseguro rechazado con mensaje PSA explícito.
- [ ] Pod compliant aceptado.
- [ ] Con `audit`, ambos son aceptados pero el inseguro genera evento.
- [ ] `kubectl label ns --overwrite` cambia comportamiento sin restart.

**Bonus:** añade `enforce-version: v1.32` para pin y ver el manifest audit report.

---

### Ejercicio 3: Kyverno policy que fuerza image digest y verifica cosign

**Objetivo:** dos policies Kyverno productivas: exigir digest y verificar signature.

**Setup:**
- Cluster con Kyverno 1.13 instalado.
- Imagen propia firmada con cosign keyless (GHA + sigstore).

**Pasos:**
1. Aplica `ClusterPolicy` `require-image-digest` con pattern `"*@sha256:*"`.
2. Intentá crear un Pod con `image: nginx:latest` → debe fallar.
3. Cambia a `image: nginx@sha256:...` → acepta.
4. Aplica `ClusterPolicy` `verify-cosign` con `verifyImages` apuntando a tu imagen.
5. Deploya Pod → Kyverno verifica en fetch; si signature ok, admite; si no, rechaza.

**Criterios de éxito:**
- [ ] Tag-based image rechazado.
- [ ] Digest-based image aceptado.
- [ ] Imagen sin firma cosign rechazada por `verifyImages`.
- [ ] Imagen firmada aceptada.

**Bonus:** añade Kyverno `mutate` que inyecte label `security-scanned: true` post-verificación.

---

### Ejercicio 4: External Secrets desde AWS Secrets Manager con IRSA

**Objetivo:** un `ExternalSecret` que sincroniza desde AWS SM sin credenciales estáticas.

**Setup:**
- EKS cluster + AWS Secrets Manager con un secret `test/linguadev` (`{"key":"value"}`).
- OIDC provider configurado en EKS.
- IAM role `eso-role` con policy `secretsmanager:GetSecretValue` sobre `test/linguadev`.

**Pasos:**
1. Instala External Secrets Operator con Helm.
2. Crea SA `eso-sa` con annotation `eks.amazonaws.com/role-arn` apuntando a `eso-role`.
3. Crea `SecretStore` provider AWS + region.
4. Crea `ExternalSecret` que sincronize `test/linguadev` a Secret K8s `test-secret`.
5. `kubectl get secret test-secret -o jsonpath='{.data.key}' | base64 -d` → debe devolver `value`.

**Criterios de éxito:**
- [ ] ESO Pods corriendo.
- [ ] `ExternalSecret.status.conditions[0].type = Ready`.
- [ ] Secret K8s creado con el valor correcto.
- [ ] Cambio del secret en AWS SM se refleja en <refreshInterval.

**Bonus:** setup `refreshInterval: 30s` y confirma que cambio en AWS se propaga en <60s.

---

### Ejercicio 5 (bonus): Trivy Operator + alerts

**Objetivo:** desplegar Trivy Operator y crear alerta cuando hay CVE crítico.

**Setup:**
- Cluster con Prometheus + Alertmanager.
- Trivy Operator instalado.

**Pasos:**
1. Verifica que `kubectl get vulnerabilityreports -A` retorna reports.
2. Habilita `trivy-operator.exportSummary` (Prometheus metrics).
3. Crea `PrometheusRule` con alerta `TrivyCriticalCVEs` si `sum(trivy_image_vulnerabilities{severity="Critical"}) > 0`.
4. Simula: deploy imagen conocida con CVEs (ej `nginx:1.19`).
5. Espera scan → verifica alerta en Alertmanager.

**Criterios de éxito:**
- [ ] Vulnerability reports generados automáticamente para cada Pod.
- [ ] Metrics de Trivy expuestos en `/metrics`.
- [ ] Alerta dispara cuando hay CVE critical.
- [ ] Dashboard Grafana muestra tendencia de vulnerabilities.

**Bonus:** integra con Jira o Slack via Alertmanager para crear tickets automáticos por CVE crítico >7 días.

---

## 9. Recursos + siguientes pasos

**Docs oficiales:**
- [kubernetes.io — Security](https://kubernetes.io/docs/concepts/security/) — hub general.
- [kubernetes.io — Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/).
- [kubernetes.io — RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/).
- [kyverno.io](https://kyverno.io) — Kyverno 1.13 docs.
- [open-policy-agent.github.io/gatekeeper](https://open-policy-agent.github.io/gatekeeper/) — Gatekeeper 3.18.

**Herramientas:**
- **Trivy Operator** (Aqua) — vuln + config + secrets scanning.
- **Falco** (CNCF Graduated) — runtime security detection.
- **kube-bench** — CIS Benchmarks.
- **kubescape** (ARMO) — security posture, misconfig, RBAC.
- **external-secrets.io** — External Secrets Operator.
- **bitnami/sealed-secrets** — GitOps-friendly secrets.
- **sigstore.dev** — cosign, fulcio, rekor.
- **cert-manager** — certificados automáticos con Let's Encrypt.

**Cursos y libros:**
- Liz Rice, "*Container Security*" (O'Reilly, 2ª ed 2024).
- Michael Hausenblas, "*Kubernetes Security and Observability*" (O'Reilly).
- CNCF **Kubernetes Security Best Practices** whitepaper 2024.
- **CKS** (Certified Kubernetes Security Specialist) exam prep.

**Referencias adicionales:**
- MITRE **ATT&CK for Containers matrix**.
- NIST SP 800-190 — Application Container Security Guide.
- CIS Kubernetes Benchmark v1.10+.

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Corré `kube-bench` y remediar findings HIGH.
- Adopta PSA restricted en todos los namespaces de apps.
- Instalá Kyverno o Gatekeeper con al menos 3 policies base.
- Setup Trivy Operator + alerting.
- Continuá con [cap 12 — Fundamentos Terraform](./12-fundamentos-terraform.md) para provisionar la infra que soporta todo esto.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre RBAC, admission, workload hardening y supply chain, dificultades junior → staff. Cubren: Role vs ClusterRole, ServiceAccount tokens bound, IRSA/Workload Identity, Pod Security Standards y sus 3 profiles, security contexts (runAsNonRoot, seccomp, capabilities), admission validating vs mutating, Kyverno YAML policies (validate/mutate/generate/verifyImages), OPA Gatekeeper con Rego, encryption at rest con KMS, External Secrets, Sealed Secrets, cosign signatures, Trivy Operator, NetworkPolicies default-deny, y trampas comunes de RBAC excesivo.

- **Fuente:** [`packages/content/src/tech/devops/sim-11-kubernetes-security.json`](../../packages/content/src/tech/devops/sim-11-kubernetes-security.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-11-kubernetes-security`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 10 — Helm y Kustomize](./10-helm-y-kustomize.md) · [Índice](./README.md) · [Capítulo 12 — Fundamentos Terraform →](./12-fundamentos-terraform.md)
