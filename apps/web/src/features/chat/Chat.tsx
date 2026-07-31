import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChatSession, type ChatStreamSessionHandle } from './ChatSession.js';
import type { Chat as ChatRow, ChatMessage, ChatPresetLocal } from '../../db/dexie.js';
import { fetchAiStatus } from '../../lib/chatClient.js';
import type { AiStatusResponse } from '@linguadev/shared';
import { IconChat, IconPlus, IconSend, IconStop, IconTrash, IconSparkle } from '../../components/Icons.js';

type Phase = 'idle' | 'streaming';

const PRESETS: { id: ChatPresetLocal; label: string; hint: string }[] = [
  { id: 'general', label: 'General', hint: 'Cualquier tema: inglés, AWS, código, dudas' },
  { id: 'english-tutor', label: 'Inglés (tutor)', hint: 'Responde en inglés y corrige errores' },
  { id: 'aws-tutor', label: 'AWS (cert)', hint: 'Enfocado en CLF-C02 y SAA-C03' },
  { id: 'custom', label: 'Custom', hint: 'Tu propio system prompt' },
];

export function Chat() {
  const [status, setStatus] = useState<AiStatusResponse | null>(null);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [assistantPartial, setAssistantPartial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showPresetPicker, setShowPresetPicker] = useState(false);
  const [customSystem, setCustomSystem] = useState('');

  // Handle del stream activo. Expone abort() + stopAndPersist() atómico que la clase
  // ChatSession implementa (evita duplicar el mensaje si el server termina justo cuando
  // el usuario aprieta Stop).
  const streamRef = useRef<ChatStreamSessionHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Tick para forzar re-render cuando mutamos la ChatSession en su lugar sin cambiar la ref.
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);

  const refresh = useCallback(async () => {
    setChats(await ChatSession.list());
  }, []);

  useEffect(() => {
    void fetchAiStatus().then(setStatus).catch(() => setStatus(null));
    void refresh();
    return () => {
      streamRef.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, assistantPartial]);

  async function openChat(id: string) {
    streamRef.current?.abort();
    setPhase('idle');
    setAssistantPartial('');
    setError(null);
    const s = await ChatSession.load(id);
    if (!s) return;
    setSession(s);
    setMessages(s.messages);
    setTimeout(() => textareaRef.current?.focus(), 30);
  }

  async function newChat(preset: ChatPresetLocal = 'general') {
    streamRef.current?.abort();
    setPhase('idle');
    setAssistantPartial('');
    setError(null);
    const s = await ChatSession.create({
      preset,
      systemOverride: preset === 'custom' ? customSystem || undefined : undefined,
    });
    setSession(s);
    setMessages([]);
    setShowPresetPicker(false);
    void refresh();
    setTimeout(() => textareaRef.current?.focus(), 30);
  }

  async function deleteChat(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('¿Borrar este chat?')) return;
    if (session?.chat.id === id) {
      streamRef.current?.abort();
      setSession(null);
      setMessages([]);
      setAssistantPartial('');
      setPhase('idle');
    }
    await ChatSession.remove(id);
    void refresh();
  }

  async function changePreset(preset: ChatPresetLocal) {
    if (!session) return;
    await session.setPreset(preset, preset === 'custom' ? customSystem || undefined : undefined);
    bump();
    void refresh();
  }

  async function send() {
    const text = input.trim();
    if (!text || phase === 'streaming') return;
    let s = session;
    if (!s) {
      s = await ChatSession.create({ preset: 'general' });
      setSession(s);
      void refresh();
    }
    setInput('');
    setError(null);
    setPhase('streaming');
    setAssistantPartial('');
    try {
      await s.addUserMessage(text);
    } catch (err) {
      setError(humanizeError(err as Error));
      setPhase('idle');
      return;
    }
    setMessages([...s.messages]);
    void refresh();

    const activeSession = s;
    streamRef.current = activeSession.send({
      onToken: (chunk) => setAssistantPartial((p) => p + chunk),
      onDone: (assistant) => {
        setMessages([...activeSession.messages]);
        setAssistantPartial('');
        setPhase('idle');
        void refresh();
        setTimeout(() => textareaRef.current?.focus(), 30);
        void assistant;
      },
      onError: (err) => {
        if (isAbortError(err)) return;
        setError(humanizeError(err));
        setAssistantPartial('');
        setPhase('idle');
      },
    });
  }

  function stop() {
    if (phase !== 'streaming') return;
    const s = session;
    const handle = streamRef.current;
    if (!handle || !s) {
      setAssistantPartial('');
      setPhase('idle');
      return;
    }
    // stopAndPersist es atómico dentro de ChatSession: bloquea el onDone tardío
    // y devuelve el mensaje persistido (o null si no había buffer).
    void handle.stopAndPersist().then((saved) => {
      if (saved) setMessages([...s.messages]);
      setAssistantPartial('');
      setPhase('idle');
      void refresh();
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const configured = status?.configured === true;
  const providerLabel = status?.configured ? `${status.provider} · ${status.model ?? ''}` : 'no configurado';

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4 md:h-[calc(100vh-6rem)] md:flex-row">
      {/* Sidebar de conversaciones */}
      <aside className="glass flex max-h-64 shrink-0 flex-col rounded-2xl border border-white/40 p-3 md:max-h-none md:w-72 dark:border-white/5">
        <div className="mb-3 flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-cyan-500 text-white shadow-pop">
            <IconChat size={18} />
          </div>
          <div>
            <div className="text-sm font-bold">Chat IA</div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-slate-500">
              {providerLabel}
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowPresetPicker((v) => !v)}
          className="mb-2 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-cyan-500 px-3 py-2 text-sm font-semibold text-white shadow-pop transition hover:opacity-90"
        >
          <IconPlus size={16} /> Nuevo chat
        </button>
        <AnimatePresence>
          {showPresetPicker && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 space-y-1 overflow-hidden"
            >
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => void newChat(p.id)}
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-left text-xs transition hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-white/5"
                >
                  <div className="font-semibold">{p.label}</div>
                  <div className="text-[10px] text-slate-500">{p.hint}</div>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {chats.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500 dark:border-slate-700">
              Sin chats. Crea uno para empezar.
            </div>
          )}
          {chats.map((c) => {
            const active = c.id === session?.chat.id;
            return (
              <button
                key={c.id}
                onClick={() => void openChat(c.id)}
                className={`group flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition ${
                  active
                    ? 'bg-gradient-to-r from-brand-500/10 to-transparent text-brand-700 dark:text-brand-300'
                    : 'hover:bg-slate-900/5 dark:hover:bg-white/5'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{c.title || 'Sin título'}</div>
                  <div className="flex items-center gap-1 text-[10px] uppercase text-slate-500">
                    <span>{c.preset}</span>
                    <span>·</span>
                    <span>{c.messageCount} msg</span>
                  </div>
                </div>
                <span
                  onClick={(e) => void deleteChat(c.id, e)}
                  className="rounded p-1 text-slate-400 opacity-0 transition hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                  role="button"
                  aria-label="Borrar"
                >
                  <IconTrash size={14} />
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Área de chat */}
      <section className="glass flex min-h-0 flex-1 flex-col rounded-2xl border border-white/40 dark:border-white/5">
        {!configured && (
          <div className="rounded-t-2xl border-b border-amber-300/60 bg-amber-100/60 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            <b>IA no configurada.</b> Edita el archivo <code>.env</code> del proyecto:
            {' '}
            <code>AI_PROVIDER=openai</code> y <code>OPENAI_API_KEY=sk-...</code>, luego reinicia el server.
          </div>
        )}
        {session && (
          <header className="flex items-center justify-between border-b border-slate-200/60 px-4 py-3 dark:border-white/5">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold">{session.chat.title}</div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500">
                {session.chat.preset} · {session.chat.messageCount} mensajes
                {session.chat.totalCostUsd
                  ? ` · $${session.chat.totalCostUsd.toFixed(4)}`
                  : ''}
              </div>
            </div>
            <select
              value={session.chat.preset}
              onChange={(e) => void changePreset(e.target.value as ChatPresetLocal)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </header>
        )}
        {session?.chat.preset === 'custom' && (
          <div className="border-b border-slate-200/60 p-3 dark:border-white/5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
              System prompt custom
            </label>
            <textarea
              value={customSystem}
              onChange={(e) => setCustomSystem(e.target.value)}
              onBlur={() => void changePreset('custom')}
              rows={2}
              placeholder="Ej: 'Eres un experto en Terraform. Responde en español con ejemplos.'"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {!session && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 text-white shadow-glow">
                <IconSparkle size={28} />
              </div>
              <h2 className="text-xl font-bold">Chat con IA</h2>
              <p className="max-w-md text-sm text-slate-500">
                Empieza escribiendo abajo o crea un chat con un preset (inglés, AWS, o custom).
                El contexto se mantiene entre turnos y se guarda local en tu navegador.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} m={m} />
          ))}
          {phase === 'streaming' && (
            <MessageBubble
              m={{
                id: 'partial',
                chatId: session?.chat.id ?? '',
                role: 'assistant',
                content: assistantPartial || '…',
                createdAt: new Date().toISOString(),
              }}
              live
            />
          )}
          {error && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-slate-200/60 p-3 dark:border-white/5">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={configured ? 'Escribe tu mensaje. Enter para enviar, Shift+Enter salto de línea.' : 'Configura la API key primero…'}
              rows={2}
              disabled={!configured}
              className="min-h-[44px] flex-1 resize-none rounded-xl border border-slate-300 bg-white p-2 text-sm outline-none transition focus:border-brand-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
            />
            {phase === 'streaming' ? (
              <button
                onClick={stop}
                className="grid h-11 w-11 place-items-center rounded-xl bg-red-500 text-white shadow-pop transition hover:bg-red-600"
                aria-label="Parar"
              >
                <IconStop size={16} />
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={!input.trim() || !configured}
                className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-cyan-500 text-white shadow-pop transition hover:opacity-90 disabled:opacity-40"
                aria-label="Enviar"
              >
                <IconSend size={16} />
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function MessageBubble({ m, live }: { m: ChatMessage; live?: boolean }) {
  const isUser = m.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm ${
          isUser
            ? 'bg-gradient-to-br from-brand-500 to-cyan-500 text-white'
            : 'border border-slate-200 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
        }`}
      >
        {m.content}
        {live && <span className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-current align-middle" />}
      </div>
    </div>
  );
}

function humanizeError(err: Error): string {
  const msg = err.message || '';
  if (msg.includes('CHAT_DELETED')) return 'El chat fue borrado. Crea uno nuevo.';
  if (msg.includes('AI_UNAVAILABLE')) return 'IA no configurada. Añade la API key en .env y reinicia el server.';
  if (msg.includes('RATE_LIMITED')) return 'Demasiadas peticiones. Espera un minuto.';
  if (msg.includes('BUDGET_EXCEEDED')) return 'Presupuesto diario superado para esta sesión.';
  if (msg.includes('HTTP 401') || msg.includes(' 401')) return 'API key inválida. Revisa .env.';
  return msg || 'Error desconocido';
}

function isAbortError(err: Error): boolean {
  return err.name === 'AbortError' || /aborted?/i.test(err.message);
}
