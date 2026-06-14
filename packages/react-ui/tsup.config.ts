import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'test-utils': 'src/test-utils.tsx',
    'integrations/css-modules-helper': 'src/integrations/css-modules-helper.tsx',
    'integrations/styled-components-theme': 'src/integrations/styled-components-theme.ts',
  },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
  external: ['react', 'react-dom', 'use-sync-external-store', 'vitest'],
  banner: {
    js: "'use client';",
  },
});
