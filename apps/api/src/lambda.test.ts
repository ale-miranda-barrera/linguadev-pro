import { describe, it, expect } from 'vitest';
import { isSsePath } from './lambda.js';

describe('lambda.isSsePath', () => {
  it('reconoce /api/ai/tutor como SSE', () => {
    expect(isSsePath('/api/ai/tutor')).toBe(true);
  });

  it('reconoce /api/ai/chat como SSE (regresión: en Lambda no streameaba en prod)', () => {
    expect(isSsePath('/api/ai/chat')).toBe(true);
  });

  it('NO trata /api/ai/chat/title como SSE (devuelve JSON)', () => {
    expect(isSsePath('/api/ai/chat/title')).toBe(false);
  });

  it('NO trata /api/ai/writing/correct como SSE', () => {
    expect(isSsePath('/api/ai/writing/correct')).toBe(false);
  });

  it('NO trata /api/ai/status como SSE', () => {
    expect(isSsePath('/api/ai/status')).toBe(false);
  });

  it('trata undefined y strings vacíos como no-SSE', () => {
    expect(isSsePath(undefined)).toBe(false);
    expect(isSsePath('')).toBe(false);
  });
});
