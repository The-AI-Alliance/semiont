/**
 * ProtectedErrorBoundary Tests
 *
 * The boundary catches render-time crashes inside the protected tree and
 * shows a generic "something went wrong" fallback. It is NOT auth-specific.
 * Auth state changes flow through context, not exceptions.
 *
 * Implementation: thin wrapper around `react-error-boundary`'s `ErrorBoundary`,
 * with a custom fallback and an optional `resetKeys` prop for navigation-based
 * auto-recovery.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ProtectedErrorBoundary } from '../ProtectedErrorBoundary';

function ThrowOnRender({ message }: { message: string }): React.ReactElement {
  throw new Error(message);
}

/**
 * A child that throws on first render but stops throwing if `shouldThrow`
 * becomes false. Used to test boundary reset behavior.
 */
function ThrowOnce({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) throw new Error('boom');
  return <div data-testid="recovered">recovered</div>;
}

describe('ProtectedErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs caught render errors to console.error in development;
    // suppress to keep test output clean.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('happy path', () => {
    it('renders children unchanged when no error', () => {
      render(
        <ProtectedErrorBoundary>
          <div data-testid="child">protected content</div>
        </ProtectedErrorBoundary>
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.getByText('protected content')).toBeInTheDocument();
      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    });
  });

  describe('on render error', () => {
    it('shows the generic fallback heading', () => {
      render(
        <ProtectedErrorBoundary>
          <ThrowOnRender message="boom" />
        </ProtectedErrorBoundary>
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('does NOT show "Authentication Error" — the boundary is not auth-themed', () => {
      // Throw an error whose message contains the word "session" — the old
      // AuthErrorBoundary substring-matched on this and switched its UI to
      // an auth-flavored fallback. The new boundary must not.
      render(
        <ProtectedErrorBoundary>
          <ThrowOnRender message="session blew up" />
        </ProtectedErrorBoundary>
      );

      expect(screen.queryByText(/Authentication Error/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('renders both a Try Again and a Refresh Page button', () => {
      render(
        <ProtectedErrorBoundary>
          <ThrowOnRender message="boom" />
        </ProtectedErrorBoundary>
      );

      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /refresh page/i })).toBeInTheDocument();
    });

    it('calls window.location.reload when the Refresh Page button is clicked', () => {
      const originalLocation = window.location;
      const reload = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...originalLocation, reload },
        writable: true,
        configurable: true,
      });

      try {
        render(
          <ProtectedErrorBoundary>
            <ThrowOnRender message="boom" />
          </ProtectedErrorBoundary>
        );

        fireEvent.click(screen.getByRole('button', { name: /refresh page/i }));
        expect(reload).toHaveBeenCalled();
      } finally {
        Object.defineProperty(window, 'location', {
          value: originalLocation,
          writable: true,
          configurable: true,
        });
      }
    });

    it('Try Again resets the boundary so children re-render', () => {
      // The child reads `shouldThrow` from a closed-over variable that we
      // flip between the initial mount and the click. Using an external
      // flag (rather than counting renders) sidesteps React 18's
      // strict-mode double-invocation of component bodies.
      let shouldThrow = true;
      function MaybeThrow(): React.ReactElement {
        if (shouldThrow) throw new Error('boom');
        return <div data-testid="recovered">recovered</div>;
      }

      render(
        <ProtectedErrorBoundary>
          <MaybeThrow />
        </ProtectedErrorBoundary>
      );
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();

      // Stop throwing so the next render succeeds
      shouldThrow = false;
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
      expect(screen.getByTestId('recovered')).toBeInTheDocument();
    });
  });

  describe('resetKeys', () => {
    it('auto-resets when a resetKey changes (simulating navigation)', () => {
      function Harness({ pathname, shouldThrow }: { pathname: string; shouldThrow: boolean }) {
        return (
          <ProtectedErrorBoundary resetKeys={[pathname]}>
            <ThrowOnce shouldThrow={shouldThrow} />
          </ProtectedErrorBoundary>
        );
      }

      const { rerender } = render(<Harness pathname="/know" shouldThrow={true} />);
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();

      // Simulate navigation to a different path AND a render that no longer throws
      rerender(<Harness pathname="/admin" shouldThrow={false} />);

      // Boundary auto-recovers because the resetKey changed
      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
      expect(screen.getByTestId('recovered')).toBeInTheDocument();
    });

    it('logs the error to console.error in development', () => {
      // Vitest's NODE_ENV defaults to "test", but the boundary's
      // componentDidCatch logs only when NODE_ENV === 'development'.
      // Force it for this test.
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        render(
          <ProtectedErrorBoundary>
            <ThrowOnRender message="instrumented boom" />
          </ProtectedErrorBoundary>
        );

        // Multiple console.error calls happen (React's own logs, plus ours).
        // Look for the boundary's prefix specifically.
        const ourCall = consoleErrorSpy.mock.calls.find(
          call => typeof call[0] === 'string' && call[0].includes('ProtectedErrorBoundary caught:')
        );
        expect(ourCall).toBeDefined();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });
});
