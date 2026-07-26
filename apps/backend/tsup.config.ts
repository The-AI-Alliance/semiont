import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

// The package version is the one `scripts/release/version.mjs` syncs from
// version.json, so it is the version this build will be published as.
const { version } = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8'),
) as { version: string };

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
  // Same convention as apps/cli: the version is injected at build time, never
  // read from the environment. See src/types/build-defines.d.ts.
  define: { __SEMIONT_VERSION__: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    mkdirSync('dist', { recursive: true });
    copyFileSync(
      resolve(__dirname, '../../specs/openapi.json'),
      resolve(__dirname, 'dist/openapi.json'),
    );
  },
});
