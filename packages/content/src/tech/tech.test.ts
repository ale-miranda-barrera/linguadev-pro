import { describe, it, expect } from 'vitest';
import { loadTechSimulations, loadTechSimulationsFor } from './index.js';
import { TECH_TRACKS, getTechTrack } from './tracks.js';
import { TechSimulationSchema } from '@linguadev/shared';
import { TECH_SIMULATIONS_RAW } from './manifest.js';

describe('tech content', () => {
  it('carga y valida todos los sims contra Zod', () => {
    const sims = loadTechSimulations();
    // Debe haber al menos los sims declarados en el manifest — si Zod falla en alguno, este contador baja.
    expect(sims.length).toBe(TECH_SIMULATIONS_RAW.length);
  });

  it('todos los sims raw pasan el schema (fail explícito si alguno no)', () => {
    for (const raw of TECH_SIMULATIONS_RAW) {
      const parsed = TechSimulationSchema.safeParse(raw);
      if (!parsed.success) {
        // Reporte informativo — ayuda a diagnosticar qué sim está roto
        const id = (raw as { id?: string }).id ?? '<sin id>';
        throw new Error(
          `Sim inválido: ${id}\n${JSON.stringify(parsed.error.flatten(), null, 2)}`,
        );
      }
    }
  });

  it('cada sim tiene ID único', () => {
    const sims = loadTechSimulations();
    const ids = sims.map((s) => s.id);
    const set = new Set(ids);
    expect(set.size).toBe(ids.length);
  });

  it('cada pregunta dentro de un sim tiene ID único', () => {
    const sims = loadTechSimulations();
    for (const sim of sims) {
      const qids = sim.questions.map((q) => q.id);
      const set = new Set(qids);
      expect(set.size, `sim ${sim.id} tiene IDs de pregunta duplicados`).toBe(qids.length);
    }
  });

  it('cada pregunta tiene al menos una opción correcta', () => {
    const sims = loadTechSimulations();
    for (const sim of sims) {
      for (const q of sim.questions) {
        const correctCount = q.options.filter((o) => o.correct).length;
        expect(
          correctCount,
          `sim ${sim.id} q ${q.id} no tiene ninguna opción correcta`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('multiSelect true implica >1 opción correcta (single implica exactamente 1)', () => {
    const sims = loadTechSimulations();
    for (const sim of sims) {
      for (const q of sim.questions) {
        const correctCount = q.options.filter((o) => o.correct).length;
        if (q.multiSelect) {
          expect(
            correctCount,
            `sim ${sim.id} q ${q.id} es multiSelect pero solo tiene 1 opción correcta`,
          ).toBeGreaterThan(1);
        } else {
          expect(
            correctCount,
            `sim ${sim.id} q ${q.id} es single pero tiene ${correctCount} opciones correctas`,
          ).toBe(1);
        }
      }
    }
  });

  it('el areaId de cada pregunta existe en el track correspondiente', () => {
    const sims = loadTechSimulations();
    for (const sim of sims) {
      const track = getTechTrack(sim.trackId);
      expect(track, `sim ${sim.id} referencia trackId inexistente: ${sim.trackId}`).toBeDefined();
      const areaIds = new Set(track!.areas.map((a) => a.id));
      for (const q of sim.questions) {
        expect(
          areaIds.has(q.areaId),
          `sim ${sim.id} q ${q.id} usa areaId "${q.areaId}" no declarado en track "${sim.trackId}"`,
        ).toBe(true);
      }
    }
  });

  it('filtra sims por track correctamente', () => {
    const progr = loadTechSimulationsFor('programmer');
    const arch = loadTechSimulationsFor('architecture');
    expect(progr.length).toBeGreaterThan(0);
    expect(arch.length).toBeGreaterThan(0);
    for (const s of progr) expect(s.trackId).toBe('programmer');
    for (const s of arch) expect(s.trackId).toBe('architecture');
  });

  it('TECH_TRACKS declara programmer y architecture', () => {
    const ids = TECH_TRACKS.map((t) => t.id);
    expect(ids).toContain('programmer');
    expect(ids).toContain('architecture');
  });
});
