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

const args = process.argv.slice(2);
const write = args.includes('--write');
const inputs = args.filter((a) => a !== '--write');
if (inputs.length === 0) {
  console.error('Usage: node scripts/lint/check-gateway-crates.mjs [--write] <cargo-metadata.json>...');
  process.exit(2);
}

/** name → license, over every metadata file (one per platform). */
const linked = new Map();
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

const lines = [...linked].sort(([a], [b]) => a.localeCompare(b)).map(([name, license]) => `    ${name} - ${spdx(license ?? policy.exceptionFor(name))}`);
const notice = readFileSync(NOTICE, 'utf8');
const start = notice.indexOf(`${HEADING}\n`);
const end = start < 0 ? -1 : notice.indexOf('\n\n', start);
if (start < 0 || end < 0) {
  problems.push(`apps/gateway/NOTICE has no "${HEADING.trim()}" section, ended by a blank line`);
} else {
  const credited = notice.slice(start + HEADING.length + 1, end).split('\n');
  const want = lines.join('\n');
  if (credited.join('\n') !== want) {
    if (write) {
      writeFileSync(NOTICE, notice.slice(0, start + HEADING.length + 1) + want + notice.slice(end));
      console.log(`✓ apps/gateway/NOTICE now credits the ${linked.size} crates the gateway links`);
    } else {
      const have = new Set(credited);
      const missing = lines.filter((l) => !have.has(l)).map((l) => `not credited: ${l.trim()}`);
      const extra = credited.filter((l) => !lines.includes(l)).map((l) => `credited, not linked: ${l.trim()}`);
      problems.push(...missing, ...extra, ...(missing.length + extra.length === 0 ? ['the crate list is out of order'] : []));
    }
  }
}

if (problems.length > 0) {
  console.error('✗ gateway crates:');
  for (const p of problems) console.error(`    ${p}`);
  console.error('  A crate outside the policy is dropped, or its licence reviewed and added to .github/licenses/allowlist.txt;');
  console.error('  the NOTICE list is rewritten with --write.');
  process.exit(1);
}
console.log(`✓ gateway crates — ${linked.size} linked, each permitted by the licence policy and credited in apps/gateway/NOTICE`);
