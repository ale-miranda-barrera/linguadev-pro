import { create } from 'zustand';
import { db } from '../db/dexie.js';
import { emptyCard, pickDailyQueue, review, type SrsState, type ReviewRating } from '@linguadev/shared';

interface State {
  queue: SrsState[];
  loaded: boolean;
  dailyLimit: number;
  buildQueueFor: (cardIds: readonly string[]) => Promise<void>;
  rate: (cardId: string, rating: ReviewRating) => Promise<SrsState>;
}

export const useSrsStore = create<State>((set, get) => ({
  queue: [],
  loaded: false,
  dailyLimit: 20,
  buildQueueFor: async (cardIds) => {
    // Asegura una entrada en SRS por cada carta pedida y calcula la cola del día con límite.
    const now = new Date();
    const states: SrsState[] = [];
    for (const id of cardIds) {
      const existing = await db.srs.get(id);
      if (existing) states.push(existing);
      else {
        const fresh = emptyCard(id, now);
        await db.srs.put(fresh);
        states.push(fresh);
      }
    }
    set({ queue: pickDailyQueue(states, get().dailyLimit, now), loaded: true });
  },
  rate: async (cardId, rating) => {
    const cur = (await db.srs.get(cardId)) ?? emptyCard(cardId);
    const next = review(cur, rating);
    await db.srs.put(next);
    set({ queue: get().queue.filter((s) => s.cardId !== cardId) });
    return next;
  },
}));
