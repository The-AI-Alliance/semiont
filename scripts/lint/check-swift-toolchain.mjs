#!/usr/bin/env node
/** Swift's package owns its toolchain; image tags and readers derive from it. */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SELF = 'scripts/lint/check-swift-toolchain.mjs';
const READER = 'scripts/ci/swift-version.sh';
const files = repositoryFiles(ROOT);
const failures = [];
const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const builds = files.filter((file) => basename(file) === 'Package.swift');
if (!builds.length) failures.push('no Package.swift found');
if (!files.includes(READER)) failures.push(`missing ${READER}`);
const versions = new Set();
for (const file of builds) {
  const owner = `${dirname(file)}/.swift-version`;
  if (!files.includes(owner)) { failures.push(`${file}: missing ${owner}`); continue; }
  const version = read(owner).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) failures.push(`${owner}: expected X.Y.Z`);
  versions.add(version);
  const tools = /^\/\/ swift-tools-version:\s*(\d+(?:\.\d+){1,2})/m.exec(read(file))?.[1];
  if (!tools) failures.push(`${file}: missing tools-version`);
  else {
    const a = tools.split('.').map(Number), b = version.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const x = a[i] ?? 0, y = b[i] ?? 0;
      if (x > y) { failures.push(`${file}: tools-version exceeds toolchain`); break; }
      if (x < y) break;
    }
  }
}
if (versions.size !== 1) failures.push('every package must use the same Swift version');
for (const file of files) {
  if (file === SELF) continue;
  let text;
  try { text = read(file); } catch { continue; }
  if (text.includes('\0')) continue;
  const workflow = /^\.github\/.*\.ya?ml$/.test(file);
  for (const [i, line] of text.split('\n').entries()) {
    const at = `${file}:${i + 1}`;
    if (/\bswift:[0-9]/.test(line)) failures.push(`${at}: derives Swift image tags through ${READER}`);
    if (workflow && /\bswift-version\s*:/.test(line)) failures.push(`${at}: workflow must derive the toolchain`);
    if (file !== READER && (workflow || /\.(?:sh|mjs|js|py)$/.test(file)) && /\b(?:cat|sed|awk|head|tail|grep|read|readFileSync|readText|open)\b.*\.swift-version\b/.test(line)) failures.push(`${at}: only ${READER} reads .swift-version`);
  }
}
if (failures.length) {
  console.error(`lint:swift-toolchain — ${failures.length} problem(s):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`lint:swift-toolchain — ${builds.length} packages; one owner, reader and toolchain`);
