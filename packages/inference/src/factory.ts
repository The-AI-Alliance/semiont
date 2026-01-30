// Factory for creating inference client instances based on configuration

import type { EnvironmentConfig } from '@semiont/core';
import { InferenceClient } from './interface.js';
import { AnthropicInferenceClient } from './implementations/anthropic.js';

export type InferenceClientType = 'anthropic';

export interface InferenceClientConfig {
  type: InferenceClientType;
  apiKey?: string;
  model: string;
  endpoint?: string;
  baseURL?: string;
}

export function createInferenceClient(config: InferenceClientConfig): InferenceClient {
  switch (config.type) {
    case 'anthropic': {
      if (!config.apiKey || config.apiKey.trim() === '') {
        throw new Error('apiKey is required for Anthropic inference client');
      }
      return new AnthropicInferenceClient(
        config.apiKey,
        config.model,
        config.endpoint || config.baseURL
      );
    }

    default:
      throw new Error(`Unsupported inference client type: ${config.type}`);
  }
}

// Helper function to evaluate environment variable placeholders
function evaluateEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;

  // Replace ${VAR_NAME} with actual environment variable value
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (!envValue) {
      throw new Error(`Environment variable ${varName} is not set. Referenced in configuration as ${match}`);
    }
    return envValue;
  });
}

export async function getInferenceClient(config: EnvironmentConfig): Promise<InferenceClient> {
  const inferenceConfig = config.services.inference;
  if (!inferenceConfig) {
    throw new Error('services.inference is required in environment config');
  }

  if (!inferenceConfig.model) {
    throw new Error('services.inference.model is required in environment config');
  }

  const clientConfig: InferenceClientConfig = {
    type: inferenceConfig.type as InferenceClientType,
    apiKey: evaluateEnvVar(inferenceConfig.apiKey),
    model: inferenceConfig.model,
    endpoint: inferenceConfig.endpoint,
    baseURL: inferenceConfig.baseURL,
  };

  console.log('Inference config loaded:', {
    type: clientConfig.type,
    model: clientConfig.model,
    endpoint: clientConfig.endpoint,
    hasApiKey: !!clientConfig.apiKey
  });

  const client = createInferenceClient(clientConfig);

  console.log(`Initialized ${inferenceConfig.type} inference client with model ${inferenceConfig.model}`);
  return client;
}

/**
 * Get the configured model name
 */
export function getInferenceModel(config: EnvironmentConfig): string {
  const inferenceConfig = config.services.inference;
  if (!inferenceConfig?.model) {
    throw new Error('Inference model not configured! Set it in your environment configuration.');
  }
  return inferenceConfig.model;
}

