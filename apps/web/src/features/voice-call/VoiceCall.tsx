import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useProfileStore } from '../../stores/profile.js';
import { db, type Conversation, type ConversationTurn } from '../../db/dexie.js';
import {
  hasSpeechRecognition,
  hasTts,
  humanizeSpeechError,
  recognizeOnce,
  speak,
  stopSpeaking,
  type RecordHandle,
} from '../../lib/speech.js';
import { streamTutor, type StreamHandle } from '../../lib/tutorClient.js';
import {
  IconClock,
  IconMic,
  IconPhone,
  IconPlay,
  IconSend,
  IconSparkle,
  IconTrash,
} from '../../components/Icons.js';

const SCENARIOS = [
  { id: 'casual', label: 'Charla casual', prompt: 'Casual chat about hobbies, weekend plans, or life.' },
  { id: 'interview', label: 'Entrevista de trabajo', prompt: 'Job interview for a software engineer role.' },
  { id: 'travel', label: 'Viaje / aeropuerto', prompt: 'You are a helpful airport agent. The user is at check-in.' },
  { id: 'cafe', label: 'Cafetería', prompt: 'You are a barista. Take the user\'s order and chat briefly.' },
  { id: 'freeform', label: 'Libre', prompt: 'Have a natural conversation. Correct politely when helpful.' },
];

type Phase = 'idle' | 'listening' | 'reviewing' | 'thinking' | 'speaking';

function sid(): string {
  try {
    const KEY = 'ld:sid';
    const cur = localStorage.getItem(KEY);
    if (cur) return cur;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return 'anon';
  }
}

