#!/usr/bin/env node
// generate-media-types-go.mjs — generate the Go media-type table from
// specs/src/media-types/registry.json, the registry the TypeScript and Rust
// SDKs generate from.
//
//   packages/sdk-go/mediatypes/registry_gen.go   the rows, in the registry's
//                                                order, and its aliases
//
// Go reads the registry for one thing: the media type a file's
// extension names (`mediatypes.ForExtension`). So a row carries its media
// type and extension, and nothing no Go code reads.
//
// --check diffs without writing (the CI drift gate).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMediaTypeTable } from './media-type-table.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = resolve(ROOT, 'specs/src/media-types/registry.json');
const ENUM = resolve(ROOT, 'specs/src/components/schemas/SupportedMediaType.json');
const OUT = resolve(ROOT, 'packages/sdk-go/mediatypes/registry_gen.go');
const CHECK = process.argv.includes('--check');

const { rows, aliases } = readMediaTypeTable(TABLE, ENUM);

const go = (value) => JSON.stringify(value);
// gofmt aligns the values of a map literal's consecutive lines.
const aliasEntries = Object.entries(aliases);
const keyWidth = Math.max(...aliasEntries.map(([alias]) => go(alias).length + 1));

const text = `// Code generated from specs/src/media-types/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-media-types-go.mjs
// The TypeScript side (packages/core/src/generated/media-types.ts) and the
// Rust side (semiont::media_types) generate from the same registry.

package mediatypes

// Row is one media type a knowledge base admits, with the extension a stored
// name takes for it.
type Row struct {
	MediaType string
	Extension string
}

// Rows is the registry, in its own order: ${rows.length} media types. The order is
// read: two types that share an extension resolve, from the extension, to the
// first row that states it.
var Rows = []Row{
${rows.map((row) => `\t{MediaType: ${go(row.mediaType)}, Extension: ${go(row.extension)}},`).join('\n')}
}

// ExtensionAliases are other spellings of an extension, each with the one a
// row states.
var ExtensionAliases = map[string]string{
${aliasEntries.map(([alias, extension]) => `\t${`${go(alias)}:`.padEnd(keyWidth)} ${go(extension)},`).join('\n')}
}
`;

const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
if (current === text) {
  console.log('ok    packages/sdk-go/mediatypes/registry_gen.go');
} else {
  console.log(`${current ? 'DRIFT' : 'new  '} packages/sdk-go/mediatypes/registry_gen.go`);
  if (CHECK) process.exit(1);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
}
console.log(`media types: ${rows.length}, extension aliases: ${aliasEntries.length}`);
