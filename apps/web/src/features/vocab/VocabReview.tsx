import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePacksStore } from '../../stores/packs.js';
import { useSrsStore } from '../../stores/srs.js';
import { useProfileStore } from '../../stores/profile.js';
import { EmptyState, LoadingState } from '../../components/UiStates.js';
import { hasTts, speak } from '../../lib/speech.js';
import { SpeakButton } from '../../components/SpeakButton.js';
import { QuestionRunner } from '../../components/questions/QuestionRunner.js';
import { generateMixedQuestions } from '../../lib/questionGen.js';
import {
  IconCards,
  IconCheck,
  IconChevronRight,
  IconPlay,
  IconSparkle,
  IconTarget,
  IconTrophy,
} from '../../components/Icons.js';

type Mode = 'flashcards' | 'quiz' | 'test' | 'mix';

interface Card {
  id: string;
  term: string;
  translation: string;
  example?: string | undefined;
  emoji?: string | undefined;
  ipa?: string | undefined;
}

export function VocabReview() {
  const packs = usePacksStore((s) => s.packs);
  const loaded = usePacksStore((s) => s.loaded);
  const [mode, setMode] = useState<Mode>('flashcards');

  const allCards = useMemo<Card[]>(() => {
    const out: Card[] = [];
    for (const p of packs) {
      if (!p.enabled) continue;
      for (const v of p.vocab) {
        out.push({
          id: v.id,
          term: v.term,
          translation: v.translation,
          example: v.example,
          emoji: v.emoji,
          ipa: v.ipa,
        });
      }
    }
    return out;
  }, [packs]);

  if (!loaded) return <LoadingState label="Cargando cola…" />;
  if (allCards.length === 0) {
    return <EmptyState title="No hay cartas por repasar" hint="Activa más packs desde Ajustes." />;
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Vocabulario</h1>
        <p className="text-xs text-slate-500">Elige tu modo de práctica</p>
      </header>

      <ModeSelector mode={mode} onChange={setMode} />

      {mode === 'flashcards' ? (
        <FlashcardsMode allCards={allCards} />
      ) : mode === 'quiz' ? (
        <QuizMode allCards={allCards} kind="practice" />
      ) : mode === 'test' ? (
        <QuizMode allCards={allCards} kind="test" />
      ) : (
        <MixMode />
      )}
    </div>
  );
}

// Modo Mix: genera N preguntas mezclando los 5 tipos (opción múltiple, verdadero/falso,
// dictado, emparejar, hablar) desde todos los packs habilitados. Configurable.
function MixMode() {
  const packs = usePacksStore((s) => s.packs);
  const [count, setCount] = useState(10);
  const [enabled, setEnabled] = useState({
    multipleChoice: true,
    trueFalse: true,
    dictation: true,
    match: true,
    speaking: true,
  });
  const [session, setSession] = useState<ReturnType<typeof generateMixedQuestions> | null>(null);

  function start() {
    setSession(generateMixedQuestions(packs, { count, types: enabled }));
  }

  if (session) {
    return (
      <div>
        <button
          onClick={() => setSession(null)}
          className="mb-3 text-xs font-semibold text-slate-500 hover:text-brand-600"
        >
          ← Configurar sesión
        </button>
        <QuestionRunner questions={session} title="mix" onFinish={() => setSession(null)} />
      </div>
    );
  }

  const kinds: Array<{ key: keyof typeof enabled; label: string; emoji: string }> = [
    { key: 'multipleChoice', label: 'Opción múltiple', emoji: '🎯' },
    { key: 'trueFalse', label: 'Verdadero/Falso', emoji: '✓' },
    { key: 'dictation', label: 'Dictado', emoji: '🔊' },
    { key: 'match', label: 'Emparejar', emoji: '🧩' },
    { key: 'speaking', label: 'Hablar', emoji: '🎙' },
  ];

  return (
    <div className="glass space-y-4 rounded-3xl border border-white/60 p-5 shadow-soft dark:border-white/5">
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">Cantidad</h3>
        <div className="mt-2 flex items-center gap-3">
          <input
            type="range"
            min={5}
            max={30}
            step={5}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="flex-1"
          />
          <span className="w-8 text-right font-black text-2xl">{count}</span>
        </div>
      </div>
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">Tipos incluidos</h3>
        <ul className="mt-2 grid grid-cols-1 gap-1.5">
          {kinds.map((k) => (
            <li key={k.key}>
              <label className="flex items-center justify-between rounded-xl bg-white/70 p-2.5 text-sm dark:bg-white/5">
                <span className="flex items-center gap-2">
                  <span className="text-lg">{k.emoji}</span>
                  <span className="font-semibold">{k.label}</span>
                </span>
                <input
                  type="checkbox"
                  checked={enabled[k.key]}
                  onChange={(e) =>
                    setEnabled((prev) => ({ ...prev, [k.key]: e.target.checked }))
                  }
                  className="h-5 w-5 accent-brand-500"
                />
              </label>
            </li>
          ))}
        </ul>
      </div>
      <button
        onClick={start}
        disabled={!Object.values(enabled).some(Boolean)}
        className="w-full rounded-2xl bg-gradient-to-r from-brand-500 to-pink-500 py-3 text-sm font-bold text-white shadow-pop disabled:opacity-40"
      >
        Empezar sesión mix
      </button>
      <p className="text-center text-xs text-slate-500">
        Se generan preguntas dinámicamente desde todos tus packs habilitados.
      </p>
    </div>
  );
}

