/**
 * The live cases built from specs/src/client/refresh.json: one per row. Each
 * has a client observe every live query the table names, of one resource, and
 * a second resource and an annotation of it, which no event of the case names;
 * causes the row's trigger; and expects exactly what the row says of the cache:
 * a request for each query it refetches, of the keys it reaches, the written
 * value where it writes, `bus.not-found` where it removes, and nothing else.
 *
 * A row is held by being here, so a table that grows a trigger this file
 * cannot cause fails the suite rather than going unheld.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_SOURCE } from '../harness/paths';
import { operationFor, registry } from '../harness/spec';
import { caseOf, type Case, type Step } from './case';

interface Query {
  name: string;
  per?: 'resource' | 'annotation' | 'filters';
  asks: string;
}

interface Row {
  on: string;
  when?: 'enriched' | 'unenriched';
  reach?: 'subject' | 'held';
  refetches?: string[];
  writes?: string[];
  removes?: string[];
  docs: string;
}

type FetchStep = Extract<Step, { fetch: string }>;

const V = (name: string): { $var: string } => ({ $var: name });

const TIMING = { busRequestTimeoutMs: 5000, invalidationWindowMs: 100, reconnectMs: 50, lazyRemoveMs: 50, lingerMs: 50 };

const resource = (name: string): unknown => ({ '@context': 'https://schema.org/', '@id': name, name, representations: [] });
const annotation = (id: string, of: string, motivation: string): unknown => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: V(id),
  motivation,
  target: { source: V(of) },
  created: '2026-01-01T00:00:00.000Z',
});
/** The subject's annotation as the services first answer with it, and as an enriched event says it now is; and the other resource's. */
const ANNOTATION = annotation('a1', 'r1', 'highlighting');
const UPDATED = annotation('a1', 'r1', 'commenting');
const OTHER = annotation('a2', 'r2', 'highlighting');
const LIST = { resources: [], total: 0, offset: 0, limit: 100, matchKind: 'lexical' };

/** The operations a refresh of the collaborator directory asks beside its own: each key holder's limits. */
const limitsOperations = (): string[] => registry().operations.map((operation) => operation.request).filter((request) => request.endsWith(':limits-requested'));

/** One request a query makes, and the answer the suite gives it. */
interface Ask {
  operation: string;
  payload?: unknown;
  response: unknown;
}

/** One key the client holds: the observer that holds it, what observing it asks, and the value it then shows. */
interface Held {
  observer: string;
  query: string;
  /** The resource whose key it is, for a query kept per resource or per annotation. */
  of?: 'r1' | 'r2';
  observe: Record<string, unknown>;
  asks: Ask[];
  value: unknown;
}

function held(): Held[] {
  const perResource = (observer: string, query: string, of: 'r1' | 'r2', operation: string, response: unknown, value: unknown): Held => ({
    observer,
    query,
    of,
    observe: { query, resource: V(of) },
    asks: [{ operation, payload: { resourceId: V(of) }, response }],
    value,
  });
  return [
    perResource('one', 'resource', 'r1', 'browse:resource-requested', { resource: resource('one'), annotations: [], entityReferences: [] }, resource('one')),
    perResource('two', 'resource', 'r2', 'browse:resource-requested', { resource: resource('two'), annotations: [], entityReferences: [] }, resource('two')),
    perResource('marks', 'annotations', 'r1', 'browse:annotations-requested', { annotations: [ANNOTATION], total: 1 }, [ANNOTATION]),
    {
      observer: 'mark',
      query: 'annotation',
      of: 'r1',
      observe: { query: 'annotation', resource: V('r1'), annotation: V('a1') },
      asks: [{ operation: 'browse:annotation-requested', payload: { resourceId: V('r1'), annotationId: V('a1') }, response: { annotation: ANNOTATION, resource: null, resolvedResource: null } }],
      value: ANNOTATION,
    },
    {
      observer: 'otherMark',
      query: 'annotation',
      of: 'r2',
      observe: { query: 'annotation', resource: V('r2'), annotation: V('a2') },
      asks: [{ operation: 'browse:annotation-requested', payload: { resourceId: V('r2'), annotationId: V('a2') }, response: { annotation: OTHER, resource: null, resolvedResource: null } }],
      value: OTHER,
    },
    perResource('history', 'events', 'r1', 'browse:events-requested', { events: [], total: 0, resourceId: V('r1') }, []),
    perResource('citing', 'referencedBy', 'r1', 'browse:referenced-by-requested', { referencedBy: [] }, []),
    { observer: 'list', query: 'resources', observe: { query: 'resources' }, asks: [{ operation: 'browse:resources-requested', payload: { limit: 100, offset: 0 }, response: LIST }], value: LIST },
    { observer: 'types', query: 'entityTypes', observe: { query: 'entityTypes' }, asks: [{ operation: 'browse:entity-types-requested', response: { entityTypes: ['Person'] } }], value: ['Person'] },
    { observer: 'schemas', query: 'tagSchemas', observe: { query: 'tagSchemas' }, asks: [{ operation: 'browse:tag-schemas-requested', response: { tagSchemas: [] } }], value: [] },
    {
      observer: 'directory',
      query: 'agents',
      observe: { query: 'agents' },
      asks: [{ operation: 'browse:agents-requested', response: { agents: [] } }, ...limitsOperations().map((operation) => ({ operation, response: { limits: [] } }))],
      value: [],
    },
  ];
}

