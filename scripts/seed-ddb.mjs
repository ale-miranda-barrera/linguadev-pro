#!/usr/bin/env node
// Crea la tabla single-table en DynamoDB Local para desarrollo.
// Ejecutar tras `pnpm ddb:up`.

import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const endpoint = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const region = process.env.AWS_REGION ?? 'us-east-1';
const table = process.env.DDB_TABLE ?? 'linguadev-dev';

const client = new DynamoDBClient({
  endpoint,
  region,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

async function tableExists() {
  try {
    await client.send(new DescribeTableCommand({ TableName: table }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function main() {
  if (await tableExists()) {
    console.log(`Table ${table} already exists at ${endpoint}`);
    return;
  }
  await client.send(
    new CreateTableCommand({
      TableName: table,
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  console.log(`Created table ${table} at ${endpoint}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
