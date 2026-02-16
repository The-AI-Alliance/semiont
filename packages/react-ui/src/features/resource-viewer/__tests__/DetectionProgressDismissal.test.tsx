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
 * - useDetectionFlow.ts (line 54-62): detection:complete clears `detectingMotivation` but keeps `detectionProgress`
 * - DetectSection.tsx (line 214): Shows progress UI whenever `detectionProgress` is not null
 * - No mechanism to auto-dismiss or manually close the progress display
 *
 * FIX OPTIONS:
 * A) Auto-dismiss after timeout (3s after completion)
 * B) Add "Close" button to progress display
 * C) Clear progress on next detection:start (already works but not ideal UX)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useDetectionFlow } from '../../../hooks/useDetectionFlow';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { resourceUri } from '@semiont/api-client';

describe('Detection Progress Dismissal Bug', () => {
  let mockStream: any;
  let mockClient: any;
  const rUri = resourceUri('https://example.com/resources/test');

  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();

    mockStream = {
      onProgress: vi.fn().mockReturnThis(),
      onComplete: vi.fn().mockReturnThis(),
      onError: vi.fn().mockReturnThis(),
      close: vi.fn(),
    };

    mockClient = {
      sse: {
        detectAnnotations: vi.fn(() => mockStream),
      },
    };
  });

  it('BUG: Progress stays visible after detection completes', { timeout: 7000 }, async () => {
    let eventBusInstance: any;

    function TestHarness() {
      eventBusInstance = useEventBus();
      const { detectingMotivation, detectionProgress } = useDetectionFlow(rUri);

      return (
        <div>
          <div data-testid="detecting">{detectingMotivation || 'none'}</div>
          <div data-testid="progress">
            {detectionProgress ? detectionProgress.message || 'has progress' : 'no progress'}
          </div>
        </div>
      );
    }

    render(
      <EventBusProvider>
        <ApiClientProvider apiClientManager={mockClient}>
          <TestHarness />
        </ApiClientProvider>
      </EventBusProvider>
    );

    // Initial state
    expect(screen.getByTestId('detecting')).toHaveTextContent('none');
    expect(screen.getByTestId('progress')).toHaveTextContent('no progress');

    // User clicks detect button (emits detection:start)
    act(() => {
      eventBusInstance.emit('detection:start', {
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
      eventBusInstance.emit('detection:progress', {
        status: 'scanning',
        message: 'Processing: Location',
        currentEntityType: 'Location',
      });
    });

    // Progress is visible
    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Processing: Location');
    });

    // Detection completes (SSE finishes, backend emits detection:complete)
    act(() => {
      eventBusInstance.emit('detection:complete', { motivation: 'linking' });
    });

    // BUG: detectingMotivation cleared but progress still visible
    await waitFor(() => {
      expect(screen.getByTestId('detecting')).toHaveTextContent('none');
      // This is the BUG - progress should eventually dismiss but doesn't
      expect(screen.getByTestId('progress')).toHaveTextContent('Processing: Location');
    });

    // Wait 5 seconds - progress STILL visible (confirming the bug)
    await new Promise(resolve => setTimeout(resolve, 5000));
    expect(screen.getByTestId('progress')).toHaveTextContent('Processing: Location');
  });

  it('WORKAROUND: Starting new detection clears old progress', async () => {
    let eventBusInstance: any;

    function TestHarness() {
      eventBusInstance = useEventBus();
      const { detectionProgress } = useDetectionFlow(rUri);

      return (
        <div data-testid="progress">
          {detectionProgress ? detectionProgress.message || 'has progress' : 'no progress'}
        </div>
      );
    }

    render(
      <EventBusProvider>
        <ApiClientProvider apiClientManager={mockClient}>
          <TestHarness />
        </ApiClientProvider>
      </EventBusProvider>
    );

    // First detection with stuck progress
    act(() => {
      eventBusInstance.emit('detection:start', { motivation: 'linking', options: {} });
    });

    act(() => {
      eventBusInstance.emit('detection:progress', { message: 'Old progress stuck here' });
    });

    act(() => {
      eventBusInstance.emit('detection:complete', { motivation: 'linking' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Old progress stuck here');
    });

    // WORKAROUND: Start new detection clears old progress
    act(() => {
      eventBusInstance.emit('detection:start', { motivation: 'highlighting', options: {} });
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
      const { detectionProgress } = useDetectionFlow(rUri);

      return (
        <div data-testid="progress">
          {detectionProgress ? 'visible' : 'dismissed'}
        </div>
      );
    }

    render(
      <EventBusProvider>
        <ApiClientProvider apiClientManager={mockClient}>
          <TestHarness />
        </ApiClientProvider>
      </EventBusProvider>
    );

    // Show progress
    act(() => {
      eventBusInstance.emit('detection:start', { motivation: 'linking', options: {} });
    });

    act(() => {
      eventBusInstance.emit('detection:progress', {
        status: 'complete',
        message: 'Complete! Created 5 annotations'
      });
    });

    act(() => {
      eventBusInstance.emit('detection:complete', { motivation: 'linking' });
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

  it('FIXED: useEventOperations now forwards final completion chunk data', async () => {
    /**
     * This test verifies the fix for the useEventOperations bug.
     *
     * FIX: useEventOperations.ts stream.onComplete(finalChunk) now emits detection:progress
     * with the final chunk data BEFORE emitting detection:complete.
     *
     * This ensures the UI can display the final completion message with status:'complete'.
     */

    let eventBusInstance: any;

    function TestHarness() {
      eventBusInstance = useEventBus();
      const { detectionProgress } = useDetectionFlow(rUri);

      return (
        <div>
          <div data-testid="progress-status">{detectionProgress?.status || 'none'}</div>
          <div data-testid="progress-message">{detectionProgress?.message || 'no message'}</div>
        </div>
      );
    }

    // Mock SSE stream to simulate backend behavior
    let onProgressCallback: any;
    let onCompleteCallback: any;

    mockStream.onProgress.mockImplementation((cb: any) => {
      onProgressCallback = cb;
      return mockStream;
    });

    mockStream.onComplete.mockImplementation((cb: any) => {
      onCompleteCallback = cb;
      return mockStream;
    });

    render(
      <EventBusProvider>
        <ApiClientProvider apiClientManager={mockClient}>
          <TestHarness />
        </ApiClientProvider>
      </EventBusProvider>
    );

    // Start detection (triggers SSE stream creation)
    act(() => {
      eventBusInstance.emit('detection:start', {
        motivation: 'linking',
        options: { entityTypes: ['Location'] }
      });
    });

    // Simulate SSE scanning chunk via stream.onProgress()
    act(() => {
      onProgressCallback?.({
        status: 'scanning',
        message: 'Processing: Location',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress-status')).toHaveTextContent('scanning');
    });

    // Simulate backend sending final chunk to stream.onComplete(finalChunk)
    // useEventOperations should forward this as detection:progress
    act(() => {
      onCompleteCallback?.({
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
