import type { TechTrack } from '@linguadev/shared';

// Metadata de los tracks tech no-certificación.
// Contenido pensado como camino real de crecimiento: fundamentos que TODO programador debe tener
// claros, hasta preguntas de nivel senior/staff sobre arquitectura, sistemas distribuidos, tradeoffs.

export const TECH_TRACKS: TechTrack[] = [
  {
    id: 'programmer',
    name: 'Programador',
    tagline: 'Fundamentos → Senior',
    description:
      'Preguntas de práctica que cubren los fundamentos que TODO programador debería dominar antes de llamarse senior: complejidad, estructuras de datos, patrones, SOLID, concurrencia, testing, code smells, refactor. Cada pregunta parte de un escenario real (bug, decisión de diseño, code review) y explica por qué cada opción es correcta o un anti-patrón típico.',
    color: 'brand',
    icon: '💻',
    areas: [
      { id: 'fundamentals', name: 'Fundamentos', description: 'Complejidad, tipos, memoria, referencia vs valor.' },
      { id: 'data-structures', name: 'Estructuras de datos', description: 'Elección de estructura correcta según acceso/tamaño/mutabilidad.' },
      { id: 'algorithms', name: 'Algoritmos', description: 'Ordenamiento, búsqueda, recursión, greedy, DP básica.' },
      { id: 'oop-solid', name: 'OOP + SOLID', description: 'Principios de diseño OO, cohesión, acoplamiento.' },
      { id: 'patterns', name: 'Patrones de diseño', description: 'GoF, patrones de aplicación real, cuándo NO usarlos.' },
      { id: 'concurrency', name: 'Concurrencia', description: 'Threads, locks, async, race conditions, deadlocks.' },
      { id: 'testing', name: 'Testing + calidad', description: 'TDD, mocks vs stubs vs fakes, tests frágiles, cobertura.' },
      { id: 'refactor', name: 'Refactor + code smells', description: 'Long method, feature envy, primitive obsession, cambio incremental seguro.' },
      { id: 'apis', name: 'APIs + protocolos', description: 'REST, GraphQL, gRPC, idempotencia, versioning, error handling.' },
      { id: 'security', name: 'Seguridad', description: 'OWASP top 10, secretos, auth, hashing, injection, XSS/CSRF.' },
    ],
  },
  {
    id: 'architecture',
    name: 'Arquitectura',
    tagline: 'Sistemas · Cloud · Tradeoffs',
    description:
      'Diseño de sistemas: cuándo usar SQL vs NoSQL, cuándo meter Redis, cuándo un event bus (Kafka/SQS/SNS), qué es Cold Start y sus implicaciones en Lambda, cómo escalar, DNS, CDN, patrones de resilencia, monolito vs microservicios, CAP, saga, CQRS, event sourcing. Escenarios reales del tipo "tienes X problema con Y restricciones — ¿qué eliges y por qué?". Sin respuestas fáciles: siempre hay tradeoffs.',
    color: 'cyan',
    icon: '🏛️',
    areas: [
      { id: 'db-choice', name: 'Elección de DB', description: 'SQL vs NoSQL, columnar, grafo, search, tiempo-real.' },
      { id: 'caching', name: 'Caching', description: 'Redis, CDN, cache-aside, write-through, invalidación, stampede.' },
      { id: 'messaging', name: 'Mensajería + eventos', description: 'SQS, SNS, Kafka, pub/sub, sagas, orquestación vs coreografía.' },
      { id: 'microservices', name: 'Microservicios vs monolito', description: 'Cuándo dividir, service boundaries, chatty services, distributed transactions.' },
      { id: 'resilience', name: 'Resilencia + HA', description: 'Retries, circuit breakers, bulkheads, timeouts, backoff, idempotencia.' },
      { id: 'scalability', name: 'Escalabilidad + performance', description: 'Vertical vs horizontal, sharding, latencia vs throughput, N+1, hot partition.' },
      { id: 'networking', name: 'Networking + DNS + CDN', description: 'DNS, TTL, HTTP/2/3, TLS, CORS, ping, RTT, edge, latencia geográfica.' },
      { id: 'serverless', name: 'Serverless', description: 'Cold start, VPC en Lambda, provisioned concurrency, límites, costos.' },
      { id: 'observability', name: 'Observabilidad', description: 'Logs, métricas, tracing, RED/USE, SLIs/SLOs, alerting sano.' },
      { id: 'security-arch', name: 'Seguridad arquitectural', description: 'Zero trust, least privilege, defense in depth, secretos, network segmentation.' },
    ],
  },
  {
    id: 'devops',
    name: 'DevOps',
    tagline: 'CI/CD · Contenedores · SRE',
    description:
      'Todo lo que un DevOps engineer debe dominar para llevar código de commit a producción de forma segura, rápida y observable: cultura y métricas DORA, Git workflows, CI/CD pipelines, Docker y Kubernetes profundo, Helm/Kustomize, IaC (Terraform/Ansible), monitoring stack (Prometheus/Grafana/Loki/Jaeger), SLO management, secretos, container security, supply chain (SLSA/Sigstore), estrategias de deployment (blue/green, canary, feature flags), disaster recovery, chaos engineering, on-call. Escenarios reales de operaciones — no sólo "qué es", sino "cuándo, cómo y por qué".',
    color: 'emerald',
    icon: '⚙️',
    areas: [
      { id: 'culture', name: 'Cultura + métricas DORA', description: 'CALMS, deploy frequency, lead time, MTTR, change failure rate.' },
      { id: 'vcs-ci', name: 'Git + CI', description: 'Trunk-based, GitFlow, GitHub Actions, Jenkins, caching, artefactos.' },
      { id: 'containers', name: 'Docker + contenedores', description: 'Dockerfile, multi-stage, layer cache, security scanning, distroless.' },
      { id: 'kubernetes', name: 'Kubernetes', description: 'Pods, Deployments, StatefulSets, Services, Ingress, RBAC, HPA.' },
      { id: 'iac', name: 'Infrastructure as Code', description: 'Terraform state, modules, Ansible, Pulumi, GitOps con ArgoCD/Flux.' },
      { id: 'monitoring', name: 'Monitoreo + observabilidad', description: 'Prometheus, Grafana, Loki, Jaeger, OpenTelemetry, SLI/SLO.' },
      { id: 'security', name: 'DevSecOps', description: 'SAST/DAST/SCA, container security, secretos (Vault/KMS), OPA.' },
      { id: 'networking', name: 'Networking + service mesh', description: 'DNS, LB, CDN, ingress controllers, Istio, mTLS, Zero Trust.' },
      { id: 'deployment', name: 'Deployment strategies', description: 'Blue/green, canary, rolling, feature flags, dark launches.' },
      { id: 'reliability', name: 'Reliability + on-call', description: 'DR, backups, chaos engineering, incident response, blameless PM.' },
    ],
  },
  {
    id: 'ai-programming',
    name: 'Programando con IA',
    tagline: 'Context · Agents · Evals · Cost · Security',
    description:
      'Todo lo que un programador senior 2026 debería saber para llevar features con LLM a producción sin quemar dinero, filtrar datos ni depender de "vibe coding". Cubre los 10 bloques que hoy diferencian a un dev pro con IA: (1) context engineering (RAG, embeddings, chunking, vector DBs, reranking, memoria), (2) agentes y herramientas (tool calling, MCP, ReAct, orquestación, computer use), (3) evals y observabilidad de LLM (datasets, LLM-as-judge, tracing con Langfuse/Braintrust), (4) seguridad IA (prompt injection, OWASP LLM Top 10, sandboxing, guardrails), (5) economía de inferencia (tokens, prompt caching, batching, streaming, model routing), (6) cuándo NO entrenar (prompting vs RAG vs LoRA vs destilación), (7) infra IA en AWS (Bedrock, SageMaker, vLLM), (8) nuevas prácticas de desarrollo (Spec-Driven Development, repos diseñados para agentes, CLI + IA en CI/CD), (9) datos y gobernanza (PII, EU AI Act, versionado), (10) UX de productos IA + GEO/AEO (posicionamiento en respuestas de IA). Escenarios reales de features en producción: qué eliges, por qué, cuáles son los tradeoffs y qué se rompe.',
    color: 'violet',
    icon: '🤖',
    areas: [
      { id: 'context-engineering', name: 'Context Engineering', description: 'RAG, embeddings, chunking, vector DBs, reranking, memoria persistente, gestión de ventana.' },
      { id: 'agents-tools', name: 'Agentes + herramientas', description: 'Tool/function calling, MCP, loops ReAct, orquestación multi-agente, agentes de código, computer use.' },
      { id: 'evals-observability', name: 'Evals + observabilidad', description: 'Datasets de evaluación, LLM-as-judge, regression tests de prompts, tracing (Langfuse/Braintrust/LangSmith).' },
      { id: 'security', name: 'Seguridad IA', description: 'Prompt injection, OWASP LLM Top 10, sandboxing de agentes, guardrails, exfiltración vía tools.' },
      { id: 'cost-inference', name: 'Economía + inferencia', description: 'Costo por token, prompt caching, batching, streaming, latencia, model routing, fallbacks.' },
      { id: 'model-strategy', name: 'Estrategia de modelo', description: 'Cuándo prompting vs RAG vs fine-tuning (LoRA) vs destilación. Decisión arquitectónica.' },
      { id: 'ai-infra-aws', name: 'Infra IA en AWS', description: 'Bedrock, SageMaker, vLLM, inferencia serverless, GPUs, cuotas y costos.' },
      { id: 'ai-dev-practices', name: 'Nuevas prácticas de dev', description: 'Spec-Driven Development, repos legibles por agentes, CLI, agentes en CI/CD, code review con IA.' },
      { id: 'data-governance', name: 'Datos + gobernanza', description: 'Pipelines de datos para IA, calidad, versionado, PII, EU AI Act, compliance.' },
      { id: 'ai-ux-geo', name: 'UX productos IA + GEO', description: 'Diseño para incertidumbre, human-in-the-loop, GEO/AEO (posicionamiento en respuestas de IA).' },
    ],
  },
];

export function getTechTrack(id: string): TechTrack | undefined {
  return TECH_TRACKS.find((t) => t.id === id);
}
