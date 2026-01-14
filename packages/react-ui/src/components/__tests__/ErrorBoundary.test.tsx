import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ErrorBoundary, AsyncErrorBoundary } from '../ErrorBoundary';

// Component that throws an error
function ThrowError({ shouldThrow = false, message = 'Test error' }: { shouldThrow?: boolean; message?: string }) {
  if (shouldThrow) {
    throw new Error(message);
  }
  return <div>No error</div>;
}

// Suppress console.error for cleaner test output
const originalError = console.error;

describe('ErrorBoundary Component', () => {
  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalError;
  });

  describe('Normal Rendering', () => {
    it('should render children when no error occurs', () => {
      render(
        <ErrorBoundary>
          <div>Test Content</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Test Content')).toBeInTheDocument();
    });

    it('should render multiple children when no error occurs', () => {
      render(
        <ErrorBoundary>
          <div>Child 1</div>
          <div>Child 2</div>
          <div>Child 3</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Child 1')).toBeInTheDocument();
      expect(screen.getByText('Child 2')).toBeInTheDocument();
      expect(screen.getByText('Child 3')).toBeInTheDocument();
    });

    it('should render nested components when no error occurs', () => {
      render(
        <ErrorBoundary>
          <div>
            <span>Nested content</span>
          </div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Nested content')).toBeInTheDocument();
    });
  });

  describe('Error Catching', () => {
    it('should catch and display default fallback UI when error occurs', () => {
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
      expect(screen.getByText('We encountered an unexpected error. Please try again.')).toBeInTheDocument();
    });

    it('should display error message in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message="Custom error message" />
        </ErrorBoundary>
      );

      expect(screen.getByText('Error Details (Development Only)')).toBeInTheDocument();
      expect(screen.getByText('Custom error message')).toBeInTheDocument();

      process.env.NODE_ENV = originalEnv;
    });

    it('should not display error details in production mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message="Production error" />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Error Details (Development Only)')).not.toBeInTheDocument();
      expect(screen.queryByText('Production error')).not.toBeInTheDocument();

      process.env.NODE_ENV = originalEnv;
    });

    it('should display error stack in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      // Stack trace should be present
      const preElement = screen.getByText('Error Details (Development Only)').parentElement?.querySelector('pre');
      expect(preElement).toBeInTheDocument();

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Custom Fallback', () => {
    it('should render custom fallback when provided', () => {
      const customFallback = (error: Error, reset: () => void) => (
        <div>
          <h1>Custom Error UI</h1>
          <p>{error.message}</p>
          <button onClick={reset}>Custom Reset</button>
        </div>
      );

      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowError shouldThrow={true} message="Custom fallback error" />
        </ErrorBoundary>
      );

      expect(screen.getByText('Custom Error UI')).toBeInTheDocument();
      expect(screen.getByText('Custom fallback error')).toBeInTheDocument();
      expect(screen.getByText('Custom Reset')).toBeInTheDocument();
    });

    it('should not render default fallback when custom fallback is provided', () => {
      const customFallback = (error: Error) => <div>Custom Fallback</div>;

      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Oops! Something went wrong')).not.toBeInTheDocument();
      expect(screen.getByText('Custom Fallback')).toBeInTheDocument();
    });
  });

  describe('Error Handler Callback', () => {
    it('should call onError callback when error occurs', () => {
      const onError = vi.fn();

      render(
        <ErrorBoundary onError={onError}>
          <ThrowError shouldThrow={true} message="Callback test error" />
        </ErrorBoundary>
      );

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Callback test error' }),
        expect.objectContaining({ componentStack: expect.any(String) })
      );
    });

    it('should not call onError callback when no error occurs', () => {
      const onError = vi.fn();

      render(
        <ErrorBoundary onError={onError}>
          <div>No error</div>
        </ErrorBoundary>
      );

      expect(onError).not.toHaveBeenCalled();
    });

    it('should log error to console in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      const consoleErrorSpy = vi.spyOn(console, 'error');

      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message="Console test error" />
        </ErrorBoundary>
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'ErrorBoundary caught an error:',
        expect.objectContaining({ message: 'Console test error' }),
        expect.objectContaining({ componentStack: expect.any(String) })
      );

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Reset Functionality', () => {
    it('should render Try Again button in error state', () => {
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
      expect(screen.getByText('Try Again')).toBeInTheDocument();
    });

    it('should call custom reset handler in custom fallback', () => {
      const resetHandler = vi.fn();
      const customFallback = (error: Error, reset: () => void) => (
        <div>
          <button onClick={() => { resetHandler(); reset(); }}>Reset</button>
        </div>
      );

      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      const resetButton = screen.getByText('Reset');
      fireEvent.click(resetButton);

      expect(resetHandler).toHaveBeenCalledOnce();
    });

    it('should clear error state when reset is called', () => {
      let resetFn: (() => void) | null = null;
      const customFallback = (error: Error, reset: () => void) => {
        resetFn = reset;
        return <div>Error: {error.message}</div>;
      };

      const { rerender } = render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowError shouldThrow={true} message="Initial error" />
        </ErrorBoundary>
      );

      expect(screen.getByText('Error: Initial error')).toBeInTheDocument();
      expect(resetFn).not.toBeNull();

      // Call reset
      if (resetFn) {
        resetFn();
      }

      // Rerender with non-throwing component after reset
      rerender(
        <ErrorBoundary fallback={customFallback}>
          <div>No error</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('No error')).toBeInTheDocument();
    });
  });

  describe('Go Home Button', () => {
    it('should render Go Home button in default fallback', () => {
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      expect(screen.getByText('Go Home')).toBeInTheDocument();
    });

    it('should navigate to home when Go Home button clicked', () => {
      const originalLocation = window.location;
      delete (window as any).location;
      window.location = { href: '' } as any;

      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      const goHomeButton = screen.getByText('Go Home');
      fireEvent.click(goHomeButton);

      expect(window.location.href).toBe('/');

      window.location = originalLocation;
    });
  });

  describe('Default Fallback Styling', () => {
    it('should have proper styling classes', () => {
      const { container } = render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      const wrapper = container.querySelector('.semiont-error-boundary');
      expect(wrapper).toBeInTheDocument();
      expect(wrapper).toHaveClass('semiont-error-boundary');
    });

    it('should have proper button styling', () => {
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );

      const tryAgainButton = screen.getByText('Try Again');
      expect(tryAgainButton).toHaveClass('semiont-button', 'semiont-button--primary');

      const goHomeButton = screen.getByText('Go Home');
      expect(goHomeButton).toHaveClass('semiont-button', 'semiont-button--secondary');
    });
  });

  describe('Edge Cases', () => {
    it('should handle error with no message', () => {
      function ThrowEmptyError() {
        throw new Error();
      }

      render(
        <ErrorBoundary>
          <ThrowEmptyError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
    });

    it('should handle multiple errors from different children', () => {
      const { rerender } = render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message="First error" />
        </ErrorBoundary>
      );

      expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();

      const resetButton = screen.getByText('Try Again');
      fireEvent.click(resetButton);

      rerender(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message="Second error" />
        </ErrorBoundary>
      );

      expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
    });

    it('should handle error with long message', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const longMessage = 'A'.repeat(1000);

      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message={longMessage} />
        </ErrorBoundary>
      );

      expect(screen.getByText(longMessage)).toBeInTheDocument();

      process.env.NODE_ENV = originalEnv;
    });
  });
});

