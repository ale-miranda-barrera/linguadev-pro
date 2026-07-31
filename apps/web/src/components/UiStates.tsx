import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

// Estados de UI de primera clase. Cada feature debe modelar loading/empty/error/offline/ready
// para no dejar pantallas en blanco ni caer al happy path silencioso.

export function LoadingState({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-slate-500">
      <motion.div
        className="h-10 w-10 rounded-full border-2 border-brand-500 border-t-transparent"
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
      />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
      <div className="text-3xl">🌱</div>
      <h3 className="mt-2 text-lg font-semibold">{title}</h3>
      {hint ? <p className="mt-1 text-sm text-slate-500">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="rounded-2xl border border-danger-500/30 bg-danger-500/5 p-6 text-center">
      <div className="text-2xl">⚠️</div>
      <p className="mt-2 text-sm">{error}</p>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-3 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white"
        >
          Reintentar
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-200 dark:bg-slate-800 ${className}`} />;
}
