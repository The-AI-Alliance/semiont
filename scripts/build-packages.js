#!/usr/bin/env node

/**
 * Build all packages in dependency order with proper error handling
 *
 * Build order (SPEC-FIRST ARCHITECTURE):
 * 1. @semiont/api-client - Generates types from openapi.json (spec-first) - NO DEPENDENCIES
 * 2. @semiont/core - Depends on @semiont/api-client for types
 * 3. Backend - Consumes types from @semiont/api-client and @semiont/core
 * 4. @semiont/test-utils - Testing utilities
 * 5. @semiont/mcp-server - MCP server (depends on @semiont/api-client)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// CRITICAL: Copy OpenAPI spec from specs/ to api-client BEFORE building
// In spec-first architecture, specs/openapi.json is the source of truth (committed to git)
console.log('📋 Copying OpenAPI spec from specs/ to api-client...');
const specsPath = path.join(__dirname, '..', 'specs', 'openapi.json');
const apiClientSpecPath = path.join(__dirname, '..', 'packages', 'api-client', 'openapi.json');

if (!fs.existsSync(specsPath)) {
  console.error('❌ OpenAPI spec not found:', specsPath);
  process.exit(1);
}

const apiClientDir = path.dirname(apiClientSpecPath);
if (!fs.existsSync(apiClientDir)) {
  fs.mkdirSync(apiClientDir, { recursive: true });
}

fs.copyFileSync(specsPath, apiClientSpecPath);
console.log('✅ OpenAPI spec copied successfully\n');

const buildSteps = [
  {
    name: '@semiont/api-client',
    type: 'package',
    description: 'API client (generates types from openapi.json - SPEC-FIRST)'
  },
  {
    name: '@semiont/core',
    type: 'package',
    description: 'Core SDK package (depends on @semiont/api-client for types)'
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

    // For api-client, verify the openapi.json file exists before building
    if (step.name === '@semiont/api-client') {
      if (!fs.existsSync(apiClientSpecPath)) {
        console.error(`❌ OpenAPI spec not found at ${apiClientSpecPath} before building api-client`);
        console.error('Current directory:', process.cwd());
        console.error('Files in packages/api-client:', fs.readdirSync(path.join(__dirname, '..', 'packages', 'api-client')));
        process.exit(1);
      }
      console.log(`✓ Verified openapi.json exists at ${apiClientSpecPath}`);
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
