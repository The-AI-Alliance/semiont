import { mergeConfig, defineConfig } from 'vitest/config';
import path from 'path';
import baseConfig from '../../vitest.shared.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: {
        include: ['src/**/*.ts'],
        exclude: ['scripts/**'],
        all: true, // Include all source files, even if not tested
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }),
);
