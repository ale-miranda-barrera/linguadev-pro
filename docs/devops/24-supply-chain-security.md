# Capítulo 24 — Supply Chain Security (SLSA, Sigstore, SBOM)

> **Focus:** Post-SolarWinds, Log4Shell y XZ Utils, la cadena de suministro de software es superficie de ataque de primer orden. Este capítulo cubre el framework **SLSA v1.2** (2025), **SBOM** en SPDX/CycloneDX, **firmado de artefactos con cosign + Sigstore keyless**, **in-toto attestations**, verificación de provenance, defensa contra dependency confusion y typosquatting, reproducible builds, y las obligaciones regulatorias emergentes (**EU Cyber Resilience Act 2024** con reporte de vulns explotadas en 24h desde septiembre 2026 y SBOM obligatorio para diciembre 2027).
> **Áreas:** Security · Compliance · CI/CD · DevSecOps
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- CI/CD con GitHub Actions (ver [cap 04 — github actions y jenkins](./04-github-actions-y-jenkins.md)).
- Docker + registries (ver [cap 05 — fundamentos docker](./05-fundamentos-docker.md), [cap 06 — container security y registries](./06-container-security-y-registries.md)).
- Fundamentos DevSecOps (ver [cap 22 — fundamentos devsecops](./22-fundamentos-devsecops.md)).
- Secrets management y KMS (ver [cap 23 — secrets management](./23-secrets-management-vault-kms.md)).
- Nociones criptográficas: firmas asimétricas, X.509, hash SHA-256.

**Glosario mínimo:**
- **Supply chain attack**: compromiso de un componente upstream (dependencia, build tool, CI/CD, mecanismo de update) que se propaga automáticamente a los consumidores downstream.
- **SLSA** (Supply-chain Levels for Software Artifacts): framework de OpenSSF con niveles progresivos de garantías sobre cómo se construyó un artefacto. Versión actual: **v1.2** (noviembre 2025).
- **SBOM** (Software Bill of Materials): inventario formal y legible por máquina de todos los componentes de un producto.
- **SPDX**: formato SBOM del Linux Foundation, ISO/IEC 5962. Actual: v3.0 (2024).
- **CycloneDX**: formato SBOM de OWASP, JSON/XML nativo. Actual: v1.6 (2024).
- **VEX** (Vulnerability Exploitability eXchange): declara si un CVE detectado en tu SBOM es realmente explotable en tu contexto.
- **Sigstore**: proyecto de Linux Foundation (2021) para firmar artefactos con OIDC keyless.
- **cosign**: CLI de Sigstore para firmar y verificar imágenes y otros artefactos.
- **Fulcio**: CA de Sigstore que emite certificados X.509 efímeros contra identidad OIDC.
- **Rekor**: transparency log de Sigstore donde queda constancia inmutable de cada firma.
- **in-toto**: framework de attestations que documentan cada paso del pipeline (source, build, test).
- **Provenance**: attestation firmada que declara "este artefacto se construyó desde X source, con Y builder, en Z timestamp".
- **Dependency confusion**: ataque donde un package público con el mismo nombre que uno interno se resuelve por accidente.
- **Typosquatting**: publicar packages con nombres similares (`react-native-camra` vs `react-native-camera`).
- **Reproducible build**: dos builds del mismo source producen artefactos byte-a-byte idénticos.
- **CRA** (Cyber Resilience Act): regulación UE 2024 con obligaciones progresivas hasta diciembre 2027.

**Setup mínimo:**

```bash
# 1. cosign (Sigstore CLI)
brew install cosign
cosign version
# GitVersion: 2.4.x (agosto 2026)

# 2. Syft para generar SBOM (Anchore)
brew install syft
syft version
# Version: 1.15.x

# 3. Grype para escanear SBOM contra CVEs
brew install grype
grype version

# 4. Trivy (multi-scanner) — versión 0.55+
brew install aquasecurity/trivy/trivy
trivy --version
# Version: 0.55.x

# 5. slsa-verifier para verificar provenance
brew install slsa-verifier

# 6. SLSA GitHub generator (usado como reusable workflow, no binario local)
# Ver ejemplo en §5.2

# 7. in-toto CLI para verificar layouts
pip install in-toto
in-toto-verify --help
```

---

## 1. El gran cuadro

