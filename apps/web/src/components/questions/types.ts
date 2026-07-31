import type { Question } from '@linguadev/shared';

// Contrato común entre QuestionRunner y cada componente de tipo.
// onResult reporta si acertó y devuelve metadata útil (respuesta, score parcial).
export interface QuestionComponentProps<Q extends Question = Question> {
  question: Q;
  onResult: (result: QuestionResult) => void;
  // Cuando true el componente muestra la respuesta correcta y desactiva inputs.
  revealed: boolean;
}

export interface QuestionResult {
  correct: boolean;
  score01: number; // 0..1
  userAnswer?: string;
  meta?: Record<string, unknown>;
}
