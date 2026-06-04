import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Regenerate the PDF fixtures before the suite (see generate-fixtures.ts).
    // Keeps `test` a plain `vitest run` and covers watch/coverage/IDE too.
    globalSetup: ['./src/__tests__/generate-fixtures.ts'],
  },
});
