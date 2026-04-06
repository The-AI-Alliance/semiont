#!/usr/bin/env node
/**
 * Version management script for Semiont monorepo
 *
 * Usage:
 *   npm run version:show           - Show current versions
 *   npm run version:sync           - Sync all packages to match version.json
 *   npm run version:bump <type>    - Bump version (patch|minor|major)
 *   npm run version:set <version>  - Set specific version for all packages
 *   npm run version:set <pkg> <v>  - Set version for specific package
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const VERSION_FILE = resolve(rootDir, 'version.json');
const PACKAGE_PATHS = {
  '@semiont/api-client': 'packages/api-client/package.json',
  '@semiont/core': 'packages/core/package.json',
  '@semiont/ontology': 'packages/ontology/package.json',
  '@semiont/content': 'packages/content/package.json',
  '@semiont/event-sourcing': 'packages/event-sourcing/package.json',
  '@semiont/graph': 'packages/graph/package.json',
  '@semiont/inference': 'packages/inference/package.json',
  '@semiont/vectors': 'packages/vectors/package.json',
  '@semiont/jobs': 'packages/jobs/package.json',
  '@semiont/make-meaning': 'packages/make-meaning/package.json',
  '@semiont/react-ui': 'packages/react-ui/package.json',
  '@semiont/mcp-server': 'packages/mcp-server/package.json',
  '@semiont/cli': 'apps/cli/package.json',
  'semiont-backend': 'apps/backend/package.json',
  'semiont-frontend': 'apps/frontend/package.json',
};

function readJSON(path) {
  return JSON.parse(readFileSync(resolve(rootDir, path), 'utf-8'));
}

function writeJSON(path, data) {
  writeFileSync(
    resolve(rootDir, path),
    JSON.stringify(data, null, 2) + '\n',
    'utf-8'
  );
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid version format: ${version}`);
  return {
    major: parseInt(match[1]),
    minor: parseInt(match[2]),
    patch: parseInt(match[3]),
  };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(version, type) {
  const v = parseVersion(version);
  switch (type) {
    case 'major':
      v.major++;
      v.minor = 0;
      v.patch = 0;
      break;
    case 'minor':
      v.minor++;
      v.patch = 0;
      break;
    case 'patch':
      v.patch++;
      break;
    default:
      throw new Error(`Invalid bump type: ${type}. Use: patch, minor, or major`);
  }
  return formatVersion(v);
}

function showVersions() {
  const versionData = readJSON(VERSION_FILE);

  console.log('\n📦 Current versions:\n');
  console.log(`Global version: ${versionData.version}\n`);

  console.log('Package versions:');
  for (const [pkg, version] of Object.entries(versionData.packages)) {
    const pkgPath = PACKAGE_PATHS[pkg];
    const pkgJson = readJSON(pkgPath);
    const inSync = pkgJson.version === version;
    const status = inSync ? '✓' : '✗';
    console.log(`  ${status} ${pkg.padEnd(25)} ${version.padEnd(10)} ${inSync ? '' : `(package.json: ${pkgJson.version})`}`);
  }
  console.log('');
}

function syncVersions() {
  const versionData = readJSON(VERSION_FILE);
  const globalVersion = versionData.version;

  console.log('\n🔄 Syncing package.json files to version.json...\n');

  // Sync root package.json first
  const rootPkgJson = readJSON('package.json');
  if (rootPkgJson.version !== globalVersion) {
    console.log(`  Updating root package.json: ${rootPkgJson.version} → ${globalVersion}`);
    rootPkgJson.version = globalVersion;
    writeJSON('package.json', rootPkgJson);
  } else {
    console.log(`  Root package.json: already at ${globalVersion}`);
  }

  for (const [pkg, version] of Object.entries(versionData.packages)) {
    const pkgPath = PACKAGE_PATHS[pkg];
    const pkgJson = readJSON(pkgPath);

    let updated = false;

    if (pkgJson.version !== version) {
      console.log(`  Updating ${pkg}: ${pkgJson.version} → ${version}`);
      pkgJson.version = version;
      updated = true;
    } else {
      console.log(`  ${pkg}: already at ${version}`);
    }

    // Sync @semiont/* workspace dependencies for CLI, backend, and frontend
    if ((pkg === '@semiont/cli' || pkg === 'semiont-backend' || pkg === 'semiont-frontend') && pkgJson.dependencies) {
      const expected = version;
      for (const [dep, depVersion] of Object.entries(pkgJson.dependencies)) {
        if (dep.startsWith('@semiont/') && depVersion !== expected) {
          console.log(`    └─ Syncing dependency ${dep}: ${depVersion} → ${expected}`);
          pkgJson.dependencies[dep] = expected;
          updated = true;
        }
      }
    }

    if (updated) {
      writeJSON(pkgPath, pkgJson);
    }

    // Sync companion package.publish.json for backend and frontend
    const publishPath =
      pkg === 'semiont-backend' ? 'apps/backend/package.publish.json' :
      pkg === 'semiont-frontend' ? 'apps/frontend/package.publish.json' :
      null;
    if (publishPath) {
      const publishPkg = readJSON(publishPath);
      let publishUpdated = false;
      if (publishPkg.version !== version) {
        console.log(`  Updating ${publishPath}: ${publishPkg.version} → ${version}`);
        publishPkg.version = version;
        publishUpdated = true;
      }
      if (publishPkg.dependencies) {
        const expected = version;
        for (const [dep, depVersion] of Object.entries(publishPkg.dependencies)) {
          if (dep.startsWith('@semiont/') && depVersion !== expected) {
            console.log(`    └─ Syncing dependency ${dep}: ${depVersion} → ${expected}`);
            publishPkg.dependencies[dep] = expected;
            publishUpdated = true;
          }
        }
      }
      if (publishUpdated) {
        writeJSON(publishPath, publishPkg);
      }
    }
  }

  console.log('\n✅ All packages synced!\n');
}

function setVersion(packageName, newVersion) {
  const versionData = readJSON(VERSION_FILE);

  if (packageName === 'all') {
    // Set all packages to same version
    console.log(`\n🔄 Setting all packages to version ${newVersion}...\n`);
    versionData.version = newVersion;
    for (const pkg of Object.keys(versionData.packages)) {
      versionData.packages[pkg] = newVersion;
    }

    writeJSON(VERSION_FILE, versionData);
    console.log('✅ version.json updated!');

    // Automatically sync root package.json when setting all versions
    const rootPkgJson = readJSON('package.json');
    if (rootPkgJson.version !== newVersion) {
      console.log(`\n🔄 Syncing root package.json: ${rootPkgJson.version} → ${newVersion}`);
      rootPkgJson.version = newVersion;
      writeJSON('package.json', rootPkgJson);
    }
  } else if (PACKAGE_PATHS[packageName]) {
    // Set specific package
    console.log(`\n🔄 Setting ${packageName} to version ${newVersion}...\n`);
    versionData.packages[packageName] = newVersion;
    writeJSON(VERSION_FILE, versionData);
    console.log('✅ version.json updated!');
  } else {
    throw new Error(`Unknown package: ${packageName}. Valid packages: ${Object.keys(PACKAGE_PATHS).join(', ')}, all`);
  }

  console.log('\nRun `npm run version:sync` to update package.json files.\n');
}

function bumpAllVersions(type) {
  const versionData = readJSON(VERSION_FILE);
  const oldVersion = versionData.version;
  const newVersion = bumpVersion(oldVersion, type);

  console.log(`\n🔼 Bumping version: ${oldVersion} → ${newVersion} (${type})\n`);

  versionData.version = newVersion;
  for (const pkg of Object.keys(versionData.packages)) {
    const oldPkgVersion = versionData.packages[pkg];
    const newPkgVersion = bumpVersion(oldPkgVersion, type);
    console.log(`  ${pkg}: ${oldPkgVersion} → ${newPkgVersion}`);
    versionData.packages[pkg] = newPkgVersion;
  }

  writeJSON(VERSION_FILE, versionData);
  console.log('\n✅ version.json updated!');

  // Automatically sync root package.json
  const rootPkgJson = readJSON('package.json');
  if (rootPkgJson.version !== newVersion) {
    console.log(`\n🔄 Syncing root package.json: ${rootPkgJson.version} → ${newVersion}`);
    rootPkgJson.version = newVersion;
    writeJSON('package.json', rootPkgJson);
  }

  console.log('\nRun `npm run version:sync` to update package.json files.\n');
}

// Main CLI
const [,, command, arg1, arg2] = process.argv;

try {
  switch (command) {
    case 'show':
      showVersions();
      break;

    case 'sync':
      syncVersions();
      break;

    case 'bump':
      if (!arg1) {
        console.error('Usage: npm run version:bump <patch|minor|major>');
        process.exit(1);
      }
      bumpAllVersions(arg1);
      break;

    case 'set':
      if (!arg1 || !arg2) {
        console.error('Usage: npm run version:set <package|all> <version>');
        console.error('       npm run version:set all 0.2.0');
        console.error('       npm run version:set semiont-backend 0.1.2');
        process.exit(1);
      }
      setVersion(arg1, arg2);
      break;

    default:
      console.log(`
📦 Semiont Version Management

Usage:
  npm run version:show              Show current versions
  npm run version:sync              Sync all packages to match version.json
  npm run version:bump <type>       Bump version (patch|minor|major)
  npm run version:set all <version> Set version for all packages
  npm run version:set <pkg> <v>     Set version for specific package

Examples:
  npm run version:show
  npm run version:bump patch
  npm run version:set all 0.2.0
  npm run version:set semiont-backend 0.1.2
  npm run version:sync
`);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(`\n❌ Error: ${error.message}\n`);
  process.exit(1);
}
