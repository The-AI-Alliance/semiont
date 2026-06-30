import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/testing.ts` is the `@semiont/core/testing` subpath — the state-unit
  // axiom harness. `fast-check` is externalized: consumers provide it; it never
  // enters the runtime `.` entry, which doesn't import testing.ts.
  entry: ['src/index.ts', 'src/config/node-config-loader.ts', 'src/testing.ts'],
  external: ['fast-check'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
});
