# Capítulo 23 — Secrets Management (Vault, KMS, External Secrets)

> **Focus:** Del anti-patrón "secretos en `.env`" al estado del arte 2026: HashiCorp Vault con dynamic secrets y PKI, AWS KMS con envelope encryption, GCP Secret Manager, Azure Key Vault, External Secrets Operator para Kubernetes, SOPS + age/GPG, Sealed Secrets, rotación automática, break-glass y audit trails. El objetivo: **cero secrets en git, cero secrets long-lived, todo auditable**.
> **Áreas:** Security · Cloud · Kubernetes · Compliance
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Cloud fundamentals: IAM roles, KMS, secrets managers gestionados (ver [cap 14 — cloud fundamentals y multi-cloud](./14-cloud-fundamentals-y-multi-cloud.md)).
- Kubernetes fundamentals: Secret, ServiceAccount, TokenReview API (ver [cap 07 — fundamentos kubernetes](./07-fundamentos-kubernetes.md)).
- Kubernetes security: RBAC, workload identity, EncryptionConfiguration (ver [cap 11 — kubernetes security](./11-kubernetes-security.md)).
- GitOps con ArgoCD/Flux (ver [cap 15 — gitops con argocd y flux](./15-gitops-con-argocd-y-flux.md)).
- Fundamentos criptográficos: symmetric vs asymmetric, DEK/KEK, envelope encryption.

**Glosario mínimo:**
- **KEK** (Key Encryption Key): clave maestra en HSM/KMS que cifra otras claves. Nunca sale del HSM.
- **DEK** (Data Encryption Key): clave que cifra datos reales. Se genera por objeto, se guarda cifrada por el KEK.
- **Envelope encryption**: patrón `data cifrado con DEK; DEK cifrada con KEK`. Base de KMS de AWS/GCP/Azure.
- **Dynamic secret**: credencial generada on-demand con TTL corto (minutos). Vault expira automáticamente. Nunca existe antes de ser leída.
- **Static secret**: credencial almacenada y recuperada tal cual (ej. API key de tercero).
- **Rotation**: regenerar el secret periódicamente. Automática es la meta.
- **Break-glass**: procedimiento de emergencia para acceder cuando falla el sistema normal, con audit trail estricto.
- **ESO** (External Secrets Operator): CRD-based operator que sincroniza secretos de proveedores externos hacia K8s Secrets.
- **SOPS**: Mozilla Secret OPerationS. Cifra archivos YAML/JSON in-place con KMS/age/GPG.
- **Sealed Secrets**: Bitnami project que cifra secrets con la pubkey del cluster; sealed encriptado puede ir a git.
- **Vault Agent Injector**: mutating webhook de Vault que inyecta secretos como archivos en pods.
- **Vault Secrets Operator (VSO)**: alternativa CRD-based nativa de HashiCorp para K8s.
- **PKI engine**: Vault emite certificados X.509 dinámicos.
- **Transit engine**: Vault ofrece cifrado como servicio sin almacenar el dato.

**Setup mínimo:**

```bash
# 1. HashiCorp Vault 1.18+ (agosto 2026)
brew install hashicorp/tap/vault
vault --version
# Vault v1.18.x

# 2. Vault dev server local (NO usar en producción — sin persistence ni seal)
vault server -dev -dev-root-token-id="root"
export VAULT_ADDR='http://127.0.0.1:8200'
export VAULT_TOKEN='root'
vault status

# 3. AWS CLI + KMS test
aws kms list-keys --region us-east-1

# 4. External Secrets Operator en K8s (v0.10+)
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets --create-namespace \
  --version 0.10.x \
  --set installCRDs=true

# 5. SOPS + age para archivos cifrados en git
brew install sops age
sops --version
age --version

# 6. Sealed Secrets controller
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system --version 2.16.x
kubeseal --version
```

---

## 1. El gran cuadro

