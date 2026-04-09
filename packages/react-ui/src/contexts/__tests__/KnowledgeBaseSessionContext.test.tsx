/**
 * KnowledgeBaseSessionContext Tests
 *
 * Exercises the merged provider against jsdom localStorage with a mocked
 * SemiontApiClient. Covers:
 *
 *   - Mount-time JWT validation (success / 401 / non-401 / no token)
 *   - The cross-tree notify functions: register on mount, no-op when no
 *     provider is mounted, set state when mounted, unregister on unmount
 *   - Mutations: addKnowledgeBase, signIn, signOut, removeKnowledgeBase,
 *     setActiveKnowledgeBase, updateKnowledgeBase
 *   - KB-switch atomic re-validation (the central architectural claim)
 *   - signIn re-validating the active KB (the regression case for the
 *     fragile object-reference fix)
 *   - acknowledgeSessionExpired / acknowledgePermissionDenied flag clearing
 *   - Derived auth fields (isAuthenticated, isAdmin, displayName, etc.)
 *   - getKbSessionStatus pure helper
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { APIError } from '@semiont/api-client';

import {
  KnowledgeBaseSessionProvider,
  useKnowledgeBaseSession,
  notifySessionExpired,
  notifyPermissionDenied,
  getKbSessionStatus,
  defaultProtocol,
  kbBackendUrl,
} from '../KnowledgeBaseSessionContext';

// ---------- SemiontApiClient mock ----------

const mockGetMe = vi.fn();
const mockRefreshToken = vi.fn();
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual<typeof import('@semiont/api-client')>('@semiont/api-client');
  class MockSemiontApiClient {
    getMe = mockGetMe;
    refreshToken = mockRefreshToken;
  }
  return {
    ...actual,
    SemiontApiClient: MockSemiontApiClient,
  };
});

// ---------- Helpers ----------

function makeFakeJwt(expSecondsFromNow = 3600): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `${header}.${payload}.sig`;
}

const KB_A = {
  id: 'kb-a',
  label: 'KB A',
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'alice@example.com',
};

const KB_B = {
  id: 'kb-b',
  label: 'KB B',
  host: 'example.com',
  port: 443,
  protocol: 'https' as const,
  email: 'bob@example.com',
};

function seedStorage(args: {
  knowledgeBases?: Array<typeof KB_A>;
  activeId?: string | null;
  /**
   * Per-KB tokens. Pass a string to default the refresh token to a fresh
   * 30-day JWT, or pass an explicit `{ access, refresh }` pair.
   */
  tokens?: Record<string, string | { access: string; refresh: string }>;
} = {}) {
  if (args.knowledgeBases !== undefined) {
    localStorage.setItem('semiont.knowledgeBases', JSON.stringify(args.knowledgeBases));
  }
  if (args.activeId !== undefined) {
    if (args.activeId === null) localStorage.removeItem('semiont.activeKnowledgeBaseId');
    else localStorage.setItem('semiont.activeKnowledgeBaseId', args.activeId);
  }
  if (args.tokens) {
    for (const [id, value] of Object.entries(args.tokens)) {
      const session = typeof value === 'string'
        ? { access: value, refresh: makeFakeJwt(30 * 24 * 3600) }
        : value;
      localStorage.setItem(`semiont.session.${id}`, JSON.stringify(session));
    }
  }
}

function getStoredAccess(kbId: string): string | null {
  const raw = localStorage.getItem(`semiont.session.${kbId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.access === 'string') return parsed.access;
  } catch { /* malformed */ }
  return null;
}

function getStoredRefresh(kbId: string): string | null {
  const raw = localStorage.getItem(`semiont.session.${kbId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.refresh === 'string') return parsed.refresh;
  } catch { /* malformed */ }
  return null;
}

interface ProbeApi {
  current: ReturnType<typeof useKnowledgeBaseSession> | null;
}

function makeProbe(): { Probe: React.FC; api: ProbeApi } {
  const api: ProbeApi = { current: null };
  const Probe: React.FC = () => {
    api.current = useKnowledgeBaseSession();
    return null;
  };
  return { Probe, api };
}

