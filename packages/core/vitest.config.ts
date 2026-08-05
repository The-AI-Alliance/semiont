import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'scripts/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/index.ts', // Usually just exports
      ],
      include: ['src/**/*.ts'],
      all: true, // Include all source files, even if not tested
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});