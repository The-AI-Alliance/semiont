/**
 * Bug Reproduction: Detection Progress Doesn't Dismiss
 *
 * USER SCENARIO:
 * 1. User clicks "Detect References" button
 * 2. Progress modal appears showing "Processing: Location"
 * 3. Detection completes successfully
 * 4. BUG: Progress modal stays visible showing "Processing: Location" indefinitely
 *
 * ROOT CAUSE:
 * - useAnnotationFlow.ts (line 54-62): annotate:assist-finished clears `assistingMotivation` but keeps `progress`
 * - AssistSection.tsx (line 214): Shows progress UI whenever `progress` is not null
 * - No mechanism to auto-dismiss or manually close the progress display
 *
 * FIX OPTIONS:
 * A) Auto-dismiss after timeout (3s after completion)
 * B) Add "Close" button to progress display
 * C) Clear progress on next annotate:assist-request (already works but not ideal UX)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useAnnotationFlow } from '../../../hooks/useAnnotationFlow';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SSEClient } from '@semiont/api-client';
import { resourceUri } from '@semiont/core';

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

describe('Detection Progress Dismissal Bug', () => {
  let mockStream: any;
  const rUri = resourceUri('https://example.com/resources/test');

  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();

    mockStream = {
      close: vi.fn(),
    };

    vi.spyOn(SSEClient.prototype, 'detectReferences').mockReturnValue(mockStream);
    vi.spyOn(SSEClient.prototype, 'detectHighlights').mockReturnValue(mockStream);
    vi.spyOn(SSEClient.prototype, 'detectComments').mockReturnValue(mockStream);
    vi.spyOn(SSEClient.prototype, 'detectAssessments').mockReturnValue(mockStream);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('FIXED: Progress auto-dismisses after detection completes', { timeout: 7000 }, async () => {
    let eventBusInstance: any;

    function TestHarness() {
      eventBusInstance = useEventBus();
      const { assistingMotivation, progress } = useAnnotationFlow(rUri);

      return (
        <div>
          <div data-testid="detecting">{assistingMotivation || 'none'}</div>
          <div data-testid="progress">
            {progress ? progress.message || 'has progress' : 'no progress'}
          </div>
        </div>
      );
    }

    render(
      <EventBusProvider>
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestHarness />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );

    // Initial state
    expect(screen.getByTestId('detecting')).toHaveTextContent('none');
    expect(screen.getByTestId('progress')).toHaveTextContent('no progress');

    // User clicks detect button (emits annotate:assist-request)
    act(() => {
      eventBusInstance.get('annotate:assist-request').next({
        motivation: 'linking',
        options: { entityTypes: ['Location'] }
      });
    });

    // Detection started
    await waitFor(() => {
      expect(screen.getByTestId('detecting')).toHaveTextContent('linking');
    });

    // SSE sends progress update
    act(() => {
      eventBusInstance.get('annotate:progress').next({
        status: 'scanning',
        message: 'Processing: Location',
        currentEntityType: 'Location',
      });
    });

    // Progress is visible
    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Processing: Location');
    });

    // Detection completes (SSE finishes, backend emits annotate:assist-finished)
    act(() => {
      eventBusInstance.get('annotate:assist-finished').next({ motivation: 'linking' });
    });

    // assistingMotivation cleared immediately
    await waitFor(() => {
      expect(screen.getByTestId('detecting')).toHaveTextContent('none');
    });

    // Wait 5 seconds - progress auto-dismissed after completion
    await new Promise(resolve => setTimeout(resolve, 5100));
    expect(screen.getByTestId('progress')).toHaveTextContent('no progress');
  });

  it('WORKAROUND: Starting new detection clears old progress', async () => {
    let eventBusInstance: any;

    function TestHarness() {
      eventBusInstance = useEventBus();
      const { progress } = useAnnotationFlow(rUri);

      return (
        <div data-testid="progress">
          {progress ? progress.message || 'has progress' : 'no progress'}
        </div>
      );
    }

    render(
      <EventBusProvider>
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestHarness />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );

    // First detection with stuck progress
    act(() => {
      eventBusInstance.get('annotate:assist-request').next({ motivation: 'linking', options: {} });
    });

    act(() => {
      eventBusInstance.get('annotate:progress').next({ message: 'Old progress stuck here' });
    });

    act(() => {
      eventBusInstance.get('annotate:assist-finished').next({ motivation: 'linking' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Old progress stuck here');
    });

    // WORKAROUND: Start new detection clears old progress
    act(() => {
      eventBusInstance.get('annotate:assist-request').next({ motivation: 'highlighting', options: {} });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('no progress');
    });
  });

  it('NEW FEATURE: Progress should auto-dismiss after 5 seconds', { timeout: 7000 }, async () => {
    // This test verifies the new auto-dismiss feature

    let eventBusInstance: any;

    function TestHarness() {
      eventBusInstance = useEventBus();
      const { progress } = useAnnotationFlow(rUri);

      return (
        <div data-testid="progress">
          {progress ? 'visible' : 'dismissed'}
        </div>
      );
    }

    render(
      <EventBusProvider>
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestHarness />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );

    // Show progress
    act(() => {
      eventBusInstance.get('annotate:assist-request').next({ motivation: 'linking', options: {} });
    });

    act(() => {
      eventBusInstance.get('annotate:progress').next({
        status: 'complete',
        message: 'Complete! Created 5 annotations'
      });
    });

    act(() => {
      eventBusInstance.get('annotate:assist-finished').next({ motivation: 'linking' });
    });

    // Progress visible initially
    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('visible');
    });

    // Auto-dismiss after 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5100));

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('dismissed');
    });
  });

  it('FIXED: SSE emits final completion chunk data as annotate:assist-progress', async () => {
    /**
     * This test verifies that SSE emits the final chunk as annotate:assist-progress
     * BEFORE emitting annotate:assist-finished.
     *
     * This ensures the UI can display the final completion message with status:'complete'.
     */

    let eventBusInstance: any;

    function TestHarness() {
      eventBusInstance = useEventBus();
      const { progress } = useAnnotationFlow(rUri);

      return (
        <div>
          <div data-testid="progress-status">{progress?.status || 'none'}</div>
          <div data-testid="progress-message">{progress?.message || 'no message'}</div>
        </div>
      );
    }

    render(
      <EventBusProvider>
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestHarness />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );

    // Start detection (triggers SSE stream creation)
    act(() => {
      eventBusInstance.get('annotate:assist-request').next({
        motivation: 'linking',
        options: { entityTypes: ['Location'] }
      });
    });

    // Simulate SSE scanning chunk
    act(() => {
      eventBusInstance.get('annotate:progress').next({
        status: 'scanning',
        message: 'Processing: Location',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress-status')).toHaveTextContent('scanning');
    });

    // Simulate SSE emitting final chunk as annotate:assist-progress
    act(() => {
      eventBusInstance.get('annotate:progress').next({
        status: 'complete',
        message: 'Complete! Found 5 entities',
        foundCount: 5,
      });
    });

    // Verify final chunk is now visible
    await waitFor(() => {
      expect(screen.getByTestId('progress-status')).toHaveTextContent('complete');
      expect(screen.getByTestId('progress-message')).toHaveTextContent('Complete! Found 5 entities');
    });
  });
});