function renderWithProvider(child: React.ReactElement = <></>) {
  const { Probe, api } = makeProbe();
  const utils = render(
    <KnowledgeBaseSessionProvider>
      <Probe />
      {child}
    </KnowledgeBaseSessionProvider>
  );
  return { ...utils, api };
}

beforeEach(() => {
  localStorage.clear();
  mockGetMe.mockReset();
  mockRefreshToken.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

// ---------- Pure helpers ----------

describe('pure helpers', () => {
  it('defaultProtocol returns http for localhost and 127.0.0.1', () => {
    expect(defaultProtocol('localhost')).toBe('http');
    expect(defaultProtocol('127.0.0.1')).toBe('http');
  });

  it('defaultProtocol returns https for everything else', () => {
    expect(defaultProtocol('example.com')).toBe('https');
    expect(defaultProtocol('api.semiont.cloud')).toBe('https');
  });

  it('kbBackendUrl composes protocol://host:port', () => {
    expect(kbBackendUrl(KB_A)).toBe('http://localhost:4000');
    expect(kbBackendUrl(KB_B)).toBe('https://example.com:443');
  });

  it('getKbSessionStatus returns "signed-out" when no token is stored', () => {
    expect(getKbSessionStatus(KB_A.id)).toBe('signed-out');
  });

  it('getKbSessionStatus returns "authenticated" when a fresh token is stored', () => {
    seedStorage({ tokens: { [KB_A.id]: makeFakeJwt(3600) } });
    expect(getKbSessionStatus(KB_A.id)).toBe('authenticated');
  });

  it('getKbSessionStatus returns "expired" when the stored token is past its exp', () => {
    seedStorage({ tokens: { [KB_A.id]: makeFakeJwt(-3600) } });
    expect(getKbSessionStatus(KB_A.id)).toBe('expired');
  });
});

// ---------- Mount-time validation ----------

describe('mount-time JWT validation', () => {
  it('does nothing if no KBs are configured', async () => {
    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current).not.toBeNull());

    expect(api.current!.knowledgeBases).toEqual([]);
    expect(api.current!.activeKnowledgeBase).toBeNull();
    expect(api.current!.session).toBeNull();
    expect(api.current!.isLoading).toBe(false);
    expect(mockGetMe).not.toHaveBeenCalled();
  });

  it('does not call getMe if no token is stored for the active KB', async () => {
    seedStorage({ knowledgeBases: [KB_A], activeId: KB_A.id });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current).not.toBeNull());

    expect(api.current!.activeKnowledgeBase).toEqual(KB_A);
    expect(api.current!.session).toBeNull();
    expect(api.current!.isLoading).toBe(false);
    expect(mockGetMe).not.toHaveBeenCalled();
  });

  it('does not call getMe if the stored token is already past its exp', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt(-100) },
    });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current).not.toBeNull());

    expect(api.current!.session).toBeNull();
    expect(mockGetMe).not.toHaveBeenCalled();
  });

  it('calls getMe and sets session on success', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com', isAdmin: true, name: 'Alice' });

    const { api } = renderWithProvider();

    await waitFor(() => expect(api.current?.session).not.toBeNull());

    expect(api.current!.session?.user.email).toBe('alice@example.com');
    expect(api.current!.isAuthenticated).toBe(true);
    expect(api.current!.isAdmin).toBe(true);
    expect(api.current!.displayName).toBe('Alice');
    expect(api.current!.isLoading).toBe(false);
  });

  it('clears the dead token and raises sessionExpiredAt on 401', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockRejectedValueOnce(new APIError('Unauthorized', 401, 'Unauthorized'));

    const { api } = renderWithProvider();

    await waitFor(() => expect(api.current?.sessionExpiredAt).not.toBeNull());

    expect(api.current!.session).toBeNull();
    expect(getStoredAccess(KB_A.id)).toBeNull();
  });

  it('does NOT clear the token on a non-401 error (5xx)', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockRejectedValueOnce(new APIError('boom', 500, 'Internal Server Error'));

    const { api } = renderWithProvider();

    await waitFor(() => expect(mockGetMe).toHaveBeenCalled());
    // Wait for isLoading to settle
    await waitFor(() => expect(api.current?.isLoading).toBe(false));

    expect(api.current!.session).toBeNull();
    expect(api.current!.sessionExpiredAt).toBeNull();
    expect(getStoredAccess(KB_A.id)).not.toBeNull();
  });

  it('treats a non-APIError throw as a non-401 error (does not raise the modal)', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockRejectedValueOnce(new Error('network down'));

    const { api } = renderWithProvider();

    await waitFor(() => expect(api.current?.isLoading).toBe(false));

    expect(api.current!.session).toBeNull();
    expect(api.current!.sessionExpiredAt).toBeNull();
    expect(getStoredAccess(KB_A.id)).not.toBeNull();
  });
});

