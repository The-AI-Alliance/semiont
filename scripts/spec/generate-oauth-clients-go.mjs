#!/usr/bin/env node
// generate-oauth-clients-go.mjs — generate the launcher's OAuth client ids and
// the scope a sign-in asks for from specs/src/session/oauth.json, the file the
// TypeScript and Rust SDKs generate theirs from.
//
//   apps/launcher/internal/launcher/oauth_clients_gen.go
//
// The launcher registers these clients in a knowledge base's realm and signs
// in as one of them, so an id restated by hand is a sign-in that fails the day
// the registration changes.
//
// --check diffs without writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOAuthClients } from './oauth-clients.mjs';
import { goComment } from './go-source.mjs';
import { writeOrCheck } from './committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = resolve(ROOT, 'specs/src/session/oauth.json');
const OUT = resolve(ROOT, 'apps/launcher/internal/launcher/oauth_clients_gen.go');
const CHECK = process.argv.includes('--check');

const { clients, scope } = readOAuthClients(TABLE);

/** `script` → `ScriptClientID` */
const goName = (name) => `${name[0].toUpperCase()}${name.slice(1)}ClientID`;

const constant = (name, docs, value) => `${goComment(`${name}: ${docs}`)}\nconst ${name} = ${JSON.stringify(value)}\n`;

const text = `// Code generated from specs/src/session/oauth.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-oauth-clients-go.mjs
// The TypeScript side (packages/core/src/generated/oauth-clients.ts) and the
// Rust side (packages/sdk-rust/build.rs) generate from the same file.

package launcher

${clients.map(({ name, id, docs }) => constant(goName(name), docs, id)).join('\n')}
${constant('SignInScope', scope.docs, scope.value)}`;

writeOrCheck(ROOT, OUT, text, CHECK);
console.log(`clients: ${clients.length}, and the sign-in scope`);
