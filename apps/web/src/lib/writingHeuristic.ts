// Feedback local para escritura sin IA. Heurísticas simples: cuenta de palabras, capitalización,
// puntuación, palabras adyacentes repetidas y errores comunes de nivel A2-B1. No pretende sustituir
// una corrección real; da feedback útil cuando el usuario está offline o no tiene IA configurada.

export interface LocalWritingIssue {
  kind: 'style' | 'grammar' | 'spelling';
  message: string;
  hint?: string;
}

export interface LocalWritingResult {
  wordCount: number;
  meetsMinWords: boolean;
  score: number; // 0-100 estimado
  issues: LocalWritingIssue[];
}

// Errores frecuentes de hispanohablantes A2/B1.
const COMMON_MISTAKES: Array<{ pattern: RegExp; message: string; hint?: string }> = [
  { pattern: /\bi\b/g, message: '"i" debe ir en mayúscula: "I".', hint: 'Siempre "I" en inglés.' },
  { pattern: /\bim\b/gi, message: '"im" debería ser "I\'m".' },
  { pattern: /\bdont\b/gi, message: '"dont" → "don\'t".' },
  { pattern: /\bdoesnt\b/gi, message: '"doesnt" → "doesn\'t".' },
  { pattern: /\bcant\b/gi, message: '"cant" → "can\'t".' },
  { pattern: /\bpeople is\b/gi, message: '"people" es plural: usa "people are".' },
  { pattern: /\bmore better\b/gi, message: '"more better" es redundante: usa "better".' },
  { pattern: /\bmore easy\b/gi, message: '"more easy" → "easier".' },
  { pattern: /\bmuch fun\b/gi, message: '"much fun" → "a lot of fun".' },
  { pattern: /\bthe last night\b/gi, message: '"the last night" → "last night" (sin the).' },
  { pattern: /\byesterday I go\b/gi, message: 'Con "yesterday" usa pasado: "I went".' },
];

export function evaluateWriting(text: string, minWords = 40): LocalWritingResult {
  const clean = text.trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const issues: LocalWritingIssue[] = [];

  if (wordCount < minWords) {
    issues.push({
      kind: 'style',
      message: `Muy corto: ${wordCount} palabras (objetivo ~${minWords}).`,
      hint: 'Amplía con un ejemplo o una segunda idea.',
    });
  }

  // Primera letra en mayúscula.
  if (clean && !/^[A-Z]/.test(clean)) {
    issues.push({ kind: 'grammar', message: 'Empieza con mayúscula.' });
  }

  // Puntuación final.
  if (clean && !/[.!?]$/.test(clean)) {
    issues.push({ kind: 'grammar', message: 'Cierra tus oraciones con "." "!" o "?".' });
  }

  // Palabras repetidas adyacentes ("the the").
  for (let i = 1; i < words.length; i++) {
    const prev = (words[i - 1] ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const cur = (words[i] ?? '').toLowerCase().replace(/[^a-z]/g, '');
    if (prev && prev === cur) {
      issues.push({ kind: 'spelling', message: `Palabra duplicada: "${prev} ${cur}".` });
      break;
    }
  }

  for (const { pattern, message, hint } of COMMON_MISTAKES) {
    if (pattern.test(clean)) {
      issues.push({ kind: 'grammar', message, ...(hint ? { hint } : {}) });
    }
  }

  // Score bruto: base según word count, penaliza cada issue.
  const meetsMinWords = wordCount >= minWords;
  const base = meetsMinWords ? 80 : Math.round((wordCount / minWords) * 60);
  const penalty = Math.min(60, issues.length * 8);
  const score = Math.max(0, Math.min(100, base - penalty));

  return { wordCount, meetsMinWords, score, issues };
}
