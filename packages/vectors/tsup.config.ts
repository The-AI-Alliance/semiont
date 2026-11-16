import { defineConfig } from 'tsup';

export default defineConfig({
  // Silenced: tsup lists every emitted artifact, and with `splitting` plus
  // `sourcemap` that is ~2 lines per chunk — react-ui alone printed ~88 for a
  // 619ms build. Failures still fail the command; build.sh prints the per-package
  // check mark. Drop this line temporarily when you want the size column.
  silent: true,
  // Two entries: the runtime surface, and `@semiont/vectors/testing` — the test
  // doubles, which consumers import from their suites and nothing in the
  // runtime entry imports.
  entry: [
    'src/index.ts',
    'src/testing.ts',
  ],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // Required the moment there is more than one entry: without splitting, each
  // entry inlines its own PRIVATE copy of any shared module, so a class
  // constructed via one entry is not `instanceof` the one exported by the
  // other and prototype spies miss. `@semiont/core`'s config records the
  // incident (the sdk's dist/testing.js), and react-ui is a live instance.
  // Today `testing.ts` imports only a type, so nothing is shared yet — this
  // holds the line for when it imports something runtime.
  splitting: true,
  treeshake: true,
});
