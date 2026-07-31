import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePacksStore } from '../../stores/packs.js';
import { useProfileStore } from '../../stores/profile.js';
import { EmptyState, LoadingState } from '../../components/UiStates.js';
import { hasTts, speak, stopSpeaking } from '../../lib/speech.js';
import { normalizeForCompare, wordMatchStats } from '@linguadev/shared';

interface DictationItem {
  id: string;
  text: string;
  packTitle: string;
}

export function Listening() {
  const packs = usePacksStore((s) => s.packs);
  const loaded = usePacksStore((s) => s.loaded);
  const markStudiedToday = useProfileStore((s) => s.markStudiedToday);
  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState('');
  const [checked, setChecked] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [ttsAvailable, setTtsAvailable] = useState<boolean | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playCount, setPlayCount] = useState(0);
  const [rate, setRate] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<DictationItem[]>(() => {
    const out: DictationItem[] = [];
    for (const p of packs) {
      if (!p.enabled) continue;
      for (const l of p.listening) {
        if (l.kind !== 'dictation') continue;
        out.push({ id: l.id, text: l.text, packTitle: p.title });
      }
    }
    return out;
  }, [packs]);

  useEffect(() => setTtsAvailable(hasTts()), []);
  useEffect(() => () => stopSpeaking(), []);

  if (!loaded || ttsAvailable === null) return <LoadingState />;
  if (items.length === 0) {
    return <EmptyState title="No hay dictados en tus packs habilitados" hint="Activa más packs desde Ajustes." />;
  }

  const current = items[idx % items.length];
  if (!current) return null;
  const stats = checked ? wordMatchStats(current.text, input) : null;
  const score = stats && stats.total > 0 ? Math.round((stats.matched / stats.total) * 100) : 0;

  async function play() {
    if (!current) return;
    setPlaying(true);
    try {
      await speak(current.text, { rate });
      setPlayCount((n) => n + 1);
    } catch {
      setTtsAvailable(false);
    } finally {
      setPlaying(false);
    }
  }

  function check() {
    setChecked(true);
    void markStudiedToday();
  }

  function next() {
    setIdx((i) => i + 1);
    setInput('');
    setChecked(false);
    setRevealed(false);
    setPlayCount(0);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <header>
        <h1 className="text-2xl font-bold">Escucha & escribe</h1>
        <p className="text-xs text-slate-500">
          {current.packTitle} · {idx + 1} / {items.length}
        </p>
      </header>

      {!ttsAvailable ? (
        <div className="rounded-xl border border-warn-500/30 bg-warn-500/5 p-3 text-sm">
          Tu navegador no tiene síntesis de voz. Puedes revelar el texto y transcribirlo para practicar.
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="text-5xl">🔊</div>
        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            onClick={() => void play()}
            disabled={playing || !ttsAvailable}
            className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {playing ? 'Reproduciendo…' : playCount === 0 ? 'Reproducir' : `Repetir (${playCount})`}
          </button>
        </div>
        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-slate-500">
          <span>Velocidad</span>
          <input
            type="range"
            min={0.6}
            max={1.2}
            step={0.1}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
          <span>{rate.toFixed(1)}x</span>
        </div>
      </div>

      <label className="block">
        <span className="text-sm font-medium">Escribe lo que escuchaste</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !checked) check();
            else if (e.key === 'Enter' && checked) next();
          }}
          className="mt-1 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-900"
          placeholder="Type here…"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={checked}
        />
      </label>

      {!checked ? (
        <div className="flex gap-2">
          <button
            onClick={check}
            disabled={input.trim().length < 2}
            className="flex-1 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            Comprobar
          </button>
          <button
            onClick={() => setRevealed((v) => !v)}
            className="rounded-xl border border-slate-300 px-3 text-sm dark:border-slate-700"
          >
            {revealed ? 'Ocultar' : 'Rendirse'}
          </button>
        </div>
      ) : (
        <button
          onClick={next}
          className="w-full rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white"
        >
          Siguiente
        </button>
      )}

      <AnimatePresence>
        {(revealed || checked) && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800"
          >
            {checked && stats ? (
              <div className="mb-3 flex items-baseline justify-between">
                <span className="text-xs uppercase tracking-wider text-slate-500">Score</span>
                <span
                  className={`text-3xl font-bold ${
                    score >= 80 ? 'text-success-600' : score >= 50 ? 'text-warn-500' : 'text-danger-500'
                  }`}
                >
                  {score}
                </span>
              </div>
            ) : null}
            <div>
              <span className="text-xs uppercase tracking-wider text-slate-500">Correcto</span>
              <p className="mt-1 text-sm">{renderDiff(current.text, input, checked)}</p>
            </div>
            {stats && stats.missing.length > 0 ? (
              <p className="mt-2 text-xs text-slate-500">
                Faltaron: <span className="font-mono">{stats.missing.join(', ')}</span>
              </p>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Resalta en verde palabras del target que aparecen en la respuesta del usuario y tacha las que no.
function renderDiff(target: string, actual: string, showColors: boolean) {
  const targetWords = target.split(/(\s+)/);
  if (!showColors) return <span>{target}</span>;
  const actualNorm = new Set(normalizeForCompare(actual).split(' ').filter(Boolean));
  return (
    <span>
      {targetWords.map((w, i) => {
        if (/^\s+$/.test(w)) return <span key={i}>{w}</span>;
        const norm = normalizeForCompare(w);
        const hit = norm && actualNorm.has(norm);
        return (
          <span key={i} className={hit ? 'text-success-600' : 'text-slate-400 line-through'}>
            {w}
          </span>
        );
      })}
    </span>
  );
}
