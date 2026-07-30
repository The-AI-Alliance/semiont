import { defineConfig } from 'tsup';

export default defineConfig({
  // Two test-only subpaths, split so the optional `fast-check` peer is really
  // optional (SDK-TESTING-DOUBLE gap 7):
  //   `src/testing.ts`        → `@semiont/core/testing`        — doubles, fc-FREE
  //   `src/testing/axioms.ts` → `@semiont/core/testing/axioms` — needs fc
  // `fast-check` is externalized either way (consumers provide it), and neither
  // enters the runtime `.` entry, which imports no testing module.
  entry: [
    'src/index.ts',
    'src/config/node-config-loader.ts',
    'src/testing.ts',
    'src/testing/axioms.ts',
  ],
  external: ['fast-check'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  // REQUIRED, not cosmetic: both testing entries pull `faulty-transport`, and
  // without splitting each bundle gets its OWN class copy — a consumer that
  // spies on `FaultyTransport.prototype` from one entry would miss the
  // instance the other constructs. The sdk hit exactly this (its `dist/
  // testing.js` held private copies and prototype spies silently missed).
  splitting: true,
  treeshake: true,
});
