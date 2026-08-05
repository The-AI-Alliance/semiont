import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // SemiontProject requires SEMIONT_ANCHORED_TEXT_DIR — the deployment
    // declares where the anchored-text store lives and it has no default
    // (packages/core/src/project.ts). Tests construct projects over temp dirs,
    // so any real path satisfies it.
    env: { SEMIONT_ANCHORED_TEXT_DIR: '/tmp/semiont-test-anchored-text' },
    environment: 'node',
    // Regenerate the PDF fixtures before the suite (see generate-fixtures.ts).
    // Keeps `test` a plain `vitest run` and covers watch/coverage/IDE too.
    globalSetup: ['./src/__tests__/generate-fixtures.ts'],
  },
});
