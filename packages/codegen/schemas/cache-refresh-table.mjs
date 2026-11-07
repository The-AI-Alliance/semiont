// cache-refresh-table.mjs — the one reading of protocol/specs/src/client/refresh.json
// that every generator of it shares: the queries, and what each trigger does
// to them, held to the registry, the gateway's API, how each trigger is
// delivered and the schema of each channel's events.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deliveryClasses } from '../bus/delivery.mjs';
import { storedEventComponent } from '../bus/stored-event.mjs';
import { readRequiredShapes } from './required-shapes.mjs';

/** The trigger that is the stream open again after a drop. */
export const REOPENED = 'reopened';
/** The trigger that is an event on one of the table's channels that cannot be read. */
export const UNREADABLE = 'unreadable';

/** What each way a row `names`, and the way it `carries`, ends at: the component of that name. */
export const WAY_ENDS = { resource: 'ResourceId', annotation: 'AnnotationId', carries: 'Annotation' };

/**
 * The table at `tablePath`, checked against the registry, the gateway's API
 * and the component schemas of the spec under `root`: its queries, its rows,
 * the triggers in the order first stated (`whens`, each with the kinds of
 * event its rows are split by), those of them that are channels, and the two
 * vocabularies a row is written in. `refuse(message)` is called for a table
 * that cannot be generated from, and does not return.
 */
