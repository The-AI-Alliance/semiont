#!/usr/bin/env node
// generate-control.mjs — the control API's types, for the launcher that serves
// it and for Desktop, which speaks to it, and the schemas both validate
// against, from protocol/specs/src/control/methods.json and the schemas it
// names.
//
//   packages/go/launcher/control_types_gen.go    a Go type for each object a
//                                                  method's params, result or
//                                                  notification reaches,
//                                                  prefixed Control
//   packages/go/launcher/control_schemas_gen.go  the text of every schema
//                                                  they reach, and the method
//                                                  and notification tables
//   apps/desktop/electron/control-types.gen.ts   the same types in
//                                                  TypeScript, the method map,
//                                                  the schemas, and the
//                                                  control group of
//                                                  protocol/specs/src/errors/codes.json
//
// Both sides validate a message against its schema and only then read it, so a
// type states the schema's shape and no rule of its own: `oneOf`, `pattern`, a
// bound and the like are the validator's. A reference into
// protocol/specs/src/discovery is that contract's own type: in Go the
// launcher's DiscoveredKB, in TypeScript @semiont/core's. A schema form this
// generator does not render is refused by name, rather than rendered as a
// guess.
//
// --check diffs without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goComment } from '../lib/go-source.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = 'protocol/specs/src/control/methods.json';
const CODES = 'protocol/specs/src/errors/codes.json';
const DISCOVERY = 'protocol/specs/src/discovery/DiscoveredKB.json';
const GO_OUT = resolve(ROOT, 'packages/go/launcher');
const TS_OUT = resolve(ROOT, 'apps/desktop/electron/control-types.gen.ts');
const CHECK = process.argv.includes('--check');

/** The keywords a type is made from, and those that are rules the validator enforces. */
const SHAPE = new Set(['title', 'type', 'description', 'properties', 'required', 'additionalProperties', 'items', '$ref']);
const RULES = new Set(['oneOf', 'not', 'const', 'enum', 'pattern', 'minLength', 'minimum']);

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

/** The property a reference into the discovery contract names, or '' for the whole of it. */
function discoveryProperty(from, path, fragment, name) {
  if (fragment === '') return '';
  const property = fragment.match(/^\/properties\/([A-Za-z]+)$/);
  if (!property || !schemaAt(path).properties?.[property[1]]) refuse(from, `${name} refers to ${path}#${fragment}, which this generator does not render`);
  return property[1];
}

function describe(schema, from) {
  if (schema.description) return schema.description;
  if (!schema.$ref) return undefined;
  const { path, fragment } = target(from, schema.$ref);
  let referred = schemaAt(path);
  for (const step of fragment.split('/').filter(Boolean)) referred = referred?.[step];
  return referred?.description;
}

const table = schemaAt(TABLE);
for (const method of table.methods) {
  for (const key of Object.keys(method)) {
    if (!['name', 'params', 'result', 'exclusive', 'sends', 'docs'].includes(key)) refuse(TABLE, `${method.name} has \`${key}\`, which this generator does not render`);
  }
  if (typeof method.exclusive !== 'boolean') refuse(TABLE, `${method.name} does not say whether it is exclusive`);
  for (const sent of method.sends) {
    if (!table.notifications.some((n) => n.name === sent && n.from === 'launcher')) refuse(TABLE, `${method.name} sends ${sent}, which is no notification the launcher sends`);
  }
}
const resolveIn = (ref) => target(TABLE, ref).path;

// ── the types, in both languages ──────────────────────────────────────────

/** Each type, by name: its Go and its TypeScript declaration. */
const types = new Map();

