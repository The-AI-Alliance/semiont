import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBusProvider, useEventBus } from '../EventBusContext';
import { useEventSubscription, useEventSubscriptions } from '../useEventSubscription';
import type { ReactNode } from 'react';

describe('useEventSubscription', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <EventBusProvider>{children}</EventBusProvider>
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Single event subscription', () => {
    it('should call handler when event is emitted', () => {
      const handler = vi.fn();

      const { result } = renderHook(
        () => {
          const eventBus = useEventBus();
          useEventSubscription('attend:hover', handler);
          return eventBus;
        },
        { wrapper }
      );

      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-1' });
      });

      expect(handler).toHaveBeenCalledWith({ annotationId: 'ann-1' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should always use latest handler (no stale closure)', () => {
      const calls: string[] = [];
      let message = 'initial';

      const { rerender, result } = renderHook(
        () => {
          const eventBus = useEventBus();

          // Handler captures 'message' from current render
          useEventSubscription('attend:hover', () => {
            calls.push(message);
          });

          return eventBus;
        },
        { wrapper }
      );

      // Emit with initial message
      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-1' });
      });
      expect(calls).toEqual(['initial']);

      // Change message and re-render
      message = 'updated';
      rerender();

      // Emit again - should use UPDATED message (not stale 'initial')
      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-2' });
      });
      expect(calls).toEqual(['initial', 'updated']);
    });

    it('should not re-subscribe when handler changes', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      let currentHandler = handler1;

      const { rerender, result } = renderHook(
        () => {
          const eventBus = useEventBus();
          useEventSubscription('attend:hover', currentHandler);
          return eventBus;
        },
        { wrapper }
      );

      // Emit with first handler
      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-1' });
      });
      expect(handler1).toHaveBeenCalledTimes(1);

      // Change handler (but don't change subscription)
      currentHandler = handler2;
      rerender();

      // Emit again - should call NEW handler
      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-2' });
      });
      expect(handler1).toHaveBeenCalledTimes(1); // Still only called once
      expect(handler2).toHaveBeenCalledTimes(1); // New handler called
    });

    it('should cleanup subscription on unmount', () => {
      const handler = vi.fn();

      const { unmount, result } = renderHook(
        () => {
          const eventBus = useEventBus();
          useEventSubscription('attend:hover', handler);
          return eventBus;
        },
        { wrapper }
      );

      // Emit before unmount
      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-1' });
      });
      expect(handler).toHaveBeenCalledTimes(1);

      // Unmount
      unmount();

      // Emit after unmount - handler should NOT be called
      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-2' });
      });
      expect(handler).toHaveBeenCalledTimes(1); // Still only 1
    });
  });

  describe('Multiple event subscriptions', () => {
    it('should subscribe to multiple events', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const { result } = renderHook(
        () => {
          const eventBus = useEventBus();

          useEventSubscriptions({
            'attend:hover': handler1,
            'navigation:click': handler2,
          });

          return eventBus;
        },
        { wrapper }
      );

      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-1' });
        result.current.get('navigation:click').next({ annotationId: 'ann-2' });
      });

      expect(handler1).toHaveBeenCalledWith({ annotationId: 'ann-1' });
      expect(handler2).toHaveBeenCalledWith({ annotationId: 'ann-2' });
    });

    it('should use latest handlers without re-subscribing', () => {
      const calls: string[] = [];
      let message = 'initial';

      const { rerender, result } = renderHook(
        () => {
          const eventBus = useEventBus();

          useEventSubscriptions({
            'attend:hover': () => calls.push(`hover:${message}`),
            'navigation:click': () => calls.push(`click:${message}`),
          });

          return eventBus;
        },
        { wrapper }
      );

      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-1' });
      });
      expect(calls).toEqual(['hover:initial']);

      // Change message and re-render
      message = 'updated';
      rerender();

      act(() => {
        result.current.get('navigation:click').next({ annotationId: 'ann-2' });
      });
      expect(calls).toEqual(['hover:initial', 'click:updated']);
    });

    it('should cleanup all subscriptions on unmount', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const { unmount, result } = renderHook(
        () => {
          const eventBus = useEventBus();

          useEventSubscriptions({
            'attend:hover': handler1,
            'navigation:click': handler2,
          });

          return eventBus;
        },
        { wrapper }
      );

      unmount();

      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-1' });
        result.current.get('navigation:click').next({ annotationId: 'ann-2' });
      });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should handle optional subscriptions (undefined handlers)', () => {
      const handler1 = vi.fn();

      const { result } = renderHook(
        () => {
          const eventBus = useEventBus();

          useEventSubscriptions({
            'attend:hover': handler1,
            'navigation:click': undefined, // Optional
          });

          return eventBus;
        },
        { wrapper }
      );

      act(() => {
        result.current.get('attend:hover').next({ annotationId: 'ann-1' });
        result.current.get('navigation:click').next({ annotationId: 'ann-2' });
      });

      expect(handler1).toHaveBeenCalledTimes(1);
      // No error from undefined handler
    });
  });
});
