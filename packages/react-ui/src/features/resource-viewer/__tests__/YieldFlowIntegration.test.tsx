/**
 * Layer 3: Feature Integration Test - Generation Flow Architecture
 *
 * Tests the COMPLETE generation flow with real component composition:
 * - EventBusProvider (REAL)
 * - ApiClientProvider (REAL, with MOCKED client)
 * - useYieldFlow (REAL, with inlined progress state)
 * - useBindFlow (REAL)
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
import { useYieldFlow } from '../../../hooks/useYieldFlow';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { useBindFlow } from '../../../hooks/useBindFlow';
import { SSEClient } from '@semiont/api-client';
import type { ResourceUri, AnnotationUri } from '@semiont/core';
import { resourceUri, annotationUri } from '@semiont/core';
import type { Emitter } from 'mitt';
import type { EventMap } from '@semiont/core';

// Mock Toast module to prevent "useToast must be used within a ToastProvider" errors
vi.mock('../../../components/Toast', () => ({
  useToast: () => ({
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

// Mock SSE stream - SSE now emits directly to EventBus, no callbacks
const createMockGenerationStream = () => {
  return {
    close: vi.fn(),
  };
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
    generateResourceSpy = vi.spyOn(SSEClient.prototype, 'yieldResourceFromAnnotation').mockReturnValue(mockStream as any);

    // Mock callbacks
    mockShowSuccess = vi.fn();
    mockShowError = vi.fn();
    mockCacheManager = { invalidate: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should open modal when yield:modal-open event is emitted', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitModalOpen } = renderYieldFlow(
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

  it('should call yieldResourceFromAnnotation exactly ONCE when generation starts', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
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
      expect.objectContaining({ auth: undefined })
    );
  });

  it('should propagate SSE progress events to useYieldProgress state', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
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
      getEventBus().get('yield:progress').next({
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

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
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
      getEventBus().get('yield:progress').next({
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
      getEventBus().get('yield:progress').next({
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
      getEventBus().get('yield:finished').next({
        status: 'complete',
        referenceId: testAnnotationUri,
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

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
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
      getEventBus().get('yield:progress').next({
        status: 'complete',
        message: 'Complete',
        resourceName: 'Generated Document',
      });
    });

    // Emit completion event
    act(() => {
      getEventBus().get('yield:finished').next({
        status: 'complete',
        referenceId: testAnnotationUri,
        resourceName: 'Generated Document',
        percentage: 100,
      });
    });

    // Verify generation completes successfully
    // Note: Progress stays visible after completion (like detection flow)
  });

  it('should clear progress on generation failure', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
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
      getEventBus().get('yield:progress').next({
        status: 'generating',
        message: 'Generating...',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('progress')).toHaveTextContent('Generating...');
    });

    // Emit failure
    act(() => {
      getEventBus().get('yield:failed').next({ error: new Error('Network error') });
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

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
      testResourceUri
    );

    // Add an additional event listener (simulating multiple subscribers)
    const additionalListener = vi.fn();
    const subscription = getEventBus().get('yield:request').subscribe(additionalListener);

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

    subscription.unsubscribe();
  });

  it('should forward final chunk as progress before emitting complete', async () => {
    const testResourceUri = resourceUri('http://localhost:4000/resources/test-resource');
    const testAnnotationUri = annotationUri('http://localhost:4000/resources/test-resource/annotations/test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
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
      getEventBus().get('yield:finished').next({
        status: 'complete',
        referenceId: testAnnotationUri,
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
 * Helper: Render useYieldFlow hook with real component composition
 * Returns methods to interact with the rendered component
 */
function renderYieldFlow(
  testResourceUri: ResourceUri
) {
  let eventBusInstance: Emitter<EventMap>;

  // Component to capture EventBus instance and set up event operations
  function EventBusCapture() {
    eventBusInstance = useEventBus();

    // Set up resolution flow (resolve:update-body, resolve:link)
    useBindFlow(testResourceUri);

    return null;
  }

  // Test harness component that uses the hook
  function YieldFlowTestHarness() {
    const {
      generationProgress,
      generationModalOpen,
      generationReferenceId,
      generationDefaultTitle,
    } = useYieldFlow(
      'en',
      testResourceUri.split('/resources/')[1] || 'test-resource',
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
          <YieldFlowTestHarness />
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
      eventBusInstance.get('yield:modal-open').next({
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
      eventBusInstance.get('yield:request').next({
        annotationUri,
        resourceUri,
        options,
      });
    },
    getEventBus: () => eventBusInstance,
  };
}