**SolarWinds** (diciembre 2020) fue el wake-up call. APT29 comprometió el build system de Orion, inyectó un backdoor en un `.DLL` **firmado con el certificado legítimo de SolarWinds** y distribuyó el update malicioso a **18.000 clientes** incluyendo el Treasury Department, DHS, DoJ y Microsoft. Coste estimado global: **$100B+**. El vector no fue un CVE en el código de Orion: fue la **cadena de confianza del proceso de build**. En 2021 apareció **Log4Shell** (CVE-2021-44228) que mostró que una lib transitiva profundamente enterrada podía paralizar Fortune 500. En 2024 el mundo se enteró de **XZ Utils** (CVE-2024-3094), un backdoor plantado durante años por un mantenedor pacientemente construido como voluntario legítimo de un proyecto OSS. Cada incidente amplió el consenso: **la seguridad de tu código es solo la punta del iceberg**; la seguridad de todo lo que construye, distribuye y firma ese código es igualmente crítica.

La respuesta de la industria se articuló en tres pilares complementarios. **SBOM** responde a la pregunta "¿qué llevo dentro?" con un inventario formal legible por máquina de todas las dependencias directas y transitivas, versiones, licencias, hashes. **SLSA** responde a "¿cómo se construyó esto?" con un framework de niveles progresivos que exige provenance firmada, builders confiables, ephemeral runners y two-person review. **Sigstore** provee la infraestructura criptográfica para firmar artefactos sin la fricción histórica de GPG: **keyless signing** basado en identidad OIDC (GitHub Actions, Google Workspace, cualquier IdP), certificados X.509 efímeros emitidos por **Fulcio** y transparencia total en **Rekor**, un append-only log público. Los tres se complementan: SBOM lista los ingredientes, SLSA garantiza que la receta se siguió, Sigstore certifica que quien lo firmó es quien dice ser.

**SLSA v1.2** (noviembre 2025) es el estado del arte 2026. Reorganizó los niveles: **L1** exige provenance existente pero no verificada; **L2** exige provenance firmada por un build service confiable; **L3** exige plataforma de build hardened, ephemeral, con aislamiento entre tenants y provenance criptográficamente no-falsificable; **L4** consolidó y separó en tracks distintos (Source, Build, Deploy) con dos-person review. Para producción moderna, **SLSA L2 se alcanza en una tarde con GitHub Actions attestations**; L3 requiere un builder confiable (SLSA GitHub Generator, Google Cloud Build con specific config, o Tekton Chains). npm lanzó **Trusted Publishing** en 2023 con provenance integrada; PyPI hizo lo propio con `pypi-publish` action; los registries están estandarizando la exigencia de provenance en 2026.

Del lado regulatorio, la **EU Cyber Resilience Act (CRA)** cambió el juego para siempre. Adoptada en 2024, impone dos deadlines críticos: desde **11 de septiembre de 2026** los fabricantes deben reportar **vulnerabilidades explotadas activamente e incidentes severos en 24 horas** a ENISA; desde **11 de diciembre de 2027** el cumplimiento total exige **SBOM machine-readable obligatorio** que cubra al menos las top-level dependencies, junto a políticas de gestión de vulnerabilidades. Multas por incumplimiento: hasta **15M EUR o 2.5% de facturación global**. La consecuencia práctica es que en 2026 la generación de SBOM en CI y el firmado con cosign dejan de ser "buena práctica" para convertirse en **requisito legal**. Este capítulo cubre cada pieza con ejemplos reproducibles sobre **LinguaDev Pro** y termina con ejercicios verificables.

---

## 2. Ataques de supply chain: casos reales

### 2.1 Categorías

1. **Compromiso de dependencia OSS**: mantenedor comprometido o malicioso publica versión con malware. Ejemplos: `event-stream` (2018), `colors.js`/`faker.js` (2022 sabotaje), `XZ Utils` (2024).
2. **Compromiso del build system**: atacante penetra el CI/CD y modifica el binario antes del firmado. Ejemplo: **SolarWinds** (2020), **Codecov** bash uploader (2021).
3. **Registry compromise**: typosquatting o dependency confusion. Ejemplos: `crossenv` vs `cross-env`, ataque a Amazon/Netflix/Uber (2021 Alex Birsan).
4. **Update mechanism hijack**: firma legítima usada para distribuir malware. Ejemplo: **NotPetya** (2017, actualizador M.E.Doc en Ucrania).
5. **Compromiso del source repo**: force-push de código malicioso, PhpMyAdmin (2012), **PyTorch nightly** (2022).

### 2.2 XZ Utils (CVE-2024-3094): la lección de 2024

