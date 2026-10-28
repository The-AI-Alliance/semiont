#!/usr/bin/env node
// generate-stack-go.mjs — the launcher's types for a knowledge base's
// documents, and the schemas it reads them against, from specs/src/stack/ and
// specs/src/kb-identity/ProjectConfig.json.
//
//   apps/launcher/internal/stack/types_gen.go    a Go type for each kind of
//                                                document, and for each object
//                                                in one
//   apps/launcher/internal/stack/schemas_gen.go  the text of every schema a
//                                                kind reaches
//
// The launcher validates a document against its schema (the one
// lint:spec-stack holds the cases to) and only then decodes it into its type,
// so a type states the schema's shape and no rule of its own: `oneOf`,
// `pattern`, a bound and the like are the schema's to enforce. A reference
// into specs/src/components/schemas is the Go SDK's type of that name. A
// schema form this generator does not render is refused by name, rather than
// rendered as a guess.
//
// --check diffs without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goComment } from './go-source.mjs';
import { writeOrCheck } from './committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'apps/launcher/internal/stack');
const CHECK = process.argv.includes('--check');

/** The kinds of document, in the order their types are written. */
const KINDS = [
  'specs/src/stack/KnowledgeBase.json',
  'specs/src/stack/KnowledgeIndex.json',
  'specs/src/stack/Issuer.json',
  'specs/src/stack/WorkerPool.json',
  'specs/src/stack/Inference.json',
  'specs/src/kb-identity/ProjectConfig.json',
];
const COMPONENTS = 'specs/src/components/schemas/';

/** The keywords a type is made from, and those that are rules the validator enforces. */
const SHAPE = new Set(['title', 'type', 'description', 'properties', 'required', 'additionalProperties', 'propertyNames', '$ref']);
const RULES = new Set(['oneOf', 'allOf', 'anyOf', 'not', 'const', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minProperties']);

function refuse(where, message) {
  console.error(`✗ ${where}: ${message}`);
  process.exit(1);
}

const parsed = new Map();
function schemaAt(path) {
  if (!parsed.has(path)) parsed.set(path, JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')));
  return parsed.get(path);
}

const pascal = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;

/** The repository path a `$ref` written in the file at `from` names, and its fragment. */
function target(from, ref) {
  const [file, fragment = ''] = ref.split('#');
  return { path: file ? relative(ROOT, resolve(dirname(resolve(ROOT, from)), file)) : from, fragment };
}

// ── the types ─────────────────────────────────────────────────────────────

const types = new Map();
let usesSDK = false;

function describe(schema, from) {
  if (schema.description) return schema.description;
  if (!schema.$ref) return undefined;
  const { path, fragment } = target(from, schema.$ref);
  let referred = schemaAt(path);
  for (const step of fragment.split('/').filter(Boolean)) referred = referred?.[step];
  return referred?.description;
}

/** The Go type of `schema`, written in the file at `from`, named `name` if it is an object of its own. */
function goType(schema, from, name) {
  for (const keyword of Object.keys(schema)) {
    if (!SHAPE.has(keyword) && !RULES.has(keyword)) refuse(from, `${name} uses \`${keyword}\`, which this generator does not render`);
  }
  if (schema.$ref) {
    const { path, fragment } = target(from, schema.$ref);
    if (path.startsWith(COMPONENTS)) {
      usesSDK = true;
      const base = path.slice(COMPONENTS.length).replace(/\.json$/, '');
      if (fragment === '') return `api.${base}`;
      const property = fragment.match(/^\/properties\/([A-Za-z]+)$/);
      if (!property) refuse(from, `${name} refers to ${path}#${fragment}, which this generator does not render`);
      return `api.${base}${pascal(property[1])}`;
    }
    if (fragment !== '') refuse(from, `${name} refers to ${path}#${fragment}, which this generator does not render`);
    const referred = schemaAt(path);
    if (referred.type === 'string') return 'string';
    if (referred.type === 'object' && referred.title && referred.properties) return objectType(referred, path, referred.title);
    refuse(path, `referred to by ${name}, and neither a string nor an object with a title`);
  }
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'integer':
      return 'int';
    case 'number':
      return 'float64';
    case 'boolean':
      return 'bool';
    case 'object':
      if (schema.properties) return objectType(schema, from, name);
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const key = schema.propertyNames ? goType(schema.propertyNames, from, `${name}Key`) : 'string';
        return `map[${key}]${goType(schema.additionalProperties, from, `${name}Value`)}`;
      }
  }
  refuse(from, `${name} is a schema of type ${JSON.stringify(schema.type)} with no properties, which this generator does not render`);
}

/** An object's struct. Its fields are named as its properties; an object under `spec` takes its kind's name. */
function objectType(schema, from, name) {
  if (types.has(name)) return name;
  types.set(name, '');
  const required = new Set(schema.required ?? []);
  const prefix = name.endsWith('Spec') ? name.slice(0, -'Spec'.length) : name;
  const fields = Object.entries(schema.properties).map(([property, sub]) => {
    const optional = !required.has(property);
    let type = goType(sub, from, `${prefix}${pascal(property)}`);
    if (optional && !type.startsWith('map[')) type = `*${type}`;
    const description = describe(sub, from);
    const field = `\t${pascal(property)} ${type} \`json:"${property}${optional ? ',omitempty' : ''}"\``;
    return description ? `${goComment(description, '\t')}\n${field}` : field;
  });
  if (!schema.description) refuse(from, `${name} is an object with no description`);
  types.set(name, `${goComment(`${name}: ${schema.description}`)}\ntype ${name} struct {\n${fields.join('\n\n')}\n}\n`);
  return name;
}

for (const path of KINDS) {
  const schema = schemaAt(path);
  if (!schema.title) refuse(path, 'a kind with no title');
  objectType(schema, path, schema.title);
}

const typesText = `// Code generated from specs/src/stack and specs/src/kb-identity/ProjectConfig.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-stack-go.mjs

package stack
${usesSDK ? '\nimport "github.com/The-AI-Alliance/semiont/packages/go/sdk/api"\n' : ''}
${[...types.values()].join('\n')}`;

// ── the schemas ───────────────────────────────────────────────────────────

/** Every schema file a kind reaches by `$ref`, the kinds' own included. */
const reached = new Set();
function reach(path) {
  if (reached.has(path)) return;
  reached.add(path);
  (function walk(node) {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) reach(target(path, value).path);
        else walk(value);
      }
    }
  })(schemaAt(path));
}
KINDS.forEach(reach);

const entries = [...reached].sort().map((path) => `\t${JSON.stringify(path)}: ${JSON.stringify(JSON.stringify(schemaAt(path)))},`);
const kindEntries = KINDS.map((path) => `\t${JSON.stringify(schemaAt(path).title)}: ${JSON.stringify(path)},`);

const schemasText = `// Code generated from specs/src/stack and specs/src/kb-identity/ProjectConfig.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-stack-go.mjs

package stack

// schemaFiles: the text of every schema a document is read against, and of
// every schema those refer to, by its path in the repository.
var schemaFiles = map[string]string{
${entries.join('\n\n')}
}

// schemaOf: the schema each kind of document is read against.
var schemaOf = map[string]string{
${kindEntries.join('\n\n')}
}
`;

writeOrCheck(ROOT, resolve(OUT, 'types_gen.go'), typesText, CHECK);
writeOrCheck(ROOT, resolve(OUT, 'schemas_gen.go'), schemasText, CHECK);
console.log(`kinds: ${KINDS.length}, types: ${types.size}, schemas: ${reached.size}`);
