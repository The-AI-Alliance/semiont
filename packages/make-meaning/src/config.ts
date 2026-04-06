import type { GraphServiceConfig, VectorsServiceConfig } from '@semiont/core';

/**
 * Inference configuration for a single actor or worker.
 */
export interface InferenceConfig {
  type: 'anthropic' | 'ollama';
  model: string;
  maxTokens?: number;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
}

/**
 * Per-actor inference overrides.
 * Stower never calls an LLM, so it has no entry here.
 */
export interface ActorInferenceConfig {
  gatherer?: InferenceConfig;
  matcher?: InferenceConfig;
}

/**
 * Per-worker-type inference overrides.
 * Falls back to `workers.default` if a specific worker is not listed.
 */
export interface WorkerInferenceConfig {
  default?: InferenceConfig;
  'reference-annotation'?: InferenceConfig;
  'highlight-annotation'?: InferenceConfig;
  'assessment-annotation'?: InferenceConfig;
  'comment-annotation'?: InferenceConfig;
  'tag-annotation'?: InferenceConfig;
  'generation'?: InferenceConfig;
}

/** Narrow config type — only the fields make-meaning actually reads */
export interface MakeMeaningConfig {
  services: {
    graph?: GraphServiceConfig;
    vectors?: VectorsServiceConfig;
  };
  /** Per-actor inference config */
  actors?: ActorInferenceConfig;
  /** Per-worker-type inference config */
  workers?: WorkerInferenceConfig;
}

/**
 * Resolve inference config for a named actor.
 */
export function resolveActorInference(
  config: MakeMeaningConfig,
  actor: 'gatherer' | 'matcher'
): InferenceConfig {
  const specific = config.actors?.[actor];
  if (specific) return specific;

  throw new Error(
    `No inference config found for actor '${actor}'. ` +
    `Set actors.${actor}.inference in your config.`
  );
}

/**
 * Resolve inference config for a named worker type.
 * Falls back to workers.default if a specific worker is not listed.
 */
export function resolveWorkerInference(
  config: MakeMeaningConfig,
  workerType: keyof Omit<WorkerInferenceConfig, 'default'>
): InferenceConfig {
  const specific = config.workers?.[workerType];
  if (specific) return specific;

  const defaultWorker = config.workers?.default;
  if (defaultWorker) return defaultWorker;

  throw new Error(
    `No inference config found for worker '${workerType}'. ` +
    `Set workers.${workerType}.inference or workers.default.inference in your config.`
  );
}
