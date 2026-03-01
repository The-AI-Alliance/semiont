/**
 * Layer 3 Integration Test: Detection Progress Flow UI/UX
 *
 * Tests the complete data flow from UI → EventBus → useBindFlow → SSE (mocked)
 *
 * This test uses COMPOSITION instead of mocking:
 * - Real React components composed together (useMarkFlow + HighlightPanel + AssistSection)
 * - Real EventBus (mitt) passed via context
 * - Real useBindFlow hook with mock API client passed as prop
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
 * UPDATED: Now tests useMarkFlow hook instead of DetectionFlowContainer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { HighlightPanel } from '../../../components/resource/panels/HighlightPanel';
import { useMarkFlow } from '../../../hooks/useMarkFlow';
import { EventBusProvider, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { SSEClient } from '@semiont/api-client';
import type { components } from '@semiont/core';

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

type Annotation = components['schemas']['Annotation'];

// Mock translations
const mockT = vi.fn((key: string) => {
  const translations: Record<string, string> = {
    title: 'Highlights',
    noHighlights: 'No highlights yet',
    annotateHighlights: 'Annotate Highlights',
    instructions: 'Instructions',
    optional: '(optional)',
    instructionsPlaceholder: 'Enter custom instructions...',
    densityLabel: 'Density',
    densitySparse: 'Sparse',
    densityDense: 'Dense',
    annotate: 'Annotate',
    annotating: 'Annotating...',
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
    this.eventBus.get('mark:progress').next(chunk);
  }

  emitComplete(finalChunk?: any, motivation: string = 'highlighting') {
    if (finalChunk) {
      this.eventBus.get('mark:progress').next(finalChunk);
    }
    this.eventBus.get('mark:assist-finished').next({ motivation });
  }

  emitError(error: Error) {
    this.eventBus.get('mark:assist-failed').next({
      type: 'job.failed' as const,
      resourceId: 'test' as any,
      userId: 'user' as any,
      id: 'evt-1' as any,
      timestamp: new Date().toISOString(),
      version: 1,
      payload: {
        jobId: 'job-1' as any,
        jobType: 'detection',
        error: error.message,
      },
    });
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
  const { assistingMotivation, progress } = useMarkFlow(rUri as any);

  return (
    <HighlightPanel
      annotations={annotations}
      pendingAnnotation={null}
      hoveredAnnotationId={null}
      isAssisting={assistingMotivation === 'highlighting'}
      progress={progress}
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
    vi.spyOn(SSEClient.prototype, 'annotateHighlights').mockReturnValue(mockStream as any);
    vi.spyOn(SSEClient.prototype, 'annotateAssessments').mockReturnValue(mockStream as any);
    vi.spyOn(SSEClient.prototype, 'annotateComments').mockReturnValue(mockStream as any);
    vi.spyOn(SSEClient.prototype, 'annotateReferences').mockReturnValue(mockStream as any);

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

    // Click annotate button
    const annotateButton = screen.getByRole('button', { name: /✨ Annotate/ });
    await user.click(annotateButton);

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

    // Click annotate button
    const annotateButton = screen.getByRole('button', { name: /✨ Annotate/ });
    await user.click(annotateButton);

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

    const annotateButton = screen.getByRole('button', { name: /✨ Annotate/ });
    await user.click(annotateButton);

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

  it('should clear progress on mark:assist-failed', async () => {
    const user = userEvent.setup();

    renderDetectionFlow();

    const annotateButton = screen.getByRole('button', { name: /✨ Annotate/ });
    await user.click(annotateButton);

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
