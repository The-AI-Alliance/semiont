#!/usr/bin/env node
// Generate the Go SDK's failure vocabularies from specs/src/errors/codes.json:
// a named type per vocabulary with a constant per code, the bus code a wire
// code becomes, and the transport code an HTTP status becomes.
//
//   packages/go/sdk/errorcodes_gen.go
//
// The reading of the table, and its check against the wire's own vocabulary
// (CommandError.code), are error-codes-table.mjs's, shared with the
// TypeScript and Python generators; Rust's build script reads the same table.
// The output is committed; `--check` compares without writing (the CI drift
// gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readErrorCodes } from './error-codes-table.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = resolve(ROOT, 'specs/src/errors/codes.json');
const COMMAND_ERROR = resolve(ROOT, 'specs/src/components/schemas/CommandError.json');
const OUT = resolve(ROOT, 'packages/go/sdk/errorcodes_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const { table, busCodes, unrecognized, transportCodes, unclassified, jobCodes, sessionCodes, signInCodes, kbIdentityCodes, spanRefusalCodes } =
  readErrorCodes(TABLE, COMMAND_ERROR, refuse);

/** `text` as Go line comments, wrapped at 78 columns. */
function comment(text, indent = '') {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
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

const pascal = (kebab) => kebab.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
/** A code's constant: its type's name, then the code's last segment (`bus.not-found` is `NotFound`). */
const constant = (type, code) => `${type}${pascal(code.split('.').at(-1))}`;

/** One vocabulary: the type and a constant per code, in the table's order. */
function vocabulary(type, docs, codes) {
  // Every constant has its comment above it, and gofmt aligns no constant
  // across a comment: each is written as gofmt leaves it.
  const constants = codes
    .map(({ code, docs: codeDocs }) => `${comment(codeDocs, '\t')}\n\t${constant(type, code)} ${type} = ${JSON.stringify(code)}`)
    .join('\n');
  return `${comment(docs)}
type ${type} string

const (
${constants}
)
`;
}

const busWire = busCodes.filter((entry) => entry.wire !== undefined);
const exact = transportCodes.filter((entry) => entry.status !== undefined);
const from = transportCodes.filter((entry) => entry.statusFrom !== undefined).sort((a, b) => b.statusFrom - a.statusFrom);

const text = `// Code generated from specs/src/errors/codes.json — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-error-codes-go.mjs
// The TypeScript and Python vocabularies are generated from the same table,
// and Rust's by its SDK's build script.

package semiont

import "github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

${vocabulary('BusRequestErrorCode', table.busRequest.docs, busCodes)}
// BusRequestErrorCodeOfWire is the code a failure's own code
// (CommandError.code) becomes. A failure that states none, or one this
// vocabulary does not name, is ${constant('BusRequestErrorCode', unrecognized.code)}.
func BusRequestErrorCodeOfWire(code *api.CommandErrorCode) BusRequestErrorCode {
	if code == nil {
		return ${constant('BusRequestErrorCode', unrecognized.code)}
	}
	switch *code {
${busWire.map((entry) => `\tcase api.CommandErrorCode${pascal(entry.wire)}:\n\t\treturn ${constant('BusRequestErrorCode', entry.code)}`).join('\n')}
	default:
		return ${constant('BusRequestErrorCode', unrecognized.code)}
	}
}

// Wire is the wire code a peer stated, when this code restates one: what a
// service answers its own caller with. A failure only this side knows states
// none, and ok is false.
func (c BusRequestErrorCode) Wire() (code api.CommandErrorCode, ok bool) {
	switch c {
${busWire.map((entry) => `\tcase ${constant('BusRequestErrorCode', entry.code)}:\n\t\treturn api.CommandErrorCode${pascal(entry.wire)}, true`).join('\n')}
	default:
		return "", false
	}
}

${vocabulary('TransportErrorCode', table.transport.docs, transportCodes)}
// TransportErrorCodeOfStatus is the code an HTTP status becomes.
func TransportErrorCodeOfStatus(status int) TransportErrorCode {
	switch {
${exact.map((entry) => `\tcase status == ${entry.status}:\n\t\treturn ${constant('TransportErrorCode', entry.code)}`).join('\n')}
${from.map((entry) => `\tcase status >= ${entry.statusFrom}:\n\t\treturn ${constant('TransportErrorCode', entry.code)}`).join('\n')}
	default:
		return ${constant('TransportErrorCode', unclassified.code)}
	}
}

${vocabulary('JobErrorCode', table.job.docs, jobCodes)}
${vocabulary('SessionErrorCode', table.session.docs, sessionCodes)}
${vocabulary('SignInErrorCode', table.signIn.docs, signInCodes)}
${vocabulary('IdentityUnverifiableReason', table.kbIdentity.docs, kbIdentityCodes)}
${vocabulary('SpanRefusal', table.spanRefusal.docs, spanRefusalCodes)}`;

writeOrCheck(ROOT, OUT, text.replace(/\n+$/, '\n'), CHECK);
