import { defineConfig } from 'tsup';

export default defineConfig({
  // testing.ts is the `./testing` subpath (SDK-TESTING-DOUBLE.md D1) —
  // nothing enters it from the runtime `.` entry, same layout as core.
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  // MUST be true with two entries: `false` gives dist/testing.js its OWN
  // copies of SemiontClient/AuthNamespace, so consumer prototype spies (the
  // AuthShell pattern) silently miss clients built by createTestClient —
  // found as 5s timeouts in the welcome pilot (SESSION-TYPED-FACTORIES P2).
  // Shared chunks = one class identity across both entries.
  splitting: true,
  treeshake: true,
});
