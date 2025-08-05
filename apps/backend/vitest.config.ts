import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
      'src/**/*.spec.ts'
    ],
    exclude: [
      'node_modules',
      'dist',
      'src/**/*.d.ts'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/__tests__/',
        '**/*.d.ts',
        '**/*.config.*',
        'src/index.ts', // Exclude main server file from coverage
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
    testTimeout: 10000,
    // Enable type checking for tests
    typecheck: {
      enabled: true
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});