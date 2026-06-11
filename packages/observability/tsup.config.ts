import { defineConfig } from 'tsup';

export default defineConfig({
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