Durante 2 años un mantenedor con identidad `Jia Tan` construyó reputación como contributor voluntario de XZ Utils (lib de compresión usada por sshd en muchas distros Linux). En marzo 2024 publicó versiones 5.6.0 y 5.6.1 con un **backdoor sofisticado** disparado solo por RSA keys específicas contra sshd, oculto en test files binarios y en el M4 macros durante `./configure`. Fue descubierto por Andres Freund (Microsoft/Postgres) porque notó **500ms extra en autenticación SSH**. Sin ese descubrimiento accidental, hoy sshd de Debian testing, Fedora rawhide y OpenSUSE Tumbleweed llevarían la puerta trasera.

**Lecciones**:
- Los tests binarios opacos son un vector; auditar builds reproducibles habría facilitado detección.
- Mantenedores solitarios en libs críticas son riesgo sistémico.
- Detección requiere anomaly detection en runtime, no solo scanners estáticos.
- SBOM habría facilitado inventariado del blast radius; SLSA L3+ habría dificultado la inyección.

### 2.3 Dependency confusion (Alex Birsan, 2021)

Alex Birsan publicó paquetes en npm/PyPI/RubyGems con nombres idénticos a paquetes **internos** de Apple, Microsoft, Uber, Tesla. Cuando el instalador resolvía dependencias, prefirió los públicos (versión más alta), ejecutando código de Birsan en pipelines corporativos. Bounty combinado: **$130k**. Defensa:

- **Scoped packages**: usar `@linguadev/tutor-shared` en vez de `tutor-shared`.
- **npm registry namespace claim**: reservar scope oficial en npm público aunque uses interno.
- **Lockfiles con integrity**: `package-lock.json` con `integrity: sha512-...`.
- **Configurar el registry interno** con `always-auth` y `.npmrc` que fuerce el interno para scope propio.

---

## 3. SBOM: inventario legible por máquina

### 3.1 Formatos: SPDX vs CycloneDX

**SPDX 3.0** (Linux Foundation, ISO/IEC 5962):
- Más maduro, adopción amplia.
- Formatos: tag-value, JSON, YAML, XML, RDF.
- Fuerte enfoque en licencias.

**CycloneDX 1.6** (OWASP):
- Más moderno, JSON/XML nativos.
- Incluye VEX embebido.
- Preferido en herramientas modernas de container security.

**Regla práctica en 2026**: generar ambos si tu tooling lo permite. Muchas orgs eligen CycloneDX como primario y SPDX como alternativo para compatibilidad con procurement.

### 3.2 Generar SBOM con Syft

```bash
# SBOM de una imagen Docker
syft linguadev/tutor:1.2.0 -o cyclonedx-json=sbom.cdx.json
syft linguadev/tutor:1.2.0 -o spdx-json=sbom.spdx.json

# SBOM de un directorio local (source-based)
syft dir:./apps/tutor-service -o cyclonedx-json=sbom-source.cdx.json

# Incluir file-level detail (más grande pero más preciso)
syft linguadev/tutor:1.2.0 --scope all-layers -o cyclonedx-json=sbom.cdx.json
```

Estructura mínima CycloneDX:

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "serialNumber": "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
  "version": 1,
  "metadata": {
    "timestamp": "2026-08-13T10:30:00Z",
    "tools": [{ "vendor": "anchore", "name": "syft", "version": "1.15.0" }],
    "component": {
      "type": "container",
      "name": "linguadev/tutor",
      "version": "1.2.0",
      "purl": "pkg:docker/linguadev/tutor@1.2.0"
    }
  },
  "components": [
    {
      "type": "library",
      "name": "express",
      "version": "4.21.1",
      "purl": "pkg:npm/express@4.21.1",
      "licenses": [{ "license": { "id": "MIT" } }],
      "hashes": [{ "alg": "SHA-256", "content": "abc123..." }]
    }
  ]
}
```

### 3.3 SBOM en CI: workflow completo

```yaml
# .github/workflows/sbom.yml
name: SBOM + Vulnerability Scan
on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: write
  packages: write
  id-token: write
  attestations: write
  security-events: write

