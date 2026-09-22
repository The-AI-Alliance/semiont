#!/usr/bin/env node
/**
 * `creator` / `generator` / `wasAttributedTo` are built in exactly one place.
 *
 * Provenance is DERIVED, never asserted (VERIFIED-PROVENANCE P2): the one
 * function `attribution()` in @semiont/core takes the requester and the
 * executor — identities the gateway stamped from tokens — and returns the
 * W3C/PROV triple. Every write path spreads its output. A second site that
 * assembles `wasAttributedTo` by hand is a second place deciding what
 * attribution means, and two places is how the human path and the worker
 * path came to disagree in the first place.
 *
 * What counts as a construction:
 *
 *   - declaring a local named `wasAttributedTo` (its initializer may start on
 *     the next line, so the declaration itself is the tell):
 *         const wasAttributedTo: Agent[] =
 *   - an object-literal key or assignment whose value is an array literal or
 *     is built from `creator`:
 *         wasAttributedTo: [creator, generator]
 *         wasAttributedTo: creator
 *         x.wasAttributedTo = [ ... ]
 *
 * Copying the function's output (`wasAttributedTo: derived.wasAttributedTo`,
 * `= event.payload.wasAttributedTo`) and reading the field are not
 * constructions and are not matched.
 *
 * The one allowed site must ALSO be found: a gate that passes on silence would
 * pass on the function being deleted.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = new URL('../../', import.meta.url).pathname;
const ALLOWED = 'packages/core/src/did-utils.ts';
const CONSTRUCTION = new RegExp([
  String.raw`\b(?:const|let|var)\s+wasAttributedTo\b`,   // a local being built
  String.raw`\bwasAttributedTo\s*[:=]\s*(?:\[|creator\b)`, // a key or assignment from a literal / from creator
].join('|'));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-types', '__tests__', 'generated']);
const SKIP_FILES = (name) =>
  name.endsWith('.test.ts') || name.endsWith('.d.ts') || name.endsWith('.d.cts') || name === 'types.ts';

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && !SKIP_FILES(entry)) yield full;
  }
}

const roots = [];
for (const top of ['packages', 'apps']) {
  for (const pkg of readdirSync(join(ROOT, top))) {
    const src = join(ROOT, top, pkg, 'src');
    try { if (statSync(src).isDirectory()) roots.push(src); } catch { /* no src */ }
  }
}

const hits = [];
for (const root of roots) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (CONSTRUCTION.test(line)) hits.push({ file: relative(ROOT, file), line: i + 1, text: line.trim() });
    });
  }
}

const allowed = hits.filter((h) => h.file === ALLOWED);
const stray = hits.filter((h) => h.file !== ALLOWED);

let failed = false;
if (allowed.length === 0) {
  console.error(`✗ lint:attribution — the one allowed construction in ${ALLOWED} was not found. Silence is not agreement.`);
  failed = true;
}
if (stray.length > 0) {
  console.error(`✗ lint:attribution — wasAttributedTo is constructed outside ${ALLOWED}:`);
  for (const h of stray) console.error(`    ${h.file}:${h.line}  ${h.text}`);
  console.error('  Route it through attribution() in @semiont/core and spread the result.');
  failed = true;
}
if (failed) process.exit(1);
console.log(`✓ lint:attribution — wasAttributedTo is constructed in one place (${ALLOWED}), ${roots.length} source roots checked`);
