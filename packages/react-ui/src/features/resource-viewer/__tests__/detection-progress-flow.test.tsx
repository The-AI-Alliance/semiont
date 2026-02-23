/**
 * Layer 3 Integration Test: Detection Progress Flow UI/UX
 *
 * Tests the complete data flow from UI → EventBus → useResolutionFlow → SSE (mocked)
 *
 * This test uses COMPOSITION instead of mocking:
 * - Real React components composed together (useDetectionFlow + HighlightPanel + DetectSection)
 * - Real EventBus (mitt) passed via context
 * - Real useResolutionFlow hook with mock API client passed as prop
 * - Mock SSE stream (simulated API responses) provided via composition
 *
 * This test focuses on USER EXPERIENCE:
 * - Verifies user clicks "Detect" button and sees progress
 * - Tests progress messages appear and update correctly
 * - Validates final message stays visible after completion
 * - Ensures progress clears on error
 *
 * COMPLEMENTARY TEST: See DetectionFlowIntegration.test.tsx for architecture testing
 * - That test verifies SYSTEM ARCHITECTURE (event wiring, API call count)
 * - This test verifies USER EXPERIENCE (button clicks, UI feedback)
 *
 * UPDATED: Now tests useDetectionFlow hook instead of DetectionFlowContainer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { HighlightPanel } from '../../../components/resource/panels/HighlightPanel';
import { useDetectionFlow } from '../../../hooks/useDetectionFlow';
import { EventBusProvider, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SSEClient } from '@semiont/api-client';
import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

// Mock translations
const mockT = vi.fn((key: string) => {
  const translations: Record<string, string> = {
    title: 'Highlights',
    noHighlights: 'No highlights yet',
    detectHighlights: 'Detect Highlights',
    instructions: 'Instructions',
    optional: '(optional)',
    instructionsPlaceholder: 'Enter custom instructions...',
    densityLabel: 'Density',
    densitySparse: 'Sparse',
    densityDense: 'Dense',
    detect: 'Detect',
  };
  return translations[key] || key;
});

vi.mock('../../../contexts/TranslationContext', () => ({
  useTranslations: () => mockT,
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Create a mock SSE stream that we can control
class MockSSEStream {
  constructor(private eventBus: any) {}

  close() {
    // Mock close method
  }

  // Test helper methods that emit to EventBus
  emitProgress(chunk: any) {
    this.eventBus.get('detect:progress').next(chunk);
  }

  emitComplete(finalChunk?: any) {
    if (finalChunk) {
      this.eventBus.get('detect:progress').next(finalChunk);
    }
    this.eventBus.get('detect:finished').next({});
  }

  emitError(error: Error) {
    this.eventBus.get('detect:failed').next({ error });
  }
}

// Composition: Test component that wires together the pieces we're testing
function DetectionFlowTestHarness({
  rUri,
  annotations,
}: {
  rUri: string;
  annotations: Annotation[];
}) {
  const { detectingMotivation, detectionProgress } = useDetectionFlow(rUri as any);

  return (
    <HighlightPanel
      annotations={annotations}
      pendingAnnotation={null}
      hoveredAnnotationId={null}
      isDetecting={detectingMotivation === 'highlighting'}
      detectionProgress={detectionProgress}
      annotateMode={true}
    />
  );
}

describe('Detection Progress Flow Integration (Layer 3)', () => {
  let mockAnnotations: Annotation[];
  let mockStream: MockSSEStream;
  const rUri = 'https://example.com/resources/test-resource-1';

  // Helper to render test harness with composition
  const renderDetectionFlow = () => {
    return render(
      <EventBusProvider>
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <DetectionFlowTestHarness
              rUri={rUri}
              annotations={mockAnnotations}
            />
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    );
  };

  beforeEach(() => {
    // Reset event bus for test isolation
    const eventBus = resetEventBusForTesting();
    vi.clearAllMocks();

    // Reset mocks - create stream with eventBus
    mockStream = new MockSSEStream(eventBus);

    // Spy on SSEClient prototype methods to inject mock stream
    vi.spyOn(SSEClient.prototype, 'detectHighlights').mockReturnValue(mockStream as any);
    vi.spyOn(SSEClient.prototype, 'detectAssessments').mockReturnValue(mockStream as any);
    vi.spyOn(SSEClient.prototype, 'detectComments').mockReturnValue(mockStream as any);
    vi.spyOn(SSEClient.prototype, 'detectReferences').mockReturnValue(mockStream as any);

    mockAnnotations = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should display detection progress from button click to completion', async () => {
    const user = userEvent.setup();

    // Render composed components with real EventBus and mock API client
    renderDetectionFlow();

    // Initial state: no progress visible
    expect(screen.queryByText(/Analyzing/)).not.toBeInTheDocument();

    // Click detect button
    const detectButton = screen.getByRole('button', { name: /✨ Detect/ });
    await user.click(detectButton);

    // Simulate SSE progress chunk #1: Starting
    act(() => {
      mockStream.emitProgress({
        status: 'started',
        percentage: 0,
        message: 'Starting detection...',
      });
    });

    // Verify progress message appears
    await waitFor(() => {
      expect(screen.getByText('Starting detection...')).toBeInTheDocument();
    });

    // Simulate SSE progress chunk #2: Analyzing
    act(() => {
      mockStream.emitProgress({
        status: 'analyzing',
        percentage: 30,
        message: 'Analyzing text...',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Analyzing text...')).toBeInTheDocument();
    });

    // Simulate SSE progress chunk #3: Creating annotations
    act(() => {
      mockStream.emitProgress({
        status: 'creating',
        percentage: 60,
        message: 'Creating 14 annotations...',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Creating 14 annotations...')).toBeInTheDocument();
    });

    // Simulate stream completion with final chunk (onComplete receives the final progress)
    act(() => {
      mockStream.emitComplete({
        status: 'complete',
        percentage: 100,
        message: 'Complete! Created 14 highlights',
      });
    });

    // CRITICAL TEST: Final message should still be visible after completion
    await waitFor(() => {
      expect(screen.getByText('Complete! Created 14 highlights')).toBeInTheDocument();
    });
  });

  it('should handle out-of-order SSE events (complete before final progress)', async () => {
    const user = userEvent.setup();

    renderDetectionFlow();

    // Click detect
    const detectButton = screen.getByRole('button', { name: /✨ Detect/ });
    await user.click(detectButton);

    // Simulate initial progress
    act(() => {
      mockStream.emitProgress({
        status: 'analyzing',
        message: 'Analyzing...',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Analyzing...')).toBeInTheDocument();
    });

    // Simulate race condition: complete arrives BEFORE final progress
    act(() => {
      mockStream.emitComplete();
    });

    // Then final progress chunk arrives
    act(() => {
      mockStream.emitProgress({
        status: 'complete',
        percentage: 100,
        message: 'Complete! Created 5 highlights',
      });
    });

    // Final message should still be visible
    await waitFor(() => {
      expect(screen.getByText('Complete! Created 5 highlights')).toBeInTheDocument();
    });
  });

  it('should show progress with request parameters', async () => {
    const user = userEvent.setup();

    renderDetectionFlow();

    const detectButton = screen.getByRole('button', { name: /✨ Detect/ });
    await user.click(detectButton);

    // Simulate progress with request parameters
    act(() => {
      mockStream.emitProgress({
        status: 'analyzing',
        message: 'Analyzing with custom instructions...',
        requestParams: [
          { label: 'Instructions', value: 'Find important points' },
          { label: 'Density', value: '5' },
        ],
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Find important points')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
    });
  });

  it('should clear progress on detect:failed', async () => {
    const user = userEvent.setup();

    renderDetectionFlow();

    const detectButton = screen.getByRole('button', { name: /✨ Detect/ });
    await user.click(detectButton);

    // Show progress
    act(() => {
      mockStream.emitProgress({
        status: 'analyzing',
        message: 'Analyzing...',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Analyzing...')).toBeInTheDocument();
    });

    // Simulate error
    act(() => {
      mockStream.emitError(new Error('Network timeout'));
    });

    // Progress should be cleared
    await waitFor(() => {
      expect(screen.queryByText('Analyzing...')).not.toBeInTheDocument();
    });
  });
});
