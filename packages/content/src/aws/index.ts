import type { AwsSimulation } from '@linguadev/shared';
import { AwsSimulationSchema } from '@linguadev/shared';
import { AWS_SIMULATIONS_RAW } from './manifest.js';

export { AWS_CERTIFICATIONS, getCertification } from './certifications.js';

export function loadAwsSimulations(): AwsSimulation[] {
  const out: AwsSimulation[] = [];
  for (const raw of AWS_SIMULATIONS_RAW) {
    const parsed = AwsSimulationSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
    else console.warn('[aws-content] simulación inválida:', parsed.error.flatten());
  }
  return out.sort((a, b) => {
    if (a.certId !== b.certId) return a.certId.localeCompare(b.certId);
    return a.order - b.order;
  });
}

export function loadAwsSimulationsFor(certId: 'clf-c02' | 'saa-c03'): AwsSimulation[] {
  return loadAwsSimulations().filter((s) => s.certId === certId);
}