export function readCacheRefresh(root, tablePath, refuse) {
  const specs = resolve(root, 'protocol/specs/src');
  const apiPath = resolve(specs, 'openapi.json');
  const registry = JSON.parse(readFileSync(resolve(specs, 'bus/registry.json'), 'utf8'));
  const { shapes } = readRequiredShapes(root, refuse);
  // A path of the API's source is a file of its own, named by `$ref`.
  const pathItem = (item) => ('$ref' in item ? JSON.parse(readFileSync(resolve(dirname(apiPath), item.$ref), 'utf8')) : item);
  const reads = new Set(
    Object.entries(JSON.parse(readFileSync(apiPath, 'utf8')).paths).flatMap(([template, item]) =>
      'get' in pathItem(item) ? [`GET ${template}`] : [],
    ),
  );
  const channels = new Map(registry.channels.map((entry) => [entry.channel, entry]));
  const requests = new Set(registry.operations.map((operation) => operation.request));
  const delivery = deliveryClasses(registry);

  const { queries, refresh } = JSON.parse(readFileSync(tablePath, 'utf8'));
  if (!Array.isArray(queries) || queries.length === 0) refuse('lists no queries');
  if (!Array.isArray(refresh) || refresh.length === 0) refuse('lists no refresh');

  const PER = ['resource', 'annotation', 'filters'];
  const queryNames = new Set();
  for (const query of queries) {
    const { name, per, asks, docs } = query;
    const read = query.reads;
    if (typeof name !== 'string' || !/^[a-z][A-Za-z]*$/.test(name)) refuse(`${JSON.stringify(name)} is not a query's name: camelCase`);
    if (queryNames.has(name)) refuse(`the query ${name} is stated twice`);
    queryNames.add(name);
    if (typeof docs !== 'string' || docs === '') refuse(`the query ${name} has no docs`);
    if ((asks === undefined) === (read === undefined)) refuse(`the query ${name} must either ask an operation of the registry or read a route of the gateway's API, and not both`);
    if (asks !== undefined && !requests.has(asks)) refuse(`the query ${name} asks ${JSON.stringify(asks)}, which is not an operation of the registry`);
    if (read !== undefined && !reads.has(read)) refuse(`the query ${name} reads ${JSON.stringify(read)}, which is no GET of the gateway's API`);
    if (per !== undefined && !PER.includes(per)) refuse(`the query ${name} is kept per ${JSON.stringify(per)}: one of ${PER.join(', ')}, or absent`);
  }

  /** The shape of the member `name` of a value of `shape`, where `shape` states one. */
  const memberOf = (shape, name) => {
    if (shape.ref !== undefined) return memberOf(shapes.get(shape.ref), name);
    if (shape.members?.[name] !== undefined) return shape.members[name];
    for (const part of shape.allOf ?? []) {
      const found = memberOf(part, name);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  /** The component the way `way` ends at, in an event of `channel`, or the refusal of `label`'s `slot`. */
  const endOf = (channel, way, label, slot) => {
    if (typeof way !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(way)) {
      refuse(`${label}: ${slot} is a way to a member, the names of the members it is within and its own joined by dots`);
    }
    const entry = channels.get(channel);
    const envelope = entry.shape === 'schema' ? entry.schema : storedEventComponent(entry);
    let shape = { ref: envelope };
    const names = way.split('.');
    names.forEach((name, at) => {
      // StoredEventResponse leaves its `payload` open; the registry names the schema of each channel's.
      const member = at === 0 && name === 'payload' && entry.shape === 'storedEvent' ? { ref: entry.payload } : memberOf(shape, name);
      if (member === undefined) refuse(`${label}: ${slot} is ${way}, and ${[envelope, ...names.slice(0, at)].join('.')} has no member ${name}`);
      shape = member;
    });
    return shape.ref;
  };

  const ACTS = ['refetches', 'writes', 'removes'];
  const WHEN = ['enriched', 'unenriched'];
  const whens = new Map();
  for (const row of refresh) {
    const { on, when, reach = 'subject', names, carries, docs } = row;
    const label = when === undefined ? on : `${on} (${when})`;
    const channel = channels.has(on);
    if (!channel && on !== REOPENED && on !== UNREADABLE) refuse(`${JSON.stringify(on)} is neither a channel of the registry nor \`${REOPENED}\` nor \`${UNREADABLE}\``);
    if (typeof docs !== 'string' || docs === '') refuse(`${label} has no docs`);
    if (!['subject', 'held'].includes(reach)) refuse(`${label} reaches ${JSON.stringify(reach)}: subject or held`);
    if (!channel && reach !== 'held') refuse(`${on} is no event, so it names no subject and reaches what is held`);
    if (when !== undefined) {
      if (!WHEN.includes(when)) refuse(`${on} is split by ${JSON.stringify(when)}: one of ${WHEN.join(', ')}`);
      if (channels.get(on)?.enriched !== true) refuse(`${on} is split by ${when}, and the registry does not say its events are enriched`);
    }

    if (names !== undefined) {
      if (!channel) refuse(`${on} is no event, so it names no subject and reaches what is held`);
      if (reach !== 'subject') refuse(`${label} names a subject, and reaches what is held`);
      if (typeof names !== 'object' || names === null || Array.isArray(names)) refuse(`${label}: names is an object`);
      for (const [slot, way] of Object.entries(names)) {
        if (!(slot in WAY_ENDS) || slot === 'carries') refuse(`${label} names a ${slot}: it names a resource and an annotation`);
        const end = endOf(on, way, label, `names.${slot}`);
        if (end !== WAY_ENDS[slot]) refuse(`${label}: names.${slot} is ${way}, which ends at ${end ?? 'no component'}, not at ${WAY_ENDS[slot]}`);
      }
      if (names.resource !== undefined && channels.get(on).system === true) refuse(`${label} names a resource, and the registry says its events are the knowledge base's, of no resource`);
    }
    if (carries !== undefined) {
      if (!channel) refuse(`${on} is no event, so it carries no value`);
      const end = endOf(on, carries, label, 'carries');
      if (end !== WAY_ENDS.carries) refuse(`${label}: carries is ${carries}, which ends at ${end ?? 'no component'}, not at ${WAY_ENDS.carries}`);
    }
    if ((carries !== undefined) !== (row.writes ?? []).length > 0) refuse(`${label} writes what the event carries, so it states both what it writes and the way to what it carries, or neither`);
    if (when !== undefined && (carries !== undefined) !== (when === 'enriched')) refuse(`${label}: an enriched row carries the value that makes it enriched, and an unenriched one carries none`);
    const stated = whens.get(on) ?? [];
    if (stated.includes(when)) refuse(`${label} is stated twice`);
    whens.set(on, [...stated, when]);

    const acted = new Set();
    for (const act of ACTS) {
      const list = row[act] ?? [];
      if (!Array.isArray(list)) refuse(`${label}: ${act} is a list of queries`);
      for (const query of list) {
        if (!queryNames.has(query)) refuse(`${label} ${act} ${JSON.stringify(query)}, which is not a query`);
        if (acted.has(query)) refuse(`${label} acts on ${query} twice`);
        acted.add(query);
      }
    }
    if (acted.size === 0) refuse(`${label} does nothing`);
    const unknown = Object.keys(row).filter((key) => !['on', 'when', 'reach', 'names', 'carries', 'docs', ...ACTS].includes(key));
    if (unknown.length > 0) refuse(`${label} states ${unknown.join(', ')}, which a row does not have`);
  }
  // What a row may do follows from how its trigger is delivered
  // (protocol/contract/TRANSPORT-CONTRACT.md § Delivery). A passing frame is lost
  // when the stream is down, so a row it triggers does only what is safe to
  // miss: it refetches, and `reopened` refetches the same queries, which is what
  // repairs the miss.
  const reopened = refresh.find((row) => row.on === REOPENED);
  if (!reopened) refuse(`has no row for \`${REOPENED}\``);
  if (!refresh.some((row) => row.on === UNREADABLE)) refuse(`has no row for \`${UNREADABLE}\``);
  for (const row of refresh) {
    if (!channels.has(row.on) || delivery.get(row.on) !== 'passing') continue;
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

  return { queries, refresh, whens, channelTriggers: [...whens.keys()].filter((on) => channels.has(on)), WHEN, ACTS };
}
