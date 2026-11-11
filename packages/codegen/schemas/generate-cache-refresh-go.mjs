#!/usr/bin/env node
// Generate the Go SDK's cache-refresh table from protocol/specs/src/client/refresh.json:
// which live queries each event on the bus, and the reopening of a dropped
// stream, asks again for, writes, or removes.
//
//   packages/go/sdk/refresh_gen.go
//
// Beside the table it writes the queries a client keeps in its storage, the
// type of the value each query's cache holds (from its `value`, as a type of
// package api), the triggers that are channels, how each of them reads a
// frame (by its typed value in package bus, so the payload type is the bus's),
// and the interface the client's refresher implements: what each act does to
// each query. A query a row comes to act on is a method the refresher lacks,
// so Go does not compile until it is answered. And it writes how the client
// keeps the queries the table persists: each is the cache of the client's live
// queries named as the query is, so one the table comes to persist is a cache
// the client lacks until it has one.
//
// The reading of the table, and the account it is held to, are
// cache-refresh-table.mjs's, shared with every SDK's generator of the table.
// The output is committed; `--check` compares without writing (the CI drift
// gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCacheRefresh } from './cache-refresh-table.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { goComment } from '../lib/go-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = resolve(ROOT, 'protocol/specs/src/client/refresh.json');
const OUT = resolve(ROOT, 'packages/go/sdk/refresh_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const { queries, values, refresh, whens, channelTriggers, ACTS } = readCacheRefresh(ROOT, TABLE, refuse);
const SCHEMAS = resolve(ROOT, 'protocol/specs/src/components/schemas');
const component = (name) => JSON.parse(readFileSync(resolve(SCHEMAS, `${name}.json`), 'utf8'));
/** The component a schema's `$ref` names, `./Name.json` or `Name.json`; undefined for a schema that is no `$ref`. */
const referred = (schema) => /^(?:\.\/)?([A-Za-z0-9]+)\.json$/.exec(schema.$ref ?? '')?.[1];
// A channel a resource's scope carries is a bus.Scoped value, and every other a bus.Global one.
const scoped = new Set(JSON.parse(readFileSync(resolve(ROOT, 'protocol/specs/src/bus/registry.json'), 'utf8')).audience.scoped);

/** `mark:body-updated` → `MarkBodyUpdated`; `referencedBy` → `ReferencedBy`. */
const pascal = (name) =>
  name
    .split(/[:\-]/)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
const quoted = (value) => JSON.stringify(value);

/** gofmt aligns a run of `Name Type = value` lines to their longest name. */
function aligned(rows, indent = '\t') {
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, rest]) => `${indent}${name}${' '.repeat(width - name.length)} ${rest}`);
}

const queryConst = (name) => `CacheQuery${pascal(name)}`;
const triggerConst = (on) => `CacheRefresh${pascal(on)}`;

const queryConsts = queries.flatMap((query, i) => [
  ...(i === 0 ? [] : ['']),
  goComment(query.docs, '\t'),
  ...aligned([[queryConst(query.name), `CacheQuery = ${quoted(query.name)}`]]),
]);

const triggers = [...whens.keys()];
const triggerConsts = aligned(triggers.map((on) => [triggerConst(on), `CacheRefreshTrigger = ${quoted(on)}`]));

const list = (names) => `[]CacheQuery{${names.map(queryConst).join(', ')}}`;
const persisted = queries.filter((query) => query.persisted === true).map((query) => query.name);

