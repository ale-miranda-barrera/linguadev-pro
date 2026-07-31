import { useState } from 'react';
import { motion } from 'framer-motion';
import type { TrueFalseQuestion } from '@linguadev/shared';
import type { QuestionComponentProps } from './types.js';
import { QuestionShell } from './QuestionShell.js';

export function TrueFalseQ({
  question,
  onResult,
  revealed,
}: QuestionComponentProps<TrueFalseQuestion>) {
  const [picked, setPicked] = useState<boolean | null>(null);

  function pick(v: boolean) {
    if (picked !== null || revealed) return;
    setPicked(v);
    const correct = v === question.correct;
    onResult({ correct, score01: correct ? 1 : 0, userAnswer: String(v) });
  }

  const show = picked !== null || revealed;

  return (
    <QuestionShell question={question} label="¿Bien o mal?">
      <p className="text-lg font-medium leading-snug">"{question.statement}"</p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <motion.button
          whileTap={{ scale: 0.96 }}
          disabled={show}
          onClick={() => pick(true)}
          className={`rounded-2xl p-6 text-center text-2xl font-black transition ${
            show && question.correct
              ? 'bg-gradient-to-br from-success-500 to-cyan-500 text-white shadow-pop'
              : show && picked === true
                ? 'bg-danger-500/15 text-danger-600 line-through'
                : 'bg-white/80 hover:-translate-y-0.5 hover:shadow-glow dark:bg-white/5'
          }`}
        >
          ✓ Good
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.96 }}
          disabled={show}
          onClick={() => pick(false)}
          className={`rounded-2xl p-6 text-center text-2xl font-black transition ${
            show && !question.correct
              ? 'bg-gradient-to-br from-success-500 to-cyan-500 text-white shadow-pop'
              : show && picked === false
                ? 'bg-danger-500/15 text-danger-600 line-through'
                : 'bg-white/80 hover:-translate-y-0.5 hover:shadow-glow dark:bg-white/5'
          }`}
        >
          ✗ Bad
        </motion.button>
      </div>
      {revealed && question.explanation ? (
        <p className="mt-3 rounded-xl bg-slate-100 p-3 text-xs text-slate-600 dark:bg-white/5 dark:text-slate-300">
          💡 {question.explanation}
        </p>
      ) : null}
    </QuestionShell>
  );
}
