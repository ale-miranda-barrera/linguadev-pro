import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTechStore } from '../../stores/tech.js';
import { EmptyState, LoadingState } from '../../components/UiStates.js';
import { IconChevronRight, IconClock, IconTarget, IconTrophy } from '../../components/Icons.js';
import { DifficultyRating } from '../../components/DifficultyRating.js';
import type { TechQuestion, TechSimulation } from '@linguadev/shared';

type Phase = 'intro' | 'running' | 'review';

interface AnswerState {
  chosen: string[];
  markedForReview: boolean;
}

const DIFF_BG: Record<string, string> = {
  junior: 'bg-success-500',
  mid: 'bg-flame-500',
  senior: 'bg-danger-500',
  staff: 'bg-purple-600',
};

const GRADIENT_BY_TRACK: Record<string, string> = {
  programmer: 'from-brand-600 to-pink-600',
  architecture: 'from-cyan-500 to-indigo-600',
  devops: 'from-emerald-500 to-teal-600',
  databases: 'from-orange-500 to-red-500',
  systemdesign: 'from-purple-500 to-brand-600',
};

export function TechSimRunner() {
  const { trackId, simId } = useParams<{ trackId: string; simId: string }>();
  const navigate = useNavigate();
  const load = useTechStore((s) => s.load);
  const loaded = useTechStore((s) => s.loaded);
  const simulations = useTechStore((s) => s.simulations);
  const recordAttempt = useTechStore((s) => s.recordAttempt);
  const bestFor = useTechStore((s) => s.bestFor);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const sim = simulations.find((s) => s.id === simId);

  const [phase, setPhase] = useState<Phase>('intro');
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [examMode, setExamMode] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timerRef = useRef<number | null>(null);
  // Modo "revisar errores": filtra las questions a solo las que fallé la última vez.
  const [reviewOnlyWrong, setReviewOnlyWrong] = useState<string[] | null>(null);

  useEffect(() => {
    if (phase === 'running' && examMode && secondsLeft > 0) {
      timerRef.current = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    }
    if (phase === 'running' && examMode && secondsLeft === 0) {
      setPhase('review');
    }
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [phase, secondsLeft, examMode]);

  if (!loaded) return <LoadingState />;
  if (!sim)
    return (
      <EmptyState
        title="Simulacro no encontrado"
        hint="Vuelve al índice"
        action={
          <Link to={`/programming/${trackId}`} className="rounded bg-brand-600 px-3 py-1.5 text-sm text-white">
            Volver
          </Link>
        }
      />
    );

  // Si estamos en modo review-only-wrong, trabajamos con un subset filtrado.
  const activeQuestions = useMemo(() => {
    if (!sim) return [];
    if (!reviewOnlyWrong) return sim.questions;
    const set = new Set(reviewOnlyWrong);
    return sim.questions.filter((q) => set.has(q.id));
  }, [sim, reviewOnlyWrong]);
  const totalQs = activeQuestions.length;
  const answered = Object.keys(answers).length;
  const gradient = GRADIENT_BY_TRACK[sim.trackId] ?? 'from-brand-500 to-cyan-500';

  function start(mode: 'practice' | 'exam') {
    setExamMode(mode === 'exam');
    setSecondsLeft(sim!.timeLimitMin * 60);
    setPhase('running');
    setIdx(0);
    setAnswers({});
    setReviewOnlyWrong(null);
  }

  function startReviewWrong(wrongIds: string[]) {
    setReviewOnlyWrong(wrongIds);
    setExamMode(false);
    setPhase('running');
    setIdx(0);
    setAnswers({});
  }

  function submitAnswer(qId: string, chosen: string[]) {
    setAnswers((prev) => ({
      ...prev,
      [qId]: { chosen, markedForReview: prev[qId]?.markedForReview ?? false },
    }));
  }

  function toggleReview(qId: string) {
    setAnswers((prev) => {
      const cur = prev[qId] ?? { chosen: [], markedForReview: false };
      return { ...prev, [qId]: { ...cur, markedForReview: !cur.markedForReview } };
    });
  }

  function goToQuestion(i: number) {
    if (i < 0 || i >= totalQs) return;
    setIdx(i);
  }

  async function finish() {
    let correctCount = 0;
    const perArea: Record<string, { correct: number; total: number }> = {};
    for (const q of activeQuestions) {
      const state = answers[q.id];
      const chosen = new Set(state?.chosen ?? []);
      const correctLetters = new Set(q.options.filter((o) => o.correct).map((o) => o.letter));
      const isCorrect =
        chosen.size === correctLetters.size &&
        [...chosen].every((l) => correctLetters.has(l as 'A' | 'B' | 'C' | 'D' | 'E' | 'F'));
      if (isCorrect) correctCount++;
      const d = perArea[q.areaId] ?? { correct: 0, total: 0 };
      d.total += 1;
      if (isCorrect) d.correct += 1;
      perArea[q.areaId] = d;
    }
    const score01 = totalQs > 0 ? correctCount / totalQs : 0;
    // Solo guardar attempt en el sim completo — no queremos que sesiones parciales de review
    // sobrescriban el bestScore01 del intento completo.
    if (!reviewOnlyWrong) {
      await recordAttempt(sim!, score01, perArea);
    }
    setPhase('review');
  }

  if (phase === 'intro') {
    const best = bestFor(sim.id);
    return (
      <IntroScreen
        sim={sim}
        best={best?.bestScore01}
        onStart={start}
        onBack={() => navigate(`/programming/${trackId}`)}
        gradient={gradient}
      />
    );
  }

  if (phase === 'review') {
    return (
      <ReviewScreen
        sim={sim}
        activeQuestions={activeQuestions}
        answers={answers}
        onRestart={() => start(examMode ? 'exam' : 'practice')}
        onReviewWrong={startReviewWrong}
        wasReviewMode={!!reviewOnlyWrong}
        trackId={trackId!}
      />
    );
  }

  const current = activeQuestions[idx]!;
  const state = answers[current.id];

  return (
    <div className="space-y-4">
      <RunHeader
        sim={sim}
        idx={idx}
        total={totalQs}
        answered={answered}
        examMode={examMode}
        secondsLeft={secondsLeft}
        onSubmit={finish}
        gradient={gradient}
      />

      <AnimatePresence mode="wait">
        <motion.div
          key={current.id}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.2 }}
        >
          <QuestionCard
            q={current}
            chosen={state?.chosen ?? []}
            markedForReview={state?.markedForReview ?? false}
            revealed={!examMode && !!state}
            onChoose={(letter) => {
              const cur = state?.chosen ?? [];
              let next: string[];
              if (current.multiSelect) {
                next = cur.includes(letter) ? cur.filter((l) => l !== letter) : [...cur, letter];
              } else {
                next = [letter];
              }
              submitAnswer(current.id, next);
            }}
            onToggleReview={() => toggleReview(current.id)}
          />
        </motion.div>
      </AnimatePresence>

      <NavBar
        idx={idx}
        total={totalQs}
        onPrev={() => goToQuestion(idx - 1)}
        onNext={() => goToQuestion(idx + 1)}
        onFinish={finish}
        answers={answers}
        questions={activeQuestions}
        onJump={goToQuestion}
        gradient={gradient}
      />
    </div>
  );
}

