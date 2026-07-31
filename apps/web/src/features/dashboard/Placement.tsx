import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProfileStore } from '../../stores/profile.js';
import type { CEFRLevel } from '@linguadev/shared';

const LEVELS: CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1'];

export function Placement() {
  const save = useProfileStore((s) => s.save);
  const nav = useNavigate();
  const [choice, setChoice] = useState<CEFRLevel>('A2');
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-bold">Selecciona tu nivel</h1>
      <p className="text-sm text-slate-500">
        Puedes cambiarlo luego. Un placement completo llega en la Fase 3.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {LEVELS.map((l) => (
          <button
            key={l}
            onClick={() => setChoice(l)}
            className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
              choice === l
                ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-300'
                : 'border-slate-200 hover:border-brand-300 dark:border-slate-800'
            }`}
          >
            {l}
          </button>
        ))}
      </div>
      <button
        onClick={async () => {
          await save({ level: choice });
          nav('/');
        }}
        className="w-full rounded-xl bg-brand-600 py-3 font-medium text-white"
      >
        Guardar y continuar
      </button>
    </div>
  );
}
