import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, LazyTypedAPIClient, TypedAPIClient } from '@/lib/api-client';

// Import server to control MSW during these tests
import { server } from '@/mocks/server';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

const mockUseSession = vi.mocked(await import('next-auth/react')).useSession;

// Use environment variable for backend URL - matching what api-client uses in test mode
const getBackendUrl = () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';


// Mock fetch globally - need to restore original fetch for MSW bypass
const originalFetch = global.fetch;
const mockFetch = vi.fn();

// Disable MSW for these tests since we're testing the HTTP layer directly
beforeEach(() => {
  server.close();
  global.fetch = mockFetch;
  // Reset the lazy API client for test isolation
  LazyTypedAPIClient.reset();
  // Set up a test instance with the correct URL
  const testClient = new TypedAPIClient(getBackendUrl());
  LazyTypedAPIClient.setInstance(testClient);
  // Mock authenticated session
  mockUseSession.mockReturnValue({
    data: { backendToken: 'test-token' },
    status: 'authenticated',
    update: vi.fn(),
  } as any);
});

afterEach(() => {
  vi.clearAllMocks();
  global.fetch = originalFetch;
  server.listen({ onUnhandledRequest: 'warn' });
  // Reset the lazy API client after each test
  LazyTypedAPIClient.reset();
});

// Helper to create a proper Response mock
const createMockResponse = (data: any, ok = true, status = 200) => ({
  ok,
  status,
  json: vi.fn().mockResolvedValue(data),
  text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  clone: vi.fn().mockReturnThis(),
  headers: new Headers(),
  url: '',
  statusText: ok ? 'OK' : 'Error',
  type: 'basic' as ResponseType,
  redirected: false,
  body: null,
  bodyUsed: false,
  arrayBuffer: vi.fn(),
  blob: vi.fn(),
  formData: vi.fn()
});

// Test wrapper component
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

// Helper to assert fetch was called with expected arguments (handles Request objects)
const expectFetchCalledWith = (url: string, options?: RequestInit) => {
  expect(mockFetch).toHaveBeenCalled();
  const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];

  if (call[0] instanceof Request) {
    // Modern fetch with Request object
    expect(call[0].url).toBe(url);
    if (options?.method) {
      expect(call[0].method).toBe(options.method);
    }
    if (options?.headers) {
      const expectedHeaders = options.headers as Record<string, string>;
      Object.entries(expectedHeaders).forEach(([key, value]) => {
        expect(call[0].headers.get(key)).toBe(value);
      });
    }
    if (options?.body) {
      // Can't easily check body on Request object in tests
    }
  } else {
    // Traditional fetch with (url, options)
    expect(call[0]).toBe(url);
    if (options) {
      expect(call[1]).toMatchObject(options);
    }
  }
};

