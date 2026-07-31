import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useProfileStore } from '../../stores/profile.js';
import { usePacksStore } from '../../stores/packs.js';
import { db } from '../../db/dexie.js';
import { fetchAiStatus } from '../../lib/chatClient.js';
import type { AiStatusResponse } from '@linguadev/shared';

export function Settings() {
  const profile = useProfileStore((s) => s.profile);
  const save = useProfileStore((s) => s.save);
  const packs = usePacksStore((s) => s.packs);
  const setEnabled = usePacksStore((s) => s.setEnabled);
  const loadInstalled = usePacksStore((s) => s.loadInstalled);
  const installFromJson = usePacksStore((s) => s.installFromJson);
  const [importText, setImportText] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);

  useEffect(() => {
    void loadInstalled();
    void fetchAiStatus().then(setAiStatus).catch(() => setAiStatus(null));
  }, [loadInstalled]);

  async function exportAll() {
    const [srs, errors, profileRow, packRows] = await Promise.all([
      db.srs.toArray(),
      db.errors.toArray(),
      db.profile.toArray(),
      db.packs.toArray(),
    ]);
    const blob = new Blob(
      [JSON.stringify({ v: 1, srs, errors, profile: profileRow, packs: packRows }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linguadev-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-bold">Ajustes</h1>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Perfil</h2>
        <div className="flex items-center justify-between rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <div>
            <div className="text-sm font-medium">Nivel CEFR</div>
            <div className="text-xs text-slate-500">Actual: {profile.level}</div>
          </div>
          <Link to="/placement" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white">
            Cambiar
          </Link>
        </div>
        <label className="block">
          <span className="text-sm">Minutos diarios: {profile.dailyGoalMinutes}</span>
          <input
            type="range"
            min={5}
            max={60}
            step={5}
            value={profile.dailyGoalMinutes}
            onChange={(e) => void save({ dailyGoalMinutes: Number(e.target.value) })}
            className="w-full"
          />
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Packs</h2>
        <ul className="space-y-2">
          {packs.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between rounded-xl border border-slate-200 p-3 dark:border-slate-800"
            >
              <div>
                <div className="font-medium">{p.title}</div>
                <div className="text-xs text-slate-500">
                  {p.level} · {p.vocab.length} vocab
                </div>
              </div>
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={(e) => void setEnabled(p.id, e.target.checked)}
              />
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <label htmlFor="import" className="text-sm font-medium">
            Importar pack (JSON)
          </label>
          <textarea
            id="import"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
            placeholder='{"schemaVersion":2,"id":"...","title":"...","level":"A2","language":"en"}'
          />
          <button
            onClick={async () => {
              const r = await installFromJson(importText);
              setImportMsg(r.ok ? `Instalado: ${r.id}` : `Rechazado: ${r.error}`);
              if (r.ok) setImportText('');
            }}
            className="mt-2 rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white"
          >
            Validar e instalar
          </button>
          {importMsg ? <p className="mt-2 text-xs text-slate-500">{importMsg}</p> : null}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          Proveedor IA (backend)
        </h2>
        <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Estado actual</div>
              <div className="text-xs text-slate-500">
                Detectado desde <code>/api/ai/status</code> en tiempo real.
              </div>
            </div>
            {aiStatus?.configured ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200">
                Conectado
              </span>
            ) : (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-red-800 dark:bg-red-500/20 dark:text-red-200">
                Sin key
              </span>
            )}
          </div>
          {aiStatus && (
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-slate-500">Proveedor</div>
                <div className="font-mono">{aiStatus.provider}</div>
              </div>
              <div>
                <div className="text-slate-500">Modelo</div>
                <div className="font-mono">{aiStatus.model ?? '—'}</div>
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-slate-500">
          Para configurar: abre <code className="rounded bg-slate-200 px-1 dark:bg-white/10">.env</code> en la raíz del proyecto y
          rellena <code>AI_PROVIDER</code> + la key correspondiente. Luego reinicia el server con <code>pnpm dev</code>.
        </p>
        <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
          <li>
            <b>OpenAI</b> (ChatGPT) — <code>AI_PROVIDER=openai</code> + <code>OPENAI_API_KEY=sk-...</code> — obtén una key en{' '}
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noreferrer noopener"
              className="text-brand-600 underline"
            >
              platform.openai.com/api-keys
            </a>
          </li>
          <li>
            <b>Anthropic</b> (Claude) — <code>AI_PROVIDER=anthropic</code> + <code>ANTHROPIC_API_KEY=sk-ant-...</code>
          </li>
          <li>
            <b>DeepSeek</b> (barato) — <code>AI_PROVIDER=deepseek</code> + <code>DEEPSEEK_API_KEY=sk-...</code>
          </li>
        </ul>
        <p className="text-xs text-slate-500">
          Presupuesto y rate-limit: <code>AI_DAILY_BUDGET_USD</code> (default $1/día por sesión), <code>AI_RATE_LIMIT_PER_MIN</code> (default 20 req/min).
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Datos</h2>
        <button onClick={exportAll} className="mt-2 rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-white">
          Exportar backup JSON
        </button>
      </section>
    </div>
  );
}
