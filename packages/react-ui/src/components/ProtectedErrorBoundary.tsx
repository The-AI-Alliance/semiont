import React from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';

interface ProtectedErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * Values that, when any change, reset the boundary back to its non-error
   * state. Apps typically pass `[location.pathname]` so navigating away from
   * a crashed page automatically recovers.
   */
  resetKeys?: unknown[];
}

/**
 * Error boundary for protected (authenticated) routes.
 *
 * Catches unexpected render-time crashes inside the protected tree and
 * shows a generic "something went wrong" fallback with a refresh option.
 *
 * NOT auth-specific. Auth state changes (sign-in, sign-out, expiry) flow
 * through the KnowledgeBaseSession context, not exceptions — so this
 * boundary will never catch an "auth error" in normal operation. Its job
 * is purely to keep a render bug from blanking the screen.
 *
 * The optional `resetKeys` prop lets callers wire automatic recovery on
 * navigation (e.g. `resetKeys={[location.pathname]}`).
 */
export function ProtectedErrorBoundary({
  children,
  resetKeys,
}: ProtectedErrorBoundaryProps) {
  return (
    <ErrorBoundary
      FallbackComponent={ProtectedErrorFallback}
      onError={(error, info) => {
        if (process.env.NODE_ENV === 'development') {
          console.error('ProtectedErrorBoundary caught:', error, info);
        }
      }}
      {...(resetKeys && { resetKeys })}
    >
      {children}
    </ErrorBoundary>
  );
}

function ProtectedErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="min-h-[400px] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-shrink-0 w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
            <svg className="w-6 h-6 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            Something went wrong
          </h2>
        </div>

        <p className="text-gray-600 dark:text-gray-300 mb-6">
          An unexpected error occurred. Try again, or refresh the page.
        </p>

        {process.env.NODE_ENV === 'development' && (
          <details className="mb-4">
            <summary className="text-sm text-gray-500 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
              Error details (development only)
            </summary>
            <pre className="mt-2 text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded-sm overflow-auto">
              {error.message}
              {error.stack}
            </pre>
          </details>
        )}

        <div className="flex gap-3">
          <button
            onClick={resetErrorBoundary}
            className="flex-1 px-4 py-2 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Refresh Page
          </button>
        </div>
      </div>
    </div>
  );
}
