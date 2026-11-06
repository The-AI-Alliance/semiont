#!/usr/bin/env node
// Generate what each component schema requires of a value, as the Python
// SDK's reading of a reply reads it (packages/python/sdk/src/semiont/_required.py):
//
//   packages/python/sdk/src/semiont/_required_table.py
//
// The reading of the schemas, and the rules a shape states, are
// required-shapes.mjs's, shared with every SDK's generator. The module holds
// the table as JSON text, which the SDK reads as it imports it. The output is
// committed; `--check` compares without writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredShapes } from './required-shapes.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { pyBanner } from '../lib/python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, 'packages/python/sdk/src/semiont/_required_table.py');
const CHECK = process.argv.includes('--check');

const { names, shapes } = readRequiredShapes(ROOT, (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
});

const lines = names.map((name, at) => `${JSON.stringify(name)}:${JSON.stringify(shapes.get(name))}${at < names.length - 1 ? ',' : ''}`);
/** `text` as a Python string in single quotes: a member's name may hold a quote or a backslash. */
const quoted = (text) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

const text = `${pyBanner('the component schemas of protocol/specs/src/openapi.json', 'packages/codegen/schemas/generate-required-python.mjs')}
"""What each component schema requires of a value, by its name, as JSON: the rules are packages/codegen/schemas/required-shapes.mjs's."""

from typing import Final

__all__ = ["SCHEMAS"]

SCHEMAS: Final = (
    "{"
${lines.map((line) => `    ${quoted(line)}`).join('\n')}
    "}"
)
`;

writeOrCheck(ROOT, OUT, text, CHECK);
