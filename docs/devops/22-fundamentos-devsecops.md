# Capítulo 22 — Fundamentos DevSecOps

> **Focus:** Integrar seguridad en TODO el SDLC en vez de tratarla como gate final. Shift-left en la práctica: IDE hooks, pre-commit, PR checks, build scans, deploy policies. SAST vs DAST vs SCA vs IAST comparados con precisión. Dependency scanning con Snyk, Dependabot, Renovate y GitHub Advanced Security. Container scanning con Trivy. Secret detection con gitleaks y trufflehog. Threat modeling con STRIDE. Security champions program. OWASP DevSecOps Maturity Model.
> **Áreas:** Security · CI/CD · Application security · Container security
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- CI/CD moderno con GitHub Actions o similar (ver [cap 04 — github actions y jenkins](./04-github-actions-y-jenkins.md)).
- Fundamentos de contenedores y registries (ver [cap 05 — fundamentos docker](./05-fundamentos-docker.md)).
- Container security base: imagen distroless, non-root, minimal (ver [cap 06 — container security y registries](./06-container-security-y-registries.md)).
- Kubernetes security: RBAC, PSP/PSA, NetworkPolicy (ver [cap 11 — kubernetes security](./11-kubernetes-security.md)).
- Familiaridad con OWASP Top 10 (web + API).

**Glosario mínimo:**
- **DevSecOps**: DevOps + security como responsabilidad compartida, automatizada en el pipeline. Acuñado por Gartner ~2012.
- **Shift-left**: mover checks de seguridad desde el final del SDLC (pentest pre-release) hacia fases tempranas (IDE, commit, PR, build).
- **SAST** (Static Application Security Testing): análisis del código fuente sin ejecutarlo. Ejemplos: Semgrep, CodeQL, SonarQube, Checkmarx.
- **DAST** (Dynamic Application Security Testing): pruebas contra la app corriendo (típicamente pentest automatizado black-box). Ejemplos: OWASP ZAP, Burp Suite, Netsparker.
- **SCA** (Software Composition Analysis): análisis de dependencias en busca de CVEs conocidas. Ejemplos: Snyk, Dependabot, Trivy, npm audit.
- **IAST** (Interactive Application Security Testing): sensor en runtime que observa el flujo de datos mientras hay tráfico. Combina fortalezas de SAST + DAST.
- **RASP** (Runtime Application Self-Protection): ejecuta dentro del proceso y bloquea ataques en tiempo real.
- **STRIDE**: framework de threat modeling de Microsoft (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege).
- **CVE**: identificador único de una vulnerabilidad publicada (base NVD).
- **CVSS**: sistema de scoring 0-10 para severidad de CVEs.
- **VEX** (Vulnerability Exploitability eXchange): declara si un CVE es explotable en tu contexto (no toda vuln en dep transitivo es alcanzable).
- **Security champion**: dev en cada equipo con formación adicional en security, actúa como enlace con el equipo de security central.
- **DSOMM**: OWASP DevSecOps Maturity Model, framework para evaluar madurez del programa.

**Setup mínimo:**

```bash
# 1. Semgrep (SAST OSS) para análisis local y en CI
brew install semgrep
semgrep --version
# 1.90.x (agosto 2026)

# 2. Trivy 0.55+ (SCA + container + IaC + secret) — el todo-en-uno referencia 2026
brew install aquasecurity/trivy/trivy
trivy --version
# Version: 0.55.x

# 3. gitleaks para detectar secretos en commits
brew install gitleaks
gitleaks version
# v8.20.x

# 4. trufflehog para historial completo del repo
brew install trufflehog
trufflehog --version

# 5. OWASP ZAP para DAST local
docker pull ghcr.io/zaproxy/zaproxy:stable

# 6. Snyk CLI (SaaS, requiere login gratis con cuenta GitHub)
npm install -g snyk
snyk auth

# 7. pre-commit framework para orquestar hooks locales
pip install pre-commit
pre-commit --version
```

---

