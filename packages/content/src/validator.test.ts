import { describe, it, expect } from 'vitest';
import { validatePack, validatePackJson } from './validator.js';
import { loadBundledPacks } from './loader.js';

describe('validator', () => {
  it('acepta packs bundled', () => {
    const packs = loadBundledPacks();
    expect(packs.length).toBeGreaterThan(0);
  });

  it('rechaza JSON inválido', () => {
    const r = validatePackJson('{ not json');
    expect(r.ok).toBe(false);
  });

  it('rechaza pack sin id', () => {
    const r = validatePack({ schemaVersion: 2, title: 'x', level: 'A2', language: 'en' });
    expect(r.ok).toBe(false);
  });

  it('rechaza contenido con <script>', () => {
    const r = validatePack({
      schemaVersion: 2,
      id: 'p',
      title: '<script>alert(1)</script>',
      level: 'A2',
      language: 'en',
      vocab: [],
    });
    expect(r.ok).toBe(false);
  });

  it('migra pack v1 a v2', () => {
    const r = validatePack({
      schemaVersion: 1,
      id: 'legacy',
      title: 'Legacy',
      level: 'A2',
      words: [{ id: 'w-1', en: 'cat', es: 'gato' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pack.vocab[0]?.term).toBe('cat');
      expect(r.pack.vocab[0]?.translation).toBe('gato');
    }
  });
});
