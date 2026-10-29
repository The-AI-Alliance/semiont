#!/usr/bin/env node
// Generate the Go SDK's kinds of id from specs/src/identifiers/kinds.json and
// each kind's schema: a type of its own for each, made only through the kind's
// rule, in the package of the wire types that carry it.
//
//   packages/go/sdk/api/ids_gen.go
//
// oapi-codegen writes the rest of package api, and would write each kind as
// an alias of string, which any text converts to. So the kinds are named in
// its config's `exclude-schemas`, and this generator writes them instead: the
// wire types still refer to each by its schema's name, and find this file's
// type there. That list restates the table, so it is held to it here: a kind
// it leaves out, or a name it has that is no kind, fails the generator and its
// `--check`.
//
// The reading of the table is identifier-kinds.mjs's, shared with the
// TypeScript and Python generators. The output is committed; `--check`
// compares without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIdentifierKinds } from './identifier-kinds.mjs';
import { writeOrCheck } from './committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const KINDS = resolve(ROOT, 'specs/src/identifiers/kinds.json');
const SCHEMAS = resolve(ROOT, 'specs/src/components/schemas');
const CONFIG = resolve(ROOT, 'packages/go/sdk/oapi-codegen.yaml');
const OUT = resolve(ROOT, 'packages/go/sdk/api/ids_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const kinds = readIdentifierKinds(KINDS, SCHEMAS, (message) => refuse(`${KINDS}: ${message}`));

// The config's `exclude-schemas` list, read as the config writes it: one
// `- Name` per line under the key.
const config = readFileSync(CONFIG, 'utf8');
const block = /^ {2}exclude-schemas:\n((?: {4}- .+\n)+)/m.exec(config);
if (block === null) refuse(`${CONFIG} names no exclude-schemas under output-options, so oapi-codegen would write each kind of id as a string`);
const excluded = block[1].trim().split('\n').map((line) => line.replace(/^\s*- /, '').trim());
const named = kinds.map(({ name }) => name);
const missing = named.filter((name) => !excluded.includes(name));
const stray = excluded.filter((name) => !named.includes(name));
if (missing.length > 0) refuse(`${CONFIG}: exclude-schemas leaves out ${missing.join(', ')}, a kind of id in ${KINDS}`);
if (stray.length > 0) refuse(`${CONFIG}: exclude-schemas names ${stray.join(', ')}, which is no kind of id in ${KINDS}`);

/** `text` as Go line comments, wrapped at 78 columns. */
function comment(text, indent = '') {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line !== '' && indent.length + 3 + line.length + 1 + word.length > 78) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => `${indent}// ${l}`).join('\n');
}

const lower = (name) => name[0].toLowerCase() + name.slice(1);

const types = kinds.map(({ name, description, pattern }) => {
  const rule = `${lower(name)}Rule`;
  const patternName = `${lower(name)}Pattern`;
  return `${comment(description)}
//
// It is made only by Parse${name}, which holds text to the kind's rule, and
// by decoding, which goes through the same rule. Its zero value is no id: it
// is refused wherever an id is written, and IsZero names it.
type ${name} struct{ text string }

const ${patternName} = ${JSON.stringify(pattern)}

var ${rule} = regexp.MustCompile(${patternName})

// Parse${name} is text as a ${name}, or an *InvalidIdentifierError when the
// kind's rule refuses it.
func Parse${name}(text string) (${name}, error) {
	if !${rule}.MatchString(text) {
		return ${name}{}, &InvalidIdentifierError{Kind: ${JSON.stringify(name)}, Pattern: ${patternName}, Value: text}
	}
	return ${name}{text: text}, nil
}

// String is the id's text.
func (id ${name}) String() string { return id.text }

// IsZero reports whether id is the zero value, which is no id.
func (id ${name}) IsZero() bool { return id.text == "" }

// MarshalText is the id's text. The zero value is refused, as the rule refuses
// empty text.
func (id ${name}) MarshalText() ([]byte, error) {
	if id.text == "" {
		return nil, &InvalidIdentifierError{Kind: ${JSON.stringify(name)}, Pattern: ${patternName}, Value: ""}
	}
	return []byte(id.text), nil
}

// UnmarshalText holds decoded text to the kind's rule.
func (id *${name}) UnmarshalText(text []byte) error {
	parsed, err := Parse${name}(string(text))
	if err != nil {
		return err
	}
	*id = parsed
	return nil
}
`;
});

const text = `// Code generated from specs/src/identifiers/kinds.json and each kind's schema — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-identifiers-go.mjs
// The TypeScript and Python kinds are generated from the same table, and Rust's
// by its SDK's build script.

package api

import (
	"fmt"
	"regexp"
)

// InvalidIdentifierError is text that is not an id of the kind it was to be.
type InvalidIdentifierError struct {
	// Kind is the kind of id the text was to be, as its schema is named.
	Kind string
	// Pattern is the kind's rule, as its schema states it.
	Pattern string
	// Value is the text the rule refused.
	Value string
}

func (e *InvalidIdentifierError) Error() string {
	return fmt.Sprintf("%q is not a %s: it does not match %s", e.Value, e.Kind, e.Pattern)
}

${types.join('\n')}`;

writeOrCheck(ROOT, OUT, text, CHECK);