jobs:
  sbom:
    runs-on: ubuntu-24.04
    outputs:
      image-digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@v4

      - name: Login GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build & push
        id: push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/linguadev/tutor:${{ github.ref_name }}
          provenance: mode=max
          sbom: true

      - name: Generate SBOM with Syft
        uses: anchore/sbom-action@v0
        with:
          image: ghcr.io/linguadev/tutor@${{ steps.push.outputs.digest }}
          format: cyclonedx-json
          output-file: sbom.cdx.json

      - name: Attest SBOM (GitHub native)
        uses: actions/attest-sbom@v2
        with:
          subject-name: ghcr.io/linguadev/tutor
          subject-digest: ${{ steps.push.outputs.digest }}
          sbom-path: sbom.cdx.json
          push-to-registry: true

      - name: Scan SBOM with Grype
        uses: anchore/scan-action@v5
        with:
          sbom: sbom.cdx.json
          fail-build: true
          severity-cutoff: high
          output-format: sarif
          output-file: grype.sarif

      - name: Upload Grype SARIF
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: grype.sarif
          category: grype

      - name: Upload SBOM as release asset
        uses: softprops/action-gh-release@v2
        with:
          files: |
            sbom.cdx.json
```

---

## 4. SLSA framework: build integrity

### 4.1 Los niveles v1.2

| Nivel | Producer requirements | Provenance requirements | Casos típicos |
|-------|----------------------|-------------------------|---------------|
| L1 | Build script existente | Existe, contenido no verificado | Cumplimiento mínimo, desarrollo interno |
| L2 | Version control + hosted build platform | Firmada por build service, resistente a manipulación básica | Producción estándar; alcanzable con GitHub Actions attestations en una tarde |
| L3 | Build platform hardened, ephemeral, isolated | No falsificable por tenants; source y build resistentes a threats específicos | Producción crítica; requiere SLSA GitHub Generator o equivalente |
| L4 (deprecated/consolidado) | Two-person review + hermetic builds + reproducible builds | Track separado en v1.2 | Sistemas de máxima confianza (Google Borg internal) |

### 4.2 Provenance format (SLSA v1.2)

Un provenance es un JSON firmado que declara: qué se construyó (subject), quién lo construyó (builder), desde qué source (materials), con qué invocation (parameters). Ejemplo:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    {
      "name": "ghcr.io/linguadev/tutor",
      "digest": {
        "sha256": "abc123def456..."
      }
    }
  ],
  "predicateType": "https://slsa.dev/provenance/v1",
  "predicate": {
    "buildDefinition": {
      "buildType": "https://actions.github.io/buildtypes/workflow/v1",
      "externalParameters": {
        "workflow": {
          "ref": "refs/tags/v1.2.0",
          "repository": "https://github.com/linguadev/monorepo",
          "path": ".github/workflows/release.yml"
        }
      },
      "internalParameters": {
        "github": {
          "event_name": "push",
          "repository_id": "12345678",
          "repository_owner_id": "1234"
        }
      },
      "resolvedDependencies": [
        {
          "uri": "git+https://github.com/linguadev/monorepo@refs/tags/v1.2.0",
          "digest": { "gitCommit": "abcdef123..." }
        }
      ]
    },
    "runDetails": {
      "builder": {
        "id": "https://github.com/actions/runner/github-hosted"
      },
      "metadata": {
        "invocationId": "https://github.com/linguadev/monorepo/actions/runs/999999",
        "startedOn": "2026-08-13T10:00:00Z",
        "finishedOn": "2026-08-13T10:07:32Z"
      }
    }
  }
}
```

### 4.3 GitHub Actions attestations: SLSA L2/L3 en una acción

```yaml
# .github/workflows/release.yml
name: Release with SLSA provenance
on:
  push:
    tags: ['v*']

permissions:
  contents: read
  packages: write
  id-token: write    # requerido para OIDC → Sigstore
  attestations: write

jobs:
  build-and-attest:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Login GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build & push image
        id: push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/linguadev/tutor:${{ github.ref_name }}
          provenance: mode=max     # habilita provenance del builder
          sbom: true

      - name: Attest build provenance (SLSA L3)
        uses: actions/attest-build-provenance@v2
        with:
          subject-name: ghcr.io/linguadev/tutor
          subject-digest: ${{ steps.push.outputs.digest }}
          push-to-registry: true
```

El action `actions/attest-build-provenance@v2` firma la provenance con la identidad OIDC del workflow, la sube a Sigstore Rekor y la asocia con el digest de la imagen en el registry. Downstream, cualquiera puede verificar con `gh attestation verify`.

### 4.4 Verificar provenance downstream

```bash
# Con GitHub CLI (integrado con Sigstore verification)
gh attestation verify oci://ghcr.io/linguadev/tutor:v1.2.0 \
  --owner linguadev
# ✓ Verification succeeded!
# Loaded 1 attestations from GitHub API
# The following policy criteria will be enforced:
# - OIDC issuer: https://token.actions.githubusercontent.com
# - Source Repository Owner URI: https://github.com/linguadev
# - Predicate type: https://slsa.dev/provenance/v1

# Con slsa-verifier (equivalente sin dependencia de gh CLI)
slsa-verifier verify-image ghcr.io/linguadev/tutor:v1.2.0 \
  --source-uri github.com/linguadev/monorepo \
  --source-tag v1.2.0
```

