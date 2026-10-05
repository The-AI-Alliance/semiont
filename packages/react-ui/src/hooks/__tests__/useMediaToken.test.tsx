/**
 * Session-level media token.
 *
 * `useMediaToken` takes the client explicitly (not `useSemiont()`), so a
 * bring-your-own-session host can mint authed `<img>` / PDF URLs from a bare
 * session — no provider.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { resourceId } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { useMediaToken, type UseMediaTokenResult } from '../useMediaToken';

function makeClient(token: string): SemiontClient {
  return { auth: { mediaToken: vi.fn(async () => ({ token })) } } as unknown as SemiontClient;
}

describe('useMediaToken', () => {
  it('resolves the media token from a bare client', async () => {
    const client = makeClient('tok-123');
    const rid = resourceId('res-1');
    const { result } = renderHook(() => useMediaToken(client, rid));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.token).toBe('tok-123');
    expect(client.auth!.mediaToken).toHaveBeenCalledWith(rid);
  });

  it('stays token-less (not loading) without a client', async () => {
    const { result } = renderHook(() => useMediaToken(null, resourceId('res-1')));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.token).toBeUndefined();
  });

  it('clears the token when the client can no longer mint', async () => {
    // A stale token would keep mediaUrl()/download links alive on a client
    // that cannot mint or refresh — they would all break 5 minutes later,
    // with nothing in the UI explaining why.
    const { result, rerender } = renderHook(
      ({ client }: { client: SemiontClient | null }) => useMediaToken(client, resourceId('res-1')),
      { initialProps: { client: makeClient('tok-1') } },
    );
    await waitFor(() => expect(result.current.token).toBe('tok-1'));

    rerender({ client: {} as unknown as SemiontClient }); // bare transport: no auth namespace

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.token).toBeUndefined();
  });

  it("does not serve the previous resource's token while the next one is minting", async () => {
    // Tokens are per-resource; the old one is wrong for the new id, not
    // merely stale. Until the new mint resolves the hook must answer
    // "no token yet", not "here is res-1's".
    const byId: Record<string, Promise<{ token: string }>> = {
      'res-1': Promise.resolve({ token: 'tok-1' }),
      'res-2': new Promise(() => {}), // never resolves — the in-flight window
    };
    const client = {
      auth: { mediaToken: vi.fn((id: string) => byId[String(id)]) },
    } as unknown as SemiontClient;

    const { result, rerender } = renderHook(
      ({ id }) => useMediaToken(client, id),
      { initialProps: { id: resourceId('res-1') } },
    );
    await waitFor(() => expect(result.current.token).toBe('tok-1'));

    rerender({ id: resourceId('res-2') });

    expect(result.current.loading).toBe(true);
    expect(result.current.token).toBeUndefined();
  });
});

// State cleared in an effect arrives one render late. A token is scoped to ONE
// resource, so for that frame a caller builds a URL for res-2 carrying res-1's
// token — a request the gateway refuses. These specs record what EVERY render
// returned, so a single stale frame shows.
describe('useMediaToken — every render answers for its own inputs', () => {
  interface Inputs {
    client: SemiontClient | null;
    id: ResourceId;
  }

  function renderRecording(initialClient: SemiontClient) {
    const renders: Array<Inputs & UseMediaTokenResult> = [];
    const initialProps: Inputs = { client: initialClient, id: resourceId('res-1') };
    const hook = renderHook(
      ({ client, id }: Inputs) => {
        const returned = useMediaToken(client, id);
        renders.push({ client, id, ...returned });
        return returned;
      },
      { initialProps },
    );
    return { ...hook, renders };
  }

  it("never returns the previous resource's token on a render for the next", async () => {
    const byId: Record<string, Promise<{ token: string }>> = {
      'res-1': Promise.resolve({ token: 'tok-1' }),
      'res-2': new Promise(() => {}),
    };
    const client = {
      auth: { mediaToken: vi.fn((id: string) => byId[String(id)]) },
    } as unknown as SemiontClient;
    const { result, rerender, renders } = renderRecording(client);
    await waitFor(() => expect(result.current.token).toBe('tok-1'));

    const next = resourceId('res-2');
    rerender({ client, id: next });

    const forNext = renders.filter((r) => r.id === next);
    expect(forNext).not.toHaveLength(0);
    expect(forNext.map((r) => r.token)).not.toContain('tok-1');
    expect(forNext.map((r) => r.loading)).not.toContain(false);
  });

  it('never returns a token on a render for a client that cannot mint', async () => {
    const { result, rerender, renders } = renderRecording(makeClient('tok-1'));
    await waitFor(() => expect(result.current.token).toBe('tok-1'));

    const bare = {} as unknown as SemiontClient; // bare transport: no auth namespace
    rerender({ client: bare, id: resourceId('res-1') });

    const forBare = renders.filter((r) => r.client === bare);
    expect(forBare).not.toHaveLength(0);
    expect(forBare.map((r) => r.token)).not.toContain('tok-1');
    expect(forBare.map((r) => r.loading)).not.toContain(true);
  });

  // A token is only good while something keeps refreshing it. Once the client
  // goes away the refresh loop stops, so by the time the same client returns
  // the token minted before the gap may have expired: the hook starts again
  // from "no token yet" instead of serving it for the length of a round trip.
  it('a returning client starts from no token, never the one minted before the gap', async () => {
    const mediaToken = vi.fn()
      .mockResolvedValueOnce({ token: 'tok-1' })
      .mockReturnValueOnce(new Promise(() => {})); // the re-mint, still in flight
    const client = { auth: { mediaToken } } as unknown as SemiontClient;
    const id = resourceId('res-1');
    const { result, rerender, renders } = renderRecording(client);
    await waitFor(() => expect(result.current.token).toBe('tok-1'));

    rerender({ client: null, id });
    expect(result.current).toEqual({ token: undefined, loading: false });

    const rendersBefore = renders.length;
    rerender({ client, id });

    const sinceReturned = renders.slice(rendersBefore);
    expect(sinceReturned).not.toHaveLength(0);
    expect(sinceReturned.map((r) => r.token)).not.toContain('tok-1');
    expect(sinceReturned.map((r) => r.loading)).not.toContain(false);
    expect(mediaToken).toHaveBeenCalledTimes(2);
  });
});
