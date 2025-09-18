#!/usr/bin/env node

import { build } from 'esbuild'
import { readdir, mkdir, writeFile, readFile, cp } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

// Read version from package.json
const packageJson = JSON.parse(await readFile('package.json', 'utf-8'))
const version = packageJson.version || '0.0.1'

// Ensure dist directory exists
if (!existsSync('dist')) {
  await mkdir('dist', { recursive: true })
}

// Build dashboard bundle first
console.log('🎨 Building web dashboard...')
const dashboardDir = join('dist', 'dashboard')
if (!existsSync(dashboardDir)) {
  await mkdir(dashboardDir, { recursive: true })
}

try {
  // Build the React dashboard bundle
  await build({
    entryPoints: ['src/core/dashboard/web-dashboard-app.tsx'],
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'iife',
    globalName: 'SemiontDashboard',
    outfile: join(dashboardDir, 'dashboard.js'),
    platform: 'browser',
    target: ['chrome90', 'firefox88', 'safari14', 'edge90'],
    define: {
      'process.env.NODE_ENV': '"production"',
      'global': 'window'
    },
    banner: {
      js: `
// Map external modules to globals
const React = window.React;
const ReactDOM = window.ReactDOM;
const require = (name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error('Unknown module: ' + name);
};
`
    },
    footer: {
      js: '// Ensure global is set\nif (typeof window !== "undefined") { window.SemiontDashboard = SemiontDashboard; }'
    },
    external: [
      // These are loaded via CDN in the HTML
      'react',
      'react-dom'
    ],
    loader: {
      '.tsx': 'tsx',
      '.ts': 'ts'
    }
  })

  // Create CSS file
  const cssContent = `
/* Semiont Web Dashboard Styles */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  min-height: 100vh;
  padding: 20px;
}

.dashboard-container {
  max-width: 1400px;
  margin: 0 auto;
}

.dashboard-header {
  background: white;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.dashboard-title {
  font-size: 24px;
  font-weight: bold;
  color: #2d3748;
}

.dashboard-subtitle {
  color: #718096;
  margin-top: 4px;
}

.refresh-info {
  text-align: right;
  color: #718096;
  font-size: 14px;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  gap: 20px;
  margin-bottom: 20px;
}

.dashboard-panel {
  background: white;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.panel-title {
  font-size: 18px;
  font-weight: 600;
  color: #2d3748;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 2px solid #e2e8f0;
}

.service-item {
  display: flex;
  align-items: center;
  padding: 12px;
  margin-bottom: 8px;
  border-radius: 8px;
  background: #f7fafc;
  transition: all 0.2s;
}

.service-item:hover {
  background: #edf2f7;
  transform: translateX(4px);
}

.status-indicator {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin-right: 12px;
  animation: pulse 2s infinite;
}

.status-healthy { background: #48bb78; }
.status-warning { background: #ed8936; }
.status-unhealthy { background: #f56565; }
.status-unknown { background: #a0aec0; }

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(72, 187, 120, 0.7); }
  70% { box-shadow: 0 0 0 10px rgba(72, 187, 120, 0); }
  100% { box-shadow: 0 0 0 0 rgba(72, 187, 120, 0); }
}

.service-name {
  font-weight: 500;
  color: #2d3748;
  flex: 1;
}

.service-details {
  color: #a0aec0;
  font-size: 12px;
  margin-top: 4px;
}

.logs-panel {
  grid-column: 1 / -1;
  max-height: 400px;
  overflow-y: auto;
}

.log-entry {
  font-family: 'Courier New', monospace;
  font-size: 13px;
  padding: 8px;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  gap: 12px;
}

.log-timestamp {
  color: #718096;
  min-width: 80px;
}

.log-service {
  color: #4299e1;
  min-width: 80px;
}

.log-level {
  min-width: 50px;
  font-weight: 600;
}

.log-level-error { color: #f56565; }
.log-level-warn { color: #ed8936; }
.log-level-info { color: #4299e1; }
.log-level-debug { color: #a0aec0; }

.log-message {
  flex: 1;
  color: #2d3748;
}

.connection-status {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.connected {
  background: #48bb78;
  color: white;
}

.disconnected {
  background: #f56565;
  color: white;
}

.action-buttons {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.action-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  text-decoration: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.2s;
  border: 1px solid rgba(0, 0, 0, 0.1);
}

.action-button:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

.action-button.console {
  background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%);
}

.action-button.logs {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
}

.action-button.metrics {
  background: linear-gradient(135deg, #3b82f6 0%, #1e40af 100%);
}

.loading {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
  color: #718096;
}

.spinner {
  border: 3px solid #e2e8f0;
  border-top: 3px solid #4299e1;
  border-radius: 50%;
  width: 40px;
  height: 40px;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
`

  await writeFile(join(dashboardDir, 'dashboard.css'), cssContent)
  console.log('✅ Dashboard bundle built successfully')

  // Now embed the dashboard assets into TypeScript file
  const dashboardJS = await readFile(join(dashboardDir, 'dashboard.js'), 'utf-8')
  const dashboardCSS = await readFile(join(dashboardDir, 'dashboard.css'), 'utf-8')
  
  const embeddedContent = `/**
 * Auto-generated file containing embedded dashboard assets
 * DO NOT EDIT MANUALLY - Generated by build.mjs
 */

export const embeddedDashboardJS = ${JSON.stringify(dashboardJS)};

export const embeddedDashboardCSS = ${JSON.stringify(dashboardCSS)};

export const dashboardAssetsEmbedded = true;
`
  
  await writeFile('src/core/dashboard/embedded-assets.ts', embeddedContent)
  console.log('✅ Dashboard assets embedded')
  
} catch (error) {
  console.error('❌ Failed to build dashboard:', error.message)
  process.exit(1)
}

// Get all TypeScript files in the src directory (excluding config files)
const scriptFiles = (await readdir('src', { withFileTypes: true }))
  .filter(dirent => dirent.isFile() && (dirent.name.endsWith('.ts') || dirent.name.endsWith('.tsx')) && dirent.name !== 'build.ts' && !dirent.name.includes('.config.'))
  .map(dirent => dirent.name.replace(/\.tsx?$/, ''))

const totalFiles = scriptFiles.length
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
        // neo4j-driver uses dynamic requires for node internals
        'neo4j-driver',
        'neo4j-driver-core',
        // esbuild is needed at runtime for compiling CDK stacks
        'esbuild',
        // Vitest and testing dependencies
        'vitest',
        '@vitest/browser',
        'lightningcss',
        'fsevents',
        'vite'
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

// Copy dashboard bundle to dist
if (existsSync('dist/dashboard')) {
  try {
    // Dashboard is already in dist, but we need to ensure it's preserved
    console.log('✅ Dashboard bundle found in dist/dashboard')
  } catch (error) {
    console.error('❌ Failed to verify dashboard:', error.message)
  }
} else {
  console.log('⚠️  Dashboard bundle not found. Run "npm run build:dashboard" to build it.')
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

// Ensure CLI entry point has execute permissions
import { chmod } from 'node:fs/promises'
try {
  await chmod('dist/cli.mjs', 0o755)
  console.log('✅ Set execute permissions on CLI entry point')
} catch (error) {
  console.error('❌ Failed to set execute permissions:', error.message)
  process.exit(1)
}

