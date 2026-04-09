/**
 * AuthShell Integration Smoke Test
 *
 * Exercises the full chain end-to-end (in jsdom):
 *
 *   AuthShell mount
 *     → AuthProvider validates JWT (mocked getMe returns 401)
 *     → catch handler clears local session
 *     → dispatches `auth:unauthorized` event
 *     → SessionExpiredModal (mounted inside AuthShell) catches the event
 *     → modal renders "Session Expired" + "Sign In Again" button
 *
 * This is the integration the unit tests miss: AuthShell + AuthProvider +
 * SessionExpiredModal working together as one piece. If any link in this
 * chain breaks, the user sees an empty page instead of the modal.
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

// Mock KnowledgeBaseContext to provide an active KB and a stored token
const mockClearKbToken = vi.fn();
const mockKb = {
  id: 'kb-1',
  label: 'Test',
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'test@example.com',
};

vi.mock('@/contexts/KnowledgeBaseContext', () => ({
  KnowledgeBaseProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useKnowledgeBaseContext: () => ({
    knowledgeBases: [mockKb],
    activeKnowledgeBase: mockKb,
    activeKnowledgeBaseId: 'kb-1',
    addKnowledgeBase: vi.fn(),
    removeKnowledgeBase: vi.fn(),
    setActiveKnowledgeBase: vi.fn(),
    updateKnowledgeBase: vi.fn(),
    signOut: vi.fn(),
  }),
  kbBackendUrl: (kb: any) => `${kb.protocol}://${kb.host}:${kb.port}`,
  getKbToken: () => 'fake-jwt-token',
  clearKbToken: (...args: any[]) => mockClearKbToken(...args),
  isTokenExpired: () => false,
}));

// Mock useSessionManager — produce a real-ish session manager that responds
// to the dispatched event flow. Since dispatch401Error is global (window
// CustomEvent), the SessionExpiredModal will pick it up regardless.
vi.mock('@/hooks/useSessionManager', () => ({
  useSessionManager: () => ({
    isAuthenticated: true,
    expiresAt: null,
    timeUntilExpiry: null,
    isExpiringSoon: false,
  }),
}));

// Mock @headlessui/react to avoid jsdom portal issues
vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

import { AuthShell } from '../AuthShell';
import { APIError } from '@semiont/api-client';

describe('AuthShell integration — 401 → SessionExpiredModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders children and no modal when getMe succeeds', async () => {
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    render(
      <AuthShell>
        <div data-testid="protected-content">protected</div>
      </AuthShell>
    );

    // Wait for the initial validation to settle
    await waitFor(() => {
      expect(mockGetMe).toHaveBeenCalled();
    });

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    // Modal should NOT have surfaced
    expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    expect(mockClearKbToken).not.toHaveBeenCalled();
  });

  it('surfaces SessionExpiredModal when getMe fails with 401', async () => {
    mockGetMe.mockRejectedValueOnce(new APIError('Unauthorized', 401, 'Unauthorized'));

    render(
      <AuthShell>
        <div data-testid="protected-content">protected</div>
      </AuthShell>
    );

    // Modal should appear
    await waitFor(() => {
      expect(screen.getByText('Session Expired')).toBeInTheDocument();
    });

    // The "Sign In Again" button is present
    expect(screen.getByRole('button', { name: /sign in again/i })).toBeInTheDocument();

    // The dead token was cleared
    expect(mockClearKbToken).toHaveBeenCalledWith('kb-1');

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

    // Non-401 errors should NOT surface the session-expired modal
    expect(screen.queryByText('Session Expired')).not.toBeInTheDocument();
    expect(mockClearKbToken).not.toHaveBeenCalled();
  });
});
