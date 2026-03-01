/**
 * Toast Notifications Test - Verifies Toast Integration
 *
 * This test verifies the fix for the issue identified in commit 9690806abc910bad490e684d6ef71d874a90579c.
 *
 * SOLUTION IMPLEMENTED:
 * - Pattern B: Both useMarkFlow and useYieldFlow call useToast internally
 * - Toast notifications are shown from within the hooks (self-contained)
 *
 * EXPECTED BEHAVIOR (after fix):
 * - Detection completes → User sees success toast ✓
 * - Detection fails → User sees error toast ✓
 * - Generation completes → User sees success toast ✓
 * - Generation fails → User sees error toast ✓
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { resourceUri } from '@semiont/core';
import { useMarkFlow } from '../../../hooks/useMarkFlow';
import { useYieldFlow } from '../../../hooks/useYieldFlow';

// Mock the toast hook to track calls
const mockShowSuccess = vi.fn();
const mockShowError = vi.fn();

vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

describe('Toast Notifications - Verifies Toast Integration', () => {
  let eventBusInstance: any;
  const rUri = resourceUri('https://example.com/resources/test');

  beforeEach(() => {
    resetEventBusForTesting();
    mockShowSuccess.mockClear();
    mockShowError.mockClear();
  });

  /**
   * Test component that uses both hooks to verify toast integration
   */
  function TestComponentWithDetection() {
    eventBusInstance = useEventBus();
    useMarkFlow(rUri);
    return <div data-testid="test">Test</div>;
  }

  function TestComponentWithGeneration() {
    eventBusInstance = useEventBus();
    useYieldFlow('en', 'test-resource', vi.fn());
    return <div data-testid="test">Test</div>;
  }

  function renderDetectionTest() {
    return render(
      <EventBusProvider>
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestComponentWithDetection />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );
  }

  function renderGenerationTest() {
    return render(
      <EventBusProvider>
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestComponentWithGeneration />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );
  }

  describe('Detection Events Trigger Toasts', () => {
    it('mark:assist-finished shows success toast', async () => {
      renderDetectionTest();

      // Clear any potential mount-related calls
      await new Promise(resolve => setTimeout(resolve, 100));
      mockShowSuccess.mockClear();

      // Emit detection finished event (what SSE would emit)
      act(() => {
        eventBusInstance.get('mark:assist-finished').next({
          motivation: 'linking' as any
        });
      });

      // Wait for toast to be called
      await waitFor(() => {
        expect(mockShowSuccess).toHaveBeenCalledWith('Annotation complete');
      });
    });

    it('mark:assist-failed shows error toast', async () => {
      renderDetectionTest();

      await new Promise(resolve => setTimeout(resolve, 100));
      mockShowError.mockClear();

      // Emit detection failed event
      act(() => {
        eventBusInstance.get('mark:assist-failed').next({
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

      // Wait for toast to be called
      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalledWith('AI service unavailable');
      });
    });
  });

  describe('Generation Events Trigger Toasts', () => {
    it('yield:finished shows success toast', async () => {
      renderGenerationTest();

      await new Promise(resolve => setTimeout(resolve, 100));
      mockShowSuccess.mockClear();

      // Emit generation finished event
      act(() => {
        eventBusInstance.get('yield:finished').next({
          status: 'complete',
          message: 'Document generated successfully',
          percentage: 100,
          referenceId: 'ref-1',
        });
      });

      // Wait for toast to be called
      await waitFor(() => {
        expect(mockShowSuccess).toHaveBeenCalledWith('Resource created successfully!');
      });
    });

    it('yield:failed shows error toast', async () => {
      renderGenerationTest();

      await new Promise(resolve => setTimeout(resolve, 100));
      mockShowError.mockClear();

      // Emit generation failed event
      act(() => {
        eventBusInstance.get('yield:failed').next({
          error: new Error('Failed to generate document'),
        });
      });

      // Wait for toast to be called
      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalledWith('Resource generation failed: Failed to generate document');
      });
    });
  });

  describe('Verification: Toast Mock Works Correctly', () => {
    it('SANITY CHECK: can verify toast is NOT called', () => {
      // This test proves our mock works correctly
      expect(mockShowSuccess).not.toHaveBeenCalled();
      expect(mockShowError).not.toHaveBeenCalled();

      // If we call them, they should be tracked
      mockShowSuccess('test');
      mockShowError('test');

      expect(mockShowSuccess).toHaveBeenCalledWith('test');
      expect(mockShowError).toHaveBeenCalledWith('test');
    });
  });
});
