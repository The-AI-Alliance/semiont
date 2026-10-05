/**
 * AuthShell Composition Tests
 *
 * AuthShell is a thin frontend composition over the library's protected
 * error boundary and its three modals. The session state (KB list, active
 * KB, SemiontSession) is owned by the module-scoped `SemiontBrowser`
 * singleton and exposed via `<SemiontProvider>` at the app root — AuthShell
 * mounts no session provider.
 *
 * Library mocks are passthroughs/markers — the goal is structure, not
 * library behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router';

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    ProtectedErrorBoundary: ({ children }: { children: React.ReactNode }) =>
      <div data-testid="protected-error-boundary">{children}</div>,
    SessionEndedModal: () => <div data-testid="session-ended-modal" />,
    PermissionDeniedModal: () => <div data-testid="permission-denied-modal" />,
    KbIdentityConflictModal: () => <div data-testid="kb-identity-conflict-modal" />,
  };
});

import { AuthShell } from '../AuthShell';

function renderShell() {
  return render(
    <MemoryRouter>
      <AuthShell>
        <div data-testid="protected-content">protected body</div>
      </AuthShell>
    </MemoryRouter>
  );
}

describe('AuthShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts ProtectedErrorBoundary as the outer wrapper', () => {
    renderShell();
    expect(screen.getByTestId('protected-error-boundary')).toBeInTheDocument();
  });

  it('mounts SessionEndedModal inside the boundary', () => {
    renderShell();
    const boundary = screen.getByTestId('protected-error-boundary');
    expect(boundary).toContainElement(screen.getByTestId('session-ended-modal'));
  });

  it('mounts PermissionDeniedModal inside the boundary', () => {
    renderShell();
    const boundary = screen.getByTestId('protected-error-boundary');
    expect(boundary).toContainElement(screen.getByTestId('permission-denied-modal'));
  });

  it('mounts KbIdentityConflictModal inside the boundary', () => {
    renderShell();
    const boundary = screen.getByTestId('protected-error-boundary');
    expect(boundary).toContainElement(screen.getByTestId('kb-identity-conflict-modal'));
  });

  it('renders children inside the boundary alongside the modals', () => {
    renderShell();
    const boundary = screen.getByTestId('protected-error-boundary');
    expect(boundary).toContainElement(screen.getByTestId('protected-content'));
    expect(screen.getByText('protected body')).toBeInTheDocument();
  });
});
