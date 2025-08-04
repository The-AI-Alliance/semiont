import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ErrorBoundary, AsyncErrorBoundary } from '../ErrorBoundary';

// Mock component that throws an error
const ThrowError = ({ shouldThrow = false, message = 'Test error' }: { shouldThrow?: boolean; message?: string }) => {
  if (shouldThrow) {
    throw new Error(message);
  }
  return <div>No error</div>;
};

// Mock console methods
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

// Mock window.location
const mockLocation = {
  href: ''
};

// Store original location
const originalLocation = window.location;

// Mock location before tests
beforeAll(() => {
  delete (window as any).location;
  window.location = mockLocation as any;
});

// Restore original location after tests
afterAll(() => {
  (window as any).location = originalLocation;
});

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation.href = '';
  });

  afterAll(() => {
    mockConsoleError.mockRestore();
  });

  describe('Normal Rendering', () => {
    it('should render children when no error occurs', () => {
      render(
        <ErrorBoundary>
          <div>Test content</div>
        </ErrorBoundary>
      );
      
      expect(screen.getByText('Test content')).toBeInTheDocument();
    });

    it('should render multiple children normally', () => {
      render(
        <ErrorBoundary>
          <div>First child</div>
          <div>Second child</div>
        </ErrorBoundary>
      );
      
      expect(screen.getByText('First child')).toBeInTheDocument();
      expect(screen.getByText('Second child')).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('should catch and display default error UI when child throws', () => {
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message="Something went wrong" />
        </ErrorBoundary>
      );
      
      expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
      expect(screen.getByText('We encountered an unexpected error. Please try again.')).toBeInTheDocument();
      expect(screen.getByText('Try Again')).toBeInTheDocument();
      expect(screen.getByText('Go Home')).toBeInTheDocument();
    });

    it('should show error details in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message="Development error" />
        </ErrorBoundary>
      );
      
      expect(screen.getByText('Error Details (Development Only)')).toBeInTheDocument();
      expect(screen.getByText('Development error')).toBeInTheDocument();
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should hide error details in production mode', () => {
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

    it('should call custom onError handler when provided', () => {
      const mockOnError = vi.fn();
      
      render(
        <ErrorBoundary onError={mockOnError}>
          <ThrowError shouldThrow={true} message="Custom error" />
        </ErrorBoundary>
      );
      
      expect(mockOnError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Custom error' }),
        expect.objectContaining({ componentStack: expect.any(String) })
      );
    });

    it('should log error to console in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message="Console error" />
        </ErrorBoundary>
      );
      
      expect(mockConsoleError).toHaveBeenCalledWith(
        'ErrorBoundary caught an error:',
        expect.objectContaining({ message: 'Console error' }),
        expect.objectContaining({ componentStack: expect.any(String) })
      );
      
      process.env.NODE_ENV = originalEnv;
    });

    it('should not log error to console in production mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      // Clear any previous calls
      mockConsoleError.mockClear();
      
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} message="Silent error" />
        </ErrorBoundary>
      );
      
      // Check that our specific error logging is not called
      // (React itself may still log, but our custom logging should not)
      expect(mockConsoleError).not.toHaveBeenCalledWith(
        'ErrorBoundary caught an error:',
        expect.any(Error),
        expect.any(Object)
      );
      
      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Custom Fallback', () => {
    it('should render custom fallback when provided', () => {
      const customFallback = (error: Error, reset: () => void) => (
        <div>
          <h1>Custom Error UI</h1>
          <p>Error: {error.message}</p>
          <button onClick={reset}>Custom Reset</button>
        </div>
      );
      
      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowError shouldThrow={true} message="Custom fallback error" />
        </ErrorBoundary>
      );
      
      expect(screen.getByText('Custom Error UI')).toBeInTheDocument();
      expect(screen.getByText('Error: Custom fallback error')).toBeInTheDocument();
      expect(screen.getByText('Custom Reset')).toBeInTheDocument();
      
      // Should not show default error UI
      expect(screen.queryByText('Oops! Something went wrong')).not.toBeInTheDocument();
    });

    it('should call reset function from custom fallback', () => {
      const customFallback = (error: Error, reset: () => void) => (
        <button onClick={reset}>Reset Error</button>
      );
      
      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );
      
      expect(screen.getByText('Reset Error')).toBeInTheDocument();
      
      // Click reset - should clear error and try to render children again
      fireEvent.click(screen.getByText('Reset Error'));
      
      // Component should attempt to render children again (though they'll error again)
      expect(screen.getByText('Reset Error')).toBeInTheDocument(); // Will error again immediately
    });
  });

  describe('Reset Functionality', () => {
    it('should reset error state when Try Again is clicked', () => {
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );
      
      expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
      
      // Click Try Again
      fireEvent.click(screen.getByText('Try Again'));
      
      // Should still show error because component will throw again
      expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
    });

    it('should display Go Home button in error UI', () => {
      render(
        <ErrorBoundary>
          <ThrowError shouldThrow={true} />
        </ErrorBoundary>
      );
      
      const goHomeButton = screen.getByText('Go Home');
      expect(goHomeButton).toBeInTheDocument();
      expect(goHomeButton.tagName).toBe('BUTTON');
    });
  });

  describe('Error Stack Display', () => {
    it('should display error stack in development when available', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      const errorWithStack = new Error('Error with stack');
      errorWithStack.stack = 'Error: Error with stack\n    at TestComponent\n    at ErrorBoundary';
      
      const ThrowErrorWithStack = () => {
        throw errorWithStack;
      };
      
      render(
        <ErrorBoundary>
          <ThrowErrorWithStack />
        </ErrorBoundary>
      );
      
      expect(screen.getByText('Error with stack')).toBeInTheDocument();
      // Stack should be displayed in a <pre> element
      const stackElement = screen.getByText(/at TestComponent/);
      expect(stackElement.tagName).toBe('PRE');
      
      process.env.NODE_ENV = originalEnv;
    });
  });
});

