import React, { useState } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import {
  ToastProvider,
  LiveRegionProvider,
  TranslationProvider,
  ThemeProvider,
  EventBusProvider,
  notifySessionExpired,
  notifyPermissionDenied,
} from '@semiont/react-ui';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { NavigationHandler } from '@/components/knowledge/NavigationHandler';
import { APIError } from '@semiont/api-client';
import { useMergedTranslationManager } from '@/hooks/useMergedTranslationManager';

/**
 * Create a minimal QueryClient with error handlers and retry logic.
 * Authentication is handled by @semiont/api-client via lib/api-hooks.
 *
 * SAFETY NET — the handlers below run only when the api-client's
 * `tokenRefresher` did NOT recover a 401. Two cases:
 *
 *   1. The api-client that issued the request has no `tokenRefresher`
 *      configured. KnowledgeBasePanel's bootstrap auth calls go through
 *      a fresh client without a refresher, so a 401 from those reaches
 *      this handler directly. (Bootstrap calls shouldn't 401 in normal
 *      operation, but this handler keeps us covered if they do.)
 *
 *   2. The refresh attempt itself failed. In that case `refreshActive`
 *      already set `sessionExpiredAt` BEFORE the 401 propagated, so the
 *      `notifySessionExpired` call here is idempotent — it just sets the
 *      same flag that's already set.
 *
 * Don't delete this handler — case (1) is still real. But understand that
 * for the protected-layout flows (the bulk of the app), it almost never
 * fires because the api-client's beforeRetry hook handles 401s transparently.
 *
 * 401/403 errors route through module-scoped notify functions registered by
 * the active KnowledgeBaseSessionProvider (mounted inside the protected
 * AuthShell). On pre-app routes where no provider is mounted, the calls are
 * no-ops.
 */
function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof APIError) {
          if (error.status === 401) {
            notifySessionExpired('Your session has expired. Please sign in again.');
          } else if (error.status === 403) {
            notifyPermissionDenied('You do not have permission to access this resource.');
          }
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (error instanceof APIError) {
          if (error.status === 401) {
            notifySessionExpired('Your session has expired. Please sign in again.');
          } else if (error.status === 403) {
            notifyPermissionDenied('You do not have permission to perform this action.');
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
 * Root Provider Composition for Semiont Frontend.
 *
 * Wires up GLOBAL contexts that every page needs — auth-independent.
 *
 * Auth-dependent providers (KnowledgeBaseSessionProvider, ProtectedErrorBoundary,
 * SessionExpiredModal, PermissionDeniedModal) are bundled in `AuthShell` and
 * mounted only in protected layouts (know/, admin/, moderate/, auth/welcome/).
 * Pre-app routes (landing, OAuth flow) intentionally do NOT mount AuthShell —
 * they have no need to validate JWTs.
 *
 * ApiClientProvider is added in feature-specific layouts (e.g. /know) that
 * require API access. Public pages don't need it.
 *
 * Provider order — outer to inner:
 * 1. TranslationProvider     — i18n
 * 2. QueryClientProvider     — React Query
 * 3. ToastProvider           — toast notifications
 * 4. LiveRegionProvider      — a11y live region
 * 5. KeyboardShortcutsProvider — keyboard shortcuts
 * 6. ThemeProvider           — theme
 * 7. EventBusProvider        — RxJS event bus
 *    + NavigationHandler
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());
  const translationManager = useMergedTranslationManager();

  return (
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
  );
}
