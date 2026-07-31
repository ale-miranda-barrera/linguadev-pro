import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useProfileStore } from '../../stores/profile.js';
import { usePacksStore } from '../../stores/packs.js';
import { LoadingState, EmptyState, ErrorState } from '../../components/UiStates.js';
import { StreakBadge } from '../../components/StreakBadge.js';
import {
  IconCards,
  IconChevronRight,
  IconHeadphones,
  IconMic,
  IconPencil,
  IconPhone,
  IconSparkle,
  IconTarget,
  IconTrophy,
} from '../../components/Icons.js';

const SKILLS = [
  {
    to: '/vocab',
    label: 'Vocab',
    hint: 'SRS + Quiz + Mix',
    Icon: IconCards,
    gradient: 'from-brand-500 to-pink-500',
    bg: 'from-brand-50 to-pink-50',
    darkBg: 'from-brand-500/10 to-pink-500/10',
  },
  {
    to: '/listening',
    label: 'Escucha',
    hint: 'Dictados con audio',
    Icon: IconHeadphones,
    gradient: 'from-cyan-500 to-brand-500',
    bg: 'from-cyan-50 to-brand-50',
    darkBg: 'from-cyan-500/10 to-brand-500/10',
  },
  {
    to: '/speaking',
    label: 'Habla',
    hint: 'Grabación + score',
    Icon: IconMic,
    gradient: 'from-pink-500 to-flame-500',
    bg: 'from-pink-50 to-flame-50',
    darkBg: 'from-pink-500/10 to-flame-500/10',
  },
  {
    to: '/writing',
    label: 'Escribir',
    hint: 'Prompts + feedback',
    Icon: IconPencil,
    gradient: 'from-flame-500 to-brand-500',
    bg: 'from-flame-50 to-brand-50',
    darkBg: 'from-flame-500/10 to-brand-500/10',
  },
];

const AI_TOOLS = [
  {
    to: '/voice-call',
    label: 'Voice Call',
    hint: 'Conversa con IA por voz',
    Icon: IconPhone,
    gradient: 'from-brand-500 to-pink-500',
  },
  {
    to: '/tutor',
    label: 'Tutor',
    hint: 'Pega un MD, aprende + quiz',
    Icon: IconSparkle,
    gradient: 'from-cyan-500 to-brand-500',
  },
  {
    to: '/create',
    label: 'Crear',
    hint: 'Arma tus propios ejercicios',
    Icon: IconPencil,
    gradient: 'from-flame-500 to-pink-500',
  },
];