function ModeSelector({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const options: Array<{ id: Mode; label: string; hint: string; Icon: React.ComponentType<{ size?: number }> }> = [
    { id: 'flashcards', label: 'Cards', hint: 'SRS', Icon: IconCards },
    { id: 'quiz', label: 'Quiz', hint: 'MC', Icon: IconSparkle },
    { id: 'test', label: 'Test', hint: '10 q', Icon: IconTrophy },
    { id: 'mix', label: 'Mix', hint: '5 tipos', Icon: IconTarget },
  ];
  return (
    <div className="grid grid-cols-4 gap-1.5 rounded-2xl bg-slate-100/70 p-1 dark:bg-slate-900/50">
      {options.map((o) => {
        const active = mode === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`relative flex flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-xs font-bold transition ${
              active ? 'text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
          >
            {active ? (
              <motion.span
                layoutId="mode-bg"
                className="absolute inset-0 rounded-xl bg-gradient-to-br from-brand-500 to-pink-500 shadow-pop"
              />
            ) : null}
            <span className="relative flex items-center gap-1">
              <o.Icon size={14} />
              {o.label}
            </span>
            <span className={`relative text-[10px] font-medium ${active ? 'text-white/80' : 'text-slate-400'}`}>
              {o.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Flashcards mode: SRS clásico con emoji, TTS y flip ───

function FlashcardsMode({ allCards }: { allCards: Card[] }) {
  const buildQueueFor = useSrsStore((s) => s.buildQueueFor);
  const rate = useSrsStore((s) => s.rate);
  const queue = useSrsStore((s) => s.queue);
  const queueLoaded = useSrsStore((s) => s.loaded);
  const markStudiedToday = useProfileStore((s) => s.markStudiedToday);
  const [showBack, setShowBack] = useState(false);

  const cardIndex = useMemo(() => {
    const map = new Map<string, Card>();
    for (const c of allCards) map.set(c.id, c);
    return map;
  }, [allCards]);

  useEffect(() => {
    void buildQueueFor([...cardIndex.keys()]);
  }, [cardIndex, buildQueueFor]);

  if (!queueLoaded) return <LoadingState label="Preparando cola…" />;
  if (queue.length === 0) {
    return (
      <EmptyState
        title="No hay cartas por repasar hoy"
        hint="Vuelve mañana o prueba el modo Quiz para practicar libre."
      />
    );
  }

  const current = queue[0];
  if (!current) return null;
  const card = cardIndex.get(current.cardId);
  if (!card) {
    void rate(current.cardId, 'good');
    return <LoadingState />;
  }

  return (
    <div>
      <ProgressPill current={1} total={queue.length + 1} label="por repasar" />

      <AnimatePresence mode="wait">
        <motion.button
          key={card.id}
          initial={{ opacity: 0, y: 20, rotateY: -20 }}
          animate={{ opacity: 1, y: 0, rotateY: 0 }}
          exit={{ opacity: 0, y: -20, rotateY: 20 }}
          transition={{ type: 'spring', stiffness: 260, damping: 24 }}
          onClick={() => setShowBack((v) => !v)}
          className="glass mt-3 flex min-h-[280px] w-full flex-col items-center justify-center gap-4 rounded-3xl border border-white/60 p-6 text-center shadow-glow dark:border-white/5"
        >
          <div className="grid h-24 w-24 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-pink-500 text-6xl text-white shadow-pop">
            {card.emoji ?? '🔤'}
          </div>
          <div>
            <p className="text-3xl font-black tracking-tight">
              {showBack ? card.translation : card.term}
            </p>
            {!showBack && card.ipa ? (
              <p className="mt-1 font-mono text-xs text-slate-400">/{card.ipa}/</p>
            ) : null}
            {showBack && card.example ? (
              <p className="mt-2 text-sm italic text-slate-500">"{card.example}"</p>
            ) : null}
          </div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {showBack ? 'Traducción' : 'Toca para ver'}
          </p>
        </motion.button>
      </AnimatePresence>

      <div className="mt-3 flex justify-center">
        <SpeakButton text={card.term} label="Pronunciar" size="md" />
      </div>

      {showBack ? (
        <div className="mt-4 grid grid-cols-4 gap-2">
          {(
            [
              { r: 'again', label: 'De nuevo', bg: 'from-danger-500 to-danger-600' },
              { r: 'hard', label: 'Difícil', bg: 'from-warn-500 to-flame-500' },
              { r: 'good', label: 'Bien', bg: 'from-brand-500 to-pink-500' },
              { r: 'easy', label: 'Fácil', bg: 'from-success-500 to-cyan-500' },
            ] as const
          ).map((b) => (
            <button
              key={b.r}
              onClick={async () => {
                await rate(current.cardId, b.r);
                await markStudiedToday();
                setShowBack(false);
              }}
              className={`rounded-xl bg-gradient-to-br ${b.bg} px-2 py-2.5 text-xs font-bold text-white shadow-pop transition hover:-translate-y-0.5 active:translate-y-0`}
            >
              {b.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-center text-xs text-slate-400">
          Recuerda antes de mostrar la traducción
        </p>
      )}
    </div>
  );
}

// ─── Quiz mode: 4 opciones (multiple choice) ───

interface Question {
  card: Card;
  options: string[]; // 4 traducciones (1 correcta + 3 distractores)
  correctIndex: number;
}

function makeQuestion(target: Card, pool: Card[]): Question {
  const distractors = pool
    .filter((c) => c.id !== target.id && c.translation !== target.translation)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3)
    .map((c) => c.translation);
  const options = [target.translation, ...distractors].sort(() => Math.random() - 0.5);
  return {
    card: target,
    options,
    correctIndex: options.indexOf(target.translation),
  };
}

function QuizMode({ allCards, kind }: { allCards: Card[]; kind: 'practice' | 'test' }) {
  const TEST_SIZE = 10;
  const markStudiedToday = useProfileStore((s) => s.markStudiedToday);
  const rate = useSrsStore((s) => s.rate);

  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Array<{ cardId: string; correct: boolean }>>([]);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    startSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCards, kind]);

  function startSession() {
    const shuffled = [...allCards].sort(() => Math.random() - 0.5);
    const count = kind === 'test' ? Math.min(TEST_SIZE, shuffled.length) : shuffled.length;
    const qs = shuffled.slice(0, count).map((c) => makeQuestion(c, allCards));
    setQuestions(qs);
    setIdx(0);
    setPicked(null);
    setAnswers([]);
    setFinished(false);
  }

  const current = questions[idx];
  const correctCount = answers.filter((a) => a.correct).length;
  const scorePct = questions.length ? Math.round((correctCount / questions.length) * 100) : 0;

  if (finished) {
    return (
      <FinalScore
        correct={correctCount}
        total={questions.length}
        scorePct={scorePct}
        onRestart={startSession}
      />
    );
  }

  if (!current) return <LoadingState />;
  const q = current;

  async function pick(i: number) {
    if (picked !== null) return;
    setPicked(i);
    const isCorrect = i === q.correctIndex;
    setAnswers((a) => [...a, { cardId: q.card.id, correct: isCorrect }]);
    if (kind === 'practice') {
      // En modo práctica actualizamos SRS igual que en flashcards.
      await rate(q.card.id, isCorrect ? 'good' : 'again');
      await markStudiedToday();
    } else {
      await markStudiedToday();
    }
  }

  function next() {
    const isLast = idx >= questions.length - 1;
    if (kind === 'test' && isLast) {
      // En test aplicamos SRS al final.
      void applyTestSrs(answers);
      setFinished(true);
      return;
    }
    if (kind === 'practice' && isLast) {
      // En práctica reciclamos con nuevas preguntas.
      startSession();
      return;
    }
    setIdx((n) => n + 1);
    setPicked(null);
  }

  async function applyTestSrs(final: Array<{ cardId: string; correct: boolean }>) {
    for (const a of final) {
      await rate(a.cardId, a.correct ? 'good' : 'again');
    }
  }

  return (
    <div>
      <ProgressPill current={idx + 1} total={questions.length} label={kind === 'test' ? 'del test' : 'práctica'} />

      <AnimatePresence mode="wait">
        <motion.div
          key={current.card.id}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -30 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          className="mt-3 space-y-4"
        >
          {/* Pregunta */}
          <div className="glass relative overflow-hidden rounded-3xl border border-white/60 p-6 text-center shadow-glow dark:border-white/5">
            <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-brand-500/20 blur-2xl" />
            <p className="relative text-[10px] font-bold uppercase tracking-widest text-slate-500">
              ¿Qué significa?
            </p>
            <div className="relative mx-auto mt-3 grid h-20 w-20 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-pink-500 text-5xl text-white shadow-pop">
              {current.card.emoji ?? '🔤'}
            </div>
            <p className="relative mt-4 text-3xl font-black tracking-tight">{current.card.term}</p>
            {current.card.ipa ? (
              <p className="relative mt-1 font-mono text-xs text-slate-400">/{current.card.ipa}/</p>
            ) : null}
            <div className="relative mt-3 inline-block">
              <SpeakButton text={current.card.term} label="Escuchar" size="sm" />
            </div>
          </div>

          {/* Opciones */}
          <div className="grid gap-2">
            {current.options.map((opt, i) => {
              const isCorrect = picked !== null && i === current.correctIndex;
              const isWrongPick = picked === i && i !== current.correctIndex;
              const revealed = picked !== null;
              return (
                <motion.button
                  key={i}
                  whileTap={{ scale: 0.98 }}
                  disabled={revealed}
                  onClick={() => void pick(i)}
                  className={`flex items-center justify-between rounded-2xl border p-4 text-left text-sm font-semibold transition ${
                    isCorrect
                      ? 'border-success-500 bg-success-500/15 text-success-700 dark:text-success-400'
                      : isWrongPick
                        ? 'border-danger-500 bg-danger-500/10 text-danger-700 dark:text-danger-400'
                        : revealed
                          ? 'border-slate-200 bg-white/50 text-slate-400 dark:border-white/5 dark:bg-white/5'
                          : 'border-slate-200 bg-white/80 hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-glow dark:border-white/5 dark:bg-white/5'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <span
                      className={`grid h-8 w-8 place-items-center rounded-lg font-black ${
                        isCorrect
                          ? 'bg-success-500 text-white'
                          : isWrongPick
                            ? 'bg-danger-500 text-white'
                            : 'bg-slate-100 text-slate-500 dark:bg-white/5'
                      }`}
                    >
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span>{opt}</span>
                  </span>
                  {isCorrect ? <IconCheck size={18} /> : null}
                </motion.button>
              );
            })}
          </div>

          {/* Feedback + next */}
          {picked !== null ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`rounded-2xl border p-4 ${
                picked === current.correctIndex
                  ? 'border-success-500/30 bg-success-500/10'
                  : 'border-danger-500/30 bg-danger-500/10'
              }`}
            >
              <p className="text-sm font-bold">
                {picked === current.correctIndex ? '¡Correcto! 🎉' : `Uy — era "${current.card.translation}"`}
              </p>
              {current.card.example ? (
                <p className="mt-1 text-sm italic text-slate-600 dark:text-slate-300">"{current.card.example}"</p>
              ) : null}
              <button
                onClick={next}
                className="mt-3 inline-flex items-center gap-1 rounded-xl bg-gradient-to-r from-brand-500 to-pink-500 px-4 py-2 text-sm font-bold text-white shadow-pop"
              >
                {kind === 'test' && idx === questions.length - 1 ? 'Ver resultado' : 'Siguiente'}
                <IconChevronRight size={14} />
              </button>
            </motion.div>
          ) : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function ProgressPill({ current, total, label }: { current: number; total: number; label: string }) {
  const pct = Math.round((current / total) * 100);
  return (
    <div className="mt-1">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-500">
          {current} / {total} {label}
        </span>
        <span className="font-mono text-slate-400">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200/60 dark:bg-white/5">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-brand-500 to-pink-500"
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  );
}

// ─── Pantalla final del Test ───

function FinalScore({
  correct,
  total,
  scorePct,
  onRestart,
}: {
  correct: number;
  total: number;
  scorePct: number;
  onRestart: () => void;
}) {
  const tier =
    scorePct >= 90 ? { title: '¡Perfecto!', emoji: '🏆', grad: 'from-success-500 to-cyan-500' } :
    scorePct >= 70 ? { title: '¡Muy bien!', emoji: '⭐', grad: 'from-brand-500 to-cyan-500' } :
    scorePct >= 50 ? { title: 'Buen intento', emoji: '💪', grad: 'from-flame-500 to-brand-500' } :
    { title: 'A seguir practicando', emoji: '🌱', grad: 'from-danger-500 to-flame-500' };

  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 18 }}
      className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${tier.grad} p-8 text-center text-white shadow-pop`}
    >
      {/* mini confetti */}
      {Array.from({ length: 20 }).map((_, i) => (
        <motion.span
          key={i}
          className="absolute h-2 w-2 rounded-sm bg-white/70"
          initial={{ x: '50%', y: '30%', opacity: 1, scale: 0 }}
          animate={{
            x: `${20 + Math.random() * 60}%`,
            y: `${20 + Math.random() * 60}%`,
            rotate: Math.random() * 360,
            opacity: 0,
            scale: 1,
          }}
          transition={{ duration: 1 + Math.random(), delay: Math.random() * 0.2 }}
        />
      ))}
      <div className="relative">
        <div className="text-6xl">{tier.emoji}</div>
        <h2 className="mt-2 text-2xl font-black">{tier.title}</h2>
        <p className="mt-4 text-6xl font-black tabular-nums">{scorePct}</p>
        <p className="mt-1 text-sm font-semibold opacity-90">
          {correct} de {total} correctas
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            onClick={onRestart}
            className="inline-flex items-center gap-1 rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-brand-700 shadow-pop"
          >
            <IconTarget size={14} /> Otro test
          </button>
        </div>
      </div>
    </motion.div>
  );
}
