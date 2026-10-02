// Generate the kinds of id from specs/src/identifiers/kinds.json and each
// kind's schema: the type of each, the question whether text is one, and the
// one constructor that makes it.
//
// Two things are written. In `types.ts`, which openapi-typescript has just
// generated, each kind's schema is given its brand, so that every property
// that refers to the kind is of that type and of no other kind's. And
// `generated/identifiers.ts` is, for each, a guard and a constructor, whose
// check is the schema's own pattern. Nothing else in TypeScript states the
// rule.
//
// Both outputs are gitignored and rebuilt by core's `generate:openapi`.
//
// `--kinds <path>`, `--schemas <dir>`, `--types <path>` and `--out <path>`
// name other inputs and outputs; the test of the refusals passes them.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const KINDS = resolve(option('--kinds') ?? resolve(ROOT, 'specs/src/identifiers/kinds.json'));
const SCHEMAS = resolve(option('--schemas') ?? resolve(ROOT, 'specs/src/components/schemas'));
const TYPES = resolve(option('--types') ?? resolve(ROOT, 'packages/core/src/types.ts'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/core/src/generated/identifiers.ts'));

function refuse(message) {
  console.error(`✗ ${KINDS}: ${message}`);
  process.exit(1);
}

const { kinds } = JSON.parse(readFileSync(KINDS, 'utf8'));
if (!Array.isArray(kinds) || kinds.length === 0) refuse('lists no kinds');

let types = readFileSync(TYPES, 'utf8');
const made = [];
for (const { schema: name } of kinds) {
  if (typeof name !== 'string' || !/^[A-Z][A-Za-z]*Id$/.test(name)) refuse(`${JSON.stringify(name)} is not a kind's name: PascalCase, ending in Id`);
  const schema = JSON.parse(readFileSync(resolve(SCHEMAS, `${name}.json`), 'utf8'));
  if (schema.type !== 'string' || typeof schema.pattern !== 'string' || typeof schema.description !== 'string') {
    refuse(`${name} is not a string with a pattern and a description`);
  }
  try {
    new RegExp(schema.pattern, 'u');
  } catch (error) {
    refuse(`${name}'s pattern is not a regular expression: ${error.message}`);
  }
  // The schema as openapi-typescript writes it, once, among the components.
  const written = new RegExp(`^( +)${name}: string;$`, 'gm');
  const found = [...types.matchAll(written)];
  if (found.length !== 1) refuse(`${TYPES} declares ${name} as a string ${found.length} times; exactly one is the schema`);
  types = types.replace(written, `$1${name}: string & { readonly __brand: "${name}" };`);
  made.push({ name, make: name[0].toLowerCase() + name.slice(1), rule: name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(), ...schema });
}

const lines = [
  '// Generated from specs/src/identifiers/kinds.json and each kind\'s schema; do not edit.',
  '//',
  '// A value of one of these types is made here and nowhere else: its guard',
  '// and its constructor hold text to the kind\'s rule, which is the schema\'s',
  '// pattern, and the type says that it passed. One kind is not assignable to',
  '// another.',
  '',
  "import type { components } from '../types';",
  '',
];
for (const { name, make, rule, description, pattern } of made) {
  lines.push(
    `/** ${description.replace(/\*\//g, '*\\/')} */`,
    `export type ${name} = components['schemas']['${name}'];`,
    '',
    `const ${rule} = new RegExp(${JSON.stringify(pattern)}, 'u');`,
    '',
    `/** Whether \`value\` is a \`${name}\`: where text enters and what is not an id is an answer, not a fault. */`,
    `export function is${name}(value: string): value is ${name} {`,
    `  return ${rule}.test(value);`,
    '}',
    '',
    `/** \`value\` as a \`${name}\`. Throws a \`TypeError\` when the kind's rule refuses it. */`,
    `export function ${make}(value: string): ${name} {`,
    `  if (!is${name}(value)) {`,
    `    throw new TypeError(\`\${JSON.stringify(value)} is not a ${name}: it does not match \${${rule}.source}\`);`,
    '  }',
    '  return value;',
    '}',
    '',
  );
}

writeFileSync(TYPES, types);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n'));
console.log(`✓ ${made.length} kinds of id: ${made.map((kind) => kind.name).join(', ')}`);
