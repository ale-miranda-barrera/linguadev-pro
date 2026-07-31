import { describe, it, expect } from 'vitest';
import { emptyCard, review, pickDailyQueue, isDue } from './index.js';

describe('srs', () => {
  it('crea carta nueva con due = ahora', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const c = emptyCard('card-1', now);
    expect(c.cardId).toBe('card-1');
    expect(c.reps).toBe(0);
    expect(isDue(c, now)).toBe(true);
  });

  it('review con "good" mueve la due al futuro', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const c = emptyCard('card-2', now);
    const next = review(c, 'good', now);
    expect(new Date(next.due).getTime()).toBeGreaterThan(now.getTime());
    expect(next.reps).toBeGreaterThan(0);
  });

  it('review con "again" no adelanta muchos días', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const c = review(emptyCard('card-3', now), 'good', now);
    const again = review(c, 'again', new Date('2026-01-02T00:00:00Z'));
    const diffMs = new Date(again.due).getTime() - new Date('2026-01-02T00:00:00Z').getTime();
    expect(diffMs).toBeLessThan(1000 * 60 * 60 * 24 * 2);
  });

  it('pickDailyQueue respeta el límite diario', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    const many = Array.from({ length: 100 }, (_, i) => emptyCard(`c-${i}`, now));
    const queue = pickDailyQueue(many, 20, now);
    expect(queue.length).toBe(20);
  });

  it('pickDailyQueue no incluye cartas no vencidas', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    const future = { ...emptyCard('c-f', now), due: new Date('2027-01-01T00:00:00Z').toISOString() };
    const queue = pickDailyQueue([future], 10, now);
    expect(queue).toHaveLength(0);
  });
});