/** Steps that expect `asks`, in whatever order the client makes them, and answer each. `tag` keeps their names apart. */
function asked(asks: Ask[], tag: string): Step[] {
  if (asks.length === 0) return [];
  const fetches: FetchStep[] = asks.map((ask, index) => ({ fetch: ask.operation, ...(ask.payload === undefined ? {} : { payload: ask.payload }), as: `${tag}${index + 1}` }));
  return [
    fetches.length === 1 ? fetches[0]! : { fetches },
    ...asks.map((ask, index): Step => ({ backend: 'emit', with: { channel: operationFor(ask.operation).result, correlationId: V(`${tag}${index + 1}`), payload: { response: ask.response } } })),
  ];
}

const record = (channel: string, extra: Record<string, unknown> = {}): Step => ({
  backend: 'record',
  // On the resource's scope unless the channel is one every client hears.
  with: { resource: V('r1'), channel, sequence: 1, live: true, ...(registry().audience.scoped.includes(channel) ? {} : { unscoped: true }), ...extra },
});

/** The keys of `holding` a row's refetch reaches, as the requests that ask for them again. */
function refetched(row: Row, holding: Held[]): Ask[] {
  return (row.refetches ?? []).flatMap((query) =>
    holding.filter((key) => key.query === query && (row.reach === 'held' || key.of === undefined || key.of === 'r1')).flatMap((key) => key.asks),
  );
}

/** How each trigger is caused. The steps leave the client having heard it, and nothing else. */
function cause(row: Row, all: Row[], holding: Held[]): Step[] {
  switch (row.on) {
    case 'reopened':
      return [{ backend: 'cut' }, { state: 'reconnecting' }, { state: 'open' }];
    case 'bus:resume-gap': {
      // A gap with no drop: the scope is let go and taken again, with the
      // watermark an event left it, while the record cannot be read.
      const added = all.find((other) => other.on === 'mark:added');
      if (!added) throw new Error('causing bus:resume-gap takes a mark:added, which the table has no row for');
      const ofScope = holding.filter((key) => key.of === 'r1');
      return [
        record('mark:added'),
        ...asked(refetched(added, holding), 'watermark'),
        ...ofScope.map((key): Step => ({ leave: key.observer })),
        { scopes: [V('r2')] },
        { backend: 'archivist', with: { replayFails: true } },
        ...ofScope.flatMap((key): Step[] => [
          { observe: key.observe, as: `${key.observer}Again` },
          { reaches: `${key.observer}Again`, state: { status: 'ready', value: key.value } },
        ]),
      ];
    }
    case 'mark:delete-ok':
      return [
        { driver: 'delete', with: { resource: V('r1'), annotation: V('a1') }, as: 'deleted' },
        { fetch: 'mark:delete', payload: { annotationId: V('a1'), resourceId: V('r1') }, as: 'deletion' },
        { backend: 'emit', with: { channel: 'mark:delete-ok', correlationId: V('deletion'), payload: { response: { annotationId: V('a1') } } } },
        { settles: 'deleted' },
      ];
    case 'mark:removed':
      return [record(row.on, { payload: { annotationId: V('a1') } })];
    case 'mark:body-updated':
      return [record(row.on, { payload: { annotationId: V('a1'), operations: [] }, ...(row.when === 'enriched' ? { enriched: { annotation: UPDATED } } : {}) })];
    case 'mark:added':
    case 'mark:entity-tag-added':
    case 'mark:entity-tag-removed':
    case 'mark:archived':
    case 'mark:unarchived':
    case 'yield:created':
    case 'yield:updated':
    case 'yield:cloned':
    case 'yield:moved':
    case 'frame:entity-type-added':
    case 'frame:tag-schema-added':
      return [record(row.on)];
    default:
      throw new Error(`specs/src/client/refresh.json has a row for ${row.on}, which refresh-cases.ts cannot cause`);
  }
}

