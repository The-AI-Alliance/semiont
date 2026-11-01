#!/usr/bin/env node
// Generate what each component schema requires of a value, as the Go SDK's
// reply checks read it (packages/go/sdk/internal/required):
//
//   packages/go/sdk/internal/required/schemas_gen.json
//
// The reading of the schemas, and the rules a shape states, are
// required-shapes.mjs's, shared with every SDK's generator. The package
// embeds the file, and finds a reply's shape by the name of the type package
// api writes of its schema, which is the schema's own. So each component must
// have such a type. One oapi-codegen writes as an alias (`type X = Y`) is
// read by the type it names, whose name is not the component's: its shape
// may state no more than the kind that type is, which is what the package
// reads of it. A component that breaks either fails the generator and its
// `--check`. The output is committed; `--check` compares without writing (the
// CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredShapes } from './required-shapes.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, 'packages/go/sdk/internal/required/schemas_gen.json');
const DECLARED = ['packages/go/sdk/api/client_gen.go', 'packages/go/sdk/api/ids_gen.go'];
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const { names, shapes } = readRequiredShapes(ROOT, refuse);

/** The kind of value a Go type that is no type of package api's is read as; none for a type of its own. */
function kindOfGo(type) {
  if (type === 'string') return 'string';
  if (type === 'bool') return 'boolean';
  if (/^u?int(8|16|32|64)?$/.test(type)) return 'integer';
  if (/^float(32|64)$/.test(type)) return 'number';
  if (type.startsWith('map[')) return 'object';
  if (type.startsWith('[]')) return 'array';
  return undefined;
}

/** Each type package api declares, and the type it names where it is an alias. */
const aliased = new Map();
for (const file of DECLARED) {
  for (const [, name, alias, named] of readFileSync(resolve(ROOT, file), 'utf8').matchAll(/^type (\w+) (=?) ?(\S+)/gm)) {
    aliased.set(name, alias === '=' ? named : undefined);
  }
}
for (const name of names) {
  if (!aliased.has(name)) refuse(`${name} is a component of protocol/specs/src/openapi.json, and package api declares no type of its name`);
  const named = aliased.get(name);
  if (named === undefined) continue;
  const shape = shapes.get(name);
  const kind = kindOfGo(named);
  const readAs = kind === undefined ? {} : { kinds: [kind] };
  if (JSON.stringify(shape) !== JSON.stringify(readAs)) {
    refuse(`package api writes ${name} as an alias of ${named}, which is read as ${JSON.stringify(readAs)}, and its schema requires ${JSON.stringify(shape)}`);
  }
}

const text = `{
  "$comment": "GENERATED from the component schemas of protocol/specs/src/openapi.json by packages/codegen/schemas/generate-required-go.mjs — do not edit. What each requires of a value, by its name: the rules are packages/codegen/schemas/required-shapes.mjs's.",
  "schemas": {
${names.map((name) => `    ${JSON.stringify(name)}: ${JSON.stringify(shapes.get(name))}`).join(',\n')}
  }
}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
