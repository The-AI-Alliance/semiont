// Generate the client's timing constants from specs/src/client/timing.json:
// its deadlines, its retry budgets, and the cadence of its stream.
//
// The table is the authority every SDK generates from. A number restated in
// each language drifts, and nothing notices: the Rust transport's first
// reconnect wait was a tenth of this one's. Output is gitignored and rebuilt
// by core's `prebuild`.
//
// `--table <path>` and `--out <path>` name another table and another output;
// the test of the refusals passes them.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'specs/src/client/timing.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/core/src/generated/client-timing.ts'));

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const wholeMs = (n) => Number.isInteger(n) && n > 0;

const { timing } = JSON.parse(readFileSync(TABLE, 'utf8'));
if (!Array.isArray(timing) || timing.length === 0) refuse('lists no timing');

const seen = new Set();
for (const entry of timing) {
  const { name, value, docs } = entry;
  if (typeof name !== 'string' || !/^[a-z][A-Za-z]*(Ms|Retry)$/.test(name)) {
    refuse(`${JSON.stringify(name)} is not a name: camelCase, ending in Ms for a duration or Retry for a budget`);
  }
  if (seen.has(name)) refuse(`${name} is stated twice`);
  seen.add(name);
  if (typeof docs !== 'string' || docs === '') refuse(`${name} has no docs`);
  if (name.endsWith('Ms')) {
    if (!wholeMs(value)) refuse(`${name} is a duration, so its value is a whole number of milliseconds above zero`);
    continue;
  }
  const fields = value === null || typeof value !== 'object' ? [] : Object.keys(value).sort();
  if (fields.join() !== 'attempts,initialDelayMs,maxDelayMs') {
    refuse(`${name} is a budget, so its value is exactly attempts, initialDelayMs and maxDelayMs`);
  }
  if (!Number.isInteger(value.attempts) || value.attempts < 1) refuse(`${name} allows no attempt`);
  if (!wholeMs(value.initialDelayMs) || !wholeMs(value.maxDelayMs)) {
    refuse(`${name}'s delays are whole numbers of milliseconds above zero`);
  }
  if (value.initialDelayMs > value.maxDelayMs) refuse(`${name}'s backoff starts above its ceiling`);
}

/** `emitRetry` → `EMIT_RETRY` */
const constantName = (name) => name.replace(/([A-Z])/g, '_$1').toUpperCase();
const doc = (text) => `/** ${text.replaceAll('*/', '*\\/')} */`;

const lines = timing.map(({ name, value, docs }) =>
  name.endsWith('Ms')
    ? `${doc(docs)}\nexport const ${constantName(name)} = ${value};\n`
    : `${doc(docs)}\nexport const ${constantName(name)}: RetryPolicy = { attempts: ${value.attempts}, initialDelayMs: ${value.initialDelayMs}, maxDelayMs: ${value.maxDelayMs} };\n`,
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
// Source: specs/src/client/timing.json → scripts/spec/generate-client-timing.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

import type { RetryPolicy } from '../retry';

${lines.join('\n')}`,
);

console.log(`generated ${timing.length} client timing constants → ${OUT}`);
