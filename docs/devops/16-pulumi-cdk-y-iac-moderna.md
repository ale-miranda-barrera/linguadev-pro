# Capítulo 16 — Pulumi, AWS CDK y IaC moderna

> **Focus:** IaC más allá de HCL. Pulumi 3.140+ con TypeScript/Python/Go/C#, AWS CDK 2.170+ (constructs L1/L2/L3), cdktf y cdk8s, Crossplane 1.18+ (K8s-native), OpenTofu como fork abierto, testing (Terratest, Pulumi CrossGuard, Jest), policy-as-code con OPA/Sentinel/CDK Aspects, comparativa Pulumi vs Terraform vs CDK, y cuándo elegir cada una.
> **Áreas:** Infrastructure as Code · Cloud provisioning · Platform engineering
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de Terraform y HCL (ver [cap 12 — fundamentos Terraform](./12-fundamentos-terraform.md)).
- TypeScript o Python a nivel intermedio (Pulumi/CDK requieren código real).
- Fundamentos de Kubernetes (necesario para Crossplane y cdk8s, ver [cap 07](./07-fundamentos-kubernetes.md)).
- CloudFormation básico (CDK compila a CFN internamente).
- CI/CD (ver [cap 04](./02-fundamentos-de-continuous-delivery.md)) para automatizar pipelines de IaC.

**Glosario mínimo:**
- **Pulumi**: IaC de Pulumi Corp que permite escribir infra en TypeScript, Python, Go, C#, Java, YAML. Backend gestiona state; el runtime construye un DAG y aplica el diff.
- **AWS CDK**: framework de AWS que genera CloudFormation templates a partir de código TS/Python/Go/C#/Java. Constructs L1/L2/L3.
- **cdktf** (CDK for Terraform): CDK que genera archivos JSON de Terraform (usa el motor de Terraform/OpenTofu detrás). Combina la sintaxis de CDK con providers de TF.
- **cdk8s**: CDK que genera manifiestos Kubernetes YAML a partir de TS/Python/Go/Java. Usable con GitOps (Argo CD, Flux).
- **Crossplane**: proyecto CNCF que expone recursos cloud como CRDs Kubernetes. `kubectl apply` provisiona RDS, S3, GKE clusters. Reconciliation loop nativo.
- **OpenTofu**: fork open source de Terraform bajo Linux Foundation (MPL 2.0). Versiones 1.9 y 1.10 introducen `for_each` en providers, OCI registry y S3 native locking.
- **Output**: en Pulumi, wrapper async que representa un valor conocido solo tras el apply (análogo a `Promise<T>` pero para el DAG de infra).
- **Construct**: en CDK, unidad componible que representa uno o más recursos CFN. L1 = mapping 1:1 con CFN; L2 = curated con defaults sanos; L3 = patrones que componen múltiples L2.
- **Synth**: fase en CDK/cdktf donde el código se ejecuta y produce el template intermedio (CFN JSON o TF JSON).
- **Terratest**: framework Go (Gruntwork) para tests end-to-end de módulos Terraform que hacen `apply` real.
- **Sentinel**: policy language de HashiCorp para Terraform Cloud/Enterprise.
- **CrossGuard**: policy-as-code de Pulumi (Rego u opciones YAML/JS).

**Setup mínimo:**

```bash
# 1. Node.js 20 LTS + pnpm (para Pulumi TS y CDK TS)
nvm install 20
npm install -g pnpm

# 2. Pulumi CLI 3.140+
brew install pulumi
pulumi version
# v3.140.x

pulumi login   # usa el backend por defecto (Pulumi Cloud) o s3://
# Alternativa self-hosted:
# pulumi login s3://linguadev-pulumi-state?region=eu-west-1

# 3. AWS CDK 2.170+
npm install -g aws-cdk
cdk --version
# 2.170.x (build ...)

# 4. cdk8s 2.68+
npm install -g cdk8s-cli
cdk8s --version

# 5. Crossplane CLI (para lab local con kind)
brew install crossplane/tap/crank
crank version

# 6. OpenTofu 1.10 (para comparativa)
brew install opentofu
tofu version

# 7. Testing: Jest para Pulumi/CDK, Go para Terratest
npm install -D jest @types/jest ts-jest
brew install go   # para Terratest
```

---

## 1. El gran cuadro

