#!/usr/bin/env node

/**
 * Build all packages in dependency order with proper error handling.
 *
 * The list of packages to build (and the build order) comes from
 * `version.json` — the single source of truth for the workspace's
 * package manifest. Adding a new package means editing version.json
 * once, not five different scripts.
 *
 * SPEC-FIRST: @semiont/core's prebuild bundles openapi.json and
 * regenerates types from it; this script bundles the spec once up
 * front so all packages see the same generated types.
 *
 * Order is the insertion order in version.json's `packages` object.
 * JSON-spec-wise that's not guaranteed; in practice every JSON parser
 * we use preserves it. If you need to reorder, edit version.json.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '../..');

// SPEC-FIRST: bundle OpenAPI spec from specs/src/ before any package builds.
// specs/src/openapi.json is the source of truth; specs/openapi.json is the
// bundled artifact that @semiont/core's prebuild script copies and reads.
console.log('📦 Bundling OpenAPI spec from specs/src/...');
try {
  execFileSync('npm', ['run', 'openapi:bundle'], { stdio: 'inherit', cwd: ROOT });
  console.log('✅ OpenAPI spec bundled successfully\n');
} catch (error) {
  console.error('❌ Failed to bundle OpenAPI spec:', error.message);
  process.exit(1);
}

// Load the workspace package manifest. Iterate in insertion order — each
// entry's deps must appear earlier in the list. (Validate by trial: a
// downstream build failing because an upstream dist is missing means
// the order is wrong.)
//
// Restrict to `publish: true` — non-publishable entries (test-utils,
// mcp-server, desktop) have build paths that don't fit this iteration.
// Desktop in particular runs `cargo tauri build`, which has no place in
// the npm dev/CI loop.
const versionJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf-8'));
const buildSteps = Object.entries(versionJson.packages).filter(([, pkg]) => pkg.publish);

console.log('🏗️  Building packages and apps in dependency order...\n');

for (const [name, pkg] of buildSteps) {
  console.log(`📦 Building ${name}...`);

  const basePath = path.join(ROOT, pkg.dir);
  if (!fs.existsSync(basePath)) {
    console.error(`❌ Directory not found: ${basePath}`);
    process.exit(1);
  }

  const pkgJsonPath = path.join(basePath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    console.error(`❌ package.json not found: ${pkgJsonPath}`);
    process.exit(1);
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  if (!pkgJson.scripts?.build) {
    console.warn(`⚠ No build script in ${name} — skipping.`);
    continue;
  }

  try {
    execFileSync('npm', ['run', 'build', `--workspace=${name}`], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    console.log(`✅ ${name} built successfully\n`);
  } catch (error) {
    console.error(`❌ Failed to build ${name}:`);
    console.error(error.message);
    process.exit(1);
  }
}

console.log('🎉 All packages and apps built successfully!');
