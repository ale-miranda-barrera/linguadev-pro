import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { TutorLessonResponse, Question } from '@linguadev/shared';
import { useProfileStore } from '../../stores/profile.js';
import { apiJson } from '../../lib/api.js';
import { safeAsync } from '../../lib/safeAsync.js';
import { QuestionRunner } from '../../components/questions/QuestionRunner.js';
import { db } from '../../db/dexie.js';
import { IconBook, IconSparkle, IconTrash } from '../../components/Icons.js';

const TEMPLATES: Array<{ label: string; emoji: string; md: string }> = [
  {
    label: 'Present Perfect',
    emoji: '⏳',
    md: `# Present Perfect

The **present perfect** tense connects the past with the present.
It uses \`have/has + past participle\`.

## Uses
- Experiences without a specific time: *I have visited Rome*.
- Actions started in the past that continue: *She has lived here for 5 years*.
- Recent actions with present relevance: *I have just finished*.

## Signal words
already, yet, ever, never, just, since, for
`,
  },
  {
    label: 'Phrasal verbs',
    emoji: '🔗',
    md: `# Common Phrasal Verbs

Phrasal verbs combine a verb with a preposition/adverb, creating new meaning.

## Examples
- **run out of**: to have no more (*We ran out of milk*).
- **give up**: to quit (*Don't give up*).
- **look up**: to search info (*Look it up online*).
- **figure out**: to solve (*I can't figure this out*).
- **come across**: to meet by chance (*I came across an old friend*).

## Tip
Some are separable (look it up), others aren't (come across it).
`,
  },
  {
    label: 'Modal verbs',
    emoji: '🔑',
    md: `# Modal Verbs of Possibility

Modals express degrees of certainty:

- **must**: strong certainty (*He must be tired*).
- **might / may**: possibility (*It might rain*).
- **could**: possibility or past ability (*It could work*).
- **can't**: negative certainty (*She can't be serious*).

## Rules
- Always followed by base verb (no 'to').
- No -s in third person: *she must go*, not *she musts go*.
`,
  },
];

const EXAMPLE_MD = TEMPLATES[0]!.md;

interface SavedLesson {
  id: string;
  createdAt: string;
  level: string;
  lesson: TutorLessonResponse;
  sourceLen: number;
}

const LESSON_STORE_KEY = 'ld:tutorLessons';

