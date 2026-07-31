export function nowIso(): string {
  return new Date().toISOString();
}

// Devuelve el "día" ISO (YYYY-MM-DD) usando UTC para evitar bugs de zona/DST en streaks.
export function todayUtcIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Normaliza texto para comparaciones de dictado y read-aloud: minúsculas, sin puntuación,
// espacios colapsados. NO altera el original mostrado al usuario.
export function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Compara palabra a palabra y devuelve estadísticas para scoring de habla/dictado.
export function wordMatchStats(
  target: string,
  actual: string,
): { matched: number; total: number; missing: string[]; extra: string[] } {
  const t = normalizeForCompare(target).split(' ').filter(Boolean);
  const a = normalizeForCompare(actual).split(' ').filter(Boolean);
  const setA = new Set(a);
  const setT = new Set(t);
  const matched = t.filter((w) => setA.has(w)).length;
  const missing = t.filter((w) => !setA.has(w));
  const extra = a.filter((w) => !setT.has(w));
  return { matched, total: t.length, missing, extra };
}

// Repara un JSON potencialmente truncado o con basura antes/después (típico de salidas LLM).
export function extractJson<T = unknown>(raw: string): T | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
