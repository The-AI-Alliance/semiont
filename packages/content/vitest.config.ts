import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.shared.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Regenerate the PDF fixtures before the suite (see generate-fixtures.ts).
      // Keeps `test` a plain `vitest run` and covers watch/coverage/IDE too.
      globalSetup: ['./src/__tests__/generate-fixtures.ts'],
    },
  }),
);
