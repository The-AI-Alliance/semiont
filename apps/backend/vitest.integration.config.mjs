import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration tests use different setup - real database via Testcontainers, SEMIONT_ENV=integration
    setupFiles: ['./src/__tests__/setup/test-setup.ts'],
    // Don't fail on uncaught exceptions from intentional error tests
    dangerouslyIgnoreUnhandledErrors: true,
    include: [
      'src/__tests__/integration/**/*.test.ts'
    ],
    exclude: [
      'node_modules',
      'dist',
      'src/**/*.d.ts'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      exclude: [
        'node_modules/',
        'src/__tests__/',
        '**/*.d.ts',
        '**/*.config.*',
        'dist/'
      ],
      reportsDirectory: './coverage',
      thresholds: {
        global: {
          branches: 70,
          functions: 70,
          lines: 70,
          statements: 70
        }
      }
    },
    // Longer timeouts for container operations
    testTimeout: 120000,
    hookTimeout: 120000,
    // Enable type checking for tests
    typecheck: {
      enabled: true
    },
    // Pool options for integration tests
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true, // Run integration tests sequentially to avoid container conflicts
        isolate: true
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});