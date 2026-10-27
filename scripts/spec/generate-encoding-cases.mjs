#!/usr/bin/env node
// generate-encoding-cases.mjs — generate specs/src/text/encoding-cases.json:
// every label of the Encoding Standard with the encoding it names, every byte
// of each of the standard's single-byte encodings, and some bytes of each of
// its other encodings, as cases every reader of a resource's text runs.
//
// Two things are read, and nothing is typed here but the names of the three
// groups an encoding can be in, and the bytes of each encoding that is not a
// single-byte one:
//
//   - The labels, from the npm package @exodus/bytes (an implementation of
//     the Encoding Standard; jsdom reads with it) at the one version the
//     repository's package.json pins. Its label table is a module of its own
//     (fallback/encoding.labels.js) that the package does not export, so it
//     is read by its path and its shape is checked before it is believed.
//   - What each byte of a single-byte encoding is, and what the bytes of each
//     other encoding are, from this Node's own TextDecoder.
//
// Each is held to the other before anything is written: TextDecoder must
// take every label as the encoding the table gives it, and refuse the labels
// of `replacement`. The Rust SDK's runner (packages/sdk-rust/tests/decode_cases.rs)
// then holds what is written to encoding_rs, which is the standard as Firefox
// has it: label by label and byte by byte.
//
// --check compares without writing (the CI drift gate).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeOrCheck } from './committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@exodus/bytes';
const LABELS = 'fallback/encoding.labels.js';
const OUT = resolve(ROOT, 'specs/src/text/encoding-cases.json');
const CHECK = process.argv.includes('--check');

/** The encodings that are not single-byte ones, by the standard's own headings. Everything else the standard names is. */
const UNICODE = { 'utf-8': 'c3 a9', 'utf-16be': '00 e9', 'utf-16le': 'e9 00' };
/**
 * For each legacy multi-byte encoding, bytes only a decoder of it reads as what
 * this Node's TextDecoder reads them as: gb18030's hold a four-byte sequence,
 * and ISO-2022-JP's switch to its two-byte mode and back.
 */
const LEGACY_MULTI_BYTE = {
  big5: 'a4 a4',
  'euc-jp': 'c6 fc',
  'euc-kr': 'c7 d1 b1 db',
  gb18030: 'd6 d0 81 30 81 30',
  gbk: 'd6 d0',
  'iso-2022-jp': '1b 24 42 46 7c 1b 28 42 41',
  shift_jis: '93 fa',
};
const REPLACEMENT = 'replacement';

function refuse(message) {
  console.error(`✗ ${PACKAGE}: ${message}`);
  process.exit(1);
}

const pinned = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).devDependencies?.[PACKAGE];
if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned)) {
  refuse(`the repository's package.json pins it as ${JSON.stringify(pinned)}, which is not one version`);
}
const installed = resolve(ROOT, 'node_modules', PACKAGE);
if (!existsSync(resolve(installed, 'package.json'))) refuse(`it is not installed. Run npm install, which installs ${pinned}`);
const manifest = JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8'));
if (manifest.version !== pinned) refuse(`${manifest.version} is installed and package.json pins ${pinned}. Run npm install`);
if (!existsSync(resolve(installed, LABELS))) refuse(`${pinned} has no ${LABELS}: its label table has moved`);

const stated = (await import(pathToFileURL(resolve(installed, LABELS)).href)).default;
if (stated === null || typeof stated !== 'object' || Array.isArray(stated)) refuse(`${LABELS} does not export a table`);

/** Every label of an encoding, its own name among them, in order. */
const labelsOf = new Map();
const seen = new Map();
for (const [encoding, others] of Object.entries(stated)) {
  if (!Array.isArray(others) || others.some((label) => typeof label !== 'string')) refuse(`${encoding}'s labels are not a list of text`);
  const labels = [encoding, ...others];
  for (const label of labels) {
    if (label === '' || label !== label.toLowerCase() || label !== label.trim() || /[^\x21-\x7e]/.test(label)) {
      refuse(`${JSON.stringify(label)} is not a label: lower case, printable ASCII, no white space`);
    }
    if (seen.has(label)) refuse(`${label} is a label of ${seen.get(label)} and of ${encoding}`);
    seen.set(label, encoding);
  }
  labelsOf.set(encoding, labels.sort());
}

// TextDecoder takes each label as the encoding the table gives it, and refuses `replacement`'s.
for (const [label, encoding] of seen) {
  let taken;
  try {
    taken = new TextDecoder(label).encoding;
  } catch {
    taken = null;
  }
  const expected = encoding === REPLACEMENT ? null : encoding;
  if (taken !== expected) {
    refuse(`the label ${label} is ${encoding} in its table and ${taken ?? 'refused'} to this Node's TextDecoder: one of the two is not the standard`);
  }
}

for (const encoding of [...Object.keys(UNICODE), ...Object.keys(LEGACY_MULTI_BYTE), REPLACEMENT]) {
  if (!labelsOf.has(encoding)) refuse(`its table has no ${encoding}`);
}
const singleByte = [...labelsOf.keys()].filter((encoding) => !(encoding in UNICODE) && !(encoding in LEGACY_MULTI_BYTE) && encoding !== REPLACEMENT).sort();

