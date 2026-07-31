import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAwsStore } from '../../stores/aws.js';
import { EmptyState, LoadingState } from '../../components/UiStates.js';

export function AwsCert() {
  const { certId } = useParams<{ certId: 'clf-c02' | 'saa-c03' }>();
  const load = useAwsStore((s) => s.load);
  const loaded = useAwsStore((s) => s.loaded);
  const simsFor = useAwsStore((s) => s.simsFor);
  const certifications = useAwsStore((s) => s.certifications);
  const attempts = useAwsStore((s) => s.attempts);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const cert = certifications.find((c) => c.id === certId);
  const sims = useMemo(() => (certId ? simsFor(certId) : []), [certId, simsFor]);

  if (!loaded) return <LoadingState />;
  if (!cert)
    return (
      <EmptyState
        title="Certificación no encontrada"
        hint="Vuelve al índice de AWS"
        action={<Link to="/aws" className="rounded bg-brand-600 px-3 py-1.5 text-sm text-white">Ir a AWS</Link>}
      />
    );

  const passed = sims.filter((s) => attempts[s.id]?.passed).length;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link to="/aws" className="text-xs font-semibold text-slate-500 underline">← AWS</Link>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-black">{cert.name}</h1>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-mono font-bold dark:bg-white/5">
            {cert.code}
          </span>
        </div>
        <p className="text-sm text-slate-500 max-w-2xl">{cert.description}</p>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {cert.domains.map((d) => (
            <div key={d.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-white/5 dark:bg-white/5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{d.id}</div>
              <div className="mt-0.5 text-sm font-bold leading-tight">{d.name}</div>
              <div className="mt-1 text-lg font-black tabular-nums text-brand-600">{Math.round(d.weight * 100)}%</div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl bg-gradient-to-r from-brand-500 to-cyan-500 p-4 text-white">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider opacity-80">Progreso</div>
              <div className="text-2xl font-black">
                {passed} <span className="text-lg opacity-70">de {sims.length} simulacros</span>
              </div>
            </div>
            <div className="text-right text-xs opacity-90">
              <div>{cert.totalQuestionsInExam} preguntas · {cert.timeLimitMin}m</div>
              <div>Aprobar: {cert.passingScore}/1000</div>
            </div>
          </div>
        </div>
      </header>

      <section>
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">
          Simulacros ({sims.length}/20)
        </h2>
        {sims.length === 0 ? (
          <EmptyState
            title="Aún no hay simulacros cargados"
            hint="El contenido se está generando; recarga en unos minutos."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sims.map((sim, i) => {
              const att = attempts[sim.id];
              const passedThis = att?.passed;
              return (
                <motion.div
                  key={sim.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.02 }}
                >
                  <Link
                    to={`/aws/${cert.id}/sim/${sim.id}`}
                    className={`glass block rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:shadow-pop ${
                      passedThis ? 'border-success-500/40 shadow-glow' : 'border-white/60 dark:border-white/10'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono font-bold text-slate-500">
                        Sim {String(sim.order).padStart(2, '0')}
                      </span>
                      {passedThis ? <span className="text-sm">✅</span> : null}
                    </div>
                    <h3 className="mt-1 text-sm font-bold leading-tight">{sim.title}</h3>
                    <p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{sim.focus}</p>

                    <div className="mt-3 flex flex-wrap gap-1">
                      {sim.domainCoverage.map((d) => (
                        <span key={d} className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-brand-700 dark:text-brand-300">
                          {d}
                        </span>
                      ))}
                    </div>

                    <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400">
                      <span>{sim.questions.length} preguntas · {sim.timeLimitMin}m</span>
                      {att ? (
                        <span className="font-mono">
                          {Math.round(att.bestScore01 * 100)}% · {att.attempts}✕
                        </span>
                      ) : null}
                    </div>
                  </Link>
                </motion.div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
