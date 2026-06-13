import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import '@testing-library/jest-dom';
import { resourceId } from '@semiont/core';
import { useResourceGraph } from '../useResourceGraph';

const mockResourceGraph = vi.fn();
const stableMockClient = {
  browse: {
    get resourceGraph() { return mockResourceGraph; },
  },
};
const stableMockSession = { client: stableMockClient };
const stableActiveSession$ = new BehaviorSubject<unknown>(stableMockSession);
const stableMockBrowser = { activeSession$: stableActiveSession$ };

vi.mock('../../session/SemiontProvider', async () => {
  const actual = await vi.importActual<typeof import('../../session/SemiontProvider')>('../../session/SemiontProvider');
  return { ...actual, useSemiont: () => stableMockBrowser };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

const GRAPH = { resource: { id: 'res-1' }, annotations: [], entityReferences: [] };

describe('useResourceGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResourceGraph.mockResolvedValue(GRAPH);
  });

  it('returns the graph and clears loading on resolve', async () => {
    const { result } = renderHook(() => useResourceGraph(resourceId('res-1')), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.graph).toEqual(GRAPH);
    expect(result.current.error).toBeNull();
    expect(mockResourceGraph).toHaveBeenCalledWith(resourceId('res-1'));
  });

  it('transitions through a loading state', async () => {
    const states: boolean[] = [];
    const { result } = renderHook(() => {
      const r = useResourceGraph(resourceId('res-2'));
      states.push(r.loading);
      return r;
    }, { wrapper: Wrapper });

    await waitFor(() => expect(result.current.graph).toEqual(GRAPH));

    expect(states).toContain(true);
    expect(result.current.loading).toBe(false);
  });

  it('surfaces an error and leaves graph null on rejection', async () => {
    mockResourceGraph.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useResourceGraph(resourceId('res-3')), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.graph).toBeNull();
  });

  it('a stale in-flight fetch does not clobber a newer id (cancellation guard)', async () => {
    let resolveOld!: (g: unknown) => void;
    let resolveNew!: (g: unknown) => void;
    const oldFetch = new Promise((r) => { resolveOld = r; });
    const newFetch = new Promise((r) => { resolveNew = r; });
    const GRAPH_OLD = { resource: { id: 'res-old' }, annotations: [], entityReferences: [] };
    const GRAPH_NEW = { resource: { id: 'res-new' }, annotations: [], entityReferences: [] };
    mockResourceGraph.mockReturnValueOnce(oldFetch).mockReturnValueOnce(newFetch);

    const { result, rerender } = renderHook(({ id }) => useResourceGraph(id), {
      wrapper: Wrapper,
      initialProps: { id: resourceId('res-old') },
    });

    // Switch ids before the first fetch resolves: the effect cleanup marks the
    // old request cancelled and a fresh fetch starts for the new id.
    rerender({ id: resourceId('res-new') });

    // Resolve the newer request, then the stale one.
    await act(async () => { resolveNew(GRAPH_NEW); });
    await waitFor(() => expect(result.current.graph).toEqual(GRAPH_NEW));
    await act(async () => { resolveOld(GRAPH_OLD); });

    // The stale res-old resolution must not overwrite res-new.
    expect(result.current.graph).toEqual(GRAPH_NEW);
  });
});
