// Thin wrapper alrededor de ts-fsrs. Fija ratings, calcula próximo estado y expone helpers puros
// para probar sin fecha real. La fuente de verdad del progreso vive en el cliente (IndexedDB);
// el backend solo respalda estos objetos SrsState en DynamoDB.

import { fsrs, generatorParameters, Rating, State, type Card as FsrsCard, type Grade } from 'ts-fsrs';
import type { SrsState } from '../schemas/sync.js';

export const FSRS_PARAMS = generatorParameters({
  enable_fuzz: true,
  maximum_interval: 365,
});

const engine = fsrs(FSRS_PARAMS);

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

// ts-fsrs indexa IPreview por `Grade` (Rating excluyendo Manual). Tipamos así para que TS lo acepte.
const RATING_MAP: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

export function emptyCard(cardId: string, now: Date = new Date()): SrsState {
  return {
    cardId,
    due: now.toISOString(),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
  };
}

function toFsrsCard(s: SrsState): FsrsCard {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsedDays,
    scheduled_days: s.scheduledDays,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state as State,
    last_review: s.lastReview ? new Date(s.lastReview) : undefined,
  };
}

function fromFsrsCard(cardId: string, c: FsrsCard): SrsState {
  return {
    cardId,
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as number,
    lastReview: c.last_review ? c.last_review.toISOString() : undefined,
  };
}

export function review(state: SrsState, rating: ReviewRating, now: Date = new Date()): SrsState {
  const card = toFsrsCard(state);
  const scheduling = engine.repeat(card, now);
  const next = scheduling[RATING_MAP[rating]].card;
  return fromFsrsCard(state.cardId, next);
}

export function isDue(state: SrsState, now: Date = new Date()): boolean {
  return new Date(state.due).getTime() <= now.getTime();
}

// Límite diario para evitar avalancha tras semanas sin estudiar.
export function pickDailyQueue(
  states: readonly SrsState[],
  dailyLimit: number,
  now: Date = new Date(),
): SrsState[] {
  const due = states.filter((s) => isDue(s, now));
  // Prioriza cartas atrasadas: due más antigua primero.
  due.sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());
  return due.slice(0, dailyLimit);
}
