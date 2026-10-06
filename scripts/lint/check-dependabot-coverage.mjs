#!/usr/bin/env node
/**
 * Every manifest Dependabot can update has an entry in .github/dependabot.yml,
 * and every entry names a directory that holds one.
 *
 * The entries restate, by hand, where the repository keeps its manifests, and
 * nothing held the two together: when this gate was written, the dispatcher's
 * Dockerfile, the desktop app's crates and the gateway's Rust toolchain had no
 * entry, so Dependabot never updated them, and nothing said so.
 *
 * What each ecosystem updates, found among the files git tracks:
 *
 *   npm             package-lock.json: one entry per install root (the root's
 *                   covers its workspaces)
 *   gomod           go.mod
 *   cargo           Cargo.toml; a workspace member's is covered by the entry
 *                   for its workspace, whose one lockfile Dependabot updates
 *   rust-toolchain  rust-toolchain.toml, rust-toolchain
 *   docker          a file whose name contains "dockerfile", in any case
 *   pip             requirements*.txt, pyproject.toml, Pipfile, setup.py; a
 *                   pyproject.toml beside a uv.lock is uv's, not pip's
 *   uv              uv.lock, which Dependabot updates with its pyproject.toml
 *   github-actions  .github/workflows/*.yml, from "/"
 *
 * A kind of manifest not listed here is not seen: add its ecosystem when the
 * repository gains one.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG = '.github/dependabot.yml';

const tracked = repositoryFiles(ROOT);

/** The directories whose Python project uv locks. */
const lockedByUv = new Set(tracked.filter((file) => basename(file) === 'uv.lock').map((file) => dirname(file)));

const MANIFESTS = {
  npm: (file) => basename(file) === 'package-lock.json',
  gomod: (file) => basename(file) === 'go.mod',
  cargo: (file) => basename(file) === 'Cargo.toml',
  'rust-toolchain': (file) => ['rust-toolchain.toml', 'rust-toolchain'].includes(basename(file)),
  docker: (file) => /dockerfile/i.test(basename(file)),
  pip: (file) =>
    !lockedByUv.has(dirname(file)) &&
    (/^requirements.*\.txt$/.test(basename(file)) || ['pyproject.toml', 'Pipfile', 'setup.py'].includes(basename(file))),
  uv: (file) => basename(file) === 'uv.lock',
  'github-actions': (file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file),
};

/** The directory an entry names for `file`: "/" for the root, "/a/b" otherwise. */
function directoryOf(ecosystem, file) {
  if (ecosystem === 'github-actions') return '/';
  const dir = dirname(file);
  return dir === '.' ? '/' : `/${dir}`;
}

/** An entry's directory as a pattern: Dependabot's `directories` take globs. */
function matcher(directory) {
  const normal = directory === '/' ? '/' : `/${directory.replace(/^\/+|\/+$/g, '')}`;
  const pattern = normal.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return { directory: normal, test: (d) => new RegExp(`^${pattern}$`).test(d) };
}

/** "ecosystem directory" → the manifests there. */
const manifests = new Map();
for (const file of tracked) {
  if (file.split('/').includes('node_modules')) continue;
  for (const [ecosystem, isManifest] of Object.entries(MANIFESTS)) {
    if (!isManifest(file)) continue;
    const key = `${ecosystem} ${directoryOf(ecosystem, file)}`;
    manifests.set(key, [...(manifests.get(key) ?? []), file]);
  }
}

const config = yaml.load(readFileSync(join(ROOT, CONFIG), 'utf8'));
const entries = [];
for (const update of config.updates ?? []) {
  const ecosystem = update['package-ecosystem'];
  for (const directory of update.directories ?? [update.directory]) entries.push({ ecosystem, ...matcher(directory) });
}

/** The directories a Cargo workspace at `directory` lists as its members. */
function cargoMembers(directory) {
  const manifest = readFileSync(join(ROOT, directory, 'Cargo.toml'), 'utf8');
  const members = /^\[workspace\][\s\S]*?^members\s*=\s*\[([^\]]*)\]/m.exec(manifest);
  if (!members) return [];
  return [...members[1].matchAll(/"([^"]+)"/g)].map(([, member]) => `/${join(directory, member)}`);
}

/** "cargo /member" → the workspace directory whose entry covers it. */
const workspaceOf = new Map();
for (const key of manifests.keys()) {
  const [ecosystem, directory] = key.split(' ');
  if (ecosystem !== 'cargo') continue;
  for (const member of cargoMembers(directory.slice(1))) workspaceOf.set(`cargo ${member}`, directory);
}

const problems = [];
for (const [key, files] of manifests) {
  const [ecosystem, directory] = key.split(' ');
  const covering = workspaceOf.get(key) ?? directory;
  if (!entries.some((e) => e.ecosystem === ecosystem && e.test(covering))) {
    problems.push(`no ${ecosystem} entry covers ${directory} (${files.join(', ')})`);
  }
}
for (const entry of entries) {
  if (!(entry.ecosystem in MANIFESTS)) {
    problems.push(`${entry.ecosystem} ${entry.directory}: an ecosystem this gate does not know — add what it updates to MANIFESTS`);
    continue;
  }
  const holds = [...manifests.keys()].some((key) => {
    const [ecosystem, directory] = key.split(' ');
    return ecosystem === entry.ecosystem && entry.test(directory);
  });
  if (!holds) problems.push(`the ${entry.ecosystem} entry for ${entry.directory} names a directory with no ${entry.ecosystem} manifest`);
}

if (problems.length > 0) {
  console.error(`✗ lint:dependabot — ${CONFIG} and the repository's manifests disagree:`);
  for (const p of problems) console.error(`    ${p}`);
  console.error('  Give every manifest an entry, and remove an entry whose manifest is gone.');
  process.exit(1);
}
console.log(`✓ lint:dependabot — ${manifests.size} manifest directories, each covered by an entry in ${CONFIG}, and every entry by a manifest`);
