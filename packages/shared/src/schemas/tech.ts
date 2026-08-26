import { z } from 'zod';

// TechTrack — tracks de práctica no-certificación (programador, arquitectura, futuro DevOps, DB, Cloud).
// Reusamos el modelo de simulación con escenario + preguntas MC/multi-select + explicación granular.
// Separado de AWS porque el ID enum de AWS está acoplado a las 2 certificaciones oficiales.

const SafeString = z
  .string()
  .max(4000)
  .refine((s) => !/<script/i.test(s), { message: 'contains disallowed tag' });

const LongText = z
  .string()
  .max(12_000)
  .refine((s) => !/<script/i.test(s), { message: 'contains disallowed tag' });

export const TechTrackIdSchema = z.enum([
  'programmer',
  'architecture',
  'devops',
  'databases',
  'systemdesign',
  'ai-programming',
]);
export type TechTrackId = z.infer<typeof TechTrackIdSchema>;

export const TechDifficultySchema = z.enum(['junior', 'mid', 'senior', 'staff']);
export type TechDifficulty = z.infer<typeof TechDifficultySchema>;

export const TechAreaSchema = z.object({
  id: z.string().min(1).max(64),
  name: SafeString,
  description: SafeString.optional(),
});
export type TechArea = z.infer<typeof TechAreaSchema>;

export const TechAnswerOptionSchema = z.object({
  letter: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
  text: SafeString,
  correct: z.boolean(),
  why: SafeString.optional(),
});
export type TechAnswerOption = z.infer<typeof TechAnswerOptionSchema>;

export const TechQuestionSchema = z.object({
  id: z.string().min(1).max(128),
  areaId: z.string().min(1).max(64),
  topic: SafeString,
  difficulty: TechDifficultySchema,
  scenario: LongText,
  question: SafeString,
  multiSelect: z.boolean().default(false),
  options: z.array(TechAnswerOptionSchema).min(2).max(6),
  explanation: LongText,
  // Real-world example — historia corta, incidente, patrón de sistema (opcional).
  realWorld: LongText.optional(),
  // Tags para filtrar por concepto (SOLID, cache, CAP, etc.).
  tags: z.array(SafeString).max(20).default([]),
  // Tecnologías/librerías/servicios mencionadas (Redis, Postgres, Kafka, Lambda, etc.).
  tech: z.array(SafeString).max(15).default([]),
  references: z
    .array(
      z.object({
        title: SafeString,
        url: z.string().url().optional(),
      }),
    )
    .max(10)
    .default([]),
});
export type TechQuestion = z.infer<typeof TechQuestionSchema>;

export const TechSimulationSchema = z.object({
  id: z.string().min(1).max(128),
  trackId: TechTrackIdSchema,
  order: z.number().int().min(1).max(200),
  title: SafeString,
  focus: SafeString,
  areaCoverage: z.array(z.string()).min(1).max(10),
  timeLimitMin: z.number().int().min(5).max(300).default(25),
  passThreshold: z.number().min(0).max(1).default(0.75),
  questions: z.array(TechQuestionSchema).min(3).max(50),
  updatedAt: z.string().datetime().optional(),
});
export type TechSimulation = z.infer<typeof TechSimulationSchema>;

export const TechTrackSchema = z.object({
  id: TechTrackIdSchema,
  name: SafeString,
  tagline: SafeString,
  description: LongText,
  color: z.string().max(64).default('brand'),
  icon: z.string().max(4).default('💻'),
  areas: z.array(TechAreaSchema).min(1).max(15),
});
export type TechTrack = z.infer<typeof TechTrackSchema>;
