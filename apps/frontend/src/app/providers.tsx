'use client';

import React, { useState } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { SessionProvider, useSession } from 'next-auth/react';
import { ToastProvider } from '@/components/Toast';
import { SessionProvider as CustomSessionProvider } from '@/contexts/SessionContext';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { LiveRegionProvider } from '@/components/LiveRegion';
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary';
import { dispatch401Error, dispatch403Error } from '@/lib/auth-events';
import { APIError } from '@/lib/api-client';

// Create authenticated query client
function createAuthenticatedQueryClient(getToken: () => string | null) {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof APIError) {
          if (error.status === 401) {
            dispatch401Error('Your session has expired. Please sign in again.');
          } else if (error.status === 403) {
            dispatch403Error('You do not have permission to access this resource.');
          }
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (error instanceof APIError) {
          if (error.status === 401) {
            dispatch401Error('Your session has expired. Please sign in again.');
          } else if (error.status === 403) {
            dispatch403Error('You do not have permission to perform this action.');
          }
        }
      },
    }),
    defaultOptions: {
      queries: {
        // Default queryFn that automatically adds auth header
        queryFn: async ({ queryKey }) => {
          const [url, ...params] = queryKey as [string, ...any[]];
          const token = getToken();

          // Build full URL
          const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
          const fullUrl = `${baseUrl}${url}`;

          // Make authenticated request
          const headers: HeadersInit = {
            'Content-Type': 'application/json',
          };

          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
          }

          const response = await fetch(fullUrl, { headers });

          if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: errorText };
            }
            throw new APIError(response.status, errorData);
          }

          return response.json();
        },
        retry: (failureCount, error) => {
          if (error instanceof APIError) {
            if (error.status === 401 || error.status === 403) {
              return false;
            }
          }
          return failureCount < 3;
        },
        staleTime: 5 * 60 * 1000,
      },
    },
  });
}

// Wrapper that provides session token to query client
function QueryClientProviderWithAuth({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();

  // Create query client with current session token
  const [queryClient] = useState(() =>
    createAuthenticatedQueryClient(() => session?.backendToken || null)
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <AuthErrorBoundary>
        <CustomSessionProvider>
          <QueryClientProviderWithAuth>
            <ToastProvider>
              <LiveRegionProvider>
                <KeyboardShortcutsProvider>
                  {children}
                </KeyboardShortcutsProvider>
              </LiveRegionProvider>
            </ToastProvider>
          </QueryClientProviderWithAuth>
        </CustomSessionProvider>
      </AuthErrorBoundary>
    </SessionProvider>
  );
}