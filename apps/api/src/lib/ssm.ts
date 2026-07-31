import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { env } from './env.js';

// Cache en memoria del contenedor Lambda. TTL 10 min para permitir rotación sin redeploy.
let cachedValue: string | undefined;
let cachedAt = 0;
const TTL_MS = 10 * 60 * 1000;

export async function getAiApiKey(): Promise<string | undefined> {
  // En dev preferimos process.env para no depender de AWS.
  if (env.isDev) {
    if (env.aiProvider === 'anthropic') return process.env.ANTHROPIC_API_KEY || undefined;
    if (env.aiProvider === 'openai') return process.env.OPENAI_API_KEY || undefined;
    if (env.aiProvider === 'deepseek') return process.env.DEEPSEEK_API_KEY || undefined;
    return undefined;
  }
  const fresh = Date.now() - cachedAt < TTL_MS;
  if (cachedValue && fresh) return cachedValue;
  const client = new SSMClient({ region: env.region });
  const out = await client.send(
    new GetParameterCommand({ Name: env.ssmParamName, WithDecryption: true }),
  );
  cachedValue = out.Parameter?.Value;
  cachedAt = Date.now();
  return cachedValue;
}
