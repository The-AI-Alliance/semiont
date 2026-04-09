/**
 * PermissionDeniedModal Tests
 *
 * The modal renders content when `permissionDeniedAt` is non-null on the
 * KnowledgeBaseSession context, and is hidden otherwise. Button clicks call
 * `acknowledgePermissionDenied()` and navigate the window or history.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  renderWithProviders,
  createMockKnowledgeBaseSession,
} from '../../../test-utils';
import { PermissionDeniedModal } from '../PermissionDeniedModal';

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
    it('does not render modal content when permissionDeniedAt is null', () => {
      renderWithProviders(<PermissionDeniedModal />, {
        knowledgeBaseSession: createMockKnowledgeBaseSession({
          permissionDeniedAt: null,
        }),
      });
      expect(screen.queryByText('Access Denied')).not.toBeInTheDocument();
    });
  });

  describe('when permissionDeniedAt is set', () => {
    it('shows modal with default message when no message provided', () => {
      renderWithProviders(<PermissionDeniedModal />, {
        knowledgeBaseSession: createMockKnowledgeBaseSession({
          permissionDeniedAt: Date.now(),
        }),
      });

      expect(screen.getByText('Access Denied')).toBeInTheDocument();
      expect(screen.getByText('You do not have permission to perform this action.')).toBeInTheDocument();
    });

    it('shows custom message from permissionDeniedMessage', () => {
      renderWithProviders(<PermissionDeniedModal />, {
        knowledgeBaseSession: createMockKnowledgeBaseSession({
          permissionDeniedAt: Date.now(),
          permissionDeniedMessage: 'Admin access required for this resource',
        }),
      });

      expect(screen.getByText('Admin access required for this resource')).toBeInTheDocument();
    });

    it('renders all three action buttons', () => {
      renderWithProviders(<PermissionDeniedModal />, {
        knowledgeBaseSession: createMockKnowledgeBaseSession({
          permissionDeniedAt: Date.now(),
        }),
      });

      expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /go to home/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /switch account/i })).toBeInTheDocument();
    });
  });

  describe('button actions', () => {
    it('acknowledges and calls window.history.back on Go Back', () => {
      const ack = vi.fn();
      renderWithProviders(<PermissionDeniedModal />, {
        knowledgeBaseSession: createMockKnowledgeBaseSession({
          permissionDeniedAt: Date.now(),
          permissionDeniedMessage: 'denied',
          acknowledgePermissionDenied: ack,
        }),
      });

      fireEvent.click(screen.getByRole('button', { name: /go back/i }));

      expect(ack).toHaveBeenCalled();
      expect(mockHistoryBack).toHaveBeenCalled();
    });

    it('acknowledges and navigates to / on Go to Home', () => {
      const ack = vi.fn();
      renderWithProviders(<PermissionDeniedModal />, {
        knowledgeBaseSession: createMockKnowledgeBaseSession({
          permissionDeniedAt: Date.now(),
          permissionDeniedMessage: 'denied',
          acknowledgePermissionDenied: ack,
        }),
      });

      fireEvent.click(screen.getByRole('button', { name: /go to home/i }));

      expect(ack).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/');
    });

    it('acknowledges and navigates to /auth/connect with current path on Switch Account', () => {
      const ack = vi.fn();
      mockLocation.pathname = '/admin/users';
      renderWithProviders(<PermissionDeniedModal />, {
        knowledgeBaseSession: createMockKnowledgeBaseSession({
          permissionDeniedAt: Date.now(),
          permissionDeniedMessage: 'denied',
          acknowledgePermissionDenied: ack,
        }),
      });

      fireEvent.click(screen.getByRole('button', { name: /switch account/i }));

      expect(ack).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/auth/connect?callbackUrl=%2Fadmin%2Fusers');
    });
  });
});
