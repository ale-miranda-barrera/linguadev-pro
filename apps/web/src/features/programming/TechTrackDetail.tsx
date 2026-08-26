import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTechStore } from '../../stores/tech.js';
import { EmptyState, LoadingState } from '../../components/UiStates.js';
import { IconChevronRight, IconTrophy } from '../../components/Icons.js';
import type { TechTrackId } from '@linguadev/shared';

const GRADIENT_BY_TRACK: Record<string, string> = {
  programmer: 'from-brand-600 via-brand-700 to-pink-600',
  architecture: 'from-cyan-500 via-brand-600 to-indigo-600',
  devops: 'from-emerald-500 via-teal-600 to-cyan-600',
  databases: 'from-orange-500 via-flame-500 to-red-500',
  systemdesign: 'from-purple-500 via-indigo-500 to-brand-600',
};

export function TechTrackDetail() {
  const { trackId } = useParams<{ trackId: TechTrackId }>();
  const load = useTechStore((s) => s.load);
  const loaded = useTechStore((s) => s.loaded);
  const simsFor = useTechStore((s) => s.simsFor);
  const attempts = useTechStore((s) => s.attempts);
  const tracks = useTechStore((s) => s.tracks);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const track = tracks.find((t) => t.id === trackId);
  const sims = useMemo(() => (trackId ? simsFor(trackId) : []), [simsFor, trackId]);

  if (!loaded) return <LoadingState />;
  if (!track)
    return (
      <EmptyState
        title="Track no encontrado"
        hint="Vuelve al índice de programación"
        action={
          <Link to="/programming" className="rounded bg-brand-600 px-3 py-1.5 text-sm text-white">
            Volver
          </Link>
        }
      />
    );

  const gradient = GRADIENT_BY_TRACK[track.id] ?? 'from-brand-500 to-cyan-500';
  const passed = sims.filter((s) => attempts[s.id]?.passed).length;
  const pct = sims.length > 0 ? Math.round((passed / sims.length) * 100) : 0;

  return (
    <div className="space-y-6">
      <Link to="/programming" className="text-xs font-semibold text-slate-500 underline">
        ← Programación
      </Link>

      <motion.header
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${gradient} p-6 text-white shadow-pop`}
      >
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-white/15 blur-3xl" />
        <div className="relative">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{track.icon}</span>
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest opacity-80">{track.tagline}</div>
              <h1 className="text-2xl font-black">{track.name}</h1>
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-sm opacity-90">{track.description}</p>

          <div className="mt-4 flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1 font-bold">
              <IconTrophy size={14} /> {passed}/{sims.length} superadas · {pct}%
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/20">
            <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </motion.header>

      <section>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Áreas cubiertas</h3>
        <div className="flex flex-wrap gap-1.5">
          {track.areas.map((a) => (
            <span
              key={a.id}
              title={a.description}
              className="rounded-full bg-brand-500/10 px-2.5 py-1 text-[11px] font-bold text-brand-700 dark:text-brand-300"
            >
              {a.name}
            </span>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Simulacros</h3>
        {sims.length === 0 ? (
          <EmptyState
            title="Aún no hay simulacros"
            hint="Estamos añadiendo contenido a este track. Vuelve pronto."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {sims.map((sim, i) => {
              const best = attempts[sim.id];
              const bestPct = best ? Math.round(best.bestScore01 * 100) : null;
              const pass = best?.passed;
              return (
                <li key={sim.id}>
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                  >
                    <Link
                      to={`/programming/${track.id}/sim/${sim.id}`}
                      className="glass block rounded-2xl border border-white/60 p-4 transition hover:-translate-y-0.5 hover:shadow-pop dark:border-white/10"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1">
                          <div className="text-[10px] font-mono font-bold text-slate-500">
                            Simulacro {String(sim.order).padStart(2, '0')}
                          </div>
                          <div className="mt-1 text-sm font-black leading-tight">{sim.title}</div>
                          <p className="mt-1 text-xs text-slate-500 line-clamp-2">{sim.focus}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                            <span className="rounded bg-brand-500/10 px-1.5 py-0.5 font-bold text-brand-700 dark:text-brand-300">
                              {sim.questions.length} preguntas
                            </span>
                            <span className="rounded bg-slate-200 px-1.5 py-0.5 font-bold text-slate-600 dark:bg-white/10 dark:text-slate-300">
                              {sim.timeLimitMin}m
                            </span>
                            <span className="text-slate-400">
                              umbral {Math.round(sim.passThreshold * 100)}%
                            </span>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          {bestPct !== null ? (
                            <>
                              <div className={`text-lg font-black tabular-nums ${pass ? 'text-success-600' : 'text-flame-600'}`}>
                                {bestPct}%
                              </div>
                              <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                                {pass ? 'aprobado' : 'reintentar'}
                              </div>
                            </>
                          ) : (
                            <IconChevronRight size={20} className="text-slate-400" />
                          )}
                        </div>
                      </div>
                    </Link>
                  </motion.div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
