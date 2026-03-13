import type { InferenceFactoryConfig } from '../../factory';

/**
 * Create a test environment config with inference settings
 */
export function createTestConfig(overrides: {
  type?: string;
  model?: string;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
} = {}): InferenceFactoryConfig {
  return {
    services: {
      inference: {
        type: overrides.type ?? 'anthropic',
        model: overrides.model ?? 'claude-3-5-sonnet-20241022',
        apiKey: 'apiKey' in overrides ? overrides.apiKey : 'test-api-key-12345',
        endpoint: overrides.endpoint,
        baseURL: overrides.baseURL,
      },
    },
  } as InferenceFactoryConfig;
}

/**
 * Create config without inference section
 */
export function createConfigWithoutInference(): InferenceFactoryConfig {
  return {
    services: {},
  } as InferenceFactoryConfig;
}

/**
 * Create config with inference but no model
 */
export function createConfigWithoutModel(): InferenceFactoryConfig {
  return {
    services: {
      inference: {
        type: 'anthropic',
        apiKey: 'test-key',
      },
    },
  } as InferenceFactoryConfig;
}

/**
 * Create config with environment variable reference
 */
export function createConfigWithEnvVar(varName: string = 'ANTHROPIC_API_KEY'): InferenceFactoryConfig {
  return {
    services: {
      inference: {
        type: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: `\${${varName}}`,
      },
    },
  } as InferenceFactoryConfig;
}
