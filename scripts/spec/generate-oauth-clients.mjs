// Generate the OAuth client ids and the scope a Semiont client signs in with
// from specs/src/session/oauth.json.
//
// The realm registers the clients, so an id is not this code's to choose: it
// is stated once, and every SDK generates it. Output is gitignored and
// rebuilt by core's `prebuild`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const TABLE = resolve(ROOT, 'specs/src/session/oauth.json');
const OUT = resolve(ROOT, 'packages/core/src/generated/oauth-clients.ts');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const { clients, scope } = JSON.parse(readFileSync(TABLE, 'utf8'));
if (!Array.isArray(clients) || clients.length === 0) refuse('lists no clients');
const stated = (value) => typeof value === 'string' && value !== '';
const seen = new Set();
for (const { name, id, docs } of clients) {
  if (!stated(name) || !/^[a-z][a-z]*$/.test(name)) refuse(`${JSON.stringify(name)} is not a client's name: lowercase letters`);
  if (seen.has(name)) refuse(`the client ${name} is stated twice`);
  seen.add(name);
  if (!stated(id)) refuse(`the client ${name} has no id`);
  if (!stated(docs)) refuse(`the client ${name} has no docs`);
}
if (!scope || !stated(scope.value) || !stated(scope.docs)) refuse('states no scope, or one with no docs');

const doc = (text) => `/** ${text.replaceAll('*/', '*\\/')} */`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
// Source: specs/src/session/oauth.json → scripts/spec/generate-oauth-clients.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

${clients.map(({ name, id, docs }) => `${doc(docs)}\nexport const ${name.toUpperCase()}_CLIENT_ID = ${JSON.stringify(id)};\n`).join('\n')}
${doc(scope.docs)}
export const SIGN_IN_SCOPE = ${JSON.stringify(scope.value)};
`,
);

console.log(`generated ${clients.length} OAuth client ids and the sign-in scope → ${OUT}`);
