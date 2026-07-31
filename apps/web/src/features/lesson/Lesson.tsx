import { useParams, Link, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { usePacksStore } from '../../stores/packs.js';
import { useLevelProgressStore } from '../../stores/levelProgress.js';
import { EmptyState, LoadingState } from '../../components/UiStates.js';
import { QuestionRunner } from '../../components/questions/QuestionRunner.js';
import type { QuestionResult } from '../../components/questions/types.js';

export function Lesson() {
  const { packId } = useParams();
  const navigate = useNavigate();
  const packs = usePacksStore((s) => s.packs);
  const loaded = usePacksStore((s) => s.loaded);
  const loadInstalled = usePacksStore((s) => s.loadInstalled);
  const recordAttempt = useLevelProgressStore((s) => s.recordAttempt);
  const progress = useLevelProgressStore((s) => s.progress);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  if (!loaded) return <LoadingState />;
  const pack = packs.find((p) => p.id === packId);
  if (!pack) {
    return (
      <EmptyState
        title="Pack no encontrado"
        hint="Instala este pack desde ajustes."
        action={<Link to="/settings" className="rounded bg-brand-600 px-3 py-1.5 text-sm text-white">Ir a ajustes</Link>}
      />
    );
  }

  const isLevelPack = pack.questions && pack.questions.length > 0 && pack.band;
  const passThreshold = pack.passThreshold ?? 0.8;
  const prog = progress[pack.id];

  async function handleFinish(results: QuestionResult[]) {
    if (!isLevelPack || !pack || !pack.band || !pack.levelOrder) return;
    const scoreSum = results.reduce((s, r) => s + r.score01, 0);
    const score01 = results.length > 0 ? scoreSum / results.length : 0;
    const outcome = await recordAttempt(pack.id, pack.band, pack.levelOrder, score01, passThreshold);
    if (outcome.passed && outcome.firstTime) {
      // Pequeña celebración; el usuario ya está viendo la pantalla final del runner.
      setTimeout(() => navigate('/path'), 3000);
    }
  }

  if (isLevelPack) {
    return (
      <div className="space-y-4">
        <header className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <Link to="/path" className="underline">Ruta</Link>
            <span>·</span>
            <span>{pack.band}</span>
            <span>·</span>
            <span>Nivel {pack.levelOrder}</span>
          </div>
          <h1 className="text-2xl font-black">{pack.title}</h1>
          {pack.description ? <p className="text-sm text-slate-500">{pack.description}</p> : null}
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span>Objetivo: {Math.round(passThreshold * 100)}% para avanzar</span>
            {prog ? (
              <span className="font-mono">
                Mejor: {Math.round(prog.bestScore01 * 100)}% · {prog.attempts} intentos {prog.passed ? '✅' : ''}
              </span>
            ) : null}
          </div>
        </header>

        <QuestionRunner questions={pack.questions!} onFinish={handleFinish} title={`nivel ${pack.levelOrder}`} />
      </div>
    );
  }

  // Fallback: packs viejos (temáticos) siguen mostrando vocab.
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">{pack.title}</h1>
        <p className="text-sm text-slate-500">Nivel {pack.level}</p>
      </header>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-500">Vocab del pack</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {pack.vocab.map((v) => (
            <li key={v.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
              <div className="font-medium">{v.term}</div>
              <div className="text-sm text-slate-500">{v.translation}</div>
              {v.example ? <div className="mt-1 text-xs italic text-slate-400">"{v.example}"</div> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