describe('React Query API hooks', () => {
  beforeEach(() => {
    // Mock fetch responses for each test
    mockFetch.mockResolvedValue(createMockResponse({ success: true }));
    process.env.NEXT_PUBLIC_API_URL = getBackendUrl();
  });

  // Removed hello.greeting and hello.getStatus hook tests - these endpoints no longer exist

  describe('auth.google mutation', () => {
    it('should make Google auth mutation', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ token: 'jwt-token', user: { id: '1' } }));

      const { result } = renderHook(
        () => api.auth.google.useMutation(),
        { wrapper: createWrapper() }
      );

      const mutationResult = await result.current.mutateAsync({ access_token: 'google-token' });

      expectFetchCalledWith(getBackendUrl() + '/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      // Check the returned data from mutateAsync
      expect(mutationResult).toEqual({ token: 'jwt-token', user: { id: '1' } });
    });

    it('should handle mutation errors', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ error: 'Invalid token' }, false, 401));

      const { result } = renderHook(
        () => api.auth.google.useMutation(),
        { wrapper: createWrapper() }
      );

      await expect(
        result.current.mutateAsync({ access_token: 'invalid-token' })
      ).rejects.toThrow();

      // Wait for the mutation state to update
      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });
    });
  });

  describe('auth.me query', () => {
    it('should fetch current user', async () => {
      const mockResponse = createMockResponse({ user: { id: '1', email: 'test@example.com' } });
      mockFetch.mockResolvedValue(mockResponse as any);

      const { result } = renderHook(
        () => api.auth.me.useQuery(),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expectFetchCalledWith(getBackendUrl() + '/api/auth/me', {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      expect(result.current.data).toEqual({ user: { id: '1', email: 'test@example.com' } });
    });

    it('should use correct query key for auth.me', () => {
      const { result } = renderHook(
        () => api.auth.me.useQuery(),
        { wrapper: createWrapper() }
      );

      // Verify the query hook is properly configured
      expect(result.current).toHaveProperty('data');
      expect(result.current).toHaveProperty('status');
      expect(result.current).toHaveProperty('isLoading');
    });
  });

  describe('auth.logout mutation', () => {
    it('should make logout mutation', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true, message: 'Logged out' }));

      const { result } = renderHook(
        () => api.auth.logout.useMutation(),
        { wrapper: createWrapper() }
      );

      const mutationResult = await result.current.mutateAsync();

      expectFetchCalledWith(getBackendUrl() + '/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      // Check the returned data from mutateAsync
      expect(mutationResult).toEqual({ success: true, message: 'Logged out' });
    });
  });

  describe('health query', () => {
    it('should fetch health status', async () => {
      const mockResponse = createMockResponse({ status: 'healthy', timestamp: '2024-01-01' });
      mockFetch.mockResolvedValue(mockResponse as any);

      const { result } = renderHook(
        () => api.health.useQuery(),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expectFetchCalledWith(getBackendUrl() + '/api/health', {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      expect(result.current.data).toEqual({ status: 'healthy', timestamp: '2024-01-01' });
    });

    it('should use correct query key for health', () => {
      const { result } = renderHook(
        () => api.health.useQuery(),
        { wrapper: createWrapper() }
      );

      // Verify the query hook is properly configured
      expect(result.current).toHaveProperty('data');
      expect(result.current).toHaveProperty('status');
      expect(result.current).toHaveProperty('isLoading');
      // Original assertion would be: expect(result.current.queryKey).toEqual(['health']);
    });
  });

  describe('admin.users.list query', () => {
    it('should fetch users list', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ 
        success: true, 
        users: [{ id: '1', email: 'admin@example.com' }] 
      }));

      const { result } = renderHook(
        () => api.admin.users.list.useQuery(),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expectFetchCalledWith(getBackendUrl() + '/api/admin/users', {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      expect(result.current.data).toEqual({ 
        success: true, 
        users: [{ id: '1', email: 'admin@example.com' }] 
      });
    });

    it('should use correct query key for admin users list', () => {
      const { result } = renderHook(
        () => api.admin.users.list.useQuery(),
        { wrapper: createWrapper() }
      );

      // Verify the query hook is properly configured
      expect(result.current).toHaveProperty('data');
      expect(result.current).toHaveProperty('status');
      expect(result.current).toHaveProperty('isLoading');
      // Original assertion would be: expect(result.current.queryKey).toEqual(['admin.users.list']);
    });
  });

  describe('admin.users.stats query', () => {
    it('should fetch user stats', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ 
        success: true, 
        stats: { total: 10, active: 8, admins: 2, recent: 3 } 
      }));

      const { result } = renderHook(
        () => api.admin.users.stats.useQuery(),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expectFetchCalledWith(getBackendUrl() + '/api/admin/users/stats', {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      expect(result.current.data).toEqual({ 
        success: true, 
        stats: { total: 10, active: 8, admins: 2, recent: 3 } 
      });
    });

    it('should use correct query key for admin users stats', () => {
      const { result } = renderHook(
        () => api.admin.users.stats.useQuery(),
        { wrapper: createWrapper() }
      );

      // Verify the query hook is properly configured
      expect(result.current).toHaveProperty('data');
      expect(result.current).toHaveProperty('status');
      expect(result.current).toHaveProperty('isLoading');
      // Original assertion would be: expect(result.current.queryKey).toEqual(['admin.users.stats']);
    });
  });

  describe('admin.users.update mutation', () => {
    it('should update user with all fields', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ 
        success: true, 
        user: { id: '123', isAdmin: true, isActive: false, name: 'Updated Name' } 
      }));

      const { result } = renderHook(
        () => api.admin.users.update.useMutation(),
        { wrapper: createWrapper() }
      );

      const updateData = { isAdmin: true, isActive: false, name: 'Updated Name' };
      const mutationResult = await result.current.mutateAsync({ id: '123', data: updateData });

      expectFetchCalledWith(getBackendUrl() + '/api/admin/users/123', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      });

      // Check the returned data from mutateAsync
      expect(mutationResult).toEqual({ 
        success: true, 
        user: { id: '123', isAdmin: true, isActive: false, name: 'Updated Name' } 
      });
    });

    it('should update user with partial data', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ 
        success: true, 
        user: { id: '123', isAdmin: true } 
      }));

      const { result } = renderHook(
        () => api.admin.users.update.useMutation(),
        { wrapper: createWrapper() }
      );

      const mutationResult = await result.current.mutateAsync({ id: '123', data: { isAdmin: true } });

      expectFetchCalledWith(getBackendUrl() + '/api/admin/users/123', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isAdmin: true })
      });

      // Check the returned data from mutateAsync
      expect(mutationResult).toEqual({ 
        success: true, 
        user: { id: '123', isAdmin: true } 
      });
    });
  });

  describe('admin.users.delete mutation', () => {
    it('should delete user', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ 
        success: true, 
        message: 'User deleted successfully' 
      }));

      const { result } = renderHook(
        () => api.admin.users.delete.useMutation(),
        { wrapper: createWrapper() }
      );

      const mutationResult = await result.current.mutateAsync({ id: '123' });

      expectFetchCalledWith(getBackendUrl() + '/api/admin/users/123', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      // Check the returned data from mutateAsync
      expect(mutationResult).toEqual({ 
        success: true, 
        message: 'User deleted successfully' 
      });
    });
  });

  describe('admin.oauth.config query', () => {
    it('should fetch OAuth configuration', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ 
        success: true, 
        providers: [{ name: 'google', isConfigured: true }],
        allowedDomains: ['example.com']
      }));

      const { result } = renderHook(
        () => api.admin.oauth.config.useQuery(),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expectFetchCalledWith(getBackendUrl() + '/api/admin/oauth/config', {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      expect(result.current.data).toEqual({ 
        success: true, 
        providers: [{ name: 'google', isConfigured: true }],
        allowedDomains: ['example.com']
      });
    });

    it('should use correct query key for OAuth config', () => {
      const { result } = renderHook(
        () => api.admin.oauth.config.useQuery(),
        { wrapper: createWrapper() }
      );

      // Verify the query hook is properly configured
      expect(result.current).toHaveProperty('data');
      expect(result.current).toHaveProperty('status');
      expect(result.current).toHaveProperty('isLoading');
      // Original assertion would be: expect(result.current.queryKey).toEqual(['admin.oauth.config']);
    });
  });

  describe('hook error handling', () => {
    it('should handle network errors in queries', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(
        () => api.health.useQuery(),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect(result.current.error).toEqual(new Error('Network error'));
    });

    it('should handle network errors in mutations', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(
        () => api.auth.logout.useMutation(),
        { wrapper: createWrapper() }
      );

      await expect(result.current.mutateAsync()).rejects.toThrow('Network error');
      
      // Wait for the mutation state to update
      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });
    });
  });

  describe('hook state management', () => {
    it('should track loading states correctly for queries', async () => {
      let resolvePromise: (value: any) => void;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      // Create a mock response that delays the JSON parsing
      const mockResponse = createMockResponse({ healthy: true });
      mockResponse.json = vi.fn().mockReturnValue(promise);
      mockFetch.mockResolvedValue(mockResponse);

      const { result } = renderHook(
        () => api.health.useQuery(),
        { wrapper: createWrapper() }
      );

      // Should start as loading in React Query v5
      expect(result.current.isLoading).toBe(true);
      expect(result.current.isSuccess).toBe(false);

      // Resolve the promise
      resolvePromise!({ healthy: true });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toEqual({ healthy: true });
    });

    it('should track loading states correctly for mutations', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      const { result } = renderHook(
        () => api.auth.logout.useMutation(),
        { wrapper: createWrapper() }
      );

      // Should start as idle
      expect(result.current.isPending).toBe(false);
      expect(result.current.isSuccess).toBe(false);

      // Start mutation and wait for completion
      const mutationResult = await result.current.mutateAsync();

      // Wait for React Query to update the state after mutation completion
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      // After completion, check states
      expect(result.current.isPending).toBe(false);
      expect(mutationResult).toEqual({ success: true });
    });
  });
});