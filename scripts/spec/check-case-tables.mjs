#!/usr/bin/env node
// lint:spec-case-tables — every case table, who runs it, and the files that do.
//
// A case table is a file under specs/src whose name ends in `cases.json`: a
// rule stated case by case, which an implementation in any language is held
// to. Each states, beside its `$comment`, who runs it:
//
//   - `runBy`: each implementation that runs it, and the files that do: its
//     tests, or for Rust its source's own tests;
//   - `absent`: an SDK that does not run it, and why;
//   - `notYetReached`: an SDK that is to run it and does not yet, and what is
//     to be built for it to.
//
// An implementation is named by its key in IMPLEMENTATIONS, which says where
// its files are. The table owns who runs it; this gate holds the table to it.
//
// It fails when:
//   - a case table is not JSON, states no `$comment`, has an empty `cases`, or
//     states no `runBy`;
//   - `runBy` names an implementation IMPLEMENTATIONS lacks, or a runner that
//     is not that implementation's, does not exist, or does not name the
//     table it is said to run: a table nothing runs holds nothing;
//   - an SDK is named twice among `runBy`, `absent` and `notYetReached`, or
//     `absent` or `notYetReached` names what is no SDK;
//   - two of the four SDKs run a table, and another of them neither runs it,
//     nor says why not (`absent`), nor is still to (`notYetReached`): what at
//     least two SDKs have, every SDK has;
//   - an SDK `notYetReached` names has a test that names the table: it runs
//     it now, and belongs in `runBy`;
//   - a table whose rule counts or states an offset has no character outside
//     the basic plane (COUNTS_CODE_POINTS). An offset counts code points, and
//     so does every length such a rule states; only a text with such a
//     character tells that count from a count of UTF-16 code units or of
//     bytes, so a table without one holds its rule to no count.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const SPECS = 'specs/src';

/** Each implementation that runs a case table, and the directories its files are in. */
const IMPLEMENTATIONS = {
  typescript: ['packages/typescript/core', 'packages/typescript/sdk', 'packages/typescript/http-transport', 'packages/typescript/react-ui'],
  rust: ['packages/rust/sdk', 'packages/rust/http-transport'],
  python: ['packages/python/sdk'],
  go: ['packages/go/sdk'],
  launcher: ['apps/launcher', 'packages/go/launcher'],
  archivist: ['images/archivist'],
  librarian: ['images/librarian'],
  smelter: ['images/smelter'],
  weaver: ['images/weaver'],
  worker: ['images/worker'],
  'graph-python': ['packages/python/graph'],
  'vectors-python': ['packages/python/vectors'],
  'inference-python': ['packages/python/inference'],
  'service-python': ['packages/python/service'],
  conformance: ['tests/conformance'],
};

/** The four SDKs, which are held to one another. */
const SDKS = ['typescript', 'rust', 'python', 'go'];

/** The tables whose rule counts or states an offset. */
const COUNTS_CODE_POINTS = new Set([
  'text/offset-cases.json',
  'text/chunk-cases.json',
  'annotations/reconcile-cases.json',
  'annotations/pdf-locate-cases.json',
  'annotations/builder-cases.json',
  'annotations/id-cases.json',
  'worker/chunk-plan-cases.json',
  'worker/parser-cases.json',
  'worker/citation-cases.json',
  'librarian/window-cases.json',
]);

const failures = [];
const fail = (message) => failures.push(message);

const OUTSIDE_THE_BASIC_PLANE = /[\u{10000}-\u{10FFFF}]/u;