// ---------- Module-scoped notify functions ----------

describe('notifySessionExpired / notifyPermissionDenied', () => {
  it('is a no-op when no provider is mounted', () => {
    // Nothing rendered. These calls must not throw.
    expect(() => notifySessionExpired('foo')).not.toThrow();
    expect(() => notifyPermissionDenied('bar')).not.toThrow();
  });

  it('notifySessionExpired raises sessionExpiredAt and clears the active KB token', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    act(() => {
      notifySessionExpired('Token kicked from the bus');
    });

    expect(api.current!.sessionExpiredAt).not.toBeNull();
    expect(api.current!.sessionExpiredMessage).toBe('Token kicked from the bus');
    expect(api.current!.session).toBeNull();
    expect(getStoredAccess(KB_A.id)).toBeNull();
  });

  it('notifySessionExpired uses a default message when none is provided', async () => {
    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current).not.toBeNull());

    act(() => {
      notifySessionExpired();
    });

    expect(api.current!.sessionExpiredAt).not.toBeNull();
    expect(api.current!.sessionExpiredMessage).toMatch(/expired/i);
  });

  it('notifyPermissionDenied raises permissionDeniedAt without touching the session', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    act(() => {
      notifyPermissionDenied('Admin only');
    });

    expect(api.current!.permissionDeniedAt).not.toBeNull();
    expect(api.current!.permissionDeniedMessage).toBe('Admin only');
    // Session is unaffected
    expect(api.current!.session).not.toBeNull();
    expect(getStoredAccess(KB_A.id)).not.toBeNull();
  });

  it('unregisters the notify handlers on unmount, becoming a no-op again', async () => {
    const { api, unmount } = renderWithProvider();
    await waitFor(() => expect(api.current).not.toBeNull());

    unmount();

    // No throw, no observable side-effect (the test would hang on a state
    // update otherwise — getting here is the assertion).
    expect(() => notifySessionExpired('post-unmount')).not.toThrow();
    expect(() => notifyPermissionDenied('post-unmount')).not.toThrow();
  });

  it('routes notify calls to the currently-mounted provider, not a stale one', async () => {
    // Mount provider A, unmount it, mount provider B.
    // Notify must reach B (proving B re-registered) and not crash on A's
    // stale state setters (proving A unregistered cleanly).
    const { api: apiA, unmount: unmountA } = renderWithProvider();
    await waitFor(() => expect(apiA.current).not.toBeNull());

    // Capture A's pre-unmount sessionExpiredAt for after-the-fact comparison
    const aBeforeUnmount = apiA.current!.sessionExpiredAt;
    unmountA();

    // Mount a fresh provider B
    const { api: apiB } = renderWithProvider();
    await waitFor(() => expect(apiB.current).not.toBeNull());

    // Sanity: B starts with no flag raised
    expect(apiB.current!.sessionExpiredAt).toBeNull();

    act(() => {
      notifySessionExpired('hits B, not A');
    });

    // B's state changed
    expect(apiB.current!.sessionExpiredAt).not.toBeNull();
    expect(apiB.current!.sessionExpiredMessage).toBe('hits B, not A');

    // A's last-known state never changed (it was null before unmount and
    // is still that exact value — A's setState was never invoked because
    // its handler was unregistered)
    expect(apiA.current!.sessionExpiredAt).toBe(aBeforeUnmount);

    // Same check for the permission-denied channel
    act(() => {
      notifyPermissionDenied('also B');
    });
    expect(apiB.current!.permissionDeniedAt).not.toBeNull();
    expect(apiB.current!.permissionDeniedMessage).toBe('also B');
  });

  it('acknowledgeSessionExpired clears the flag', async () => {
    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current).not.toBeNull());

    act(() => {
      notifySessionExpired('boom');
    });
    expect(api.current!.sessionExpiredAt).not.toBeNull();

    act(() => {
      api.current!.acknowledgeSessionExpired();
    });

    expect(api.current!.sessionExpiredAt).toBeNull();
    expect(api.current!.sessionExpiredMessage).toBeNull();
  });

  it('acknowledgePermissionDenied clears the flag', async () => {
    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current).not.toBeNull());

    act(() => {
      notifyPermissionDenied('nope');
    });
    expect(api.current!.permissionDeniedAt).not.toBeNull();

    act(() => {
      api.current!.acknowledgePermissionDenied();
    });

    expect(api.current!.permissionDeniedAt).toBeNull();
    expect(api.current!.permissionDeniedMessage).toBeNull();
  });
});

