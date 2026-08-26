# Capítulo 25 — Policy as Code con OPA y Kyverno

> **Focus:** Convertir políticas de seguridad, compliance y gobernanza en código ejecutable y versionado. OPA (Open Policy Agent) como decision engine agnóstico con Rego; Gatekeeper como puente a Kubernetes admission; Kyverno como alternativa YAML-native; ValidatingAdmissionPolicy con CEL como camino built-in en Kubernetes 1.30+; Conftest para CI; Sentinel para Terraform; y patrones de distribución, testing y observabilidad de políticas a escala.
> **Áreas:** Security · Kubernetes · Governance
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior → Staff

## 0. Antes de empezar

**Pre-requisitos:**
- Kubernetes fundamentals: Pod, Deployment, Namespace, CRD, admission controllers (ver [cap 07 — kubernetes fundamentals](./07-fundamentos-kubernetes.md)).
- Kubernetes security básica: RBAC, ServiceAccounts, Pod Security Standards (ver [cap 11 — kubernetes security](./11-kubernetes-security.md)).
- Container security y supply chain: firmas Cosign, SBOM, provenance SLSA (ver [cap 24 — supply chain security](./24-supply-chain-security.md)).
- Terraform y CI/CD: haber ejecutado `terraform plan` y pipelines GitHub Actions/GitLab CI.
- JSON/YAML fluidez; nociones de Datalog/Prolog ayudan pero no son requisito.

**Glosario mínimo:**
- **PaC** (Policy as Code): disciplina de expresar políticas de seguridad, compliance, cost y governance como código ejecutable, versionado en git, testeable en CI y evaluado por un engine automatizado.
- **OPA** (Open Policy Agent): decision engine open source (CNCF Graduated 2021, OPA 1.0 GA 2024). Recibe input JSON + policies Rego y devuelve una decisión. Agnóstico al dominio.
- **Rego**: lenguaje declarativo de OPA, inspirado en Datalog. En OPA 1.0 los `import future.keywords` legacy dejaron de ser necesarios; `if`, `in`, `contains` son sintaxis por default.
- **Gatekeeper**: proyecto CNCF que integra OPA como ValidatingAdmissionWebhook (y opcionalmente Mutating) de Kubernetes. En 2026 la versión estable es 3.18.x.
- **Kyverno**: policy engine K8s-nativo escrito en Go, políticas en YAML (sin lenguaje custom). CNCF Graduated 2024. Versión estable en 2026: 1.13.x.
- **ConstraintTemplate / Constraint**: en Gatekeeper, un `ConstraintTemplate` define el schema + Rego; un `Constraint` es la instancia parametrizada.
- **ClusterPolicy / Policy**: en Kyverno, `ClusterPolicy` aplica cluster-wide, `Policy` es namespace-scoped.
- **ValidatingAdmissionPolicy (VAP)**: recurso built-in de Kubernetes (GA en 1.30, abril 2024) que usa CEL para validar admission sin webhooks externos.
- **CEL** (Common Expression Language): DSL de Google inspirado en Go, standard en K8s 1.30+ para VAP, JSON Schema y Envoy.
- **Mutation / Validation / Generation**: tres tipos de políticas admission — modificar el recurso, aceptar/rechazar, o crear recursos derivados.
- **Conftest**: CLI del proyecto OPA que evalúa manifests YAML/JSON/HCL contra policies Rego. Ideal para CI.
- **Sentinel**: DSL propietario de HashiCorp integrado en Terraform Cloud/Enterprise para policy gating.

**Setup mínimo:**

```bash
# 1. OPA 1.0+
curl -L -o opa https://openpolicyagent.org/downloads/latest/opa_linux_amd64_static
chmod +x opa && sudo mv opa /usr/local/bin/
opa version
# Version: 1.4.0

# 2. Conftest para CI
brew install conftest    # o wget desde github.com/open-policy-agent/conftest/releases

# 3. Cluster local con kind
kind create cluster --name paclab --image kindest/node:v1.30.5

# 4. Gatekeeper 3.18+
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm install gatekeeper gatekeeper/gatekeeper \
  --version 3.18.2 \
  --namespace gatekeeper-system --create-namespace

# 5. Kyverno 1.13+
helm repo add kyverno https://kyverno.github.io/kyverno/
helm install kyverno kyverno/kyverno \
  --version 3.3.0 \
  --namespace kyverno --create-namespace

# 6. Kyverno CLI
brew install kyverno    # kyverno test / apply

# 7. Kyverno Policies (200+ ready-to-use)
kubectl apply -f https://github.com/kyverno/policies/raw/main/pod-security/subrule/restricted/restricted.yaml
```

---

## 1. El gran cuadro

Antes de Policy as Code, la disciplina de compliance se sostenía sobre wikis en Confluence, checklists en Word y disciplina humana. Un compliance officer escribía "no usar `:latest` en producción", "todo Pod requiere resource limits", "namespaces `prod` requieren label `owner`", y los devs, cansados a las seis de la tarde, olvidaban o ignoraban la lista. La auditoría anual encontraba doscientas violaciones y todos culpaban al "proceso". La lección se aprendió muchas veces: **las reglas que no se ejecutan no existen**. Policy as Code convierte la intención en enforcement automático: la regla vive como código en git, un motor la evalúa contra cada recurso propuesto y decide si se admite o se rechaza. Nada de screenshots manuales, nada de disciplina personal, nada de "se me pasó".

El ecosistema PaC en 2026 gira alrededor de tres motores principales y un puñado de herramientas periféricas. **OPA** (Open Policy Agent) es el más veterano y universal: un decision engine escrito en Go, con lenguaje propio (Rego, inspirado en Datalog) y agnóstico al dominio — la misma instancia sirve Kubernetes admission, authorization de microservicios, validación de Terraform plans, gating de CI/CD y decisiones de feature flags. **Kyverno** es el nativo Kubernetes: políticas en YAML puro (sin lenguaje custom), primitivas `validate`, `mutate`, `generate` y `verifyImages`, y el catálogo `kyverno/policies` con más de doscientos policies production-ready. **ValidatingAdmissionPolicy** (VAP) es el built-in de Kubernetes desde 1.30 (abril 2024): usa CEL como DSL, no requiere webhooks externos, y latencia sub-milisegundo — cambia la ecuación para casos simples.

