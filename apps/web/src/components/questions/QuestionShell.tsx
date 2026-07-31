import type { PropsWithChildren } from 'react';
import type { Question } from '@linguadev/shared';

// Wrapper visual común: banner con el tipo, imagen opcional, y contenido específico.
export function QuestionShell({
  question,
  label,
  children,
}: PropsWithChildren<{ question: Question; label: string }>) {
  return (
    <div className="glass rounded-3xl border border-white/60 p-5 shadow-glow dark:border-white/5">
      <div className="mb-3 flex items-center justify-between">
        <span className="inline-flex items-center rounded-full bg-gradient-to-r from-brand-500 to-pink-500 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
          {label}
        </span>
        {question.hint ? (
          <span className="text-[11px] italic text-slate-500">💡 {question.hint}</span>
        ) : null}
      </div>
      {question.image ? (
        <div className="mb-3 overflow-hidden rounded-2xl">
          <img
            src={question.image}
            alt=""
            className="mx-auto max-h-56 w-full object-cover"
            loading="lazy"
          />
        </div>
      ) : null}
      {question.prompt ? (
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          {question.prompt}
        </p>
      ) : null}
      {children}
    </div>
  );
}
