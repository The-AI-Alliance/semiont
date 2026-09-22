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
 *
 * The SECOND rule, same shape, different fact: a Person's `name` is assigned
 * in exactly one place too (PERSON-PROFILE P4). `didToAgent` deliberately
 * leaves a Person unnamed — the subject is an opaque identifier, and printing
 * it was how every artifact came to read "By 59523dd4-…" — and the name is
 * filled in when a record is READ, by the Browser's resolver, from the
 * knowledge base's own projection. A second place that names a Person is a
 * second answer to "what is this person called", and the one that wins would
 * be whichever ran last.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = new URL('../../', import.meta.url).pathname;
const ALLOWED = 'packages/core/src/did-utils.ts';
/** Where a Person Agent acquires a name — the read-side resolver, and only it. */
const NAMES_A_PERSON = 'packages/make-meaning/src/views/people-reader.ts';
/**
 * Assigning `name` onto something already known to be a Person. Matches the
 * resolver's own shape and a hand-rolled equivalent; reading a name, and
 * naming a Software agent (whose name legitimately derives from provider and
 * model), are not matched.
 */
const PERSON_NAMING = /\['name'\]\s*=|\bname:\s*profile\.name\b/;
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
const nameHits = [];
for (const root of roots) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const where = { file: relative(ROOT, file), line: i + 1, text: line.trim() };
      if (CONSTRUCTION.test(line)) hits.push(where);
      if (PERSON_NAMING.test(line)) nameHits.push(where);
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
const namedHere = nameHits.filter((h) => h.file === NAMES_A_PERSON);
const namedElsewhere = nameHits.filter((h) => h.file !== NAMES_A_PERSON);
if (namedHere.length === 0) {
  console.error(`✗ lint:attribution — nothing in ${NAMES_A_PERSON} names a Person. A record whose people are never named is the defect this resolver exists to fix.`);
  failed = true;
}
if (namedElsewhere.length > 0) {
  console.error('✗ lint:attribution — a Person Agent is named outside the read-side resolver:');
  for (const h of namedElsewhere) console.error(`    ${h.file}:${h.line}  ${h.text}`);
  console.error(`  A name is resolved when a record is READ, in ${NAMES_A_PERSON}, from the people projection.`);
  failed = true;
}

if (failed) process.exit(1);
console.log(`✓ lint:attribution — wasAttributedTo is constructed in one place (${ALLOWED}), a Person is named in one place (${NAMES_A_PERSON}), ${roots.length} source roots checked`);
