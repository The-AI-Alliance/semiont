/**
 * What each live query's cache holds, as protocol/specs/src/client/refresh.json's `value` says: a census.
 * `SDK_VALUES` is this SDK's reading of every query's value, the component and the members within it; it
 * is held to refresh.json at test time, row by row, and to the types this SDK's caches hold at compile
 * time (`valueCensus`). A query refresh.json gains fails both: `satisfies` names it, and so does the
 * comparison with the table's rows.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { CacheQuery, components } from '@semiont/core';
import type { CacheObservable } from '../awaitable';
import type { KeptValue } from '../cache-persister';
import type { BrowseNamespace, GatherNamespace, MatchNamespace } from '../namespaces/types';

type Schemas = components['schemas'];

/** What packages/codegen/schemas/cache-refresh-table.mjs reads of a query's `value`. */
interface Value {
  component: string;
  members: string[];
}

type ReadCacheRefresh = (root: string, tablePath: string, refuse: (message: string) => never) => { values: Map<string, Value> };

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const { readCacheRefresh }: { readCacheRefresh: ReadCacheRefresh } = await import(
  fileURLToPath(new URL('../../../../codegen/schemas/cache-refresh-table.mjs', import.meta.url))
);

const { values } = readCacheRefresh(ROOT, `${ROOT}/protocol/specs/src/client/refresh.json`, (message) => {
  throw new Error(message);
});

/**
 * The queries whose `value` waits on a ruling: refresh.json names one, and this SDK is not yet held to it.
 * `engines` is proposed as BrowseEnginesResult's `response.engines`, the engines without their limits.
 */
const WAITING = ['engines'] as const;
type Waiting = (typeof WAITING)[number];

/** Each query's value as this SDK holds it: the component, and the members within it, outermost first. */
const SDK_VALUES = {
  resource: { component: 'ResourceDescriptor', members: [] },
  annotations: { component: 'GetAnnotationsResponse', members: [] },
  annotation: { component: 'Annotation', members: [] },
  events: { component: 'GetEventsResponse', members: ['events'] },
  referencedBy: { component: 'GetReferencedByResponse', members: ['referencedBy'] },
  resources: { component: 'ListResourcesResponse', members: [] },
  matchedResources: { component: 'MatchResourcesResponse', members: [] },
  entityTypes: { component: 'GetEntityTypesResponse', members: ['entityTypes'] },
  tagSchemas: { component: 'GetTagSchemasResponse', members: ['tagSchemas'] },
} as const satisfies { [Q in Exclude<CacheQuery, Waiting>]: { component: keyof Schemas; members: readonly string[] } };
type Mapped = keyof typeof SDK_VALUES;

/** What a live query shows. */
type Shown<O> = O extends CacheObservable<infer V> ? V : never;

/**
 * The type each query's cache holds in this SDK. A kept query's is what its persister reads back; the
 * others' is what their query shows, which is their value whole (`annotations` shows a view of its value,
 * and is kept).
 */
interface SdkValue {
  resource: KeptValue<'resource'>;
  annotations: KeptValue<'annotations'>;
  annotation: KeptValue<'annotation'>;
  events: Shown<ReturnType<BrowseNamespace['events']>>;
  referencedBy: Shown<ReturnType<GatherNamespace['referencedBy']>>;
  resources: Shown<ReturnType<BrowseNamespace['resources']>>;
  matchedResources: Shown<ReturnType<MatchNamespace['resources']>>;
  entityTypes: KeptValue<'entityTypes'>;
  tagSchemas: KeptValue<'tagSchemas'>;
}

/** The member `members` names within `T`, member within member. */
type Walk<T, M extends readonly string[]> = M extends readonly [infer Head, ...infer Rest extends readonly string[]]
  ? Head extends keyof T
    ? Walk<T[Head], Rest>
    : never
  : T;

/** The type of the value `SDK_VALUES` names for a query. */
type NamedValue<Q extends Mapped> = Walk<Schemas[(typeof SDK_VALUES)[Q]['component']], (typeof SDK_VALUES)[Q]['members']>;

/** Each holds every value of the other: the same shape, however it is written. */
type Agrees<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Disagreeing = { [Q in Mapped]: Agrees<SdkValue[Q], NamedValue<Q>> extends true ? never : Q }[Mapped];

/** tsc fails here while any query's cache holds another type than the value `SDK_VALUES` names: `Disagreeing` is those queries. */
const valueCensus: [Disagreeing] extends [never] ? 'agrees' : Disagreeing = 'agrees';

const isMapped = (query: string): query is Mapped => Object.hasOwn(SDK_VALUES, query);

describe("what each live query's cache holds (protocol/specs/src/client/refresh.json's value)", () => {
  it("names every query refresh.json names: those this SDK maps, and those waiting on a ruling", () => {
    expect([...values.keys()].sort()).toEqual([...Object.keys(SDK_VALUES), ...WAITING].sort());
  });

  it.each(Object.keys(SDK_VALUES))('%s: its value is the component and the members this SDK holds it as', (query) => {
    if (!isMapped(query)) throw new Error(`${query} is no query this SDK maps`);
    const { component, members } = SDK_VALUES[query];
    expect(values.get(query)).toEqual({ component, members: [...members] });
  });

  it("the type each query's cache holds is the value it is mapped to", () => {
    expect(valueCensus).toBe('agrees');
  });
});
