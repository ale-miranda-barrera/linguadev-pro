import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { apiJson } from '../../lib/api.js';
import type { WritingCorrectResponse } from '@linguadev/shared';
import { useProfileStore } from '../../stores/profile.js';
import { usePacksStore } from '../../stores/packs.js';
import { safeAsync } from '../../lib/safeAsync.js';
import { evaluateWriting, type LocalWritingResult } from '../../lib/writingHeuristic.js';
import { db } from '../../db/dexie.js';

interface Prompt {
  id: string;
  prompt: string;
  minWords: number;
  hints: string[];
  packTitle: string;
}

export function Writing() {
  const level = useProfileStore((s) => s.profile.level);
  const markStudiedToday = useProfileStore((s) => s.markStudiedToday);
  const packs = usePacksStore((s) => s.packs);
  const loaded = usePacksStore((s) => s.loaded);
  const [promptIdx, setPromptIdx] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiResult, setAiResult] = useState<WritingCorrectResponse | null>(null);
  const [local, setLocal] = useState<LocalWritingResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const prompts = useMemo<Prompt[]>(() => {
    const out: Prompt[] = [];
    for (const p of packs) {
      if (!p.enabled) continue;
      for (const w of p.writing) {
        out.push({
          id: w.id,
          prompt: w.prompt,
          minWords: w.minWords,
          hints: w.hints,
          packTitle: p.title,
        });
      }
    }
    return out;
  }, [packs]);

  const current = prompts[promptIdx % Math.max(prompts.length, 1)];

  // Autosave del borrador por prompt.
  useEffect(() => {
    if (!current) return;
    const key = `ld:draft:${current.id}`;
    try {
      const saved = localStorage.getItem(key);
      setText(saved ?? '');
    } catch {
      setText('');
    }
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!current) return;
    const key = `ld:draft:${current.id}`;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(key, text);
      } catch {
        // QuotaExceeded: no bloqueamos la UX, el usuario puede exportar backup.
      }
    }, 300);
    return () => clearTimeout(t);
  }, [text, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!current) return;
    setBusy(true);
    setAiError(null);
    setAiResult(null);
    setLocal(null);
    void markStudiedToday();

    // Siempre corre feedback local: rápido, útil, sin red.
    const localFeedback = evaluateWriting(text, current.minWords);
    setLocal(localFeedback);

    let aiCorrection: string | undefined;
    // Si estamos online, intenta la IA. Si falla, dejamos el local como respaldo.
    if (online) {
      const r = await safeAsync(() =>
        apiJson<WritingCorrectResponse>('/api/ai/writing/correct', {
          method: 'POST',
          body: JSON.stringify({ text, level }),
        }),
      );
      if (r.ok) {
        setAiResult(r.value);
        aiCorrection = r.value.corrected;
      } else {
        setAiError(r.error.message);
      }
    }

    // Registra el intento en Dexie para el "centro de errores" (fase futura).
    // Usamos aiCorrection local (no el state) porque setAiResult todavía no se ha aplicado.
    try {
      const entry = {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        skill: 'writing' as const,
        prompt: current.prompt,
        userAnswer: text,
        ...(aiCorrection ? { correction: aiCorrection } : {}),
      };
      await db.errors.put(entry);
    } catch {
      // Sin espacio: silencioso; el ejercicio no depende de esto.
    }

    setBusy(false);
  }

  function nextPrompt() {
    setPromptIdx((i) => i + 1);
    setAiResult(null);
    setLocal(null);
    setAiError(null);
  }

  if (!loaded) return null;
  if (prompts.length === 0 || !current) {
    return <p className="text-sm text-slate-500">No hay prompts en tus packs habilitados.</p>;
  }

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header>
        <h1 className="text-2xl font-bold">Escribir</h1>
        <p className="text-xs text-slate-500">
          {current.packTitle} · Nivel {level}
        </p>
      </header>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <p className="text-xs uppercase tracking-wider text-slate-500">Prompt</p>
        <p className="mt-1 font-medium">{current.prompt}</p>
        {current.hints.length ? (
          <p className="mt-2 text-xs text-slate-500">Sugerencias: {current.hints.join(' · ')}</p>
        ) : null}
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        className="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-900"
        placeholder="Escribe aquí…"
      />
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {wordCount} palabras / objetivo ~{current.minWords} · borrador guardado
        </span>
        {!online ? <span className="text-warn-600">Offline: solo feedback local</span> : null}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => void submit()}
          disabled={busy || text.trim().length < 5}
          className="flex-1 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Analizando…' : online ? 'Analizar (IA + local)' : 'Analizar (local)'}
        </button>
        <button
          onClick={nextPrompt}
          className="rounded-xl border border-slate-300 px-4 text-sm dark:border-slate-700"
        >
          Otro prompt
        </button>
      </div>

      {local ? (
        <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-xs uppercase tracking-wider text-slate-500">Feedback local</span>
            <span
              className={`text-3xl font-bold ${
                local.score >= 80 ? 'text-success-600' : local.score >= 50 ? 'text-warn-500' : 'text-danger-500'
              }`}
            >
              {local.score}
            </span>
          </div>
          {local.issues.length === 0 ? (
            <p className="text-sm text-success-600">Sin issues detectados por la heurística local ✓</p>
          ) : (
            <ul className="space-y-1.5">
              {local.issues.map((i, k) => (
                <li key={k} className="text-sm">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      i.kind === 'grammar'
                        ? 'bg-danger-500/15 text-danger-600'
                        : i.kind === 'spelling'
                          ? 'bg-warn-500/15 text-warn-600'
                          : 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                    }`}
                  >
                    {i.kind}
                  </span>{' '}
                  {i.message}
                  {i.hint ? <span className="text-xs text-slate-500"> — {i.hint}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {aiError ? (
        <div className="rounded-xl border border-warn-500/30 bg-warn-500/5 p-3 text-sm">
          IA no disponible: {aiError}. El feedback local sigue siendo válido.
        </div>
      ) : null}

      {aiResult ? (
        <div className="space-y-3 rounded-2xl border border-brand-500/30 bg-brand-50/40 p-4 dark:bg-brand-900/10">
          <div className="flex items-baseline justify-between">
            <span className="text-xs uppercase tracking-wider text-brand-700 dark:text-brand-300">
              Corrección IA
            </span>
            <div className="text-3xl font-bold">{aiResult.score}</div>
          </div>
          <div>
            <span className="text-xs uppercase tracking-wider text-slate-500">Corregido</span>
            <p
              className="mt-1 text-sm"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(aiResult.corrected) }}
            />
          </div>
          <div>
            <span className="text-xs uppercase tracking-wider text-slate-500">Mejor versión</span>
            <p
              className="mt-1 text-sm italic text-slate-600 dark:text-slate-300"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(aiResult.betterVersion) }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
