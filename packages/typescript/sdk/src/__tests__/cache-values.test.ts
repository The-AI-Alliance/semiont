/**
 * What each live query's cache holds, as protocol/specs/src/client/refresh.json's `value` says. The mapping
 * is generated (packages/codegen/schemas/generate-cache-refresh.mjs): `CACHE_VALUES`, each query's component
 * and the members within it, and `CacheValues`, the type each names, which types the namespaces' caches.
 * Held here: that the generated mapping names refresh.json's rows, and, at compile time (`shownCensus`), that
 * what each live query shows, which namespaces/types.ts writes by hand in the names consumers read
 * (`ResourceDescriptor`, `ResourceList`, …), is its cache's value. `annotations` shows its value's
 * annotations. `engines` shows a view no component is, each engine joined with its limits
 * (`EngineWithLimits`), so generation cannot name it, and nothing here holds it.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CACHE_QUERIES, CACHE_VALUES, type CacheQuery, type CacheValues } from '@semiont/core';
import type { CacheObservable } from '../awaitable';
import type { BrowseNamespace, GatherNamespace, MatchNamespace } from '../namespaces/types';

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

const isQuery = (name: string): name is CacheQuery => Object.hasOwn(CACHE_VALUES, name);

/** What a live query shows. */
type Shown<O> = O extends CacheObservable<infer V> ? V : never;

/** The queries whose live query shows what generation names: all but `engines`. */
type Named = Exclude<CacheQuery, 'engines'>;

/** What each live query shows, as its namespace declares it. */
interface ShownByQuery {
  resource: Shown<ReturnType<BrowseNamespace['resource']>>;
  annotations: Shown<ReturnType<BrowseNamespace['annotations']>>;
  annotation: Shown<ReturnType<BrowseNamespace['annotation']>>;
  events: Shown<ReturnType<BrowseNamespace['events']>>;
  referencedBy: Shown<ReturnType<GatherNamespace['referencedBy']>>;
  resources: Shown<ReturnType<BrowseNamespace['resources']>>;
  matchedResources: Shown<ReturnType<MatchNamespace['resources']>>;
  entityTypes: Shown<ReturnType<BrowseNamespace['entityTypes']>>;
  tagSchemas: Shown<ReturnType<BrowseNamespace['tagSchemas']>>;
}

/** What of its cache's value each live query shows: the value, or `annotations`' annotations. */
type ShownOfValue<Q extends Named> = Q extends 'annotations' ? CacheValues['annotations']['annotations'] : CacheValues[Q];

/** Each holds every value of the other: the same shape, however it is written. */
type Agrees<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Disagreeing = { [Q in Named]: Agrees<ShownByQuery[Q], ShownOfValue<Q>> extends true ? never : Q }[Named];

/** tsc fails here while any live query shows another type than its cache's value: `Disagreeing` is those queries. */
const shownCensus: [Disagreeing] extends [never] ? 'agrees' : Disagreeing = 'agrees';

describe("what each live query's cache holds (protocol/specs/src/client/refresh.json's value)", () => {
  it('the generated mapping names every query refresh.json names, in its order, and no other', () => {
    expect(Object.keys(CACHE_VALUES)).toEqual([...values.keys()]);
    expect(Object.keys(CACHE_VALUES)).toEqual([...CACHE_QUERIES]);
  });

  it.each([...values.keys()])("%s: the generated mapping names refresh.json's component and members", (query) => {
    if (!isQuery(query)) throw new Error(`refresh.json names ${query}, which the generated mapping does not`);
    expect(CACHE_VALUES[query]).toEqual(values.get(query));
  });

  it("what each live query shows is its cache's value", () => {
    expect(shownCensus).toBe('agrees');
  });
});
