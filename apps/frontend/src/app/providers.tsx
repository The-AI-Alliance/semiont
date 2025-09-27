'use client';

import React, { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { SessionProvider, useSession } from 'next-auth/react';
import { useSecureAPI } from '@/hooks/useSecureAPI';
import { ToastProvider } from '@/components/Toast';
import { SessionProvider as CustomSessionProvider } from '@/contexts/SessionContext';
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary';
import { dispatch401Error, dispatch403Error } from '@/lib/auth-events';
import { APIError } from '@/lib/api-client';

// Separate component to use the secure API hook
function SecureAPIProvider({ children }: { children: React.ReactNode }) {
  // This hook automatically manages API authentication
  useSecureAPI();
  const { status } = useSession();

  // Block rendering until we know if we have auth or not
  // This prevents any child components from making API calls before auth is set up
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-600 dark:text-gray-300">Loading authentication...</p>
      </div>
    );
  }

  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        // Handle 401 errors from queries globally
        if (error instanceof APIError) {
          if (error.status === 401) {
            // Clear cache and dispatch event for modal
            queryClient.clear();
            dispatch401Error('Your session has expired. Please sign in again.');
          } else if (error.status === 403) {
            dispatch403Error('You do not have permission to access this resource.');
          }
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        // Handle 401 errors from mutations globally (backup for useApiWithAuth)
        if (error instanceof APIError) {
          if (error.status === 401) {
            // Clear cache and dispatch event for modal
            queryClient.clear();
            dispatch401Error('Your session has expired. Please sign in again.');
          } else if (error.status === 403) {
            dispatch403Error('You do not have permission to perform this action.');
          }
        }
      },
    }),
    defaultOptions: {
      queries: {
        // Security: Don't retry on 401/403 errors
        retry: (failureCount, error) => {
          if (error instanceof APIError) {
            if (error.status === 401 || error.status === 403) {
              return false;
            }
          }
          return failureCount < 3;
        },
        // Stale time for security-sensitive data
        staleTime: 5 * 60 * 1000, // 5 minutes
      },
    },
  }));

  return (
    <SessionProvider>
      <AuthErrorBoundary>
        <CustomSessionProvider>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <SecureAPIProvider>
                {children}
              </SecureAPIProvider>
            </ToastProvider>
          </QueryClientProvider>
        </CustomSessionProvider>
      </AuthErrorBoundary>
    </SessionProvider>
  );
}