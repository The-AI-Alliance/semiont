import { defineConfig } from 'vitest/config';
import baseConfig from '../../vitest.shared.config.js';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