// ---------- Mutations ----------

describe('addKnowledgeBase', () => {
  it('atomically stores token, adds the KB to the list, and sets it active', async () => {
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current).not.toBeNull());

    const newAccess = makeFakeJwt();
    const newRefresh = makeFakeJwt(30 * 24 * 3600);
    let returnedKb: ReturnType<NonNullable<typeof api.current>['addKnowledgeBase']> | undefined;
    act(() => {
      returnedKb = api.current!.addKnowledgeBase(
        { label: 'New KB', host: 'localhost', port: 4000, protocol: 'http', email: 'admin@example.com' },
        newAccess,
        newRefresh,
      );
    });

    expect(returnedKb).toBeDefined();
    expect(returnedKb!.label).toBe('New KB');
    expect(returnedKb!.id).toMatch(/.+/); // some non-empty string
    expect(api.current!.knowledgeBases).toHaveLength(1);
    expect(api.current!.activeKnowledgeBase?.id).toBe(returnedKb!.id);
    expect(getStoredAccess(returnedKb!.id)).toBe(newAccess);
    expect(getStoredRefresh(returnedKb!.id)).toBe(newRefresh);

    // The provider should fire validation against the new KB
    await waitFor(() => expect(mockGetMe).toHaveBeenCalled());
  });
});

describe('signIn', () => {
  it('stores the new token and re-validates against the SAME active KB', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    // First validation: success
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com', name: 'Alice' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());
    expect(mockGetMe).toHaveBeenCalledTimes(1);

    // Second validation: a different user, to prove re-validation actually ran
    mockGetMe.mockResolvedValueOnce({ email: 'alice2@example.com', name: 'Alice2' });

    const freshAccess = makeFakeJwt();
    const freshRefresh = makeFakeJwt(30 * 24 * 3600);
    act(() => {
      api.current!.signIn(KB_A.id, freshAccess, freshRefresh);
    });

    expect(getStoredAccess(KB_A.id)).toBe(freshAccess);
    expect(getStoredRefresh(KB_A.id)).toBe(freshRefresh);
    await waitFor(() => expect(mockGetMe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.current?.session?.user.email).toBe('alice2@example.com'));
  });

  it('switches to a different KB and re-validates against it', async () => {
    seedStorage({
      knowledgeBases: [KB_A, KB_B],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session?.user.email).toBe('alice@example.com'));

    mockGetMe.mockResolvedValueOnce({ email: 'bob@example.com' });

    const bobAccess = makeFakeJwt();
    const bobRefresh = makeFakeJwt(30 * 24 * 3600);
    act(() => {
      api.current!.signIn(KB_B.id, bobAccess, bobRefresh);
    });

    expect(api.current!.activeKnowledgeBase?.id).toBe(KB_B.id);
    expect(getStoredAccess(KB_B.id)).toBe(bobAccess);
    await waitFor(() => expect(api.current?.session?.user.email).toBe('bob@example.com'));
  });
});