El manejo de secretos es la disciplina donde más se rompe el principio DevSecOps de "shift-left": lo típico es que los devs pongan un `.env` en `.gitignore`, se olviden de rotarlo durante 2 años y descubran el leak cuando el cliente reporta una factura AWS anómala. En 2026 el estado del arte se articula sobre cuatro principios que se refuerzan: **cero secrets en git**, **cero secrets long-lived** (todo con TTL bajo), **identidad workload-nativa en vez de credenciales pre-compartidas** y **audit trail exhaustivo**. Cada principio se materializa en herramientas concretas: **HashiCorp Vault** para orquestación central, **AWS/GCP/Azure KMS** para keys criptográficas y envelope encryption, **External Secrets Operator** para inyectar en Kubernetes, **SOPS + age** para configuración versionada, **Vault dynamic secrets** para eliminar el concepto mismo de "credencial que persiste".

La distinción **static vs dynamic secret** es la más importante para entender la evolución. Un static secret es la contraseña de la DB Postgres que existe en el config, se rota trimestralmente y todos los servicios la comparten. Un **dynamic secret** de Vault en cambio se **genera on-demand** cuando la app la pide, tiene TTL de 5 minutos, es **única por invocación**, se revoca automáticamente al expirar y es **imposible** que se filtre porque no existe antes de la petición ni después del TTL. El blast radius se colapsa: si se leakea, en 5 minutos ya no vale. Vault soporta dynamic secrets para PostgreSQL, MySQL, MongoDB, AWS IAM, GCP, Azure, PKI (certificados X.509), SSH y más de 40 backends.

**KMS y envelope encryption** son la infraestructura criptográfica sobre la que se construye todo lo demás. En AWS KMS (equivalente en GCP Cloud KMS, Azure Key Vault Keys), la KEK vive en HSM validados FIPS 140-2 nivel 3 y **nunca sale**; para cifrar datos grandes, KMS genera una DEK al vuelo, cifra el dato con la DEK, y guarda la DEK cifrada por el KEK junto al dato (envelope). Esto habilita **rotación de KEK sin recifrar datos** (el KEK nuevo solo tiene que descifrar el DEK cifrado viejo una vez) y separa **audit de acceso a KEK** de **audit de acceso a datos**. S3 SSE-KMS, EBS encrypted, RDS encryption, Secrets Manager, Parameter Store — todos usan envelope internamente. Kubernetes puede cifrar `Secret` en etcd con KMS provider (**EncryptionConfiguration**), cerrando el hueco histórico de que secrets en K8s se guardaban base64-encoded sin encryption at rest.

En Kubernetes, la solución dominante en 2026 es **External Secrets Operator (ESO)** en su versión 0.10+, que reemplaza patrones más viejos como injecting secrets via init containers. ESO define CRDs `ClusterSecretStore` (backend: Vault, AWS SM, GCP SM, Azure KV) y `ExternalSecret` (recurso namespaced que declara "quiero traer X del backend Y y crear K8s Secret Z con refresh cada 15 min"). El operator hace el trabajo de sincronización, rotación y auditoría. Alternativas: **Vault Secrets Operator** (nativo HashiCorp), **Sealed Secrets** (para GitOps puro sin backend externo), **SOPS + Flux** (cifrado in-git decrypted en runtime). Este capítulo cubre cada patrón, muestra código real de Vault, KMS, ESO, SOPS y Sealed Secrets, y termina con ejercicios verificables sobre **LinguaDev Pro**.

---

## 2. Anti-patrones y principios base

### 2.1 Los seis anti-patrones clásicos

1. **Secrets hardcoded en código**: `const AWS_SECRET = "wJal..."` commiteado. Bots escanean GitHub en segundos. Aunque borres el commit, el historial retiene todo.
2. **`.env` commiteado**: el mismo pecado, disfrazado. Regla: `.env` siempre en `.gitignore`; commitear `.env.example` con placeholders.
3. **Long-lived tokens compartidos**: un solo `VAULT_TOKEN` estático usado por todo CI. Si se filtra, blast radius total.
4. **Secrets en variables de entorno logueadas**: `console.log(process.env)` en un handler de error. Datadog/New Relic capturaron env vars por defecto en versiones antiguas.
5. **CLI args**: `./app --db-pass=xxx` es visible en `ps auxww` para cualquier usuario del host y queda en `~/.bash_history`.
6. **K8s Secret asumido como "seguro"**: en K8s default, `Secret` se almacena **base64 (no cifrado)** en etcd. Sin `EncryptionConfiguration` con KMS, cualquiera con acceso a etcd lee todos los secrets.