Durante casi una década, **Terraform** con HCL fue la lingua franca de la infra como código. Pero HCL tiene límites: no permite escribir helpers reutilizables con lógica no trivial, el testing real es difícil (`terraform plan` no es un test unitario), no hay autocompletado de IDE comparable con lenguajes reales, y las abstracciones complejas (multi-tenant, multi-region parametrizado) terminan en generadores de HCL escritos en Python o Jsonnet. Alrededor de 2018-2019 aparecieron dos respuestas dominantes: **Pulumi** (Joe Duffy, ex-Microsoft) y **AWS CDK** (Amazon, después de dogfood interno). Ambas apuestan por lo mismo: **escribí infra en un lenguaje real** (TypeScript, Python, Go, C#) y aprovechá el ecosistema completo: testing con Jest/pytest, packaging con npm/pip, abstracciones con clases y generics, IDE con go-to-definition y refactor.

En 2026, el paisaje se ha diversificado más. **Pulumi 3.140+** soporta seis lenguajes primarios, backend Pulumi Cloud o self-hosted (S3, Azure Blob, GCS, file), y su modelo mental de `Output<T>` es lo que la mayoría de devs deben internalizar antes de ser productivos. **AWS CDK 2.170+** es referencia dentro del ecosistema AWS —Amazon lo usa internamente para amazon.com, Prime Video, Alexa— pero encadena tu infra a CloudFormation con sus limitaciones (stack size, timeouts, drift complejo). **cdktf** es CDK sobre Terraform (mejor cobertura de providers no-AWS con el motor TF). **cdk8s** genera manifiestos K8s (perfecto para GitOps). **Crossplane 1.18+** invierte el paradigma: en vez de "un CLI ejecuta apply", el propio Kubernetes se convierte en control plane; recursos cloud son CRDs que un controller reconcilia continuamente.

Paralelo a esto, la comunidad reaccionó al cambio de licencia de HashiCorp (BSL, agosto 2023) creando **OpenTofu** —fork MPL 2.0 bajo Linux Foundation—. OpenTofu 1.10 (julio 2025) adelantó a Terraform en features como OCI registry para modules, S3 native locking y OTel tracing experimental. En 2026, OpenTofu es el default "lower-risk" para greenfield que no necesita HCP Terraform. IBM completó la adquisición de HashiCorp en febrero 2025, redoblando la relevancia de la alternativa OSS.

**El impacto práctico** es que hoy los equipos no eligen "una" herramienta de IaC. Un stack platform típico en 2026 puede tener: **OpenTofu** para VPC/EKS/RDS core; **AWS CDK** para el bounded context propio de una app en Amazon; **cdk8s** para manifiestos K8s; **Crossplane** para self-service developers dentro de K8s; y **policy-as-code** (OPA/Conftest, Sentinel, CrossGuard) para prevención. Este capítulo cubre las 4 herramientas alternativas a Terraform puro con código real que corre, y termina con ejercicios sobre **LinguaDev Pro** para practicar cada una.

---

## 2. Pulumi: modelo mental y primeros pasos (nivel básico)

### 2.1 Anatomía de un proyecto Pulumi

Un proyecto Pulumi es un directorio con `Pulumi.yaml` (metadatos) y código en el lenguaje elegido. TypeScript es el más común en 2026.

```yaml
# Pulumi.yaml
name: linguadev-infra
runtime: nodejs
description: Infraestructura de LinguaDev Pro con Pulumi TS
```

```typescript
// index.ts
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const env = config.require("env");        // dev | staging | prod

const assets = new aws.s3.BucketV2("assets", {
    bucket: `linguadev-assets-${env}`,
    tags: {
        Project: "linguadev",
        Environment: env,
    },
});

const versioning = new aws.s3.BucketVersioningV2("assets-versioning", {
    bucket: assets.id,
    versioningConfiguration: { status: "Enabled" },
});

export const bucketName = assets.id;
export const bucketArn  = assets.arn;
```

```bash
pulumi stack init dev             # crea un stack (equivalente a workspace/env)
pulumi config set env dev
pulumi up                         # muestra el plan y aplica tras confirmación
pulumi stack output bucketName
pulumi destroy
```

Cada `stack` de Pulumi tiene su propio state (guardado en Pulumi Cloud, S3, Azure Blob o file). `pulumi stack init prod` crea otro stack; el mismo código con distinta config produce infra distinta.

### 2.2 Output<T>: el concepto que confunde a todos al principio

En Pulumi, casi todos los atributos de un recurso son `Output<T>`, no valores directos:

```typescript
const bucket = new aws.s3.BucketV2("assets", { bucket: "linguadev-assets" });

// ❌ Esto NO funciona: bucket.arn es Output<string>, no string
console.log("ARN: " + bucket.arn);
// Imprime: "ARN: Calling [Function: toString] on an [Output<T>]..."

// ✅ Forma 1: apply
bucket.arn.apply(arn => console.log("ARN:", arn));

// ✅ Forma 2: interpolate (template literals con Outputs)
const message = pulumi.interpolate`Bucket ARN is ${bucket.arn}`;

// ✅ Forma 3: combinar múltiples Outputs
const combined = pulumi.all([bucket.arn, bucket.region]).apply(
    ([arn, region]) => `${arn} in ${region}`
);
```

**Por qué existe `Output<T>`:** cuando escribís el código, el bucket todavía no se creó, así que `arn` no existe aún. Pulumi construye un DAG de dependencias basado en cómo se pasan los Outputs entre recursos y calcula el orden de creación. Es análogo a `Promise<T>` pero atado al ciclo de vida de infra. **Regla:** nunca hagas fetch a APIs externas dentro de `.apply` (rompe determinism). Nunca `await` un Output (no son Promises reales).

### 2.3 Componentes: crear tus propias abstracciones

Uno de los grandes valores de Pulumi es escribir clases que encapsulan patrones:

```typescript
// components/secure-bucket.ts
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface SecureBucketArgs {
    bucketName: pulumi.Input<string>;
    kmsKeyId?: pulumi.Input<string>;
}

export class SecureBucket extends pulumi.ComponentResource {
    public readonly bucket: aws.s3.BucketV2;
    public readonly arn: pulumi.Output<string>;

    constructor(name: string, args: SecureBucketArgs, opts?: pulumi.ComponentResourceOptions) {
        super("linguadev:aws:SecureBucket", name, {}, opts);

        this.bucket = new aws.s3.BucketV2(`${name}-bucket`, {
            bucket: args.bucketName,
        }, { parent: this });

        new aws.s3.BucketVersioningV2(`${name}-versioning`, {
            bucket: this.bucket.id,
            versioningConfiguration: { status: "Enabled" },
        }, { parent: this });

        new aws.s3.BucketServerSideEncryptionConfigurationV2(`${name}-sse`, {
            bucket: this.bucket.id,
            rules: [{
                applyServerSideEncryptionByDefault: {
                    sseAlgorithm: args.kmsKeyId ? "aws:kms" : "AES256",
                    kmsMasterKeyId: args.kmsKeyId,
                },
            }],
        }, { parent: this });

        new aws.s3.BucketPublicAccessBlock(`${name}-pab`, {
            bucket: this.bucket.id,
            blockPublicAcls:       true,
            blockPublicPolicy:     true,
            ignorePublicAcls:      true,
            restrictPublicBuckets: true,
        }, { parent: this });

        this.arn = this.bucket.arn;
        this.registerOutputs({ arn: this.arn });
    }
}

// index.ts
import { SecureBucket } from "./components/secure-bucket";
const assets = new SecureBucket("assets", { bucketName: "linguadev-assets" });
export const assetsArn = assets.arn;
```

Esta clase produce 4 recursos con defaults de seguridad. Se publica como npm package interno para el resto de la organización.

---

## 3. AWS CDK: L1, L2, L3 constructs (nivel medio)

### 3.1 Anatomía de una app CDK

```bash
mkdir linguadev-cdk && cd linguadev-cdk
cdk init app --language typescript
# genera bin/, lib/, cdk.json, package.json
```

```typescript
// bin/linguadev-cdk.ts
#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { LinguadevInfraStack } from "../lib/linguadev-infra-stack";

const app = new cdk.App();
new LinguadevInfraStack(app, "LinguadevInfraDev", {
    env: { account: "123456789012", region: "eu-west-1" },
});
```

```typescript
// lib/linguadev-infra-stack.ts
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export class LinguadevInfraStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // L2: opinado, con defaults sanos
        const assets = new s3.Bucket(this, "AssetsBucket", {
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            lifecycleRules: [{
                id: "delete-old-versions",
                noncurrentVersionExpiration: cdk.Duration.days(90),
            }],
        });

        const table = new dynamodb.Table(this, "Progress", {
            partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
            sortKey:      { name: "topicId", type: dynamodb.AttributeType.STRING },
            billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption:   dynamodb.TableEncryption.AWS_MANAGED,
            pointInTimeRecovery: true,
        });

        const api = new lambda.Function(this, "ApiHandler", {
            runtime: lambda.Runtime.NODEJS_20_X,
            code:    lambda.Code.fromAsset("../packages/api/dist"),
            handler: "index.handler",
            memorySize: 512,
            timeout: cdk.Duration.seconds(10),
            environment: {
                BUCKET_NAME: assets.bucketName,
                TABLE_NAME:  table.tableName,
            },
        });

        // Grants: 1 línea → IAM policy least-privilege auto-generada
        assets.grantRead(api);
        table.grantReadWriteData(api);

        new cdk.CfnOutput(this, "AssetsBucketName", { value: assets.bucketName });
    }
}
```

```bash
cdk synth                    # genera CloudFormation template en cdk.out/
cdk diff                     # dry-run: qué cambiaría en el stack
cdk deploy                   # apply
cdk destroy
```

### 3.2 L1 vs L2 vs L3: la escalera de abstracción

**L1 (CFN Resources)** — mapping 1:1 con CloudFormation, auto-generado del schema oficial de AWS. Verboso, sin defaults.

```typescript
import * as s3 from "aws-cdk-lib/aws-s3";
new s3.CfnBucket(this, "L1Bucket", {
    bucketName: "linguadev-l1",
    versioningConfiguration: { status: "Enabled" },
    bucketEncryption: {
        serverSideEncryptionConfiguration: [{
            serverSideEncryptionByDefault: { sseAlgorithm: "AES256" },
        }],
    },
    // ...15 líneas más
});
```

**L2 (Curated Constructs)** — API opinada con defaults sanos, `grant*` para IAM, integraciones ergonómicas.

```typescript
new s3.Bucket(this, "L2Bucket", {
    versioned: true,
    encryption: s3.BucketEncryption.S3_MANAGED,
});  // 3 líneas + defaults seguros
```

**L3 (Patterns)** — composiciones para casos de uso completos. Ej.: `ApplicationLoadBalancedFargateService` monta ALB + Fargate + Target Group + Security Groups + Route53 en una construct.

```typescript
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
new ApplicationLoadBalancedFargateService(this, "Api", {
    cluster: myCluster,
    memoryLimitMiB: 512,
    cpu: 256,
    desiredCount: 3,
    taskImageOptions: { image: ecs.ContainerImage.fromRegistry("ghcr.io/linguadev/api:2.1.0") },
    publicLoadBalancer: true,
});
```

**Regla de oro:**
- Empezá con L2. Cae a L1 solo cuando L2 no expone algo (escape hatch: `const cfn = bucket.node.defaultChild as s3.CfnBucket; cfn.addPropertyOverride("...", "...")`).
- L3 solo si el patrón encaja exacto; si no, construí tus propios L3 con L2.
- Custom constructs internos = L3 con opinions de la organización.

### 3.3 CDK Aspects: policy-as-code cross-stack

Aspects permiten aplicar transformaciones o validaciones a todos los recursos de una app:

```typescript
import { IAspect, Annotations } from "aws-cdk-lib";
import { IConstruct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";

class RequireBucketEncryption implements IAspect {
    visit(node: IConstruct): void {
        if (node instanceof s3.CfnBucket) {
            const enc = node.bucketEncryption;
            if (!enc) {
                Annotations.of(node).addError(
                    `Bucket ${node.node.path} debe tener bucketEncryption configurado`
                );
            }
        }
    }
}

cdk.Aspects.of(app).add(new RequireBucketEncryption());
```

En `cdk synth`, si algún bucket viola la policy, el synth falla. Es equivalente a un linter integrado.

### 3.4 cdktf: CDK sobre Terraform

Si querés la ergonomía de CDK pero necesitás usar providers de Terraform (no todo está en AWS), `cdktf` es la opción.

```typescript
import { App, TerraformStack, TerraformOutput } from "cdktf";
import { AwsProvider } from "@cdktf/provider-aws/lib/provider";
import { S3Bucket } from "@cdktf/provider-aws/lib/s3-bucket";
import { Construct } from "constructs";

class LinguadevStack extends TerraformStack {
    constructor(scope: Construct, id: string) {
        super(scope, id);
        new AwsProvider(this, "AWS", { region: "eu-west-1" });
        const bucket = new S3Bucket(this, "Assets", { bucket: "linguadev-assets-cdktf" });
        new TerraformOutput(this, "bucketName", { value: bucket.id });
    }
}

const app = new App();
new LinguadevStack(app, "linguadev");
app.synth();
```

```bash
cdktf get       # descarga providers como packages TS
cdktf plan
cdktf deploy
```

Detrás, cdktf compila a JSON de Terraform y ejecuta `terraform apply`. Ganás: sintaxis TS/Python + ecosistema providers de TF (Cloudflare, Datadog, Snowflake, GitHub, Auth0 y cientos más).

### 3.5 cdk8s: manifiestos K8s con TypeScript

```typescript
import { App, Chart } from "cdk8s";
import { Deployment, Service } from "cdk8s-plus-30";
import { Construct } from "constructs";

class ApiChart extends Chart {
    constructor(scope: Construct, id: string) {
        super(scope, id);
        const dep = new Deployment(this, "api", {
            replicas: 3,
            containers: [{
                image: "ghcr.io/linguadev/api:2.1.0",
                port: 8080,
            }],
        });
        dep.exposeViaService({ ports: [{ port: 80, targetPort: 8080 }] });
    }
}

const app = new App();
new ApiChart(app, "linguadev-api");
app.synth();  // genera dist/linguadev-api.k8s.yaml
```

Ideal para GitOps: `cdk8s synth` genera manifiestos YAML → commit al repo `apps/` → Argo CD sincroniza al cluster.

---

## 4. Crossplane, testing y policy (nivel senior)

### 4.1 Crossplane: infra como CRDs en Kubernetes

Crossplane (CNCF Sandbox 2020 → Incubating 2022) invierte el modelo tradicional de IaC. En vez de un CLI (`terraform apply`, `pulumi up`) que ejecuta un batch, **el propio Kubernetes se convierte en control plane**. Los recursos cloud son CRDs; un controller los reconcilia continuamente. Si alguien borra un bucket a mano, Crossplane lo recrea. Perfecto para self-service developers en plataformas internas.

```yaml
# 1. Instalar Crossplane 1.18+ en un cluster
# helm install crossplane crossplane-stable/crossplane -n crossplane-system --create-namespace

# 2. Instalar provider AWS
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.crossplane.io/crossplane-contrib/provider-upjet-aws-s3:v1.18.0
---
# 3. Configurar credenciales (secret + ProviderConfig)
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-creds
      key: creds
---
# 4. Provisionar S3 bucket como CRD Kubernetes
apiVersion: s3.aws.upbound.io/v1beta1
kind: Bucket
metadata:
  name: linguadev-assets-dev
spec:
  forProvider:
    region: eu-west-1
    tags:
      Project: linguadev
      Env: dev
  providerConfigRef:
    name: default
```

```bash
kubectl apply -f bucket.yaml
kubectl get bucket linguadev-assets-dev
# NAME                    READY  SYNCED  EXTERNAL-NAME
# linguadev-assets-dev    True   True    linguadev-assets-dev
```

**Compositions**: el poder de Crossplane está en `XRD` (composite resource definition) + `Composition` para crear abstracciones ad-hoc: "una `LinguadevEnvironment` es VPC + EKS + RDS + Redis". Los devs escriben:

```yaml
apiVersion: platform.linguadev.io/v1alpha1
kind: LinguadevEnvironment
metadata:
  name: dev-tenant-42
spec:
  region: eu-west-1
  tier: small
```

Y Crossplane orquesta toda la infra detrás.

### 4.2 Testing de IaC

Cinco enfoques según herramienta y nivel:

**1. Unit tests con Pulumi (mocks)** — sin cloud real, rápido:

```typescript
// __tests__/bucket.test.ts
import * as pulumi from "@pulumi/pulumi";

pulumi.runtime.setMocks({
    newResource: (args) => ({
        id: `${args.name}-mock-id`,
        state: { ...args.inputs, arn: `arn:aws:${args.type}:::${args.name}` },
    }),
    call: (args) => args.inputs,
});

import { SecureBucket } from "../components/secure-bucket";

describe("SecureBucket", () => {
    it("creates a bucket with SSE and no public access", async () => {
        const bucket = new SecureBucket("test", { bucketName: "test-bucket" });
        const arn = await new Promise<string>(res => bucket.arn.apply(a => res(a)));
        expect(arn).toContain("arn:aws:aws:s3/bucketv2:BucketV2");
    });
});
```

**2. Snapshot tests con CDK** — comparar template CFN generado:

```typescript
// __tests__/stack.test.ts
import { Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import { LinguadevInfraStack } from "../lib/linguadev-infra-stack";

test("stack has encrypted bucket", () => {
    const app = new cdk.App();
    const stack = new LinguadevInfraStack(app, "TestStack");
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
            ServerSideEncryptionConfiguration: [{
                ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
            }],
        },
    });
});

test("no public buckets", () => {
    // ...
    template.allResourcesProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
        },
    });
});
```

**3. Integration tests con Terratest (Go)** — hace `terraform apply` real contra sandbox:

```go
// test/vpc_test.go
package test

import (
    "testing"
    "github.com/gruntwork-io/terratest/modules/terraform"
    "github.com/stretchr/testify/assert"
)

func TestVpcModule(t *testing.T) {
    opts := &terraform.Options{
        TerraformDir: "../modules/vpc",
        Vars: map[string]interface{}{
            "name": "test-vpc",
            "cidr": "10.99.0.0/16",
        },
    }
    defer terraform.Destroy(t, opts)
    terraform.InitAndApply(t, opts)

    vpcId := terraform.Output(t, opts, "vpc_id")
    assert.NotEmpty(t, vpcId)
}
```

**4. Policy tests con Conftest/OPA** — sobre `plan.json`:

```rego
package terraform.security

deny[msg] {
    r := input.resource_changes[_]
    r.type == "aws_s3_bucket"
    not r.change.after.server_side_encryption_configuration
    msg := sprintf("Bucket '%s' requires SSE", [r.address])
}
```

**5. Pulumi CrossGuard** — policies TS/Python en el pipeline de Pulumi:

```typescript
// policies/no-public-buckets.ts
import * as aws from "@pulumi/aws";
import { PolicyPack, validateResourceOfType } from "@pulumi/policy";

new PolicyPack("aws-security", {
    policies: [{
        name: "no-public-s3",
        description: "S3 buckets must not be public",
        enforcementLevel: "mandatory",
        validateResource: validateResourceOfType(aws.s3.BucketPublicAccessBlock, (pab, args, report) => {
            if (!pab.blockPublicAcls || !pab.blockPublicPolicy) {
                report("Public access block must be enabled");
            }
        }),
    }],
});
```

### 4.3 Comparativa: Pulumi vs Terraform/OpenTofu vs CDK vs Crossplane

| Dimensión | Pulumi | Terraform/OpenTofu | AWS CDK | Crossplane |
|---|---|---|---|---|
| Lenguaje | TS, Python, Go, C#, Java, YAML | HCL | TS, Python, Go, C#, Java | YAML (CRDs) |
| Motor | Propio (DAG runtime) | Terraform/OpenTofu core | CloudFormation | Kubernetes reconciler |
| Cloud coverage | Alto (AWS/Azure/GCP/K8s) | Muy alto (3000+ providers) | Solo AWS (nativo) | AWS/GCP/Azure/K8s |
| Multi-cloud | Sí | Sí | No | Sí |
| Testing unit | Excelente | Limitado (terratest = apply real) | Bueno (Template.fromStack) | K8s testing patterns |
| Estado | Pulumi Cloud / S3 / file | Backend configurable | CloudFormation | etcd (K8s) |
| Aprendizaje | Medio (Output<T>) | Bajo (HCL simple) | Medio (constructs) | Alto (K8s CRDs) |
| Ecosistema | Creciente | Enorme (registry) | Grande (constructs.dev) | Sandbox-Incubating |
| Reconciliation continua | No (batch apply) | No | No | Sí |
| Sweet spot | Devs con TS/Py, multi-cloud | Ops-heavy, cross-vendor | AWS-only apps | Plataformas internas K8s |

---

## 5. Ejemplo práctico: infra de LinguaDev Pro en Pulumi TypeScript

Vamos a provisionar VPC + RDS + S3 + Lambda + CloudFront con Pulumi. Estructura:

```
pulumi/
├── Pulumi.yaml
├── Pulumi.dev.yaml
├── Pulumi.prod.yaml
├── package.json
├── tsconfig.json
├── index.ts
├── components/
│   ├── network.ts
│   ├── database.ts
│   └── secure-bucket.ts
└── __tests__/
    └── secure-bucket.test.ts
```

### Paso 1: Componente de red

```typescript
// components/network.ts
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface NetworkArgs {
    cidr: pulumi.Input<string>;
    azCount: number;
    envName: pulumi.Input<string>;
}

export class Network extends pulumi.ComponentResource {
    public readonly vpcId: pulumi.Output<string>;
    public readonly publicSubnetIds: pulumi.Output<string>[];
    public readonly privateSubnetIds: pulumi.Output<string>[];

    constructor(name: string, args: NetworkArgs, opts?: pulumi.ComponentResourceOptions) {
        super("linguadev:aws:Network", name, {}, opts);

        const vpc = new aws.ec2.Vpc(`${name}-vpc`, {
            cidrBlock: args.cidr,
            enableDnsSupport: true,
            enableDnsHostnames: true,
            tags: { Name: pulumi.interpolate`${args.envName}-vpc` },
        }, { parent: this });

        const azs = aws.getAvailabilityZones({ state: "available" });

        this.publicSubnetIds = [];
        this.privateSubnetIds = [];

        for (let i = 0; i < args.azCount; i++) {
            const pub = new aws.ec2.Subnet(`${name}-public-${i}`, {
                vpcId: vpc.id,
                cidrBlock: pulumi.interpolate`10.${i}.0.0/24`,
                availabilityZone: azs.then(a => a.names[i]),
                mapPublicIpOnLaunch: true,
            }, { parent: this });
            this.publicSubnetIds.push(pub.id);

            const priv = new aws.ec2.Subnet(`${name}-private-${i}`, {
                vpcId: vpc.id,
                cidrBlock: pulumi.interpolate`10.${i + 100}.0.0/24`,
                availabilityZone: azs.then(a => a.names[i]),
            }, { parent: this });
            this.privateSubnetIds.push(priv.id);
        }

        const igw = new aws.ec2.InternetGateway(`${name}-igw`, {
            vpcId: vpc.id,
        }, { parent: this });

        this.vpcId = vpc.id;
        this.registerOutputs({ vpcId: this.vpcId });
    }
}
```

### Paso 2: Componente base de datos

```typescript
// components/database.ts
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface DatabaseArgs {
    identifier: pulumi.Input<string>;
    vpcId: pulumi.Input<string>;
    subnetIds: pulumi.Input<pulumi.Input<string>[]>;
    password: pulumi.Input<string>;
    instanceClass?: string;
}

export class Database extends pulumi.ComponentResource {
    public readonly endpoint: pulumi.Output<string>;

    constructor(name: string, args: DatabaseArgs, opts?: pulumi.ComponentResourceOptions) {
        super("linguadev:aws:Database", name, {}, opts);

        const sg = new aws.ec2.SecurityGroup(`${name}-sg`, {
            vpcId: args.vpcId,
            ingress: [{
                protocol: "tcp", fromPort: 5432, toPort: 5432,
                cidrBlocks: ["10.0.0.0/8"],
            }],
            egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
        }, { parent: this });

        const subnetGroup = new aws.rds.SubnetGroup(`${name}-subnets`, {
            subnetIds: args.subnetIds,
        }, { parent: this });

        const db = new aws.rds.Instance(`${name}-postgres`, {
            identifier: args.identifier,
            engine: "postgres",
            engineVersion: "16.4",
            instanceClass: args.instanceClass ?? "db.t4g.micro",
            allocatedStorage: 20,
            storageEncrypted: true,
            dbName: "linguadev",
            username: "linguadev",
            password: args.password,
            dbSubnetGroupName: subnetGroup.name,
            vpcSecurityGroupIds: [sg.id],
            skipFinalSnapshot: true,
        }, { parent: this });

        this.endpoint = db.endpoint;
        this.registerOutputs({ endpoint: this.endpoint });
    }
}
```

### Paso 3: entrypoint

```typescript
// index.ts
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Network } from "./components/network";
import { Database } from "./components/database";
import { SecureBucket } from "./components/secure-bucket";

const config = new pulumi.Config();
const env = config.require("env");
const dbPassword = config.requireSecret("dbPassword");

const network = new Network("main", {
    cidr: "10.0.0.0/16",
    azCount: 2,
    envName: env,
});

const db = new Database("main", {
    identifier: `linguadev-${env}`,
    vpcId: network.vpcId,
    subnetIds: pulumi.output(network.privateSubnetIds),
    password: dbPassword,
});

const assets = new SecureBucket("assets", { bucketName: `linguadev-assets-${env}` });

export const vpcId = network.vpcId;
export const dbEndpoint = db.endpoint;
export const bucketName = assets.arn;
```

### Paso 4: config por stack

```bash
pulumi stack init dev
pulumi config set env dev
pulumi config set --secret dbPassword $(openssl rand -base64 32)

pulumi stack init prod
pulumi config set env prod
pulumi config set --secret dbPassword $(openssl rand -base64 32)
```

### Paso 5: apply y test

```bash
pulumi stack select dev
pulumi preview          # dry-run
pulumi up               # apply
pulumi stack output

# Tests
npx jest
```

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ **Pulumi Output<T>**: nunca hagas fetch externo dentro de `.apply`, nunca `await` Outputs.
- ✅ **CDK L2 por default**; L1 solo como escape hatch.
- ✅ **CDK Aspects** para invariantes cross-stack (encryption obligatorio, tags obligatorios).
- ✅ **Un stack Pulumi/CDK por environment** (dev/staging/prod), no workspaces mezclados.
- ✅ **State remoto siempre** (Pulumi Cloud/S3, TF/OpenTofu backend, CloudFormation nativo).
- ✅ **Secrets con `pulumi config set --secret`** o AWS Secrets Manager, nunca hardcoded.
- ✅ **Snapshot tests en CDK** (`Template.hasResourceProperties`) + review manual del diff cuando cambian.
- ✅ **Policy-as-code en pipeline** (CrossGuard para Pulumi, Aspects para CDK, OPA/Sentinel para TF).
- ✅ **Crossplane Compositions** para self-service platform-as-a-product.
- ✅ **cdk8s** cuando querés dev-friendly generation de YAML para GitOps.
- ✅ **cdktf** si necesitás providers de TF pero preferís código TS/Python.
- ✅ **Versión pin de constructs**: `aws-cdk-lib ~= 2.170`.
- ✅ **En 2026, OpenTofu 1.10+** para greenfield que no necesita HCP Terraform.

### Anti-patrones

- ❌ Mezclar `pulumi stack` y `pulumi workspace` como si fueran lo mismo.
- ❌ `console.log(bucket.arn)` esperando string (imprime `[Output<T>]`).
- ❌ Fetch a APIs externas dentro de `.apply` (rompe determinism del DAG).
- ❌ Usar solo L1 CDK "porque es más explícito" (perdés todos los defaults sanos y grants).
- ❌ L3 pattern que no encaja + monkey-patching en cascada.
- ❌ CDK stack con >500 recursos (limits de CloudFormation, mejor split).
- ❌ `cdk deploy` en local con credenciales prod.
- ❌ Testear Terraform solo con `plan` (no captura runtime issues; usá Terratest para modules críticos).
- ❌ Crossplane sin Compositions (exponer CRDs providers directos = mala DX para devs).
- ❌ IaC "casino": una app en TF, otra en Pulumi, otra en CDK, sin criterio.

### Tabla decisión

| Necesitás | Elegí |
|---|---|
| IaC greenfield, equipo TS/Python fuerte, multi-cloud | **Pulumi** |
| Toda tu infra en AWS y ya usás CloudFormation | **AWS CDK** |
| Motor Terraform + sintaxis TS/Python + providers no-AWS | **cdktf** |
| Manifiestos K8s generados desde código | **cdk8s** |
| Self-service platform con reconciliation continua | **Crossplane** |
| Ops-heavy, HCL simple, multi-cloud amplio | **OpenTofu 1.10+** |
| Enterprise con Sentinel + private modules | **Terraform + HCP** |

---

## 7. Casos reales industria 2023-2026

**Snowflake usando Pulumi (2020+):** Snowflake migró infra multi-cloud a Pulumi con TypeScript para reutilizar skills de dev-heavy team. Componentes internos publicados como npm packages internos. **Lección:** Pulumi brilla cuando la abstracción interna es rica.

**Mercedes-Benz + Pulumi (2022+):** Mercedes reportó en Pulumi Cloud Engineering Summit su plataforma interna con >100 stacks Pulumi en TypeScript, generando entornos self-service para equipos de vehículos conectados. **Lección:** platform engineering con IaC ejecutivo escala mejor en lenguajes reales.

**AWS interno con CDK (2018+):** Amazon.com, Prime Video, Alexa construyen sobre CDK. Amazon publicó papers y talks sobre migración masiva de CloudFormation raw a CDK. **Lección:** CDK ganó porque Amazon lo usó primero.

**Airbnb migración parcial de TF a Pulumi (2023):** Airbnb reportó migrar abstracciones complejas (multi-region, multi-tenant) de Terraform a Pulumi para tener testing real y helpers. Mantuvieron TF para el core estable. **Lección:** herramientas coexisten; migra por bounded context, no big bang.

**Crossplane en Upbound + adopción enterprise (2022-2025):** empresas como Autodesk, PlayStation adoptaron Crossplane para plataformas internas donde devs pedían "un cluster con RDS" con `kubectl apply`. Upbound (empresa detrás de Crossplane) creció como proveedor managed. **Lección:** GitOps + Crossplane es la respuesta a "Terraform pipelines son lentos para devs".

**OpenTofu creación + LF governance (ago 2023 → 2026):** tras el cambio de licencia BSL de HashiCorp, Gruntwork, Spacelift, env0, Harness y otros fundaron OpenTofu bajo Linux Foundation. Versión 1.0 en enero 2024; 1.10 en julio 2025 con OCI registry y S3 native locking. En 2026 es el default OSS. **Lección:** governance neutral es factor de decisión.

**IBM adquiere HashiCorp (feb 2025):** IBM completó adquisición y HCP Terraform pasó a portafolio IBM Cloud. Comunidad OSS se recentró en OpenTofu. **Lección:** vendor consolidation acelera adopción de forks.

**cdk8s + Argo CD en Grafana Labs (2023+):** Grafana Labs usa cdk8s para generar manifests desde TypeScript y sincroniza con Argo CD. Reportaron eliminar Helm charts complejos con lógica ilegible. **Lección:** cdk8s es alternativa viable a Helm cuando la lógica de templating explota.

**Pulumi ESC + Copilot AI (2024-2026):** Pulumi lanzó ESC (Environments, Secrets, Configuration) para gestión unificada de config, y AI Copilot para generar código Pulumi. **Lección:** vendors compiten en DX; evaluá según tu stack.

**Panasonic Avionics + Pulumi Python (2024):** IoT infra multi-region con Pulumi Python. **Lección:** Python en Pulumi funciona bien para equipos data-heavy con familiaridad Python.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Componente Pulumi SecureBucket con test unitario

**Objetivo:** escribir un componente reutilizable y validar comportamiento con Jest.

**Setup:**
- Node.js 20 + pnpm.
- Pulumi CLI 3.140+ logueado.
- Directorio `lab-ex1/`.

**Pasos:**
1. `pulumi new aws-typescript` para bootstrap.
2. Creá `components/secure-bucket.ts` con la clase del ejemplo §2.3.
3. Instalá `@pulumi/policy` y `jest ts-jest @types/jest`.
4. Escribí `__tests__/secure-bucket.test.ts` con `setMocks`.
5. Ejecutá `npx jest` — debe pasar sin conexión a AWS.
6. `pulumi preview` contra sandbox real y verifica que crea bucket + versioning + SSE + PAB.

**Criterios de éxito:**
- [ ] Componente registra 4 recursos hijos (`bucket`, `versioning`, `sse`, `pab`).
- [ ] Test unitario pasa sin credenciales AWS.
- [ ] `pulumi preview` muestra 4 recursos con propiedades esperadas.
- [ ] `pulumi up` deja el bucket con SSE = AES256 verificado con `aws s3api get-bucket-encryption`.

**Bonus:** publica el componente como npm package interno y consúmelo desde otro proyecto.

---

### Ejercicio 2: Migrar un Ingress a cdk8s

**Objetivo:** reemplazar manifiesto YAML manual por cdk8s + integrar con Argo CD.

**Setup:**
- Cluster kind local.
- `cdk8s init typescript-app` en `lab-ex2/`.
- Kubernetes provider `cdk8s-plus-30`.

**Pasos:**
1. Escribí `main.ts` con un Deployment + Service + Ingress para `api` con 3 replicas.
2. `cdk8s synth` — genera `dist/lab-ex2.k8s.yaml`.
3. `kubectl apply -f dist/lab-ex2.k8s.yaml` — verifica que Deployment corre.
4. Refactorizá a un componente reutilizable `LinguadevApiChart` que reciba `image` y `replicas` como props.
5. Genera dos charts (`api` y `worker`) con la misma clase, distintos parámetros.
6. Añade helper `withMetrics` que agregue prometheus scrape annotations a todos los pods.

**Criterios de éxito:**
- [ ] `cdk8s synth` produce YAML válido pasando `kubectl apply --dry-run=client`.
- [ ] El chart genera Deployment, Service e Ingress.
- [ ] Componente reutilizable con parámetros funciona para 2 apps.
- [ ] Anotaciones prometheus aplicadas globalmente.

**Bonus:** setea Argo CD apuntando al directorio `dist/` y observa sync automático.

---

### Ejercicio 3: CDK Aspect para prohibir S3 públicos

**Objetivo:** implementar policy-as-code interna con CDK Aspects que rompa `cdk synth` ante violaciones.

**Setup:**
- CDK 2.170+ (`cdk init app --language typescript`).
- Stack con al menos 3 buckets, uno de ellos "malo" (sin PAB).

**Pasos:**
1. Crea la clase `RequireBucketPublicAccessBlock implements IAspect` que verifique cada `s3.CfnBucket`.
2. Registrala con `cdk.Aspects.of(app).add(...)` en `bin/*.ts`.
3. `cdk synth` — debe fallar con `Annotations.of(node).addError(...)`.
4. Corregí el bucket "malo".
5. `cdk synth` debe pasar y generar el CFN template.
6. Añade una segunda Aspect que **agregue** encryption por default si no está seteada (auto-fix en vez de validate).

**Criterios de éxito:**
- [ ] Aspect detecta bucket sin PAB y bloquea `cdk synth` con exit code != 0.
- [ ] Mensaje de error incluye path del recurso ofensor.
- [ ] Segunda Aspect muta recursos añadiendo encryption sin que fallen tests existentes.
- [ ] Snapshot test refleja el auto-fix.

**Bonus:** empaquetá las Aspects en un npm package `@linguadev/cdk-guardrails`.

---

### Ejercicio 4: Crossplane XRD + Composition para "LinguadevBucket"

**Objetivo:** exponer una abstracción interna vía CRD Kubernetes que provisiona bucket S3 con defaults.

**Setup:**
- Cluster kind con Crossplane 1.18+ instalado y provider AWS S3 configurado (`crossplane-contrib/provider-upjet-aws-s3:v1.18.0`).
- Credenciales AWS en secret.

**Pasos:**
1. Definí un `CompositeResourceDefinition` (XRD) `xlinguadev-buckets.platform.linguadev.io` con schema: `name`, `env`.
2. Definí un `Composition` que traduce el XR a un `Bucket` S3 + `BucketVersioning` + `BucketServerSideEncryptionConfiguration`.
3. Crea un `ClaimRef` en un namespace `apps/` con `apiVersion: platform.linguadev.io/v1alpha1, kind: LinguadevBucket, name: my-app-assets, env: dev`.
4. `kubectl get linguadevbucket` — el objeto debe `READY=True`.
5. Verifica que el bucket real existe en AWS.
6. Elimina el bucket a mano en la consola AWS y verifica que Crossplane lo recrea.

**Criterios de éxito:**
- [ ] XRD registrado y CRD generado (`kubectl get crd | grep linguadev`).
- [ ] Composition matchea el XR y crea recursos hijos.
- [ ] Claim `LinguadevBucket` refleja `READY=True`.
- [ ] Reconciliation recrea el bucket tras deleción manual.

**Bonus:** añade un `RDS` a la Composition para exponer `LinguadevAppStack = Bucket + RDS`.

---

### Ejercicio 5: Terratest de un module Terraform de LinguaDev

**Objetivo:** escribir un test Go que aplique un module real, valide outputs y destruya.

**Setup:**
- Go 1.22+.
- Sandbox AWS con permisos.
- Module `modules/s3-bucket` del cap 12 §5.

**Pasos:**
1. `mkdir -p test && cd test && go mod init linguadev-tf-tests`.
2. Instalá `go get github.com/gruntwork-io/terratest/modules/terraform`.
3. Escribí `s3_bucket_test.go` que use `terraform.Options` apuntando al module.
4. `defer terraform.Destroy(t, opts)` para cleanup garantizado.
5. `terraform.InitAndApply(t, opts)` + assertions sobre outputs.
6. Ejecutá `go test -v -timeout 30m`.
7. Verificá cleanup: no debe quedar bucket en AWS.

**Criterios de éxito:**
- [ ] Test corre `apply` real contra sandbox.
- [ ] Outputs asertados (bucket name, arn).
- [ ] `terraform destroy` ejecuta aunque el test falle (defer).
- [ ] Sin recursos huérfanos en AWS.

**Bonus:** parametrizá el test con `t.Run` para probar 3 configuraciones (encrypted, versioning off, con logging).

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [pulumi.com/docs](https://www.pulumi.com/docs) — Pulumi 3.140+.
- [docs.aws.amazon.com/cdk](https://docs.aws.amazon.com/cdk/v2/guide/home.html) — AWS CDK 2.
- [developer.hashicorp.com/terraform/cdktf](https://developer.hashicorp.com/terraform/cdktf) — cdktf.
- [cdk8s.io](https://cdk8s.io) — cdk8s.
- [crossplane.io](https://www.crossplane.io) — Crossplane 1.18+.
- [opentofu.org](https://opentofu.org) — OpenTofu.
- [constructs.dev](https://constructs.dev) — Construct Hub para CDK.

**Herramientas y libs:**
- [Terratest](https://terratest.gruntwork.io) — testing Go para TF.
- [Pulumi CrossGuard](https://www.pulumi.com/docs/using-pulumi/crossguard/) — policy-as-code.
- [Kitchen-Terraform](https://github.com/newcontext-oss/kitchen-terraform) — testing con Test Kitchen.
- [Conftest](https://www.conftest.dev) + OPA — policies genéricas para plan.json.
- [Checkov](https://www.checkov.io) — security scanning multi-framework.
- [driftctl](https://github.com/snyk/driftctl) — drift detection.

**Libros y referencias:**
- Joe Duffy, "*Modern Infrastructure with Pulumi*" (2022, Pulumi blog series).
- Rosemary Wang, "*Infrastructure as Code, Patterns and Practices*" (Manning, 2022).
- Yevgeniy Brikman, "*Terraform: Up & Running*" (O'Reilly, 3ª ed. 2022).
- Talks de KubeCon 2024-2026 sobre Crossplane Compositions.

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Evaluá cuál herramienta encaja mejor con tu equipo y stack actual.
- Configurá pipeline de CI con testing (Jest para Pulumi/CDK, Terratest para TF).
- Añadí policy-as-code (Aspects, CrossGuard o OPA) al pipeline.
- Continuá con [cap 17 — Prometheus y metrics](./17-prometheus-y-metrics.md) para observability.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre Pulumi (Output<T>, componentes, config, secrets, backend), AWS CDK (L1/L2/L3, Aspects, synth), cdktf, cdk8s, Crossplane (Providers, XRDs, Compositions), OpenTofu (fork, features 2026), testing (Terratest, Jest, snapshot), policy-as-code (Sentinel, OPA, CrossGuard, Aspects) y decisiones arquitectónicas. Dificultad junior → staff.

- **Fuente:** [`packages/content/src/tech/devops/sim-16-pulumi-cdk-and-modern-iac.json`](../../packages/content/src/tech/devops/sim-16-pulumi-cdk-and-modern-iac.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-16-pulumi-cdk-and-modern-iac`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 15 — GitOps con Argo CD y Flux](./15-gitops-con-argocd-y-flux.md) · [Índice](./README.md) · [Capítulo 17 — Prometheus y metrics →](./17-prometheus-y-metrics.md)
