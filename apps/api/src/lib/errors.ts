import type { Context } from 'hono';
import type { ErrorCode } from '@linguadev/shared';

export function apiError(c: Context, code: ErrorCode, message: string, status = 400, details?: unknown) {
  return c.json({ error: { code, message, details } }, status as never);
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
