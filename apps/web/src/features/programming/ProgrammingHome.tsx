import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAwsStore } from '../../stores/aws.js';
import { useTechStore } from '../../stores/tech.js';
import { IconChevronRight, IconTrophy } from '../../components/Icons.js';

// Hub de Programación: expone Certificados (AWS), Programador, Arquitectura y placeholders
// para futuros tracks (DevOps, DBs, System Design). Cada card muestra progreso agregado local.

export function ProgrammingHome() {
  const awsLoad = useAwsStore((s) => s.load);
  const awsLoaded = useAwsStore((s) => s.loaded);
  const awsSims = useAwsStore((s) => s.simulations);
  const awsAttempts = useAwsStore((s) => s.attempts);

  const techLoad = useTechStore((s) => s.load);
  const techLoaded = useTechStore((s) => s.loaded);
  const techSims = useTechStore((s) => s.simulations);
  const techAttempts = useTechStore((s) => s.attempts);
  const techTracks = useTechStore((s) => s.tracks);

  useEffect(() => {
    if (!awsLoaded) void awsLoad();
    if (!techLoaded) void techLoad();
  }, [awsLoaded, awsLoad, techLoaded, techLoad]);

  const awsTotal = awsSims.length;
  const awsPassed = Object.values(awsAttempts).filter((a) => a.passed).length;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-brand-500 to-cyan-500 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white shadow-glow">
          <span>{'💻'}</span> Programación
        </div>
        <h1 className="text-3xl font-black">Camino técnico</h1>
        <p className="max-w-2xl text-sm text-slate-500">
          Aprende con casos reales del día a día: bugs de producción, decisiones de diseño, entrevistas técnicas. Cada respuesta te explica el <strong>por qué</strong> — no sólo qué es correcto sino qué principio general aplica y qué anti-patrones típicos evitas.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* AWS Certificaciones — hero */}
        <TrackCard
          to="/aws"
          icon="☁️"
          title="Certificaciones AWS"
          tagline="CLF-C02 · SAA-C03"
          description="40 simulacros temáticos alineados a los dominios oficiales del examen. Escenarios reales con explicación pregunta por pregunta y por qué cada distractor es un error típico."
          gradient="from-orange-500 via-orange-600 to-yellow-500"
          progressPassed={awsPassed}
          progressTotal={awsTotal}
        />

        {/* Programador */}
        {techTracks
          .filter((t) => t.id === 'programmer')
          .map((t) => {
            const sims = techSims.filter((s) => s.trackId === t.id);
            const passed = sims.filter((s) => techAttempts[s.id]?.passed).length;
            return (
              <TrackCard
                key={t.id}
                to={`/programming/${t.id}`}
                icon={t.icon}
                title={t.name}
                tagline={t.tagline}
                description={t.description}
                gradient="from-brand-600 via-brand-700 to-pink-600"
                progressPassed={passed}
                progressTotal={sims.length}
              />
            );
          })}

        {/* Arquitectura */}
        {techTracks
          .filter((t) => t.id === 'architecture')
          .map((t) => {
            const sims = techSims.filter((s) => s.trackId === t.id);
            const passed = sims.filter((s) => techAttempts[s.id]?.passed).length;
            return (
              <TrackCard
                key={t.id}
                to={`/programming/${t.id}`}
                icon={t.icon}
                title={t.name}
                tagline={t.tagline}
                description={t.description}
                gradient="from-cyan-500 via-brand-600 to-indigo-600"
                progressPassed={passed}
                progressTotal={sims.length}
              />
            );
          })}

        {/* DevOps */}
        {techTracks
          .filter((t) => t.id === 'devops')
          .map((t) => {
            const sims = techSims.filter((s) => s.trackId === t.id);
            const passed = sims.filter((s) => techAttempts[s.id]?.passed).length;
            return (
              <TrackCard
                key={t.id}
                to={`/programming/${t.id}`}
                icon={t.icon}
                title={t.name}
                tagline={t.tagline}
                description={t.description}
                gradient="from-emerald-500 via-teal-600 to-cyan-600"
                progressPassed={passed}
                progressTotal={sims.length}
              />
            );
          })}

        {/* Programando con IA */}
        {techTracks
          .filter((t) => t.id === 'ai-programming')
          .map((t) => {
            const sims = techSims.filter((s) => s.trackId === t.id);
            const passed = sims.filter((s) => techAttempts[s.id]?.passed).length;
            return (
              <TrackCard
                key={t.id}
                to={`/programming/${t.id}`}
                icon={t.icon}
                title={t.name}
                tagline={t.tagline}
                description={t.description}
                gradient="from-violet-600 via-fuchsia-600 to-pink-500"
                progressPassed={passed}
                progressTotal={sims.length}
              />
            );
          })}
      </div>

      {/* Modo Mix - interleaving */}
      <Link
        to="/programming/mix"
        className="relative block overflow-hidden rounded-2xl border-2 border-dashed border-purple-500/40 bg-gradient-to-r from-purple-500/10 via-brand-500/10 to-cyan-500/10 p-4 transition hover:-translate-y-0.5 hover:shadow-glow"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-purple-700 dark:text-purple-300">
              🧠 Modo Mix · Interleaving
            </div>
            <div className="mt-1 text-base font-black">Práctica mezclada — mejora retención</div>
            <div className="mt-0.5 text-xs text-slate-500">
              Preguntas aleatorias de todos los tracks · basado en evidencia (Bjork Learning Lab)
            </div>
          </div>
          <IconChevronRight size={20} className="text-slate-400" />
        </div>
      </Link>

      <section className="glass rounded-2xl border border-white/60 p-4 text-sm dark:border-white/10">
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Filosofía del contenido</h3>
        <ul className="space-y-1.5 text-slate-600 dark:text-slate-300">
          <li>1. Cada pregunta parte de un <strong>escenario real</strong> — bug, decisión, code review, entrevista.</li>
          <li>2. Todas las opciones (incluidas las incorrectas) tienen explicación: por qué la elección o el anti-patrón.</li>
          <li>3. Sección <strong>Real World</strong> conecta el concepto con un caso conocido (Facebook outage, Airbnb, Discord, etc.).</li>
          <li>4. Ordenado por dificultad: <span className="rounded bg-success-500 px-1 text-white">junior</span> → <span className="rounded bg-flame-500 px-1 text-white">mid</span> → <span className="rounded bg-danger-500 px-1 text-white">senior</span>.</li>
          <li>5. Tu progreso queda guardado <strong>localmente</strong> en IndexedDB (Dexie) — no depende del backend.</li>
        </ul>
      </section>
    </div>
  );
}

