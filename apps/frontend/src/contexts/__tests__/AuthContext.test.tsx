/**
 * AuthContext Tests
 *
 * Focuses on the JWT validation behavior in AuthProvider — specifically
 * the catch handler when getMe fails with a 401:
 *
 *   1. Local session state is cleared
 *   2. The dead JWT is removed from localStorage via clearKbToken
 *   3. dispatch401Error is fired so SessionExpiredModal can surface
 *
 * Non-401 errors only clear local state (no token removal, no event).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, waitFor, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock dispatch401Error from the library
const mockDispatch401Error = vi.fn();
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    dispatch401Error: (...args: any[]) => mockDispatch401Error(...args),
  };
});

// Mock SemiontApiClient — we control whether getMe resolves or rejects
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

// Mock KnowledgeBaseContext
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

import { AuthProvider, useAuthContext } from '../AuthContext';
import { APIError } from '@semiont/api-client';

function ProbeChild() {
  const { session, isLoading } = useAuthContext();
  return (
    <div>
      <div data-testid="session">{session ? `user:${session.user?.email ?? 'unknown'}` : 'null'}</div>
      <div data-testid="loading">{isLoading ? 'loading' : 'idle'}</div>
    </div>
  );
}

describe('AuthContext / AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getMe success', () => {
    it('sets session state with the returned user', async () => {
      mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

      render(
        <AuthProvider>
          <ProbeChild />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('session')).toHaveTextContent('user:alice@example.com');
      });

      expect(mockClearKbToken).not.toHaveBeenCalled();
      expect(mockDispatch401Error).not.toHaveBeenCalled();
    });
  });

  describe('getMe 401 — token invalid/expired', () => {
    it('clears session state', async () => {
      mockGetMe.mockRejectedValueOnce(new APIError('Unauthorized', 401, 'Unauthorized'));

      render(
        <AuthProvider>
          <ProbeChild />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('session')).toHaveTextContent('null');
      });
    });

    it('calls clearKbToken with the active KB id', async () => {
      mockGetMe.mockRejectedValueOnce(new APIError('Unauthorized', 401, 'Unauthorized'));

      render(
        <AuthProvider>
          <ProbeChild />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(mockClearKbToken).toHaveBeenCalledWith('kb-1');
      });
    });

    it('dispatches the auth:unauthorized event', async () => {
      mockGetMe.mockRejectedValueOnce(new APIError('Unauthorized', 401, 'Unauthorized'));

      render(
        <AuthProvider>
          <ProbeChild />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(mockDispatch401Error).toHaveBeenCalled();
      });
      expect(mockDispatch401Error).toHaveBeenCalledWith(
        expect.stringContaining('expired')
      );
    });
  });

  describe('getMe non-401 error', () => {
    it('clears session but does NOT clear token or dispatch event', async () => {
      mockGetMe.mockRejectedValueOnce(new APIError('Server error', 500, 'Internal Server Error'));

      render(
        <AuthProvider>
          <ProbeChild />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('session')).toHaveTextContent('null');
      });

      expect(mockClearKbToken).not.toHaveBeenCalled();
      expect(mockDispatch401Error).not.toHaveBeenCalled();
    });

    it('treats network errors (non-APIError) as non-401', async () => {
      mockGetMe.mockRejectedValueOnce(new Error('Network failure'));

      render(
        <AuthProvider>
          <ProbeChild />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('session')).toHaveTextContent('null');
      });

      expect(mockClearKbToken).not.toHaveBeenCalled();
      expect(mockDispatch401Error).not.toHaveBeenCalled();
    });
  });
});
