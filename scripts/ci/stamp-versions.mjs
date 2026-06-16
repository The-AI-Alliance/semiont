#!/usr/bin/env node
/**
 * Stamp the release version across version.json and every workspace
 * package.json (the `version` field + internal cross-dep pins). Run by
 * publish.sh before staging/publishing.
 *
 * Internal `@semiont/*` / `semiont-*` deps are declared `"*"` in source and
 * rewritten to the exact version here via the shared stampInternalDeps — the
 * single publish-time pin normalization (see docs/development/RELEASE.md).
 *
 * Usage: node scripts/ci/stamp-versions.mjs <version>
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stampInternalDeps } from './stamp-internal-deps.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/ci/stamp-versions.mjs <version>');
  process.exit(1);
}

const read = (p) => JSON.parse(readFileSync(resolve(rootDir, p), 'utf-8'));
const write = (p, data) => writeFileSync(resolve(rootDir, p), JSON.stringify(data, null, 2) + '\n');

const versionJson = read('version.json');
versionJson.version = version;
for (const pkg of Object.values(versionJson.packages)) pkg.version = version;
write('version.json', versionJson);
console.log('  version.json -> ' + version);

// Stamp every package.json in version.json — including non-published ones
// (test-utils, mcp-server, desktop) so the workspace stays version-coherent.
for (const pkg of Object.values(versionJson.packages)) {
  const path = pkg.dir + '/package.json';
  const json = read(path);
  json.version = version;
  stampInternalDeps(json, version);
  write(path, json);
  console.log('  ' + json.name + ' -> ' + version);
}
