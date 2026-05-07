/**
 * LocaleLayout Provider Boundary Tests
 *
 * Regression tests that assert the locale layout does NOT mount AuthShell.
 * The whole point of the AuthShell extraction is that pre-app routes
 * (landing, about, OAuth flow) don't mount the auth-failure modals or
 * protected error boundary.
 *
 * AuthShell is mocked as a marker; the test fails if the locale layout
 * renders it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock app-specific providers as passthroughs
vi.mock('@/app/providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/CookieBanner', () => ({
  CookieBanner: () => null,
}));

// AuthShell mocked as a marker — test fails if locale layout mounts it
vi.mock('@/contexts/AuthShell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) =>
    <div data-testid="auth-shell-marker">{children}</div>,
}));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    SkipLinks: () => null,
  };
});

import LocaleLayout from '../layout';

function renderLocaleLayoutWithChild(child: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/en']}>
      <Routes>
        <Route path="/en" element={<LocaleLayout />}>
          <Route index element={child} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('LocaleLayout — provider boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT mount AuthShell at the locale level', () => {
    renderLocaleLayoutWithChild(<div data-testid="child">content</div>);
    expect(screen.queryByTestId('auth-shell-marker')).not.toBeInTheDocument();
  });

  it('renders children via Outlet', () => {
    renderLocaleLayoutWithChild(<div data-testid="child">page content</div>);
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });
});
