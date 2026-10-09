#!/usr/bin/env node
// lint:spec-reference-forms — how the spec writes a reference to another schema.
//
// OpenAPI 3.0 reads nothing beside a `$ref`, so something said of a reference
// is written `{ "allOf": [{ "$ref": … }], "description": … }`, and
// `npm run openapi:lint` refuses a description beside a bare one. Two of the
// generators cannot take that form everywhere, and nothing they emit says so:
// the TypeScript type loosens and the Go method is renamed, and both still
// build. This gate holds the places they cannot.
//
// It fails when:
//   - a wrapped reference names a schema that has a `discriminator`.
//     openapi-typescript takes the discriminator's property out of a wrapped
//     one (`Omit<Agent, "@type">`). Such a reference stays a bare `$ref` with
//     its description beside it, and .redocly.lint-ignore.yaml names the place
//     under `spec-ref-siblings`;
//   - a member of a `oneOf` or an `anyOf` is a wrapped reference. oapi-codegen
//     names a union's accessors by a wrapped member's position
//     (`AsAnnotationTarget0`). The member stays a bare `$ref`, and what would
//     be said of it is said in the union's description;
//   - a bare `$ref` has something beside it and names a schema with no
//     `discriminator`. No other reference is excused from the wrapped form,
//     whatever the ignore file lists.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');

/** Where the two API documents are written: the gateway's root, and every directory of schemas, responses and paths. */
const ROOT = 'specs/src/openapi.json';
const DIRECTORIES = ['specs/src/components', 'specs/src/paths', 'specs/src/archivist'];

function jsonFilesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) return jsonFilesUnder(path);
    return name.endsWith('.json') && !name.endsWith('-cases.json') ? [path] : [];
  });
}

const documents = new Map();
function read(file) {
  if (!documents.has(file)) documents.set(file, JSON.parse(readFileSync(file, 'utf8')));
  return documents.get(file);
}

/** Whether the schema a reference names has a discriminator. A schema is a file; a reference into this one names none. */
function namesADiscriminated(ref, from) {
  const [path] = ref.split('#');
  if (path === '') return false;
  return read(resolve(dirname(from), path)).discriminator !== undefined;
}

/** The reference a node wraps, when it is an `allOf` of one `$ref`. */
function wrappedReference(node) {
  const [only, ...others] = Array.isArray(node.allOf) ? node.allOf : [];
  return others.length === 0 && typeof only?.$ref === 'string' && Object.keys(only).length === 1 ? only.$ref : undefined;
}

const failures = [];

function walk(node, pointer, file) {
  if (Array.isArray(node)) {
    node.forEach((member, index) => walk(member, `${pointer}/${index}`, file));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const at = `${relative(REPO, file)} ${pointer}`;

  const wrapped = wrappedReference(node);
  if (wrapped !== undefined && namesADiscriminated(wrapped, file)) {
    failures.push(
      `${at} wraps a reference to ${wrapped}, which has a discriminator: the TypeScript type would lose the discriminator's property. ` +
        'Write it as a bare `$ref` with its description beside it, and name the place in .redocly.lint-ignore.yaml under spec-ref-siblings',
    );
  }
  if (typeof node.$ref === 'string' && Object.keys(node).length > 1 && !namesADiscriminated(node.$ref, file)) {
    failures.push(
      `${at} says something beside a bare reference to ${node.$ref}, and OpenAPI 3.0 reads nothing there. ` +
        'Write it as `{ "allOf": [{ "$ref": … }], "description": … }`',
    );
  }
  for (const union of ['oneOf', 'anyOf']) {
    (Array.isArray(node[union]) ? node[union] : []).forEach((member, index) => {
      if (member !== null && typeof member === 'object' && wrappedReference(member) !== undefined) {
        failures.push(
          `${at}/${union}/${index} is a wrapped reference as a member of a union: the Go client would name the union's accessors by its position. ` +
            `Write the member as a bare \`$ref\`, and say what would be said of it in the ${union}'s description`,
        );
      }
    });
  }
  for (const [name, member] of Object.entries(node)) walk(member, `${pointer}/${name}`, file);
}

const files = [resolve(REPO, ROOT), ...DIRECTORIES.flatMap((directory) => jsonFilesUnder(resolve(REPO, directory)))];
for (const file of files) walk(read(file), '#', file);

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(`✓ ${files.length} spec files write each reference in a form every generator reads`);
