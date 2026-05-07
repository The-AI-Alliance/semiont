import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/worker-main.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
});
