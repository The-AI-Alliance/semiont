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

vi.mock('../../client', async () => {
  const actual = await vi.importActual<typeof import('../../client')>('../../client');
  class MockSemiontApiClient {
    getMe = mockGetMe;
    dispose = mockDispose;
    refreshToken = mockRefreshToken;
    actor = { state$: mockActorStateSubject };
    eventBus = { get: () => ({ next: () => {}, subscribe: () => ({ unsubscribe: () => {} }) }) };
  }
  return {
    ...actual,
    SemiontApiClient: MockSemiontApiClient,
  };
});

import { SemiontSession } from '../semiont-session';
import { SESSION_PREFIX_RE, storageKey, seedStoredSession, TestStorage } from './test-storage-helpers';

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

let storage: TestStorage;

beforeEach(() => {
  storage = new TestStorage();
  mockGetMe.mockReset();
  mockDispose.mockReset();
  mockRefreshToken.mockReset();
});

afterEach(() => {
  // Tests that create sessions should dispose them inside the test.
});

describe('SemiontSession — construction & initial token', () => {
  it('starts with null token when no stored session', async () => {
    const session = new SemiontSession({ kb: KB, storage });
    expect(session.token$.getValue()).toBeNull();
    expect(session.user$.getValue()).toBeNull();
    await session.ready;
    await session.dispose();
  });

  it('starts with stored token when unexpired, then populates user$ via getMe', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'refresh-tok');
    mockGetMe.mockResolvedValue({ id: 'u1', email: 'a@b.c', name: 'Alice', isAdmin: false, isModerator: false });

    const session = new SemiontSession({ kb: KB, storage });
    expect(session.token$.getValue()).toBe(jwt);

    await session.ready;
    expect(mockGetMe).toHaveBeenCalled();
    expect(session.user$.getValue()).toMatchObject({ name: 'Alice' });

    await session.dispose();
  });

  it('stays with null user$ if stored token is expired and no refresh path is available', async () => {
    const expired = freshJwt(-3600);
    seedStoredSession(storage, KB.id, expired, 'refresh-tok');
    mockRefreshToken.mockRejectedValue(new Error('refresh blocked'));

    const session = new SemiontSession({ kb: KB, storage });
    await session.ready;
    expect(session.user$.getValue()).toBeNull();
    expect(storage.get(storageKey(KB.id))).toBeNull();

    await session.dispose();
  });
});

describe('SemiontSession — modal state', () => {
  it('notifySessionExpired sets sessionExpiredAt$ and nulls token$', async () => {
    const session = new SemiontSession({ kb: KB, storage });
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
    const session = new SemiontSession({ kb: KB, storage });
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
    const session = new SemiontSession({ kb: KB, storage });
    await session.ready;

    let completed = false;
    session.token$.subscribe({ complete: () => { completed = true; } });

    await session.dispose();
    expect(completed).toBe(true);
    expect(mockDispose).toHaveBeenCalled();
  });

  it('dispose is idempotent', async () => {
    const session = new SemiontSession({ kb: KB, storage });
    await session.ready;
    await session.dispose();
    await session.dispose();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});

describe('SemiontSession — cross-context storage sync', () => {
  it('responds to a storage change that updates this KB\'s session key', async () => {
    const session = new SemiontSession({ kb: KB, storage });
    await session.ready;

    const newJwt = freshJwt();
    const nextToken = firstValueFrom(session.token$.pipe(skip(1), take(1)));
    storage.dispatch(storageKey(KB.id), JSON.stringify({ access: newJwt, refresh: 'r2' }));
    await expect(nextToken).resolves.toBe(newJwt);

    await session.dispose();
  });

  it('responds to a storage change that clears this KB\'s session', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'r');
    mockGetMe.mockResolvedValue({ id: 'u', email: 'a@b.c', name: 'A', isAdmin: false, isModerator: false });

    const session = new SemiontSession({ kb: KB, storage });
    await session.ready;
    expect(session.token$.getValue()).toBe(jwt);

    storage.dispatch(storageKey(KB.id), null);

    expect(session.token$.getValue()).toBeNull();
    expect(session.user$.getValue()).toBeNull();

    await session.dispose();
  });

  it('ignores storage changes for other keys', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'r');
    mockGetMe.mockResolvedValue({ id: 'u', email: 'a@b.c', name: 'A', isAdmin: false, isModerator: false });

    const session = new SemiontSession({ kb: KB, storage });
    await session.ready;

    storage.dispatch('semiont.session.OTHER_KB', JSON.stringify({ access: 'xyz', refresh: 'q' }));
    expect(session.token$.getValue()).toBe(jwt);

    await session.dispose();
  });
});

describe('test helpers sanity', () => {
  it('storage keys are scoped by kb id', () => {
    expect(storageKey(KB.id)).toMatch(SESSION_PREFIX_RE);
  });
});
