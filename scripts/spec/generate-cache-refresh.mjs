// Generate the client's cache-refresh table from specs/src/client/refresh.json:
// which live queries each event on the bus, and the reopening of a dropped
// stream, asks again for, writes, or removes.
//
// The table is the authority every SDK generates from. Stated per language it
// was three statements of one fact: a table in prose, a block of handlers,
// and the cases that held them. Output is gitignored and rebuilt by core's
// `prebuild`.
//
// `--table <path>` and `--out <path>` name another table and another output;
// the test of the refusals passes them.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryClasses } from '../bus/delivery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'specs/src/client/refresh.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/core/src/generated/cache-refresh.ts'));

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const registry = JSON.parse(readFileSync(resolve(ROOT, 'specs/src/bus/registry.json'), 'utf8'));
const channels = new Map(registry.channels.map((entry) => [entry.channel, entry]));
const requests = new Set(registry.operations.map((operation) => operation.request));
const delivery = deliveryClasses(registry);

const { queries, refresh } = JSON.parse(readFileSync(TABLE, 'utf8'));
if (!Array.isArray(queries) || queries.length === 0) refuse('lists no queries');
if (!Array.isArray(refresh) || refresh.length === 0) refuse('lists no refresh');

const PER = ['resource', 'annotation', 'filters'];
const names = new Set();
for (const query of queries) {
  const { name, per, asks, docs } = query;
  if (typeof name !== 'string' || !/^[a-z][A-Za-z]*$/.test(name)) refuse(`${JSON.stringify(name)} is not a query's name: camelCase`);
  if (names.has(name)) refuse(`the query ${name} is stated twice`);
  names.add(name);
  if (typeof docs !== 'string' || docs === '') refuse(`the query ${name} has no docs`);
  if (!requests.has(asks)) refuse(`the query ${name} asks ${JSON.stringify(asks)}, which is not an operation of the registry`);
  if (per !== undefined && !PER.includes(per)) refuse(`the query ${name} is kept per ${JSON.stringify(per)}: one of ${PER.join(', ')}, or absent`);
}

const ACTS = ['refetches', 'writes', 'removes'];
const WHEN = ['enriched', 'unenriched'];
const whens = new Map();
for (const row of refresh) {
  const { on, when, reach = 'subject', docs } = row;
  const label = when === undefined ? on : `${on} (${when})`;
  if (on !== 'reopened' && !channels.has(on)) refuse(`${JSON.stringify(on)} is neither a channel of the registry nor \`reopened\``);
  if (typeof docs !== 'string' || docs === '') refuse(`${label} has no docs`);
  if (!['subject', 'held'].includes(reach)) refuse(`${label} reaches ${JSON.stringify(reach)}: subject or held`);
  if (on === 'reopened' && reach !== 'held') refuse('reopened names no subject, so it reaches what is held');
  if (when !== undefined) {
    if (!WHEN.includes(when)) refuse(`${on} is split by ${JSON.stringify(when)}: one of ${WHEN.join(', ')}`);
    if (channels.get(on)?.enriched !== true) refuse(`${on} is split by ${when}, and the registry does not say its events are enriched`);
  }
  const stated = whens.get(on) ?? [];
  if (stated.includes(when)) refuse(`${label} is stated twice`);
  whens.set(on, [...stated, when]);

  const acted = new Set();
  for (const act of ACTS) {
    const list = row[act] ?? [];
    if (!Array.isArray(list)) refuse(`${label}: ${act} is a list of queries`);
    for (const query of list) {
      if (!names.has(query)) refuse(`${label} ${act} ${JSON.stringify(query)}, which is not a query`);
      if (acted.has(query)) refuse(`${label} acts on ${query} twice`);
      acted.add(query);
    }
  }
  if (acted.size === 0) refuse(`${label} does nothing`);
  const unknown = Object.keys(row).filter((key) => !['on', 'when', 'reach', 'docs', ...ACTS].includes(key));
  if (unknown.length > 0) refuse(`${label} states ${unknown.join(', ')}, which a row does not have`);
}
// What a row may do follows from how its trigger is delivered
// (docs/protocol/TRANSPORT-CONTRACT.md § Delivery). A passing frame is lost
// when the stream is down and may arrive twice across a handoff, so a row it
// triggers does only what is safe to repeat and to miss: it refetches, and
// `reopened` refetches the same queries, which is what repairs the miss.
const reopened = refresh.find((row) => row.on === 'reopened');
if (!reopened) refuse('has no row for `reopened`');
for (const row of refresh) {
  if (row.on === 'reopened' || delivery.get(row.on) !== 'passing') continue;
  // The gateway writes this one itself, on the stream whose subscription it is about: it cannot be missed.
  if (row.on === 'bus:resume-gap') continue;
  for (const act of ['writes', 'removes']) {
    if ((row[act] ?? []).length > 0) refuse(`${row.on} ${act} ${row[act].join(', ')}, and its frames have no identity: one lost or doubled must leave the cache right`);
  }
  const unrepaired = (row.refetches ?? []).filter((query) => !(reopened.refetches ?? []).includes(query));
  if (unrepaired.length > 0) {
    refuse(`${row.on} refetches ${unrepaired.join(', ')}, and nothing replays it to a client whose stream was down: \`reopened\` must refetch ${unrepaired.join(', ')} too`);
  }
}

