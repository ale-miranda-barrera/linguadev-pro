// Migrador de packs v1 → v2. v1 usaba `words` (arreglo simple) y no tenía
// listening/speaking/writing/grammar. Copiamos con defaults sensatos y NO borramos ids existentes.

export function v1ToV2(input: Record<string, unknown>): Record<string, unknown> {
  const words = Array.isArray(input.words) ? (input.words as Array<Record<string, unknown>>) : [];
  const vocab = words.map((w, idx) => ({
    id: typeof w.id === 'string' ? w.id : `v1-${idx}`,
    term: String(w.term ?? w.en ?? ''),
    translation: String(w.translation ?? w.es ?? ''),
    example: typeof w.example === 'string' ? w.example : undefined,
    tags: Array.isArray(w.tags) ? w.tags : [],
  }));

  return {
    schemaVersion: 2,
    id: String(input.id ?? 'pack-migrated'),
    title: String(input.title ?? 'Pack migrado'),
    level: typeof input.level === 'string' ? input.level : 'A2',
    language: 'en',
    description: typeof input.description === 'string' ? input.description : undefined,
    vocab,
    listening: [],
    speaking: [],
    writing: [],
    grammar: [],
    updatedAt: new Date().toISOString(),
  };
}
