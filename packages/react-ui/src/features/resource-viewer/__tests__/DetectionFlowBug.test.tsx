/**
 * FAILING TEST: Reproduces the bug where detection events fire but state doesn't update
 *
 * Based on console logs from production:
 * ✅ detection:start emitted
 * ✅ detection:progress emitted
 * ❌ detectingMotivation remains null
 * ❌ detectionProgress remains null
 *
 * UPDATED: Now tests useDetectionFlow hook instead of DetectionFlowContainer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useDetectionFlow } from '../../../hooks/useDetectionFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import type { ApiClientManager } from '../../../types/ApiClientManager';
import type { SemiontApiClient } from '@semiont/api-client';

describe('REPRODUCING BUG: Detection state not updating', () => {
  let mockApiClient: SemiontApiClient;

  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();

    // Minimal mock - SSE streams not needed for this test
    mockApiClient = {
      sse: {
        detectAnnotations: vi.fn(),
        detectHighlights: vi.fn(),
        detectComments: vi.fn(),
        detectAssessments: vi.fn(),
      },
    } as any;
  });

  it('SHOULD update state when detection:start event is emitted', async () => {
    let eventBusInstance: any;
    let currentState: any;

    // Component to capture EventBus and hook state
    function TestComponent() {
      eventBusInstance = useEventBus();
      const state = useDetectionFlow('http://localhost:8080/resources/test' as any);
      currentState = state;

      console.log('[TEST] useDetectionFlow state:', {
        detectingMotivation: state.detectingMotivation,
        detectionProgress: state.detectionProgress,
      });

      return (
        <div>
          <div data-testid="detecting">{state.detectingMotivation || 'null'}</div>
          <div data-testid="progress">{state.detectionProgress?.message || 'null'}</div>
        </div>
      );
    }

    render(
      <EventBusProvider>
        <ApiClientProvider apiClientManager={mockApiClient as ApiClientManager}>
          <TestComponent />
        </ApiClientProvider>
      </EventBusProvider>
    );

    // Initial state should be null
    expect(screen.getByTestId('detecting')).toHaveTextContent('null');
    expect(screen.getByTestId('progress')).toHaveTextContent('null');

    console.log('[TEST] Emitting detection:start event...');

    // Emit detection:start event (exactly like production)
    act(() => {
      eventBusInstance.emit('detection:start', {
        motivation: 'linking',
        options: { entityTypes: ['Location'] }
      });
    });

    console.log('[TEST] After detection:start, checking state...');

    // THIS SHOULD PASS but currently FAILS
    await waitFor(() => {
      expect(screen.getByTestId('detecting')).toHaveTextContent('linking');
    }, { timeout: 1000 });

    expect(currentState.detectingMotivation).toBe('linking');
    expect(currentState.detectionProgress).toBeNull(); // Should clear on start
  });

  it('SHOULD update state when detection:progress event is emitted', async () => {
    let eventBusInstance: any;
    let currentState: any;

    function TestComponent() {
      eventBusInstance = useEventBus();
      const state = useDetectionFlow('http://localhost:8080/resources/test' as any);
      currentState = state;

      return (
        <div>
          <div data-testid="detecting">{state.detectingMotivation || 'null'}</div>
          <div data-testid="progress">{state.detectionProgress?.message || 'null'}</div>
        </div>
      );
    }

    render(
      <EventBusProvider>
        <ApiClientProvider apiClientManager={mockApiClient as ApiClientManager}>
          <TestComponent />
        </ApiClientProvider>
      </EventBusProvider>
    );

    console.log('[TEST] Emitting detection:progress event...');

    // Emit detection:progress event (exactly like production)
    act(() => {
      eventBusInstance.emit('detection:progress', {
        status: 'started',
        resourceId: 'test',
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        message: 'Starting entity detection...'
      });
    });

    console.log('[TEST] After detection:progress, checking state...');

    // THIS SHOULD PASS but currently FAILS
    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Starting entity detection...');
    }, { timeout: 1000 });

    expect(currentState.detectionProgress).toMatchObject({
      status: 'started',
      message: 'Starting entity detection...'
    });
  });

  it('SHOULD show EXACTLY the production bug', async () => {
    let eventBusInstance: any;
    const stateSnapshots: any[] = [];

    function TestComponent() {
      eventBusInstance = useEventBus();
      const state = useDetectionFlow('http://localhost:8080/resources/f45fd44f9cb0b0fe1b7980d3d034bc61' as any);

      stateSnapshots.push({
        detectingMotivation: state.detectingMotivation,
        detectionProgress: state.detectionProgress,
      });

      return (
        <div>
          <div data-testid="detecting">{state.detectingMotivation || 'null'}</div>
          <div data-testid="progress">{state.detectionProgress?.message || 'null'}</div>
        </div>
      );
    }

    render(
      <EventBusProvider>
        <ApiClientProvider apiClientManager={mockApiClient as ApiClientManager}>
          <TestComponent />
        </ApiClientProvider>
      </EventBusProvider>
    );

    console.log('\n=== REPRODUCING PRODUCTION BUG ===');
    console.log('Initial state:', stateSnapshots[stateSnapshots.length - 1]);

    // Exactly like production logs
    act(() => {
      console.log('[EventBus] emit: detection:start {motivation: "linking", options: {...}}');
      eventBusInstance.emit('detection:start', {
        motivation: 'linking',
        options: { entityTypes: ['Location'] }
      });
    });

    console.log('After detection:start:', stateSnapshots[stateSnapshots.length - 1]);

    act(() => {
      console.log('[EventBus] emit: detection:progress {status: "started", ...}');
      eventBusInstance.emit('detection:progress', {
        status: 'started',
        resourceId: 'f45fd44f9cb0b0fe1b7980d3d034bc61',
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        message: 'Starting entity detection...'
      });
    });

    console.log('After detection:progress:', stateSnapshots[stateSnapshots.length - 1]);

    act(() => {
      console.log('[EventBus] emit: detection:progress {status: "scanning", ...}');
      eventBusInstance.emit('detection:progress', {
        status: 'scanning',
        resourceId: 'f45fd44f9cb0b0fe1b7980d3d034bc61',
        currentEntityType: 'Location',
        totalEntityTypes: 1,
        processedEntityTypes: 1,
        message: 'Scanning for Location...'
      });
    });

    console.log('After second detection:progress:', stateSnapshots[stateSnapshots.length - 1]);
    console.log('=== END REPRODUCTION ===\n');

    // THIS IS THE BUG: Events fire but state never updates
    // Production logs show: detectingMotivation: null, detectionProgress: null
    // Even though events were emitted
    await waitFor(() => {
      const currentSnapshot = stateSnapshots[stateSnapshots.length - 1];
      console.log('Final state check:', currentSnapshot);

      // These SHOULD pass but will FAIL if bug is present
      expect(currentSnapshot.detectingMotivation).toBe('linking');
      expect(currentSnapshot.detectionProgress?.message).toBe('Scanning for Location...');
    }, { timeout: 2000 });
  });
});
