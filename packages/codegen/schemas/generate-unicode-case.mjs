#!/usr/bin/env node
// Generate the code points Unicode gives the Cased and the Case_Ignorable
// property, which decide whether a capital sigma ends a word as the
// case-insensitive search lower-cases it (protocol/specs/src/annotations/reconcile-cases.json),
// as the C# SDK reads them as it builds:
//
//   packages/csharp/sdk/generators/Semiont.Generator/unicode-case.json   (read by the SDK's source generator)
//
// .NET gives neither property. The ranges are
// unicode-properties.mjs's, from Node's Unicode data, which Haskell's table
// is generated from too. No build runs this, so the copy is committed;
// `--check` compares without writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { propertyRanges, unicodeVersion } from './unicode-properties.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUTS = [
  'packages/csharp/sdk/generators/Semiont.Generator/unicode-case.json',
];
const CHECK = process.argv.includes('--check');

const text = `{
  "$comment": "GENERATED from Node's Unicode ${unicodeVersion} data by packages/codegen/schemas/generate-unicode-case.mjs — do not edit. The code points Unicode gives the Cased and the Case_Ignorable property, each as ascending ranges of a first and a last code point: what decides whether a capital sigma ends a word (protocol/specs/src/annotations/reconcile-cases.json).",
  "cased": ${JSON.stringify(propertyRanges(/\p{Cased}/u))},
  "caseIgnorable": ${JSON.stringify(propertyRanges(/\p{Case_Ignorable}/u))}
}
`;

for (const out of OUTS) writeOrCheck(ROOT, resolve(ROOT, out), text, CHECK);
