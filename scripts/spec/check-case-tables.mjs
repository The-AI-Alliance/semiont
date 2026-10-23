#!/usr/bin/env node
// lint:spec-case-tables — the case tables that state what a worker does to a
// text and to a model's reply, what a bus log shows of a payload, what the
// graph holds of an annotation and a resource and what the Weaver's fold does
// to it, how a follower of the record takes each log, what a point of the
// vector index is and what the index answers, the
// work a Smelter's start plans and what each kind of PDF becomes, what the
// Librarian answers from what it reads, the origin of a knowledge base's
// gateway, which jobs a claim's filter takes and whether a failed job is
// tried again, and the runners each must have.
//
// A rule that lives only in one implementation's code is that
// implementation's. These tables are the rules a worker in any language is
// held to, and the one every bus log is. What an SDK gives a worker's author
// (what an offset counts, what text a resource's bytes are, the reconciling
// of a quote, the locating of a span of a PDF, the builders, the id, the
// readers of an annotation and of a resource) is run by the TypeScript, Rust
// and Python SDKs, each through its own code, and so are the origin a session
// makes of its gateway's endpoint, the jobs a claim's filter takes and whether
// a failed job is tried again. What Semiont's worker alone
// does is run by that worker, and the cutting of a text by its Smelter too;
// TypeScript's core, which cuts no text, runs the estimate of a text's tokens
// that a cut is sized by. What a bus log shows of a payload is run by each
// bus log: TypeScript's, Rust's and Python's. What the graph holds of an
// annotation and of a resource is run by each implementation of the graph's
// codecs, and what the Weaver's fold does to the graph by each Weaver. What a
// point of the vector index is, and what the index answers after a history
// of writes, is run by the stores: Python's. The work a start plans and what
// each kind of PDF becomes is run by the Smelter. What the Librarian answers
// (a reference search's scores, a text search's page, the knowledge graph,
// the text around a selection, its prompts, its readings of a reply, the
// names it gives) is run by the Librarian, and the views read off a knowledge
// graph by the Librarian and by TypeScript's core.
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
//     holds its rule to no count. These are every table here but twenty-three:
//     what an offset counts, the chunker, the reconciling of a quote, the
//     locating of a span of a PDF, the builders, the id (whose anchor states a
//     span's offsets), the chunk plan, the citations, and the reading of a
//     reply (whose items state where each passage is, and how long a piece
//     was), and the Librarian's text around a selection. The two tables of what text a resource's bytes are, the two
//     readers' tables (an annotation's and a resource's), the table of
//     failure classes, the bus log's table, the graph codecs' table, the
//     Weaver's fold table, the follower's table, the two tables of the vector index, the
//     Smelter's two, the Librarian's other seven, the gateway's origin and
//     the two of a job's claim and retry count nothing and state no offset, and are held to
//     nothing about their characters.
//
// It reads the source files, so it cannot pass on a stale bundle.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');

/** Where these tables live. Every `*-cases.json` in one of them is listed below. */
const DIRECTORIES = ['specs/src/text', 'specs/src/annotations', 'specs/src/resources', 'specs/src/worker', 'specs/src/bus', 'specs/src/graph', 'specs/src/weaver', 'specs/src/follower', 'specs/src/vectors', 'specs/src/smelter', 'specs/src/librarian', 'specs/src/session', 'specs/src/jobs'];

/**
 * Each table, and the files that run it.
 *
 * `countsCodePoints` marks a table whose rule counts or states an offset: it
 * must have a character outside the basic plane.
 */
