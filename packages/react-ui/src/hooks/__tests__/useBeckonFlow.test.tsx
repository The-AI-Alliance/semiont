/**
 * Unit tests for useBeckonFlow
 *
 * Tests the annotation attention / pointer coordination hook:
 * - beckon:hover → sets hoveredAnnotationId + emits beckon:sparkle
 * - beckon:hover (null) → clears hoveredAnnotationId, no sparkle
 * - browse:click → emits beckon:focus
 * - Subscriptions cleaned up on unmount (no stale listeners)
 * - Only one beckon:sparkle emitted per hover (not doubled)
 *
 * Uses real EventBus and real useEventSubscriptions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useBeckonFlow } from '../useBeckonFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../contexts/EventBusContext';

// ─── Test harness ──────────────────────────────────────────────────────────────

function renderBeckonFlow() {
  let eventBusInstance: ReturnType<typeof useEventBus> | null = null;
  let lastState: ReturnType<typeof useBeckonFlow> | null = null;

  function TestComponent() {
    eventBusInstance = useEventBus();
    lastState = useBeckonFlow();
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

describe('useBeckonFlow', () => {
  beforeEach(() => {
    resetEventBusForTesting();
  });

  describe('initial state', () => {
    it('starts with hoveredAnnotationId as null', () => {
      const { getState } = renderBeckonFlow();
      expect(getState().hoveredAnnotationId).toBeNull();
    });
  });

  describe('beckon:hover', () => {
    it('sets hoveredAnnotationId when annotation is hovered', () => {
      const { getState, getEventBus } = renderBeckonFlow();

      act(() => { getEventBus().get('beckon:hover').next({ annotationId: 'ann-1' }); });

      expect(getState().hoveredAnnotationId).toBe('ann-1');
    });

    it('clears hoveredAnnotationId when null is hovered (mouse leaves)', () => {
      const { getState, getEventBus } = renderBeckonFlow();

      act(() => { getEventBus().get('beckon:hover').next({ annotationId: 'ann-1' }); });
      expect(getState().hoveredAnnotationId).toBe('ann-1');

      act(() => { getEventBus().get('beckon:hover').next({ annotationId: null }); });
      expect(getState().hoveredAnnotationId).toBeNull();
    });

    it('updates hoveredAnnotationId when a different annotation is hovered', () => {
      const { getState, getEventBus } = renderBeckonFlow();

      act(() => { getEventBus().get('beckon:hover').next({ annotationId: 'ann-1' }); });
      act(() => { getEventBus().get('beckon:hover').next({ annotationId: 'ann-2' }); });

      expect(getState().hoveredAnnotationId).toBe('ann-2');
    });

    it('emits beckon:sparkle when a non-null annotation is hovered', () => {
      const { getEventBus } = renderBeckonFlow();
      const sparkleSpy = vi.fn();

      const unsubscribe = getEventBus().get('beckon:sparkle').subscribe(sparkleSpy);
      act(() => { getEventBus().get('beckon:hover').next({ annotationId: 'ann-sparkle' }); });
      unsubscribe.unsubscribe();

      expect(sparkleSpy).toHaveBeenCalledTimes(1);
      expect(sparkleSpy).toHaveBeenCalledWith({ annotationId: 'ann-sparkle' });
    });

    it('does NOT emit beckon:sparkle when null is hovered', () => {
      const { getEventBus } = renderBeckonFlow();
      const sparkleSpy = vi.fn();

      const unsubscribe = getEventBus().get('beckon:sparkle').subscribe(sparkleSpy);
      act(() => { getEventBus().get('beckon:hover').next({ annotationId: null }); });
      unsubscribe.unsubscribe();

      expect(sparkleSpy).not.toHaveBeenCalled();
    });

    it('emits beckon:sparkle exactly ONCE per hover (no duplicate subscriptions)', () => {
      const { getEventBus } = renderBeckonFlow();
      const sparkleSpy = vi.fn();

      const unsubscribe = getEventBus().get('beckon:sparkle').subscribe(sparkleSpy);
      act(() => { getEventBus().get('beckon:hover').next({ annotationId: 'ann-once' }); });
      unsubscribe.unsubscribe();

      // If useBeckonFlow were registered twice, sparkle would fire twice
      expect(sparkleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('browse:click', () => {
    it('emits beckon:focus when an annotation is clicked', () => {
      const { getEventBus } = renderBeckonFlow();
      const focusSpy = vi.fn();

      const unsubscribe = getEventBus().get('beckon:focus').subscribe(focusSpy);
      act(() => { getEventBus().get('browse:click').next({ annotationId: 'ann-click', motivation: 'highlighting' }); });
      unsubscribe.unsubscribe();

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(focusSpy).toHaveBeenCalledWith({ annotationId: 'ann-click' });
    });

    it('emits beckon:focus exactly ONCE per click (no duplicate subscriptions)', () => {
      const { getEventBus } = renderBeckonFlow();
      const focusSpy = vi.fn();

      const unsubscribe = getEventBus().get('beckon:focus').subscribe(focusSpy);
      act(() => { getEventBus().get('browse:click').next({ annotationId: 'ann-dedup', motivation: 'commenting' }); });
      unsubscribe.unsubscribe();

      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT change hoveredAnnotationId on click', () => {
      const { getState, getEventBus } = renderBeckonFlow();

      // Hover first
      act(() => { getEventBus().get('beckon:hover').next({ annotationId: 'ann-hovered' }); });
      expect(getState().hoveredAnnotationId).toBe('ann-hovered');

      // Click a different annotation — hover state should be unaffected
      act(() => { getEventBus().get('browse:click').next({ annotationId: 'ann-clicked', motivation: 'highlighting' }); });
      expect(getState().hoveredAnnotationId).toBe('ann-hovered');
    });
  });

  describe('unmount cleanup', () => {
    it('stops responding to beckon:hover after unmount', () => {
      let eventBusInstance: ReturnType<typeof useEventBus> | null = null;
      let lastState: { hoveredAnnotationId: string | null } | null = null;

      function TestComponent() {
        eventBusInstance = useEventBus();
        lastState = useBeckonFlow();
        return null;
      }

      const { unmount } = render(
        <EventBusProvider>
          <TestComponent />
        </EventBusProvider>
      );

      act(() => { eventBusInstance!.get('beckon:hover').next({ annotationId: 'pre-unmount' }); });
      expect(lastState!.hoveredAnnotationId).toBe('pre-unmount');

      unmount();

      // Post-unmount events must not cause state updates (would throw React warning)
      expect(() => {
        act(() => { eventBusInstance!.get('beckon:hover').next({ annotationId: 'post-unmount' }); });
      }).not.toThrow();
    });

    it('stops emitting beckon:sparkle after unmount', () => {
      let eventBusInstance: ReturnType<typeof useEventBus> | null = null;

      function TestComponent() {
        eventBusInstance = useEventBus();
        useBeckonFlow();
        return null;
      }

      const { unmount } = render(
        <EventBusProvider>
          <TestComponent />
        </EventBusProvider>
      );

      unmount();

      const sparkleSpy = vi.fn();
      const subscription = eventBusInstance!.get('beckon:sparkle').subscribe(sparkleSpy);
      act(() => { eventBusInstance!.get('beckon:hover').next({ annotationId: 'ghost' }); });
      subscription.unsubscribe();

      expect(sparkleSpy).not.toHaveBeenCalled();
    });
  });

});
