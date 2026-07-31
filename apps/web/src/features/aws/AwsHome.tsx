import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAwsStore } from '../../stores/aws.js';

export function AwsHome() {
  const load = useAwsStore((s) => s.load);
  const loaded = useAwsStore((s) => s.loaded);
  const certifications = useAwsStore((s) => s.certifications);
  const simsFor = useAwsStore((s) => s.simsFor);
  const attempts = useAwsStore((s) => s.attempts);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-orange-500 to-yellow-500 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white shadow-glow">
          <span>☁️</span> AWS Certifications
        </div>
        <h1 className="text-3xl font-black">Certificaciones AWS</h1>
        <p className="text-sm text-slate-500 max-w-2xl">
          Prepárate con simulacros construidos desde tus guías locales, alineados a los dominios oficiales del examen. Cada simulación incluye escenarios reales, explicaciones detalladas y razonamiento por cada opción.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {certifications.map((cert, i) => {
          const sims = simsFor(cert.id);
          const passed = sims.filter((s) => attempts[s.id]?.passed).length;
          const total = sims.length;
          const isEntry = cert.id === 'clf-c02';
          return (
            <motion.div
              key={cert.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Link
                to={`/aws/${cert.id}`}
                className={`relative block overflow-hidden rounded-3xl bg-gradient-to-br ${
                  isEntry ? 'from-orange-500 via-orange-600 to-yellow-500' : 'from-blue-600 via-brand-600 to-brand-700'
                } p-6 text-white shadow-pop transition hover:-translate-y-0.5`}
              >
                <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-white/15 blur-3xl" />
                <div className="relative">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center rounded-full bg-white/20 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ring-1 ring-white/25 backdrop-blur">
                      {isEntry ? 'Foundational' : 'Associate'}
                    </span>
                    <span className="text-xs font-mono opacity-80">{cert.code}</span>
                  </div>
                  <h2 className="mt-3 text-xl font-black leading-tight">{cert.name}</h2>
                  <p className="mt-2 text-xs opacity-90 line-clamp-3">{cert.description}</p>

                  <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[11px]">
                    <div className="rounded-lg bg-white/15 p-2 backdrop-blur">
                      <div className="text-lg font-black">{cert.totalQuestionsInExam}</div>
                      <div className="opacity-70">preguntas</div>
                    </div>
                    <div className="rounded-lg bg-white/15 p-2 backdrop-blur">
                      <div className="text-lg font-black">{cert.timeLimitMin}m</div>
                      <div className="opacity-70">duración</div>
                    </div>
                    <div className="rounded-lg bg-white/15 p-2 backdrop-blur">
                      <div className="text-lg font-black">{cert.passingScore}</div>
                      <div className="opacity-70">para pasar</div>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between text-xs">
                    <span className="font-bold">Simulacros disponibles: {total}</span>
                    <span className="font-mono">
                      {passed}/{total} ✅
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/20">
                    <div
                      className="h-full rounded-full bg-white"
                      style={{ width: `${total > 0 ? Math.round((passed / total) * 100) : 0}%` }}
                    />
                  </div>
                </div>
              </Link>
            </motion.div>
          );
        })}
      </div>

      <section className="glass rounded-2xl border border-white/60 p-4 text-sm dark:border-white/10">
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Cómo usar esta sección</h3>
        <ul className="space-y-1.5 text-slate-600 dark:text-slate-300">
          <li>1. Empieza por <strong>CLF-C02</strong> si es tu primera certificación — cubre los fundamentos que el SAA-C03 asume.</li>
          <li>2. Cada simulación es <strong>temática</strong> (un dominio o un patrón de examen). Aprueba con ≥70% para desbloquear la siguiente en algunos casos.</li>
          <li>3. En cada pregunta verás <strong>por qué cada opción es correcta o incorrecta</strong>. Es lo que enseña de verdad.</li>
          <li>4. Cuando tengas ≥80% consistentes en TODAS las simulaciones, agenda tu examen real.</li>
        </ul>
      </section>
    </div>
  );
}
