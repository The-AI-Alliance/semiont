#!/usr/bin/env node
// generate-sign-in-go.mjs — generate the Go SDK's entry of the sign-in store
// from specs/src/sign-in-store/SignIn.json, the schema the Rust and Python SDKs
// generate theirs from.
//
//   packages/sdk-go/signin_gen.go   the entry, and the names every entry must
//                                   state
//
// Programs in several languages read and write <stateDir>/tokens.json, so the
// entry's shape is the contract's to state. The launcher keeps its sign-ins
// through the SDK's store.
//
// The reading of the schema is sign-in-schema.mjs's, shared with the Python
// SDK's generator.
//
// --check diffs without writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goComment } from './go-source.mjs';
import { writeOrCheck } from './committed-source.mjs';
import { readSignInSchema } from './sign-in-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = resolve(ROOT, 'specs/src/sign-in-store/SignIn.json');
const OUT = resolve(ROOT, 'packages/sdk-go/signin_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${SCHEMA}: ${message}`);
  process.exit(1);
}

const schema = readSignInSchema(SCHEMA, refuse);
const { required } = schema;

const fields = schema.fields.map(({ name, description, isTime, required: must }) => {
  // An absent optional property is the zero value: "" for a string, the zero
  // time for a date-time. Neither is written.
  const omit = must ? '' : isTime ? ',omitzero' : ',omitempty';
  return {
    usesTime: isTime,
    text: [goComment(description, '\t'), `\t${name[0].toUpperCase()}${name.slice(1)} ${isTime ? 'time.Time' : 'string'} \`json:"${name}${omit}"\``].join(
      '\n',
    ),
  };
});

const lowerFirst = (text) => `${text[0].toLowerCase()}${text.slice(1)}`;
const requiredName = `${lowerFirst(schema.title)}Required`;

const text = `// Code generated from specs/src/sign-in-store/SignIn.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-sign-in-go.mjs
// The Rust (semiont::sign_in_store) and Python (semiont.sign_in) SDKs generate
// their entries from the same schema.

package semiont
${fields.some((field) => field.usesTime) ? '\nimport "time"\n' : ''}
${goComment(`${schema.title}: ${schema.description}`)}
type ${schema.title} struct {
${fields.map((field) => field.text).join('\n\n')}
}

// ${requiredName}: the properties every ${schema.title} states. A member of the
// document that lacks one is not a ${schema.title}.
var ${requiredName} = []string{${required.map((name) => JSON.stringify(name)).join(', ')}}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
console.log(`properties: ${schema.fields.length}, required: ${required.length}`);
