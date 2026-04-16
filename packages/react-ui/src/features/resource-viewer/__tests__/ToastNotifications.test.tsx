/**
 * Toast Notifications Test - Verifies Toast Integration
 *
 * Tests that useMarkFlow calls useToast internally for detection events.
 * Yield toast handling moved to the consumer (ResourceViewerPage) via
 * EventBus subscriptions — tested there, not here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { EventBusProvider, useEventBus } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { resourceId } from '@semiont/core';
import { useMarkFlow } from '../../../hooks/useMarkFlow';

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
  const rUri = resourceId('test');

  beforeEach(() => {
    mockShowSuccess.mockClear();
    mockShowError.mockClear();
  });

  function TestComponentWithDetection() {
    eventBusInstance = useEventBus();
    useMarkFlow(rUri);
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
          resourceId: 'test' as any,
          message: 'AI service unavailable',
        });
      });

      // Wait for toast to be called
      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalledWith('AI service unavailable');
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
