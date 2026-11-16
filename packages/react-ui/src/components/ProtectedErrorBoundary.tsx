import React from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import './ProtectedErrorBoundary.css';

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
  // react-error-boundary v6 types `error` as `unknown` — a thrown value can be
  // anything, so narrow before reading Error fields.
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return (
    <div className="semiont-protected-error-boundary-container">
      <div className="semiont-protected-error-boundary-card">
        <div className="semiont-protected-error-boundary-header">
          <div className="semiont-protected-error-boundary-icon-wrapper">
            <svg className="semiont-protected-error-boundary-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="semiont-protected-error-boundary-title">
            Something went wrong
          </h2>
        </div>

        <p className="semiont-protected-error-boundary-message">
          An unexpected error occurred. Try again, or refresh the page.
        </p>

        {process.env.NODE_ENV === 'development' && (
          <details className="semiont-protected-error-boundary-details">
            <summary className="semiont-protected-error-boundary-summary">
              Error details (development only)
            </summary>
            <pre className="semiont-protected-error-boundary-stack">
              {message}
              {stack}
            </pre>
          </details>
        )}

        <div className="semiont-protected-error-boundary-actions">
          <button
            onClick={resetErrorBoundary}
            className="semiont-button"
            data-variant="secondary"
            data-size="md"
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="semiont-button"
            data-variant="primary"
            data-size="md"
          >
            Refresh Page
          </button>
        </div>
      </div>
    </div>
  );
}
