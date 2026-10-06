#!/usr/bin/env node
// Generate the Python SDK's client constants from specs/src/client/timing.json:
// its deadlines, its retry budgets, the cadence of its stream, and what it
// keeps count of.
//
//   packages/sdk-python/src/semiont/timing.py
//
// The reading of the table is client-timing-table.mjs's, shared with the
// TypeScript generator. The output is committed; `--check` compares without
// writing (the CI drift gate).
//
// `--table <path>` and `--out <path>` name another table and another output.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClientTiming } from './client-timing-table.mjs';
import { writeOrCheck } from './committed-source.mjs';
import { pyBanner, pyComment, pyConstant, pyString } from './python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'specs/src/client/timing.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/sdk-python/src/semiont/timing.py'));
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const timing = readClientTiming(TABLE, refuse);

const constants = timing.map(({ name, value, docs }) =>
  name.endsWith('Retry')
    ? `${pyComment(docs)}\n${pyConstant(name)}: Final = RetryPolicy(attempts=${value.attempts}, initial_delay_ms=${value.initialDelayMs}, max_delay_ms=${value.maxDelayMs})\n`
    : `${pyComment(docs)}\n${pyConstant(name)}: Final = ${value}\n`,
);

const text = `${pyBanner('specs/src/client/timing.json', 'scripts/spec/generate-client-timing-python.mjs')}
"""The timing a Semiont client keeps: its deadlines, its retry budgets, the
cadence of its stream, and what it keeps count of.

Each constant is an entry of the table every SDK generates from, under the
entry's own name: \`emitRetry\` is \`EMIT_RETRY\`. \`TIMING_NAMES\` lists the names
as the table states them, which is how a caller overrides one.
"""

from typing import Final

from semiont.retry import RetryPolicy

__all__ = [
${['TIMING_NAMES', ...timing.map(({ name }) => pyConstant(name))].sort().map((name) => `    ${pyString(name)},`).join('\n')}
]

${constants.join('\n')}
# Every entry's name, as the table states it.
TIMING_NAMES: Final[tuple[str, ...]] = (
${timing.map(({ name }) => `    ${pyString(name)},`).join('\n')}
)
`;

writeOrCheck(ROOT, OUT, text, CHECK);
