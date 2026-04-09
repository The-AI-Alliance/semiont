/**
 * useContextGatherFlow tests
 *
 * Tests gather state transitions: requested → loading, complete → context,
 * failed → error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useContextGatherFlow } from '../useContextGatherFlow';
import { EventBusProvider, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { SemiontApiClient } from '@semiont/api-client';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';

vi.mock('@semiont/api-client', () => ({
  SemiontApiClient: vi.fn(function () {}),
  baseUrl: vi.fn(function (url: string) { return url; }),
  accessToken: vi.fn(function (t: string) { return t as any; }),
}));

const mockFlowGatherContext = vi.fn().mockReturnValue({ unsubscribe: vi.fn() });
const mockClient = {
  stores: { resources: { setTokenGetter: vi.fn() }, annotations: { setTokenGetter: vi.fn() } },
  flows: { gatherContext: mockFlowGatherContext },
};

vi.mocked(SemiontApiClient).mockImplementation(function () { return mockClient; });

const RID = makeResourceId('res-1');
const AID = makeAnnotationId('ann-1');

const wrapper = ({ children }: { children: ReactNode }) =>
  React.createElement(
    EventBusProvider,
    null,
    React.createElement(
      AuthTokenProvider,
      { token: null },
      React.createElement(ApiClientProvider, { baseUrl: 'http://localhost:4000' }, children)
    )
  );

function renderContextGatherFlow() {
  return renderHook(
    () => ({ flow: useContextGatherFlow({ resourceId: RID }), bus: useEventBus() }),
    { wrapper }
  );
}

describe('useContextGatherFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlowGatherContext.mockReturnValue({ unsubscribe: vi.fn() });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with null context, not loading, no error', () => {
    const { result } = renderContextGatherFlow();
    expect(result.current.flow.gatherContext).toBeNull();
    expect(result.current.flow.gatherLoading).toBe(false);
    expect(result.current.flow.gatherError).toBeNull();
    expect(result.current.flow.gatherAnnotationId).toBeNull();
  });

  it('activates the gather flow engine on mount', () => {
    renderContextGatherFlow();
    expect(mockFlowGatherContext).toHaveBeenCalledWith(RID, expect.any(Function));
  });

  it('sets loading on gather:requested', async () => {
    const { result } = renderContextGatherFlow();

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });

    await waitFor(() => {
      expect(result.current.flow.gatherLoading).toBe(true);
      expect(result.current.flow.gatherContext).toBeNull();
      expect(result.current.flow.gatherError).toBeNull();
      expect(result.current.flow.gatherAnnotationId).toBe(AID);
    });
  });

  it('sets context on gather:complete', async () => {
    const { result } = renderContextGatherFlow();

    const mockContext = {
      annotation: { id: 'ann-1' },
      sourceResource: { '@id': 'res-1' },
      sourceContext: 'text context',
    };

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });
    await waitFor(() => expect(result.current.flow.gatherLoading).toBe(true));

    act(() => {
      result.current.bus.get('gather:complete').next({
        response: { context: mockContext },
      } as any);
    });

    await waitFor(() => {
      expect(result.current.flow.gatherContext).toEqual(mockContext);
      expect(result.current.flow.gatherLoading).toBe(false);
    });
  });

  it('sets null context when gather:complete has no context', async () => {
    const { result } = renderContextGatherFlow();

    act(() => {
      result.current.bus.get('gather:complete').next({ response: {} } as any);
    });

    await waitFor(() => {
      expect(result.current.flow.gatherContext).toBeNull();
      expect(result.current.flow.gatherLoading).toBe(false);
    });
  });

  it('sets error on gather:failed', async () => {
    const { result } = renderContextGatherFlow();
    const error = new Error('gather failed');

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });
    await waitFor(() => expect(result.current.flow.gatherLoading).toBe(true));

    act(() => {
      result.current.bus.get('gather:failed').next({ error } as any);
    });

    await waitFor(() => {
      expect(result.current.flow.gatherError).toBe(error);
      expect(result.current.flow.gatherLoading).toBe(false);
    });
  });

  it('clears previous error on gather:requested', async () => {
    const { result } = renderContextGatherFlow();

    // First request fails
    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });
    act(() => {
      result.current.bus.get('gather:failed').next({ message: 'first fail' } as any);
    });
    await waitFor(() => expect(result.current.flow.gatherError).not.toBeNull());

    // Second request clears error
    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });
    await waitFor(() => {
      expect(result.current.flow.gatherError).toBeNull();
      expect(result.current.flow.gatherLoading).toBe(true);
    });
  });

  it('clears previous context on gather:requested', async () => {
    const { result } = renderContextGatherFlow();
    const mockContext = { annotation: {}, sourceResource: {}, sourceContext: 'ctx' };

    act(() => {
      result.current.bus.get('gather:complete').next({ response: { context: mockContext } } as any);
    });
    await waitFor(() => expect(result.current.flow.gatherContext).not.toBeNull());

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });
    await waitFor(() => {
      expect(result.current.flow.gatherContext).toBeNull();
    });
  });

  it('updates gatherAnnotationId on each gather:requested', async () => {
    const { result } = renderContextGatherFlow();
    const AID2 = makeAnnotationId('ann-2');

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });
    await waitFor(() => expect(result.current.flow.gatherAnnotationId).toBe(AID));

    act(() => {
      result.current.bus.get('gather:complete').next({ response: {} } as any);
    });

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID2 } as any);
    });
    await waitFor(() => expect(result.current.flow.gatherAnnotationId).toBe(AID2));
  });
});