/** The Go and TypeScript types of `schema`, written in the file at `from`, named `name` if it is an object of its own. */
function typeOf(schema, from, name) {
  for (const keyword of Object.keys(schema)) {
    if (!SHAPE.has(keyword) && !RULES.has(keyword)) refuse(from, `${name} uses \`${keyword}\`, which this generator does not render`);
  }
  if (schema.$ref) {
    const { path, fragment } = target(from, schema.$ref);
    if (path === DISCOVERY) {
      const property = discoveryProperty(from, path, fragment, name);
      if (property === '') return { go: 'DiscoveredKB', ts: 'DiscoveredKB' };
      const referred = schemaAt(path).properties[property];
      const go = referred.enum ? `DiscoveredKB${pascal(property)}` : typeOf(referred, path, `DiscoveredKB${pascal(property)}`).go;
      return { go, ts: `NonNullable<DiscoveredKB['${property}']>` };
    }
    if (fragment !== '') refuse(from, `${name} refers to ${path}#${fragment}, which this generator does not render`);
    if (!path.startsWith('protocol/specs/src/control/')) refuse(from, `${name} refers to ${path}, outside the control contract and the discovery contract`);
    const referred = schemaAt(path);
    if (referred.type === 'object') return objectType(referred, path, referred.title);
    if (!referred.title) refuse(path, `referred to by ${name}, and has no title`);
    return scalarType(referred, path, referred.title, true);
  }
  if (schema.type === 'object') {
    if (!schema.properties) refuse(from, `${name} is an object with no properties`);
    return objectType(schema, from, name);
  }
  if (schema.type === 'array') {
    if (!schema.items) refuse(from, `${name} is an array with no items`);
    const item = typeOf(schema.items, from, `${name}Item`);
    return { go: `[]${item.go}`, ts: `${parenthesized(item.ts)}[]` };
  }
  return scalarType(schema, from, name, false);
}

const parenthesized = (ts) => (ts.includes(' ') ? `(${ts})` : ts);

/** A string, number or boolean: named, as its own type, when it is a file of its own. */
function scalarType(schema, from, name, own) {
  let go;
  let ts;
  if (Array.isArray(schema.type)) {
    if (JSON.stringify(schema.type) !== '["string","integer"]') refuse(from, `${name} is of the types ${JSON.stringify(schema.type)}, which this generator does not render`);
    go = 'json.RawMessage';
    ts = 'string | number';
  } else {
    switch (schema.type) {
      case 'string':
        go = 'string';
        ts = schema.const !== undefined ? JSON.stringify(schema.const) : schema.enum ? schema.enum.map((v) => JSON.stringify(v)).join(' | ') : 'string';
        break;
      case 'integer':
        go = 'int';
        ts = 'number';
        break;
      case 'boolean':
        go = 'bool';
        ts = 'boolean';
        break;
      default:
        refuse(from, `${name} is a schema of type ${JSON.stringify(schema.type)}, which this generator does not render`);
    }
  }
  if (!own) return { go, ts };
  // A scalar of its own is named in TypeScript, where the union of its values
  // is a type; in Go it is the type it is made of, and the validator holds
  // its values.
  const typeName = `Control${name}`;
  if (!types.has(typeName)) {
    if (!schema.description) refuse(from, `${name} has no description`);
    types.set(typeName, { ts: `/** ${schema.description} */\nexport type ${typeName} = ${ts};\n` });
  }
  return { go, ts: typeName };
}

/** An object's struct and interface. Its fields are named as its properties. */
function objectType(schema, from, name) {
  const typeName = `Control${name}`;
  if (types.has(typeName)) return { go: typeName, ts: typeName };
  types.set(typeName, undefined);
  if (!schema.description) refuse(from, `${name} is an object with no description`);
  if (schema.additionalProperties !== false) refuse(from, `${name} admits properties it does not name: a message is held to its schema`);
  const required = new Set(schema.required ?? []);
  const goFields = [];
  const tsFields = [];
  for (const [property, sub] of Object.entries(schema.properties)) {
    const optional = !required.has(property);
    const type = typeOf(sub, from, `${name}${pascal(property)}`);
    const pointer = optional && !type.go.startsWith('[]') && type.go !== 'json.RawMessage';
    const description = describe(sub, from);
    const goField = `\t${pascal(property)} ${pointer ? '*' : ''}${type.go} \`json:"${property}${optional ? ',omitempty' : ''}"\``;
    goFields.push(description ? `${goComment(description, '\t')}\n${goField}` : goField);
    const tsField = `  ${property}${optional ? '?' : ''}: ${type.ts};`;
    tsFields.push(description ? `  /** ${description} */\n${tsField}` : tsField);
  }
  types.set(typeName, {
    go: `${goComment(`${typeName}: ${schema.description}`)}\ntype ${typeName} struct {\n${goFields.join('\n\n')}\n}\n`,
    ts: `/** ${schema.description} */\nexport interface ${typeName} {\n${tsFields.join('\n')}\n}\n`,
  });
  return { go: typeName, ts: typeName };
}

