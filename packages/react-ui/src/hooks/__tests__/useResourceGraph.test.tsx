import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
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
});
