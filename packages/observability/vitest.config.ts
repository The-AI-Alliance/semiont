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
        // No `**/index.ts` exclusion: that pattern is for barrel files, and
        // this package's `src/index.ts` is not one — it is the entire
        // universal API (spans, traceparent, every metric recorder), 854 of
        // the package's 1313 source lines, with `__tests__/index.test.ts`
        // written against it. Excluding it measured 6% of the package.
      ],
      include: ['src/**/*.ts'],
      // Floors, not aspirations: each is the measured figure rounded down, so
      // an honest refactor has room to move but a real regression fails the
      // run. Raise them when the measurement rises; never lower one to make a
      // red run go green.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 90,
        lines: 95,
      },
    },
  },
});
