// Generate the protocol's limits from the bundled OpenAPI spec: every
// operation's `x-semiont-limits`, and every schema property's `maxItems`.
//
// The spec states the limits a gateway enforces and a client plans around;
// an implementation reads them from here rather than restating the numbers,
// so the spec cannot change under it unnoticed. Output is gitignored and
// rebuilt by core's `prebuild`, like the validators beside it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SPEC = resolve(ROOT, 'specs/openapi.json');
const OUT_DIR = resolve(ROOT, 'packages/core/src/generated');
const OUT = resolve(OUT_DIR, 'protocol-limits.ts');

const spec = JSON.parse(readFileSync(SPEC, 'utf8'));

const operationLimits = {};
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    const limits = op?.['x-semiont-limits'];
    if (limits) operationLimits[`${method.toUpperCase()} ${path}`] = limits;
  }
}

const itemLimits = {};
for (const [name, schema] of Object.entries(spec.components.schemas)) {
  for (const [property, declared] of Object.entries(schema.properties ?? {})) {
    if (typeof declared.maxItems === 'number') itemLimits[`${name}.${property}`] = declared.maxItems;
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
// Source: specs/openapi.json → scripts/spec/generate-limits.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

/** Each operation's \`x-semiont-limits\`, by \`METHOD path\`. */
export const operationLimits = ${JSON.stringify(operationLimits, null, 2)} as const;

/** Each schema property's \`maxItems\`, by \`Schema.property\`. */
export const itemLimits = ${JSON.stringify(itemLimits, null, 2)} as const;
`,
);

console.log(`generated ${Object.keys(operationLimits).length} operations' limits and ${Object.keys(itemLimits).length} item limits → packages/core/src/generated/protocol-limits.ts`);
