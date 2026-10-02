// The identifier spec gate.
//
// The protocol names four kinds of id (`specs/src/identifiers/kinds.json`),
// each a schema whose `pattern` is the rule a value of that kind is held to.
// A gateway validates a payload against its schema, so a property that
// carries an id and does not refer to its kind is an id nothing checks. The
// check fails when:
//
//   - a kind has no schema, its schema is anything but a string with a
//     pattern and a description, or the gateway's API does not declare it;
//   - a string the kind `accepts` does not match its pattern, or one it
//     `refuses` does;
//   - a property the file names for a kind is, anywhere in the spec, anything
//     but a reference to that kind (or a list of them);
//   - a property whose name ends in `Id` or `Ids` is named for no kind and is
//     not among `others`: a new id is classified before it is merged;
//   - an entry of `others` names a property the spec does not have, or one
//     that refers to a kind;
//   - a path parameter is not a reference to a kind.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const SPEC = resolve(REPO, 'specs/src');
const SCHEMAS = resolve(SPEC, 'components/schemas');
const KINDS = resolve(SPEC, 'identifiers/kinds.json');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

const failures = [];
const fail = (message) => failures.push(message);

const { kinds, others } = read(KINDS);
const kindNames = kinds.map((kind) => kind.schema);

// ── each kind is a schema, and its cases agree with its pattern ───────────

const declared = read(resolve(SPEC, 'openapi.json')).components.schemas;
for (const kind of kinds) {
  const path = resolve(SCHEMAS, `${kind.schema}.json`);
  if (!existsSync(path)) {
    fail(`${kind.schema} has no schema: specs/src/components/schemas/${kind.schema}.json`);
    continue;
  }
  const schema = read(path);
  const keys = Object.keys(schema).sort().join();
  if (schema.type !== 'string' || typeof schema.pattern !== 'string' || typeof schema.description !== 'string' || keys !== 'description,pattern,type') {
    fail(`${kind.schema} must be exactly a string with a pattern and a description; it has [${keys}]`);
    continue;
  }
  if (declared[kind.schema]?.$ref !== `components/schemas/${kind.schema}.json`) {
    fail(`specs/src/openapi.json does not declare ${kind.schema} among its schemas`);
  }
  const rule = new RegExp(schema.pattern, 'u');
  for (const { id, why } of kind.accepts) {
    if (!rule.test(id)) fail(`${kind.schema} accepts ${JSON.stringify(id)} (${why}), and its pattern ${schema.pattern} does not`);
  }
  for (const { id, why } of kind.refuses) {
    if (rule.test(id)) fail(`${kind.schema} refuses ${JSON.stringify(id)} (${why}), and its pattern ${schema.pattern} accepts it`);
  }
  if (kind.accepts.length === 0 || kind.refuses.length === 0) fail(`${kind.schema} has no case on one side: a rule nothing is refused by, or nothing passes, is not held`);
}

// ── every property that carries an id refers to its kind ──────────────────

const kindOfProperty = new Map();
for (const kind of kinds) {
  for (const property of kind.properties) {
    if (kindOfProperty.has(property)) fail(`${property} is named for two kinds: ${kindOfProperty.get(property)} and ${kind.schema}`);
    kindOfProperty.set(property, kind.schema);
  }
}
const otherProperties = new Map(others.map((other) => [other.property, other]));
for (const other of others) {
  if (kindOfProperty.has(other.property)) fail(`${other.property} is among \`others\` and is named for ${kindOfProperty.get(other.property)}`);
  if (typeof other.docs !== 'string' || other.docs.trim() === '') fail(`${other.property} is among \`others\` and does not say what it carries`);
}

/** The kind a schema refers to: directly, as the items of a list, or as the one member of a nullable `allOf`. */
function referred(schema) {
  const ref = schema?.$ref ?? schema?.items?.$ref ?? (schema?.allOf?.length === 1 ? schema.allOf[0].$ref : undefined);
  if (typeof ref !== 'string') return undefined;
  const name = basename(ref, '.json');
  return kindNames.includes(name) ? name : undefined;
}

const seen = new Set();
const namedLikeAnId = (name) => /Ids?$/.test(name);

function walk(node, file) {
  if (Array.isArray(node)) {
    for (const member of node) walk(member, file);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (node.properties !== null && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    for (const [name, schema] of Object.entries(node.properties)) {
      if (schema === null || typeof schema !== 'object') continue;
      seen.add(name);
      const expected = kindOfProperty.get(name);
      const actual = referred(schema);
      if (expected !== undefined && actual !== expected) {
        fail(`${file}: ${name} must refer to ${expected}${actual ? `, and refers to ${actual}` : ''}`);
      } else if (expected === undefined && otherProperties.has(name) && actual !== undefined) {
        fail(`${file}: ${name} is among \`others\` and refers to ${actual}`);
      } else if (expected === undefined && !otherProperties.has(name) && namedLikeAnId(name)) {
        fail(`${file}: ${name} is named like an id and is classified nowhere: name it for a kind, or among \`others\`, in specs/src/identifiers/kinds.json`);
      }
    }
  }
  if (Array.isArray(node.parameters)) {
    for (const parameter of node.parameters) {
      if (parameter?.in === 'path' && referred(parameter.schema) === undefined) {
        fail(`${file}: the path parameter {${parameter.name}} must refer to a kind of id`);
      }
    }
  }
  for (const member of Object.values(node)) walk(member, file);
}

function files(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith('.json') && path !== KINDS ? [path] : [];
  });
}

for (const path of files(SPEC)) walk(read(path), relative(REPO, path));

for (const property of [...kindOfProperty.keys(), ...otherProperties.keys()]) {
  if (!seen.has(property)) fail(`specs/src/identifiers/kinds.json names ${property}, which no schema of the spec has`);
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} identifier problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ ${kinds.length} kinds of id: every property named for one refers to it, and every case agrees with its rule`);
