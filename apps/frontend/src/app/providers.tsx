'use client';

import React, { useState } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { SessionProvider } from 'next-auth/react';
import {
  ToastProvider,
  SessionProvider as CustomSessionProvider,
  LiveRegionProvider,
  TranslationProvider,
  ApiClientProvider,
  dispatch401Error,
  dispatch403Error,
} from '@semiont/react-ui';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary';
import { APIError } from '@semiont/api-client';
import { useSessionManager } from '@/hooks/useSessionManager';
import { useMergedTranslationManager } from '@/hooks/useMergedTranslationManager';
import { useApiClientManager } from '@/hooks/useApiClientManager';

/**
 * Create a minimal QueryClient with error handlers and retry logic
 * Authentication is handled by @semiont/api-client via lib/api-hooks
 */
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

/**
 * Root Provider Composition for Semiont Frontend
 *
 * Wires up GLOBAL contexts used across all routes.
 * Feature-specific providers (OpenResourcesProvider, CacheProvider, etc.) are added
 * in route-specific layouts (e.g., apps/frontend/src/app/[locale]/know/layout.tsx)
 *
 * Provider order matters - dependencies flow from outer to inner:
 *
 * 1. SessionProvider (NextAuth) - Authentication foundation
 * 2. AuthErrorBoundary - Error boundary for auth failures
 * 3. CustomSessionProvider - Session management and expiry tracking
 * 4. TranslationProvider - i18n translation management
 * 5. ApiClientProvider - API client configuration
 * 6. QueryClientProvider - React Query for data fetching
 * 7. ToastProvider - Toast notifications
 * 8. LiveRegionProvider - A11y live region announcements
 * 9. KeyboardShortcutsProvider - App-specific keyboard shortcuts
 */

/**
 * Inner providers that depend on SessionProvider being initialized
 * These hooks use next-auth's useSession internally, so they must be wrapped
 */
function InnerProviders({ children, queryClient }: { children: React.ReactNode; queryClient: QueryClient }) {
  // Manager hooks - these provide app-specific implementations to @semiont/react-ui contexts
  // These are called INSIDE SessionProvider because they use useSession()
  const sessionManager = useSessionManager();
  const translationManager = useMergedTranslationManager(); // Use merged manager for both frontend and react-ui translations
  const apiClientManager = useApiClientManager();

  return (
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
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Create QueryClient once per app instance
  const [queryClient] = useState(() => createQueryClient());

  return (
    <SessionProvider>
      <InnerProviders queryClient={queryClient}>
        {children}
      </InnerProviders>
    </SessionProvider>
  );
}