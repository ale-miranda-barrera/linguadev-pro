import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import type { CEFRLevel, Question, QuestionType } from '@linguadev/shared';
import { PackSchemaV2 } from '@linguadev/shared';
import { db } from '../../db/dexie.js';
import type { StoredPack } from '../../db/dexie.js';
import { QuestionRunner } from '../../components/questions/QuestionRunner.js';
import {
  IconCards,
  IconChevronRight,
  IconPencil,
  IconPlay,
  IconSparkle,
  IconTarget,
  IconTrash,
  IconTrophy,
} from '../../components/Icons.js';
import { hasTts, speak } from '../../lib/speech.js';
import { compressImageToDataUrl } from '../../lib/imageCompress.js';

const LEVELS: CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const TYPE_OPTIONS: Array<{ id: QuestionType; label: string; emoji: string; hint: string }> = [
  { id: 'multiple-choice', label: 'Opción múltiple', emoji: '🎯', hint: '1 correcta, 3 distractores' },
  { id: 'true-false', label: 'Bien / Mal', emoji: '✓', hint: '¿Es correcta esta frase?' },
  { id: 'dictation', label: 'Dictado', emoji: '🔊', hint: 'TTS + escribir lo escuchado' },
  { id: 'match', label: 'Emparejar', emoji: '🧩', hint: 'Pares término-traducción' },
  { id: 'speaking', label: 'Hablar', emoji: '🎙', hint: 'Leer en voz alta' },
];

