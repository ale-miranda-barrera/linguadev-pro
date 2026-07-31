import { z } from 'zod';

// AWS certification content schema.
// Separado del Pack de inglés porque el modelo mental es distinto:
// - Certification (CLF-C02 / SAA-C03) tiene N simulations
// - Simulation = mini-examen temático de 10-15 preguntas
// - Cada AwsQuestion = MC single o multi-select con whyWrong por distractor + references

const SafeString = z
  .string()
  .max(4000)
  .refine((s) => !/<script/i.test(s), { message: 'contains disallowed tag' });

const LongText = z
  .string()
  .max(10_000)
  .refine((s) => !/<script/i.test(s), { message: 'contains disallowed tag' });

export const AwsCertIdSchema = z.enum(['clf-c02', 'saa-c03']);
export type AwsCertId = z.infer<typeof AwsCertIdSchema>;

export const AwsDifficultySchema = z.enum(['easy', 'medium', 'hard']);
export type AwsDifficulty = z.infer<typeof AwsDifficultySchema>;

// Un dominio oficial del examen (ej. "Security & Compliance", "Design Resilient Architectures")
export const AwsDomainSchema = z.object({
  id: z.string().min(1).max(64), // "sec", "resilient", "cost"
  name: SafeString,
  weight: z.number().min(0).max(1), // fracción del examen (ej. 0.30 = 30%)
});

// Opción de respuesta con su explicación de por qué es correcta/incorrecta.
export const AwsAnswerOptionSchema = z.object({
  letter: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
  text: SafeString,
  correct: z.boolean(),
  // Explicación específica: por qué esta opción es correcta o por qué es un distractor típico.
  // Debe enseñar (no solo decir "es incorrecta").
  why: SafeString.optional(),
});

export const AwsQuestionSchema = z.object({
  id: z.string().min(1).max(128),
  domainId: z.string().min(1).max(64), // FK al Domain
  topic: SafeString, // "EC2 Auto Scaling", "S3 Storage Classes"
  difficulty: AwsDifficultySchema,
  // Escenario: contexto realista (empresa, requerimientos, restricciones).
  scenario: LongText,
  // Pregunta concreta al final del escenario.
  question: SafeString,
  // Multi-select si esperas más de 1 respuesta correcta. UI muestra checkboxes vs radios.
  multiSelect: z.boolean().default(false),
  options: z.array(AwsAnswerOptionSchema).min(2).max(6),
  // Explicación integral de la respuesta (además del `why` por opción).
  explanation: LongText,
  // Palabras clave que "disparan" esta respuesta en el enunciado (para review y estudio).
  keywords: z.array(SafeString).max(20).default([]),
  // Servicios AWS involucrados.
  services: z.array(SafeString).max(15).default([]),
  // Referencias a docs oficiales AWS (opcional).
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

export const AwsSimulationSchema = z.object({
  id: z.string().min(1).max(128),
  certId: AwsCertIdSchema,
  order: z.number().int().min(1).max(50),
  title: SafeString,
  focus: SafeString, // "Domain 2 — Security & Compliance", "Mixed final"
  domainCoverage: z.array(z.string()).min(1).max(6), // ids de domains cubiertos
  timeLimitMin: z.number().int().min(5).max(300).default(20),
  passThreshold: z.number().min(0).max(1).default(0.7),
  questions: z.array(AwsQuestionSchema).min(5).max(65),
  updatedAt: z.string().datetime().optional(),
});

export const AwsCertificationSchema = z.object({
  id: AwsCertIdSchema,
  name: SafeString, // "AWS Cloud Practitioner (CLF-C02)"
  code: SafeString, // "CLF-C02"
  totalQuestionsInExam: z.number().int().min(1).max(200),
  timeLimitMin: z.number().int().min(30).max(360),
  passingScore: z.number().int().min(0).max(1000),
  domains: z.array(AwsDomainSchema).min(1).max(10),
  description: LongText,
});

export type AwsDomain = z.infer<typeof AwsDomainSchema>;
export type AwsAnswerOption = z.infer<typeof AwsAnswerOptionSchema>;
export type AwsQuestion = z.infer<typeof AwsQuestionSchema>;
export type AwsSimulation = z.infer<typeof AwsSimulationSchema>;
export type AwsCertification = z.infer<typeof AwsCertificationSchema>;
