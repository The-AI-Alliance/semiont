import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resourceId, userId, type EventBus, type EventOfType, type ResourceId, type StoredEvent } from '@semiont/core';
import { useEventSubscription, useEventSubscriptions, useResourceEventSubscriptions } from '../useEventSubscription';
import { createTestSemiontWrapper } from '../../test-utils';
import type { ReactNode } from 'react';

function makeWrapper(): {
  wrapper: (props: { children: ReactNode }) => ReactNode;
  eventBus: EventBus;
} {
  const { SemiontWrapper, eventBus } = createTestSemiontWrapper();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  return { wrapper, eventBus };
}

describe('useEventSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Single event subscription', () => {
    it('should call handler when event is emitted', () => {
      const handler = vi.fn();
      const { wrapper, eventBus } = makeWrapper();

      renderHook(
        () => useEventSubscription('beckon:hover', handler),
        { wrapper },
      );

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-1' }) as never);
      });

      expect(handler).toHaveBeenCalledWith({ annotationId: 'ann-1' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('delivers browse:resource-open to a subscriber — the tour imperative', () => {
      // The channel is bridged (BRIDGED_BROADCASTS), so a launcher emit
      // arrives on this bus over SSE; the viewer's handler turns it into
      // routes.resourceDetail → nav:push. This pins the subscription half.
      const handler = vi.fn();
      const { wrapper, eventBus } = makeWrapper();

      renderHook(
        () => useEventSubscription('browse:resource-open', handler),
        { wrapper },
      );

      act(() => {
        eventBus.emit('browse:resource-open', ({ resourceId: 'res-42' }) as never);
      });

      expect(handler).toHaveBeenCalledWith({ resourceId: 'res-42' });
    });

    it('should always use latest handler (no stale closure)', () => {
      const calls: string[] = [];
      let message = 'initial';
      const { wrapper, eventBus } = makeWrapper();

      const { rerender } = renderHook(
        () => {
          useEventSubscription('beckon:hover', () => {
            calls.push(message);
          });
        },
        { wrapper },
      );

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-1' }) as never);
      });
      expect(calls).toEqual(['initial']);

      message = 'updated';
      rerender();

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-2' }) as never);
      });
      expect(calls).toEqual(['initial', 'updated']);
    });

    it('should not re-subscribe when handler changes', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      let currentHandler = handler1;
      const { wrapper, eventBus } = makeWrapper();

      const { rerender } = renderHook(
        () => useEventSubscription('beckon:hover', currentHandler),
        { wrapper },
      );

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-1' }) as never);
      });
      expect(handler1).toHaveBeenCalledTimes(1);

      currentHandler = handler2;
      rerender();

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-2' }) as never);
      });
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should cleanup subscription on unmount', () => {
      const handler = vi.fn();
      const { wrapper, eventBus } = makeWrapper();

      const { unmount } = renderHook(
        () => useEventSubscription('beckon:hover', handler),
        { wrapper },
      );

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-1' }) as never);
      });
      expect(handler).toHaveBeenCalledTimes(1);

      unmount();

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-2' }) as never);
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Multiple event subscriptions', () => {
    it('should subscribe to multiple events', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const { wrapper, eventBus } = makeWrapper();

      renderHook(
        () => {
          useEventSubscriptions({
            'beckon:hover': handler1,
            'browse:click': handler2,
          });
        },
        { wrapper },
      );

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-1' }) as never);
        eventBus.emit('browse:click', ({ annotationId: 'ann-2' }) as never);
      });

      expect(handler1).toHaveBeenCalledWith({ annotationId: 'ann-1' });
      expect(handler2).toHaveBeenCalledWith({ annotationId: 'ann-2' });
    });

    it('should use latest handlers without re-subscribing', () => {
      const calls: string[] = [];
      let message = 'initial';
      const { wrapper, eventBus } = makeWrapper();

      const { rerender } = renderHook(
        () => {
          useEventSubscriptions({
            'beckon:hover': () => calls.push(`hover:${message}`),
            'browse:click': () => calls.push(`click:${message}`),
          });
        },
        { wrapper },
      );

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-1' }) as never);
      });
      expect(calls).toEqual(['hover:initial']);

      message = 'updated';
      rerender();

      act(() => {
        eventBus.emit('browse:click', ({ annotationId: 'ann-2' }) as never);
      });
      expect(calls).toEqual(['hover:initial', 'click:updated']);
    });

    it('should cleanup all subscriptions on unmount', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const { wrapper, eventBus } = makeWrapper();

      const { unmount } = renderHook(
        () => {
          useEventSubscriptions({
            'beckon:hover': handler1,
            'browse:click': handler2,
          });
        },
        { wrapper },
      );

      unmount();

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-1' }) as never);
        eventBus.emit('browse:click', ({ annotationId: 'ann-2' }) as never);
      });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should handle optional subscriptions (undefined handlers)', () => {
      const handler1 = vi.fn();
      const { wrapper, eventBus } = makeWrapper();

      renderHook(
        () => {
          useEventSubscriptions({
            'beckon:hover': handler1,
            'browse:click': undefined,
          });
        },
        { wrapper },
      );

      act(() => {
        eventBus.emit('beckon:hover', ({ annotationId: 'ann-1' }) as never);
        eventBus.emit('browse:click', ({ annotationId: 'ann-2' }) as never);
      });

      expect(handler1).toHaveBeenCalledTimes(1);
    });
  });
});

describe('useResourceEventSubscriptions', () => {
  const RID = resourceId('res-1');
  const OTHER = resourceId('res-2');

  function archived(of: ResourceId): StoredEvent<EventOfType<'mark:archived'>> {
    return {
      id: `evt-${of}`,
      type: 'mark:archived',
      resourceId: of,
      userId: userId('did:web:example.org:users:alice'),
      version: 1,
      timestamp: '2026-01-01T00:00:00Z',
      payload: {},
      metadata: { sequenceNumber: 1 },
    };
  }

  it("holds the resource's scope while mounted, and is given that resource's events only", () => {
    const { SemiontWrapper, eventBus, client } = createTestSemiontWrapper();
    const leave = vi.fn();
    const held = vi.spyOn(client.transport, 'subscribeToResource').mockReturnValue(leave);
    const seen: string[] = [];

    const { unmount } = renderHook(
      () => useResourceEventSubscriptions(RID, { 'mark:archived': (stored) => seen.push(stored.id) }),
      { wrapper: ({ children }: { children: ReactNode }) => <SemiontWrapper>{children}</SemiontWrapper> },
    );
    expect(held).toHaveBeenCalledExactlyOnceWith(RID);

    act(() => {
      eventBus.emit('mark:archived', archived(RID));
      eventBus.emit('mark:archived', archived(OTHER));
    });
    expect(seen).toEqual(['evt-res-1']);

    unmount();
    expect(leave).toHaveBeenCalledOnce();
  });

  it('a scoped channel is not one the generic hooks take: the types refuse it, and so does the session', () => {
    const { wrapper } = makeWrapper();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      renderHook(
        () => {
          // @ts-expect-error — mark:archived is read for one resource: useResourceEventSubscriptions
          useEventSubscriptions({ 'mark:archived': () => {} });
        },
        { wrapper },
      ),
    ).toThrow(/mark:archived.*resource/);
    quiet.mockRestore();
  });
});
