/**
 * Shared mock setup for command tests using MockPlatformStrategy
 */

import { vi } from 'vitest';
import { MockPlatformStrategy } from '../../platforms/mock-platform.js';

// Ensure we have a single global instance
if (!(globalThis as any).__mockPlatformInstance) {
  (globalThis as any).__mockPlatformInstance = new MockPlatformStrategy();
}

// Export the shared instance
export const mockPlatformInstance = (globalThis as any).__mockPlatformInstance as MockPlatformStrategy;

// Mock PlatformFactory to use MockPlatformStrategy for all platforms
vi.mock('../../platforms/index.js', () => {
  // Make sure we have the instance available at module resolution time
  if (!(globalThis as any).__mockPlatformInstance) {
    const { MockPlatformStrategy } = require('../../platforms/mock-platform.js');
    (globalThis as any).__mockPlatformInstance = new MockPlatformStrategy();
  }
  
  return {
    PlatformFactory: {
      getPlatform: vi.fn(() => {
        // Return the global instance
        return (globalThis as any).__mockPlatformInstance;
      })
    }
  };
});

// Mock platform-resolver for environment config
vi.mock('../../platforms/platform-resolver.js', () => ({
  getNodeEnvForEnvironment: vi.fn(() => 'test'),
  loadEnvironmentConfig: vi.fn(() => ({
    name: 'test',
    env: { NODE_ENV: 'test' }
  }))
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
export function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>) {
  return services.map(service => ({
    name: service.name,
    platform: service.type as any,
    config: service.config || {}
  }));
}

// Helper to reset mock state
export function resetMockState() {
  vi.clearAllMocks();
  mockPlatformInstance['mockState'].clear();
}