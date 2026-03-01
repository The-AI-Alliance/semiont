/**
 * FAILING TEST: Reproduces the bug where detection events fire but state doesn't update
 *
 * Based on console logs from production:
 * ✅ mark:assist-request emitted
 * ✅ annotate:assist-progress emitted
 * ❌ assistingMotivation remains null
 * ❌ progress remains null
 *
 * UPDATED: Now tests useMarkFlow hook instead of DetectionFlowContainer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useMarkFlow } from '../../../hooks/useMarkFlow';
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
    vi.spyOn(SSEClient.prototype, 'annotateReferences').mockReturnValue({ onProgress: vi.fn().mockReturnThis(), onComplete: vi.fn().mockReturnThis(), onError: vi.fn().mockReturnThis(), close: vi.fn() } as any);
    vi.spyOn(SSEClient.prototype, 'annotateHighlights').mockReturnValue({ onProgress: vi.fn().mockReturnThis(), onComplete: vi.fn().mockReturnThis(), onError: vi.fn().mockReturnThis(), close: vi.fn() } as any);
    vi.spyOn(SSEClient.prototype, 'annotateComments').mockReturnValue({ onProgress: vi.fn().mockReturnThis(), onComplete: vi.fn().mockReturnThis(), onError: vi.fn().mockReturnThis(), close: vi.fn() } as any);
    vi.spyOn(SSEClient.prototype, 'annotateAssessments').mockReturnValue({ onProgress: vi.fn().mockReturnThis(), onComplete: vi.fn().mockReturnThis(), onError: vi.fn().mockReturnThis(), close: vi.fn() } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SHOULD update state when mark:assist-request event is emitted', async () => {
    let eventBusInstance: any;
    let currentState: any;

    // Component to capture EventBus and hook state
    function TestComponent() {
      eventBusInstance = useEventBus();
      const state = useMarkFlow('http://localhost:8080/resources/test' as any);
      currentState = state;

      console.log('[TEST] useMarkFlow state:', {
        assistingMotivation: state.assistingMotivation,
        progress: state.progress,
      });

      return (
        <div>
          <div data-testid="detecting">{state.assistingMotivation || 'null'}</div>
          <div data-testid="progress">{state.progress?.message || 'null'}</div>
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

    console.log('[TEST] Emitting mark:assist-request event...');

    // Emit mark:assist-request event (exactly like production)
    act(() => {
      eventBusInstance.get('mark:assist-request').next({
        motivation: 'linking',
        options: { entityTypes: ['Location'] }
      });
    });

    console.log('[TEST] After mark:assist-request, checking state...');

    // THIS SHOULD PASS but currently FAILS
    await waitFor(() => {
      expect(screen.getByTestId('detecting')).toHaveTextContent('linking');
    }, { timeout: 1000 });

    expect(currentState.assistingMotivation).toBe('linking');
    expect(currentState.progress).toBeNull(); // Should clear on start
  });

  it('SHOULD update state when annotate:assist-progress event is emitted', async () => {
    let eventBusInstance: any;
    let currentState: any;

    function TestComponent() {
      eventBusInstance = useEventBus();
      const state = useMarkFlow('http://localhost:8080/resources/test' as any);
      currentState = state;

      return (
        <div>
          <div data-testid="detecting">{state.assistingMotivation || 'null'}</div>
          <div data-testid="progress">{state.progress?.message || 'null'}</div>
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

    console.log('[TEST] Emitting annotate:assist-progress event...');

    // Emit annotate:assist-progress event (exactly like production)
    act(() => {
      eventBusInstance.get('mark:progress').next({
        status: 'started',
        resourceId: 'test',
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        message: 'Starting entity detection...'
      });
    });

    console.log('[TEST] After annotate:assist-progress, checking state...');

    // THIS SHOULD PASS but currently FAILS
    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Starting entity detection...');
    }, { timeout: 1000 });

    expect(currentState.progress).toMatchObject({
      status: 'started',
      message: 'Starting entity detection...'
    });
  });

  it('SHOULD show EXACTLY the production bug', async () => {
    let eventBusInstance: any;
    const stateSnapshots: any[] = [];

    function TestComponent() {
      eventBusInstance = useEventBus();
      const state = useMarkFlow('http://localhost:8080/resources/f45fd44f9cb0b0fe1b7980d3d034bc61' as any);

      stateSnapshots.push({
        assistingMotivation: state.assistingMotivation,
        progress: state.progress,
      });

      return (
        <div>
          <div data-testid="detecting">{state.assistingMotivation || 'null'}</div>
          <div data-testid="progress">{state.progress?.message || 'null'}</div>
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
      console.log('[EventBus] emit: mark:assist-request {motivation: "linking", options: {...}}');
      eventBusInstance.get('mark:assist-request').next({
        motivation: 'linking',
        options: { entityTypes: ['Location'] }
      });
    });

    console.log('After mark:assist-request:', stateSnapshots[stateSnapshots.length - 1]);

    act(() => {
      console.log('[EventBus] emit: annotate:assist-progress {status: "started", ...}');
      eventBusInstance.get('mark:progress').next({
        status: 'started',
        resourceId: 'f45fd44f9cb0b0fe1b7980d3d034bc61',
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        message: 'Starting entity detection...'
      });
    });

    console.log('After annotate:assist-progress:', stateSnapshots[stateSnapshots.length - 1]);

    act(() => {
      console.log('[EventBus] emit: annotate:assist-progress {status: "scanning", ...}');
      eventBusInstance.get('mark:progress').next({
        status: 'scanning',
        resourceId: 'f45fd44f9cb0b0fe1b7980d3d034bc61',
        currentEntityType: 'Location',
        totalEntityTypes: 1,
        processedEntityTypes: 1,
        message: 'Scanning for Location...'
      });
    });

    console.log('After second annotate:assist-progress:', stateSnapshots[stateSnapshots.length - 1]);
    console.log('=== END REPRODUCTION ===\n');

    // THIS IS THE BUG: Events fire but state never updates
    // Production logs show: assistingMotivation: null, progress: null
    // Even though events were emitted
    await waitFor(() => {
      const currentSnapshot = stateSnapshots[stateSnapshots.length - 1];
      console.log('Final state check:', currentSnapshot);

      // These SHOULD pass but will FAIL if bug is present
      expect(currentSnapshot.assistingMotivation).toBe('linking');
      expect(currentSnapshot.progress?.message).toBe('Scanning for Location...');
    }, { timeout: 2000 });
  });
});
