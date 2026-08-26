import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect, type ComponentType, type PropsWithChildren } from 'react';
import { useProfileStore } from '../stores/profile.js';
import { StreakBadge } from './StreakBadge.js';
import { ThemeToggle } from './ThemeToggle.js';
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
  IconChevronRight,
} from './Icons.js';

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  accent: string;
}

// Navegación jerárquica: dos categorías principales (Inglés, Programación) con sub-items.
// El sidebar desktop las muestra colapsables; el bottom bar móvil las muestra como
// atajos que llevan al Dashboard (donde se ve la vista principal con las secciones).

const ENGLISH_ITEMS: NavItem[] = [
  { to: '/path', label: 'Ruta CEFR', Icon: IconTarget, accent: 'from-cyan-500 to-brand-500' },
  { to: '/vocab', label: 'Vocab', Icon: IconCards, accent: 'from-brand-500 to-pink-500' },
  { to: '/listening', label: 'Escucha', Icon: IconHeadphones, accent: 'from-cyan-500 to-brand-500' },
  { to: '/speaking', label: 'Habla', Icon: IconMic, accent: 'from-pink-500 to-flame-500' },
  { to: '/writing', label: 'Escribir', Icon: IconPencil, accent: 'from-flame-500 to-brand-500' },
  { to: '/chat', label: 'Chat IA', Icon: IconChat, accent: 'from-brand-500 to-cyan-500' },
  { to: '/voice-call', label: 'Voice Call', Icon: IconPhone, accent: 'from-brand-500 to-pink-500' },
  { to: '/tutor', label: 'Tutor', Icon: IconBook, accent: 'from-cyan-500 to-brand-500' },
  { to: '/create', label: 'Crear pack', Icon: IconSparkle, accent: 'from-flame-500 to-pink-500' },
];

const PROGRAMMING_ITEMS: NavItem[] = [
  { to: '/aws', label: 'Certificados AWS', Icon: IconTrophy, accent: 'from-orange-500 to-yellow-500' },
  { to: '/programming/programmer', label: 'Programador (Senior)', Icon: IconSparkle, accent: 'from-brand-500 to-pink-500' },
  { to: '/programming/architecture', label: 'Arquitectura', Icon: IconTarget, accent: 'from-cyan-500 to-indigo-500' },
  { to: '/programming/devops', label: 'DevOps', Icon: IconTarget, accent: 'from-emerald-500 to-teal-600' },
  { to: '/programming/ai-programming', label: 'Programando con IA', Icon: IconSparkle, accent: 'from-violet-600 to-fuchsia-500' },
];

const BOTTOM_NAV: NavItem[] = [
  { to: '/', label: 'Hoy', Icon: IconHome, accent: 'from-brand-500 to-brand-700' },
  { to: '/programming', label: 'Programación', Icon: IconTrophy, accent: 'from-brand-500 to-cyan-500' },
  { to: '/vocab', label: 'Inglés', Icon: IconCards, accent: 'from-brand-500 to-pink-500' },
  { to: '/progress', label: 'Progreso', Icon: IconTarget, accent: 'from-cyan-500 to-brand-500' },
  { to: '/settings', label: 'Ajustes', Icon: IconSettings, accent: 'from-slate-500 to-slate-700' },
];

