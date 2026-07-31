import { z } from 'zod';

// SafeString: max 2000, sin <script>. Reutilizado del pack schema para consistencia.
const SafeString = z
  .string()
  .max(2000)
  .refine((s) => !/<script/i.test(s), { message: 'contains disallowed tag' });

// Imagen: data URI o URL http(s). No blob:, no javascript:.
const SafeImage = z.string().max(2_000_000).refine(
  (s) => /^(data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,|https?:\/\/)/i.test(s),
  { message: 'invalid image (must be data:image or http(s) URL)' },
);

// Base común: metadata compartida por todos los tipos.
// explanation + examples aparecen en feedback cuando el usuario se equivoca.
const BaseQuestion = z.object({
  id: z.string().min(1).max(128),
  prompt: SafeString.optional(), // enunciado / instrucción
  image: SafeImage.optional(),
  hint: SafeString.optional(),
  audioText: SafeString.optional(), // texto a leer con TTS
  explanation: SafeString.optional(),
  examples: z.array(SafeString).max(4).optional(),
});

// 1. Opción múltiple
export const MultipleChoiceQuestionSchema = BaseQuestion.extend({
  type: z.literal('multiple-choice'),
  question: SafeString,
  options: z.array(SafeString).min(2).max(6),
  correctIndex: z.number().int().min(0).max(5),
});

// 2. Verdadero/Falso (o Good/Bad para "¿es correcta esta traducción?")
export const TrueFalseQuestionSchema = BaseQuestion.extend({
  type: z.literal('true-false'),
  statement: SafeString,
  correct: z.boolean(),
});

// 3. Dictado
export const DictationQuestionSchema = BaseQuestion.extend({
  type: z.literal('dictation'),
  text: SafeString, // el usuario debe escribirlo
  playbackRate: z.number().min(0.5).max(1.5).default(1),
});

// 4. Emparejar (match: pares término↔traducción)
export const MatchQuestionSchema = BaseQuestion.extend({
  type: z.literal('match'),
  pairs: z
    .array(z.object({ left: SafeString, right: SafeString }))
    .min(2)
    .max(8),
});

// 5. Hablar (read-aloud / shadowing con SR + scoring)
export const SpeakingQuestionSchema = BaseQuestion.extend({
  type: z.literal('speaking'),
  target: SafeString,
});

export const QuestionSchema = z.discriminatedUnion('type', [
  MultipleChoiceQuestionSchema,
  TrueFalseQuestionSchema,
  DictationQuestionSchema,
  MatchQuestionSchema,
  SpeakingQuestionSchema,
]);

export type Question = z.infer<typeof QuestionSchema>;
export type MultipleChoiceQuestion = z.infer<typeof MultipleChoiceQuestionSchema>;
export type TrueFalseQuestion = z.infer<typeof TrueFalseQuestionSchema>;
export type DictationQuestion = z.infer<typeof DictationQuestionSchema>;
export type MatchQuestion = z.infer<typeof MatchQuestionSchema>;
export type SpeakingQuestion = z.infer<typeof SpeakingQuestionSchema>;

export type QuestionType = Question['type'];

export const QUESTION_TYPES: QuestionType[] = [
  'multiple-choice',
  'true-false',
  'dictation',
  'match',
  'speaking',
];