La decisión "OPA vs Kyverno vs VAP" no es religiosa. La regla práctica en 2026 es: (1) si la política se puede expresar en CEL puro y solo es validación, usá **VAP** built-in — cero componentes extra, latencia insignificante; (2) si necesitás mutation, generation o verify-images en Kubernetes, usá **Kyverno** — el catálogo es enorme y no hay que aprender un lenguaje nuevo; (3) si necesitás políticas **cross-domain** (K8s + Terraform + microservicios + CI/CD) con un solo modelo mental, invertí en **OPA/Rego** y distribuí con bundles. Muchas empresas maduras usan las tres: VAP para casos triviales, Kyverno para K8s admission avanzado, OPA para authorization de aplicaciones y Terraform gating.

El impacto operacional es concreto. Netflix ejecuta OPA como sidecar por microservicio para authorization con latencia p99 sub-milisegundo. Capital One y Goldman Sachs usan Styra DAS (control plane comercial de OPA) para gestionar cientos de bundles a través de miles de servicios. Adobe y VMware apostaron por Kyverno para hardening masivo de clusters. Y desde que **Kyverno alcanzó CNCF Graduated en 2024** y **OPA 1.0** salió el mismo año (con Rego v1 como default: sin `import future.keywords`, sintaxis más limpia), el ecosistema entró en fase de madurez industrial. Este capítulo cubre los motores, el lenguaje Rego, patrones de mutation/validation/generation, distribución vía bundle, testing con `opa test` y `kyverno test`, integración con Terraform (Conftest, Sentinel), authorization de microservicios y anti-patterns comunes — con código real ejecutable sobre el proyecto LinguaDev Pro.

---

## 2. OPA, Rego y arquitectura del decision engine (nivel básico)

### 2.1 Qué es OPA arquitectónicamente

OPA es un **decision engine puro**: recibe un input JSON (el contexto de la decisión — un Pod propuesto, un HTTP request, un Terraform plan) más una policy escrita en Rego, evalúa y responde con una decisión JSON. No sabe nada de Kubernetes, AWS o HTTP; delega el **enforcement** a la aplicación que lo consulta. Esta separación **decisión vs enforcement** es la clave de su universalidad: Gatekeeper enforcea admission en K8s consultando a OPA; Envoy enforcea authorization en HTTP consultando a OPA; Terraform Cloud enforcea policies pre-apply consultando a OPA. El mismo motor, distintos callers.

Se ejecuta en tres topologías: **sidecar** (Pod K8s con contenedor OPA junto al app, latencia sub-ms), **daemon centralizado** (un Deployment de OPA que múltiples apps consultan, más simple pero con network hop y SPOF potencial) y **embebido como library** (importar el paquete Go `github.com/open-policy-agent/opa/rego` o compilar Rego a WASM para embed en Node/Python/Rust). La API REST default corre en `:8181` y expone `/v1/data/<paquete>/<rule>` para queries y `/v1/policies` para gestionar policies. En 2026, **OPA 1.0** (GA fines de 2024) marcó Rego v1 como default: sintaxis moderna sin `import future.keywords` obligatorios, keyword `if` explícito, mejor error messages y mayor throughput.

### 2.2 Rego: fundamentos del lenguaje

Rego es **declarativo basado en Datalog**: describís qué hace verdadera una regla, no cómo calcularla paso a paso. `allow` es true si existe una evaluación donde `input.user.role` sea `"admin"`. No hay if/else imperativo — hay reglas que se cumplen o no. Los conceptos críticos son cuatro: (1) **`input`** es el JSON de la decisión actual; (2) **`data`** son datos externos cargados vía bundle (whitelists, catálogos); (3) **reglas parciales** con el mismo nombre se combinan (múltiples `deny[msg] { ... }` acumulan violations); (4) **`default`** define el valor cuando ninguna regla matchea (sin default, es `undefined`).

Policy Rego v1 que rechaza pods con imagen `:latest`:

```rego
# policies/no_latest.rego
package kubernetes.admission

# Rego v1 (OPA 1.0+): if/in son keywords built-in, no requieren import future.keywords.

default allow := false

allow if {
    count(deny) == 0
}

deny contains msg if {
    input.request.kind.kind == "Pod"
    some container in input.request.object.spec.containers
    endswith(container.image, ":latest")
    msg := sprintf("container %q usa tag :latest (image=%q)", [container.name, container.image])
}

deny contains msg if {
    input.request.kind.kind == "Pod"
    some container in input.request.object.spec.containers
    not contains(container.image, ":")
    msg := sprintf("container %q no especifica tag (image=%q)", [container.name, container.image])
}
```

Puntos clave: `deny contains msg if { ... }` es sintaxis Rego v1 para partial rules (equivalente al legacy `deny[msg] { ... }`); múltiples definiciones acumulan sus msgs en un set; `sprintf` genera mensajes útiles ("container nginx uses :latest tag", no "violation"). El dev que ve el error entiende qué corregir.

### 2.3 Testing de policies con `opa test`

Policies son código, y código sin tests es debt. `opa test` corre archivos `_test.rego` con reglas cuyo nombre empieza por `test_`:

```rego
# policies/no_latest_test.rego
package kubernetes.admission

test_reject_latest_tag if {
    input := {
        "request": {
            "kind": {"kind": "Pod"},
            "object": {
                "spec": {
                    "containers": [
                        {"name": "web", "image": "linguadev/web:latest"}
                    ]
                }
            }
        }
    }
    result := deny with input as input
    count(result) == 1
}

test_accept_pinned_tag if {
    input := {
        "request": {
            "kind": {"kind": "Pod"},
            "object": {
                "spec": {
                    "containers": [
                        {"name": "web", "image": "linguadev/web:1.4.0"}
                    ]
                }
            }
        }
    }
    result := deny with input as input
    count(result) == 0
}

test_reject_no_tag if {
    input := {
        "request": {
            "kind": {"kind": "Pod"},
            "object": {
                "spec": {
                    "containers": [{"name": "web", "image": "linguadev/web"}]
                }
            }
        }
    }
    result := deny with input as input
    count(result) == 1
}
```

