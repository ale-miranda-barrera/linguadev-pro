// Import estático de todos los simulacros tech (paralelo al manifest de AWS).
// Cuando añadas más JSONs, agrega su import aquí.

import sim_programmer_01 from './programmer/sim-01-fundamentals-and-complexity.json' with { type: 'json' };
import sim_programmer_02 from './programmer/sim-02-solid-and-patterns.json' with { type: 'json' };
import sim_programmer_03 from './programmer/sim-03-concurrency-and-async.json' with { type: 'json' };
import sim_programmer_04 from './programmer/sim-04-testing-and-refactor.json' with { type: 'json' };
import sim_programmer_05 from './programmer/sim-05-apis-and-security.json' with { type: 'json' };
import sim_programmer_06 from './programmer/sim-06-memory-and-gc.json' with { type: 'json' };
import sim_programmer_07 from './programmer/sim-07-networking-http-and-tcp.json' with { type: 'json' };
import sim_programmer_08 from './programmer/sim-08-jit-vm-and-performance.json' with { type: 'json' };
import sim_programmer_09 from './programmer/sim-09-async-patterns-deep.json' with { type: 'json' };
import sim_programmer_10 from './programmer/sim-10-error-handling-and-recovery.json' with { type: 'json' };
import sim_programmer_11 from './programmer/sim-11-databases-for-devs.json' with { type: 'json' };
import sim_programmer_12 from './programmer/sim-12-git-and-collaboration.json' with { type: 'json' };
import sim_programmer_13 from './programmer/sim-13-docker-and-containers.json' with { type: 'json' };
import sim_programmer_14 from './programmer/sim-14-linux-and-shell.json' with { type: 'json' };
import sim_programmer_15 from './programmer/sim-15-observability-for-devs.json' with { type: 'json' };
import sim_architecture_01 from './architecture/sim-01-db-choice.json' with { type: 'json' };
import sim_architecture_02 from './architecture/sim-02-messaging-and-microservices.json' with { type: 'json' };
import sim_architecture_03 from './architecture/sim-03-serverless-and-networking.json' with { type: 'json' };
import sim_architecture_04 from './architecture/sim-04-resilience-patterns.json' with { type: 'json' };
import sim_architecture_05 from './architecture/sim-05-observability-and-scale.json' with { type: 'json' };
import sim_architecture_06 from './architecture/sim-06-cap-and-consistency.json' with { type: 'json' };
import sim_architecture_07 from './architecture/sim-07-event-sourcing-and-cqrs.json' with { type: 'json' };
import sim_architecture_08 from './architecture/sim-08-consensus-and-coordination.json' with { type: 'json' };
import sim_architecture_09 from './architecture/sim-09-cloud-native-patterns.json' with { type: 'json' };
import sim_architecture_10 from './architecture/sim-10-security-architecture.json' with { type: 'json' };
import sim_architecture_11 from './architecture/sim-11-lambda-serverless-deep.json' with { type: 'json' };
import sim_architecture_12 from './architecture/sim-12-migrations-zero-downtime.json' with { type: 'json' };
import sim_architecture_13 from './architecture/sim-13-chaos-and-testing-production.json' with { type: 'json' };
import sim_architecture_14 from './architecture/sim-14-multi-region-and-dr.json' with { type: 'json' };
import sim_architecture_15 from './architecture/sim-15-cost-optimization.json' with { type: 'json' };
import sim_devops_01 from './devops/sim-01-devops-culture-and-dora.json' with { type: 'json' };
import sim_devops_02 from './devops/sim-02-continuous-delivery-fundamentals.json' with { type: 'json' };
import sim_devops_03 from './devops/sim-03-git-workflows-and-branching.json' with { type: 'json' };
import sim_devops_04 from './devops/sim-04-github-actions-and-jenkins.json' with { type: 'json' };
import sim_devops_05 from './devops/sim-05-docker-fundamentals.json' with { type: 'json' };
import sim_devops_06 from './devops/sim-06-container-security-and-registries.json' with { type: 'json' };
import sim_devops_07 from './devops/sim-07-kubernetes-fundamentals.json' with { type: 'json' };
import sim_devops_08 from './devops/sim-08-kubernetes-workloads.json' with { type: 'json' };
import sim_devops_09 from './devops/sim-09-kubernetes-networking-storage.json' with { type: 'json' };
import sim_devops_10 from './devops/sim-10-helm-and-kustomize.json' with { type: 'json' };
import sim_devops_11 from './devops/sim-11-kubernetes-security.json' with { type: 'json' };
import sim_devops_12 from './devops/sim-12-terraform-fundamentals.json' with { type: 'json' };
import sim_devops_13 from './devops/sim-13-ansible-and-config-management.json' with { type: 'json' };
import sim_devops_14 from './devops/sim-14-cloud-fundamentals-and-multi-cloud.json' with { type: 'json' };
import sim_devops_15 from './devops/sim-15-gitops-with-argocd-flux.json' with { type: 'json' };
import sim_devops_16 from './devops/sim-16-pulumi-cdk-and-modern-iac.json' with { type: 'json' };
import sim_devops_17 from './devops/sim-17-prometheus-and-metrics.json' with { type: 'json' };
import sim_devops_18 from './devops/sim-18-grafana-and-dashboards.json' with { type: 'json' };
import sim_devops_19 from './devops/sim-19-logging-elk-loki.json' with { type: 'json' };
import sim_devops_20 from './devops/sim-20-distributed-tracing.json' with { type: 'json' };
import sim_devops_21 from './devops/sim-21-slo-management-and-error-budgets.json' with { type: 'json' };
import sim_devops_22 from './devops/sim-22-devsecops-fundamentals.json' with { type: 'json' };
import sim_devops_23 from './devops/sim-23-secrets-management-vault-kms.json' with { type: 'json' };
import sim_devops_24 from './devops/sim-24-supply-chain-security.json' with { type: 'json' };
import sim_devops_25 from './devops/sim-25-policy-as-code-opa-kyverno.json' with { type: 'json' };
import sim_devops_26 from './devops/sim-26-compliance-and-audit.json' with { type: 'json' };
import sim_devops_27 from './devops/sim-27-dns-and-load-balancing.json' with { type: 'json' };
import sim_devops_28 from './devops/sim-28-cdn-and-edge-computing.json' with { type: 'json' };
import sim_devops_29 from './devops/sim-29-service-mesh-istio-linkerd.json' with { type: 'json' };
import sim_devops_30 from './devops/sim-30-api-gateways.json' with { type: 'json' };
import sim_devops_31 from './devops/sim-31-network-security-mtls-zero-trust.json' with { type: 'json' };
import sim_devops_32 from './devops/sim-32-blue-green-canary-rolling.json' with { type: 'json' };
import sim_devops_33 from './devops/sim-33-progressive-delivery-flagger-argo-rollouts.json' with { type: 'json' };
import sim_devops_34 from './devops/sim-34-feature-flags-at-scale.json' with { type: 'json' };
import sim_devops_35 from './devops/sim-35-database-migrations-zero-downtime.json' with { type: 'json' };
import sim_devops_36 from './devops/sim-36-artifact-management-and-caching.json' with { type: 'json' };
import sim_devops_37 from './devops/sim-37-disaster-recovery-and-backups.json' with { type: 'json' };
import sim_devops_38 from './devops/sim-38-chaos-engineering-in-practice.json' with { type: 'json' };
import sim_devops_39 from './devops/sim-39-incident-response-and-oncall.json' with { type: 'json' };
import sim_devops_40 from './devops/sim-40-cost-optimization-finops.json' with { type: 'json' };
import sim_ai_01 from './ai-programming/sim-01-fundamentals-tokens-context.json' with { type: 'json' };
import sim_ai_02 from './ai-programming/sim-02-rag-embeddings-chunking.json' with { type: 'json' };
import sim_ai_03 from './ai-programming/sim-03-vector-dbs-hybrid-reranking.json' with { type: 'json' };
import sim_ai_04 from './ai-programming/sim-04-context-memory-caching.json' with { type: 'json' };
import sim_ai_05 from './ai-programming/sim-05-tool-function-calling.json' with { type: 'json' };
import sim_ai_06 from './ai-programming/sim-06-mcp-model-context-protocol.json' with { type: 'json' };
import sim_ai_07 from './ai-programming/sim-07-agent-loops-orchestration.json' with { type: 'json' };
import sim_ai_08 from './ai-programming/sim-08-code-agents-computer-use.json' with { type: 'json' };
import sim_ai_09 from './ai-programming/sim-09-evals-datasets-llm-judge.json' with { type: 'json' };
import sim_ai_10 from './ai-programming/sim-10-llm-observability-tracing.json' with { type: 'json' };
import sim_ai_11 from './ai-programming/sim-11-prompt-injection-owasp-llm.json' with { type: 'json' };
import sim_ai_12 from './ai-programming/sim-12-agent-sandboxing-guardrails.json' with { type: 'json' };
import sim_ai_13 from './ai-programming/sim-13-inference-cost-prompt-caching.json' with { type: 'json' };
import sim_ai_14 from './ai-programming/sim-14-latency-streaming-model-routing.json' with { type: 'json' };
import sim_ai_15 from './ai-programming/sim-15-prompting-vs-rag-vs-finetuning.json' with { type: 'json' };
import sim_ai_16 from './ai-programming/sim-16-ai-infra-aws-bedrock-sagemaker.json' with { type: 'json' };
import sim_ai_17 from './ai-programming/sim-17-spec-driven-development-agent-ready-repos.json' with { type: 'json' };
import sim_ai_18 from './ai-programming/sim-18-cli-agents-ci-cd-code-review.json' with { type: 'json' };
import sim_ai_19 from './ai-programming/sim-19-data-pipelines-pii-eu-ai-act.json' with { type: 'json' };
import sim_ai_20 from './ai-programming/sim-20-ai-product-ux-geo-aeo.json' with { type: 'json' };

