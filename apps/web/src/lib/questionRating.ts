// Rating manual del usuario post-respuesta (SRS-lite).
// Basado en la escala de Anki/FSRS: Again (fallé) / Hard / Good / Easy.
// Persiste en localStorage por questionId. Feed para un future review queue.

export type Rating = 'again' | 'hard' | 'good' | 'easy';

interface RatingRecord {
  rating: Rating;
  ts: string;
  // Historia acumulada — cuántas veces has valorado esta pregunta y con qué.
  history?: Array<{ rating: Rating; ts: string }>;
}

const STORAGE_KEY = 'linguadev.question-ratings';

function readAll(): Record<string, RatingRecord> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, RatingRecord>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, RatingRecord>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // storage full o SecurityError — ignora silenciosamente, no bloquea la UX.
  }
}

export function getRating(questionId: string): RatingRecord | undefined {
  return readAll()[questionId];
}

export function setRating(questionId: string, rating: Rating): void {
  const all = readAll();
  const existing = all[questionId];
  const now = new Date().toISOString();
  const history = [...(existing?.history ?? []), { rating, ts: now }].slice(-10);
  all[questionId] = { rating, ts: now, history };
  writeAll(all);
}

// Devuelve todos los questionIds marcados como "again" o "hard" — candidatos a review.
export function getReviewCandidates(): string[] {
  const all = readAll();
  return Object.entries(all)
    .filter(([, r]) => r.rating === 'again' || r.rating === 'hard')
    .map(([id]) => id);
}

// Métricas simples para dashboards.
export function getRatingStats(): { total: number; again: number; hard: number; good: number; easy: number } {
  const all = readAll();
  const stats = { total: 0, again: 0, hard: 0, good: 0, easy: 0 };
  for (const r of Object.values(all)) {
    stats.total += 1;
    stats[r.rating] += 1;
  }
  return stats;
}