const TABLES = [
  // The origin of a knowledge base's gateway, from its HTTP endpoint.
  {
    table: 'specs/src/session/gateway-url-cases.json',
    runners: [
      'packages/sdk/src/session/__tests__/gateway-url-cases.test.ts',
      'packages/sdk-rust/src/session/knowledge_base.rs',
      'packages/sdk-python/tests/test_gateway_url.py',
    ],
  },
  // Which jobs a claim's filter takes, and whether a failed job is tried again.
  {
    table: 'specs/src/jobs/filter-cases.json',
    runners: [
      'packages/core/src/__tests__/job-filter.test.ts',
      'packages/sdk-rust/tests/job_filter.rs',
      'packages/sdk-python/tests/test_claims.py',
    ],
  },
  {
    table: 'specs/src/jobs/retry-cases.json',
    runners: [
      'packages/sdk/src/__tests__/job-claims.test.ts',
      'packages/sdk-rust/tests/job_retry_cases.rs',
      'packages/sdk-python/tests/test_claims.py',
    ],
  },
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
  // What Semiont's worker alone does, but for the cutting of a text, which
  // its Smelter does by the same rule.
  {
    table: 'specs/src/text/chunk-cases.json',
    runners: ['apps/worker/tests/test_chunk_cases.py', 'apps/smelter/tests/test_chunk_cases.py'],
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
  // What the graph holds of an annotation and of a resource, run by the
  // graph's codecs (semiont_graph) and by the reader the conformance harness
  // reads a graph with, which runs the parts a reader has.
  {
    table: 'specs/src/graph/codec-cases.json',
    runners: ['packages/graph-python/tests/test_codec_cases.py', 'tests/conformance/harness/graph-codec.test.ts'],
  },
  // What the Weaver's fold does to the graph: a history of recorded events,
  // and the graph it leaves. Run by the Weaver (semiont_weaver).
  {
    table: 'specs/src/weaver/fold-cases.json',
    runners: ['apps/weaver/tests/test_fold_cases.py'],
  },
  // How a follower of the record takes each log: a cursor that moves by one,
  // a delivered event taken as a hint, and a sweep at the start and at each
  // reopening of its stream. Run by the shared follower (semiont_service),
  // which the Weaver and the Smelter follow the record with.
  {
    table: 'specs/src/follower/follow-cases.json',
    runners: ['packages/service-python/tests/test_follow_cases.py'],
  },
  // What a point of the vector index is. Run by the stores
  // (semiont_vectors), which write the points and search them, and whose
  // store contract a real Qdrant is held to as well.
  {
    table: 'specs/src/vectors/payload-cases.json',
    runners: [
      'packages/vectors-python/tests/test_payload_cases.py',
      'packages/vectors-python/tests/store_contract.py',
    ],
  },
  // What the index answers after a history of writes. Run by the stores.
  {
    table: 'specs/src/vectors/store-cases.json',
    runners: ['packages/vectors-python/tests/store_contract.py'],
  },
  // The work a Smelter's start plans, from what the index, the catalog and
  // the anchored-text store each hold; and what each kind of PDF becomes. Run
  // by the Smelter (apps/smelter).
  {
    table: 'specs/src/smelter/reconcile-cases.json',
    runners: ['apps/smelter/tests/test_reconcile_cases.py'],
  },
  {
    table: 'specs/src/smelter/extraction-cases.json',
    runners: ['apps/smelter/tests/test_extraction_cases.py'],
  },
  // What the Librarian answers from what it reads: a reference search's
  // candidates and their scores, a text search's page, the knowledge graph
  // built from the graph's answers, the text around a selection (which counts
  // offsets), each prompt it writes and what it reads of a model's reply, and
  // the names it gives the people a reply mentions. Run by the Librarian
  // (apps/librarian).
  {
    table: 'specs/src/librarian/score-cases.json',
    runners: ['apps/librarian/tests/test_score_cases.py'],
  },
  {
    table: 'specs/src/librarian/search-cases.json',
    runners: ['apps/librarian/tests/test_search_cases.py'],
  },
  {
    table: 'specs/src/librarian/knowledge-graph-cases.json',
    runners: ['apps/librarian/tests/test_knowledge_graph_cases.py'],
  },
  {
    table: 'specs/src/librarian/window-cases.json',
    runners: ['apps/librarian/tests/test_window_cases.py'],
    countsCodePoints: true,
  },
  {
    table: 'specs/src/librarian/prompt-cases.json',
    runners: ['apps/librarian/tests/test_prompt_cases.py'],
  },
  {
    table: 'specs/src/librarian/reply-cases.json',
    runners: ['apps/librarian/tests/test_reply_cases.py'],
  },
  {
    table: 'specs/src/librarian/naming-cases.json',
    runners: ['apps/librarian/tests/test_naming_cases.py'],
  },
  // The views read off a knowledge graph: who a resource connects to, who
  // cites it, and the entity types of the annotations beside one. Run by each
  // reader: TypeScript's (@semiont/core), which the Browser calls, the
  // Librarian's, and the Worker's, which its generation prompt reads.
  {
    table: 'specs/src/librarian/derive-views-cases.json',
    runners: [
      'packages/core/src/__tests__/derive-views-cases.test.ts',
      'apps/librarian/tests/test_derive_views_cases.py',
      'apps/worker/tests/test_derive_views_cases.py',
    ],
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
