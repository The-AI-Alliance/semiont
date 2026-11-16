#!/usr/bin/env node
/**
 * Stage backend and frontend apps for npm publishing.
 *
 * Creates staging directories with pre-built artifacts and publish-ready
 * package.json files. The staged directories can then be published with
 * `npm publish` from within each staging dir.
 *
 * Usage:
 *   node scripts/ci/publish-npm-apps.mjs                # Stage both apps
 *   node scripts/ci/publish-npm-apps.mjs --dry-run      # Show what would be staged
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stampInternalDeps } from './stamp-internal-deps.mjs';


const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../..');
const DRY_RUN = process.argv.includes('--dry-run');
const STAGE_DIR = resolve(rootDir, '.npm-stage');

function getVersion() {
  const versionJson = JSON.parse(readFileSync(resolve(rootDir, 'version.json'), 'utf-8'));
  return versionJson.version;
}

function log(msg) {
  console.log(msg);
}

/**
 * Curated source `devDependencies` that the *published* backend needs at
 * runtime even though source treats them as dev-only. `prisma` is the CLI that
 * runs database migrations against the deployed schema, so the published tarball
 * must depend on it.
 */
const BACKEND_RUNTIME_DEVDEPS = ['prisma'];

/**
 * Derive the published backend's `dependencies` from source — the single source
 * of truth for external runtime version ranges. This mirrors stampInternalDeps
 * (which owns the internal `@semiont/*` pins): instead of hand-maintaining a
 * second copy of the dep ranges in `package.publish.json` (which silently
 * drifted), we read them straight from `apps/backend/package.json` so they can
 * never diverge. External ranges and the internal `@semiont/*` set both come
 * verbatim from source; runtime deps that source keeps as devDependencies
 * (BACKEND_RUNTIME_DEVDEPS) are folded in. The internal `"*"` ranges are pinned
 * to the exact release version afterwards by stampInternalDeps.
 *
 * @param {string} backendDir absolute path to apps/backend
 * @returns {Record<string,string>} the staged manifest's `dependencies`
 */
function deriveBackendRuntimeDeps(backendDir) {
  const src = JSON.parse(readFileSync(resolve(backendDir, 'package.json'), 'utf-8'));
  const deps = { ...src.dependencies };
  for (const name of BACKEND_RUNTIME_DEVDEPS) {
    const range = src.devDependencies?.[name];
    if (!range) {
      throw new Error(
        `Cannot promote '${name}' to a runtime dependency: not found in apps/backend/package.json devDependencies`
      );
    }
    deps[name] = range;
  }
  // Stable alphabetical ordering for a clean, diffable staged manifest.
  return Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]));
}

function stageBackend(version) {
  log('\n=== Staging @semiont/backend ===\n');

  const backendDir = resolve(rootDir, 'apps/backend');
  const stageDir = resolve(STAGE_DIR, 'backend');

  if (DRY_RUN) {
    log(`  Would stage to: ${stageDir}`);
    log(`  Would copy: dist/, prisma/`);
    log(`  Would use: package.publish.json with version ${version}`);
    log(`  Would derive dependencies from apps/backend/package.json (promoted: ${BACKEND_RUNTIME_DEVDEPS.join(', ')})`);
    return stageDir;
  }

  // Verify built artifacts exist
  const distIndex = resolve(backendDir, 'dist/index.js');
  if (!existsSync(distIndex)) {
    throw new Error(`Backend not built: ${distIndex} not found. Run 'npm run build' in apps/backend first.`);
  }

  const prismaSchema = resolve(backendDir, 'prisma/schema.prisma');
  if (!existsSync(prismaSchema)) {
    throw new Error(`Prisma schema not found: ${prismaSchema}`);
  }

  // Clean and create staging directory
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
  mkdirSync(stageDir, { recursive: true });

  // Copy built artifacts
  execFileSync('cp', ['-r', resolve(backendDir, 'dist'), resolve(stageDir, 'dist')]);
  execFileSync('cp', ['-r', resolve(backendDir, 'prisma'), resolve(stageDir, 'prisma')]);
  execFileSync('cp', [resolve(backendDir, 'prisma.config.ts'), resolve(stageDir, 'prisma.config.ts')]);

  // Copy and update publish package.json. `package.publish.json` holds only the
  // publish metadata that differs from source (name, bin, files, …) — NOT deps.
  const publishPkg = JSON.parse(readFileSync(resolve(backendDir, 'package.publish.json'), 'utf-8'));
  publishPkg.version = version;

  // Derive runtime deps from source (single source of truth for external
  // ranges), then pin internal @semiont/* cross-deps to the exact release
  // version (single stamper).
  publishPkg.dependencies = deriveBackendRuntimeDeps(backendDir);
  stampInternalDeps(publishPkg, version);

  writeFileSync(resolve(stageDir, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');

  // Copy README for npm listing
  execFileSync('cp', [resolve(backendDir, 'README.npm.md'), resolve(stageDir, 'README.md')]);

  log(`  Derived ${Object.keys(publishPkg.dependencies).length} runtime deps from source (promoted: ${BACKEND_RUNTIME_DEVDEPS.join(', ')})`);
  log(`  Staged @semiont/backend@${version} to ${stageDir}`);
  log(`  Files: dist/, prisma/, prisma.config.ts, package.json, README.md`);

  return stageDir;
}

function stageFrontend(version) {
  log('\n=== Staging @semiont/frontend ===\n');

  const frontendDir = resolve(rootDir, 'apps/frontend');
  const stageDir = resolve(STAGE_DIR, 'frontend');

  if (DRY_RUN) {
    log(`  Would stage to: ${stageDir}`);
    log(`  Would copy: dist/, server.js`);
    log(`  Would use: package.publish.json with version ${version}`);
    return stageDir;
  }

  // Verify built artifacts exist
  const distIndex = resolve(frontendDir, 'dist/index.html');
  if (!existsSync(distIndex)) {
    throw new Error(`Frontend not built: ${distIndex} not found. Run 'npm run build' in apps/frontend first.`);
  }

  const serverJs = resolve(frontendDir, 'server.js');
  if (!existsSync(serverJs)) {
    throw new Error(`Frontend server.js not found at ${serverJs}`);
  }

  // Clean and create staging directory
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
  mkdirSync(stageDir, { recursive: true });

  // Copy Vite build output
  execFileSync('cp', ['-r', resolve(frontendDir, 'dist'), resolve(stageDir, 'dist')]);

  // Copy static server script
  execFileSync('cp', [serverJs, resolve(stageDir, 'server.js')]);

  // Copy and update publish package.json
  const publishPkg = JSON.parse(readFileSync(resolve(frontendDir, 'package.publish.json'), 'utf-8'));
  publishPkg.version = version;
  stampInternalDeps(publishPkg, version);

  writeFileSync(resolve(stageDir, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');

  // Copy README for npm listing
  execFileSync('cp', [resolve(frontendDir, 'README.npm.md'), resolve(stageDir, 'README.md')]);

  log(`  Staged @semiont/frontend@${version} to ${stageDir}`);
  log(`  Files: dist/, server.js, package.json, README.md`);

  return stageDir;
}

// Main
const version = getVersion();
log(`Version: ${version}`);
if (DRY_RUN) log('(dry run)\n');

const backendStage = stageBackend(version);
const frontendStage = stageFrontend(version);

log('\n=== Staging complete ===\n');
log('To publish:');
log(`  cd ${backendStage} && npm publish --access public`);
log(`  cd ${frontendStage} && npm publish --access public`);
