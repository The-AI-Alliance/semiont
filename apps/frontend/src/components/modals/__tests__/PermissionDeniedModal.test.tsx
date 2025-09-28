import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PermissionDeniedModal } from '../PermissionDeniedModal';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';

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

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn()
}));

// Mock auth events
vi.mock('@/lib/auth-events', () => ({
  AUTH_EVENTS: {
    FORBIDDEN: 'auth:forbidden'
  },
  onAuthEvent: vi.fn((event, callback) => {
    // Return cleanup function
    return () => {};
  })
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

  describe('Keyboard Navigation', () => {
    it('should close modal when Escape key is pressed', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show by simulating forbidden event
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'You need admin access' } });

      // Wait for modal to appear
      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      // Press Escape key
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

      // Should call router.back() and modal should close
      await waitFor(() => {
        expect(mockBack).toHaveBeenCalled();
      });
    });

    it('should handle Enter key on focused button', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'You need admin access' } });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      const goBackButton = screen.getByRole('button', { name: /go back/i });
      goBackButton.focus();

      // Press Enter on focused button
      fireEvent.keyDown(goBackButton, { key: 'Enter', code: 'Enter' });

      // Should trigger the button action
      expect(mockBack).toHaveBeenCalled();
    });

    it('should handle Space key on focused button', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'You need admin access' } });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      const goHomeButton = screen.getByRole('button', { name: /go to home/i });
      goHomeButton.focus();

      // Press Space on focused button
      fireEvent.keyDown(goHomeButton, { key: ' ', code: 'Space' });
      fireEvent.keyUp(goHomeButton, { key: ' ', code: 'Space' });

      // Should trigger the button action
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/');
      });
    });
  });

  describe('Focus Trapping', () => {
    it('should trap focus within modal buttons', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'You need admin access' } });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      // Get all interactive elements
      const goBackButton = screen.getByRole('button', { name: /go back/i });
      const goHomeButton = screen.getByRole('button', { name: /go to home/i });
      const switchAccountButton = screen.getByRole('button', { name: /switch account/i });
      const requestAccessButton = screen.getByRole('button', { name: /request access/i });

      // Focus first button
      goBackButton.focus();
      expect(document.activeElement).toBe(goBackButton);

      // Tab through all buttons
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(goHomeButton);
      });

      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(switchAccountButton);
      });

      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(requestAccessButton);
      });

      // Tab should wrap back to first button
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(goBackButton);
      });
    });

    it('should not allow focus to escape to document body', async () => {
      render(
        <div>
          <button data-testid="outside-button">Outside Button</button>
          <PermissionDeniedModal />
        </div>
      );

      const outsideButton = screen.getByTestId('outside-button');

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'You need admin access' } });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      // Try to focus outside button
      outsideButton.focus();

      // Focus should be trapped in modal, not on outside button
      expect(document.activeElement).not.toBe(outsideButton);

      // Focus should be within the modal
      const modal = screen.getByText('Access Denied').closest('[role="dialog"]');
      expect(modal).toContainElement(document.activeElement);
    });
  });

  describe('Click Outside Behavior', () => {
    it('should close modal and go back when clicking outside', async () => {
      const { container } = render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'You need admin access' } });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      // Click on the backdrop
      const backdrop = container.querySelector('.fixed.inset-0.bg-black\\/50');
      if (backdrop) {
        fireEvent.click(backdrop);
      }

      // Should call router.back()
      expect(mockBack).toHaveBeenCalled();
    });

    it('should not close when clicking inside modal', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'You need admin access' } });

      await waitFor(() => {
        expect(screen.getByText('Access Denied')).toBeInTheDocument();
      });

      // Click inside the modal
      const modalContent = screen.getByText('Access Denied');
      fireEvent.click(modalContent);

      // Should not call router.back()
      expect(mockBack).not.toHaveBeenCalled();

      // Modal should remain open
      expect(screen.getByText('Access Denied')).toBeInTheDocument();
    });
  });

  describe('Multiple Actions', () => {
    it('should handle Switch Account action', async () => {
      render(<PermissionDeniedModal />);

      // Trigger the modal to show
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'You need admin access' } });

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
      const { onAuthEvent } = await import('@/lib/auth-events');
      const eventHandler = (onAuthEvent as any).mock.calls[0][1];
      eventHandler({ detail: { message: 'You need admin access' } });

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
});