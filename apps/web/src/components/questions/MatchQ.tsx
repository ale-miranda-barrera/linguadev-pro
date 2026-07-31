import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import type { MatchQuestion } from '@linguadev/shared';
import type { QuestionComponentProps } from './types.js';
import { QuestionShell } from './QuestionShell.js';

// Emparejar: usuario toca uno de la izquierda y uno de la derecha; si coinciden, se marcan verdes.
export function MatchQ({ question, onResult, revealed }: QuestionComponentProps<MatchQuestion>) {
  const shuffledRight = useMemo(() => {
    return [...question.pairs].map((p) => p.right).sort(() => Math.random() - 0.5);
  }, [question]);

  const [leftSel, setLeftSel] = useState<number | null>(null);
  const [rightSel, setRightSel] = useState<number | null>(null);
  // matched[i] es el índice del `right` que ya emparejó con `pairs[i]`. undefined = pendiente.
  const [matched, setMatched] = useState<Record<number, number>>({});
  const [wrongFlash, setWrongFlash] = useState<{ l: number; r: number } | null>(null);
  const [reported, setReported] = useState(false);
  const [wrongCount, setWrongCount] = useState(0);

  function tryMatch(l: number, r: number) {
    const isPair = question.pairs[l]?.right === shuffledRight[r];
    if (isPair) {
      setMatched((m) => ({ ...m, [l]: r }));
    } else {
      setWrongFlash({ l, r });
      setWrongCount((n) => n + 1);
      setTimeout(() => setWrongFlash(null), 400);
    }
    setLeftSel(null);
    setRightSel(null);
  }

  useEffect(() => {
    const done = Object.keys(matched).length === question.pairs.length;
    if (done && !reported) {
      setReported(true);
      const total = question.pairs.length;
      const penalized = Math.max(0, total - wrongCount);
      const score = total ? penalized / total : 0;
      onResult({ correct: wrongCount === 0, score01: score, userAnswer: 'match-completed' });
    }
  }, [matched, reported, wrongCount, question.pairs.length, onResult]);

  function isLeftMatched(i: number) {
    return matched[i] !== undefined;
  }

  function rightMatchedTo(rIdx: number): number | undefined {
    for (const [k, v] of Object.entries(matched)) {
      if (Number(v) === rIdx) return Number(k);
    }
    return undefined;
  }

  return (
    <QuestionShell question={question} label="Empareja">
      <p className="mb-3 text-sm text-slate-500">Toca un término y luego su traducción.</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          {question.pairs.map((p, i) => {
            const done = isLeftMatched(i);
            const active = leftSel === i;
            const wrong = wrongFlash?.l === i;
            return (
              <motion.button
                key={i}
                animate={wrong ? { x: [0, -6, 6, -3, 3, 0] } : {}}
                transition={{ duration: 0.3 }}
                disabled={done || revealed}
                onClick={() => {
                  if (rightSel !== null) tryMatch(i, rightSel);
                  else setLeftSel(active ? null : i);
                }}
                className={`w-full rounded-xl p-3 text-sm font-semibold transition ${
                  done
                    ? 'bg-success-500/15 text-success-700 line-through dark:text-success-400'
                    : active
                      ? 'bg-brand-500 text-white shadow-pop'
                      : 'bg-white/80 hover:bg-brand-500/10 dark:bg-white/5'
                }`}
              >
                {p.left}
              </motion.button>
            );
          })}
        </div>
        <div className="space-y-2">
          {shuffledRight.map((r, i) => {
            const matchedFrom = rightMatchedTo(i);
            const done = matchedFrom !== undefined;
            const active = rightSel === i;
            const wrong = wrongFlash?.r === i;
            return (
              <motion.button
                key={i}
                animate={wrong ? { x: [0, -6, 6, -3, 3, 0] } : {}}
                transition={{ duration: 0.3 }}
                disabled={done || revealed}
                onClick={() => {
                  if (leftSel !== null) tryMatch(leftSel, i);
                  else setRightSel(active ? null : i);
                }}
                className={`w-full rounded-xl p-3 text-sm font-semibold transition ${
                  done
                    ? 'bg-success-500/15 text-success-700 dark:text-success-400'
                    : active
                      ? 'bg-pink-500 text-white shadow-pop'
                      : 'bg-white/80 hover:bg-pink-500/10 dark:bg-white/5'
                }`}
              >
                {r}
              </motion.button>
            );
          })}
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-slate-500">
        Emparejados: {Object.keys(matched).length}/{question.pairs.length}
        {wrongCount > 0 ? ` · fallos: ${wrongCount}` : ''}
      </p>
    </QuestionShell>
  );
}
