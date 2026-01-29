import type { EnvironmentConfig } from '@semiont/core';

/**
 * Create a test environment config with inference settings
 */
export function createTestConfig(overrides: {
  type?: string;
  model?: string;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
} = {}): EnvironmentConfig {
  return {
    services: {
      inference: {
        type: overrides.type ?? 'anthropic',
        model: overrides.model ?? 'claude-3-5-sonnet-20241022',
        apiKey: overrides.apiKey ?? 'test-api-key-12345',
        endpoint: overrides.endpoint,
        baseURL: overrides.baseURL,
      },
      graph: {
        type: 'memory',
      },
    },
  } as EnvironmentConfig;
}

/**
 * Create config without inference section
 */
export function createConfigWithoutInference(): EnvironmentConfig {
  return {
    services: {
      graph: {
        type: 'memory',
      },
    },
  } as EnvironmentConfig;
}

/**
 * Create config with inference but no model
 */
export function createConfigWithoutModel(): EnvironmentConfig {
  return {
    services: {
      inference: {
        type: 'anthropic',
        apiKey: 'test-key',
      },
      graph: {
        type: 'memory',
      },
    },
  } as EnvironmentConfig;
}

/**
 * Create config with environment variable reference
 */
export function createConfigWithEnvVar(varName: string = 'ANTHROPIC_API_KEY'): EnvironmentConfig {
  return {
    services: {
      inference: {
        type: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: `\${${varName}}`,
      },
      graph: {
        type: 'memory',
      },
    },
  } as EnvironmentConfig;
}
