import { describe, it, expect } from 'vitest';
import { normalizeForCompare, wordMatchStats, extractJson } from './index.js';

describe('normalizeForCompare', () => {
  it('quita puntuación y acentos', () => {
    expect(normalizeForCompare("¡Hola! ¿Cómo estás?")).toBe('hola como estas');
  });
});

describe('wordMatchStats', () => {
  it('cuenta coincidencias ignorando puntuación', () => {
    const r = wordMatchStats('I love coffee.', 'i love coffee');
    expect(r.matched).toBe(3);
    expect(r.total).toBe(3);
    expect(r.missing).toEqual([]);
  });
  it('detecta faltantes', () => {
    const r = wordMatchStats('I love coffee', 'love');
    expect(r.matched).toBe(1);
    expect(r.missing).toEqual(['i', 'coffee']);
  });
});

describe('extractJson', () => {
  it('extrae objeto de texto ruidoso', () => {
    const j = extractJson<{ ok: boolean }>('preface {"ok":true} trailing');
    expect(j?.ok).toBe(true);
  });
  it('devuelve null en basura', () => {
    expect(extractJson('nope')).toBeNull();
  });
});
