#!/usr/bin/env node
/** global.json owns the .NET SDK; image tags are derived by dotnet-version.sh. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OWNER = 'packages/csharp/sdk/global.json';
const READER = 'scripts/ci/dotnet-version.sh';
const SELF = 'scripts/lint/check-dotnet-toolchain.mjs';
const files = repositoryFiles(ROOT);
const failures = [];
const stated = JSON.parse(readFileSync(join(ROOT, OWNER), 'utf8')).sdk;
if (stated.rollForward !== 'disable') failures.push(`${OWNER} must disable roll-forward`);
if (!/^\d+\.\d+\.\d+(?:(?:-preview|-rc)\.\d+\.\d+\.\d+)?$/.test(stated.version)) failures.push(`${OWNER} must pin a full SDK version`);
if (execFileSync('sh', [join(ROOT, READER)], { encoding: 'utf8' }).trim() !== stated.version) failures.push(`${READER} disagrees with ${OWNER}`);
const tag = execFileSync('sh', [join(ROOT, READER), '--image-tag'], { encoding: 'utf8' }).trim();
const expected = stated.version.replace(/(-(preview|rc)\.\d+)\.\d+\.\d+$/, '$1');
if (tag !== expected) failures.push(`${READER} must derive the image tag by removing only the prerelease build stamp`);
for (const file of files) {
  if (file === SELF || file === OWNER || file === READER) continue;
  let text;
  try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;
  for (const [index, line] of text.split('\n').entries()) {
    const at = `${file}:${index + 1}`;
    if (/mcr\.microsoft\.com\/dotnet\/sdk:\d/.test(line)) failures.push(`${at}: derive the .NET image tag through ${READER}`);
    if (/^\.github\/.*\.ya?ml$/.test(file) && /\bdotnet-version\s*:/.test(line)) failures.push(`${at}: use setup-dotnet's global-json-file`);
    if (/\.(?:sh|mjs|js|py)$/.test(file) && /\b(?:cat|sed|awk|readFileSync|open)\b.*global\.json/.test(line)) failures.push(`${at}: ${READER} is the one script that reads global.json`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`✓ lint:dotnet-toolchain — ${OWNER} owns SDK ${stated.version}; image tag ${tag}`);