### 2.2 Los cuatro principios modernos

- **Cero secrets en git** (ni cifrados en claro; solo cifrados con KMS via SOPS/Sealed Secrets).
- **Cero secrets long-lived**: rotación automática siempre, dynamic secrets cuando posible.
- **Identidad workload-nativa**: usá la identidad de la plataforma (IAM Roles for Service Accounts en EKS, Workload Identity en GKE, ManagedIdentity en AKS) en vez de credenciales pre-compartidas.
- **Audit trail exhaustivo**: cada acceso a un secret debe quedar registrado, con quién, cuándo, desde dónde, con qué policy.

### 2.3 Jerarquía de seguridad para inyección

De peor a mejor:

| Método | Riesgo | Cuándo aceptable |
|--------|--------|------------------|
| CLI args | muy alto | nunca |
| Env var estática | medio-alto | apps legacy, con logs sanitizados |
| Env var inyectada por CI en runtime | medio | pipelines cortos |
| Archivo montado en tmpfs | medio-bajo | cuando app soporta reload |
| Dynamic secret via Vault Agent | bajo | production estándar |
| Workload identity + SDK KMS/SM | mínimo | óptimo cuando disponible |

---

## 3. HashiCorp Vault: arquitectura

### 3.1 Componentes

- **Storage backend**: dónde vive el estado cifrado (Integrated Storage/Raft recomendado en 2026, antes Consul).
- **Seal/Unseal**: la KEK del vault (Shamir shares) o auto-unseal con KMS del cloud.
- **Auth methods**: cómo probás quién sos (OIDC, K8s, AWS IAM, JWT/GitHub, LDAP, token).
- **Secrets engines**: qué secretos gestiona (KV v2, database dynamic, PKI, transit, AWS, SSH).
- **Policies**: HCL/JSON que define qué paths puede leer/escribir cada identidad.
- **Audit devices**: file, syslog, socket — cada operación queda logueada.

### 3.2 Auth methods modernos

- **OIDC**: SSO con Okta/Google Workspace/Auth0. Para humanos.
- **Kubernetes**: el ServiceAccount JWT del pod se valida contra la TokenReview API del cluster. Para workloads en K8s.
- **JWT / GitHub OIDC**: GitHub Actions emite JWT firmado por workflow; Vault lo valida sin necesitar `VAULT_TOKEN` estático. Elimina el patrón "long-lived token in CI secrets".
- **AWS IAM**: EC2/EKS pods presentan su identidad IAM; Vault valida contra STS `GetCallerIdentity`.

### 3.3 Habilitar Kubernetes auth y policy

```bash
# Habilitar el auth method
vault auth enable kubernetes

# Configurar con endpoint del cluster
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

# Escribir policy que permite leer secrets del path del tutor
vault policy write tutor-read - <<EOF
path "secret/data/tutor/*" {
  capabilities = ["read"]
}
path "database/creds/tutor-db-readonly" {
  capabilities = ["read"]
}
EOF

# Bind role: el SA "tutor" del namespace "tutor" puede autenticar y obtener policy tutor-read
vault write auth/kubernetes/role/tutor \
  bound_service_account_names=tutor \
  bound_service_account_namespaces=tutor \
  policies=tutor-read \
  ttl=1h \
  max_ttl=24h
```

---

## 4. Vault secrets engines

### 4.1 KV v2 para secrets estáticos versionados

```bash
# Habilitar KV v2 en path secret/
vault secrets enable -path=secret -version=2 kv

# Escribir un secret
vault kv put secret/tutor/openai \
  api_key="sk-prod-xxxxx" \
  org_id="org-xxxxx"

# Leer
vault kv get secret/tutor/openai

# KV v2 mantiene versiones — rollback trivial
vault kv put secret/tutor/openai api_key="sk-prod-new" org_id="org-xxxxx"
vault kv metadata get secret/tutor/openai
vault kv rollback -version=1 secret/tutor/openai
```

### 4.2 Database dynamic secrets (Postgres)

