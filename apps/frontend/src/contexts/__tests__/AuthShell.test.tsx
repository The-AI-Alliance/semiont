/**
 * AuthShell Composition Tests
 *
 * After Track 2, AuthShell is a thin frontend composition over a library
 * provider, the library protected error boundary, and the two library
 * modals. These tests verify the structural contract: every piece is
 * mounted, and the children render inside the chain.
 *
 * Library mocks are passthroughs/markers — the goal is structure, not
 * library behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    KnowledgeBaseSessionProvider: ({ children }: { children: React.ReactNode }) =>
      <div data-testid="kb-session-provider">{children}</div>,
    ProtectedErrorBoundary: ({ children }: { children: React.ReactNode }) =>
      <div data-testid="protected-error-boundary">{children}</div>,
    SessionExpiredModal: () => <div data-testid="session-expired-modal" />,
    PermissionDeniedModal: () => <div data-testid="permission-denied-modal" />,
  };
});

import { AuthShell } from '../AuthShell';

function renderShell() {
  return render(
    <AuthShell>
      <div data-testid="protected-content">protected body</div>
    </AuthShell>
  );
}

describe('AuthShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts KnowledgeBaseSessionProvider as the outermost wrapper', () => {
    renderShell();
    expect(screen.getByTestId('kb-session-provider')).toBeInTheDocument();
  });

  it('mounts ProtectedErrorBoundary inside KnowledgeBaseSessionProvider', () => {
    renderShell();
    const provider = screen.getByTestId('kb-session-provider');
    const boundary = screen.getByTestId('protected-error-boundary');
    expect(provider).toContainElement(boundary);
  });

  it('mounts SessionExpiredModal inside the boundary', () => {
    renderShell();
    const boundary = screen.getByTestId('protected-error-boundary');
    expect(boundary).toContainElement(screen.getByTestId('session-expired-modal'));
  });

  it('mounts PermissionDeniedModal inside the boundary', () => {
    renderShell();
    const boundary = screen.getByTestId('protected-error-boundary');
    expect(boundary).toContainElement(screen.getByTestId('permission-denied-modal'));
  });

  it('renders children inside the boundary alongside the modals', () => {
    renderShell();
    const boundary = screen.getByTestId('protected-error-boundary');
    expect(boundary).toContainElement(screen.getByTestId('protected-content'));
    expect(screen.getByText('protected body')).toBeInTheDocument();
  });
});
