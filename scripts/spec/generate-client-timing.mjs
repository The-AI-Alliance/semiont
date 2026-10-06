// Generate the client's constants from specs/src/client/timing.json: its
// deadlines, its retry budgets, the cadence of its stream, and what it keeps
// count of.
//
// The table is the authority every SDK generates from. A number restated in
// each language drifts, and nothing notices: the Rust transport's first
// reconnect wait was a tenth of this one's. Output is gitignored and rebuilt
// by core's `prebuild`.
//
// `--table <path>` and `--out <path>` name another table and another output;
// the test of the refusals passes them.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClientTiming } from './client-timing-table.mjs';

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

const timing = readClientTiming(TABLE, refuse);

/** `emitRetry` → `EMIT_RETRY` */
const constantName = (name) => name.replace(/([A-Z])/g, '_$1').toUpperCase();
const doc = (text) => `/** ${text.replaceAll('*/', '*\\/')} */`;

const lines = timing.map(({ name, value, docs }) =>
  name.endsWith('Retry')
    ? `${doc(docs)}\nexport const ${constantName(name)}: RetryPolicy = { attempts: ${value.attempts}, initialDelayMs: ${value.initialDelayMs}, maxDelayMs: ${value.maxDelayMs} };\n`
    : `${doc(docs)}\nexport const ${constantName(name)} = ${value};\n`,
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

console.log(`generated ${timing.length} client constants → ${OUT}`);
