import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAuthenticatedAPI } from '../useAuthenticatedAPI';
import { APIError } from '@semiont/api-client';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

const mockUseSession = vi.mocked(await import('next-auth/react')).useSession;

// Mock fetch - properly initialize as a vi.fn()
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// Helper to create mock Response objects
function createMockResponse(options: {
  ok: boolean;
  status?: number;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
}) {
  const mockResponse = {
    ok: options.ok,
    status: options.status || (options.ok ? 200 : 500),
    json: options.json || (async () => ({})),
    text: options.text || (async () => ''),
    clone: () => mockResponse,
  };
  return mockResponse;
}

describe('useAuthenticatedAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Note: NEXT_PUBLIC_API_URL is set to 'http://localhost:3001' in vitest.setup.js
    // and cannot be changed at runtime since env.ts exports are constants
  });

  it('should return fetchAPI function and isAuthenticated flag', () => {
    mockUseSession.mockReturnValue({
      data: { backendToken: 'test-token' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    const { result } = renderHook(() => useAuthenticatedAPI());

    expect(result.current.fetchAPI).toBeInstanceOf(Function);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('should set isAuthenticated to false when no token', () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: 'unauthenticated',
      update: vi.fn(),
    } as any);

    const { result } = renderHook(() => useAuthenticatedAPI());

    expect(result.current.isAuthenticated).toBe(false);
  });

  it('should throw error if token is missing when fetchAPI is called', async () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: 'unauthenticated',
      update: vi.fn(),
    } as any);

    const { result } = renderHook(() => useAuthenticatedAPI());

    await expect(result.current.fetchAPI('/api/test')).rejects.toThrow(
      'Authentication required. No session token available.'
    );
  });

  it('should make authenticated request with correct headers', async () => {
    mockUseSession.mockReturnValue({
      data: { backendToken: 'test-token-123' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        ok: true,
        json: async () => ({ success: true }),
      })
    );

    const { result } = renderHook(() => useAuthenticatedAPI());
    const response = await result.current.fetchAPI('/api/test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('Expected fetch to be called');

    // Check URL (can be Request object or string)
    if (call[0] instanceof Request) {
      expect(call[0].url).toBe('http://localhost:3001/api/test');
      expect(call[0].headers.get('Content-Type')).toBe('application/json');
      expect(call[0].headers.get('Authorization')).toBe('Bearer test-token-123');
    } else {
      expect(call[0]).toBe('http://localhost:3001/api/test');
      expect(call[1]?.headers?.['Content-Type']).toBe('application/json');
      expect(call[1]?.headers?.['Authorization']).toBe('Bearer test-token-123');
    }

    expect(response).toEqual({ success: true });
  });

  it('should allow custom headers to override defaults', async () => {
    mockUseSession.mockReturnValue({
      data: { backendToken: 'test-token' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    mockFetch.mockResolvedValueOnce(createMockResponse({
      ok: true,
      json: async () => ({ success: true }),
    }));

    const { result } = renderHook(() => useAuthenticatedAPI());
    await result.current.fetchAPI('/api/test', {
      headers: {
        'Content-Type': 'text/plain',
        'X-Custom-Header': 'custom-value',
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('Expected fetch to be called');

    if (call[0] instanceof Request) {
      expect(call[0].url).toBe('http://localhost:3001/api/test');
      expect(call[0].headers.get('Content-Type')).toBe('text/plain');
      expect(call[0].headers.get('Authorization')).toBe('Bearer test-token');
      expect(call[0].headers.get('X-Custom-Header')).toBe('custom-value');
    } else {
      expect(call[0]).toBe('http://localhost:3001/api/test');
      expect(call[1]?.headers?.['Content-Type']).toBe('text/plain');
      expect(call[1]?.headers?.['Authorization']).toBe('Bearer test-token');
      expect(call[1]?.headers?.['X-Custom-Header']).toBe('custom-value');
    }
  });

  it('should pass through other fetch options', async () => {
    mockUseSession.mockReturnValue({
      data: { backendToken: 'test-token' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    mockFetch.mockResolvedValueOnce(createMockResponse({
      ok: true,
      json: async () => ({ success: true }),
    }));

    const { result } = renderHook(() => useAuthenticatedAPI());
    await result.current.fetchAPI('/api/test', {
      method: 'POST',
      body: JSON.stringify({ data: 'test' }),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('Expected fetch to be called');

    if (call[0] instanceof Request) {
      expect(call[0].url).toBe('http://localhost:3001/api/test');
      expect(call[0].method).toBe('POST');
      expect(call[0].headers.get('Content-Type')).toBe('application/json');
      expect(call[0].headers.get('Authorization')).toBe('Bearer test-token');
    } else {
      expect(call[0]).toBe('http://localhost:3001/api/test');
      expect(call[1]?.method).toBe('POST');
      expect(call[1]?.headers?.['Content-Type']).toBe('application/json');
      expect(call[1]?.headers?.['Authorization']).toBe('Bearer test-token');
    }
  });

  it('should throw APIError with status and parsed JSON error on 401', async () => {
    mockUseSession.mockReturnValue({
      data: { backendToken: 'test-token' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    mockFetch.mockResolvedValueOnce(createMockResponse({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'Unauthorized' }),
    }));

    const { result } = renderHook(() => useAuthenticatedAPI());

    try {
      await result.current.fetchAPI('/api/test');
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).status).toBe(401);
      expect((error as APIError).details).toEqual({ error: 'Unauthorized' });
    }
  });

  it('should throw APIError with status and parsed JSON error on 403', async () => {
    mockUseSession.mockReturnValue({
      data: { backendToken: 'test-token' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    mockFetch.mockResolvedValueOnce(createMockResponse({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'Forbidden' }),
    }));

    const { result } = renderHook(() => useAuthenticatedAPI());

    try {
      await result.current.fetchAPI('/api/test');
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).status).toBe(403);
      expect((error as APIError).details).toEqual({ error: 'Forbidden' });
    }
  });

  it('should handle non-JSON error responses', async () => {
    mockUseSession.mockReturnValue({
      data: { backendToken: 'test-token' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    mockFetch.mockResolvedValueOnce(createMockResponse({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }));

    const { result } = renderHook(() => useAuthenticatedAPI());

    try {
      await result.current.fetchAPI('/api/test');
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).status).toBe(500);
      expect((error as APIError).details).toEqual({ error: 'Internal Server Error' });
    }
  });

  it('should handle network errors', async () => {
    mockUseSession.mockReturnValue({
      data: { backendToken: 'test-token' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useAuthenticatedAPI());

    await expect(result.current.fetchAPI('/api/test')).rejects.toThrow('Network error');
  });

  it('should update fetchAPI when token changes', async () => {
    const { result, rerender } = renderHook(() => useAuthenticatedAPI());

    // First render with token
    mockUseSession.mockReturnValue({
      data: { backendToken: 'token-1' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    mockFetch.mockResolvedValueOnce(createMockResponse({
      ok: true,
      json: async () => ({ success: true }),
    }));

    rerender();
    await result.current.fetchAPI('/api/test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    let call = mockFetch.mock.calls[0];
    if (!call) throw new Error('Expected fetch to be called');

    if (call[0] instanceof Request) {
      expect(call[0].headers.get('Authorization')).toBe('Bearer token-1');
    } else {
      expect(call[1]?.headers?.['Authorization']).toBe('Bearer token-1');
    }

    // Second render with new token
    mockUseSession.mockReturnValue({
      data: { backendToken: 'token-2' },
      status: 'authenticated',
      update: vi.fn(),
    } as any);

    mockFetch.mockResolvedValueOnce(createMockResponse({
      ok: true,
      json: async () => ({ success: true }),
    }));

    rerender();
    await result.current.fetchAPI('/api/test');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    call = mockFetch.mock.calls[1];
    if (!call) throw new Error('Expected fetch to be called');

    if (call[0] instanceof Request) {
      expect(call[0].headers.get('Authorization')).toBe('Bearer token-2');
    } else {
      expect(call[1]?.headers?.['Authorization']).toBe('Bearer token-2');
    }
  });
});
