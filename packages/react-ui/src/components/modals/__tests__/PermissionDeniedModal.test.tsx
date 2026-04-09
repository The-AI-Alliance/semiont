/**
 * PermissionDeniedModal Tests
 *
 * Tests the modal that surfaces when an `auth:forbidden` event is dispatched
 * on the window. The modal stays hidden by default.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../test-utils';
import { PermissionDeniedModal } from '../PermissionDeniedModal';
import { dispatch403Error } from '../../../lib/auth-events';

vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

const originalLocation = window.location;
const originalHistoryBack = window.history.back;
let mockLocation: { href: string; pathname: string };
let mockHistoryBack: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockLocation = { href: '', pathname: '/admin/users' };
  Object.defineProperty(window, 'location', {
    value: mockLocation,
    writable: true,
    configurable: true,
  });
  mockHistoryBack = vi.fn();
  window.history.back = mockHistoryBack;
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
  window.history.back = originalHistoryBack;
});

describe('PermissionDeniedModal', () => {
  describe('initial render', () => {
    it('does not render modal content before any 403 event', () => {
      renderWithProviders(<PermissionDeniedModal />);
      expect(screen.queryByText('Access Denied')).not.toBeInTheDocument();
    });
  });

  describe('on auth:forbidden event', () => {
    it('shows modal with default message when none provided', () => {
      renderWithProviders(<PermissionDeniedModal />);

      act(() => {
        dispatch403Error();
      });

      expect(screen.getByText('Access Denied')).toBeInTheDocument();
      expect(screen.getByText('You do not have permission to perform this action')).toBeInTheDocument();
    });

    it('shows custom message when provided', () => {
      renderWithProviders(<PermissionDeniedModal />);

      act(() => {
        dispatch403Error('Admin access required for this resource');
      });

      expect(screen.getByText('Admin access required for this resource')).toBeInTheDocument();
    });

    it('renders all three action buttons', () => {
      renderWithProviders(<PermissionDeniedModal />);

      act(() => {
        dispatch403Error();
      });

      expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /go to home/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /switch account/i })).toBeInTheDocument();
    });
  });

  describe('button actions', () => {
    it('calls window.history.back on Go Back', () => {
      renderWithProviders(<PermissionDeniedModal />);
      act(() => { dispatch403Error('denied'); });

      fireEvent.click(screen.getByRole('button', { name: /go back/i }));

      expect(mockHistoryBack).toHaveBeenCalled();
    });

    it('navigates to / on Go to Home', () => {
      renderWithProviders(<PermissionDeniedModal />);
      act(() => { dispatch403Error('denied'); });

      fireEvent.click(screen.getByRole('button', { name: /go to home/i }));

      expect(mockLocation.href).toBe('/');
    });

    it('navigates to /auth/connect with current path on Switch Account', () => {
      mockLocation.pathname = '/admin/users';
      renderWithProviders(<PermissionDeniedModal />);
      act(() => { dispatch403Error('denied'); });

      fireEvent.click(screen.getByRole('button', { name: /switch account/i }));

      expect(mockLocation.href).toBe('/auth/connect?callbackUrl=%2Fadmin%2Fusers');
    });
  });
});
