#!/usr/bin/env node
// generate-encodings-python.mjs — generate the Python SDK's table of the
// Encoding Standard from specs/src/text/encoding-cases.json, the table every
// reader of a resource's text runs.
//
//   packages/python/sdk/src/semiont/_encodings.py
//
// Rust reads a resource's text with encoding_rs and TypeScript with the
// platform's TextDecoder, each of which has the standard's labels and its
// single-byte encodings in it. Python's own codecs have other labels and, for
// some bytes, other characters. So the Python SDK's reader takes both from
// this module: the encoding each label names, and the 256 characters of each
// single-byte encoding.
//
// --check compares without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { pyBanner } from '../lib/python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = resolve(ROOT, 'specs/src/text/encoding-cases.json');
const OUT = resolve(ROOT, 'packages/python/sdk/src/semiont/_encodings.py');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const table = JSON.parse(readFileSync(TABLE, 'utf8'));
if (!Array.isArray(table.cases) || table.cases.length === 0) refuse('has no cases');

/** A Python string literal of printable ASCII: every other character as an escape, which JSON's are. */
const pyAscii = (value) => JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

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
const labels = [...encodingOf.keys()].sort();
const pySet = (names) => `frozenset({${names.map(pyAscii).join(', ')}})`;

const text = `${pyBanner('specs/src/text/encoding-cases.json', 'packages/codegen/schemas/generate-encodings-python.mjs')}
"""The Encoding Standard as the reader of a resource's text needs it: the encoding each label names, and each single-byte encoding byte by byte."""

from collections.abc import Mapping
from typing import Final

__all__ = ["ENCODING_OF_LABEL", "REFUSED", "SINGLE_BYTE"]

# Every label of the standard: ${labels.length} of them.
ENCODING_OF_LABEL: Final[Mapping[str, str]] = {
${labels.map((label) => `    ${pyAscii(label)}: ${pyAscii(encodingOf.get(label))},`).join('\n')}
}
"""The encoding each label of the standard names. A label is matched in lower case, with no white space around it.

An encoding that is neither in \`SINGLE_BYTE\` nor in \`REFUSED\` is one no
table here decodes: UTF-8, UTF-16BE, UTF-16LE, or one of the standard's legacy
multi-byte encodings.
"""

SINGLE_BYTE: Final[Mapping[str, str]] = {
${singleByte.map(({ encoding, everyByte }) => `    ${pyAscii(encoding)}: ${pyAscii(everyByte)},`).join('\n')}
}
"""For each single-byte encoding, the 256 characters its bytes are: the one at \`n\` is the byte \`n\`'s."""

REFUSED: Final = ${pySet(refused.sort())}
"""The encodings whose labels are refused: no text is read under them."""
`;

writeOrCheck(ROOT, OUT, text, CHECK);
