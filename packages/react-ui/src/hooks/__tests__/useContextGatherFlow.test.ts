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

const mockGatherAnnotation = vi.fn();
const mockClient = {
  browse: { setTokenGetter: vi.fn() },
  gather: { annotation: mockGatherAnnotation },
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
    // Default: return a pending Observable (does not complete)
    mockGatherAnnotation.mockReturnValue({ subscribe: () => ({ unsubscribe: vi.fn() }) });
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

  it('does not call gather.annotation on mount (event-driven)', () => {
    renderContextGatherFlow();
    expect(mockGatherAnnotation).not.toHaveBeenCalled();
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

  it('sets context when Observable emits completion progress', async () => {
    const mockContext = {
      annotation: { id: 'ann-1' },
      sourceResource: { '@id': 'res-1' },
      sourceContext: 'text context',
    };

    // Observable emits a progress event with response.context then completes
    mockGatherAnnotation.mockReturnValue({
      subscribe: (observer: any) => {
        observer.next?.({ response: { context: mockContext } });
        observer.complete?.();
        return { unsubscribe: vi.fn() };
      },
    });

    const { result } = renderContextGatherFlow();

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });

    await waitFor(() => {
      expect(result.current.flow.gatherContext).toEqual(mockContext);
      expect(result.current.flow.gatherLoading).toBe(false);
    });
  });

  it('sets null context when Observable emits progress without context', async () => {
    mockGatherAnnotation.mockReturnValue({
      subscribe: (observer: any) => {
        observer.next?.({ response: {} });
        observer.complete?.();
        return { unsubscribe: vi.fn() };
      },
    });

    const { result } = renderContextGatherFlow();

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });

    await waitFor(() => {
      expect(result.current.flow.gatherContext).toBeNull();
      expect(result.current.flow.gatherLoading).toBe(false);
    });
  });

  it('sets error when Observable errors', async () => {
    mockGatherAnnotation.mockReturnValue({
      subscribe: (observer: any) => {
        observer.error?.(new Error('gather failed'));
        return { unsubscribe: vi.fn() };
      },
    });

    const { result } = renderContextGatherFlow();

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });

    await waitFor(() => {
      expect(result.current.flow.gatherError).toEqual(new Error('gather failed'));
      expect(result.current.flow.gatherLoading).toBe(false);
    });
  });

  it('clears previous error on gather:requested', async () => {
    // First request errors
    mockGatherAnnotation.mockReturnValue({
      subscribe: (observer: any) => {
        observer.error?.(new Error('first fail'));
        return { unsubscribe: vi.fn() };
      },
    });

    const { result } = renderContextGatherFlow();

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });
    await waitFor(() => expect(result.current.flow.gatherError).not.toBeNull());

    // Second request clears error (pending Observable)
    mockGatherAnnotation.mockReturnValue({ subscribe: () => ({ unsubscribe: vi.fn() }) });
    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });
    await waitFor(() => {
      expect(result.current.flow.gatherError).toBeNull();
      expect(result.current.flow.gatherLoading).toBe(true);
    });
  });

  it('clears previous context on gather:requested', async () => {
    const mockContext = { annotation: {}, sourceResource: {}, sourceContext: 'ctx' };

    // First request completes with context
    mockGatherAnnotation.mockReturnValue({
      subscribe: (observer: any) => {
        observer.next?.({ response: { context: mockContext } });
        observer.complete?.();
        return { unsubscribe: vi.fn() };
      },
    });

    const { result } = renderContextGatherFlow();

    act(() => {
      result.current.bus.get('gather:requested').next({ annotationId: AID } as any);
    });
    await waitFor(() => expect(result.current.flow.gatherContext).not.toBeNull());

    // Second request clears context (pending Observable)
    mockGatherAnnotation.mockReturnValue({ subscribe: () => ({ unsubscribe: vi.fn() }) });
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
      result.current.bus.get('gather:requested').next({ annotationId: AID2 } as any);
    });
    await waitFor(() => expect(result.current.flow.gatherAnnotationId).toBe(AID2));
  });
});
