import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useProfileStore } from '../../stores/profile.js';
import { usePacksStore } from '../../stores/packs.js';
import { useAwsStore } from '../../stores/aws.js';
import { useTechStore } from '../../stores/tech.js';
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

const ENGLISH_SKILLS = [
  { to: '/vocab', label: 'Vocab', hint: 'SRS + Quiz + Mix', Icon: IconCards, gradient: 'from-brand-500 to-pink-500' },
  { to: '/listening', label: 'Escucha', hint: 'Dictados con audio', Icon: IconHeadphones, gradient: 'from-cyan-500 to-brand-500' },
  { to: '/speaking', label: 'Habla', hint: 'Grabación + score', Icon: IconMic, gradient: 'from-pink-500 to-flame-500' },
  { to: '/writing', label: 'Escribir', hint: 'Prompts + feedback', Icon: IconPencil, gradient: 'from-flame-500 to-brand-500' },
];

const ENGLISH_TOOLS = [
  { to: '/voice-call', label: 'Voice Call', hint: 'Conversa con IA por voz', Icon: IconPhone, gradient: 'from-brand-500 to-pink-500' },
  { to: '/tutor', label: 'Tutor', hint: 'Pega un MD, aprende + quiz', Icon: IconSparkle, gradient: 'from-cyan-500 to-brand-500' },
  { to: '/chat', label: 'Chat', hint: 'Chatea en inglés', Icon: IconPencil, gradient: 'from-purple-500 to-brand-500' },
  { to: '/create', label: 'Crear', hint: 'Arma tus propios ejercicios', Icon: IconPencil, gradient: 'from-flame-500 to-pink-500' },
];

interface ProgrammingItem {
  to: string;
  icon: string;
  label: string;
  hint: string;
  gradient: string;
  passed: number;
  total: number;
}

