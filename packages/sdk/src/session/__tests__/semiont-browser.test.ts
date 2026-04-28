/**
 * SemiontBrowser — unit tests for the registry, D2 setActiveKb contract,
 * and open-resources CRUD. Mocks SemiontClient so no HTTP/SSE is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, skip, take } from 'rxjs';

const mockGetMe = vi.fn();
const mockDispose = vi.fn();
const mockRefreshToken = vi.fn();

vi.mock('../../client', async () => {
  const actual = await vi.importActual<typeof import('../../client')>('../../client');
  const { Subject } = await import('rxjs');
  class MockSemiontApiClient {
    auth = { me: mockGetMe, refresh: mockRefreshToken };
    dispose = mockDispose;
    actor = { state$: { subscribe: () => ({ unsubscribe: () => {} }) } };
    eventBus = { get: () => ({ next: () => {}, subscribe: () => ({ unsubscribe: () => {} }) }) };
    // Mirrors the `ITransport` errors$ contract enough for the
    // SemiontBrowser → signals routing tests to push test errors through.
    transport = (() => {
      const errorsSubject = new Subject();
      return { errorsSubject, errors$: errorsSubject.asObservable() };
    })();
  }
  return {
    ...actual,
    SemiontClient: MockSemiontApiClient,
  };
});

import { SemiontBrowser } from '../semiont-browser';
import { createHttpSessionFactory } from '../http-session-factory';
import { getBrowser } from '../registry';
import { __resetForTests } from '../testing';
import { storageKey, seedStoredSession, TestStorage } from './test-storage-helpers';
import { STORAGE_KEY, ACTIVE_KEY } from '../storage';

const KB_A = {
  id: 'kb-a',
  label: 'KB A',
  email: 'a@example.com',
  endpoint: { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const },
};
const KB_B = {
  id: 'kb-b',
  label: 'KB B',
  email: 'b@example.com',
  endpoint: { kind: 'http' as const, host: 'example.com', port: 443, protocol: 'https' as const },
};

function freshJwt(expSecondsFromNow = 3600): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `${header}.${payload}.sig`;
}

let storage: TestStorage;

// Test-local helper: every test in this file exercises HTTP-backed sessions,
// so we wire the HTTP `SessionFactory` once and let test bodies stay terse.
const makeBrowser = (s: TestStorage = storage) =>
  new SemiontBrowser({ storage: s, sessionFactory: createHttpSessionFactory() });

beforeEach(() => {
  storage = new TestStorage();
  mockGetMe.mockReset();
  mockDispose.mockReset();
  mockRefreshToken.mockReset();
  mockGetMe.mockResolvedValue({ id: 'u', email: 'x@y.z', name: 'X', isAdmin: false, isModerator: false });
});

afterEach(async () => {
  await __resetForTests();
});

describe('SemiontBrowser — registry singleton', () => {
  it('getBrowser() returns the same instance across calls', () => {
    const a = getBrowser({ storage, sessionFactory: createHttpSessionFactory() });
    const b = getBrowser({ storage, sessionFactory: createHttpSessionFactory() });
    expect(a).toBe(b);
  });

  it('__resetForTests clears the singleton so a subsequent getBrowser() returns a new instance', async () => {
    const a = getBrowser({ storage, sessionFactory: createHttpSessionFactory() });
    await __resetForTests();
    const b = getBrowser({ storage: new TestStorage(), sessionFactory: createHttpSessionFactory() });
    expect(a).not.toBe(b);
  });
});

describe('SemiontBrowser — identity token (D1)', () => {
  it('setIdentityToken updates identityToken$', async () => {
    const browser = makeBrowser();
    expect(browser.identityToken$.getValue()).toBeNull();

    browser.setIdentityToken('nextauth-token');
    expect(browser.identityToken$.getValue()).toBe('nextauth-token');

    browser.setIdentityToken(null);
    expect(browser.identityToken$.getValue()).toBeNull();

    await browser.dispose();
  });
});

describe('SemiontBrowser — KB list', () => {
  it('addKb persists to storage and activates the new KB', async () => {
    const browser = makeBrowser();
    const kb = browser.addKb(
      { label: KB_A.label, email: KB_A.email, endpoint: KB_A.endpoint },
      freshJwt(),
      'refresh',
    );

    expect(kb.id).toBeDefined();
    expect(browser.kbs$.getValue().map((k) => k.id)).toContain(kb.id);
    expect(browser.activeKbId$.getValue()).toBe(kb.id);

    await browser.dispose();
  });

  it('removeKb clears the KB and, if active, activates a fallback (or null)', async () => {
    const browser = makeBrowser();
    const a = browser.addKb(
      { label: KB_A.label, email: KB_A.email, endpoint: KB_A.endpoint },
      freshJwt(),
      'r',
    );
    const b = browser.addKb(
      { label: KB_B.label, email: KB_B.email, endpoint: KB_B.endpoint },
      freshJwt(),
      'r',
    );
    expect(browser.activeKbId$.getValue()).toBe(b.id);

    browser.removeKb(b.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(browser.kbs$.getValue().map((k) => k.id)).not.toContain(b.id);
    expect(browser.activeKbId$.getValue()).toBe(a.id);

    await browser.dispose();
  });

  it('updateKb edits the record in kbs$', async () => {
    const browser = makeBrowser();
    const kb = browser.addKb(
      { label: KB_A.label, email: KB_A.email, endpoint: KB_A.endpoint },
      freshJwt(),
      'r',
    );
    browser.updateKb(kb.id, { label: 'New Label' });
    const updated = browser.kbs$.getValue().find((k) => k.id === kb.id);
    expect(updated?.label).toBe('New Label');
    await browser.dispose();
  });
});

describe('SemiontBrowser — setActiveKb (D2 disposal contract)', () => {
  it('emits null on activeSession$ BEFORE the new session is constructed', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    seedStoredSession(storage, KB_B.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A, KB_B]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    const emissions: Array<string | null> = [];
    const sub = browser.activeSession$.subscribe((s) => {
      emissions.push(s?.kb.id ?? null);
    });

    await browser.setActiveKb(KB_B.id);
    sub.unsubscribe();

    const nullIdx = emissions.indexOf(null);
    const bIdx = emissions.lastIndexOf(KB_B.id);
    expect(nullIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(nullIdx);

    await browser.dispose();
  });

  it('disposes the prior session before activating the next', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    seedStoredSession(storage, KB_B.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A, KB_B]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    const disposeCountBefore = mockDispose.mock.calls.length;
    await browser.setActiveKb(KB_B.id);
    expect(mockDispose.mock.calls.length).toBeGreaterThan(disposeCountBefore);

    await browser.dispose();
  });

  it('setActiveKb(null) disposes the prior session and emits null', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    expect(browser.activeSession$.getValue()).not.toBeNull();

    await browser.setActiveKb(null);
    expect(browser.activeSession$.getValue()).toBeNull();

    await browser.dispose();
  });
});

describe('SemiontBrowser — open resources', () => {
  it('addOpenResource, removeOpenResource, updateName, reorder', async () => {
    const browser = makeBrowser();

    browser.addOpenResource('r1', 'One');
    browser.addOpenResource('r2', 'Two', 'text/markdown', 'file://two.md');
    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['r1', 'r2']);

    browser.addOpenResource('r1', 'One v2', 'text/plain');
    const r1 = browser.openResources$.getValue().find((r) => r.id === 'r1');
    expect(r1?.name).toBe('One v2');
    expect(r1?.mediaType).toBe('text/plain');

    browser.updateOpenResourceName('r2', 'Two v2');
    expect(browser.openResources$.getValue().find((r) => r.id === 'r2')?.name).toBe('Two v2');

    browser.reorderOpenResources(0, 1);
    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['r2', 'r1']);

    browser.removeOpenResource('r1');
    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['r2']);

    await browser.dispose();
  });

  it('reorderOpenResources ignores out-of-range indices', async () => {
    const browser = makeBrowser();
    browser.addOpenResource('r1', 'One');
    const before = browser.openResources$.getValue();
    browser.reorderOpenResources(0, 5);
    expect(browser.openResources$.getValue()).toEqual(before);
    await browser.dispose();
  });
});

describe('SemiontBrowser — signOut', () => {
  it('clears stored tokens and emits null on activeSession$', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    await browser.signOut(KB_A.id);
    expect(browser.activeSession$.getValue()).toBeNull();
    expect(storage.get(storageKey(KB_A.id))).toBeNull();

    await browser.dispose();
  });
});

describe('SemiontBrowser — getKbSessionStatus', () => {
  it('returns signed-out when no session is stored', () => {
    const browser = makeBrowser();
    expect(browser.getKbSessionStatus('unknown-kb')).toBe('signed-out');
  });

  it('returns authenticated for an unexpired stored JWT', () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    const browser = makeBrowser();
    expect(browser.getKbSessionStatus(KB_A.id)).toBe('authenticated');
  });

  it('returns expired for an expired stored JWT', () => {
    seedStoredSession(storage, KB_A.id, freshJwt(-3600), 'r');
    const browser = makeBrowser();
    expect(browser.getKbSessionStatus(KB_A.id)).toBe('expired');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Auth callbacks: SemiontBrowser owns the refresh-token + user-validate
// logic and passes them to each SemiontSession it constructs. These
// callbacks were previously in a separate `refresh.ts` module; they
// moved here as `performRefresh` / `performValidate` during the
// WORKER-SESSIONS refactor. The tests below exercise the inlined
// logic directly by triggering session construction with a stored
// token (activates `performValidate`) or an expired stored token
// (activates `performRefresh`).
// ──────────────────────────────────────────────────────────────────────

describe('SemiontBrowser — performRefresh (inlined refresh flow)', () => {
  it('calls refreshToken on a throwaway client when the stored token is expired', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(-3600), 'old-refresh');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);
    mockRefreshToken.mockResolvedValueOnce({ access_token: freshJwt(), token_type: 'Bearer' });

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    expect(mockRefreshToken).toHaveBeenCalledTimes(1);
    // The throwaway client is disposed afterward.
    expect(mockDispose).toHaveBeenCalled();

    await browser.dispose();
  });

  it('persists the new access token to storage on successful refresh', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(-3600), 'old-refresh');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);
    const newJwt = freshJwt();
    mockRefreshToken.mockResolvedValueOnce({ access_token: newJwt, token_type: 'Bearer' });

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    const stored = JSON.parse(storage.get(storageKey(KB_A.id))!);
    expect(stored.access).toBe(newJwt);
    // Refresh token MUST be preserved (we don't rotate refresh tokens on access-token refresh).
    expect(stored.refresh).toBe('old-refresh');

    await browser.dispose();
  });

  it('returns null when refreshToken throws, and clears the stored session', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(-3600), 'bad-refresh');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);
    mockRefreshToken.mockRejectedValueOnce(new Error('refresh endpoint down'));

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    // Refresh failure → session-expired path: storage cleared.
    expect(storage.get(storageKey(KB_A.id))).toBeNull();

    await browser.dispose();
  });

  it('dedupes concurrent refresh calls for the same KB (single network round-trip)', async () => {
    // Two simultaneous `session.refresh()` calls should converge on a
    // single underlying performRefresh call via the in-flight Map.
    // We construct one session, then fire refresh twice concurrently
    // and assert the refreshToken endpoint was hit only once.
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    const session = await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    mockRefreshToken.mockClear();

    // Hold the refresh call open so both session.refresh() calls see
    // an in-flight entry in the Map.
    let resolveRefresh!: (value: { access_token: string; token_type: string }) => void;
    mockRefreshToken.mockImplementationOnce(
      () => new Promise((r) => { resolveRefresh = r; }),
    );

    const r1 = session!.refresh();
    const r2 = session!.refresh();
    resolveRefresh({ access_token: freshJwt(), token_type: 'Bearer' });
    await Promise.all([r1, r2]);

    expect(mockRefreshToken).toHaveBeenCalledTimes(1);

    await browser.dispose();
  });
});

describe('SemiontBrowser — performValidate (inlined getMe flow)', () => {
  it('invokes getMe on a throwaway client at session startup when token is valid', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    expect(mockGetMe).toHaveBeenCalled();

    await browser.dispose();
  });

  it('populates session.user$ with the getMe response', async () => {
    const testUser = { id: 'abc', email: 'a@b.c', name: 'Alice', isAdmin: false, isModerator: false };
    mockGetMe.mockResolvedValue(testUser);
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    const session = await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    expect(session?.user$.getValue()).toMatchObject({ name: 'Alice' });

    await browser.dispose();
  });
});

describe('SemiontBrowser — activeSignals$ lifecycle (SessionSignals)', () => {
  it('emits a non-null SessionSignals when activeSession$ is non-null', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    expect(browser.activeSession$.getValue()).not.toBeNull();
    expect(browser.activeSignals$.getValue()).not.toBeNull();

    await browser.dispose();
  });

  it('exposes modal-signal observables on the signals instance', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    const signals = browser.activeSignals$.getValue()!;
    expect(signals.sessionExpiredAt$.getValue()).toBeNull();
    expect(signals.permissionDeniedAt$.getValue()).toBeNull();

    signals.notifyPermissionDenied('nope');
    expect(signals.permissionDeniedAt$.getValue()).toBeGreaterThan(0);
    expect(signals.permissionDeniedMessage$.getValue()).toBe('nope');

    await browser.dispose();
  });

  it('emits null on activeSignals$ when the session is torn down via setActiveKb', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    expect(browser.activeSignals$.getValue()).not.toBeNull();

    await browser.setActiveKb(null);
    expect(browser.activeSession$.getValue()).toBeNull();
    expect(browser.activeSignals$.getValue()).toBeNull();

    await browser.dispose();
  });

  it('emits null on activeSignals$ when the session is torn down via signOut', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    await browser.signOut(KB_A.id);
    expect(browser.activeSignals$.getValue()).toBeNull();

    await browser.dispose();
  });

  it('constructs fresh signals when signIn re-activates a previously-active KB', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    const firstSignals = browser.activeSignals$.getValue();
    expect(firstSignals).not.toBeNull();

    // signIn for the already-active KB tears down and reconstructs so
    // the new token is picked up from storage.
    await browser.signIn(KB_A.id, freshJwt(), 'new-refresh');
    const secondSignals = browser.activeSignals$.getValue();
    expect(secondSignals).not.toBeNull();
    expect(secondSignals).not.toBe(firstSignals);

    await browser.dispose();
  });

  it('fires session-expired signal via the session onAuthFailed callback on refresh failure', async () => {
    // Fresh stored token (no initial refresh), but subsequent refresh fails.
    seedStoredSession(storage, KB_A.id, freshJwt(), 'bad-refresh');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);
    mockRefreshToken.mockRejectedValue(new Error('down'));

    const browser = makeBrowser();
    const session = await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    const signals = browser.activeSignals$.getValue()!;
    expect(signals.sessionExpiredAt$.getValue()).toBeNull();

    // Manually trigger session.refresh() to simulate a proactive-refresh miss.
    await session!.refresh();
    expect(signals.sessionExpiredAt$.getValue()).toBeGreaterThan(0);

    await browser.dispose();
  });

  it('routes 401 from transport.errors$ to signals.sessionExpiredAt$', async () => {
    const { APIError } = await import('@semiont/api-client');
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    const session = await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    const signals = browser.activeSignals$.getValue()!;
    expect(signals.sessionExpiredAt$.getValue()).toBeNull();

    // Push directly through the transport's errors Subject — this is the
    // same path HttpTransport hits in its `beforeError` ky hook.
    const subj = (session!.client.transport as any).errorsSubject;
    subj.next(new APIError('token expired', 401, 'Unauthorized'));

    expect(signals.sessionExpiredAt$.getValue()).toBeGreaterThan(0);
    expect(signals.sessionExpiredMessage$.getValue()).toBe('token expired');
    await browser.dispose();
  });

  it('routes 403 from transport.errors$ to signals.permissionDeniedAt$', async () => {
    const { APIError } = await import('@semiont/api-client');
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    const session = await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    const signals = browser.activeSignals$.getValue()!;
    expect(signals.permissionDeniedAt$.getValue()).toBeNull();

    const subj = (session!.client.transport as any).errorsSubject;
    subj.next(new APIError('not allowed', 403, 'Forbidden'));

    expect(signals.permissionDeniedAt$.getValue()).toBeGreaterThan(0);
    expect(signals.permissionDeniedMessage$.getValue()).toBe('not allowed');
    await browser.dispose();
  });

  it('does not fire either signal for non-401/403 transport errors', async () => {
    const { APIError } = await import('@semiont/api-client');
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    const session = await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    const signals = browser.activeSignals$.getValue()!;

    const subj = (session!.client.transport as any).errorsSubject;
    subj.next(new APIError('boom', 500, 'Internal Server Error'));
    subj.next(new APIError('not found', 404, 'Not Found'));

    expect(signals.sessionExpiredAt$.getValue()).toBeNull();
    expect(signals.permissionDeniedAt$.getValue()).toBeNull();
    await browser.dispose();
  });

  it('completes activeSignals$ on browser dispose', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    let completed = false;
    browser.activeSignals$.subscribe({ complete: () => { completed = true; } });

    await browser.dispose();
    expect(completed).toBe(true);
  });
});