describe('signOut', () => {
  it('clears the token and the in-memory session for the active KB', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    act(() => {
      api.current!.signOut(KB_A.id);
    });

    expect(getStoredAccess(KB_A.id)).toBeNull();
    expect(api.current!.session).toBeNull();
    expect(api.current!.isAuthenticated).toBe(false);
  });

  it('clears another KB\'s token without disturbing the active session', async () => {
    seedStorage({
      knowledgeBases: [KB_A, KB_B],
      activeId: KB_A.id,
      tokens: {
        [KB_A.id]: makeFakeJwt(),
        [KB_B.id]: makeFakeJwt(),
      },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    act(() => {
      api.current!.signOut(KB_B.id);
    });

    expect(getStoredAccess(KB_B.id)).toBeNull();
    // Active KB session is unaffected
    expect(api.current!.session?.user.email).toBe('alice@example.com');
    expect(getStoredAccess(KB_A.id)).not.toBeNull();
  });
});

describe('removeKnowledgeBase', () => {
  it('removes the KB, clears its token, and reassigns active to the next available', async () => {
    seedStorage({
      knowledgeBases: [KB_A, KB_B],
      activeId: KB_A.id,
      tokens: {
        [KB_A.id]: makeFakeJwt(),
        [KB_B.id]: makeFakeJwt(),
      },
    });
    // KB_A initial validation
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.activeKnowledgeBase?.id).toBe(KB_A.id));

    // KB_B revalidation after removal of KB_A
    mockGetMe.mockResolvedValueOnce({ email: 'bob@example.com' });

    act(() => {
      api.current!.removeKnowledgeBase(KB_A.id);
    });

    expect(api.current!.knowledgeBases.map(k => k.id)).toEqual([KB_B.id]);
    expect(getStoredAccess(KB_A.id)).toBeNull();
    await waitFor(() => expect(api.current?.activeKnowledgeBase?.id).toBe(KB_B.id));
  });

  it('clears active when removing the only KB', async () => {
    seedStorage({ knowledgeBases: [KB_A], activeId: KB_A.id });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.activeKnowledgeBase?.id).toBe(KB_A.id));

    act(() => {
      api.current!.removeKnowledgeBase(KB_A.id);
    });

    expect(api.current!.knowledgeBases).toEqual([]);
    expect(api.current!.activeKnowledgeBase).toBeNull();
  });
});

describe('setActiveKnowledgeBase', () => {
  it('atomically switches sessions: validates the new KB and sets its session', async () => {
    seedStorage({
      knowledgeBases: [KB_A, KB_B],
      activeId: KB_A.id,
      tokens: {
        [KB_A.id]: makeFakeJwt(),
        [KB_B.id]: makeFakeJwt(),
      },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session?.user.email).toBe('alice@example.com'));

    mockGetMe.mockResolvedValueOnce({ email: 'bob@example.com' });

    act(() => {
      api.current!.setActiveKnowledgeBase(KB_B.id);
    });

    await waitFor(() => expect(api.current?.session?.user.email).toBe('bob@example.com'));
    expect(api.current!.activeKnowledgeBase?.id).toBe(KB_B.id);
  });
});

