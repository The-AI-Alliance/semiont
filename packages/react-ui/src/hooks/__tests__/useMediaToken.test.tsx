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
});
