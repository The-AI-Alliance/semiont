#!/usr/bin/env node
/**
 * Stage the browser app for npm publishing.
 *
 * Creates a staging directory with the pre-built artifacts and a publish-ready
 * package.json, which can then be published with `npm publish` from within it.
 * (The gateway is not an npm package: its image compiles it from the
 * repository.)
 *
 * Usage:
 *   node packages/typescript/scripts/publish-npm-apps.mjs                # Stage the browser
 *   node packages/typescript/scripts/publish-npm-apps.mjs --dry-run      # Show what would be staged
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'node:os';
import { verifyPublication } from './publication-inputs.mjs';
import { stampInternalDeps } from './stamp-internal-deps.mjs';


const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../../..');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');
const VERIFY_DIR = VERIFY ? mkdtempSync(resolve(tmpdir(), 'semiont-npm-verify-')) : null;
const STAGE_DIR = VERIFY_DIR ?? resolve(rootDir, '.npm-stage');

function getVersion() {
  const versionJson = JSON.parse(readFileSync(resolve(rootDir, 'version.json'), 'utf-8'));
  return versionJson.version;
}

function log(msg) {
  console.log(msg);
}

function stageBrowser(version) {
  log('\n=== Staging @semiont/browser ===\n');

  const browserDir = resolve(rootDir, 'images/browser');
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
    throw new Error(`Browser not built: ${distIndex} not found. Build the Browser's npm artifacts first (make packages PACKAGE_NAMES=typescript includes them).`);
  }

  const serverJs = resolve(browserDir, 'server.js');
  if (!existsSync(serverJs)) {
    throw new Error(`Browser server.js not found at ${serverJs}`);
  }

  for (const input of ['README.npm.md', 'package.publish.json']) {
    if (!existsSync(resolve(browserDir, input))) throw new Error(`Browser publication input missing: ${input}`);
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

  verifyPublication(stageDir, publishPkg, 'images/browser');
  log(`  Staged @semiont/browser@${version} to ${stageDir}`);
  log(`  Files: dist/, server.js, package.json, README.md`);

  return stageDir;
}

// Main
const version = getVersion();
log(`Version: ${version}`);
if (DRY_RUN) log('(dry run)\n');

let browserStage;
try {
  browserStage = stageBrowser(version);
} finally {
  if (VERIFY_DIR) rmSync(VERIFY_DIR, { recursive: true, force: true });
}

if (!VERIFY) {
  log('\n=== Staging complete ===\n');
  log('To publish:');
  log(`  cd ${browserStage} && npm publish --access public`);
}
