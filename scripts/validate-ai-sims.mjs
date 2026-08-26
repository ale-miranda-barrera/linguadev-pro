// Valida los 20 JSONs de ai-programming contra TechSimulationSchema.
// Uso: node scripts/validate-ai-sims.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TechSimulationSchema } from '../packages/shared/dist/schemas/tech.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '..', 'packages', 'content', 'src', 'tech', 'ai-programming');

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
let ok = 0;
let fail = 0;
const issues = [];

for (const f of files) {
  const full = join(dir, f);
  let raw;
  try {
    raw = JSON.parse(readFileSync(full, 'utf-8'));
  } catch (e) {
    fail++;
    issues.push(`${f}: JSON parse error — ${e.message}`);
    continue;
  }
  const result = TechSimulationSchema.safeParse(raw);
  if (!result.success) {
    fail++;
    const errs = result.error.issues.slice(0, 5).map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    issues.push(`${f}: schema fail\n${errs}${result.error.issues.length > 5 ? `\n  ... y ${result.error.issues.length - 5} más` : ''}`);
    continue;
  }
  const nQ = raw.questions.length;
  const oneCorrect = raw.questions.every((q) => q.options.filter((o) => o.correct).length === 1);
  const uniqIds = new Set(raw.questions.map((q) => q.id)).size === nQ;
  if (nQ !== 20) issues.push(`${f}: WARN — tiene ${nQ} preguntas (esperado 20)`);
  if (!oneCorrect) issues.push(`${f}: WARN — alguna pregunta no tiene exactamente 1 correct: true`);
  if (!uniqIds) issues.push(`${f}: WARN — ids de preguntas duplicados`);
  ok++;
  console.log(`OK  ${f}  (${nQ}q)`);
}

if (issues.length) {
  console.log('\n=== ISSUES ===');
  for (const i of issues) console.log(i);
}
console.log(`\nResumen: ${ok} ok / ${fail} fallos / ${files.length} archivos`);
process.exit(fail > 0 ? 1 : 0);
