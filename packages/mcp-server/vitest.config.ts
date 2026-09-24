import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.shared.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      coverage: {
        include: ['src/**/*.ts'],
        exclude: [
          'src/__fixtures__/**',
          // The entry point boots a stdio server on import, so it can only be
          // exercised as a process — index.e2e.test.ts does that, and v8's
          // instrumentation does not cross the process boundary. Left in, it
          // reports 0% for code that is in fact tested.
          'src/index.ts',
        ],
      },
    },
  }),
);
