/**
 * The engines subscription behind the CollaborationPanel's engine rows.
 *
 * Sibling to `useMediaToken`: takes the client explicitly so a
 * bring-your-own-session host can read the engines from a bare session.
 *
 * The contract worth pinning is what happens when things are NOT fine. The
 * engines are decoration on a panel whose real job is connection state, so a
 * failed or absent read must degrade to "no engines" — never a thrown
 * render, never a permanent spinner.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { BehaviorSubject, Subject } from 'rxjs';
import type { EngineWithLimits } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { useEngines } from '../useEngines';

type CacheState<T> =
  | { status: 'pending' }
  | { status: 'ready'; value: T }
  | { status: 'failed'; error: Error };

const entry = (model: string): EngineWithLimits => ({
  engine: { provider: 'anthropic', model },
  jobs: [{ jobType: 'yield' }],
  limits: { contextTokens: 200_000, maxOutputTokens: 64_000 },
});

/** A client whose `browse.engines()` replays whatever the given subject holds. */
function makeClient(subject: Subject<CacheState<EngineWithLimits[]>>) {
  const engines = vi.fn(() => subject);
  return { client: { browse: { engines } } as unknown as SemiontClient, engines };
}

describe('useEngines', () => {
  it('surfaces the engines once the cache is ready', async () => {
    const subject = new BehaviorSubject<CacheState<EngineWithLimits[]>>({ status: 'pending' });
    const { client } = makeClient(subject);

    const { result } = renderHook(() => useEngines(client));
    expect(result.current.loading).toBe(true);

    act(() => subject.next({ status: 'ready', value: [entry('claude-sonnet-5')] }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.engines).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('reports empty — and NOT loading — without a client', async () => {
    // A host on a bare transport has no session yet. Spinning forever here
    // would leave the panel permanently mid-load.
    const { result } = renderHook(() => useEngines(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.engines).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('degrades to no engines when the cache reports failure', async () => {
    const subject = new BehaviorSubject<CacheState<EngineWithLimits[]>>({ status: 'pending' });
    const { client } = makeClient(subject);
    const { result } = renderHook(() => useEngines(client));

    act(() => subject.next({ status: 'failed', error: new Error('engines unavailable') }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.engines).toEqual([]);
    expect(result.current.error?.message).toBe('engines unavailable');
  });

  it('normalizes a non-Error thrown on the stream', async () => {
    const subject = new Subject<CacheState<EngineWithLimits[]>>();
    const { client } = makeClient(subject);
    const { result } = renderHook(() => useEngines(client));

    act(() => subject.error('boom'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
  });

  it('keeps the previous engines visible while revalidating', async () => {
    // `pending` after a successful read is a revalidation, not a blank slate;
    // clearing here would flicker the panel on every resume-gap refresh.
    const subject = new BehaviorSubject<CacheState<EngineWithLimits[]>>({
      status: 'ready',
      value: [entry('gemma2:27b')],
    });
    const { client } = makeClient(subject);
    const { result } = renderHook(() => useEngines(client));

    await waitFor(() => expect(result.current.engines).toHaveLength(1));
    act(() => subject.next({ status: 'pending' }));

    expect(result.current.engines).toHaveLength(1);
  });

  it('unsubscribes on unmount and resubscribes for a new client', async () => {
    const subject = new BehaviorSubject<CacheState<EngineWithLimits[]>>({ status: 'pending' });
    const { client, engines } = makeClient(subject);

    const { unmount, rerender } = renderHook(
      ({ c }: { c: SemiontClient | null }) => useEngines(c),
      { initialProps: { c: client } },
    );
    expect(engines).toHaveBeenCalledTimes(1);
    expect(subject.observed).toBe(true);

    // A KB switch replaces the client; the old subscription must not linger.
    const second = makeClient(new BehaviorSubject<CacheState<EngineWithLimits[]>>({ status: 'pending' }));
    rerender({ c: second.client });
    expect(subject.observed).toBe(false);
    expect(second.engines).toHaveBeenCalledTimes(1);

    unmount();
    expect(second.engines.mock.results[0]!.value.observed).toBe(false);
  });
});
