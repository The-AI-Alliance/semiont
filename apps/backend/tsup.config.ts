import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: 'node20',
  platform: 'node',
  noExternal: [],
});
