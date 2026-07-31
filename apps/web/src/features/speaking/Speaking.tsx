import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePacksStore } from '../../stores/packs.js';
import { useProfileStore } from '../../stores/profile.js';
import { EmptyState, LoadingState } from '../../components/UiStates.js';
import {
  hasSpeechRecognition,
  hasTts,
  humanizeSpeechError,
  recognizeOnce,
  speak,
  startMicMeter,
  stopSpeaking,
  type MicMeter,
  type RecordHandle,
} from '../../lib/speech.js';
import { wordMatchStats } from '@linguadev/shared';
import { IconMic, IconPlay, IconChevronRight, IconSparkle } from '../../components/Icons.js';

interface SpeakItem {
  id: string;
  kind: 'shadowing' | 'read-aloud' | 'roleplay';
  target: string;
  packTitle: string;
}

export function Speaking() {
  const packs = usePacksStore((s) => s.packs);
  const loaded = usePacksStore((s) => s.loaded);
  const markStudiedToday = useProfileStore((s) => s.markStudiedToday);
  const [srSupported, setSrSupported] = useState<boolean | null>(null);
  const [ttsSupported, setTtsSupported] = useState<boolean | null>(null);
  const [idx, setIdx] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [partial, setPartial] = useState('');
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recogRef = useRef<RecordHandle | null>(null);
  const meterRef = useRef<MicMeter | null>(null);

  const items = useMemo<SpeakItem[]>(() => {
    const out: SpeakItem[] = [];
    for (const p of packs) {
      if (!p.enabled) continue;
      for (const s of p.speaking) {
        out.push({ id: s.id, kind: s.kind, target: s.target, packTitle: p.title });
      }
    }
    return out;
  }, [packs]);

  useEffect(() => {
    setSrSupported(hasSpeechRecognition());
    setTtsSupported(hasTts());
  }, []);

  useEffect(() => {
    return () => {
      recogRef.current?.stop();
      meterRef.current?.stop();
      stopSpeaking();
    };
  }, []);

  if (!loaded || srSupported === null || ttsSupported === null) return <LoadingState />;

  const current = items[idx % Math.max(items.length, 1)];
  if (!current) return <EmptyState title="No hay ejercicios de habla en tus packs habilitados" />;

  const stats = transcript ? wordMatchStats(current.target, transcript) : null;
  const score = stats && stats.total > 0 ? Math.round((stats.matched / stats.total) * 100) : 0;

  // Arranca reconocimiento PRIMERO (evita conflicto con el meter por getUserMedia).
  // El meter es puramente visual: si falla, seguimos igual con la grabación.
  function start() {
    if (!current || listening) return;
    setError(null);
    setTranscript('');
    setPartial('');
    setListening(true);

    recogRef.current = recognizeOnce({
      onPartial: (t) => setPartial(t),
      onFinal: (text) => {
        setTranscript(text);
        setListening(false);
        meterRef.current?.stop();
        meterRef.current = null;
        void markStudiedToday();
      },
      onError: (err) => {
        setError(humanizeSpeechError(err.message));
        setListening(false);
        meterRef.current?.stop();
        meterRef.current = null;
      },
      onEnd: () => {
        setListening(false);
        meterRef.current?.stop();
        meterRef.current = null;
      },
    });

    // Intenta añadir medidor de nivel; si falla, no bloquea la grabación.
    startMicMeter(setLevel)
      .then((m) => {
        meterRef.current = m;
      })
      .catch(() => {
        // Sin meter no importa — SR sigue capturando audio por su cuenta.
      });
  }

  function stop() {
    recogRef.current?.stop();
    recogRef.current = null;
    meterRef.current?.stop();
    meterRef.current = null;
    setListening(false);
  }

  function next() {
    stop();
    setIdx((i) => i + 1);
    setTranscript('');
    setPartial('');
    setError(null);
  }

  const kindLabel =
    current.kind === 'shadowing' ? 'Shadowing' : current.kind === 'read-aloud' ? 'Leer en voz alta' : 'Roleplay';

  return (
    <div className="mx-auto max-w-md space-y-4">
      <header>
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500">
          <span>{current.packTitle}</span>
          <span>·</span>
          <span className="rounded-full bg-gradient-to-r from-pink-500 to-flame-500 bg-clip-text text-transparent">
            {kindLabel}
          </span>
        </div>
        <h1 className="mt-1 text-3xl font-black tracking-tight">Habla</h1>
        <p className="text-xs text-slate-500">
          Frase {idx + 1} de {items.length}
        </p>
      </header>

      {!srSupported ? (
        <div className="rounded-2xl border border-warn-500/30 bg-warn-500/10 p-4 text-sm">
          <p className="font-semibold text-warn-600">Sin reconocimiento de voz</p>
          <p className="mt-1 text-slate-600 dark:text-slate-300">
            Tu navegador no soporta SpeechRecognition (Firefox / iOS Safari suelen no tenerlo). Usa el
            botón <b>Escuchar modelo</b> y repite en voz alta para practicar.
          </p>
        </div>
      ) : null}

      {/* Target card con estilo hero */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-pink-500 via-brand-600 to-cyan-500 p-6 text-white shadow-pop">
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/20 blur-2xl" />
        <p className="relative text-[10px] font-bold uppercase tracking-widest text-white/70">
          Frase objetivo
        </p>
        <p className="relative mt-2 text-xl font-bold leading-snug sm:text-2xl">"{current.target}"</p>
        <div className="relative mt-4 flex gap-2">
          <button
            onClick={() => void speak(current.target).catch(() => setTtsSupported(false))}
            disabled={!ttsSupported}
            className="inline-flex items-center gap-1.5 rounded-xl bg-white/20 px-3 py-1.5 text-xs font-semibold ring-1 ring-white/25 backdrop-blur transition hover:bg-white/30 disabled:opacity-40"
          >
            <IconPlay size={12} /> Escuchar modelo
          </button>
          <button
            onClick={() => void speak(current.target, { rate: 0.7 }).catch(() => setTtsSupported(false))}
            disabled={!ttsSupported}
            className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-1.5 text-xs font-semibold ring-1 ring-white/20 backdrop-blur transition hover:bg-white/20 disabled:opacity-40"
          >
            0.7x
          </button>
        </div>
      </div>

      {srSupported ? (
        <div className="flex flex-col items-center gap-3">
          {/* Botón grande con onda alrededor cuando graba */}
          <div className="relative">
            {listening ? (
              <>
                <span
                  className="absolute inset-0 -m-2 rounded-full bg-pink-500/25"
                  style={{ transform: `scale(${1 + level * 0.6})`, transition: 'transform 80ms' }}
                />
                <span className="absolute inset-0 -m-6 animate-ping rounded-full bg-pink-500/20" />
              </>
            ) : null}
            <button
              onClick={() => (listening ? stop() : start())}
              className={`relative grid h-24 w-24 place-items-center rounded-full text-white shadow-pop transition ${
                listening
                  ? 'bg-gradient-to-br from-pink-500 to-flame-500'
                  : 'bg-gradient-to-br from-brand-500 to-pink-500 hover:scale-105 active:scale-95'
              }`}
              aria-label={listening ? 'Detener grabación' : 'Iniciar grabación'}
            >
              {listening ? (
                <span className="text-2xl font-black">■</span>
              ) : (
                <IconMic size={36} />
              )}
            </button>
          </div>

          <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">
            {listening ? 'Escuchando… habla ahora' : 'Toca para grabar'}
          </p>

          {/* Transcripción parcial en vivo, siempre visible mientras escucha */}
          <div className="min-h-[3rem] w-full rounded-2xl border border-dashed border-slate-300/70 bg-white/40 p-3 text-center text-sm italic text-slate-500 dark:border-white/10 dark:bg-white/5">
            {partial || (listening ? 'Esperando tu voz…' : 'Aquí verás lo que grabes')}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-danger-500/30 bg-danger-500/5 p-3 text-sm">
          <p className="font-semibold text-danger-600">Oops</p>
          <p className="mt-0.5 text-slate-600 dark:text-slate-300">{error}</p>
        </div>
      ) : null}

      <AnimatePresence>
        {transcript ? (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="glass rounded-2xl border border-white/60 p-4 shadow-soft dark:border-white/5"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-brand-700 dark:text-brand-300">
                <IconSparkle size={10} /> Resultado
              </span>
              <span
                className={`text-4xl font-black tabular-nums ${
                  score >= 80 ? 'text-success-600' : score >= 50 ? 'text-warn-500' : 'text-danger-500'
                }`}
              >
                {score}
              </span>
            </div>
            <p className="text-sm italic text-slate-600 dark:text-slate-300">"{transcript}"</p>
            {stats && stats.missing.length > 0 ? (
              <p className="mt-2 text-xs text-slate-500">
                Palabras que no detecté:{' '}
                <span className="font-mono text-danger-500">{stats.missing.join(', ')}</span>
              </p>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                onClick={next}
                className="flex-1 rounded-xl bg-gradient-to-r from-brand-500 to-pink-500 py-2.5 text-sm font-bold text-white shadow-pop"
              >
                Siguiente <IconChevronRight className="inline" size={14} />
              </button>
              <button
                onClick={() => {
                  setTranscript('');
                  setPartial('');
                }}
                className="rounded-xl border border-slate-300 px-3 text-sm font-semibold dark:border-slate-700"
              >
                Reintentar
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {!transcript && !listening ? (
        <button
          onClick={next}
          className="w-full rounded-xl border border-slate-300/70 py-2 text-sm text-slate-500 hover:bg-slate-100/50 dark:border-slate-700"
        >
          Saltar esta frase
        </button>
      ) : null}
    </div>
  );
}
