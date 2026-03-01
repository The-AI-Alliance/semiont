/**
 * Layer 3: Feature Integration Test - Detection Flow Architecture
 *
 * Tests the COMPLETE detection flow with real component composition:
 * - EventBusProvider (REAL)
 * - ApiClientProvider (REAL, with MOCKED client)
 * - useMarkFlow (REAL)
 * - useBindFlow (REAL)
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
import { useMarkFlow } from '../../../hooks/useMarkFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SSEClient } from '@semiont/api-client';
import type { Motivation } from '@semiont/core';
import { resourceUri } from '@semiont/core';
import type { Emitter } from 'mitt';

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));
import type { EventMap } from '@semiont/core';

// Mock SSE stream - SSE now emits directly to EventBus, no callbacks
const createMockSSEStream = () => {
  return {
    close: vi.fn(),
  };
};

describe('Detection Flow - Feature Integration', () => {
  let mockStream: ReturnType<typeof createMockSSEStream>;
  let annotateReferencesSpy: any;
  let annotateHighlightsSpy: any;
  let detectCommentsSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();

    // Create fresh mock stream for each test
    mockStream = createMockSSEStream();

    // Spy on SSEClient prototype methods
    annotateReferencesSpy = vi.spyOn(SSEClient.prototype, 'annotateReferences').mockReturnValue(mockStream as any);
    annotateHighlightsSpy = vi.spyOn(SSEClient.prototype, 'annotateHighlights').mockReturnValue(mockStream as any);
    detectCommentsSpy = vi.spyOn(SSEClient.prototype, 'annotateComments').mockReturnValue(mockStream as any);
    vi.spyOn(SSEClient.prototype, 'annotateAssessments').mockReturnValue(mockStream as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call annotateReferences exactly ONCE when detection starts (not twice)', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');

    // Render with real component composition
    const { emitDetectionStart } = renderDetectionFlow(testUri);

    // Trigger detection for linking (uses annotateReferences)
    act(() => {
      emitDetectionStart('linking', {
        entityTypes: ['Person', 'Organization'],
        includeDescriptiveReferences: false
      });
    });

    // CRITICAL ASSERTION: API called exactly once (not twice!)
    // This would FAIL if useBindFlow was called in multiple places
    await waitFor(() => {
      expect(annotateReferencesSpy).toHaveBeenCalledTimes(1);
    });

    // Verify correct parameters (eventBus is passed but we don't need to verify its exact value)
    expect(annotateReferencesSpy).toHaveBeenCalledWith(
      testUri,
      {
        entityTypes: ['Person', 'Organization'],
        includeDescriptiveReferences: false,
      },
      expect.objectContaining({ auth: undefined })
    );
  });

  it('should propagate SSE progress events to useMarkFlow state', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');

    // Render with state observer
    const { emitDetectionStart, getEventBus } = renderDetectionFlow(testUri);

    // Start detection
    act(() => {
      emitDetectionStart('linking', {
        entityTypes: ['Person']
      });
    });

    // Wait for stream to be created
    await waitFor(() => {
      expect(annotateReferencesSpy).toHaveBeenCalled();
    });

    // Simulate SSE progress event being emitted to EventBus (how SSE actually works now)
    act(() => {
      getEventBus().get('mark:progress').next({
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
    const { emitDetectionStart, getEventBus } = renderDetectionFlow(testUri);

    // Start detection
    act(() => {
      emitDetectionStart('highlighting', {
        instructions: 'Find important passages'
      });
    });

    await waitFor(() => {
      expect(annotateHighlightsSpy).toHaveBeenCalledTimes(1);
    });

    // First progress update via EventBus
    act(() => {
      getEventBus().get('mark:progress').next({
        status: 'started',
        message: 'Starting analysis...',
        percentage: 0,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Starting analysis...');
    });

    // Second progress update via EventBus
    act(() => {
      getEventBus().get('mark:progress').next({
        status: 'analyzing',
        message: 'Analyzing text...',
        percentage: 50,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Analyzing text...');
    });

    // Final progress update via EventBus
    act(() => {
      getEventBus().get('mark:progress').next({
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

    // Send final progress via EventBus
    act(() => {
      getEventBus().get('mark:progress').next({
        status: 'complete',
        message: 'Created 14 highlights',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Created 14 highlights');
    });

    // Emit completion event
    act(() => {
      getEventBus().get('mark:assist-finished').next({ motivation: 'highlighting' });
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

    // Add some progress via EventBus
    act(() => {
      getEventBus().get('mark:progress').next({
        status: 'scanning',
        message: 'Scanning...',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Scanning...');
    });

    // Emit failure
    act(() => {
      getEventBus().get('mark:assist-failed').next({
        type: 'job.failed' as const,
        resourceId: 'test-resource' as any,
        userId: 'user' as any,
        id: 'evt-1' as any,
        timestamp: new Date().toISOString(),
        version: 1,
        payload: {
          jobId: 'job-1' as any,
          jobType: 'detection',
          error: 'Network error',
        },
      });
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
      expect(annotateHighlightsSpy).toHaveBeenCalledTimes(1);
      expect(annotateHighlightsSpy).toHaveBeenCalledWith(testUri, {
        instructions: 'Find important text',
      }, expect.objectContaining({ auth: undefined }));
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
      }, expect.objectContaining({ auth: undefined }));
    });
  });

  it('should only call API once even with multiple event listeners', async () => {
    const testUri = resourceUri('http://localhost:4000/resources/test-resource');

    // This test specifically catches the duplicate useBindFlow bug
    // If multiple components call useBindFlow, we'll see multiple API calls
    const { emitDetectionStart, getEventBus } = renderDetectionFlow(testUri);

    // Add an additional event listener (simulating multiple subscribers)
    const additionalListener = vi.fn();
    const subscription = getEventBus().get('mark:assist-request').subscribe(additionalListener);

    // Trigger detection
    act(() => {
      emitDetectionStart('linking', { entityTypes: ['Person'] });
    });

    // Wait for operation to complete
    await waitFor(() => {
      expect(annotateReferencesSpy).toHaveBeenCalled();
    });

    // VERIFY: API called exactly once, even though multiple listeners exist
    expect(annotateReferencesSpy).toHaveBeenCalledTimes(1);

    // VERIFY: Our additional listener was called (events work)
    expect(additionalListener).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
  });
});

/**
 * Helper: Render useMarkFlow hook with real component composition
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
    const { progress, assistingMotivation } = useMarkFlow(testUri as any);
    return (
      <div>
        <div data-testid="detecting">{assistingMotivation || 'none'}</div>
        <div data-testid="progress">
          {progress?.message || 'No progress'}
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
      eventBusInstance.get('mark:assist-request').next({ motivation, options });
    },
    getEventBus: () => eventBusInstance,
  };
}
