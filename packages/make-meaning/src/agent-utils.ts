import type { InferenceConfig } from './config.js';
import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];

/**
 * Build a SoftwareAgent descriptor for annotation generator attribution.
 * Encodes the worker type, inference provider, and model.
 * Used by service.ts to construct the Agent once at worker startup,
 * so workers never need to know about InferenceConfig.
 */
export function inferenceConfigToGenerator(
  workerType: string,
  config: InferenceConfig,
): Agent {
  const providerLabel =
    config.type === 'ollama'    ? `Ollama ${config.model}` :
    config.type === 'anthropic' ? `Anthropic ${config.model}` :
    config.type != null         ? `${config.type} ${config.model}` :
    undefined;

  return {
    '@type': 'SoftwareAgent',
    name: providerLabel ? `${workerType} / ${providerLabel}` : workerType,
    worker: workerType,
    inferenceProvider: config.type,
    model: config.model,
  };
}
