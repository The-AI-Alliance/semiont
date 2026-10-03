// Generate the OAuth client ids and the scope a Semiont client signs in with
// from specs/src/session/oauth.json.
//
// The realm registers the clients, so an id is not this code's to choose: it
// is stated once, and every SDK generates it. Output is gitignored and
// rebuilt by core's `prebuild`.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOAuthClients } from './oauth-clients.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const TABLE = resolve(ROOT, 'specs/src/session/oauth.json');
const OUT = resolve(ROOT, 'packages/core/src/generated/oauth-clients.ts');

const { clients, scope } = readOAuthClients(TABLE);

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
