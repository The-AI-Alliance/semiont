/**
 * SessionExpiredModal Tests
 *
 * The modal renders content when `sessionExpired$` holds a notice on the
 * KnowledgeBaseSession context, and is hidden otherwise. Button clicks
 * call `acknowledgeSessionExpired()` and navigate the window.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  renderWithProviders,
  createTestBrowserWithSignals,
} from '../../../test-utils';
import { SessionExpiredModal } from '../SessionExpiredModal';

vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

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
    it('does not render modal content when nothing is raised', () => {
      renderWithProviders(<SessionExpiredModal />, {
        browser: createTestBrowserWithSignals(),
      });
      expect(screen.queryByText('Signed Out')).not.toBeInTheDocument();
    });
  });

  describe('when session-expired is raised', () => {
    it('renders the modal with default message', () => {
      renderWithProviders(<SessionExpiredModal />, {
        browser: createTestBrowserWithSignals({
          sessionExpired: { message: null },
        }),
      });

      expect(screen.getByText('Signed Out')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in again/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /go to home/i })).toBeInTheDocument();
    });

    it('renders the custom message from the notice', () => {
      renderWithProviders(<SessionExpiredModal />, {
        browser: createTestBrowserWithSignals({
          sessionExpired: { message: 'Your token expired at 5pm' },
        }),
      });
      expect(screen.getByText(/your token expired at 5pm/i)).toBeInTheDocument();
    });
  });

  describe('button actions', () => {
    it('calls acknowledgeSessionExpired and navigates to /auth/connect on Sign In Again', () => {
      const ack = vi.fn();
      mockLocation.pathname = '/know/discover';
      renderWithProviders(<SessionExpiredModal />, {
        browser: createTestBrowserWithSignals({
          sessionExpired: { message: null },
          acknowledgeSessionExpired: ack,
        }),
      });

      fireEvent.click(screen.getByRole('button', { name: /sign in again/i }));

      expect(ack).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/auth/connect?callbackUrl=%2Fknow%2Fdiscover');
    });

    it('calls acknowledgeSessionExpired and navigates to / on Go to Home', () => {
      const ack = vi.fn();
      renderWithProviders(<SessionExpiredModal />, {
        browser: createTestBrowserWithSignals({
          sessionExpired: { message: null },
          acknowledgeSessionExpired: ack,
        }),
      });

      fireEvent.click(screen.getByRole('button', { name: /go to home/i }));

      expect(ack).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/');
    });
  });
});