```bash
# 1. Habilitar el engine
vault secrets enable database

# 2. Configurar conexión con Postgres (usuario admin de Vault)
vault write database/config/tutor-postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="tutor-db-readonly,tutor-db-readwrite" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.internal:5432/tutor?sslmode=require" \
  username="vault_admin" \
  password="STRONG_ADMIN_PASSWORD"

# 3. Definir role con SQL de creación
vault write database/roles/tutor-db-readonly \
  db_name=tutor-postgres \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; \
                       GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="15m" \
  max_ttl="1h"

# 4. La app pide credencial: Vault CREA usuario Postgres con TTL 15 min
vault read database/creds/tutor-db-readonly
# Key                Value
# ---                -----
# lease_id           database/creds/tutor-db-readonly/xxx
# lease_duration     15m
# username           v-token-tutor-db-readonly-abcd1234
# password           A1b2C3d4E5...

# Al expirar TTL, Vault revoca automáticamente el usuario Postgres.
```

Zero credential leak posible: cada request genera credencial nueva, única, con TTL 15 min, específica del cliente.

### 4.3 PKI engine: emitir certificados X.509 dinámicos

```bash
# 1. Habilitar engine PKI intermediate
vault secrets enable -path=pki_int pki

# Extender TTL max (por defecto 30 días)
vault secrets tune -max-lease-ttl=8760h pki_int

# 2. Generar CSR intermedio, firmar con root externo (o auto-signed en lab)
vault write -field=csr pki_int/intermediate/generate/internal \
  common_name="LinguaDev Intermediate CA" \
  key_type=ec key_bits=256 \
  ttl=8760h > pki_int.csr

# 3. Definir role: qué DNS puede firmar, TTLs
vault write pki_int/roles/tutor-svc \
  allowed_domains="tutor.internal,tutor.svc.cluster.local" \
  allow_subdomains=true \
  max_ttl="72h" \
  key_type="ec" \
  key_bits="256"

# 4. App pide certificado
vault write pki_int/issue/tutor-svc common_name="api.tutor.internal" ttl="24h"
# Emite cert + key + chain. Rotación cada 24h, cero manual.
```

### 4.4 Transit engine: cifrado como servicio

```bash
# Habilitar transit
vault secrets enable transit

# Crear key encryption key
vault write -f transit/keys/tutor-pii

# App envía plaintext, Vault devuelve ciphertext
vault write transit/encrypt/tutor-pii \
  plaintext=$(echo -n "usuario@example.com" | base64)
# Response: ciphertext = "vault:v1:xxxxx"

# App guarda "vault:v1:xxxxx" en su DB. Para descifrar:
vault write transit/decrypt/tutor-pii ciphertext="vault:v1:xxxxx"
```

Vault **nunca almacena el plaintext**. Ideal para PII: rotación de key sin re-cifrar datos (Vault re-envuelve al leer).

---

## 5. External Secrets Operator en Kubernetes

### 5.1 Por qué ESO

ESO es el patrón dominante en 2026 para inyectar secretos desde backends externos hacia K8s. Ventajas: nativo GitOps (los `ExternalSecret` van a git; los secretos reales no), refresh automático, multi-backend (Vault, AWS SM, GCP SM, Azure KV, Akeyless, 1Password), y CRDs claros.

### 5.2 SecretStore contra AWS Secrets Manager (con IRSA)

```yaml
# eso-store-aws.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-sm-prod
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-secrets
  namespace: external-secrets
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789:role/eso-secrets-reader
```

### 5.3 ExternalSecret trae credenciales de OpenAI

```yaml
# tutor-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: tutor-openai
  namespace: tutor
spec:
  refreshInterval: 15m
  secretStoreRef:
    kind: ClusterSecretStore
    name: aws-sm-prod
  target:
    name: tutor-openai       # K8s Secret que se crea/refresca
    creationPolicy: Owner
    template:
      type: Opaque
      data:
        OPENAI_API_KEY: "{{ .apiKey }}"
        OPENAI_ORG_ID: "{{ .orgId }}"
  data:
    - secretKey: apiKey
      remoteRef:
        key: prod/tutor/openai
        property: api_key
    - secretKey: orgId
      remoteRef:
        key: prod/tutor/openai
        property: org_id
```

Verificación:

