// oauth-clients.mjs — read and check specs/src/session/oauth.json: the client
// ids a Semiont client signs in as, and the scope a sign-in asks for.
//
// One place for the checks, shared by every generator that reads the file
// (generate-oauth-clients.mjs for TypeScript, generate-oauth-clients-go.mjs
// for the launcher), so no generated artifact comes from a file the others
// would refuse.

import { readFileSync } from 'node:fs';

/** The clients and the scope, or exit 1 saying what is wrong with the file. */
export function readOAuthClients(tablePath) {
  const refuse = (message) => {
    console.error(`✗ ${tablePath}: ${message}`);
    process.exit(1);
  };

  const { clients, scope } = JSON.parse(readFileSync(tablePath, 'utf8'));
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
  return { clients, scope };
}
