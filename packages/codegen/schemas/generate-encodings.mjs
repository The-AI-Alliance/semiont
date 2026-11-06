#!/usr/bin/env node
// generate-encodings.mjs — generate TypeScript's table of the Encoding
// Standard from protocol/specs/src/text/encoding-cases.json, the table every
// reader of a resource's text runs:
//
//   packages/typescript/core/src/generated/encodings.ts
//
// TypeScript reads a resource's text with the platform's TextDecoder, which
// has the standard's labels and its single-byte encodings in it. What it takes
// from here is the encodings whose labels every reader refuses, which
// TextDecoder decodes all the same. Output is gitignored and rebuilt by core's
// `prebuild`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = resolve(ROOT, 'protocol/specs/src/text/encoding-cases.json');
const OUT = resolve(ROOT, 'packages/typescript/core/src/generated/encodings.ts');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const table = JSON.parse(readFileSync(TABLE, 'utf8'));
if (!Array.isArray(table.cases) || table.cases.length === 0) refuse('has no cases');
const refused = table.cases.filter((stated) => stated.refused === true).map((stated) => stated.encoding);
if (refused.length === 0 || refused.some((encoding) => typeof encoding !== 'string')) refuse('refuses no encoding by its name');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
//
// Source:    protocol/specs/src/text/encoding-cases.json
// Generator: packages/codegen/schemas/generate-encodings.mjs
// Regen:     npm run generate:encodings --workspace=@semiont/core

/** The encodings of the Encoding Standard whose labels every reader of a resource's text refuses, by their names in lower case. */
export const REFUSED_ENCODINGS: ReadonlySet<string> = new Set([${refused.sort().map((encoding) => `'${encoding}'`).join(', ')}]);
`,
);
