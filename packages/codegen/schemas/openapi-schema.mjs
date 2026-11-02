// openapi-schema.mjs — the spec's component schemas as standard JSON Schema.
//
// The components (specs/src/components/schemas) are OpenAPI 3.0 schemas, and
// one of 3.0's keywords means something JSON Schema has no keyword for:
// `nullable`. Every generator that reads a component as JSON Schema
// translates it here, in one place:
//
//   - packages/codegen/schemas/generate-validators.mjs, TypeScript's validators (draft-07,
//     through the bundled spec)
//   - packages/codegen/schemas/generate-mcp-tools-go.mjs, the launcher's MCP tools
//     (2020-12, each tool's schema self-contained)
//   - packages/codegen/schemas/required-members.mjs, what each component requires of a
//     value, which Go's and TypeScript's reply checks are generated from
//
// `discriminator` is left as it is written: a dispatch hint beside the `oneOf`
// that decides, which is OpenAPI's own meaning for it, and a keyword a JSON
// Schema validator does not know.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const COMPONENTS = 'specs/src/components/schemas';

/**
 * OpenAPI 3.0 `nullable` → JSON Schema.
 *
 * Two idioms, and BOTH are load-bearing — a generator missing either fails on
 * valid schemas:
 *   - `nullable` beside a string `type` → `type: [original, 'null']`
 *   - `nullable` beside `allOf` → `anyOf: [{type:'null'}, <the rest>]`. This is
 *     3.0's only way to express a nullable `$ref` (a bare `$ref` takes no
 *     siblings).
 * Mutates in place; caller passes a deep clone.
 */
export function convertNullable(obj) {
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

/** `schema` as standard JSON Schema: a deep copy, its `nullable` translated. */
export function translated(schema) {
  const copy = structuredClone(schema);
  convertNullable(copy);
  return copy;
}

/** A component schema by name, as it is written in specs/src/components/schemas. */
export function component(root, name) {
  return JSON.parse(readFileSync(resolve(root, COMPONENTS, `${name}.json`), 'utf8'));
}

/** The component a reference between components names: `./Name.json` or `Name.json`. */
function referred(ref) {
  const named = ref.match(/^(?:\.\/)?([A-Za-z0-9]+)\.json$/);
  if (!named) throw new Error(`a reference between components that names no component file: ${ref}`);
  return named[1];
}

/**
 * `schema` (written among the components) made self-contained: every
 * component it reaches, translated, under `$defs` by its name, and every
 * reference to one — a `$ref`, and a `discriminator`'s mapping — rewritten to
 * `#/$defs/<Name>`. The result is a deep copy; `schema` is not changed.
 */
export function selfContained(root, schema) {
  const defs = {};
  const seen = new Set();
  const pending = [];
  const reach = (ref) => {
    const name = referred(ref);
    if (!seen.has(name)) {
      seen.add(name);
      pending.push(name);
    }
    return `#/$defs/${name}`;
  };
  const rewrite = (node) => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === '$ref' && typeof value === 'string' ? reach(value) : rewrite(value);
    }
    if (out.discriminator?.mapping) {
      const mapping = {};
      for (const [tag, ref] of Object.entries(out.discriminator.mapping)) mapping[tag] = reach(ref);
      out.discriminator = { ...out.discriminator, mapping };
    }
    return out;
  };
  const result = rewrite(translated(schema));
  while (pending.length > 0) {
    const name = pending.shift();
    defs[name] = rewrite(translated(component(root, name)));
  }
  const sorted = Object.fromEntries(Object.keys(defs).sort().map((name) => [name, defs[name]]));
  return Object.keys(sorted).length === 0 ? result : { ...result, $defs: sorted };
}
