import { create } from 'zustand';
import { db, type TechSimAttempt } from '../db/dexie.js';
import { loadTechSimulations, TECH_TRACKS } from '@linguadev/content';
import type { TechSimulation, TechTrack, TechTrackId } from '@linguadev/shared';

interface State {
  simulations: TechSimulation[];
  attempts: Record<string, TechSimAttempt>;
  loaded: boolean;
  tracks: TechTrack[];
  load: () => Promise<void>;
  simsFor: (trackId: TechTrackId) => TechSimulation[];
  bestFor: (simId: string) => TechSimAttempt | undefined;
  recordAttempt: (
    sim: TechSimulation,
    score01: number,
    perAreaStats: Record<string, { correct: number; total: number }>,
  ) => Promise<{ passed: boolean; firstTime: boolean }>;
}

export const useTechStore = create<State>((set, get) => ({
  simulations: [],
  attempts: {},
  loaded: false,
  tracks: TECH_TRACKS,
  load: async () => {
    const sims = loadTechSimulations();
    const rows = await db.techAttempts.toArray();
    const map: Record<string, TechSimAttempt> = {};
    for (const r of rows) map[r.simId] = r;
    set({ simulations: sims, attempts: map, loaded: true });
  },
  simsFor: (trackId) =>
    get()
      .simulations.filter((s) => s.trackId === trackId)
      .sort((a, b) => a.order - b.order),
  bestFor: (simId) => get().attempts[simId],
  recordAttempt: async (sim, score01, perAreaStats) => {
    const now = new Date().toISOString();
    const existing = get().attempts[sim.id];
    const bestScore01 = Math.max(existing?.bestScore01 ?? 0, score01);
    const passed = bestScore01 >= sim.passThreshold;
    const firstTime = passed && !existing?.passed;
    const next: TechSimAttempt = {
      simId: sim.id,
      trackId: sim.trackId,
      order: sim.order,
      bestScore01,
      attempts: (existing?.attempts ?? 0) + 1,
      passed,
      firstPassedAt: existing?.firstPassedAt ?? (passed ? now : undefined),
      lastAttemptAt: now,
      perAreaStats: mergePerArea(existing?.perAreaStats, perAreaStats),
    };
    await db.techAttempts.put(next);
    set((s) => ({ attempts: { ...s.attempts, [sim.id]: next } }));
    return { passed, firstTime };
  },
}));

function mergePerArea(
  a?: Record<string, { correct: number; total: number }>,
  b?: Record<string, { correct: number; total: number }>,
): Record<string, { correct: number; total: number }> {
  const out: Record<string, { correct: number; total: number }> = { ...(a ?? {}) };
  if (b) {
    for (const [k, v] of Object.entries(b)) {
      out[k] = {
        correct: (out[k]?.correct ?? 0) + v.correct,
        total: (out[k]?.total ?? 0) + v.total,
      };
    }
  }
  return out;
}