Ejecutar:

```bash
opa test policies/ -v
# PASS: 3/3
# data.kubernetes.admission.test_reject_latest_tag: PASS (523.4µs)
# data.kubernetes.admission.test_accept_pinned_tag: PASS (411.2µs)
# data.kubernetes.admission.test_reject_no_tag:     PASS (392.1µs)

# Con coverage
opa test policies/ --coverage --format=json | jq '.files | to_entries | map({file: .key, coverage: .value.coverage})'

# Formateo idiomático
opa fmt --write policies/

# Evaluación ad-hoc contra un manifest
opa eval -d policies/ -i pod.yaml 'data.kubernetes.admission.deny'
```

### 2.4 Bundles: distribución de policies a escala

Con cincuenta clusters K8s en tres regiones más veinte microservicios que usan OPA para authorization más pipelines Terraform, distribuir doscientas policies actualizadas es un problema en sí mismo. **OPA Bundle** lo resuelve: un `tar.gz` con policies (`.rego`) + data (`.json`/`.yaml`) + manifest, servido desde un HTTP endpoint (S3 + CloudFront es lo más común, aunque Styra DAS o un Nginx custom sirven). Los OPA agents descargan el bundle periódicamente (default cada 60s), verifican firma opcional y activan las policies atómicamente. Si el bundle nuevo falla parse, mantienen el anterior — no downtime.

Configuración típica (`opa run --config-file=opa-config.yaml`):

```yaml
services:
  s3-bundles:
    url: https://linguadev-policies.s3.amazonaws.com
    credentials:
      s3_signing:
        environment_credentials: {}

bundles:
  authz:
    service: s3-bundles
    resource: bundles/authz.tar.gz
    polling:
      min_delay_seconds: 60
      max_delay_seconds: 120
    signing:
      keyid: linguadev-key
      scope: linguadev.io

decision_logs:
  console: false
  service: splunk
  reporting:
    min_delay_seconds: 5
    max_delay_seconds: 30

status:
  service: styra-das
```

El `manifest.json` del bundle incluye `revision` (típicamente el git SHA) y `roots` (paths que este bundle es autorizado a escribir). La `Status API` de OPA (`/v1/status`) reporta a un control plane qué versión tiene cada agent en la flota — imprescindible cuando gestionás cien clusters. **Rollback trivial**: publicás el bundle anterior en S3 y los agents lo cargan en menos de un minuto.

---

## 3. Kubernetes admission: Gatekeeper, Kyverno y ValidatingAdmissionPolicy (nivel medio)

### 3.1 Gatekeeper 3.18 con ConstraintTemplate + Constraint

Gatekeeper es un **ValidatingAdmissionWebhook** (opcionalmente Mutating) que integra OPA con el API server de Kubernetes. Cuando llega un `kubectl apply`, el API server llama al webhook de Gatekeeper con el objeto propuesto; Gatekeeper convierte a input JSON, evalúa las policies definidas como CRDs y responde admit/reject. Los devs ven el error en su terminal. En 2026, Gatekeeper 3.18 evalúa policies Rego en 0.5-2ms típicamente (el compilador es altamente optimizado).

El patrón CRD `ConstraintTemplate + Constraint` desacopla lógica de parámetros:

```yaml
# ConstraintTemplate: define el schema + Rego
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
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_]}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("faltan labels obligatorios: %v", [missing])
        }
---
# Constraint: instancia parametrizada
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: prod-namespaces-require-owner
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: [Namespace]
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: In
          values: [prod, prod-eu, prod-us]
  parameters:
    labels: [owner, cost-center, environment]
  enforcementAction: deny   # deny | warn | dryrun
```

**Enforcement actions**: `deny` (rechaza el request), `warn` (permite pero envía warning al kubectl) y `dryrun` (permite pero registra en `status.violations`). Best practice: deployar toda policy nueva en `dryrun` 1-2 semanas, revisar los violations reportados en el `Constraint.status`, ajustar y solo entonces cambiar a `deny`. La sentencia "aplicamos la policy y bloqueó al equipo de auth de deployar" es incident real repetido en muchas empresas.

### 3.2 Kyverno 1.13 con ClusterPolicy en YAML

Kyverno hace el mismo trabajo con YAML puro. Sin lenguaje nuevo. El equivalente de la policy "bloquear `:latest`":

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-latest-tag
  annotations:
    policies.kyverno.io/title: Disallow :latest Tag
    policies.kyverno.io/category: Best Practices
    policies.kyverno.io/severity: medium
spec:
  validationFailureAction: Enforce    # Enforce | Audit
  background: true
  rules:
    - name: require-image-tag
      match:
        any:
          - resources:
              kinds: [Pod]
      validate:
        message: "La imagen debe especificar un tag distinto de :latest."
        pattern:
          spec:
            containers:
              - image: "!*:latest & *:*"

    - name: validate-image-tag
      match:
        any:
          - resources:
              kinds: [Pod]
      validate:
        message: "Se prohíbe el tag :latest."
        deny:
          conditions:
            any:
              - key: "{{ request.object.spec.containers[].image | to_string(@) }}"
                operator: Equals
                value: "*:latest*"
