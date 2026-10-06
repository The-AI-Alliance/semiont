// cache-refresh-table.mjs — the one reading of specs/src/client/refresh.json
// that every generator of it shares: the queries, and what each trigger does
// to them, held to the registry and to how each trigger is delivered.

import { readFileSync } from 'node:fs';
import { deliveryClasses } from '../bus/delivery.mjs';

/**
 * The table at `tablePath`, checked against the registry at `registryPath`:
 * its queries, its rows, the triggers in the order first stated (`whens`, each
 * with the kinds of event its rows are split by), and the two vocabularies a
 * row is written in. `refuse(message)` is called for a table that cannot be
 * generated from, and does not return.
 */
export function readCacheRefresh(tablePath, registryPath, refuse) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const channels = new Map(registry.channels.map((entry) => [entry.channel, entry]));
  const requests = new Set(registry.operations.map((operation) => operation.request));
  const delivery = deliveryClasses(registry);

  const { queries, refresh } = JSON.parse(readFileSync(tablePath, 'utf8'));
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
  // when the stream is down, so a row it triggers does only what is safe to
  // miss: it refetches, and `reopened` refetches the same queries, which is what
  // repairs the miss.
  const reopened = refresh.find((row) => row.on === 'reopened');
  if (!reopened) refuse('has no row for `reopened`');
  for (const row of refresh) {
    if (row.on === 'reopened' || delivery.get(row.on) !== 'passing') continue;
    // The gateway writes this one itself, on the stream whose subscription it is about: it cannot be missed.
    if (row.on === 'bus:resume-gap') continue;
    for (const act of ['writes', 'removes']) {
      if ((row[act] ?? []).length > 0) refuse(`${row.on} ${act} ${row[act].join(', ')}, and its frames are passing: one lost must leave the cache right`);
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

  return { queries, refresh, whens, WHEN, ACTS };
}
