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
import { BehaviorSubject, Subject, firstValueFrom, switchMap } from 'rxjs';
import { trackList } from '../list-state';

describe('trackList', () => {
  it('starts loading, with the empty value and no error', async () => {
    const source = new BehaviorSubject<string[] | undefined>(undefined);
    const { state, dispose } = trackList<string[]>(() => source, []);

    expect(await firstValueFrom(state.loading$)).toBe(true);
    expect(await firstValueFrom(state.value$)).toEqual([]);
    expect(await firstValueFrom(state.error$)).toBeNull();
    dispose();
  });

  it('a value ends loading', async () => {
    const source = new BehaviorSubject<string[] | undefined>(undefined);
    const { state, dispose } = trackList<string[]>(() => source, []);

    source.next(['a']);

    expect(await firstValueFrom(state.loading$)).toBe(false);
    expect(await firstValueFrom(state.value$)).toEqual(['a']);
    dispose();
  });

  it('a terminal failure ends loading and surfaces the reason', async () => {
    const source = new Subject<string[] | undefined>();
    const { state, dispose } = trackList<string[]>(() => source, []);

    source.error(new Error('Resource not found'));

    expect(await firstValueFrom(state.loading$)).toBe(false);
    expect((await firstValueFrom(state.error$))?.message).toBe('Resource not found');
    dispose();
  });

  describe('re-entering loading', () => {
    // `undefined` means "this key is not resolved yet". Ignoring it outright
    // is only safe if it can never follow a value — but it can: a thunk whose
    // chain `switchMap`s to a NEW cache key emits `undefined` for that key
    // first. Leaving `loading$` false there tells the consumer the previous
    // key's data is current when it is stale and a request is in flight.
    // Reachable today on /know/discover, where changing the entity-type
    // filter switches `browse.resources()` to a new key.

    it('goes back to loading when the source returns to undefined', async () => {
      const source = new BehaviorSubject<string[] | undefined>(undefined);
      const { state, dispose } = trackList<string[]>(() => source, []);

      source.next(['first']);
      expect(await firstValueFrom(state.loading$)).toBe(false);

      source.next(undefined);

      expect(await firstValueFrom(state.loading$)).toBe(true);
      dispose();
    });

    it('keeps the last value while re-loading, so the view can render stale-with-spinner', async () => {
      const source = new BehaviorSubject<string[] | undefined>(undefined);
      const { state, dispose } = trackList<string[]>(() => source, []);

      source.next(['first']);
      source.next(undefined);

      expect(await firstValueFrom(state.value$)).toEqual(['first']);
      dispose();
    });

    it('the real shape: a switchMap to a new key re-enters loading', async () => {
      // Mirrors discover-state-unit's `recent` thunk.
      const filter$ = new BehaviorSubject<string>('');
      const keys = new Map<string, BehaviorSubject<string[] | undefined>>();
      const forKey = (k: string) => {
        if (!keys.has(k)) keys.set(k, new BehaviorSubject<string[] | undefined>(undefined));
        return keys.get(k)!;
      };

      const { state, dispose } = trackList<string[]>(
        () => filter$.pipe(switchMap((k) => forKey(k))),
        [],
      );

      forKey('').next(['unfiltered']);
      expect(await firstValueFrom(state.loading$)).toBe(false);

      // User picks an entity-type filter: a different cache key, not yet resolved.
      filter$.next('Person');

      expect(await firstValueFrom(state.loading$)).toBe(true);

      forKey('Person').next(['filtered']);
      expect(await firstValueFrom(state.loading$)).toBe(false);
      expect(await firstValueFrom(state.value$)).toEqual(['filtered']);
      dispose();
    });
  });

  it('retry clears the error, re-enters loading, and re-subscribes', async () => {
    const attempts: Array<Subject<string[] | undefined>> = [];
    const { state, dispose } = trackList<string[]>(() => {
      const s = new Subject<string[] | undefined>();
      attempts.push(s);
      return s;
    }, []);

    attempts[0]!.error(new Error('boom'));
    expect(await firstValueFrom(state.error$)).not.toBeNull();

    state.retry();

    expect(attempts.length).toBe(2);
    expect(await firstValueFrom(state.error$)).toBeNull();
    expect(await firstValueFrom(state.loading$)).toBe(true);

    attempts[1]!.next(['recovered']);
    expect(await firstValueFrom(state.value$)).toEqual(['recovered']);
    dispose();
  });

  it('dispose is terminal and inert', async () => {
    const source = new BehaviorSubject<string[] | undefined>(undefined);
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
