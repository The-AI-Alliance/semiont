import { defineConfig } from 'vitest/config';

/**
 * Configuration for integration tests that need real file system and environment setup.
 * These tests use setup-env.ts to create a real test environment.
 */
export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    globals: true,
    include: [
      '**/*.integration.test.ts',
      // Exclude the unit tests that use mocks
      '**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      '**/*.unit.test.ts',
      // These use mocks despite not being named .unit.test.ts
      '**/init-command.test.ts',
      '**/configure-command.test.ts',
    ],
    setupFiles: ['__tests__/setup-env.ts'],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    testTimeout: 30000, // Integration tests may take longer
  },
});