const named = (path) => {
  const schema = schemaAt(path);
  if (schema.type !== 'object' || !schema.title) refuse(path, 'a method or notification names a schema that is not an object with a title');
  return objectType(schema, path, schema.title).go;
};
const methods = table.methods.map((m) => ({ ...m, paramsPath: resolveIn(m.params), resultPath: resolveIn(m.result) }));
const notifications = table.notifications.map((n) => ({ ...n, paramsPath: resolveIn(n.params) }));
for (const m of methods) {
  m.paramsType = named(m.paramsPath);
  m.resultType = named(m.resultPath);
}
for (const n of notifications) n.paramsType = named(n.paramsPath);
const errorDataPath = resolveIn(table.errorData);
named(errorDataPath);
const apiVersionPath = resolveIn(table.apiVersion);
const apiVersion = schemaAt(apiVersionPath).const;
if (typeof apiVersion !== 'string') refuse(apiVersionPath, 'states no version as its const');

// ── the schemas they reach ────────────────────────────────────────────────

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
[apiVersionPath, errorDataPath, ...methods.flatMap((m) => [m.paramsPath, m.resultPath]), ...notifications.map((n) => n.paramsPath)].forEach(reach);
const schemaPaths = [...reached].sort();

// ── the control error codes ───────────────────────────────────────────────

const control = schemaAt(CODES).control;
if (!control || !Array.isArray(control.codes) || control.codes.length === 0) refuse(CODES, 'has no control group, or it lists no codes');
const codes = control.codes.map((entry) => {
  if (!/^control\.[a-z]+(-[a-z]+)*$/.test(entry.code)) refuse(CODES, `control's ${entry.code} is not control.<kebab-case>`);
  return entry;
});

// ── Go ────────────────────────────────────────────────────────────────────

/** A control code's Go constant: control.target-required is controlCodeTargetRequired. */
const goCodeName = (code) => `controlCode${code.slice('control.'.length).split('-').map(pascal).join('')}`;

const header = `// Code generated from ${TABLE} and the schemas it names — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-control.mjs
`;
const goTypes = [...types.values()].filter((t) => t.go).map((t) => t.go);
const goTypesText = `${header}
package launcher
${goTypes.some((t) => t.includes('json.RawMessage')) ? '\nimport "encoding/json"\n' : ''}
${goTypes.join('\n')}`;

const goMethod = (m) =>
  `\t{name: ${JSON.stringify(m.name)}, params: ${JSON.stringify(m.paramsPath)}, result: ${JSON.stringify(m.resultPath)}, exclusive: ${m.exclusive}, sends: []string{${m.sends.map((s) => JSON.stringify(s)).join(', ')}}},`;
