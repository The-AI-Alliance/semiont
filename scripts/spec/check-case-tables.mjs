#!/usr/bin/env node
// lint:spec-case-tables — the case tables that state what a worker does to a
// text and to a model's reply, what a bus log shows of a payload, what the
// graph holds of an annotation and a resource and what the Weaver's fold does
// to it, what a point of the vector index is and what the index answers, the
// work a Smelter's start plans and what each kind of PDF becomes, and the
// runners each must have.
//
// A rule that lives only in one implementation's code is that
// implementation's. These tables are the rules a worker in any language is
// held to, and the one every bus log is. What an SDK gives a worker's author
// (what an offset counts, what text a resource's bytes are, the reconciling
// of a quote, the locating of a span of a PDF, the builders, the id, the
// readers of an annotation and of a resource) is run by the TypeScript, Rust
// and Python SDKs, each through its own code. What Semiont's worker alone
// does is run by that worker. What a bus log shows of a payload is run by
// each bus log: TypeScript's, Rust's and Python's. What the graph holds of an
// annotation and of a resource is run by each implementation of the graph's
// codecs, and what the Weaver's fold does to the graph by each Weaver. What a
// point of the vector index is, and what the index answers, is run by each
// implementation of the stores; the work a start plans and what each kind of
// PDF becomes, by each Smelter.
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
//     holds its rule to no count. These are every table here but twelve:
//     what an offset counts, the chunker, the reconciling of a quote, the
//     locating of a span of a PDF, the builders, the id (whose anchor states a
//     span's offsets), the chunk plan, the citations, and the reading of a
//     reply (whose items state where each passage is, and how long a piece
//     was). The two tables of what text a resource's bytes are, the two
//     readers' tables (an annotation's and a resource's), the table of
//     failure classes, the bus log's table, the graph codecs' table, the
//     Weaver's fold table, the two tables of the vector index and the
//     Smelter's two count nothing and state no offset, and are held to
//     nothing about their characters.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');

/** Where these tables live. Every `*-cases.json` in one of them is listed below. */
const DIRECTORIES = ['specs/src/text', 'specs/src/annotations', 'specs/src/resources', 'specs/src/worker', 'specs/src/bus', 'specs/src/graph', 'specs/src/weaver', 'specs/src/vectors', 'specs/src/smelter'];

/**
 * Each table, and the files that run it.
 *
 * `countsCodePoints` marks a table whose rule counts or states an offset: it
 * must have a character outside the basic plane.
 */
