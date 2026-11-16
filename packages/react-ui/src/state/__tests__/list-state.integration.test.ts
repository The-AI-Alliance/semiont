/**
 * `trackList` over the REAL SDK cache — not mock subjects.
 *
 * The mock-subject tests in `list-state.test.ts` describe trackList's own
 * contract, but they let a wrong belief survive twice: first a two-state
 * consumer of a three-outcome cache, then a fix routed through the blocking
 * signal on the assumption that value→undefined happens on stable keys (it
 * cannot: `invalidate()` keeps the value per B7, and `remove()` is not used
 * on list caches). This file pins trackList against `createCache`'s actual
 * emission and failure semantics — B3 dedup, B14 bounded retry, B15
 * terminal failure, and the observe()-time re-arm that `retry()` relies on.
 *
 * See .plans/PANEL-FAILURE-STATES.md
 */
import { describe, it, expect } from 'vitest';
import { BehaviorSubject, switchMap } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { createCache, type Cache } from '@semiont/sdk';
import { trackList } from '../list-state';

interface Deferred {
  resolve: (v: string[]) => void;
  reject: (e: Error) => void;
  promise: Promise<string[]>;
}

function deferred(): Deferred {
  let resolve!: (v: string[]) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string[]>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}

/** Let the cache's promise chains (fetch → retry → B15 push) settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** A real cache whose fetches the test resolves by hand, in call order. */
function harness(): { cache: Cache<string, string[]>; calls: Array<{ key: string; d: Deferred }> } {
  const calls: Array<{ key: string; d: Deferred }> = [];
  const cache = createCache<string, string[]>((key) => {
    const d = deferred();
    calls.push({ key, d });
    return d.promise;
  });
  return { cache, calls };
}

describe('trackList × createCache (integration)', () => {
  it('fresh key: loading until the real fetch resolves', async () => {
    const { cache, calls } = harness();
    const { state, dispose } = trackList<string[]>(() => cache.observe('recent'), []);

    expect(await firstValueFrom(state.loading$)).toBe(true);
    expect(calls).toHaveLength(1);

    calls[0]!.d.resolve(['r1']);
    await settle();

    expect(await firstValueFrom(state.loading$)).toBe(false);
    expect(await firstValueFrom(state.value$)).toEqual(['r1']);

    dispose();
    cache.dispose();
  });

  it('filter switch (discover shape): stale rows held, revalidating — never blocking', async () => {
    const { cache, calls } = harness();
    const filter$ = new BehaviorSubject<string>('');
    const { state, dispose } = trackList<string[]>(
      () => filter$.pipe(switchMap((f) => cache.observe(f))),
      [],
    );

    calls[0]!.d.resolve(['all']);
    await settle();
    expect(await firstValueFrom(state.value$)).toEqual(['all']);

    // New key: the cache genuinely emits `undefined` for it first.
    filter$.next('Person');
    await settle();

    expect(await firstValueFrom(state.loading$)).toBe(false);
    expect(await firstValueFrom(state.revalidating$)).toBe(true);
    expect(await firstValueFrom(state.value$)).toEqual(['all']);
    expect(calls).toHaveLength(2);

    calls[1]!.d.resolve(['people']);
    await settle();

    expect(await firstValueFrom(state.revalidating$)).toBe(false);
    expect(await firstValueFrom(state.value$)).toEqual(['people']);

    dispose();
    cache.dispose();
  });

  it('stable key never re-enters loading across the cache lifecycle', async () => {
    const { cache, calls } = harness();
    const { state, dispose } = trackList<string[]>(() => cache.observe('recent'), []);
    const seen: boolean[] = [];
    state.loading$.subscribe((l) => seen.push(l));

    calls[0]!.d.resolve(['r1']);
    await settle();
    cache.invalidate('recent'); // B7: value stays visible through the refetch
    await settle();
    calls[1]!.d.resolve(['r1', 'r2']);
    await settle();

    expect(seen).toEqual([true, false]);
    expect(await firstValueFrom(state.value$)).toEqual(['r1', 'r2']);

    dispose();
    cache.dispose();
  });

  it('lost reply: B14 retry, then B15 lands on error$ — and retry() recovers through observe()', async () => {
    const { cache, calls } = harness();
    const { state, dispose } = trackList<string[]>(() => cache.observe('recent'), []);

    calls[0]!.d.reject(new Error('lost reply'));
    await settle(); // B14 re-issues once
    expect(calls).toHaveLength(2);
    calls[1]!.d.reject(new Error('lost reply'));
    await settle(); // B15: value-less key errors its observable

    expect((await firstValueFrom(state.error$))?.message).toBe('lost reply');
    expect(await firstValueFrom(state.loading$)).toBe(false);

    // retry() must go through observe() again — that is what clears the B15
    // failure marker and starts a fresh attempt chain.
    state.retry();
    await settle();
    expect(calls).toHaveLength(3);
    expect(await firstValueFrom(state.error$)).toBeNull();
    expect(await firstValueFrom(state.loading$)).toBe(true);

    calls[2]!.d.resolve(['recovered']);
    await settle();
    expect(await firstValueFrom(state.value$)).toEqual(['recovered']);
    expect(await firstValueFrom(state.loading$)).toBe(false);

    dispose();
    cache.dispose();
  });
});
