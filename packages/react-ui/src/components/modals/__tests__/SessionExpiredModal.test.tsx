/**
 * SessionExpiredModal Tests
 *
 * Tests the modal that surfaces when:
 * - The user transitions from authenticated → not authenticated (via SessionContext)
 * - An `auth:unauthorized` event is dispatched on the window
 *
 * The modal is hidden by default and only renders content when triggered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders, createMockSessionManager } from '../../../test-utils';
import { SessionExpiredModal } from '../SessionExpiredModal';
import { dispatch401Error } from '../../../lib/auth-events';

// Mock HeadlessUI to avoid jsdom issues with portals/transitions
vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

// Mock window.location for navigation assertions
const originalLocation = window.location;
let mockLocation: { href: string; pathname: string };

beforeEach(() => {
  mockLocation = { href: '', pathname: '/know/discover' };
  Object.defineProperty(window, 'location', {
    value: mockLocation,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

describe('SessionExpiredModal', () => {
  describe('initial render', () => {
    it('does not render modal content when authenticated and no event fired', () => {
      renderWithProviders(<SessionExpiredModal />, {
        sessionManager: createMockSessionManager({ isAuthenticated: true }),
      });
      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    });

    it('does not render modal content when initially unauthenticated', () => {
      renderWithProviders(<SessionExpiredModal />, {
        sessionManager: createMockSessionManager({ isAuthenticated: false }),
      });
      // No transition occurred, no event fired → modal stays hidden
      expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    });
  });

  describe('on auth:unauthorized event', () => {
    it('shows modal when dispatch401Error is called', () => {
      renderWithProviders(<SessionExpiredModal />, {
        sessionManager: createMockSessionManager({ isAuthenticated: true }),
      });

      act(() => {
        dispatch401Error('Token expired');
      });

      expect(screen.getByText('Session Expired')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in again/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /go to home/i })).toBeInTheDocument();
    });

    it('shows modal regardless of session state when 401 fires', () => {
      renderWithProviders(<SessionExpiredModal />, {
        sessionManager: createMockSessionManager({ isAuthenticated: false }),
      });

      act(() => {
        dispatch401Error();
      });

      expect(screen.getByText('Session Expired')).toBeInTheDocument();
    });
  });

  describe('button actions', () => {
    it('navigates to /auth/connect with current path on Sign In Again', () => {
      mockLocation.pathname = '/know/discover';
      renderWithProviders(<SessionExpiredModal />, {
        sessionManager: createMockSessionManager({ isAuthenticated: true }),
      });

      act(() => {
        dispatch401Error();
      });

      fireEvent.click(screen.getByRole('button', { name: /sign in again/i }));

      expect(mockLocation.href).toBe('/auth/connect?callbackUrl=%2Fknow%2Fdiscover');
    });

    it('navigates to / on Go to Home', () => {
      renderWithProviders(<SessionExpiredModal />, {
        sessionManager: createMockSessionManager({ isAuthenticated: true }),
      });

      act(() => {
        dispatch401Error();
      });

      fireEvent.click(screen.getByRole('button', { name: /go to home/i }));

      expect(mockLocation.href).toBe('/');
    });
  });
});
