/**
 * EMBEDDABLE-RESOURCE-VIEWER step 4 — session-level media token.
 *
 * `useMediaToken` takes the client explicitly (not `useSemiont()`), so a
 * bring-your-own-session host can mint authed `<img>` / PDF URLs from a bare
 * session — no provider.
 *
 * Started RED (old signature was `useMediaToken(id)`) and GREEN once step 4 lands.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { resourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { useMediaToken } from '../useMediaToken';

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