## 1. El gran cuadro

El nombre **DevSecOps** apareció en 2012 y en 2026 ya no es novedad sino baseline. La tesis es simple: **la seguridad no puede ser un gate al final del pipeline**, porque en un pipeline moderno donde se despliega 20 veces al día, ese gate se convierte en cuello de botella y termina saltándose. La respuesta no es más security engineers al final —eso agrava el bottleneck— sino redistribuir la responsabilidad a lo largo del SDLC, con automatización que dé feedback inmediato a los devs, con security champions embebidos en cada equipo y con un equipo central que actúa como enabler (threat modelers, incident responders, políticas as-code) en vez de gatekeeper.

La curva de costo NIST/IBM es la justificación económica: un bug encontrado en design cuesta **$80**, en test **$960**, y en post-release **$7,600**. Multiplicá por la escala de un incidente real (Equifax pagó $700M+ por una vulnerabilidad no parcheada en Apache Struts) y la ecuación se vuelve absurda: **cualquier inversión en shift-left tiene ROI positivo**. La estructura práctica del pipeline DevSecOps moderno cubre seis fases con scanners específicos: **IDE** (linters inline en VSCode/JetBrains), **pre-commit** (gitleaks + secret detection), **PR** (SAST y SCA con GitHub Advanced Security o Snyk), **build** (container scan con Trivy, IaC scan con Checkov), **staging** (DAST con OWASP ZAP), **producción** (RASP y runtime observability con Falco).

El vocabulario técnico exige precisión. **SAST** analiza código fuente estático (Semgrep, CodeQL, Checkmarx), tiene alto ruido pero cobertura amplia; encuentra patrones como SQL injection en concatenación de strings. **DAST** ejecuta pruebas contra la app corriendo en staging (OWASP ZAP, Burp), tiene bajo ruido pero cobertura limitada al surface accesible externamente. **SCA** analiza dependencias contra bases de CVEs (Snyk, Dependabot, Trivy, GitHub dependency review), es la fuente de la mayoría de findings porque **el 80% del código de tu app es de terceros**. **IAST** instrumenta el runtime y observa flujos de datos con tráfico real (Contrast Security, Checkmarx IAST), combina fortalezas de los otros dos pero requiere agentes. La regla es: los cuatro son complementarios, no sustitutos.

El estado del arte 2026 tiene cinco componentes clave. Primero, **GitHub Advanced Security** es hoy plataforma dominante para orgs en GitHub: CodeQL (SAST propietario), Dependabot (SCA), Secret Scanning con Push Protection, Dependency Review action y desde 2024 attestations SLSA nativas. Segundo, **Snyk** compite en el segmento enterprise con SAST + SCA + IaC + container. Tercero, **Trivy** de Aqua es el open source de referencia con 31k+ stars: un solo binario que scanea dependencias, imágenes, IaC, secretos y K8s manifests con salida SARIF integrada a GHAS. Cuarto, **Renovate** desplaza a Dependabot en muchas orgs por su flexibilidad y policies (auto-merge de patches, grouping por ecosystem). Quinto, la **EU Cyber Resilience Act** entra en vigor con obligaciones críticas: reporte de vulnerabilidades explotadas en 24h desde el 11 de septiembre de 2026 y SBOM obligatorio para diciembre de 2027, empujando DevSecOps de "buena práctica" a "requisito legal". Este capítulo cubre la teoría, muestra código real en cada capa y termina con ejercicios verificables sobre **LinguaDev Pro**.

---

## 2. Shift-left: qué scanner en qué fase

### 2.1 La cascada de checks

Cada fase tiene su scanner y su costo de falso positivo. Diseñar bien la cascada significa **checks rápidos y baratos temprano** y **checks lentos y precisos después**.

