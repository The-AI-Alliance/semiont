import type { InferenceServiceConfig } from '@semiont/core';

/**
 * Create a test inference config
 */
export function createTestConfig(overrides: {
  type?: string;
  model?: string;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
} = {}): InferenceServiceConfig {
  return {
    type: overrides.type ?? 'anthropic',
    model: overrides.model ?? 'claude-3-5-sonnet-20241022',
    apiKey: 'apiKey' in overrides ? overrides.apiKey : 'test-api-key-12345',
    endpoint: overrides.endpoint,
    baseURL: overrides.baseURL,
  } as InferenceServiceConfig;
}

/**
 * Create config with inference but no model
 */
export function createConfigWithoutModel(): InferenceServiceConfig {
  return {
    type: 'anthropic',
    apiKey: 'test-key',
  } as InferenceServiceConfig;
}

/**
 * Create config with environment variable reference
 */
export function createConfigWithEnvVar(varName: string = 'ANTHROPIC_API_KEY'): InferenceServiceConfig {
  return {
    type: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    apiKey: `\${${varName}}`,
  } as InferenceServiceConfig;
}
