#!/usr/bin/env node
// lint:spec-offset-units — the spec says what an offset into a text counts.
//
// A text offset counts Unicode code points from the start of the text, and so
// does every length worked out from one: the W3C Web Annotation rule, and the
// same number in every language. specs/src/text/offset-cases.json holds the
// counting itself, and each implementation runs it. This gate holds the
// wording: a member that carries an offset or a length of text and does not
// say its unit leaves a reader to assume their own language's, and a
// JavaScript string, a Rust `str` and a Python `str` each count differently.
//
// It fails when:
//   - a member listed below is gone, or its description does not say
//     "code points". These are the members that carry an offset or a length of
//     text on the wire, in the record or in a store;
//   - any description of a component schema speaks of an offset, of
//     characters, or of code units, and does not say "code points". A member
//     added beside the listed ones is held by this, whatever it is called.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const SCHEMAS = 'specs/src/components/schemas';

/** The members that carry an offset into a text, or a length of one: schema, then the path to the member. */
const MEMBERS = [
  ['TextPositionSelector', ['properties', 'start']],
  ['TextPositionSelector', ['properties', 'end']],
  ['SelectionData', ['properties', 'start']],
  ['SelectionData', ['properties', 'end']],
  ['PdfTextItem', ['properties', 'start']],
  ['PdfTextItem', ['properties', 'end']],
  ['AnchoredTextExtractedEntry', ['properties', 'lines', 'items', 'properties', 'words']],
  ['UnitCursor', ['properties', 'next']],
  ['GatherAnnotationOptions', ['properties', 'contextWindow']],
];

const SAYS_THE_UNIT = /code points?/i;
const SPEAKS_OF_A_COUNT_OF_TEXT = /\boffsets?\b|\bcharacters?\b|\bchars?\b|utf-16|\bcode units?\b/i;

const failures = [];
const schemas = new Map(
  readdirSync(resolve(REPO, SCHEMAS))
    .filter((name) => name.endsWith('.json'))
    .map((name) => [name.slice(0, -'.json'.length), JSON.parse(readFileSync(resolve(REPO, SCHEMAS, name), 'utf8'))]),
);

/** The listed members, as the sweep names a place: it leaves them to the check above. */
const listed = new Set(MEMBERS.map(([schema, path]) => `${schema} #/${path.join('/')}`));

for (const [schema, path] of MEMBERS) {
  const at = `${SCHEMAS}/${schema}.json #/${path.join('/')}`;
  const member = path.reduce((node, name) => node?.[name], schemas.get(schema));
  if (member === undefined) {
    failures.push(`${at} is listed as carrying an offset or a length of text, and is not there`);
  } else if (typeof member.description !== 'string' || !SAYS_THE_UNIT.test(member.description)) {
    failures.push(`${at} carries an offset or a length of text, and its description does not say that it counts code points`);
  }
}

function sweep(node, pointer, schema) {
  if (Array.isArray(node)) {
    node.forEach((member, index) => sweep(member, `${pointer}/${index}`, schema));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const { description } = node;
  const speaks = typeof description === 'string' && SPEAKS_OF_A_COUNT_OF_TEXT.test(description) && !SAYS_THE_UNIT.test(description);
  if (speaks && !listed.has(`${schema} ${pointer}`)) {
    failures.push(
      `${SCHEMAS}/${schema}.json ${pointer} speaks of an offset or of characters and does not say "code points": ${JSON.stringify(description.slice(0, 90))}`,
    );
  }
  for (const [name, member] of Object.entries(node)) sweep(member, `${pointer}/${name}`, schema);
}
for (const [schema, document] of schemas) sweep(document, '#', schema);

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(`✓ ${MEMBERS.length} members that carry an offset or a length of text say that they count code points, and no description of ${schemas.size} schemas leaves the unit out`);
