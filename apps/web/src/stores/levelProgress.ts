import { create } from 'zustand';
import { db, type LevelProgress } from '../db/dexie.js';

type Band = LevelProgress['band'];

interface State {
  progress: Record<string, LevelProgress>;
  loaded: boolean;
  load: () => Promise<void>;
  recordAttempt: (
    packId: string,
    band: Band,
    levelOrder: number,
    score01: number,
    passThreshold: number,
  ) => Promise<{ passed: boolean; firstTime: boolean }>;
  isUnlocked: (band: Band, levelOrder: number) => boolean;
  bandProgress: (band: Band) => { passed: number; total: number };
}

const BAND_ORDER: Band[] = ['A2', 'A2+', 'B1', 'B1+', 'B2', 'B2+', 'C1'];

export const useLevelProgressStore = create<State>((set, get) => ({
  progress: {},
  loaded: false,
  load: async () => {
    const rows = await db.levelProgress.toArray();
    const map: Record<string, LevelProgress> = {};
    for (const r of rows) map[r.packId] = r;
    set({ progress: map, loaded: true });
  },
  recordAttempt: async (packId, band, levelOrder, score01, passThreshold) => {
    const now = new Date().toISOString();
    const existing = get().progress[packId];
    const bestScore01 = Math.max(existing?.bestScore01 ?? 0, score01);
    const passed = bestScore01 >= passThreshold;
    const firstTime = passed && !existing?.passed;
    const next: LevelProgress = {
      packId,
      band,
      levelOrder,
      bestScore01,
      attempts: (existing?.attempts ?? 0) + 1,
      passed,
      firstPassedAt: existing?.firstPassedAt ?? (passed ? now : undefined),
      lastAttemptAt: now,
    };
    await db.levelProgress.put(next);
    set((s) => ({ progress: { ...s.progress, [packId]: next } }));
    return { passed, firstTime };
  },
  isUnlocked: (band, levelOrder) => {
    // Nivel 1 de cualquier banda siempre desbloqueado.
    // Los siguientes: desbloquea si el anterior fue superado.
    // Cambio de banda: se desbloquea si TODOS los niveles de la banda previa están pasados.
    if (levelOrder === 1) {
      const bandIdx = BAND_ORDER.indexOf(band);
      if (bandIdx <= 0) return true; // A2 nivel 1: siempre.
      // Chequea que la banda anterior esté 100% completada.
      const prevBand = BAND_ORDER[bandIdx - 1];
      const prev = get().bandProgress(prevBand!);
      return prev.total > 0 && prev.passed === prev.total;
    }
    // Nivel N: requiere nivel N-1 de la misma banda pasado.
    const prevKey = Object.values(get().progress).find(
      (p) => p.band === band && p.levelOrder === levelOrder - 1,
    );
    return !!prevKey?.passed;
  },
  bandProgress: (band) => {
    const rows = Object.values(get().progress).filter((p) => p.band === band);
    return {
      passed: rows.filter((r) => r.passed).length,
      total: rows.length, // Nota: total real depende del catálogo cargado; caller lo puede ajustar.
    };
  },
}));
