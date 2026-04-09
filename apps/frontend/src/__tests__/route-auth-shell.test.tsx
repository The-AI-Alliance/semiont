/**
 * Route-level AuthShell Wrapping Test
 *
 * Verifies that the App.tsx route definition wraps `auth/welcome` in
 * AuthShell while the other auth routes (`auth/connect`, `auth/signup`,
 * `auth/error`) and the landing page do NOT mount AuthShell.
 *
 * This catches regressions where someone reorganizes routes and
 * accidentally drops or moves the AuthShell wrapper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

// AuthShell mocked as a marker
vi.mock('@/contexts/AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-shell-marker">{children}</div>
  ),
}));

// Stub all the lazy-loaded pages with marker components so we don't pull in
// their real implementations (which have their own provider needs)
vi.mock('@/app/[locale]/layout', () => ({
  default: () => {
    const { Outlet } = require('react-router-dom');
    return <div data-testid="locale-layout"><Outlet /></div>;
  },
}));

vi.mock('@/app/[locale]/page', () => ({
  default: () => <div data-testid="home-page">Home</div>,
}));

vi.mock('@/app/[locale]/about/page', () => ({ default: () => <div data-testid="about-page">About</div> }));
vi.mock('@/app/[locale]/privacy/page', () => ({ default: () => <div data-testid="privacy-page">Privacy</div> }));
vi.mock('@/app/[locale]/terms/page', () => ({ default: () => <div data-testid="terms-page">Terms</div> }));
vi.mock('@/app/[locale]/auth/connect/page', () => ({ default: () => <div data-testid="connect-page">Connect</div> }));
vi.mock('@/app/[locale]/auth/signup/page', () => ({ default: () => <div data-testid="signup-page">Signup</div> }));
vi.mock('@/app/[locale]/auth/error/page', () => ({ default: () => <div data-testid="error-page">Error</div> }));
vi.mock('@/app/[locale]/auth/welcome/page', () => ({ default: () => <div data-testid="welcome-page">Welcome</div> }));
vi.mock('@/app/[locale]/know/layout', () => ({
  default: () => {
    const { Outlet } = require('react-router-dom');
    return <div data-testid="know-layout"><Outlet /></div>;
  },
}));
vi.mock('@/app/[locale]/know/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/know/discover/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/know/compose/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/know/resource/[id]/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/admin/layout', () => ({ default: () => null }));
vi.mock('@/app/[locale]/admin/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/admin/users/client', () => ({ default: () => null }));
vi.mock('@/app/[locale]/admin/security/client', () => ({ default: () => null }));
vi.mock('@/app/[locale]/admin/exchange/client', () => ({ default: () => null }));
vi.mock('@/app/[locale]/admin/devops/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/layout', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/recent/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/entity-tags/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/tag-schemas/page', () => ({ default: () => null }));
vi.mock('@/app/[locale]/moderate/linked-data/client', () => ({ default: () => null }));
vi.mock('@/app/[locale]/not-found', () => ({ default: () => <div data-testid="not-found">404</div> }));

// i18n config used by App.tsx
vi.mock('@/i18n/config', () => ({
  DEFAULT_LOCALE: 'en',
  isSupportedLocale: (l: string) => l === 'en',
}));

// react-i18next is used for locale switching inside LocaleGuard
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import App from '../App';

function renderAppAt(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
    </MemoryRouter>
  );
}

describe('App route definitions — AuthShell wrapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('routes that should NOT mount AuthShell (pre-app surfaces)', () => {
    it('landing page (/en) does not mount AuthShell', async () => {
      renderAppAt('/en');
      await waitFor(() => {
        expect(screen.getByTestId('home-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('auth-shell-marker')).not.toBeInTheDocument();
    });

    it('auth/connect does not mount AuthShell', async () => {
      renderAppAt('/en/auth/connect');
      await waitFor(() => {
        expect(screen.getByTestId('connect-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('auth-shell-marker')).not.toBeInTheDocument();
    });

    it('auth/signup does not mount AuthShell', async () => {
      renderAppAt('/en/auth/signup');
      await waitFor(() => {
        expect(screen.getByTestId('signup-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('auth-shell-marker')).not.toBeInTheDocument();
    });

    it('auth/error does not mount AuthShell', async () => {
      renderAppAt('/en/auth/error');
      await waitFor(() => {
        expect(screen.getByTestId('error-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('auth-shell-marker')).not.toBeInTheDocument();
    });

    it('about does not mount AuthShell', async () => {
      renderAppAt('/en/about');
      await waitFor(() => {
        expect(screen.getByTestId('about-page')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('auth-shell-marker')).not.toBeInTheDocument();
    });
  });

  describe('routes that should mount AuthShell', () => {
    it('auth/welcome mounts AuthShell wrapping the WelcomePage', async () => {
      renderAppAt('/en/auth/welcome');
      await waitFor(() => {
        expect(screen.getByTestId('welcome-page')).toBeInTheDocument();
      });

      const marker = screen.getByTestId('auth-shell-marker');
      expect(marker).toBeInTheDocument();
      expect(marker).toContainElement(screen.getByTestId('welcome-page'));
    });
  });
});
