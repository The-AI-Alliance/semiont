// Generate the locale table from specs/src/locales/registry.json: the languages
// Semiont supports, and what each is called.
//
// The registry is the authority. The interface is read in one of its languages
// and a resource is written in one of them, so the frontend and the workers
// that tell a model what language a text is in both read this one table.
// A registry that cannot be meant is refused before anything is written from
// it. Output is gitignored and rebuilt by core's `prebuild`.
//
// `--table <path>` and `--out <path>` name another registry and another
// output; the test of the refusals passes them.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'specs/src/locales/registry.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/core/src/generated/locales.ts'));

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const NAMES = ['nativeName', 'englishName'];
const READ = new Set(['code', ...NAMES]);

const rows = JSON.parse(readFileSync(TABLE, 'utf8')).locales;
if (!Array.isArray(rows) || rows.length === 0) refuse('the registry states no languages');

const seen = new Set();
for (const row of rows) {
  const { code } = row;
  if (typeof code !== 'string' || !/^[a-z]{2,3}$/.test(code)) refuse(`${code} is not a lower-case language code`);
  if (seen.has(code)) refuse(`${code} is stated twice`);
  seen.add(code);
  for (const name of NAMES) {
    if (typeof row[name] !== 'string' || row[name] === '') refuse(`${code} states no ${name}`);
  }
  for (const key of Object.keys(row)) {
    if (!READ.has(key)) refuse(`${code} states ${key}, which nothing reads`);
  }
}

const text = (value) => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
//
// Source:    specs/src/locales/registry.json (the AUTHORITY)
// Generator: scripts/spec/generate-locales.mjs
// Regen:     npm run generate:locales --workspace=@semiont/core

/** The code of every supported language, in the registry's order. */
export const LOCALE_CODES = [${rows.map((row) => text(row.code)).join(', ')}] as const;

/** The code of a supported language. */
export type LocaleCode = (typeof LOCALE_CODES)[number];

/** A supported language: its code, what it calls itself, and its name in English. */
export interface LocaleInfo {
  code: LocaleCode;
  nativeName: string;
  englishName: string;
}

/** A row per supported language, in the registry's order. */
export const LOCALES: readonly LocaleInfo[] = [
${rows.map((row) => `  { code: ${text(row.code)}, nativeName: ${text(row.nativeName)}, englishName: ${text(row.englishName)} },`).join('\n')}
];
`,
);
console.log(`generated ${rows.length} locales → ${OUT}`);
