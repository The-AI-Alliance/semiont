import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Unit tests only use the unit test setup (mocks Prisma, uses SEMIONT_ENV=unit)
    setupFiles: ['./src/__tests__/setup.ts'],
    // Don't fail on uncaught exceptions from intentional error tests
    dangerouslyIgnoreUnhandledErrors: true,
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
      'src/**/*.spec.ts'
    ],
    exclude: [
      'node_modules',
      'dist',
      'src/**/*.d.ts',
      // Exclude integration tests from main config - they use separate config
      'src/__tests__/integration/**/*.test.ts'
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
    // Increased timeouts for container operations
    testTimeout: 60000,
    hookTimeout: 60000,
    // Enable type checking for tests
    typecheck: {
      enabled: true
    },
    // Pool options for integration tests
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
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