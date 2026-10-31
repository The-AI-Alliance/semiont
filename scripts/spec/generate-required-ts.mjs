// Generate what each component schema requires of a value, as the TypeScript
// SDK's reply checks read it (packages/typescript/core/src/required.ts):
//
//   packages/typescript/core/src/generated/required-schemas.ts
//
// The reading of the schemas, and the rules a shape states, are
// required-members.mjs's, shared with Go's generator. The table is typed by
// the schemas openapi-typescript writes (src/types.ts), so one it leaves out,
// or a name that is no schema, fails to compile. Output is gitignored and
// rebuilt by core's `prebuild`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredMembers } from './required-members.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'packages/typescript/core/src/generated/required-schemas.ts');

const { names, shapes } = readRequiredMembers(ROOT, (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
// Source: the component schemas of specs/src/openapi.json → scripts/spec/generate-required-ts.mjs,
// by the rules of scripts/spec/required-members.mjs.
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

import type { Shape } from '../required';
import type { components } from '../types';

/** What each component schema requires of a value, as far as its members go, by its name. */
export const REQUIRED_SCHEMAS: { readonly [Name in keyof components['schemas']]: Shape } = {
${names.map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(shapes.get(name))},`).join('\n')}
};
`,
);

console.log(`generated what ${names.length} schemas require → ${OUT}`);
