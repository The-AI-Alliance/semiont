// The media-type registry (specs/src/media-types/registry.json), read and
// checked once for every generator that takes it: TypeScript
// (generate-media-types.mjs) and Go (generate-media-types-go.mjs). A registry
// that cannot be meant is refused here, before anything is written from it.

import { readFileSync } from 'node:fs';

export const VOCABULARIES = ['render', 'anchoring', 'textSource'];
export const FLAGS = ['authorable', 'uploadable', 'generatable'];

/**
 * The registry at `tablePath`, checked against itself and against the
 * `SupportedMediaType` enum at `enumPath`. Exits 1, naming the fault, on a
 * table no generator may read.
 */
export function readMediaTypeTable(tablePath, enumPath) {
  function refuse(message) {
    console.error(`✗ ${tablePath}: ${message}`);
    process.exit(1);
  }

  const table = JSON.parse(readFileSync(tablePath, 'utf8'));
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
  const admitted = JSON.parse(readFileSync(enumPath, 'utf8')).enum;
  for (const mediaType of admitted) {
    if (!stated.has(mediaType)) refuse(`${mediaType} is in the SupportedMediaType schema and has no row here`);
  }
  for (const mediaType of stated) {
    if (!admitted.includes(mediaType)) refuse(`${mediaType} has a row here and is not in the SupportedMediaType schema`);
  }

  return { table, rows, aliases };
}
