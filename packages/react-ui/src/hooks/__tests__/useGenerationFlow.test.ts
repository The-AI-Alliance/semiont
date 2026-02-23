/**
 * useGenerationFlow - Generation Progress State Tests
 *
 * Tests the generation progress tracking behaviour that was formerly in
 * useGenerationProgress.  The state is now inlined directly into
 * useGenerationFlow.
 *
 * Subscribes to generation events from the event bus and verifies that
 * isGenerating / generationProgress / clearProgress behave correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useGenerationFlow } from '../useGenerationFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting, type EventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import type { GenerationProgress } from '@semiont/core';

// Full provider stack required by useGenerationFlow
const wrapper = ({ children }: { children: ReactNode }) =>
  React.createElement(
    EventBusProvider,
    null,
    React.createElement(
      AuthTokenProvider,
      { token: null },
      React.createElement(
        ApiClientProvider,
        { baseUrl: 'http://localhost:4000' },
        children
      )
    )
  );

// Helper: capture the event bus from inside the provider tree
function captureEventBus(): EventBus {
  const { result } = renderHook(() => useEventBus(), { wrapper });
  return result.current;
}

// Stable no-op callbacks for useGenerationFlow params
const noop = () => {};
const mockShowSuccess = vi.fn();
const mockShowError = vi.fn();
const mockClearNewAnnotationId = vi.fn();

function renderGenerationFlow() {
  return renderHook(
    () => useGenerationFlow('en', 'test-resource', mockShowSuccess, mockShowError, mockClearNewAnnotationId),
    { wrapper }
  );
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

describe('useGenerationFlow — progress state', () => {
  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default progress state', () => {
    const { result } = renderGenerationFlow();

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.generationProgress).toBeNull();
  });

  it('should set isGenerating to true and update progress on generation:progress event', async () => {
    const { result } = renderGenerationFlow();
    const eventBus = captureEventBus();

    const mockProgress = makeProgress({ status: 'generating', percentage: 30, message: 'Generating content...' });

    act(() => {
      eventBus.get('generation:progress').next(mockProgress);
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
      expect(result.current.generationProgress).toEqual(mockProgress);
    });
  });

  it('should update progress on subsequent generation:progress events', async () => {
    const { result } = renderGenerationFlow();
    const eventBus = captureEventBus();

    const firstProgress = makeProgress({ status: 'started', percentage: 0, message: 'Starting...' });
    const secondProgress = makeProgress({ status: 'generating', percentage: 50, message: 'Half way...' });

    act(() => {
      eventBus.get('generation:progress').next(firstProgress);
    });

    await waitFor(() => {
      expect(result.current.generationProgress).toEqual(firstProgress);
    });

    act(() => {
      eventBus.get('generation:progress').next(secondProgress);
    });

    await waitFor(() => {
      expect(result.current.generationProgress).toEqual(secondProgress);
      expect(result.current.isGenerating).toBe(true);
    });
  });

  it('should set isGenerating to false and update progress on generation:complete event', async () => {
    const { result } = renderGenerationFlow();
    const eventBus = captureEventBus();

    // First simulate some progress
    act(() => {
      eventBus.get('generation:progress').next(makeProgress({ percentage: 75, message: 'Almost done...' }));
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
    });

    // Now complete
    const finalProgress = makeProgress({ status: 'complete', percentage: 100, message: 'Generation complete!' });

    act(() => {
      eventBus.get('generation:complete').next(finalProgress);
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(result.current.generationProgress).toEqual(finalProgress);
    });
  });

  it('should clear progress and set isGenerating to false on generation:failed event', async () => {
    const { result } = renderGenerationFlow();
    const eventBus = captureEventBus();

    // First simulate some progress
    act(() => {
      eventBus.get('generation:progress').next(makeProgress({ percentage: 40 }));
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
    });

    // Now fail
    act(() => {
      eventBus.get('generation:failed').next({
        error: new Error('Generation failed'),
      });
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(result.current.generationProgress).toBeNull();
    });
  });

  it('should handle generation:complete event without prior progress', async () => {
    const { result } = renderGenerationFlow();
    const eventBus = captureEventBus();

    const finalProgress = makeProgress({ status: 'complete', percentage: 100, message: 'Done!' });

    act(() => {
      eventBus.get('generation:complete').next(finalProgress);
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(result.current.generationProgress).toEqual(finalProgress);
    });
  });

  it('should handle generation:failed event without prior progress gracefully', async () => {
    const { result } = renderGenerationFlow();
    const eventBus = captureEventBus();

    act(() => {
      eventBus.get('generation:failed').next({
        error: new Error('Unexpected failure'),
      });
    });

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(result.current.generationProgress).toBeNull();
    });
  });
});