describe('updateKnowledgeBase', () => {
  it('updates the label without affecting the session', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValue({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    // updateKnowledgeBase changes the activeKnowledgeBase object reference,
    // which causes the validation effect to re-run. Wrap in async act so
    // the resulting microtasks flush before assertion.
    await act(async () => {
      api.current!.updateKnowledgeBase(KB_A.id, { label: 'Renamed KB' });
    });

    expect(api.current!.activeKnowledgeBase?.label).toBe('Renamed KB');
    // Session survives the rename
    expect(api.current!.session?.user.email).toBe('alice@example.com');
  });
});

// ---------- Derived auth fields ----------

describe('derived auth fields', () => {
  it('exposes user-derived fields after a successful session', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValueOnce({
      email: 'alice@company.com',
      name: 'Alice Anderson',
      image: 'https://example.com/avatar.png',
      domain: 'company.com',
      isAdmin: true,
      isModerator: false,
    });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    expect(api.current!.user?.email).toBe('alice@company.com');
    expect(api.current!.token).toMatch(/^.+\..+\..+$/);
    expect(api.current!.isAuthenticated).toBe(true);
    expect(api.current!.hasValidBackendToken).toBe(true);
    expect(api.current!.isFullyAuthenticated).toBe(true);
    expect(api.current!.displayName).toBe('Alice Anderson');
    expect(api.current!.avatarUrl).toBe('https://example.com/avatar.png');
    expect(api.current!.userDomain).toBe('company.com');
    expect(api.current!.isAdmin).toBe(true);
    expect(api.current!.isModerator).toBe(false);
  });

  it('falls back to email-prefix as displayName when user has no name', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'noname@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    expect(api.current!.displayName).toBe('noname');
  });

  it('falls back to "User" when there is no user.name and no email', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValueOnce({});

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    expect(api.current!.displayName).toBe('User');
  });

  it('derives userDomain from email when no domain is present', async () => {
    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: makeFakeJwt() },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'alice@derivedfromhere.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    expect(api.current!.userDomain).toBe('derivedfromhere.com');
  });

  it('exposes a parsed expiresAt for the session-timer UI', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({ exp }));
    const token = `${header}.${payload}.sig`;

    seedStorage({
      knowledgeBases: [KB_A],
      activeId: KB_A.id,
      tokens: { [KB_A.id]: token },
    });
    mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current?.session).not.toBeNull());

    expect(api.current!.expiresAt).toBeInstanceOf(Date);
    expect(api.current!.expiresAt!.getTime()).toBe(exp * 1000);
  });

  it('returns the expected unauthenticated defaults when no session', async () => {
    const { api } = renderWithProvider();
    await waitFor(() => expect(api.current).not.toBeNull());

    expect(api.current!.user).toBeNull();
    expect(api.current!.token).toBeNull();
    expect(api.current!.isAuthenticated).toBe(false);
    expect(api.current!.hasValidBackendToken).toBe(false);
    expect(api.current!.isFullyAuthenticated).toBe(false);
    expect(api.current!.displayName).toBe('User');
    expect(api.current!.avatarUrl).toBeNull();
    expect(api.current!.isAdmin).toBe(false);
    expect(api.current!.isModerator).toBe(false);
    expect(api.current!.expiresAt).toBeNull();
  });
});

// ---------- Hook contract ----------

describe('useKnowledgeBaseSession', () => {
  it('throws when called outside a provider', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Probe() {
      useKnowledgeBaseSession();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/useKnowledgeBaseSession requires KnowledgeBaseSessionProvider/);
    consoleErrorSpy.mockRestore();
  });
});

// ---------- Refresh flow ----------

