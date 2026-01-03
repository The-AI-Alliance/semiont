import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionExpiredModal } from '../SessionExpiredModal';
import { SessionProvider } from '../../../contexts/SessionContext';

// Mock next-auth
const mockSignIn = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: mockSignIn,
  useSession: vi.fn(() => ({
    data: null,
    status: 'unauthenticated'
  }))
}));

// Mock window.location
const mockLocation = {
  href: '',
  pathname: '/test'
};

Object.defineProperty(window, 'location', {
  value: mockLocation,
  writable: true
});

// Helper to render with SessionProvider
const renderWithSession = (isAuthenticated = false) => {
  return render(
    <SessionProvider isAuthenticated={isAuthenticated}>
      <SessionExpiredModal />
    </SessionProvider>
  );
};

describe('SessionExpiredModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation.href = '';
    mockLocation.pathname = '/test';
  });

  describe('Modal Visibility', () => {
    it('should not show modal initially when authenticated', () => {
      renderWithSession(true);

      // Modal should not be visible
      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    });

    it('should not show modal initially when unauthenticated', () => {
      renderWithSession(false);

      // Modal should not be visible (only shows on transition or event)
      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    });
  });

  describe('Modal Content', () => {
    it('should render modal content when shown', async () => {
      const { rerender } = renderWithSession(true);

      // Trigger session expiration by changing from authenticated to unauthenticated
      rerender(
        <SessionProvider isAuthenticated={false}>
          <SessionExpiredModal />
        </SessionProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      expect(screen.getByText('Your session has expired for security reasons. Please sign in again to continue working.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Sign In Again/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Go to Home/i })).toBeInTheDocument();
    });
  });

  describe('User Actions', () => {
    it('should call signIn when Sign In button is clicked', async () => {
      const { rerender } = renderWithSession(true);

      // Trigger modal
      rerender(
        <SessionProvider isAuthenticated={false}>
          <SessionExpiredModal />
        </SessionProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      const signInButton = screen.getByRole('button', { name: /Sign In Again/i });
      fireEvent.click(signInButton);

      expect(mockSignIn).toHaveBeenCalledWith(undefined, {
        callbackUrl: '/test'
      });
    });

    it('should navigate to home when Go to Home button is clicked', async () => {
      const { rerender } = renderWithSession(true);

      // Trigger modal
      rerender(
        <SessionProvider isAuthenticated={false}>
          <SessionExpiredModal />
        </SessionProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      const goHomeButton = screen.getByRole('button', { name: /Go to Home/i });
      fireEvent.click(goHomeButton);

      expect(mockLocation.href).toBe('/');
    });
  });

  describe('Session Transition Detection', () => {
    it('should show modal when transitioning from authenticated to unauthenticated', async () => {
      const { rerender } = renderWithSession(true);

      // Initially authenticated, modal should not be visible
      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();

      // Transition to unauthenticated
      rerender(
        <SessionProvider isAuthenticated={false}>
          <SessionExpiredModal />
        </SessionProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });
    });

    it('should not show modal when starting unauthenticated', () => {
      renderWithSession(false);

      // Should not show modal on initial unauthenticated state
      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    });

    it('should not show modal when remaining authenticated', () => {
      const { rerender } = renderWithSession(true);

      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();

      // Re-render with same authenticated state
      rerender(
        <SessionProvider isAuthenticated={true}>
          <SessionExpiredModal />
        </SessionProvider>
      );

      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels and roles', async () => {
      const { rerender } = renderWithSession(true);

      // Trigger modal
      rerender(
        <SessionProvider isAuthenticated={false}>
          <SessionExpiredModal />
        </SessionProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      // Check dialog role
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();

      // Check buttons are properly labeled
      expect(screen.getByRole('button', { name: /Sign In Again/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Go to Home/i })).toBeInTheDocument();
    });
  });
});
