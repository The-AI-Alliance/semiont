/**
 * Tests for usePanelNavigation hook
 *
 * Validates the panel navigation capability:
 * - Panel state management (open/close/toggle)
 * - localStorage persistence
 * - Scroll coordination
 * - Initial tab routing with generation counter
 * - Event subscriptions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../contexts/EventBusContext';
import { usePanelNavigation } from '../usePanelNavigation';

// Test harness
function renderPanelNavigation() {
  let eventBusInstance: ReturnType<typeof useEventBus> | null = null;
  let lastState: ReturnType<typeof usePanelNavigation> | null = null;

  function TestComponent() {
    eventBusInstance = useEventBus();
    lastState = usePanelNavigation();
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

describe('usePanelNavigation', () => {
  beforeEach(() => {
    resetEventBusForTesting();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('initializes with no active panel', () => {
    const { getState } = renderPanelNavigation();

    expect(getState().activePanel).toBe(null);
    expect(getState().scrollToAnnotationId).toBe(null);
    expect(getState().panelInitialTab).toBe(null);
  });

  it('loads active panel from localStorage on mount', () => {
    localStorage.setItem('activeToolbarPanel', 'annotations');

    const { getState } = renderPanelNavigation();

    expect(getState().activePanel).toBe('annotations');
  });

  it('opens panel on attend:panel-open event', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'annotations',
      });
    });

    await waitFor(() => {
      expect(getState().activePanel).toBe('annotations');
    });
  });

  it('closes panel on attend:panel-close event', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    // First open a panel
    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'annotations',
      });
    });

    await waitFor(() => {
      expect(getState().activePanel).toBe('annotations');
    });

    // Then close it
    act(() => {
      getEventBus().get('attend:panel-close').next();
    });

    await waitFor(() => {
      expect(getState().activePanel).toBe(null);
    });
  });

  it('toggles panel on attend:panel-toggle event', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    // Toggle to open
    act(() => {
      getEventBus().get('attend:panel-toggle').next({
        panel: 'settings',
      });
    });

    await waitFor(() => {
      expect(getState().activePanel).toBe('settings');
    });

    // Toggle to close
    act(() => {
      getEventBus().get('attend:panel-toggle').next({
        panel: 'settings',
      });
    });

    await waitFor(() => {
      expect(getState().activePanel).toBe(null);
    });
  });

  it('switches to different panel when toggling different panel', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    // Open annotations panel
    act(() => {
      getEventBus().get('attend:panel-toggle').next({
        panel: 'annotations',
      });
    });

    await waitFor(() => {
      expect(getState().activePanel).toBe('annotations');
    });

    // Toggle settings panel (should switch, not close)
    act(() => {
      getEventBus().get('attend:panel-toggle').next({
        panel: 'settings',
      });
    });

    await waitFor(() => {
      expect(getState().activePanel).toBe('settings');
    });
  });

  it('persists active panel to localStorage', async () => {
    const { getEventBus } = renderPanelNavigation();

    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'info',
      });
    });

    await waitFor(() => {
      expect(localStorage.getItem('activeToolbarPanel')).toBe('info');
    });
  });

  it('removes localStorage entry when panel is closed', async () => {
    const { getEventBus } = renderPanelNavigation();

    // Open panel
    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'history',
      });
    });

    await waitFor(() => {
      expect(localStorage.getItem('activeToolbarPanel')).toBe('history');
    });

    // Close panel
    act(() => {
      getEventBus().get('attend:panel-close').next();
    });

    await waitFor(() => {
      expect(localStorage.getItem('activeToolbarPanel')).toBe(null);
    });
  });

  it('sets scrollToAnnotationId when panel opens with scroll target', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'annotations',
        scrollToAnnotationId: 'anno-123',
      });
    });

    await waitFor(() => {
      expect(getState().scrollToAnnotationId).toBe('anno-123');
    });
  });

  it('clears scrollToAnnotationId on scroll completed', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    // Open with scroll target
    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'annotations',
        scrollToAnnotationId: 'anno-456',
      });
    });

    await waitFor(() => {
      expect(getState().scrollToAnnotationId).toBe('anno-456');
    });

    // Simulate scroll completion
    act(() => {
      getState().onScrollCompleted();
    });

    await waitFor(() => {
      expect(getState().scrollToAnnotationId).toBe(null);
    });
  });

  it('sets panelInitialTab when opening with motivation', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'annotations',
        motivation: 'linking',
      });
    });

    await waitFor(() => {
      expect(getState().panelInitialTab).toMatchObject({
        tab: 'reference',
        generation: expect.any(Number),
      });
    });
  });

  it('maps motivations to correct tab keys', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    const motivationToTab = [
      { motivation: 'linking', expectedTab: 'reference' },
      { motivation: 'commenting', expectedTab: 'comment' },
      { motivation: 'tagging', expectedTab: 'tag' },
      { motivation: 'highlighting', expectedTab: 'highlight' },
      { motivation: 'assessing', expectedTab: 'assessment' },
    ];

    for (const { motivation, expectedTab } of motivationToTab) {
      act(() => {
        getEventBus().get('attend:panel-open').next({
          panel: 'annotations',
          motivation,
        });
      });

      await waitFor(() => {
        expect(getState().panelInitialTab?.tab).toBe(expectedTab);
      });
    }
  });

  it('increments generation counter on each panel open with motivation', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'annotations',
        motivation: 'highlighting',
      });
    });

    await waitFor(() => {
      expect(getState().panelInitialTab).toBeTruthy();
    });

    const firstGeneration = getState().panelInitialTab!.generation;

    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'annotations',
        motivation: 'commenting',
      });
    });

    await waitFor(() => {
      const secondGeneration = getState().panelInitialTab!.generation;
      expect(secondGeneration).toBeGreaterThan(firstGeneration);
    });
  });

  it('defaults to highlight tab for unknown motivation', async () => {
    const { getState, getEventBus } = renderPanelNavigation();

    act(() => {
      getEventBus().get('attend:panel-open').next({
        panel: 'annotations',
        motivation: 'unknown-motivation',
      });
    });

    await waitFor(() => {
      expect(getState().panelInitialTab?.tab).toBe('highlight');
    });
  });

  it('provides onScrollCompleted callback', () => {
    const { getState } = renderPanelNavigation();

    expect(typeof getState().onScrollCompleted).toBe('function');
  });
});