export const TECH_SIMULATIONS_RAW: unknown[] = [
  sim_programmer_01,
  sim_programmer_02,
  sim_programmer_03,
  sim_programmer_04,
  sim_programmer_05,
  sim_programmer_06,
  sim_programmer_07,
  sim_programmer_08,
  sim_programmer_09,
  sim_programmer_10,
  sim_programmer_11,
  sim_programmer_12,
  sim_programmer_13,
  sim_programmer_14,
  sim_programmer_15,
  sim_architecture_01,
  sim_architecture_02,
  sim_architecture_03,
  sim_architecture_04,
  sim_architecture_05,
  sim_architecture_06,
  sim_architecture_07,
  sim_architecture_08,
  sim_architecture_09,
  sim_architecture_10,
  sim_architecture_11,
  sim_architecture_12,
  sim_architecture_13,
  sim_architecture_14,
  sim_architecture_15,
  sim_devops_01,
  sim_devops_02,
  sim_devops_03,
  sim_devops_04,
  sim_devops_05,
  sim_devops_06,
  sim_devops_07,
  sim_devops_08,
  sim_devops_09,
  sim_devops_10,
  sim_devops_11,
  sim_devops_12,
  sim_devops_13,
  sim_devops_14,
  sim_devops_15,
  sim_devops_16,
  sim_devops_17,
  sim_devops_18,
  sim_devops_19,
  sim_devops_20,
  sim_devops_21,
  sim_devops_22,
  sim_devops_23,
  sim_devops_24,
  sim_devops_25,
  sim_devops_26,
  sim_devops_27,
  sim_devops_28,
  sim_devops_29,
  sim_devops_30,
  sim_devops_31,
  sim_devops_32,
  sim_devops_33,
  sim_devops_34,
  sim_devops_35,
  sim_devops_36,
  sim_devops_37,
  sim_devops_38,
  sim_devops_39,
  sim_devops_40,
  sim_ai_01,
  sim_ai_02,
  sim_ai_03,
  sim_ai_04,
  sim_ai_05,
  sim_ai_06,
  sim_ai_07,
  sim_ai_08,
  sim_ai_09,
  sim_ai_10,
  sim_ai_11,
  sim_ai_12,
  sim_ai_13,
  sim_ai_14,
  sim_ai_15,
  sim_ai_16,
  sim_ai_17,
  sim_ai_18,
  sim_ai_19,
  sim_ai_20,
];
