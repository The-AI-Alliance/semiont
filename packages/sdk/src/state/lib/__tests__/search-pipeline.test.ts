/**
 * createSearchPipeline tests
 *
 * Pure RxJS — no React, no jsdom, no act warnings. The pipeline is a plain
 * object: instantiate it with a stub fetch, push values via setQuery, assert
 * on emissions from state$ and query$. Its meaning is the Rust SDK's
 * `SearchPipeline` (packages/sdk-rust/src/state/search.rs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BehaviorSubject, of } from 'rxjs';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';
import { createSearchPipeline, type SearchPipeline, type SearchState } from '../search-pipeline';

describe('createSearchPipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a reader that arrives late the query and the state as they are now', () => {
    const fetch = vi.fn(() => of(['hit']));
    const pipeline = createSearchPipeline<string>(fetch);

    pipeline.setQuery('foo');
    vi.advanceTimersByTime(300);
    const queries: string[] = [];
    const states: SearchState<string>[] = [];
    pipeline.query$.subscribe((q) => queries.push(q));
    pipeline.state$.subscribe((s) => states.push(s));

    expect(queries).toEqual(['foo']);
    expect(states).toEqual([{ results: ['hit'], isSearching: false }]);

    pipeline.dispose();
  });

  it('searches with one search for all its readers', () => {
    const fetch = vi.fn(() => of(['hit']));
    const pipeline = createSearchPipeline<string>(fetch);
    pipeline.state$.subscribe();
    pipeline.state$.subscribe();

    pipeline.setQuery('foo');
    vi.advanceTimersByTime(300);

    expect(fetch).toHaveBeenCalledTimes(1);

    pipeline.dispose();
  });

  it('does not restart the debounce when set to the query it already has', () => {
    const fetch = vi.fn(() => of(['hit']));
    const pipeline = createSearchPipeline<string>(fetch);

    pipeline.setQuery('foo');
    vi.advanceTimersByTime(200);
    pipeline.setQuery('foo');
    vi.advanceTimersByTime(100);

    expect(fetch).toHaveBeenCalledWith('foo');

    pipeline.dispose();
  });
});

describe('SearchPipeline — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms, over a search that never ends', () => {
    assertStateUnitAxioms<SearchPipeline<string>>({
      setup: () =>
        createSearchPipeline<string>(() => new BehaviorSubject<string[] | undefined>(undefined).asObservable(), {
          initialQuery: 'seed',
        }),
      surfaces: (u) => [u.query$, u.state$],
      invocations: (u) => [() => u.setQuery('a'), () => u.setQuery('')],
    });
  });
});
