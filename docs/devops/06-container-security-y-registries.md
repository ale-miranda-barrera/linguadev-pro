# Capítulo 06 — Container security, registries y supply chain

> **Focus:** Escaneo de vulnerabilidades (Trivy, Grype, Snyk), SBOMs (Syft, SPDX, CycloneDX), firma y verificación de imágenes con cosign/Sigstore, registries privados (ECR, GHCR, Harbor), pull-through cache, retention policies, y hardening runtime (rootless, capabilities, seccomp, Falco).
> **Áreas:** Container security · Supply chain · Registry ops
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de contenedores y Dockerfiles ([cap 05](./05-fundamentos-docker.md)).
- Conocer conceptos de PKI (public/private key, X.509, OpenID Connect).
- Pipeline CI/CD funcional con GitHub Actions o Jenkins ([cap 04](./04-github-actions-y-jenkins.md)).

**Glosario mínimo:**
- **CVE** (Common Vulnerabilities and Exposures): identificador global `CVE-YYYY-NNNNN` de una vulnerabilidad; mantenido por MITRE, publicado en NVD.
- **CVSS 4.0** (Common Vulnerability Scoring System): score 0.0-10.0 con vector completo (AV, AC, PR, UI, S, VC/VI/VA…). En 2026 la mayoría de scanners reportan tanto CVSS 3.1 como 4.0.
- **EPSS**: Exploit Prediction Scoring System (FIRST); probabilidad 0-1 de que un CVE sea explotado en los próximos 30 días. Muy útil para priorizar.
- **KEV**: Known Exploited Vulnerabilities catalog (CISA). Si un CVE está en KEV, mitigar hoy.
- **SBOM** (Software Bill of Materials): lista formal de componentes en dos formatos dominantes: **SPDX 3.0** y **CycloneDX 1.6**.
- **SLSA v1.2** (Supply-chain Levels for Software Artifacts, [slsa.dev](https://slsa.dev)): framework con 4 niveles de garantía; v1.2 estabilizada 2026.
- **Sigstore**: proyecto CNCF con `cosign`, `fulcio` (CA short-lived certs), `rekor` (transparency log).
- **OCI Distribution Spec v1.1**: API estándar para registries; soporta referrers (para SBOMs y firmas adjuntas).
- **Pull-through cache**: registry que actúa como proxy caché del upstream (Docker Hub, GHCR) para reducir rate limits y latencia.

**Setup mínimo (agosto 2026):**

```bash
# Trivy 0.55+ (Aqua Security)
brew install aquasecurity/trivy/trivy || \
  curl -sSL https://github.com/aquasecurity/trivy/releases/download/v0.55.0/trivy_0.55.0_Linux-64bit.tar.gz | tar xz -C /usr/local/bin trivy

# Syft + Grype (Anchore) para SBOM y scanning
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh  | sh -s -- -b /usr/local/bin
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin

# cosign 2.4+ (Sigstore)
curl -sSL -o cosign https://github.com/sigstore/cosign/releases/download/v2.4.0/cosign-linux-amd64
chmod +x cosign && sudo mv cosign /usr/local/bin/

# Verificación
trivy --version    # → Version: 0.55.x
syft version       # → syft 1.14+
grype version      # → 0.82+
cosign version     # → v2.4.x
```

---

## 1. El gran cuadro

En 2020 SolarWinds cambió cómo se piensa la seguridad de software: un atacante comprometió el pipeline de build y firmó un binario malicioso con la clave legítima del vendor. En 2021 Log4Shell (CVE-2021-44228, CVSS 10.0) reveló que los defensores no sabían dónde vivía Log4j en su parque: sin SBOMs, buscar la vulnerabilidad tomó semanas. En 2023-2024 XZ Utils (CVE-2024-3094) mostró un backdoor introducido durante dos años por un mantenedor infiltrado. Y en 2024-2026 la Executive Order 14028 (EE. UU.), la Cyber Resilience Act (UE, entrada en vigor escalonada 2027) y varias regulaciones sectoriales convergen en el mismo requisito: **cadena de suministro auditable**, con SBOMs, firmas verificables y evidencia de reproducibilidad.

El resultado práctico para un equipo de plataforma en 2026 es un flujo de vida por imagen con cinco compuertas obligatorias:

1. **Build reproducible** (BuildKit determinista, base pinned por digest, `--provenance=true`).
2. **SBOM adjunta** al artefacto en el registry (formato SPDX o CycloneDX).
3. **Escaneo de CVEs** con priorización por EPSS/KEV, no solo CVSS.
4. **Firma con cosign** (keyless via OIDC de GitHub/GitLab o key-based) más registro en Rekor.
5. **Política de admisión** en el destino (Kubernetes con Kyverno/OPA verifica firma, SBOM y CVEs máximos antes de aceptar la imagen).

Este capítulo cubre las cinco compuertas más la operación de registries (tipos, pull-through cache, retention, replication) y hardening runtime (rootless, capabilities, seccomp/apparmor, Falco). Es la base para [cap 24 — Supply chain security](./24-supply-chain-security.md), donde se profundiza en SLSA y provenance.

---

## 2. Container registries: tipos, autenticación y OCI (nivel básico)

Un **registry** es un servicio HTTP que sirve el estándar [OCI Distribution Spec v1.1](https://github.com/opencontainers/distribution-spec). Cada imagen se identifica por:

- **Repository**: `ghcr.io/miorg/miapp`
- **Tag**: `1.4.2`, `latest`, `pr-123` (mutable, puede reasignarse).
- **Digest**: `sha256:9f8c...` (inmutable, hash del manifest).

**Regla operativa 2026**: en producción, referencia por **digest** (`ghcr.io/miorg/miapp@sha256:9f8c...`), nunca por tag. Los tags son punteros movibles; los digests garantizan que corres exactamente el mismo bytes que verificaste.

**Tipos de registry**:

| Tipo | Proveedor | Fortalezas | Debilidades |
|---|---|---|---|
| Público gratuito | Docker Hub | Ubicuidad, imágenes oficiales | Rate limits agresivos, retention política, público por defecto |
| GitHub | GHCR (`ghcr.io`) | Free para privado, OIDC token nativo, integración Actions | Cuota storage en org grandes |
| AWS | ECR (Elastic Container Registry) | IAM, pull-through cache, retention nativa, replicación | Coste egress cross-region |
| GCP | Artifact Registry | Similar ECR, VPC-native | Bloqueado en algunas regiones |
| Azure | ACR | RBAC AAD, geo-replication | UX menos madura |
| Self-hosted OSS | Harbor (CNCF) | RBAC, vulnerability scan integrado (Trivy), signing, replication, retention | Ops overhead |
| Self-hosted enterprise | JFrog Artifactory, Sonatype Nexus | Multi-formato (npm, Maven, OCI…), Xray | Coste |

**Autenticación con GHCR desde GitHub Actions** (patrón 2026):

```yaml
permissions:
  packages: write
  id-token: write   # necesario para cosign keyless
steps:
  - uses: docker/login-action@v3
    with:
      registry: ghcr.io
      username: ${{ github.actor }}
      password: ${{ secrets.GITHUB_TOKEN }}
```

`GITHUB_TOKEN` es un OIDC token con vida ~1 h scoped al repo. No hay que rotarlo manualmente.

**Autenticación con ECR desde Kubernetes en AWS** (IRSA + `imagePullSecrets` no necesarios):

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: puller
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/ecr-puller
```

El kubelet en EKS resuelve las credenciales de ECR automáticamente cuando la SA tiene una IAM role con `ecr:GetAuthorizationToken` y `ecr:BatchGetImage`.

---

## 3. CVEs, CVSS 4.0, EPSS y KEV (nivel básico)

Un CVE es un **identificador** de vulnerabilidad; no una medida de riesgo. La medida es una combinación de:

- **CVSS 4.0** (severidad técnica): Critical (9.0-10.0), High (7.0-8.9), Medium (4.0-6.9), Low (0.1-3.9).
- **EPSS** (probabilidad de explotación 30 días): 0-1. Un EPSS 0.75 significa 75% probable ser explotado.
- **KEV** (CISA Known Exploited Vulnerabilities): si está en KEV, hay evidencia de explotación activa.

**Priorización real** (política común en 2026):

| Regla | Acción |
|---|---|
| CVE en KEV | Parche en ≤ 24 h. Escalado inmediato. |
| CVSS ≥ 9.0 **y** EPSS ≥ 0.5 | Parche en ≤ 72 h. |
| CVSS ≥ 7.0 con exploit público | Parche en ≤ 7 d. |
| CVSS 4.0-6.9 sin exploit | Parche en próximo ciclo (14-30 d). |
| CVSS < 4.0 | Backlog, revisar mensualmente. |

Confiar solo en CVSS produce miles de "críticos" que nadie va a explotar y agota al equipo. EPSS + KEV recorta esa lista al 5-10% verdaderamente urgente.

**Casos históricos que definen la disciplina**:

- **CVE-2021-44228 (Log4Shell)**: RCE remoto en Log4j. Impacto masivo por dependencia transitiva no rastreada. Motor detrás del push regulatorio hacia SBOMs obligatorios.
- **CVE-2024-3094 (XZ Utils backdoor)**: código malicioso introducido por un mantenedor. Cambió cómo se piensa en confianza de mantenedores upstream.
- **CVE-2024-21626 (runc leak fd)**: escape de contenedor con volume mount específico. Recordatorio de que el runtime también tiene CVEs.
- **CVE-2025-XXXXX (BuildKit git checkout)** (2026): inyección de comandos en frontend git. Los builders también son superficie.

---

## 4. Trivy, Grype y Snyk: escaneo de imágenes (nivel medio)

**Trivy** (Aqua Security) es el scanner OSS dominante en 2026: rápido (single binary Go, sin daemon), cubre imágenes, filesystems, repos git, manifests IaC (K8s, Terraform, Helm), SBOMs y secretos.

```bash
# Scan imagen local o remota; falla el pipeline si hay Critical
trivy image \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --exit-code 1 \
  --format sarif \
  --output trivy-report.sarif \
  ghcr.io/miorg/miapp:1.4.2

# Scan del Dockerfile (misconfig) + secretos
trivy config ./Dockerfile
trivy fs --scanners vuln,secret,misconfig .
```

`--ignore-unfixed` es clave: no fallar por CVEs sin fix upstream (nada que puedas hacer excepto documentar). En cambio, si hay fix disponible, actualiza.

**Ignorar CVEs deliberadamente** con archivo `.trivyignore` (o mejor, VEX):

```
# .trivyignore
# CVE-2024-1234 no aplica: no usamos la función vulnerable (documentado por sec-eng, 2026-07)
CVE-2024-1234 exp:2026-12-31
```

**VEX (Vulnerability Exploitability eXchange)** en formato OpenVEX u OASIS CSAF es superior a `.trivyignore` porque es firmable, adjuntable al SBOM y auditable. Trivy 0.55+ consume VEX vía `--vex`.

**Grype** (Anchore) es alternativa OSS; comparte DB con Syft y es útil cuando ya usas el ecosistema Anchore. **Snyk** y **Docker Scout** son SaaS con integración developer-first y feed comercial más agresivo (a veces detectan CVEs antes de que aparezcan en NVD).

**Diferencia clave 2026**: los scanners difieren en su DB. Trivy usa NVD + GitHub Advisory + OSS Index; Grype similar; Snyk y Chainguard tienen feeds propietarios curados. Ejecuta al menos **dos scanners** en pipeline crítico y trata la unión como el conjunto real. Nunca confíes en un solo scanner para decisiones de deploy.

**GitHub Actions pipeline canonical** con Trivy + upload de SARIF a GitHub Security:

```yaml
name: image-scan
on: [push, pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
      packages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Build image (local)
        run: |
          docker buildx build --load \
            -t ghcr.io/${{ github.repository }}:${{ github.sha }} .
      - name: Trivy scan
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: ghcr.io/${{ github.repository }}:${{ github.sha }}
          format: sarif
          output: trivy.sarif
          severity: HIGH,CRITICAL
          exit-code: 1
          ignore-unfixed: true
      - name: Upload SARIF to GitHub Security
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy.sarif
```

---

## 5. SBOM: Syft, SPDX y CycloneDX (nivel medio)

Un **SBOM** es la lista firmable de componentes de un artefacto. Sin SBOM no sabes qué versión de qué librería corre en producción; con SBOM, cuando aparezca el próximo Log4Shell, contestas la pregunta "¿estoy afectado?" en segundos, no semanas.

Dos formatos dominantes:

- **SPDX 3.0** (Linux Foundation, ISO/IEC 5962:2021): más rico en licenciamiento; adoptado en compliance corporativo.
- **CycloneDX 1.6** (OWASP): más orientado a seguridad; primer soporte para VEX, ML-BOM, SaaSBOM.

Ambos son válidos; muchas orgs generan los dos y los dejan como attestations en el registry. En 2026 la Executive Order 14028 y CRA europea prácticamente exigen SBOMs para software crítico.

**Generar SBOM con Syft**:

```bash
# CycloneDX JSON
syft ghcr.io/miorg/miapp:1.4.2 -o cyclonedx-json > sbom-cdx.json
# SPDX JSON
syft ghcr.io/miorg/miapp:1.4.2 -o spdx-json > sbom-spdx.json

# Escanear SBOM (mucho más rápido que reescanear imagen)
grype sbom:./sbom-cdx.json --fail-on high
```

**Attestar SBOM al registry** con OCI referrers (spec v1.1):

```bash
# 1. Firmar y subir SBOM como attestation al registry
cosign attest --predicate sbom-cdx.json \
  --type cyclonedx \
  --yes \
  ghcr.io/miorg/miapp@sha256:9f8c...

# 2. Descubrir SBOMs adjuntos
cosign tree ghcr.io/miorg/miapp:1.4.2

# 3. Descargar y verificar
cosign verify-attestation \
  --certificate-identity-regexp='https://github.com/miorg/.*/.github/workflows/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com' \
  --type cyclonedx \
  ghcr.io/miorg/miapp@sha256:9f8c...
```

**Integración con buildx** desde Docker 25+ / BuildKit 0.14+ genera SBOM en la propia build:

```bash
docker buildx build \
  --sbom=true --provenance=true \
  -t ghcr.io/miorg/miapp:1.4.2 \
  --push .
```

El SBOM queda como referrer OCI en el mismo repo sin trabajo adicional.

---

## 6. Firma de imágenes con cosign y Sigstore (nivel medio-avanzado)

Antes de Sigstore, firmar imágenes requería PKI corporativa: gestionar claves privadas, HSMs, rotación, distribución de public keys. Nadie lo hacía. Sigstore invirtió el modelo con **keyless signing** basado en OIDC:

1. Tu pipeline pide un ID token a un OIDC provider (GitHub, GitLab, Google, Buildkite).
2. `cosign` envía el token a **Fulcio** (CA de Sigstore) que emite un **cert efímero de 10 minutos** vinculado a la identidad del token.
3. `cosign` firma con la clave privada del cert (destruida tras uso).
4. La firma + cert se publica en **Rekor** (transparency log público, append-only, tipo Certificate Transparency).
5. La firma se sube al registry como OCI referrer del digest de la imagen.

Verificación posterior no necesita ninguna clave privada: comprueba que el cert de Fulcio se corresponde a la identidad esperada y que la firma está registrada en Rekor.

**Firmar desde GitHub Actions (keyless)**:

```yaml
- uses: sigstore/cosign-installer@v3
  with: { cosign-release: 'v2.4.0' }
- name: Sign image
  env:
    COSIGN_EXPERIMENTAL: "true"
  run: |
    IMG=ghcr.io/${{ github.repository }}@${{ steps.push.outputs.digest }}
    cosign sign --yes "$IMG"
```

No hay `password`, no hay `--key`. La identidad del firmante queda ligada al workflow (`https://github.com/miorg/miapp/.github/workflows/release.yml@refs/heads/main`).

**Verificar antes de deploy** (política en Kubernetes vía Kyverno):

```yaml
apiVersion: kyverno.io/v2beta1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
spec:
  validationFailureAction: Enforce
  webhookTimeoutSeconds: 30
  rules:
    - name: cosign-keyless-github
      match:
        any:
          - resources:
              kinds: [Pod]
      verifyImages:
        - imageReferences:
            - "ghcr.io/miorg/*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/miorg/*/.github/workflows/release.yml@refs/heads/main"
                    issuer:  "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
          mutateDigest: true
          verifyDigest: true
```

Este bloque rechaza cualquier Pod que use una imagen `ghcr.io/miorg/*` cuya firma no venga del workflow `release.yml` en main. Si un atacante compromete un dev token y sube una imagen, no pasa la puerta de admisión.

**Key-based (fallback offline)** si no puedes usar OIDC:

```bash
cosign generate-key-pair             # genera cosign.key + cosign.pub
cosign sign --key cosign.key IMG
cosign verify --key cosign.pub IMG
```

Guarda `cosign.key` en KMS (AWS KMS, GCP KMS, Vault Transit) usando URLs `awskms://`, `gcpkms://`, `hashivault://`.

---

## 7. SLSA v1.2 y provenance (nivel avanzado)

**SLSA** (Supply-chain Levels for Software Artifacts) define 4 niveles progresivos de garantía. Versión v1.2 estabilizada en 2026 clarifica requisitos de "provenance" y añade categoría **Build L3** más estricta.

| Nivel | Requisitos clave |
|---|---|
| **L1** | Build automatizado + provenance no firmada. Baseline. |
| **L2** | Provenance firmada por el build system; runners autenticados. |
| **L3** | Build isolation fuerte (ephemeral, hermetic), provenance no falsificable por scripts del proyecto, runner platform trusted. |
| **L4** | (Retirada como nivel formal en v1.0+; sus requisitos se reparten en L3 más estrictos.) |

GitHub Actions + BuildKit `--provenance=true` alcanzan **SLSA Build L2** por defecto en 2026, y **L3** con configuración adicional (hosted runners + reusable workflows).

Un **provenance attestation** SLSA v1.2 es un JSON firmado con cosign que responde a: *¿quién construyó, con qué inputs (source URL + commit), con qué builder, con qué parámetros?* Ejemplo simplificado:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "predicateType": "https://slsa.dev/provenance/v1",
  "subject": [{ "name": "ghcr.io/miorg/miapp", "digest": { "sha256": "9f8c..." }}],
  "predicate": {
    "buildDefinition": {
      "buildType": "https://github.com/actions/runner/buildkit@v1",
      "externalParameters": {
        "workflow": {
          "ref": "refs/heads/main",
          "repository": "https://github.com/miorg/miapp",
          "path": ".github/workflows/release.yml"
        }
      },
      "resolvedDependencies": [
        { "uri": "git+https://github.com/miorg/miapp@refs/heads/main",
          "digest": { "gitCommit": "abc123..." } }
      ]
    },
    "runDetails": {
      "builder": { "id": "https://github.com/actions/runner" },
      "metadata": {
        "invocationId": "https://github.com/miorg/miapp/actions/runs/9876543",
        "startedOn": "2026-08-13T09:30:00Z",
        "finishedOn": "2026-08-13T09:34:12Z"
      }
    }
  }
}
```

Verificación con [`slsa-verifier`](https://github.com/slsa-framework/slsa-verifier):

```bash
slsa-verifier verify-image ghcr.io/miorg/miapp@sha256:9f8c... \
  --source-uri github.com/miorg/miapp \
  --source-tag v1.4.2
```

Si el binary del release no fue construido desde `github.com/miorg/miapp` con el tag `v1.4.2`, el verifier falla.

---

## 8. Runtime hardening: rootless, capabilities, seccomp, AppArmor, Falco (nivel avanzado)

Escanear la imagen no basta. Un proceso puede pasar todos los scans y seguir explotable en runtime por privilegios innecesarios. El endurecimiento runtime cubre 5 capas:

**1. Rootless containers.** Podman lo hace nativo desde v1; Docker desde 20.10 con `dockerd-rootless-setuptool.sh`. En Kubernetes, kubelet + containerd rootless es aún adopción baja en 2026 pero creciente. El beneficio: aunque haya escape del runtime, el atacante cae como usuario no privilegiado del host.

**2. Capabilities.** Nunca `--privileged`. Drop-all + add específicas:

```yaml
securityContext:
  capabilities:
    drop: ["ALL"]
    add: ["NET_BIND_SERVICE"]   # solo si necesitas puerto <1024
```

Las que casi siempre se pueden dropear: `CAP_SYS_ADMIN` (equivale a root), `CAP_NET_ADMIN`, `CAP_SYS_PTRACE`, `CAP_SYS_MODULE`.

**3. Seccomp profile.** Filtra qué syscalls puede hacer el proceso. En Kubernetes 1.30+ el default `RuntimeDefault` es un buen punto de partida:

```yaml
securityContext:
  seccompProfile:
    type: RuntimeDefault
```

Para workloads sensibles, generar un perfil restringido con `strace` + [`kubectl-seccomp-profile`](https://github.com/kubernetes-sigs/security-profiles-operator).

**4. AppArmor / SELinux.** Mandatory Access Control. Kubernetes 1.31+ tiene AppArmor GA con field `securityContext.appArmorProfile`. En RHEL/OpenShift, SELinux es obligatorio.

```yaml
securityContext:
  appArmorProfile:
    type: RuntimeDefault
```

**5. Detección runtime con Falco** (CNCF): motor eBPF/kmod que emite alertas cuando ocurren eventos sospechosos (spawn de shell dentro de contenedor, escritura en `/etc`, mount inesperado, syscall bloqueada). Regla ejemplo:

```yaml
- rule: Shell in container
  desc: Alert when a shell is spawned inside a container
  condition: >
    container and shell_procs and proc.tty != 0 and container_entrypoint
  output: >
    Shell spawned (user=%user.name container=%container.name
    shell=%proc.name parent=%proc.pname pid=%proc.pid)
  priority: WARNING
  tags: [container, shell]
```

Falco se despliega como DaemonSet ([cap 08](./08-kubernetes-workloads.md)) y sus alertas van a un backend (Falcosidekick → Slack, PagerDuty, Loki).

**Baseline recomendado 2026 para Pod producción:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hardened
  annotations:
    container.apparmor.security.beta.kubernetes.io/app: runtime/default
spec:
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: app
      image: ghcr.io/miorg/miapp@sha256:9f8c...
      imagePullPolicy: IfNotPresent
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: ["ALL"] }
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits:   { cpu: 500m, memory: 512Mi }
      volumeMounts:
        - { name: tmp,     mountPath: /tmp }
        - { name: cache,   mountPath: /var/cache/app }
  volumes:
    - { name: tmp,   emptyDir: { medium: Memory, sizeLimit: 64Mi } }
    - { name: cache, emptyDir: { sizeLimit: 128Mi } }
```

---

## 9. Operación de registries: pull-through cache, retention, replication (nivel avanzado)

En 2020 Docker Hub introdujo **rate limits** (100 pulls/6 h anonymous, 200 autenticado). Cientos de pipelines CI empezaron a fallar con `TOOMANYREQUESTS`. La solución operativa correcta es **pull-through cache**: un registry en tu VPC que actúa como proxy caché del upstream.

**ECR pull-through cache** para Docker Hub:

```bash
aws ecr create-pull-through-cache-rule \
  --ecr-repository-prefix dockerhub \
  --upstream-registry-url registry-1.docker.io \
  --credential-arn arn:aws:secretsmanager:us-east-1:...:secret:dockerhub-XXXX
```

Después referencia como `123456789012.dkr.ecr.us-east-1.amazonaws.com/dockerhub/library/nginx:1.27`. El primer pull llega a Docker Hub; los siguientes vienen de ECR sin egress externo.

Harbor, GCR, ACR y GitLab Registry tienen equivalente.

**Retention policies** — sin ellas el registry crece indefinidamente. Ejemplo Harbor:

```
Keep the most recently pushed 10 tags matching **prod-** in all repositories
AND keep tags matching v* pushed in the last 90 days
AND delete untagged manifests older than 7 days
```

En ECR con lifecycle policies:

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Keep last 30 prod images",
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["prod-"],
        "countType": "imageCountMoreThan",
        "countNumber": 30
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Delete untagged after 7 days",
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

**Replication cross-region** (DR, latencia global): Harbor y ECR replican por reglas; GHCR usa la red global de GitHub. Si tu producción vive en `us-east-1` y `eu-west-1`, replica el registry o pagarás egress cross-region en cada pull.

**Referrers API (OCI v1.1)**: en registries que la soportan (Harbor 2.10+, ECR 2024+, GHCR 2025+), SBOMs y firmas son adjuntables al mismo repositorio con `oras attach` y descubribles con `cosign tree` o `oras discover`. Si tu registry no la soporta, cosign hace fallback a "tag scheme" (sha256-abc.sig, sha256-abc.att) que ensucia el listado.

---

## 10. Ejercicios verificables

**Ejercicio 1 — Scan diferencial.** Toma dos versiones de tu imagen: una con base `node:20-alpine3.20` y otra con `gcr.io/distroless/nodejs20-debian12:nonroot`. Ejecuta `trivy image --severity HIGH,CRITICAL` sobre ambas. Cuenta CVEs. Documenta reducción y la clase de vulnerabilidad que desaparece (típicamente CVEs de paquetes shell y utilidades no usadas).

**Ejercicio 2 — SBOM + Grype.** Genera SBOM con `syft ghcr.io/miorg/miapp:test -o cyclonedx-json > sbom.json`. Sube al repo como artifact. Escanéalo con `grype sbom:./sbom.json`. Verifica que el conteo de CVEs coincide con `grype ghcr.io/miorg/miapp:test`.

**Ejercicio 3 — Firma keyless.** En un workflow de GitHub Actions añade `cosign sign --yes` al push. Después ejecuta `cosign verify --certificate-identity-regexp='.*/actions/.*' --certificate-oidc-issuer='https://token.actions.githubusercontent.com' <img>`. Debe verificar. Cambia el `identity-regexp` a algo incorrecto y confirma que falla.

**Ejercicio 4 — Kyverno bloquea sin firma.** Instala Kyverno en un cluster kind local. Aplica la ClusterPolicy `verify-image-signatures` del §6. Intenta desplegar una imagen sin firma; debe ser rechazada con `admission webhook denied`. Firma la imagen; debe pasar.

**Ejercicio 5 — Pull-through cache.** En una cuenta AWS gratuita crea un pull-through cache para Docker Hub. Modifica un `Deployment` para usar `123456789012.dkr.ecr.us-east-1.amazonaws.com/dockerhub/library/redis:7-alpine`. Verifica con `aws ecr describe-images` que la imagen aparece cacheada tras el primer pull.

**Ejercicio 6 — Runtime hardening.** Toma un Deployment tuyo. Aplica el `securityContext` completo del §8 (nonRoot, readOnlyRoot, drop ALL, seccomp RuntimeDefault). Si el pod falla en arranque, diagnostica con `kubectl logs` y ajusta (probablemente escribe en un path que necesita `emptyDir`). Documenta las modificaciones necesarias en tu app.

**Referencia al simulacro:**

- Path del JSON: [`packages/content/src/tech/devops/sim-06-container-security-and-registries.json`](../../packages/content/src/tech/devops/sim-06-container-security-and-registries.json)
- ID interno: `devops-sim-06-container-security-and-registries`

---

## Navegación

- Prev: [Cap 05 — Fundamentos de Docker](./05-fundamentos-docker.md)
- Next: [Cap 07 — Fundamentos de Kubernetes →](./07-fundamentos-kubernetes.md)
