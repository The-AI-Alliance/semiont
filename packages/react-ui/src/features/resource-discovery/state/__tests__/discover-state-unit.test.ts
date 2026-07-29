import { describe, it, expect, vi } from 'vitest';
import { sessionOf } from '../../../../__tests__/test-client';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { filter, skip, take, toArray } from 'rxjs/operators';
import type { SemiontClient } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../../state/shell-state-unit';
import { createDiscoverStateUnit } from '../discover-state-unit';
import { assertStateUnitAxioms, disposeProbe } from '@semiont/core/testing';

function mockBrowse(): ShellStateUnit {
  return { dispose: vi.fn() } as unknown as ShellStateUnit;
}

interface BrowseFilters {
  limit?: number;
  archived?: boolean;
  search?: string;
  entityType?: string;
}

function mockClient(overrides: {
  resources$?: BehaviorSubject<unknown[] | undefined>;
  entityTypes$?: BehaviorSubject<string[] | undefined>;
  resourcesFn?: (filters: BrowseFilters) => BehaviorSubject<unknown[] | undefined>;
} = {}): { client: SemiontClient; resourceCalls: BrowseFilters[] } {
  const resourceCalls: BrowseFilters[] = [];
  const defaultResources$ =
    overrides.resources$ ?? new BehaviorSubject<unknown[] | undefined>([{ '@id': 'r1' }]);
  const entityTypes$ =
    overrides.entityTypes$ ?? new BehaviorSubject<string[] | undefined>(['Person']);

  const resourcesFn = overrides.resourcesFn ?? (() => defaultResources$);

  const client = {
    browse: {
      resources: (filters: BrowseFilters = {}) => {
        resourceCalls.push(filters);
        return resourcesFn(filters).asObservable();
      },
      entityTypes: () => entityTypes$.asObservable(),
    },
  } as unknown as SemiontClient;

  return { client, resourceCalls };
}