| Fase | Ejemplo scanner | Tiempo aceptable | Falla el pipeline si… |
|------|-----------------|------------------|-----------------------|
| IDE | Semgrep VSCode, SonarLint | inline (< 500ms) | nunca (feedback educativo) |
| pre-commit | gitleaks, detect-secrets | < 10s | secretos detectados |
| PR check | Semgrep, CodeQL, Snyk, Trivy dep | < 5 min | vulns CRITICAL nuevos |
| Build | Trivy image, Checkov IaC | < 10 min | CVEs CRITICAL con fix disponible |
| Deploy | Cosign verify, policy engine | < 30s | imagen sin firma o firma inválida |
| Staging | OWASP ZAP baseline | 30 min-2h | vulns HIGH descubiertos |
| Prod | Falco, runtime WAF | continuo | comportamiento anómalo bloquea |

### 2.2 El principio 80/20 del gate

**Regla dura**: solo los checks con **alta precisión** deben bloquear el pipeline. Un scanner con 40% de falsos positivos que bloquea genera fatiga y termina siendo ignorado o silenciado. Preferí:

- **Bloquear**: secretos detectados, CVEs CRITICAL con fix disponible en dependencia directa, imagen sin firma, license prohibida (AGPL en producto propietario).
- **Warning**: CVEs HIGH sin fix, CVEs en dep transitivo lejano, hallazgos SAST de prioridad media.
- **Log-only**: detección de patterns "sospechosos" pero no confirmados.

---

## 3. SAST vs DAST vs SCA vs IAST

### 3.1 Comparativa precisa

| Dimensión | SAST | DAST | SCA | IAST |
|-----------|------|------|-----|------|
| Qué analiza | código fuente | app corriendo | dependencias | runtime instrumentado |
| Cuándo corre | pre-build | staging con tráfico | pre-build + monitor | staging o prod con agente |
| Idioma | atado al lenguaje | agnóstico | por ecosystem (npm/pip/mvn) | por lenguaje del agente |
| Requiere ejecutar | no | sí | no | sí |
| Falsos positivos | altos (30-70%) | bajos (10-20%) | bajos con VEX | muy bajos |
| Cobertura | amplia (todo el código) | limitada al surface externo | 100% del deps tree | amplia pero solo paths ejercitados |
| Encuentra | SQLi, XSS, hardcoded creds | vulns explotables reales | CVEs conocidas en deps | vulns con contexto real |
| No encuentra | vulns de config runtime | código no accedido | vulns 0-day | código no ejercitado |
| Ejemplos 2026 | Semgrep, CodeQL, Checkmarx | OWASP ZAP, Burp | Snyk, Dependabot, Trivy, Renovate | Contrast, Checkmarx IAST |

### 3.2 Cuándo usar cada uno

- **Todos los repos**: SAST (Semgrep/CodeQL) + SCA (Dependabot/Snyk/Trivy). Coverage universal, bajo esfuerzo con GitHub Advanced Security.
- **Apps web/API público**: añadir DAST (OWASP ZAP) contra staging tras cada deploy significativo.
- **Apps críticas con tráfico real**: añadir IAST en staging o pre-prod para vulns con contexto real.
- **Producción**: WAF + RASP + runtime detection (Falco). Es el "shift-right" complementario.

### 3.3 Ejemplo Semgrep en GitHub Actions

```yaml
# .github/workflows/sast.yml
name: SAST — Semgrep
on:
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 3 * * 1'  # scan completo lunes 03:00 UTC

permissions:
  contents: read
  security-events: write   # necesario para subir SARIF a GHAS
  pull-requests: write

jobs:
  semgrep:
    runs-on: ubuntu-24.04
    container: semgrep/semgrep:latest
    if: github.actor != 'dependabot[bot]'
    steps:
      - uses: actions/checkout@v4
      - name: Semgrep scan
        run: |
          semgrep ci \
            --config=p/owasp-top-ten \
            --config=p/typescript \
            --config=p/react \
            --config=p/nodejsscan \
            --sarif --output=semgrep.sarif \
            --error --severity=ERROR
      - name: Upload SARIF to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: semgrep.sarif
          category: semgrep
```

---

## 4. Dependency scanning en profundidad

### 4.1 Por qué es la prioridad #1

