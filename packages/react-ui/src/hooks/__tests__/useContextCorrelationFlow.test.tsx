/**
 * Tests for useContextCorrelationFlow hook
 *
 * Validates the context correlation capability:
 * - Event subscription to correlate:requested
 * - API calls with correct parameters
 * - Success/failure event emission
 * - URI extraction and tracking
 * - State management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { EventBus, resourceUri, type GenerationContext } from '@semiont/core';
import { SemiontApiClient } from '@semiont/api-client';
import { useContextCorrelationFlow } from '../useContextCorrelationFlow';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';


describe('useContextCorrelationFlow', () => {
  let eventBus: EventBus;
  let mockClient: vi.Mocked<SemiontApiClient>;
  const testToken = 'test-token-123';
  const testResourceUri = resourceUri('http://example.com/resources/resource-123');
  const testAnnotationUri = 'http://example.com/annotations/anno-456';
  const testAnnotationId = 'anno-456';

  const mockContext: GenerationContext = {
    beforeText: 'This is text before the selection.',
    selectedText: 'Selected entity reference',
    afterText: 'This is text after the selection.',
  };

  beforeEach(() => {
    eventBus = new EventBus();
    mockClient = {
      getAnnotationLLMContext: vi.fn(),
    } as unknown as vi.Mocked<SemiontApiClient>;

    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  afterEach(() => {
    eventBus.destroy();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AuthTokenProvider token={testToken}>{children}</AuthTokenProvider>
  );

  it('subscribes to correlate:requested event', () => {
    const { result } = renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Initial state
    expect(result.current.correlationLoading).toBe(false);
    expect(result.current.correlationContext).toBe(null);
    expect(result.current.correlationError).toBe(null);
    expect(result.current.correlationAnnotationUri).toBe(null);

    // Verify subscription exists by checking if event can be triggered
    const correlateRequestedChannel = eventBus.get('correlate:requested');
    expect(correlateRequestedChannel).toBeDefined();
  });

  it('fetches context from API with correct parameters', async () => {
    mockClient.getAnnotationLLMContext.mockResolvedValue({
      context: mockContext,
    });

    renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Trigger correlate:requested event
    eventBus.get('correlate:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    await waitFor(() => {
      expect(mockClient.getAnnotationLLMContext).toHaveBeenCalledWith(
        testResourceUri,
        testAnnotationId,
        expect.objectContaining({
          contextWindow: 2000,
          auth: testToken, // accessToken returns branded string, not object
        })
      );
    });
  });

  it('emits correlate:complete on success', async () => {
    mockClient.getAnnotationLLMContext.mockResolvedValue({
      context: mockContext,
    });

    renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Subscribe to correlate:complete event
    const completeSpy = vi.fn();
    eventBus.get('correlate:complete').subscribe(completeSpy);

    // Trigger correlate:requested
    eventBus.get('correlate:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    await waitFor(() => {
      expect(completeSpy).toHaveBeenCalledWith({
        annotationUri: testAnnotationUri,
        context: mockContext,
      });
    });
  });

  it('emits correlate:failed on error', async () => {
    const testError = new Error('API request failed');
    mockClient.getAnnotationLLMContext.mockRejectedValue(testError);

    renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Subscribe to correlate:failed event
    const failedSpy = vi.fn();
    eventBus.get('correlate:failed').subscribe(failedSpy);

    // Trigger correlate:requested
    eventBus.get('correlate:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    await waitFor(() => {
      expect(failedSpy).toHaveBeenCalledWith({
        annotationUri: testAnnotationUri,
        error: testError,
      });
    });
  });

  it('handles URI extraction correctly', async () => {
    mockClient.getAnnotationLLMContext.mockResolvedValue({
      context: mockContext,
    });

    renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Test with full URI
    eventBus.get('correlate:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    await waitFor(() => {
      expect(mockClient.getAnnotationLLMContext).toHaveBeenCalledWith(
        testResourceUri,
        testAnnotationId, // Extracted from URI
        expect.any(Object)
      );
    });
  });

  it('clears previous state on new request', async () => {
    // Use a deferred promise to control when the API resolves
    let resolveSecondRequest: ((value: any) => void) | null = null;
    const secondRequestPromise = new Promise((resolve) => {
      resolveSecondRequest = resolve;
    });

    // First request resolves immediately
    mockClient.getAnnotationLLMContext.mockResolvedValueOnce({
      context: mockContext,
    });

    const { result } = renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // First request
    act(() => {
      eventBus.get('correlate:requested').next({
        annotationUri: testAnnotationUri,
        resourceUri: testResourceUri,
      });
    });

    await waitFor(() => {
      expect(result.current.correlationContext).toEqual(mockContext);
    });

    // Second request - use deferred promise so we can check state before it completes
    mockClient.getAnnotationLLMContext.mockReturnValueOnce(secondRequestPromise as any);

    const newAnnotationUri = 'http://example.com/annotations/anno-789';

    act(() => {
      eventBus.get('correlate:requested').next({
        annotationUri: newAnnotationUri,
        resourceUri: testResourceUri,
      });
    });

    // Wait for state to be cleared (should happen immediately in event handler)
    await waitFor(() => {
      expect(result.current.correlationContext).toBe(null);
      expect(result.current.correlationError).toBe(null);
      expect(result.current.correlationLoading).toBe(true);
    });

    // Now resolve the second request
    act(() => {
      resolveSecondRequest!({ context: mockContext });
    });

    // Wait for new context to load
    await waitFor(() => {
      expect(result.current.correlationContext).toEqual(mockContext);
    });
  });

  it('stores annotation URI for tracking', async () => {
    mockClient.getAnnotationLLMContext.mockResolvedValue({
      context: mockContext,
    });

    const { result } = renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Initial state - no annotation URI
    expect(result.current.correlationAnnotationUri).toBe(null);

    // Trigger correlation
    eventBus.get('correlate:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    // Annotation URI should be stored immediately
    await waitFor(() => {
      expect(result.current.correlationAnnotationUri).toBe(testAnnotationUri);
    });

    // Annotation URI should persist after completion
    await waitFor(() => {
      expect(result.current.correlationContext).toEqual(mockContext);
      expect(result.current.correlationAnnotationUri).toBe(testAnnotationUri);
    });
  });

  it('updates loading state correctly during request lifecycle', async () => {
    let resolvePromise: (value: any) => void;
    const delayedPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    mockClient.getAnnotationLLMContext.mockReturnValue(delayedPromise as any);

    const { result } = renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Initial state - not loading
    expect(result.current.correlationLoading).toBe(false);

    // Trigger correlation
    eventBus.get('correlate:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    // Should be loading
    await waitFor(() => {
      expect(result.current.correlationLoading).toBe(true);
    });

    // Resolve the API call
    resolvePromise!({ context: mockContext });

    // Should stop loading
    await waitFor(() => {
      expect(result.current.correlationLoading).toBe(false);
    });
  });

  it('handles error state correctly', async () => {
    const testError = new Error('Network error');
    mockClient.getAnnotationLLMContext.mockRejectedValue(testError);

    const { result } = renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Trigger correlation
    eventBus.get('correlate:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    // Wait for error to be set
    await waitFor(() => {
      expect(result.current.correlationError).toEqual(testError);
      expect(result.current.correlationLoading).toBe(false);
      expect(result.current.correlationContext).toBe(null);
    });
  });

  it('handles null context response', async () => {
    mockClient.getAnnotationLLMContext.mockResolvedValue({
      context: null,
    });

    const { result } = renderHook(
      () => useContextCorrelationFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Subscribe to events
    const completeSpy = vi.fn();
    eventBus.get('correlate:complete').subscribe(completeSpy);

    // Trigger correlation
    eventBus.get('correlate:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    await waitFor(() => {
      expect(result.current.correlationContext).toBe(null);
      expect(result.current.correlationLoading).toBe(false);
    });

    // Should NOT emit correlate:complete when context is null
    expect(completeSpy).not.toHaveBeenCalled();
  });
});
