import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

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
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    mkdirSync('dist', { recursive: true });
    copyFileSync(
      resolve(__dirname, '../../specs/openapi.json'),
      resolve(__dirname, 'dist/openapi.json'),
    );
  },
});
