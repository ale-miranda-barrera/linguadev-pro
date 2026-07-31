import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { env } from './env.js';

let cached: DynamoDBDocumentClient | undefined;

export function ddb(): DynamoDBDocumentClient {
  if (cached) return cached;
  const base = new DynamoDBClient({
    region: env.region,
    ...(env.ddbEndpoint
      ? {
          endpoint: env.ddbEndpoint,
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }
      : {}),
  });
  cached = DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
  });
  return cached;
}

export const TABLE = env.ddbTable;
