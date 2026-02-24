/**
 * Toast Notifications Test - Verifies Toast Integration
 *
 * This test verifies the fix for the issue identified in commit 9690806abc910bad490e684d6ef71d874a90579c.
 *
 * SOLUTION IMPLEMENTED:
 * - Pattern B: Both useDetectionFlow and useGenerationFlow call useToast internally
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
import { useDetectionFlow } from '../../../hooks/useDetectionFlow';
import { useGenerationFlow } from '../../../hooks/useGenerationFlow';

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
    useDetectionFlow(rUri);
    return <div data-testid="test">Test</div>;
  }

  function TestComponentWithGeneration() {
    eventBusInstance = useEventBus();
    useGenerationFlow('en', 'test-resource', vi.fn());
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
    it('annotate:detect-finished shows success toast', async () => {
      renderDetectionTest();

      // Clear any potential mount-related calls
      await new Promise(resolve => setTimeout(resolve, 100));
      mockShowSuccess.mockClear();

      // Emit detection finished event (what SSE would emit)
      act(() => {
        eventBusInstance.get('annotate:detect-finished').next({
          motivation: 'linking' as any
        });
      });

      // Wait for toast to be called
      await waitFor(() => {
        expect(mockShowSuccess).toHaveBeenCalledWith('Detection complete');
      });
    });

    it('annotate:detect-failed shows error toast', async () => {
      renderDetectionTest();

      await new Promise(resolve => setTimeout(resolve, 100));
      mockShowError.mockClear();

      // Emit detection failed event
      act(() => {
        eventBusInstance.get('annotate:detect-failed').next({
          error: new Error('AI service unavailable'),
        });
      });

      // Wait for toast to be called
      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalledWith('AI service unavailable');
      });
    });
  });

  describe('Generation Events Trigger Toasts', () => {
    it('generate:finished shows success toast', async () => {
      renderGenerationTest();

      await new Promise(resolve => setTimeout(resolve, 100));
      mockShowSuccess.mockClear();

      // Emit generation finished event
      act(() => {
        eventBusInstance.get('generate:finished').next({
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

    it('generate:failed shows error toast', async () => {
      renderGenerationTest();

      await new Promise(resolve => setTimeout(resolve, 100));
      mockShowError.mockClear();

      // Emit generation failed event
      act(() => {
        eventBusInstance.get('generate:failed').next({
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
