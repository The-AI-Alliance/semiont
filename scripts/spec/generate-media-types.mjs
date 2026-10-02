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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'specs/src/media-types/registry.json'));
const ENUM = resolve(option('--enum') ?? resolve(ROOT, 'specs/src/components/schemas/SupportedMediaType.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/core/src/generated/media-types.ts'));

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const table = JSON.parse(readFileSync(TABLE, 'utf8'));
const VOCABULARIES = ['render', 'anchoring', 'textSource'];
const FLAGS = ['authorable', 'uploadable', 'generatable'];
for (const vocabulary of VOCABULARIES) {
  const words = table[vocabulary];
  if (!Array.isArray(words) || words.length === 0 || words.some((word) => typeof word !== 'string' || word === '')) {
    refuse(`${vocabulary} lists no words`);
  }
  if (new Set(words).size !== words.length) refuse(`${vocabulary} states a word twice`);
}

const rows = table.mediaTypes;
if (!Array.isArray(rows) || rows.length === 0) refuse('lists no media types');
const stated = new Set();
for (const row of rows) {
  const { mediaType, extension, label } = row;
  if (typeof mediaType !== 'string' || mediaType === '') refuse(`a row names no media type: ${JSON.stringify(row)}`);
  if (mediaType !== mediaType.toLowerCase() || mediaType.includes(';')) {
    refuse(`${mediaType} is not a base media type: lower case, and no parameters`);
  }
  if (stated.has(mediaType)) refuse(`${mediaType} is stated twice`);
  stated.add(mediaType);
  if (typeof extension !== 'string' || !/^\.[a-z0-9]+$/.test(extension)) {
    refuse(`${mediaType}'s extension is ${JSON.stringify(extension)}: a dot, then lower-case letters and digits`);
  }
  if (typeof label !== 'string' || label === '') refuse(`${mediaType} has no label`);
  for (const vocabulary of VOCABULARIES) {
    if (!table[vocabulary].includes(row[vocabulary])) {
      refuse(`${mediaType}'s ${vocabulary} is ${JSON.stringify(row[vocabulary])}, which is none of ${table[vocabulary].join(', ')}`);
    }
  }
  for (const flag of FLAGS) {
    if (typeof row[flag] !== 'boolean') refuse(`${mediaType} does not say whether it is ${flag}`);
  }
  const unknown = Object.keys(row).filter((key) => !['mediaType', 'extension', 'label', ...VOCABULARIES, ...FLAGS].includes(key));
  if (unknown.length > 0) refuse(`${mediaType} states ${unknown.join(', ')}, which no generator reads`);
}

const aliases = table.extensionAliases;
if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) refuse('extensionAliases is not a table');
const extensions = new Set(rows.map((row) => row.extension));
for (const [alias, extension] of Object.entries(aliases)) {
  if (!/^\.[a-z0-9]+$/.test(alias)) refuse(`the alias ${JSON.stringify(alias)} is not a dot, then lower-case letters and digits`);
  if (extensions.has(alias)) refuse(`${alias} is an alias and a row's own extension: it would never be read as ${extension}`);
  if (!extensions.has(extension)) refuse(`${alias} is read as ${JSON.stringify(extension)}, which no row states`);
}

// The enum and the registry are one list, stated in two places for what each
// is read by. Neither may have a member the other lacks.
const admitted = JSON.parse(readFileSync(ENUM, 'utf8')).enum;
for (const mediaType of admitted) {
  if (!stated.has(mediaType)) refuse(`${mediaType} is in the SupportedMediaType schema and has no row here`);
}
for (const mediaType of stated) {
  if (!admitted.includes(mediaType)) refuse(`${mediaType} has a row here and is not in the SupportedMediaType schema`);
}

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
