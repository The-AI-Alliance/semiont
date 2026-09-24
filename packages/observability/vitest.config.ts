import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.shared.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
      exclude: ['node_modules', 'dist'],
    },
  }),
);
