// Generate the media-type registry from specs/src/media-types/registry.json:
// the types a knowledge base admits, and what the system can do with each.
//
// The table is the authority every SDK generates from. Restated in one
// language, it was something no other could derive: the Rust client had no
// way to say which format a clone takes. Output is gitignored and rebuilt by
// core's `prebuild`.
//
// `--table <path>`, `--enum <path>` and `--out <path>` name another table,
// another enum and another output; the test of the refusals passes them.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMediaTypeTable, VOCABULARIES, FLAGS } from './media-type-table.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'specs/src/media-types/registry.json'));
const ENUM = resolve(option('--enum') ?? resolve(ROOT, 'specs/src/components/schemas/SupportedMediaType.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/core/src/generated/media-types.ts'));

const { table, rows, aliases } = readMediaTypeTable(TABLE, ENUM);

const text = (value) => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const union = (words) => words.map(text).join(' | ');
const typeName = { render: 'RenderMode', anchoring: 'AnchoringModel', textSource: 'TextSource' };

const lines = rows.map(
  (row) =>
    `  ${text(row.mediaType)}: { extension: ${text(row.extension)}, label: ${text(row.label)}, ` +
    `${VOCABULARIES.map((v) => `${v}: ${text(row[v])}`).join(', ')}, ` +
    `${FLAGS.map((f) => `${f}: ${row[f]}`).join(', ')} },`,
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
//
// Source:    specs/src/media-types/registry.json (the AUTHORITY)
// Generator: scripts/spec/generate-media-types.mjs
// Regen:     npm run generate:media-types --workspace=@semiont/core

${VOCABULARIES.map((v) => `export type ${typeName[v]} = ${union(table[v])};`).join('\n')}

/** A row of the registry, by media type, in the registry's order. */
export const MEDIA_TYPE_ROWS = {
${lines.join('\n')}
} as const;

/** Other spellings of an extension, each with the one a row states. */
export const EXTENSION_ALIASES: Readonly<Record<string, string>> = {
${Object.entries(aliases).map(([alias, extension]) => `  ${text(alias)}: ${text(extension)},`).join('\n')}
};
`,
);
console.log(`generated ${rows.length} media types → ${OUT}`);
