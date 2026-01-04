import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { SessionProvider, useSessionContext } from '../SessionContext';
import type { SessionManager } from '../../types/SessionManager';

// Test component that uses the hook
function TestConsumer() {
  const session = useSessionContext();
  return (
    <div>
      <div data-testid="isAuthenticated">{String(session.isAuthenticated)}</div>
      <div data-testid="expiresAt">{session.expiresAt?.toISOString() || 'null'}</div>
      <div data-testid="timeUntilExpiry">{session.timeUntilExpiry !== null ? session.timeUntilExpiry : 'null'}</div>
      <div data-testid="isExpiringSoon">{String(session.isExpiringSoon)}</div>
    </div>
  );
}

describe('SessionContext', () => {
  describe('SessionProvider', () => {
    it('should provide session manager to child components', () => {
      const mockSessionManager: SessionManager = {
        isAuthenticated: true,
        expiresAt: new Date('2025-01-04T12:00:00Z'),
        timeUntilExpiry: 3600000, // 1 hour
        isExpiringSoon: false,
      };

      render(
        <SessionProvider sessionManager={mockSessionManager}>
          <TestConsumer />
        </SessionProvider>
      );

      expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('true');
      expect(screen.getByTestId('expiresAt')).toHaveTextContent('2025-01-04T12:00:00.000Z');
      expect(screen.getByTestId('timeUntilExpiry')).toHaveTextContent('3600000');
      expect(screen.getByTestId('isExpiringSoon')).toHaveTextContent('false');
    });

    it('should handle unauthenticated state', () => {
      const mockSessionManager: SessionManager = {
        isAuthenticated: false,
        expiresAt: null,
        timeUntilExpiry: null,
        isExpiringSoon: false,
      };

      render(
        <SessionProvider sessionManager={mockSessionManager}>
          <TestConsumer />
        </SessionProvider>
      );

      expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('false');
      expect(screen.getByTestId('expiresAt')).toHaveTextContent('null');
      expect(screen.getByTestId('timeUntilExpiry')).toHaveTextContent('null');
      expect(screen.getByTestId('isExpiringSoon')).toHaveTextContent('false');
    });

    it('should handle expiring soon state', () => {
      const mockSessionManager: SessionManager = {
        isAuthenticated: true,
        expiresAt: new Date(Date.now() + 4 * 60 * 1000), // 4 minutes from now
        timeUntilExpiry: 4 * 60 * 1000, // 4 minutes
        isExpiringSoon: true,
      };

      render(
        <SessionProvider sessionManager={mockSessionManager}>
          <TestConsumer />
        </SessionProvider>
      );

      expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('true');
      expect(screen.getByTestId('isExpiringSoon')).toHaveTextContent('true');
    });

    it('should render children', () => {
      const mockSessionManager: SessionManager = {
        isAuthenticated: true,
        expiresAt: new Date(),
        timeUntilExpiry: 3600000,
        isExpiringSoon: false,
      };

      render(
        <SessionProvider sessionManager={mockSessionManager}>
          <div data-testid="child">Child content</div>
        </SessionProvider>
      );

      expect(screen.getByTestId('child')).toHaveTextContent('Child content');
    });

    it('should update when session manager changes', () => {
      const mockSessionManager1: SessionManager = {
        isAuthenticated: false,
        expiresAt: null,
        timeUntilExpiry: null,
        isExpiringSoon: false,
      };

      const { rerender } = render(
        <SessionProvider sessionManager={mockSessionManager1}>
          <TestConsumer />
        </SessionProvider>
      );

      expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('false');

      const mockSessionManager2: SessionManager = {
        isAuthenticated: true,
        expiresAt: new Date('2025-01-04T12:00:00Z'),
        timeUntilExpiry: 3600000,
        isExpiringSoon: false,
      };

      rerender(
        <SessionProvider sessionManager={mockSessionManager2}>
          <TestConsumer />
        </SessionProvider>
      );

      expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('true');
      expect(screen.getByTestId('expiresAt')).toHaveTextContent('2025-01-04T12:00:00.000Z');
    });
  });

  describe('useSessionContext', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useSessionContext must be used within SessionProvider');

      console.error = consoleError;
    });

    it('should return session manager from context', () => {
      const mockSessionManager: SessionManager = {
        isAuthenticated: true,
        expiresAt: new Date('2025-01-04T12:00:00Z'),
        timeUntilExpiry: 3600000,
        isExpiringSoon: false,
      };

      render(
        <SessionProvider sessionManager={mockSessionManager}>
          <TestConsumer />
        </SessionProvider>
      );

      // If no error is thrown and values are rendered, the hook works correctly
      expect(screen.getByTestId('isAuthenticated')).toBeInTheDocument();
    });
  });

  describe('Provider Pattern Integration', () => {
    it('should accept any SessionManager implementation', () => {
      // Custom implementation with additional fields (future-proofing)
      const customSessionManager = {
        isAuthenticated: true,
        expiresAt: new Date('2025-01-04T12:00:00Z'),
        timeUntilExpiry: 3600000,
        isExpiringSoon: false,
        // Additional custom fields would be ignored by the context
      } as SessionManager;

      render(
        <SessionProvider sessionManager={customSessionManager}>
          <TestConsumer />
        </SessionProvider>
      );

      expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('true');
    });

    it('should work with nested providers', () => {
      const outerSession: SessionManager = {
        isAuthenticated: true,
        expiresAt: new Date('2025-01-04T12:00:00Z'),
        timeUntilExpiry: 3600000,
        isExpiringSoon: false,
      };

      const innerSession: SessionManager = {
        isAuthenticated: false,
        expiresAt: null,
        timeUntilExpiry: null,
        isExpiringSoon: false,
      };

      function InnerConsumer() {
        const session = useSessionContext();
        return <div data-testid="inner">{String(session.isAuthenticated)}</div>;
      }

      function OuterConsumer() {
        const session = useSessionContext();
        return (
          <div>
            <div data-testid="outer">{String(session.isAuthenticated)}</div>
            <SessionProvider sessionManager={innerSession}>
              <InnerConsumer />
            </SessionProvider>
          </div>
        );
      }

      render(
        <SessionProvider sessionManager={outerSession}>
          <OuterConsumer />
        </SessionProvider>
      );

      // Outer should be authenticated, inner should not
      expect(screen.getByTestId('outer')).toHaveTextContent('true');
      expect(screen.getByTestId('inner')).toHaveTextContent('false');
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero timeUntilExpiry', () => {
      const mockSessionManager: SessionManager = {
        isAuthenticated: true,
        expiresAt: new Date(),
        timeUntilExpiry: 0,
        isExpiringSoon: false,
      };

      render(
        <SessionProvider sessionManager={mockSessionManager}>
          <TestConsumer />
        </SessionProvider>
      );

      expect(screen.getByTestId('timeUntilExpiry')).toHaveTextContent('0');
    });

    it('should handle negative timeUntilExpiry (expired)', () => {
      const mockSessionManager: SessionManager = {
        isAuthenticated: false,
        expiresAt: new Date(Date.now() - 1000),
        timeUntilExpiry: -1000,
        isExpiringSoon: false,
      };

      render(
        <SessionProvider sessionManager={mockSessionManager}>
          <TestConsumer />
        </SessionProvider>
      );

      expect(screen.getByTestId('timeUntilExpiry')).toHaveTextContent('-1000');
    });

    it('should handle large timeUntilExpiry values', () => {
      const mockSessionManager: SessionManager = {
        isAuthenticated: true,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        timeUntilExpiry: 30 * 24 * 60 * 60 * 1000,
        isExpiringSoon: false,
      };

      render(
        <SessionProvider sessionManager={mockSessionManager}>
          <TestConsumer />
        </SessionProvider>
      );

      expect(screen.getByTestId('isExpiringSoon')).toHaveTextContent('false');
    });
  });
});
