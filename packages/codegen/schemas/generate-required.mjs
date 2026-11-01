#!/usr/bin/env node
// Generate what each component schema requires of a value, as the Rust and
// Kotlin SDKs read it as they build:
//
//   protocol/specs/src/client/required.json
//
// The reading of the schemas, and the rules a shape states, are
// required-shapes.mjs's, shared with every SDK's generator. Rust's build
// (packages/rust/sdk/build.rs) and Kotlin's generator
// (packages/kotlin/sdk/src/codegen) read the file among the rest of
// protocol/specs/src, and write each SDK's table from it. The output is committed;
// `--check` compares without writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredShapes } from './required-shapes.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, 'protocol/specs/src/client/required.json');
const CHECK = process.argv.includes('--check');

const { names, shapes } = readRequiredShapes(ROOT, (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
});

const text = `{
  "$comment": "GENERATED from the component schemas of protocol/specs/src/openapi.json by packages/codegen/schemas/generate-required.mjs — do not edit. What each requires of a value, by its name: the rules are packages/codegen/schemas/required-shapes.mjs's. Rust's build and Kotlin's generator read it.",
  "schemas": {
${names.map((name) => `    ${JSON.stringify(name)}: ${JSON.stringify(shapes.get(name))}`).join(',\n')}
  }
}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
