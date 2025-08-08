#!/usr/bin/env node

import { build } from 'esbuild'
import { readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

// Get all TypeScript files in the scripts directory (excluding lib/ subdirectory)
const scriptFiles = (await readdir('.', { withFileTypes: true }))
  .filter(dirent => dirent.isFile() && (dirent.name.endsWith('.ts') || dirent.name.endsWith('.tsx')) && dirent.name !== 'build.ts')
  .map(dirent => dirent.name.replace(/\.tsx?$/, ''))

console.log(`📦 Bundling ${scriptFiles.length} commands with esbuild...`)

// Build each command as a separate bundle
await Promise.all(scriptFiles.map(async (name) => {
  // Check if .tsx exists first, then .ts
  const tsxExists = existsSync(`${name}.tsx`);
  const entryPoint = tsxExists ? `${name}.tsx` : `${name}.ts`;
  const outFile = `dist/${name}.mjs`
  
  try {
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      outfile: outFile,
      jsx: 'automatic',
      jsxImportSource: 'react',
      external: [
        // Don't bundle these Node.js built-ins and external binaries
        'aws-cli',
        'docker',
        'podman',
        // React and Ink - keep external to avoid ESM/top-level await issues
        'react',
        'ink',
        'react-devtools-core',
        // AWS SDK packages have complex CommonJS/ESM interactions
        '@aws-sdk/*',
        // Local workspace packages
        '@semiont/config-loader',
        '@semiont/api-types',
        '@semiont/cloud',
        // Native binaries that can't be bundled
        'ssh2',
        'cpu-features',
        // Large dependencies that work better as external
        '@testcontainers/postgresql',
        '@prisma/client'
      ],
      define: {
        // Disable ink devtools in production bundles
        'process.env.NODE_ENV': '"production"'
      },
      banner: {
        js: '#!/usr/bin/env node'
      },
      logLevel: 'warning'
    })
    console.log(`✅ ${name}`)
  } catch (error) {
    console.error(`❌ ${name}:`, error.message)
    process.exit(1)
  }
}))

console.log(`🎉 All commands bundled successfully!`)