describe('refresh flow', () => {
  describe('mount-time refresh', () => {
    it('refreshes on mount when the access token is past its exp', async () => {
      const expiredAccess = makeFakeJwt(-100);
      const validRefresh = makeFakeJwt(30 * 24 * 3600);
      const newAccess = makeFakeJwt(3600);

      seedStorage({
        knowledgeBases: [KB_A],
        activeId: KB_A.id,
        tokens: { [KB_A.id]: { access: expiredAccess, refresh: validRefresh } },
      });
      mockRefreshToken.mockResolvedValueOnce({ access_token: newAccess });
      mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

      const { api } = renderWithProvider();
      await waitFor(() => expect(api.current?.session).not.toBeNull());

      // Refresh was called once
      expect(mockRefreshToken).toHaveBeenCalledTimes(1);
      // getMe was called with the NEW token
      expect(mockGetMe).toHaveBeenCalledTimes(1);
      // Storage was updated to the new access token, refresh unchanged
      expect(getStoredAccess(KB_A.id)).toBe(newAccess);
      expect(getStoredRefresh(KB_A.id)).toBe(validRefresh);
      // In-memory session token reflects the refreshed value
      expect(api.current!.token).toBe(newAccess);
    });

    it('clears session and stays signed out if refresh fails on mount', async () => {
      const expiredAccess = makeFakeJwt(-100);
      seedStorage({
        knowledgeBases: [KB_A],
        activeId: KB_A.id,
        tokens: { [KB_A.id]: { access: expiredAccess, refresh: makeFakeJwt(30 * 24 * 3600) } },
      });
      mockRefreshToken.mockRejectedValueOnce(new APIError('Invalid', 401, 'Unauthorized'));

      const { api } = renderWithProvider();
      await waitFor(() => expect(api.current?.isLoading).toBe(false));

      expect(api.current!.session).toBeNull();
      expect(getStoredAccess(KB_A.id)).toBeNull();
      expect(mockGetMe).not.toHaveBeenCalled();
    });

    it('falls through to refresh when getMe returns 401, then re-validates', async () => {
      const accessTokenStr = makeFakeJwt(3600);
      const refreshTokenStr = makeFakeJwt(30 * 24 * 3600);
      const newAccess = makeFakeJwt(3600);

      seedStorage({
        knowledgeBases: [KB_A],
        activeId: KB_A.id,
        tokens: { [KB_A.id]: { access: accessTokenStr, refresh: refreshTokenStr } },
      });

      // First getMe rejects with 401, refresh succeeds, second getMe succeeds
      mockGetMe
        .mockRejectedValueOnce(new APIError('Unauthorized', 401, 'Unauthorized'))
        .mockResolvedValueOnce({ email: 'alice@example.com' });
      mockRefreshToken.mockResolvedValueOnce({ access_token: newAccess });

      const { api } = renderWithProvider();
      await waitFor(() => expect(api.current?.session).not.toBeNull());

      expect(mockGetMe).toHaveBeenCalledTimes(2);
      expect(mockRefreshToken).toHaveBeenCalledTimes(1);
      expect(api.current!.token).toBe(newAccess);
      // Modal flag NOT raised — recovery succeeded
      expect(api.current!.sessionExpiredAt).toBeNull();
    });
  });

  describe('refreshActive (the imperative API)', () => {
    it('returns the new access token and updates session.token', async () => {
      const accessTokenStr = makeFakeJwt(3600);
      const refreshTokenStr = makeFakeJwt(30 * 24 * 3600);
      const newAccess = makeFakeJwt(3600);

      seedStorage({
        knowledgeBases: [KB_A],
        activeId: KB_A.id,
        tokens: { [KB_A.id]: { access: accessTokenStr, refresh: refreshTokenStr } },
      });
      mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });
      mockRefreshToken.mockResolvedValueOnce({ access_token: newAccess });

      const { api } = renderWithProvider();
      await waitFor(() => expect(api.current?.session).not.toBeNull());

      let returned: string | null = null;
      await act(async () => {
        returned = await api.current!.refreshActive();
      });

      expect(returned).toBe(newAccess);
      expect(api.current!.token).toBe(newAccess);
      expect(getStoredAccess(KB_A.id)).toBe(newAccess);
      expect(api.current!.session?.user.email).toBe('alice@example.com');
    });

    it('returns null and surfaces sessionExpiredAt when refresh fails', async () => {
      const accessTokenStr = makeFakeJwt(3600);
      const refreshTokenStr = makeFakeJwt(30 * 24 * 3600);

      seedStorage({
        knowledgeBases: [KB_A],
        activeId: KB_A.id,
        tokens: { [KB_A.id]: { access: accessTokenStr, refresh: refreshTokenStr } },
      });
      mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });
      mockRefreshToken.mockRejectedValueOnce(new APIError('Invalid', 401, 'Unauthorized'));

      const { api } = renderWithProvider();
      await waitFor(() => expect(api.current?.session).not.toBeNull());

      let returned: string | null = 'still-set';
      await act(async () => {
        returned = await api.current!.refreshActive();
      });

      expect(returned).toBeNull();
      expect(api.current!.session).toBeNull();
      expect(api.current!.sessionExpiredAt).not.toBeNull();
      expect(getStoredAccess(KB_A.id)).toBeNull();
    });

    it('deduplicates concurrent refreshActive calls into a single network call', async () => {
      const accessTokenStr = makeFakeJwt(3600);
      const refreshTokenStr = makeFakeJwt(30 * 24 * 3600);
      const newAccess = makeFakeJwt(3600);

      seedStorage({
        knowledgeBases: [KB_A],
        activeId: KB_A.id,
        tokens: { [KB_A.id]: { access: accessTokenStr, refresh: refreshTokenStr } },
      });
      mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

      // The first refresh is the only one that should hit the network.
      // Make it slow so the second concurrent caller has to await it.
      let resolveRefresh: (value: { access_token: string }) => void;
      const refreshPromise = new Promise<{ access_token: string }>(resolve => {
        resolveRefresh = resolve;
      });
      mockRefreshToken.mockReturnValueOnce(refreshPromise);

      const { api } = renderWithProvider();
      await waitFor(() => expect(api.current?.session).not.toBeNull());

      // Fire two concurrent refreshes
      let firstResult: string | null = null;
      let secondResult: string | null = null;
      await act(async () => {
        const p1 = api.current!.refreshActive().then(v => { firstResult = v; });
        const p2 = api.current!.refreshActive().then(v => { secondResult = v; });
        // Resolve the network mock
        resolveRefresh!({ access_token: newAccess });
        await Promise.all([p1, p2]);
      });

      expect(mockRefreshToken).toHaveBeenCalledTimes(1);
      expect(firstResult).toBe(newAccess);
      expect(secondResult).toBe(newAccess);
    });
  });

  describe('proactive refresh', () => {
    it('schedules and fires a refresh shortly before the access token expires', async () => {
      vi.useFakeTimers();
      try {
        // Access token expires in 6 minutes — proactive refresh fires 5 min before exp = ~1 min from now
        const expiresInSec = 6 * 60;
        const accessTokenStr = makeFakeJwt(expiresInSec);
        const refreshTokenStr = makeFakeJwt(30 * 24 * 3600);
        const newAccess = makeFakeJwt(3600);

        seedStorage({
          knowledgeBases: [KB_A],
          activeId: KB_A.id,
          tokens: { [KB_A.id]: { access: accessTokenStr, refresh: refreshTokenStr } },
        });
        mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });
        mockRefreshToken.mockResolvedValueOnce({ access_token: newAccess });

        const { api } = renderWithProvider();
        await vi.waitFor(() => expect(api.current?.session).not.toBeNull());

        // No refresh has fired yet
        expect(mockRefreshToken).not.toHaveBeenCalled();

        // Advance past the proactive-refresh fire time (~1 minute)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        });

        expect(mockRefreshToken).toHaveBeenCalledTimes(1);
        expect(api.current!.token).toBe(newAccess);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('cross-tab sync', () => {
    it('updates the in-memory token when another tab refreshes the same KB', async () => {
      const accessTokenStr = makeFakeJwt(3600);
      const refreshTokenStr = makeFakeJwt(30 * 24 * 3600);
      const newAccessFromOtherTab = makeFakeJwt(3600);

      seedStorage({
        knowledgeBases: [KB_A],
        activeId: KB_A.id,
        tokens: { [KB_A.id]: { access: accessTokenStr, refresh: refreshTokenStr } },
      });
      mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

      const { api } = renderWithProvider();
      await waitFor(() => expect(api.current?.session).not.toBeNull());

      // Simulate another tab writing a new session for the same KB
      act(() => {
        const newValue = JSON.stringify({ access: newAccessFromOtherTab, refresh: refreshTokenStr });
        window.dispatchEvent(new StorageEvent('storage', {
          key: `semiont.session.${KB_A.id}`,
          newValue,
          oldValue: null,
        }));
      });

      expect(api.current!.token).toBe(newAccessFromOtherTab);
      // User info is unchanged
      expect(api.current!.session?.user.email).toBe('alice@example.com');
    });

    it('clears the session when another tab signs out', async () => {
      seedStorage({
        knowledgeBases: [KB_A],
        activeId: KB_A.id,
        tokens: { [KB_A.id]: makeFakeJwt() },
      });
      mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

      const { api } = renderWithProvider();
      await waitFor(() => expect(api.current?.session).not.toBeNull());

      // Simulate another tab clearing the storage entry
      act(() => {
        window.dispatchEvent(new StorageEvent('storage', {
          key: `semiont.session.${KB_A.id}`,
          newValue: null,
          oldValue: 'whatever',
        }));
      });

      expect(api.current!.session).toBeNull();
    });

    it('ignores storage events for other KBs', async () => {
      seedStorage({
        knowledgeBases: [KB_A, KB_B],
        activeId: KB_A.id,
        tokens: { [KB_A.id]: makeFakeJwt() },
      });
      mockGetMe.mockResolvedValueOnce({ email: 'alice@example.com' });

      const { api } = renderWithProvider();
      await waitFor(() => expect(api.current?.session).not.toBeNull());
      const tokenBefore = api.current!.token;

      // Storage event for the OTHER KB — must not affect the active session
      act(() => {
        window.dispatchEvent(new StorageEvent('storage', {
          key: `semiont.session.${KB_B.id}`,
          newValue: null,
          oldValue: 'whatever',
        }));
      });

      expect(api.current!.session).not.toBeNull();
      expect(api.current!.token).toBe(tokenBefore);
    });
  });
});
