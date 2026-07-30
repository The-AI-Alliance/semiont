/**
 * `trackList` — the three-state model behind every cache-backed list.
 *
 * It had no direct test despite backing four state units (resource viewer,
 * discover, compose, entity tags); this file is that coverage, with the
 * re-entering-loading case (found in review of PR #1112) as its centrepiece.
 *
 * See .plans/PANEL-FAILURE-STATES.md
 */
import { describe, it, expect } from 'vitest';
import type { CacheState } from '@semiont/sdk';
import { BehaviorSubject, Subject, firstValueFrom, switchMap } from 'rxjs';
import { trackList } from '../list-state';

describe('trackList', () => {
  it('starts loading, with the empty value and no error', async () => {
    const source = new BehaviorSubject<CacheState<string[]>>({ status: 'pending' });
    const { state, dispose } = trackList<string[]>(() => source, []);

    expect(await firstValueFrom(state.loading$)).toBe(true);
    expect(await firstValueFrom(state.value$)).toEqual([]);
    expect(await firstValueFrom(state.error$)).toBeNull();
    dispose();
  });

  it('a value ends loading', async () => {
    const source = new BehaviorSubject<CacheState<string[]>>({ status: 'pending' });
    const { state, dispose } = trackList<string[]>(() => source, []);

    source.next({ status: 'ready', value: ['a'] });

    expect(await firstValueFrom(state.loading$)).toBe(false);
    expect(await firstValueFrom(state.value$)).toEqual(['a']);
    dispose();
  });

  it('a terminal failure ends loading and surfaces the reason', async () => {
    const source = new Subject<CacheState<string[]>>();
    const { state, dispose } = trackList<string[]>(() => source, []);

    source.next({ status: 'failed', error: new Error('Resource not found') });

    expect(await firstValueFrom(state.loading$)).toBe(false);
    expect((await firstValueFrom(state.error$))?.message).toBe('Resource not found');
    dispose();
  });

  describe('revalidation — undefined after a value', () => {
    // `undefined` means "this key is not resolved yet". A stable key can
    // never go value→undefined (invalidate keeps the value per B7; remove()
    // is not used on list caches), so a late `undefined` only ever means the
    // thunk's chain switched to a NEW key — /know/discover does this when the
    // entity-type filter changes. That is a revalidation behind stale rows,
    // NOT a return to the blocking loading state: routing it into `loading$`
    // turns a filter switch into a full-page spinner, and a lost fetch into
    // one that never resolves.

    it('enters revalidating — not loading — when the source returns to undefined', async () => {
      const source = new BehaviorSubject<CacheState<string[]>>({ status: 'pending' });
      const { state, dispose } = trackList<string[]>(() => source, []);

      source.next({ status: 'ready', value: ['first'] });
      expect(await firstValueFrom(state.loading$)).toBe(false);

      source.next({ status: 'pending' });

      expect(await firstValueFrom(state.loading$)).toBe(false);
      expect(await firstValueFrom(state.revalidating$)).toBe(true);
      dispose();
    });

    it('loading$ never re-enters after the first value — a blocking spinner cannot latch', async () => {
      const source = new BehaviorSubject<CacheState<string[]>>({ status: 'pending' });
      const { state, dispose } = trackList<string[]>(() => source, []);
      const seen: boolean[] = [];
      state.loading$.subscribe((l) => seen.push(l));

      source.next({ status: 'ready', value: ['first'] });
      source.next({ status: 'pending' });
      source.next({ status: 'pending' });

      expect(seen).toEqual([true, false]);
      dispose();
    });

    it('keeps the last value while re-loading, so the view can render stale-with-spinner', async () => {
      const source = new BehaviorSubject<CacheState<string[]>>({ status: 'pending' });
      const { state, dispose } = trackList<string[]>(() => source, []);

      source.next({ status: 'ready', value: ['first'] });
      source.next({ status: 'pending' });

      expect(await firstValueFrom(state.value$)).toEqual(['first']);
      dispose();
    });

    it('the real shape: a switchMap to a new key re-enters loading', async () => {
      // Mirrors discover-state-unit's `recent` thunk.
      const filter$ = new BehaviorSubject<string>('');
      const keys = new Map<string, BehaviorSubject<CacheState<string[]>>>();
      const forKey = (k: string) => {
        if (!keys.has(k)) keys.set(k, new BehaviorSubject<CacheState<string[]>>({ status: 'pending' }));
        return keys.get(k)!;
      };

      const { state, dispose } = trackList<string[]>(
        () => filter$.pipe(switchMap((k) => forKey(k))),
        [],
      );

      forKey('').next({ status: 'ready', value: ['unfiltered'] });
      expect(await firstValueFrom(state.loading$)).toBe(false);

      // User picks an entity-type filter: a different cache key, not yet resolved.
      filter$.next('Person');

      expect(await firstValueFrom(state.loading$)).toBe(false);
      expect(await firstValueFrom(state.revalidating$)).toBe(true);
      // Stale rows stay visible while the new key loads.
      expect(await firstValueFrom(state.value$)).toEqual(['unfiltered']);

      forKey('Person').next({ status: 'ready', value: ['filtered'] });
      expect(await firstValueFrom(state.revalidating$)).toBe(false);
      expect(await firstValueFrom(state.value$)).toEqual(['filtered']);
      dispose();
    });
  });

  it('retry with a stale value re-enters revalidating, not loading', async () => {
    const attempts: Array<Subject<CacheState<string[]>>> = [];
    const { state, dispose } = trackList<string[]>(() => {
      const s = new Subject<CacheState<string[]>>();
      attempts.push(s);
      return s;
    }, []);

    attempts[0]!.next({ status: 'ready', value: ['stale'] });
    attempts[0]!.next({ status: 'failed', error: new Error('boom') });
    expect(await firstValueFrom(state.error$)).not.toBeNull();

    state.retry();

    expect(await firstValueFrom(state.loading$)).toBe(false);
    expect(await firstValueFrom(state.revalidating$)).toBe(true);
    expect(await firstValueFrom(state.value$)).toEqual(['stale']);
    dispose();
  });

  it('retry clears the error, re-enters loading, and re-subscribes', async () => {
    const attempts: Array<Subject<CacheState<string[]>>> = [];
    const { state, dispose } = trackList<string[]>(() => {
      const s = new Subject<CacheState<string[]>>();
      attempts.push(s);
      return s;
    }, []);

    attempts[0]!.next({ status: 'failed', error: new Error('boom') });
    expect(await firstValueFrom(state.error$)).not.toBeNull();

    state.retry();

    expect(attempts.length).toBe(2);
    expect(await firstValueFrom(state.error$)).toBeNull();
    expect(await firstValueFrom(state.loading$)).toBe(true);

    attempts[1]!.next({ status: 'ready', value: ['recovered'] });
    expect(await firstValueFrom(state.value$)).toEqual(['recovered']);
    dispose();
  });

  it('dispose is terminal and inert', async () => {
    const source = new BehaviorSubject<CacheState<string[]>>({ status: 'pending' });
    const { state, dispose } = trackList<string[]>(() => source, []);

    let completed = 0;
    state.value$.subscribe({ complete: () => { completed += 1; } });

    dispose();
    dispose();
    state.retry();

    expect(completed).toBe(1);
    expect(source.observed).toBe(false);
  });
});
