/**
 * useResourceContent is bring-your-own-client.
 *
 * The last provider-bound hook on the embeddable path joins the
 * useResourceLoader/useMediaToken convention: client-first (`null` → idle),
 * NO providers required, and errors are RETURNED, never toasted — the host
 * decides chrome. Real decodeWithCharset over encoded bytes (no core mocks).
 *
 * Started RED (the old hook threw from useSemiont with no providers and took
 * no client param) and GREEN once the de-provider lands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { resourceId } from '@semiont/core';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { useResourceContent, type UseResourceContentResult } from '../useResourceContent';

const mockResourceRepresentation = vi.fn();
const client = {
  browse: {
    get resourceRepresentation() { return mockResourceRepresentation; },
  },
} as unknown as SemiontClient;

const resource = {
  representations: [{ mediaType: 'text/plain', byteSize: 11 }],
} as unknown as ResourceDescriptor;

const RID = resourceId('res-1');
const utf8 = (s: string) => new TextEncoder().encode(s).buffer;

/** A promise the test settles by hand, to observe the state while it is pending. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useResourceContent — bring-your-own-client, no providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResourceRepresentation.mockResolvedValue({ data: utf8(''), contentType: 'text/plain' });
  });

  it('resolves decoded content for text media (real charset decode)', async () => {
    mockResourceRepresentation.mockResolvedValue({
      data: utf8('Hello World'),
      contentType: 'text/plain; charset=utf-8',
    });

    const { result } = renderHook(() => useResourceContent(client, RID, resource));

    await waitFor(() => expect(result.current.content).toBe('Hello World'));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockResourceRepresentation).toHaveBeenCalledWith(RID);
  });

  it('transitions through a loading state', async () => {
    const loadingStates: boolean[] = [];
    mockResourceRepresentation.mockResolvedValue({ data: utf8('done'), contentType: 'text/plain' });

    const { result } = renderHook(() => {
      const r = useResourceContent(client, RID, resource);
      loadingStates.push(r.loading);
      return r;
    });

    await waitFor(() => expect(result.current.content).toBe('done'));
    expect(loadingStates).toContain(true);
    expect(result.current.loading).toBe(false);
  });

  it('client=null stays idle — no fetch, not loading, no content', () => {
    const { result } = renderHook(() => useResourceContent(null, RID, resource));

    expect(mockResourceRepresentation).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.content).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('enabled=false fetches nothing (the binary/media-token path)', () => {
    const { result } = renderHook(() => useResourceContent(client, RID, resource, false));

    expect(mockResourceRepresentation).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('a failing fetch RETURNS the error — nothing is toasted (no provider to toast with)', async () => {
    mockResourceRepresentation.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useResourceContent(client, RID, resource));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Network error');
    expect(result.current.content).toBeUndefined();
  });
});

// `content` is the loaded fact: `undefined` until the text has arrived, the
// text afterwards. An empty string is a document — a zero-byte one — so it
// must never also mean "not loaded yet", or a caller asking "is it loaded?"
// can only guess from length and gets every empty document wrong.
describe('useResourceContent — undefined means not loaded, never an empty document', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a zero-byte representation loads as the empty string', async () => {
    const fetch = deferred<{ data: ArrayBuffer; contentType: string }>();
    mockResourceRepresentation.mockReturnValue(fetch.promise);

    const { result } = renderHook(() => useResourceContent(client, RID, resource));
    expect(result.current.content).toBeUndefined();

    fetch.resolve({ data: utf8(''), contentType: 'text/plain' });

    await waitFor(() => expect(result.current.content).toBe(''));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('disabling mid-fetch returns to idle: not loading, no content, and the late reply is dropped', async () => {
    const fetch = deferred<{ data: ArrayBuffer; contentType: string }>();
    mockResourceRepresentation.mockReturnValue(fetch.promise);

    const { result, rerender } = renderHook(
      ({ enabled }) => useResourceContent(client, RID, resource, enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    rerender({ enabled: false });
    expect(result.current.loading).toBe(false);

    await act(async () => {
      fetch.resolve({ data: utf8('late'), contentType: 'text/plain' });
      await fetch.promise;
    });
    expect(result.current.content).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });
});

// State cleared in an effect arrives one render late: for that frame a caller
// holding resource B is handed A's content, A's error, or "not loading". These
// specs record what EVERY render returned, so a single stale frame shows.
describe('useResourceContent — every render answers for its own inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const NEXT = resourceId('res-2');

  function renderRecording() {
    const renders: Array<{ rid: ResourceId } & UseResourceContentResult> = [];
    const hook = renderHook(
      ({ rid }) => {
        const returned = useResourceContent(client, rid, resource);
        renders.push({ rid, ...returned });
        return returned;
      },
      { initialProps: { rid: RID } },
    );
    return { ...hook, rendersFor: (rid: ResourceId) => renders.filter((r) => r.rid === rid) };
  }

  it('is loading from the first render — no frame says idle while its fetch is about to start', () => {
    mockResourceRepresentation.mockReturnValue(deferred().promise);

    const { rendersFor } = renderRecording();

    expect(rendersFor(RID).map((r) => r.loading)).not.toContain(false);
  });

  it('never returns the previous resource\'s content on a render for the next', async () => {
    mockResourceRepresentation.mockResolvedValueOnce({ data: utf8('first'), contentType: 'text/plain' });
    const { result, rerender, rendersFor } = renderRecording();
    await waitFor(() => expect(result.current.content).toBe('first'));

    const next = deferred<{ data: ArrayBuffer; contentType: string }>();
    mockResourceRepresentation.mockReturnValueOnce(next.promise);
    rerender({ rid: NEXT });

    expect(rendersFor(NEXT)).not.toHaveLength(0);
    expect(rendersFor(NEXT).map((r) => r.content)).not.toContain('first');
    expect(rendersFor(NEXT).map((r) => r.loading)).not.toContain(false);

    next.resolve({ data: utf8('second'), contentType: 'text/plain' });
    await waitFor(() => expect(result.current.content).toBe('second'));
    expect(result.current.loading).toBe(false);
  });

  it('never returns the previous resource\'s error on a render for the next', async () => {
    mockResourceRepresentation.mockRejectedValueOnce(new Error('first failed'));
    const { result, rerender, rendersFor } = renderRecording();
    await waitFor(() => expect(result.current.error?.message).toBe('first failed'));

    mockResourceRepresentation.mockReturnValueOnce(deferred().promise);
    rerender({ rid: NEXT });

    expect(rendersFor(NEXT)).not.toHaveLength(0);
    expect(rendersFor(NEXT).map((r) => r.error?.message)).not.toContain('first failed');
  });

  // The other side of "an outcome answers for the inputs it was fetched for":
  // when the SAME inputs come back, the text already fetched for them is still
  // the answer. It is served at once and refreshed behind, rather than blanked
  // for a round trip — text does not expire the way a media token does.
  it('re-enabling for the same inputs serves the fetched content at once, and refetches', async () => {
    mockResourceRepresentation.mockResolvedValueOnce({ data: utf8('first'), contentType: 'text/plain' });
    const renders: Array<{ enabled: boolean } & UseResourceContentResult> = [];
    const { result, rerender } = renderHook(
      ({ enabled }) => {
        const returned = useResourceContent(client, RID, resource, enabled);
        renders.push({ enabled, ...returned });
        return returned;
      },
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.content).toBe('first'));

    rerender({ enabled: false });
    expect(result.current).toEqual({ content: undefined, loading: false, error: null });

    const refetch = deferred<{ data: ArrayBuffer; contentType: string }>();
    mockResourceRepresentation.mockReturnValueOnce(refetch.promise);
    const rendersBefore = renders.length;
    rerender({ enabled: true });

    const sinceReenabled = renders.slice(rendersBefore);
    expect(sinceReenabled).not.toHaveLength(0);
    expect(sinceReenabled.map((r) => r.content)).toEqual(sinceReenabled.map(() => 'first'));
    expect(sinceReenabled.map((r) => r.loading)).not.toContain(true);
    expect(mockResourceRepresentation).toHaveBeenCalledTimes(2);

    refetch.resolve({ data: utf8('second'), contentType: 'text/plain' });
    await waitFor(() => expect(result.current.content).toBe('second'));
    expect(result.current.loading).toBe(false);
  });
});
