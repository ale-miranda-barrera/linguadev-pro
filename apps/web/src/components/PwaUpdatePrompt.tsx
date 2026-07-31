import { useEffect, useState } from 'react';
// @ts-expect-error el virtual module lo genera vite-plugin-pwa en build; en dev es no-op.
import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaUpdatePrompt() {
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const { updateServiceWorker } = useRegisterSW({
    onNeedRefresh() {
      setNeedsRefresh(true);
    },
  });

  useEffect(() => {
    // no-op: solo garantiza que useRegisterSW se llame en cliente
  }, []);

  if (!needsRefresh) return null;

  return (
    <div className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-sm rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-800 dark:bg-slate-900">
      <p className="text-sm font-medium">Hay una nueva versión disponible</p>
      <div className="mt-2 flex gap-2">
        <button
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white"
          onClick={() => updateServiceWorker(true)}
        >
          Recargar
        </button>
        <button
          className="rounded-lg px-3 py-1.5 text-sm text-slate-500"
          onClick={() => setNeedsRefresh(false)}
        >
          Después
        </button>
      </div>
    </div>
  );
}