Estudios de 2025 (Sonatype, Snyk State of Open Source) confirman: **~85% del código de una app moderna es de terceros**. Log4Shell (CVE-2021-44228) mostró que un CVE crítico en una lib transitiva profunda puede paralizar Fortune 500 durante semanas. En 2026, el dependency scanning es **la línea de defensa más barata y de mayor ROI** en un programa DevSecOps.

### 4.2 Herramientas en 2026

- **GitHub Advanced Security — Dependabot**: nativo, gratuito para repos públicos, integrado con Security Advisories, PRs automáticos con changelog. Weak spot: bumps de una dep a la vez, no groups.
- **Renovate**: OSS de Mend, hoy más flexible que Dependabot: grouping por ecosystem, auto-merge por regex, schedule por tipo de dep. Ejemplo: agrupar todas las patch updates diarias, merge automático si CI verde.
- **Snyk**: SaaS con base propia (Snyk Vulnerability Database, más rápida que NVD en publicar), fix advice contextual, prioritization score que considera exploitability + reachability.
- **Trivy**: OSS de Aqua, `trivy fs .` scanea deps en segundos, integración SARIF con GHAS, soporta multi-ecosystem (npm, pip, maven, go, cargo, composer, gem).
- **GitHub Dependency Review action**: bloquea PRs que introducen deps con vulnerabilidades HIGH+ o licencias prohibidas. Integrado gratuito en repos con GHAS.

### 4.3 Renovate con auto-merge de patches

```json
// renovate.json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":dependencyDashboard"],
  "schedule": ["after 3am on monday"],
  "prConcurrentLimit": 10,
  "packageRules": [
    {
      "description": "Auto-merge de patches y minors si CI verde",
      "matchUpdateTypes": ["patch", "pin", "digest"],
      "automerge": true,
      "automergeType": "pr",
      "platformAutomerge": true,
      "matchCurrentVersion": "!/^0/"
    },
    {
      "description": "Agrupar dev dependencies",
      "matchDepTypes": ["devDependencies"],
      "groupName": "dev dependencies (non-major)",
      "matchUpdateTypes": ["patch", "minor"]
    },
    {
      "description": "Actualizaciones de seguridad urgentes",
      "matchDatasources": ["npm"],
      "matchPackageNames": ["*"],
      "vulnerabilityAlerts": {
        "labels": ["security", "urgent"],
        "prPriority": 100
      }
    }
  ],
  "vulnerabilityAlerts": {
    "enabled": true
  },
  "osvVulnerabilityAlerts": true
}
```

### 4.4 Dependency Review para bloquear introducciones dañinas

```yaml
# .github/workflows/dependency-review.yml
name: Dependency Review
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  dependency-review:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - name: Dependency Review
        uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: high
          deny-licenses: AGPL-3.0, GPL-3.0, LGPL-3.0
          comment-summary-in-pr: always
          vulnerability-check: true
          license-check: true
```

Este action bloquea cualquier PR que añada dependencias con CVE HIGH+ o licencias prohibidas, comentando en el PR con detalle. Zero configuración adicional.

---

## 5. Secret detection

### 5.1 Por qué escanear secretos

En 2024 GitHub reportó **más de 39 millones de secretos filtrados** en repositorios públicos. Bots automatizados escanean commits en segundos y explotan tokens en minutos. AWS mismo escanea GitHub y revoca keys expuestas automáticamente, pero muchos tokens (Slack, Stripe, third-party) no tienen esa protección.

### 5.2 gitleaks pre-commit

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.20.1
    hooks:
      - id: gitleaks
        name: Detect hardcoded secrets

  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: check-added-large-files
        args: ['--maxkb=1024']
      - id: detect-private-key
      - id: end-of-file-fixer
```

Instalación local:

```bash
pre-commit install
# Cada `git commit` corre gitleaks. Si detecta secret, aborta.