---

## 5. Sigstore y cosign

### 5.1 Arquitectura Sigstore

- **cosign**: CLI para firmar y verificar. Firma imágenes OCI, blobs, attestations.
- **Fulcio**: CA pública que emite certificados X.509 efímeros (~10 min) contra identidad OIDC. Sin gestión de claves.
- **Rekor**: transparency log append-only (Merkle tree, similar a Certificate Transparency). Cada firma queda registrada públicamente.
- **fulcio + rekor + cosign** habilitan **keyless signing**: no hay clave privada persistente que proteger. El OIDC token acredita quién sos; Fulcio emite cert efímero; cosign firma con ese cert; Rekor archiva la evidencia.

### 5.2 Firmar imagen con cosign keyless

```yaml
# En el workflow, después de build & push
- name: Install cosign
  uses: sigstore/cosign-installer@v3
  with:
    cosign-release: v2.4.0

- name: Sign image (keyless via GitHub OIDC)
  env:
    COSIGN_EXPERIMENTAL: '1'
  run: |
    cosign sign --yes \
      ghcr.io/linguadev/tutor@${{ steps.push.outputs.digest }}
```

El comando no requiere clave privada local. Detecta el entorno GitHub Actions, solicita el JWT OIDC, lo intercambia con Fulcio por un cert efímero, firma la imagen y publica la firma en Rekor. Todo en 3 segundos.

### 5.3 Verificar firma en admission controller

```bash
# Verificación básica (identidad OIDC + repo)
cosign verify \
  --certificate-identity-regexp "^https://github.com/linguadev/monorepo/\.github/workflows/.+@refs/tags/v.+" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/linguadev/tutor:v1.2.0
```

En Kubernetes se usa un admission controller que bloquea pods con imágenes no firmadas. **Sigstore Policy Controller** es el estándar OSS 2026:

```yaml
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: require-linguadev-signature
spec:
  images:
    - glob: "ghcr.io/linguadev/*"
  authorities:
    - keyless:
        url: https://fulcio.sigstore.dev
        identities:
          - issuer: https://token.actions.githubusercontent.com
            subjectRegExp: ^https://github.com/linguadev/monorepo/\.github/workflows/.+@refs/tags/v.+
        ctlog:
          url: https://rekor.sigstore.dev
```

### 5.4 Firmar attestations (no solo la imagen)

```bash
# Firmar SBOM como attestation asociada a la imagen
cosign attest --yes \
  --predicate sbom.cdx.json \
  --type cyclonedx \
  ghcr.io/linguadev/tutor@${DIGEST}

# Verificar la attestation
cosign verify-attestation \
  --certificate-identity-regexp "..." \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --type cyclonedx \
  ghcr.io/linguadev/tutor@${DIGEST}
```

Attestations soportadas: `slsaprovenance`, `spdx`, `cyclonedx`, `vuln`, custom types via `--type`.

---

## 6. in-toto y layouts

### 6.1 in-toto en una frase

**in-toto** define un **layout** firmado que declara los **pasos** del pipeline (source, build, test, package), qué **materials/products** produce cada paso, y qué **functionaries** (identidades) están autorizados a firmar cada paso. Al final, el consumidor verifica todo el pipeline against el layout: cada paso ocurrió, con las inputs correctas y firmadas por la persona/servicio autorizado.

SLSA provenance es un caso específico de attestation in-toto. La generalización de in-toto permite modelar pipelines complejos con múltiples firmantes.

### 6.2 Ejemplo minimalista de layout

```json
{
  "signed": {
    "_type": "layout",
    "expires": "2027-01-01T00:00:00Z",
    "keys": {
      "keyid-owner": { "keytype": "ed25519", "keyval": {"public": "..."} }
    },
    "steps": [
      {
        "name": "clone",
        "expected_command": ["git", "clone"],
        "pubkeys": ["keyid-owner"],
        "expected_materials": [],
        "expected_products": [["ALLOW", "*.js"], ["ALLOW", "*.ts"]]
      },
      {
        "name": "build",
        "expected_command": ["npm", "run", "build"],
        "pubkeys": ["keyid-owner"],
        "expected_materials": [["MATCH", "*.ts", "WITH", "PRODUCTS", "FROM", "clone"]],
        "expected_products": [["ALLOW", "dist/*.js"]]
      }
    ],
    "inspect": [
      {
        "name": "verify-bundle",
        "expected_command": ["sha256sum", "dist/app.js"]
      }
    ]
  },
  "signatures": [{"keyid": "keyid-owner", "sig": "..."}]
}
```

