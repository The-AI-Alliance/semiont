import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBus } from '@semiont/core';
import { useEventSubscription, useEventSubscriptions } from '../useEventSubscription';
import { createTestSemiontWrapper } from '../../test-utils';
import type { ReactNode } from 'react';

function makeWrapper(): {
  wrapper: (props: { children: ReactNode }) => JSX.Element;
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
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-1' });
      });

      expect(handler).toHaveBeenCalledWith({ annotationId: 'ann-1' });
      expect(handler).toHaveBeenCalledTimes(1);
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
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-1' });
      });
      expect(calls).toEqual(['initial']);

      message = 'updated';
      rerender();

      act(() => {
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-2' });
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
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-1' });
      });
      expect(handler1).toHaveBeenCalledTimes(1);

      currentHandler = handler2;
      rerender();

      act(() => {
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-2' });
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
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-1' });
      });
      expect(handler).toHaveBeenCalledTimes(1);

      unmount();

      act(() => {
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-2' });
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
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-1' });
        (eventBus.get('browse:click') as any).next({ annotationId: 'ann-2' });
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
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-1' });
      });
      expect(calls).toEqual(['hover:initial']);

      message = 'updated';
      rerender();

      act(() => {
        (eventBus.get('browse:click') as any).next({ annotationId: 'ann-2' });
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
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-1' });
        (eventBus.get('browse:click') as any).next({ annotationId: 'ann-2' });
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
        (eventBus.get('beckon:hover') as any).next({ annotationId: 'ann-1' });
        (eventBus.get('browse:click') as any).next({ annotationId: 'ann-2' });
      });

      expect(handler1).toHaveBeenCalledTimes(1);
    });
  });
});
