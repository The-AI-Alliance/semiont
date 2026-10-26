#!/usr/bin/env node
// generate-encodings-go.mjs — generate the Go SDK's table of the Encoding
// Standard from specs/src/text/encoding-cases.json, the table every reader of
// a resource's text runs.
//
//   packages/sdk-go/encodings_gen.go
//
// Rust reads a resource's text with encoding_rs and TypeScript with the
// platform's TextDecoder, each of which has the standard's labels and its
// single-byte encodings in it. Go's standard library has neither, and the Go
// SDK takes nothing else at run time. So its reader takes both from this
// file, as the Python SDK's does from its own: the encoding each label names,
// and the 256 characters of each single-byte encoding.
//
// --check compares without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from './committed-source.mjs';
import { goComment } from './go-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = resolve(ROOT, 'specs/src/text/encoding-cases.json');
const OUT = resolve(ROOT, 'packages/sdk-go/encodings_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const table = JSON.parse(readFileSync(TABLE, 'utf8'));
if (!Array.isArray(table.cases) || table.cases.length === 0) refuse('has no cases');
if (table.legacyMultiByte === null || typeof table.legacyMultiByte !== 'object') refuse('does not list the legacy multi-byte encodings');

/** A Go string literal of printable ASCII: every other character as an escape, which JSON's are. */
const goAscii = (value) => JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const encodingOf = new Map();
const singleByte = [];
const refused = [];
const named = (encoding, labels) => {
  if (!Array.isArray(labels) || !labels.includes(encoding)) refuse(`${encoding} is not among its own labels`);
  for (const label of labels) {
    if (encodingOf.has(label)) refuse(`${label} is a label of ${encodingOf.get(label)} and of ${encoding}`);
    encodingOf.set(label, encoding);
  }
};
for (const stated of table.cases) {
  named(stated.encoding, stated.labels);
  if (typeof stated.everyByte === 'string') {
    if ([...stated.everyByte].length !== 256 || stated.everyByte.length !== 256) refuse(`${stated.encoding} states ${stated.everyByte.length} characters, not 256`);
    singleByte.push(stated);
  } else if (stated.refused === true) {
    refused.push(stated.encoding);
  } else if (typeof stated.bytes !== 'string' || typeof stated.text !== 'string') {
    refuse(`${stated.encoding} is a case of no kind this generator knows`);
  }
}
const legacy = Object.keys(table.legacyMultiByte).sort();
for (const encoding of legacy) named(encoding, table.legacyMultiByte[encoding]);
const labels = [...encodingOf.keys()].sort();

const text = `// Code generated from specs/src/text/encoding-cases.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-encodings-go.mjs

package semiont

${goComment(`labelsOfEncodings is every label of the Encoding Standard, ${labels.length} of them, each with the encoding it names. A label is matched in lower case, with no white space around it. An encoding that is neither in singleByteEncodings nor in refusedEncodings is UTF-8, UTF-16BE, UTF-16LE, or one of the standard's legacy multi-byte encodings (${legacy.join(', ')}), which no table here decodes.`)}
var labelsOfEncodings = []struct{ label, encoding string }{
${labels.map((label) => `\t{${goAscii(label)}, ${goAscii(encodingOf.get(label))}},`).join('\n')}
}

// singleByteEncodings is, for each single-byte encoding, the 256 characters
// its bytes are: the one at n is the byte n's.
var singleByteEncodings = []struct{ encoding, everyByte string }{
${singleByte.map(({ encoding, everyByte }) => `\t{${goAscii(encoding)}, ${goAscii(everyByte)}},`).join('\n')}
}

// refusedEncodings is the encodings whose labels are refused: no text is read
// under them.
var refusedEncodings = []string{${refused.sort().map(goAscii).join(', ')}}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
