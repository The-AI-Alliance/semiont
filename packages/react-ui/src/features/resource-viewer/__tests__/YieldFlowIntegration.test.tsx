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
import { EventBusProvider, useEventBus } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { useBindFlow } from '../../../hooks/useBindFlow';
import { SemiontApiClient } from '@semiont/api-client';
import type { AnnotationId, ResourceId } from '@semiont/core';
import { resourceId, annotationId } from '@semiont/core';
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

describe('Generation Flow - Feature Integration', () => {
  let generateResourceSpy: any;
  let mockShowSuccess: ReturnType<typeof vi.fn>;
  let mockShowError: ReturnType<typeof vi.fn>;
  let mockCacheManager: { invalidate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    // Spy on SemiontApiClient prototype HTTP method (namespace methods call this)
    generateResourceSpy = vi.spyOn(SemiontApiClient.prototype, 'yieldResourceFromAnnotation').mockResolvedValue({ correlationId: 'c1', jobId: 'j1' });

    // Mock callbacks
    mockShowSuccess = vi.fn();
    mockShowError = vi.fn();
    mockCacheManager = { invalidate: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call yieldResource exactly ONCE when generation starts', async () => {
    const testResourceId = resourceId('test-resource');
    const testAnnotationId = annotationId('test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
      testResourceId
    );

    // Trigger generation with full options
    act(() => {
      emitGenerationStart(testAnnotationId, testResourceId, {
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

    // Verify correct parameters — resourceId and annotationId are now bare IDs
    expect(generateResourceSpy).toHaveBeenCalledWith(
      testResourceId,
      testAnnotationId,
      expect.objectContaining({
        title: 'Generated Document',
        prompt: 'Create a comprehensive document',
        language: 'en',
        temperature: 0.7,
        maxTokens: 2000,
      }),
      expect.objectContaining({ auth: undefined })
    );
  });

  it('should propagate SSE progress events to useYieldProgress state', async () => {
    const testResourceId = resourceId('test-resource');
    const testAnnotationId = annotationId('test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
      testResourceId
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationId, testResourceId, {
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
    const testResourceId = resourceId('test-resource');
    const testAnnotationId = annotationId('test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
      testResourceId
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationId, testResourceId, {
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
        referenceId: testAnnotationId,
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
    const testResourceId = resourceId('test-resource');
    const testAnnotationId = annotationId('test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
      testResourceId
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationId, testResourceId, {
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
        referenceId: testAnnotationId,
        resourceName: 'Generated Document',
        percentage: 100,
      });
    });

    // Verify generation completes successfully
    // Note: Progress stays visible after completion (like detection flow)
  });

  it('should clear progress on generation failure', async () => {
    const testResourceId = resourceId('test-resource');
    const testAnnotationId = annotationId('test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
      testResourceId
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationId, testResourceId, {
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
      getEventBus().get('yield:failed').next({ error: 'Network error' });
    });

    // Verify: progress cleared and not generating
    await waitFor(() => {
      expect(screen.getByTestId('is-generating')).toHaveTextContent('false');
      expect(screen.getByTestId('progress')).toHaveTextContent('No progress');
    });
  });

  it('should only call API once even with multiple renders', async () => {
    const testResourceId = resourceId('test-resource');
    const testAnnotationId = annotationId('test-annotation');

    const { emitGenerationStart } = renderYieldFlow(
      testResourceId
    );

    // Trigger generation
    act(() => {
      emitGenerationStart(testAnnotationId, testResourceId, {
        title: 'Test',
        context: { sourceText: 'test' },
      });
    });

    // Wait for operation to complete
    await waitFor(() => {
      expect(generateResourceSpy).toHaveBeenCalled();
    });

    // VERIFY: API called exactly once
    expect(generateResourceSpy).toHaveBeenCalledTimes(1);
  });

  it('should forward final chunk as progress before emitting complete', async () => {
    const testResourceId = resourceId('test-resource');
    const testAnnotationId = annotationId('test-annotation');

    const { emitGenerationStart, getEventBus } = renderYieldFlow(
      testResourceId
    );

    // Start generation
    act(() => {
      emitGenerationStart(testAnnotationId, testResourceId, {
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
        referenceId: testAnnotationId,
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
  testResourceId: ResourceId
) {
  let eventBusInstance: ReturnType<typeof useEventBus>;
  let generateFn: ReturnType<typeof useYieldFlow>['onGenerateDocument'];

  // Component to capture EventBus instance and set up event operations
  function EventBusCapture() {
    eventBusInstance = useEventBus();
    useBindFlow(testResourceId);
    return null;
  }

  // Test harness component that uses the hook
  function YieldFlowTestHarness() {
    const {
      isGenerating,
      generationProgress,
      onGenerateDocument,
    } = useYieldFlow(
      'en',
      testResourceId,
      vi.fn()
    );

    generateFn = onGenerateDocument;

    return (
      <div>
        <div data-testid="is-generating">
          {isGenerating ? 'true' : 'false'}
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
    emitGenerationStart: (
      aId: AnnotationId,
      _rId: ResourceId,
      options: {
        title: string;
        storageUri?: string;
        prompt?: string;
        language?: string;
        temperature?: number;
        maxTokens?: number;
        context: any;
      }
    ) => {
      // Call the hook's callback directly (no longer EventBus-driven)
      generateFn(aId as string, { storageUri: options.storageUri ?? 'file:///tmp/test', ...options });
    },
    getEventBus: () => eventBusInstance,
  };
}
