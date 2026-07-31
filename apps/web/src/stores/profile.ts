import { create } from 'zustand';
import { db, ensureProfile, type Profile } from '../db/dexie.js';

interface State {
  profile: Profile;
  loaded: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<Profile>) => Promise<void>;
  markStudiedToday: () => Promise<void>;
}

const PLACEHOLDER: Profile = {
  id: 'me',
  level: 'A2',
  streak: 0,
  dailyGoalMinutes: 15,
  tz: 'UTC',
  version: 1,
  updatedAt: new Date().toISOString(),
};

export const useProfileStore = create<State>((set, get) => ({
  profile: PLACEHOLDER,
  loaded: false,
  load: async () => {
    const p = await ensureProfile();
    set({ profile: p, loaded: true });
  },
  save: async (patch) => {
    const next: Profile = {
      ...get().profile,
      ...patch,
      version: get().profile.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await db.profile.put(next);
    set({ profile: next });
  },
  markStudiedToday: async () => {
    const today = new Date().toISOString().slice(0, 10);
    const p = get().profile;
    if (p.lastStudiedIsoDay === today) return;
    // Streak: si estudió ayer, +1; si no, reinicia a 1.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const streak = p.lastStudiedIsoDay === yesterday ? p.streak + 1 : 1;
    await get().save({ lastStudiedIsoDay: today, streak });
  },
}));
