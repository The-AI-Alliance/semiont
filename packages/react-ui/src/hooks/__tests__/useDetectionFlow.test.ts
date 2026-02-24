/**
 * useDetectionFlow Hook Tests
 *
 * Tests for the detection flow state management hook, covering:
 * - Toast notifications for CRUD operations
 * - Detection cancellation
 * - Auto-dismiss timeout behavior
 * - Manual progress dismissal
 * - Pending annotation lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../contexts/EventBusContext';
import { ApiClientProvider } from '../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';
import { resourceUri } from '@semiont/core';
import { useDetectionFlow } from '../useDetectionFlow';
import type { ReactNode } from 'react';

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

describe('useDetectionFlow', () => {
  const rUri = resourceUri('https://example.com/resources/test');
  let eventBusInstance: any;

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <EventBusProvider>
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            {children}
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );
  }

  function TestComponent() {
    eventBusInstance = useEventBus();
    const detectionFlow = useDetectionFlow(rUri);
    return detectionFlow;
  }

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
    it('should show error toast when annotation creation fails', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      // Get event bus instance
      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });
      mockShowError.mockClear();

      // Emit annotate:create-failed event
      act(() => {
        eventBusInstance.get('annotate:create-failed').next({
          error: new Error('Network connection failed')
        });
      });

      // Wait for toast to be called
      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalledWith('Failed to create annotation: Network connection failed');
      });
    });

    it('should show error toast when annotation deletion fails', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });
      mockShowError.mockClear();

      // Emit annotate:delete-failed event
      act(() => {
        eventBusInstance.get('annotate:delete-failed').next({
          error: new Error('Annotation not found')
        });
      });

      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalledWith('Failed to delete annotation: Annotation not found');
      });
    });

    it('should handle error without message gracefully', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });
      mockShowError.mockClear();

      // Emit error without message property
      act(() => {
        eventBusInstance.get('annotate:create-failed').next({
          error: {} as Error
        });
      });

      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalled();
      });
    });
  });

  describe('Detection Cancellation', () => {
    it('should show info toast when detection is cancelled', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });
      mockShowInfo.mockClear();

      // Emit annotate:detect-cancelled event
      act(() => {
        eventBusInstance.get('annotate:detect-cancelled').next(undefined);
      });

      await waitFor(() => {
        expect(mockShowInfo).toHaveBeenCalledWith('Detection cancelled');
      });
    });

    it('should clear detection state when cancelled', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // Start detection
      act(() => {
        eventBusInstance.get('annotate:detect-request').next({
          motivation: 'linking',
          options: { entityTypes: ['Person'] }
        });
      });

      // Set some progress
      act(() => {
        eventBusInstance.get('annotate:detect-progress').next({
          status: 'processing',
          message: 'Scanning document...',
          percentage: 50
        });
      });

      await waitFor(() => {
        expect(result.current.detectingMotivation).toBe('linking');
      });

      // Cancel detection via job:cancel-requested
      act(() => {
        eventBusInstance.get('job:cancel-requested').next({
          jobType: 'detection'
        });
      });

      // Verify stream was aborted
      expect(result.current.detectionStreamRef.current).toBeNull();
    });
  });

  describe('Auto-Dismiss Timeout Behavior', () => {
    it('should keep progress visible for 5 seconds after completion', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // Set progress
      act(() => {
        eventBusInstance.get('annotate:detect-progress').next({
          status: 'complete',
          message: 'Found 5 references',
          currentEntityType: 'Person',
          completedEntityTypes: [{ entityType: 'Person', foundCount: 5 }]
        });
      });

      await waitFor(() => {
        expect(result.current.detectionProgress).toBeTruthy();
      });

      // Complete detection
      act(() => {
        eventBusInstance.get('annotate:detect-finished').next({
          motivation: 'linking'
        });
      });

      // Progress should still be visible immediately after completion
      expect(result.current.detectionProgress).toBeTruthy();
      expect(result.current.detectingMotivation).toBeNull();

      // Advance time by 3 seconds - progress should still be visible
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(result.current.detectionProgress).toBeTruthy();

      // Advance time to complete the 5 second timeout
      act(() => {
        vi.advanceTimersByTime(2100);
      });

      await waitFor(() => {
        expect(result.current.detectionProgress).toBeNull();
      });
    });

    it('should clear progress immediately on failure', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // Set progress
      act(() => {
        eventBusInstance.get('annotate:detect-progress').next({
          status: 'processing',
          message: 'Scanning...',
          percentage: 50
        });
      });

      await waitFor(() => {
        expect(result.current.detectionProgress).toBeTruthy();
      });

      // Fail detection
      act(() => {
        eventBusInstance.get('annotate:detect-failed').next({
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
      await waitFor(() => {
        expect(result.current.detectionProgress).toBeNull();
        expect(result.current.detectingMotivation).toBeNull();
      });

      // Advance time - progress should remain null
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(result.current.detectionProgress).toBeNull();
    });

    it('should cancel old timeout when new detection starts', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // Complete first detection
      act(() => {
        eventBusInstance.get('annotate:detect-progress').next({
          status: 'complete',
          message: 'Found 3 highlights'
        });
      });

      act(() => {
        eventBusInstance.get('annotate:detect-finished').next({
          motivation: 'highlighting'
        });
      });

      // Start new detection after 3 seconds (before auto-dismiss)
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      act(() => {
        eventBusInstance.get('annotate:detect-request').next({
          motivation: 'commenting',
          options: {}
        });
      });

      // Old timeout should be cancelled, progress should start fresh
      await waitFor(() => {
        expect(result.current.detectingMotivation).toBe('commenting');
      });

      // Advance past original 5s timeout
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      // Progress should NOT be cleared (old timeout cancelled)
      expect(result.current.detectingMotivation).toBe('commenting');
    });
  });

  describe('Manual Progress Dismissal', () => {
    it('should clear progress when user dismisses manually', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // Complete detection (starts 5s auto-dismiss)
      act(() => {
        eventBusInstance.get('annotate:detect-progress').next({
          status: 'complete',
          message: 'Detection complete'
        });
      });

      act(() => {
        eventBusInstance.get('annotate:detect-finished').next({
          motivation: 'linking'
        });
      });

      await waitFor(() => {
        expect(result.current.detectionProgress).toBeTruthy();
      });

      // User manually dismisses at 2 seconds
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      act(() => {
        eventBusInstance.get('annotate:detect-dismiss').next(undefined);
      });

      // Progress should be cleared immediately
      await waitFor(() => {
        expect(result.current.detectionProgress).toBeNull();
      });

      // Advance past original 5s timeout
      act(() => {
        vi.advanceTimersByTime(4000);
      });

      // Progress should remain null (timeout was cancelled)
      expect(result.current.detectionProgress).toBeNull();
    });

    it('should not throw error if dismissing when no progress exists', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // Try to dismiss when no detection is active
      expect(() => {
        act(() => {
          eventBusInstance.get('annotate:detect-dismiss').next(undefined);
        });
      }).not.toThrow();

      expect(result.current.detectionProgress).toBeNull();
    });
  });

  describe('Pending Annotation Lifecycle', () => {
    it('should set pending annotation on selection event', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // User selects text for comment
      act(() => {
        eventBusInstance.get('annotate:select-comment').next({
          exact: 'Selected text',
          start: 0,
          end: 13,
          prefix: '',
          suffix: ''
        });
      });

      await waitFor(() => {
        expect(result.current.pendingAnnotation).toBeTruthy();
        expect(result.current.pendingAnnotation?.motivation).toBe('commenting');
      });
    });

    it('should clear pending annotation on cancel', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // Create pending annotation
      act(() => {
        eventBusInstance.get('annotate:select-comment').next({
          exact: 'Test',
          start: 0,
          end: 4
        });
      });

      await waitFor(() => {
        expect(result.current.pendingAnnotation).toBeTruthy();
      });

      // Cancel pending annotation
      act(() => {
        eventBusInstance.get('annotate:cancel-pending').next(undefined);
      });

      await waitFor(() => {
        expect(result.current.pendingAnnotation).toBeNull();
      });
    });

    it('should clear pending annotation after successful creation', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      mockCreateAnnotation.mockResolvedValue({
        annotation: {
          id: 'test-annotation-id',
          type: 'Annotation',
          motivation: 'commenting'
        }
      });

      // Create pending annotation
      act(() => {
        eventBusInstance.get('annotate:select-comment').next({
          exact: 'Test',
          start: 0,
          end: 4
        });
      });

      await waitFor(() => {
        expect(result.current.pendingAnnotation).toBeTruthy();
      });

      // Create annotation
      act(() => {
        eventBusInstance.get('annotate:create').next({
          motivation: 'commenting',
          selector: { type: 'TextQuoteSelector', exact: 'Test' },
          body: [{ type: 'TextualBody', value: 'Comment text' }]
        });
      });

      // Pending annotation should be cleared after creation
      await waitFor(() => {
        expect(result.current.pendingAnnotation).toBeNull();
      });
    });

    it('should replace pending annotation when new selection made', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // Create first pending annotation
      act(() => {
        eventBusInstance.get('annotate:select-comment').next({
          exact: 'First selection',
          start: 0,
          end: 15
        });
      });

      await waitFor(() => {
        expect(result.current.pendingAnnotation?.motivation).toBe('commenting');
      });

      // Create second pending annotation with different motivation
      act(() => {
        eventBusInstance.get('annotate:select-assessment').next({
          exact: 'Second selection',
          start: 20,
          end: 36
        });
      });

      await waitFor(() => {
        expect(result.current.pendingAnnotation?.motivation).toBe('assessing');
      });

      // Should only have one pending annotation (the latest)
      expect(result.current.pendingAnnotation).toBeTruthy();
    });
  });

  describe('Detection Progress State Updates', () => {
    it('should update detection progress from events', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // Send progress update
      act(() => {
        eventBusInstance.get('annotate:detect-progress').next({
          status: 'scanning',
          message: 'Scanning document for references',
          currentEntityType: 'Person',
          percentage: 25
        });
      });

      await waitFor(() => {
        expect(result.current.detectionProgress).toEqual({
          status: 'scanning',
          message: 'Scanning document for references',
          currentEntityType: 'Person',
          percentage: 25
        });
      });
    });

    it('should track multiple progress updates', async () => {
      const { result } = renderHook(() => useDetectionFlow(rUri), { wrapper });

      const { result: busResult } = renderHook(() => useEventBus(), { wrapper });
      eventBusInstance = busResult.current;

      // First update
      act(() => {
        eventBusInstance.get('annotate:detect-progress').next({
          status: 'scanning',
          message: 'Scanning Person entities',
          currentEntityType: 'Person',
          percentage: 33
        });
      });

      await waitFor(() => {
        expect(result.current.detectionProgress?.currentEntityType).toBe('Person');
      });

      // Second update
      act(() => {
        eventBusInstance.get('annotate:detect-progress').next({
          status: 'scanning',
          message: 'Scanning Location entities',
          currentEntityType: 'Location',
          percentage: 66
        });
      });

      await waitFor(() => {
        expect(result.current.detectionProgress?.currentEntityType).toBe('Location');
        expect(result.current.detectionProgress?.percentage).toBe(66);
      });
    });
  });
});
