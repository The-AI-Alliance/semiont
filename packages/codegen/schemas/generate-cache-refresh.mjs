// Generate the client's cache-refresh table from protocol/specs/src/client/refresh.json:
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

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCacheRefresh } from './cache-refresh-table.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'protocol/specs/src/client/refresh.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/typescript/core/src/generated/cache-refresh.ts'));

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const { queries, refresh, whens, channelTriggers, WHEN } = readCacheRefresh(ROOT, TABLE, refuse);

const list = (values) => `[${values.map((v) => `'${v}'`).join(', ')}]`;
const doc = (text) => `/** ${text.replaceAll('*/', '*\\/')} */`;
/** A way to a member, as the names it is made of. */
const way = (dotted) => list(dotted.split('.'));
const rowOf = ({ when, reach = 'subject', names = {}, carries, refetches = [], writes = [], removes = [] }) => {
  const named = Object.entries(names).map(([slot, dotted]) => `${slot}: ${way(dotted)}`);
  return `{ ${when === undefined ? '' : `when: '${when}', `}reach: '${reach}', names: {${named.length === 0 ? '' : ` ${named.join(', ')} `}}, ${carries === undefined ? '' : `carries: ${way(carries)}, `}refetches: ${list(refetches)}, writes: ${list(writes)}, removes: ${list(removes)} }`;
};

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
// Source: protocol/specs/src/client/refresh.json → packages/codegen/schemas/generate-cache-refresh.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

/** The live queries a client's cache answers. */
export const CACHE_QUERIES = ${list(queries.map((query) => query.name))} as const;
export type CacheQuery = (typeof CACHE_QUERIES)[number];

/** Which of a split channel's two kinds of event a row is for. */
export type CacheRefreshWhen = ${WHEN.map((when) => `'${when}'`).join(' | ')};

/** A way to a member of an event: the names of the members it is within, and its own. */
export type CacheRefreshWay = readonly string[];

/** What one trigger does to the cache. */
export interface CacheRefresh {
  readonly when?: CacheRefreshWhen;
  /** \`subject\`: the keys the event names. \`held\`: every key the client holds. */
  readonly reach: 'subject' | 'held';
  /** Where in the event the keys a \`subject\` row reaches are: the way to the resource it names (a ResourceId), and to the annotation (an AnnotationId). */
  readonly names: { readonly resource?: CacheRefreshWay; readonly annotation?: CacheRefreshWay };
  /** The way to the value the row writes (an Annotation). On a split channel, its presence is what makes an event enriched. */
  readonly carries?: CacheRefreshWay;
  /** Asked for again, the value shown meanwhile. */
  readonly refetches: readonly CacheQuery[];
  /** Written with the value the event carries. */
  readonly writes: readonly CacheQuery[];
  /** Gone: the key fails as \`bus.not-found\`. */
  readonly removes: readonly CacheQuery[];
}

/** What each trigger does: a channel's events; \`reopened\`, the stream open again after a drop; or \`unreadable\`, an event on one of these channels that cannot be read. */
export const CACHE_REFRESH = {
${entries.join('\n')}
} as const satisfies Record<string, readonly CacheRefresh[]>;

export type CacheRefreshTrigger = keyof typeof CACHE_REFRESH;

/** The triggers that are channels of the bus. */
export const CACHE_REFRESH_CHANNELS = ${list(channelTriggers)} as const;
export type CacheRefreshChannel = (typeof CACHE_REFRESH_CHANNELS)[number];
`,
);

console.log(`generated ${refresh.length} cache-refresh rows → ${OUT}`);