describe('createDiscoverStateUnit', () => {
  it('exposes recent resources from browse namespace', async () => {
    const { client } = mockClient();
    const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    const recent = await firstValueFrom(stateUnit.recent.value$);
    expect(recent).toEqual([{ '@id': 'r1' }]);

    stateUnit.dispose();
  });

  it('exposes entity types from browse namespace', async () => {
    const { client } = mockClient();
    const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    const types = await firstValueFrom(stateUnit.entityTypes.value$);
    expect(types).toEqual(['Person']);

    stateUnit.dispose();
  });

  it('falls back to [] when entityTypes() emits undefined', async () => {
    const entityTypes$ = new BehaviorSubject<string[] | undefined>(undefined);
    const { client } = mockClient({ entityTypes$ });
    const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    const types = await firstValueFrom(stateUnit.entityTypes.value$);
    expect(types).toEqual([]);

    stateUnit.dispose();
  });

  it('reports loading when resources are undefined', async () => {
    const resources$ = new BehaviorSubject<unknown[] | undefined>(undefined);
    const { client } = mockClient({ resources$ });
    const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    const loading = await firstValueFrom(stateUnit.recent.loading$);
    expect(loading).toBe(true);

    resources$.next([]);
    const loaded = await firstValueFrom(stateUnit.recent.loading$.pipe(filter((l) => !l)));
    expect(loaded).toBe(false);

    stateUnit.dispose();
  });

  it('exposes a search pipeline', () => {
    const { client } = mockClient();
    const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    expect(stateUnit.search).toBeDefined();
    expect(typeof stateUnit.search.setQuery).toBe('function');
    expect(stateUnit.search.state$).toBeDefined();

    stateUnit.dispose();
  });

  it('initial selectedEntityType$ is empty and recent fetch carries no entityType', async () => {
    const { client, resourceCalls } = mockClient();
    const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    await firstValueFrom(stateUnit.recent.value$);

    expect(resourceCalls).toHaveLength(1);
    expect(resourceCalls[0]).toEqual({ limit: 10, archived: false });
    expect(await firstValueFrom(stateUnit.selectedEntityType$)).toBe('');

    stateUnit.dispose();
  });

  it('setSelectedEntityType drives a refetch with the entityType filter', async () => {
    const { client, resourceCalls } = mockClient();
    const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    // Prime the first subscription so the switchMap is live.
    const sub = stateUnit.recent.value$.subscribe();

    stateUnit.setSelectedEntityType('Person');

    expect(await firstValueFrom(stateUnit.selectedEntityType$)).toBe('Person');
    // Two calls expected: initial '' then 'Person'.
    expect(resourceCalls.length).toBeGreaterThanOrEqual(2);
    expect(resourceCalls.at(-1)).toEqual({ limit: 10, archived: false, entityType: 'Person' });

    sub.unsubscribe();
    stateUnit.dispose();
  });

  it('search with an empty query yields no results without hitting the wire', async () => {
    vi.useFakeTimers();
    try {
      const { client, resourceCalls } = mockClient();
      const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

      const collected: Array<{ results: unknown[]; isSearching: boolean }> = [];
      const sub = stateUnit.search.state$.subscribe((s) => collected.push(s));

      await vi.advanceTimersByTimeAsync(300);

      expect(collected.at(-1)).toEqual({ results: [], isSearching: false });
      const searchCalls = resourceCalls.filter((c) => c.search !== undefined);
      expect(searchCalls).toHaveLength(0);

      sub.unsubscribe();
      stateUnit.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('search with a non-empty query and selected entityType pushes both into the filter', async () => {
    vi.useFakeTimers();
    try {
      const results$ = new BehaviorSubject<unknown[] | undefined>([{ '@id': 'hit' }]);
      const { client, resourceCalls } = mockClient({
        resourcesFn: (filters) => (filters.search ? results$ : new BehaviorSubject<unknown[] | undefined>([])),
      });
      const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

      const sub = stateUnit.search.state$.subscribe();
      stateUnit.setSelectedEntityType('Person');
      stateUnit.search.setQuery('lincoln');

      await vi.advanceTimersByTimeAsync(300);

      const searchCalls = resourceCalls.filter((c) => c.search !== undefined);
      expect(searchCalls.length).toBeGreaterThanOrEqual(1);
      expect(searchCalls.at(-1)).toEqual({
        search: 'lincoln',
        limit: 20,
        entityType: 'Person',
      });

      sub.unsubscribe();
      stateUnit.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('search results flow through state$ once the debounced query fetches', async () => {
    vi.useFakeTimers();
    try {
      const results$ = new BehaviorSubject<unknown[] | undefined>([{ '@id': 'hit' }]);
      const { client } = mockClient({
        resourcesFn: () => results$,
      });
      const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

      const collected: Array<{ results: unknown[]; isSearching: boolean }> = [];
      const sub = stateUnit.search.state$.subscribe((s) => collected.push(s));

      stateUnit.search.setQuery('lincoln');
      await vi.advanceTimersByTimeAsync(300);

      expect(collected.at(-1)).toEqual({ results: [{ '@id': 'hit' }], isSearching: false });

      sub.unsubscribe();
      stateUnit.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('search reports isSearching while the fetch is in flight', async () => {
    vi.useFakeTimers();
    try {
      const inflight$ = new BehaviorSubject<unknown[] | undefined>(undefined);
      const { client } = mockClient({
        resourcesFn: () => inflight$,
      });
      const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

      const collected: Array<{ results: unknown[]; isSearching: boolean }> = [];
      const sub = stateUnit.search.state$.subscribe((s) => collected.push(s));

      stateUnit.search.setQuery('lincoln');
      await vi.advanceTimersByTimeAsync(300);

      expect(collected.at(-1)).toEqual({ results: [], isSearching: true });

      sub.unsubscribe();
      stateUnit.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('search query observable echoes the latest setQuery value', async () => {
    const { client } = mockClient();
    const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    const queries = stateUnit.search.query$.pipe(skip(1), take(1), toArray()).toPromise();
    stateUnit.search.setQuery('alpha');

    expect(await queries).toEqual(['alpha']);

    stateUnit.dispose();
  });

  it('omits entityType from the filter when the empty sentinel is selected', async () => {
    const { client, resourceCalls } = mockClient();
    const stateUnit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    const sub = stateUnit.recent.value$.subscribe();
    stateUnit.setSelectedEntityType('Person');
    stateUnit.setSelectedEntityType('');

    const last = resourceCalls.at(-1)!;
    expect(last.entityType).toBeUndefined();

    sub.unsubscribe();
    stateUnit.dispose();
  });
});

describe('DiscoverStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms (incl. A7-passed: never disposes the injected browse)', () => {
    assertStateUnitAxioms({
      setup: () => {
        const browse = disposeProbe();
        const { client } = mockClient();
        return { unit: createDiscoverStateUnit(sessionOf(client), browse as unknown as ShellStateUnit), passedIn: [browse] };
      },
      surfaces: (u) => [u.selectedEntityType$],
      invocations: (u) => [() => u.setSelectedEntityType('')],
    });
  });
});

describe('createDiscoverStateUnit — terminal load failure', () => {
  // `isLoadingRecent$` was `recent$.pipe(map(r => r === undefined))`, so a
  // terminally failed list (B15) — which has no value either — left
  // /know/discover spinning for ever. Same defect as the References and
  // History panels. See .plans/PANEL-FAILURE-STATES.md

  it('recent: stops loading and surfaces the reason instead of spinning for ever', async () => {
    const resources$ = new BehaviorSubject<unknown[] | undefined>(undefined);
    const { client } = mockClient({ resources$ });
    const unit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    expect(await firstValueFrom(unit.recent.loading$)).toBe(true);
    resources$.error(new Error('Resource not found'));

    expect(await firstValueFrom(unit.recent.loading$)).toBe(false);
    expect((await firstValueFrom(unit.recent.error$) as Error | null)?.message)
      .toBe('Resource not found');

    unit.dispose();
  });

  it('entityTypes: same, and keeps an empty list to render', async () => {
    const entityTypes$ = new BehaviorSubject<string[] | undefined>(undefined);
    const { client } = mockClient({ entityTypes$ });
    const unit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    entityTypes$.error(new Error('boom'));

    expect(await firstValueFrom(unit.entityTypes.loading$)).toBe(false);
    expect(await firstValueFrom(unit.entityTypes.error$)).not.toBeNull();
    expect(await firstValueFrom(unit.entityTypes.value$)).toEqual([]);

    unit.dispose();
  });

  it('recent.retry() re-issues the query and can recover', async () => {
    // A fresh `observe()` is what clears the B15 marker, so retry must reach
    // `browse.resources()` again rather than re-subscribing to a dead stream.
    const attempts: BehaviorSubject<unknown[] | undefined>[] = [];
    const { client } = mockClient({
      resourcesFn: () => {
        const s = new BehaviorSubject<unknown[] | undefined>(undefined);
        attempts.push(s);
        return s;
      },
    });
    const unit = createDiscoverStateUnit(sessionOf(client), mockBrowse());

    attempts[0]!.error(new Error('nope'));
    expect(await firstValueFrom(unit.recent.error$)).not.toBeNull();

    unit.recent.retry();
    expect(attempts.length).toBeGreaterThan(1);
    expect(await firstValueFrom(unit.recent.error$)).toBeNull();

    attempts[attempts.length - 1]!.next([{ '@id': 'r1' }]);
    expect(await firstValueFrom(unit.recent.value$)).toHaveLength(1);
    expect(await firstValueFrom(unit.recent.loading$)).toBe(false);

    unit.dispose();
  });
});
