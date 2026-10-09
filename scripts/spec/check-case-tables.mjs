#!/usr/bin/env node
// lint:spec-case-tables — the case tables that state what a worker does to a
// text and to a model's reply, and the runner each must have.
//
// A rule that lives only in one implementation's code is that
// implementation's. These tables are the rules a worker in any language is
// held to: the TypeScript worker runs them today, and a worker written in
// another language runs the same files.
//
// It fails when:
//   - a table listed here does not exist, is not JSON, states no `$comment`
//     saying what it holds and who runs it, or has no cases;
//   - a runner listed for a table does not exist, or does not name the table
//     it is said to run: a table nothing runs holds nothing;
//   - a `*-cases.json` file sits in one of these directories and is not
//     listed here, so a table cannot be added beside the others and go unrun;
//   - a table whose rule counts or states an offset has no character outside
//     the basic plane. An offset counts code points, and so does every length
//     such a rule states; only a text with such a character tells that count
//     from a count of UTF-16 code units or of bytes, so a table without one
//     holds its rule to no count. These are every table here but one: what an
//     offset counts, the chunker, the reconciling of a quote, the locating of
//     a span of a PDF, the builder, the id (whose anchor states a span's
//     offsets), the chunk plan, the citations, and the reading of a reply
//     (whose items state where each passage is, and how long a piece was).
//     The table of failure classes counts nothing and states no offset, and
//     is held to nothing about its characters.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');

/** Where these tables live. Every `*-cases.json` in one of them is listed below. */
const DIRECTORIES = ['specs/src/text', 'specs/src/worker'];

/**
 * Each table, and the files that run it. `specs/src/annotations/` holds a
 * table of another census as well (the readers', `lint:client-surface`'s), so
 * its tables are listed here by name and the directory is not swept.
 *
 * `countsCodePoints` marks a table whose rule counts or states an offset: it
 * must have a character outside the basic plane.
 */
const TABLES = [
  // What a text offset counts.
  { table: 'specs/src/text/offset-cases.json', runners: ['packages/core/src/__tests__/offset-cases.test.ts', 'packages/react-ui/src/lib/__tests__/code-point-offsets.test.ts'], countsCodePoints: true },
  // What every worker does to a text.
  { table: 'specs/src/text/chunk-cases.json', runners: ['packages/core/src/__tests__/chunk-cases.test.ts'], countsCodePoints: true },
  { table: 'specs/src/annotations/reconcile-cases.json', runners: ['packages/core/src/__tests__/reconcile-cases.test.ts'], countsCodePoints: true },
  { table: 'specs/src/annotations/pdf-locate-cases.json', runners: ['packages/core/src/__tests__/pdf-locate-cases.test.ts'], countsCodePoints: true },
  { table: 'specs/src/annotations/builder-cases.json', runners: ['packages/jobs/src/__tests__/builder-cases.test.ts'], countsCodePoints: true },
  { table: 'specs/src/annotations/id-cases.json', runners: ['packages/jobs/src/__tests__/id-cases.test.ts'], countsCodePoints: true },
  // What Semiont's worker alone does.
  { table: 'specs/src/worker/chunk-plan-cases.json', runners: ['packages/jobs/src/__tests__/chunk-plan-cases.test.ts'], countsCodePoints: true },
  { table: 'specs/src/worker/parser-cases.json', runners: ['packages/jobs/src/__tests__/parser-cases.test.ts'], countsCodePoints: true },
  { table: 'specs/src/worker/citation-cases.json', runners: ['packages/jobs/src/__tests__/citation-cases.test.ts'], countsCodePoints: true },
  { table: 'specs/src/worker/failure-class-cases.json', runners: ['packages/jobs/src/__tests__/failure-class-cases.test.ts'] },
];

const failures = [];
const fail = (message) => failures.push(message);

const OUTSIDE_THE_BASIC_PLANE = /[\u{10000}-\u{10FFFF}]/u;

for (const { table, runners, countsCodePoints = false } of TABLES) {
  const path = resolve(REPO, table);
  if (!existsSync(path)) {
    fail(`${table} does not exist`);
    continue;
  }
  const text = readFileSync(path, 'utf8');
  let content;
  try {
    content = JSON.parse(text);
  } catch (error) {
    fail(`${table} is not JSON: ${error.message}`);
    continue;
  }
  if (typeof content.$comment !== 'string' || content.$comment.trim() === '') {
    fail(`${table} states no $comment: what it holds, and who runs it`);
  }
  if (!Array.isArray(content.cases) || content.cases.length === 0) {
    fail(`${table} has no cases`);
  }
  if (countsCodePoints && !OUTSIDE_THE_BASIC_PLANE.test(text)) {
    fail(`${table} has no character outside the basic plane: its rule counts or states an offset, and it tells a count of code points from no other`);
  }
  for (const runner of runners) {
    const runnerPath = resolve(REPO, runner);
    if (!existsSync(runnerPath)) {
      fail(`${table} is to be run by ${runner}, which does not exist`);
    } else if (!readFileSync(runnerPath, 'utf8').includes(table)) {
      fail(`${runner} does not name ${table}, the table it is listed as running`);
    }
  }
}

const listed = new Set(TABLES.map(({ table }) => table));
for (const directory of DIRECTORIES) {
  const path = resolve(REPO, directory);
  if (!existsSync(path)) continue;
  for (const name of readdirSync(path)) {
    const table = `${directory}/${name}`;
    if (name.endsWith('-cases.json') && !listed.has(table)) {
      fail(`${table} is a case table this gate does not list: nothing holds it to a runner`);
    }
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(`✓ ${TABLES.length} case tables exist, each run by the runner it is listed with`);
