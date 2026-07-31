import { useEffect, useRef, useState } from 'react';
import type { SpeakingQuestion } from '@linguadev/shared';
import { wordMatchStats } from '@linguadev/shared';
import type { QuestionComponentProps } from './types.js';
import { QuestionShell } from './QuestionShell.js';
import {
  hasSpeechRecognition,
  hasTts,
  humanizeSpeechError,
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
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recogRef = useRef<RecordHandle | null>(null);

  useEffect(() => {
    setSrSupported(hasSpeechRecognition());
    setTtsSupported(hasTts());
    return () => {
      recogRef.current?.stop();
      stopSpeaking();
    };
  }, []);

  function start() {
    if (listening || revealed) return;
    setError(null);
    setTranscript('');
    setPartial('');
    setListening(true);
    recogRef.current = recognizeOnce({
      onPartial: (t) => setPartial(t),
      onFinal: (t) => {
        setTranscript(t);
        setListening(false);
        const stats = wordMatchStats(question.target, t);
        const score = stats.total ? stats.matched / stats.total : 0;
        onResult({ correct: score >= 0.8, score01: score, userAnswer: t });
      },
      onError: (err) => {
        setError(humanizeSpeechError(err.message));
        setListening(false);
      },
      onEnd: () => setListening(false),
    });
  }

  function stop() {
    recogRef.current?.stop();
    setListening(false);
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
            onClick={() => (listening ? stop() : start())}
            className={`grid h-20 w-20 place-items-center rounded-full text-white shadow-pop transition ${
              listening
                ? 'animate-pulse bg-gradient-to-br from-pink-500 to-flame-500'
                : 'bg-gradient-to-br from-brand-500 to-pink-500 hover:scale-105 active:scale-95'
            }`}
          >
            {listening ? '■' : <IconMic size={28} />}
          </button>
          <p className="min-h-[1.25rem] text-center text-xs italic text-slate-500">
            {partial || (listening ? 'Escuchando…' : 'Toca para grabar')}
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
    </QuestionShell>
  );
}
