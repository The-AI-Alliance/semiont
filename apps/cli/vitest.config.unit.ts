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
      'src/**/*.unit.test.ts',
      // These tests use mocks even though not named .unit.test.ts
      'src/**/init-command.test.ts',
      'src/**/configure-command.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
    // No setupFiles - unit tests should be isolated
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
});