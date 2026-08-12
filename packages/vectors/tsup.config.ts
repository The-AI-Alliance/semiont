import { defineConfig } from 'tsup';

export default defineConfig({
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
