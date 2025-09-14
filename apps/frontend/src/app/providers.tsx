'use client';

import React, { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from 'next-auth/react';
import { useSecureAPI } from '@/hooks/useSecureAPI';
import { ToastProvider } from '@/components/Toast';

// Separate component to use the secure API hook
function SecureAPIProvider({ children }: { children: React.ReactNode }) {
  // This hook automatically manages API authentication
  useSecureAPI();
  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        // Security: Don't retry on 401/403 errors
        retry: (failureCount, error) => {
          if (error instanceof Error) {
            const message = error.message.toLowerCase();
            if (message.includes('401') || message.includes('403') || message.includes('unauthorized')) {
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
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SecureAPIProvider>
            {children}
          </SecureAPIProvider>
        </ToastProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}