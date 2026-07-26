import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __SEMIONT_VERSION__: JSON.stringify('test'),
  },
  test: {
    name: 'unit',
    environment: 'node',
    globals: true,
    include: ['src/**/*.unit.test.ts'],
    exclude: ['node_modules', 'dist'],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
});
