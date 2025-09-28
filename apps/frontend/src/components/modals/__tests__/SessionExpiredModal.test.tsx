import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { SessionExpiredModal } from '../SessionExpiredModal';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

// Mock next-auth
vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
  useSession: vi.fn(() => ({
    data: null,
    status: 'unauthenticated'
  }))
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn()
}));

// Mock auth events
vi.mock('@/lib/auth-events', () => ({
  AUTH_EVENTS: {
    UNAUTHORIZED: 'auth:unauthorized'
  },
  onAuthEvent: vi.fn((event, callback) => {
    // Return cleanup function
    return () => {};
  })
}));

// Mock SessionContext
vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: vi.fn(() => ({
    isAuthenticated: false,
    loading: false
  }))
}));

describe('SessionExpiredModal', () => {
  const mockPush = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as any).mockReturnValue({ push: mockPush });
  });

  describe('Keyboard Navigation', () => {
    it('should close modal when Escape key is pressed', async () => {
      const { rerender } = render(<SessionExpiredModal />);

      // Trigger the modal to show by simulating auth event
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'Session expired' } });

      // Wait for modal to appear
      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      // Press Escape key
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

      // Modal should close (content no longer visible)
      await waitFor(() => {
        expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
      });
    });

    it('should trap focus within modal when Tab is pressed', async () => {
      render(<SessionExpiredModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'Session expired' } });

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      const signInButton = screen.getByRole('button', { name: /sign in/i });
      const goHomeButton = screen.getByRole('button', { name: /go to home/i });

      // Focus should cycle between buttons
      signInButton.focus();
      expect(document.activeElement).toBe(signInButton);

      // Tab to next button
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(goHomeButton);
      });

      // Tab should wrap back to first button
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(signInButton);
      });
    });

    it('should handle Shift+Tab for reverse navigation', async () => {
      render(<SessionExpiredModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'Session expired' } });

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      const signInButton = screen.getByRole('button', { name: /sign in/i });
      const goHomeButton = screen.getByRole('button', { name: /go to home/i });

      // Focus last button
      goHomeButton.focus();
      expect(document.activeElement).toBe(goHomeButton);

      // Shift+Tab to previous button
      fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
      await waitFor(() => {
        expect(document.activeElement).toBe(signInButton);
      });
    });
  });

  describe('Click Outside Behavior', () => {
    it('should close modal when clicking outside', async () => {
      const { container } = render(<SessionExpiredModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'Session expired' } });

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      // Click on the backdrop
      const backdrop = container.querySelector('.fixed.inset-0.bg-black\\/50');
      if (backdrop) {
        fireEvent.click(backdrop);
      }

      // Modal should close
      await waitFor(() => {
        expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
      });
    });

    it('should not close modal when clicking inside', async () => {
      render(<SessionExpiredModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'Session expired' } });

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      // Click inside the modal content
      const modalContent = screen.getByText('Session Expired');
      fireEvent.click(modalContent);

      // Modal should remain open
      expect(screen.getByText('Session Expired')).toBeInTheDocument();
    });
  });

  describe('Focus Restoration', () => {
    it('should restore focus to previous element when modal closes', async () => {
      const { container } = render(
        <div>
          <button data-testid="trigger">Trigger Button</button>
          <SessionExpiredModal />
        </div>
      );

      const triggerButton = screen.getByTestId('trigger');
      triggerButton.focus();
      const previousActiveElement = document.activeElement;

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'Session expired' } });

      await waitFor(() => {
        expect(screen.getByText('Session Expired')).toBeInTheDocument();
      });

      // Focus should be inside modal
      expect(document.activeElement).not.toBe(previousActiveElement);

      // Close modal with Escape
      fireEvent.keyDown(document, { key: 'Escape' });

      // Focus should return to trigger button
      await waitFor(() => {
        expect(document.activeElement).toBe(previousActiveElement);
      });
    });
  });
});