```bash
kubectl get externalsecret tutor-openai -n tutor
# NAME           STORE         REFRESH INTERVAL   STATUS         READY
# tutor-openai   aws-sm-prod   15m                SecretSynced   True

kubectl get secret tutor-openai -n tutor -o jsonpath='{.metadata.ownerReferences[0].kind}'
# ExternalSecret

# El deployment consume normalmente:
kubectl create deployment tutor --image=linguadev/tutor:1.0 \
  --dry-run=client -o yaml | kubectl set env --from=secret/tutor-openai -f - -
```

### 5.4 ExternalSecret contra Vault dynamic secrets

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: tutor-db-creds
  namespace: tutor
spec:
  refreshInterval: 10m  # menor que TTL de Vault (15m)
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-prod
  target:
    name: tutor-db-creds
    creationPolicy: Owner
  dataFrom:
    - sourceRef:
        generatorRef:
          apiVersion: generators.external-secrets.io/v1alpha1
          kind: VaultDynamicSecret
          name: tutor-db-dynamic
---
apiVersion: generators.external-secrets.io/v1alpha1
kind: VaultDynamicSecret
metadata:
  name: tutor-db-dynamic
  namespace: tutor
spec:
  path: database/creds/tutor-db-readonly
  method: GET
  provider:
    server: https://vault.linguadev.dev:8200
    path: database
    version: v2
    auth:
      kubernetes:
        role: tutor
        serviceAccountRef:
          name: tutor
```

Cada 10 min, ESO pide credencial nueva a Vault, Vault crea usuario Postgres con TTL 15 min, ESO actualiza el K8s Secret. El pod monta el secret y hace reload (con `stakater/reloader` o restart controlado).

---

## 6. SOPS + age para secrets en git

### 6.1 Por qué SOPS

**SOPS** cifra archivos YAML/JSON in-place manteniendo la estructura visible (solo values cifrados). Los archivos cifrados pueden commiterse a git. Al desplegar, Flux/ArgoCD descifra en runtime usando la key correspondiente.

**age** es el reemplazo moderno de GPG: sintaxis simple, curva Curve25519, sin web of trust, ideal para uso operativo.

### 6.2 Setup age + SOPS

```bash
# Generar key age (una vez por persona/máquina)
age-keygen -o ~/.config/sops/age/keys.txt
# Output: Public key: age1abcdefg... (guardar público, compartir en git)

# Configurar .sops.yaml en el root del repo
cat > .sops.yaml <<EOF
creation_rules:
  - path_regex: secrets/prod/.*\.yaml$
    encrypted_regex: '^(data|stringData)$'
    age: age1abcdefg...
  - path_regex: secrets/staging/.*\.yaml$
    encrypted_regex: '^(data|stringData)$'
    age: age1hijklmn...
EOF

# Crear secret plaintext y cifrar
cat > secrets/prod/db.yaml <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: tutor
type: Opaque
stringData:
  password: "supersecret123"
  connectionString: "postgres://user:supersecret123@db:5432/tutor"
EOF

sops -e -i secrets/prod/db.yaml

# El archivo ahora tiene stringData cifrada, resto en claro (metadata visible).
git add secrets/prod/db.yaml
git commit -m "encrypted db credentials for prod"
```

### 6.3 Integración con Flux

```yaml
# flux-kustomization.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: tutor-app
  namespace: flux-system
spec:
  interval: 5m
  path: ./deploy/tutor
  prune: true
  sourceRef:
    kind: GitRepository
    name: linguadev-monorepo
  decryption:
    provider: sops
    secretRef:
      name: sops-age
---
apiVersion: v1
kind: Secret
metadata:
  name: sops-age
  namespace: flux-system
type: Opaque
stringData:
  age.agekey: AGE-SECRET-KEY-1XXXXXXXXX  # private key del cluster
```

Flux descifra los SOPS files al aplicarlos. Los devs versionan cifrado; el cluster tiene la clave privada montada como secret.

---

## 7. Sealed Secrets

### 7.1 Cuándo elegirlo

Sealed Secrets (Bitnami) tiene un modelo distinto a SOPS: el `SealedSecret` está cifrado con la **pubkey del controller en el cluster**, así que solo ese cluster puede descifrar. Es simple pero atado a un cluster; no soporta multi-cluster naturalmente. Ideal para setups pequeños sin backend externo.

### 7.2 Workflow

```bash
# 1. Crear Secret plaintext (nunca commitear)
kubectl create secret generic tutor-db \
  --from-literal=password="supersecret" \
  --dry-run=client -o yaml > tutor-db.yaml

