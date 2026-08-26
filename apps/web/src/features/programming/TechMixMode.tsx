import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTechStore } from '../../stores/tech.js';
import { LoadingState, EmptyState } from '../../components/UiStates.js';
import { IconChevronRight, IconTarget, IconTrophy, IconSparkle } from '../../components/Icons.js';
import type { TechQuestion, TechSimulation } from '@linguadev/shared';

// MODO MIX (interleaved) — mezcla preguntas de todos los sims/tracks en una sola sesión.
// Basado en 'desirable difficulties' de Bjork: interleaving mejora retención vs bloques.
// El usuario elige tamaño (10/20/30) y opcionalmente track. Sin puntaje persistido —
// esta modalidad es para práctica de retención, no evaluación.

interface MixedQuestion extends TechQuestion {
  sourceSimId: string;
  sourceSimTitle: string;
  sourceTrackId: string;
}

const DIFF_BG: Record<string, string> = {
  junior: 'bg-success-500',
  mid: 'bg-flame-500',
  senior: 'bg-danger-500',
  staff: 'bg-purple-600',
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

export function TechMixMode() {
  const load = useTechStore((s) => s.load);
  const loaded = useTechStore((s) => s.loaded);
  const simulations = useTechStore((s) => s.simulations);
  const tracks = useTechStore((s) => s.tracks);

  const [trackFilter, setTrackFilter] = useState<string>('all');
  const [size, setSize] = useState(10);
  const [phase, setPhase] = useState<'config' | 'running' | 'done'>('config');
  const [questions, setQuestions] = useState<MixedQuestion[]>([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, { chosen: string[]; correct: boolean; skipped: boolean }>>({});

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const availableSims = useMemo(
    () =>
      trackFilter === 'all'
        ? simulations
        : simulations.filter((s) => s.trackId === trackFilter),
    [simulations, trackFilter],
  );

  const availableQuestionCount = useMemo(
    () => availableSims.reduce((n, s) => n + s.questions.length, 0),
    [availableSims],
  );

  function start() {
    const pool: MixedQuestion[] = [];
    for (const s of availableSims) {
      for (const q of s.questions) {
        pool.push({
          ...q,
          sourceSimId: s.id,
          sourceSimTitle: s.title,
          sourceTrackId: s.trackId,
        });
      }
    }
    const shuffled = shuffle(pool).slice(0, Math.min(size, pool.length));
    setQuestions(shuffled);
    setIdx(0);
    setAnswers({});
    setPhase('running');
  }

  if (!loaded) return <LoadingState />;
  if (simulations.length === 0)
    return <EmptyState title="Sin simulacros disponibles" hint="Primero completa algún track" />;

  if (phase === 'config') {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <Link to="/programming" className="text-xs font-semibold text-slate-500 underline">
            ← Programación
          </Link>
          <div className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-purple-500 to-cyan-500 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white shadow-glow">
            <IconSparkle size={12} /> Modo Mix · Interleaving
          </div>
          <h1 className="text-3xl font-black">Práctica interleaved</h1>
          <p className="max-w-2xl text-sm text-slate-500">
            Mezcla preguntas de todos los simulacros en orden aleatorio. Basado en <em>desirable difficulties</em> (Bjork): se siente más difícil pero <strong>+43 puntos porcentuales</strong> de retención vs practicar por bloques.
          </p>
        </header>

        <section className="glass rounded-2xl border border-white/60 p-4 dark:border-white/10">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Filtrar por track</h3>
          <div className="flex flex-wrap gap-2">
            <FilterChip active={trackFilter === 'all'} onClick={() => setTrackFilter('all')} label="Todos" count={simulations.length} />
            {tracks.map((t) => {
              const count = simulations.filter((s) => s.trackId === t.id).length;
              if (count === 0) return null;
              return (
                <FilterChip
                  key={t.id}
                  active={trackFilter === t.id}
                  onClick={() => setTrackFilter(t.id)}
                  label={`${t.icon} ${t.name}`}
                  count={count}
                />
              );
            })}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {availableQuestionCount} preguntas disponibles en tu filtro.
          </p>
        </section>

        <section className="glass rounded-2xl border border-white/60 p-4 dark:border-white/10">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Tamaño de sesión</h3>
          <div className="grid grid-cols-4 gap-2">
            {[10, 20, 30, 50].map((n) => (
              <button
                key={n}
                onClick={() => setSize(n)}
                disabled={n > availableQuestionCount}
                className={`rounded-xl py-3 text-sm font-black transition disabled:opacity-40 ${
                  size === n
                    ? 'bg-gradient-to-br from-purple-500 to-cyan-500 text-white shadow-pop'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/5 dark:text-slate-300'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </section>

        <button
          onClick={start}
          disabled={availableQuestionCount === 0}
          className="w-full rounded-2xl bg-gradient-to-r from-purple-500 via-brand-600 to-cyan-500 py-4 text-base font-black text-white shadow-pop disabled:opacity-40"
        >
          Empezar sesión mix
        </button>

        <section className="rounded-2xl bg-brand-500/5 p-4 text-xs">
          <h4 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-brand-700 dark:text-brand-300">
            📚 Por qué interleaving funciona
          </h4>
          <p className="text-slate-600 dark:text-slate-300">
            Cuando mezclas temas, tu cerebro trabaja más duro para recordar CUÁL principio aplica a esta pregunta específica (no solo recordar el principio). Esto se llama <strong>retrieval effort</strong> y crea memorias más duraderas. Al principio te sientes peor — es normal y esperado (Bjork lo llama "the desirable difficulty").
          </p>
        </section>
      </div>
    );
  }

  if (phase === 'done') {
    const answered = Object.values(answers).filter((a) => !a.skipped);
    const correct = answered.filter((a) => a.correct).length;
    const skipped = Object.values(answers).filter((a) => a.skipped).length;
    const pct = answered.length > 0 ? Math.round((correct / answered.length) * 100) : 0;
    return (
      <div className="space-y-6">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="rounded-3xl bg-gradient-to-br from-purple-500 via-brand-600 to-cyan-500 p-8 text-center text-white shadow-pop"
        >
          <div className="text-6xl">🧠</div>
          <h2 className="mt-2 text-2xl font-black">Sesión mix completada</h2>
          <p className="mt-4 text-5xl font-black tabular-nums">{pct}%</p>
          <p className="mt-1 text-sm opacity-90">
            {correct} de {answered.length} correctas · {skipped} saltadas
          </p>
          <p className="mt-3 text-xs opacity-80">
            El interleaving se siente más difícil pero mejora la retención a largo plazo. ¡Sigue así!
          </p>
        </motion.div>

        <div className="flex gap-2">
          <button
            onClick={() => setPhase('config')}
            className="flex-1 rounded-xl bg-gradient-to-r from-purple-500 to-cyan-500 py-2.5 text-sm font-bold text-white shadow-pop"
          >
            Otra sesión mix
          </button>
          <Link
            to="/programming"
            className="rounded-xl bg-slate-200 px-5 py-2.5 text-sm font-bold text-slate-700 dark:bg-white/10 dark:text-slate-200"
          >
            Volver
          </Link>
        </div>
      </div>
    );
  }

  const current = questions[idx];
  if (!current) return null;
  const state = answers[current.id];
  const revealed = !!state && !state.skipped;
  const correctLetters = new Set(current.options.filter((o) => o.correct).map((o) => o.letter));

  function choose(letter: string) {
    if (revealed || !current) return;
    const chosen = current.multiSelect
      ? state?.chosen.includes(letter)
        ? state.chosen.filter((l) => l !== letter)
        : [...(state?.chosen ?? []), letter]
      : [letter];
    if (!current.multiSelect) {
      const cLetters = new Set(current.options.filter((o) => o.correct).map((o) => o.letter));
      const isCorrect = chosen.length === cLetters.size && chosen.every((l) => cLetters.has(l as 'A' | 'B' | 'C' | 'D' | 'E' | 'F'));
      setAnswers((prev) => ({ ...prev, [current.id]: { chosen, correct: isCorrect, skipped: false } }));
    } else {
      setAnswers((prev) => ({ ...prev, [current.id]: { chosen, correct: false, skipped: false } }));
    }
  }

  function confirmMulti() {
    if (!current) return;
    const chosen = state?.chosen ?? [];
    const isCorrect =
      chosen.length === correctLetters.size &&
      chosen.every((l) => correctLetters.has(l as 'A' | 'B' | 'C' | 'D' | 'E' | 'F'));
    setAnswers((prev) => ({ ...prev, [current.id]: { chosen, correct: isCorrect, skipped: false } }));
  }

  function skip() {
    if (!current) return;
    setAnswers((prev) => ({ ...prev, [current.id]: { chosen: [], correct: false, skipped: true } }));
    goNext();
  }

  function goNext() {
    if (idx + 1 >= questions.length) setPhase('done');
    else setIdx(idx + 1);
  }

  return (
    <div className="space-y-4">
      <div className="glass flex items-center justify-between rounded-xl border border-white/60 p-2 dark:border-white/10">
        <span className="text-xs font-bold text-slate-500">
          Mix · {idx + 1} / {questions.length}
        </span>
        <span className="text-[10px] font-mono text-slate-400 truncate max-w-[50%]">
          desde: {current.sourceSimTitle}
        </span>
        <button
          onClick={() => setPhase('config')}
          className="rounded bg-danger-500/10 px-2 py-0.5 text-[10px] font-bold text-danger-600"
        >
          Salir
        </button>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={current.id}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.2 }}
          className="glass space-y-4 rounded-2xl border border-white/60 p-5 dark:border-white/10"
        >
          <div className="flex items-center justify-between text-[10px]">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 font-bold uppercase tracking-widest text-white ${
                  DIFF_BG[current.difficulty] ?? 'bg-slate-500'
                }`}
              >
                {current.difficulty}
              </span>
              <span className="font-mono font-bold text-slate-500">{current.topic}</span>
            </div>
            <span className="rounded bg-purple-500/10 px-1.5 py-0.5 font-bold text-purple-700 dark:text-purple-300">
              {current.sourceTrackId}
            </span>
          </div>

          <div>
            <p className="whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">{current.scenario}</p>
            <p className="mt-3 text-base font-bold">{current.question}</p>
          </div>

          <div className="space-y-2">
            {current.options.map((opt) => {
              const isChosen = state?.chosen.includes(opt.letter) ?? false;
              const isCorrect = correctLetters.has(opt.letter);
              const showColor = revealed;
              const cls = !showColor
                ? isChosen
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-slate-200 hover:border-brand-300 dark:border-white/10'
                : isCorrect
                ? 'border-success-500 bg-success-500/10'
                : isChosen
                ? 'border-danger-500 bg-danger-500/10'
                : 'border-slate-200 dark:border-white/10 opacity-60';
              return (
                <button
                  key={opt.letter}
                  onClick={() => choose(opt.letter)}
                  disabled={revealed}
                  className={`w-full rounded-xl border-2 p-3 text-left text-sm transition ${cls}`}
                >
                  <div className="flex items-start gap-3">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 font-bold dark:bg-white/10">
                      {opt.letter}
                    </span>
                    <span className="flex-1 whitespace-pre-line">{opt.text}</span>
                    {revealed ? (
                      <span className="shrink-0 text-lg">
                        {isCorrect ? '✅' : isChosen ? '❌' : ''}
                      </span>
                    ) : null}
                  </div>
                  {revealed && opt.why ? (
                    <p
                      className={`mt-2 pl-10 text-[12px] italic ${
                        isCorrect ? 'text-success-700 dark:text-success-300' : 'text-slate-500'
                      }`}
                    >
                      {opt.why}
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>

          {current.multiSelect && !revealed ? (
            <button
              onClick={confirmMulti}
              disabled={!state?.chosen.length}
              className="w-full rounded-xl bg-gradient-to-r from-purple-500 to-cyan-500 py-2.5 text-sm font-bold text-white disabled:opacity-40"
            >
              Confirmar respuesta
            </button>
          ) : null}

          {revealed ? (
            <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-white/5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Explicación</div>
              <p className="mt-1 whitespace-pre-line leading-relaxed text-slate-700 dark:text-slate-200">
                {current.explanation}
              </p>
              {current.realWorld ? (
                <div className="mt-3 rounded-lg border-l-4 border-cyan-500 bg-cyan-500/5 p-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">
                    🌍 Caso real
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-slate-700 dark:text-slate-200">
                    {current.realWorld}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </motion.div>
      </AnimatePresence>

      <div className="flex gap-2">
        <button
          onClick={skip}
          className="rounded-xl border border-slate-300/70 px-4 py-2.5 text-sm font-semibold text-slate-500 dark:border-slate-700"
        >
          ⏭️ Saltar
        </button>
        {revealed || answers[current.id]?.skipped ? (
          <button
            onClick={goNext}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-xl bg-gradient-to-r from-purple-500 to-cyan-500 px-4 py-2.5 text-sm font-bold text-white shadow-pop"
          >
            {idx + 1 >= questions.length ? (
              <>
                <IconTrophy size={14} /> Terminar
              </>
            ) : (
              <>
                Siguiente <IconChevronRight size={14} />
              </>
            )}
          </button>
        ) : (
          <button
            disabled
            className="flex-1 rounded-xl bg-slate-200 py-2.5 text-sm font-bold text-slate-400 dark:bg-white/5"
          >
            Elige una respuesta o Salta
          </button>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition ${
        active
          ? 'bg-gradient-to-r from-purple-500 to-cyan-500 text-white shadow-pop'
          : 'bg-slate-200 text-slate-600 hover:bg-slate-300 dark:bg-white/5 dark:text-slate-300'
      }`}
    >
      {label}
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${active ? 'bg-white/25' : 'bg-slate-100 dark:bg-white/10'}`}>
        {count}
      </span>
    </button>
  );
}
