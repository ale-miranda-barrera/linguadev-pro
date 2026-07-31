import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Question } from '@linguadev/shared';
import { MultipleChoiceQ } from './MultipleChoiceQ.js';
import { TrueFalseQ } from './TrueFalseQ.js';
import { DictationQ } from './DictationQ.js';
import { MatchQ } from './MatchQ.js';
import { SpeakingQ } from './SpeakingQ.js';
import type { QuestionResult } from './types.js';
import { IconChevronRight, IconTarget, IconTrophy } from '../Icons.js';

interface Props {
  questions: Question[];
  onFinish?: (results: QuestionResult[]) => void;
  title?: string;
}

export function QuestionRunner({ questions, onFinish, title }: Props) {
  const [idx, setIdx] = useState(0);
  const [results, setResults] = useState<QuestionResult[]>([]);
  const [pending, setPending] = useState<QuestionResult | null>(null);

  if (questions.length === 0) {
    return (
      <p className="text-center text-sm text-slate-500">
        No hay preguntas en esta sesión.
      </p>
    );
  }

  if (idx >= questions.length) {
    const correct = results.filter((r) => r.correct).length;
    const scoreSum = results.reduce((s, r) => s + r.score01, 0);
    const scorePct = Math.round((scoreSum / results.length) * 100);
    return (
      <FinalScreen
        correct={correct}
        total={results.length}
        scorePct={scorePct}
        onRestart={() => {
          setIdx(0);
          setResults([]);
          setPending(null);
          onFinish?.(results);
        }}
      />
    );
  }

  const current = questions[idx];
  if (!current) return null;

  function handleResult(r: QuestionResult) {
    setPending(r);
  }

  function next() {
    if (!pending) return;
    setResults((rs) => [...rs, pending]);
    setIdx((i) => i + 1);
    setPending(null);
  }

  return (
    <div className="space-y-4">
      <ProgressBar current={idx + 1} total={questions.length} label={title ?? 'sesión'} />
      <AnimatePresence mode="wait">
        <motion.div
          key={current.id}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -30 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        >
          <RenderQuestion question={current} onResult={handleResult} revealed={!!pending} />
        </motion.div>
      </AnimatePresence>

      {pending ? (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className={`space-y-3 rounded-2xl border p-4 ${
            pending.correct
              ? 'border-success-500/30 bg-success-500/10'
              : 'border-danger-500/30 bg-danger-500/10'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold">
              {pending.correct ? '¡Bien hecho! 🎉' : 'Casi — no te preocupes'}
            </span>
            <button
              onClick={next}
              className="inline-flex items-center gap-1 rounded-xl bg-gradient-to-r from-brand-500 to-pink-500 px-4 py-2 text-sm font-bold text-white shadow-pop"
            >
              {idx === questions.length - 1 ? 'Ver resultado' : 'Siguiente'}
              <IconChevronRight size={14} />
            </button>
          </div>
          {/* Feedback pedagógico: solo si el usuario se equivocó y la pregunta tiene explicación/ejemplos. */}
          {!pending.correct && (current.explanation || (current.examples && current.examples.length > 0)) ? (
            <div className="space-y-2 rounded-xl bg-white/60 p-3 text-sm dark:bg-black/20">
              {current.explanation ? (
                <p className="leading-relaxed text-slate-700 dark:text-slate-200">
                  <span className="mr-1 font-bold">💡 Explicación:</span>
                  {current.explanation}
                </p>
              ) : null}
              {current.examples && current.examples.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">
                    Ejemplos
                  </p>
                  <ul className="space-y-1">
                    {current.examples.map((ex, i) => (
                      <li key={i} className="rounded-lg bg-slate-100/70 px-2.5 py-1.5 font-mono text-[13px] text-slate-700 dark:bg-white/5 dark:text-slate-200">
                        {ex}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </motion.div>
      ) : null}
    </div>
  );
}

function RenderQuestion({
  question,
  onResult,
  revealed,
}: {
  question: Question;
  onResult: (r: QuestionResult) => void;
  revealed: boolean;
}) {
  switch (question.type) {
    case 'multiple-choice':
      return <MultipleChoiceQ question={question} onResult={onResult} revealed={revealed} />;
    case 'true-false':
      return <TrueFalseQ question={question} onResult={onResult} revealed={revealed} />;
    case 'dictation':
      return <DictationQ question={question} onResult={onResult} revealed={revealed} />;
    case 'match':
      return <MatchQ question={question} onResult={onResult} revealed={revealed} />;
    case 'speaking':
      return <SpeakingQ question={question} onResult={onResult} revealed={revealed} />;
  }
}

function ProgressBar({ current, total, label }: { current: number; total: number; label: string }) {
  const pct = Math.round((current / total) * 100);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-500">
          {current} / {total} · {label}
        </span>
        <span className="font-mono text-slate-400">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200/60 dark:bg-white/5">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-brand-500 to-pink-500"
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  );
}

function FinalScreen({
  correct,
  total,
  scorePct,
  onRestart,
}: {
  correct: number;
  total: number;
  scorePct: number;
  onRestart: () => void;
}) {
  const tier =
    scorePct >= 90 ? { title: '¡Perfecto!', emoji: '🏆', grad: 'from-success-500 to-cyan-500' } :
    scorePct >= 70 ? { title: '¡Muy bien!', emoji: '⭐', grad: 'from-brand-500 to-cyan-500' } :
    scorePct >= 50 ? { title: 'Buen intento', emoji: '💪', grad: 'from-flame-500 to-brand-500' } :
    { title: 'A seguir practicando', emoji: '🌱', grad: 'from-danger-500 to-flame-500' };
  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 18 }}
      className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${tier.grad} p-8 text-center text-white shadow-pop`}
    >
      {Array.from({ length: 24 }).map((_, i) => (
        <motion.span
          key={i}
          className="absolute h-2 w-2 rounded-sm bg-white/70"
          initial={{ x: '50%', y: '30%', opacity: 1, scale: 0 }}
          animate={{
            x: `${20 + Math.random() * 60}%`,
            y: `${20 + Math.random() * 60}%`,
            rotate: Math.random() * 360,
            opacity: 0,
            scale: 1,
          }}
          transition={{ duration: 1 + Math.random(), delay: Math.random() * 0.2 }}
        />
      ))}
      <div className="relative">
        <div className="text-6xl">{tier.emoji}</div>
        <h2 className="mt-2 text-2xl font-black">{tier.title}</h2>
        <p className="mt-4 text-6xl font-black tabular-nums">{scorePct}</p>
        <p className="mt-1 text-sm font-semibold opacity-90">
          {correct} de {total} correctas
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            onClick={onRestart}
            className="inline-flex items-center gap-1 rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-brand-700 shadow-pop"
          >
            <IconTarget size={14} /> Otra vez
          </button>
          <a
            href="/"
            className="inline-flex items-center gap-1 rounded-xl bg-white/20 px-5 py-2.5 text-sm font-bold text-white ring-1 ring-white/25 backdrop-blur"
          >
            <IconTrophy size={14} /> Ir al inicio
          </a>
        </div>
      </div>
    </motion.div>
  );
}
