#!/usr/bin/env node
// Generate what each component schema requires of a value, as the Rust,
// Kotlin, Swift and C# SDKs read it as they build, one copy in each:
//
//   packages/rust/sdk/src/required-schemas.json                              (read by packages/rust/sdk/build.rs)
//   packages/kotlin/sdk/src/codegen/required-schemas.json                    (read by the SDK's generator)
//   packages/swift/sdk/Sources/SemiontCodegen/required-schemas.json          (read by the SDK's build plugin)
//   packages/csharp/sdk/generators/Semiont.Generator/required-schemas.json   (read by the SDK's source generator)
//
// The reading of the schemas, and the rules a shape states, are
// required-shapes.mjs's, shared with every SDK's generator. No build runs
// them, so the copies are committed; `--check` compares without
// writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredShapes } from './required-shapes.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUTS = [
  'packages/rust/sdk/src/required-schemas.json',
  'packages/kotlin/sdk/src/codegen/required-schemas.json',
  'packages/swift/sdk/Sources/SemiontCodegen/required-schemas.json',
  'packages/csharp/sdk/generators/Semiont.Generator/required-schemas.json',
];
const CHECK = process.argv.includes('--check');

const { names, shapes } = readRequiredShapes(ROOT, (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
});

const text = `{
  "$comment": "GENERATED from the component schemas of protocol/specs/src/openapi.json by packages/codegen/schemas/generate-required.mjs — do not edit. What each requires of a value, by its name: the rules are packages/codegen/schemas/required-shapes.mjs's.",
  "schemas": {
${names.map((name) => `    ${JSON.stringify(name)}: ${JSON.stringify(shapes.get(name))}`).join(',\n')}
  }
}
`;

for (const out of OUTS) writeOrCheck(ROOT, resolve(ROOT, out), text, CHECK);
