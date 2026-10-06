#!/usr/bin/env node
// generate-oauth-clients-python.mjs — generate the Python SDK's OAuth client
// ids and the scope a sign-in asks for from specs/src/session/oauth.json, the
// file the TypeScript and Rust SDKs and the launcher generate theirs from.
//
//   packages/sdk-python/src/semiont/oauth_clients.py
//
// A knowledge base's realm registers these clients, and every SDK signs in as
// one of them, so an id restated by hand is a sign-in that fails the day the
// registration changes.
//
// --check compares without writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from './committed-source.mjs';
import { readOAuthClients } from './oauth-clients.mjs';
import { pyBanner, pyComment, pyString } from './python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = resolve(ROOT, 'specs/src/session/oauth.json');
const OUT = resolve(ROOT, 'packages/sdk-python/src/semiont/oauth_clients.py');
const CHECK = process.argv.includes('--check');

const { clients, scope } = readOAuthClients(TABLE);

/** `script` → `SCRIPT_CLIENT_ID` */
const pyName = (name) => `${name.toUpperCase()}_CLIENT_ID`;
const constant = (name, docs, value) => `${pyComment(docs)}\n${name}: Final = ${pyString(value)}\n`;

const text = `${pyBanner('specs/src/session/oauth.json', 'scripts/spec/generate-oauth-clients-python.mjs')}
"""How a Semiont client presents itself to the issuer a knowledge base trusts:
the clients its realm registers, and the scope every sign-in asks for.
"""

from typing import Final

__all__ = [
${[...clients.map(({ name }) => pyName(name)), 'SIGN_IN_SCOPE'].sort().map((name) => `    ${pyString(name)},`).join('\n')}
]

${clients.map(({ name, id, docs }) => constant(pyName(name), docs, id)).join('\n')}
${constant('SIGN_IN_SCOPE', scope.docs, scope.value)}`;

writeOrCheck(ROOT, OUT, text, CHECK);
