#!/usr/bin/env node
// Generate the Go SDK's cache-refresh table from specs/src/client/refresh.json:
// which live queries each event on the bus, and the reopening of a dropped
// stream, asks again for, writes, or removes.
//
//   packages/go/sdk/refresh_gen.go
//
// Beside the table it writes the two interfaces the client's refresher
// implements: what each trigger's event names, and what each act does to each
// query. A trigger or a query the table gains is a method the refresher lacks,
// so Go does not compile until it is answered.
//
// The reading of the table, and the account it is held to, are
// cache-refresh-table.mjs's, shared with the TypeScript and Python generators.
// The output is committed; `--check` compares without writing (the CI drift
// gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCacheRefresh } from './cache-refresh-table.mjs';
import { writeOrCheck } from './committed-source.mjs';
import { goComment } from './go-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = resolve(ROOT, 'specs/src/client/refresh.json');
const OUT = resolve(ROOT, 'packages/go/sdk/refresh_gen.go');
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const { queries, refresh, whens, ACTS } = readCacheRefresh(TABLE, resolve(ROOT, 'specs/src/bus/registry.json'), resolve(ROOT, 'specs/src/openapi.json'), refuse);

/** `mark:body-updated` → `MarkBodyUpdated`; `referencedBy` → `ReferencedBy`. */
const pascal = (name) =>
  name
    .split(/[:\-]/)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
/** `mark:body-updated` → `markBodyUpdated`. */
const camel = (name) => {
  const p = pascal(name);
  return p[0].toLowerCase() + p.slice(1);
};
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
const rowOf = (row) => {
  const said = [];
  if (row.when !== undefined) said.push(`When: CacheRefreshWhen${pascal(row.when)}`);
  said.push(`Reach: CacheRefreshReach${pascal(row.reach ?? 'subject')}`);
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

const eventMethods = triggers.map((on) => (on === 'reopened' ? `\treopened() cacheSubject` : `\t${camel(on)}(frame Frame) (cacheSubject, error)`));
const eventCases = triggers
  .map((on) => (on === 'reopened' ? `\tcase ${triggerConst(on)}:\n\t\treturn events.reopened(), nil` : `\tcase ${triggerConst(on)}:\n\t\treturn events.${camel(on)}(frame)`))
  .join('\n');

const text = `// Code generated from specs/src/client/refresh.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-cache-refresh-go.mjs

package semiont

import "fmt"

// CacheQuery is a live query a client's cache answers.
type CacheQuery string

// The live queries a client's cache answers.
const (
${queryConsts.join('\n')}
)

// CacheQueries is every live query, in the table's order.
var CacheQueries = ${list(queries.map((query) => query.name))}

// CacheRefreshTrigger is what refreshes a client's cache: a channel of the
// bus, or the stream open again after a drop.
type CacheRefreshTrigger string

// The triggers of the table.
const (
${triggerConsts.join('\n')}
)

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

// CacheRefresh is one row of the table: the queries a trigger asks again
// for, keeping the value shown meanwhile; those whose new value its event
// carries; and those whose entity its event says is gone.
type CacheRefresh struct {
\tWhen      CacheRefreshWhen
\tReach     CacheRefreshReach
\tRefetches []CacheQuery
\tWrites    []CacheQuery
\tRemoves   []CacheQuery
}

// CacheRefreshTable is each trigger's rows.
var CacheRefreshTable = map[CacheRefreshTrigger][]CacheRefresh{
${table.join('\n')}
}

// cacheEvents is what the client's refresher states each trigger's event
// names. A trigger the table gains is a method it lacks.
type cacheEvents interface {
${eventMethods.join('\n')}
}

// subjectOf is what frame's event names, by its trigger. A payload that is not
// its channel's is the error.
func subjectOf(events cacheEvents, trigger CacheRefreshTrigger, frame Frame) (cacheSubject, error) {
\tswitch trigger {
${eventCases}
\t}
\treturn cacheSubject{}, fmt.Errorf("%s is no trigger of the refresh table", trigger)
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
`;

writeOrCheck(ROOT, OUT, text, CHECK);
if (!CHECK) console.log(`cache refresh: ${queries.length} queries, ${triggers.length} triggers, ${refresh.length} rows`);
