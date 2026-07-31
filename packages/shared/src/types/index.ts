export type CEFRLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

export const CEFR_ORDER: readonly CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

export type Skill = 'vocab' | 'listening' | 'speaking' | 'writing' | 'grammar';

export type ExerciseType =
  | 'flashcard'
  | 'choice'
  | 'typed-answer'
  | 'dictation'
  | 'shadowing'
  | 'read-aloud'
  | 'writing-prompt'
  | 'gap-fill'
  | 'word-bank'
  | 'listening-mcq';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED'
  | 'AI_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR'
  | 'PAYLOAD_TOO_LARGE';

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}