# Escaneo del historial completo (para auditoría):
gitleaks detect --source . --verbose --redact
```

### 5.3 GitHub Push Protection

Habilitá en `Settings > Code security > Secret scanning > Push protection`. Cuando GHAS detecta un patrón de secret (>200 partners: AWS, GCP, Stripe, Slack, GitHub PAT, etc.) al hacer `git push`, **rechaza el push** y muestra al dev exactamente qué archivo y línea. El único bypass legítimo requiere justificación escrita que queda en el audit log.

### 5.4 trufflehog para escaneo de historial

```bash
# Escanea todo el historial git en busca de secretos verificados
trufflehog git --repo=https://github.com/linguadev/monorepo \
  --only-verified \
  --json > trufflehog-report.json

# --only-verified: intenta autenticar contra el servicio real (elimina falsos positivos)
# Ejemplo: si detecta AKIA..., intenta STS get-caller-identity para confirmar
```

### 5.5 Qué hacer cuando un secret sí se filtra

Regla ordenada. **No borres el commit primero**: el atacante ya lo vio.

1. **Rotá el secret en el proveedor origen** (AWS: `aws iam delete-access-key` + crear nueva). Es la única mitigación real.
2. **Revocá tokens dependientes**: si el secret daba acceso a otras APIs, revocá las descendientes.
3. **Audita logs** del período de exposición: en AWS revisá CloudTrail buscando `AccessDenied` desde IPs desconocidas.
4. **Notificá al equipo AppSec y al owner del sistema** para post-mortem.
5. **Solo después** limpiá el historial con `git filter-repo --path secrets.env --invert-paths`. Recordá que forks o clones existentes retienen la copia; el rotate del paso 1 es lo único definitivo.

Documenta el incidente en el registro de security findings incluso si el impacto fue nulo — sirve para calibrar el programa de prevención (más hooks, formación adicional).

---

## 6. Container scanning en CI

### 6.1 Trivy en GitHub Actions

```yaml
# .github/workflows/container-security.yml
name: Container Security
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  security-events: write

jobs:
  build-and-scan:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build image (local, no push)
        uses: docker/build-push-action@v6
        with:
          context: .
          load: true
          tags: linguadev/tutor:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Trivy image scan
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: linguadev/tutor:${{ github.sha }}
          format: sarif
          output: trivy-image.sarif
          severity: CRITICAL,HIGH
          exit-code: '1'
          ignore-unfixed: true
          vuln-type: 'os,library'

      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy-image.sarif
          category: trivy-image

      - name: Trivy filesystem scan (secrets + config + IaC)
        uses: aquasecurity/trivy-action@0.28.0
        with:
          scan-type: fs
          scan-ref: .
          format: sarif
          output: trivy-fs.sarif
          severity: CRITICAL,HIGH
          scanners: vuln,secret,misconfig
