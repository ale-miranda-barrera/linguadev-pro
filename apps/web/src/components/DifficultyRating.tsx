import { useState, useEffect } from 'react';
import type { Rating } from '../lib/questionRating.js';
import { getRating, setRating } from '../lib/questionRating.js';

// Widget de rating post-respuesta: Otra vez / Difícil / Bien / Fácil
// Persiste en localStorage por questionId (via lib/questionRating).

const RATINGS: Array<{ value: Rating; label: string; emoji: string; bg: string; textDark: string; hint: string }> = [
  {
    value: 'again',
    label: 'Otra vez',
    emoji: '🔴',
    bg: 'from-danger-500 to-danger-600',
    textDark: 'text-danger-300',
    hint: 'No la sabía. Vuelvo a repasar.',
  },
  {
    value: 'hard',
    label: 'Difícil',
    emoji: '🟠',
    bg: 'from-flame-500 to-flame-600',
    textDark: 'text-flame-300',
    hint: 'La adiviné o me costó.',
  },
  {
    value: 'good',
    label: 'Bien',
    emoji: '🟢',
    bg: 'from-brand-500 to-cyan-500',
    textDark: 'text-brand-300',
    hint: 'La supe con esfuerzo razonable.',
  },
  {
    value: 'easy',
    label: 'Fácil',
    emoji: '⭐',
    bg: 'from-success-500 to-cyan-500',
    textDark: 'text-success-300',
    hint: 'La sabía sin dudar.',
  },
];

interface Props {
  questionId: string;
}

export function DifficultyRating({ questionId }: Props) {
  const [current, setCurrent] = useState<Rating | null>(null);

  useEffect(() => {
    const existing = getRating(questionId);
    setCurrent(existing?.rating ?? null);
  }, [questionId]);

  function handleRate(r: Rating) {
    setRating(questionId, r);
    setCurrent(r);
  }

  return (
    <div className="rounded-xl border border-brand-500/20 bg-brand-500/5 p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-brand-700 dark:text-brand-300">
        📊 ¿Cómo te fue con esta pregunta?
      </div>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Ayuda al sistema a priorizar tu repaso (localmente en tu navegador)
      </p>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {RATINGS.map((r) => {
          const active = current === r.value;
          return (
            <button
              key={r.value}
              onClick={() => handleRate(r.value)}
              title={r.hint}
              className={`flex flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[10px] font-bold transition ${
                active
                  ? `bg-gradient-to-br ${r.bg} text-white shadow-pop`
                  : 'bg-white text-slate-600 hover:-translate-y-0.5 hover:shadow-soft dark:bg-white/10 dark:text-slate-300'
              }`}
            >
              <span className="text-base leading-none">{r.emoji}</span>
              <span>{r.label}</span>
            </button>
          );
        })}
      </div>
      {current ? (
        <p className="mt-2 text-center text-[10px] text-slate-500">
          ✓ Marcada como <strong>{RATINGS.find((r) => r.value === current)?.label}</strong>
        </p>
      ) : null}
    </div>
  );
}
