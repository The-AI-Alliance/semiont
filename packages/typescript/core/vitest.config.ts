import { mergeConfig, defineConfig } from 'vitest/config';
import path from 'path';
import baseConfig from '../../vitest.shared.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: {
        include: ['src/**/*.ts'],
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }),
);
