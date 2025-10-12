#!/usr/bin/env node

/**
 * Build all packages in dependency order with proper error handling
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const packages = [
  '@semiont/sdk',
  '@semiont/test-utils',
  '@semiont/mcp-server'
];

console.log('🏗️  Building packages...\n');

for (const pkg of packages) {
  console.log(`📦 Building ${pkg}...`);

  try {
    // Check if package exists
    const pkgPath = path.join(__dirname, '..', 'packages', pkg.replace('@semiont/', ''));
    if (!fs.existsSync(pkgPath)) {
      console.error(`❌ Package directory not found: ${pkgPath}`);
      process.exit(1);
    }

    // Check if package.json exists and has build script
    const pkgJsonPath = path.join(pkgPath, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      console.error(`❌ package.json not found: ${pkgJsonPath}`);
      process.exit(1);
    }

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (!pkgJson.scripts?.build) {
      console.error(`❌ No build script found in ${pkg}`);
      process.exit(1);
    }

    // Build the package
    execSync(`npm run build --workspace=${pkg}`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });

    console.log(`✅ ${pkg} built successfully\n`);

  } catch (error) {
    console.error(`❌ Failed to build ${pkg}:`);
    console.error(error.message);
    process.exit(1);
  }
}

console.log('🎉 All packages built successfully!');