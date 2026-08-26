import type { Pack } from '@linguadev/shared';
import { validatePack } from './validator.js';
import fundamentosA2 from './packs/fundamentos-a2.json' with { type: 'json' };
import travelB1 from './packs/travel-b1.json' with { type: 'json' };
import workInterviewB1 from './packs/work-interview-b1.json' with { type: 'json' };
import everydayA2 from './packs/everyday-a2.json' with { type: 'json' };
import techEnglishB1 from './packs/tech-english-b1.json' with { type: 'json' };
import techEnglishCodeReviewB2 from './packs/tech-english-code-review-b2.json' with { type: 'json' };
import techEnglishIncidentB2 from './packs/tech-english-incident-postmortem-b2.json' with { type: 'json' };
import techEnglishDesignReviewC1 from './packs/tech-english-design-review-c1.json' with { type: 'json' };
import techEnglishInterviewC1 from './packs/tech-english-interview-behavioral-c1.json' with { type: 'json' };
import { LEVEL_PACKS } from './packs/levels/index.js';

const BUNDLED = [
  fundamentosA2,
  everydayA2,
  travelB1,
  workInterviewB1,
  techEnglishB1,
  techEnglishCodeReviewB2,
  techEnglishIncidentB2,
  techEnglishDesignReviewC1,
  techEnglishInterviewC1,
] as unknown[];

export function loadBundledPacks(): Pack[] {
  const packs: Pack[] = [];
  for (const raw of BUNDLED) {
    const r = validatePack(raw);
    if (r.ok) packs.push(r.pack);
    else console.warn('[content] pack bundled inválido, se ignora:', r.error);
  }
  return packs;
}

/**
 * Carga los packs de niveles (250 packs: A2 → A2+ → B1 → B2 → B2+).
 * Cada pack = un "nivel" con 15 preguntas mixtas. Ordenados por band + levelOrder.
 */
export function loadLevelPacks(): Pack[] {
  const packs: Pack[] = [];
  for (const raw of LEVEL_PACKS) {
    const r = validatePack(raw);
    if (r.ok) packs.push(r.pack);
    else console.warn('[content] level pack inválido, se ignora:', r.error);
  }
  return packs;
}

/** Todos los packs bundled (temáticos + de nivel). */
export function loadAllPacks(): Pack[] {
  return [...loadBundledPacks(), ...loadLevelPacks()];
}
