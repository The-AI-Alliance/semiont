#!/usr/bin/env node
/**
 * Version management script for Semiont monorepo.
 *
 * Reads the workspace package manifest from `version.json` (the single
 * source of truth — see scripts/dev/build-packages.js, scripts/ci/{build,
 * publish}.sh, and the publish workflow). Each entry in
 * `version.json.packages` is `{ dir, version, publish, stage? }`.
 *
 * Usage:
 *   npm run version:show           - Show current versions
 *   npm run version:sync           - Sync all packages to match version.json
 *   npm run version:bump <type>    - Bump version (patch|minor|major)
 *   npm run version:set <version>  - Set specific version for all packages
 *   npm run version:set <pkg> <v>  - Set version for specific package
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../..');

const VERSION_FILE = resolve(rootDir, 'version.json');

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

/** Path to a package's package.json given its manifest entry. */
function packageJsonPath(entry) {
  return `${entry.dir}/package.json`;
}

/** Path to a package's staging companion (only present on apps with `stage`). */
function publishJsonPath(entry) {
  // `package.publish.json` lives next to the source package.json — it's
  // a template the staging script consumes when assembling .npm-stage/<x>.
  const path = `${entry.dir}/package.publish.json`;
  return existsSync(resolve(rootDir, path)) ? path : null;
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

/**
 * Stamp `@semiont/*` and `semiont-*` cross-references in a package.json's
 * dependency sections. `*` workspace ranges are preserved (npm resolves
 * those at publish time).
 */
function syncSemiontDeps(json, version) {
  let changed = false;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (!json[section]) continue;
    for (const dep of Object.keys(json[section])) {
      if (!(dep.startsWith('@semiont/') || dep.startsWith('semiont-'))) continue;
      if (json[section][dep] === '*') continue;
      if (json[section][dep] !== version) {
        json[section][dep] = version;
        changed = true;
      }
    }
  }
  return changed;
}

function showVersions() {
  const versionData = readJSON(VERSION_FILE);

  console.log('\n📦 Current versions:\n');
  console.log(`Global version: ${versionData.version}\n`);

  console.log('Package versions:');
  for (const [name, entry] of Object.entries(versionData.packages)) {
    const pkgJson = readJSON(packageJsonPath(entry));
    const inSync = pkgJson.version === entry.version;
    const status = inSync ? '✓' : '✗';
    const pubFlag = entry.publish ? '   ' : 'int';
    console.log(`  ${status} ${pubFlag} ${name.padEnd(28)} ${entry.version.padEnd(10)} ${inSync ? '' : `(package.json: ${pkgJson.version})`}`);
  }
  console.log('');
}

function syncVersions() {
  const versionData = readJSON(VERSION_FILE);
  const globalVersion = versionData.version;

  console.log('\n🔄 Syncing package.json files to version.json...\n');

  // Sync root package.json first.
  const rootPkgJson = readJSON('package.json');
  if (rootPkgJson.version !== globalVersion) {
    console.log(`  Updating root package.json: ${rootPkgJson.version} → ${globalVersion}`);
    rootPkgJson.version = globalVersion;
    writeJSON('package.json', rootPkgJson);
  } else {
    console.log(`  Root package.json: already at ${globalVersion}`);
  }

  for (const [name, entry] of Object.entries(versionData.packages)) {
    const pkgPath = packageJsonPath(entry);
    const pkgJson = readJSON(pkgPath);

    let updated = false;

    if (pkgJson.version !== entry.version) {
      console.log(`  Updating ${name}: ${pkgJson.version} → ${entry.version}`);
      pkgJson.version = entry.version;
      updated = true;
    } else {
      console.log(`  ${name}: already at ${entry.version}`);
    }

    if (syncSemiontDeps(pkgJson, entry.version)) {
      updated = true;
    }

    if (updated) {
      writeJSON(pkgPath, pkgJson);
    }

    // Apps with a staging companion (apps/{backend,frontend}/package.publish.json)
    // are templates for the staged tarball — sync them the same way.
    const publishPath = publishJsonPath(entry);
    if (publishPath) {
      const publishPkg = readJSON(publishPath);
      let publishUpdated = false;
      if (publishPkg.version !== entry.version) {
        console.log(`  Updating ${publishPath}: ${publishPkg.version} → ${entry.version}`);
        publishPkg.version = entry.version;
        publishUpdated = true;
      }
      if (syncSemiontDeps(publishPkg, entry.version)) {
        publishUpdated = true;
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
    console.log(`\n🔄 Setting all packages to version ${newVersion}...\n`);
    versionData.version = newVersion;
    for (const entry of Object.values(versionData.packages)) {
      entry.version = newVersion;
    }
    writeJSON(VERSION_FILE, versionData);
    console.log('✅ version.json updated!');

    const rootPkgJson = readJSON('package.json');
    if (rootPkgJson.version !== newVersion) {
      console.log(`\n🔄 Syncing root package.json: ${rootPkgJson.version} → ${newVersion}`);
      rootPkgJson.version = newVersion;
      writeJSON('package.json', rootPkgJson);
    }
  } else if (versionData.packages[packageName]) {
    console.log(`\n🔄 Setting ${packageName} to version ${newVersion}...\n`);
    versionData.packages[packageName].version = newVersion;
    writeJSON(VERSION_FILE, versionData);
    console.log('✅ version.json updated!');
  } else {
    const known = Object.keys(versionData.packages).join(', ');
    throw new Error(`Unknown package: ${packageName}. Valid packages: ${known}, all`);
  }

  console.log('\nRun `npm run version:sync` to update package.json files.\n');
}

function bumpAllVersions(type) {
  const versionData = readJSON(VERSION_FILE);
  const oldVersion = versionData.version;
  const newVersion = bumpVersion(oldVersion, type);

  console.log(`\n🔼 Bumping version: ${oldVersion} → ${newVersion} (${type})\n`);

  versionData.version = newVersion;
  for (const [name, entry] of Object.entries(versionData.packages)) {
    const oldPkgVersion = entry.version;
    const newPkgVersion = bumpVersion(oldPkgVersion, type);
    console.log(`  ${name}: ${oldPkgVersion} → ${newPkgVersion}`);
    entry.version = newPkgVersion;
  }

  writeJSON(VERSION_FILE, versionData);
  console.log('\n✅ version.json updated!');

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
