#!/usr/bin/env node
/**
 * `creator` / `generator` / `wasAttributedTo` are built in exactly one place.
 *
 * Provenance is DERIVED, never asserted: the one function `attribution()` in
 * the Archivist's record (`images/archivist/record/src/agents.rs`) takes the
 * requester and the executor — identities the gateway stamped from tokens —
 * and returns the W3C/PROV triple, which every write the Archivist records
 * copies. A second site that assembles `wasAttributedTo` by hand
 * is a second place deciding what attribution means, and two places is how
 * the human path and the worker path came to disagree in the first place.
 *
 * What counts as a construction:
 *
 *   - declaring a local named `wasAttributedTo`, or in Rust
 *     `was_attributed_to` (its initializer may start on the next line, so the
 *     declaration itself is the tell):
 *         const wasAttributedTo: Agent[] =
 *         let was_attributed_to = …
 *   - an object-literal key or assignment whose value is an array literal or
 *     is built from `creator`:
 *         wasAttributedTo: [creator, generator]
 *         wasAttributedTo: creator
 *         x.wasAttributedTo = [ ... ]
 *
 * Copying the function's output (`wasAttributedTo: derived.wasAttributedTo`,
 * `Value::Array(derived.was_attributed_to)`, `= event.payload.wasAttributedTo`)
 * and reading the field are not constructions and are not matched.
 *
 * The one allowed site must ALSO be found: a gate that passes on silence would
 * pass on the function being deleted.
 *
 * The SECOND rule, same shape, different fact: a principal's `name` is
 * assigned in one place too. The record's `did_to_agent` leaves a person and
 * an agent unnamed — the subject is an opaque identifier, and printing it was
 * how every artifact came to read "By 59523dd4-…" — and the name is filled in
 * when a reply is READ, from the profiles projection: what each principal last
 * said it is called. Two services read it, the Librarian in Python and the
 * Archivist in Rust (`images/archivist/src/naming.rs`), and
 * `specs/src/principals/naming-cases.json` holds both to one rule. A second
 * place that names a principal is a second answer to "what is this principal
 * called", and the one that wins would be whichever ran last. The Librarian's
 * resolver is Python and the rest of the tree's readers are TypeScript and
 * Python, so this rule reads the source of both.
 *
 * The files read are the TypeScript, Python and Rust under each package's,
 * app's and image's `src`, a crate inside an image included, that git says the
 * repository holds (`repository-files.mjs`), tests left out: a fixture may
 * build provenance by hand, and is no second definition of it. The second rule
 * reads the TypeScript and Python alone.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { repositoryFiles } from '../../../.github/scripts/checks/repository-files.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ALLOWED = 'images/archivist/record/src/agents.rs';
/** Where a principal acquires a name in TypeScript or Python — the Librarian's read-side resolver, and only it. */
const NAMES_A_PRINCIPAL = 'images/librarian/src/semiont_librarian/naming.py';
/**
 * Assigning `name` onto something already known to be a principal. Matches
 * the resolver's own shape and a hand-rolled equivalent; reading a name is not
 * matched.
 */
const PRINCIPAL_NAMING = /\[['"]name['"]\]\s*=|\bname:\s*profile\.name\b/;
const CONSTRUCTION = new RegExp([
  String.raw`\b(?:const|let|var)\s+wasAttributedTo\b`,   // a local being built
  String.raw`\bwasAttributedTo\s*[:=]\s*(?:\[|creator\b)`, // a key or assignment from a literal / from creator
  String.raw`\blet\s+(?:mut\s+)?was_attributed_to\b`,  // Rust: a local being built
].join('|'));

/** A source directory at the head of a path: `packages/<language>/<name>/src`, `apps/<name>/src`, `images/<name>/src`, or a crate's inside an image, `images/<name>/<crate>/src`. */
const SOURCE_ROOT = /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+|images\/[^/]+(?:\/[^/]+)?)\/src(?=\/)/;
const TEST = /(^|\/)__tests__\/|\.test\.ts$/;

const sources = repositoryFiles(ROOT).filter((file) => SOURCE_ROOT.test(file));
const roots = new Set(sources.map((file) => SOURCE_ROOT.exec(file)[0]));

const hits = [];
const nameHits = [];
for (const file of sources.filter((f) => /\.(?:ts|py|rs)$/.test(f) && !TEST.test(f))) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const namesPrincipals = !file.endsWith('.rs');
  lines.forEach((line, i) => {
    const where = { file, line: i + 1, text: line.trim() };
    if (CONSTRUCTION.test(line)) hits.push(where);
    if (namesPrincipals && PRINCIPAL_NAMING.test(line)) nameHits.push(where);
  });
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
  console.error(`  Route it through attribution() in ${ALLOWED} and copy the result.`);
  failed = true;
}
const namedHere = nameHits.filter((h) => h.file === NAMES_A_PRINCIPAL);
const namedElsewhere = nameHits.filter((h) => h.file !== NAMES_A_PRINCIPAL);
if (namedHere.length === 0) {
  console.error(`✗ lint:attribution — nothing in ${NAMES_A_PRINCIPAL} names a principal. A record whose principals are never named is the defect this resolver exists to fix.`);
  failed = true;
}
if (namedElsewhere.length > 0) {
  console.error('✗ lint:attribution — a principal is named outside the read-side resolver:');
  for (const h of namedElsewhere) console.error(`    ${h.file}:${h.line}  ${h.text}`);
  console.error(`  A name is resolved when a record is READ, in ${NAMES_A_PRINCIPAL}, from the profiles projection.`);
  failed = true;
}

if (failed) process.exit(1);
console.log(`✓ lint:attribution — wasAttributedTo is constructed in one place (${ALLOWED}), a principal is named in one place (${NAMES_A_PRINCIPAL}), ${roots.size} source roots checked`);
