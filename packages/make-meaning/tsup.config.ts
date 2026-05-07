import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/smelter-main.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
  splitting: false,
  treeshake: true,
});
