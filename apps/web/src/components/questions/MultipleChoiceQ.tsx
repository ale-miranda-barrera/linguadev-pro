import { useState } from 'react';
import { motion } from 'framer-motion';
import type { MultipleChoiceQuestion } from '@linguadev/shared';
import type { QuestionComponentProps } from './types.js';
import { QuestionShell } from './QuestionShell.js';
import { IconCheck } from '../Icons.js';

export function MultipleChoiceQ({
  question,
  onResult,
  revealed,
}: QuestionComponentProps<MultipleChoiceQuestion>) {
  const [picked, setPicked] = useState<number | null>(null);

  function pick(i: number) {
    if (picked !== null || revealed) return;
    setPicked(i);
    const correct = i === question.correctIndex;
    onResult({
      correct,
      score01: correct ? 1 : 0,
      userAnswer: question.options[i] ?? '',
    });
  }

  return (
    <QuestionShell question={question} label="Opción múltiple">
      <p className="text-lg font-bold leading-snug">{question.question}</p>
      <ul className="mt-4 grid gap-2">
        {question.options.map((opt, i) => {
          const isCorrect = i === question.correctIndex;
          const isPicked = picked === i;
          const show = picked !== null || revealed;
          return (
            <motion.button
              key={i}
              whileTap={{ scale: 0.98 }}
              disabled={show}
              onClick={() => pick(i)}
              className={`flex items-center justify-between rounded-2xl border p-4 text-left text-sm font-semibold transition ${
                show && isCorrect
                  ? 'border-success-500 bg-success-500/15 text-success-700 dark:text-success-400'
                  : show && isPicked
                    ? 'border-danger-500 bg-danger-500/10 text-danger-700 dark:text-danger-400'
                    : show
                      ? 'border-slate-200 bg-white/50 text-slate-400 dark:border-white/5 dark:bg-white/5'
                      : 'border-slate-200 bg-white/80 hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-glow dark:border-white/5 dark:bg-white/5'
              }`}
            >
              <span className="flex items-center gap-3">
                <span
                  className={`grid h-8 w-8 place-items-center rounded-lg font-black ${
                    show && isCorrect
                      ? 'bg-success-500 text-white'
                      : show && isPicked
                        ? 'bg-danger-500 text-white'
                        : 'bg-slate-100 text-slate-500 dark:bg-white/5'
                  }`}
                >
                  {String.fromCharCode(65 + i)}
                </span>
                <span>{opt}</span>
              </span>
              {show && isCorrect ? <IconCheck size={18} /> : null}
            </motion.button>
          );
        })}
      </ul>
      {revealed && question.explanation ? (
        <p className="mt-3 rounded-xl bg-slate-100 p-3 text-xs text-slate-600 dark:bg-white/5 dark:text-slate-300">
          💡 {question.explanation}
        </p>
      ) : null}
    </QuestionShell>
  );
}
