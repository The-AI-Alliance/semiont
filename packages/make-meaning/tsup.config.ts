import { defineConfig } from 'tsup';

export default defineConfig({
  // Silenced: tsup lists every emitted artifact, and with `splitting` plus
  // `sourcemap` that is ~2 lines per chunk — react-ui alone printed ~88 for a
  // 619ms build. Failures still fail the command; build.sh prints the per-package
  // check mark. Drop this line temporarily when you want the size column.
  silent: true,
  entry: {
    index: 'src/index.ts',
    'smelter-main': 'src/smelter-main.ts',
    'weaver-main': 'src/weaver-main.ts',
    'librarian-main': 'src/librarian-main.ts',
  },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
  splitting: false,
  treeshake: true,
});
