/**
 * FAILING TEST: Reproduces the bug where detection events fire but state doesn't update
 *
 * Based on console logs from production:
 * ✅ annotate:detect-request emitted
 * ✅ annotate:detect-progress emitted
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
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SSEClient } from '@semiont/api-client';

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

describe('REPRODUCING BUG: Detection state not updating', () => {
  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();

    // Minimal mock - SSE streams not needed for this test
    vi.spyOn(SSEClient.prototype, 'detectReferences').mockReturnValue({ onProgress: vi.fn().mockReturnThis(), onComplete: vi.fn().mockReturnThis(), onError: vi.fn().mockReturnThis(), close: vi.fn() } as any);
    vi.spyOn(SSEClient.prototype, 'detectHighlights').mockReturnValue({ onProgress: vi.fn().mockReturnThis(), onComplete: vi.fn().mockReturnThis(), onError: vi.fn().mockReturnThis(), close: vi.fn() } as any);
    vi.spyOn(SSEClient.prototype, 'detectComments').mockReturnValue({ onProgress: vi.fn().mockReturnThis(), onComplete: vi.fn().mockReturnThis(), onError: vi.fn().mockReturnThis(), close: vi.fn() } as any);
    vi.spyOn(SSEClient.prototype, 'detectAssessments').mockReturnValue({ onProgress: vi.fn().mockReturnThis(), onComplete: vi.fn().mockReturnThis(), onError: vi.fn().mockReturnThis(), close: vi.fn() } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SHOULD update state when annotate:detect-request event is emitted', async () => {
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
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestComponent />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );

    // Initial state should be null
    expect(screen.getByTestId('detecting')).toHaveTextContent('null');
    expect(screen.getByTestId('progress')).toHaveTextContent('null');

    console.log('[TEST] Emitting annotate:detect-request event...');

    // Emit annotate:detect-request event (exactly like production)
    act(() => {
      eventBusInstance.get('annotate:detect-request').next({
        motivation: 'linking',
        options: { entityTypes: ['Location'] }
      });
    });

    console.log('[TEST] After annotate:detect-request, checking state...');

    // THIS SHOULD PASS but currently FAILS
    await waitFor(() => {
      expect(screen.getByTestId('detecting')).toHaveTextContent('linking');
    }, { timeout: 1000 });

    expect(currentState.detectingMotivation).toBe('linking');
    expect(currentState.detectionProgress).toBeNull(); // Should clear on start
  });

  it('SHOULD update state when annotate:detect-progress event is emitted', async () => {
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
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestComponent />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );

    console.log('[TEST] Emitting annotate:detect-progress event...');

    // Emit annotate:detect-progress event (exactly like production)
    act(() => {
      eventBusInstance.get('annotate:detect-progress').next({
        status: 'started',
        resourceId: 'test',
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        message: 'Starting entity detection...'
      });
    });

    console.log('[TEST] After annotate:detect-progress, checking state...');

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
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <TestComponent />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );

    console.log('\n=== REPRODUCING PRODUCTION BUG ===');
    console.log('Initial state:', stateSnapshots[stateSnapshots.length - 1]);

    // Exactly like production logs
    act(() => {
      console.log('[EventBus] emit: annotate:detect-request {motivation: "linking", options: {...}}');
      eventBusInstance.get('annotate:detect-request').next({
        motivation: 'linking',
        options: { entityTypes: ['Location'] }
      });
    });

    console.log('After annotate:detect-request:', stateSnapshots[stateSnapshots.length - 1]);

    act(() => {
      console.log('[EventBus] emit: annotate:detect-progress {status: "started", ...}');
      eventBusInstance.get('annotate:detect-progress').next({
        status: 'started',
        resourceId: 'f45fd44f9cb0b0fe1b7980d3d034bc61',
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        message: 'Starting entity detection...'
      });
    });

    console.log('After annotate:detect-progress:', stateSnapshots[stateSnapshots.length - 1]);

    act(() => {
      console.log('[EventBus] emit: annotate:detect-progress {status: "scanning", ...}');
      eventBusInstance.get('annotate:detect-progress').next({
        status: 'scanning',
        resourceId: 'f45fd44f9cb0b0fe1b7980d3d034bc61',
        currentEntityType: 'Location',
        totalEntityTypes: 1,
        processedEntityTypes: 1,
        message: 'Scanning for Location...'
      });
    });

    console.log('After second annotate:detect-progress:', stateSnapshots[stateSnapshots.length - 1]);
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
