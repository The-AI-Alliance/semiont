import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

// The package version is the one `scripts/release/version.mjs` syncs from
// version.json, so it is the version this build will be published as.
const { version } = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8'),
) as { version: string };

export default defineConfig({
  // Silenced: tsup lists every emitted artifact, and with `splitting` plus
  // `sourcemap` that is ~2 lines per chunk — react-ui alone printed ~88 for a
  // 619ms build. Failures still fail the command; build.sh prints the per-package
  // check mark. Drop this line temporarily when you want the size column.
  silent: true,
  // Two entries besides the server, both run as their own processes:
  //   db-url  — the container's CMD, before `migrate deploy` and before the
  //             server (see src/cli/db-url.ts for why it cannot live in index.ts)
  //   useradd — `semiont useradd` execs it via `container exec`
  entry: ['src/index.ts', 'src/cli/db-url.ts', 'src/cli/useradd.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: 'node20',
  platform: 'node',
  noExternal: [],
  // The version is injected at build time, never read from the environment.
  // See src/types/build-defines.d.ts.
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
