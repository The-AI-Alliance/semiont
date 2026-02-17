/**
 * useGenerationProgress Hook Tests
 *
 * Tests the event-driven generation progress tracking hook.
 * The hook subscribes to generation events from the event bus
 * and updates local state accordingly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useGenerationProgress } from '../useGenerationProgress';
import { EventBusProvider, useEventBus, resetEventBusForTesting, type EventBus } from '../../contexts/EventBusContext';
import type { GenerationProgress } from '../../types/progress';

// Wrapper component to provide EventBus context
const wrapper = ({ children }: { children: ReactNode }) =>
  React.createElement(EventBusProvider, { children });

// Helper: render a hook that returns the event bus, used to emit test events
function captureEventBus(): EventBus {
  const { result } = renderHook(() => useEventBus(), { wrapper });
  return result.current;
}

// A shared reference annotation ID for test data
const TEST_REF_ID = 'test-annotation-ref-id';

// Helper to build a valid GenerationProgress
function makeProgress(overrides: Partial<GenerationProgress> = {}): GenerationProgress {
  return {
    status: 'generating',
    referenceId: TEST_REF_ID,
    percentage: 50,
    message: 'Working...',
    ...overrides,
  };
}

describe('useGenerationProgress', () => {
  beforeEach(() => {
    resetEventBusForTesting();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useGenerationProgress(), { wrapper });

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(typeof result.current.clearProgress).toBe('function');
  });

  it('should set isGenerating to true and update progress on generation:progress event', async () => {
    const { result } = renderHook(() => useGenerationProgress(), { wrapper });
    const bus = captureEventBus();

    const mockProgress = makeProgress({ status: 'generating', percentage: 30, message: 'Generating content...' });

    act(() => {
      bus.emit('generation:progress', mockProgress);
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
      expect(result.current.progress).toEqual(mockProgress);
    });
  });

  it('should update progress on subsequent generation:progress events', async () => {
    const { result } = renderHook(() => useGenerationProgress(), { wrapper });
    const bus = captureEventBus();

    const firstProgress = makeProgress({ status: 'started', percentage: 0, message: 'Starting...' });
    const secondProgress = makeProgress({ status: 'generating', percentage: 50, message: 'Half way...' });

    act(() => {
      bus.emit('generation:progress', firstProgress);
    });

    await waitFor(() => {
      expect(result.current.progress).toEqual(firstProgress);
    });

    act(() => {
      bus.emit('generation:progress', secondProgress);
    });

    await waitFor(() => {
      expect(result.current.progress).toEqual(secondProgress);
      expect(result.current.isGenerating).toBe(true);
    });
  });

  it('should set isGenerating to false and update progress on generation:complete event', async () => {
    const { result } = renderHook(() => useGenerationProgress(), { wrapper });
    const bus = captureEventBus();

    // First simulate some progress
    act(() => {
      bus.emit('generation:progress', makeProgress({ percentage: 75, message: 'Almost done...' }));
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
    });

    // Now complete
    const finalProgress = makeProgress({ status: 'complete', percentage: 100, message: 'Generation complete!' });

    act(() => {
      bus.emit('generation:complete', {
        annotationUri: 'http://localhost:4000/annotations/test-ref-id',
        progress: finalProgress,
      });
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(result.current.progress).toEqual(finalProgress);
    });
  });

  it('should clear progress and set isGenerating to false on generation:failed event', async () => {
    const { result } = renderHook(() => useGenerationProgress(), { wrapper });
    const bus = captureEventBus();

    // First simulate some progress
    act(() => {
      bus.emit('generation:progress', makeProgress({ percentage: 40 }));
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
    });

    // Now fail
    act(() => {
      bus.emit('generation:failed', {
        error: new Error('Generation failed'),
      });
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(result.current.progress).toBeNull();
    });
  });

  it('should clear progress when clearProgress is called', async () => {
    const { result } = renderHook(() => useGenerationProgress(), { wrapper });
    const bus = captureEventBus();

    // Set some progress first
    act(() => {
      bus.emit('generation:progress', makeProgress());
    });

    await waitFor(() => {
      expect(result.current.progress).not.toBeNull();
    });

    act(() => {
      result.current.clearProgress();
    });

    expect(result.current.progress).toBeNull();
  });

  it('should not affect isGenerating when clearProgress is called', async () => {
    const { result } = renderHook(() => useGenerationProgress(), { wrapper });
    const bus = captureEventBus();

    act(() => {
      bus.emit('generation:progress', makeProgress());
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
    });

    act(() => {
      result.current.clearProgress();
    });

    // clearProgress only clears progress, not isGenerating
    expect(result.current.progress).toBeNull();
    expect(result.current.isGenerating).toBe(true);
  });

  it('should handle generation:complete event without prior progress', async () => {
    const { result } = renderHook(() => useGenerationProgress(), { wrapper });
    const bus = captureEventBus();

    const finalProgress = makeProgress({ status: 'complete', percentage: 100, message: 'Done!' });

    act(() => {
      bus.emit('generation:complete', {
        annotationUri: 'http://localhost:4000/annotations/test-ref-id',
        progress: finalProgress,
      });
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(result.current.progress).toEqual(finalProgress);
    });
  });

  it('should handle generation:failed event without prior progress gracefully', async () => {
    const { result } = renderHook(() => useGenerationProgress(), { wrapper });
    const bus = captureEventBus();

    act(() => {
      bus.emit('generation:failed', {
        error: new Error('Unexpected failure'),
      });
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(result.current.progress).toBeNull();
    });
  });
});
