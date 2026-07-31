export type HonoEnv = {
  Variables: {
    budgetKey: { PK: string; SK: string };
    aiSpendUsd: number;
  };
};

// Getters dinámicos: leen process.env cada acceso. Necesario porque este módulo se importa
// desde otros (via app.ts) antes de que dotenv termine de cargar (ES imports hoisted).
export const env = {
  get region() {
    return process.env.AWS_REGION ?? 'us-east-1';
  },
  get ddbEndpoint() {
    return process.env.DDB_ENDPOINT;
  },
  get ddbTable() {
    return process.env.DDB_TABLE ?? 'linguadev-dev';
  },
  get ssmParamName() {
    return process.env.SSM_AI_KEY_PARAM ?? '/linguadev/ai/apiKey';
  },
  get aiProvider() {
    return (process.env.AI_PROVIDER ?? 'anthropic') as 'anthropic' | 'openai' | 'deepseek' | 'bedrock';
  },
  get aiRateLimitPerMin() {
    return Number(process.env.AI_RATE_LIMIT_PER_MIN ?? 20);
  },
  get aiDailyBudgetUsd() {
    return Number(process.env.AI_DAILY_BUDGET_USD ?? 1);
  },
  get isLambda() {
    return !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  },
  get isDev() {
    return (process.env.NODE_ENV ?? 'development') === 'development';
  },
  get corsAllowedOrigins() {
    return (process.env.CORS_ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());
  },
};
