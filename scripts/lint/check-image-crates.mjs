#!/usr/bin/env node
/**
 * The crates each Rust service binary links: every one under a license the
 * published images' policy permits, and every one — no more — credited in
 * that service image's NOTICE.
 *
 * An image carries no Cargo.lock and no source, so this is where the crates'
 * licenses are held, before the image exists. What a binary links is cargo's
 * own answer, `cargo tree` for that binary on each platform the images are
 * built for, over normal dependencies: a procedural macro runs when the binary
 * is compiled and ships nothing, and build scripts' and tests' dependencies
 * are not normal ones. It is asked per binary because the workspace's
 * resolution is not it: there a feature one crate's tests turn on counts for
 * every crate, so a test harness's dependencies would read as shipped. Each
 * crate's license, and whether it compiles native code in, is `cargo
 * metadata`'s. Cargo's legacy `A/B` license form means `A OR B`.
 *
 * A crate that compiles native code into the binary (`links` in its manifest)
 * is one whose license field may not cover all it ships, and metadata cannot
 * say. NATIVE records what each such crate compiles in, read from its source;
 * a linked crate with `links` that NATIVE does not describe fails the check, and
 * so does an entry for a crate no longer linked.
 *
 * Usage (the Rust CI job runs it), over a directory holding both:
 *   cargo metadata --format-version 1 --locked > <dir>/metadata.json
 *   cargo tree --locked -p <binary> -e normal,no-proc-macro --target <target> --prefix none --format '{p}' \
 *     > <dir>/linked-<binary>-<target>.txt                          # per binary, per target
 *   node scripts/lint/check-image-crates.mjs <dir>                  # check
 *   node scripts/lint/check-image-crates.mjs --write <dir>          # rewrite the NOTICEs' crate lists
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../../.github/scripts/license-policy.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Each image that ships a Rust binary: the binary's package, and the image's NOTICE. */
const IMAGES = [
  { service: 'gateway', binary: 'semiont-gateway', notice: 'apps/gateway/NOTICE' },
  { service: 'dispatcher', binary: 'semiont-dispatcher', notice: 'apps/dispatcher/NOTICE' },
];
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
const [directory, ...rest] = args.filter((a) => a !== '--write');
if (!directory || rest.length > 0) {
  console.error('Usage: node scripts/lint/check-image-crates.mjs [--write] <directory of metadata.json and linked-<binary>-<target>.txt>');
  process.exit(2);
}

const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
const packages = new Map(metadata.packages.map((p) => [`${p.name} v${p.version}`, p]));
const members = new Set(metadata.workspace_members);

/**
 * What `binary` links, over every platform's listing: each crate from
 * crates.io by name, with its license, and those that compile native code.
 */
function linkedBy(binary) {
  const linked = new Map();
  const native = new Set();
  const listings = readdirSync(directory).filter((name) => name.startsWith(`linked-${binary}-`) && name.endsWith('.txt'));
  if (listings.length === 0) throw new Error(`${directory} holds no linked-${binary}-<target>.txt`);
  for (const listing of listings) {
    for (const line of readFileSync(join(directory, listing), 'utf8').split('\n')) {
      if (line === '') continue;
      // `name vX.Y.Z`, then a workspace crate's path and, where cargo has listed the crate before, `(*)`.
      const named = /^(\S+ v\S+)( \(.*\))?$/.exec(line);
      const pkg = named && packages.get(named[1]);
      if (!pkg) throw new Error(`${listing}: metadata.json has no package for "${line}"`);
      // The workspace's own crates are the repository's, under its licence.
      if (members.has(pkg.id)) continue;
      linked.set(pkg.name, pkg.license ?? null);
      if (pkg.links) native.add(pkg.name);
    }
  }
  return { linked, native };
}

