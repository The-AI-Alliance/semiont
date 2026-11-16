import { defineConfig } from 'tsup';

export default defineConfig({
  // Silenced: tsup lists every emitted artifact, and with `splitting` plus
  // `sourcemap` that is ~2 lines per chunk — react-ui alone printed ~88 for a
  // 619ms build. Failures still fail the command; build.sh prints the per-package
  // check mark. Drop this line temporarily when you want the size column.
  silent: true,
  entry: ['src/index.ts', 'src/node.ts', 'src/web.ts', 'src/process-logger.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  // All deps (OTel SDKs, winston, @semiont/core) stay external — tsup
  // excludes package.json dependencies from the bundle by default.
});
