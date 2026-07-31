# infra — AWS SAM stack

Stack "always-free" para LinguaDev Pro. Lo que crea:

- **Lambda (Node 20, arm64)** con Function URL en modo `RESPONSE_STREAM` (para `/api/ai/tutor`).
- **DynamoDB** single-table `linguadev-{stage}`, `PAY_PER_REQUEST`, TTL en `ttl`, PITR on.
- **S3** privado (`linguadev-web-{stage}-{account}`) + **CloudFront** con **OAC** para servir la PWA.
- **AWS Budgets** con alertas a 20% y 80% del límite (default $5).
- **IAM** para la Lambda: solo `DynamoDBCrudPolicy` sobre la tabla y `ssm:GetParameter` sobre `/linguadev/ai/*`.

## Requisitos previos

1. Instalar AWS SAM CLI y credenciales configuradas (`aws configure`).
2. Crear el parámetro con la API key de IA (SecureString — no lo hace CFN por seguridad):

   ```bash
   aws ssm put-parameter \
     --name /linguadev/ai/apiKey \
     --type SecureString \
     --value "sk-..."
   ```

## Deploy

```bash
# Bundle del backend:
pnpm --filter @linguadev/api build

# Deploy inicial (guiado, guarda samconfig.toml):
pnpm sam:deploy

# Deploy siguiente:
sam deploy
```

## Deploy del frontend

```bash
pnpm --filter @linguadev/web build
aws s3 sync apps/web/dist/ s3://$(sam list stack-outputs --stack-name linguadev-pro-dev --output json | jq -r '.[] | select(.OutputKey=="WebBucketName") | .OutputValue) --delete
aws cloudfront create-invalidation --distribution-id <ID> --paths '/*'
```

## Comprobación rápida

```bash
curl "$(sam list stack-outputs --stack-name linguadev-pro-dev --output json | jq -r '.[] | select(.OutputKey=="ApiFunctionUrl") | .OutputValue)api/health"
```
