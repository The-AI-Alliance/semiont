#!/usr/bin/env node
// lint:spec-stack — the documents a knowledge base's repository commits, held
// to their schemas.
//
// specs/src/stack/ holds one schema for each kind of the stack (KnowledgeBase,
// KnowledgeIndex, Issuer, WorkerPool, Inference), and specs/src/kb-identity/
// the project file's (ProjectConfig). The launcher reads every document
// against these schemas, with the same cases (specs/src/stack/cases.json),
// so the schema is the one thing that decides a document's shape. It fails
// when:
//
//   - a case is not accepted or refused as it says, or is refused somewhere or
//     for a reason it does not say;
//   - a schema has no refused case, or nothing accepted against it: a schema
//     nothing is refused by holds nothing;
//   - a document of the launcher's fixture knowledge base does not validate,
//     or is of no kind a schema is for;
//   - a project file of specs/src/kb-identity/cases.json validates when its
//     case says every reader refuses it, or does not when it says none does;
//   - a property a schema names has no field of the launcher's generated types
//     (packages/go/launcher/stack/types_gen.go) tagged with its name.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CASES = resolve(ROOT, 'specs/src/stack/cases.json');
const FIXTURE = resolve(ROOT, 'packages/go/launcher/testdata/kb/.semiont');

/** Each schema a document is read against, by the name cases give it. */
const SCHEMAS = {
  KnowledgeBase: 'specs/src/stack/KnowledgeBase.json',
  KnowledgeIndex: 'specs/src/stack/KnowledgeIndex.json',
  Issuer: 'specs/src/stack/Issuer.json',
  WorkerPool: 'specs/src/stack/WorkerPool.json',
  Inference: 'specs/src/stack/Inference.json',
  ProjectConfig: 'specs/src/kb-identity/ProjectConfig.json',
};

const failures = [];
const fail = (message) => failures.push(message);

// Every schema, and every schema it refers to, under the file URL its
// relative `$ref`s resolve against. Strict, but for `required`: Runner.json
// requires properties its referrers define.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const added = new Set();
function addSchema(path) {
  if (added.has(path)) return;
  added.add(path);
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  const refs = [];
  (function collect(node) {
    if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) refs.push(value.split('#')[0]);
        else collect(value);
      }
    }
  })(schema);
  ajv.addSchema({ ...schema, $id: pathToFileURL(path).href });
  for (const ref of refs) addSchema(resolve(dirname(path), ref));
}
const validators = {};
for (const [name, path] of Object.entries(SCHEMAS)) {
  addSchema(resolve(ROOT, path));
  validators[name] = ajv.getSchema(pathToFileURL(resolve(ROOT, path)).href);
}

/** A JSON merge patch (RFC 7396) applied to `target`. */
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

