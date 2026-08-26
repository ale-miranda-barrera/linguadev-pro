import { describe, it, expect, beforeEach } from 'vitest';
import { getRating, setRating, getReviewCandidates, getRatingStats } from './questionRating.js';

describe('questionRating', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getRating', () => {
    it('devuelve undefined si no hay rating', () => {
      expect(getRating('q1')).toBeUndefined();
    });

    it('devuelve el rating guardado', () => {
      setRating('q1', 'good');
      expect(getRating('q1')?.rating).toBe('good');
    });
  });

  describe('setRating', () => {
    it('guarda un nuevo rating con timestamp', () => {
      setRating('q1', 'hard');
      const r = getRating('q1');
      expect(r?.rating).toBe('hard');
      expect(r?.ts).toBeTruthy();
      expect(new Date(r!.ts).getTime()).toBeGreaterThan(0);
    });

    it('actualiza rating existente y añade a history', () => {
      setRating('q1', 'again');
      setRating('q1', 'hard');
      setRating('q1', 'good');
      const r = getRating('q1');
      expect(r?.rating).toBe('good');
      expect(r?.history?.length).toBe(3);
      expect(r?.history?.map((h) => h.rating)).toEqual(['again', 'hard', 'good']);
    });

    it('history se limita a 10 entries (ring buffer)', () => {
      for (let i = 0; i < 15; i++) {
        setRating('q1', i % 2 === 0 ? 'good' : 'hard');
      }
      const r = getRating('q1');
      expect(r?.history?.length).toBe(10);
    });
  });

  describe('getReviewCandidates', () => {
    it('devuelve solo preguntas con rating again/hard', () => {
      setRating('q1', 'again');
      setRating('q2', 'good');
      setRating('q3', 'hard');
      setRating('q4', 'easy');

      const candidates = getReviewCandidates();
      expect(candidates.sort()).toEqual(['q1', 'q3']);
    });

    it('devuelve array vacío si no hay ratings', () => {
      expect(getReviewCandidates()).toEqual([]);
    });
  });

  describe('getRatingStats', () => {
    it('cuenta correctamente ratings por categoría', () => {
      setRating('q1', 'again');
      setRating('q2', 'good');
      setRating('q3', 'good');
      setRating('q4', 'easy');
      setRating('q5', 'hard');

      const stats = getRatingStats();
      expect(stats.total).toBe(5);
      expect(stats.again).toBe(1);
      expect(stats.hard).toBe(1);
      expect(stats.good).toBe(2);
      expect(stats.easy).toBe(1);
    });

    it('devuelve ceros si no hay ratings', () => {
      const stats = getRatingStats();
      expect(stats.total).toBe(0);
    });
  });

  describe('resiliency', () => {
    it('sobrevive JSON corrupto en localStorage', () => {
      localStorage.setItem('linguadev.question-ratings', '{ not json');
      expect(() => getRating('q1')).not.toThrow();
      expect(getRating('q1')).toBeUndefined();
    });
  });
});
