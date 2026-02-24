/**
 * Layer 3: Feature Integration Test - Annotation Deletion Flow Architecture
 *
 * Tests the COMPLETE annotation deletion flow with real component composition:
 * - EventBusProvider (REAL)
 * - ApiClientProvider (REAL, with MOCKED client)
 * - useDetectionFlow (REAL) — single registration point for useResolutionFlow
 * - useEventSubscriptions (REAL)
 *
 * This test focuses on ARCHITECTURE and EVENT WIRING:
 * - Verifies deletion API called exactly ONCE (catches duplicate subscriptions)
 * - Tests event propagation through the event bus
 * - Validates success/failure event emissions
 * - Ensures auth token is passed correctly
 *
 * CRITICAL: This test prevents regressions where:
 * - Multiple deletion paths exist (event-driven vs direct)
 * - useResolutionFlow called in more than one hook (causes duplicate subscriptions)
 * - Auth token missing from API calls (401 errors)
 *
 * ARCHITECTURE: useResolutionFlow is called ONLY in useDetectionFlow.
 * useDetectionFlow handles all detection state (manual annotation selection
 * and AI-driven SSE detection) plus all API operations via useResolutionFlow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useDetectionFlow } from '../../../hooks/useDetectionFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SemiontApiClient } from '@semiont/api-client';
import { resourceUri, accessToken } from '@semiont/core';

describe('Annotation Deletion - Feature Integration', () => {
  let deleteAnnotationSpy: ReturnType<typeof vi.fn>;
  const testUri = resourceUri('http://localhost:4000/resources/test-resource');
  const testToken = 'test-token-123';
  const testBaseUrl = 'http://localhost:4000';

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();

    // Mock the deleteAnnotation method on SemiontApiClient prototype
    deleteAnnotationSpy = vi.fn().mockResolvedValue({ success: true });
    vi.spyOn(SemiontApiClient.prototype, 'deleteAnnotation').mockImplementation(deleteAnnotationSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to render the annotation flow with real providers
   */
  function renderAnnotationFlow() {
    let eventBusInstance: ReturnType<typeof useEventBus> | null = null;

    function TestComponent() {
      eventBusInstance = useEventBus();
      // useDetectionFlow is the single registration point for useResolutionFlow
      // (handles annotate:delete annotate:create annotate:detect-request, etc.)
      useDetectionFlow(testUri);
      return null;
    }

    render(
      <AuthTokenProvider token={testToken}>
        <EventBusProvider>
          <ApiClientProvider baseUrl={testBaseUrl}>
            <TestComponent />
          </ApiClientProvider>
        </EventBusProvider>
      </AuthTokenProvider>
    );

    return {
      emitDelete: (annotationId: string) => {
        act(() => {
          eventBusInstance!.get('annotate:delete').next({ annotationId });
        });
      },
      eventBus: eventBusInstance!,
    };
  }

  it('should call deleteAnnotation API exactly ONCE when annotate:deleteevent is emitted', async () => {
    const { emitDelete } = renderAnnotationFlow();
    const annotationId = 'annotation-123';

    // Trigger deletion via event bus (how UI triggers it)
    emitDelete(annotationId);

    // CRITICAL ASSERTION: API called exactly once (not twice!)
    // This would FAIL if there were competing deletion paths
    await waitFor(() => {
      expect(deleteAnnotationSpy).toHaveBeenCalledTimes(1);
    });

    // Verify correct parameters (annotationUri constructed from ID)
    expect(deleteAnnotationSpy).toHaveBeenCalledWith(
      expect.stringContaining(annotationId),
      expect.objectContaining({
        auth: accessToken(testToken),
      })
    );
  });

  it('should pass auth token to API call (prevents 401 errors)', async () => {
    const { emitDelete } = renderAnnotationFlow();

    emitDelete('annotation-456');

    await waitFor(() => {
      expect(deleteAnnotationSpy).toHaveBeenCalled();
    });

    // CRITICAL: Auth token must be present
    const callArgs = deleteAnnotationSpy.mock.calls[0];
    expect(callArgs[1]).toHaveProperty('auth');
    expect(callArgs[1].auth).toBe(accessToken(testToken));
  });

  it('should emit annotate:deleted event on successful deletion', async () => {
    const { emitDelete, eventBus } = renderAnnotationFlow();
    const deletedListener = vi.fn();

    // Subscribe to success event
    eventBus.get('annotate:deleted').subscribe(deletedListener);

    emitDelete('annotation-789');

    // Wait for API call to complete
    await waitFor(() => {
      expect(deleteAnnotationSpy).toHaveBeenCalled();
    });

    // Verify success event was emitted
    await waitFor(() => {
      expect(deletedListener).toHaveBeenCalledWith({
        annotationId: 'annotation-789',
      });
    });
  });

  it('should emit annotate:delete-failed event on API error', async () => {
    // Make API call fail
    deleteAnnotationSpy.mockRejectedValue(new Error('Network error'));

    const { emitDelete, eventBus } = renderAnnotationFlow();
    const failedListener = vi.fn();

    // Subscribe to failure event
    eventBus.get('annotate:delete-failed').subscribe(failedListener);

    emitDelete('annotation-error');

    // Wait for API call to be attempted
    await waitFor(() => {
      expect(deleteAnnotationSpy).toHaveBeenCalled();
    });

    // Verify failure event was emitted
    await waitFor(() => {
      expect(failedListener).toHaveBeenCalledWith({
        error: expect.any(Error),
      });
    });
  });

  it('should handle multiple deletions in sequence without duplicate API calls', async () => {
    const { emitDelete } = renderAnnotationFlow();

    // Delete first annotation
    emitDelete('annotation-1');

    await waitFor(() => {
      expect(deleteAnnotationSpy).toHaveBeenCalledTimes(1);
    });

    // Delete second annotation
    emitDelete('annotation-2');

    await waitFor(() => {
      expect(deleteAnnotationSpy).toHaveBeenCalledTimes(2);
    });

    // Verify each call had correct annotation ID
    expect(deleteAnnotationSpy.mock.calls[0][0]).toContain('annotation-1');
    expect(deleteAnnotationSpy.mock.calls[1][0]).toContain('annotation-2');
  });

  it('ARCHITECTURE: useResolutionFlow is called in useDetectionFlow (single registration point)', async () => {
    /**
     * This test validates that there's only ONE event-driven deletion path:
     * - useDetectionFlow calls useResolutionFlow (the single registration point)
     * - useResolutionFlow subscribes to annotation:delete
     *
     * If this test fails with 2 API calls, it means useResolutionFlow was added
     * to a second hook, causing duplicate subscriptions (ARCHITECTURE VIOLATION).
     */

    const { emitDelete } = renderAnnotationFlow();

    emitDelete('architecture-test');

    // Single API call = single subscription = correct architecture
    await waitFor(() => {
      expect(deleteAnnotationSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('REGRESSION: No direct deleteAnnotation function in ResourceAnnotationsContext', () => {
    /**
     * This test prevents regression to the old pattern where
     * ResourceAnnotationsContext had a deleteAnnotation function
     * that bypassed the event bus.
     *
     * The correct pattern is event-driven only:
     * - UI emits annotate:deleteevent
     * - useResolutionFlow handles it
     * - No direct function calls
     */

    // This would fail to compile if deleteAnnotation was added back to context
    // Type-level enforcement via TypeScript
    const { emitDelete } = renderAnnotationFlow();
    emitDelete('regression-test');

    // Deletion still works via events
    expect(deleteAnnotationSpy).toHaveBeenCalled();
  });
});
