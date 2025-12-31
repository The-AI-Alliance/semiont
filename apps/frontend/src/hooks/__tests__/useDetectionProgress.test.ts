/**
 * useDetectionProgress Hook Tests
 *
 * Tests the SSE event handling for real-time detection progress updates.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDetectionProgress } from '../useDetectionProgress';
import { resourceUri } from '@semiont/api-client';
import type { DetectionProgress } from '@semiont/api-client';

// Create a mock SSE stream
const createMockSSEStream = () => {
  const stream = {
    onProgressCallback: null as ((progress: DetectionProgress) => void) | null,
    onCompleteCallback: null as ((result: DetectionProgress) => void) | null,
    onErrorCallback: null as ((error: Error) => void) | null,
    onProgress: vi.fn((callback: (progress: DetectionProgress) => void) => {
      stream.onProgressCallback = callback;
    }),
    onComplete: vi.fn((callback: (result: DetectionProgress) => void) => {
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
const mockDetectAnnotations = vi.fn();
const mockApiClient = {
  sse: {
    detectAnnotations: mockDetectAnnotations,
  },
};

vi.mock('@/lib/api-hooks', () => ({
  useApiClient: () => mockApiClient,
}));

// Mock environment
vi.mock('@/lib/env', () => ({
  SERVER_API_URL: 'http://localhost:4000'
}));

describe('useDetectionProgress', () => {
  let mockStream: ReturnType<typeof createMockSSEStream>;

  beforeEach(() => {
    mockStream = createMockSSEStream();
    mockDetectAnnotations.mockReturnValue(mockStream);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
      })
    );

    expect(result.current.isDetecting).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(typeof result.current.startDetection).toBe('function');
    expect(typeof result.current.cancelDetection).toBe('function');
  });

  it('should call api-client with correct parameters', async () => {
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
      })
    );

    await result.current.startDetection(['Person', 'Organization']);

    expect(mockDetectAnnotations).toHaveBeenCalledWith(
      resourceUri('http://localhost:4000/resources/test-resource'),
      { entityTypes: ['Person', 'Organization'] }
    );
  });

  it('should set isDetecting to true when detection starts', async () => {
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
      })
    );

    await result.current.startDetection(['Person']);

    await waitFor(() => {
      expect(result.current.isDetecting).toBe(true);
    });
  });

  it('should handle detection-started event', async () => {
    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
        onProgress
      })
    );

    await result.current.startDetection(['Person']);

    // Simulate SSE progress event
    const progressData: DetectionProgress = {
      status: 'started',
      resourceId: 'test-resource',
      totalEntityTypes: 1,
      processedEntityTypes: 0,
      message: 'Starting entity detection...'
    };

    mockStream.onProgressCallback!(progressData);

    await waitFor(() => {
      expect(onProgress).toHaveBeenCalled();
    });

    expect(result.current.progress).toMatchObject({
      status: 'started',
      resourceId: 'test-resource',
      totalEntityTypes: 1,
      processedEntityTypes: 0
    });
  });

  it('should handle detection-progress events', async () => {
    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
        onProgress
      })
    );

    await result.current.startDetection(['Person', 'Organization']);

    // Simulate progress event
    const progressData: DetectionProgress = {
      status: 'scanning',
      resourceId: 'test-resource',
      currentEntityType: 'Person',
      totalEntityTypes: 2,
      processedEntityTypes: 1,
      foundCount: 3,
      message: 'Scanning for Person...'
    };

    mockStream.onProgressCallback!(progressData);

    await waitFor(() => {
      expect(result.current.progress?.status).toBe('scanning');
    });

    expect(result.current.progress).toMatchObject({
      status: 'scanning',
      currentEntityType: 'Person',
      totalEntityTypes: 2,
      processedEntityTypes: 1,
      foundCount: 3
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'scanning',
        currentEntityType: 'Person',
        foundCount: 3
      })
    );
  });

  it('should handle detection-complete event', async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
        onComplete
      })
    );

    await result.current.startDetection(['Person']);

    const completeData: DetectionProgress = {
      status: 'complete',
      resourceId: 'test-resource',
      totalEntityTypes: 1,
      processedEntityTypes: 1,
      message: 'Detection complete!'
    };

    mockStream.onCompleteCallback!(completeData);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });

    expect(result.current.isDetecting).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('should handle detection-error event', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
        onError
      })
    );

    await result.current.startDetection(['Person']);

    const error = new Error('Detection failed');
    mockStream.onErrorCallback!(error);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Detection failed');
    });

    expect(result.current.isDetecting).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('should track completed entity types history', async () => {
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
      })
    );

    await result.current.startDetection(['Person', 'Organization']);

    // First entity type
    mockStream.onProgressCallback!({
      status: 'scanning',
      currentEntityType: 'Person',
      foundCount: 3
    } as DetectionProgress);

    await waitFor(() => {
      expect(result.current.progress?.completedEntityTypes).toHaveLength(1);
    });

    // Second entity type
    mockStream.onProgressCallback!({
      status: 'scanning',
      currentEntityType: 'Organization',
      foundCount: 5
    } as DetectionProgress);

    await waitFor(() => {
      expect(result.current.progress?.completedEntityTypes).toHaveLength(2);
    });

    expect(result.current.progress?.completedEntityTypes).toEqual([
      { entityType: 'Person', foundCount: 3 },
      { entityType: 'Organization', foundCount: 5 }
    ]);
  });

  it('should cancel detection and close SSE stream', async () => {
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
      })
    );

    await result.current.startDetection(['Person']);
    result.current.cancelDetection();

    expect(mockStream.close).toHaveBeenCalled();
    expect(result.current.isDetecting).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  // Note: Authentication testing is handled by useApiClient hook tests
  // The hook relies on useApiClient returning null when not authenticated

  it('should handle SSE connection errors', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
        onError
      })
    );

    await result.current.startDetection(['Person']);

    const error = new Error('Connection lost');
    mockStream.onErrorCallback!(error);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Connection lost');
    });

    expect(result.current.isDetecting).toBe(false);
  });

  it('should cleanup on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('http://localhost:4000/resources/test-resource'),
      })
    );

    result.current.startDetection(['Person']);
    unmount();

    expect(mockStream.close).toHaveBeenCalled();
  });
});
