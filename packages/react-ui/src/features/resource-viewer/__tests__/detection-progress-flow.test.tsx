/**
 * Layer 3 Integration Test: Detection Progress Flow
 *
 * Tests the complete data flow from UI → EventBus → useEventOperations → SSE (mocked)
 *
 * This test uses:
 * - Real React components (ResourceViewerPage, UnifiedAnnotationsPanel, HighlightPanel, DetectSection)
 * - Real EventBus (mitt)
 * - Real useEventOperations hook
 * - Mock SSE stream (simulated API responses)
 *
 * This is the CRITICAL test that will reveal where the detection progress bug is.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { ResourceViewerPage } from '../components/ResourceViewerPage';
import type { ResourceViewerPageProps } from '../components/ResourceViewerPage';
// Import directly from file, not from @semiont/react-ui barrel export
import { EventBusProvider, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import type { components } from '@semiont/api-client';

type Resource = components['schemas']['Resource'];
type Annotation = components['schemas']['Annotation'];

// Mock API client hook to return our test client
let testMockClient: any = null;

vi.mock('@semiont/react-ui', async () => {
  const actual: any = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    ResourceViewer: ({ resource }: any) => <div data-testid="resource-viewer">{resource.name}</div>,
    Toolbar: () => <div data-testid="toolbar">Toolbar</div>,
    // Don't mock ToolbarPanels, UnifiedAnnotationsPanel - let real ones render for integration test
    AnnotationHistory: () => <div data-testid="history-panel">History</div>,
    ResourceInfoPanel: () => <div data-testid="info-panel">Info</div>,
    CollaborationPanel: () => <div data-testid="collaboration-panel">Collaboration</div>,
    JsonLdPanel: () => <div data-testid="jsonld-panel">JSON-LD</div>,
    ErrorBoundary: ({ children }: any) => children,
    createCancelDetectionHandler: () => vi.fn(),
    useGenerationProgress: () => ({
      progress: null,
      startGeneration: vi.fn(),
      clearProgress: vi.fn(),
    }),
    useResourceLoadingAnnouncements: () => ({
      announceResourceLoading: vi.fn(),
      announceResourceLoaded: vi.fn(),
    }),
    useResourceAnnotations: () => ({
      clearNewAnnotationId: vi.fn(),
      newAnnotationIds: new Set(),
      createAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      triggerSparkleAnimation: vi.fn(),
    }),
    useApiClient: () => testMockClient,
    // Don't mock useEventBus, EventBusProvider, useEventSubscriptions - let actual pass through
    useEventSubscriptions: vi.fn(),
  };
});

// Create a mock SSE stream that we can control
class MockSSEStream {
  private progressHandlers: Array<(chunk: any) => void> = [];
  private completeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];

  onProgress(handler: (chunk: any) => void) {
    this.progressHandlers.push(handler);
  }

  onComplete(handler: () => void) {
    this.completeHandlers.push(handler);
  }

  onError(handler: (error: Error) => void) {
    this.errorHandlers.push(handler);
  }

  // Test helper methods
  emitProgress(chunk: any) {
    this.progressHandlers.forEach(handler => handler(chunk));
  }

  emitComplete() {
    this.completeHandlers.forEach(handler => handler());
  }

  emitError(error: Error) {
    this.errorHandlers.forEach(handler => handler(error));
  }
}

describe('Detection Progress Flow Integration (Layer 3)', () => {
  let mockResource: Resource;
  let mockAnnotations: Annotation[];
  let mockStream: MockSSEStream;
  let mockClient: any;

  // Helper to create props and render
  const renderResourceViewerPage = (props?: Partial<ResourceViewerPageProps>) => {
    const defaultProps: ResourceViewerPageProps = {
      resource: mockResource as any,
      rUri: mockResource.uri as any,
      content: 'Test content',
      contentLoading: false,
      annotations: mockAnnotations,
      referencedBy: [],
      referencedByLoading: false,
      allEntityTypes: [],
      locale: 'en',
      theme: 'light',
      showLineNumbers: false,
      showSuccess: vi.fn(),
      showError: vi.fn(),
      cacheManager: mockClient as any,
      Link: ({ children }: any) => <a>{children}</a>,
      routes: { know: '/know', browse: '/browse' },
      // ToolbarPanels component that renders when activePanel is set
      ToolbarPanels: ({ children, activePanel }: any) =>
        activePanel ? <div data-testid="toolbar-panels">{children}</div> : null,
      SearchResourcesModal: () => <div>Search Modal</div>,
      GenerationConfigModal: () => <div>Generation Modal</div>,
      ...props,
    };

    return render(
      <EventBusProvider>
        <ResourceViewerPage {...defaultProps} />
      </EventBusProvider>
    );
  };

  beforeEach(() => {
    // Reset event bus for test isolation
    resetEventBusForTesting();

    // Reset mocks
    mockStream = new MockSSEStream();

    // Create mock API client with SSE support
    mockClient = {
      sse: {
        detectHighlights: vi.fn(() => mockStream),
        detectAssessments: vi.fn(() => mockStream),
        detectComments: vi.fn(() => mockStream),
        detectTags: vi.fn(() => mockStream),
        detectAnnotations: vi.fn(() => mockStream),
      },
      createAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      updateAnnotationBody: vi.fn(),
    };

    // Set the test mock client for useApiClient hook
    testMockClient = mockClient;

    // Mock resource
    mockResource = {
      id: 'test-resource-1',
      name: 'Test Document',
      uri: 'https://example.com/resources/test-resource-1',
      resourceType: 'Document',
      mimeType: 'text/plain',
      content: 'This is test content for detection.',
      archived: false,
      created: '2024-01-01T00:00:00Z',
      modified: '2024-01-01T00:00:00Z',
    };

    mockAnnotations = [];

    // Setup localStorage to show annotations panel in annotate mode
    if (typeof window !== 'undefined') {
      localStorage.clear();
      localStorage.setItem('activeToolbarPanel', 'annotations');
      localStorage.setItem('annotateMode', 'true');
    }
  });

  it('should display detection progress from button click to completion', async () => {
    const user = userEvent.setup();

    // Render with EventBusProvider and mocked API client
    const { getByText, queryByText } = renderResourceViewerPage();

    // Initial state: no progress visible
    expect(queryByText(/Analyzing/)).not.toBeInTheDocument();

    // Click detect button (assumes we're in annotate mode and highlights panel)
    // First, make sure we're on the annotations panel
    const detectButton = getByText(/Detect/i);
    await user.click(detectButton);

    // Verify API was called
    await waitFor(() => {
      expect(mockClient.sse.detectHighlights).toHaveBeenCalledWith(
        mockResource.uri,
        expect.objectContaining({
          instructions: expect.any(String),
        })
      );
    });

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
      expect(getByText('Starting detection...')).toBeInTheDocument();
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
      expect(getByText('Analyzing text...')).toBeInTheDocument();
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
      expect(getByText('Creating 14 annotations...')).toBeInTheDocument();
    });

    // Simulate SSE progress chunk #4: Complete
    act(() => {
      mockStream.emitProgress({
        status: 'complete',
        percentage: 100,
        message: 'Complete! Created 14 highlights',
      });
    });

    // Simulate stream completion
    act(() => {
      mockStream.emitComplete();
    });

    // CRITICAL TEST: Final message should still be visible after completion
    await waitFor(() => {
      expect(getByText('Complete! Created 14 highlights')).toBeInTheDocument();
    });
  });

  it('should handle out-of-order SSE events (complete before final progress)', async () => {
    const user = userEvent.setup();

    const { getByText } = renderResourceViewerPage();

    // Click detect
    const detectButton = getByText(/Detect/i);
    await user.click(detectButton);

    // Simulate initial progress
    act(() => {
      mockStream.emitProgress({
        status: 'analyzing',
        message: 'Analyzing...',
      });
    });

    await waitFor(() => {
      expect(getByText('Analyzing...')).toBeInTheDocument();
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
      expect(getByText('Complete! Created 5 highlights')).toBeInTheDocument();
    });
  });

  it('should show progress with request parameters', async () => {
    const user = userEvent.setup();

    const { getByText } = renderResourceViewerPage();

    const detectButton = getByText(/Detect/i);
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
      expect(getByText('Find important points')).toBeInTheDocument();
      expect(getByText('5')).toBeInTheDocument();
    });
  });

  it('should clear progress on detection:failed', async () => {
    const user = userEvent.setup();

    const { getByText, queryByText } = renderResourceViewerPage();

    const detectButton = getByText(/Detect/i);
    await user.click(detectButton);

    // Show progress
    act(() => {
      mockStream.emitProgress({
        status: 'analyzing',
        message: 'Analyzing...',
      });
    });

    await waitFor(() => {
      expect(getByText('Analyzing...')).toBeInTheDocument();
    });

    // Simulate error
    act(() => {
      mockStream.emitError(new Error('Network timeout'));
    });

    // Progress should be cleared
    await waitFor(() => {
      expect(queryByText('Analyzing...')).not.toBeInTheDocument();
    });
  });
});
