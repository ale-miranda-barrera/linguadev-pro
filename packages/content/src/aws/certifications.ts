import type { AwsCertification } from '@linguadev/shared';

// Metadata oficial (2026) — verificado contra AWS_CLF-C02_Guia_Definitiva_2026.md y AWS_SAA-C03_Guia_Definitiva_2026.md
export const AWS_CERTIFICATIONS: AwsCertification[] = [
  {
    id: 'clf-c02',
    name: 'AWS Certified Cloud Practitioner',
    code: 'CLF-C02',
    totalQuestionsInExam: 65,
    timeLimitMin: 90,
    passingScore: 700,
    description:
      'Certificación fundacional AWS. Valida entendimiento general de la nube: conceptos, seguridad, servicios principales y facturación. Ideal para roles no técnicos, iniciados o como base antes de las certificaciones Associate.',
    domains: [
      { id: 'concepts', name: 'Cloud Concepts', weight: 0.24 },
      { id: 'security', name: 'Security & Compliance', weight: 0.30 },
      { id: 'technology', name: 'Cloud Technology & Services', weight: 0.34 },
      { id: 'billing', name: 'Billing, Pricing & Support', weight: 0.12 },
    ],
  },
  {
    id: 'saa-c03',
    name: 'AWS Certified Solutions Architect – Associate',
    code: 'SAA-C03',
    totalQuestionsInExam: 65,
    timeLimitMin: 130,
    passingScore: 720,
    description:
      'Certificación Associate para arquitectos de soluciones. Valida diseño de arquitecturas seguras, resilientes, de alto rendimiento y optimizadas en costo sobre AWS. Recomienda 1 año de experiencia diseñando en AWS.',
    domains: [
      { id: 'secure', name: 'Design Secure Architectures', weight: 0.30 },
      { id: 'resilient', name: 'Design Resilient Architectures', weight: 0.26 },
      { id: 'high-performing', name: 'Design High-Performing Architectures', weight: 0.24 },
      { id: 'cost-optimized', name: 'Design Cost-Optimized Architectures', weight: 0.20 },
    ],
  },
];

export function getCertification(id: string): AwsCertification | undefined {
  return AWS_CERTIFICATIONS.find((c) => c.id === id);
}
