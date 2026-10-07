#!/usr/bin/env node
/**
 * lint:node-version — the Node that builds and tests the repository is written
 * in .node-version, the oldest Node a package runs on in `engines.node`, and
 * nothing else writes either.
 *
 * Two facts, and how each is held:
 *
 * - .node-version names the Node every workflow and script runs.
 *   actions/setup-node reads the file (`node-version-file`), and a tooling
 *   image's tag is its content, node:<version>-<variant>, which
 *   scripts/ci/node-version.sh prints.
 * - `engines.node` is the floor a package asks of whoever installs it. npm
 *   reads it from each manifest and from no other, so every manifest states
 *   it, and they are held here to one floor, on the line .node-version names.
 *
 * 1. .node-version holds one version.
 * 2. Every package.json that states `engines.node` states `>=X.Y.Z`, the
 *    root's, whose major is .node-version's. package-lock.json's copy of each
 *    workspace's floor says the same.
 * 3. A workflow names the file (`node-version-file: .node-version`), never a
 *    version (`node-version:`), and keeps none in a NODE_VERSION variable.
 * 4. No file but a Dockerfile writes a Node image's tag out (`node:` and a
 *    digit). A Dockerfile's base is its image's own, and Dependabot moves it.
 * 5. A sentence that states the floor ("Node.js X.Y.Z or later") states this
 *    one, and none states its major and up ("Node.js 24+").
 * 6. .node-version is read in one place, scripts/ci/node-version.sh: beside
 *    the workflows, nothing else hands the file to a command, a redirection
 *    or a call that reads it.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs):
 * the files git tracks, and new ones it does not ignore.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OWNER = '.node-version';
const READER = 'scripts/ci/node-version.sh';
const LOCK = 'package-lock.json';
/** This file names what it refuses. */
const SELF = 'scripts/lint/check-node-version.mjs';

/** Rule 6: the file handed to something that reads it: a command, a redirection, or a call. A mention is not a read. */
const READS_OWNER = /(?:\b(?:cat|head|tail|sed|awk|grep|cut|tr|read|source)\b[^|;&]*|<\s*|\breadFile(?:Sync)?\s*\(\s*|\bopen\s*\(\s*)["'`]?[^\s"'`]*\.node-version\b/;

const failures = [];
const fail = (message) => failures.push(message);
const report = () => {
  console.error(`❌ lint:node-version — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
};

const files = repositoryFiles(ROOT).filter((file) => !file.split('/').includes('node_modules'));
if (!files.includes(OWNER)) fail(`${OWNER} is not in the repository: nothing names the Node that builds and tests it`);
if (!files.includes(READER)) fail(`${READER} is not in the repository: nothing reads ${OWNER} for the scripts`);
if (failures.length > 0) report();

// Rule 1.
const version = readFileSync(join(ROOT, OWNER), 'utf8').trim();
if (!/^\d+(\.\d+){0,2}$/.test(version)) {
  fail(`${OWNER} holds ${JSON.stringify(version)}, which is not one version`);
  report();
}
const major = version.split('.')[0];

// Rule 2.
const manifests = files.filter((file) => basename(file) === 'package.json');
const stated = manifests
  .map((file) => ({ file, node: JSON.parse(readFileSync(join(ROOT, file), 'utf8')).engines?.node }))
  .filter(({ node }) => node !== undefined);
const floor = stated.find(({ file }) => file === 'package.json')?.node;
const floorVersion = /^>=(\d+\.\d+\.\d+)$/.exec(floor ?? '')?.[1];
if (!floorVersion) {
  fail(`package.json states engines.node as ${JSON.stringify(floor)}; the floor is written >=X.Y.Z`);
  report();
}
if (floorVersion.split('.')[0] !== major) fail(`package.json's floor is Node ${floorVersion} and ${OWNER} names Node ${version}; the floor is on the line that builds`);
for (const { file, node } of stated) {
  if (node !== floor) fail(`${file} states engines.node ${node}; the floor is ${floor}, as package.json states it`);
}
if (files.includes(LOCK)) {
  const locked = JSON.parse(readFileSync(join(ROOT, LOCK), 'utf8')).packages ?? {};
  for (const { file } of stated) {
    const workspace = dirname(file) === '.' ? '' : dirname(file);
    const copy = locked[workspace]?.engines?.node;
    if (copy !== undefined && copy !== floor) fail(`${LOCK} holds engines.node ${copy} for ${workspace || 'the root'}; the floor is ${floor} (regenerate the lockfile)`);
  }
}

let read = 0;
for (const file of files) {
  if (file === SELF) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue; // a directory git lists (a submodule), or a link to nothing
  }
  if (text.includes('\u0000')) continue; // not text
  read += 1;
  const isWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file);
  const isDocument = file.endsWith('.md');
  const isDockerfile = /dockerfile/i.test(basename(file));

  text.split('\n').forEach((line, index) => {
    const at = `${file}:${index + 1}`;

    if (!isDockerfile && /\bnode:[0-9]/.test(line)) {
      fail(`${at} writes a Node image's tag out; a tooling image is node:<version>-<variant>, with the version ${READER} prints`);
    }

    for (const [, said] of line.matchAll(/\bNode(?:\.js)? (\d+(?:\.\d+)+) or later\b/g)) {
      if (said !== floorVersion) fail(`${at} says Node ${said} or later; the floor is ${floorVersion}`);
    }
    for (const [, said] of line.matchAll(/\bNode(?:\.js)? (\d+)\+/g)) {
      if (said === major) fail(`${at} says Node ${said} and up; the floor is Node ${floorVersion} or later`);
    }

    if (isWorkflow) {
      if (/\bnode-version\s*:/.test(line)) fail(`${at} names a Node version; a workflow names the file (node-version-file: ${OWNER})`);
      if (/\bNODE_VERSION\s*:/.test(line)) fail(`${at} keeps a Node version in a variable; a workflow names the file (node-version-file: ${OWNER})`);
      const named = /\bnode-version-file\s*:\s*["']?([^"'\s]+)/.exec(line)?.[1];
      if (named !== undefined && named !== OWNER) fail(`${at} takes its Node version from ${named}; the file is ${OWNER}`);
      return;
    }
    if (file !== OWNER && file !== READER && !isDocument && READS_OWNER.test(line)) {
      fail(`${at} reads ${OWNER} itself; ${READER} is the one reader`);
    }
  });
}

if (failures.length > 0) report();
console.log(`✅ lint:node-version — Node ${version} builds and tests; ${stated.length} manifests state the floor ${floor}; ${read} files read, and none writes either another way`);
