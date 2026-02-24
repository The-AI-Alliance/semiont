/**
 * useAnnotationFlow Hook Tests
 *
 * Tests for the annotation flow state management hook, covering:
 * - Toast notifications for CRUD operations
 * - Detection cancellation
 * - Auto-dismiss timeout behavior
 * - Manual progress dismissal
 * - Pending annotation lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { resourceUri } from '@semiont/core';
import { useAnnotationFlow } from '../useAnnotationFlow';

// Mock the toast hook to track calls
const mockShowSuccess = vi.fn();
const mockShowError = vi.fn();
const mockShowInfo = vi.fn();

vi.mock('../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showInfo: mockShowInfo,
    showWarning: vi.fn(),
  }),
}));

// Mock API client
const mockCreateAnnotation = vi.fn();
const mockDeleteAnnotation = vi.fn();

vi.mock('../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual('../../contexts/ApiClientContext');
  return {
    ...actual,
    useApiClient: () => ({
      createAnnotation: mockCreateAnnotation,
      deleteAnnotation: mockDeleteAnnotation,
      sse: {
        detectReferences: vi.fn(),
        detectTags: vi.fn(),
        detectHighlights: vi.fn(),
        detectAssessments: vi.fn(),
        detectComments: vi.fn(),
      },
    }),
  };
});

// ─── Test harness ──────────────────────────────────────────────────────────────

function renderAnnotationFlow() {
  const rUri = resourceUri('https://example.com/resources/test');
  let eventBusInstance: ReturnType<typeof useEventBus> | null = null;
  let lastState: ReturnType<typeof useAnnotationFlow> | null = null;

  function TestComponent() {
    eventBusInstance = useEventBus();
    lastState = useAnnotationFlow(rUri);
    return null;
  }

  render(
    <EventBusProvider>
      <AuthTokenProvider token={null}>
        <ApiClientProvider baseUrl="http://localhost:4000">
          <TestComponent />
        </ApiClientProvider>
      </AuthTokenProvider>
    </EventBusProvider>
  );

  return {
    getState: () => lastState!,
    getEventBus: () => eventBusInstance!,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('useAnnotationFlow', () => {
  beforeEach(() => {
    resetEventBusForTesting();
    mockShowSuccess.mockClear();
    mockShowError.mockClear();
    mockShowInfo.mockClear();
    mockCreateAnnotation.mockClear();
    mockDeleteAnnotation.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('CRUD Error Toast Notifications', () => {
    it('should show error toast when annotation creation fails', () => {
      const { getEventBus } = renderAnnotationFlow();

      // Emit annotate:create-failed event
      act(() => {
        getEventBus().get('annotate:create-failed').next({
          error: new Error('Network connection failed')
        });
      });

      // Toast should be called
      expect(mockShowError).toHaveBeenCalledWith('Failed to create annotation: Network connection failed');
    });

    it('should show error toast when annotation deletion fails', () => {
      const { getEventBus } = renderAnnotationFlow();

      act(() => {
        getEventBus().get('annotate:delete-failed').next({
          error: new Error('Annotation not found')
        });
      });

      expect(mockShowError).toHaveBeenCalledWith('Failed to delete annotation: Annotation not found');
    });

    it('should handle error without message gracefully', () => {
      const { getEventBus } = renderAnnotationFlow();

      act(() => {
        getEventBus().get('annotate:create-failed').next({
          error: {} as Error
        });
      });

      expect(mockShowError).toHaveBeenCalled();
    });
  });

  describe('Detection Cancellation', () => {
    it('should show info toast when detection is cancelled', () => {
      const { getEventBus } = renderAnnotationFlow();

      act(() => {
        getEventBus().get('annotate:detect-cancelled').next(undefined);
      });

      expect(mockShowInfo).toHaveBeenCalledWith('Detection cancelled');
    });

    it('should clear detection state when cancelled', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // Start detection
      act(() => {
        getEventBus().get('annotate:detect-request').next({
          motivation: 'linking',
          options: { entityTypes: ['Person'] }
        });
      });

      // Set some progress
      act(() => {
        getEventBus().get('annotate:detect-progress').next({
          status: 'processing',
          message: 'Scanning document...',
          percentage: 50
        });
      });

      expect(getState().detectingMotivation).toBe('linking');

      // Cancel detection
      act(() => {
        getEventBus().get('job:cancel-requested').next({
          jobType: 'detection'
        });
      });

      // Stream should be aborted
      expect(getState().detectionStreamRef.current).toBeNull();
    });
  });

  describe('Auto-Dismiss Timeout Behavior', () => {
    it('should keep progress visible for 5 seconds after completion', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // Set progress
      act(() => {
        getEventBus().get('annotate:detect-progress').next({
          status: 'complete',
          message: 'Found 5 references',
          currentEntityType: 'Person',
          completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }]
        });
      });

      expect(getState().detectionProgress).toBeTruthy();

      // Complete detection
      act(() => {
        getEventBus().get('annotate:detect-finished').next({
          motivation: 'linking'
        });
      });

      // Progress should still be visible immediately after completion
      expect(getState().detectionProgress).toBeTruthy();
      expect(getState().detectingMotivation).toBeNull();

      // Advance time by 3 seconds - progress should still be visible
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(getState().detectionProgress).toBeTruthy();

      // Advance time to complete the 5 second timeout
      act(() => {
        vi.advanceTimersByTime(2100);
      });

      expect(getState().detectionProgress).toBeNull();
    });

    it('should clear progress immediately on failure', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // Set progress
      act(() => {
        getEventBus().get('annotate:detect-progress').next({
          status: 'processing',
          message: 'Scanning...',
          percentage: 50
        });
      });

      expect(getState().detectionProgress).toBeTruthy();

      // Fail detection
      act(() => {
        getEventBus().get('annotate:detect-failed').next({
          type: 'job.failed' as const,
          resourceId: 'test' as any,
          userId: 'user' as any,
          id: 'evt-1' as any,
          timestamp: new Date().toISOString(),
          version: 1,
          payload: {
            jobId: 'job-1' as any,
            jobType: 'detection',
            error: 'AI service unavailable',
          },
        });
      });

      // Progress should be cleared immediately
      expect(getState().detectionProgress).toBeNull();
      expect(getState().detectingMotivation).toBeNull();

      // Advance time - progress should remain null
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(getState().detectionProgress).toBeNull();
    });

    it('should cancel old timeout when new detection starts', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // Complete first detection
      act(() => {
        getEventBus().get('annotate:detect-progress').next({
          status: 'complete',
          message: 'Found 3 highlights'
        });
      });

      act(() => {
        getEventBus().get('annotate:detect-finished').next({
          motivation: 'highlighting'
        });
      });

      // Start new detection after 3 seconds (before auto-dismiss)
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      act(() => {
        getEventBus().get('annotate:detect-request').next({
          motivation: 'commenting',
          options: {}
        });
      });

      // Old timeout should be cancelled, new detection should start
      expect(getState().detectingMotivation).toBe('commenting');

      // Advance past original 5s timeout
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      // Progress should NOT be cleared (old timeout cancelled)
      expect(getState().detectingMotivation).toBe('commenting');
    });
  });

  describe('Manual Progress Dismissal', () => {
    it('should clear progress when user dismisses manually', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // Complete detection (starts 5s auto-dismiss)
      act(() => {
        getEventBus().get('annotate:detect-progress').next({
          status: 'complete',
          message: 'Detection complete'
        });
      });

      act(() => {
        getEventBus().get('annotate:detect-finished').next({
          motivation: 'linking'
        });
      });

      expect(getState().detectionProgress).toBeTruthy();

      // User manually dismisses at 2 seconds
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      act(() => {
        getEventBus().get('annotate:detect-dismiss').next(undefined);
      });

      // Progress should be cleared immediately
      expect(getState().detectionProgress).toBeNull();

      // Advance past original 5s timeout
      act(() => {
        vi.advanceTimersByTime(4000);
      });

      // Progress should remain null (timeout was cancelled)
      expect(getState().detectionProgress).toBeNull();
    });

    it('should not throw error if dismissing when no progress exists', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // Try to dismiss when no detection is active
      expect(() => {
        act(() => {
          getEventBus().get('annotate:detect-dismiss').next(undefined);
        });
      }).not.toThrow();

      expect(getState().detectionProgress).toBeNull();
    });
  });

  describe('Pending Annotation Lifecycle', () => {
    it('should set pending annotation on selection event', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // User selects text for comment
      act(() => {
        getEventBus().get('annotate:select-comment').next({
          exact: 'Selected text',
          start: 0,
          end: 13,
          prefix: '',
          suffix: ''
        });
      });

      expect(getState().pendingAnnotation).toBeTruthy();
      expect(getState().pendingAnnotation?.motivation).toBe('commenting');
    });

    it('should clear pending annotation on cancel', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // Create pending annotation
      act(() => {
        getEventBus().get('annotate:select-comment').next({
          exact: 'Test',
          start: 0,
          end: 4
        });
      });

      expect(getState().pendingAnnotation).toBeTruthy();

      // Cancel pending annotation
      act(() => {
        getEventBus().get('annotate:cancel-pending').next(undefined);
      });

      expect(getState().pendingAnnotation).toBeNull();
    });

    it('should replace pending annotation when new selection made', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // Create first pending annotation
      act(() => {
        getEventBus().get('annotate:select-comment').next({
          exact: 'First selection',
          start: 0,
          end: 15
        });
      });

      expect(getState().pendingAnnotation?.motivation).toBe('commenting');

      // Create second pending annotation with different motivation
      act(() => {
        getEventBus().get('annotate:select-assessment').next({
          exact: 'Second selection',
          start: 20,
          end: 36
        });
      });

      expect(getState().pendingAnnotation?.motivation).toBe('assessing');

      // Should only have one pending annotation (the latest)
      expect(getState().pendingAnnotation).toBeTruthy();
    });
  });

  describe('Detection Progress State Updates', () => {
    it('should update detection progress from events', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // Send progress update
      act(() => {
        getEventBus().get('annotate:detect-progress').next({
          status: 'scanning',
          message: 'Scanning document for references',
          currentEntityType: 'Person',
          percentage: 25
        });
      });

      expect(getState().detectionProgress).toEqual({
        status: 'scanning',
        message: 'Scanning document for references',
        currentEntityType: 'Person',
        percentage: 25
      });
    });

    it('should track multiple progress updates', () => {
      const { getState, getEventBus } = renderAnnotationFlow();

      // First update
      act(() => {
        getEventBus().get('annotate:detect-progress').next({
          status: 'scanning',
          message: 'Scanning Person entities',
          currentEntityType: 'Person',
          percentage: 33
        });
      });

      expect(getState().detectionProgress?.currentEntityType).toBe('Person');

      // Second update
      act(() => {
        getEventBus().get('annotate:detect-progress').next({
          status: 'scanning',
          message: 'Scanning Location entities',
          currentEntityType: 'Location',
          percentage: 66
        });
      });

      expect(getState().detectionProgress?.currentEntityType).toBe('Location');
      expect(getState().detectionProgress?.percentage).toBe(66);
    });
  });
});