function IntroScreen({
  sim,
  best,
  onStart,
  onBack,
  gradient,
}: {
  sim: TechSimulation;
  best?: number;
  onStart: (m: 'practice' | 'exam') => void;
  onBack: () => void;
  gradient: string;
}) {
  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-xs font-semibold text-slate-500 underline">
        ← Volver a simulacros
      </button>
      <div className={`rounded-3xl bg-gradient-to-br ${gradient} p-6 text-white shadow-pop`}>
        <div className="text-[10px] font-black uppercase tracking-widest opacity-80">
          Simulacro {String(sim.order).padStart(2, '0')}
        </div>
        <h1 className="mt-1 text-2xl font-black leading-tight">{sim.title}</h1>
        <p className="mt-2 text-sm opacity-90">{sim.focus}</p>
        <div className="mt-4 grid grid-cols-3 gap-3 text-center text-xs">
          <div className="rounded-lg bg-white/15 p-3 backdrop-blur">
            <div className="text-xl font-black">{sim.questions.length}</div>
            <div className="opacity-80">preguntas</div>
          </div>
          <div className="rounded-lg bg-white/15 p-3 backdrop-blur">
            <div className="text-xl font-black">{sim.timeLimitMin}m</div>
            <div className="opacity-80">tiempo</div>
          </div>
          <div className="rounded-lg bg-white/15 p-3 backdrop-blur">
            <div className="text-xl font-black">{Math.round(sim.passThreshold * 100)}%</div>
            <div className="opacity-80">para pasar</div>
          </div>
        </div>
        {best !== undefined ? (
          <p className="mt-3 text-xs opacity-90">
            Mejor puntaje anterior: <strong>{Math.round(best * 100)}%</strong>
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          onClick={() => onStart('practice')}
          className="glass rounded-2xl border-2 border-brand-500/40 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-pop"
        >
          <div className="flex items-center gap-2 text-brand-600">
            <IconTarget size={18} />
            <span className="text-sm font-black uppercase tracking-wider">Modo Práctica</span>
          </div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Feedback inmediato tras cada pregunta. Sin tiempo. Ideal para aprender por primera vez.
          </p>
        </button>
        <button
          onClick={() => onStart('exam')}
          className="rounded-2xl bg-gradient-to-br from-danger-500 to-flame-500 p-4 text-left text-white shadow-pop transition hover:-translate-y-0.5"
        >
          <div className="flex items-center gap-2">
            <IconClock size={18} />
            <span className="text-sm font-black uppercase tracking-wider">Modo Examen</span>
          </div>
          <p className="mt-2 text-sm opacity-90">
            Con temporizador. Sin feedback hasta el final. Mide dominio real.
          </p>
        </button>
      </div>
    </div>
  );
}

function RunHeader({
  sim,
  idx,
  total,
  answered,
  examMode,
  secondsLeft,
  onSubmit,
  gradient,
}: {
  sim: TechSimulation;
  idx: number;
  total: number;
  answered: number;
  examMode: boolean;
  secondsLeft: number;
  onSubmit: () => void;
  gradient: string;
}) {
  const pct = Math.round(((idx + 1) / total) * 100);
  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  return (
    <div className="glass rounded-2xl border border-white/60 p-3 dark:border-white/10">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 font-semibold text-slate-500">
          <span>{sim.title}</span>
        </div>
        <div className="flex items-center gap-3">
          {examMode ? (
            <span
              className={`inline-flex items-center gap-1 font-mono font-bold ${
                secondsLeft < 300 ? 'text-danger-600' : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <IconClock size={12} /> {mins}:{secs.toString().padStart(2, '0')}
            </span>
          ) : null}
          <span className="font-mono text-slate-400">
            {idx + 1}/{total} · {answered} contestadas
          </span>
          <button
            onClick={onSubmit}
            className="rounded-lg bg-danger-500 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-danger-600"
          >
            Terminar
          </button>
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200/60 dark:bg-white/5">
        <motion.div
          className={`h-full rounded-full bg-gradient-to-r ${gradient}`}
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  );
}

function QuestionCard({
  q,
  chosen,
  markedForReview,
  revealed,
  onChoose,
  onToggleReview,
}: {
  q: TechQuestion;
  chosen: string[];
  markedForReview: boolean;
  revealed: boolean;
  onChoose: (letter: string) => void;
  onToggleReview: () => void;
}) {
  const correctLetters = new Set(q.options.filter((o) => o.correct).map((o) => o.letter));
  return (
    <div className="glass space-y-4 rounded-2xl border border-white/60 p-5 dark:border-white/10">
      <div className="flex items-center justify-between text-[10px]">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 font-bold uppercase tracking-widest text-white ${
              DIFF_BG[q.difficulty] ?? 'bg-slate-500'
            }`}
          >
            {q.difficulty}
          </span>
          <span className="font-mono font-bold text-slate-500">{q.topic}</span>
          {q.multiSelect ? (
            <span className="rounded bg-brand-500/10 px-1.5 py-0.5 font-bold text-brand-700 dark:text-brand-300">
              Multi-select
            </span>
          ) : null}
        </div>
        <button
          onClick={onToggleReview}
          className={`rounded px-2 py-0.5 font-bold ${
            markedForReview ? 'bg-yellow-400 text-black' : 'bg-slate-200 text-slate-500 dark:bg-white/10'
          }`}
        >
          🚩 {markedForReview ? 'Marcada' : 'Marcar'}
        </button>
      </div>

      <div>
        <p className="whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">{q.scenario}</p>
        <p className="mt-3 text-base font-bold">{q.question}</p>
      </div>

      <div className="space-y-2">
        {q.options.map((opt) => {
          const isChosen = chosen.includes(opt.letter);
          const isCorrect = correctLetters.has(opt.letter);
          const showColor = revealed;
          const state = !showColor
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
              onClick={() => !revealed && onChoose(opt.letter)}
              disabled={revealed}
              className={`w-full rounded-xl border-2 p-3 text-left text-sm transition ${state}`}
            >
              <div className="flex items-start gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 font-bold dark:bg-white/10">
                  {opt.letter}
                </span>
                <span className="flex-1 whitespace-pre-line">{opt.text}</span>
                {revealed ? (
                  <span className="shrink-0 text-lg">{isCorrect ? '✅' : isChosen ? '❌' : ''}</span>
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

      {revealed ? (
        <div className="space-y-3 rounded-xl bg-slate-50 p-3 text-sm dark:bg-white/5">
          {/* Difficulty rating manual — active recall + self-assessment */}
          <DifficultyRating questionId={q.id} />
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Explicación</div>
            <p className="mt-1 whitespace-pre-line leading-relaxed text-slate-700 dark:text-slate-200">
              {q.explanation}
            </p>
          </div>
          {q.realWorld ? (
            <div className="rounded-lg border-l-4 border-cyan-500 bg-cyan-500/5 p-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">
                🌍 Caso real
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-700 dark:text-slate-200">{q.realWorld}</p>
            </div>
          ) : null}
          {q.tags.length > 0 ? (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Conceptos</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {q.tags.map((k) => (
                  <span
                    key={k}
                    className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-bold text-brand-700 dark:text-brand-300"
                  >
                    {k}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {q.tech.length > 0 ? (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Stack / Tech</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {q.tech.map((s) => (
                  <span
                    key={s}
                    className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold text-cyan-700 dark:text-cyan-300"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {q.references.length > 0 ? (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Referencias</div>
              <ul className="mt-1 space-y-0.5">
                {q.references.map((r, i) => (
                  <li key={i} className="text-[11px] text-slate-500">
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noreferrer" className="underline">
                        {r.title} ↗
                      </a>
                    ) : (
                      r.title
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NavBar({
  idx,
  total,
  onPrev,
  onNext,
  onFinish,
  answers,
  questions,
  onJump,
  gradient,
}: {
  idx: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onFinish: () => void;
  answers: Record<string, AnswerState>;
  questions: TechQuestion[];
  onJump: (i: number) => void;
  gradient: string;
}) {
  return (
    <div className="glass rounded-2xl border border-white/60 p-3 dark:border-white/10">
      <div className="mb-2 flex flex-wrap gap-1">
        {questions.map((q, i) => {
          const state = answers[q.id];
          const cls = state?.markedForReview
            ? 'bg-yellow-400 text-black'
            : state
            ? 'bg-brand-500 text-white'
            : 'bg-slate-200 text-slate-500 dark:bg-white/10';
          const active = i === idx ? 'ring-2 ring-brand-600' : '';
          return (
            <button
              key={q.id}
              onClick={() => onJump(i)}
              className={`h-7 w-7 rounded text-[10px] font-mono font-bold ${cls} ${active}`}
              title={q.topic}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between">
        <button
          disabled={idx === 0}
          onClick={onPrev}
          className="rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-bold disabled:opacity-40 dark:bg-white/10"
        >
          ← Anterior
        </button>
        {idx < total - 1 ? (
          <button
            onClick={onNext}
            className={`inline-flex items-center gap-1 rounded-lg bg-gradient-to-r ${gradient} px-4 py-1.5 text-xs font-bold text-white`}
          >
            Siguiente <IconChevronRight size={12} />
          </button>
        ) : (
          <button
            onClick={onFinish}
            className="inline-flex items-center gap-1 rounded-lg bg-success-500 px-4 py-1.5 text-xs font-bold text-white"
          >
            <IconTrophy size={12} /> Terminar y ver resultado
          </button>
        )}
      </div>
    </div>
  );
}

function ReviewScreen({
  sim,
  activeQuestions,
  answers,
  onRestart,
  onReviewWrong,
  wasReviewMode,
  trackId,
}: {
  sim: TechSimulation;
  activeQuestions: TechQuestion[];
  answers: Record<string, AnswerState>;
  onRestart: () => void;
  onReviewWrong: (wrongIds: string[]) => void;
  wasReviewMode: boolean;
  trackId: string;
}) {
  const stats = useMemo(() => {
    let correct = 0;
    const wrongIds: string[] = [];
    const perArea: Record<string, { correct: number; total: number }> = {};
    for (const q of activeQuestions) {
      const chosen = new Set(answers[q.id]?.chosen ?? []);
      const correctLetters = new Set(q.options.filter((o) => o.correct).map((o) => o.letter));
      const isCorrect =
        chosen.size === correctLetters.size &&
        [...chosen].every((l) => correctLetters.has(l as 'A' | 'B' | 'C' | 'D' | 'E' | 'F'));
      if (isCorrect) correct++;
      else wrongIds.push(q.id);
      const d = perArea[q.areaId] ?? { correct: 0, total: 0 };
      d.total += 1;
      if (isCorrect) d.correct += 1;
      perArea[q.areaId] = d;
    }
    return { correct, total: activeQuestions.length, perArea, wrongIds };
  }, [activeQuestions, answers]);

  const pct = Math.round((stats.correct / stats.total) * 100);
  const passed = pct / 100 >= sim.passThreshold;

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className={`rounded-3xl bg-gradient-to-br p-8 text-center text-white shadow-pop ${
          passed ? 'from-success-500 to-cyan-500' : 'from-flame-500 to-danger-500'
        }`}
      >
        <div className="text-6xl">{passed ? '🏆' : '💪'}</div>
        <h2 className="mt-2 text-2xl font-black">{passed ? '¡Aprobado!' : 'Sigue practicando'}</h2>
        <p className="mt-4 text-6xl font-black tabular-nums">{pct}</p>
        <p className="mt-1 text-sm opacity-90">
          {stats.correct} de {stats.total} correctas · umbral {Math.round(sim.passThreshold * 100)}%
        </p>
      </motion.div>

      <section>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Rendimiento por área</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {Object.entries(stats.perArea).map(([d, v]) => {
            const p = Math.round((v.correct / v.total) * 100);
            return (
              <div key={d} className="glass rounded-xl border border-white/60 p-3 dark:border-white/10">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-bold">{d}</span>
                  <span className="font-mono">
                    {v.correct}/{v.total} · {p}%
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200/60 dark:bg-white/5">
                  <div
                    className={`h-full ${p >= 70 ? 'bg-success-500' : 'bg-danger-500'}`}
                    style={{ width: `${p}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Modo review de errores — botón destacado si hay wrongs */}
      {stats.wrongIds.length > 0 ? (
        <section className="rounded-2xl border-2 border-dashed border-flame-500/40 bg-flame-500/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-black">🎯 Repasa solo tus errores</h4>
              <p className="mt-0.5 text-xs text-slate-500">
                {stats.wrongIds.length} preguntas fallaste. Repasarlas ahora refuerza la memoria (active recall dirigido).
              </p>
            </div>
            <button
              onClick={() => onReviewWrong(stats.wrongIds)}
              className="shrink-0 rounded-xl bg-gradient-to-br from-flame-500 to-danger-500 px-4 py-2 text-xs font-bold text-white shadow-pop"
            >
              Revisar errores
            </button>
          </div>
        </section>
      ) : null}

      <section>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">
          Revisión pregunta por pregunta {wasReviewMode ? '(sesión de repaso)' : null}
        </h3>
        <div className="space-y-3">
          {activeQuestions.map((q, i) => {
            const chosen = new Set(answers[q.id]?.chosen ?? []);
            const correctLetters = new Set(q.options.filter((o) => o.correct).map((o) => o.letter));
            const isCorrect =
              chosen.size === correctLetters.size &&
              [...chosen].every((l) => correctLetters.has(l as 'A' | 'B' | 'C' | 'D' | 'E' | 'F'));
            return (
              <details
                key={q.id}
                className={`rounded-xl border-2 p-3 ${isCorrect ? 'border-success-500/40' : 'border-danger-500/40'}`}
              >
                <summary className="cursor-pointer text-sm font-bold">
                  {isCorrect ? '✅' : '❌'} P{i + 1}. {q.topic} — {q.question}
                </summary>
                <div className="mt-3 space-y-2 text-sm">
                  <p className="whitespace-pre-line text-slate-600 dark:text-slate-300">{q.scenario}</p>
                  <div className="space-y-1">
                    {q.options.map((opt) => (
                      <div
                        key={opt.letter}
                        className={`rounded-lg p-2 ${
                          opt.correct
                            ? 'bg-success-500/10'
                            : chosen.has(opt.letter)
                            ? 'bg-danger-500/10'
                            : 'bg-slate-100 dark:bg-white/5'
                        }`}
                      >
                        <div className="flex gap-2">
                          <strong>{opt.letter}.</strong>
                          <span className="flex-1">{opt.text}</span>
                          {opt.correct ? <span>✅</span> : chosen.has(opt.letter) ? <span>❌</span> : null}
                        </div>
                        {opt.why ? (
                          <p className="mt-1 pl-6 text-xs italic text-slate-500">{opt.why}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="rounded-lg bg-brand-500/10 p-2 text-xs">
                    <strong>💡 Explicación:</strong> {q.explanation}
                  </div>
                  {q.realWorld ? (
                    <div className="rounded-lg bg-cyan-500/10 p-2 text-xs">
                      <strong>🌍 Caso real:</strong> {q.realWorld}
                    </div>
                  ) : null}
                </div>
              </details>
            );
          })}
        </div>
      </section>

      <div className="flex gap-2">
        <button
          onClick={onRestart}
          className="rounded-xl bg-gradient-to-r from-brand-500 to-cyan-500 px-5 py-2.5 text-sm font-bold text-white shadow-pop"
        >
          Otra vez
        </button>
        <Link
          to={`/programming/${trackId}`}
          className="rounded-xl bg-slate-200 px-5 py-2.5 text-sm font-bold text-slate-700 dark:bg-white/10 dark:text-slate-200"
        >
          Volver a simulacros
        </Link>
      </div>
    </div>
  );
}
