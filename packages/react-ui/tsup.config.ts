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
  // Already the tsup default for esm, but stated because it is load-bearing
  // here and the default is format-dependent: `index` and `test-utils` both
  // pull the provider modules, and unsplit each entry would get its OWN
  // `SemiontContext`/`ToastContext`. A test wrapping in test-utils'
  // `SemiontProvider` while the component reads its hook from the index would
  // then resolve a different context object and the provider would silently
  // fail to satisfy it. Adding 'cjs' to `format` above would flip the default
  // to false for that output and reintroduce exactly that — keep this true.
  splitting: true,
  // NOT treeshake: true (unlike every other package here). tsup runs rollup
  // for treeshaking, which drops the `'use client'` banner below from all
  // outputs — verified: 41/41 files lose it, with or without splitting. The
  // banner is what makes this package usable from a React Server Components
  // consumer, so it outranks the ~1.6% bundle saving treeshaking buys.
  banner: {
    js: "'use client';",
  },
});
