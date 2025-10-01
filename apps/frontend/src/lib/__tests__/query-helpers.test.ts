import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useAuthenticatedQuery, useAuthenticatedMutation, useAuthenticatedQueryWithParams } from '../query-helpers';

// Mock useAuthenticatedAPI
vi.mock('@/hooks/useAuthenticatedAPI', () => ({
  useAuthenticatedAPI: vi.fn(),
}));

import { useAuthenticatedAPI as mockUseAuthenticatedAPIImport } from '@/hooks/useAuthenticatedAPI';
const mockUseAuthenticatedAPI = vi.mocked(mockUseAuthenticatedAPIImport);

describe('query-helpers', () => {
  let queryClient: QueryClient;
  let wrapper: React.FC<{ children: React.ReactNode }>;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
  });

  describe('useAuthenticatedQuery', () => {
    it('should execute query when authenticated', async () => {
      const mockFetchAPI = vi.fn().mockResolvedValue({ data: 'test' });
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: true,
      });

      const { result } = renderHook(
        () => useAuthenticatedQuery(['/api/test'], '/api/test'),
        { wrapper }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetchAPI).toHaveBeenCalledWith('/api/test');
      expect(result.current.data).toEqual({ data: 'test' });
    });

    it('should not execute query when not authenticated', () => {
      const mockFetchAPI = vi.fn();
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: false,
      });

      const { result } = renderHook(
        () => useAuthenticatedQuery(['/api/test'], '/api/test'),
        { wrapper }
      );

      expect(mockFetchAPI).not.toHaveBeenCalled();
      expect(result.current.isLoading).toBe(true);
      expect(result.current.fetchStatus).toBe('idle');
    });

    it('should allow enabled override to force execution', async () => {
      const mockFetchAPI = vi.fn().mockResolvedValue({ data: 'test' });
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: false,
      });

      const { result } = renderHook(
        () => useAuthenticatedQuery(['/api/test'], '/api/test', { enabled: true }),
        { wrapper }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockFetchAPI).toHaveBeenCalledWith('/api/test');
    });

    it('should allow enabled override to prevent execution', () => {
      const mockFetchAPI = vi.fn();
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: true,
      });

      const { result } = renderHook(
        () => useAuthenticatedQuery(['/api/test'], '/api/test', { enabled: false }),
        { wrapper }
      );

      expect(mockFetchAPI).not.toHaveBeenCalled();
      expect(result.current.isLoading).toBe(true);
      expect(result.current.fetchStatus).toBe('idle');
    });

    it('should handle query errors', async () => {
      const mockError = new Error('Test error');
      const mockFetchAPI = vi.fn().mockRejectedValue(mockError);
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: true,
      });

      const { result } = renderHook(
        () => useAuthenticatedQuery(['/api/test'], '/api/test'),
        { wrapper }
      );

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBe(mockError);
    });
  });

  describe('useAuthenticatedMutation', () => {
    it('should execute mutation with fetchAPI', async () => {
      const mockFetchAPI = vi.fn().mockResolvedValue({ success: true });
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: true,
      });

      const mutationFn = vi.fn((variables: { name: string }, fetchAPI) =>
        fetchAPI('/api/test', {
          method: 'POST',
          body: JSON.stringify(variables),
        })
      );

      const { result } = renderHook(
        () => useAuthenticatedMutation(mutationFn),
        { wrapper }
      );

      result.current.mutate({ name: 'test' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mutationFn).toHaveBeenCalledWith({ name: 'test' }, mockFetchAPI);
      expect(mockFetchAPI).toHaveBeenCalledWith('/api/test', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      });
      expect(result.current.data).toEqual({ success: true });
    });

    it('should handle mutation errors', async () => {
      const mockError = new Error('Mutation error');
      const mockFetchAPI = vi.fn().mockRejectedValue(mockError);
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: true,
      });

      const mutationFn = vi.fn((variables: any, fetchAPI) =>
        fetchAPI('/api/test')
      );

      const { result } = renderHook(
        () => useAuthenticatedMutation(mutationFn),
        { wrapper }
      );

      result.current.mutate({ data: 'test' });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBe(mockError);
    });

    it('should call onSuccess callback', async () => {
      const mockFetchAPI = vi.fn().mockResolvedValue({ success: true });
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: true,
      });

      const onSuccess = vi.fn();
      const mutationFn = vi.fn((variables: any, fetchAPI) => fetchAPI('/api/test'));

      const { result } = renderHook(
        () => useAuthenticatedMutation(mutationFn, { onSuccess }),
        { wrapper }
      );

      result.current.mutate({ data: 'test' });

      await waitFor(() => expect(onSuccess).toHaveBeenCalled());

      expect(onSuccess).toHaveBeenCalledWith(
        { success: true },
        { data: 'test' },
        undefined
      );
    });
  });

  describe('useAuthenticatedQueryWithParams', () => {
    it('should build URL from query key params', async () => {
      const mockFetchAPI = vi.fn().mockResolvedValue({ data: 'test' });
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: true,
      });

      const urlBuilder = vi.fn((params) => `/api/documents/${params[1]}`);

      const { result } = renderHook(
        () => useAuthenticatedQueryWithParams(
          ['/api/documents', 'doc-123'],
          urlBuilder
        ),
        { wrapper }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(urlBuilder).toHaveBeenCalledWith(['/api/documents', 'doc-123']);
      expect(mockFetchAPI).toHaveBeenCalledWith('/api/documents/doc-123');
      expect(result.current.data).toEqual({ data: 'test' });
    });

    it('should respect enabled option', () => {
      const mockFetchAPI = vi.fn();
      mockUseAuthenticatedAPI.mockReturnValue({
        fetchAPI: mockFetchAPI,
        isAuthenticated: true,
      });

      const urlBuilder = (params: any) => `/api/documents/${params[1]}`;

      const { result } = renderHook(
        () => useAuthenticatedQueryWithParams(
          ['/api/documents', 'doc-123'],
          urlBuilder,
          { enabled: false }
        ),
        { wrapper }
      );

      expect(mockFetchAPI).not.toHaveBeenCalled();
      expect(result.current.isLoading).toBe(true);
    });
  });
});
