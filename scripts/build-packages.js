#!/usr/bin/env node

/**
 * Build all packages in dependency order with proper error handling
 *
 * Build order (SPEC-FIRST ARCHITECTURE):
 * 1. @semiont/core - Base package with no dependencies
 * 2. @semiont/api-client - Generates types from openapi.json (spec-first)
 * 3. Backend - Consumes types from @semiont/api-client
 * 4. @semiont/test-utils - Testing utilities
 * 5. @semiont/mcp-server - MCP server (depends on @semiont/api-client)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const buildSteps = [
  {
    name: '@semiont/core',
    type: 'package',
    description: 'Core SDK package'
  },
  {
    name: '@semiont/api-client',
    type: 'package',
    description: 'API client (generates types from openapi.json - SPEC-FIRST)'
  },
  {
    name: 'semiont-backend',
    type: 'app',
    description: 'Backend (consumes types from @semiont/api-client)',
  },
  {
    name: '@semiont/test-utils',
    type: 'package',
    description: 'Test utilities'
  },
  {
    name: '@semiont/mcp-server',
    type: 'package',
    description: 'MCP server'
  }
];

console.log('🏗️  Building packages and apps in dependency order...\n');

for (const step of buildSteps) {
  console.log(`📦 Building ${step.name}... (${step.description})`);

  try {
    // Check if package/app exists
    const basePath = step.type === 'package'
      ? path.join(__dirname, '..', 'packages', step.name.replace('@semiont/', ''))
      : path.join(__dirname, '..', 'apps', step.name.replace('semiont-', ''));

    if (!fs.existsSync(basePath)) {
      console.error(`❌ Directory not found: ${basePath}`);
      process.exit(1);
    }

    // Check if package.json exists and has build script
    const pkgJsonPath = path.join(basePath, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      console.error(`❌ package.json not found: ${pkgJsonPath}`);
      process.exit(1);
    }

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (!pkgJson.scripts?.build) {
      console.error(`❌ No build script found in ${step.name}`);
      process.exit(1);
    }

    // Build the package/app
    execSync(`npm run build --workspace=${step.name}`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });

    console.log(`✅ ${step.name} built successfully\n`);

  } catch (error) {
    console.error(`❌ Failed to build ${step.name}:`);
    console.error(error.message);
    process.exit(1);
  }
}

console.log('🎉 All packages and apps built successfully!');
