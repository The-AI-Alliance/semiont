/**
 * HEADLESS-RESOURCE-CONTENT — useResourceContent is bring-your-own-client.
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
import { renderHook, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { resourceId } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { useResourceContent } from '../useResourceContent';

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

  it('client=null stays idle — no fetch, not loading', () => {
    const { result } = renderHook(() => useResourceContent(null, RID, resource));

    expect(mockResourceRepresentation).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.content).toBe('');
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
    expect(result.current.content).toBe('');
  });
});
