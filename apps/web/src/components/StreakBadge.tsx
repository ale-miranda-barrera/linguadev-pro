import { IconFlame } from './Icons.js';

interface Props {
  streak: number;
  compact?: boolean;
}

export function StreakBadge({ streak, compact }: Props) {
  const active = streak > 0;
  if (compact) {
    return (
      <div
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
          active
            ? 'bg-flame-500/15 text-flame-600 dark:text-flame-400'
            : 'bg-slate-200 text-slate-500 dark:bg-slate-800'
        }`}
        title="Racha diaria"
      >
        <IconFlame size={14} className={active ? 'animate-flicker' : ''} />
        {streak}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-gradient-to-br from-flame-400 to-flame-600 px-4 py-3 text-white shadow-pop">
      <IconFlame size={28} className={active ? 'animate-flicker' : ''} />
      <div className="leading-tight">
        <div className="text-2xl font-black">{streak}</div>
        <div className="text-[10px] uppercase tracking-widest opacity-80">día{streak === 1 ? '' : 's'}</div>
      </div>
    </div>
  );
}