```

Notas clave:
- `ignore-unfixed: true` evita bloquear por CVEs sin fix disponible.
- `severity: CRITICAL,HIGH` reduce ruido a lo accionable.
- `exit-code: '1'` hace que el step falle si hay hallazgos.
- Trivy 0.55+ acepta scanners combinados (vuln + secret + misconfig) en un solo pase.

### 6.2 Base image update strategy

- **Distroless** (`gcr.io/distroless/nodejs22-debian12:nonroot`): sin shell ni package manager, superficie mínima.
- **Alpine minimal**: superficie pequeña pero cuidado con musl libc issues en apps que asumen glibc.
- **Digest pinning obligatorio**: `FROM node:22.9.0@sha256:abc123...` para builds reproducibles.
- **Renovate para base images**: automatiza el bump del digest.

---

## 7. Threat modeling con STRIDE

### 7.1 Qué es STRIDE

Framework de Microsoft (2003) que categoriza amenazas en seis clases mnemotécnicas:

| Letra | Amenaza | Ejemplo | Mitigación |
|-------|---------|---------|------------|
| **S** | Spoofing | atacante se hace pasar por usuario | auth fuerte, MFA, OIDC |
| **T** | Tampering | modificar datos en tránsito o en reposo | TLS, firmas, hash |
| **R** | Repudiation | usuario niega haber hecho una acción | audit logs firmados, non-repudiation |
| **I** | Information disclosure | leak de datos sensibles | encryption at rest + in transit, least privilege |
| **D** | Denial of service | tumbar el servicio | rate limits, autoscaling, WAF |
| **E** | Elevation of privilege | escalar de usuario normal a admin | RBAC estricto, PoLP, sandbox |

### 7.2 Threat model práctico: endpoint `/api/lessons`

1. Dibujá el **data flow diagram** (Browser → API Gateway → Lambda → DynamoDB).
2. Identificá **trust boundaries** (WAN/VPC, VPC/subnet privada).
3. Aplicá STRIDE en cada componente y cada flow.
4. Documentá amenazas + mitigaciones actuales + gaps.

Ejemplo tabla resumen:

| Componente | Amenaza STRIDE | Mitigación actual | Gap |
|------------|----------------|-------------------|-----|
| Browser → API GW | Tampering | TLS 1.3 obligatorio | HSTS preload pendiente |
| API GW | Spoofing | JWT firmado con Cognito | rotar signing key |
| Lambda | Info disclosure | logs sin PII | falta VEX en deps |
| DynamoDB | Elevation | IAM condition per-tenant | audit trail incompleto |

### 7.3 Threat modeling en design reviews

Institucionalizar: **todo diseño nuevo con impacto de datos personales o cross-tenant requiere threat model documentado antes de code-review**. El template STRIDE de 1 hora es asumible por cualquier tech lead.

---

## 8. Security champions program

### 8.1 Estructura

Un security champion es un dev **embebido en cada squad** con:

- 10-20% de su tiempo dedicado a security.
- Formación acelerada (curso OWASP, laboratorios internos).
- Acceso al Slack privado del equipo AppSec central.
- Responsabilidad de triage inicial de findings de scanners.

**Ratio ideal**: 1 champion cada 5-10 devs. Con 100 devs: ~15 champions distribuidos en 15 squads.

### 8.2 Por qué funciona

- **Escala**: el equipo AppSec (típicamente 3-8 personas para 100 devs) no puede revisar todo.
- **Contexto**: el champion entiende el código de su squad mejor que un AppSec externo.
- **Proximidad**: el champion educa al resto del squad de forma orgánica.
- **Carrera**: senior devs interesados en security tienen un path claro hacia rol AppSec eventual.

### 8.3 Métricas del programa

- % squads con champion asignado (meta: 100% en 12 meses).
- Champions activos (participación en syncs semanales).
- Reducción de findings en pentest final (baseline vs post-programa).
- MTTR de vulns críticos (mediana días para fix).

---

## 9. OWASP DevSecOps Maturity Model (DSOMM)

### 9.1 Ejes de evaluación

DSOMM define 4 dimensiones y 4 niveles de madurez cada una:

| Dimensión | Nivel 1 (básico) | Nivel 4 (avanzado) |
|-----------|------------------|--------------------|
| **Build & Deployment** | build automatizado | build reproducible + firmado + attestations SLSA 3 |
| **Culture & Organization** | security team separado | champions en todos los squads + threat modeling en design |
| **Implementation** | linters básicos | SAST + SCA + secret + IaC + container + DAST integrados |
| **Information Gathering** | logs centralizados | SIEM + IR runbooks + threat intel feeds |

### 9.2 Cómo usarlo

1. **Assessment inicial**: entrevistas por dimensión con leads técnicos. Puntúa 1-4.
2. **Roadmap trimestral**: elegir 2-3 áreas con más gap y menor coste.
3. **Reasessment anual**: medir progreso.

Muchas orgs empiezan en Nivel 1-2 en Implementation y Nivel 1 en Culture. El salto más rentable suele ser: **añadir Dependabot + gitleaks + Trivy en CI + nombrar champions** (llega a Nivel 3 en Implementation en un trimestre).

### 9.3 Anti-patrones del programa DevSecOps

- **Security como "quality gate" externo**: bloquear releases con reviews humanos manuales al final. Recrea el silo que DevSecOps supuestamente eliminó.
- **Sin ownership por severity**: findings CRITICAL sin dueño explícito, se acumulan en el backlog "de seguridad" durante meses.
- **Métricas de vanidad**: "número de findings escaneados/mes" sin trackear MTTR ni closure rate. Un scanner que emite 10.000 findings ignorados no aporta.
- **Falta de threat model**: parchear vulns reactivamente sin entender el modelo de amenazas del producto genera trabajo sin prioridad.
- **Champions sin tiempo real**: nominar champions sin liberar % de su capacidad convierte el rol en carga extra que nadie ejerce.

### 9.4 KPIs recomendados en 2026

| KPI | Objetivo | Cadencia | Fuente |
|-----|----------|----------|--------|
| MTTR vulns CRITICAL | < 7 días | mensual | GHAS Security Alerts |
| MTTR vulns HIGH | < 30 días | mensual | GHAS |
| % PRs con SAST + SCA passing | > 98% | semanal | GitHub Actions |
| Secretos leaked/mes | 0 (con push protection) | mensual | GHAS Secret Scanning |
| Squads con champion activo | 100% | trimestral | interna |
| Threat models actualizados/quarter | ≥ 1 por servicio crítico | trimestral | interna |
| Cobertura de imágenes escaneadas | 100% pre-deploy | continua | Trivy + registry policy |

---

## 9-bis. Compliance emergente en 2026

### EU Cyber Resilience Act (CRA)

La CRA entró en vigor en 2024 y obliga a los fabricantes de "productos con elementos digitales" comercializados en la UE:

- **11 de septiembre de 2026**: reporte obligatorio de vulnerabilidades explotadas activamente y de incidentes severos a ENISA en **24 horas** desde el conocimiento.
- **11 de diciembre de 2027**: cumplimiento total con requisitos técnicos, incluyendo **SBOM obligatorio** (top-level dependencies mínimo, formato machine-readable).
- Multas por incumplimiento: hasta **15M EUR o 2.5% de facturación global**.

Consecuencia práctica para DevSecOps: SBOM generation en CI deja de ser opcional. Ver capítulo 24 para el detalle técnico (Syft, SPDX, CycloneDX).

### SLSA como baseline

Muchos clientes enterprise en 2026 exigen atestaciones **SLSA nivel 2 o 3** en contratos B2B. GitHub Actions con `actions/attest-build-provenance` genera provenance L3 sin código adicional. Detalles en el capítulo 24.

### Executive Order 14028 (US)

Para vendors del gobierno federal US: SBOM obligatorio, atestaciones NIST SSDF, y checkpoints de seguridad en el SDLC. Aplicable a subcontratistas de agencias federales.

---

---

## 10. Ejercicios prácticos sobre LinguaDev Pro

### Ejercicio 1: instrumentar Semgrep + Dependabot + gitleaks (45 min)

**Objetivo**: cascada mínima de shift-left en el monorepo.

**Pasos**:
1. Crear `.github/workflows/sast.yml` con Semgrep p/owasp-top-ten (ver §3.3).
2. Habilitar Dependabot con `.github/dependabot.yml` para npm + gh-actions.
3. Crear `.pre-commit-config.yaml` con gitleaks (ver §5.2) y correr `pre-commit install`.
4. Abrir un PR de prueba con `const key = "AKIAIOSFODNN7EXAMPLE";` — verificar que se bloquea.

**Verificación**:

```bash
gh pr checks --watch
# Debe reportar failure en Semgrep + Dependency Review + pre-commit.

