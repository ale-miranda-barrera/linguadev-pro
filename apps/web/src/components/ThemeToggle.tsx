import { useThemeStore } from '../stores/theme.js';

// Botón compacto que cicla entre Auto → Light → Dark.
// Muestra icono + label del modo actual; recuerda tu elección.

export function ThemeToggle({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const mode = useThemeStore((s) => s.mode);
  const effective = useThemeStore((s) => s.effective);
  const cycle = useThemeStore((s) => s.cycle);

  const icon = mode === 'auto' ? (effective === 'dark' ? '🌗' : '🌓') : mode === 'dark' ? '🌙' : '☀️';
  const label = mode === 'auto' ? 'Auto' : mode === 'dark' ? 'Noche' : 'Día';
  const title = `Tema: ${label} (click para cambiar)`;

  const iconSize = size === 'sm' ? 'text-base' : 'text-lg';
  const padding = size === 'sm' ? 'h-8 px-2.5' : 'h-9 px-3';

  return (
    <button
      onClick={cycle}
      title={title}
      aria-label={title}
      className={`inline-flex ${padding} items-center gap-1.5 rounded-full border border-slate-300/70 bg-white/70 text-xs font-bold text-slate-700 shadow-soft transition hover:-translate-y-0.5 dark:border-white/10 dark:bg-white/5 dark:text-slate-200`}
    >
      <span className={iconSize}>{icon}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