# 2. Sellar con kubeseal usando pubkey del controller
kubeseal --controller-name=sealed-secrets \
  --controller-namespace=kube-system \
  --format yaml < tutor-db.yaml > tutor-db-sealed.yaml

# 3. Borrar plaintext, commitear sellado
rm tutor-db.yaml
git add tutor-db-sealed.yaml
git commit -m "sealed db secret"
```

El `SealedSecret` en git contiene un blob cifrado que solo el controller del cluster origen puede descifrar. Al aplicarlo, el controller lo descifra y crea el `Secret` real.

---

## 8. AWS KMS y envelope encryption

### 8.1 Crear KMS key + policy

```json
{
  "Version": "2012-10-17",
  "Id": "tutor-kek-policy",
  "Statement": [
    {
      "Sid": "AllowRootAccountAdmin",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::123456789012:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "AllowTutorRoleEncryptDecrypt",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/tutor-runtime"
      },
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:EncryptionContext:app": "tutor",
          "aws:PrincipalOrgID": "o-abc123"
        }
      }
    },
    {
      "Sid": "DenyOldTLS",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "kms:*",
      "Resource": "*",
      "Condition": {
        "NumericLessThan": {
          "kms:TlsVersion": "1.2"
        }
      }
    }
  ]
}
```

Crear la key:

```bash
aws kms create-key \
  --description "tutor service PII envelope KEK" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --policy file://tutor-kek-policy.json \
  --tags TagKey=app,TagValue=tutor TagKey=env,TagValue=prod

# Habilitar rotación automática anual (recomendado)
aws kms enable-key-rotation --key-id alias/tutor-kek

# Crear alias
aws kms create-alias --alias-name alias/tutor-kek --target-key-id KEY_ID
```

### 8.2 Envelope encryption en la app (Node.js AWS SDK v3)

```javascript
// El patrón: genera DEK con KMS, cifra dato con DEK, guarda DEK cifrada junto al dato
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const kms = new KMSClient({ region: 'us-east-1' });
const KEY_ID = 'alias/tutor-kek';

