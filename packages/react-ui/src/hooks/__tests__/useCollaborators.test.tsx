/**
 * INFERENCE-LIMITS-EXPOSURE P3a — the roster subscription behind the
 * CollaborationPanel's software-agent rows.
 *
 * Sibling to `useMediaToken`: takes the client explicitly so a
 * bring-your-own-session host can read the roster from a bare session.
 *
 * The contract worth pinning is what happens when things are NOT fine. The
 * roster is decoration on a panel whose real job is connection state, so a
 * failed or absent read must degrade to "no collaborators" — never a thrown
 * render, never a permanent spinner.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { BehaviorSubject, Subject } from 'rxjs';
import type { CollaboratorEntry } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { useCollaborators } from '../useCollaborators';

type CacheState<T> =
  | { status: 'pending' }
  | { status: 'ready'; value: T }
  | { status: 'failed'; error: Error };

const entry = (model: string): CollaboratorEntry =>
  ({
    agent: { '@type': 'Software', name: model, provider: 'anthropic', model },
    servesJobTypes: ['generation'],
    limits: { contextTokens: 200_000, maxOutputTokens: 64_000 },
  }) as unknown as CollaboratorEntry;

/** A client whose `browse.agents()` replays whatever the given subject holds. */
function makeClient(subject: Subject<CacheState<CollaboratorEntry[]>>) {
  const agents = vi.fn(() => subject);
  return { client: { browse: { agents } } as unknown as SemiontClient, agents };
}

describe('useCollaborators', () => {
  it('surfaces the roster once the cache is ready', async () => {
    const subject = new BehaviorSubject<CacheState<CollaboratorEntry[]>>({ status: 'pending' });
    const { client } = makeClient(subject);

    const { result } = renderHook(() => useCollaborators(client));
    expect(result.current.loading).toBe(true);

    act(() => subject.next({ status: 'ready', value: [entry('claude-sonnet-5')] }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collaborators).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('reports empty — and NOT loading — without a client', async () => {
    // A host on a bare transport has no session yet. Spinning forever here
    // would leave the panel permanently mid-load.
    const { result } = renderHook(() => useCollaborators(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collaborators).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('degrades to an empty roster when the cache reports failure', async () => {
    const subject = new BehaviorSubject<CacheState<CollaboratorEntry[]>>({ status: 'pending' });
    const { client } = makeClient(subject);
    const { result } = renderHook(() => useCollaborators(client));

    act(() => subject.next({ status: 'failed', error: new Error('directory unavailable') }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collaborators).toEqual([]);
    expect(result.current.error?.message).toBe('directory unavailable');
  });

  it('normalizes a non-Error thrown on the stream', async () => {
    const subject = new Subject<CacheState<CollaboratorEntry[]>>();
    const { client } = makeClient(subject);
    const { result } = renderHook(() => useCollaborators(client));

    act(() => subject.error('boom'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
  });

  it('keeps the previous roster visible while revalidating', async () => {
    // `pending` after a successful read is a revalidation, not a blank slate;
    // clearing here would flicker the panel on every resume-gap refresh.
    const subject = new BehaviorSubject<CacheState<CollaboratorEntry[]>>({
      status: 'ready',
      value: [entry('gemma2:27b')],
    });
    const { client } = makeClient(subject);
    const { result } = renderHook(() => useCollaborators(client));

    await waitFor(() => expect(result.current.collaborators).toHaveLength(1));
    act(() => subject.next({ status: 'pending' }));

    expect(result.current.collaborators).toHaveLength(1);
  });

  it('unsubscribes on unmount and resubscribes for a new client', async () => {
    const subject = new BehaviorSubject<CacheState<CollaboratorEntry[]>>({ status: 'pending' });
    const { client, agents } = makeClient(subject);

    const { unmount, rerender } = renderHook(
      ({ c }: { c: SemiontClient | null }) => useCollaborators(c),
      { initialProps: { c: client } },
    );
    expect(agents).toHaveBeenCalledTimes(1);
    expect(subject.observed).toBe(true);

    // A KB switch replaces the client; the old subscription must not linger.
    const second = makeClient(new BehaviorSubject<CacheState<CollaboratorEntry[]>>({ status: 'pending' }));
    rerender({ c: second.client });
    expect(subject.observed).toBe(false);
    expect(second.agents).toHaveBeenCalledTimes(1);

    unmount();
    expect(second.agents.mock.results[0]!.value.observed).toBe(false);
  });
});
