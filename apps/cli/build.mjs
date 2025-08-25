#!/usr/bin/env node

import { build } from 'esbuild'
import { readdir, mkdir, writeFile, readFile, cp } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

// Read version from package.json
const packageJson = JSON.parse(await readFile('package.json', 'utf-8'))
const version = packageJson.version || '0.0.1'

// Ensure dist/commands directory exists
if (!existsSync('dist')) {
  await mkdir('dist', { recursive: true })
}
if (!existsSync('dist/commands')) {
  await mkdir('dist/commands', { recursive: true })
}

// Get all TypeScript files in the src directory (excluding config files)
const scriptFiles = (await readdir('src', { withFileTypes: true }))
  .filter(dirent => dirent.isFile() && (dirent.name.endsWith('.ts') || dirent.name.endsWith('.tsx')) && dirent.name !== 'build.ts' && !dirent.name.includes('.config.'))
  .map(dirent => dirent.name.replace(/\.tsx?$/, ''))

// Get all TypeScript files in the commands directory
const commandFiles = existsSync('src/commands') 
  ? (await readdir('src/commands', { withFileTypes: true }))
      .filter(dirent => dirent.isFile() && (dirent.name.endsWith('.ts') || dirent.name.endsWith('.tsx')))
      .map(dirent => dirent.name.replace(/\.tsx?$/, ''))
  : []

const totalFiles = scriptFiles.length + commandFiles.length
console.log(`📦 Bundling ${totalFiles} files with esbuild...`)

// Build root files
await Promise.all(scriptFiles.map(async (name) => {
  // Check if .tsx exists first, then .ts
  const tsxExists = existsSync(`src/${name}.tsx`);
  const entryPoint = tsxExists ? `src/${name}.tsx` : `src/${name}.ts`;
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
        // Node.js built-ins that can't be bundled
        'fs',
        'path',
        'child_process',
        'crypto',
        'os',
        'util',
        'stream',
        'events',
        'buffer',
        'url',
        'querystring',
        'module',
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
        // CDK is optional - projects can provide their own
        'aws-cdk-lib',
        'constructs',
        // Local workspace packages
        '@semiont/api-types',
        // Native binaries that can't be bundled
        'ssh2',
        'cpu-features',
        // Large dependencies that work better as external
        '@testcontainers/postgresql',
        '@prisma/client',
        // Express and Socket.IO need to be external due to CommonJS/ESM issues
        'express',
        'socket.io',
        // simple-git uses dynamic requires that don't work with bundling
        'simple-git',
        // esbuild is needed at runtime for compiling CDK stacks
        'esbuild'
      ],
      define: {
        // Disable ink devtools in production bundles
        'process.env.NODE_ENV': '"production"'
      },
      banner: {
        js: '#!/usr/bin/env node\n'
      },
      logLevel: 'warning'
    })
    console.log(`✅ ${name}`)
  } catch (error) {
    console.error(`❌ ${name}:`, error.message)
    process.exit(1)
  }
}))

// Build command files
await Promise.all(commandFiles.map(async (name) => {
  // Check if .tsx exists first, then .ts
  const tsxExists = existsSync(`src/commands/${name}.tsx`);
  const entryPoint = tsxExists ? `src/commands/${name}.tsx` : `src/commands/${name}.ts`;
  const outFile = `dist/commands/${name}.mjs`
  
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
        // Node.js built-ins that can't be bundled
        'fs',
        'path',
        'child_process',
        'crypto',
        'os',
        'util',
        'stream',
        'events',
        'buffer',
        'url',
        'querystring',
        'module',
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
        // CDK is optional - projects can provide their own
        'aws-cdk-lib',
        'constructs',
        // Local workspace packages
        '@semiont/api-types',
        // Native binaries that can't be bundled
        'ssh2',
        'cpu-features',
        // Large dependencies that work better as external
        '@testcontainers/postgresql',
        '@prisma/client',
        // Express and Socket.IO need to be external due to CommonJS/ESM issues
        'express',
        'socket.io',
        // simple-git uses dynamic requires that don't work with bundling
        'simple-git',
        // esbuild is needed at runtime for compiling CDK stacks
        'esbuild'
      ],
      define: {
        'process.env.NODE_ENV': '"production"'
      },
      banner: {
        js: '#!/usr/bin/env node\n'
      },
      logLevel: 'warning'
    })
    console.log(`✅ commands/${name}`)
  } catch (error) {
    console.error(`❌ commands/${name}:`, error.message)
    process.exit(1)
  }
}))

console.log(`🎉 All files bundled successfully!`)

// Copy templates directory to dist
if (existsSync('templates')) {
  try {
    await cp('templates', 'dist/templates', { recursive: true })
    console.log('✅ Copied templates directory')
  } catch (error) {
    console.error('❌ Failed to copy templates:', error.message)
    process.exit(1)
  }
}

// Copy MCP server to dist
const mcpServerSrc = '../../packages/mcp-server/dist'
if (existsSync(mcpServerSrc)) {
  try {
    await cp(mcpServerSrc, 'dist/mcp-server', { recursive: true })
    console.log('✅ Copied MCP server')
  } catch (error) {
    console.error('❌ Failed to copy MCP server:', error.message)
    process.exit(1)
  }
}