export function Shell({ children }: PropsWithChildren) {
  const level = useProfileStore((s) => s.profile.level);
  const streak = useProfileStore((s) => s.profile.streak);
  const location = useLocation();

  // Auto-expandir la categoría que contiene la ruta actual
  const englishActive = ENGLISH_ITEMS.some((i) => location.pathname.startsWith(i.to)) || location.pathname.startsWith('/lesson');
  const programmingActive =
    PROGRAMMING_ITEMS.some((i) => location.pathname.startsWith(i.to)) ||
    location.pathname.startsWith('/programming') ||
    location.pathname.startsWith('/aws');

  const [openEnglish, setOpenEnglish] = useState(englishActive);
  const [openProgramming, setOpenProgramming] = useState(programmingActive);

  useEffect(() => {
    if (englishActive) setOpenEnglish(true);
    if (programmingActive) setOpenProgramming(true);
  }, [englishActive, programmingActive]);

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

        <div className="mx-4 mb-2 flex items-center gap-2">
          <LevelPill level={level} />
          <StreakBadge streak={streak} compact />
          <div className="ml-auto">
            <ThemeToggle size="sm" />
          </div>
        </div>

        <nav className="mt-2 flex flex-col gap-1 p-3">
          {/* Hoy */}
          <NavLink
            to="/"
            end
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
                      ? 'bg-gradient-to-br from-brand-500 to-brand-700 shadow-pop'
                      : 'bg-slate-200 text-slate-500 group-hover:bg-slate-300 dark:bg-slate-800'
                  }`}
                >
                  <IconHome size={16} />
                </span>
                <span>Hoy</span>
              </>
            )}
          </NavLink>

          {/* CATEGORÍA INGLÉS (colapsable) */}
          <CategoryHeader
            icon="🇬🇧"
            label="Inglés"
            open={openEnglish}
            onToggle={() => setOpenEnglish((v) => !v)}
            active={englishActive}
          />
          <AnimatePresence initial={false}>
            {openEnglish ? (
              <motion.div
                key="english-items"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden pl-3"
              >
                {ENGLISH_ITEMS.map((n) => (
                  <SubItemLink key={n.to} item={n} />
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* CATEGORÍA PROGRAMACIÓN (colapsable) */}
          <CategoryHeader
            icon="💻"
            label="Programación"
            open={openProgramming}
            onToggle={() => setOpenProgramming((v) => !v)}
            active={programmingActive}
          />
          <AnimatePresence initial={false}>
            {openProgramming ? (
              <motion.div
                key="programming-items"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden pl-3"
              >
                <NavLink
                  to="/programming"
                  end
                  className={({ isActive }) =>
                    `mb-0.5 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] font-bold uppercase tracking-widest transition ${
                      isActive
                        ? 'bg-brand-500/10 text-brand-700 dark:text-brand-300'
                        : 'text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5'
                    }`
                  }
                >
                  Ver todos
                </NavLink>
                {PROGRAMMING_ITEMS.map((n) => (
                  <SubItemLink key={n.to} item={n} />
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="my-2 h-px bg-slate-200/60 dark:bg-white/5" />

          {/* Progreso */}
          <NavLink
            to="/progress"
            className={({ isActive }) =>
              `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                isActive
                  ? 'bg-gradient-to-r from-cyan-500/10 to-transparent text-cyan-700 dark:text-cyan-300'
                  : 'text-slate-600 hover:bg-slate-900/5 dark:text-slate-300 dark:hover:bg-white/5'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`grid h-8 w-8 place-items-center rounded-lg text-white transition ${
                    isActive
                      ? 'bg-gradient-to-br from-cyan-500 to-brand-500 shadow-pop'
                      : 'bg-slate-200 text-slate-500 group-hover:bg-slate-300 dark:bg-slate-800'
                  }`}
                >
                  <IconTarget size={16} />
                </span>
                <span>Progreso</span>
              </>
            )}
          </NavLink>

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
              <ThemeToggle size="sm" />
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
          {BOTTOM_NAV.map((n) => (
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

function CategoryHeader({
  icon,
  label,
  open,
  onToggle,
  active,
}: {
  icon: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  active: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      className={`group flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-bold transition ${
        active
          ? 'bg-gradient-to-r from-brand-500/10 to-transparent text-brand-700 dark:text-brand-300'
          : 'text-slate-700 hover:bg-slate-900/5 dark:text-slate-200 dark:hover:bg-white/5'
      }`}
    >
      <span className="flex items-center gap-3">
        <span className={`grid h-8 w-8 place-items-center rounded-lg text-lg ${
          active ? 'bg-gradient-to-br from-brand-500 to-pink-500 shadow-pop' : 'bg-slate-200 dark:bg-slate-800'
        }`}>
          <span>{icon}</span>
        </span>
        {label}
      </span>
      <IconChevronRight
        size={14}
        className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
      />
    </button>
  );
}

function SubItemLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        `group ml-2 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition ${
          isActive
            ? 'bg-gradient-to-r from-brand-500/10 to-transparent text-brand-700 dark:text-brand-300'
            : 'text-slate-500 hover:bg-slate-900/5 dark:text-slate-400 dark:hover:bg-white/5'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`grid h-6 w-6 place-items-center rounded-md text-white transition ${
              isActive
                ? `bg-gradient-to-br ${item.accent}`
                : 'bg-slate-200 text-slate-500 group-hover:bg-slate-300 dark:bg-slate-800'
            }`}
          >
            <item.Icon size={12} />
          </span>
          <span>{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

function LevelPill({ level }: { level: string }) {
  return (
    <span className="inline-flex h-7 items-center rounded-full bg-gradient-to-r from-brand-500 to-cyan-500 px-2.5 text-[11px] font-black uppercase tracking-widest text-white shadow-glow">
      {level}
    </span>
  );
}
