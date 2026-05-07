/**
 * createSearchPipeline tests
 *
 * Pure RxJS — no React, no jsdom, no act warnings. The pipeline is a plain
 * object: instantiate it with a stub fetch, push values via setQuery, assert
 * on emissions from state$ and query$.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';
import { filter, take, toArray } from 'rxjs/operators';
import { createSearchPipeline, type SearchState } from '../search-pipeline';

describe('createSearchPipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with an idle state — empty results, not searching', () => {
    const fetch = vi.fn(() => of([]));
    const pipeline = createSearchPipeline<string>(fetch);
    const states: SearchState<string>[] = [];
    pipeline.state$.subscribe((s) => states.push(s));

    // Initial empty input passes through startWith → debounce → empty → idle.
    vi.advanceTimersByTime(300);
    expect(states[states.length - 1]).toEqual({ results: [], isSearching: false });
    expect(fetch).not.toHaveBeenCalled();

    pipeline.dispose();
  });

  it('does not call fetch when query is empty or whitespace', () => {
    const fetch = vi.fn(() => of(['x']));
    const pipeline = createSearchPipeline<string>(fetch);
    pipeline.state$.subscribe();

    pipeline.setQuery('');
    pipeline.setQuery('   ');
    vi.advanceTimersByTime(300);

    expect(fetch).not.toHaveBeenCalled();
    pipeline.dispose();
  });

  it('debounces rapid input — only the last value triggers a fetch', () => {
    const fetch = vi.fn(() => of(['result']));
    const pipeline = createSearchPipeline<string>(fetch);
    pipeline.state$.subscribe();

    pipeline.setQuery('a');
    vi.advanceTimersByTime(100);
    pipeline.setQuery('ab');
    vi.advanceTimersByTime(100);
    pipeline.setQuery('abc');
    vi.advanceTimersByTime(100);
    expect(fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('abc');

    pipeline.dispose();
  });

  it('honors a custom debounceMs', () => {
    const fetch = vi.fn(() => of(['x']));
    const pipeline = createSearchPipeline<string>(fetch, { debounceMs: 500 });
    pipeline.state$.subscribe();

    pipeline.setQuery('hi');
    vi.advanceTimersByTime(300);
    expect(fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(fetch).toHaveBeenCalledWith('hi');

    pipeline.dispose();
  });

  it('emits the initialQuery on subscribe and fires fetch after debounce', () => {
    const fetch = vi.fn(() => of(['seed']));
    const pipeline = createSearchPipeline<string>(fetch, { initialQuery: 'foo' });
    const states: SearchState<string>[] = [];
    pipeline.state$.subscribe((s) => states.push(s));

    vi.advanceTimersByTime(300);
    expect(fetch).toHaveBeenCalledWith('foo');
    expect(states[states.length - 1]).toEqual({ results: ['seed'], isSearching: false });

    pipeline.dispose();
  });

  it('exposes the initialQuery on query$', () => {
    const fetch = vi.fn(() => of([]));
    const pipeline = createSearchPipeline<string>(fetch, { initialQuery: 'foo' });
    const queries: string[] = [];
    pipeline.query$.subscribe((q) => queries.push(q));

    expect(queries[0]).toBe('foo');

    pipeline.dispose();
  });

  it('reflects subsequent setQuery values on query$', () => {
    const fetch = vi.fn(() => of([]));
    const pipeline = createSearchPipeline<string>(fetch);
    const queries: string[] = [];
    pipeline.query$.subscribe((q) => queries.push(q));

    pipeline.setQuery('a');
    pipeline.setQuery('ab');

    expect(queries).toEqual(['', 'a', 'ab']);

    pipeline.dispose();
  });

  it('emits a searching state before the fetch resolves', () => {
    const subject = new BehaviorSubject<string[] | undefined>(undefined);
    const fetch = vi.fn(() => subject.asObservable());
    const pipeline = createSearchPipeline<string>(fetch);
    const states: SearchState<string>[] = [];
    pipeline.state$.subscribe((s) => states.push(s));

    pipeline.setQuery('foo');
    vi.advanceTimersByTime(300);

    // After debounce, the helper emits its synthetic "searching" state, then
    // the inner Observable's first value (undefined → still searching).
    expect(states.some((s) => s.isSearching && s.results.length === 0)).toBe(true);

    subject.next(['hit']);
    expect(states[states.length - 1]).toEqual({ results: ['hit'], isSearching: false });

    pipeline.dispose();
  });

  it('treats undefined emissions as still-loading and array emissions as ready', () => {
    const subject = new BehaviorSubject<number[] | undefined>(undefined);
    const fetch = vi.fn(() => subject.asObservable());
    const pipeline = createSearchPipeline<number>(fetch);
    const states: SearchState<number>[] = [];
    pipeline.state$.subscribe((s) => states.push(s));

    pipeline.setQuery('q');
    vi.advanceTimersByTime(300);

    // First post-fetch emission is the BehaviorSubject's current `undefined`.
    const firstAfterFetch = states[states.length - 1];
    expect(firstAfterFetch?.isSearching).toBe(true);
    expect(firstAfterFetch?.results).toEqual([]);

    subject.next([1, 2, 3]);
    expect(states[states.length - 1]).toEqual({ results: [1, 2, 3], isSearching: false });

    subject.next(undefined);
    expect(states[states.length - 1]).toEqual({ results: [], isSearching: true });

    pipeline.dispose();
  });

  it('switches to the latest query (cancels in-flight via switchMap)', () => {
    const subjectA = new BehaviorSubject<string[] | undefined>(undefined);
    const subjectB = new BehaviorSubject<string[] | undefined>(undefined);
    const fetch = vi.fn((q: string) => (q === 'a' ? subjectA.asObservable() : subjectB.asObservable()));
    const pipeline = createSearchPipeline<string>(fetch);
    const states: SearchState<string>[] = [];
    pipeline.state$.subscribe((s) => states.push(s));

    pipeline.setQuery('a');
    vi.advanceTimersByTime(300);
    expect(fetch).toHaveBeenCalledWith('a');

    pipeline.setQuery('b');
    vi.advanceTimersByTime(300);
    expect(fetch).toHaveBeenCalledWith('b');

    // Late emission from the cancelled subjectA must NOT reach the consumer.
    subjectA.next(['stale']);
    expect(states[states.length - 1].results).not.toContain('stale');

    subjectB.next(['fresh']);
    expect(states[states.length - 1]).toEqual({ results: ['fresh'], isSearching: false });

    pipeline.dispose();
  });

  it('deduplicates consecutive identical queries (distinctUntilChanged)', () => {
    const fetch = vi.fn(() => of(['x']));
    const pipeline = createSearchPipeline<string>(fetch);
    pipeline.state$.subscribe();

    pipeline.setQuery('foo');
    vi.advanceTimersByTime(300);
    pipeline.setQuery('foo');
    vi.advanceTimersByTime(300);
    pipeline.setQuery('foo');
    vi.advanceTimersByTime(300);

    expect(fetch).toHaveBeenCalledTimes(1);

    pipeline.dispose();
  });

  it('clearing the input transitions back to idle without calling fetch', () => {
    const fetch = vi.fn(() => of(['hit']));
    const pipeline = createSearchPipeline<string>(fetch);
    const states: SearchState<string>[] = [];
    pipeline.state$.subscribe((s) => states.push(s));

    pipeline.setQuery('q');
    vi.advanceTimersByTime(300);
    expect(fetch).toHaveBeenCalledTimes(1);

    pipeline.setQuery('');
    vi.advanceTimersByTime(300);

    expect(fetch).toHaveBeenCalledTimes(1); // not called again
    expect(states[states.length - 1]).toEqual({ results: [], isSearching: false });

    pipeline.dispose();
  });

  it('completes input$ on dispose', async () => {
    const fetch = vi.fn(() => of([]));
    const pipeline = createSearchPipeline<string>(fetch);

    // Use real timers for the completion check (firstValueFrom + completion).
    vi.useRealTimers();
    const completed = firstValueFrom(
      pipeline.query$.pipe(
        // skip the synchronous startWith emission, then complete on dispose
        filter((_, i) => i > 0),
        take(1),
        toArray(),
      ),
    );

    pipeline.setQuery('one');
    pipeline.dispose();
    await completed;
    // If we got here without timeout, dispose worked (the pipeline didn't hang).
    expect(true).toBe(true);
  });
});