function loadSaved(): SavedLesson[] {
  try {
    const raw = localStorage.getItem(LESSON_STORE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedLesson[];
  } catch {
    return [];
  }
}

function saveLesson(l: SavedLesson) {
  try {
    const cur = loadSaved();
    const next = [l, ...cur.filter((x) => x.id !== l.id)].slice(0, 20);
    localStorage.setItem(LESSON_STORE_KEY, JSON.stringify(next));
  } catch {
    // sin espacio: silencioso
  }
}

function deleteLesson(id: string) {
  try {
    const next = loadSaved().filter((l) => l.id !== id);
    localStorage.setItem(LESSON_STORE_KEY, JSON.stringify(next));
  } catch {
    /* noop */
  }
}

export function Tutor() {
  const level = useProfileStore((s) => s.profile.level);
  const [md, setMd] = useState('');
  const [loading, setLoading] = useState(false);
  const [lesson, setLesson] = useState<TutorLessonResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedLesson[]>([]);
  const [showQuiz, setShowQuiz] = useState(false);

  useEffect(() => {
    setSaved(loadSaved());
  }, []);

  async function analyze() {
    if (md.trim().length < 20) {
      setError('El material es muy corto. Pega al menos 20 caracteres de markdown.');
      return;
    }
    setLoading(true);
    setError(null);
    setLesson(null);
    setShowQuiz(false);

    const r = await safeAsync(() =>
      apiJson<TutorLessonResponse>('/api/ai/tutor-lesson', {
        method: 'POST',
        body: JSON.stringify({ markdown: md, level, language: 'es' }),
      }),
    );
    setLoading(false);
    if (r.ok) {
      setLesson(r.value);
      const rec: SavedLesson = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        level,
        lesson: r.value,
        sourceLen: md.length,
      };
      saveLesson(rec);
      setSaved(loadSaved());
    } else {
      setError(r.error.message);
    }
  }

  async function pickFile(file: File) {
    const text = await file.text();
    setMd(text.slice(0, 20000));
  }

  async function saveLessonAsPack(l: TutorLessonResponse) {
    const id = `tutor-${crypto.randomUUID().slice(0, 8)}`;
    await db.packs.put({
      schemaVersion: 2,
      id,
      title: `📚 ${l.title}`,
      level,
      language: 'en',
      description: l.summary.slice(0, 200),
      vocab: [],
      listening: [],
      speaking: [],
      writing: [],
      grammar: [],
      questions: l.questions,
      custom: true,
      enabled: true,
      installedAt: new Date().toISOString(),
    });
    alert(`Guardado como pack "${l.title}". Ábrelo en Vocab → Mix.`);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
          Modo tutor
        </div>
        <h1 className="mt-1 flex items-center gap-2 text-3xl font-black tracking-tight">
          <span className="inline-grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-cyan-500 to-brand-500 text-white shadow-pop">
            <IconBook size={22} />
          </span>
          Aprende con material propio
        </h1>
        <p className="text-xs text-slate-500">
          Pega un archivo Markdown con lo que quieras aprender. La IA lo analiza y te lo explica con
          ejemplos + un quiz para evaluar si entendiste.
        </p>
      </header>

      {/* Input */}
      {!lesson ? (
        <div className="glass space-y-3 rounded-3xl border border-white/60 p-4 dark:border-white/5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Material (Markdown)
            </label>
            <div className="flex gap-2">
              <label className="cursor-pointer rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 dark:bg-white/5 dark:text-slate-300">
                📎 Subir .md
                <input
                  type="file"
                  accept=".md,.markdown,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void pickFile(f);
                  }}
                />
              </label>
              <div className="flex gap-1">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    onClick={() => setMd(t.md)}
                    className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 dark:bg-white/5 dark:text-slate-300"
                    title={`Cargar plantilla: ${t.label}`}
                  >
                    {t.emoji} {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <textarea
            value={md}
            onChange={(e) => setMd(e.target.value)}
            rows={10}
            placeholder="# Título&#10;&#10;Contenido en markdown…"
            className="w-full rounded-2xl border border-slate-200 bg-white/70 p-3 font-mono text-xs dark:border-white/10 dark:bg-slate-900"
          />
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{md.length.toLocaleString()} caracteres · nivel {level}</span>
            <button
              onClick={() => void analyze()}
              disabled={loading || md.trim().length < 20}
              className="rounded-xl bg-gradient-to-r from-cyan-500 to-brand-500 px-5 py-2 text-sm font-bold text-white shadow-pop disabled:opacity-40"
            >
              {loading ? 'Analizando…' : (
                <>
                  <IconSparkle size={14} className="inline" /> Explicar con IA
                </>
              )}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-danger-500/30 bg-danger-500/5 p-4 text-sm">
          <p className="font-semibold text-danger-600">IA no disponible</p>
          <p className="mt-1 text-slate-600 dark:text-slate-300">{error}</p>
          <p className="mt-2 text-xs text-slate-500">
            Configura ANTHROPIC_API_KEY, OPENAI_API_KEY o DEEPSEEK_API_KEY en el .env del backend.
          </p>
        </div>
      ) : null}

      {/* Lesson result */}
      {lesson && !showQuiz ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <button
            onClick={() => setLesson(null)}
            className="text-xs font-semibold text-slate-500 hover:text-brand-600"
          >
            ← Nueva lección
          </button>

          <div className="glass rounded-3xl border border-white/60 p-6 shadow-glow dark:border-white/5">
            <div className="mb-3 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-cyan-500 to-brand-500 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white">
              <IconSparkle size={10} /> Lección
            </div>
            <h2 className="text-2xl font-black">{lesson.title}</h2>
            <p className="mt-3 whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">
              {lesson.summary}
            </p>
          </div>

          <div className="glass rounded-3xl border border-white/60 p-6 dark:border-white/5">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">
              🔑 Puntos clave
            </h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {lesson.keyPoints.map((k, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-brand-500">•</span>
                  {k}
                </li>
              ))}
            </ul>
          </div>

          <div className="glass rounded-3xl border border-white/60 p-6 dark:border-white/5">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">
              💡 Ejemplos
            </h3>
            <ul className="mt-2 space-y-1.5">
              {lesson.examples.map((e, i) => (
                <li key={i} className="rounded-xl bg-brand-500/5 p-2 text-sm italic text-slate-700 dark:text-slate-200">
                  "{e}"
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setShowQuiz(true)}
              className="flex-1 rounded-2xl bg-gradient-to-r from-brand-500 to-pink-500 py-3 text-sm font-bold text-white shadow-pop"
            >
              Empezar quiz ({lesson.questions.length} preguntas)
            </button>
            <button
              onClick={() => void saveLessonAsPack(lesson)}
              className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-bold text-slate-700 dark:border-white/10 dark:text-slate-200"
              title="Guardar el quiz de esta lección como pack para practicar luego"
            >
              💾 Guardar como pack
            </button>
          </div>
        </motion.div>
      ) : null}

      {lesson && showQuiz ? (
        <div>
          <button
            onClick={() => setShowQuiz(false)}
            className="mb-3 text-xs font-semibold text-slate-500 hover:text-brand-600"
          >
            ← Volver a la lección
          </button>
          <QuestionRunner
            questions={lesson.questions as Question[]}
            title="quiz tutor"
          />
        </div>
      ) : null}

      {/* Historial */}
      {!lesson && saved.length > 0 ? (
        <div>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
            Lecciones anteriores ({saved.length})
          </h3>
          <ul className="space-y-2">
            {saved.map((l) => (
              <li
                key={l.id}
                className="glass flex items-center gap-3 rounded-2xl border border-white/60 p-3 dark:border-white/5"
              >
                <button
                  onClick={() => setLesson(l.lesson)}
                  className="flex-1 text-left"
                >
                  <p className="text-sm font-bold">{l.lesson.title}</p>
                  <p className="text-[11px] text-slate-500">
                    {new Date(l.createdAt).toLocaleString()} · {l.level} · {l.lesson.questions.length} preguntas
                  </p>
                </button>
                <button
                  onClick={() => {
                    deleteLesson(l.id);
                    setSaved(loadSaved());
                  }}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-danger-500/10 hover:text-danger-600"
                >
                  <IconTrash size={16} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
