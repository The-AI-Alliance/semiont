/**
 * useResourceEvents tests
 *
 * Tests EventBus-driven event dispatch and SSE stream lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useResourceEvents } from '../useResourceEvents';
import { EventBusProvider, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { SemiontApiClient } from '@semiont/api-client';
import { resourceId as makeResourceId } from '@semiont/core';
import type { ResourceEvent } from '@semiont/core';

vi.mock('@semiont/api-client', () => ({
  SemiontApiClient: vi.fn(function () {}),
  baseUrl: vi.fn(function (url: string) { return url; }),
  accessToken: vi.fn(function (t: string) { return t as any; }),
}));

const mockFlowResourceEvents = vi.fn().mockReturnValue({ unsubscribe: vi.fn() });
const mockClient = {
  stores: { resources: { setTokenGetter: vi.fn() }, annotations: { setTokenGetter: vi.fn() } },
  flows: { resourceEvents: mockFlowResourceEvents },
};

vi.mocked(SemiontApiClient).mockImplementation(function () { return mockClient; });

const RID = makeResourceId('res-1');

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

// Helper to build typed ResourceEvents
function makeEvent<T extends ResourceEvent['type']>(
  type: T,
  payload: Extract<ResourceEvent, { type: T }>['payload']
): Extract<ResourceEvent, { type: T }> {
  return { type, payload } as Extract<ResourceEvent, { type: T }>;
}

// Create flat StoredEvent shape for typed channels
function wrapStored(event: any): any {
  return { ...event, metadata: { sequenceNumber: 1, streamPosition: 0 } };
}

describe('useResourceEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlowResourceEvents.mockReturnValue({ unsubscribe: vi.fn() });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with disconnected status', () => {
    const { result } = renderHook(
      () => useResourceEvents({ rUri: RID, autoConnect: false }),
      { wrapper }
    );
    expect(result.current.status).toBe('disconnected');
    expect(result.current.lastEvent).toBeNull();
    expect(result.current.eventCount).toBe(0);
  });

  it('connects when autoConnect is true (default)', async () => {
    renderHook(
      () => useResourceEvents({ rUri: RID }),
      { wrapper }
    );
    await waitFor(() => {
      expect(mockFlowResourceEvents).toHaveBeenCalledWith(RID, expect.any(Function));
    });
  });

  it('does not auto-connect when autoConnect is false', () => {
    renderHook(
      () => useResourceEvents({ rUri: RID, autoConnect: false }),
      { wrapper }
    );
    expect(mockFlowResourceEvents).not.toHaveBeenCalled();
  });

  it('sets status to connected after connect()', async () => {
    const { result } = renderHook(
      () => useResourceEvents({ rUri: RID, autoConnect: false }),
      { wrapper }
    );

    act(() => { result.current.connect(); });

    await waitFor(() => {
      expect(result.current.status).toBe('connected');
    });
  });

  it('sets status to disconnected after disconnect()', async () => {
    const { result } = renderHook(
      () => useResourceEvents({ rUri: RID }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.status).toBe('connected'));

    act(() => { result.current.disconnect(); });

    await waitFor(() => {
      expect(result.current.status).toBe('disconnected');
    });
  });

  describe('EventBus event dispatch', () => {
    function renderWithHandlers(handlers: Omit<Parameters<typeof useResourceEvents>[0], 'rUri'>) {
      return renderHook(
        () => ({
          events: useResourceEvents({ rUri: RID, autoConnect: false, ...handlers }),
          bus: useEventBus(),
        }),
        { wrapper }
      );
    }

    it('dispatches mark:added to onAnnotationAdded', async () => {
      const onAnnotationAdded = vi.fn();
      const { result } = renderWithHandlers({ onAnnotationAdded });

      const event = makeEvent('mark:added', { annotation: { id: 'ann-1' } } as any);

      act(() => {
        result.current.bus.get('mark:added' as any).next(wrapStored(event));
      });

      await waitFor(() => {
        expect(onAnnotationAdded).toHaveBeenCalledWith(event);
      });
    });

    it('dispatches mark:removed to onAnnotationRemoved', async () => {
      const onAnnotationRemoved = vi.fn();
      const { result } = renderWithHandlers({ onAnnotationRemoved });

      const event = makeEvent('mark:removed', { annotationId: 'ann-1' } as any);

      act(() => {
        result.current.bus.get('mark:removed' as any).next(wrapStored(event));
      });

      await waitFor(() => {
        expect(onAnnotationRemoved).toHaveBeenCalledWith(event);
      });
    });

    it('dispatches mark:body-updated to onAnnotationBodyUpdated', async () => {
      const onAnnotationBodyUpdated = vi.fn();
      const { result } = renderWithHandlers({ onAnnotationBodyUpdated });

      const event = makeEvent('mark:body-updated', { annotationId: 'ann-1' } as any);

      act(() => {
        result.current.bus.get('mark:body-updated' as any).next(wrapStored(event));
      });

      await waitFor(() => {
        expect(onAnnotationBodyUpdated).toHaveBeenCalledWith(event);
      });
    });

    it('dispatches mark:entity-tag-added to onEntityTagAdded', async () => {
      const onEntityTagAdded = vi.fn();
      const { result } = renderWithHandlers({ onEntityTagAdded });

      const event = makeEvent('mark:entity-tag-added', { entityType: 'Animal' } as any);

      act(() => {
        result.current.bus.get('mark:entity-tag-added' as any).next(wrapStored(event));
      });

      await waitFor(() => {
        expect(onEntityTagAdded).toHaveBeenCalledWith(event);
      });
    });

    it('dispatches mark:entity-tag-removed to onEntityTagRemoved', async () => {
      const onEntityTagRemoved = vi.fn();
      const { result } = renderWithHandlers({ onEntityTagRemoved });

      const event = makeEvent('mark:entity-tag-removed', { entityType: 'Animal' } as any);

      act(() => {
        result.current.bus.get('mark:entity-tag-removed' as any).next(wrapStored(event));
      });

      await waitFor(() => {
        expect(onEntityTagRemoved).toHaveBeenCalledWith(event);
      });
    });

    it('dispatches mark:archived to onDocumentArchived', async () => {
      const onDocumentArchived = vi.fn();
      const { result } = renderWithHandlers({ onDocumentArchived });

      const event = makeEvent('mark:archived', {} as any);

      act(() => {
        result.current.bus.get('mark:archived' as any).next(wrapStored(event));
      });

      await waitFor(() => {
        expect(onDocumentArchived).toHaveBeenCalledWith(event);
      });
    });

    it('dispatches mark:unarchived to onDocumentUnarchived', async () => {
      const onDocumentUnarchived = vi.fn();
      const { result } = renderWithHandlers({ onDocumentUnarchived });

      const event = makeEvent('mark:unarchived', {} as any);

      act(() => {
        result.current.bus.get('mark:unarchived' as any).next(wrapStored(event));
      });

      await waitFor(() => {
        expect(onDocumentUnarchived).toHaveBeenCalledWith(event);
      });
    });

    it('calls onEvent for every event type', async () => {
      const onEvent = vi.fn();
      const { result } = renderWithHandlers({ onEvent });

      const event = makeEvent('mark:added', { annotation: { id: 'ann-1' } } as any);

      act(() => {
        result.current.bus.get('mark:added' as any).next(wrapStored(event));
      });

      await waitFor(() => {
        expect(onEvent).toHaveBeenCalledWith(event);
      });
    });

    it('increments eventCount on each event', async () => {
      const { result } = renderWithHandlers({});

      act(() => {
        result.current.bus.get('mark:added' as any).next(
          wrapStored(makeEvent('mark:added', { annotation: { id: 'ann-1' } } as any))
        );
      });

      await waitFor(() => expect(result.current.events.eventCount).toBe(1));

      act(() => {
        result.current.bus.get('mark:removed' as any).next(
          wrapStored(makeEvent('mark:removed', { annotationId: 'ann-1' } as any))
        );
      });

      await waitFor(() => expect(result.current.events.eventCount).toBe(2));
    });

    it('updates lastEvent on each event', async () => {
      const { result } = renderWithHandlers({});

      const event = makeEvent('mark:added', { annotation: { id: 'ann-1' } } as any);

      act(() => {
        result.current.bus.get('mark:added' as any).next(wrapStored(event));
      });

      await waitFor(() => {
        expect(result.current.events.lastEvent).toEqual(event);
      });
    });
  });

  it('unsubscribes from the flow on unmount', async () => {
    const unsub = vi.fn();
    mockFlowResourceEvents.mockReturnValue({ unsubscribe: unsub });

    const { unmount } = renderHook(
      () => useResourceEvents({ rUri: RID }),
      { wrapper }
    );

    await waitFor(() => expect(mockFlowResourceEvents).toHaveBeenCalled());
    unmount();

    expect(unsub).toHaveBeenCalled();
  });

  it('isConnected is true when status is connected', async () => {
    const { result } = renderHook(
      () => useResourceEvents({ rUri: RID }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.isConnected).toBe(true));
  });
});
