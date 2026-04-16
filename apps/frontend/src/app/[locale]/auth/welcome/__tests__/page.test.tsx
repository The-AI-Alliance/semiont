/**
 * Welcome Page — decline-terms flow
 *
 * The decline path used to call the deleted `clearSession()` (in-memory only).
 * Track 2 changed it to `signOut(activeKnowledgeBase.id)`, which also clears
 * the per-KB JWT in localStorage. This test pins that behavior.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRouterPush = vi.fn();
vi.mock('@/i18n/routing', () => ({
  useRouter: () => ({ push: mockRouterPush }),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const ACTIVE_KB = {
  id: 'kb-1',
  label: 'Test',
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'admin@example.com',
};

const mockSignOut = vi.fn();
const mockUseKbSession = vi.fn();
const mockGetMe = vi.fn();
const mockAcceptTerms = vi.fn();

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useKnowledgeBaseSession: () => mockUseKbSession(),
    useApiClient: () => ({
      getMe: mockGetMe,
      acceptTerms: mockAcceptTerms,
    }),
    useAuthToken: () => 'test-token',
    useToast: () => ({ showError: vi.fn(), showSuccess: vi.fn() }),
    PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    // The library WelcomePage is a presentational component that takes
    // onAccept/onDecline callbacks. Replace it with a marker that exposes
    // those callbacks as buttons we can click.
    WelcomePage: ({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) => (
      <div data-testid="welcome-page">
        <button onClick={onAccept}>accept</button>
        <button onClick={onDecline}>decline</button>
      </div>
    ),
  };
});

import Welcome from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated, KB active, terms not yet accepted
  mockUseKbSession.mockReturnValue({
    isAuthenticated: true,
    isLoading: false,
    user: { name: 'Alice Anderson', email: 'alice@example.com' },
    activeKnowledgeBase: ACTIVE_KB,
    signOut: mockSignOut,
  });
  mockGetMe.mockResolvedValue({ termsAcceptedAt: null });
});

describe('Welcome page — decline terms flow', () => {
  it('signs out of the active KB and navigates home', () => {
    render(<Welcome />);

    fireEvent.click(screen.getByText('decline'));

    expect(mockSignOut).toHaveBeenCalledWith(ACTIVE_KB.id);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith('/');
    // The accept-mutation must NOT be called on decline
    expect(mockAcceptTerms).not.toHaveBeenCalled();
  });

  it('does not call signOut when no KB is active, but still navigates home', () => {
    mockUseKbSession.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { name: 'Alice', email: 'alice@example.com' },
      activeKnowledgeBase: null,
      signOut: mockSignOut,
    });

    render(<Welcome />);

    fireEvent.click(screen.getByText('decline'));

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith('/');
  });
});