export function VoiceCall() {
  const level = useProfileStore((s) => s.profile.level);
  const [scenarioId, setScenarioId] = useState('casual');
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [partial, setPartial] = useState('');
  const [draft, setDraft] = useState('');
  const [aiPartial, setAiPartial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Conversation[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [autoSend, setAutoSend] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [handsFree, setHandsFree] = useState(false);

  const srSupported = hasSpeechRecognition();
  const ttsSupported = hasTts();

  const recogRef = useRef<RecordHandle | null>(null);
  const streamRef = useRef<StreamHandle | null>(null);
  const autoSendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    void loadHistory();
    return () => {
      recogRef.current?.stop();
      streamRef.current?.abort();
      stopSpeaking();
      if (autoSendTimer.current) clearTimeout(autoSendTimer.current);
    };
  }, []);

  useEffect(() => {
    // Auto-scroll al final cuando cambia la conversación o llega respuesta.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [conversation?.turns.length, aiPartial]);

  async function loadHistory() {
    const list = await db.conversations.orderBy('createdAt').reverse().limit(20).toArray();
    setHistory(list);
  }

  function newConversation() {
    stopEverything();
    const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!;
    const now = new Date().toISOString();
    startedAtRef.current = Date.now();
    setConversation({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      level,
      scenario: scenario.prompt,
      turns: [],
      userWordCount: 0,
    });
    setPhase('idle');
    setError(null);
    setPartial('');
    setDraft('');
    setAiPartial('');
  }

  function stopEverything() {
    recogRef.current?.stop();
    recogRef.current = null;
    streamRef.current?.abort();
    streamRef.current = null;
    stopSpeaking();
    if (autoSendTimer.current) {
      clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }
  }

  // ─── Grabación ───

  function startListening() {
    if (!conversation) newConversation();
    setError(null);
    setPartial('');
    setDraft('');
    setPhase('listening');
    stopSpeaking();

    recogRef.current = recognizeOnce({
      lang: 'en-US',
      onPartial: (t) => setPartial(t),
      onFinal: (text) => {
        setPartial('');
        setDraft(text);
        setPhase('reviewing');
        if (autoSend) scheduleAutoSend();
      },
      onError: (err) => {
        setError(humanizeSpeechError(err.message));
        setPhase('idle');
      },
      onEnd: () => {
        if (phaseRef.current === 'listening') {
          // Terminó sin final: usa el parcial como draft (si hay).
          setDraft((prev) => prev || partialRef.current);
          setPhase(partialRef.current ? 'reviewing' : 'idle');
          if (partialRef.current && autoSend) scheduleAutoSend();
        }
      },
    });
  }

  // refs sincronizados para leer estados frescos dentro de callbacks de recogRef.
  const phaseRef = useRef(phase);
  const partialRef = useRef(partial);
  const handsFreeRef = useRef(handsFree);
  const startListeningRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    partialRef.current = partial;
  }, [partial]);
  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);
  useEffect(() => {
    startListeningRef.current = startListening;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  function stopListening() {
    recogRef.current?.stop();
    recogRef.current = null;
    if (partial) {
      setDraft(partial);
      setPhase('reviewing');
      if (autoSend) scheduleAutoSend();
    } else {
      setPhase('idle');
    }
  }

  function scheduleAutoSend() {
    if (autoSendTimer.current) clearTimeout(autoSendTimer.current);
    autoSendTimer.current = setTimeout(() => sendTurn(), 2500);
  }

  function cancelAutoSend() {
    if (autoSendTimer.current) {
      clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }
  }

  // ─── Envío al tutor ───

  const sendTurn = useCallback(async () => {
    const text = draftRef.current.trim();
    if (!text || !conversation) return;
    cancelAutoSend();

    const userTurn: ConversationTurn = { role: 'user', text, ts: new Date().toISOString() };
    const nextTurns = [...conversation.turns, userTurn];
    const updated: Conversation = {
      ...conversation,
      turns: nextTurns,
      updatedAt: new Date().toISOString(),
      userWordCount: (conversation.userWordCount ?? 0) + text.split(/\s+/).length,
    };
    setConversation(updated);
    setDraft('');
    setPartial('');
    setPhase('thinking');
    setAiPartial('');
    await persist(updated);

    // Buffer para TTS por oración: cada vez que llegue . ! ? habla lo acumulado.
    let ttsBuffer = '';
    let fullText = '';
    const speakBuffered = async () => {
      const chunk = ttsBuffer.trim();
      if (!chunk) return;
      ttsBuffer = '';
      if (ttsEnabled && ttsSupported) {
        try {
          setPhase('speaking');
          await speak(chunk);
        } catch {
          // Silencioso — el texto ya está visible en la burbuja.
        }
      }
    };

    streamRef.current = streamTutor(
      {
        sessionId: sid(),
        level,
        scenario: conversation.scenario,
        turns: nextTurns,
      },
      {
        onToken: (chunk) => {
          fullText += chunk;
          ttsBuffer += chunk;
          setAiPartial(fullText);
          // Habla oración a oración cuando aparezca puntuación final.
          if (/[.!?]\s*$/.test(ttsBuffer)) {
            void speakBuffered();
          }
        },
        onDone: async () => {
          await speakBuffered();
          const aiTurn: ConversationTurn = {
            role: 'assistant',
            text: fullText.trim() || '(respuesta vacía)',
            ts: new Date().toISOString(),
          };
          const finalConv: Conversation = {
            ...updated,
            turns: [...nextTurns, aiTurn],
            updatedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAtRef.current,
          };
          setConversation(finalConv);
          setAiPartial('');
          await persist(finalConv);
          void loadHistory();
          setPhase('idle');
          streamRef.current = null;
          // Modo hands-free: arranca el mic automáticamente tras la respuesta IA.
          if (handsFreeRef.current && srSupported) {
            setTimeout(() => {
              if (phaseRef.current === 'idle') startListeningRef.current?.();
            }, 500);
          }
        },
        onError: (err) => {
          setError(err.message);
          setAiPartial('');
          setPhase('idle');
          streamRef.current = null;
        },
      },
    );
  }, [conversation, level, ttsEnabled, ttsSupported]);

  // ref para leer el draft fresco desde el timeout
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  async function persist(c: Conversation) {
    try {
      await db.conversations.put(c);
    } catch {
      // sin espacio — no bloqueamos el flow, se ve en la UI
    }
  }

  async function deleteConversation(id: string) {
    await db.conversations.delete(id);
    if (conversation?.id === id) setConversation(null);
    void loadHistory();
  }

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!;
  const canSend = draft.trim().length > 0 && phase !== 'thinking' && phase !== 'speaking';

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header>
        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
          Llamada con la IA
        </div>
        <h1 className="mt-1 flex items-center gap-2 text-3xl font-black tracking-tight">
          <span className="inline-grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-pink-500 text-white shadow-pop">
            <IconPhone size={22} />
          </span>
          Voice Call
        </h1>
        <p className="text-xs text-slate-500">
          Habla en inglés, la IA te responde. Cada turno se transcribe y guarda para revisar después.
        </p>
      </header>

      {!srSupported ? (
        <div className="rounded-2xl border border-warn-500/30 bg-warn-500/10 p-4 text-sm">
          <p className="font-semibold text-warn-600">Sin reconocimiento de voz</p>
          <p className="mt-1 text-slate-600 dark:text-slate-300">
            Aun así puedes escribir tu turno abajo y la IA responderá con voz.
          </p>
        </div>
      ) : null}

      {/* Config bar */}
      <div className="glass flex flex-wrap items-center gap-2 rounded-2xl border border-white/60 p-3 dark:border-white/5">
        <label className="text-xs font-semibold text-slate-500">
          Escenario
          <select
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
            disabled={!!conversation && conversation.turns.length > 0}
            className="ml-2 rounded-lg border border-slate-300/70 bg-white px-2 py-1 text-xs font-semibold text-slate-700 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="ml-auto flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
          Auto-enviar
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={ttsEnabled && ttsSupported}
            onChange={(e) => setTtsEnabled(e.target.checked)}
            disabled={!ttsSupported}
          />
          Voz IA
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500" title="Reanudar mic automáticamente tras la respuesta IA">
          <input
            type="checkbox"
            checked={handsFree && srSupported}
            onChange={(e) => setHandsFree(e.target.checked)}
            disabled={!srSupported}
          />
          Manos libres
        </label>
        <button
          onClick={newConversation}
          className="rounded-lg bg-gradient-to-r from-brand-500 to-pink-500 px-3 py-1.5 text-xs font-bold text-white shadow-pop"
        >
          Nueva llamada
        </button>
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="rounded-lg border border-slate-300/70 px-3 py-1.5 text-xs font-semibold text-slate-600 dark:border-white/10 dark:text-slate-300"
        >
          <IconClock size={12} className="inline" /> Historial ({history.length})
        </button>
      </div>

      {/* Historial expandible */}
      <AnimatePresence>
        {showHistory ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <ul className="space-y-2">
              {history.length === 0 ? (
                <li className="text-center text-xs text-slate-400">No hay llamadas guardadas.</li>
              ) : null}
              {history.map((c) => (
                <li key={c.id} className="glass flex items-center justify-between gap-2 rounded-xl border border-white/60 p-3 dark:border-white/5">
                  <button
                    onClick={() => {
                      setConversation(c);
                      setShowHistory(false);
                    }}
                    className="flex-1 text-left"
                  >
                    <div className="text-sm font-semibold">
                      {c.scenario.slice(0, 60)}{c.scenario.length > 60 ? '…' : ''}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {new Date(c.createdAt).toLocaleString()} · {c.turns.length} turnos · {c.level}
                    </div>
                  </button>
                  <button
                    onClick={() => void deleteConversation(c.id)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-danger-500/10 hover:text-danger-600"
                    aria-label="Borrar conversación"
                  >
                    <IconTrash size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Chat */}
      <div
        ref={scrollRef}
        className="glass min-h-[300px] max-h-[52vh] overflow-y-auto rounded-3xl border border-white/60 p-4 shadow-soft dark:border-white/5"
      >
        {!conversation || conversation.turns.length === 0 ? (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 text-center text-sm text-slate-500">
            <div className="text-4xl">💬</div>
            <p className="font-semibold">{scenario.label}</p>
            <p className="text-xs text-slate-400">{scenario.prompt}</p>
            <p className="mt-2 text-xs">Presiona el micrófono para empezar</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {conversation.turns.map((t, i) => (
              <li key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <Bubble turn={t} />
              </li>
            ))}
            {aiPartial ? (
              <li className="flex justify-start">
                <Bubble turn={{ role: 'assistant', text: aiPartial, ts: new Date().toISOString() }} streaming />
              </li>
            ) : null}
            {phase === 'thinking' ? (
              <li className="flex justify-start">
                <div className="flex items-center gap-1 rounded-2xl bg-slate-100 px-4 py-2 dark:bg-white/5">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
                  <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" style={{ animationDelay: '150ms' }} />
                  <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" style={{ animationDelay: '300ms' }} />
                </div>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {error ? (
        <div className="rounded-xl border border-danger-500/30 bg-danger-500/5 p-3 text-sm">
          <p className="font-semibold text-danger-600">Oops</p>
          <p className="mt-0.5 text-slate-600 dark:text-slate-300">{error}</p>
        </div>
      ) : null}

      {(phase === 'speaking' || phase === 'thinking') && conversation ? (
        <div className="flex justify-center">
          <button
            onClick={() => {
              stopSpeaking();
              streamRef.current?.abort();
              streamRef.current = null;
              setAiPartial('');
              setPhase('idle');
            }}
            className="rounded-full bg-danger-500 px-4 py-2 text-xs font-bold text-white shadow-pop"
          >
            ■ Parar IA
          </button>
        </div>
      ) : null}

      {/* Draft editable con transcripción en vivo */}
      <div className="glass rounded-3xl border border-white/60 p-3 shadow-soft dark:border-white/5">
        {phase === 'listening' ? (
          <div className="mb-2 min-h-[2rem] text-sm italic text-slate-500">
            {partial || 'Esperando tu voz…'}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              cancelAutoSend();
            }}
            onFocus={() => {
              cancelAutoSend();
              // Si el usuario enfoca el textarea mientras el mic está activo, ceder el turno al teclado.
              if (phaseRef.current === 'listening') stopListening();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && canSend) {
                e.preventDefault();
                void sendTurn();
              }
            }}
            placeholder={
              phase === 'listening'
                ? 'Grabando…'
                : phase === 'reviewing'
                  ? 'Puedes editar antes de enviar…'
                  : 'Escribe o graba con el micrófono'
            }
            rows={2}
            className="flex-1 resize-none rounded-2xl border border-slate-200 bg-white/70 p-2 text-sm dark:border-white/10 dark:bg-slate-900/60"
          />
          <div className="flex flex-col gap-2">
            {srSupported ? (
              <button
                onClick={phase === 'listening' ? stopListening : startListening}
                disabled={phase === 'thinking' || phase === 'speaking'}
                className={`grid h-14 w-14 place-items-center rounded-2xl text-white shadow-pop transition disabled:opacity-40 ${
                  phase === 'listening'
                    ? 'bg-gradient-to-br from-pink-500 to-flame-500'
                    : 'bg-gradient-to-br from-brand-500 to-pink-500 hover:scale-105 active:scale-95'
                }`}
                aria-label={phase === 'listening' ? 'Detener grabación' : 'Grabar'}
              >
                {phase === 'listening' ? <span className="text-lg font-black">■</span> : <IconMic size={22} />}
              </button>
            ) : null}
            <button
              onClick={sendTurn}
              disabled={!canSend}
              className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-cyan-500 to-brand-500 text-white shadow-pop transition disabled:opacity-40"
              aria-label="Enviar"
            >
              <IconSend size={20} />
            </button>
          </div>
        </div>
        {phase === 'reviewing' && autoSend ? (
          <p className="mt-1 text-[10px] text-slate-400">
            Se envía en 2.5s si no editas. Toca el textarea para pausar.
          </p>
        ) : null}
        {conversation && conversation.turns.length > 0 ? (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-400">
            <IconSparkle size={10} />
            {conversation.turns.length} turnos · {conversation.userWordCount ?? 0} palabras dichas · guardado localmente
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Bubble({ turn, streaming }: { turn: ConversationTurn; streaming?: boolean }) {
  const isUser = turn.role === 'user';
  return (
    <div
      className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm shadow-soft ${
        isUser
          ? 'bg-gradient-to-br from-brand-500 to-pink-500 text-white'
          : 'bg-white/90 text-slate-800 dark:bg-white/10 dark:text-slate-100'
      }`}
    >
      <p className="whitespace-pre-wrap">{turn.text}{streaming ? <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-current align-middle" /> : null}</p>
      {!isUser && !streaming ? (
        <button
          onClick={() => hasTts() && void speak(turn.text)}
          className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400 hover:text-brand-600"
        >
          <IconPlay size={10} /> Reproducir
        </button>
      ) : null}
    </div>
  );
}