/** The Go type of a member's schema: a type of package api, a list of them, or a list of strings. */
const goTypeOf = (schema, label) => {
  const named = referred(schema);
  if (named !== undefined) return `api.${named}`;
  if (schema.type === 'array' && schema.items !== undefined) return `[]${goTypeOf(schema.items, label)}`;
  if (schema.type === 'string') return 'string';
  refuse(`${label} is of ${JSON.stringify(schema)}, which this generator writes no Go type for`);
};
/** The Go type of the value a query's cache holds: its `value`'s component, or the member within it. */
const valueType = (name) => {
  const { component: named, members } = values.get(name);
  if (members.length === 0) return `api.${named}`;
  let holder = component(named);
  for (const member of members.slice(0, -1)) {
    const inner = holder.properties[member];
    const next = referred(inner);
    holder = next === undefined ? inner : component(next);
  }
  return goTypeOf(holder.properties[members.at(-1)], `the value of the query ${name}`);
};
const valueTypes = aligned(queries.map((query) => [`${query.name}Value`, `= ${valueType(query.name)}`]));
// Each query the table persists is kept by the client's cache named as it is.
const keeps = persisted.map((name) => `\tkeepIn(v.${name}, persistence, ${queryConst(name)}, v.links.timing)`);
/** `payload.annotationId` → `CacheRefreshWay{"payload", "annotationId"}`. */
const way = (dotted) => `CacheRefreshWay{${dotted.split('.').map(quoted).join(', ')}}`;
const rowOf = (row) => {
  const said = [];
  if (row.when !== undefined) said.push(`When: CacheRefreshWhen${pascal(row.when)}`);
  said.push(`Reach: CacheRefreshReach${pascal(row.reach ?? 'subject')}`);
  const names = [
    ['Resource', row.names?.resource],
    ['Annotation', row.names?.annotation],
  ].flatMap(([field, dotted]) => (dotted === undefined ? [] : [`${field}: ${way(dotted)}`]));
  if (names.length > 0) said.push(`Names: CacheRefreshNames{${names.join(', ')}}`);
  if (row.carries !== undefined) said.push(`Carries: ${way(row.carries)}`);
  for (const act of ACTS) if ((row[act] ?? []).length > 0) said.push(`${pascal(act)}: ${list(row[act])}`);
  return `{${said.join(', ')}}`;
};
const table = triggers.flatMap((on, i) => {
  const rows = refresh.filter((row) => row.on === on);
  const docs = rows.length === 1 ? rows[0].docs : rows.map((row) => `${row.when}: ${row.docs}`).join(' ');
  return [...(i === 0 ? [] : ['']), goComment(docs, '\t'), `\t${triggerConst(on)}: {`, ...rows.map((row) => `\t\t${rowOf(row)},`), '\t},'];
});

// What each act does to which queries: a method per query a row acts on that way.
const acted = (act) => queries.map((query) => query.name).filter((name) => refresh.some((row) => (row[act] ?? []).includes(name)));
const verb = { refetches: 'refetch', writes: 'write', removes: 'remove' };
const actMethods = ACTS.flatMap((act) =>
  acted(act).map((name) =>
    act === 'refetches' ? `\t${verb[act]}${pascal(name)}(reach CacheRefreshReach, subject cacheSubject)` : `\t${verb[act]}${pascal(name)}(subject cacheSubject)`,
  ),
);
const actCases = (act) =>
  acted(act)
    .map((name) => `\t\tcase ${queryConst(name)}:\n\t\t\tacts.${verb[act]}${pascal(name)}(${act === 'refetches' ? 'row.Reach, ' : ''}subject)`)
    .join('\n');

const channelList = `[]CacheRefreshTrigger{${channelTriggers.map(triggerConst).join(', ')}}`;
// The bus's typed value of each channel is named as its trigger is.
const readings = aligned(
  channelTriggers.map((on) => [`${triggerConst(on)}:`, `${scoped.has(on) ? 'scopedReadingOf' : 'readingOf'}(bus.${pascal(on)}),`]),
);

