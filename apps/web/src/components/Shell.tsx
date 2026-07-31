import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { ComponentType, PropsWithChildren } from 'react';
import { useProfileStore } from '../stores/profile.js';
import { StreakBadge } from './StreakBadge.js';
import {
  IconHome,
  IconCards,
  IconHeadphones,
  IconMic,
  IconPencil,
  IconPhone,
  IconSettings,
  IconSparkle,
  IconBook,
  IconTarget,
  IconTrophy,
  IconChat,
} from './Icons.js';

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  accent: string; // clase de gradient para el círculo del icono activo
}

const NAV: NavItem[] = [
  { to: '/', label: 'Hoy', Icon: IconHome, accent: 'from-brand-500 to-brand-700' },
  { to: '/path', label: 'Ruta', Icon: IconTarget, accent: 'from-cyan-500 to-brand-500' },
  { to: '/vocab', label: 'Vocab', Icon: IconCards, accent: 'from-brand-500 to-pink-500' },
  { to: '/speaking', label: 'Habla', Icon: IconMic, accent: 'from-pink-500 to-flame-500' },
  { to: '/writing', label: 'Escribir', Icon: IconPencil, accent: 'from-flame-500 to-brand-500' },
];

const NAV_DESKTOP: NavItem[] = [
  { to: '/', label: 'Hoy', Icon: IconHome, accent: 'from-brand-500 to-brand-700' },
  { to: '/path', label: 'Ruta CEFR', Icon: IconTarget, accent: 'from-cyan-500 to-brand-500' },
  { to: '/vocab', label: 'Vocab', Icon: IconCards, accent: 'from-brand-500 to-pink-500' },
  { to: '/listening', label: 'Escucha', Icon: IconHeadphones, accent: 'from-cyan-500 to-brand-500' },
  { to: '/speaking', label: 'Habla', Icon: IconMic, accent: 'from-pink-500 to-flame-500' },
  { to: '/writing', label: 'Escribir', Icon: IconPencil, accent: 'from-flame-500 to-brand-500' },
];

const AI_NAV: NavItem[] = [
  { to: '/chat', label: 'Chat IA', Icon: IconChat, accent: 'from-brand-500 to-cyan-500' },
  { to: '/voice-call', label: 'Voice Call', Icon: IconPhone, accent: 'from-brand-500 to-pink-500' },
  { to: '/tutor', label: 'Tutor', Icon: IconBook, accent: 'from-cyan-500 to-brand-500' },
  { to: '/create', label: 'Crear pack', Icon: IconSparkle, accent: 'from-flame-500 to-pink-500' },
];

const CERT_NAV: NavItem[] = [
  { to: '/aws', label: 'AWS', Icon: IconTrophy, accent: 'from-orange-500 to-yellow-500' },
];

