/**
 * SessionEndedModal Tests
 *
 * The modal renders content when `sessionEnded$` holds a notice on the
 * active signals, and is hidden otherwise. Every word comes from the
 * person's locale: the notice carries a reason, never a sentence, so the
 * modal picks the sentence. Button clicks call `acknowledgeSessionEnded()`
 * and navigate the window.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  renderWithProviders,
  createTestBrowserWithSignals,
  createMockTranslationManager,
} from '../../../test-utils';
import { SessionEndedModal } from '../SessionEndedModal';
import en from '../../../../translations/en.json';
import ja from '../../../../translations/ja.json';

vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

const english = createMockTranslationManager(en);
const japanese = createMockTranslationManager(ja);

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

describe('SessionEndedModal', () => {
  describe('initial render', () => {
    it('does not render modal content when nothing is raised', () => {
      renderWithProviders(<SessionEndedModal />, {
        browser: createTestBrowserWithSignals(),
        translationManager: english,
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('when the session ended', () => {
    it('an expired session is told so, under the one title', () => {
      renderWithProviders(<SessionEndedModal />, {
        browser: createTestBrowserWithSignals({ sessionEnded: { reason: 'expired' } }),
        translationManager: english,
      });

      expect(screen.getByText(en.SessionEndedModal.title)).toBeInTheDocument();
      expect(screen.getByText(en.SessionEndedModal.expired)).toBeInTheDocument();
      expect(screen.queryByText(en.SessionEndedModal.refused)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: en.SessionEndedModal.signInAgain })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: en.SessionEndedModal.goHome })).toBeInTheDocument();
    });

    it('a refused credential is told so, under the same title', () => {
      renderWithProviders(<SessionEndedModal />, {
        browser: createTestBrowserWithSignals({ sessionEnded: { reason: 'refused' } }),
        translationManager: english,
      });

      expect(screen.getByText(en.SessionEndedModal.title)).toBeInTheDocument();
      expect(screen.getByText(en.SessionEndedModal.refused)).toBeInTheDocument();
      expect(screen.queryByText(en.SessionEndedModal.expired)).not.toBeInTheDocument();
    });

    it('a person using the application in Japanese is told in Japanese: title, reason and buttons', () => {
      renderWithProviders(<SessionEndedModal />, {
        browser: createTestBrowserWithSignals({ sessionEnded: { reason: 'refused' } }),
        translationManager: japanese,
      });

      expect(ja.SessionEndedModal.title).not.toBe(en.SessionEndedModal.title);
      expect(screen.getByText(ja.SessionEndedModal.title)).toBeInTheDocument();
      expect(screen.getByText(ja.SessionEndedModal.refused)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: ja.SessionEndedModal.signInAgain })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: ja.SessionEndedModal.goHome })).toBeInTheDocument();
      expect(screen.queryByText(en.SessionEndedModal.title)).not.toBeInTheDocument();
      expect(screen.queryByText(en.SessionEndedModal.refused)).not.toBeInTheDocument();
    });
  });

  describe('button actions', () => {
    it('calls acknowledgeSessionEnded and navigates to /auth/connect on Sign In Again', () => {
      const ack = vi.fn();
      mockLocation.pathname = '/know/discover';
      renderWithProviders(<SessionEndedModal />, {
        browser: createTestBrowserWithSignals({
          sessionEnded: { reason: 'expired' },
          acknowledgeSessionEnded: ack,
        }),
        translationManager: english,
      });

      fireEvent.click(screen.getByRole('button', { name: en.SessionEndedModal.signInAgain }));

      expect(ack).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/auth/connect?callbackUrl=%2Fknow%2Fdiscover');
    });

    it('calls acknowledgeSessionEnded and navigates to / on Go to Home', () => {
      const ack = vi.fn();
      renderWithProviders(<SessionEndedModal />, {
        browser: createTestBrowserWithSignals({
          sessionEnded: { reason: 'expired' },
          acknowledgeSessionEnded: ack,
        }),
        translationManager: english,
      });

      fireEvent.click(screen.getByRole('button', { name: en.SessionEndedModal.goHome }));

      expect(ack).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/');
    });
  });
});
