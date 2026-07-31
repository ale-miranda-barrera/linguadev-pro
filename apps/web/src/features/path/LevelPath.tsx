import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { usePacksStore } from '../../stores/packs.js';
import { useLevelProgressStore } from '../../stores/levelProgress.js';
import type { Pack } from '@linguadev/shared';

type Band = 'A2' | 'A2+' | 'B1' | 'B1+' | 'B2' | 'B2+' | 'C1';

const BANDS: { key: Band; label: string; gradient: string }[] = [
  { key: 'A2', label: 'A2 · Elementary', gradient: 'from-cyan-500 to-brand-500' },
  { key: 'A2+', label: 'A2+ · Elementary Plus', gradient: 'from-brand-500 to-pink-500' },
  { key: 'B1', label: 'B1 · Intermediate', gradient: 'from-pink-500 to-flame-500' },
  { key: 'B2', label: 'B2 · Upper Intermediate', gradient: 'from-flame-500 to-danger-500' },
  { key: 'B2+', label: 'B2+ · Advanced Bridge', gradient: 'from-danger-500 to-success-500' },
];

export function LevelPath() {
  const navigate = useNavigate();
  const packs = usePacksStore((s) => s.packs);
  const packsLoaded = usePacksStore((s) => s.loaded);
  const installBundled = usePacksStore((s) => s.installBundled);
  const progressLoaded = useLevelProgressStore((s) => s.loaded);
  const loadProgress = useLevelProgressStore((s) => s.load);
  const progress = useLevelProgressStore((s) => s.progress);

  const [activeBand, setActiveBand] = useState<Band>('A2');

  useEffect(() => {
    if (!progressLoaded) void loadProgress();
  }, [progressLoaded, loadProgress]);

  useEffect(() => {
    if (packsLoaded && packs.filter((p) => p.band).length === 0) {
      // Nunca se cargaron los level packs → intenta instalarlos.
      void installBundled();
    }
  }, [packsLoaded, packs, installBundled]);

  const byBand = useMemo(() => {
    const map = new Map<Band, Pack[]>();
    for (const p of packs) {
      if (!p.band || !p.levelOrder) continue;
      const band = p.band as Band;
      const list = map.get(band) ?? [];
      list.push(p);
      map.set(band, list);
    }
    for (const [, list] of map) list.sort((a, b) => (a.levelOrder ?? 0) - (b.levelOrder ?? 0));
    return map;
  }, [packs]);

  const active = byBand.get(activeBand) ?? [];

  function isUnlocked(band: Band, order: number): boolean {
    if (order === 1) {
      const idx = BANDS.findIndex((b) => b.key === band);
      if (idx <= 0) return true;
      const prevBand = BANDS[idx - 1]!.key;
      const prevList = byBand.get(prevBand) ?? [];
      if (prevList.length === 0) return true; // sin banda previa cargada, permite
      return prevList.every((p) => progress[p.id]?.passed);
    }
    const prev = active.find((p) => p.levelOrder === order - 1);
    if (!prev) return false;
    return !!progress[prev.id]?.passed;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-black">Ruta CEFR</h1>
        <p className="text-sm text-slate-500">
          250 niveles de A2 a B2+ con preguntas mixtas. Debes aprobar cada nivel para desbloquear el siguiente.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {BANDS.map((b) => {
          const list = byBand.get(b.key) ?? [];
          const passed = list.filter((p) => progress[p.id]?.passed).length;
          const total = list.length;
          const isActive = activeBand === b.key;
          return (
            <button
              key={b.key}
              onClick={() => setActiveBand(b.key)}
              className={`rounded-2xl px-4 py-2 text-sm font-bold transition ${
                isActive
                  ? `bg-gradient-to-r ${b.gradient} text-white shadow-pop`
                  : 'bg-slate-100 text-slate-700 dark:bg-white/5 dark:text-slate-300'
              }`}
            >
              {b.label}
              <span className="ml-2 text-[10px] font-mono opacity-80">
                {passed}/{total}
              </span>
            </button>
          );
        })}
      </div>

      {active.length === 0 ? (
        <p className="rounded-2xl bg-slate-100 p-4 text-sm text-slate-500 dark:bg-white/5">
          Aún no hay niveles cargados para esta banda. Reinicia la app o ejecuta la migración de packs.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {active.map((p, i) => {
            const prog = progress[p.id];
            const unlocked = isUnlocked(activeBand, p.levelOrder ?? 1);
            const score = prog?.bestScore01 ?? 0;
            const passed = prog?.passed ?? false;
            return (
              <motion.button
                key={p.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.008 }}
                disabled={!unlocked}
                onClick={() => navigate(`/lesson/${p.id}`)}
                className={`glass relative flex min-h-[110px] flex-col items-start rounded-2xl border p-3 text-left transition ${
                  !unlocked
                    ? 'cursor-not-allowed border-white/40 opacity-50'
                    : passed
                    ? 'border-success-500/40 shadow-glow hover:-translate-y-0.5'
                    : 'border-white/60 hover:-translate-y-0.5 hover:shadow-pop dark:border-white/10'
                }`}
              >
                <div className="mb-1 flex w-full items-center justify-between">
                  <span className="text-[10px] font-mono font-bold text-slate-500">
                    L{p.levelOrder}
                  </span>
                  {passed ? <span className="text-sm">✅</span> : !unlocked ? <span className="text-sm">🔒</span> : null}
                </div>
                <p className="text-xs font-bold leading-tight text-slate-800 dark:text-slate-100">
                  {p.title.replace(/^A2\+? · L\d+ — |^B1 · L\d+ — |^B2\+? · L\d+ — /, '')}
                </p>
                {p.topic ? (
                  <p className="mt-1 line-clamp-2 text-[10px] text-slate-500">{p.topic}</p>
                ) : null}
                {prog ? (
                  <div className="mt-auto w-full pt-2">
                    <div className="h-1 overflow-hidden rounded-full bg-slate-200/60 dark:bg-white/5">
                      <div
                        className={`h-full ${passed ? 'bg-success-500' : 'bg-brand-500'}`}
                        style={{ width: `${Math.round(score * 100)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[10px] font-mono text-slate-400">
                      {Math.round(score * 100)}% · {prog.attempts}✕
                    </p>
                  </div>
                ) : null}
              </motion.button>
            );
          })}
        </div>
      )}
    </div>
  );
}