export function Dashboard() {
  const profile = useProfileStore((s) => s.profile);
  const loadedProfile = useProfileStore((s) => s.loaded);
  const installBundled = usePacksStore((s) => s.installBundled);
  const packs = usePacksStore((s) => s.packs);
  const loadedPacks = usePacksStore((s) => s.loaded);

  const awsLoad = useAwsStore((s) => s.load);
  const awsLoaded = useAwsStore((s) => s.loaded);
  const awsSims = useAwsStore((s) => s.simulations);
  const awsAttempts = useAwsStore((s) => s.attempts);

  const techLoad = useTechStore((s) => s.load);
  const techLoaded = useTechStore((s) => s.loaded);
  const techSims = useTechStore((s) => s.simulations);
  const techAttempts = useTechStore((s) => s.attempts);
  const techTracks = useTechStore((s) => s.tracks);

  const [installError, setInstallError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [openEnglish, setOpenEnglish] = useState(true);
  const [openProgramming, setOpenProgramming] = useState(true);

  useEffect(() => {
    if (!awsLoaded) void awsLoad();
    if (!techLoaded) void techLoad();
  }, [awsLoaded, awsLoad, techLoaded, techLoad]);

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

  const programmingItems: ProgrammingItem[] = useMemo(() => {
    const items: ProgrammingItem[] = [];
    items.push({
      to: '/aws',
      icon: '☁️',
      label: 'Certificados AWS',
      hint: 'CLF-C02 · SAA-C03',
      gradient: 'from-orange-500 to-yellow-500',
      passed: Object.values(awsAttempts).filter((a) => a.passed).length,
      total: awsSims.length,
    });
    for (const t of techTracks) {
      const sims = techSims.filter((s) => s.trackId === t.id);
      const passed = sims.filter((s) => techAttempts[s.id]?.passed).length;
      items.push({
        to: `/programming/${t.id}`,
        icon: t.icon,
        label: t.name,
        hint: t.tagline,
        gradient:
          t.id === 'programmer'
            ? 'from-brand-500 to-pink-500'
            : t.id === 'architecture'
            ? 'from-cyan-500 to-indigo-500'
            : 'from-brand-500 to-cyan-500',
        passed,
        total: sims.length,
      });
    }
    return items;
  }, [awsSims, awsAttempts, techSims, techAttempts, techTracks]);

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
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-cyan-400/30 blur-3xl animate-blob" />
        <div className="pointer-events-none absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-pink-400/30 blur-3xl animate-blob" />

        <div className="relative flex items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ring-1 ring-white/20 backdrop-blur">
              <IconSparkle size={12} />
              Tu día
            </div>
            <h2 className="mt-3 max-w-md text-2xl font-black leading-tight sm:text-3xl">
              {profile.dailyGoalMinutes} min · inglés + tech práctico
            </h2>
            <p className="mt-1 text-sm text-white/70">
              {totalCards} tarjetas · {awsSims.length + techSims.length} simulacros disponibles
            </p>
          </div>
          <StreakBadge streak={profile.streak} />
        </div>

        <div className="relative mt-6 flex flex-wrap gap-2">
          <Link
            to="/progress"
            className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-brand-700 transition hover:scale-[1.02] active:scale-95"
          >
            🗺️ Mi progreso
          </Link>
          <Link
            to="/path"
            className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-4 py-2.5 text-sm font-semibold ring-1 ring-white/25 backdrop-blur transition hover:bg-white/25"
          >
            <IconTarget size={16} />
            Ruta CEFR
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
        <StatTile Icon={IconTrophy} label="Nivel" value={profile.level} gradient="from-brand-500 to-cyan-500" />
        <StatTile Icon={IconTarget} label="Meta" value={`${profile.dailyGoalMinutes}m`} gradient="from-cyan-500 to-brand-500" />
        <StatTile Icon={IconSparkle} label="Vocab" value={String(totalCards)} gradient="from-pink-500 to-flame-500" />
      </section>

      {/* SECCIÓN INGLÉS (colapsable) */}
      <SectionHeader
        title="Inglés"
        icon="🇬🇧"
        open={openEnglish}
        onToggle={() => setOpenEnglish((v) => !v)}
        countLabel={`${enabled.length} packs · nivel ${profile.level}`}
      />
      <AnimatePresence initial={false}>
        {openEnglish ? (
          <motion.div
            key="english"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-6 overflow-hidden"
          >
            {/* Skills grid */}
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {ENGLISH_SKILLS.map((s, i) => (
                <li key={s.to}>
                  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                    <Link
                      to={s.to}
                      className={`group relative block overflow-hidden rounded-2xl bg-gradient-to-br ${s.gradient} p-4 text-white shadow-pop transition hover:-translate-y-0.5`}
                    >
                      <div className="flex flex-col items-start gap-2">
                        <s.Icon size={22} />
                        <div>
                          <div className="text-sm font-black">{s.label}</div>
                          <div className="text-[10px] opacity-80">{s.hint}</div>
                        </div>
                      </div>
                    </Link>
                  </motion.div>
                </li>
              ))}
            </ul>

            {/* AI tools */}
            <div>
              <h4 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Herramientas con IA</h4>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {ENGLISH_TOOLS.map((t) => (
                  <li key={t.to}>
                    <Link
                      to={t.to}
                      className="glass flex items-center gap-2 rounded-xl border border-white/60 p-2.5 text-xs font-bold transition hover:-translate-y-0.5 hover:shadow-soft dark:border-white/10"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-cyan-500 text-white">
                        <t.Icon size={14} />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate">{t.label}</div>
                        <div className="truncate text-[9px] font-normal text-slate-500">{t.hint}</div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Packs */}
            <div>
              <h4 className="mb-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Tus packs
                <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {enabled.length}
                </span>
              </h4>
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
                <ul className="grid gap-2 sm:grid-cols-2">
                  {enabled.map((p) => (
                    <li key={p.id}>
                      <Link
                        to={`/lesson/${p.id}`}
                        className="glass block rounded-xl border border-white/60 p-3 transition hover:-translate-y-0.5 hover:shadow-soft dark:border-white/10"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h5 className="truncate text-sm font-bold">{p.title}</h5>
                            <p className="mt-0.5 text-[10px] text-slate-500">
                              {p.vocab.length} vocab · {p.listening.length} escucha · {p.speaking.length} habla
                            </p>
                          </div>
                          <span className="shrink-0 rounded-full bg-gradient-to-r from-brand-500 to-cyan-500 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-white">
                            {p.level}
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* SECCIÓN PROGRAMACIÓN (colapsable) */}
      <SectionHeader
        title="Programación"
        icon="💻"
        open={openProgramming}
        onToggle={() => setOpenProgramming((v) => !v)}
        countLabel={`${programmingItems.reduce((s, i) => s + i.total, 0)} simulacros`}
      />
      <AnimatePresence initial={false}>
        {openProgramming ? (
          <motion.div
            key="programming"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ul className="grid gap-3 sm:grid-cols-3">
              {programmingItems.map((item, i) => {
                const pct = item.total > 0 ? Math.round((item.passed / item.total) * 100) : 0;
                return (
                  <li key={item.to}>
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                      <Link
                        to={item.to}
                        className={`group relative block overflow-hidden rounded-2xl bg-gradient-to-br ${item.gradient} p-4 text-white shadow-pop transition hover:-translate-y-0.5`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xl">{item.icon}</span>
                          <IconChevronRight size={16} />
                        </div>
                        <div className="mt-3">
                          <div className="text-base font-black">{item.label}</div>
                          <div className="text-[10px] opacity-80">{item.hint}</div>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-[11px] font-bold">
                          <span>
                            {item.passed}/{item.total} superadas
                          </span>
                          <span className="font-mono opacity-80">{pct}%</span>
                        </div>
                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/20">
                          <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
                        </div>
                      </Link>
                    </motion.div>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SectionHeader({
  title,
  icon,
  open,
  onToggle,
  countLabel,
}: {
  title: string;
  icon: string;
  open: boolean;
  onToggle: () => void;
  countLabel: string;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-xl bg-slate-100 px-4 py-3 text-left transition hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10"
    >
      <div className="flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <div>
          <h3 className="text-lg font-black leading-none">{title}</h3>
          <p className="mt-0.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">{countLabel}</p>
        </div>
      </div>
      <IconChevronRight
        size={18}
        className={`text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
      />
    </button>
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
      <div className={`absolute -right-6 -top-6 h-16 w-16 rounded-full bg-gradient-to-br ${gradient} opacity-25 blur-xl`} />
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
