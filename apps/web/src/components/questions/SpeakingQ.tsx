import { useEffect, useRef, useState } from 'react';
import type { SpeakingQuestion } from '@linguadev/shared';
import { wordMatchStats } from '@linguadev/shared';
import type { QuestionComponentProps } from './types.js';
import { QuestionShell } from './QuestionShell.js';
import {
  ensureMicPermission,
  hasSpeechRecognition,
  hasTts,
  humanizeSpeechError,
  isSecureContextForMic,
  recognizeOnce,
  speak,
  stopSpeaking,
  type RecordHandle,
} from '../../lib/speech.js';
import { IconMic, IconPlay } from '../Icons.js';

export function SpeakingQ({
  question,
  onResult,
  revealed,
}: QuestionComponentProps<SpeakingQuestion>) {
  const [srSupported, setSrSupported] = useState<boolean | null>(null);
  const [ttsSupported, setTtsSupported] = useState<boolean | null>(null);
  const [status, setStatus] = useState<'idle' | 'requesting-mic' | 'starting' | 'listening'>('idle');
  const listening = status !== 'idle';
  const [partial, setPartial] = useState('');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recogRef = useRef<RecordHandle | null>(null);
  const safetyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setSrSupported(hasSpeechRecognition());
    setTtsSupported(hasTts());
    return () => {
      recogRef.current?.stop();
      if (safetyTimerRef.current) window.clearTimeout(safetyTimerRef.current);
      stopSpeaking();
    };
  }, []);

  useEffect(() => {
    if (safetyTimerRef.current) window.clearTimeout(safetyTimerRef.current);
    if (status === 'requesting-mic' || status === 'starting') {
      safetyTimerRef.current = window.setTimeout(() => {
        setError('Tiempo agotado esperando el micrófono. Toca "Saltar" y sigue.');
        recogRef.current?.stop();
        setStatus('idle');
      }, 8000);
    } else if (status === 'listening') {
      safetyTimerRef.current = window.setTimeout(() => {
        recogRef.current?.stop();
        setStatus('idle');
      }, 20000);
    }
    return () => {
      if (safetyTimerRef.current) window.clearTimeout(safetyTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function start() {
    if (listening || revealed) return;
    setError(null);
    setTranscript('');
    setPartial('');
    if (!isSecureContextForMic()) {
      setError('Necesitas HTTPS o localhost para acceder al micrófono.');
      return;
    }
    setStatus('requesting-mic');
    const ok = await ensureMicPermission();
    if (!ok) {
      setError('Permiso de micrófono denegado. Actívalo en la barra de dirección.');
      setStatus('idle');
      return;
    }
    setStatus('starting');
    recogRef.current = recognizeOnce({
      onStart: () => setStatus('listening'),
      onPartial: (t) => setPartial(t),
      onFinal: (t) => {
        setTranscript(t);
        setStatus('idle');
        const stats = wordMatchStats(question.target, t);
        const score = stats.total ? stats.matched / stats.total : 0;
        onResult({ correct: score >= 0.8, score01: score, userAnswer: t });
      },
      onError: (err) => {
        setError(humanizeSpeechError(err.message));
        setStatus('idle');
      },
      onEnd: () => setStatus('idle'),
    });
  }

  function stop() {
    recogRef.current?.stop();
    setStatus('idle');
  }

  const stats = transcript ? wordMatchStats(question.target, transcript) : null;

  return (
    <QuestionShell question={question} label="Habla en voz alta">
      <div className="rounded-2xl bg-gradient-to-br from-pink-500 to-flame-500 p-4 text-white shadow-pop">
        <p className="text-[10px] font-bold uppercase tracking-widest text-white/70">Frase objetivo</p>
        <p className="mt-1 text-lg font-bold leading-snug">"{question.target}"</p>
        <button
          onClick={() => void speak(question.target).catch(() => setTtsSupported(false))}
          disabled={!ttsSupported}
          className="mt-2 inline-flex items-center gap-1 rounded-lg bg-white/20 px-2 py-1 text-xs font-semibold ring-1 ring-white/25 backdrop-blur disabled:opacity-40"
        >
          <IconPlay size={12} /> Escuchar
        </button>
      </div>

      {!srSupported ? (
        <p className="mt-3 rounded-xl border border-warn-500/30 bg-warn-500/10 p-3 text-xs">
          Sin reconocimiento de voz — puedes repetir en voz alta para practicar.
        </p>
      ) : (
        <div className="mt-4 flex flex-col items-center gap-2">
          <button
            onClick={() => (listening ? stop() : void start())}
            disabled={status === 'requesting-mic' || status === 'starting'}
            className={`grid h-20 w-20 place-items-center rounded-full text-white shadow-pop transition ${
              status === 'listening'
                ? 'animate-pulse bg-gradient-to-br from-pink-500 to-flame-500'
                : status === 'requesting-mic' || status === 'starting'
                ? 'bg-gradient-to-br from-slate-400 to-slate-500'
                : 'bg-gradient-to-br from-brand-500 to-pink-500 hover:scale-105 active:scale-95'
            }`}
          >
            {status === 'listening' ? '■' : status === 'requesting-mic' || status === 'starting' ? '◌' : <IconMic size={28} />}
          </button>
          <p className="min-h-[1.25rem] text-center text-xs italic text-slate-500">
            {status === 'requesting-mic'
              ? 'Pidiendo permiso…'
              : status === 'starting'
              ? 'Iniciando…'
              : status === 'listening'
              ? '🎙️ Grabando · habla ahora'
              : partial || 'Toca para grabar'}
          </p>
        </div>
      )}

      {error ? (
        <p className="mt-2 rounded-xl border border-danger-500/30 bg-danger-500/5 p-3 text-xs text-danger-600">
          {error}
        </p>
      ) : null}

      {transcript ? (
        <div className="mt-3 rounded-2xl border border-slate-200 p-3 dark:border-white/10">
          <div className="flex justify-between">
            <span className="text-xs text-slate-500">Tu intento</span>
            {stats ? (
              <span className="text-xs font-bold">
                {stats.matched}/{stats.total} palabras
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm italic">"{transcript}"</p>
        </div>
      ) : null}

      {/* Botón Saltar siempre visible — nunca dejar al usuario atrapado */}
      {!revealed ? (
        <div className="mt-3 flex gap-2">
          {listening ? (
            <button
              onClick={stop}
              className="rounded-lg border border-danger-500/50 bg-danger-500/10 px-3 py-1.5 text-xs font-bold text-danger-600"
            >
              Cancelar
            </button>
          ) : null}
          <button
            onClick={() => onResult({ correct: false, score01: 0, userAnswer: '' })}
            className="flex-1 rounded-lg border border-slate-300/70 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100/50 dark:border-slate-700 dark:text-slate-400"
          >
            ⏭️ Saltar pregunta
          </button>
        </div>
      ) : null}
    </QuestionShell>
  );
}
