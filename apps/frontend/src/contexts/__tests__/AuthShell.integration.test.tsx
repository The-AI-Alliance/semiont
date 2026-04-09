/**
 * AuthShell Integration Smoke Test
 *
 * Exercises the full chain end-to-end (in jsdom):
 *
 *   localStorage seeded with a KB + token
 *     → AuthShell mounts
 *     → KnowledgeBaseSessionProvider validates token via getMe
 *     → on 401: provider clears token + sets sessionExpiredAt
 *     → SessionExpiredModal reads sessionExpiredAt and renders
 *
 * If any link in this chain breaks, the user sees an empty page instead of
 * the modal. This is the integration the unit tests miss.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock SemiontApiClient — control whether getMe succeeds or fails
const mockGetMe = vi.fn();
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual<typeof import('@semiont/api-client')>('@semiont/api-client');
  class MockSemiontApiClient {
    getMe = mockGetMe;
  }
  return {
    ...actual,
    SemiontApiClient: MockSemiontApiClient,
  };
});

// Mock @headlessui/react to avoid jsdom portal issues
vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

// Build a fake JWT whose `exp` is far in the future, so the provider tries
// to validate it (rather than rejecting it as expired before calling getMe).
function makeFakeJwt(): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${header}.${payload}.sig`;
}

const KB_ID = 'kb-1';
const KB = {
  id: KB_ID,
  label: 'Test',
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'test@example.com',
};

import { AuthShell } from '../AuthShell';
import { APIError } from '@semiont/api-client';

describe('AuthShell integration — KB session validation → modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('semiont.knowledgeBases', JSON.stringify([KB]));
    localStorage.setItem('semiont.activeKnowledgeBaseId', KB_ID);
    localStorage.setItem(`semiont.token.${KB_ID}`, makeFakeJwt());
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders children and no modal when getMe succeeds', async () => {
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    render(
      <AuthShell>
        <div data-testid="protected-content">protected</div>
      </AuthShell>
    );

    await waitFor(() => {
      expect(mockGetMe).toHaveBeenCalled();
    });

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    // Token should still be in storage on success
    expect(localStorage.getItem(`semiont.token.${KB_ID}`)).not.toBeNull();
  });

  it('surfaces SessionExpiredModal when getMe fails with 401', async () => {
    mockGetMe.mockRejectedValueOnce(new APIError('Unauthorized', 401, 'Unauthorized'));

    render(
      <AuthShell>
        <div data-testid="protected-content">protected</div>
      </AuthShell>
    );

    await waitFor(() => {
      expect(screen.getByText('Session Expired')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /sign in again/i })).toBeInTheDocument();
    // Provider should have cleared the dead token
    expect(localStorage.getItem(`semiont.token.${KB_ID}`)).toBeNull();
    // Children still render alongside the modal
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
  });

  it('does NOT surface SessionExpiredModal when getMe fails with 500', async () => {
    mockGetMe.mockRejectedValueOnce(new APIError('Server error', 500, 'Internal Server Error'));

    render(
      <AuthShell>
        <div data-testid="protected-content">protected</div>
      </AuthShell>
    );

    await waitFor(() => {
      expect(mockGetMe).toHaveBeenCalled();
    });

    expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    // Token should NOT be cleared on a 500
    expect(localStorage.getItem(`semiont.token.${KB_ID}`)).not.toBeNull();
  });
});
