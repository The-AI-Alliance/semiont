/**
 * useGenerationProgress Hook Tests
 *
 * Tests the SSE event handling for real-time resource generation progress updates.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGenerationProgress } from '../useGenerationProgress';
import { annotationUri, resourceUri } from '@semiont/api-client';
import type { GenerationProgress } from '@semiont/api-client';

// Create a mock SSE stream
const createMockSSEStream = () => {
  const stream = {
    onProgressCallback: null as ((progress: GenerationProgress) => void) | null,
    onCompleteCallback: null as ((result: GenerationProgress) => void) | null,
    onErrorCallback: null as ((error: Error) => void) | null,
    onProgress: vi.fn((callback: (progress: GenerationProgress) => void) => {
      stream.onProgressCallback = callback;
    }),
    onComplete: vi.fn((callback: (result: GenerationProgress) => void) => {
      stream.onCompleteCallback = callback;
    }),
    onError: vi.fn((callback: (error: Error) => void) => {
      stream.onErrorCallback = callback;
    }),
    close: vi.fn(),
  };
  return stream;
};

// Mock api-client hook
const mockGenerateResource = vi.fn();
const mockApiClient = {
  sse: {
    generateResource: mockGenerateResource,
  },
};

vi.mock('@/lib/api-hooks', () => ({
  useApiClient: () => mockApiClient,
}));

// Mock environment
vi.mock('@/lib/env', () => ({
  NEXT_PUBLIC_API_URL: 'http://localhost:4000'
}));

describe('useGenerationProgress', () => {
  let mockStream: ReturnType<typeof createMockSSEStream>;

  beforeEach(() => {
    mockStream = createMockSSEStream();
    mockGenerateResource.mockReturnValue(mockStream);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(typeof result.current.startGeneration).toBe('function');
    expect(typeof result.current.cancelGeneration).toBe('function');
    expect(typeof result.current.clearProgress).toBe('function');
  });

  it('should call api-client with correct parameters', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource'),
      {
        title: 'Test Resource',
        prompt: 'Create a resource about testing',
        language: 'en'
      }
    );

    expect(mockGenerateResource).toHaveBeenCalledWith(
      resourceUri('http://localhost:4000/resources/test-resource'),
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      {
        title: 'Test Resource',
        prompt: 'Create a resource about testing',
        language: 'en'
      }
    );
  });

  it('should set isGenerating to true when generation starts', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
    });
  });

  it('should handle generation-started event', async () => {
    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onProgress })
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );

    const progressData: GenerationProgress = {
      status: 'started',
      referenceId: 'test-ref-id',
      percentage: 0,
      message: 'Starting...'
    };

    mockStream.onProgressCallback!(progressData);

    await waitFor(() => {
      expect(onProgress).toHaveBeenCalled();
    });

    expect(result.current.progress).toMatchObject({
      status: 'started',
      referenceId: 'test-ref-id',
      percentage: 0
    });
  });

  it('should handle generation-progress events for all stages', async () => {
    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onProgress })
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );

    const stages: GenerationProgress[] = [
      { status: 'started', referenceId: 'test-ref-id', percentage: 0, message: 'Starting...' },
      { status: 'fetching', referenceId: 'test-ref-id', percentage: 25, message: 'Fetching...' },
      { status: 'generating', referenceId: 'test-ref-id', percentage: 50, message: 'Generating...' },
      { status: 'creating', referenceId: 'test-ref-id', percentage: 75, message: 'Creating...' },
    ];

    for (const stage of stages) {
      mockStream.onProgressCallback!(stage);
      await waitFor(() => {
        expect(result.current.progress?.status).toBe(stage.status);
      });
    }

    expect(onProgress).toHaveBeenCalledTimes(4);
  });

  it('should handle generation-complete event', async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onComplete })
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );

    const completeData: GenerationProgress = {
      status: 'complete',
      referenceId: 'test-ref-id',
      resourceId: 'new-resource-123',
      percentage: 100,
      message: 'Complete!'
    };

    mockStream.onCompleteCallback!(completeData);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });

    expect(result.current.isGenerating).toBe(false);
  });

  it('should handle generation-error event', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onError })
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );

    const error = new Error('Generation failed');
    mockStream.onErrorCallback!(error);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Generation failed');
    });

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('should cancel generation and close SSE stream', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );
    result.current.cancelGeneration();

    expect(mockStream.close).toHaveBeenCalled();
    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('should clear progress manually', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    // Start generation to set up the stream
    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );

    // Set progress first
    mockStream.onProgressCallback!({
      status: 'started',
      referenceId: 'test-ref-id',
      percentage: 0,
      message: 'Starting...'
    });

    await waitFor(() => {
      expect(result.current.progress).not.toBeNull();
    });

    // Clear it
    result.current.clearProgress();

    await waitFor(() => {
      expect(result.current.progress).toBeNull();
    });
  });

  // Note: Authentication testing is handled by useApiClient hook tests
  // The hook relies on useApiClient returning null when not authenticated

  it('should handle SSE connection errors', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onError })
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );

    const error = new Error('Connection lost');
    mockStream.onErrorCallback!(error);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Connection lost');
    });

    expect(result.current.isGenerating).toBe(false);
  });

  it('should cleanup on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useGenerationProgress({})
    );

    result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );
    unmount();

    expect(mockStream.close).toHaveBeenCalled();
  });

  it('should pass language option to API', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource'),
      { language: 'es' }
    );

    expect(mockGenerateResource).toHaveBeenCalledWith(
      resourceUri('http://localhost:4000/resources/test-resource'),
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      { language: 'es' }
    );
  });

  it('should close existing stream before starting new generation', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    // Start first generation
    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-1'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );

    const firstStream = mockStream;

    // Create new stream for second generation
    mockStream = createMockSSEStream();
    mockGenerateResource.mockReturnValue(mockStream);

    // Start second generation
    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-2'),
      resourceUri('http://localhost:4000/resources/test-resource')
    );

    // First stream should be closed
    expect(firstStream.close).toHaveBeenCalled();
  });
});
