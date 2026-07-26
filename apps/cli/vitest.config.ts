import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __SEMIONT_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