describe('AsyncErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render children when no error occurs', () => {
    render(
      <AsyncErrorBoundary>
        <div>Async content</div>
      </AsyncErrorBoundary>
    );
    
    expect(screen.getByText('Async content')).toBeInTheDocument();
  });

  it('should display specialized async error UI when child throws', () => {
    render(
      <AsyncErrorBoundary>
        <ThrowError shouldThrow={true} message="Async error" />
      </AsyncErrorBoundary>
    );
    
    expect(screen.getByText('Failed to load this section')).toBeInTheDocument();
    expect(screen.getByText('Async error')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('should show generic message when error has no message', () => {
    const errorWithoutMessage = new Error();
    errorWithoutMessage.message = '';
    
    const ThrowEmptyError = () => {
      throw errorWithoutMessage;
    };
    
    render(
      <AsyncErrorBoundary>
        <ThrowEmptyError />
      </AsyncErrorBoundary>
    );
    
    expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
  });

  it('should handle retry functionality', () => {
    render(
      <AsyncErrorBoundary>
        <ThrowError shouldThrow={true} message="Async retry error" />
      </AsyncErrorBoundary>
    );
    
    expect(screen.getByText('Failed to load this section')).toBeInTheDocument();
    
    // Click retry
    fireEvent.click(screen.getByText('Retry'));
    
    // Should still show error because component will throw again
    expect(screen.getByText('Failed to load this section')).toBeInTheDocument();
  });

  it('should display warning icon', () => {
    const { container } = render(
      <AsyncErrorBoundary>
        <ThrowError shouldThrow={true} />
      </AsyncErrorBoundary>
    );
    
    // Check for SVG warning icon by class and viewBox
    const svgIcon = container.querySelector('svg[viewBox="0 0 20 20"]');
    expect(svgIcon).toBeTruthy();
    expect(svgIcon).toHaveClass('h-5', 'w-5', 'text-yellow-400');
  });
});

describe('ErrorBoundary Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle non-render errors gracefully', () => {
    // This tests that the ErrorBoundary doesn't break when non-render errors occur
    // (which it correctly ignores, as per React's design)
    const ComponentWithAsyncError = () => {
      const handleClick = () => {
        // This type of error is NOT caught by ErrorBoundary - this is expected
        setTimeout(() => {
          throw new Error('Async error');
        }, 0);
      };
      
      return (
        <div>
          <span>Component with async error</span>
          <button onClick={handleClick}>Trigger Async Error</button>
        </div>
      );
    };
    
    render(
      <ErrorBoundary>
        <ComponentWithAsyncError />
      </ErrorBoundary>
    );
    
    // Component should render normally
    expect(screen.getByText('Component with async error')).toBeInTheDocument();
    expect(screen.getByText('Trigger Async Error')).toBeInTheDocument();
    
    // Clicking the button won't cause ErrorBoundary to catch the error
    // (this is expected React behavior - only render errors are caught)
    fireEvent.click(screen.getByText('Trigger Async Error'));
    
    // Component should still be rendered normally
    expect(screen.getByText('Component with async error')).toBeInTheDocument();
  });

  it('should handle multiple sequential errors', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} message="First error" />
      </ErrorBoundary>
    );
    
    expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
    
    // Reset and cause another error
    fireEvent.click(screen.getByText('Try Again'));
    
    // Should still handle the error properly
    expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
  });

  it('should handle complex error objects', () => {
    const complexError = new Error('Complex error');
    (complexError as any).code = 'COMPLEX_ERROR';
    (complexError as any).details = { severity: 'high' };
    
    const ThrowComplexError = () => {
      throw complexError;
    };
    
    const mockOnError = vi.fn();
    
    render(
      <ErrorBoundary onError={mockOnError}>
        <ThrowComplexError />
      </ErrorBoundary>
    );
    
    expect(screen.getByText('Oops! Something went wrong')).toBeInTheDocument();
    expect(mockOnError).toHaveBeenCalledWith(
      expect.objectContaining({ 
        message: 'Complex error',
        code: 'COMPLEX_ERROR'
      }),
      expect.any(Object)
    );
  });
});