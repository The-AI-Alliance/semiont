/**
 * Tests for useContextGatherFlow hook
 *
 * Validates the gather capability:
 * - Event subscription to gather:requested
 * - API calls with correct parameters
 * - Success/failure event emission
 * - URI extraction and tracking
 * - State management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { EventBus, resourceUri, type YieldContext } from '@semiont/core';
import { SemiontApiClient } from '@semiont/api-client';
import { useContextGatherFlow } from '../useContextGatherFlow';
import { AuthTokenProvider } from '../../contexts/AuthTokenContext';


describe('useContextGatherFlow', () => {
  let eventBus: EventBus;
  let mockClient: vi.Mocked<SemiontApiClient>;
  const testToken = 'test-token-123';
  const testResourceUri = resourceUri('http://example.com/resources/resource-123');
  const testAnnotationUri = 'http://example.com/annotations/anno-456';
  const testAnnotationId = 'anno-456';

  const mockContext: YieldContext = {
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

  it('subscribes to gather:requested event', () => {
    const { result } = renderHook(
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Initial state
    expect(result.current.gatherLoading).toBe(false);
    expect(result.current.gatherContext).toBe(null);
    expect(result.current.gatherError).toBe(null);
    expect(result.current.gatherAnnotationUri).toBe(null);

    // Verify subscription exists by checking if event can be triggered
    const gatherRequestedChannel = eventBus.get('gather:requested');
    expect(gatherRequestedChannel).toBeDefined();
  });

  it('fetches context from API with correct parameters', async () => {
    mockClient.getAnnotationLLMContext.mockResolvedValue({
      context: mockContext,
    });

    renderHook(
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Trigger gather:requested event
    eventBus.get('gather:requested').next({
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

  it('emits gather:complete on success', async () => {
    mockClient.getAnnotationLLMContext.mockResolvedValue({
      context: mockContext,
    });

    renderHook(
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Subscribe to gather:complete event
    const completeSpy = vi.fn();
    eventBus.get('gather:complete').subscribe(completeSpy);

    // Trigger gather:requested
    eventBus.get('gather:requested').next({
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

  it('emits gather:failed on error', async () => {
    const testError = new Error('API request failed');
    mockClient.getAnnotationLLMContext.mockRejectedValue(testError);

    renderHook(
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Subscribe to gather:failed event
    const failedSpy = vi.fn();
    eventBus.get('gather:failed').subscribe(failedSpy);

    // Trigger gather:requested
    eventBus.get('gather:requested').next({
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
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Test with full URI
    eventBus.get('gather:requested').next({
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
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // First request
    act(() => {
      eventBus.get('gather:requested').next({
        annotationUri: testAnnotationUri,
        resourceUri: testResourceUri,
      });
    });

    await waitFor(() => {
      expect(result.current.gatherContext).toEqual(mockContext);
    });

    // Second request - use deferred promise so we can check state before it completes
    mockClient.getAnnotationLLMContext.mockReturnValueOnce(secondRequestPromise as any);

    const newAnnotationUri = 'http://example.com/annotations/anno-789';

    act(() => {
      eventBus.get('gather:requested').next({
        annotationUri: newAnnotationUri,
        resourceUri: testResourceUri,
      });
    });

    // Wait for state to be cleared (should happen immediately in event handler)
    await waitFor(() => {
      expect(result.current.gatherContext).toBe(null);
      expect(result.current.gatherError).toBe(null);
      expect(result.current.gatherLoading).toBe(true);
    });

    // Now resolve the second request
    act(() => {
      resolveSecondRequest!({ context: mockContext });
    });

    // Wait for new context to load
    await waitFor(() => {
      expect(result.current.gatherContext).toEqual(mockContext);
    });
  });

  it('stores annotation URI for tracking', async () => {
    mockClient.getAnnotationLLMContext.mockResolvedValue({
      context: mockContext,
    });

    const { result } = renderHook(
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Initial state - no annotation URI
    expect(result.current.gatherAnnotationUri).toBe(null);

    // Trigger gather
    eventBus.get('gather:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    // Annotation URI should be stored immediately
    await waitFor(() => {
      expect(result.current.gatherAnnotationUri).toBe(testAnnotationUri);
    });

    // Annotation URI should persist after completion
    await waitFor(() => {
      expect(result.current.gatherContext).toEqual(mockContext);
      expect(result.current.gatherAnnotationUri).toBe(testAnnotationUri);
    });
  });

  it('updates loading state correctly during request lifecycle', async () => {
    let resolvePromise: (value: any) => void;
    const delayedPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    mockClient.getAnnotationLLMContext.mockReturnValue(delayedPromise as any);

    const { result } = renderHook(
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Initial state - not loading
    expect(result.current.gatherLoading).toBe(false);

    // Trigger gather
    eventBus.get('gather:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    // Should be loading
    await waitFor(() => {
      expect(result.current.gatherLoading).toBe(true);
    });

    // Resolve the API call
    resolvePromise!({ context: mockContext });

    // Should stop loading
    await waitFor(() => {
      expect(result.current.gatherLoading).toBe(false);
    });
  });

  it('handles error state correctly', async () => {
    const testError = new Error('Network error');
    mockClient.getAnnotationLLMContext.mockRejectedValue(testError);

    const { result } = renderHook(
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Trigger gather
    eventBus.get('gather:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    // Wait for error to be set
    await waitFor(() => {
      expect(result.current.gatherError).toEqual(testError);
      expect(result.current.gatherLoading).toBe(false);
      expect(result.current.gatherContext).toBe(null);
    });
  });

  it('handles null context response', async () => {
    mockClient.getAnnotationLLMContext.mockResolvedValue({
      context: null,
    });

    const { result } = renderHook(
      () => useContextGatherFlow(eventBus, {
        client: mockClient,
        resourceUri: testResourceUri,
      }),
      { wrapper }
    );

    // Subscribe to events
    const completeSpy = vi.fn();
    eventBus.get('gather:complete').subscribe(completeSpy);

    // Trigger gather
    eventBus.get('gather:requested').next({
      annotationUri: testAnnotationUri,
      resourceUri: testResourceUri,
    });

    await waitFor(() => {
      expect(result.current.gatherContext).toBe(null);
      expect(result.current.gatherLoading).toBe(false);
    });

    // Should NOT emit gather:complete when context is null
    expect(completeSpy).not.toHaveBeenCalled();
  });
});
