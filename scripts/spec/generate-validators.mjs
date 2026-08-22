// Generate standalone Ajv validators for every schema in the bundled OpenAPI
// spec — GRAPH-ANNOTATION-CODEC P4, D8 = generate.
//
// WHY BUILD TIME. Ajv's `addSchema` does NOT compile; compilation is deferred
// to the first `validateSchema` call. A schema Ajv cannot compile therefore
// became a 500 on EVERY request through that schema, valid payloads included —
// which is how a `discriminator` added to AnnotationBody.json broke
// `POST /bus/emit` for `mark:create` (PR #1189). Compiling here moves that
// failure to the build, and retires the eager-compile test that existed only
// to catch it in CI.
//
// WHY EVERY SCHEMA, not the bus registry's `validate` set. That field masters a
// different question — which CHANNELS are enforced at emit — and it keeps doing
// exactly that at runtime. The validator's other consumer validates HTTP route
// bodies by schema name and has no registry entry at all, so generating over
// `validate` alone would silently skip every route schema. Generating all of
// them needs no selection authority and no second list to keep in sync.
//
// Output is gitignored and rebuilt by core's `prebuild`, following
// `src/types.ts` (the other large spec-derived artifact) rather than
// `bus-protocol.ts` (small, readable, committed with a --check gate). Drift is
// impossible by construction rather than gated.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SPEC = resolve(ROOT, 'specs/openapi.json');
const OUT_DIR = resolve(ROOT, 'packages/core/src/generated');
// CommonJS, deliberately. Ajv's `code.esm` option only changes the EXPORT
// syntax — `compile/codegen/scope.js` has no ESM handling, so scope values
// (ajv-formats' format table, ajv's ucs2length) are emitted as `require()`
// whatever it is set to. A `require` inside an ESM file is unbundlable:
// esbuild replaces it with a dynamic-require shim that throws at runtime, so
// the built dist failed while vitest (which runs the source) passed. As CJS
// the same requires bundle statically.
const OUT_JS = resolve(OUT_DIR, 'openapi-validators.cjs');
const OUT_DTS = resolve(OUT_DIR, 'openapi-validators.d.cts');

const BANNER = `// ⚠ GENERATED FILE — do not edit.
// Source: specs/openapi.json → scripts/spec/generate-validators.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.
`;

/**
 * OpenAPI 3.0 `nullable` → JSON Schema draft-07, which Ajv speaks.
 *
 * Two idioms, and BOTH are load-bearing — a generator missing either fails on
 * schemas that validate correctly today:
 *   - `nullable` beside a string `type` → `type: [original, 'null']`
 *   - `nullable` beside `allOf` → `anyOf: [{type:'null'}, <the rest>]`. This is
 *     3.0's only way to express a nullable `$ref` (a bare `$ref` takes no
 *     siblings), and five schemas use it.
 * Mutates in place; caller passes a deep clone.
 */
function convertNullable(obj) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return;
  if (obj.nullable === true) {
    delete obj.nullable;
    if (typeof obj.type === 'string') {
      obj.type = [obj.type, 'null'];
    } else {
      const inner = {};
      for (const key of Object.keys(obj)) {
        inner[key] = obj[key];
        delete obj[key];
      }
      obj.anyOf = [{ type: 'null' }, inner];
    }
  }
  for (const value of Object.values(obj)) {
    if (typeof value === 'object') convertNullable(value);
  }
}

const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
const schemas = spec.components?.schemas ?? {};
const names = Object.keys(schemas).sort();
if (names.length === 0) throw new Error(`No component schemas found in ${SPEC}`);

const ajv = new Ajv({
  allErrors: true,       // report every problem, not just the first
  coerceTypes: true,     // "123" → 123, as the wire has always behaved
  removeAdditional: false,
  // OpenAPI vocabulary Ajv does not know. Annotation-only, deliberately:
  // `discriminator` is a dispatch HINT and the sibling `oneOf` stays the
  // validation authority — which is also OpenAPI's own semantics for it.
  // (Ajv's `discriminator: true` option is not usable here: it rejects the
  // explicit `mapping` our discriminated unions declare.)
  keywords: ['example', 'discriminator'],
  code: { source: true },
});
addFormats(ajv);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const refs = {};
for (const name of names) {
  if (!IDENT.test(name)) {
    throw new Error(`Schema name "${name}" is not a valid JS identifier and cannot be exported`);
  }
  const key = `#/components/schemas/${name}`;
  const converted = structuredClone(schemas[name]);
  convertNullable(converted);
  try {
    ajv.addSchema(converted, key);
  } catch (error) {
    throw new Error(`Schema "${name}" could not be added: ${error.message}`);
  }
  refs[name] = key;
}

// COMPILES, one schema at a time — the build gate. Compilation pulls in every
// schema reached by `$ref`, so the name reported is the first ENTRY that
// failed, which may not be where the fault is written; the message says so
// rather than sending the reader to a file that is fine.
for (const name of names) {
  try {
    ajv.getSchema(refs[name]);
  } catch (error) {
    throw new Error(
      `Schema "${name}" does not compile: ${error.message}\n` +
        `  (compilation follows $ref, so the fault may be in a schema "${name}" references)`,
    );
  }
}

const code = standaloneCode(ajv, refs);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_JS, BANNER + code);
// Typed against the SAME `components['schemas']` that openapi-typescript emits
// from the SAME bundle, so a validator and the type it guards cannot disagree —
// and `validators.Typo` is a compile error rather than an undefined at runtime.
writeFileSync(
  OUT_DTS,
  BANNER +
    `import type { ValidateFunction } from 'ajv';\n` +
    `import type { components } from '../types.js';\n\n` +
    names
      .map((n) => `export declare const ${n}: ValidateFunction<components['schemas']['${n}']>;`)
      .join('\n') +
    `\n`,
);

console.log(`generated ${names.length} validators → packages/core/src/generated/openapi-validators.cjs`);
