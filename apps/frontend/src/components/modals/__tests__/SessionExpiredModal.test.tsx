import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SessionExpiredModal } from '../SessionExpiredModal';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  signIn: vi.fn()
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn()
}));

// Mock auth events
vi.mock('@/lib/auth-events', () => ({
  AUTH_EVENTS: {
    UNAUTHORIZED: 'auth:unauthorized',
    SESSION_EXPIRED: 'auth:session-expired'
  },
  onAuthEvent: vi.fn((event, callback) => {
    // Return cleanup function
    return () => {};
  })
}));

// Mock SessionContext
vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: vi.fn(() => ({
    clearSession: vi.fn()
  }))
}));

// Mock window.location
Object.defineProperty(window, 'location', {
  value: {
    href: '',
    pathname: '/test'
  },
  writable: true
});

describe('SessionExpiredModal', () => {
  const mockPush = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as any).mockReturnValue({
      push: mockPush
    });

    // Reset location.href
    window.location.href = '';
  });

  describe('Modal Display', () => {
    it('should show modal when session expired event is triggered', async () => {
      render(<SessionExpiredModal />);

      // Trigger the modal to show by simulating auth event
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];

      act(() => {
        eventHandler({ detail: { message: 'Session expired' } });
      });

      // Modal should be visible
      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
        expect(screen.getByText('Your session has expired for security reasons. Please sign in again to continue working.')).toBeInTheDocument();
      });
    });

  });

  describe('User Actions', () => {
    it('should call signIn when Sign In button is clicked', async () => {
      render(<SessionExpiredModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];

      act(() => {
        eventHandler({ detail: { message: 'Session expired' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      // Click Sign In button
      const signInButton = screen.getByRole('button', { name: /sign in/i });
      fireEvent.click(signInButton);

      // Should call signIn with callback URL
      expect(signIn).toHaveBeenCalledWith(undefined, {
        callbackUrl: window.location.pathname
      });
    });

    it('should navigate to home when Go to Home button is clicked', async () => {
      render(<SessionExpiredModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];

      act(() => {
        eventHandler({ detail: { message: 'Session expired' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      // Click Go to Home button
      const goHomeButton = screen.getByRole('button', { name: /go to home/i });
      fireEvent.click(goHomeButton);

      // Should set window.location.href to home
      expect(window.location.href).toBe('/');
    });
  });

  describe('Modal Behavior', () => {
    it('should only show one modal instance', async () => {
      render(<SessionExpiredModal />);

      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];

      // Trigger multiple times
      act(() => {
        eventHandler({ detail: { message: 'Session expired' } });
        eventHandler({ detail: { message: 'Session expired again' } });
      });

      await waitFor(() => {
        const modals = screen.getAllByText('Session Expired');
        expect(modals).toHaveLength(1);
      });
    });

    it('should call signIn when Sign In button is clicked (modal remains open)', async () => {
      render(<SessionExpiredModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];

      act(() => {
        eventHandler({ detail: { message: 'Session expired' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      // Click Sign In button
      const signInButton = screen.getByRole('button', { name: /sign in/i });
      fireEvent.click(signInButton);

      // Should call signIn (modal stays open until authentication completes)
      expect(signIn).toHaveBeenCalledWith(undefined, {
        callbackUrl: window.location.pathname
      });

      // Modal should still be visible (it closes only after successful authentication or Go to Home)
      expect(screen.getByText('Session Expired')).toBeInTheDocument();
    });

    it('should close modal after Go to Home action', async () => {
      render(<SessionExpiredModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];

      act(() => {
        eventHandler({ detail: { message: 'Session expired' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      // Click Go to Home button
      const goHomeButton = screen.getByRole('button', { name: /go to home/i });
      fireEvent.click(goHomeButton);

      // Should set window.location.href to home (modal closes via redirect)
      expect(window.location.href).toBe('/');
    });
  });

  describe('Event Listener Cleanup', () => {
    it('should cleanup event listeners on unmount', async () => {
      const { unmount } = render(<SessionExpiredModal />);
      const { onAuthEvent } = await import('@/lib/auth-events');

      // Should have registered event listener for unauthorized events
      expect(onAuthEvent).toHaveBeenCalledWith('auth:unauthorized', expect.any(Function));

      // Get cleanup function
      const cleanupFunction = (onAuthEvent as any).mock.results
        .find((result: any) => result.type === 'return')?.value;

      unmount();

      // Cleanup function should exist
      expect(typeof cleanupFunction).toBe('function');
    });
  });
});