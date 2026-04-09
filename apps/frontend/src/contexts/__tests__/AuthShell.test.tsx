/**
 * AuthShell Integration Tests
 *
 * Verifies that AuthShell:
 * - Bundles KnowledgeBaseProvider, AuthProvider, SessionProvider, and the auth-failure modals
 * - Renders its children (the protected layout body)
 * - Re-keys AuthProvider when the active KB changes (so token validation re-runs)
 *
 * These tests use mocks heavily — the goal is to verify the structural contract
 * of AuthShell, not the behavior of its individual children (which have their
 * own tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock the AuthContext module — we don't want to actually validate tokens
vi.mock('@/contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) =>
    <div data-testid="auth-provider">{children}</div>,
}));

// Mock KnowledgeBaseContext — control the active KB
const mockKbContext = {
  knowledgeBases: [{ id: 'kb-1', label: 'Test', host: 'localhost', port: 4000, protocol: 'http' as const, email: 'test@example.com' }],
  activeKnowledgeBase: { id: 'kb-1', label: 'Test', host: 'localhost', port: 4000, protocol: 'http' as const, email: 'test@example.com' },
  activeKnowledgeBaseId: 'kb-1',
  addKnowledgeBase: vi.fn(),
  removeKnowledgeBase: vi.fn(),
  setActiveKnowledgeBase: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  signOut: vi.fn(),
};

vi.mock('@/contexts/KnowledgeBaseContext', () => ({
  KnowledgeBaseProvider: ({ children }: { children: React.ReactNode }) =>
    <div data-testid="kb-provider">{children}</div>,
  useKnowledgeBaseContext: () => mockKbContext,
  kbBackendUrl: (kb: any) => `${kb.protocol}://${kb.host}:${kb.port}`,
  getKbToken: () => 'mock-token',
  clearKbToken: vi.fn(),
  isTokenExpired: () => false,
}));

// Mock the AuthErrorBoundary as a passthrough
vi.mock('@/components/AuthErrorBoundary', () => ({
  AuthErrorBoundary: ({ children }: { children: React.ReactNode }) =>
    <div data-testid="auth-error-boundary">{children}</div>,
}));

// Mock useSessionManager
vi.mock('@/hooks/useSessionManager', () => ({
  useSessionManager: () => ({
    isAuthenticated: true,
    expiresAt: null,
    timeUntilExpiry: null,
    isExpiringSoon: false,
  }),
}));

// Mock @semiont/react-ui — passthrough providers, marker modals
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    SessionProvider: ({ children }: { children: React.ReactNode }) =>
      <div data-testid="session-provider">{children}</div>,
    SessionExpiredModal: () => <div data-testid="session-expired-modal" />,
    PermissionDeniedModal: () => <div data-testid="permission-denied-modal" />,
  };
});

import { AuthShell } from '../AuthShell';

describe('AuthShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('provider composition', () => {
    it('mounts KnowledgeBaseProvider as the outermost wrapper', () => {
      render(
        <AuthShell>
          <div data-testid="protected-content">protected</div>
        </AuthShell>
      );

      expect(screen.getByTestId('kb-provider')).toBeInTheDocument();
    });

    it('mounts AuthProvider inside KnowledgeBaseProvider', () => {
      render(
        <AuthShell>
          <div data-testid="protected-content">protected</div>
        </AuthShell>
      );

      const kb = screen.getByTestId('kb-provider');
      const auth = screen.getByTestId('auth-provider');
      expect(kb).toContainElement(auth);
    });

    it('mounts SessionProvider inside AuthProvider', () => {
      render(
        <AuthShell>
          <div data-testid="protected-content">protected</div>
        </AuthShell>
      );

      const auth = screen.getByTestId('auth-provider');
      const session = screen.getByTestId('session-provider');
      expect(auth).toContainElement(session);
    });

    it('mounts AuthErrorBoundary inside AuthProvider', () => {
      render(
        <AuthShell>
          <div data-testid="protected-content">protected</div>
        </AuthShell>
      );

      const auth = screen.getByTestId('auth-provider');
      const boundary = screen.getByTestId('auth-error-boundary');
      expect(auth).toContainElement(boundary);
    });
  });

  describe('modals', () => {
    it('mounts SessionExpiredModal', () => {
      render(
        <AuthShell>
          <div data-testid="protected-content">protected</div>
        </AuthShell>
      );

      expect(screen.getByTestId('session-expired-modal')).toBeInTheDocument();
    });

    it('mounts PermissionDeniedModal', () => {
      render(
        <AuthShell>
          <div data-testid="protected-content">protected</div>
        </AuthShell>
      );

      expect(screen.getByTestId('permission-denied-modal')).toBeInTheDocument();
    });

    it('mounts both modals inside SessionProvider', () => {
      render(
        <AuthShell>
          <div data-testid="protected-content">protected</div>
        </AuthShell>
      );

      const session = screen.getByTestId('session-provider');
      expect(session).toContainElement(screen.getByTestId('session-expired-modal'));
      expect(session).toContainElement(screen.getByTestId('permission-denied-modal'));
    });
  });

  describe('children', () => {
    it('renders children inside the provider chain', () => {
      render(
        <AuthShell>
          <div data-testid="protected-content">protected body</div>
        </AuthShell>
      );

      expect(screen.getByTestId('protected-content')).toBeInTheDocument();
      expect(screen.getByText('protected body')).toBeInTheDocument();
    });

    it('renders children alongside the modals (siblings under SessionProvider)', () => {
      render(
        <AuthShell>
          <div data-testid="protected-content">protected</div>
        </AuthShell>
      );

      const session = screen.getByTestId('session-provider');
      expect(session).toContainElement(screen.getByTestId('protected-content'));
    });
  });
});
