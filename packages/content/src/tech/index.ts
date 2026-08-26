import type { TechSimulation, TechTrackId } from '@linguadev/shared';
import { TechSimulationSchema } from '@linguadev/shared';
import { TECH_SIMULATIONS_RAW } from './manifest.js';

export { TECH_TRACKS, getTechTrack } from './tracks.js';

export function loadTechSimulations(): TechSimulation[] {
  const out: TechSimulation[] = [];
  for (const raw of TECH_SIMULATIONS_RAW) {
    const parsed = TechSimulationSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
    else console.warn('[tech-content] simulación inválida:', parsed.error.flatten());
  }
  return out.sort((a, b) => {
    if (a.trackId !== b.trackId) return a.trackId.localeCompare(b.trackId);
    return a.order - b.order;
  });
}

export function loadTechSimulationsFor(trackId: TechTrackId): TechSimulation[] {
  return loadTechSimulations().filter((s) => s.trackId === trackId);
}