const text = `// Code generated from protocol/specs/src/client/refresh.json — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-cache-refresh-go.mjs

package semiont

import (
\t"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
\t"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// CacheQuery is a live query a client's cache answers.
type CacheQuery string

// The live queries a client's cache answers.
const (
${queryConsts.join('\n')}
)

// CacheQueries is every live query, in the table's order.
var CacheQueries = ${list(queries.map((query) => query.name))}

// PersistedCacheQueries is every live query a client keeps in its storage,
// in the table's order: each under its name (CacheKey).
var PersistedCacheQueries = ${list(persisted)}

// The type of the value each live query's cache holds for a key: the table's
// \`value\`, a component or a member within one.
type (
${valueTypes.join('\n')}
)

// CacheRefreshTrigger is what refreshes a client's cache: a channel of the
// bus, the stream open again after a drop, or an event on one of the table's
// channels that cannot be read.
type CacheRefreshTrigger string

// The triggers of the table.
const (
${triggerConsts.join('\n')}
)

// CacheRefreshChannels is each trigger of the table that is a channel of the
// bus, in the table's order.
var CacheRefreshChannels = ${channelList}

// CacheRefreshReach is which keys a row acts on: those the event names
// (subject), or every key the client holds (held).
type CacheRefreshReach string

// The reaches of a row.
const (
\tCacheRefreshReachSubject CacheRefreshReach = "subject"
\tCacheRefreshReachHeld    CacheRefreshReach = "held"
)

// CacheRefreshWhen splits a channel whose events come two ways: enriched
// with the annotation's new value, or unenriched without. A row of a channel
// whose events come one way states none ("").
type CacheRefreshWhen string

// The two ways a split channel's events come.
const (
\tCacheRefreshWhenEnriched   CacheRefreshWhen = "enriched"
\tCacheRefreshWhenUnenriched CacheRefreshWhen = "unenriched"
)

// CacheRefreshWay is a way to a member of an event: the names of the members
// it is within, and its own. Nil where a row states none.
type CacheRefreshWay []string

// CacheRefreshNames is where in its event a row that reaches its subject
// finds it: the way to the resource it names (a ResourceId), and to the
// annotation (an AnnotationId).
type CacheRefreshNames struct {
\tResource   CacheRefreshWay
\tAnnotation CacheRefreshWay
}

// CacheRefresh is one row of the table: where its event names what it
// reaches; the way to the value it writes (an Annotation); the queries a
// trigger asks again for, keeping the value shown meanwhile; those whose new
// value its event carries; and those whose entity its event says is gone.
type CacheRefresh struct {
\tWhen      CacheRefreshWhen
\tReach     CacheRefreshReach
\tNames     CacheRefreshNames
\tCarries   CacheRefreshWay
\tRefetches []CacheQuery
\tWrites    []CacheQuery
\tRemoves   []CacheQuery
}

// CacheRefreshTable is each trigger's rows.
var CacheRefreshTable = map[CacheRefreshTrigger][]CacheRefresh{
${table.join('\n')}
}

// cacheRefreshReadings is how each channel of the table reads a frame:
// whether its payload is one of the channel's.
var cacheRefreshReadings = map[CacheRefreshTrigger]func(Frame) bool{
${readings.join('\n')}
}

// cacheActs is what the client's refresher does to each live query a row acts
// on. A query a row comes to act on is a method it lacks.
type cacheActs interface {
${actMethods.join('\n')}
}

// applyRefresh applies row to what subject names, by acts: its writes, its
// removes, then its refetches.
func applyRefresh(acts cacheActs, row CacheRefresh, subject cacheSubject) {
\tfor _, query := range row.Writes {
\t\tswitch query {
${actCases('writes')}
\t\t}
\t}
\tfor _, query := range row.Removes {
\t\tswitch query {
${actCases('removes')}
\t\t}
\t}
\tfor _, query := range row.Refetches {
\t\tswitch query {
${actCases('refetches')}
\t\t}
\t}
}

// attach has the caches of the queries the table persists keep their values
// in persistence from now on, each beginning with what it kept.
func (v *live) attach(persistence *CachePersistence) {
${keeps.join('\n')}
}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
if (!CHECK) console.log(`cache refresh: ${queries.length} queries, ${triggers.length} triggers, ${refresh.length} rows`);
