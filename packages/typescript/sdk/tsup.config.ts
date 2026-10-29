import { defineConfig } from 'tsup';

export default defineConfig({
  // Silenced: tsup lists every emitted artifact, and with `splitting` plus
  // `sourcemap` that is ~2 lines per chunk — react-ui alone printed ~88 for a
  // 619ms build. Failures still fail the command; build.sh prints the per-package
  // check mark. Drop this line temporarily when you want the size column.
  silent: true,
  // testing.ts is the `./testing` subpath — nothing enters it from the
  // runtime `.` entry, same layout as core.
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  // MUST be true with two entries: `false` gives dist/testing.js its OWN
  // copies of SemiontClient/AuthNamespace, so consumer prototype spies (the
  // AuthShell pattern) silently miss clients built by createTestClient —
  // found as 5s timeouts when the welcome page was converted to
  // session-typed state-unit factories. Shared chunks = one class identity
  // across both entries.
  splitting: true,
  treeshake: true,
});
