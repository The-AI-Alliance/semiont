import { defineConfig } from 'tsup';

export default defineConfig({
  // Silenced: tsup lists every emitted artifact, and with `splitting` plus
  // `sourcemap` that is ~2 lines per chunk — react-ui alone printed ~88 for a
  // 619ms build. Failures still fail the command; build.sh prints the per-package
  // check mark. Drop this line temporarily when you want the size column.
  silent: true,
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