pre-commit run --all-files
# gitleaks encontrará el pattern y saldrá con exit 1.
```

### Ejercicio 2: Trivy image + fs scan bloqueando merges (30 min)

**Objetivo**: agregar container scanning en PR.

**Pasos**:
1. Copiar workflow de §6.1 a `.github/workflows/container-security.yml`.
2. Ajustar `image-ref` al nombre real de la imagen del tutor service.
3. Confirmar que SARIF sube a Security tab del repo.
4. Introducir intencionalmente `openssl` viejo en el Dockerfile y validar que el CI falla.

**Verificación**:

```bash
trivy image linguadev/tutor:test --severity CRITICAL,HIGH --exit-code 1
# Exit code 1 si hay vulns críticas.

gh api repos/linguadev/monorepo/code-scanning/alerts --jq '.[] | .rule.id'
# Debe listar reglas de Trivy y Semgrep.
```

### Ejercicio 3: Renovate con auto-merge de patches (45 min)

**Objetivo**: reemplazar Dependabot manual por Renovate con automerge.

**Pasos**:
1. Instalar Renovate GitHub App en la organización.
2. Añadir `renovate.json` del §4.3 al root.
3. Esperar el "Dependency Dashboard" PR y aprobarlo.
4. Verificar que patches se auto-mergean tras verde CI.

**Verificación**: revisar la PR list — patches semanales cerrándose sin intervención.

### Ejercicio 4: threat model del endpoint tutor stream (60 min)

**Objetivo**: aplicar STRIDE al endpoint SSE `/api/tutor/stream`.

**Pasos**:
1. Dibuja el DFD (browser → CloudFront → API Gateway → Lambda → OpenAI, con Redis cache paralelo).
2. Identifica 2-3 amenazas por letra STRIDE. Documenta en `docs/threat-models/tutor-stream.md`.
3. Para cada amenaza lista mitigación actual y gap.
4. Convierte los gaps en issues GitHub con label `security`.

**Verificación**: 12-18 amenazas identificadas totales, cada una con mitigación explícita o gap tracked.

### Ejercicio 5: OWASP ZAP baseline contra staging (60 min)

**Objetivo**: agregar DAST semanal automatizado.

**Pasos**:
1. Crear `.github/workflows/dast.yml` con ZAP baseline action:

```yaml
name: DAST — ZAP Baseline
on:
  schedule:
    - cron: '0 4 * * 1'
  workflow_dispatch:

