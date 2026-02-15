/**
 * Layer 3 Integration Test: DetectionFlowContainer
 *
 * Tests the COMPLETE detection flow:
 * - EventBus (REAL)
 * - useEventOperations (REAL - sets up SSE handlers)
 * - DetectionFlowContainer (REAL - manages state)
 * - Event subscriptions (REAL)
 * - API client (MOCKED - we mock the SSE stream)
 *
 * This is the test that was IMPOSSIBLE before the refactoring.
 * It verifies the actual data flow: Event → State → Props
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { DetectionFlowContainer } from '../containers/DetectionFlowContainer';
import { EventBusProvider, useEventBus } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import type { ApiClientManager } from '../../../types/ApiClientManager';

// Mock API client with SSE stream
const createMockApiClient = () => {
  const mockStream = {
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    close: vi.fn(),
  };

  return {
    apiClientManager: {
      getClient: vi.fn().mockReturnValue({
        sse: {
          detectHighlights: vi.fn().mockReturnValue(mockStream),
          detectComments: vi.fn().mockReturnValue(mockStream),
          detectAssessments: vi.fn().mockReturnValue(mockStream),
        },
      }),
    } as unknown as ApiClientManager,
    mockStream,
  };
};

describe('DetectionFlowContainer - Layer 3 Integration', () => {
  let mockApiClient: ReturnType<typeof createMockApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = createMockApiClient();
  });

  it('should update detectionProgress when detection:progress event is emitted', async () => {
    const { result, emitEvent } = renderDetectionFlowContainer(mockApiClient.apiClientManager);

    // Verify initial state
    expect(result().detectionProgress).toBeNull();
    expect(result().detectingMotivation).toBeNull();

    // Emit detection:start event
    act(() => {
      emitEvent('detection:start', { motivation: 'highlighting' });
    });

    // Verify detecting state updated
    await waitFor(() => {
      expect(result().detectingMotivation).toBe('highlighting');
      expect(result().detectionProgress).toBeNull(); // No progress yet
    });

    // Emit detection:progress event
    act(() => {
      emitEvent('detection:progress', {
        status: 'analyzing',
        percentage: 30,
        message: 'Analyzing text...',
      });
    });

    // Verify progress state updated
    await waitFor(() => {
      expect(result().detectionProgress).toEqual({
        status: 'analyzing',
        percentage: 30,
        message: 'Analyzing text...',
      });
    });
  });

  it('should keep progress visible after detection:complete', async () => {
    const { result, emitEvent } = renderDetectionFlowContainer(mockApiClient.apiClientManager);

    // Start detection
    act(() => {
      emitEvent('detection:start', { motivation: 'highlighting' });
    });

    await waitFor(() => {
      expect(result().detectingMotivation).toBe('highlighting');
    });

    // Emit final progress chunk
    act(() => {
      emitEvent('detection:progress', {
        status: 'complete',
        percentage: 100,
        message: 'Complete! Created 14 highlights',
      });
    });

    await waitFor(() => {
      expect(result().detectionProgress?.message).toBe('Complete! Created 14 highlights');
    });

    // Emit detection:complete
    act(() => {
      emitEvent('detection:complete', { motivation: 'highlighting' });
    });

    // Verify: detecting flag cleared BUT progress still visible
    await waitFor(() => {
      expect(result().detectingMotivation).toBeNull();
      expect(result().detectionProgress?.message).toBe('Complete! Created 14 highlights');
    });
  });

  it('should handle multiple progress updates', async () => {
    const { result, emitEvent } = renderDetectionFlowContainer(mockApiClient.apiClientManager);

    act(() => {
      emitEvent('detection:start', { motivation: 'highlighting' });
    });

    await waitFor(() => {
      expect(result().detectingMotivation).toBe('highlighting');
    });

    // First progress
    act(() => {
      emitEvent('detection:progress', {
        status: 'started',
        percentage: 0,
        message: 'Starting...',
      });
    });

    await waitFor(() => {
      expect(result().detectionProgress?.message).toBe('Starting...');
    });

    // Second progress
    act(() => {
      emitEvent('detection:progress', {
        status: 'analyzing',
        percentage: 50,
        message: 'Analyzing...',
      });
    });

    await waitFor(() => {
      expect(result().detectionProgress?.message).toBe('Analyzing...');
      expect(result().detectionProgress?.percentage).toBe(50);
    });

    // Final progress
    act(() => {
      emitEvent('detection:progress', {
        status: 'complete',
        percentage: 100,
        message: 'Done!',
      });
    });

    await waitFor(() => {
      expect(result().detectionProgress?.message).toBe('Done!');
      expect(result().detectionProgress?.percentage).toBe(100);
    });
  });

  it('should clear progress on detection:failed', async () => {
    const { result, emitEvent } = renderDetectionFlowContainer(mockApiClient.apiClientManager);

    // Start detection
    act(() => {
      emitEvent('detection:start', { motivation: 'highlighting' });
      emitEvent('detection:progress', {
        status: 'analyzing',
        message: 'Analyzing...',
      });
    });

    await waitFor(() => {
      expect(result().detectionProgress).not.toBeNull();
    });

    // Emit failure
    act(() => {
      emitEvent('detection:failed', { error: new Error('Network error') });
    });

    // Verify: both detecting flag and progress cleared
    await waitFor(() => {
      expect(result().detectingMotivation).toBeNull();
      expect(result().detectionProgress).toBeNull();
    });
  });

  it('should handle different motivations', async () => {
    const { result, emitEvent } = renderDetectionFlowContainer(mockApiClient.apiClientManager);

    // Test commenting motivation
    act(() => {
      emitEvent('detection:start', { motivation: 'commenting' });
    });

    await waitFor(() => {
      expect(result().detectingMotivation).toBe('commenting');
    });

    act(() => {
      emitEvent('detection:complete', { motivation: 'commenting' });
    });

    await waitFor(() => {
      expect(result().detectingMotivation).toBeNull();
    });

    // Test assessing motivation
    act(() => {
      emitEvent('detection:start', { motivation: 'assessing' });
    });

    await waitFor(() => {
      expect(result().detectingMotivation).toBe('assessing');
    });
  });

  it('should only clear detecting flag for matching motivation on complete', async () => {
    const { result, emitEvent } = renderDetectionFlowContainer(mockApiClient.apiClientManager);

    // Start highlighting detection
    act(() => {
      emitEvent('detection:start', { motivation: 'highlighting' });
    });

    await waitFor(() => {
      expect(result().detectingMotivation).toBe('highlighting');
    });

    // Complete with different motivation (shouldn't clear)
    act(() => {
      emitEvent('detection:complete', { motivation: 'commenting' });
    });

    // Verify: still detecting highlights
    await waitFor(() => {
      expect(result().detectingMotivation).toBe('highlighting');
    });

    // Complete with matching motivation
    act(() => {
      emitEvent('detection:complete', { motivation: 'highlighting' });
    });

    // Verify: now cleared
    await waitFor(() => {
      expect(result().detectingMotivation).toBeNull();
    });
  });
});

// Test helper: Render DetectionFlowContainer with event bus access
function renderDetectionFlowContainer(apiClientManager: ApiClientManager) {
  let eventBusInstance: any;
  let currentState: any = {
    detectingMotivation: null,
    detectionProgress: null,
    detectionStreamRef: { current: null },
  };

  // Component to capture event bus
  function EventBusCapture() {
    eventBusInstance = useEventBus();
    return null;
  }

  const { rerender } = render(
    <EventBusProvider>
      <ApiClientProvider apiClientManager={apiClientManager}>
        <EventBusCapture />
        <DetectionFlowContainer rUri="resource-1">
          {(state) => {
            currentState = state;
            return (
              <>
                <div data-testid="detecting">{state.detectingMotivation || 'none'}</div>
                <div data-testid="progress">{state.detectionProgress?.message || 'No progress'}</div>
              </>
            );
          }}
        </DetectionFlowContainer>
      </ApiClientProvider>
    </EventBusProvider>
  );

  return {
    result: () => currentState,
    emitEvent: (event: string, payload: any) => {
      if (!eventBusInstance) throw new Error('EventBus not captured');
      eventBusInstance.emit(event, payload);
      rerender(
        <EventBusProvider>
          <ApiClientProvider apiClientManager={apiClientManager}>
            <EventBusCapture />
            <DetectionFlowContainer rUri="resource-1">
              {(state) => {
                currentState = state;
                return (
                  <>
                    <div data-testid="detecting">{state.detectingMotivation || 'none'}</div>
                    <div data-testid="progress">{state.detectionProgress?.message || 'No progress'}</div>
                  </>
                );
              }}
            </DetectionFlowContainer>
          </ApiClientProvider>
        </EventBusProvider>
      );
    },
  };
}
