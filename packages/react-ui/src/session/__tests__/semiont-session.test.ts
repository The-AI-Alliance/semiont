/**
 * SemiontSession — unit tests for lifecycle, token wiring, and modal state.
 * SemiontApiClient is mocked via `vi.mock` so no real HTTP or SSE fires.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, skip, take } from 'rxjs';

const mockGetMe = vi.fn();
const mockDispose = vi.fn();
const mockRefreshToken = vi.fn();
const mockActorStateSubject = { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) };

vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual<typeof import('@semiont/api-client')>('@semiont/api-client');
  class MockSemiontApiClient {
    getMe = mockGetMe;
    dispose = mockDispose;
    refreshToken = mockRefreshToken;
    actor = { state$: mockActorStateSubject };
  }
  return {
    ...actual,
    SemiontApiClient: MockSemiontApiClient,
  };
});

import { SemiontSession } from '../semiont-session';
import { SESSION_PREFIX_RE, storageKey, seedStoredSession } from './test-storage-helpers';

function freshJwt(expSecondsFromNow = 3600): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `${header}.${payload}.sig`;
}

const KB = {
  id: 'kb-alpha',
  label: 'Alpha',
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'alice@example.com',
};

beforeEach(() => {
  localStorage.clear();
  mockGetMe.mockReset();
  mockDispose.mockReset();
  mockRefreshToken.mockReset();
});

afterEach(() => {
  // Clean up any leftover storage listeners by collecting sessions.
  // Tests that create sessions should dispose them inside the test.
});

describe('SemiontSession — construction & initial token', () => {
  it('starts with null token when no stored session', async () => {
    const session = new SemiontSession({ kb: KB });
    expect(session.token$.getValue()).toBeNull();
    expect(session.user$.getValue()).toBeNull();
    await session.ready;
    await session.dispose();
  });

  it('starts with stored token when unexpired, then populates user$ via getMe', async () => {
    const jwt = freshJwt();
    seedStoredSession(KB.id, jwt, 'refresh-tok');
    mockGetMe.mockResolvedValue({ id: 'u1', email: 'a@b.c', name: 'Alice', isAdmin: false, isModerator: false });

    const session = new SemiontSession({ kb: KB });
    expect(session.token$.getValue()).toBe(jwt);

    await session.ready;
    expect(mockGetMe).toHaveBeenCalled();
    expect(session.user$.getValue()).toMatchObject({ name: 'Alice' });

    await session.dispose();
  });

  it('stays with null user$ if stored token is expired and no refresh path is available', async () => {
    const expired = freshJwt(-3600);
    seedStoredSession(KB.id, expired, 'refresh-tok');
    // performRefresh will call refreshToken() — fail it.
    mockRefreshToken.mockRejectedValue(new Error('refresh blocked'));

    const session = new SemiontSession({ kb: KB });
    await session.ready;
    expect(session.user$.getValue()).toBeNull();
    // Expired stored session is cleared.
    expect(localStorage.getItem(storageKey(KB.id))).toBeNull();

    await session.dispose();
  });
});

describe('SemiontSession — modal state', () => {
  it('notifySessionExpired sets sessionExpiredAt$ and nulls token$', async () => {
    const session = new SemiontSession({ kb: KB });
    await session.ready;

    session.notifySessionExpired('expired');
    expect(session.sessionExpiredAt$.getValue()).not.toBeNull();
    expect(session.sessionExpiredMessage$.getValue()).toBe('expired');
    expect(session.token$.getValue()).toBeNull();

    session.acknowledgeSessionExpired();
    expect(session.sessionExpiredAt$.getValue()).toBeNull();
    expect(session.sessionExpiredMessage$.getValue()).toBeNull();

    await session.dispose();
  });

  it('notifyPermissionDenied sets permissionDeniedAt$', async () => {
    const session = new SemiontSession({ kb: KB });
    await session.ready;

    session.notifyPermissionDenied('nope');
    expect(session.permissionDeniedAt$.getValue()).not.toBeNull();
    expect(session.permissionDeniedMessage$.getValue()).toBe('nope');

    session.acknowledgePermissionDenied();
    expect(session.permissionDeniedAt$.getValue()).toBeNull();

    await session.dispose();
  });
});

describe('SemiontSession — dispose', () => {
  it('completes subjects and calls client.dispose on dispose', async () => {
    const session = new SemiontSession({ kb: KB });
    await session.ready;

    let completed = false;
    session.token$.subscribe({ complete: () => { completed = true; } });

    await session.dispose();
    expect(completed).toBe(true);
    expect(mockDispose).toHaveBeenCalled();
  });

  it('dispose is idempotent', async () => {
    const session = new SemiontSession({ kb: KB });
    await session.ready;
    await session.dispose();
    await session.dispose();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});

describe('SemiontSession — cross-tab storage sync', () => {
  it('responds to a storage event that updates this KB\'s session key', async () => {
    const session = new SemiontSession({ kb: KB });
    await session.ready;

    // Manually dispatch a storage event with a new access token.
    const newJwt = freshJwt();
    const evt = new StorageEvent('storage', {
      key: storageKey(KB.id),
      newValue: JSON.stringify({ access: newJwt, refresh: 'r2' }),
    });
    // Wait for the next emission after dispatch.
    const nextToken = firstValueFrom(session.token$.pipe(skip(1), take(1)));
    window.dispatchEvent(evt);
    await expect(nextToken).resolves.toBe(newJwt);

    await session.dispose();
  });

  it('responds to a storage event that clears this KB\'s session', async () => {
    const jwt = freshJwt();
    seedStoredSession(KB.id, jwt, 'r');
    mockGetMe.mockResolvedValue({ id: 'u', email: 'a@b.c', name: 'A', isAdmin: false, isModerator: false });

    const session = new SemiontSession({ kb: KB });
    await session.ready;
    expect(session.token$.getValue()).toBe(jwt);

    const evt = new StorageEvent('storage', { key: storageKey(KB.id), newValue: null });
    window.dispatchEvent(evt);

    expect(session.token$.getValue()).toBeNull();
    expect(session.user$.getValue()).toBeNull();

    await session.dispose();
  });

  it('ignores storage events for other keys', async () => {
    const jwt = freshJwt();
    seedStoredSession(KB.id, jwt, 'r');
    mockGetMe.mockResolvedValue({ id: 'u', email: 'a@b.c', name: 'A', isAdmin: false, isModerator: false });

    const session = new SemiontSession({ kb: KB });
    await session.ready;

    const evt = new StorageEvent('storage', {
      key: 'semiont.session.OTHER_KB',
      newValue: JSON.stringify({ access: 'xyz', refresh: 'q' }),
    });
    window.dispatchEvent(evt);
    expect(session.token$.getValue()).toBe(jwt);

    await session.dispose();
  });
});

// Guardrail for tests above: assert we're actually using a KB-scoped key.
describe('test helpers sanity', () => {
  it('storage keys are scoped by kb id', () => {
    expect(storageKey(KB.id)).toMatch(SESSION_PREFIX_RE);
  });
});
