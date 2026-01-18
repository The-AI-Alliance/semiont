'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Generic Error Boundary component that catches JavaScript errors
 * in child components and displays a fallback UI.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log error to console in development
    if (process.env.NODE_ENV === 'development') {
      console.error('ErrorBoundary caught an error:', error, errorInfo);
    }

    // Call custom error handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // Update state with error info
    this.setState({
      errorInfo,
    });

    // In production, you might want to log to an error reporting service
    // Example: logErrorToService(error, errorInfo);
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  override render() {
    if (this.state.hasError && this.state.error) {
      // Custom fallback UI
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset);
      }

      // Default fallback UI
      return <DefaultErrorFallback error={this.state.error} reset={this.handleReset} />;
    }

    return this.props.children;
  }
}

/**
 * Default error fallback component
 */
function DefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="semiont-error-boundary-container">
      <div className="semiont-error-boundary-content">
        <div className="semiont-error-boundary-header">
          <h2 className="semiont-error-boundary-title">
            Oops! Something went wrong
          </h2>
          <p className="semiont-error-boundary-message">
            We encountered an unexpected error. Please try again.
          </p>
        </div>

        {process.env.NODE_ENV === 'development' && (
          <div className="semiont-error-boundary-details">
            <h3 className="semiont-error-boundary-details-title">
              Error Details (Development Only)
            </h3>
            <p className="semiont-error-boundary-details-message">
              {error.message}
            </p>
            {error.stack && (
              <pre className="semiont-error-boundary-stack">
                {error.stack}
              </pre>
            )}
          </div>
        )}

        <div className="semiont-error-boundary-actions">
          <button
            onClick={reset}
            className="semiont-button"
            data-variant="primary"
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.href = '/'}
            className="semiont-button"
            data-variant="secondary"
          >
            Go Home
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Specialized error boundary for async components
 */
export function AsyncErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div className="semiont-async-error-boundary">
          <div className="semiont-async-error-content">
            <div className="semiont-async-error-icon">
              <svg className="semiont-icon-warning" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="semiont-async-error-details">
              <h3 className="semiont-async-error-title">
                Failed to load this section
              </h3>
              <p className="semiont-async-error-message">
                {error.message || 'An unexpected error occurred'}
              </p>
              <button
                onClick={reset}
                className="semiont-async-error-retry"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}