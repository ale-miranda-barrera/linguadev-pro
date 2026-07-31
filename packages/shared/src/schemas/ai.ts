import { z } from 'zod';
import { CEFRLevelSchema, PackSchemaV2 } from './pack.js';
import { MultipleChoiceQuestionSchema } from './question.js';

export const WritingCorrectRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  level: CEFRLevelSchema,
  goal: z.string().max(200).optional(),
});

export const WritingDiffSchema = z.object({
  op: z.enum(['keep', 'insert', 'delete', 'replace']),
  before: z.string().max(500).optional(),
  after: z.string().max(500).optional(),
  reason: z.string().max(500).optional(),
});

export const WritingCorrectResponseSchema = z.object({
  corrected: z.string().max(6000),
  diffs: z.array(WritingDiffSchema).max(500),
  betterVersion: z.string().max(6000),
  score: z.number().min(0).max(100),
});

export const SpeakingEvalRequestSchema = z.object({
  target: z.string().min(1).max(2000),
  transcript: z.string().min(1).max(4000),
  level: CEFRLevelSchema,
});

export const SpeakingEvalResponseSchema = z.object({
  score: z.number().min(0).max(100),
  matched: z.number().int().min(0),
  total: z.number().int().min(1),
  tips: z.array(z.string().max(400)).max(10),
});

export const TutorRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  level: CEFRLevelSchema,
  scenario: z.string().max(300),
  turns: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(4000),
      }),
    )
    .max(30),
});

export const PackGenerateRequestSchema = z.object({
  topic: z.string().min(1).max(200),
  level: CEFRLevelSchema,
  counts: z
    .object({
      vocab: z.number().int().min(0).max(30).default(12),
      listening: z.number().int().min(0).max(10).default(2),
      speaking: z.number().int().min(0).max(10).default(3),
      writing: z.number().int().min(0).max(5).default(1),
      grammar: z.number().int().min(0).max(5).default(1),
    })
    .default({}),
});

export const PackGenerateResponseSchema = z.object({
  pack: PackSchemaV2,
});

// ─── Tutor lesson (modo tutor: MD → resumen + ejemplos + quiz) ───

export const TutorLessonRequestSchema = z.object({
  markdown: z.string().min(20).max(20000),
  level: CEFRLevelSchema,
  language: z.enum(['en', 'es']).default('es'),
});

export const TutorLessonResponseSchema = z.object({
  title: z.string().max(200),
  summary: z.string().max(2000),
  keyPoints: z.array(z.string().max(500)).max(12),
  examples: z.array(z.string().max(500)).max(12),
  questions: z.array(MultipleChoiceQuestionSchema).max(10),
});

export type WritingCorrectRequest = z.infer<typeof WritingCorrectRequestSchema>;
export type WritingCorrectResponse = z.infer<typeof WritingCorrectResponseSchema>;
export type SpeakingEvalRequest = z.infer<typeof SpeakingEvalRequestSchema>;
export type SpeakingEvalResponse = z.infer<typeof SpeakingEvalResponseSchema>;
export type TutorRequest = z.infer<typeof TutorRequestSchema>;
export type PackGenerateRequest = z.infer<typeof PackGenerateRequestSchema>;
export type PackGenerateResponse = z.infer<typeof PackGenerateResponseSchema>;
export type TutorLessonRequest = z.infer<typeof TutorLessonRequestSchema>;
export type TutorLessonResponse = z.infer<typeof TutorLessonResponseSchema>;
