'use client';

import { useMutation, useQueryClient, UseMutationOptions } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/Toast';
import { dispatch401Error, dispatch403Error } from '@/lib/auth-events';

interface ApiCallOptions {
  route: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: any;
  params?: Record<string, any>;
}

interface ApiError extends Error {
  status?: number;
  code?: string;
}

/**
 * Hook for making authenticated API calls with proper error handling
 * Automatically handles 401 errors and session expiry
 */
export function useApiWithAuth<TData = any, TError = ApiError>(
  options?: Omit<UseMutationOptions<TData, TError, ApiCallOptions>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  const { data: session, status } = useSession();
  const router = useRouter();
  const { showError } = useToast();

  return useMutation<TData, TError, ApiCallOptions>({
    mutationFn: async ({ route, method, body, params }) => {
      // Check if we have a session before making the call
      if (status === 'unauthenticated') {
        throw new Error('Not authenticated');
      }

      // Wait for session to load
      if (status === 'loading') {
        throw new Error('Session loading, please wait...');
      }

      // Make the API call directly using fetch with auth header
      const token = session?.backendToken;
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const url = new URL(route, process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000');
      if (params) {
        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined) {
            url.searchParams.append(key, String(value));
          }
        });
      }

      const fetchOptions: RequestInit = {
        method,
        headers,
      };

      if (body && method !== 'GET') {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(url.toString(), fetchOptions);

      if (!response.ok) {
        const error = new Error(`API Error: ${response.status}`) as ApiError;
        error.status = response.status;
        throw error;
      }

      return response.json();
    },
    onError: (error: TError) => {
      const apiError = error as ApiError;

      // Handle 401 Unauthorized - session expired
      if (apiError.status === 401) {
        // Invalidate all queries since we're no longer authenticated
        queryClient.clear();

        // Show error notification
        showError('Your session has expired. Please sign in again.');

        // Dispatch event to trigger SessionExpiredModal
        dispatch401Error('Your session has expired. Please sign in again.');
      }
      // Handle 403 Forbidden - insufficient permissions
      else if (apiError.status === 403) {
        showError('You do not have permission to perform this action.');

        // Dispatch event for potential future handling
        dispatch403Error('You do not have permission to perform this action.');
      }
      // Handle network errors
      else if (!apiError.status) {
        showError('Network error. Please check your connection.');
      }

      // Call any additional error handler passed in options
      options?.onError?.(error, { route: '', method: 'GET' }, undefined);
    },
    ...options
  });
}

/**
 * Hook for making authenticated queries with automatic refetch on auth change
 */
export function useAuthenticatedQuery<TData = any>(
  queryKey: any[],
  queryFn: () => Promise<TData>,
  options?: any
) {
  const { status } = useSession();

  return {
    queryKey: [...queryKey, status], // Include auth status in key
    queryFn,
    enabled: status === 'authenticated' && (options?.enabled ?? true),
    retry: (failureCount: number, error: any) => {
      // Don't retry on auth errors
      if (error?.status === 401 || error?.status === 403) {
        return false;
      }
      // Default retry logic
      return failureCount < 3;
    },
    ...options
  };
}