import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
  'AI_UNAVAILABLE',
  'AI_TIMEOUT',
  'UNAUTHORIZED',
  'INTERNAL_ERROR',
  'PAYLOAD_TOO_LARGE',
]);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;