const TABLES = [
  // What a text offset counts.
  {
    table: 'specs/src/text/offset-cases.json',
    runners: [
      'packages/core/src/__tests__/offset-cases.test.ts',
      'packages/react-ui/src/lib/__tests__/code-point-offsets.test.ts',
      'packages/sdk-rust/src/text_offsets.rs',
      'packages/sdk-python/tests/test_offsets.py',
    ],
    countsCodePoints: true,
  },
  // What text a resource's bytes are, which an offset is counted in: the cases
  // written by hand, and the generated ones of every label and every byte.
  {
    table: 'specs/src/text/decode-cases.json',
    runners: [
      'packages/core/src/__tests__/decode-cases.test.ts',
      'packages/sdk-rust/tests/decode_cases.rs',
      // The reader of UTF-8 alone, which a build without the `charsets` feature has.
      'packages/sdk-rust/src/resources.rs',
      'packages/sdk-python/tests/test_decode_cases.py',
    ],
  },
  {
    table: 'specs/src/text/encoding-cases.json',
    runners: [
      'packages/core/src/__tests__/decode-cases.test.ts',
      'packages/sdk-rust/tests/decode_cases.rs',
      'packages/sdk-rust/src/resources.rs',
      'packages/sdk-python/tests/test_decode_cases.py',
    ],
  },
  // What an SDK gives a worker's author.
  {
    table: 'specs/src/annotations/reconcile-cases.json',
    runners: [
      'packages/core/src/__tests__/reconcile-cases.test.ts',
      'packages/sdk-rust/tests/reconcile_cases.rs',
      'packages/sdk-python/tests/test_reconcile.py',
    ],
    countsCodePoints: true,
  },
  {
    table: 'specs/src/annotations/pdf-locate-cases.json',
    runners: [
      'packages/core/src/__tests__/pdf-locate-cases.test.ts',
      'packages/sdk-rust/src/annotations/locate.rs',
      'packages/sdk-python/tests/test_pdf_locate.py',
      // Its `claims`, which are the rule of Semiont's worker alone.
      'apps/worker/tests/test_claim_cases.py',
    ],
    countsCodePoints: true,
  },
  {
    table: 'specs/src/annotations/builder-cases.json',
    runners: [
      'packages/core/src/__tests__/builder-cases.test.ts',
      'packages/sdk/src/__tests__/annotation-builders.test.ts',
      'packages/sdk-rust/tests/builder_cases.rs',
      'packages/sdk-python/tests/test_annotation_builders.py',
    ],
    countsCodePoints: true,
  },
  {
    table: 'specs/src/annotations/id-cases.json',
    runners: [
      'packages/core/src/__tests__/id-cases.test.ts',
      'packages/sdk-rust/src/annotations/id.rs',
      'packages/sdk-python/tests/test_annotation_ids.py',
    ],
    countsCodePoints: true,
  },
  {
    table: 'specs/src/annotations/reader-cases.json',
    runners: [
      'packages/core/src/__tests__/annotation-reader-cases.test.ts',
      'packages/sdk/src/__tests__/annotation-readers.test.ts',
      'packages/sdk-rust/tests/annotation_reader_cases.rs',
      'packages/sdk-python/tests/test_annotations.py',
    ],
  },
  {
    table: 'specs/src/resources/reader-cases.json',
    runners: [
      'packages/core/src/__tests__/resource-reader-cases.test.ts',
      'packages/sdk-rust/tests/resource_reader_cases.rs',
      'packages/sdk-python/tests/test_resource_readers.py',
    ],
  },
  // What Semiont's worker alone does.
  {
    table: 'specs/src/text/chunk-cases.json',
    runners: ['packages/core/src/__tests__/chunk-cases.test.ts', 'apps/worker/tests/test_chunk_cases.py'],
    countsCodePoints: true,
  },
  {
    table: 'specs/src/worker/chunk-plan-cases.json',
    runners: ['apps/worker/tests/test_chunk_plan_cases.py'],
    countsCodePoints: true,
  },
  {
    table: 'specs/src/worker/parser-cases.json',
    runners: ['apps/worker/tests/test_parser_cases.py'],
    countsCodePoints: true,
  },
  {
    table: 'specs/src/worker/citation-cases.json',
    runners: ['apps/worker/tests/test_citation_cases.py'],
    countsCodePoints: true,
  },
  {
    table: 'specs/src/worker/failure-class-cases.json',
    runners: ['apps/worker/tests/test_failure_class_cases.py'],
  },
  // What a bus log shows of a payload.
  {
    table: 'specs/src/bus/log-cases.json',
    runners: [
      'packages/core/src/__tests__/bus-log-cases.test.ts',
      'packages/sdk-rust/src/bus_log.rs',
      'packages/sdk-python/tests/test_bus_log.py',
    ],
  },
  // What the graph holds of an annotation and of a resource, run by each
  // implementation of the graph's codecs: TypeScript's (@semiont/graph) and
  // Python's (semiont_graph).
  {
    table: 'specs/src/graph/codec-cases.json',
    runners: ['packages/graph/src/__tests__/codec-cases.test.ts', 'packages/graph-python/tests/test_codec_cases.py'],
  },
  // What the Weaver's fold does to the graph: a history of recorded events,
  // and the graph it leaves. Run by the Weaver (semiont_weaver).
  {
    table: 'specs/src/weaver/fold-cases.json',
    runners: ['apps/weaver/tests/test_fold_cases.py'],
  },
  // What a point of the vector index is, and what the index answers after a
  // history of writes. Run by each implementation of the stores: TypeScript's
  // (@semiont/vectors) and Python's (semiont_vectors), whose store contract a
  // real Qdrant is held to as well.
  {
    table: 'specs/src/vectors/payload-cases.json',
    runners: [
      'packages/vectors/src/__tests__/payload-cases.test.ts',
      'packages/vectors-python/tests/test_payload_cases.py',
      'packages/vectors-python/tests/store_contract.py',
    ],
  },
  {
    table: 'specs/src/vectors/store-cases.json',
    runners: ['packages/vectors/src/__tests__/store-cases.test.ts', 'packages/vectors-python/tests/store_contract.py'],
  },
  // The work a Smelter's start plans, from what the index, the catalog and
  // the anchored-text store each hold; and what each kind of PDF becomes. Run
  // by the Smelter (@semiont/make-meaning, with @semiont/content).
  {
    table: 'specs/src/smelter/reconcile-cases.json',
    runners: ['packages/make-meaning/src/__tests__/reconcile-cases.test.ts'],
  },
  {
    table: 'specs/src/smelter/extraction-cases.json',
    runners: ['packages/content/src/__tests__/extraction-cases.test.ts', 'apps/smelter/tests/test_extraction_cases.py'],
  },
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
console.log(`✓ ${TABLES.length} case tables exist, each run by the runners it is listed with`);
