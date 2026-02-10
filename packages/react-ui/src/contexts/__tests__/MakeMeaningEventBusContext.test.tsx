import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MakeMeaningEventBusProvider, useMakeMeaningEvents } from '../MakeMeaningEventBusContext';
import type { ResourceEvent } from '@semiont/core';
import type { ResourceUri } from '@semiont/api-client';

// Mock useResourceEvents hook
vi.mock('../../hooks/useResourceEvents', () => ({
  useResourceEvents: vi.fn(({ onEvent }) => {
    // Store the onEvent callback for test control
    (global as any).__mockOnEvent = onEvent;
    return { status: 'connected', eventCount: 0 };
  })
}));

describe('MakeMeaningEventBusContext', () => {
  const testRUri = 'r:test-resource' as ResourceUri;

  beforeEach(() => {
    vi.clearAllMocks();
    delete (global as any).__mockOnEvent;
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MakeMeaningEventBusProvider rUri={testRUri}>
      {children}
    </MakeMeaningEventBusProvider>
  );

  describe('useMakeMeaningEvents', () => {
    it('should throw error when used outside provider', () => {
      expect(() => {
        renderHook(() => useMakeMeaningEvents());
      }).toThrow('useMakeMeaningEvents must be used within MakeMeaningEventBusProvider');
    });

    it('should return event bus when used inside provider', () => {
      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      expect(result.current).toBeDefined();
      expect(typeof result.current.on).toBe('function');
      expect(typeof result.current.off).toBe('function');
      expect(typeof result.current.emit).toBe('function');
    });
  });

  describe('Event translation', () => {
    it('should translate job.started to detection:started for detection jobs', () => {
      const handler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('detection:started', handler);

        // Simulate backend event
        const event: ResourceEvent = {
          type: 'job.started',
          payload: { jobType: 'detection', totalSteps: 3 }
        } as ResourceEvent;

        (global as any).__mockOnEvent(event);
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'job.started',
          payload: expect.objectContaining({ jobType: 'detection' })
        })
      );
    });

    it('should translate job.started to generation:started for generation jobs', () => {
      const handler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('generation:started', handler);

        // Simulate backend event
        const event: ResourceEvent = {
          type: 'job.started',
          payload: { jobType: 'generation', totalSteps: 4 }
        } as ResourceEvent;

        (global as any).__mockOnEvent(event);
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'job.started',
          payload: expect.objectContaining({ jobType: 'generation' })
        })
      );
    });

    it('should translate job.progress to detection:progress for detection jobs', () => {
      const handler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('detection:progress', handler);

        const event: ResourceEvent = {
          type: 'job.progress',
          payload: { jobType: 'detection', percentage: 50, currentStep: 'Person' }
        } as ResourceEvent;

        (global as any).__mockOnEvent(event);
      });

      expect(handler).toHaveBeenCalled();
    });

    it('should emit both annotation:added and detection:entity-found for detected entities', () => {
      const annotationHandler = vi.fn();
      const detectionHandler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('annotation:added', annotationHandler);
        result.current.on('detection:entity-found', detectionHandler);

        // Simulate make-meaning detecting an entity
        const event: ResourceEvent = {
          type: 'annotation.added',
          payload: { annotation: { id: 'ann-1' } }
        } as ResourceEvent;

        (global as any).__mockOnEvent(event);
      });

      expect(annotationHandler).toHaveBeenCalled();
      expect(detectionHandler).toHaveBeenCalled();
    });

    it('should translate annotation.removed to annotation:removed', () => {
      const handler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('annotation:removed', handler);

        const event: ResourceEvent = {
          type: 'annotation.removed',
          payload: { annotationId: 'ann-1' }
        } as ResourceEvent;

        (global as any).__mockOnEvent(event);
      });

      expect(handler).toHaveBeenCalled();
    });

    it('should translate annotation.body.updated to annotation:updated', () => {
      const handler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('annotation:updated', handler);

        const event: ResourceEvent = {
          type: 'annotation.body.updated',
          payload: { annotationId: 'ann-1', body: {} }
        } as ResourceEvent;

        (global as any).__mockOnEvent(event);
      });

      expect(handler).toHaveBeenCalled();
    });

    it('should translate resource.archived to resource:archived', () => {
      const handler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('resource:archived', handler);

        const event: ResourceEvent = {
          type: 'resource.archived',
          payload: { resourceId: 'r:test' }
        } as ResourceEvent;

        (global as any).__mockOnEvent(event);
      });

      expect(handler).toHaveBeenCalled();
    });

    it('should translate entitytag.added to entity-tag:added', () => {
      const handler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('entity-tag:added', handler);

        const event: ResourceEvent = {
          type: 'entitytag.added',
          payload: { entityType: 'Person', tag: 'Alice' }
        } as ResourceEvent;

        (global as any).__mockOnEvent(event);
      });

      expect(handler).toHaveBeenCalled();
    });

    it('should emit generic make-meaning:event for all events', () => {
      const handler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('make-meaning:event', handler);

        const event: ResourceEvent = {
          type: 'job.started',
          payload: { jobType: 'detection', totalSteps: 3 }
        } as ResourceEvent;

        (global as any).__mockOnEvent(event);
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'job.started'
        })
      );
    });
  });

  describe('Event subscription cleanup', () => {
    it('should allow unsubscribing from events', () => {
      const handler = vi.fn();

      const { result } = renderHook(() => useMakeMeaningEvents(), { wrapper });

      act(() => {
        result.current.on('detection:started', handler);

        // Emit event - should be handled
        const event1: ResourceEvent = {
          type: 'job.started',
          payload: { jobType: 'detection', totalSteps: 3 }
        } as ResourceEvent;
        (global as any).__mockOnEvent(event1);

        // Unsubscribe
        result.current.off('detection:started', handler);

        // Emit another event - should NOT be handled
        const event2: ResourceEvent = {
          type: 'job.started',
          payload: { jobType: 'detection', totalSteps: 3 }
        } as ResourceEvent;
        (global as any).__mockOnEvent(event2);
      });

      // Handler should only be called once (before unsubscribe)
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
