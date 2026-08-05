import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // SemiontProject requires SEMIONT_ANCHORED_TEXT_DIR — the deployment
    // declares where the anchored-text store lives and it has no default
    // (packages/core/src/project.ts). Tests construct projects over temp dirs,
    // so any real path satisfies it.
    env: { SEMIONT_ANCHORED_TEXT_DIR: '/tmp/semiont-test-anchored-text' },
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