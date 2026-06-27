/**
 * GENERATE-FROM-BUTTON P2 — drives `client.gather.resource` (a Promise, no
 * progress stream) into React state. Mirrors the useResourceGraph test's
 * SemiontProvider mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import { resourceId } from '@semiont/core';
import { useResourceGather } from '../useResourceGather';

const mockGatherResource = vi.fn();
const stableMockClient = {
  gather: {
    get resource() { return mockGatherResource; },
  },
};
const stableActiveSession$ = new BehaviorSubject<unknown>({ client: stableMockClient });
const stableMockBrowser = { activeSession$: stableActiveSession$ };

vi.mock('../../session/SemiontProvider', async () => {
  const actual = await vi.importActual<typeof import('../../session/SemiontProvider')>('../../session/SemiontProvider');
  return { ...actual, useSemiont: () => stableMockBrowser };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

const CTX = {
  focus: { kind: 'resource', resource: { id: 'res-1', name: 'My Resource' } },
  graph: { nodes: [], edges: [] },
  metadata: {},
};

describe('useResourceGather', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGatherResource.mockResolvedValue(CTX);
    stableActiveSession$.next({ client: stableMockClient });
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useResourceGather(), { wrapper: Wrapper });
    expect(result.current.context).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('gather() resolves into context and calls gather.resource with the branded id + options', async () => {
    const { result } = renderHook(() => useResourceGather(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.gather('res-1', { depth: 2, excludeEntityTypes: ['Question'] });
    });
    expect(mockGatherResource).toHaveBeenCalledWith(resourceId('res-1'), { depth: 2, excludeEntityTypes: ['Question'] });
    expect(result.current.context).toEqual(CTX);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error and leaves context null on rejection', async () => {
    mockGatherResource.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useResourceGather(), { wrapper: Wrapper });
    await act(async () => { await result.current.gather('res-2'); });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.context).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('wraps a non-Error rejection in an Error', async () => {
    mockGatherResource.mockRejectedValue('plain string');
    const { result } = renderHook(() => useResourceGather(), { wrapper: Wrapper });
    await act(async () => { await result.current.gather('res-3'); });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('plain string');
  });

  it('reset() clears context, error, and loading', async () => {
    mockGatherResource.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useResourceGather(), { wrapper: Wrapper });
    await act(async () => { await result.current.gather('res-4'); });
    expect(result.current.error).toBeInstanceOf(Error);
    act(() => { result.current.reset(); });
    expect(result.current.context).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('gather() is a no-op without an active client', async () => {
    stableActiveSession$.next(null); // no session → client undefined
    const { result } = renderHook(() => useResourceGather(), { wrapper: Wrapper });
    await act(async () => { await result.current.gather('res-x'); });
    expect(mockGatherResource).not.toHaveBeenCalled();
    expect(result.current.context).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
