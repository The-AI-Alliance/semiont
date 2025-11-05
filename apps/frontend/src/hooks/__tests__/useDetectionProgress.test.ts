/**
 * useDetectionProgress Hook Tests
 *
 * Tests the SSE event handling for real-time detection progress updates.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDetectionProgress } from '../useDetectionProgress';
import { useSession } from 'next-auth/react';
import { resourceUri } from '@semiont/api-client';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  useSession: vi.fn()
}));

// Mock fetch-event-source
const mockFetchEventSource: any = vi.fn();
vi.mock('@microsoft/fetch-event-source', () => ({
  fetchEventSource: (...args: any[]) => mockFetchEventSource(...args)
}));

// Mock environment
vi.mock('@/lib/env', () => ({
  NEXT_PUBLIC_API_URL: 'http://localhost:4000'
}));

describe('useDetectionProgress', () => {
  const mockSession = {
    backendToken: 'test-token',
    user: { id: 'user-1', email: 'test@example.com' }
  };

  beforeEach(() => {
    vi.mocked(useSession).mockReturnValue({
      data: mockSession as any,
      status: 'authenticated',
      update: vi.fn()
    });
    mockFetchEventSource.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
      })
    );

    expect(result.current.isDetecting).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(typeof result.current.startDetection).toBe('function');
    expect(typeof result.current.cancelDetection).toBe('function');
  });

  it('should call fetchEventSource with correct parameters', async () => {
    mockFetchEventSource.mockImplementation(async () => {});

    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
      })
    );

    await result.current.startDetection(['Person', 'Organization']);

    expect(mockFetchEventSource).toHaveBeenCalledWith(
      'http://localhost:4000/api/resources/test-resource/detect-annotations-stream',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token'
        },
        body: JSON.stringify({ entityTypes: ['Person', 'Organization'] }),
        signal: expect.any(AbortSignal)
      })
    );
  });

  it('should set isDetecting to true when detection starts', async () => {
    mockFetchEventSource.mockImplementation(async () => {});

    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
      })
    );

    await result.current.startDetection(['Person']);

    await waitFor(() => {
      expect(result.current.isDetecting).toBe(true);
    });
  });

  it('should handle detection-started event', async () => {
    let capturedOnMessage: ((ev: any) => void) | null = null;

    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      capturedOnMessage = options.onmessage;
    });

    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
        onProgress
      })
    );

    await result.current.startDetection(['Person']);

    // Simulate SSE event
    capturedOnMessage!({
      event: 'detection-started',
      data: JSON.stringify({
        status: 'started',
        rUri: resourceUri('test-resource'),
        totalEntityTypes: 1,
        processedEntityTypes: 0,
        message: 'Starting entity detection...'
      })
    });

    await waitFor(() => {
      expect(onProgress).toHaveBeenCalled();
    });

    expect(result.current.progress).toMatchObject({
      status: 'started',
      rUri: resourceUri('test-resource'),
      totalEntityTypes: 1,
      processedEntityTypes: 0
    });
  });

  it('should handle detection-progress events', async () => {
    let capturedOnMessage: ((ev: any) => void) | null = null;

    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      capturedOnMessage = options.onmessage;
    });

    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
        onProgress
      })
    );

    await result.current.startDetection(['Person', 'Organization']);

    // Simulate progress events
    capturedOnMessage!({
      event: 'detection-progress',
      data: JSON.stringify({
        status: 'scanning',
        rUri: resourceUri('test-resource'),
        currentEntityType: 'Person',
        totalEntityTypes: 2,
        processedEntityTypes: 1,
        foundCount: 3,
        message: 'Scanning for Person...'
      })
    });

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
    let capturedOnMessage: ((ev: any) => void) | null = null;

    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      capturedOnMessage = options.onmessage;
    });

    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
        onComplete
      })
    );

    await result.current.startDetection(['Person']);

    capturedOnMessage!({
      event: 'detection-complete',
      data: JSON.stringify({
        status: 'complete',
        rUri: resourceUri('test-resource'),
        totalEntityTypes: 1,
        processedEntityTypes: 1,
        message: 'Detection complete!'
      })
    });

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });

    expect(result.current.isDetecting).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('should handle detection-error event', async () => {
    let capturedOnMessage: ((ev: any) => void) | null = null;

    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      capturedOnMessage = options.onmessage;
    });

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
        onError
      })
    );

    await result.current.startDetection(['Person']);

    capturedOnMessage!({
      event: 'detection-error',
      data: JSON.stringify({
        status: 'error',
        rUri: resourceUri('test-resource'),
        message: 'Detection failed'
      })
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Detection failed');
    });

    expect(result.current.isDetecting).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('should track completed entity types history', async () => {
    let capturedOnMessage: ((ev: any) => void) | null = null;

    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      capturedOnMessage = options.onmessage;
    });

    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
      })
    );

    await result.current.startDetection(['Person', 'Organization']);

    // First entity type
    capturedOnMessage!({
      event: 'detection-progress',
      data: JSON.stringify({
        status: 'scanning',
        currentEntityType: 'Person',
        foundCount: 3
      })
    });

    await waitFor(() => {
      expect(result.current.progress?.completedEntityTypes).toHaveLength(1);
    });

    // Second entity type
    capturedOnMessage!({
      event: 'detection-progress',
      data: JSON.stringify({
        status: 'scanning',
        currentEntityType: 'Organization',
        foundCount: 5
      })
    });

    await waitFor(() => {
      expect(result.current.progress?.completedEntityTypes).toHaveLength(2);
    });

    expect(result.current.progress?.completedEntityTypes).toEqual([
      { entityType: 'Person', foundCount: 3 },
      { entityType: 'Organization', foundCount: 5 }
    ]);
  });

  it('should cancel detection and abort SSE connection', async () => {
    const abortController = { abort: vi.fn(), signal: { aborted: false } as any };
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController as any);

    mockFetchEventSource.mockImplementation(async () => {});

    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
      })
    );

    await result.current.startDetection(['Person']);
    result.current.cancelDetection();

    expect(abortController.abort).toHaveBeenCalled();
    expect(result.current.isDetecting).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('should require authentication', async () => {
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: 'unauthenticated',
      update: vi.fn()
    });

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
        onError
      })
    );

    await result.current.startDetection(['Person']);

    expect(onError).toHaveBeenCalledWith('Authentication required');
    expect(mockFetchEventSource).not.toHaveBeenCalled();
  });

  it('should handle SSE connection errors', async () => {
    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      options.onerror(new Error('Connection lost'));
    });

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
        onError
      })
    );

    await result.current.startDetection(['Person']);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Connection lost. Please try again.');
    });

    expect(result.current.isDetecting).toBe(false);
  });

  it('should cleanup on unmount', () => {
    const abortController = { abort: vi.fn(), signal: { aborted: false } as any };
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController as any);

    mockFetchEventSource.mockImplementation(async () => {});

    const { result, unmount } = renderHook(() =>
      useDetectionProgress({
        rUri: resourceUri('test-resource'),
      })
    );

    result.current.startDetection(['Person']);
    unmount();

    expect(abortController.abort).toHaveBeenCalled();
  });
});