export function Shell({ children }: PropsWithChildren) {
  const level = useProfileStore((s) => s.profile.level);
  const streak = useProfileStore((s) => s.profile.streak);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Sidebar desktop */}
      <aside className="glass hidden w-64 shrink-0 border-r border-white/40 md:flex md:flex-col dark:border-white/5">
        <div className="p-6">
          <div className="flex items-center gap-2">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-pink-500 text-white shadow-pop">
              <span className="text-lg font-black">L</span>
            </div>
            <div className="text-lg font-black tracking-tight">
              LinguaDev
              <span className="ml-1 bg-gradient-to-r from-brand-500 to-cyan-500 bg-clip-text text-transparent">
                Pro
              </span>
            </div>
          </div>
        </div>

        <div className="mx-4 mb-2 flex items-center gap-3">
          <LevelPill level={level} />
          <StreakBadge streak={streak} compact />
        </div>

        <nav className="mt-2 flex flex-col gap-1 p-3">
          {NAV_DESKTOP.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                  isActive
                    ? 'bg-gradient-to-r from-brand-500/10 to-transparent text-brand-700 dark:text-brand-300'
                    : 'text-slate-600 hover:bg-slate-900/5 dark:text-slate-300 dark:hover:bg-white/5'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={`grid h-8 w-8 place-items-center rounded-lg text-white transition ${
                      isActive
                        ? `bg-gradient-to-br ${n.accent} shadow-pop`
                        : 'bg-slate-200 text-slate-500 group-hover:bg-slate-300 dark:bg-slate-800'
                    }`}
                  >
                    <n.Icon size={16} />
                  </span>
                  <span>{n.label}</span>
                </>
              )}
            </NavLink>
          ))}
          <div className="my-2 h-px bg-slate-200/60 dark:bg-white/5" />
          <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Certificaciones
          </div>
          {CERT_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                  isActive
                    ? 'bg-gradient-to-r from-orange-500/10 to-transparent text-orange-700 dark:text-orange-300'
                    : 'text-slate-600 hover:bg-slate-900/5 dark:text-slate-300 dark:hover:bg-white/5'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={`grid h-8 w-8 place-items-center rounded-lg text-white transition ${
                      isActive
                        ? `bg-gradient-to-br ${n.accent} shadow-pop`
                        : 'bg-slate-200 text-slate-500 group-hover:bg-slate-300 dark:bg-slate-800'
                    }`}
                  >
                    <n.Icon size={16} />
                  </span>
                  <span>{n.label}</span>
                </>
              )}
            </NavLink>
          ))}
          <div className="my-2 h-px bg-slate-200/60 dark:bg-white/5" />
          <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
            IA
          </div>
          {AI_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                  isActive
                    ? 'bg-gradient-to-r from-brand-500/10 to-transparent text-brand-700 dark:text-brand-300'
                    : 'text-slate-600 hover:bg-slate-900/5 dark:text-slate-300 dark:hover:bg-white/5'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={`grid h-8 w-8 place-items-center rounded-lg text-white transition ${
                      isActive
                        ? `bg-gradient-to-br ${n.accent} shadow-pop`
                        : 'bg-slate-200 text-slate-500 group-hover:bg-slate-300 dark:bg-slate-800'
                    }`}
                  >
                    <n.Icon size={16} />
                  </span>
                  <span>{n.label}</span>
                </>
              )}
            </NavLink>
          ))}
          <div className="my-2 h-px bg-slate-200/60 dark:bg-white/5" />
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${
                isActive
                  ? 'bg-slate-900/5 text-slate-900 dark:bg-white/5 dark:text-white'
                  : 'text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5'
              }`
            }
          >
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-200 text-slate-500 dark:bg-slate-800">
              <IconSettings size={16} />
            </span>
            Ajustes
          </NavLink>
        </nav>
      </aside>

      {/* Contenido */}
      <main className="flex-1 pb-24 md:pb-6">
        {/* Header móvil */}
        <header className="glass sticky top-0 z-30 border-b border-white/40 md:hidden dark:border-white/5">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-pink-500 text-white shadow-pop">
                <span className="text-sm font-black">L</span>
              </div>
              <div className="text-base font-black tracking-tight">
                LinguaDev
                <span className="ml-1 bg-gradient-to-r from-brand-500 to-cyan-500 bg-clip-text text-transparent">
                  Pro
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <LevelPill level={level} />
              <StreakBadge streak={streak} compact />
            </div>
          </div>
        </header>

        <div className="mx-auto w-full max-w-3xl px-4 py-4 md:px-6 md:py-8">{children}</div>
      </main>

      {/* Bottom nav móvil */}
      <nav className="glass fixed bottom-0 left-0 right-0 z-40 border-t border-white/40 md:hidden dark:border-white/5">
        <ul className="grid grid-cols-5">
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  `relative flex flex-col items-center gap-1 py-2 text-[11px] font-semibold ${
                    isActive ? 'text-brand-700 dark:text-brand-300' : 'text-slate-500'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={`grid h-9 w-9 place-items-center rounded-xl transition ${
                        isActive
                          ? `bg-gradient-to-br ${n.accent} text-white shadow-pop`
                          : 'bg-slate-200/70 text-slate-500 dark:bg-slate-800'
                      }`}
                    >
                      <n.Icon size={18} />
                    </span>
                    <span>{n.label}</span>
                    {isActive ? (
                      <motion.span
                        layoutId="tab-underline"
                        className="absolute -top-0.5 h-1 w-10 rounded-full bg-gradient-to-r from-brand-500 to-pink-500"
                      />
                    ) : null}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <div style={{ paddingBottom: 'env(safe-area-inset-bottom)' }} />
      </nav>
    </div>
  );
}

function LevelPill({ level }: { level: string }) {
  return (
    <span className="inline-flex h-7 items-center rounded-full bg-gradient-to-r from-brand-500 to-cyan-500 px-2.5 text-[11px] font-black uppercase tracking-widest text-white shadow-glow">
      {level}
    </span>
  );
}