```

Kyverno primitives clave: `validate` (accept/reject), `mutate` (modifica manifest — añadir labels, sidecar, defaults), `generate` (crea recursos derivados: al crear Namespace, generar NetworkPolicy default + ResourceQuota + LimitRange), `verifyImages` (verifica firmas Cosign/Notary y attestations SLSA) y `verifyManifests` (firmas de manifests). La feature **`generate`** es única y muy útil: OPA/Gatekeeper no la tiene nativamente (necesitarías un operator custom).

Mutation típica (añadir sidecar de observability + labels obligatorios):

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: mutate-add-labels-and-sidecar
spec:
  rules:
    - name: add-owner-label
      match:
        any:
          - resources:
              kinds: [Deployment, StatefulSet]
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              linguadev.io/owner: "{{ request.userInfo.username }}"
              linguadev.io/created-at: "{{ time_now_utc() }}"

    - name: inject-otel-sidecar
      match:
        any:
          - resources:
              kinds: [Pod]
      preconditions:
        all:
          - key: "{{ request.object.metadata.labels.\"linguadev.io/inject-otel\" || 'false' }}"
            operator: Equals
            value: "true"
      mutate:
        patchStrategicMerge:
          spec:
            containers:
              - name: otel-collector
                image: otel/opentelemetry-collector:0.111.0
                ports:
                  - containerPort: 4317
                    name: otlp-grpc
                resources:
                  limits: { memory: 128Mi, cpu: 200m }
```

### 3.3 ValidatingAdmissionPolicy con CEL (built-in K8s 1.30+)

VAP llegó a GA en Kubernetes 1.30 (abril 2024) y en 2026 es el camino canónico para validation simple sin instalar componentes externos. Usa **CEL** (Common Expression Language) — mismo DSL que Google usa en Envoy y en JSON Schema. Latencia: sub-milisegundo (no webhook, no HTTP hop). Trade-off: solo validation por ahora (MutatingAdmissionPolicy sigue en alpha en 2026), y CEL es menos expresivo que Rego para lógica muy compleja.

Equivalente "bloquear `:latest`":

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: disallow-latest-tag
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups:   [""]
        apiVersions: ["v1"]
        operations:  [CREATE, UPDATE]
        resources:   [pods]
  validations:
    - expression: |
        object.spec.containers.all(c,
          !c.image.endsWith(':latest') && c.image.contains(':')
        )
      messageExpression: "'Al menos un container usa :latest o no especifica tag: ' + object.spec.containers.filter(c, c.image.endsWith(':latest') || !c.image.contains(':')).map(c, c.name).join(', ')"
      reason: Invalid
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: disallow-latest-tag-binding
spec:
  policyName: disallow-latest-tag
  validationActions: [Deny, Audit]
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: production
```

Regla práctica 2026: si podés expresar la política en CEL y solo necesitás validation → **VAP** (built-in, cero overhead); si necesitás mutation/generate o el catálogo `kyverno/policies` te ahorra días → **Kyverno**; si necesitás la misma skill cross-domain (K8s + Terraform + microservicios) → **OPA + Gatekeeper + Conftest**.

### 3.4 Kyverno vs Gatekeeper vs VAP: tabla de decisión

| Criterio | VAP (built-in) | Kyverno 1.13 | Gatekeeper 3.18 |
|---|---|---|---|
| Instalación | Ninguna (K8s 1.30+) | Helm chart | Helm chart |
| Lenguaje | CEL | YAML declarativo | Rego (OPA) |
| Validation | ✅ | ✅ | ✅ |
| Mutation | ❌ (Mutating VAP alpha) | ✅ nativo | ✅ (más limitado) |
| Generation | ❌ | ✅ único | ❌ |
| verifyImages (Cosign) | ❌ | ✅ nativo | ❌ (necesita policy custom) |
| Latencia typical | <0.5ms | 1-3ms simple, 10-30ms con lookups | 0.5-2ms |
| Curva aprendizaje | Baja (CEL simple) | Muy baja (YAML) | Alta (Rego) |
| Cross-domain | ❌ solo K8s | ❌ solo K8s | ✅ (misma skill OPA/Rego en TF, CI, microservicios) |
| Catálogo policies | Ejemplos oficiales K8s | `kyverno/policies` 200+ | `gatekeeper-library` |
| CNCF status | Core K8s | Graduated 2024 | Incubating (OPA Graduated) |

---

## 4. OPA fuera de Kubernetes: Terraform, CI/CD y microservicios (nivel avanzado)

### 4.1 Conftest para Terraform y manifests en CI

El pipeline debe rechazar PRs que introducen recursos inseguros ANTES del merge. **Conftest** (subproyecto OPA) es el CLI idiomatic: `conftest test <archivos> -p <policies-dir>`. Soporta HCL Terraform, YAML K8s, Dockerfile y más.

Policy Rego para Terraform: rechazar S3 buckets sin encryption y sin public block:

```rego
# policies/terraform/s3.rego
package terraform.s3

deny contains msg if {
    some rc in input.resource_changes
    rc.type == "aws_s3_bucket"
    rc.change.actions[_] == "create"
    not has_encryption(rc.name)
    msg := sprintf("S3 bucket %q se crea sin server-side encryption", [rc.name])
}

deny contains msg if {
    some rc in input.resource_changes
    rc.type == "aws_s3_bucket"
    rc.change.actions[_] == "create"
    not has_public_access_block(rc.name)
    msg := sprintf("S3 bucket %q se crea sin public access block", [rc.name])
}

has_encryption(bucket_name) if {
    some rc in input.resource_changes
    rc.type == "aws_s3_bucket_server_side_encryption_configuration"
    rc.change.after.bucket == bucket_name
}

