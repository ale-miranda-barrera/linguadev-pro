import { create } from 'zustand';
import { db, type StoredPack } from '../db/dexie.js';
import { loadBundledPacks, loadLevelPacks, validatePack } from '@linguadev/content';

interface State {
  packs: StoredPack[];
  loaded: boolean;
  loadInstalled: () => Promise<void>;
  installBundled: () => Promise<void>;
  installFromJson: (raw: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
}

export const usePacksStore = create<State>((set, get) => ({
  packs: [],
  loaded: false,
  loadInstalled: async () => {
    let all = await db.packs.toArray();
    // Primer arranque: Dexie vacío → siembra automática de los packs bundled + level packs.
    // Contrato local-first: la app SIEMPRE debe tener contenido, incluso offline.
    if (all.length === 0) {
      const bundled = loadBundledPacks();
      const levels = loadLevelPacks();
      const installedAt = new Date().toISOString();
      for (const p of [...bundled, ...levels]) {
        await db.packs.put({ ...p, enabled: true, installedAt });
      }
      all = await db.packs.toArray();
    } else {
      // Ya hay packs — chequea si hay level packs nuevos (releases posteriores) y los añade.
      const levels = loadLevelPacks();
      const installedAt = new Date().toISOString();
      let added = false;
      for (const p of levels) {
        const existing = await db.packs.get(p.id);
        if (existing) continue;
        await db.packs.put({ ...p, enabled: true, installedAt });
        added = true;
      }
      if (added) all = await db.packs.toArray();
    }
    set({ packs: all, loaded: true });
  },
  installBundled: async () => {
    const bundled = loadBundledPacks();
    const levels = loadLevelPacks();
    const installedAt = new Date().toISOString();
    for (const p of [...bundled, ...levels]) {
      const existing = await db.packs.get(p.id);
      if (existing) continue;
      await db.packs.put({ ...p, enabled: true, installedAt });
    }
    await get().loadInstalled();
  },
  installFromJson: async (raw) => {
    const r = validatePack(safeParse(raw));
    if (!r.ok) return { ok: false, error: r.error };
    await db.packs.put({ ...r.pack, enabled: true, installedAt: new Date().toISOString() });
    await get().loadInstalled();
    return { ok: true, id: r.pack.id };
  },
  setEnabled: async (id, enabled) => {
    const cur = await db.packs.get(id);
    if (!cur) return;
    await db.packs.put({ ...cur, enabled });
    await get().loadInstalled();
  },
}));

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