export function CreatePack() {
  const nav = useNavigate();
  const [customPacks, setCustomPacks] = useState<StoredPack[]>([]);
  const [editing, setEditing] = useState<StoredPack | null>(null);

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    const all = await db.packs.toArray();
    setCustomPacks(all.filter((p) => p.custom));
  }

  function newPack() {
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
    setEditing({
      schemaVersion: 2,
      id,
      title: 'Mi pack sin nombre',
      level: 'A2',
      language: 'en',
      description: '',
      vocab: [],
      listening: [],
      speaking: [],
      writing: [],
      grammar: [],
      questions: [],
      custom: true,
      enabled: true,
      installedAt: new Date().toISOString(),
    });
  }

  async function deletePack(id: string) {
    await db.packs.delete(id);
    void reload();
  }

  if (editing) {
    return (
      <PackEditor
        pack={editing}
        onSave={async (p) => {
          await db.packs.put(p);
          setEditing(null);
          void reload();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header>
        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Crear contenido</div>
        <h1 className="mt-1 flex items-center gap-2 text-3xl font-black tracking-tight">
          <span className="inline-grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-pink-500 text-white shadow-pop">
            <IconPencil size={22} />
          </span>
          Constructor de packs
        </h1>
        <p className="text-xs text-slate-500">
          Arma tus propias sesiones con los 5 tipos de pregunta. Guardadas localmente.
        </p>
      </header>

      <button
        onClick={newPack}
        className="w-full rounded-2xl bg-gradient-to-r from-brand-500 to-pink-500 py-3 text-sm font-bold text-white shadow-pop"
      >
        + Nuevo pack
      </button>

      <div>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
          Mis packs ({customPacks.length})
        </h3>
        {customPacks.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-300/70 p-6 text-center text-sm text-slate-500 dark:border-white/10">
            Aún no has creado ningún pack.
          </p>
        ) : (
          <ul className="space-y-2">
            {customPacks.map((p) => (
              <li
                key={p.id}
                className="glass flex items-center gap-3 rounded-2xl border border-white/60 p-3 dark:border-white/5"
              >
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-pink-500 text-white">
                  <IconCards size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-bold">{p.title}</p>
                  <p className="text-xs text-slate-500">
                    {p.level} · {p.questions?.length ?? 0} preguntas
                  </p>
                </div>
                <button
                  onClick={() => setEditing(p)}
                  className="rounded-lg bg-brand-500/10 px-3 py-1.5 text-xs font-bold text-brand-700 dark:text-brand-300"
                >
                  Editar
                </button>
                <button
                  onClick={() => nav('/vocab')}
                  className="rounded-lg bg-success-500/10 px-3 py-1.5 text-xs font-bold text-success-700 dark:text-success-400"
                >
                  Jugar
                </button>
                <button
                  onClick={() => void deletePack(p.id)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-danger-500/10 hover:text-danger-600"
                >
                  <IconTrash size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Editor principal ───

function PackEditor({
  pack,
  onSave,
  onCancel,
}: {
  pack: StoredPack;
  onSave: (p: StoredPack) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<StoredPack>(pack);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addQuestion(type: QuestionType) {
    const q = defaultQuestion(type);
    setDraft((d) => ({ ...d, questions: [...(d.questions ?? []), q] }));
  }

  function updateQuestion(i: number, patch: Partial<Question>) {
    setDraft((d) => {
      const qs = [...(d.questions ?? [])];
      qs[i] = { ...qs[i]!, ...patch } as Question;
      return { ...d, questions: qs };
    });
  }

  function deleteQuestion(i: number) {
    setDraft((d) => ({ ...d, questions: (d.questions ?? []).filter((_, k) => k !== i) }));
  }

  async function save() {
    setError(null);
    // Valida con Zod antes de guardar.
    const { custom, enabled, installedAt, ...packPart } = draft;
    const parsed = PackSchemaV2.safeParse(packPart);
    if (!parsed.success) {
      setError(JSON.stringify(parsed.error.flatten(), null, 2));
      return;
    }
    await onSave({ ...parsed.data, custom, enabled, installedAt });
  }

  if (previewing) {
    const questions = (draft.questions ?? []) as Question[];
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <button
          onClick={() => setPreviewing(false)}
          className="text-xs font-semibold text-slate-500 hover:text-brand-600"
        >
          ← Volver al editor
        </button>
        <h1 className="text-2xl font-black">Vista previa: {draft.title}</h1>
        {questions.length === 0 ? (
          <p className="text-sm text-slate-500">Añade preguntas antes de previsualizar.</p>
        ) : (
          <QuestionRunner questions={questions} title="preview" />
        )}
      </div>
    );
  }

  const qs = (draft.questions ?? []) as Question[];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={onCancel}
          className="text-xs font-semibold text-slate-500 hover:text-brand-600"
        >
          ← Cancelar
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => setPreviewing(true)}
            disabled={qs.length === 0}
            className="rounded-xl border border-slate-300/70 px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-40 dark:border-white/10 dark:text-slate-200"
          >
            <IconPlay size={12} className="inline" /> Preview
          </button>
          <button
            onClick={() => void save()}
            className="rounded-xl bg-gradient-to-r from-brand-500 to-pink-500 px-4 py-1.5 text-xs font-bold text-white shadow-pop"
          >
            Guardar
          </button>
        </div>
      </div>

      <div className="glass space-y-3 rounded-3xl border border-white/60 p-4 dark:border-white/5">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Título</span>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white/70 p-2 text-lg font-bold dark:border-white/10 dark:bg-slate-900"
          />
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Nivel</span>
          <div className="mt-1 grid grid-cols-6 gap-1">
            {LEVELS.map((l) => (
              <button
                key={l}
                onClick={() => setDraft((d) => ({ ...d, level: l }))}
                className={`rounded-lg py-1.5 text-xs font-bold ${
                  draft.level === l
                    ? 'bg-gradient-to-r from-brand-500 to-cyan-500 text-white shadow-pop'
                    : 'bg-slate-100 text-slate-500 dark:bg-white/5'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Descripción</span>
          <textarea
            value={draft.description ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            rows={2}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white/70 p-2 text-sm dark:border-white/10 dark:bg-slate-900"
          />
        </label>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">
          Preguntas ({qs.length})
        </h3>
        <ul className="space-y-2">
          {qs.map((q, i) => (
            <QuestionEditor
              key={q.id}
              question={q}
              onChange={(patch) => updateQuestion(i, patch)}
              onDelete={() => deleteQuestion(i)}
            />
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Añadir pregunta</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {TYPE_OPTIONS.map((t) => (
            <button
              key={t.id}
              onClick={() => addQuestion(t.id)}
              className="glass flex flex-col items-center gap-1 rounded-2xl border border-white/60 p-3 text-center transition hover:-translate-y-0.5 hover:shadow-glow dark:border-white/5"
            >
              <span className="text-2xl">{t.emoji}</span>
              <span className="text-[11px] font-bold">{t.label}</span>
              <span className="text-[9px] text-slate-500">{t.hint}</span>
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <pre className="whitespace-pre-wrap rounded-xl border border-danger-500/30 bg-danger-500/5 p-3 text-xs text-danger-600">
          {error}
        </pre>
      ) : null}
    </div>
  );
}

// ─── Editor por pregunta (cambia según el type) ───

function QuestionEditor({
  question,
  onChange,
  onDelete,
}: {
  question: Question;
  onChange: (patch: Partial<Question>) => void;
  onDelete: () => void;
}) {
  const typeMeta = TYPE_OPTIONS.find((t) => t.id === question.type)!;

  async function pickImage(file: File) {
    // Comprime siempre: downscale a 800px + JPEG 80% queda alrededor de 30-100KB.
    try {
      const dataUrl = await compressImageToDataUrl(file, { maxDim: 800, quality: 0.8 });
      onChange({ image: dataUrl } as Partial<Question>);
    } catch (err) {
      alert(`No pude cargar la imagen: ${(err as Error).message}`);
    }
  }

  return (
    <li className="glass rounded-2xl border border-white/60 p-3 dark:border-white/5">
      <div className="mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-xs font-bold">
          <span className="text-lg">{typeMeta.emoji}</span>
          <span className="uppercase tracking-wider text-slate-500">{typeMeta.label}</span>
        </span>
        <button
          onClick={onDelete}
          className="rounded p-1 text-slate-400 hover:bg-danger-500/10 hover:text-danger-600"
        >
          <IconTrash size={14} />
        </button>
      </div>

      {/* Campos comunes */}
      <input
        type="text"
        placeholder="Enunciado (opcional)"
        value={question.prompt ?? ''}
        onChange={(e) => onChange({ prompt: e.target.value })}
        className="w-full rounded-lg border border-slate-200 bg-white/70 p-2 text-xs dark:border-white/10 dark:bg-slate-900"
      />

      {/* Imagen */}
      <div className="mt-2 flex items-center gap-2">
        <label className="cursor-pointer rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 dark:bg-white/5 dark:text-slate-300">
          📷 Imagen
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickImage(f);
            }}
          />
        </label>
        {question.image ? (
          <>
            <img src={question.image} alt="" className="h-10 w-10 rounded object-cover" />
            <button
              onClick={() => onChange({ image: undefined } as Partial<Question>)}
              className="text-[10px] text-danger-500"
            >
              Quitar
            </button>
          </>
        ) : null}
      </div>

      <div className="mt-2 space-y-2">
        {question.type === 'multiple-choice' ? (
          <MCEditor q={question} onChange={onChange} />
        ) : question.type === 'true-false' ? (
          <TFEditor q={question} onChange={onChange} />
        ) : question.type === 'dictation' ? (
          <DictationEditor q={question} onChange={onChange} />
        ) : question.type === 'match' ? (
          <MatchEditor q={question} onChange={onChange} />
        ) : (
          <SpeakingEditor q={question} onChange={onChange} />
        )}
      </div>
    </li>
  );
}

function MCEditor({
  q,
  onChange,
}: {
  q: Extract<Question, { type: 'multiple-choice' }>;
  onChange: (patch: Partial<Question>) => void;
}) {
  return (
    <>
      <input
        type="text"
        placeholder="Pregunta (ej: ¿Qué significa 'meeting'?)"
        value={q.question}
        onChange={(e) => onChange({ question: e.target.value } as Partial<Question>)}
        className="w-full rounded-lg border border-slate-200 bg-white/70 p-2 text-xs font-semibold dark:border-white/10 dark:bg-slate-900"
      />
      {q.options.map((opt, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="radio"
            checked={q.correctIndex === i}
            onChange={() => onChange({ correctIndex: i } as Partial<Question>)}
            className="accent-success-500"
          />
          <input
            type="text"
            placeholder={`Opción ${String.fromCharCode(65 + i)}`}
            value={opt}
            onChange={(e) => {
              const opts = [...q.options];
              opts[i] = e.target.value;
              onChange({ options: opts } as Partial<Question>);
            }}
            className="flex-1 rounded-lg border border-slate-200 bg-white/70 p-2 text-xs dark:border-white/10 dark:bg-slate-900"
          />
          {q.options.length > 2 ? (
            <button
              onClick={() => {
                const opts = q.options.filter((_, k) => k !== i);
                onChange({ options: opts, correctIndex: Math.min(q.correctIndex, opts.length - 1) } as Partial<Question>);
              }}
              className="text-danger-500"
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
      {q.options.length < 6 ? (
        <button
          onClick={() => onChange({ options: [...q.options, ''] } as Partial<Question>)}
          className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 dark:bg-white/5"
        >
          + Añadir opción
        </button>
      ) : null}
    </>
  );
}

function TFEditor({
  q,
  onChange,
}: {
  q: Extract<Question, { type: 'true-false' }>;
  onChange: (patch: Partial<Question>) => void;
}) {
  return (
    <>
      <input
        type="text"
        placeholder="Afirmación (ej: 'meeting' significa 'reunión')"
        value={q.statement}
        onChange={(e) => onChange({ statement: e.target.value } as Partial<Question>)}
        className="w-full rounded-lg border border-slate-200 bg-white/70 p-2 text-xs dark:border-white/10 dark:bg-slate-900"
      />
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={q.correct}
          onChange={(e) => onChange({ correct: e.target.checked } as Partial<Question>)}
          className="accent-success-500"
        />
        Es correcta
      </label>
    </>
  );
}

function DictationEditor({
  q,
  onChange,
}: {
  q: Extract<Question, { type: 'dictation' }>;
  onChange: (patch: Partial<Question>) => void;
}) {
  return (
    <>
      <textarea
        placeholder="Texto a dictar (se reproduce con TTS)"
        value={q.text}
        onChange={(e) => onChange({ text: e.target.value } as Partial<Question>)}
        rows={2}
        className="w-full rounded-lg border border-slate-200 bg-white/70 p-2 text-xs dark:border-white/10 dark:bg-slate-900"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => hasTts() && void speak(q.text)}
          className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 dark:bg-white/5"
        >
          <IconPlay size={10} className="inline" /> Probar TTS
        </button>
        <label className="flex items-center gap-1 text-[10px] text-slate-500">
          Velocidad
          <input
            type="number"
            min={0.5}
            max={1.5}
            step={0.1}
            value={q.playbackRate ?? 1}
            onChange={(e) => onChange({ playbackRate: Number(e.target.value) } as Partial<Question>)}
            className="w-14 rounded border border-slate-200 bg-white/70 p-1 text-xs dark:border-white/10 dark:bg-slate-900"
          />
        </label>
      </div>
    </>
  );
}

function MatchEditor({
  q,
  onChange,
}: {
  q: Extract<Question, { type: 'match' }>;
  onChange: (patch: Partial<Question>) => void;
}) {
  return (
    <>
      {q.pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Izquierda"
            value={p.left}
            onChange={(e) => {
              const pairs = [...q.pairs];
              pairs[i] = { ...pairs[i]!, left: e.target.value };
              onChange({ pairs } as Partial<Question>);
            }}
            className="flex-1 rounded-lg border border-slate-200 bg-white/70 p-2 text-xs dark:border-white/10 dark:bg-slate-900"
          />
          <IconChevronRight size={14} className="text-slate-400" />
          <input
            type="text"
            placeholder="Derecha"
            value={p.right}
            onChange={(e) => {
              const pairs = [...q.pairs];
              pairs[i] = { ...pairs[i]!, right: e.target.value };
              onChange({ pairs } as Partial<Question>);
            }}
            className="flex-1 rounded-lg border border-slate-200 bg-white/70 p-2 text-xs dark:border-white/10 dark:bg-slate-900"
          />
          {q.pairs.length > 2 ? (
            <button
              onClick={() => onChange({ pairs: q.pairs.filter((_, k) => k !== i) } as Partial<Question>)}
              className="text-danger-500"
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
      {q.pairs.length < 8 ? (
        <button
          onClick={() => onChange({ pairs: [...q.pairs, { left: '', right: '' }] } as Partial<Question>)}
          className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 dark:bg-white/5"
        >
          + Añadir par
        </button>
      ) : null}
    </>
  );
}

function SpeakingEditor({
  q,
  onChange,
}: {
  q: Extract<Question, { type: 'speaking' }>;
  onChange: (patch: Partial<Question>) => void;
}) {
  return (
    <textarea
      placeholder="Frase objetivo (el usuario la dirá en voz alta)"
      value={q.target}
      onChange={(e) => onChange({ target: e.target.value } as Partial<Question>)}
      rows={2}
      className="w-full rounded-lg border border-slate-200 bg-white/70 p-2 text-xs dark:border-white/10 dark:bg-slate-900"
    />
  );
}

function defaultQuestion(type: QuestionType): Question {
  const id = `q-${crypto.randomUUID().slice(0, 8)}`;
  switch (type) {
    case 'multiple-choice':
      return {
        id,
        type: 'multiple-choice',
        question: '',
        options: ['', '', '', ''],
        correctIndex: 0,
      };
    case 'true-false':
      return { id, type: 'true-false', statement: '', correct: true };
    case 'dictation':
      return { id, type: 'dictation', text: '', playbackRate: 1 };
    case 'match':
      return {
        id,
        type: 'match',
        pairs: [
          { left: '', right: '' },
          { left: '', right: '' },
        ],
      };
    case 'speaking':
      return { id, type: 'speaking', target: '' };
  }
}
