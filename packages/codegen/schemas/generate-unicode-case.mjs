#!/usr/bin/env node
// Generate the code points Unicode gives the Cased and the Case_Ignorable
// property, which decide whether a capital sigma ends a word as the
// case-insensitive search lower-cases it (protocol/specs/src/annotations/reconcile-cases.json),
// as the C#, Kotlin and Go SDKs read them as they build, one copy in each:
//
//   packages/csharp/sdk/generators/Semiont.Generator/unicode-case.json   (read by the SDK's source generator)
//   packages/kotlin/sdk/src/codegen/unicode-case.json                    (read by the SDK's generator)
//   packages/go/sdk/annotations/unicodecase_gen.go                       (the two as range tables)
//
// Neither .NET, the JDK nor Go's unicode package gives the two properties,
// and Go's x/text, which lower-cases by its own copy of them, takes a
// character that is both as cased. The ranges are unicode-properties.mjs's,
// from Node's Unicode data, which Haskell's table is generated from too. No
// build runs this, so the copies are committed; `--check` compares without
// writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { propertyRanges, unicodeVersion } from './unicode-properties.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { goComment } from '../lib/go-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECK = process.argv.includes('--check');

const cased = propertyRanges(/\p{Cased}/u);
const caseIgnorable = propertyRanges(/\p{Case_Ignorable}/u);

const json = `{
  "$comment": "GENERATED from Node's Unicode ${unicodeVersion} data by packages/codegen/schemas/generate-unicode-case.mjs — do not edit. The code points Unicode gives the Cased and the Case_Ignorable property, each as ascending ranges of a first and a last code point: what decides whether a capital sigma ends a word (protocol/specs/src/annotations/reconcile-cases.json).",
  "cased": ${JSON.stringify(cased)},
  "caseIgnorable": ${JSON.stringify(caseIgnorable)}
}
`;

/**
 * `ranges` as the Go `*unicode.RangeTable` named `name`: the ranges of the
 * Basic Multilingual Plane as 16-bit ones, those beyond it as 32-bit ones, and
 * a range that crosses from the one to the other split in two.
 */
function goRangeTable(name, ranges) {
  const r16 = [];
  const r32 = [];
  for (const [first, last] of ranges) {
    if (first <= 0xffff) r16.push([first, Math.min(last, 0xffff)]);
    if (last > 0xffff) r32.push([Math.max(first, 0x10000), last]);
  }
  const hex = (code) => `0x${code.toString(16).padStart(4, '0')}`;
  const rows = (pairs) => pairs.map(([first, last]) => `\t\t{${hex(first)}, ${hex(last)}, 1},`).join('\n');
  return `var ${name} = &unicode.RangeTable{
\tR16: []unicode.Range16{
${rows(r16)}
\t},
\tR32: []unicode.Range32{
${rows(r32)}
\t},
\tLatinOffset: ${r16.filter(([, last]) => last <= 0xff).length},
}`;
}

const go = `// Code generated from Node's Unicode ${unicodeVersion} data by packages/codegen/schemas/generate-unicode-case.mjs — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-unicode-case.mjs
// C#'s and Kotlin's copies of the two properties are generated from the same data.

package annotations

import "unicode"

${goComment('cased is the code points Unicode gives the Cased property.')}
${goRangeTable('cased', cased)}

${goComment('caseIgnorable is the code points Unicode gives the Case_Ignorable property.')}
${goRangeTable('caseIgnorable', caseIgnorable)}
`;

const OUTS = [
  ['packages/csharp/sdk/generators/Semiont.Generator/unicode-case.json', json],
  ['packages/kotlin/sdk/src/codegen/unicode-case.json', json],
  ['packages/go/sdk/annotations/unicodecase_gen.go', go],
];

for (const [out, text] of OUTS) writeOrCheck(ROOT, resolve(ROOT, out), text, CHECK);
