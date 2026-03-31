import React, { useState } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import {
  ToastProvider,
  SessionProvider as CustomSessionProvider,
  LiveRegionProvider,
  TranslationProvider,
  ThemeProvider,
  EventBusProvider,
  dispatch401Error,
  dispatch403Error,
} from '@semiont/react-ui';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { NavigationHandler } from '@/components/knowledge/NavigationHandler';
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary';
import { APIError } from '@semiont/api-client';
import { AuthProvider } from '@/contexts/AuthContext';
import { KnowledgeBaseProvider, useKnowledgeBaseContext } from '@/contexts/KnowledgeBaseContext';
import { useSessionManager } from '@/hooks/useSessionManager';
import { useMergedTranslationManager } from '@/hooks/useMergedTranslationManager';

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
 * 1. AuthProvider - JWT cookie authentication context
 * 2. AuthErrorBoundary - Error boundary for auth failures
 * 3. TranslationProvider - i18n translation management
 * 4. ApiClientProvider - API client configuration
 * 5. QueryClientProvider - React Query for data fetching
 * 6. ToastProvider - Toast notifications
 * 7. LiveRegionProvider - A11y live region announcements
 * 8. KeyboardShortcutsProvider - App-specific keyboard shortcuts
 */

/**
 * Inner providers that depend on AuthProvider being initialized
 */
function InnerProviders({ children, queryClient }: { children: React.ReactNode; queryClient: QueryClient }) {
  // Manager hooks - these provide app-specific implementations to @semiont/react-ui contexts
  const sessionManager = useSessionManager();
  const translationManager = useMergedTranslationManager(); // Use merged manager for both frontend and react-ui translations

  // Note: ApiClientProvider is NOT here - it's added in feature-specific layouts (e.g., /know)
  // that require authentication. Public pages don't need API access.
  return (
    <AuthErrorBoundary>
      <CustomSessionProvider sessionManager={sessionManager}>
        <TranslationProvider translationManager={translationManager}>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <LiveRegionProvider>
                <KeyboardShortcutsProvider>
                  <ThemeProvider>
                    <EventBusProvider>
                      <NavigationHandler />
                      {children}
                    </EventBusProvider>
                  </ThemeProvider>
                </KeyboardShortcutsProvider>
              </LiveRegionProvider>
            </ToastProvider>
          </QueryClientProvider>
        </TranslationProvider>
      </CustomSessionProvider>
    </AuthErrorBoundary>
  );
}

function KnowledgeBaseAuthBridge({ children, queryClient }: { children: React.ReactNode; queryClient: QueryClient }) {
  const { activeKnowledgeBase } = useKnowledgeBaseContext();
  if (!activeKnowledgeBase) {
    // No knowledge base configured yet. Render inner providers (routing, i18n, etc.) but skip
    // AuthProvider — there is no backend URL to authenticate against. KnowledgeLayout will
    // redirect to /auth/connect when the user navigates to /know.
    return (
      <InnerProviders queryClient={queryClient}>
        {children}
      </InnerProviders>
    );
  }
  return (
    <AuthProvider key={activeKnowledgeBase.id} backendUrl={activeKnowledgeBase.backendUrl}>
      <InnerProviders queryClient={queryClient}>
        {children}
      </InnerProviders>
    </AuthProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Create QueryClient once per app instance
  const [queryClient] = useState(() => createQueryClient());

  return (
    <KnowledgeBaseProvider>
      <KnowledgeBaseAuthBridge queryClient={queryClient}>
        {children}
      </KnowledgeBaseAuthBridge>
    </KnowledgeBaseProvider>
  );
}