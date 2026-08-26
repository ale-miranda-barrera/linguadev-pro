import { create } from 'zustand';

// Theme store: light | dark | auto (sigue prefers-color-scheme).
// Aplica la clase 'dark' en <html> inmediatamente para evitar FOUC.
// Persiste la elección en localStorage bajo 'linguadev.theme'.

export type ThemeMode = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 'linguadev.theme';

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function resolveEffective(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'auto') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

function applyTheme(effective: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (effective === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  // Actualiza meta theme-color para PWA / status bar mobile.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = effective === 'dark' ? '#0b0716' : '#7c3aed';
}

function readStored(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'auto';
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'auto') return v;
  return 'auto';
}

interface State {
  mode: ThemeMode;
  effective: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
  cycle: () => void;
}

export const useThemeStore = create<State>((set) => {
  const initialMode = readStored();
  const initialEffective = resolveEffective(initialMode);
  applyTheme(initialEffective);

  // Si mode='auto', re-aplicar cuando el SO cambia de tema.
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', () => {
      const stored = readStored();
      if (stored === 'auto') {
        const eff = mq.matches ? 'dark' : 'light';
        applyTheme(eff);
        set({ effective: eff });
      }
    });
  }

  return {
    mode: initialMode,
    effective: initialEffective,
    setMode: (m: ThemeMode) => {
      localStorage.setItem(STORAGE_KEY, m);
      const eff = resolveEffective(m);
      applyTheme(eff);
      set({ mode: m, effective: eff });
    },
    cycle: () => {
      const order: ThemeMode[] = ['auto', 'light', 'dark'];
      set((s) => {
        const idx = order.indexOf(s.mode);
        const next = order[(idx + 1) % order.length]!;
        localStorage.setItem(STORAGE_KEY, next);
        const eff = resolveEffective(next);
        applyTheme(eff);
        return { mode: next, effective: eff };
      });
    },
  };
});