/** Every file under a directory, its path from the repository's root. */
function filesUnder(directory) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(resolve(REPO, at))) {
      if (name === 'node_modules' || name === 'target' || name.startsWith('.')) continue;
      const path = join(at, name);
      if (statSync(resolve(REPO, path)).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  if (existsSync(resolve(REPO, directory))) walk(directory);
  return out;
}

/** Whether a file's text names a table: by its path under specs/src, or by Go's directory and name. */
function names(text, table) {
  const [directory, name] = [table.slice(0, table.lastIndexOf('/')), table.slice(table.lastIndexOf('/') + 1)];
  return text.includes(table) || text.includes(`"${directory}", "${name}"`);
}

const isTest = (path) => /(_test\.go|\.test\.tsx?|\/test_[^/]*\.py|_test\.py)$|\/tests?\/|__tests__\//.test(path);

const tables = filesUnder(SPECS)
  .filter((path) => path.endsWith('cases.json'))
  .map((path) => relative(SPECS, path))
  .sort();

for (const table of tables) {
  const text = readFileSync(resolve(REPO, SPECS, table), 'utf8');
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
  if ('cases' in content && (!Array.isArray(content.cases) || content.cases.length === 0)) {
    fail(`${table} has no cases`);
  }
  if (COUNTS_CODE_POINTS.has(table) && !OUTSIDE_THE_BASIC_PLANE.test(text)) {
    fail(`${table} has no character outside the basic plane: its rule counts or states an offset, and it tells a count of code points from no other`);
  }
  const runBy = content.runBy;
  if (runBy === null || typeof runBy !== 'object' || Array.isArray(runBy) || Object.keys(runBy).length === 0) {
    fail(`${table} states no runBy: who runs it, and the files that do`);
    continue;
  }
  const absent = content.absent ?? {};
  const notYetReached = content.notYetReached ?? {};

  for (const [implementation, runners] of Object.entries(runBy)) {
    const directories = IMPLEMENTATIONS[implementation];
    if (directories === undefined) {
      fail(`${table}: runBy names ${implementation}, which is no implementation this gate knows (IMPLEMENTATIONS)`);
      continue;
    }
    if (!Array.isArray(runners) || runners.length === 0) {
      fail(`${table}: runBy names ${implementation} with no runner`);
      continue;
    }
    for (const runner of runners) {
      if (!directories.some((directory) => runner.startsWith(`${directory}/`))) {
        fail(`${table}: ${runner} is not ${implementation}'s, whose files are in ${directories.join(', ')}`);
      } else if (!existsSync(resolve(REPO, runner))) {
        fail(`${table} is to be run by ${runner}, which does not exist`);
      } else if (!names(readFileSync(resolve(REPO, runner), 'utf8'), table)) {
        fail(`${runner} does not name ${table}, the table it is said to run`);
      }
    }
  }

  for (const [said, entries] of [['absent', absent], ['notYetReached', notYetReached]]) {
    for (const [sdk, why] of Object.entries(entries)) {
      if (!SDKS.includes(sdk)) fail(`${table}: ${said} names ${sdk}, which is no SDK`);
      if (typeof why !== 'string' || why.trim() === '') fail(`${table}: ${said} names ${sdk} and says nothing of why`);
    }
  }
  for (const sdk of SDKS) {
    const stated = [sdk in runBy, sdk in absent, sdk in notYetReached].filter(Boolean).length;
    if (stated > 1) fail(`${table}: ${sdk} is named more than once among runBy, absent and notYetReached`);
    const othersRunning = SDKS.filter((other) => other !== sdk && other in runBy).length;
    if (stated === 0 && othersRunning >= 2) {
      fail(`${table} is run by ${othersRunning} of the other SDKs, and ${sdk} neither runs it nor says why not (absent) nor is still to (notYetReached)`);
    }
  }

  for (const sdk of Object.keys(notYetReached)) {
    const running = (IMPLEMENTATIONS[sdk] ?? [])
      .flatMap(filesUnder)
      .filter((path) => isTest(path) && names(readFileSync(resolve(REPO, path), 'utf8'), table));
    if (running.length > 0) {
      fail(`${table}: ${sdk} is notYetReached, and ${running.join(', ')} names it: it runs the table now, and belongs in runBy`);
    }
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`✗ ${message}`);
  process.exit(1);
}
const waiting = tables.filter((table) => Object.keys(JSON.parse(readFileSync(resolve(REPO, SPECS, table), 'utf8')).notYetReached ?? {}).length > 0);
console.log(`✓ ${tables.length} case tables, each run by the implementations it names; ${waiting.length} still to be reached by an SDK`);
