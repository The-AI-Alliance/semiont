/**
 * LocaleLayout Provider Boundary Tests
 *
 * Regression tests that assert the locale layout does NOT mount any
 * auth-dependent providers. The whole point of the AuthShell extraction
 * is that pre-app routes (landing, about, OAuth flow) don't trigger
 * JWT validation or surface session-expired modals.
 *
 * If a future change accidentally re-introduces AuthProvider at the
 * locale level, these tests fail loudly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock app-specific providers as passthroughs (we don't care about their internals)
vi.mock('@/app/providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/CookieBanner', () => ({
  CookieBanner: () => null,
}));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    SkipLinks: () => null,
  };
});

import LocaleLayout from '../layout';
import { useKnowledgeBaseSession } from '@semiont/react-ui';

/**
 * A child component that calls useKnowledgeBaseSession. If LocaleLayout
 * has not mounted AuthShell (the desired behavior), this throws — proving
 * the boundary holds.
 */
function AuthContextProbe() {
  useKnowledgeBaseSession();
  return <div data-testid="probe">probe</div>;
}

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

  it('does NOT mount AuthShell — useKnowledgeBaseSession throws when called outside it', () => {
    // React logs the thrown error to console.error before re-raising;
    // suppress it for clean test output.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      renderLocaleLayoutWithChild(<AuthContextProbe />);
    }).toThrow(/useKnowledgeBaseSession requires KnowledgeBaseSessionProvider/);
    consoleError.mockRestore();
  });

  it('renders children via Outlet', () => {
    renderLocaleLayoutWithChild(<div data-testid="child">page content</div>);
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });
});
