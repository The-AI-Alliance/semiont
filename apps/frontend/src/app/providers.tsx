'use client';

import React, { useState } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { SessionProvider } from 'next-auth/react';
import { ToastProvider } from '@/components/Toast';
import { SessionProvider as CustomSessionProvider } from '@/contexts/SessionContext';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { LiveRegionProvider } from '@/components/LiveRegion';
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary';
import { dispatch401Error, dispatch403Error } from '@/lib/auth-events';
import { APIError } from '@/lib/api-client';

// Create a minimal QueryClient with error handlers and retry logic
// Authentication is now handled per-request via useAuthenticatedAPI hook
function createQueryClient() {
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
        // No default queryFn - each query provides its own via useAuthenticatedAPI
        retry: (failureCount, error) => {
          // Don't retry on auth errors
          if (error instanceof APIError) {
            if (error.status === 401 || error.status === 403) {
              return false;
            }
          }
          return failureCount < 3;
        },
        staleTime: 5 * 60 * 1000, // 5 minutes
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Create QueryClient once per app instance
  const [queryClient] = useState(() => createQueryClient());

  return (
    <SessionProvider>
      <AuthErrorBoundary>
        <CustomSessionProvider>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <LiveRegionProvider>
                <KeyboardShortcutsProvider>
                  {children}
                </KeyboardShortcutsProvider>
              </LiveRegionProvider>
            </ToastProvider>
          </QueryClientProvider>
        </CustomSessionProvider>
      </AuthErrorBoundary>
    </SessionProvider>
  );
}