En 2026 la mayoría de orgs no escriben layouts a mano: usan **SLSA GitHub Generator** o **Tekton Chains** que producen attestations in-toto compatibles automáticamente.

---

## 7. Dependency confusion y typosquatting: defensas

### 7.1 Configuración npm segura

```ini
# .npmrc en el root del monorepo
@linguadev:registry=https://npm.internal.linguadev.dev/
registry=https://registry.npmjs.org/
always-auth=true

# Verificación de integridad obligatoria
package-lock=true
lockfile-version=3

# Bloquear postinstall scripts de deps no auditadas
ignore-scripts=false
```

Reglas complementarias:
- **Scoped packages** para todo lo interno (`@linguadev/*`).
- **Reservar el scope** en npm público aunque no publiques ahí, para evitar squatting.
- **Renovate/Dependabot** actualiza `package-lock.json` con hashes SHA512 integrity.
- **Deshabilitar auto-execute** de postinstall scripts en CI (variable `NPM_CONFIG_IGNORE_SCRIPTS=true` para stages no-build).

### 7.2 Bloquear typosquatting con Socket, Snyk o npq

**Socket.dev** (2022+) analiza cada nueva dep en el PR y detecta comportamiento sospechoso: instalación de shells, network calls a IPs raras, obfuscación. En 2026 es adopción amplia como GitHub App gratuito para OSS.

```yaml
# GitHub App instalado; sin workflow adicional necesario. Socket comenta en cada PR.
# Config opcional en socket.yml:
version: 2
projectIgnorePaths:
  - 'test/fixtures/**'
issueRules:
  malware: error
  gptSecurity: error
  networkAccess: warn
  filesystemAccess: warn
```

---

## 8. Reproducible builds

### 8.1 Qué es y por qué importa

Un build es **reproducible** si dos ejecuciones sobre el mismo commit producen artefactos **byte-a-byte idénticos**. Requiere eliminar toda fuente de no-determinismo: timestamps, uid/gid, orden de archivos, paths absolutos, semillas aleatorias.

**Por qué importa**: reproducibilidad permite que cualquiera verifique que un binario firmado se corresponde con el source publicado. Es la defensa fundamental contra ataques como SolarWinds: si el binario oficial no reproduce el build local desde el source declarado, algo se inyectó en el pipeline.

### 8.2 Técnicas prácticas para Docker

```dockerfile
# Build reproducible con Docker BuildKit
# syntax=docker/dockerfile:1.9
FROM node:22.9.0-alpine@sha256:0abc123... AS build
WORKDIR /app

# 1. SOURCE_DATE_EPOCH normaliza timestamps
ENV SOURCE_DATE_EPOCH=1700000000

# 2. Copiar por hash del lockfile primero (cache layer estable)
COPY package.json package-lock.json ./
RUN npm ci --frozen-lockfile

# 3. Ordenar archivos al copiar (find + sort)
COPY . .
RUN find /app -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

# 4. Build determinístico
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:def456...
COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules
CMD ["/app/dist/server.js"]
```

Buildkit con `--output type=image,rewrite-timestamp=true` y digest pinning para todas las stages garantiza reproducibilidad. Verificación: `docker buildx build` dos veces y comparar digests del image final.

---

## 9. EU Cyber Resilience Act y compliance 2026

### 9.1 Timeline

- **10 de diciembre de 2024**: entrada en vigor del reglamento.
- **11 de septiembre de 2026**: obligación de reporte a ENISA en 24h desde el conocimiento de una vulnerabilidad activamente explotada o de un incidente severo.
- **11 de diciembre de 2027**: cumplimiento total con requisitos técnicos (SBOM machine-readable de top-level deps, secure-by-design, gestión de vulnerabilidades, updates gratis y automáticos durante el período de soporte declarado).
- **Multas**: hasta **15M EUR o 2.5% de facturación global**, la mayor.

### 9.2 Qué hay que hacer YA en 2026

