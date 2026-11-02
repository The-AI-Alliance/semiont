#!/usr/bin/env node
// Generate what each component schema requires of a value, as the Go SDK's
// reply checks read it (packages/go/sdk/internal/required):
//
//   packages/go/sdk/internal/required/schemas_gen.json
//
// The reading of the schemas, and the rules a shape states, are
// required-members.mjs's, shared with TypeScript's generator. The package
// embeds the file, and finds a reply's shape by the name of the type package
// api writes of its schema, which is the schema's own. So each component must
// have such a type, and one oapi-codegen writes as an alias (`type X = Y`),
// whose name a decoded value does not carry, must require nothing; a
// component that breaks either fails the generator and its `--check`. The
// output is committed; `--check` compares without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredMembers } from './required-members.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, 'packages/go/sdk/internal/required/schemas_gen.json');
const DECLARED = ['packages/go/sdk/api/client_gen.go', 'packages/go/sdk/api/ids_gen.go'];
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const { names, shapes } = readRequiredMembers(ROOT, refuse);

/** Each type package api declares, and whether it is an alias. */
const aliased = new Map();
for (const file of DECLARED) {
  for (const [, name, alias] of readFileSync(resolve(ROOT, file), 'utf8').matchAll(/^type (\w+) (=?)/gm)) {
    aliased.set(name, alias === '=');
  }
}
for (const name of names) {
  if (!aliased.has(name)) refuse(`${name} is a component of specs/src/openapi.json, and package api declares no type of its name`);
  if (aliased.get(name) && Object.keys(shapes.get(name)).length > 0) {
    refuse(`package api writes ${name} as an alias, whose name a decoded value does not carry, and it requires members: ${JSON.stringify(shapes.get(name))}`);
  }
}

const text = `{
  "$comment": "GENERATED from the component schemas of specs/src/openapi.json by packages/codegen/schemas/generate-required-go.mjs — do not edit. What each requires of a value, as far as its members go, by its name: the rules are packages/codegen/schemas/required-members.mjs's.",
  "schemas": {
${names.map((name) => `    ${JSON.stringify(name)}: ${JSON.stringify(shapes.get(name))}`).join(',\n')}
  }
}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
