import { defineConfig } from 'vitest/config';

/**
 * Configuration for unit tests that use mocks.
 * These tests should not have setup-env.ts which creates real files.
 */
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    globals: true,
    include: [
      '**/*.unit.test.ts',
      // These tests use mocks even though not named .unit.test.ts
      '**/init-command.test.ts',
      '**/configure-command.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
    // No setupFiles - unit tests should be isolated
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
});