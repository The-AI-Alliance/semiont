/**
 * useGenerationProgress Hook Tests
 *
 * Tests the SSE event handling for real-time resource generation progress updates.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGenerationProgress } from '../useGenerationProgress';
import { useSession } from 'next-auth/react';

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

// Import the real extractAnnotationId from core instead of mocking with string manipulation
import { extractAnnotationId } from '@semiont/core';

vi.mock('@semiont/api-client', () => ({
  extractAnnotationId
}));

describe('useGenerationProgress', () => {
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
      useGenerationProgress({})
    );

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(typeof result.current.startGeneration).toBe('function');
    expect(typeof result.current.cancelGeneration).toBe('function');
    expect(typeof result.current.clearProgress).toBe('function');
  });

  it('should call fetchEventSource with correct parameters', async () => {
    mockFetchEventSource.mockImplementation(async () => {});

    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration('test-ref-id', 'test-resource', {
      title: 'Test Resource',
      prompt: 'Create a resource about testing',
      language: 'en'
    });

    expect(mockFetchEventSource).toHaveBeenCalledWith(
      'http://localhost:4000/api/annotations/test-ref-id/generate-resource-stream',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token'
        },
        body: JSON.stringify({
          resourceId: 'test-resource',
          title: 'Test Resource',
          prompt: 'Create a resource about testing',
          language: 'en'
        }),
        signal: expect.any(AbortSignal)
      })
    );
  });

  it('should set isGenerating to true when generation starts', async () => {
    mockFetchEventSource.mockImplementation(async () => {});

    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration('test-ref-id', 'test-resource');

    await waitFor(() => {
      expect(result.current.isGenerating).toBe(true);
    });
  });

  it('should handle generation-started event', async () => {
    let capturedOnMessage: ((ev: any) => void) | null = null;

    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      capturedOnMessage = options.onmessage;
    });

    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onProgress })
    );

    await result.current.startGeneration('test-ref-id', 'test-resource');

    capturedOnMessage!({
      event: 'generation-started',
      data: JSON.stringify({
        status: 'started',
        referenceId: 'test-ref-id',
        percentage: 0,
        message: 'Starting...'
      })
    });

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
    let capturedOnMessage: ((ev: any) => void) | null = null;

    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      capturedOnMessage = options.onmessage;
    });

    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onProgress })
    );

    await result.current.startGeneration('test-ref-id', 'test-resource');

    const stages = [
      { status: 'fetching', percentage: 20, message: 'Fetching source resource...' },
      { status: 'generating', percentage: 40, message: 'Creating content with AI...' },
      { status: 'creating', percentage: 85, message: 'Creating resource...' }
    ];

    for (const stage of stages) {
      capturedOnMessage!({
        event: 'generation-progress',
        data: JSON.stringify({
          status: stage.status,
          referenceId: 'test-ref-id',
          percentage: stage.percentage,
          message: stage.message
        })
      });

      await waitFor(() => {
        expect(result.current.progress?.status).toBe(stage.status);
      });

      expect(result.current.progress?.percentage).toBe(stage.percentage);
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          status: stage.status,
          percentage: stage.percentage
        })
      );
    }
  });

  it('should handle generation-complete event', async () => {
    let capturedOnMessage: ((ev: any) => void) | null = null;

    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      capturedOnMessage = options.onmessage;
    });

    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onComplete })
    );

    await result.current.startGeneration('test-ref-id', 'test-resource');

    capturedOnMessage!({
      event: 'generation-complete',
      data: JSON.stringify({
        status: 'complete',
        referenceId: 'test-ref-id',
        resourceId: 'new-resource-id',
        sourceResourceId: 'test-resource',
        percentage: 100,
        message: 'Draft resource created! Ready for review.'
      })
    });

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress).toMatchObject({
      status: 'complete',
      resourceId: 'new-resource-id',
      percentage: 100
    });
  });

  it('should handle generation-error event', async () => {
    let capturedOnMessage: ((ev: any) => void) | null = null;

    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      capturedOnMessage = options.onmessage;
    });

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onError })
    );

    await result.current.startGeneration('test-ref-id', 'test-resource');

    capturedOnMessage!({
      event: 'generation-error',
      data: JSON.stringify({
        status: 'error',
        referenceId: 'test-ref-id',
        percentage: 0,
        message: 'Generation failed: AI service unavailable'
      })
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Generation failed: AI service unavailable');
    });

    expect(result.current.isGenerating).toBe(false);
  });

  it('should cancel generation and abort SSE connection', async () => {
    const abortController = { abort: vi.fn(), signal: { aborted: false } as any };
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController as any);

    mockFetchEventSource.mockImplementation(async () => {});

    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration('test-ref-id', 'test-resource');
    result.current.cancelGeneration();

    expect(abortController.abort).toHaveBeenCalled();
    expect(result.current.isGenerating).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('should clear progress', () => {
    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    // Manually set progress (simulating after completion)
    result.current.clearProgress();

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
      useGenerationProgress({ onError })
    );

    await result.current.startGeneration('test-ref-id', 'test-resource');

    expect(onError).toHaveBeenCalledWith('Authentication required');
    expect(mockFetchEventSource).not.toHaveBeenCalled();
  });

  it('should handle SSE connection errors', async () => {
    mockFetchEventSource.mockImplementation(async (url: string, options: any) => {
      options.onerror(new Error('Connection lost'));
    });

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useGenerationProgress({ onError })
    );

    await result.current.startGeneration('test-ref-id', 'test-resource');

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Connection lost. Please try again.');
    });

    expect(result.current.isGenerating).toBe(false);
  });

  it('should extract annotation ID from URI', async () => {
    mockFetchEventSource.mockImplementation(async () => {});

    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    // Pass a full URI instead of just an ID
    await result.current.startGeneration(
      'http://localhost:4000/api/annotations/test-ref-id',
      'test-resource'
    );

    expect(mockFetchEventSource).toHaveBeenCalledWith(
      'http://localhost:4000/api/annotations/test-ref-id/generate-resource-stream',
      expect.any(Object)
    );
  });

  it('should keep connection open when tab is in background', async () => {
    mockFetchEventSource.mockImplementation(async () => {});

    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration('test-ref-id', 'test-resource');

    expect(mockFetchEventSource).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        openWhenHidden: true
      })
    );
  });

  it('should cleanup on unmount', () => {
    const abortController = { abort: vi.fn(), signal: { aborted: false } as any };
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController as any);

    mockFetchEventSource.mockImplementation(async () => {});

    const { result, unmount } = renderHook(() =>
      useGenerationProgress({})
    );

    result.current.startGeneration('test-ref-id', 'test-resource');
    unmount();

    expect(abortController.abort).toHaveBeenCalled();
  });

  it('should pass language option to API', async () => {
    mockFetchEventSource.mockImplementation(async () => {});

    const { result } = renderHook(() =>
      useGenerationProgress({})
    );

    await result.current.startGeneration('test-ref-id', 'test-resource', {
      language: 'es'
    });

    expect(mockFetchEventSource).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          resourceId: 'test-resource',
          language: 'es'
        })
      })
    );
  });
});
