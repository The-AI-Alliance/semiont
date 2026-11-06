// Generate what the TypeScript SDK's sign-in store holds of the contract
// (protocol/specs/src/sign-in-store):
//
//   packages/typescript/core/src/generated/sign-in.ts
//
// - one entry of tokens.json, and its guard, from SignIn.json;
// - the modes and the access list a writer keeps the directory and its files
//   to, from owner-only.json;
// - the document's name, its lock's, and the byte of the lock that is locked
//   on Windows, from README.md, as the C# SDK's generator reads them.
//
// The store hands each value to its caller's files, so no caller restates
// one. The reading of the schema is sign-in-schema.mjs's, and of the
// owner-only file owner-only.mjs's. Output is gitignored and rebuilt by
// core's `prebuild`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOwnerOnly } from './owner-only.mjs';
import { readSignInSchema } from './sign-in-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SPECS = resolve(ROOT, 'protocol/specs/src/sign-in-store');
const SCHEMA = resolve(SPECS, 'SignIn.json');
const CONTRACT = resolve(SPECS, 'README.md');
const OUT = resolve(ROOT, 'packages/typescript/core/src/generated/sign-in.ts');

const refuse = (path) => (message) => {
  console.error(`✗ ${path}: ${message}`);
  process.exit(1);
};

const schema = readSignInSchema(SCHEMA, refuse(SCHEMA));
const { directoryMode, fileMode, accessList } = readOwnerOnly(resolve(SPECS, 'owner-only.json'));

const contract = readFileSync(CONTRACT, 'utf8');
/** The one thing `pattern` matches in the contract, or exit 1 saying what was not found. */
const stated = (what, pattern) => {
  const found = [...contract.matchAll(new RegExp(pattern, 'g'))].map((match) => match[1]);
  const distinct = [...new Set(found)];
  if (distinct.length !== 1) refuse(CONTRACT)(`states ${distinct.length === 0 ? 'no' : 'more than one'} ${what} (${pattern})`);
  return distinct[0];
};
const documentName = stated('document name', '<stateDir>/([a-z-]+\\.json)');
const lockName = stated('lock name', '<stateDir>/([a-z-]+\\.lock)');
const offsetHigh = stated('Windows lock offset', 'OffsetHigh:\\s*(0x[0-9A-Fa-f]+)');

const doc = (text, indent = '') => `${indent}/** ${text.replaceAll('*/', '*\\/')} */`;

const field = ({ name, description, required }) => `${doc(description, '  ')}\n  ${name}${required ? '' : '?'}: string;`;
const check = ({ name, required }) =>
  required ? `isString(value[${JSON.stringify(name)}])` : `(value[${JSON.stringify(name)}] === undefined || isString(value[${JSON.stringify(name)}]))`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
// Source: protocol/specs/src/sign-in-store (SignIn.json, owner-only.json, README.md) → packages/codegen/schemas/generate-sign-in.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

import { isObject, isString } from '../type-guards';

${doc(schema.description)}
export interface ${schema.title} {
${schema.fields.map(field).join('\n')}
}

/** Whether \`value\` is a ${schema.title}: what it requires is there, and every member it has is text. */
export function is${schema.title}(value: unknown): value is ${schema.title} {
  return isObject(value)
    && ${schema.fields.map(check).join('\n    && ')};
}

${doc(directoryMode.docs)}
export const OWNER_ONLY_DIRECTORY_MODE = 0o${directoryMode.octal};

${doc(fileMode.docs)}
export const OWNER_ONLY_FILE_MODE = 0o${fileMode.octal};

${doc(accessList.docs)}
export function ownerOnlyAccessList(owner: string): string {
  return ${JSON.stringify(accessList.before)} + owner + ${JSON.stringify(accessList.after)};
}

/** The document's name in the state home: one sign-in per stack. */
export const SIGN_IN_STORE_FILE = ${JSON.stringify(documentName)};

/** The name, beside the document, of the file every writer locks from before its read until after its rename. */
export const SIGN_IN_STORE_LOCK = ${JSON.stringify(lockName)};

/** On Windows, the high 32 bits of the offset of the one byte of the lock file that is locked: far past anything the file holds. */
export const SIGN_IN_STORE_WINDOWS_OFFSET_HIGH = ${offsetHigh};
`,
);

console.log(`generated the sign-in store's entry, modes, access list and names → ${OUT}`);
