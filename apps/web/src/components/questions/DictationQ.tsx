import { useEffect, useRef, useState } from 'react';
import type { DictationQuestion } from '@linguadev/shared';
import { normalizeForCompare, wordMatchStats } from '@linguadev/shared';
import type { QuestionComponentProps } from './types.js';
import { QuestionShell } from './QuestionShell.js';
import { hasTts, speak, stopSpeaking } from '../../lib/speech.js';
import { IconPlay } from '../Icons.js';

export function DictationQ({
  question,
  onResult,
  revealed,
}: QuestionComponentProps<DictationQuestion>) {
  const [input, setInput] = useState('');
  const [checked, setChecked] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ttsOn, setTtsOn] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setTtsOn(hasTts()), []);
  useEffect(() => () => stopSpeaking(), []);

  async function play() {
    setPlaying(true);
    try {
      await speak(question.audioText ?? question.text, { rate: question.playbackRate ?? 1 });
    } catch {
      setTtsOn(false);
    } finally {
      setPlaying(false);
    }
  }

  function check() {
    if (checked) return;
    setChecked(true);
    const stats = wordMatchStats(question.text, input);
    const score = stats.total ? stats.matched / stats.total : 0;
    onResult({
      correct: score >= 0.8,
      score01: score,
      userAnswer: input,
      meta: { missing: stats.missing },
    });
  }

  const stats = checked ? wordMatchStats(question.text, input) : null;

  return (
    <QuestionShell question={question} label="Dictado">
      <div className="text-center">
        <button
          onClick={() => void play()}
          disabled={playing || !ttsOn}
          className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-br from-cyan-500 to-brand-500 px-6 py-3 text-sm font-bold text-white shadow-pop disabled:opacity-50"
        >
          <IconPlay size={16} /> {playing ? 'Reproduciendo…' : 'Reproducir'}
        </button>
      </div>
      {!ttsOn ? (
        <p className="mt-2 text-center text-xs text-warn-600">
          Sin TTS: usa "Revelar" para leer el texto y practica escribiéndolo.
        </p>
      ) : null}
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !checked) check();
        }}
        disabled={checked || revealed}
        placeholder="Escribe lo que escuchaste…"
        autoCorrect="off"
        spellCheck={false}
        className="mt-3 w-full rounded-2xl border border-slate-200 bg-white/70 p-3 text-sm dark:border-white/10 dark:bg-slate-900"
      />
      {!checked && !revealed ? (
        <button
          onClick={check}
          disabled={input.trim().length < 2}
          className="mt-3 w-full rounded-2xl bg-brand-600 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          Comprobar
        </button>
      ) : null}
      {checked || revealed ? (
        <div className="mt-3 rounded-2xl border border-slate-200 p-3 text-sm dark:border-white/10">
          <div className="flex justify-between">
            <span className="text-xs text-slate-500">Correcto</span>
            {stats ? (
              <span className="text-xs font-bold">
                {stats.matched}/{stats.total} palabras
              </span>
            ) : null}
          </div>
          <p className="mt-1">{renderDiff(question.text, input, checked || revealed)}</p>
        </div>
      ) : null}
    </QuestionShell>
  );
}

function renderDiff(target: string, actual: string, show: boolean) {
  const words = target.split(/(\s+)/);
  if (!show) return target;
  const norm = new Set(normalizeForCompare(actual).split(' ').filter(Boolean));
  return words.map((w, i) => {
    if (/^\s+$/.test(w)) return <span key={i}>{w}</span>;
    const n = normalizeForCompare(w);
    const hit = n && norm.has(n);
    return (
      <span key={i} className={hit ? 'text-success-600' : 'text-slate-400 line-through'}>
        {w}
      </span>
    );
  });
}
