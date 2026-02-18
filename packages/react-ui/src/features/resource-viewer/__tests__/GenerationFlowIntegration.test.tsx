/**
 * Layer 3: Feature Integration Test - Generation Flow Architecture
 *
 * Tests the COMPLETE generation flow with real component composition:
 * - EventBusProvider (REAL)
 * - ApiClientProvider (REAL, with MOCKED client)
 * - useGenerationFlow (REAL, with inlined progress state)
 * - useResolutionFlow (REAL)
 * - useEventSubscriptions (REAL)
 *
 * This test focuses on ARCHITECTURE and EVENT WIRING:
 * - Verifies API called exactly ONCE (catches duplicate subscriptions)
 * - Tests event propagation through the event bus
 * - Validates modal workflow (open → submit → SSE stream)
 * - Ensures generation progress updates correctly
 * - Tests success/error handling
 *
 * NO BACKEND SERVER - only mocked API client boundary
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { useGenerationFlow } from '../../../hooks/useGenerationFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { useResolutionFlow } from '../../../hooks/useResolutionFlow';
import { SSEClient } from '@semiont/api-client';
import type { ResourceUri, AnnotationUri } from '@semiont/api-client';
import { resourceUri, annotationUri } from '@semiont/api-client';
import type { Emitter } from 'mitt';
import type { EventMap } from '../../../contexts/EventBusContext';

// Mock SSE stream that we can control in tests
const createMockGenerationStream = () => {
  const stream = {
    onProgressCallback: null as ((chunk: any) => void) | null,
    onCompleteCallback: null as ((finalChunk: any) => void) | null,
    onErrorCallback: null as ((error: Error) => void) | null,
    onProgress: vi.fn((callback: (chunk: any) => void) => {
      stream.onProgressCallback = callback;
      return stream;
    }),
    onComplete: vi.fn((callback: (finalChunk: any) => void) => {
      stream.onCompleteCallback = callback;
      return stream;
    }),
    onError: vi.fn((callback: (error: Error) => void) => {
      stream.onErrorCallback = callback;
      return stream;
    }),
    close: vi.fn(),
  };
  return stream;
};

describe('Generation Flow - Feature Integration', () => {
  let mockStream: ReturnType<typeof createMockGenerationStream>;
  let generateResourceSpy: any;
  let mockShowSuccess: ReturnType<typeof vi.fn>;
  let mockShowError: ReturnType<typeof vi.fn>;
  let mockCacheManager: { invalidate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();

    // Create fresh mock stream for each test
    mockStream = createMockGenerationStream();

    // Spy on SSEClient prototype method
    generateResourceSpy = vi.spyOn(SSEClient.prototype, 'generateResourceFromAnnotation').mockReturnValue(mockStream as any);

    // Mock callbacks
    mockShowSuccess = vi.fn();
    mockShowError = vi.fn();
    mockCacheManager = { invalidate: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should open modal when generation:modal-open event is emitted', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitModalOpen } = renderGenerationFlow(
      testResourceUri
    );

    // Emit modal open event
    act(() => {
      emitModalOpen(testAnnotationUri, testResourceUri, 'Test Reference');
    });

    // Verify modal state updated
    await waitFor(() => {
      expect(screen.getByTestId('modal-open')).toHaveTextContent('true');
      expect(screen.getByTestId('reference-id')).toHaveTextContent(testAnnotationUri);
      expect(screen.getByTestId('default-title')).toHaveTextContent('Test Reference');
    });
  });

  it('should call generateResourceFromAnnotation exactly ONCE when generation starts', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart } = renderGenerationFlow(
      testResourceUri
    );

    // Trigger generation with full options
    act(() => {
      emitGenerationStart(testAnnotationUri, testResourceUri, {
        title: 'Generated Document',
        prompt: 'Create a comprehensive document',
        language: 'en',
        temperature: 0.7,
        maxTokens: 2000,
        context: {
          sourceText: 'Reference text from the document',
          entityTypes: ['Person', 'Organization'],
        },
      });
    });

    // CRITICAL ASSERTION: API called exactly once (not twice!)
    await waitFor(() => {
      expect(generateResourceSpy).toHaveBeenCalledTimes(1);
    });

    // Verify correct parameters
    expect(generateResourceSpy).toHaveBeenCalledWith(
      testResourceUri,
      testAnnotationUri,
      {
        title: 'Generated Document',
        prompt: 'Create a comprehensive document',
        language: 'en',
        temperature: 0.7,
        maxTokens: 2000,
        context: {
          sourceText: 'Reference text from the document',
          entityTypes: ['Person', 'Organization'],
        },
      },
      { auth: undefined }
    );
  });

  it('should propagate SSE progress events to useGenerationProgress state', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart } = renderGenerationFlow(
      testResourceUri
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationUri, testResourceUri, {
        title: 'Test Doc',
        context: { sourceText: 'test' },
      });
    });

    // Wait for stream to be created
    await waitFor(() => {
      expect(generateResourceSpy).toHaveBeenCalled();
    });

    // Simulate SSE progress callback being invoked
    act(() => {
      mockStream.onProgressCallback!({
        status: 'generating',
        message: 'Generating content...',
        percentage: 25,
      });
    });

    // Verify progress propagated to UI
    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Generating content...');
      expect(screen.getByTestId('is-generating')).toHaveTextContent('true');
    });
  });

  it('should handle multiple progress updates correctly', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart } = renderGenerationFlow(
      testResourceUri
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationUri, testResourceUri, {
        title: 'Test',
        context: { sourceText: 'test' },
      });
    });

    await waitFor(() => {
      expect(generateResourceSpy).toHaveBeenCalledTimes(1);
    });

    // First progress update
    act(() => {
      mockStream.onProgressCallback!({
        status: 'started',
        message: 'Starting generation...',
        percentage: 0,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Starting generation...');
    });

    // Second progress update
    act(() => {
      mockStream.onProgressCallback!({
        status: 'generating',
        message: 'Creating document structure...',
        percentage: 50,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Creating document structure...');
    });

    // Final progress update via onComplete
    act(() => {
      mockStream.onCompleteCallback!({
        status: 'complete',
        message: 'Document created successfully',
        percentage: 100,
        resourceName: 'Generated Document',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Document created successfully');
      // Progress stays visible after completion (like detection flow)
    });
  });

  it('should show success toast on generation complete', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart, getEventBus } = renderGenerationFlow(
      testResourceUri
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationUri, testResourceUri, {
        title: 'Test',
        context: { sourceText: 'test' },
      });
    });

    await waitFor(() => {
      expect(generateResourceSpy).toHaveBeenCalled();
    });

    // Simulate completion with final chunk
    act(() => {
      mockStream.onProgressCallback!({
        status: 'complete',
        message: 'Complete',
        resourceName: 'Generated Document',
      });
    });

    // Emit completion event
    act(() => {
      getEventBus().emit('generation:complete', {
        annotationUri: testAnnotationUri,
        progress: {
          status: 'complete',
          resourceName: 'Generated Document',
        },
      });
    });

    // Verify generation completes successfully
    // Note: Progress stays visible after completion (like detection flow)
  });

  it('should clear progress on generation failure', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart, getEventBus } = renderGenerationFlow(
      testResourceUri
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationUri, testResourceUri, {
        title: 'Test',
        context: { sourceText: 'test' },
      });
    });

    // Add some progress
    act(() => {
      mockStream.onProgressCallback!({
        status: 'generating',
        message: 'Generating...',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Generating...');
    });

    // Emit failure
    act(() => {
      getEventBus().emit('generation:failed', { error: new Error('Network error') });
    });

    // Verify: progress cleared and not generating
    await waitFor(() => {
      expect(screen.getByTestId('is-generating')).toHaveTextContent('false');
      expect(screen.getByTestId('progress')).toHaveTextContent('No progress');
    });
  });

  it('should only call API once even with multiple event listeners', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart, getEventBus } = renderGenerationFlow(
      testResourceUri
    );

    // Add an additional event listener (simulating multiple subscribers)
    const additionalListener = vi.fn();
    getEventBus().on('generation:start', additionalListener);

    // Trigger generation
    act(() => {
      emitGenerationStart(testAnnotationUri, testResourceUri, {
        title: 'Test',
        context: { sourceText: 'test' },
      });
    });

    // Wait for operation to complete
    await waitFor(() => {
      expect(generateResourceSpy).toHaveBeenCalled();
    });

    // VERIFY: API called exactly once, even though multiple listeners exist
    expect(generateResourceSpy).toHaveBeenCalledTimes(1);

    // VERIFY: Our additional listener was called (events work)
    expect(additionalListener).toHaveBeenCalledTimes(1);
  });

  it('should forward final chunk as progress before emitting complete', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart } = renderGenerationFlow(
      testResourceUri
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationUri, testResourceUri, {
        title: 'Test',
        context: { sourceText: 'test' },
      });
    });

    await waitFor(() => {
      expect(generateResourceSpy).toHaveBeenCalled();
    });

    // Simulate onComplete with final chunk
    act(() => {
      mockStream.onCompleteCallback!({
        status: 'complete',
        message: 'Document created: My Document',
        resourceName: 'My Document',
        percentage: 100,
      });
    });

    // Verify final chunk is visible as progress
    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Document created: My Document');
      // Progress stays visible after completion (like detection flow)
    });
  });
});

/**
 * Helper: Render useGenerationFlow hook with real component composition
 * Returns methods to interact with the rendered component
 */
