/**
 * useGenerationProgress Hook Tests
 *
 * Tests the SSE event handling for real-time resource generation progress updates.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGenerationProgress } from '../useGenerationProgress';
import { annotationUri, resourceUri } from '@semiont/api-client';
import type { GenerationProgress, GenerationContext } from '@semiont/api-client';

// Mock GenerationContext for tests
const mockGenerationContext: GenerationContext = {
  sourceContext: {
    before: 'Text before',
    selected: 'selected text',
    after: 'text after'
  },
  metadata: {
    resourceType: 'document',
    language: 'en',
    entityTypes: ['test']
  }
};

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
const mockGenerateResourceFromAnnotation = vi.fn();
const mockApiClient = {
  sse: {
    generateResourceFromAnnotation: mockGenerateResourceFromAnnotation,
  },
};

vi.mock('../../contexts/ApiClientContext', () => ({
  useApiClient: () => mockApiClient,
}));

// Mock environment
vi.mock('@/lib/env', () => ({
  SERVER_API_URL: 'http://localhost:4000'
}));

describe('useGenerationProgress', () => {
  let mockStream: ReturnType<typeof createMockSSEStream>;

  beforeEach(() => {
    mockStream = createMockSSEStream();
    mockGenerateResourceFromAnnotation.mockReturnValue(mockStream);
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
        language: 'en',
        context: mockGenerationContext
      }
    );

    expect(mockGenerateResourceFromAnnotation).toHaveBeenCalledWith(
      resourceUri('http://localhost:4000/resources/test-resource'),
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      {
        title: 'Test Resource',
        prompt: 'Create a resource about testing',
        language: 'en',
        context: mockGenerationContext
      }
    );
  });

  it('should set isGenerating to true when generation starts', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource'),
      { context: mockGenerationContext }
    );

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
    });
  });

  it('should handle generation-started event', async () => {
    const onProgressMock = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onProgress: onProgressMock })
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource'),
      { context: mockGenerationContext }
    );

    // Simulate generation-started event
    const mockProgressData: GenerationProgress = {
      status: 'started',
      referenceId: 'test-ref-id',
      percentage: 0,
      message: 'Starting generation...'
    };

    mockStream.onProgressCallback?.(mockProgressData);

    await waitFor(() => {
      expect(result.current.progress).toEqual(mockProgressData);
      expect(onProgressMock).toHaveBeenCalledWith(mockProgressData);
    });
  });

  it('should handle generation-progress event', async () => {
    const onProgressMock = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onProgress: onProgressMock })
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource'),
      { context: mockGenerationContext }
    );

    // Simulate generation-progress event
    const mockProgressData: GenerationProgress = {
      status: 'generating',
      referenceId: 'test-ref-id',
      percentage: 50,
      message: 'Generating content...'
    };

    mockStream.onProgressCallback?.(mockProgressData);

    await waitFor(() => {
      expect(result.current.progress).toEqual(mockProgressData);
      expect(onProgressMock).toHaveBeenCalledWith(mockProgressData);
    });
  });

  it('should handle generation-complete event', async () => {
    const onCompleteMock = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onComplete: onCompleteMock })
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource'),
      { context: mockGenerationContext }
    );

    // Simulate generation-complete event
    const mockCompleteData: GenerationProgress = {
      status: 'complete',
      referenceId: 'test-ref-id',
      resourceId: 'new-resource-id',
      percentage: 100,
      message: 'Generation complete!'
    };

    mockStream.onCompleteCallback?.(mockCompleteData);

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(onCompleteMock).toHaveBeenCalledWith(mockCompleteData);
    });
  });

  it('should handle generation-error event', async () => {
    const onErrorMock = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onError: onErrorMock })
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource'),
      { context: mockGenerationContext }
    );

    // Simulate generation-error event
    const mockError = new Error('Generation failed');
    mockStream.onErrorCallback?.(mockError);

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(false);
      expect(onErrorMock).toHaveBeenCalledWith('Generation failed');
    });
  });

  it('should cancel generation', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource'),
      { context: mockGenerationContext }
    );

    result.current.cancelGeneration();

    expect(mockStream.close).toHaveBeenCalled();
    expect(result.current.isGenerating).toBe(false);
  });

  it('should clear progress', () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    result.current.clearProgress();

    expect(result.current.progress).toBeNull();
    expect(result.current.isGenerating).toBe(false);
  });

  it('should pass language option to api-client', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      resourceUri('http://localhost:4000/resources/test-resource'),
      {
        language: 'es',
        context: mockGenerationContext
      }
    );

    expect(mockGenerateResourceFromAnnotation).toHaveBeenCalledWith(
      resourceUri('http://localhost:4000/resources/test-resource'),
      annotationUri('http://localhost:4000/annotations/test-ref-id'),
      { language: 'es', context: mockGenerationContext }
    );
  });

  it('should close existing stream when starting new generation', async () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id-1'),
      resourceUri('http://localhost:4000/resources/test-resource-1'),
      { context: mockGenerationContext }
    );

    await result.current.startGeneration(
      annotationUri('http://localhost:4000/annotations/test-ref-id-2'),
      resourceUri('http://localhost:4000/resources/test-resource-2'),
      { context: mockGenerationContext }
    );

    expect(mockStream.close).toHaveBeenCalled();
  });

  it('should not crash if cancelGeneration called when not generating', () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    expect(() => result.current.cancelGeneration()).not.toThrow();
  });
});
