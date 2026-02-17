import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EventBusProvider,
  useEventBus,
  resetEventBusForTesting
} from '../EventBusContext';

describe('EventBusContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <EventBusProvider>
      {children}
    </EventBusProvider>
  );

  describe('useEventBus', () => {
    it('should throw error when used outside provider', () => {
      expect(() => {
        renderHook(() => useEventBus());
      }).toThrow('useEventBus must be used within EventBusProvider');
    });

    it('should return event bus when used inside provider', () => {
      const { result } = renderHook(() => useEventBus(), { wrapper });

      expect(result.current).toBeDefined();
      expect(result.current.emit).toBeDefined();
      expect(result.current.on).toBeDefined();
      expect(result.current.off).toBeDefined();
    });
  });

  describe('Event emission and subscription', () => {
    it('should allow subscribing to and emitting UI events', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('annotation:hover', handler);
        result.current.emit('annotation:hover', { annotationId: 'ann-123' });
      });

      expect(handler).toHaveBeenCalledWith({ annotationId: 'ann-123' });
    });

    it('should allow subscribing to panel toggle events', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('panel:toggle', handler);
        result.current.emit('panel:toggle', { panel: 'comments' });
      });

      expect(handler).toHaveBeenCalledWith({ panel: 'comments' });
    });

    it('should allow subscribing to toolbar events', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('toolbar:selection-changed', handler);
        result.current.emit('toolbar:selection-changed', { motivation: 'highlighting' });
      });

      expect(handler).toHaveBeenCalledWith({ motivation: 'highlighting' });
    });

    it('should allow subscribing to navigation events', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('navigation:sidebar-toggle', handler);
        result.current.emit('navigation:sidebar-toggle', undefined);
      });

      expect(handler).toHaveBeenCalled();
    });

    it('should allow subscribing to settings events', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('settings:theme-changed', handler);
        result.current.emit('settings:theme-changed', { theme: 'dark' });
      });

      expect(handler).toHaveBeenCalledWith({ theme: 'dark' });
    });

    it('should allow subscribing to API operation events', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('annotation:create', handler);
        result.current.emit('annotation:create', {
          motivation: 'highlighting',
          selector: { type: 'TextQuoteSelector', exact: 'test' },
          body: [{ type: 'TextualBody', value: 'highlight' }]
        });
      });

      expect(handler).toHaveBeenCalled();
    });

    it('should allow subscribing to detection events', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('detection:start', handler);
        result.current.emit('detection:start', {
          motivation: 'highlighting',
          options: { instructions: 'Find important parts' }
        });
      });

      expect(handler).toHaveBeenCalledWith({
        motivation: 'highlighting',
        options: { instructions: 'Find important parts' }
      });
    });

    it('should support multiple subscribers to the same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('annotation:hover', handler1);
        result.current.on('annotation:hover', handler2);
        result.current.emit('annotation:hover', { annotationId: 'ann-123' });
      });

      expect(handler1).toHaveBeenCalledWith({ annotationId: 'ann-123' });
      expect(handler2).toHaveBeenCalledWith({ annotationId: 'ann-123' });
    });
  });

  describe('Event unsubscription', () => {
    it('should allow unsubscribing from events', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('annotation:hover', handler);
        result.current.emit('annotation:hover', { annotationId: 'ann-1' });
      });

      expect(handler).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.off('annotation:hover', handler);
        result.current.emit('annotation:hover', { annotationId: 'ann-2' });
      });

      // Should still be called only once (from before unsubscribing)
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should only unsubscribe the specific handler', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('annotation:hover', handler1);
        result.current.on('annotation:hover', handler2);

        // Unsubscribe only handler1
        result.current.off('annotation:hover', handler1);

        result.current.emit('annotation:hover', { annotationId: 'ann-1' });
      });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledWith({ annotationId: 'ann-1' });
    });
  });

  describe('Global singleton event bus', () => {
    it('should share the same event bus instance across multiple providers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const wrapper1 = ({ children }: { children: React.ReactNode }) => (
        <EventBusProvider>
          {children}
        </EventBusProvider>
      );

      const wrapper2 = ({ children }: { children: React.ReactNode }) => (
        <EventBusProvider>
          {children}
        </EventBusProvider>
      );

      const { result: result1 } = renderHook(() => useEventBus(), { wrapper: wrapper1 });
      const { result: result2 } = renderHook(() => useEventBus(), { wrapper: wrapper2 });

      act(() => {
        result1.current.on('annotation:hover', handler1);
        result2.current.on('annotation:hover', handler2);

        // Emit on bus 1 - should trigger both handlers since it's the same global bus
        result1.current.emit('annotation:hover', { annotationId: 'ann-1' });
      });

      // Both handlers should be called because they share the same global event bus
      expect(handler1).toHaveBeenCalledWith({ annotationId: 'ann-1' });
      expect(handler2).toHaveBeenCalledWith({ annotationId: 'ann-1' });
    });

    it('should return the same event bus reference across different hook calls', () => {
      const { result: result1 } = renderHook(() => useEventBus(), { wrapper });
      const { result: result2 } = renderHook(() => useEventBus(), { wrapper });

      // Both hooks should return the exact same object reference
      expect(result1.current).toBe(result2.current);
    });
  });

  describe('Complex event flows', () => {
    it('should handle annotation workflow events', () => {
      const createHandler = vi.fn();
      const createdHandler = vi.fn();
      const hoverHandler = vi.fn();

      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        // Subscribe to annotation events
        result.current.on('annotation:create', createHandler);
        result.current.on('annotation:created', createdHandler);
        result.current.on('annotation:hover', hoverHandler);

        // Simulate annotation creation flow
        result.current.emit('annotation:create', {
          motivation: 'commenting',
          selector: { type: 'TextQuoteSelector', exact: 'important text' },
          body: [{ type: 'TextualBody', value: 'my comment' }]
        });

        // Simulate successful creation (would normally come from API)
        result.current.emit('annotation:created', {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            type: 'Annotation',
            id: 'ann-123',
            motivation: 'commenting',
            target: { source: 'r:test-resource' },
            body: []
          } as any
        });

        // Simulate hover
        result.current.emit('annotation:hover', { annotationId: 'ann-123' });
      });

      expect(createHandler).toHaveBeenCalled();
      expect(createdHandler).toHaveBeenCalled();
      expect(hoverHandler).toHaveBeenCalledWith({ annotationId: 'ann-123' });
    });

    it('should handle detection workflow events', () => {
      const startHandler = vi.fn();
      const progressHandler = vi.fn();
      const completeHandler = vi.fn();

      const { result } = renderHook(() => useEventBus(), { wrapper });

      act(() => {
        result.current.on('detection:start', startHandler);
        result.current.on('detection:progress', progressHandler);
        result.current.on('detection:complete', completeHandler);

        // Start detection
        result.current.emit('detection:start', {
          motivation: 'tagging',
          options: { schemaId: 'legal', categories: ['Issue', 'Rule'] }
        });

        // Progress update
        result.current.emit('detection:progress', {
          type: 'job.progress',
          payload: { current: 5, total: 10 }
        } as any);

        // Complete
        result.current.emit('detection:complete', { motivation: 'tagging' });
      });

      expect(startHandler).toHaveBeenCalled();
      expect(progressHandler).toHaveBeenCalled();
      expect(completeHandler).toHaveBeenCalledWith({ motivation: 'tagging' });
    });
  });
});
