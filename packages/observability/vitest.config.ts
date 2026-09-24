import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      // `lcov` is what the Codecov upload reads and `json-summary` is what the
      // workflow's step summary renders; a config emitting neither leaves the
      // pipeline green with nothing to measure, which is why this package was
      // in the job matrix and in no coverage report.
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/index.ts',
      ],
      include: ['src/**/*.ts'],
      // No `thresholds` here deliberately: the shared config's blanket 70 is
      // unenforced everywhere it is not imported, and a floor nobody measured
      // is a number, not a gate. Set one when this package has a baseline.
    },
  },
});
