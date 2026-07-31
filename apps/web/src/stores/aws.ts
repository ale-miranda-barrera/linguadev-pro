import { create } from 'zustand';
import { db, type AwsSimAttempt } from '../db/dexie.js';
import { loadAwsSimulations, AWS_CERTIFICATIONS } from '@linguadev/content';
import type { AwsSimulation, AwsCertification } from '@linguadev/shared';

interface State {
  simulations: AwsSimulation[];
  attempts: Record<string, AwsSimAttempt>;
  loaded: boolean;
  load: () => Promise<void>;
  simsFor: (certId: 'clf-c02' | 'saa-c03') => AwsSimulation[];
  certifications: AwsCertification[];
  recordAttempt: (
    sim: AwsSimulation,
    score01: number,
    perDomainStats: Record<string, { correct: number; total: number }>,
  ) => Promise<{ passed: boolean; firstTime: boolean }>;
  bestFor: (simId: string) => AwsSimAttempt | undefined;
}

export const useAwsStore = create<State>((set, get) => ({
  simulations: [],
  attempts: {},
  loaded: false,
  certifications: AWS_CERTIFICATIONS,
  load: async () => {
    const sims = loadAwsSimulations();
    const rows = await db.awsAttempts.toArray();
    const map: Record<string, AwsSimAttempt> = {};
    for (const r of rows) map[r.simId] = r;
    set({ simulations: sims, attempts: map, loaded: true });
  },
  simsFor: (certId) => get().simulations.filter((s) => s.certId === certId).sort((a, b) => a.order - b.order),
  bestFor: (simId) => get().attempts[simId],
  recordAttempt: async (sim, score01, perDomainStats) => {
    const now = new Date().toISOString();
    const existing = get().attempts[sim.id];
    const bestScore01 = Math.max(existing?.bestScore01 ?? 0, score01);
    const passed = bestScore01 >= sim.passThreshold;
    const firstTime = passed && !existing?.passed;
    const next: AwsSimAttempt = {
      simId: sim.id,
      certId: sim.certId,
      order: sim.order,
      bestScore01,
      attempts: (existing?.attempts ?? 0) + 1,
      passed,
      firstPassedAt: existing?.firstPassedAt ?? (passed ? now : undefined),
      lastAttemptAt: now,
      // Suma acumulada de stats por dominio (opcional)
      perDomainStats: mergePerDomain(existing?.perDomainStats, perDomainStats),
    };
    await db.awsAttempts.put(next);
    set((s) => ({ attempts: { ...s.attempts, [sim.id]: next } }));
    return { passed, firstTime };
  },
}));

function mergePerDomain(
  a?: Record<string, { correct: number; total: number }>,
  b?: Record<string, { correct: number; total: number }>,
): Record<string, { correct: number; total: number }> {
  const out: Record<string, { correct: number; total: number }> = { ...(a ?? {}) };
  if (b) {
    for (const [k, v] of Object.entries(b)) {
      out[k] = { correct: (out[k]?.correct ?? 0) + v.correct, total: (out[k]?.total ?? 0) + v.total };
    }
  }
  return out;
}
