import { useState, useRef } from 'react';
import { hasTts, speak, ttsStatus } from '../lib/speech.js';
import { IconPlay } from './Icons.js';

// Botón reutilizable de pronunciación con:
// - user gesture directo (sin awaits antes de speak()) para iOS Safari
// - feedback visual mientras habla (animación)
// - retry automático si las voces aún no cargaron
// - toast de error breve si falla el TTS

interface Props {
  text: string;
  lang?: string;
  rate?: number;
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function SpeakButton({
  text,
  lang = 'en-US',
  rate = 1,
  label = 'Escuchar',
  size = 'sm',
  className = '',
}: Props) {
  const [state, setState] = useState<'idle' | 'speaking' | 'error'>('idle');
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const retryRef = useRef(false);

  const iconSize = size === 'sm' ? 10 : 14;
  const padY = size === 'sm' ? 'py-1' : 'py-1.5';
  const padX = size === 'sm' ? 'px-3' : 'px-3.5';
  const fontSize = size === 'sm' ? 'text-[11px]' : 'text-xs';

  function trigger() {
    if (!hasTts()) {
      setState('error');
      setErrorHint('Tu navegador no soporta síntesis de voz.');
      setTimeout(() => setState('idle'), 2500);
      return;
    }
    // Llamamos speak() SÍNCRONO desde el click handler (crítico en iOS).
    setState('speaking');
    setErrorHint(null);
    try {
      const p = speak(text, { lang, rate });
      p.then(
        () => setState('idle'),
        (err: Error) => {
          const status = ttsStatus();
          // Si aún no cargaron voces, reintentar UNA vez tras 400ms.
          if (status.voicesLoaded === 0 && !retryRef.current) {
            retryRef.current = true;
            setTimeout(() => {
              retryRef.current = false;
              try {
                const p2 = speak(text, { lang, rate });
                p2.then(
                  () => setState('idle'),
                  () => {
                    setState('error');
                    setErrorHint(status.hint ?? 'No se pudo reproducir. Intenta de nuevo.');
                    setTimeout(() => setState('idle'), 2500);
                  },
                );
              } catch {
                setState('error');
              }
            }, 400);
            return;
          }
          setState('error');
          setErrorHint(status.hint ?? `No se pudo reproducir (${err.message}).`);
          setTimeout(() => setState('idle'), 2500);
        },
      );
    } catch (err) {
      setState('error');
      setErrorHint(`Fallo al iniciar: ${(err as Error).message}`);
      setTimeout(() => setState('idle'), 2500);
    }
  }

  return (
    <div className="relative inline-flex flex-col items-center">
      <button
        onClick={(e) => {
          e.stopPropagation();
          trigger();
        }}
        aria-label={`Pronunciar ${text}`}
        className={`inline-flex items-center gap-1 rounded-full border border-slate-300/70 bg-white/70 ${padX} ${padY} ${fontSize} font-semibold transition dark:border-white/10 dark:bg-white/5 ${
          state === 'speaking'
            ? 'border-brand-500 bg-brand-500/10 text-brand-700 dark:text-brand-300'
            : state === 'error'
            ? 'border-danger-500 bg-danger-500/10 text-danger-700 dark:text-danger-300'
            : 'text-slate-600 dark:text-slate-300'
        } ${className}`}
      >
        {state === 'speaking' ? (
          <span className="inline-flex gap-0.5">
            <span className="h-2.5 w-0.5 animate-pulse rounded bg-current" />
            <span className="h-3 w-0.5 animate-pulse rounded bg-current [animation-delay:100ms]" />
            <span className="h-2 w-0.5 animate-pulse rounded bg-current [animation-delay:200ms]" />
          </span>
        ) : (
          <IconPlay size={iconSize} />
        )}
        {state === 'speaking' ? 'Hablando…' : state === 'error' ? 'Reintenta' : label}
      </button>
      {state === 'error' && errorHint ? (
        <div className="pointer-events-none absolute top-full z-30 mt-1 whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-[10px] font-semibold text-white shadow-pop">
          {errorHint}
        </div>
      ) : null}
    </div>
  );
}