const pointer = (base, key) => `${base}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

/** Each refusal Ajv gives, as the place refused and the reason the cases name. */
function refusals(errors) {
  return (errors ?? []).map((error) => {
    switch (error.keyword) {
      case 'additionalProperties':
        return { at: pointer(error.instancePath, error.params.additionalProperty), reason: 'unknown-field' };
      case 'required':
        return { at: pointer(error.instancePath, error.params.missingProperty), reason: 'missing-required' };
      case 'propertyNames':
        return { at: pointer(error.instancePath, error.params.propertyName), reason: 'not-allowed' };
      case 'type':
        return { at: error.instancePath, reason: 'wrong-type' };
      case 'oneOf':
        return { at: error.instancePath, reason: 'exactly-one' };
      default:
        return { at: error.instancePath, reason: 'not-allowed' };
    }
  });
}

function validate(schema, document) {
  const validator = validators[schema];
  if (!validator) return null;
  return validator(document) ? [] : refusals(validator.errors);
}

// ── the cases ───────────────────────────────────────────────────────────────

const { cases } = JSON.parse(readFileSync(CASES, 'utf8'));
const held = Object.fromEntries(Object.keys(SCHEMAS).map((name) => [name, { accepted: 0, refused: 0 }]));
for (const testCase of cases) {
  const label = `case "${testCase.why}"`;
  let document;
  try {
    document = testCase.document !== undefined
      ? yaml.load(testCase.document)
      : mergePatch(yaml.load(readFileSync(resolve(ROOT, testCase.base), 'utf8')), testCase.patch);
  } catch (error) {
    fail(`${label}: its document could not be read: ${error.message}`);
    continue;
  }
  const found = validate(testCase.schema, document);
  if (found === null) {
    fail(`${label}: no schema is named ${testCase.schema}`);
    continue;
  }
  if (testCase.verdict === 'accepted') {
    held[testCase.schema].accepted++;
    if (found.length > 0) fail(`${label}: refused, and says it is accepted: ${JSON.stringify(found)}`);
  } else if (testCase.verdict === 'refused') {
    held[testCase.schema].refused++;
    if (found.length === 0) fail(`${label}: accepted, and says it is refused at ${testCase.at} (${testCase.reason})`);
    else if (!found.some((r) => r.at === testCase.at && r.reason === testCase.reason)) {
      fail(`${label}: refused, but not at ${testCase.at} for ${testCase.reason}: ${JSON.stringify(found)}`);
    }
  } else {
    fail(`${label}: verdict ${JSON.stringify(testCase.verdict)} is neither accepted nor refused`);
  }
}

// ── the launcher's fixture knowledge base ──────────────────────────────────

function documents(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return documents(path);
    return name.endsWith('.yaml') ? [path] : [];
  });
}
const fixtures = [resolve(FIXTURE, 'config.yaml'), ...documents(resolve(FIXTURE, 'stack'))];
for (const path of fixtures) {
  const where = path.slice(ROOT.length + 1);
  const document = yaml.load(readFileSync(path, 'utf8'));
  const schema = path.endsWith('/config.yaml') ? 'ProjectConfig' : document?.kind;
  const found = validate(schema, document);
  if (found === null) fail(`${where}: of no kind a schema is for (${JSON.stringify(schema)})`);
  else if (found.length > 0) fail(`${where}: does not validate as ${schema}: ${JSON.stringify(found)}`);
  else held[schema].accepted++;
}

// ── the identity cases hold to the project file's schema ───────────────────

// specs/src/kb-identity/cases.json says of each project file whether every
// reader refuses it; ProjectConfig decides that, so each case's file must
// validate exactly when the case says it is not refused.
const identityCases = JSON.parse(readFileSync(resolve(ROOT, 'specs/src/kb-identity/cases.json'), 'utf8')).cases;
for (const { why, config, refused } of identityCases) {
  if (config === null) continue;
  let document;
  let parsed = true;
  try {
    document = yaml.load(config);
  } catch {
    parsed = false;
  }
  const holds = parsed && validate('ProjectConfig', document).length === 0;
  if (holds === refused) fail(`kb-identity case "${why}": its project file ${holds ? 'holds to' : 'does not hold to'} ProjectConfig, and the case says it is ${refused ? '' : 'not '}refused`);
}

// ── the launcher's types hold every property ───────────────────────────────

// An independent count, not the generator's: every property a schema of
// specs/src/stack or the project file's names has a field tagged with its name
// in the launcher's generated types. A generator that drops a property passes
// its own drift check; it does not pass this.
const types = readFileSync(resolve(ROOT, 'packages/go/launcher/stack/types_gen.go'), 'utf8');
const stackSchemas = readdirSync(resolve(ROOT, 'specs/src/stack')).filter((name) => name.endsWith('.json') && name !== 'cases.json').map((name) => `specs/src/stack/${name}`);
for (const path of [...stackSchemas, SCHEMAS.ProjectConfig]) {
  (function walk(node, where) {
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${where}/${i}`));
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'properties') {
          for (const property of Object.keys(value)) {
            if (!types.includes(`\`json:"${property}"\``) && !types.includes(`\`json:"${property},omitempty"\``)) {
              fail(`${path}${where}/properties/${property}: no field of packages/go/launcher/stack/types_gen.go is tagged with it — run: node scripts/spec/generate-stack-go.mjs`);
            }
          }
        }
        walk(value, `${where}/${key}`);
      }
    }
  })(JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')), '');
}

for (const [name, { accepted, refused }] of Object.entries(held)) {
  if (refused === 0) fail(`${name}: no case is refused against it, so it holds nothing`);
  if (accepted === 0) fail(`${name}: nothing is accepted against it`);
}

if (failures.length > 0) {
  console.error(`✗ lint:spec-stack — ${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ lint:spec-stack — ${cases.length} cases, ${identityCases.length} identity cases and ${fixtures.length} fixture documents agree with ${Object.keys(SCHEMAS).length} schemas`);