export async function encryptPII(plaintext, encryptionContext) {
  const { Plaintext: dek, CiphertextBlob: dekEncrypted } = await kms.send(
    new GenerateDataKeyCommand({
      KeyId: KEY_ID,
      KeySpec: 'AES_256',
      EncryptionContext: encryptionContext, // ej. { app: 'tutor', userId: 'u123' }
    })
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Guardar: iv || tag || dekEncrypted || ct — dek plaintext se descarta inmediatamente
  return Buffer.concat([iv, tag, Buffer.from(dekEncrypted), ct]).toString('base64');
}

export async function decryptPII(envelope, encryptionContext) {
  const buf = Buffer.from(envelope, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const dekEnc = buf.subarray(28, 28 + 184); // KMS ciphertext ~184 bytes para AES_256
  const ct = buf.subarray(28 + 184);
  const { Plaintext: dek } = await kms.send(
    new DecryptCommand({
      CiphertextBlob: dekEnc,
      EncryptionContext: encryptionContext,
    })
  );
  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
```

Ventajas: KMS solo maneja la DEK (llamada barata, ~1ms), el bulk data se cifra localmente. Rotar KEK no requiere re-cifrar; el DEK cifrado se descifra con la versión anterior automáticamente.

### 8.3 Comparativa proveedores

| Feature | AWS KMS + SM | GCP KMS + SM | Azure Key Vault |
|---------|--------------|--------------|-----------------|
| HSM level | FIPS 140-2 L3 (CloudHSM opt.) | FIPS 140-2 L3 | FIPS 140-2 L2/L3 (Premium) |
| Envelope encryption | nativa | nativa | nativa |
| Rotación KEK auto | anual | configurable | configurable |
| Secret store | AWS Secrets Manager | GCP Secret Manager | Key Vault Secrets |
| Workload identity | IRSA (EKS), IAM (EC2) | Workload Identity (GKE) | Managed Identity (AKS) |
| Costo típico secret/mes | $0.40 + $0.05/10k API | $0.06 + $0.03/10k | $0.03/op |

---

## 9. Rotation, break-glass y audit

### 9.1 Estrategias de rotation

- **Automática por proveedor**: AWS Secrets Manager tiene Lambda-based rotation nativo para RDS, DocumentDB, Redshift. Configurar `RotationRules` con `AutomaticallyAfterDays: 30`.
- **Automática por Vault**: dynamic secrets expiran solos; static secrets con `vault kv put` scriptable en cron.
- **Aplicación soporta reload**: app relee secret al recibir SIGHUP o cada N minutos, sin restart.
- **Rollout deploy**: para apps que no soportan reload, rotation dispara `kubectl rollout restart deployment/...`. Usar `stakater/reloader`.

### 9.2 Break-glass procedures

Cuando el sistema normal falla (Vault caído, Okta out) hace falta acceso de emergencia. Reglas:

1. **Credenciales break-glass en HSM offline** (ej. Vault root token shares distribuidos en 5 personas con Shamir 3-of-5).
2. **Uso registrado y notificado**: cada activación dispara alertas a `#security-oncall` y `#leadership`.
3. **Auto-revocación**: token break-glass tiene TTL corto (4h) y se revoca automáticamente.
4. **Post-mortem obligatorio**: por qué el sistema normal falló + qué se accedió + validación por security team.
5. **Simulacros trimestrales**: ejecutar el procedimiento sin incidente real para verificar que funciona y que las personas designadas siguen activas.

### 9.3 Audit trail: qué loguear

- **Vault**: `audit device` file/syslog captura toda operación con hash de la request/response. Envío a SIEM.
- **AWS KMS**: CloudTrail data events (`kms.amazonaws.com`) registra cada `Encrypt`/`Decrypt`/`GenerateDataKey` con `EncryptionContext`.
- **K8s Secrets**: audit policy con `verbs: ["get", "list", "watch"]` sobre `resources: ["secrets"]` a nivel `RequestResponse`.
- **AWS Secrets Manager**: CloudTrail management events registra reads con caller identity.

Alertas SIEM útiles:

- Acceso a un secret fuera de horario laboral por usuario humano.
- >100 lecturas/min desde una nueva IP (posible enum).
- Cualquier uso del root token de Vault.
- `Decrypt` sin `EncryptionContext` esperado (posible bypass de policy).

---

## 10. Ejercicios prácticos sobre LinguaDev Pro

### Ejercicio 1: Vault dev + K8s auth + dynamic Postgres (90 min)

**Objetivo**: obtener credencial dinámica Postgres desde un pod del tutor.

**Pasos**:
1. Correr `vault server -dev` local (o Vault helm chart en kind).
2. Habilitar `kubernetes` auth method (ver §3.3).
3. Habilitar `database` engine y configurar con Postgres local (docker) + role `tutor-db-readonly` (ver §4.2).
4. Deployar pod `tutor` con SA que bindea al role Vault.
5. Desde el pod, curlear `/v1/database/creds/tutor-db-readonly` con el token.

**Verificación**:

```bash
kubectl exec -n tutor deploy/tutor -- \
  curl -s -H "X-Vault-Token: $(cat /vault/secrets/token)" \
  http://vault:8200/v1/database/creds/tutor-db-readonly | jq .data
# {"username": "v-token-tutor-db-...", "password": "..."}

# Verificar en Postgres:
psql -h postgres -U postgres -c "\du" | grep v-token
# El usuario existe. En 15 min desaparecerá.
```

### Ejercicio 2: External Secrets Operator con AWS Secrets Manager (60 min)

**Objetivo**: sincronizar `prod/tutor/openai` desde AWS SM hacia un K8s Secret.

**Pasos**:
1. Instalar ESO (ver §0).
2. Crear IAM role `eso-secrets-reader` con policy `secretsmanager:GetSecretValue` sobre `prod/tutor/*` y trust IRSA.
3. Aplicar `ClusterSecretStore` (§5.2) + `ExternalSecret` (§5.3).
4. Verificar sync.

**Verificación**:

```bash
kubectl get es -n tutor
kubectl get secret tutor-openai -n tutor -o jsonpath='{.data.OPENAI_API_KEY}' | base64 -d
# Debe imprimir el valor real (sin exponer en logs).

# Rotar en AWS y esperar refresh
aws secretsmanager put-secret-value --secret-id prod/tutor/openai \
  --secret-string '{"api_key":"sk-new-value","org_id":"org-xxx"}'
sleep 900  # esperar refreshInterval
kubectl get secret tutor-openai -n tutor -o jsonpath='{.data.OPENAI_API_KEY}' | base64 -d
# Debe reflejar el nuevo valor.
```

### Ejercicio 3: SOPS + age + Flux (60 min)

**Objetivo**: commitear un DB secret cifrado a git y que Flux lo descifre al deploy.

**Pasos**:
1. Instalar age + sops. Generar key y publicar pública en `.sops.yaml` (ver §6.2).
2. Cifrar `secrets/prod/db.yaml` con SOPS.
3. Configurar `Kustomization` de Flux con `decryption.provider: sops` (§6.3).
4. Aplicar clave privada como Secret `sops-age` en `flux-system`.
5. Commit + push. Observar Flux desplegar el `Secret` real.

**Verificación**:

```bash
# Ver que el archivo commiteado está cifrado
grep -c "ENC\[" secrets/prod/db.yaml  # > 0

# Ver que el cluster tiene el Secret real
kubectl get secret db-credentials -n tutor -o jsonpath='{.data.password}' | base64 -d
# Debe imprimir el plaintext original.
```

### Ejercicio 4: AWS KMS envelope encryption en Node.js (75 min)

**Objetivo**: cifrar/descifrar PII con envelope pattern.

**Pasos**:
1. Crear KMS key con policy del §8.1.
2. Copiar código Node.js del §8.2 a `packages/lib-pii/src/envelope.ts`.
3. Test unitario que cifra `"usuario@example.com"` con context `{app:'tutor',userId:'u1'}`, descifra y compara.
4. Test que descifrar con context distinto **falla** (verifica que EncryptionContext no es opcional).

**Verificación**:

```bash
npm test -- envelope.spec.ts
# ✓ encryptPII + decryptPII returns original plaintext
# ✓ decryptPII with wrong context throws InvalidCiphertextException
```

### Ejercicio 5: Sealed Secrets como alternativa (30 min)

**Objetivo**: sellar un Secret y commitear el sealed a git.

**Pasos**:
1. Instalar sealed-secrets controller.
2. `kubectl create secret generic ...` seguido de `kubeseal` (§7.2).
3. Commit sealed. Aplicar. Verificar que aparece el Secret descifrado.

**Verificación**:

```bash
kubectl get sealedsecret tutor-db -n tutor
kubectl get secret tutor-db -n tutor -o jsonpath='{.metadata.ownerReferences[0].kind}'
# SealedSecret
```

### Ejercicio 6: audit trail + alerta SIEM (60 min)

**Objetivo**: registrar acceso al `tutor-openai` secret y alertar sobre lectura anómala.

**Pasos**:
1. Configurar Vault audit device file en `/vault/audit/log.jsonl`.
2. Habilitar CloudTrail data events sobre KMS + `prod/tutor/*` en AWS SM.
3. Enviar logs a Grafana Loki o CloudWatch Logs Insights.
4. Crear regla que alerte si un usuario humano lee `tutor-openai` fuera de 9-18 UTC.

**Verificación**: forzar acceso fuera de horario (con account de test) y comprobar que la alerta dispara en el canal Slack correspondiente.

**Simulacro asociado**: [`packages/content/src/tech/devops/sim-23-secrets-management-vault-kms.json`](../../packages/content/src/tech/devops/sim-23-secrets-management-vault-kms.json) (id `devops-sim-23-secrets-management-vault-kms`, 20 preguntas, 30 min, pass 75%).

---

## Navegación

- Anterior: [Capítulo 22 — Fundamentos DevSecOps](./22-fundamentos-devsecops.md)
- Siguiente: [Capítulo 24 — Supply Chain Security →](./24-supply-chain-security.md)
- Índice: [docs/devops](./)
