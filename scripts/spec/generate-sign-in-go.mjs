#!/usr/bin/env node
// generate-sign-in-go.mjs — generate the launcher's entry of the sign-in store
// from specs/src/sign-in-store/SignIn.json, the schema the Rust SDK generates
// its own from.
//
//   apps/launcher/internal/launcher/sign_in_gen.go   the entry, and the names
//                                                    every entry must state
//
// The launcher and an application on the Rust SDK both read and write
// <stateDir>/tokens.json, so the entry's shape is the contract's to state.
//
// The schema is flat: every property is a string, some of them a date-time.
// Anything else is refused here, by name, rather than rendered as a guess.
//
// --check diffs without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goComment } from './go-source.mjs';
import { writeOrCheck } from './committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = resolve(ROOT, 'specs/src/sign-in-store/SignIn.json');
const OUT = resolve(ROOT, 'apps/launcher/internal/launcher/sign_in_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${SCHEMA}: ${message}`);
  process.exit(1);
}

const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
const stated = (value) => typeof value === 'string' && value !== '';

for (const keyword of Object.keys(schema)) {
  if (!['title', 'type', 'description', 'properties', 'required'].includes(keyword)) {
    refuse(`uses \`${keyword}\`, which this generator does not render`);
  }
}
if (schema.type !== 'object') refuse('is not an object schema');
if (!stated(schema.title) || !/^[A-Z][A-Za-z]*$/.test(schema.title)) refuse('has no title that names a Go type');
if (!stated(schema.description)) refuse('has no description');
const properties = Object.entries(schema.properties ?? {});
if (properties.length === 0) refuse('states no properties');
const required = schema.required ?? [];
if (!Array.isArray(required) || required.length === 0) refuse('requires nothing');
for (const name of required) {
  if (!Object.hasOwn(schema.properties, name)) refuse(`requires \`${name}\`, which is not a property`);
}

const fields = properties.map(([name, property]) => {
  if (!/^[a-z][A-Za-z]*$/.test(name)) refuse(`\`${name}\` is not a camelCase property name`);
  for (const keyword of Object.keys(property)) {
    if (!['type', 'format', 'description'].includes(keyword)) {
      refuse(`\`${name}\` uses \`${keyword}\`, which this generator does not render`);
    }
  }
  if (property.type !== 'string') refuse(`\`${name}\` is not a string`);
  if (property.format !== undefined && property.format !== 'date-time') {
    refuse(`\`${name}\` has the format ${JSON.stringify(property.format)}; only date-time is rendered`);
  }
  if (!stated(property.description)) refuse(`\`${name}\` has no description`);
  const isTime = property.format === 'date-time';
  // An absent optional property is the zero value: "" for a string, the zero
  // time for a date-time. Neither is written.
  const omit = required.includes(name) ? '' : isTime ? ',omitzero' : ',omitempty';
  return {
    usesTime: isTime,
    text: [
      goComment(property.description, '\t'),
      `\t${name[0].toUpperCase()}${name.slice(1)} ${isTime ? 'time.Time' : 'string'} \`json:"${name}${omit}"\``,
    ].join('\n'),
  };
});

const lowerFirst = (text) => `${text[0].toLowerCase()}${text.slice(1)}`;
const requiredName = `${lowerFirst(schema.title)}Required`;

const text = `// Code generated from specs/src/sign-in-store/SignIn.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-sign-in-go.mjs
// The Rust side (semiont::sign_in_store) generates its entry from the same
// schema.

package launcher
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
console.log(`properties: ${properties.length}, required: ${required.length}`);
