#!/usr/bin/env node
// Validates all generated level packs against the Zod schema.
// Usage: node scripts/validate-level-packs.mjs

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEVELS_DIR = join(__dirname, '..', 'packages', 'content', 'src', 'packs', 'levels');
const BANDS = ['a2', 'a2plus', 'b1', 'b2', 'b2plus'];

const REQUIRED_TOP = ['schemaVersion', 'id', 'title', 'level', 'language', 'questions'];
const VALID_TYPES = new Set(['multiple-choice', 'true-false', 'dictation', 'match', 'speaking']);

let errors = 0;
let ok = 0;
const perBand = {};

for (const band of BANDS) {
  const bandDir = join(LEVELS_DIR, band);
  perBand[band] = { total: 0, ok: 0, errors: 0, orders: [] };
  if (!existsSync(bandDir)) continue;
  const files = readdirSync(bandDir).filter((f) => f.endsWith('.json')).sort();
  perBand[band].total = files.length;

  for (const file of files) {
    const path = join(bandDir, file);
    let pack;
    try {
      pack = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      console.error(`[PARSE] ${band}/${file}: ${e.message}`);
      errors++;
      perBand[band].errors++;
      continue;
    }

    const issues = [];

    for (const key of REQUIRED_TOP) {
      if (!(key in pack)) issues.push(`missing "${key}"`);
    }
    if (pack.schemaVersion !== 2) issues.push(`schemaVersion must be 2, got ${pack.schemaVersion}`);
    if (!['A2', 'B1', 'B2', 'C1'].includes(pack.level)) issues.push(`invalid level "${pack.level}"`);
    if (pack.language !== 'en') issues.push(`language must be "en"`);
    if (!Array.isArray(pack.questions)) {
      issues.push('questions must be an array');
    } else {
      if (pack.questions.length !== 15) issues.push(`expected 15 questions, got ${pack.questions.length}`);
      const qIds = new Set();
      pack.questions.forEach((q, i) => {
        if (!q || typeof q !== 'object') return issues.push(`q${i} not an object`);
        if (!q.id) issues.push(`q${i} missing id`);
        if (qIds.has(q.id)) issues.push(`duplicate question id "${q.id}"`);
        qIds.add(q.id);
        if (!VALID_TYPES.has(q.type)) issues.push(`q${i} invalid type "${q.type}"`);
        switch (q.type) {
          case 'multiple-choice':
            if (!q.question) issues.push(`${q.id}: missing question`);
            if (!Array.isArray(q.options) || q.options.length < 2) issues.push(`${q.id}: options < 2`);
            if (typeof q.correctIndex !== 'number' || q.correctIndex < 0 || q.correctIndex >= (q.options?.length ?? 0)) {
              issues.push(`${q.id}: bad correctIndex`);
            }
            break;
          case 'true-false':
            if (!q.statement) issues.push(`${q.id}: missing statement`);
            if (typeof q.correct !== 'boolean') issues.push(`${q.id}: correct must be boolean`);
            break;
          case 'dictation':
            if (!q.text) issues.push(`${q.id}: missing text`);
            break;
          case 'match':
            if (!Array.isArray(q.pairs) || q.pairs.length < 2) issues.push(`${q.id}: pairs < 2`);
            break;
          case 'speaking':
            if (!q.target) issues.push(`${q.id}: missing target`);
            break;
        }
        if (!q.explanation) issues.push(`${q.id}: missing explanation`);
        if (!Array.isArray(q.examples) || q.examples.length < 2) {
          issues.push(`${q.id}: examples must be array of >= 2`);
        }
      });
    }

    const orderMatch = file.match(/^(\d+)-/);
    if (orderMatch) perBand[band].orders.push(Number(orderMatch[1]));

    if (issues.length === 0) {
      ok++;
      perBand[band].ok++;
    } else {
      errors++;
      perBand[band].errors++;
      console.error(`[FAIL] ${band}/${file}:\n  - ${issues.join('\n  - ')}`);
    }
  }
}

console.log('\n=== Summary ===');
for (const band of BANDS) {
  const b = perBand[band];
  const missing = [];
  for (let i = 1; i <= 50; i++) if (!b.orders.includes(i)) missing.push(i);
  console.log(`${band}: ${b.ok}/${b.total} pass, ${b.errors} errors, ${missing.length} missing orders${missing.length ? ` [${missing.slice(0, 10).join(',')}${missing.length > 10 ? '...' : ''}]` : ''}`);
}
console.log(`\nTotal: ${ok} OK, ${errors} errors`);
process.exit(errors > 0 ? 1 : 0);
