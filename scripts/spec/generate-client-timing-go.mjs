#!/usr/bin/env node
// Generate the Go SDK's client timing from specs/src/client/timing.json: one
// field of `Timing` per entry, and `DefaultTiming`, the table's values.
//
//   packages/sdk-go/timing_gen.go
//
// A duration (`…Ms`) is a time.Duration named without its unit (`reconnectMs`
// is `Reconnect`), a retry budget (`…Retry`) a RetryPolicy, and a count
// (`…Count`) an int. The reading of the table is client-timing-table.mjs's,
// shared with the TypeScript and Python generators; Rust's build script reads
// the same table. The output is committed; `--check` compares without writing
// (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClientTiming } from './client-timing-table.mjs';
import { writeOrCheck } from './committed-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = resolve(ROOT, 'specs/src/client/timing.json');
const OUT = resolve(ROOT, 'packages/sdk-go/timing_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const entries = readClientTiming(TABLE, refuse);

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

const upper = (name) => name[0].toUpperCase() + name.slice(1);
const field = (name) => upper(name.endsWith('Ms') ? name.slice(0, -2) : name);
const ms = (n) => `${n} * time.Millisecond`;

const fields = entries.map(({ name, docs }) => {
  const type = name.endsWith('Ms') ? 'time.Duration' : name.endsWith('Retry') ? 'RetryPolicy' : 'int';
  return `${comment(`${field(name)} is ${name}: ${docs}`, '\t')}\n\t${field(name)} ${type}`;
});

const width = Math.max(...entries.map(({ name }) => field(name).length + 1));
const values = entries.map(({ name, value }) => {
  const stated = name.endsWith('Ms')
    ? ms(value)
    : name.endsWith('Retry')
      ? `RetryPolicy{Attempts: ${value.attempts}, InitialDelay: ${ms(value.initialDelayMs)}, MaxDelay: ${ms(value.maxDelayMs)}}`
      : String(value);
  return `\t\t${`${field(name)}:`.padEnd(width)} ${stated},`;
});

const text = `// Code generated from specs/src/client/timing.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-client-timing-go.mjs
// The TypeScript and Python constants are generated from the same table, and
// Rust's by its SDK's build script.

package semiont

import "time"

// Timing is the timing a Semiont client keeps: its deadlines, its retry
// budgets, the cadence of its stream, and what it keeps count of, as
// specs/src/client/timing.json states them for every SDK. It holds one field
// per entry, under the entry's name. DefaultTiming is the table's values; a
// caller that wants another sets that field.
type Timing struct {
${fields.join('\n')}
}

// DefaultTiming is the table's values.
func DefaultTiming() Timing {
	return Timing{
${values.join('\n')}
	}
}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
