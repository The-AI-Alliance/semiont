import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest configuration for packages
 * Individual packages can extend this configuration
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov', 'cobertura'],
      exclude: [
        'node_modules/',
        'dist/',
        'build/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/test/**',
        '**/tests/**',
        '**/examples/**',
        '**/demo/**',
        '**/index.ts', // Export files
        '**/types.ts', // Generated types
      ],
      // Thresholds for coverage - can be overridden per package
      thresholds: {
        global: {
          statements: 70,
          branches: 70,
          functions: 70,
          lines: 70,
        },
      },
    },
  },
});