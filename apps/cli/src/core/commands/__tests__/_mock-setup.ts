/**
 * Shared mock setup for command tests using MockPlatformStrategy
 */

import { vi } from 'vitest';
import { MockPlatform } from '../../../platforms/mock/platform.js';
import { PlatformFactory } from '../../../platforms/index.js';

// Tests share a single MockPlatform instance so they can set state via
// `mockPlatformInstance['mockState']` and have the production code
// (which resolves the platform via PlatformFactory.getPlatform('mock'))
// observe that state. We pre-register our instance in the factory cache.
export const mockPlatformInstance = new MockPlatform();
(PlatformFactory as any).instances.set('mock', mockPlatformInstance);

export async function getMockPlatform(): Promise<MockPlatform> {
  return mockPlatformInstance;
}

// Mock environment-loader for environment config
vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual<typeof import('@semiont/core')>('@semiont/core');
  return {
    ...actual,
    findProjectRoot: vi.fn(() => '/test/project/root'),
    loadEnvironmentConfig: vi.fn((_projectRoot: string, _environment: string) => ({
      _metadata: {
        environment: _environment,
        projectRoot: _projectRoot
      },
      services: {},
      env: { NODE_ENV: 'test' }
    })),
    getAvailableEnvironments: vi.fn(() => ['dev', 'staging', 'production', 'test']),
    isValidEnvironment: vi.fn((env: string) => ['dev', 'staging', 'production', 'test'].includes(env)),
    parseEnvironment: vi.fn((env: string) => {
      const valid = ['dev', 'staging', 'production', 'test'];
      if (valid.includes(env)) return env;
      throw new Error(`Invalid environment: ${env}. Available environments: ${valid.join(', ')}`);
    }),
  };
});

// Mock cli-paths to provide a test project root
vi.mock('../../lib/cli-paths.js', () => ({
  getProjectRoot: vi.fn(() => '/test/project/root')
}));

// Mock fs for state management
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('12345'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ isFile: () => true })
    },
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue('12345')
  };
});

// Helper function to create service deployments for tests
// By default, all services use 'mock' platform for unit testing
export function createServiceDeployments(services: Array<{name: string, type?: string, config?: any}>) {
  return services.map(service => ({
    name: service.name,
    platform: (service.type || 'mock') as any,  // Default to 'mock' platform
    config: service.config || {}
  }));
}

// Helper to reset mock state
export function resetMockState() {
  vi.clearAllMocks();
  mockPlatformInstance['mockState'].clear();
}

// Helper to create mock environment config for tests
export function createMockEnvConfig(environment: string = 'test'): import('@semiont/core').EnvironmentConfig {
  return {
    _metadata: {
      environment,
      projectRoot: '/test/project/root'
    },
    services: {},
    env: { NODE_ENV: 'test' }
  } as import('@semiont/core').EnvironmentConfig;
}