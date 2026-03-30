/**
 * useYieldFlow - Generation Progress State Tests
 *
 * Tests the generation progress tracking behaviour that was formerly in
 * useYieldProgress.  The state is now inlined directly into
 * useYieldFlow.
 *
 * Subscribes to generation events from the event bus and verifies that
 * isGenerating / generationProgress / clearProgress behave correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { useYieldFlow } from '../useYieldFlow';
import { EventBusProvider, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import type { YieldProgress } from '@semiont/core';

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

// Full provider stack required by useYieldFlow
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

const mockClearNewAnnotationId = vi.fn();

function renderYieldFlow() {
  return renderHook(
    () => ({
      flow: useYieldFlow('en', 'test-resource', mockClearNewAnnotationId),
      eventBus: useEventBus(),
    }),
    { wrapper }
  );
}

// A shared reference annotation ID for test data
const TEST_REF_ID = 'test-annotation-ref-id';

// Helper to build a valid YieldProgress
function makeProgress(overrides: Partial<YieldProgress> = {}): YieldProgress {
  return {
    status: 'generating',
    referenceId: TEST_REF_ID,
    percentage: 50,
    message: 'Working...',
    ...overrides,
  };
}

describe('useYieldFlow — progress state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default progress state', () => {
    const { result } = renderYieldFlow();

    expect(result.current.flow.isGenerating).toBe(false);
    expect(result.current.flow.generationProgress).toBeNull();
  });

  it('should set isGenerating to true and update progress on yield:progress event', async () => {
    const { result } = renderYieldFlow();

    const mockProgress = makeProgress({ status: 'generating', percentage: 30, message: 'Generating content...' });

    act(() => {
      result.current.eventBus.get('yield:progress').next(mockProgress);
    });

    await waitFor(() => {
      expect(result.current.flow.isGenerating).toBe(true);
      expect(result.current.flow.generationProgress).toEqual(mockProgress);
    });
  });

  it('should update progress on subsequent yield:progress events', async () => {
    const { result } = renderYieldFlow();

    const firstProgress = makeProgress({ status: 'started', percentage: 0, message: 'Starting...' });
    const secondProgress = makeProgress({ status: 'generating', percentage: 50, message: 'Half way...' });

    act(() => {
      result.current.eventBus.get('yield:progress').next(firstProgress);
    });

    await waitFor(() => {
      expect(result.current.flow.generationProgress).toEqual(firstProgress);
    });

    act(() => {
      result.current.eventBus.get('yield:progress').next(secondProgress);
    });

    await waitFor(() => {
      expect(result.current.flow.generationProgress).toEqual(secondProgress);
      expect(result.current.flow.isGenerating).toBe(true);
    });
  });

  it('should set isGenerating to false and update progress on yield:finished event', async () => {
    const { result } = renderYieldFlow();

    // First simulate some progress
    act(() => {
      result.current.eventBus.get('yield:progress').next(makeProgress({ percentage: 75, message: 'Almost done...' }));
    });

    await waitFor(() => {
      expect(result.current.flow.isGenerating).toBe(true);
    });

    // Now complete
    const finalProgress = makeProgress({ status: 'complete', percentage: 100, message: 'Generation complete!' });

    act(() => {
      result.current.eventBus.get('yield:finished').next(finalProgress);
    });

    await waitFor(() => {
      expect(result.current.flow.isGenerating).toBe(false);
      expect(result.current.flow.generationProgress).toEqual(finalProgress);
    });
  });

  it('should clear progress and set isGenerating to false on yield:failed event', async () => {
    const { result } = renderYieldFlow();

    // First simulate some progress
    act(() => {
      result.current.eventBus.get('yield:progress').next(makeProgress({ percentage: 40 }));
    });

    await waitFor(() => {
      expect(result.current.flow.isGenerating).toBe(true);
    });

    // Now fail
    act(() => {
      result.current.eventBus.get('yield:failed').next({
        error: new Error('Generation failed'),
      });
    });

    await waitFor(() => {
      expect(result.current.flow.isGenerating).toBe(false);
      expect(result.current.flow.generationProgress).toBeNull();
    });
  });

  it('should handle yield:finished event without prior progress', async () => {
    const { result } = renderYieldFlow();

    const finalProgress = makeProgress({ status: 'complete', percentage: 100, message: 'Done!' });

    act(() => {
      result.current.eventBus.get('yield:finished').next(finalProgress);
    });

    await waitFor(() => {
      expect(result.current.flow.isGenerating).toBe(false);
      expect(result.current.flow.generationProgress).toEqual(finalProgress);
    });
  });

  it('should handle yield:failed event without prior progress gracefully', async () => {
    const { result } = renderYieldFlow();

    act(() => {
      result.current.eventBus.get('yield:failed').next({
        error: new Error('Unexpected failure'),
      });
    });

    await waitFor(() => {
      expect(result.current.flow.isGenerating).toBe(false);
      expect(result.current.flow.generationProgress).toBeNull();
    });
  });
});