const policy = loadPolicy(join(ROOT, '.github/licenses/allowlist.txt'), join(ROOT, '.github/licenses/exceptions.txt'));
const spdx = (license) => license.replace(/\s*\/\s*/g, ' OR ');
const problems = [];
const rewritten = [];
const nativeAnywhere = new Set();
for (const { service, binary, notice: noticePath } of IMAGES) {
  const { linked, native } = linkedBy(binary);
  if (linked.size === 0) {
    problems.push(`the listings name no crate ${binary} links. Silence is not agreement.`);
    continue;
  }
  for (const name of native) nativeAnywhere.add(name);
  for (const [name, license] of linked) {
    const judged = license ?? policy.exceptionFor(name);
    if (!judged) problems.push(`${name} declares no license`);
    else if (!policy.allows(spdx(judged))) problems.push(`${name} is ${judged}, which .github/licenses/allowlist.txt does not permit`);
  }
  for (const name of [...native].sort()) {
    if (!(name in NATIVE)) problems.push(`${name} compiles native code into ${binary}, and NATIVE does not say what: read its source, then describe it`);
  }

  const crateLines = [...linked].sort(([a], [b]) => a.localeCompare(b)).map(([name, license]) => `    ${name} - ${spdx(license ?? policy.exceptionFor(name))}`);
  const nativeLines = Object.entries(NATIVE)
    .filter(([crate, library]) => library && native.has(crate))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([crate, library]) => `    ${library.name} - ${library.license} (compiled in by ${crate})`);

  let notice = readFileSync(join(ROOT, noticePath), 'utf8');
  const before = notice;
  /** The NOTICE's list under `heading` is exactly `lines`, in order — or, with --write, becomes it. */
  const census = (heading, lines, what) => {
    const start = notice.indexOf(`${heading}\n`);
    const end = start < 0 ? -1 : notice.indexOf('\n\n', start);
    if (start < 0 || end < 0) {
      if (lines.length > 0) problems.push(`${noticePath} has no "${heading.trim()}" section, ended by a blank line`);
      return;
    }
    const credited = notice.slice(start + heading.length + 1, end).split('\n');
    const want = lines.join('\n');
    if (credited.join('\n') === want) return;
    if (write) {
      notice = notice.slice(0, start + heading.length + 1) + want + notice.slice(end);
      rewritten.push(`${noticePath}: ${lines.length} ${what}`);
      return;
    }
    const have = new Set(credited);
    const missing = lines.filter((l) => !have.has(l)).map((l) => `${noticePath} does not credit: ${l.trim()}`);
    const extra = credited.filter((l) => !lines.includes(l)).map((l) => `${noticePath} credits, and ${binary} does not link: ${l.trim()}`);
    problems.push(...missing, ...extra, ...(missing.length + extra.length === 0 ? [`${noticePath}'s ${what} list is out of order`] : []));
  };
  census(`  Rust crates compiled into the ${service} binary (from crates.io):`, crateLines, 'crates');
  census('  Native code those crates compile into the binary:', nativeLines, 'native libraries');
  if (notice !== before) writeFileSync(join(ROOT, noticePath), notice);
}
for (const [crate, library] of Object.entries(NATIVE)) {
  if (!nativeAnywhere.has(crate)) problems.push(`NATIVE describes ${crate}, which no image's binary links`);
  else if (library && !policy.allows(library.license)) problems.push(`${crate} compiles in ${library.name}, ${library.license}, which .github/licenses/allowlist.txt does not permit`);
}
for (const line of rewritten) console.log(`✓ rewrote ${line}`);

if (problems.length > 0) {
  console.error('✗ image crates:');
  for (const p of problems) console.error(`    ${p}`);
  console.error('  A crate outside the policy is dropped, or its licence reviewed and added to .github/licenses/allowlist.txt;');
  console.error('  the NOTICE lists are rewritten with --write.');
  process.exit(1);
}
console.log(`✓ image crates — ${IMAGES.map((i) => i.binary).join(' and ')}: each crate linked permitted by the licence policy and credited in its image's NOTICE`);
