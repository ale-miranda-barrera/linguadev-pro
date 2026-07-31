import { z } from 'zod';
import { QuestionSchema } from './question.js';

const SafeString = z
  .string()
  .max(2000)
  .refine((s) => !/<script/i.test(s), { message: 'contains disallowed tag' });

export const CEFRLevelSchema = z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
export const CEFRBandSchema = z.enum(['A2', 'A2+', 'B1', 'B1+', 'B2', 'B2+', 'C1']);

export const VocabCardSchema = z.object({
  id: z.string().min(1).max(128),
  term: SafeString,
  translation: SafeString,
  example: SafeString.optional(),
  ipa: z.string().max(200).optional(),
  audioUrl: z.string().url().optional(),
  // Emoji o pequeño glifo que ilustra el concepto. Cabe uno o dos emojis.
  emoji: z.string().max(8).optional(),
  tags: z.array(z.string().max(40)).max(20).default([]),
});

export const ListeningItemSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['dictation', 'comprehension']),
  audioUrl: z.string().url().optional(),
  text: SafeString,
  transcript: SafeString.optional(),
  questions: z
    .array(
      z.object({
        q: SafeString,
        options: z.array(SafeString).min(2).max(6),
        answerIndex: z.number().int().min(0).max(5),
      }),
    )
    .max(10)
    .optional(),
});

export const SpeakingItemSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['shadowing', 'read-aloud', 'roleplay']),
  target: SafeString,
  hint: SafeString.optional(),
});

export const WritingPromptSchema = z.object({
  id: z.string().min(1).max(128),
  prompt: SafeString,
  minWords: z.number().int().min(10).max(1000).default(40),
  hints: z.array(SafeString).max(10).default([]),
});

export const GrammarPointSchema = z.object({
  id: z.string().min(1).max(128),
  title: SafeString,
  explanation: SafeString,
  examples: z.array(SafeString).max(20).default([]),
  practice: z
    .array(
      z.object({
        prompt: SafeString,
        answer: SafeString,
      }),
    )
    .max(20)
    .default([]),
});

export const PackSchemaV2 = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1).max(128),
  title: SafeString,
  level: CEFRLevelSchema,
  language: z.literal('en'),
  description: SafeString.optional(),
  vocab: z.array(VocabCardSchema).max(500).default([]),
  listening: z.array(ListeningItemSchema).max(200).default([]),
  speaking: z.array(SpeakingItemSchema).max(200).default([]),
  writing: z.array(WritingPromptSchema).max(100).default([]),
  grammar: z.array(GrammarPointSchema).max(100).default([]),
  // Packs custom construidos por el usuario usan `questions` como fuente principal.
  // Los bundled los dejan vacíos y usan las secciones tradicionales.
  questions: z.array(QuestionSchema).max(500).default([]),
  // Marca pack creado por el usuario (para diferenciarlo en UI y sync).
  custom: z.boolean().optional(),
  updatedAt: z.string().datetime().optional(),
  // Level pack metadata: 250 packs organizados por band + order.
  band: CEFRBandSchema.optional(),
  levelOrder: z.number().int().min(1).max(500).optional(),
  topic: SafeString.optional(),
  // % de aciertos requeridos para avanzar al siguiente nivel (0-1). Default 0.8.
  passThreshold: z.number().min(0).max(1).optional(),
});

export type Pack = z.infer<typeof PackSchemaV2>;
export type VocabCard = z.infer<typeof VocabCardSchema>;
export type ListeningItem = z.infer<typeof ListeningItemSchema>;
export type SpeakingItem = z.infer<typeof SpeakingItemSchema>;
export type WritingPrompt = z.infer<typeof WritingPromptSchema>;
export type GrammarPoint = z.infer<typeof GrammarPointSchema>;
