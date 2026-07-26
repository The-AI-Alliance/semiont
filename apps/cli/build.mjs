#!/usr/bin/env node

/**
 * Build the deprecated `semiont` entry point.
 *
 * This package no longer ships commands — the bundle is a single file that
 * prints a deprecation notice. See src/cli.ts.
 */

import { build } from 'esbuild'
import { readFile, chmod } from 'fs/promises'

const packageJson = JSON.parse(await readFile('package.json', 'utf-8'))
const version = packageJson.version || '0.0.1'

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'dist/cli.mjs',
  define: {
    '__SEMIONT_VERSION__': JSON.stringify(version)
  },
  banner: {
    js: '#!/usr/bin/env node'
  }
})

await chmod('dist/cli.mjs', 0o755)

console.log(`✅ Built deprecated CLI stub (v${version})`)
