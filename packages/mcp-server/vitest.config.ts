import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__fixtures__/**',
        // The entry point boots a stdio server on import, so it can only be
        // exercised as a process — index.e2e.test.ts does that, and v8's
        // instrumentation does not cross the process boundary. Left in, it
        // reports 0% for code that is in fact tested.
        'src/index.ts',
      ]
    }
  }
});