function TrackCard({
  to,
  icon,
  title,
  tagline,
  description,
  gradient,
  progressPassed,
  progressTotal,
}: {
  to: string;
  icon: string;
  title: string;
  tagline: string;
  description: string;
  gradient: string;
  progressPassed: number;
  progressTotal: number;
}) {
  const pct = progressTotal > 0 ? Math.round((progressPassed / progressTotal) * 100) : 0;
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <Link
        to={to}
        className={`relative block overflow-hidden rounded-3xl bg-gradient-to-br ${gradient} p-6 text-white shadow-pop transition hover:-translate-y-0.5`}
      >
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-white/15 blur-3xl" />
        <div className="relative">
          <div className="flex items-center justify-between">
            <span className="text-2xl">{icon}</span>
            <span className="rounded-full bg-white/20 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ring-1 ring-white/25 backdrop-blur">
              {tagline}
            </span>
          </div>
          <h2 className="mt-3 text-2xl font-black leading-tight">{title}</h2>
          <p className="mt-2 text-xs opacity-90 line-clamp-4">{description}</p>

          <div className="mt-4 flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1 font-bold">
              <IconTrophy size={14} /> {progressPassed}/{progressTotal} superadas
            </span>
            <span className="font-mono opacity-80">{pct}%</span>
            <IconChevronRight size={16} />
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/20">
            <div className="h-full rounded-full bg-white transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