for (const [on, stated] of whens) {
  if (stated.length === 1 && stated[0] === undefined) continue;
  if (stated.length !== WHEN.length || !WHEN.every((when) => stated.includes(when))) {
    refuse(`${on} is split, so it has a row for each of ${WHEN.join(' and ')} and no other`);
  }
}

const list = (values) => `[${values.map((v) => `'${v}'`).join(', ')}]`;
const doc = (text) => `/** ${text.replaceAll('*/', '*\\/')} */`;
const rowOf = ({ when, reach = 'subject', refetches = [], writes = [], removes = [] }) =>
  `{ ${when === undefined ? '' : `when: '${when}', `}reach: '${reach}', refetches: ${list(refetches)}, writes: ${list(writes)}, removes: ${list(removes)} }`;

const triggers = [...whens.keys()];
const entries = triggers.map((on) => {
  const rows = refresh.filter((row) => row.on === on);
  const docs = rows.length === 1 ? rows[0].docs : rows.map((row) => `${row.when}: ${row.docs}`).join(' ');
  return `  ${doc(docs)}\n  '${on}': [${rows.map(rowOf).join(', ')}],`;
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
// Source: specs/src/client/refresh.json → scripts/spec/generate-cache-refresh.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

/** The live queries a client's cache answers. */
export const CACHE_QUERIES = ${list(queries.map((query) => query.name))} as const;
export type CacheQuery = (typeof CACHE_QUERIES)[number];

/** Which of a split channel's two kinds of event a row is for. */
export type CacheRefreshWhen = ${WHEN.map((when) => `'${when}'`).join(' | ')};

/** What one trigger does to the cache. */
export interface CacheRefresh {
  readonly when?: CacheRefreshWhen;
  /** \`subject\`: the keys the event names. \`held\`: every key the client holds. */
  readonly reach: 'subject' | 'held';
  /** Asked for again, the value shown meanwhile. */
  readonly refetches: readonly CacheQuery[];
  /** Written with the value the event carries. */
  readonly writes: readonly CacheQuery[];
  /** Gone: the key fails as \`bus.not-found\`. */
  readonly removes: readonly CacheQuery[];
}

/** What each trigger does: a channel's events, or \`reopened\`, the stream open again after a drop. */
export const CACHE_REFRESH = {
${entries.join('\n')}
} as const satisfies Record<string, readonly CacheRefresh[]>;

export type CacheRefreshTrigger = keyof typeof CACHE_REFRESH;
`,
);

console.log(`generated ${refresh.length} cache-refresh rows → ${OUT}`);