1. **Generar SBOM en CI para cada release**: Syft + `actions/attest-sbom@v2`.
2. **Firmar imágenes con cosign keyless**: `actions/attest-build-provenance@v2`.
3. **Escanear SBOM contra CVEs**: Grype/Trivy en CI con fail-on-high.
4. **Publicar policy de disclosure** (SECURITY.md en repo + email para reportes).
5. **Establecer proceso interno de triage 24h**: on-call security con playbook de respuesta a vuln crítica.
6. **Mantener SBOM histórica** de todos los releases activos (para responder retroactivamente ante nuevas CVEs).

### 9.3 SBOM mínima según CRA

- **Nombre del componente y versión exacta**.
- **Identificador único** (purl o cpe).
- **Proveedor** (autor/mantenedor).
- **Relación de dependencia** (directa / transitiva).
- **Timestamp de generación**.
- **Author del SBOM** (herramienta usada).
- **Machine-readable format**: SPDX o CycloneDX aceptados explícitamente.

### 9.4 VEX: separando "presente" de "explotable"

Grype sobre un SBOM típico devuelve **cientos de CVEs**. La mayoría no son explotables en tu contexto: quizá la función vulnerable no se llama nunca, o el dato de entrada está saneado antes, o la ruta código nunca se alcanza desde tu API pública. **VEX** (Vulnerability Exploitability eXchange) es el formato para declarar explícitamente el estatus de cada CVE:

- `not_affected` (con justificación: `component_not_present`, `vulnerable_code_not_present`, `vulnerable_code_not_in_execute_path`, `vulnerable_code_cannot_be_controlled_by_adversary`, `inline_mitigations_already_exist`).
- `affected` (necesita fix o mitigación).
- `fixed` (parche aplicado).
- `under_investigation`.

VEX se genera con herramientas como `openvex` o embebido en CycloneDX. Publicar VEX junto al SBOM reduce el ruido para los consumidores downstream de forma dramática y es requisito emergente en procurement enterprise 2026.

```json
{
  "@context": "https://openvex.dev/ns/v0.2.0",
  "@id": "https://linguadev.dev/vex/tutor-v1.2.0",
  "author": "security@linguadev.dev",
  "timestamp": "2026-08-13T10:00:00Z",
  "version": 1,
  "statements": [
    {
      "vulnerability": { "name": "CVE-2024-XXXXX" },
      "products": [
        { "@id": "pkg:oci/tutor@sha256:abc123..." }
      ],
      "status": "not_affected",
      "justification": "vulnerable_code_not_in_execute_path",
      "impact_statement": "El path vulnerable de la lib X solo se invoca desde el módulo CLI que no se compila en la imagen production."
    }
  ]
}
```

### 9.5 Reciprocidad con SEC US y otras jurisdicciones

- **SEC Cybersecurity Disclosure Rules** (US, 2023): companies públicas reportan incidents materiales en 4 días laborales.
- **UK PSTI** (2024): productos IoT deben tener política de vuln disclosure y ventana de soporte declarada.
- **NIST SSDF** (US, EO 14028): SBOM + secure development attestations para vendors federales.
- **Japón METI SBOM guidelines** (2024, adopción voluntaria).

Estrategia práctica en 2026 para orgs con presencia global: **generar SBOM + provenance + VEX en cada release y publicarlos**. Con eso cumples de facto la parte técnica de todas las regulaciones anteriores; el resto son procesos (disclosure policy, incident response) documentables una sola vez.

---

## 10. Ejercicios prácticos sobre LinguaDev Pro

### Ejercicio 1: SBOM + Grype scan en CI (45 min)

**Objetivo**: generar y escanear SBOM en cada release del tutor.

**Pasos**:
1. Copiar workflow del §3.3 a `.github/workflows/sbom.yml`.
2. Adaptar imagen a `ghcr.io/linguadev/tutor`.
3. Hacer tag `v0.1.0-test` y observar CI.
4. Descargar el SBOM asset del release y validar con `syft convert sbom.cdx.json -o spdx-json`.

**Verificación**:

```bash
syft attest linguadev/tutor:v0.1.0-test | jq '.predicate.components | length'
# > 100 (dependencias listadas)

grype sbom:./sbom.cdx.json --fail-on high
# Exit 0 si no hay HIGH/CRITICAL; exit 1 si sí.
```

### Ejercicio 2: SLSA L3 provenance con GitHub Actions (60 min)

**Objetivo**: adjuntar provenance verificable a cada release.

**Pasos**:
1. Copiar workflow del §4.3 a `.github/workflows/release.yml`.
2. Verificar `permissions: id-token: write` y `attestations: write`.
3. Tag `v0.2.0-slsa` y observar la attestation en el registry.
4. Verificar downstream con `gh attestation verify oci://ghcr.io/linguadev/tutor:v0.2.0-slsa --owner linguadev`.

