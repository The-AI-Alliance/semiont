'use client';

import React, { useState } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { SessionProvider } from 'next-auth/react';
import { ToastProvider, SessionProvider as CustomSessionProvider, LiveRegionProvider, TranslationProvider, ApiClientProvider } from '@semiont/react-ui';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary';
import { dispatch401Error, dispatch403Error } from '@semiont/react-ui';
import { APIError } from '@semiont/api-client';
import { useSessionManager } from '@/hooks/useSessionManager';
import { useTranslationManager } from '@/hooks/useTranslationManager';
import { useApiClientManager } from '@/hooks/useApiClientManager';

// Create a minimal QueryClient with error handlers and retry logic
// Authentication is handled by @semiont/api-client via lib/api-hooks
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
        // No default queryFn - each query uses @semiont/api-client via lib/api-hooks
        retry: (failureCount, error) => {
          // Don't retry on client errors (4xx) - these won't fix themselves
          if (error instanceof APIError) {
            // Never retry auth errors
            if (error.status === 401 || error.status === 403) {
              return false;
            }
            // Never retry other client errors (400, 404, 422, etc.)
            if (error.status >= 400 && error.status < 500) {
              return false;
            }
          }
          // Only retry server errors (5xx) or network errors, max 3 times
          return failureCount < 3;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff: 1s, 2s, 4s, max 30s
        staleTime: 5 * 60 * 1000, // 5 minutes
        refetchOnWindowFocus: false, // Prevent unnecessary refetches when window regains focus
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Create QueryClient once per app instance
  const [queryClient] = useState(() => createQueryClient());
  const sessionManager = useSessionManager();
  const translationManager = useTranslationManager();
  const apiClientManager = useApiClientManager();

  return (
    <SessionProvider>
      <AuthErrorBoundary>
        <CustomSessionProvider sessionManager={sessionManager}>
          <TranslationProvider translationManager={translationManager}>
            <ApiClientProvider apiClientManager={apiClientManager}>
              <QueryClientProvider client={queryClient}>
                <ToastProvider>
                  <LiveRegionProvider>
                    <KeyboardShortcutsProvider>
                      {children}
                    </KeyboardShortcutsProvider>
                  </LiveRegionProvider>
                </ToastProvider>
              </QueryClientProvider>
            </ApiClientProvider>
          </TranslationProvider>
        </CustomSessionProvider>
      </AuthErrorBoundary>
    </SessionProvider>
  );
}