describe('AsyncErrorBoundary Component', () => {
  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalError;
  });

  describe('Normal Rendering', () => {
    it('should render children when no error occurs', () => {
      render(
        <AsyncErrorBoundary>
          <div>Async Content</div>
        </AsyncErrorBoundary>
      );

      expect(screen.getByText('Async Content')).toBeInTheDocument();
    });
  });

  describe('Error Catching', () => {
    it('should catch and display async-specific fallback UI', () => {
      render(
        <AsyncErrorBoundary>
          <ThrowError shouldThrow={true} message="Async error" />
        </AsyncErrorBoundary>
      );

      expect(screen.getByText('Failed to load this section')).toBeInTheDocument();
      expect(screen.getByText('Async error')).toBeInTheDocument();
    });

    it('should display retry button', () => {
      render(
        <AsyncErrorBoundary>
          <ThrowError shouldThrow={true} />
        </AsyncErrorBoundary>
      );

      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('should handle error with no message', () => {
      function ThrowEmptyError() {
        throw new Error();
      }

      render(
        <AsyncErrorBoundary>
          <ThrowEmptyError />
        </AsyncErrorBoundary>
      );

      expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
    });
  });

  describe('Reset Functionality', () => {
    it('should render Retry button in error state', () => {
      render(
        <AsyncErrorBoundary>
          <ThrowError shouldThrow={true} />
        </AsyncErrorBoundary>
      );

      expect(screen.getByText('Failed to load this section')).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('should be clickable without errors', () => {
      render(
        <AsyncErrorBoundary>
          <ThrowError shouldThrow={true} />
        </AsyncErrorBoundary>
      );

      const retryButton = screen.getByText('Retry');

      // Clicking should not throw
      expect(() => fireEvent.click(retryButton)).not.toThrow();
    });
  });

  describe('Styling', () => {
    it('should have proper async error styling', () => {
      const { container } = render(
        <AsyncErrorBoundary>
          <ThrowError shouldThrow={true} />
        </AsyncErrorBoundary>
      );

      const wrapper = container.querySelector('.semiont-async-error-boundary');
      expect(wrapper).toBeInTheDocument();
      expect(wrapper).toHaveClass('semiont-async-error-boundary');
    });

    it('should display warning icon', () => {
      const { container } = render(
        <AsyncErrorBoundary>
          <ThrowError shouldThrow={true} />
        </AsyncErrorBoundary>
      );

      const icon = container.querySelector('svg');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveClass('semiont-async-error-boundary__icon');
    });
  });

  describe('Integration with ErrorBoundary', () => {
    it('should use ErrorBoundary internally', () => {
      // AsyncErrorBoundary should catch errors like ErrorBoundary
      render(
        <AsyncErrorBoundary>
          <ThrowError shouldThrow={true} message="Integration test" />
        </AsyncErrorBoundary>
      );

      expect(screen.getByText('Integration test')).toBeInTheDocument();
    });
  });
});
