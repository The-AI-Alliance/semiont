#!/usr/bin/env node
/**
 * The crates the gateway binary links: every one under a license the
 * published images' policy permits, and every one — no more — credited in the
 * image's NOTICE.
 *
 * The image carries no Cargo.lock and no source, so this is where the crates'
 * licenses are held, before the image exists: from `cargo metadata` for each
 * platform the image is built for, the crates the gateway reaches through
 * normal dependencies. A procedural macro runs when the gateway is compiled and
 * ships nothing, so the walk stops at one; build scripts' and tests'
 * dependencies are not normal ones. Cargo's legacy `A/B` license form means
 * `A OR B`.
 *
 * A crate that compiles native code into the binary (`links` in its manifest)
 * is one whose license field may not cover all it ships, and metadata cannot
 * say. NATIVE records what each such crate compiles in, read from its source;
 * a linked crate with `links` that NATIVE does not describe fails the check, and
 * so does an entry for a crate no longer linked.
 *
 * Usage (the Rust Gateway CI job runs it):
 *   cargo metadata --format-version 1 --locked --filter-platform <target> > meta-<target>.json   # per target
 *   node scripts/lint/check-gateway-crates.mjs meta-*.json            # check
 *   node scripts/lint/check-gateway-crates.mjs --write meta-*.json    # rewrite the NOTICE's crate list
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../../.github/scripts/license-policy.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOTICE = join(ROOT, 'apps/gateway/NOTICE');
const HEADING = '  Rust crates compiled into the gateway binary (from crates.io):';
const NATIVE_HEADING = '  Native code those crates compile into the binary:';

/**
 * Each crate that links native code: `null` when the crate's own license
 * covers that code, or the library it compiles in under a license of its own,
 * which the NOTICE credits beside the crates.
 */
const NATIVE = {
  // BoringSSL-derived C and assembly, under the crate's own Apache-2.0 AND ISC.
  ring: null,
  // The jemalloc allocator, whose COPYING the crate's source carries.
  'tikv-jemalloc-sys': { name: 'jemalloc', license: 'BSD-2-Clause' },
};

const args = process.argv.slice(2);
const write = args.includes('--write');
const inputs = args.filter((a) => a !== '--write');
if (inputs.length === 0) {
  console.error('Usage: node scripts/lint/check-gateway-crates.mjs [--write] <cargo-metadata.json>...');
  process.exit(2);
}

/** name → license, over every metadata file (one per platform). */
const linked = new Map();
/** The linked crates that compile native code. */
const native = new Set();
for (const input of inputs) {
  const metadata = JSON.parse(readFileSync(input, 'utf8'));
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const pkg = packages.get(id);
    const macro = pkg.targets.some((t) => t.kind.includes('proc-macro'));
    if (macro) continue;
    if (id !== metadata.resolve.root) linked.set(pkg.name, pkg.license ?? null);
    if (id !== metadata.resolve.root && pkg.links) native.add(pkg.name);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some((k) => k.kind === null)) pending.push(dep.pkg);
    }
  }
}
if (linked.size === 0) {
  console.error('✗ gateway crates — the metadata names no crate the gateway links. Silence is not agreement.');
  process.exit(1);
}

const policy = loadPolicy(join(ROOT, '.github/licenses/allowlist.txt'), join(ROOT, '.github/licenses/exceptions.txt'));
const spdx = (license) => license.replace(/\s*\/\s*/g, ' OR ');
const problems = [];
for (const [name, license] of linked) {
  const judged = license ?? policy.exceptionFor(name);
  if (!judged) problems.push(`${name} declares no license`);
  else if (!policy.allows(spdx(judged))) problems.push(`${name} is ${judged}, which .github/licenses/allowlist.txt does not permit`);
}

for (const name of [...native].sort()) {
  if (!(name in NATIVE)) problems.push(`${name} compiles native code into the binary, and NATIVE does not say what: read its source, then describe it`);
}
for (const [crate, library] of Object.entries(NATIVE)) {
  if (!native.has(crate)) problems.push(`NATIVE describes ${crate}, which the gateway does not link`);
  else if (library && !policy.allows(library.license)) problems.push(`${crate} compiles in ${library.name}, ${library.license}, which .github/licenses/allowlist.txt does not permit`);
}

const crateLines = [...linked].sort(([a], [b]) => a.localeCompare(b)).map(([name, license]) => `    ${name} - ${spdx(license ?? policy.exceptionFor(name))}`);
const nativeLines = Object.entries(NATIVE)
  .filter(([crate, library]) => library && native.has(crate))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([crate, library]) => `    ${library.name} - ${library.license} (compiled in by ${crate})`);

let notice = readFileSync(NOTICE, 'utf8');
const rewritten = [];
/** The NOTICE's list under `heading` is exactly `lines`, in order — or, with --write, becomes it. */
function census(heading, lines, what) {
  const start = notice.indexOf(`${heading}\n`);
  const end = start < 0 ? -1 : notice.indexOf('\n\n', start);
  if (start < 0 || end < 0) {
    if (lines.length > 0) problems.push(`apps/gateway/NOTICE has no "${heading.trim()}" section, ended by a blank line`);
    return;
  }
  const credited = notice.slice(start + heading.length + 1, end).split('\n');
  const want = lines.join('\n');
  if (credited.join('\n') === want) return;
  if (write) {
    notice = notice.slice(0, start + heading.length + 1) + want + notice.slice(end);
    rewritten.push(`${lines.length} ${what}`);
    return;
  }
  const have = new Set(credited);
  const missing = lines.filter((l) => !have.has(l)).map((l) => `not credited: ${l.trim()}`);
  const extra = credited.filter((l) => !lines.includes(l)).map((l) => `credited, not linked: ${l.trim()}`);
  problems.push(...missing, ...extra, ...(missing.length + extra.length === 0 ? [`the ${what} list is out of order`] : []));
}
census(HEADING, crateLines, 'crates');
census(NATIVE_HEADING, nativeLines, 'native libraries');
if (rewritten.length > 0) {
  writeFileSync(NOTICE, notice);
  console.log(`✓ apps/gateway/NOTICE now credits ${rewritten.join(' and ')}`);
}

if (problems.length > 0) {
  console.error('✗ gateway crates:');
  for (const p of problems) console.error(`    ${p}`);
  console.error('  A crate outside the policy is dropped, or its licence reviewed and added to .github/licenses/allowlist.txt;');
  console.error('  the NOTICE list is rewritten with --write.');
  process.exit(1);
}
console.log(`✓ gateway crates — ${linked.size} linked, ${native.size} of them compiling native code, each permitted by the licence policy and credited in apps/gateway/NOTICE`);