export function Dashboard() {
  const profile = useProfileStore((s) => s.profile);
  const loadedProfile = useProfileStore((s) => s.loaded);
  const installBundled = usePacksStore((s) => s.installBundled);
  const packs = usePacksStore((s) => s.packs);
  const loadedPacks = usePacksStore((s) => s.loaded);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {}, []);

  const totalCards = useMemo(
    () => packs.filter((p) => p.enabled).reduce((n, p) => n + p.vocab.length, 0),
    [packs],
  );

  async function install() {
    setInstalling(true);
    setInstallError(null);
    try {
      await installBundled();
    } catch (err) {
      setInstallError((err as Error).message);
    } finally {
      setInstalling(false);
    }
  }

  if (!loadedProfile || !loadedPacks) return <LoadingState label="Preparando tu plan…" />;

  const enabled = packs.filter((p) => p.enabled);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';

  return (
    <div className="space-y-8">
      {/* Saludo */}
      <section className="animate-fade-in-up">
        <p className="text-sm font-medium text-slate-500">{greeting} 👋</p>
        <h1 className="mt-1 text-3xl font-black tracking-tight">Listo para practicar</h1>
      </section>

      {/* Hero: plan de hoy */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 120, damping: 18 }}
        className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 via-brand-700 to-pink-600 p-6 text-white shadow-pop sm:p-8"
      >
        {/* blobs decorativos */}
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-cyan-400/30 blur-3xl animate-blob" />
        <div className="pointer-events-none absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-pink-400/30 blur-3xl animate-blob" />

        <div className="relative flex items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ring-1 ring-white/20 backdrop-blur">
              <IconSparkle size={12} />
              Plan de hoy
            </div>
            <h2 className="mt-3 max-w-md text-2xl font-black leading-tight sm:text-3xl">
              {profile.dailyGoalMinutes} min · vocab, escucha y escritura corta
            </h2>
            <p className="mt-1 text-sm text-white/70">
              {totalCards} tarjetas disponibles en tus packs
            </p>
          </div>
          <StreakBadge streak={profile.streak} />
        </div>

        <div className="relative mt-6 flex flex-wrap gap-2">
          <Link
            to="/path"
            className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-brand-700 transition hover:scale-[1.02] active:scale-95"
          >
            <IconTarget size={16} />
            Ruta CEFR · 250 niveles
          </Link>
          <Link
            to="/vocab"
            className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-4 py-2.5 text-sm font-semibold ring-1 ring-white/25 backdrop-blur transition hover:bg-white/25"
          >
            <IconCards size={16} />
            Vocab
          </Link>
          <Link
            to="/voice-call"
            className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-4 py-2.5 text-sm font-semibold ring-1 ring-white/25 backdrop-blur transition hover:bg-white/25"
          >
            <IconPhone size={16} />
            Llamar
          </Link>
        </div>
      </motion.section>

      {/* Stats row */}
      <section className="grid grid-cols-3 gap-3">
        <StatTile
          Icon={IconTrophy}
          label="Nivel"
          value={profile.level}
          gradient="from-brand-500 to-cyan-500"
        />
        <StatTile
          Icon={IconTarget}
          label="Meta"
          value={`${profile.dailyGoalMinutes}m`}
          gradient="from-cyan-500 to-brand-500"
        />
        <StatTile
          Icon={IconSparkle}
          label="Vocab"
          value={String(totalCards)}
          gradient="from-pink-500 to-flame-500"
        />
      </section>

      {/* AWS Certifications hero */}
      <section>
        <h3 className="mb-3 flex items-center justify-between text-sm font-bold uppercase tracking-wider text-slate-500">
          Certificaciones AWS
        </h3>
        <Link
          to="/aws"
          className="glass block overflow-hidden rounded-2xl border border-orange-500/30 bg-gradient-to-br from-orange-500/15 via-transparent to-yellow-500/15 p-4 transition hover:-translate-y-0.5 hover:shadow-pop"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-orange-700 dark:text-orange-300">
                ☁️ CLF-C02 · SAA-C03
              </div>
              <div className="mt-1 text-base font-black">Prepara tu examen AWS</div>
              <div className="text-xs text-slate-500">40 simulacros · escenarios reales · explicaciones detalladas</div>
            </div>
            <IconChevronRight size={20} className="text-slate-400" />
          </div>
        </Link>
      </section>

      {/* AI Tools row */}
      <section>
        <h3 className="mb-3 flex items-center justify-between text-sm font-bold uppercase tracking-wider text-slate-500">
          Herramientas con IA
        </h3>
        <ul className="grid grid-cols-3 gap-2">
          {AI_TOOLS.map((t, i) => (
            <li key={t.to}>
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <Link
                  to={t.to}
                  className={`group flex flex-col items-center gap-1 rounded-2xl bg-gradient-to-br ${t.gradient} p-3 text-white shadow-pop transition hover:-translate-y-0.5`}
                >
                  <t.Icon size={22} />
                  <span className="text-xs font-bold">{t.label}</span>
                  <span className="hidden text-[9px] text-white/80 sm:inline">{t.hint}</span>
                </Link>
              </motion.div>
            </li>
          ))}
        </ul>
      </section>

      {/* Skills grid */}
      <section>
        <h3 className="mb-3 flex items-center justify-between text-sm font-bold uppercase tracking-wider text-slate-500">
          Practica una habilidad
        </h3>
        <ul className="grid grid-cols-2 gap-3">
          {SKILLS.map((s, i) => (
            <li key={s.to}>
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <Link
                  to={s.to}
                  className={`group relative block overflow-hidden rounded-2xl bg-gradient-to-br ${s.bg} p-4 shadow-soft transition hover:-translate-y-0.5 hover:shadow-pop dark:${s.darkBg}`}
                >
                  <div
                    className={`grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br ${s.gradient} text-white shadow-pop`}
                  >
                    <s.Icon size={22} />
                  </div>
                  <div className="mt-3 flex items-baseline justify-between">
                    <div>
                      <div className="text-base font-bold">{s.label}</div>
                      <div className="text-xs text-slate-500">{s.hint}</div>
                    </div>
                    <IconChevronRight size={16} className="text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-slate-600" />
                  </div>
                </Link>
              </motion.div>
            </li>
          ))}
        </ul>
      </section>

      {/* Packs */}
      <section>
        <h3 className="mb-3 flex items-center justify-between text-sm font-bold uppercase tracking-wider text-slate-500">
          Tus packs
          <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {enabled.length}
          </span>
        </h3>
        {installError ? (
          <ErrorState error={installError} onRetry={() => void install()} />
        ) : enabled.length === 0 ? (
          <EmptyState
            title="Aún no tienes packs instalados"
            hint="Instala los packs iniciales para arrancar."
            action={
              <button
                onClick={() => void install()}
                disabled={installing}
                className="rounded-xl bg-gradient-to-r from-brand-500 to-pink-500 px-5 py-2.5 text-sm font-bold text-white shadow-pop disabled:opacity-50"
              >
                {installing ? 'Instalando…' : 'Instalar packs de inicio'}
              </button>
            }
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {enabled.map((p, i) => (
              <li key={p.id}>
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                >
                  <Link
                    to={`/lesson/${p.id}`}
                    className="glass block rounded-2xl border border-white/60 p-4 shadow-soft transition hover:-translate-y-0.5 hover:shadow-glow dark:border-white/5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 className="text-base font-bold leading-tight">{p.title}</h4>
                        <p className="mt-1 text-xs text-slate-500">
                          {p.vocab.length} vocab · {p.listening.length} escucha · {p.speaking.length} habla
                        </p>
                        <div className="mt-3 flex gap-1.5">
                          {p.vocab.length > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-bold text-brand-700 dark:text-brand-300">
                              <IconCards size={10} /> {p.vocab.length}
                            </span>
                          ) : null}
                          {p.listening.length > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold text-cyan-700 dark:text-cyan-300">
                              <IconHeadphones size={10} /> {p.listening.length}
                            </span>
                          ) : null}
                          {p.speaking.length > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-pink-500/10 px-2 py-0.5 text-[10px] font-bold text-pink-700 dark:text-pink-300">
                              <IconMic size={10} /> {p.speaking.length}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-gradient-to-r from-brand-500 to-cyan-500 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest text-white shadow-glow">
                        {p.level}
                      </span>
                    </div>
                  </Link>
                </motion.div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatTile({
  Icon,
  label,
  value,
  gradient,
}: {
  Icon: React.ComponentType<{ size?: number }>;
  label: string;
  value: string;
  gradient: string;
}) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl border border-white/60 p-3 shadow-soft dark:border-white/5">
      <div
        className={`absolute -right-6 -top-6 h-16 w-16 rounded-full bg-gradient-to-br ${gradient} opacity-25 blur-xl`}
      />
      <div className="relative flex items-center gap-2">
        <div className={`grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br ${gradient} text-white`}>
          <Icon size={16} />
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
          <div className="text-lg font-black leading-none">{value}</div>
        </div>
      </div>
    </div>
  );
}