function built(row: Row, all: Row[], queries: Query[]): Case {
  const holding = held();
  const unheld = queries.filter((query) => !holding.some((key) => key.query === query.name));
  if (unheld.length > 0) throw new Error(`refresh-cases.ts observes no ${unheld.map((query) => query.name).join(', ')}, which specs/src/client/refresh.json names`);
  for (const key of holding) {
    const stated = queries.find((query) => query.name === key.query)!.asks;
    if (key.asks[0]!.operation !== stated) throw new Error(`refresh-cases.ts asks ${key.asks[0]!.operation} for ${key.query}; the table says ${stated}`);
  }

  // After a gap the keys of the scope are held by the observers that took it again.
  const holder = (key: Held): string => (row.on === 'bus:resume-gap' && key.of === 'r1' ? `${key.observer}Again` : key.observer);
  const acted = (queries: string[] | undefined): Held[] => holding.filter((key) => (queries ?? []).includes(key.query) && key.of !== 'r2');
  const written: Record<string, unknown> = { annotations: [UPDATED], annotation: UPDATED };

  const requests = [...holding.flatMap((key) => key.asks.map((ask) => ask.operation)), 'mark:delete'];
  const steps: Step[] = [
    { backend: 'listen', with: { channels: [...new Set(requests)] } },
    { driver: 'open', with: { timing: TIMING } },
    { state: 'open' },
    ...holding.flatMap((key, index): Step[] => [
      { observe: key.observe, as: key.observer },
      ...asked(key.asks, `first${index + 1}x`),
      { reaches: key.observer, state: { status: 'ready', value: key.value } },
    ]),
    { scopes: [V('r1'), V('r2')] },
    ...cause(row, all, holding),
    ...asked(refetched(row, holding), 'again'),
    ...acted(row.writes).map((key): Step => {
      if (!(key.query in written)) throw new Error(`${row.on} writes ${key.query}, which refresh-cases.ts has no written value for`);
      return { reaches: holder(key), state: { status: 'ready', value: written[key.query] } };
    }),
    ...acted(row.removes).map((key): Step => ({ reaches: holder(key), state: { status: 'failed', error: { code: 'bus.not-found' } } })),
    { scopes: [V('r1'), V('r2')] },
    { quiet: 400 },
  ];

  const label = row.when === undefined ? row.on : `${row.on}, ${row.when}`;
  return caseOf(`refresh-${row.on.replaceAll(':', '-')}${row.when === undefined ? '' : `-${row.when}`}`, {
    about: `${label}: ${row.docs.charAt(0).toLowerCase()}${row.docs.slice(1)}`,
    source: 'specs/src/client/refresh.json',
    tier: 'parity',
    steps,
  });
}

/** A live case for every row of the refresh table. */
export function refreshCases(): Case[] {
  const { queries, refresh } = JSON.parse(readFileSync(join(SPEC_SOURCE, 'client/refresh.json'), 'utf8')) as { queries: Query[]; refresh: Row[] };
  return refresh.map((row) => built(row, refresh, queries));
}
