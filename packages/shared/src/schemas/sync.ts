import { z } from 'zod';
import { CEFRLevelSchema } from './pack.js';

export const SrsStateSchema = z.object({
  cardId: z.string(),
  due: z.string().datetime(),
  stability: z.number(),
  difficulty: z.number(),
  elapsedDays: z.number(),
  scheduledDays: z.number(),
  reps: z.number().int().min(0),
  lapses: z.number().int().min(0),
  state: z.number().int().min(0).max(3),
  lastReview: z.string().datetime().optional(),
});

export const ErrorEntrySchema = z.object({
  id: z.string(),
  ts: z.string().datetime(),
  skill: z.enum(['vocab', 'listening', 'speaking', 'writing', 'grammar']),
  prompt: z.string().max(2000),
  userAnswer: z.string().max(4000),
  correction: z.string().max(4000).optional(),
  explanation: z.string().max(4000).optional(),
});

export const SyncStateSchema = z.object({
  version: z.number().int().min(1),
  updatedAt: z.string().datetime(),
  profile: z.object({
    level: CEFRLevelSchema,
    streak: z.number().int().min(0).default(0),
    dailyGoalMinutes: z.number().int().min(5).max(180).default(15),
    tz: z.string().max(64).default('UTC'),
  }),
  srs: z.array(SrsStateSchema).max(50000).default([]),
  errors: z.array(ErrorEntrySchema).max(10000).default([]),
  packsEnabled: z.array(z.string()).max(500).default([]),
});

export type SyncState = z.infer<typeof SyncStateSchema>;
export type SrsState = z.infer<typeof SrsStateSchema>;
export type ErrorEntry = z.infer<typeof ErrorEntrySchema>;