has_public_access_block(bucket_name) if {
    some rc in input.resource_changes
    rc.type == "aws_s3_bucket_public_access_block"
    rc.change.after.bucket == bucket_name
    rc.change.after.block_public_acls == true
    rc.change.after.block_public_policy == true
    rc.change.after.ignore_public_acls == true
    rc.change.after.restrict_public_buckets == true
}
```

Pipeline GitHub Actions completo:

```yaml
# .github/workflows/terraform-policy.yml
name: Terraform Policy Check
on:
  pull_request:
    paths: [infra/**]

jobs:
  policy-check:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.9.8

      - name: Install conftest
        run: |
          wget https://github.com/open-policy-agent/conftest/releases/download/v0.56.0/conftest_0.56.0_Linux_x86_64.tar.gz
          tar xzf conftest_0.56.0_Linux_x86_64.tar.gz
          sudo mv conftest /usr/local/bin/

      - name: Terraform init & plan
        working-directory: infra
        run: |
          terraform init -backend=false
          terraform plan -out=tfplan
          terraform show -json tfplan > plan.json

      - name: OPA unit tests
        run: opa test policies/terraform/ -v

      - name: Conftest against plan
        run: |
          conftest test infra/plan.json \
            --policy policies/terraform/ \
            --output=github    # formato GitHub Actions annotations

      - name: Checkov (defense in depth)
        run: |
          pip install checkov==3.2.257
          checkov -d infra --framework terraform --quiet
```

### 4.2 Sentinel: la alternativa HashiCorp

Terraform Cloud/Enterprise trae **Sentinel** built-in — DSL propietario Rego-like con integración nativa entre `plan` y `apply`. Modes: `soft-mandatory` (warn con override por admin), `hard-mandatory` (block absoluto sin excepción), `advisory` (log only). Sentinel es más simple que Rego pero solo funciona dentro del ecosistema HashiCorp; OPA/Conftest funciona en cualquier CI. En 2026, Terraform Cloud también soporta OPA nativamente como alternativa a Sentinel.

Ejemplo Sentinel (block S3 buckets con ACL `public-read`):

```hcl
# sentinel/s3-no-public.sentinel
import "tfplan/v2" as tfplan

s3_buckets = filter tfplan.resource_changes as _, rc {
    rc.type is "aws_s3_bucket" and
    (rc.change.actions contains "create" or rc.change.actions contains "update")
}

no_public_acl = rule {
    all s3_buckets as _, bucket {
        bucket.change.after.acl is not "public-read" and
        bucket.change.after.acl is not "public-read-write"
    }
}

main = rule {
    no_public_acl
}
```

### 4.3 OPA para authorization de microservicios

Netflix, Chef y Pinterest publicaron cómo usan OPA como authorization engine centralizado. El pattern canónico: cada microservicio tiene un **sidecar OPA**, el app construye input JSON con contexto (`user`, `action`, `resource`, `context`) y hace HTTP POST al `localhost:8181`. Latencia sub-ms, policies actualizadas via bundle sin redeploy de la app.

Policy Rego de authorization "un user puede leer sus propios recursos, admin lee todo":

```rego
# policies/authz.rego
package linguadev.authz

import data.roles

default allow := false

# Admin: puede todo.
allow if {
    "admin" in input.user.roles
}

# Ownership: user puede leer/editar sus propios recursos.
allow if {
    input.action in {"read", "update"}
    input.resource.owner_id == input.user.id
}

# Read-only para miembros del mismo tenant.
allow if {
    input.action == "read"
    input.resource.tenant_id == input.user.tenant_id
    "reader" in input.user.roles
}

# Deny explícito con motivo (útil para audit logs).
reason := "user has no matching authz rule" if {
    not allow
}
```

Y en el código del microservicio (Go, usando el paquete OPA embed):

```go
package main

import (
    "context"
    "encoding/json"
    "net/http"

    "github.com/open-policy-agent/opa/rego"
)

var authzQuery rego.PreparedEvalQuery

func init() {
    var err error
    authzQuery, err = rego.New(
        rego.Query("data.linguadev.authz.allow"),
        rego.Load([]string{"./policies/authz.rego"}, nil),
    ).PrepareForEval(context.Background())
    if err != nil { panic(err) }
}

func authzMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        input := map[string]any{
            "user": map[string]any{
                "id":        r.Header.Get("X-User-ID"),
                "tenant_id": r.Header.Get("X-Tenant-ID"),
                "roles":     r.Header.Values("X-User-Roles"),
            },
            "action":   r.Method,
            "resource": extractResource(r),
        }

        results, err := authzQuery.Eval(r.Context(), rego.EvalInput(input))
        if err != nil || !results.Allowed() {
            w.WriteHeader(http.StatusForbidden)
            _ = json.NewEncoder(w).Encode(map[string]string{"error": "forbidden"})
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

---

## 5. Ejemplo práctico: hardening completo de LinguaDev Pro con Kyverno + OPA

Bajemos todo a un stack concreto sobre el proyecto **LinguaDev Pro**: cluster K8s con namespace `linguadev-prod`, dos apps (`web` y `api`), y policies que enforcean baseline de seguridad + supply chain + compliance.

### Paso 1: baseline Kyverno con Pod Security Standards restricted

```yaml
# policies/pss-restricted.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-run-as-non-root
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-run-as-non-root
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [linguadev-prod]
      validate:
        message: "Todos los containers deben correr como no-root."
        pattern:
          spec:
            =(securityContext):
              =(runAsNonRoot): "true"
            containers:
              - =(securityContext):
                  =(runAsNonRoot): "true"
---
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-drop-all-capabilities
spec:
  validationFailureAction: Enforce
  rules:
    - name: drop-all-caps
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [linguadev-prod]
      validate:
        message: "Containers deben drop ALL capabilities."
        pattern:
          spec:
            containers:
              - securityContext:
                  capabilities:
                    drop: [ALL]
```

### Paso 2: verifyImages con Cosign para supply chain

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-linguadev-signatures
spec:
  validationFailureAction: Enforce
  webhookTimeoutSeconds: 30
  rules:
    - name: verify-cosign-signature
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [linguadev-prod]
      verifyImages:
        - imageReferences:
            - "ghcr.io/linguadev/*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/linguadev/*"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
          mutateDigest: true
          verifyDigest: true
          required: true
```

### Paso 3: OPA + Conftest para Terraform del cluster

```rego
# policies/terraform/eks_hardening.rego
package terraform.eks

deny contains msg if {
    some rc in input.resource_changes
    rc.type == "aws_eks_cluster"
    rc.change.actions[_] == "create"
    not rc.change.after.encryption_config
    msg := sprintf("EKS cluster %q sin encryption_config (KMS)", [rc.name])
}

deny contains msg if {
    some rc in input.resource_changes
    rc.type == "aws_eks_cluster"
    rc.change.actions[_] == "create"
    not "audit" in rc.change.after.enabled_cluster_log_types
    msg := sprintf("EKS cluster %q sin audit logs habilitados", [rc.name])
}

deny contains msg if {
    some rc in input.resource_changes
    rc.type == "aws_eks_cluster"
    rc.change.after.vpc_config[0].endpoint_public_access == true
    count(rc.change.after.vpc_config[0].public_access_cidrs) == 0
    msg := sprintf("EKS cluster %q público sin CIDR restrictions", [rc.name])
}
```

### Paso 4: ValidatingAdmissionPolicy para límites de resources (built-in)

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-resource-limits
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: [CREATE, UPDATE]
        resources: [pods]
  validations:
    - expression: |
        object.spec.containers.all(c,
          has(c.resources) &&
          has(c.resources.limits) &&
          has(c.resources.limits.memory) &&
          has(c.resources.limits.cpu)
        )
      message: "Todos los containers deben declarar resources.limits.cpu y resources.limits.memory."
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-resource-limits-binding
spec:
  policyName: require-resource-limits
  validationActions: [Deny, Audit]
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: production
```

### Paso 5: pipeline CI que corre todo antes de merge

```yaml
# .github/workflows/policy-gate.yml
name: Policy Gate
on:
  pull_request:
    paths: [k8s/**, infra/**]

jobs:
  policies:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Setup tools
        run: |
          curl -L -o opa https://openpolicyagent.org/downloads/latest/opa_linux_amd64_static
          chmod +x opa && sudo mv opa /usr/local/bin/
          curl -L https://github.com/kyverno/kyverno/releases/download/v1.13.2/kyverno-cli_v1.13.2_linux_x86_64.tar.gz | tar xz
          sudo mv kyverno /usr/local/bin/

      - name: opa test (Rego unit tests)
        run: opa test policies/ -v

      - name: kyverno test (fixtures)
        run: kyverno test policies/kyverno/

      - name: conftest against manifests
        run: |
          conftest test k8s/ -p policies/rego/kubernetes/

      - name: conftest against terraform plan
        working-directory: infra
        run: |
          terraform init -backend=false
          terraform plan -out=tfplan
          terraform show -json tfplan | conftest test - -p ../policies/rego/terraform/
```

---

## 6. Cheatsheet + reglas mentales + anti-patterns

### Reglas de oro

- ✅ Toda policy debe tener **tests unitarios** (`opa test`, `kyverno test`) antes del merge.
- ✅ Deployar nuevas policies en **`dryrun`/`Audit`** 1-2 semanas antes de `Enforce`.
- ✅ **Shift-left**: gate en CI + gate en admission (defense in depth), no solo uno.
- ✅ **Rationale** en cada policy: header con owner + ticket que la motivó + exception process.
- ✅ Usar **`kyverno/policies`** y **`gatekeeper-library`** como base — no reinventar.
- ✅ Para K8s puro con CEL suficiente → **ValidatingAdmissionPolicy** (cero overhead).
- ✅ Para mutation/generate/verifyImages → **Kyverno**.
- ✅ Para políticas cross-domain (K8s + TF + microservicios) → **OPA + bundles**.
- ✅ **Decision logs** ON siempre en producción (SOC2/PCI/HIPAA lo requieren).
- ✅ Bundles firmados (**HMAC** o JWT) + versionamiento por git SHA.
- ✅ **Golden Paths** documentados: platform define QUÉ, teams eligen CÓMO.
- ✅ Progressive enforcement: dev → staging → prod (namespace por namespace).
- ✅ Mensajes de deny **descriptivos** ("container nginx uses :latest", no "violation").
- ✅ Rego v1 (OPA 1.0+): keywords built-in, sin `import future.keywords`.
- ✅ Correr `opa fmt --write` en pre-commit para consistencia.

### Anti-patrones

- ❌ Policies sin tests → un typo bloquea deploys legítimos = outage.
- ❌ **Dry-run permanente**: policies "activas" que nunca pasan a `Enforce` = security theater.
- ❌ Business logic mezclada con security (`if user in tenant X, allow feature Y` no es policy).
- ❌ Copiar-pegar de `gatekeeper-library` sin entender qué hace.
- ❌ **God policy** de 5000 líneas Rego — imposible mantener.
- ❌ Policy sprawl: 500 policies, muchas obsoletas, latency admission > 500ms.
- ❌ **Exceptions permanentes** sin expiration date (comienzan temporales, quedan forever).
- ❌ Wikis + human discipline como "compliance" (ya vimos que fallan).
- ❌ Enforce cluster-wide sin comunicar a equipos = incident + rebellion.
- ❌ No decision logs = auditoría imposible = SOC2 falla.
- ❌ OPA para performance/routing (no es su job — usá service mesh).
- ❌ Bundles sin versionamiento (rollback imposible cuando algo se rompe).

### Cheat-sheet Rego v1

| Concepto | Sintaxis |
|---|---|
| Package | `package linguadev.authz` |
| Default | `default allow := false` |
| Regla condicional | `allow if { input.user.role == "admin" }` |
| Partial rule (set) | `deny contains msg if { ... }` |
| Iteración | `some container in input.request.object.spec.containers` |
| Comprehension | `admins := {u | some u in data.users; u.role == "admin"}` |
| Helpers strings | `endswith`, `startswith`, `contains`, `regex.match`, `sprintf` |
| Helpers collections | `count`, `sort`, `sum`, `union`, `intersection` |
| Testing | `test_...` en archivo `*_test.rego`; `opa test .` |

---

## 7. Casos reales industria 2023-2026

**Netflix Titus / OPA (2018+):** Netflix construyó Titus (su orchestrator pre-K8s) con OPA integrado desde ~2018 para authorization en microservicios. Publicaron latency <2ms p99 con sidecar. **Lección:** OPA en producción a escala real (miles req/s) es viable.

**CNCF OPA Graduated (2021):** OPA se convirtió en CNCF Graduated project — señal de madurez industrial y adopción cross-industry. Casos incluyen Netflix, Pinterest, Chef, TripAdvisor, Goldman Sachs, Capital One. **Lección:** invertir en OPA/Rego skills es safe bet.

**Kyverno Graduated (2024):** Kyverno alcanzó CNCF Graduated en 2024, validando la apuesta por YAML-native para K8s. VMware, Nirmata, GitLab lo usan en producción. **Lección:** el ecosistema K8s tiene espacio para múltiples motores con filosofías distintas.

**OPA 1.0 GA (2024):** OPA lanzó su versión 1.0 con Rego v1 como default: `if`, `in`, `contains` built-in sin `import future.keywords`, mejor performance y error messages. **Lección:** el lenguaje maduró; policies escritas antes deben migrarse (compatibilidad backwards con flag).

**ValidatingAdmissionPolicy GA en K8s 1.30 (abril 2024):** VAP built-in con CEL, sin webhooks externos. Latencia sub-ms. En 2026 es el camino default para validation simple. **Lección:** para casos triviales, no instales Gatekeeper — usá VAP.

**Capital One usage con Styra DAS (2022+):** Capital One publicó cómo usa Styra DAS para gestionar cientos de bundles OPA cross-microservicios. Decision logs alimentan dashboards de compliance en tiempo real. **Lección:** en enterprise, un control plane comercial vale la pena (evidence automation + governance).

**Adobe adoption Kyverno (2023):** Adobe compartió en KubeCon su migración a Kyverno para hardening masivo de clusters. La feature `generate` fue decisiva para auto-provisionar NetworkPolicies + Quotas por namespace nuevo. **Lección:** `generate` es la killer feature de Kyverno.

**Sigstore + Cosign + Kyverno para SLSA (2024+):** post-SolarWinds, la adopción de verifyImages con signatures Cosign se volvió estándar. Kyverno integra Rekor + Fulcio nativamente. **Lección:** PaC + supply chain security convergen.

**Post-mortem "policy que bloqueó al team de auth" (recurrente en incident reports):** el patrón se repite: policy nueva deployada directamente en `Enforce`, no anticipó legacy workloads, bloqueó deploys críticos. **Lección:** siempre `dryrun`/`Audit` primero.

**Spotify Golden Paths (public 2020, extendido 2024+):** platform team define policies como parte del Golden Path; teams dentro del path son productivos, teams fuera tienen fricción proporcional. Backstage integra checks. **Lección:** PaC + platform engineering se refuerzan mutuamente.

---

## 8. Ejercicios prácticos

### Ejercicio 1: escribir + testar policy Rego "no `:latest`"

**Objetivo:** implementar la policy con `opa test` unitarios y correrla con conftest contra manifests reales.

**Setup:** OPA 1.0+, un directorio `k8s/` con Deployments de ejemplo.

**Pasos:**
1. Crear `policies/no_latest.rego` con Rego v1 sin `import future.keywords`.
2. Crear `policies/no_latest_test.rego` con 3 tests (reject `:latest`, accept pinned tag, reject sin tag).
3. Correr `opa test policies/ -v`.
4. Crear 3 manifests: uno correcto, uno con `:latest`, uno sin tag.
5. `conftest test k8s/ -p policies/`.

**Criterios de éxito:**
- [ ] 3/3 tests pasan.
- [ ] Conftest muestra 2 fallos con mensajes descriptivos.
- [ ] `opa fmt --write policies/` no cambia nada (código idiomatic).

**Bonus:** añadir un cuarto test para InitContainers + ephemeralContainers.

---

### Ejercicio 2: Gatekeeper ConstraintTemplate + progressive rollout

**Objetivo:** deployar `K8sRequiredLabels` en `dryrun`, revisar violations, y solo entonces pasar a `deny`.

**Setup:** kind cluster + Gatekeeper 3.18+.

**Pasos:**
1. Instalar Gatekeeper vía Helm.
2. Aplicar el `ConstraintTemplate` y `Constraint` de la sección 3.1 con `enforcementAction: dryrun`.
3. Crear 3 namespaces: uno con todos los labels, uno con label parcial, uno sin labels.
4. `kubectl get k8srequiredlabels prod-namespaces-require-owner -o yaml` — revisar `status.violations`.
5. Cambiar `enforcementAction: deny` y verificar que los namespaces sin labels ahora se rechazan al crear/updatear.

**Criterios de éxito:**
- [ ] En `dryrun`, los 3 namespaces se crean; el `status.violations` reporta los 2 que faltan labels.
- [ ] En `deny`, crear un Namespace sin labels retorna error del API server con mensaje descriptivo.
- [ ] Un Namespace correcto sigue admitiéndose sin problema.

**Bonus:** añadir un `Constraint` que también aplique a Deployments con exception via label `exempt-from-labels=true`.

---

### Ejercicio 3: Kyverno mutate + generate para bootstrap de namespaces

**Objetivo:** al crear un Namespace nuevo, auto-generar `NetworkPolicy default-deny` + `ResourceQuota` + label `owner`.

**Setup:** kind cluster + Kyverno 1.13+.

**Pasos:**
1. Escribir `ClusterPolicy` con `mutate` que añade label `linguadev.io/managed-by: kyverno` al Namespace.
2. Escribir `ClusterPolicy` con `generate` que crea un `NetworkPolicy default-deny` + `ResourceQuota` cuando se crea un Namespace con label `environment in [dev, staging, prod]`.
3. Crear `Namespace test-app` con el label.
4. Verificar que aparecen `NetworkPolicy default-deny` y `ResourceQuota` en `test-app`.

**Criterios de éxito:**
- [ ] `kubectl get ns test-app -o yaml` muestra el label mutado.
- [ ] `kubectl get networkpolicy,resourcequota -n test-app` muestra los 2 recursos generados.
- [ ] Borrar el `ClusterPolicy generate` — los recursos generados persisten (por default).

**Bonus:** añadir `synchronize: true` para que si alguien edita el `NetworkPolicy` generado, Kyverno lo revierta.

---

### Ejercicio 4: OPA + Conftest en pipeline Terraform

**Objetivo:** bloquear PRs que introducen S3 buckets sin encryption/public block.

**Setup:** repo con Terraform + GitHub Actions + Conftest.

**Pasos:**
1. Crear `infra/main.tf` con 2 buckets: uno seguro, uno inseguro.
2. Escribir `policies/terraform/s3.rego` de la sección 4.1.
3. `terraform init && terraform plan -out=tfplan && terraform show -json tfplan > plan.json`.
4. `conftest test plan.json -p policies/terraform/`.
5. Añadir GitHub Actions workflow que corra el gate en cada PR.

**Criterios de éxito:**
- [ ] Conftest reporta 2 violations por el bucket inseguro (encryption + public block).
- [ ] El PR muestra annotations en la UI de GitHub.
- [ ] Corregir el Terraform y validar que conftest pasa.
- [ ] `opa test policies/terraform/ -v` con 3+ tests que pasan.

**Bonus:** añadir Checkov en el mismo workflow (defense in depth).

---

### Ejercicio 5: ValidatingAdmissionPolicy nativo (K8s 1.30+)

**Objetivo:** implementar "require resource limits" con VAP + CEL, sin instalar componentes externos.

**Setup:** kind cluster con K8s 1.30+.

**Pasos:**
1. Aplicar `ValidatingAdmissionPolicy` + `Binding` de la sección 3.4.
2. Etiquetar el namespace `default` con `environment=production`.
3. Deployar un Pod sin `resources.limits` — debe rechazarse con el mensaje CEL.
4. Deployar un Pod con `resources.limits` completos — debe admitirse.
5. Cambiar `validationActions: [Audit]` — el Pod sin limits se admite pero registra event.

**Criterios de éxito:**
- [ ] Pod sin limits en namespace prod se rechaza.
- [ ] Pod completo se admite.
- [ ] En modo Audit, `kubectl get events` muestra el warning.
- [ ] Zero pods de Gatekeeper/Kyverno instalados (VAP es built-in).

**Bonus:** extender la policy con `variables` CEL para reutilizar expresiones + añadir un segundo `Binding` con match `environment=staging`.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [openpolicyagent.org/docs](https://www.openpolicyagent.org/docs/latest/) — OPA 1.0 docs, Rego v1, bundles.
- [kyverno.io/docs](https://kyverno.io/docs/) — Kyverno 1.13, policies, mutation, generation.
- [open-policy-agent.github.io/gatekeeper](https://open-policy-agent.github.io/gatekeeper/) — Gatekeeper 3.18 + ConstraintTemplate reference.
- [kubernetes.io — ValidatingAdmissionPolicy](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/) — VAP oficial + CEL guide.

**Repositorios de policies ready-to-use:**
- [github.com/kyverno/policies](https://github.com/kyverno/policies) — 200+ policies categorizadas.
- [github.com/open-policy-agent/gatekeeper-library](https://github.com/open-policy-agent/gatekeeper-library) — templates Rego.
- [github.com/aquasecurity/trivy-policies](https://github.com/aquasecurity/trivy-policies) — trivy con Rego.

**Herramientas complementarias:**
- **Conftest** — CI gate para YAML/HCL/JSON con Rego.
- **Checkov** (Bridgecrew/Palo Alto) — static analysis IaC con policies built-in.
- **tfsec** (Aqua) — Terraform security scanner.
- **Sentinel** (HashiCorp) — DSL propietario para Terraform Cloud.
- **Styra DAS** — control plane comercial para OPA a escala enterprise.
- **jsPolicy** (Loft) — alternativa policies en JavaScript en vez de Rego.

**Zanzibar-style alternativas (para authz fine-grained):**
- **SpiceDB** (Authzed) — inspirado en Google Zanzibar.
- **OpenFGA** (Auth0/Okta).
- **Cerbos** — authz sidecar.

**Referencias adicionales:**
- Tim Hinrichs, Torin Sandall, *"Open Policy Agent: Introduction and Roadmap"* — cofundadores de OPA/Styra.
- Chris Hein, *"Policy as Code with Open Policy Agent"* (O'Reilly, 2023).
- Chef Community, *"Compliance as Code with InSpec"* — pionero de la disciplina.
- CNCF *"Cloud Native Security Whitepaper"* — recomendaciones PaC.
- Google *"Zanzibar: Google's Consistent, Global Authorization System"* (paper 2019).

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Auditá tu cluster: ¿tenés PaC? ¿decision logs? ¿tests de policies en CI?
- Migrá una policy existente de Gatekeeper a Kyverno o VAP (según encaje) para practicar.
- Introducí `conftest` en un pipeline Terraform en staging.
- Continuá con [cap 26 — Compliance y auditoría](./26-compliance-y-audit.md), donde PaC se conecta con SOC2, ISO 27001, PCI-DSS y evidence automation.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas junior → mid → senior → staff. Cubren: Policy as Code como disciplina, arquitectura OPA, Rego basics + sintaxis v1, Gatekeeper con ConstraintTemplate/Constraint, Kyverno vs OPA/Gatekeeper, mutation vs validation vs generation, testing con `opa test`/`kyverno test`, bundle distribution + firmas + rollback, decision logs para audit, OPA + Terraform via Conftest + Sentinel, CI/CD gates, authorization de microservicios con sidecar/embed/Envoy, compliance-as-code para CIS Kubernetes Benchmark, Pod Security Standards con Kyverno, performance tuning (partial evaluation, WASM, indexing), anti-patterns (dry-run permanente, sprawl, exceptions permanentes) y el futuro (supply chain + AI + Zanzibar-style + IDE integration).

- **Fuente:** [`packages/content/src/tech/devops/sim-25-policy-as-code-opa-kyverno.json`](../../packages/content/src/tech/devops/sim-25-policy-as-code-opa-kyverno.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-25-policy-as-code-opa-kyverno`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 24 — Supply Chain Security](./24-supply-chain-security.md) · [Índice](./README.md) · [Capítulo 26 — Compliance y auditoría →](./26-compliance-y-audit.md)
