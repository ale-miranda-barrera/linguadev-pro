import { v1ToV2 } from './v1-to-v2.js';

export const LATEST_SCHEMA_VERSION = 2 as const;

export type MigrationResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export function migrate(input: unknown): MigrationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'pack must be an object' };
  }
  const obj = input as Record<string, unknown>;
  const version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1;
  if (version === LATEST_SCHEMA_VERSION) return { ok: true, data: obj };
  if (version === 1) return { ok: true, data: v1ToV2(obj) };
  return { ok: false, error: `unsupported schemaVersion: ${version}` };
}