/** The 256 characters the bytes 00 to ff are in a single-byte encoding, each byte read on its own. */
function everyByte(encoding) {
  const decoder = new TextDecoder(encoding);
  let text = '';
  for (let byte = 0; byte < 256; byte++) {
    const read = decoder.decode(new Uint8Array([byte]));
    if (read.length !== 1) refuse(`${encoding} reads the byte ${byte.toString(16)} as ${read.length} UTF-16 code units: it is no single-byte encoding`);
    text += read;
  }
  // The same bytes read together: a single-byte encoding reads each byte by itself.
  if (decoder.decode(Uint8Array.from({ length: 256 }, (_, byte) => byte)) !== text) refuse(`${encoding} reads its bytes otherwise together than one by one`);
  return text;
}

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
const bytesFrom = (written) => Uint8Array.from(written.split(' '), (byte) => parseInt(byte, 16));
const cases = [
  ...Object.entries(UNICODE).map(([encoding, bytes]) => {
    const text = new TextDecoder(encoding).decode(bytesFrom(bytes));
    if (text !== 'é') refuse(`${encoding} reads ${bytes} as ${JSON.stringify(text)}`);
    return { encoding, labels: labelsOf.get(encoding), bytes, text };
  }),
  ...Object.entries(LEGACY_MULTI_BYTE).map(([encoding, bytes]) => {
    const text = new TextDecoder(encoding).decode(bytesFrom(bytes));
    if (text.includes('\uFFFD') || /^[\x00-\x7f]*$/.test(text)) refuse(`${encoding} reads ${bytes} as ${JSON.stringify(text)}, which proves no decoder of it`);
    return { encoding, labels: labelsOf.get(encoding), bytes, text };
  }),
  ...singleByte.map((encoding) => ({ encoding, labels: labelsOf.get(encoding), everyByte: everyByte(encoding) })),
  { encoding: REPLACEMENT, labels: labelsOf.get(REPLACEMENT), refused: true },
];

const table = {
  $comment:
    'GENERATED by scripts/spec/generate-encoding-cases.mjs; do not edit. Every label of the Encoding Standard ' +
    '(https://encoding.spec.whatwg.org/) with the encoding it names, and every byte of each of the standard\'s ' +
    'single-byte encodings and of x-user-defined, as every reader of a resource\'s text must read them. It is the ' +
    'exhaustive half of the rule docs/protocol/W3C-SELECTORS.md states of a resource\'s text; decode-cases.json, beside ' +
    'it and written by hand, holds what is said of a content type, of a label, of a byte-order mark and of malformed ' +
    'UTF-8 and UTF-16. A CASE is an `encoding`, by its name in lower case, and its `labels`, the name among them. A ' +
    'reader given a content type whose charset is any one of the labels, in any case and with ASCII white space around ' +
    'it, reads the bytes in that encoding. What that is, is one of three things. `everyByte`: the encoding is a ' +
    'single-byte one, and this is the text the 256 bytes 00 to ff, in that order, are: one character to a byte, and ' +
    'U+FFFD where the encoding gives the byte none. `bytes` and `text`: some bytes in hexadecimal and the text they ' +
    'are, which tell UTF-8, UTF-16BE and UTF-16LE from one another, and which only a decoder of each of the ' +
    'standard\'s seven legacy multi-byte encodings reads; where readers\' decoders of those differ, in rarer sequences ' +
    'and in what they make of a fault, is not held here. `refused`: every label of the case is refused, by its name: ' +
    'these are the labels of the standard\'s `replacement` encoding. Every character here that is not printable ASCII ' +
    'is written as an escape. WHERE IT COMES FROM. The labels are read from ' +
    `the npm package ${PACKAGE}, an implementation of the standard, at the version the repository's package.json pins ` +
    '(MIT, Exodus Movement); the characters of each byte, and the text of each case\'s bytes, are what Node\'s ' +
    'TextDecoder reads; and the generator refuses ' +
    'to write where the two disagree about a label. RUN BY TypeScript in packages/core (decode-cases.test.ts), by the ' +
    'Rust SDK (tests/decode_cases.rs), by the Python SDK (tests/test_decode_cases.py) and by the Go SDK ' +
    '(resources_test.go), each for every label of every case. The Rust SDK\'s reader is encoding_rs, which is the standard as ' +
    'Firefox has it, so its run is the check of this table against a second implementation, label by label and byte ' +
    'by byte. A reader in another language runs it too.',
  runBy: {
    typescript: ['packages/core/src/__tests__/decode-cases.test.ts'],
    rust: ['packages/sdk-rust/src/resources.rs', 'packages/sdk-rust/tests/decode_cases.rs'],
    python: ['packages/sdk-python/tests/test_decode_cases.py'],
    go: ['packages/sdk-go/resources_test.go'],
  },
  cases,
};

// Printable ASCII alone: every other character as the escape JSON has for it.
const text = `${JSON.stringify(table, null, 2).replace(/[^\n\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
if (hex(new TextEncoder().encode(JSON.parse(text).cases[0].text)) !== 'c3 a9') refuse('what is written does not read back');

writeOrCheck(ROOT, OUT, text, CHECK);