jobs:
  zap:
    runs-on: ubuntu-24.04
    steps:
      - name: OWASP ZAP Baseline
        uses: zaproxy/action-baseline@v0.13.0
        with:
          target: https://staging.linguadev.dev
          rules_file_name: .zap/rules.tsv
          cmd_options: '-a -j'
          fail_action: true
          allow_issue_writing: true
```

2. Crear `.zap/rules.tsv` para excluir rules ruidosas (ej. informational-only).
3. Correr manual con `workflow_dispatch`, verificar reporte HTML.

**Verificación**: issue GitHub creado con hallazgos, categorizados como HIGH/MEDIUM/LOW.

### Ejercicio 6: security champions kickoff (2 h workshop)

**Objetivo**: institucionalizar el programa con 4 champions iniciales.

**Pasos**:
1. Identifica 4 devs voluntarios (uno por squad).
2. Workshop de 2h: intro OWASP Top 10, tour por Security tab de GitHub, triage de 5 findings reales.
3. Crear canal Slack #security-champions con AppSec team + los 4.
4. Establecer sync semanal 30 min.
5. Trackea KPIs: findings triaged, PRs revisados por security lens, threat models producidos.

**Verificación**: 4 champions activos a mes 1; ≥ 10 findings triaged por champions/mes.

**Simulacro asociado**: [`packages/content/src/tech/devops/sim-22-devsecops-fundamentals.json`](../../packages/content/src/tech/devops/sim-22-devsecops-fundamentals.json) (id `devops-sim-22-devsecops-fundamentals`, 20 preguntas, 30 min, pass 75%).

---

## Navegación

- Anterior: [Capítulo 21 — SLO Management y Error Budgets](./21-slo-management-y-error-budgets.md)
- Siguiente: [Capítulo 23 — Secrets Management (Vault, KMS) →](./23-secrets-management-vault-kms.md)
- Índice: [docs/devops](./)
