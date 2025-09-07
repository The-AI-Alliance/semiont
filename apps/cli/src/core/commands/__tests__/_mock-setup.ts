/**
 * Shared mock setup for command tests using MockPlatformStrategy
 */

import { vi } from 'vitest';
import { MockPlatform } from '../../../platforms/mock/platform.js';
import { PlatformFactory } from '../../../platforms/index.js';

// Get the singleton MockPlatform instance from PlatformFactory
// This ensures we're using the same instance that the commands will use
export const mockPlatformInstance = PlatformFactory.getPlatform('mock') as MockPlatform;

// No need to mock PlatformFactory - it already supports 'mock' platform
// Just ensure we have a shared instance for test state management
// Note: PlatformFactory.getPlatform('mock') will return the singleton MockPlatform

// Mock platform-resolver for environment config
vi.mock('../../platform-resolver.js', () => ({
  findProjectRoot: vi.fn(() => '/test/project/root'),
  getNodeEnvForEnvironment: vi.fn(() => 'test'),
  loadEnvironmentConfig: vi.fn(() => ({
    name: 'test',
    env: { NODE_ENV: 'test' }
  })),
  getAvailableEnvironments: vi.fn(() => ['dev', 'staging', 'production', 'test']),
  isValidEnvironment: vi.fn((env) => ['dev', 'staging', 'production', 'test'].includes(env)),
  resolveServiceDeployments: vi.fn((services, _env) => services)
}));

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