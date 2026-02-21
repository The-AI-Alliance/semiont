/**
 * Unit tests for useAttentionFlow
 *
 * Tests the annotation attention / pointer coordination hook:
 * - annotation:hover → sets hoveredAnnotationId + emits annotation:sparkle
 * - annotation:hover (null) → clears hoveredAnnotationId, no sparkle
 * - annotation:click → emits annotation:focus
 * - Subscriptions cleaned up on unmount (no stale listeners)
 * - Only one annotation:sparkle emitted per hover (not doubled)
 *
 * Uses real EventBus and real useEventSubscriptions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useAttentionFlow } from '../useAttentionFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../contexts/EventBusContext';

// ─── Test harness ──────────────────────────────────────────────────────────────

function renderAttentionFlow() {
  let eventBusInstance: ReturnType<typeof useEventBus> | null = null;
  let lastState: ReturnType<typeof useAttentionFlow> | null = null;

  function TestComponent() {
    eventBusInstance = useEventBus();
    lastState = useAttentionFlow();
    return null;
  }

  render(
    <EventBusProvider>
      <TestComponent />
    </EventBusProvider>
  );

  return {
    getState: () => lastState!,
    getEventBus: () => eventBusInstance!,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('useAttentionFlow', () => {
  beforeEach(() => {
    resetEventBusForTesting();
  });

  describe('initial state', () => {
    it('starts with hoveredAnnotationId as null', () => {
      const { getState } = renderAttentionFlow();
      expect(getState().hoveredAnnotationId).toBeNull();
    });
  });

  describe('annotation:hover', () => {
    it('sets hoveredAnnotationId when annotation is hovered', () => {
      const { getState, getEventBus } = renderAttentionFlow();

      act(() => { getEventBus().get('annotation:hover').next({ annotationId: 'ann-1' }); });

      expect(getState().hoveredAnnotationId).toBe('ann-1');
    });

    it('clears hoveredAnnotationId when null is hovered (mouse leaves)', () => {
      const { getState, getEventBus } = renderAttentionFlow();

      act(() => { getEventBus().get('annotation:hover').next({ annotationId: 'ann-1' }); });
      expect(getState().hoveredAnnotationId).toBe('ann-1');

      act(() => { getEventBus().get('annotation:hover').next({ annotationId: null }); });
      expect(getState().hoveredAnnotationId).toBeNull();
    });

    it('updates hoveredAnnotationId when a different annotation is hovered', () => {
      const { getState, getEventBus } = renderAttentionFlow();

      act(() => { getEventBus().get('annotation:hover').next({ annotationId: 'ann-1' }); });
      act(() => { getEventBus().get('annotation:hover').next({ annotationId: 'ann-2' }); });

      expect(getState().hoveredAnnotationId).toBe('ann-2');
    });

    it('emits annotation:sparkle when a non-null annotation is hovered', () => {
      const { getEventBus } = renderAttentionFlow();
      const sparkleSpy = vi.fn();

      const unsubscribe = getEventBus().get('annotation:sparkle').subscribe(sparkleSpy);
      act(() => { getEventBus().get('annotation:hover').next({ annotationId: 'ann-sparkle' }); });
      unsubscribe.unsubscribe();

      expect(sparkleSpy).toHaveBeenCalledTimes(1);
      expect(sparkleSpy).toHaveBeenCalledWith({ annotationId: 'ann-sparkle' });
    });

    it('does NOT emit annotation:sparkle when null is hovered', () => {
      const { getEventBus } = renderAttentionFlow();
      const sparkleSpy = vi.fn();

      const unsubscribe = getEventBus().get('annotation:sparkle').subscribe(sparkleSpy);
      act(() => { getEventBus().get('annotation:hover').next({ annotationId: null }); });
      unsubscribe.unsubscribe();

      expect(sparkleSpy).not.toHaveBeenCalled();
    });

    it('emits annotation:sparkle exactly ONCE per hover (no duplicate subscriptions)', () => {
      const { getEventBus } = renderAttentionFlow();
      const sparkleSpy = vi.fn();

      const unsubscribe = getEventBus().get('annotation:sparkle').subscribe(sparkleSpy);
      act(() => { getEventBus().get('annotation:hover').next({ annotationId: 'ann-once' }); });
      unsubscribe.unsubscribe();

      // If useAttentionFlow were registered twice, sparkle would fire twice
      expect(sparkleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('annotation:click', () => {
    it('emits annotation:focus when an annotation is clicked', () => {
      const { getEventBus } = renderAttentionFlow();
      const focusSpy = vi.fn();

      const unsubscribe = getEventBus().get('annotation:focus').subscribe(focusSpy);
      act(() => { getEventBus().get('annotation:click').next({ annotationId: 'ann-click', motivation: 'highlighting' }); });
      unsubscribe.unsubscribe();

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(focusSpy).toHaveBeenCalledWith({ annotationId: 'ann-click' });
    });

    it('emits annotation:focus exactly ONCE per click (no duplicate subscriptions)', () => {
      const { getEventBus } = renderAttentionFlow();
      const focusSpy = vi.fn();

      const unsubscribe = getEventBus().get('annotation:focus').subscribe(focusSpy);
      act(() => { getEventBus().get('annotation:click').next({ annotationId: 'ann-dedup', motivation: 'commenting' }); });
      unsubscribe.unsubscribe();

      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT change hoveredAnnotationId on click', () => {
      const { getState, getEventBus } = renderAttentionFlow();

      // Hover first
      act(() => { getEventBus().get('annotation:hover').next({ annotationId: 'ann-hovered' }); });
      expect(getState().hoveredAnnotationId).toBe('ann-hovered');

      // Click a different annotation — hover state should be unaffected
      act(() => { getEventBus().get('annotation:click').next({ annotationId: 'ann-clicked', motivation: 'highlighting' }); });
      expect(getState().hoveredAnnotationId).toBe('ann-hovered');
    });
  });

  describe('unmount cleanup', () => {
    it('stops responding to annotation:hover after unmount', () => {
      let eventBusInstance: ReturnType<typeof useEventBus> | null = null;
      let lastState: { hoveredAnnotationId: string | null } | null = null;

      function TestComponent() {
        eventBusInstance = useEventBus();
        lastState = useAttentionFlow();
        return null;
      }

      const { unmount } = render(
        <EventBusProvider>
          <TestComponent />
        </EventBusProvider>
      );

      act(() => { eventBusInstance!.get('annotation:hover').next({ annotationId: 'pre-unmount' }); });
      expect(lastState!.hoveredAnnotationId).toBe('pre-unmount');

      unmount();

      // Post-unmount events must not cause state updates (would throw React warning)
      expect(() => {
        act(() => { eventBusInstance!.get('annotation:hover').next({ annotationId: 'post-unmount' }); });
      }).not.toThrow();
    });

    it('stops emitting annotation:sparkle after unmount', () => {
      let eventBusInstance: ReturnType<typeof useEventBus> | null = null;

      function TestComponent() {
        eventBusInstance = useEventBus();
        useAttentionFlow();
        return null;
      }

      const { unmount } = render(
        <EventBusProvider>
          <TestComponent />
        </EventBusProvider>
      );

      unmount();

      const sparkleSpy = vi.fn();
      const subscription = eventBusInstance!.get('annotation:sparkle').subscribe(sparkleSpy);
      act(() => { eventBusInstance!.get('annotation:hover').next({ annotationId: 'ghost' }); });
      subscription.unsubscribe();

      expect(sparkleSpy).not.toHaveBeenCalled();
    });
  });

});