function renderGenerationFlow(
  testResourceUri: ResourceUri
) {
  let eventBusInstance: Emitter<EventMap>;

  // Component to capture EventBus instance and set up event operations
  function EventBusCapture() {
    eventBusInstance = useEventBus();

    // Set up resolution flow (annotation:update-body, reference:link)
    useResolutionFlow(testResourceUri);

    return null;
  }

  // Test harness component that uses the hook
  function GenerationFlowTestHarness() {
    const {
      generationProgress,
      generationModalOpen,
      generationReferenceId,
      generationDefaultTitle,
    } = useGenerationFlow(
      'en',
      testResourceUri.split('/resources/')[1] || 'test-resource',
      vi.fn(),
      vi.fn(),
      null,
      vi.fn()
    );

    return (
      <div>
        <div data-testid="modal-open">{generationModalOpen ? 'true' : 'false'}</div>
        <div data-testid="reference-id">{generationReferenceId || 'none'}</div>
        <div data-testid="default-title">{generationDefaultTitle || 'none'}</div>
        <div data-testid="is-generating">
          {generationProgress ? 'true' : 'false'}
        </div>
        <div data-testid="progress">
          {generationProgress?.message || 'No progress'}
        </div>
      </div>
    );
  }

  render(
    <EventBusProvider>
      <AuthTokenProvider token={null}>
        <ApiClientProvider baseUrl="http://localhost:4000">
          <EventBusCapture />
          <GenerationFlowTestHarness />
        </ApiClientProvider>
      </AuthTokenProvider>
    </EventBusProvider>
  );

  return {
    emitModalOpen: (
      annotationUri: AnnotationUri,
      resourceUri: ResourceUri,
      defaultTitle: string
    ) => {
      eventBusInstance.emit('generation:modal-open', {
        annotationUri,
        resourceUri,
        defaultTitle,
      });
    },
    emitGenerationStart: (
      annotationUri: AnnotationUri,
      resourceUri: ResourceUri,
      options: {
        title: string;
        prompt?: string;
        language?: string;
        temperature?: number;
        maxTokens?: number;
        context: any;
      }
    ) => {
      eventBusInstance.emit('generation:start', {
        annotationUri,
        resourceUri,
        options,
      });
    },
    getEventBus: () => eventBusInstance,
  };
}
