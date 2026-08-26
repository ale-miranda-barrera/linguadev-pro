import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAwsStore } from '../../stores/aws.js';
import { useTechStore } from '../../stores/tech.js';
import { usePacksStore } from '../../stores/packs.js';
import { useProfileStore } from '../../stores/profile.js';
import { db } from '../../db/dexie.js';
import { useState } from 'react';
import type { LevelProgress, TechSimAttempt } from '../../db/dexie.js';

// Pestaña unificada de progreso: mapa de dominio a través de Inglés, AWS, Programador, Arquitectura.
// Toda la data proviene de Dexie (local-first) — no requiere backend.

interface AreaSummary {
  title: string;
  icon: string;
  href: string;
  gradient: string;
  passed: number;
  total: number;
  avgScore: number | null;
  extra?: string;
}

export function Progress() {
  const awsLoad = useAwsStore((s) => s.load);
  const awsLoaded = useAwsStore((s) => s.loaded);
  const awsSims = useAwsStore((s) => s.simulations);
  const awsAttempts = useAwsStore((s) => s.attempts);

  const techLoad = useTechStore((s) => s.load);
  const techLoaded = useTechStore((s) => s.loaded);
  const techSims = useTechStore((s) => s.simulations);
  const techAttempts = useTechStore((s) => s.attempts);
  const techTracks = useTechStore((s) => s.tracks);

  const packs = usePacksStore((s) => s.packs);
  const profile = useProfileStore((s) => s.profile);

  const [levelProgress, setLevelProgress] = useState<LevelProgress[]>([]);

  useEffect(() => {
    if (!awsLoaded) void awsLoad();
    if (!techLoaded) void techLoad();
    void db.levelProgress.toArray().then(setLevelProgress);
  }, [awsLoaded, awsLoad, techLoaded, techLoad]);

  const englishBands = useMemo(() => {
    const bandMap: Record<string, { passed: number; total: number }> = {};
    for (const lp of levelProgress) {
      const b = bandMap[lp.band] ?? { passed: 0, total: 0 };
      b.total += 1;
      if (lp.passed) b.passed += 1;
      bandMap[lp.band] = b;
    }
    return bandMap;
  }, [levelProgress]);

  const areas: AreaSummary[] = useMemo(() => {
    const out: AreaSummary[] = [];

    // Inglés
    const totalPacks = packs.length;
    const enabledPacks = packs.filter((p) => p.enabled).length;
    const englishAvg = levelProgress.length > 0
      ? Math.round((levelProgress.reduce((s, l) => s + l.bestScore01, 0) / levelProgress.length) * 100)
      : null;
    out.push({
      title: 'Inglés',
      icon: '🇬🇧',
      href: '/',
      gradient: 'from-brand-500 via-brand-600 to-pink-600',
      passed: levelProgress.filter((l) => l.passed).length,
      total: totalPacks,
      avgScore: englishAvg,
      extra: `${enabledPacks} packs activos · nivel ${profile.level}`,
    });

    // AWS
    const awsPassed = Object.values(awsAttempts).filter((a) => a.passed).length;
    const awsAvg = Object.values(awsAttempts).length > 0
      ? Math.round((Object.values(awsAttempts).reduce((s, a) => s + a.bestScore01, 0) / Object.values(awsAttempts).length) * 100)
      : null;
    out.push({
      title: 'Certificaciones AWS',
      icon: '☁️',
      href: '/aws',
      gradient: 'from-orange-500 via-orange-600 to-yellow-500',
      passed: awsPassed,
      total: awsSims.length,
      avgScore: awsAvg,
    });

    // Tech tracks
    for (const track of techTracks) {
      const sims = techSims.filter((s) => s.trackId === track.id);
      const trackAttempts = sims
        .map((s) => techAttempts[s.id])
        .filter((a): a is TechSimAttempt => Boolean(a));
      const passedCount = trackAttempts.filter((a) => a.passed).length;
      const avg = trackAttempts.length > 0
        ? Math.round((trackAttempts.reduce((s, a) => s + a.bestScore01, 0) / trackAttempts.length) * 100)
        : null;
      out.push({
        title: track.name,
        icon: track.icon,
        href: `/programming/${track.id}`,
        gradient:
          track.id === 'programmer'
            ? 'from-brand-600 via-brand-700 to-pink-600'
            : track.id === 'architecture'
            ? 'from-cyan-500 via-brand-600 to-indigo-600'
            : 'from-brand-500 to-cyan-500',
        passed: passedCount,
        total: sims.length,
        avgScore: avg,
      });
    }

    return out;
  }, [awsAttempts, awsSims, techAttempts, techSims, techTracks, packs, levelProgress, profile.level]);

  const overallProgress = areas.length > 0
    ? Math.round((areas.reduce((s, a) => s + (a.total > 0 ? a.passed / a.total : 0), 0) / areas.length) * 100)
    : 0;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-brand-500 to-cyan-500 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white shadow-glow">
          🗺️ Progreso
        </div>
        <h1 className="text-3xl font-black">Tu mapa de aprendizaje</h1>
        <p className="max-w-2xl text-sm text-slate-500">
          Todo tu progreso en un solo lugar: inglés, AWS, programación y arquitectura. La data se guarda <strong>localmente</strong> — puedes practicar sin internet.
        </p>
      </header>

      {/* Overall */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-3xl bg-gradient-to-br from-brand-600 via-brand-700 to-cyan-600 p-6 text-white shadow-pop"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest opacity-80">Progreso global</div>
            <div className="mt-1 text-5xl font-black tabular-nums">{overallProgress}%</div>
            <p className="mt-1 text-xs opacity-90">Promedio de áreas superadas en cada track</p>
          </div>
          <div className="text-6xl">📈</div>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/20">
          <motion.div
            className="h-full rounded-full bg-white"
            initial={{ width: 0 }}
            animate={{ width: `${overallProgress}%` }}
            transition={{ type: 'spring', stiffness: 80, damping: 20 }}
          />
        </div>
      </motion.section>

      {/* Areas grid */}
      <section>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Por área</h3>
        <ul className="grid gap-3 sm:grid-cols-2">
          {areas.map((a, i) => (
            <li key={a.title}>
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <Link
                  to={a.href}
                  className={`relative block overflow-hidden rounded-2xl bg-gradient-to-br ${a.gradient} p-5 text-white shadow-soft transition hover:-translate-y-0.5 hover:shadow-pop`}
                >
                  <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-white/15 blur-2xl" />
                  <div className="relative">
                    <div className="flex items-center justify-between">
                      <span className="text-2xl">{a.icon}</span>
                      {a.avgScore !== null ? (
                        <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-black tabular-nums backdrop-blur">
                          {a.avgScore}%
                        </span>
                      ) : (
                        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest opacity-70">
                          Sin datos
                        </span>
                      )}
                    </div>
                    <h4 className="mt-3 text-lg font-black">{a.title}</h4>
                    {a.extra ? <p className="mt-1 text-[11px] opacity-80">{a.extra}</p> : null}
                    <div className="mt-3 flex items-center justify-between text-xs">
                      <span className="font-bold">
                        {a.passed}/{a.total} completadas
                      </span>
                      <span className="font-mono opacity-80">
                        {a.total > 0 ? Math.round((a.passed / a.total) * 100) : 0}%
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/20">
                      <div
                        className="h-full rounded-full bg-white"
                        style={{ width: `${a.total > 0 ? (a.passed / a.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                </Link>
              </motion.div>
            </li>
          ))}
        </ul>
      </section>

      {/* English band breakdown */}
      {Object.keys(englishBands).length > 0 ? (
        <section>
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Inglés por banda CEFR</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Object.entries(englishBands).map(([band, v]) => {
              const p = Math.round((v.passed / v.total) * 100);
              return (
                <div key={band} className="glass rounded-xl border border-white/60 p-3 dark:border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-wider">{band}</span>
                    <span className="text-xs font-mono">{v.passed}/{v.total}</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200/60 dark:bg-white/5">
                    <div className={`h-full ${p >= 80 ? 'bg-success-500' : p >= 50 ? 'bg-flame-500' : 'bg-danger-500'}`} style={{ width: `${p}%` }} />
                  </div>
                  <div className="mt-1 text-right text-[10px] font-bold text-slate-500">{p}%</div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Recent attempts */}
      <section>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Últimos intentos</h3>
        <RecentAttempts awsAttempts={awsAttempts} techAttempts={techAttempts} awsSims={awsSims} techSims={techSims} />
      </section>
    </div>
  );
}

function RecentAttempts({
  awsAttempts,
  techAttempts,
  awsSims,
  techSims,
}: {
  awsAttempts: Record<string, { simId: string; bestScore01: number; passed: boolean; lastAttemptAt: string; certId: string }>;
  techAttempts: Record<string, { simId: string; bestScore01: number; passed: boolean; lastAttemptAt: string; trackId: string }>;
  awsSims: { id: string; title: string }[];
  techSims: { id: string; title: string }[];
}) {
  const all = useMemo(() => {
    const rows: {
      simId: string;
      title: string;
      score: number;
      passed: boolean;
      when: string;
      href: string;
      kind: 'AWS' | 'Tech';
    }[] = [];
    for (const a of Object.values(awsAttempts)) {
      const sim = awsSims.find((s) => s.id === a.simId);
      rows.push({
        simId: a.simId,
        title: sim?.title ?? a.simId,
        score: Math.round(a.bestScore01 * 100),
        passed: a.passed,
        when: a.lastAttemptAt,
        href: `/aws/${a.certId}/sim/${a.simId}`,
        kind: 'AWS',
      });
    }
    for (const a of Object.values(techAttempts)) {
      const sim = techSims.find((s) => s.id === a.simId);
      rows.push({
        simId: a.simId,
        title: sim?.title ?? a.simId,
        score: Math.round(a.bestScore01 * 100),
        passed: a.passed,
        when: a.lastAttemptAt,
        href: `/programming/${a.trackId}/sim/${a.simId}`,
        kind: 'Tech',
      });
    }
    return rows.sort((a, b) => (b.when > a.when ? 1 : -1)).slice(0, 8);
  }, [awsAttempts, techAttempts, awsSims, techSims]);

  if (all.length === 0)
    return (
      <p className="text-sm text-slate-500">Aún no has completado simulacros. ¡Empieza por Programación o AWS!</p>
    );

  return (
    <ul className="space-y-2">
      {all.map((r) => (
        <li key={r.simId + r.when}>
          <Link
            to={r.href}
            className="glass flex items-center justify-between rounded-xl border border-white/60 p-3 transition hover:-translate-y-0.5 hover:shadow-soft dark:border-white/10"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-white ${
                    r.kind === 'AWS' ? 'bg-orange-500' : 'bg-brand-600'
                  }`}
                >
                  {r.kind}
                </span>
                <span className="truncate text-sm font-bold">{r.title}</span>
              </div>
              <div className="mt-1 text-[10px] text-slate-500">{new Date(r.when).toLocaleString()}</div>
            </div>
            <div className="text-right">
              <div
                className={`text-lg font-black tabular-nums ${
                  r.passed ? 'text-success-600' : 'text-flame-600'
                }`}
              >
                {r.score}%
              </div>
              <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                {r.passed ? 'aprobado' : 'reintentar'}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