const goSchemasText = `${header}
package launcher

// controlAPIVersion: the version of the control API this launcher speaks.
const controlAPIVersion = ${JSON.stringify(apiVersion)}

// controlErrorDataSchema: the schema of a failed request's error data.
const controlErrorDataSchema = ${JSON.stringify(errorDataPath)}

// controlSchemaFiles: the text of every schema a control message is read
// against, and of every schema those refer to, by its path in the repository.
var controlSchemaFiles = map[string]string{
${schemaPaths.map((p) => `\t${JSON.stringify(p)}: ${JSON.stringify(JSON.stringify(schemaAt(p)))},`).join('\n\n')}
}

// controlMethods: each method, the schemas of its params and its result,
// whether it is exclusive, and the notifications it may send besides
// progress.
var controlMethods = []controlMethod{
${methods.map(goMethod).join('\n')}
}

// controlNotifications: each notification, who sends it, and the schema of
// its params.
var controlNotifications = []controlNotification{
${notifications.map((n) => `\t{name: ${JSON.stringify(n.name)}, from: ${JSON.stringify(n.from)}, params: ${JSON.stringify(n.paramsPath)}},`).join('\n')}
}

// The control group of ${CODES}: why a request failed.
const (
${codes.map((c) => `${goComment(c.docs, '\t')}\n\t${goCodeName(c.code)} = ${JSON.stringify(c.code)}`).join('\n\n')}
)

// controlCodes: every code of the control group, in its order.
var controlCodes = []string{
${codes.map((c) => `\t${goCodeName(c.code)},`).join('\n')}
}
`;

writeOrCheck(ROOT, resolve(GO_OUT, 'control_types_gen.go'), goTypesText, CHECK);
writeOrCheck(ROOT, resolve(GO_OUT, 'control_schemas_gen.go'), goSchemasText, CHECK);

// ── TypeScript ───────────────────────────────────────────────────────────

const tsText = `// Code generated from ${TABLE} and the schemas it names — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-control.mjs

import type { DiscoveredKB } from '@semiont/core';

/** The version of the control API this client speaks. */
export const CONTROL_API_VERSION = ${JSON.stringify(apiVersion)};

${[...types.values()].map((t) => t.ts).join('\n')}
/** Each method's params and result. */
export interface ControlMethods {
${methods.map((m) => `  ${JSON.stringify(m.name)}: { params: ${m.paramsType}; result: ${m.resultType} };`).join('\n')}
}

export type ControlMethod = keyof ControlMethods;

/** Each notification the launcher sends, and its params. */
export interface ControlLauncherNotifications {
${notifications.filter((n) => n.from === 'launcher').map((n) => `  ${JSON.stringify(n.name)}: ${n.paramsType};`).join('\n')}
}

/** Each notification the client sends, and its params. */
export interface ControlClientNotifications {
${notifications.filter((n) => n.from === 'client').map((n) => `  ${JSON.stringify(n.name)}: ${n.paramsType};`).join('\n')}
}

/** Why a request failed: the control group of ${CODES}. */
export type ControlErrorCode =
${codes.map((c) => `  | ${JSON.stringify(c.code)}`).join('\n')};

/** The schema of each method's params and result, by its path in the repository. */
export const CONTROL_METHOD_SCHEMAS: { readonly [M in ControlMethod]: { readonly params: string; readonly result: string } } = {
${methods.map((m) => `  ${JSON.stringify(m.name)}: { params: ${JSON.stringify(m.paramsPath)}, result: ${JSON.stringify(m.resultPath)} },`).join('\n')}
};

/** The schema of each launcher notification's params, by its path in the repository. */
export const CONTROL_NOTIFICATION_SCHEMAS: { readonly [N in keyof ControlLauncherNotifications]: string } = {
${notifications.filter((n) => n.from === 'launcher').map((n) => `  ${JSON.stringify(n.name)}: ${JSON.stringify(n.paramsPath)},`).join('\n')}
};

/** The schema of a control error's data, by its path in the repository. */
export const CONTROL_ERROR_DATA_SCHEMA = ${JSON.stringify(errorDataPath)};

/** Every schema a control message is read against, and every one those refer to, by its path in the repository. */
export const CONTROL_SCHEMAS: { readonly [path: string]: object } = {
${schemaPaths.map((p) => `  ${JSON.stringify(p)}: ${JSON.stringify(schemaAt(p))},`).join('\n')}
};
`;

writeOrCheck(ROOT, TS_OUT, tsText, CHECK);
console.log(`methods: ${methods.length}, notifications: ${notifications.length}, types: ${types.size}, schemas: ${schemaPaths.length}, codes: ${codes.length}`);
