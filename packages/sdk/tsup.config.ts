import { defineConfig } from 'tsup';

export default defineConfig({
  // testing.ts is the `./testing` subpath (SDK-TESTING-DOUBLE.md D1) —
  // nothing enters it from the runtime `.` entry, same layout as core.
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
});