**Verificación**:

```bash
gh attestation verify oci://ghcr.io/linguadev/tutor:v0.2.0-slsa \
  --owner linguadev \
  --predicate-type https://slsa.dev/provenance/v1
# ✓ Verification succeeded!
```

### Ejercicio 3: Firmar imagen con cosign keyless + verificar (30 min)

**Objetivo**: firmar con Sigstore y verificar identidad.

**Pasos**:
1. Añadir step de cosign install + sign al workflow (§5.2).
2. Tag `v0.3.0-signed`.
3. Local: `cosign verify --certificate-identity-regexp "^https://github.com/linguadev/monorepo/.+" --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/linguadev/tutor:v0.3.0-signed`.

**Verificación**:

```bash
cosign tree ghcr.io/linguadev/tutor:v0.3.0-signed
# Muestra árbol: imagen + signature + attestations asociadas

# Buscar en Rekor
rekor-cli search --sha $(cosign triangulate ghcr.io/linguadev/tutor:v0.3.0-signed --type digest)
```

### Ejercicio 4: Policy Controller bloqueando imágenes no firmadas (60 min)

**Objetivo**: en Kubernetes lab, rechazar cualquier pod que use imagen sin firma Sigstore de linguadev.

**Pasos**:
1. Instalar Sigstore Policy Controller (`helm install policy-controller sigstore/policy-controller`).
2. Aplicar `ClusterImagePolicy` del §5.3.
3. Etiquetar namespace con `policy.sigstore.dev/include=true`.
4. Intentar deployar `nginx:latest` (falla) y `ghcr.io/linguadev/tutor:v0.3.0-signed` (OK).

**Verificación**:

```bash
kubectl label ns tutor policy.sigstore.dev/include=true
kubectl run test-nginx --image=nginx:latest -n tutor
# Error: admission webhook denied: no matching signatures

kubectl run test-tutor --image=ghcr.io/linguadev/tutor:v0.3.0-signed -n tutor
# pod/test-tutor created
```

### Ejercicio 5: Dependency confusion drill (45 min)

**Objetivo**: verificar que la config npm bloquea instalación accidental de package público con nombre `@linguadev/tutor-shared`.

**Pasos**:
1. Asegurar `.npmrc` del §7.1 en el monorepo.
2. Publicar (en test) `@linguadev/tutor-shared` **falso** en npm público con versión `999.0.0`.
3. Correr `npm install @linguadev/tutor-shared` desde el monorepo.
4. Verificar que resuelve contra el registry interno, no el público.

**Verificación**:

```bash
npm view @linguadev/tutor-shared version --registry https://npm.internal.linguadev.dev/
# 1.2.3 (versión interna)

npm view @linguadev/tutor-shared version --registry https://registry.npmjs.org/
# 999.0.0 (public falso)

npm ls @linguadev/tutor-shared
# └── @linguadev/tutor-shared@1.2.3 (interno, correcto)
```

### Ejercicio 6: CRA-ready SBOM + disclosure policy (60 min)

**Objetivo**: preparar el repo para cumplimiento CRA 2026-09-11.

**Pasos**:
1. Verificar que el workflow SBOM genera output CycloneDX y lo firma con cosign.
2. Publicar `SECURITY.md` con: alcance, canal de reporte (`security@linguadev.dev`), PGP key opcional, timeline de triage (24h/72h/30d).
3. Documentar el proceso interno de respuesta en `docs/security/vuln-response.md`.
4. Simular reporte de vuln crítica end-to-end (con equipo interno) y medir MTTR real.

**Verificación**:

```bash
gh release view v0.4.0-cra --json assets | jq '.assets[].name'
# ["sbom.cdx.json", "sbom.cdx.json.sig", "provenance.json"]

# El README debe linkear SECURITY.md, la política debe declarar procesos <24h.
```

**Simulacro asociado**: [`packages/content/src/tech/devops/sim-24-supply-chain-security.json`](../../packages/content/src/tech/devops/sim-24-supply-chain-security.json) (id `devops-sim-24-supply-chain-security`, 20 preguntas, 30 min, pass 75%).

---

## Navegación

- Anterior: [Capítulo 23 — Secrets Management (Vault, KMS)](./23-secrets-management-vault-kms.md)
- Siguiente: [Capítulo 25 — Policy as Code (OPA, Kyverno) →](./25-policy-as-code-opa-kyverno.md)
- Índice: [docs/devops](./)
