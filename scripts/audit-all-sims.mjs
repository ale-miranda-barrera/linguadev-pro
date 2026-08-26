// Auditoría de calidad sobre TODOS los sims (programmer, architecture, devops, ai-programming)
// Busca problemas comunes: campos vacíos, `why` duplicado de `text`, refs sin título,
// preguntas duplicadas por scenario, opciones incorrectas sin `why`, escenarios muy cortos.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const techDir = join(__dirname, '..', 'packages', 'content', 'src', 'tech');
const tracks = ['programmer', 'architecture', 'devops', 'ai-programming'];

const issues = [];
const stats = {};

for (const track of tracks) {
  const dir = join(techDir, track);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  stats[track] = { files: files.length, questions: 0, problems: 0 };

  for (const f of files) {
    const rel = `${track}/${f}`;
    const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (!data.questions || !Array.isArray(data.questions)) {
      issues.push(`${rel}: NO tiene array de questions`);
      continue;
    }
    stats[track].questions += data.questions.length;

    // 1. Detectar campos crípticos o vacíos
    for (const q of data.questions) {
      const qref = `${rel} ${q.id}`;
      if (!q.scenario || q.scenario.trim().length < 40) {
        issues.push(`${qref}: scenario muy corto (<40 chars) — puede ser calidad baja`);
      }
      if (!q.explanation || q.explanation.trim().length < 80) {
        issues.push(`${qref}: explanation muy corta (<80 chars) — puede ser calidad baja`);
      }
      if (!q.options || q.options.length < 3) {
        issues.push(`${qref}: opciones < 3 (schema pide 2 mínimo pero <3 es sospechoso)`);
      }
      // 2. Opciones sin why
      for (const opt of q.options || []) {
        if (!opt.why || opt.why.trim().length < 10) {
          issues.push(`${qref} opt ${opt.letter}: WHY vacío o < 10 chars`);
        }
        // 3. why == text (duplicado por descuido)
        if (opt.why && opt.text && opt.why.trim() === opt.text.trim()) {
          issues.push(`${qref} opt ${opt.letter}: WHY es duplicado exacto de TEXT`);
        }
      }
      // 4. Referencias sin título
      for (const ref of q.references || []) {
        if (!ref.title || ref.title.trim().length < 3) {
          issues.push(`${qref}: reference con title vacío o < 3 chars`);
        }
        // URL bogus check
        if (ref.url && !ref.url.startsWith('http')) {
          issues.push(`${qref}: reference URL no arranca con http (${ref.url})`);
        }
      }
      // 5. multiSelect mismatch
      const nCorrect = (q.options || []).filter((o) => o.correct).length;
      if (nCorrect === 0) {
        issues.push(`${qref}: ⚠️  NINGUNA opción marcada correct: true`);
      }
      if (q.multiSelect === false && nCorrect > 1) {
        issues.push(`${qref}: multiSelect=false pero ${nCorrect} opciones correctas — inconsistente`);
      }
      if (q.multiSelect === true && nCorrect === 1) {
        issues.push(`${qref}: multiSelect=true pero SOLO 1 opción correcta — cambiar a false o añadir correctas`);
      }
    }

    // 6. IDs de pregunta duplicados en el mismo sim
    const ids = data.questions.map((q) => q.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) issues.push(`${rel}: IDs duplicados: ${[...new Set(dup)].join(', ')}`);

    // 7. Escenarios duplicados en el mismo sim (posible copy-paste)
    const scenarios = data.questions.map((q) => (q.scenario || '').trim());
    for (let i = 0; i < scenarios.length; i++) {
      for (let j = i + 1; j < scenarios.length; j++) {
        if (scenarios[i].length > 50 && scenarios[i] === scenarios[j]) {
          issues.push(`${rel}: scenarios idénticos en ${data.questions[i].id} y ${data.questions[j].id}`);
        }
      }
    }
  }
}

// Resumen por track
console.log('=== RESUMEN ===');
for (const t of tracks) {
  console.log(`${t}: ${stats[t].files} sims, ${stats[t].questions} preguntas`);
}
console.log(`\nTotal problemas detectados: ${issues.length}`);
if (issues.length) {
  console.log('\n=== PROBLEMAS ===');
  for (const i of issues.slice(0, 200)) console.log(i);
  if (issues.length > 200) console.log(`\n... y ${issues.length - 200} más`);
}
