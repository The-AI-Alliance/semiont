/**
 * Unit tests for useAttentionFlow
 *
 * Tests the annotation attention / pointer coordination hook:
 * - attend:hover → sets hoveredAnnotationId + emits attend:sparkle
 * - attend:hover (null) → clears hoveredAnnotationId, no sparkle
 * - attend:click → emits attend:focus
 * - Subscriptions cleaned up on unmount (no stale listeners)
 * - Only one attend:sparkle emitted per hover (not doubled)
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

  describe('attend:hover', () => {
    it('sets hoveredAnnotationId when annotation is hovered', () => {
      const { getState, getEventBus } = renderAttentionFlow();

      act(() => { getEventBus().get('attend:hover').next({ annotationId: 'ann-1' }); });

      expect(getState().hoveredAnnotationId).toBe('ann-1');
    });

    it('clears hoveredAnnotationId when null is hovered (mouse leaves)', () => {
      const { getState, getEventBus } = renderAttentionFlow();

      act(() => { getEventBus().get('attend:hover').next({ annotationId: 'ann-1' }); });
      expect(getState().hoveredAnnotationId).toBe('ann-1');

      act(() => { getEventBus().get('attend:hover').next({ annotationId: null }); });
      expect(getState().hoveredAnnotationId).toBeNull();
    });

    it('updates hoveredAnnotationId when a different annotation is hovered', () => {
      const { getState, getEventBus } = renderAttentionFlow();

      act(() => { getEventBus().get('attend:hover').next({ annotationId: 'ann-1' }); });
      act(() => { getEventBus().get('attend:hover').next({ annotationId: 'ann-2' }); });

      expect(getState().hoveredAnnotationId).toBe('ann-2');
    });

    it('emits attend:sparkle when a non-null annotation is hovered', () => {
      const { getEventBus } = renderAttentionFlow();
      const sparkleSpy = vi.fn();

      const unsubscribe = getEventBus().get('attend:sparkle').subscribe(sparkleSpy);
      act(() => { getEventBus().get('attend:hover').next({ annotationId: 'ann-sparkle' }); });
      unsubscribe.unsubscribe();

      expect(sparkleSpy).toHaveBeenCalledTimes(1);
      expect(sparkleSpy).toHaveBeenCalledWith({ annotationId: 'ann-sparkle' });
    });

    it('does NOT emit attend:sparkle when null is hovered', () => {
      const { getEventBus } = renderAttentionFlow();
      const sparkleSpy = vi.fn();

      const unsubscribe = getEventBus().get('attend:sparkle').subscribe(sparkleSpy);
      act(() => { getEventBus().get('attend:hover').next({ annotationId: null }); });
      unsubscribe.unsubscribe();

      expect(sparkleSpy).not.toHaveBeenCalled();
    });

    it('emits attend:sparkle exactly ONCE per hover (no duplicate subscriptions)', () => {
      const { getEventBus } = renderAttentionFlow();
      const sparkleSpy = vi.fn();

      const unsubscribe = getEventBus().get('attend:sparkle').subscribe(sparkleSpy);
      act(() => { getEventBus().get('attend:hover').next({ annotationId: 'ann-once' }); });
      unsubscribe.unsubscribe();

      // If useAttentionFlow were registered twice, sparkle would fire twice
      expect(sparkleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('attend:click', () => {
    it('emits attend:focus when an annotation is clicked', () => {
      const { getEventBus } = renderAttentionFlow();
      const focusSpy = vi.fn();

      const unsubscribe = getEventBus().get('attend:focus').subscribe(focusSpy);
      act(() => { getEventBus().get('attend:click').next({ annotationId: 'ann-click', motivation: 'highlighting' }); });
      unsubscribe.unsubscribe();

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(focusSpy).toHaveBeenCalledWith({ annotationId: 'ann-click' });
    });

    it('emits attend:focus exactly ONCE per click (no duplicate subscriptions)', () => {
      const { getEventBus } = renderAttentionFlow();
      const focusSpy = vi.fn();

      const unsubscribe = getEventBus().get('attend:focus').subscribe(focusSpy);
      act(() => { getEventBus().get('attend:click').next({ annotationId: 'ann-dedup', motivation: 'commenting' }); });
      unsubscribe.unsubscribe();

      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT change hoveredAnnotationId on click', () => {
      const { getState, getEventBus } = renderAttentionFlow();

      // Hover first
      act(() => { getEventBus().get('attend:hover').next({ annotationId: 'ann-hovered' }); });
      expect(getState().hoveredAnnotationId).toBe('ann-hovered');

      // Click a different annotation — hover state should be unaffected
      act(() => { getEventBus().get('attend:click').next({ annotationId: 'ann-clicked', motivation: 'highlighting' }); });
      expect(getState().hoveredAnnotationId).toBe('ann-hovered');
    });
  });

  describe('unmount cleanup', () => {
    it('stops responding to attend:hover after unmount', () => {
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

      act(() => { eventBusInstance!.get('attend:hover').next({ annotationId: 'pre-unmount' }); });
      expect(lastState!.hoveredAnnotationId).toBe('pre-unmount');

      unmount();

      // Post-unmount events must not cause state updates (would throw React warning)
      expect(() => {
        act(() => { eventBusInstance!.get('attend:hover').next({ annotationId: 'post-unmount' }); });
      }).not.toThrow();
    });

    it('stops emitting attend:sparkle after unmount', () => {
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
      const subscription = eventBusInstance!.get('attend:sparkle').subscribe(sparkleSpy);
      act(() => { eventBusInstance!.get('attend:hover').next({ annotationId: 'ghost' }); });
      subscription.unsubscribe();

      expect(sparkleSpy).not.toHaveBeenCalled();
    });
  });

});
