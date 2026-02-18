/**
 * Layer 3: Feature Integration Test - Detection Flow Architecture
 *
 * Tests the COMPLETE detection flow with real component composition:
 * - EventBusProvider (REAL)
 * - ApiClientProvider (REAL, with MOCKED client)
 * - useDetectionFlow (REAL)
 * - useResolutionFlow (REAL)
 * - useEventSubscriptions (REAL)
 *
 * This test focuses on ARCHITECTURE and EVENT WIRING:
 * - Verifies API called exactly ONCE (catches duplicate subscriptions)
 * - Tests event propagation through the event bus
 * - Validates different motivations call correct API methods
 * - Ensures multiple event listeners don't cause duplicate API calls
 *
 * COMPLEMENTARY TEST: See detection-progress-flow.test.tsx for UI/UX testing
 * - That test verifies the USER EXPERIENCE (button clicks, progress display)
 * - This test verifies the SYSTEM ARCHITECTURE (event wiring, API calls)
 *
 * NO BACKEND SERVER - only mocked API client boundary
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useDetectionFlow } from '../../../hooks/useDetectionFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SSEClient } from '@semiont/api-client';
import type { Motivation } from '@semiont/api-client';
import { resourceUri } from '@semiont/api-client';
import type { Emitter } from 'mitt';
import type { EventMap } from '../../../contexts/EventBusContext';

// Mock SSE stream that we can control in tests
const createMockSSEStream = () => {
  const stream = {
    onProgressCallback: null as ((chunk: any) => void) | null,
    onCompleteCallback: null as (() => void) | null,
    onErrorCallback: null as ((error: Error) => void) | null,
    onProgress: vi.fn((callback: (chunk: any) => void) => {
      stream.onProgressCallback = callback;
      return stream;
    }),
    onComplete: vi.fn((callback: () => void) => {
      stream.onCompleteCallback = callback;
      return stream;
    }),
    onError: vi.fn((callback: (error: Error) => void) => {
      stream.onErrorCallback = callback;
      return stream;
    }),
    close: vi.fn(),
  };
  return stream;
};

describe('Detection Flow - Feature Integration', () => {
  let mockStream: ReturnType<typeof createMockSSEStream>;
  let detectReferencesSpy: any;
  let detectHighlightsSpy: any;
  let detectCommentsSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();

    // Create fresh mock stream for each test
    mockStream = createMockSSEStream();

    // Spy on SSEClient prototype methods
    detectReferencesSpy = vi.spyOn(SSEClient.prototype, 'detectReferences').mockReturnValue(mockStream as any);
    detectHighlightsSpy = vi.spyOn(SSEClient.prototype, 'detectHighlights').mockReturnValue(mockStream as any);
    detectCommentsSpy = vi.spyOn(SSEClient.prototype, 'detectComments').mockReturnValue(mockStream as any);
    vi.spyOn(SSEClient.prototype, 'detectAssessments').mockReturnValue(mockStream as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call detectReferences exactly ONCE when detection starts (not twice)', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');

    // Render with real component composition
    const { emitDetectionStart } = renderDetectionFlow(testUri);

    // Trigger detection for linking (uses detectReferences)
    act(() => {
      emitDetectionStart('linking', {
        entityTypes: ['Person', 'Organization'],
        includeDescriptiveReferences: false
      });
    });

    // CRITICAL ASSERTION: API called exactly once (not twice!)
    // This would FAIL if useResolutionFlow was called in multiple places
    await waitFor(() => {
      expect(detectReferencesSpy).toHaveBeenCalledTimes(1);
    });

    // Verify correct parameters
    expect(detectReferencesSpy).toHaveBeenCalledWith(
      testUri,
      {
        entityTypes: ['Person', 'Organization'],
        includeDescriptiveReferences: false,
      },
      { auth: undefined }
    );
  });

  it('should propagate SSE progress events to useDetectionFlow state', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');

    // Render with state observer
    const { emitDetectionStart } = renderDetectionFlow(testUri);

    // Start detection
    act(() => {
      emitDetectionStart('linking', {
        entityTypes: ['Person']
      });
    });

    // Wait for stream to be created
    await waitFor(() => {
      expect(detectReferencesSpy).toHaveBeenCalled();
    });

    // Simulate SSE progress callback being invoked
    act(() => {
      mockStream.onProgressCallback!({
        status: 'scanning',
        message: 'Scanning for Person...',
        currentEntityType: 'Person',
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        foundCount: 5,
      });
    });

    // Verify progress propagated to UI
    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Scanning for Person...');
      expect(screen.getByTestId('detecting')).toHaveTextContent('linking');
    });
  });

  it('should handle multiple progress updates correctly', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');
    const { emitDetectionStart } = renderDetectionFlow(testUri);

    // Start detection
    act(() => {
      emitDetectionStart('highlighting', {
        instructions: 'Find important passages'
      });
    });

    await waitFor(() => {
      expect(detectHighlightsSpy).toHaveBeenCalledTimes(1);
    });

    // First progress update
    act(() => {
      mockStream.onProgressCallback!({
        status: 'started',
        message: 'Starting analysis...',
        percentage: 0,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Starting analysis...');
    });

    // Second progress update
    act(() => {
      mockStream.onProgressCallback!({
        status: 'analyzing',
        message: 'Analyzing text...',
        percentage: 50,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Analyzing text...');
    });

    // Final progress update
    act(() => {
      mockStream.onProgressCallback!({
        status: 'complete',
        message: 'Created 14 highlights',
        percentage: 100,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Created 14 highlights');
    });
  });

  it('should keep progress visible after detection completes', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');
    const { emitDetectionStart, getEventBus } = renderDetectionFlow(testUri);

    // Start detection
    act(() => {
      emitDetectionStart('highlighting', { instructions: 'Test' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('detecting')).toHaveTextContent('highlighting');
    });

    // Send final progress
    act(() => {
      mockStream.onProgressCallback!({
        status: 'complete',
        message: 'Created 14 highlights',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Created 14 highlights');
    });

    // Emit completion event
    act(() => {
      getEventBus().emit('detection:complete', { motivation: 'highlighting' });
    });

    // Verify: detecting flag cleared BUT progress still visible
    await waitFor(() => {
      expect(screen.getByTestId('detecting')).toHaveTextContent('none');
      expect(screen.getByTestId('progress')).toHaveTextContent('Created 14 highlights');
    });
  });

  it('should clear progress on detection failure', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');
    const { emitDetectionStart, getEventBus } = renderDetectionFlow(testUri);

    // Start detection
    act(() => {
      emitDetectionStart('linking', { entityTypes: ['Person'] });
    });

    // Add some progress
    act(() => {
      mockStream.onProgressCallback!({
        status: 'scanning',
        message: 'Scanning...',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Scanning...');
    });

    // Emit failure
    act(() => {
      getEventBus().emit('detection:failed', { type: 'job.failed', resourceId: 'test-resource' as any, payload: { jobId: 'job-1' as any, jobType: 'detection', error: 'Network error' } });
    });

    // Verify: both detecting and progress cleared
    await waitFor(() => {
      expect(screen.getByTestId('detecting')).toHaveTextContent('none');
      expect(screen.getByTestId('progress')).toHaveTextContent('No progress');
    });
  });

  it('should handle different detection motivations with correct API calls', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');
    const { emitDetectionStart } = renderDetectionFlow(testUri);

    // Test highlighting
    act(() => {
      emitDetectionStart('highlighting', { instructions: 'Find important text' });
    });

    await waitFor(() => {
      expect(detectHighlightsSpy).toHaveBeenCalledTimes(1);
      expect(detectHighlightsSpy).toHaveBeenCalledWith(testUri, {
        instructions: 'Find important text',
      }, { auth: undefined });
    });

    // Reset for next test
    vi.clearAllMocks();
    mockStream = createMockSSEStream();
    detectCommentsSpy.mockReturnValue(mockStream);

    // Test commenting
    act(() => {
      emitDetectionStart('commenting', {
        instructions: 'Add helpful comments',
        tone: 'educational'
      });
    });

    await waitFor(() => {
      expect(detectCommentsSpy).toHaveBeenCalledTimes(1);
      expect(detectCommentsSpy).toHaveBeenCalledWith(testUri, {
        instructions: 'Add helpful comments',
        tone: 'educational',
      }, { auth: undefined });
    });
  });

  it('should only call API once even with multiple event listeners', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');

    // This test specifically catches the duplicate useResolutionFlow bug
    // If multiple components call useResolutionFlow, we'll see multiple API calls
    const { emitDetectionStart, getEventBus } = renderDetectionFlow(testUri);

    // Add an additional event listener (simulating multiple subscribers)
    const additionalListener = vi.fn();
    getEventBus().on('detection:start', additionalListener);

    // Trigger detection
    act(() => {
      emitDetectionStart('linking', { entityTypes: ['Person'] });
    });

    // Wait for operation to complete
    await waitFor(() => {
      expect(detectReferencesSpy).toHaveBeenCalled();
    });

    // VERIFY: API called exactly once, even though multiple listeners exist
    expect(detectReferencesSpy).toHaveBeenCalledTimes(1);

    // VERIFY: Our additional listener was called (events work)
    expect(additionalListener).toHaveBeenCalledTimes(1);
  });
});

/**
 * Helper: Render useDetectionFlow hook with real component composition
 * Returns methods to interact with the rendered component
 */
function renderDetectionFlow(testUri: string) {
  let eventBusInstance: Emitter<EventMap>;

  // Component to capture EventBus instance
  function EventBusCapture() {
    eventBusInstance = useEventBus();
    return null;
  }

  // Test harness component that uses the hook
  function DetectionFlowTestHarness() {
    const { detectionProgress, detectingMotivation } = useDetectionFlow(testUri as any);
    return (
      <div>
        <div data-testid="detecting">{detectingMotivation || 'none'}</div>
        <div data-testid="progress">
          {detectionProgress?.message || 'No progress'}
        </div>
      </div>
    );
  }

  render(
    <EventBusProvider>
      <AuthTokenProvider token={null}>
        <ApiClientProvider baseUrl="http://localhost:4000">
          <EventBusCapture />
          <DetectionFlowTestHarness />
        </ApiClientProvider>
      </AuthTokenProvider>
    </EventBusProvider>
  );

  return {
    emitDetectionStart: (motivation: Motivation, options: any) => {
      eventBusInstance.emit('detection:start', { motivation, options });
    },
    getEventBus: () => eventBusInstance,
  };
}
