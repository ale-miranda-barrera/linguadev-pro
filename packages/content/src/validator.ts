import { PackSchemaV2, type Pack } from '@linguadev/shared';
import { migrate } from './migrators/index.js';

export type ValidationResult =
  | { ok: true; pack: Pack }
  | { ok: false; error: string; issues?: unknown };

export function validatePack(input: unknown): ValidationResult {
  const migrated = migrate(input);
  if (!migrated.ok) return migrated;
  const parsed = PackSchemaV2.safeParse(migrated.data);
  if (!parsed.success) {
    return { ok: false, error: 'invalid pack shape', issues: parsed.error.flatten() };
  }
  // Dedupe por id preservando el primero (evita conflictos si viene con ids repetidos).
  const seen = new Set<string>();
  parsed.data.vocab = parsed.data.vocab.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
  return { ok: true, pack: parsed.data };
}

export function validatePackJson(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  return validatePack(parsed);
}
