import { defineConfig } from 'vitest/config';

/**
 * Default configuration that runs ALL tests.
 * For unit tests with mocks, use: npm run test:unit
 * For integration tests with real filesystem, use: npm run test:integration
 * For both sequentially, use: npm run test:all
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // No setupFiles - let each test type handle its own setup
    // Unit tests use mocks, integration tests use setup-env.ts
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
});