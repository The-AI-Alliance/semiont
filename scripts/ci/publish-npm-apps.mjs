#!/usr/bin/env node
/**
 * Stage gateway and browser apps for npm publishing.
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
 * Curated source `devDependencies` that the *published* gateway needs at
 * runtime even though source treats them as dev-only. `prisma` is the CLI that
 * runs database migrations against the deployed schema, so the published tarball
 * must depend on it.
 */
const GATEWAY_RUNTIME_DEVDEPS = ['prisma'];

/**
 * Derive the published gateway's `dependencies` from source — the single source
 * of truth for external runtime version ranges. This mirrors stampInternalDeps
 * (which owns the internal `@semiont/*` pins): instead of hand-maintaining a
 * second copy of the dep ranges in `package.publish.json` (which silently
 * drifted), we read them straight from `apps/gateway/package.json` so they can
 * never diverge. External ranges and the internal `@semiont/*` set both come
 * verbatim from source; runtime deps that source keeps as devDependencies
 * (GATEWAY_RUNTIME_DEVDEPS) are folded in. The internal `"*"` ranges are pinned
 * to the exact release version afterwards by stampInternalDeps.
 *
 * @param {string} gatewayDir absolute path to apps/gateway
 * @returns {Record<string,string>} the staged manifest's `dependencies`
 */
function deriveGatewayRuntimeDeps(gatewayDir) {
  const src = JSON.parse(readFileSync(resolve(gatewayDir, 'package.json'), 'utf-8'));
  const deps = { ...src.dependencies };
  for (const name of GATEWAY_RUNTIME_DEVDEPS) {
    const range = src.devDependencies?.[name];
    if (!range) {
      throw new Error(
        `Cannot promote '${name}' to a runtime dependency: not found in apps/gateway/package.json devDependencies`
      );
    }
    deps[name] = range;
  }
  // Stable alphabetical ordering for a clean, diffable staged manifest.
  return Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]));
}

function stageGateway(version) {
  log('\n=== Staging @semiont/gateway ===\n');

  const gatewayDir = resolve(rootDir, 'apps/gateway');
  const stageDir = resolve(STAGE_DIR, 'gateway');

  if (DRY_RUN) {
    log(`  Would stage to: ${stageDir}`);
    log(`  Would copy: dist/, prisma/`);
    log(`  Would use: package.publish.json with version ${version}`);
    log(`  Would derive dependencies from apps/gateway/package.json (promoted: ${GATEWAY_RUNTIME_DEVDEPS.join(', ')})`);
    return stageDir;
  }

  // Verify built artifacts exist
  const distIndex = resolve(gatewayDir, 'dist/index.js');
  if (!existsSync(distIndex)) {
    throw new Error(`Gateway not built: ${distIndex} not found. Run 'npm run build' in apps/gateway first.`);
  }

  const prismaSchema = resolve(gatewayDir, 'prisma/schema.prisma');
  if (!existsSync(prismaSchema)) {
    throw new Error(`Prisma schema not found: ${prismaSchema}`);
  }

  // Clean and create staging directory
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
  mkdirSync(stageDir, { recursive: true });

  // Copy built artifacts
  execFileSync('cp', ['-r', resolve(gatewayDir, 'dist'), resolve(stageDir, 'dist')]);
  execFileSync('cp', ['-r', resolve(gatewayDir, 'prisma'), resolve(stageDir, 'prisma')]);
  execFileSync('cp', [resolve(gatewayDir, 'prisma.config.ts'), resolve(stageDir, 'prisma.config.ts')]);

  // Copy and update publish package.json. `package.publish.json` holds only the
  // publish metadata that differs from source (name, bin, files, …) — NOT deps.
  const publishPkg = JSON.parse(readFileSync(resolve(gatewayDir, 'package.publish.json'), 'utf-8'));
  publishPkg.version = version;

  // Derive runtime deps from source (single source of truth for external
  // ranges), then pin internal @semiont/* cross-deps to the exact release
  // version (single stamper).
  publishPkg.dependencies = deriveGatewayRuntimeDeps(gatewayDir);
  stampInternalDeps(publishPkg, version);

  writeFileSync(resolve(stageDir, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');

  // Copy README for npm listing
  execFileSync('cp', [resolve(gatewayDir, 'README.npm.md'), resolve(stageDir, 'README.md')]);

  log(`  Derived ${Object.keys(publishPkg.dependencies).length} runtime deps from source (promoted: ${GATEWAY_RUNTIME_DEVDEPS.join(', ')})`);
  log(`  Staged @semiont/gateway@${version} to ${stageDir}`);
  log(`  Files: dist/, prisma/, prisma.config.ts, package.json, README.md`);

  return stageDir;
}

function stageBrowser(version) {
  log('\n=== Staging @semiont/browser ===\n');

  const browserDir = resolve(rootDir, 'apps/browser');
  const stageDir = resolve(STAGE_DIR, 'browser');

  if (DRY_RUN) {
    log(`  Would stage to: ${stageDir}`);
    log(`  Would copy: dist/, server.js`);
    log(`  Would use: package.publish.json with version ${version}`);
    return stageDir;
  }

  // Verify built artifacts exist
  const distIndex = resolve(browserDir, 'dist/index.html');
  if (!existsSync(distIndex)) {
    throw new Error(`Browser not built: ${distIndex} not found. Run 'npm run build' in apps/browser first.`);
  }

  const serverJs = resolve(browserDir, 'server.js');
  if (!existsSync(serverJs)) {
    throw new Error(`Browser server.js not found at ${serverJs}`);
  }

  // Clean and create staging directory
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
  mkdirSync(stageDir, { recursive: true });

  // Copy Vite build output
  execFileSync('cp', ['-r', resolve(browserDir, 'dist'), resolve(stageDir, 'dist')]);

  // Copy static server script
  execFileSync('cp', [serverJs, resolve(stageDir, 'server.js')]);

  // Copy and update publish package.json
  const publishPkg = JSON.parse(readFileSync(resolve(browserDir, 'package.publish.json'), 'utf-8'));
  publishPkg.version = version;
  stampInternalDeps(publishPkg, version);

  writeFileSync(resolve(stageDir, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');

  // Copy README for npm listing
  execFileSync('cp', [resolve(browserDir, 'README.npm.md'), resolve(stageDir, 'README.md')]);

  log(`  Staged @semiont/browser@${version} to ${stageDir}`);
  log(`  Files: dist/, server.js, package.json, README.md`);

  return stageDir;
}

// Main
const version = getVersion();
log(`Version: ${version}`);
if (DRY_RUN) log('(dry run)\n');

const gatewayStage = stageGateway(version);
const browserStage = stageBrowser(version);

log('\n=== Staging complete ===\n');
log('To publish:');
log(`  cd ${gatewayStage} && npm publish --access public`);
log(`  cd ${browserStage} && npm publish --access public`);
