import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import {
  useGreeting,
  useBackendStatus,
  useHealthCheck,
  useAuthenticatedAPI,
  useAPICall,
  useAPIMutation,
} from '@/hooks/useAPI';
import { api } from '@/lib/api-client';
import { useAuth } from '@/hooks/useAuth';


// Mock dependencies
vi.mock('@/lib/api-client', () => ({
  api: {
    hello: {
      greeting: {
        useQuery: vi.fn(),
      },
      getStatus: {
        useQuery: vi.fn(),
      },
    },
    health: {
      useQuery: vi.fn(),
    },
    auth: {
      me: {
        useQuery: vi.fn(),
      },
      logout: {
        useMutation: vi.fn(),
      },
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

// Helper to create wrapper with QueryClient
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useAPI hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock authenticated state by default
    (useAuth as any).mockReturnValue({
      isFullyAuthenticated: true,
      session: { backendToken: 'test-token' },
      isLoading: false,
      isAuthenticated: true,
      hasValidBackendToken: true,
      user: null,
      backendUser: null,
      userDomain: null,
      displayName: 'Test User',
      avatarUrl: null,
      isAdmin: false
    });
  });

  describe('useGreeting', () => {
    it('should call greeting API without name', () => {
      const mockUseQuery = vi.fn().mockReturnValue({ data: 'Hello!' });
      (api.hello.greeting.useQuery as any).mockImplementation(mockUseQuery);

      const { result } = renderHook(() => useGreeting(), {
        wrapper: createWrapper(),
      });

      expect(mockUseQuery).toHaveBeenCalledWith({
        token: 'test-token',
        enabled: false, // Should be disabled when no name and authenticated
      });
      expect(result.current).toEqual({ data: 'Hello!' });
    });

    it('should call greeting API with name', () => {
      const mockUseQuery = vi.fn().mockReturnValue({ data: 'Hello, John!' });
      (api.hello.greeting.useQuery as any).mockImplementation(mockUseQuery);

      const { result } = renderHook(() => useGreeting('John'), {
        wrapper: createWrapper(),
      });

      expect(mockUseQuery).toHaveBeenCalledWith({ 
        name: 'John',
        token: 'test-token',
        enabled: true, // Should be enabled when name is provided and authenticated
      });
      expect(result.current).toEqual({ data: 'Hello, John!' });
    });
  });

  describe('useBackendStatus', () => {
    it('should call status API without options', () => {
      const mockUseQuery = vi.fn().mockReturnValue({ data: { status: 'healthy' } });
      (api.hello.getStatus.useQuery as any).mockImplementation(mockUseQuery);

      const { result } = renderHook(() => useBackendStatus(), {
        wrapper: createWrapper(),
      });

      expect(mockUseQuery).toHaveBeenCalledWith({
        token: 'test-token',
        enabled: true,
      });
      expect(result.current).toEqual({ data: { status: 'healthy' } });
    });

    it('should call status API with polling options', () => {
      const mockUseQuery = vi.fn().mockReturnValue({ data: { status: 'healthy' } });
      (api.hello.getStatus.useQuery as any).mockImplementation(mockUseQuery);

      const { result } = renderHook(
        () => useBackendStatus({ pollingInterval: 5000, enabled: true }),
        {
          wrapper: createWrapper(),
        }
      );

      expect(mockUseQuery).toHaveBeenCalledWith({
        token: 'test-token',
        enabled: true,
        pollingInterval: 5000,
      });
      expect(result.current).toEqual({ data: { status: 'healthy' } });
    });

    it('should not enable query when not authenticated', () => {
      (useAuth as any).mockReturnValue({
        isFullyAuthenticated: false,
        session: null,
        isLoading: false,
        isAuthenticated: false,
        hasValidBackendToken: false,
        user: null,
        backendUser: null,
        userDomain: null,
        displayName: null,
        avatarUrl: null,
        isAdmin: false
      });

      const mockUseQuery = vi.fn().mockReturnValue({ data: null });
      (api.hello.getStatus.useQuery as any).mockImplementation(mockUseQuery);

      const { result } = renderHook(() => useBackendStatus(), {
        wrapper: createWrapper(),
      });

      expect(mockUseQuery).toHaveBeenCalledWith({
        enabled: false,
      });
      expect(result.current).toEqual({ data: null });
    });
  });

  describe('useHealthCheck', () => {
    it('should call health API', () => {
      const mockUseQuery = vi.fn().mockReturnValue({ data: { healthy: true } });
      (api.health.useQuery as any).mockImplementation(mockUseQuery);

      const { result } = renderHook(() => useHealthCheck(), {
        wrapper: createWrapper(),
      });

      expect(mockUseQuery).toHaveBeenCalled();
      expect(result.current).toEqual({ data: { healthy: true } });
    });
  });

  describe('useAuthenticatedAPI', () => {
    it('should provide authenticated API hooks when fully authenticated', () => {
      const mockMeQuery = vi.fn().mockReturnValue({ data: { id: '1', name: 'John' } });
      const mockLogoutMutation = vi.fn().mockReturnValue({ mutate: vi.fn() });

      (useAuth as any).mockReturnValue({
        isFullyAuthenticated: true,
        session: { user: { id: '1' } },
      });
      (api.auth.me.useQuery as any).mockImplementation(mockMeQuery);
      (api.auth.logout.useMutation as any).mockImplementation(mockLogoutMutation);

      const { result } = renderHook(() => useAuthenticatedAPI(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isReady).toBe(true);

      // Test useUserProfile
      const profileHook = renderHook(() => result.current.useUserProfile(), {
        wrapper: createWrapper(),
      });
      expect(mockMeQuery).toHaveBeenCalled();
      expect(profileHook.result.current).toEqual({ data: { id: '1', name: 'John' } });

      // Test useLogout
      const logoutHook = renderHook(() => result.current.useLogout(), {
        wrapper: createWrapper(),
      });
      expect(mockLogoutMutation).toHaveBeenCalled();
      expect(logoutHook.result.current).toEqual({ mutate: expect.any(Function) });
    });

    it('should indicate not ready when not authenticated', () => {
      (useAuth as any).mockReturnValue({
        isFullyAuthenticated: false,
        session: null,
      });

      const { result } = renderHook(() => useAuthenticatedAPI(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isReady).toBe(false);
    });
  });

  describe('useAPICall', () => {
    it('should handle successful API call', async () => {
      const mockData = { message: 'Success' };
      const queryFn = vi.fn().mockResolvedValue(mockData);

      const { result } = renderHook(
        () => useAPICall(['test-key'], queryFn),
        {
          wrapper: createWrapper(),
        }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(queryFn).toHaveBeenCalled();
      expect(result.current.data).toEqual(mockData);
    });

    it('should handle API call with custom options', async () => {
      const mockData = { message: 'Success' };
      const queryFn = vi.fn().mockResolvedValue(mockData);
      const customMeta = { customField: 'value' };

      const { result } = renderHook(
        () => useAPICall(['test-key'], queryFn, {
          enabled: false,
          meta: customMeta,
        }),
        {
          wrapper: createWrapper(),
        }
      );

      expect(queryFn).not.toHaveBeenCalled();
      expect(result.current.status).toBe('loading');
    });

    it('should handle failed API call', async () => {
      const error = new Error('API Error');
      const queryFn = vi.fn().mockRejectedValue(error);

      const { result } = renderHook(
        () => useAPICall(['test-key'], queryFn),
        {
          wrapper: createWrapper(),
        }
      );

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(queryFn).toHaveBeenCalled();
      expect(result.current.error).toBe(error);
    });
  });

  describe('useAPIMutation', () => {
    it('should handle successful mutation', async () => {
      const mockData = { id: '1', created: true };
      const mutationFn = vi.fn().mockResolvedValue(mockData);

      const { result } = renderHook(
        () => useAPIMutation(mutationFn),
        {
          wrapper: createWrapper(),
        }
      );

      result.current.mutate({ name: 'Test' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mutationFn).toHaveBeenCalledWith({ name: 'Test' });
      expect(result.current.data).toEqual(mockData);
    });

    it('should handle failed mutation with error logging', async () => {
      const error = new Error('Mutation failed');
      const mutationFn = vi.fn().mockRejectedValue(error);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onErrorCallback = vi.fn();

      const { result } = renderHook(
        () => useAPIMutation(mutationFn, {
          onError: onErrorCallback,
        }),
        {
          wrapper: createWrapper(),
        }
      );

      const variables = { name: 'Test' };
      result.current.mutate(variables);

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(mutationFn).toHaveBeenCalledWith(variables);
      expect(consoleSpy).toHaveBeenCalledWith('API Mutation Error:', error);
      expect(onErrorCallback).toHaveBeenCalledWith(
        error,
        variables,
        undefined
      );

      consoleSpy.mockRestore();
    });

    it('should handle mutation with optimistic update', async () => {
      const mockData = { id: '1', updated: true };
      const mutationFn = vi.fn().mockResolvedValue(mockData);
      const onMutate = vi.fn().mockReturnValue({ previousData: 'old' });
      const onSettled = vi.fn();

      const { result } = renderHook(
        () => useAPIMutation(mutationFn, {
          onMutate,
          onSettled,
        }),
        {
          wrapper: createWrapper(),
        }
      );

      const variables = { id: '1', name: 'Updated' };
      result.current.mutate(variables);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(onMutate).toHaveBeenCalledWith(variables);
      expect(onSettled).toHaveBeenCalled();
    });

    it('should not call custom error handler if not provided', async () => {
      const error = new Error('Mutation failed');
      const mutationFn = vi.fn().mockRejectedValue(error);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(
        () => useAPIMutation(mutationFn),
        {
          wrapper: createWrapper(),
        }
      );

      result.current.mutate({ name: 'Test' });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(consoleSpy).toHaveBeenCalledWith('API Mutation Error:', error);

      consoleSpy.mockRestore();
    });
  });

  describe('Edge cases and integration', () => {
    it('should handle useGreeting with empty string name', () => {
      const mockUseQuery = vi.fn().mockReturnValue({ data: 'Hello!' });
      (api.hello.greeting.useQuery as any).mockImplementation(mockUseQuery);

      const { result } = renderHook(() => useGreeting(''), {
        wrapper: createWrapper(),
      });

      expect(mockUseQuery).toHaveBeenCalledWith({
        token: 'test-token',
        enabled: false, // Should be disabled for empty string
      });
      expect(result.current).toEqual({ data: 'Hello!' });
    });

    it('should handle useBackendStatus with undefined options', () => {
      const mockUseQuery = vi.fn().mockReturnValue({ data: { status: 'healthy' } });
      (api.hello.getStatus.useQuery as any).mockImplementation(mockUseQuery);

      const { result } = renderHook(() => useBackendStatus(undefined), {
        wrapper: createWrapper(),
      });

      expect(mockUseQuery).toHaveBeenCalled();
      expect(result.current).toEqual({ data: { status: 'healthy' } });
    });

    it('should handle useAPICall with stale time options', async () => {
      const mockData = { message: 'Cached' };
      const queryFn = vi.fn().mockResolvedValue(mockData);

      const { result } = renderHook(
        () => useAPICall(['cache-key'], queryFn, {
          staleTime: 5 * 60 * 1000, // 5 minutes
          cacheTime: 10 * 60 * 1000, // 10 minutes
        }),
        {
          wrapper: createWrapper(),
        }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(mockData);
    });

    it('should handle useAPIMutation with complex error scenarios', async () => {
      const networkError = new Error('Network request failed');
      (networkError as any).code = 'NETWORK_ERROR';
      
      const mutationFn = vi.fn().mockRejectedValue(networkError);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(
        () => useAPIMutation(mutationFn),
        {
          wrapper: createWrapper(),
        }
      );

      result.current.mutate({ data: 'test' });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBe(networkError);
      expect(result.current.error).toHaveProperty('code', 'NETWORK_ERROR');

      consoleSpy.mockRestore();
    });
  });
});