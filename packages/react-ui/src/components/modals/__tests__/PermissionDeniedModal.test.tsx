/**
 * PermissionDeniedModal Tests
 *
 * The modal renders content when `permissionDenied$` holds a notice on the
 * active signals, and is hidden otherwise. Its own copy comes from the
 * person's locale; beneath it, when the gateway said why it refused, are the
 * gateway's words, unaltered and marked as the knowledge base's. Button
 * clicks call `acknowledgePermissionDenied()` and navigate the window or
 * history.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  renderWithProviders,
  createTestBrowserWithSignals,
  createMockTranslationManager,
} from '../../../test-utils';
import { PermissionDeniedModal } from '../PermissionDeniedModal';
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
const SAID = 'Archiving needs the curator role.';

const originalLocation = window.location;
const originalHistoryBack = window.history.back;
let mockLocation: { href: string; pathname: string };
let mockHistoryBack: Mock<() => void>;

beforeEach(() => {
  mockLocation = { href: '', pathname: '/admin/users' };
  Object.defineProperty(window, 'location', {
    value: mockLocation,
    writable: true,
    configurable: true,
  });
  mockHistoryBack = vi.fn<() => void>();
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
    it('does not render modal content when nothing is raised', () => {
      renderWithProviders(<PermissionDeniedModal />, {
        browser: createTestBrowserWithSignals(),
        translationManager: english,
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('when permission-denied is raised', () => {
    it('shows its own copy: title, the reasons, and every button', () => {
      renderWithProviders(<PermissionDeniedModal />, {
        browser: createTestBrowserWithSignals({ permissionDenied: { detail: null } }),
        translationManager: english,
      });

      const m = en.PermissionDeniedModal;
      expect(screen.getByText(m.title)).toBeInTheDocument();
      expect(screen.getByText(m.reasonsIntro)).toBeInTheDocument();
      expect(screen.getByText(m.reasonPermissions)).toBeInTheDocument();
      expect(screen.getByText(m.reasonRestricted)).toBeInTheDocument();
      expect(screen.getByText(m.reasonAccountType)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: m.goBack })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: m.goHome })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: m.switchAccount })).toBeInTheDocument();
    });

    it("shows the gateway's words beneath, unaltered and marked as the knowledge base's", () => {
      renderWithProviders(<PermissionDeniedModal />, {
        browser: createTestBrowserWithSignals({ permissionDenied: { detail: SAID } }),
        translationManager: english,
      });

      const said = screen.getByText(SAID);
      expect(said.tagName).toBe('BLOCKQUOTE');
      expect(said.closest('figure')).toHaveTextContent(en.PermissionDeniedModal.detailLabel);
    });

    it('a gateway that said nothing shows no detail, and no label for one', () => {
      renderWithProviders(<PermissionDeniedModal />, {
        browser: createTestBrowserWithSignals({ permissionDenied: { detail: null } }),
        translationManager: english,
      });

      expect(screen.queryByText(en.PermissionDeniedModal.detailLabel)).not.toBeInTheDocument();
    });

    it("a person using the application in Japanese reads its copy in Japanese, and the gateway's words as it wrote them", () => {
      renderWithProviders(<PermissionDeniedModal />, {
        browser: createTestBrowserWithSignals({ permissionDenied: { detail: SAID } }),
        translationManager: japanese,
      });

      const m = ja.PermissionDeniedModal;
      expect(m.title).not.toBe(en.PermissionDeniedModal.title);
      expect(screen.getByText(m.title)).toBeInTheDocument();
      expect(screen.getByText(m.reasonsIntro)).toBeInTheDocument();
      expect(screen.getByText(m.reasonPermissions)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: m.goBack })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: m.switchAccount })).toBeInTheDocument();
      expect(screen.getByText(m.detailLabel)).toBeInTheDocument();
      expect(screen.getByText(SAID)).toBeInTheDocument();
      expect(screen.queryByText(en.PermissionDeniedModal.title)).not.toBeInTheDocument();
    });
  });

  describe('button actions', () => {
    it('acknowledges and calls window.history.back on Go Back', () => {
      const ack = vi.fn();
      renderWithProviders(<PermissionDeniedModal />, {
        browser: createTestBrowserWithSignals({
          permissionDenied: { detail: null },
          acknowledgePermissionDenied: ack,
        }),
        translationManager: english,
      });

      fireEvent.click(screen.getByRole('button', { name: en.PermissionDeniedModal.goBack }));

      expect(ack).toHaveBeenCalled();
      expect(mockHistoryBack).toHaveBeenCalled();
    });

    it('acknowledges and navigates to / on Go to Home', () => {
      const ack = vi.fn();
      renderWithProviders(<PermissionDeniedModal />, {
        browser: createTestBrowserWithSignals({
          permissionDenied: { detail: null },
          acknowledgePermissionDenied: ack,
        }),
        translationManager: english,
      });

      fireEvent.click(screen.getByRole('button', { name: en.PermissionDeniedModal.goHome }));

      expect(ack).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/');
    });

    it('acknowledges and navigates to /auth/connect with current path on Switch Account', () => {
      const ack = vi.fn();
      mockLocation.pathname = '/admin/users';
      renderWithProviders(<PermissionDeniedModal />, {
        browser: createTestBrowserWithSignals({
          permissionDenied: { detail: null },
          acknowledgePermissionDenied: ack,
        }),
        translationManager: english,
      });

      fireEvent.click(screen.getByRole('button', { name: en.PermissionDeniedModal.switchAccount }));

      expect(ack).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/auth/connect?callbackUrl=%2Fadmin%2Fusers');
    });
  });
});
