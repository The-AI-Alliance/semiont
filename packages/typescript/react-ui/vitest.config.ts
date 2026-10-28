import { mergeConfig, defineConfig } from 'vitest/config';
import path from 'path';
import baseConfig from '../../vitest.shared.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      coverage: {
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'vitest.setup.ts',
          'src/types/**', // Type definitions
          'src/examples/**', // Example files, not production code
        ],
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }),
);
