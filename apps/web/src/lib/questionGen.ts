// Genera Question[] a partir de packs bundled. Se usa en el modo Mix y como fallback
// para el modo Quiz. Combina los 5 tipos según lo que el pack ofrezca.

import type { Pack, Question } from '@linguadev/shared';
import type { StoredPack } from '../db/dexie.js';

interface GenOpts {
  count: number;
  // Habilitar/deshabilitar tipos individualmente. Todos true por defecto.
  types?: {
    multipleChoice?: boolean;
    trueFalse?: boolean;
    dictation?: boolean;
    match?: boolean;
    speaking?: boolean;
  };
}

const DEFAULT_TYPES = {
  multipleChoice: true,
  trueFalse: true,
  dictation: true,
  match: true,
  speaking: true,
};

export function generateMixedQuestions(packs: (Pack | StoredPack)[], opts: GenOpts): Question[] {
  const types = { ...DEFAULT_TYPES, ...(opts.types ?? {}) };
  const enabled = packs.filter((p) => (p as StoredPack).enabled !== false);
  const allVocab = enabled.flatMap((p) =>
    p.vocab.map((v: Pack['vocab'][number]) => ({ ...v, packTitle: p.title })),
  );
  const allListening = enabled.flatMap((p) => p.listening);
  const allSpeaking = enabled.flatMap((p) => p.speaking);
  const allCustom = enabled.flatMap((p) => p.questions ?? []);

  const pool: Question[] = [];

  // Empieza con las preguntas custom (packs creados por el usuario) — son primera prioridad.
  pool.push(...allCustom);

  if (types.multipleChoice && allVocab.length >= 4) {
    for (const v of allVocab) {
      const distractors = allVocab
        .filter((x) => x.id !== v.id && x.translation !== v.translation)
        .sort(() => Math.random() - 0.5)
        .slice(0, 3)
        .map((x) => x.translation);
      const options = [v.translation, ...distractors].sort(() => Math.random() - 0.5);
      pool.push({
        id: `mc-${v.id}`,
        type: 'multiple-choice',
        prompt: `¿Qué significa "${v.term}"?`,
        question: v.term,
        options,
        correctIndex: options.indexOf(v.translation),
        explanation: v.example,
        hint: v.emoji,
      });
    }
  }

  if (types.trueFalse && allVocab.length >= 2) {
    for (const v of allVocab) {
      const wrong = allVocab.filter((x) => x.id !== v.id)[Math.floor(Math.random() * (allVocab.length - 1))];
      const showCorrect = Math.random() < 0.5;
      const shown = showCorrect ? v.translation : wrong?.translation ?? v.translation;
      pool.push({
        id: `tf-${v.id}-${showCorrect}`,
        type: 'true-false',
        prompt: `¿Es correcta esta traducción?`,
        statement: `"${v.term}" → "${shown}"`,
        correct: showCorrect,
        explanation: showCorrect ? undefined : `La traducción correcta es "${v.translation}".`,
      });
    }
  }

  if (types.dictation) {
    for (const l of allListening) {
      if (l.kind !== 'dictation') continue;
      pool.push({
        id: `dic-${l.id}`,
        type: 'dictation',
        text: l.text,
        playbackRate: 1,
      });
    }
  }

  if (types.match && allVocab.length >= 4) {
    // Genera grupos de 4 términos para emparejar.
    const shuffled = [...allVocab].sort(() => Math.random() - 0.5);
    for (let i = 0; i + 4 <= shuffled.length; i += 4) {
      const group = shuffled.slice(i, i + 4);
      pool.push({
        id: `match-${i}-${group[0]?.id ?? 'x'}`,
        type: 'match',
        pairs: group.map((v) => ({ left: v.term, right: v.translation })),
      });
    }
  }

  if (types.speaking) {
    for (const s of allSpeaking) {
      pool.push({
        id: `sp-${s.id}`,
        type: 'speaking',
        target: s.target,
        hint: s.hint,
      });
    }
  }

  // Baraja y recorta.
  return pool.sort(() => Math.random() - 0.5).slice(0, opts.count);
}
