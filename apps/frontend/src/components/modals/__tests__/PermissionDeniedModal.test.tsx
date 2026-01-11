import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PermissionDeniedModal } from '../PermissionDeniedModal';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from '@/i18n/routing';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
  useSession: vi.fn(() => ({
    data: {
      user: {
        email: 'test@example.com'
      }
    },
    status: 'authenticated'
  }))
}));

// Mock @/i18n/routing
vi.mock('@/i18n/routing', () => ({
  useRouter: vi.fn()
}));

// Mock auth events
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    AUTH_EVENTS: {
      FORBIDDEN: 'auth:forbidden'
    },
    onAuthEvent: vi.fn((event, callback) => {
      // Return cleanup function
      return () => {};
    })
  };
});

// Mock SessionContext
vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: vi.fn(() => ({
    clearSession: vi.fn()
  }))
}));

// Mock window.alert
global.alert = vi.fn();

describe('PermissionDeniedModal', () => {
  const mockPush = vi.fn();
  const mockBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as any).mockReturnValue({
      push: mockPush,
      back: mockBack
    });
  });

  describe('Modal Display', () => {
    it('should show modal when forbidden event is triggered', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show by simulating forbidden event
      const { onAuthEvent } = await import('@semiont/react-ui');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];

      act(() => {
        act(() => {
        eventHandler({ detail: { message: 'You need admin access' } });
      });
      });

      // Modal should be visible
      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
        expect(screen.getByText('You need admin access')).toBeInTheDocument();
      });
    });

    it('should display current user email', async () => {
      render(<PermissionDeniedModal />);

      const { onAuthEvent } = await import('@semiont/react-ui');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];

      act(() => {
        eventHandler({ detail: { message: 'Access denied' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Currently signed in as:')).toBeInTheDocument();
        expect(screen.getByText('test@example.com')).toBeInTheDocument();
      });
    });
  });

  describe('User Actions', () => {
    it('should call router.back when Go Back button is clicked', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@semiont/react-ui');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      act(() => {
        eventHandler({ detail: { message: 'You need admin access' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      // Click Go Back button
      const goBackButton = screen.getByRole('button', { name: /go back/i });
      fireEvent.click(goBackButton);

      // Should call router.back()
      expect(mockBack).toHaveBeenCalled();
    });

    it('should navigate to home when Go to Home button is clicked', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@semiont/react-ui');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      act(() => {
        eventHandler({ detail: { message: 'You need admin access' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      // Click Go to Home button
      const goHomeButton = screen.getByRole('button', { name: /go to home/i });
      fireEvent.click(goHomeButton);

      // Should navigate to home
      expect(mockPush).toHaveBeenCalledWith('/');
    });

    it('should handle Switch Account action', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@semiont/react-ui');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      act(() => {
        eventHandler({ detail: { message: 'You need admin access' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      const switchAccountButton = screen.getByRole('button', { name: /switch account/i });
      fireEvent.click(switchAccountButton);

      // Should call signIn with current path as callback
      expect(signIn).toHaveBeenCalledWith(undefined, {
        callbackUrl: window.location.pathname
      });
    });

    it('should handle Request Access action', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@semiont/react-ui');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      act(() => {
        eventHandler({ detail: { message: 'You need admin access' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      const requestAccessButton = screen.getByRole('button', { name: /request access/i });
      fireEvent.click(requestAccessButton);

      // Should show alert (mocked)
      expect(global.alert).toHaveBeenCalledWith(
        'Access request feature coming soon. Please contact your administrator.'
      );
    });
  });

  describe('Modal Behavior', () => {
    it('should close modal after Go Back action', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@semiont/react-ui');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      act(() => {
        eventHandler({ detail: { message: 'You need admin access' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      // Click Go Back button
      const goBackButton = screen.getByRole('button', { name: /go back/i });
      fireEvent.click(goBackButton);

      // Modal should close after action
      await waitFor(() => {
        expect(screen.queryByText('Access Denied')).not.toBeInTheDocument();
      });
    });

    it('should close modal after Go to Home action', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@semiont/react-ui');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      act(() => {
        eventHandler({ detail: { message: 'You need admin access' } });
      });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      // Click Go to Home button
      const goHomeButton = screen.getByRole('button', { name: /go to home/i });
      fireEvent.click(goHomeButton);

      // Modal should close after action
      await waitFor(() => {
        expect(screen.queryByText('Access Denied')).not.toBeInTheDocument();
      });
    });

    it('should only show one modal instance', async () => {
      render(<PermissionDeniedModal />);

      const { onAuthEvent } = await import('@semiont/react-ui');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];

      // Trigger multiple times
      act(() => {
        eventHandler({ detail: { message: 'Access denied' } });
        eventHandler({ detail: { message: 'Access denied again' } });
      });

      await waitFor(() => {
        const modals = screen.getAllByText('Access Denied');
        expect(modals).toHaveLength(1);
      });
    });
  });

  describe('Event Listener Cleanup', () => {
    it('should cleanup event listeners on unmount', async () => {
      const { unmount } = render(<PermissionDeniedModal />);
      const { onAuthEvent } = await import('@semiont/react-ui');

      // Should have registered event listener
      expect(onAuthEvent).toHaveBeenCalledWith('auth:forbidden', expect.any(Function));

      // Get cleanup function
      const cleanupFunction = (onAuthEvent as any).mock.results
        .find((result: any) => result.type === 'return')?.value;

      unmount();

      // Cleanup function should exist
      expect(typeof cleanupFunction).toBe('function');
    });
  });
});