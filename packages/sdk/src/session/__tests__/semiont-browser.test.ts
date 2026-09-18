/**
 * SemiontBrowser — unit tests for the registry, D2 setActiveKb contract,
 * and open-resources CRUD. Mocks SemiontClient so no HTTP/SSE is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, filter, skip, take } from 'rxjs';

const mockGetMe = vi.fn();
const mockDispose = vi.fn();
const mockResourceFresh = vi.fn();
let mockSystemStatus: (() => Promise<unknown>) | null = null;

vi.mock('../../client', async () => {
  const actual = await vi.importActual<typeof import('../../client')>('../../client');
  const { Subject } = await import('rxjs');
  class MockSemiontApiClient {
    auth = { me: mockGetMe };
    dispose = mockDispose;
    actor = { state$: { subscribe: () => ({ unsubscribe: () => {} }) } };
    eventBus = { get: () => ({ next: () => {}, subscribe: () => ({ unsubscribe: () => {} }) }) };
    // Mirrors the `ITransport` errors$ contract enough for the
    // SemiontBrowser → signals routing tests to push test errors through.
    transport = (() => {
      const errorsSubject = new Subject();
      return { errorsSubject, errors$: errorsSubject.asObservable() };
    })();
    // KB-IDENTITY P1: the identity check reads the did the KB reports.
    // `undefined` models a transport with no system namespace (D3's local case).
    system = mockSystemStatus === null ? undefined : { status: () => mockSystemStatus!() };
    // TABS-REVALIDATE P3: validation reads descriptors through `browse`.
    // `.fresh()` is the one-shot read (CACHE-CONTRACT D2 deleted the
    // `await`able surface), and it REJECTS on failure — which is how a
    // `not-found` verdict reaches the tab policy at all.
    browse = {
      resource: (id: string) => ({ fresh: () => mockResourceFresh(id) }),
    };
  }
  return {
    ...actual,
    SemiontClient: MockSemiontApiClient,
  };
});

import { HttpTransport } from '@semiont/http-transport';
import { SemiontBrowser } from '../semiont-browser';
import { createHttpSessionFactory } from '../http-session-factory';
import { getBrowser } from '../registry';
import { __resetForTests } from '../testing';
import { storageKey, seedStoredSession, testSession, TestStorage, TEST_TOKEN_ENDPOINT, TEST_REVOCATION_ENDPOINT } from './test-storage-helpers';
import { STORAGE_KEY, ACTIVE_KEY, OPEN_RESOURCES_BY_KB_KEY, LAST_VIEWED_RESOURCE_BY_KB_KEY } from '../storage';
import { PENDING_AUTHORIZATION_KEY } from '../oauth';
import { IdentityUnverifiableError } from '../connect';
import { BusRequestError } from '@semiont/core';

/** An issuer's JSON answer, as `fetch` would hand it back. */
function issuerReply(json: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => json } as unknown as Response;
}

/**
 * Every fetch in this file goes through this stub — the issuer's answers AND
 * the live transport's event-stream subscribe, which the mocked client does
 * not replace. Assertions therefore look at the calls to a given issuer
 * endpoint, never at "the first fetch"; the default refuses to refresh.
 */
let fetchMock: ReturnType<typeof vi.fn>;
const callsTo = (endpoint: string) =>
  fetchMock.mock.calls.filter(([url]) => url === endpoint) as unknown as Array<[string, { body: URLSearchParams }]>;
/** Script the issuer's token endpoint; everything else keeps refusing. */
const tokenEndpointAnswers = (answer: Response | Error) =>
  fetchMock.mockImplementation(async (url: string) => {
    if (url !== TEST_TOKEN_ENDPOINT) return issuerReply({ error: 'invalid_grant' }, 400);
    if (answer instanceof Error) throw answer;
    return answer;
  });

const KB_A = {
  id: 'kb-a',
  label: 'KB A',
  email: 'a@example.com',
  did: 'did:web:example.github.io:kb-a',
  endpoint: { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const },
};
const KB_B = {
  id: 'kb-b',
  label: 'KB B',
  email: 'b@example.com',
  did: 'did:web:example.github.io:kb-b',
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
  mockResourceFresh.mockReset();
  fetchMock = vi.fn(async () => issuerReply({ error: 'invalid_grant' }, 400));
  vi.stubGlobal('fetch', fetchMock);
  // Default: a status with NO did — D3's "no verdict", which leaves state
  // alone and hands off to the per-resource pass. Deliberately not a matching
  // did: that would be per-KB, and a fixed one silently trips the identity
  // check the moment a test activates a different KB.
  mockSystemStatus = async () => ({ version: '1' });
  // Default: every tab validates, so tests that do not care are unaffected.
  mockResourceFresh.mockImplementation(async (id: string) => ({ '@id': id, name: `name-${id}` }));
  mockGetMe.mockResolvedValue({ id: 'u', email: 'x@y.z', name: 'X', isAdmin: false, isModerator: false });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      { label: KB_A.label, email: KB_A.email, did: KB_A.did, endpoint: KB_A.endpoint },
      testSession(freshJwt(), 'refresh'),
    );

    expect(kb.id).toBeDefined();
    expect(browser.kbs$.getValue().map((k) => k.id)).toContain(kb.id);
    expect(browser.activeKbId$.getValue()).toBe(kb.id);

    await browser.dispose();
  });

  it("round-trips a KB's did through registration and storage (identity survives a reload)", async () => {
    // The did is what a client joins discovered KBs to connected ones on
    // (.plans/KB-IDENTITY-VS-ADDRESS.md). It is captured once at auth time
    // from the KB's own /api/status, so if registration or the storage
    // round-trip dropped it the join would silently never match — the
    // failure mode this whole plan exists to end. Pinned here because
    // `isKnowledgeBase` validates required fields only: a future rewrite
    // that normalizes entries could quietly strip optional identity.
    const DID = 'did:web:the-ai-alliance.github.io:semiont-caselaw-kb';
    const browser = makeBrowser();
    const kb = browser.addKb(
      { label: KB_A.label, email: KB_A.email, endpoint: KB_A.endpoint, did: DID },
      testSession(freshJwt(), 'refresh'),
    );

    expect(kb.did).toBe(DID);
    expect(browser.kbs$.getValue().find((k) => k.id === kb.id)?.did).toBe(DID);

    // …and survives the persist/rehydrate cycle a page reload performs.
    const persisted = JSON.parse(storage.get(STORAGE_KEY) ?? '[]') as Array<{ id: string; did?: string }>;
    expect(persisted.find((k) => k.id === kb.id)?.did).toBe(DID);

    await browser.dispose();

    const reloaded = makeBrowser(); // same storage — a fresh page load
    expect(reloaded.kbs$.getValue().find((k) => k.id === kb.id)?.did).toBe(DID);
    await reloaded.dispose();
  });

  it('drops a stored KB that predates the did requirement, rather than loading one without identity', async () => {
    // Decision 8 made `did` required; entries persisted before it have none.
    // Loading them would satisfy the type only by lying — the identity join
    // would compare against `undefined` and silently never match. Per the
    // storage stance (no back-compat layer) they drop and the user re-adds:
    // a one-time list clear, in exchange for every loaded KB actually having
    // the identity its type promises.
    storage.set(STORAGE_KEY, JSON.stringify([
      { id: 'legacy', label: 'Pre-did KB', email: 'a@example.com', endpoint: KB_A.endpoint },
      { id: 'current', label: 'KB A', email: 'a@example.com', endpoint: KB_A.endpoint, did: 'did:web:example.github.io:kb-a' },
    ]));

    const browser = makeBrowser();
    const ids = browser.kbs$.getValue().map((k) => k.id);

    expect(ids).toEqual(['current']);
    await browser.dispose();
  });

  it('removeKb clears the KB and, if active, activates a fallback (or null)', async () => {
    const browser = makeBrowser();
    const a = browser.addKb(
      { label: KB_A.label, email: KB_A.email, did: KB_A.did, endpoint: KB_A.endpoint },
      testSession(freshJwt(), 'r'),
    );
    const b = browser.addKb(
      { label: KB_B.label, email: KB_B.email, did: KB_B.did, endpoint: KB_B.endpoint },
      testSession(freshJwt(), 'r'),
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
      { label: KB_A.label, email: KB_A.email, did: KB_A.did, endpoint: KB_A.endpoint },
      testSession(freshJwt(), 'r'),
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

describe('SemiontBrowser — open resources (KB-scoped)', () => {
  // Tabs are per-KB state; the visible list is a projection of the ACTIVE,
  // CONNECTED KB (gate: activeSession$ non-null). Storage is the durable
  // per-KB record; removeKb reaps it; the legacy flat key is ignored.

  /** KB_A + KB_B registered with stored sessions; KB_A active and live. */
  async function makeConnectedBrowser() {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    seedStoredSession(storage, KB_B.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A, KB_B]));
    storage.set(ACTIVE_KEY, KB_A.id);
    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(filter((s) => s !== null), take(1)));
    return browser;
  }

  const liveSession = (browser: SemiontBrowser) =>
    firstValueFrom(browser.activeSession$.pipe(filter((s) => s !== null), take(1)));

  it('addOpenResource, removeOpenResource, updateName, reorder — on the active KB', async () => {
    const browser = await makeConnectedBrowser();

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

  it('assigns a unique order after removals (no collision with surviving tabs)', async () => {
    const browser = await makeConnectedBrowser();
    browser.addOpenResource('r1', 'One');
    browser.addOpenResource('r2', 'Two');
    browser.addOpenResource('r3', 'Three');
    browser.removeOpenResource('r2'); // surviving orders: 0, 2

    browser.addOpenResource('r4', 'Four'); // length-based order would collide at 2

    const list = browser.openResources$.getValue();
    const orders = list.map((r) => r.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(list.map((r) => r.id)).toEqual(['r1', 'r3', 'r4']);

    await browser.dispose();
  });

  it('reorderOpenResources ignores out-of-range indices', async () => {
    const browser = await makeConnectedBrowser();
    browser.addOpenResource('r1', 'One');
    const before = browser.openResources$.getValue();
    browser.reorderOpenResources(0, 5);
    expect(browser.openResources$.getValue()).toEqual(before);
    await browser.dispose();
  });

  // ── TABS-REVALIDATE-ON-RESTORE P3 ──────────────────────────────────
  // A tab is a claim about a KB, and a claim is checked against the KB.
  // The list projects immediately from storage; every entry is confirmed or
  // dropped once there is a session to ask.

  /** Seed a persisted tab list for KB_A, as a restore would leave it. */
  function seedTabs(...ids: string[]) {
    storage.set(OPEN_RESOURCES_BY_KB_KEY, JSON.stringify({
      [KB_A.id]: ids.map((id, i) => ({ id, name: `stale-${id}`, openedAt: i, order: i })),
    }));
  }

  /** The validation pass is fire-and-forget; let its microtasks drain. */
  const settled = () => new Promise((r) => setTimeout(r, 0));

  const notFound = () =>
    new BusRequestError('Resource not found', 'bus.not-found', {});

  it('drops a restored tab the KB says does not exist, and persists the removal', async () => {
    seedTabs('gone', 'kept');
    mockResourceFresh.mockImplementation(async (id: string) => {
      if (id === 'gone') throw notFound();
      return { '@id': id, name: `name-${id}` };
    });

    const browser = await makeConnectedBrowser();
    await settled();

    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['kept']);
    const persisted = JSON.parse(storage.get(OPEN_RESOURCES_BY_KB_KEY)!) as Record<string, { id: string }[]>;
    expect(persisted[KB_A.id]!.map((r) => r.id)).toEqual(['kept']);

    await browser.dispose();
  });

  it('KEEPS a tab whose check fails for any reason other than not-found (D2)', async () => {
    // The test that must never be weakened into "any failure removes". Wiping
    // tabs because the archivist was briefly down is worse than phantoms.
    seedTabs('peer', 'boom', 'slow');
    mockResourceFresh.mockImplementation(async (id: string) => {
      if (id === 'peer') throw new BusRequestError('no subscriber', 'bus.peer-unavailable', {});
      if (id === 'boom') throw new Error('socket hang up');
      if (id === 'slow') throw new BusRequestError('timed out', 'bus.timeout', {});
      return { '@id': id, name: `name-${id}` };
    });

    const browser = await makeConnectedBrowser();
    await settled();

    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['peer', 'boom', 'slow']);

    await browser.dispose();
  });

  it('refreshes a validated tab name and mediaType from the descriptor (D3)', async () => {
    seedTabs('r1');
    mockResourceFresh.mockImplementation(async () => ({
      '@id': 'r1',
      name: 'Current Title',
      representations: [{ mediaType: 'application/pdf', storageUri: 'file://r1.pdf' }],
    }));

    const browser = await makeConnectedBrowser();
    await settled();

    const tab = browser.openResources$.getValue().find((r) => r.id === 'r1');
    expect(tab?.name).toBe('Current Title');
    expect(tab?.mediaType).toBe('application/pdf');

    await browser.dispose();
  });

  it('validates once per activation, not once per projection', async () => {
    seedTabs('r1', 'r2');
    const browser = await makeConnectedBrowser();
    await settled();
    expect(mockResourceFresh).toHaveBeenCalledTimes(2);

    // A projection refresh is not an activation: CRUD re-projects, and must
    // not re-run the pass.
    browser.addOpenResource('r3', 'Three');
    browser.reorderOpenResources(0, 1);
    await settled();
    expect(mockResourceFresh).toHaveBeenCalledTimes(2);

    await browser.dispose();
  });

  it('a KB switch validates the newly active list', async () => {
    storage.set(OPEN_RESOURCES_BY_KB_KEY, JSON.stringify({
      [KB_A.id]: [{ id: 'a1', name: 'A1', openedAt: 0 }],
      [KB_B.id]: [{ id: 'b1', name: 'B1', openedAt: 0 }],
    }));
    const browser = await makeConnectedBrowser();
    await settled();
    expect(mockResourceFresh.mock.calls.map((c) => c[0])).toEqual(['a1']);

    await browser.setActiveKb(KB_B.id);
    await liveSession(browser);
    await settled();
    expect(mockResourceFresh.mock.calls.map((c) => c[0])).toEqual(['a1', 'b1']);

    await browser.dispose();
  });

  it('a removal survives a sibling context\'s concurrent write, and the sibling tab survives too', async () => {
    // The cross-tab case (D11). Another context writes the whole map while
    // validation is in flight; neither side may lose its change.
    seedTabs('gone', 'kept');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mockResourceFresh.mockImplementation(async (id: string) => {
      if (id === 'gone') { await gate; throw notFound(); }
      return { '@id': id, name: `name-${id}` };
    });

    const browser = await makeConnectedBrowser();

    // Sibling adds a tab from its own (still stale) view of the list.
    storage.set(OPEN_RESOURCES_BY_KB_KEY, JSON.stringify({
      [KB_A.id]: [
        { id: 'gone', name: 'stale-gone', openedAt: 0, order: 0 },
        { id: 'kept', name: 'stale-kept', openedAt: 1, order: 1 },
        { id: 'sibling', name: 'Sibling', openedAt: 2, order: 2 },
      ],
    }));

    release();
    await settled();

    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['kept', 'sibling']);

    await browser.dispose();
  });

  it('two contexts each adding a tab do not lose one (D11 — older than this plan)', async () => {
    // Nothing to do with validation: `mutateOpenResources` used to write from
    // its in-memory copy, so whichever context wrote last erased the other.
    const browser = await makeConnectedBrowser();
    browser.addOpenResource('mine', 'Mine');

    // A sibling context commits its own tab directly to storage.
    const committed = JSON.parse(storage.get(OPEN_RESOURCES_BY_KB_KEY)!) as Record<string, unknown[]>;
    committed[KB_A.id] = [...(committed[KB_A.id] ?? []), { id: 'theirs', name: 'Theirs', openedAt: 9, order: 9 }];
    storage.set(OPEN_RESOURCES_BY_KB_KEY, JSON.stringify(committed));

    browser.addOpenResource('later', 'Later');

    const persisted = JSON.parse(storage.get(OPEN_RESOURCES_BY_KB_KEY)!) as Record<string, { id: string }[]>;
    expect(persisted[KB_A.id]!.map((r) => r.id).sort()).toEqual(['later', 'mine', 'theirs']);

    await browser.dispose();
  });

  // ── KB-IDENTITY-CHECKED-ON-ACTIVATION P1 ───────────────────────────
  // A registry entry claims a particular KB answers at a particular address.
  // Addresses get reused. The claim is checked once there is a session to ask
  // — and the did is read in ONE direction only: differs → act, matches →
  // says nothing (a clone and a codespace of one repo share a did).

  /** Both per-KB maps seeded for KB_A and KB_B, as a restore would leave them. */
  function seedKbScopedState() {
    storage.set(OPEN_RESOURCES_BY_KB_KEY, JSON.stringify({
      [KB_A.id]: [{ id: 'a1', name: 'A1', openedAt: 0 }],
      [KB_B.id]: [{ id: 'b1', name: 'B1', openedAt: 0 }],
    }));
    storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, JSON.stringify({
      [KB_A.id]: 'a1',
      [KB_B.id]: 'b1',
    }));
  }

  const readMap = (key: string) =>
    JSON.parse(storage.get(key) ?? '{}') as Record<string, unknown>;

  it('a KB reporting a DIFFERENT did voids that KB\'s tabs and last-viewed (D2)', async () => {
    seedKbScopedState();
    mockSystemStatus = async () => ({ did: 'did:web:someone-else.github.io:other-kb' });

    const browser = await makeConnectedBrowser();
    await settled();

    expect(browser.openResources$.getValue()).toEqual([]);
    expect(browser.lastViewedResource$.getValue()).toBeNull();
    // The tab list empties through the write funnel (D7), which maps a list to
    // a list — so the key remains with an empty list. The last-viewed entry has
    // no funnel and is dropped outright. Both are "no claim about contents";
    // the shapes differ because the write paths do.
    expect(readMap(OPEN_RESOURCES_BY_KB_KEY)[KB_A.id]).toEqual([]);
    expect(readMap(LAST_VIEWED_RESOURCE_BY_KB_KEY)[KB_A.id]).toBeUndefined();

    await browser.dispose();
  });

  it('only the active KB is voided — other KBs keep both maps', async () => {
    seedKbScopedState();
    mockSystemStatus = async () => ({ did: 'did:web:someone-else.github.io:other-kb' });

    const browser = await makeConnectedBrowser();
    await settled();

    expect(readMap(OPEN_RESOURCES_BY_KB_KEY)[KB_B.id]).toEqual([
      { id: 'b1', name: 'B1', openedAt: 0 },
    ]);
    expect(readMap(LAST_VIEWED_RESOURCE_BY_KB_KEY)[KB_B.id]).toBe('b1');

    await browser.dispose();
  });

  it('a matching did changes nothing — a match is not evidence about contents (D1)', async () => {
    seedKbScopedState();
    mockSystemStatus = async () => ({ did: KB_A.did });
    const browser = await makeConnectedBrowser();
    await settled();

    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['a1']);
    expect(readMap(LAST_VIEWED_RESOURCE_BY_KB_KEY)[KB_A.id]).toBe('a1');

    await browser.dispose();
  });

  it('NO VERDICT is not a mismatch — three absences, three assertions (D3)', async () => {
    // The guard that must never be weakened. Losing a user's tabs because the
    // gateway was briefly down is strictly worse than the phantoms this fixes.
    for (const [label, arrange] of [
      ['status rejects', () => { mockSystemStatus = async () => { throw new Error('unreachable'); }; }],
      ['status reports no did', () => { mockSystemStatus = async () => ({ version: '1' }); }],
      ['no system namespace at all', () => { mockSystemStatus = null; }],
    ] as const) {
      storage = new TestStorage();
      seedKbScopedState();
      arrange();

      const browser = await makeConnectedBrowser();
      await settled();

      expect(browser.openResources$.getValue().map((r) => r.id), label).toEqual(['a1']);
      expect(readMap(LAST_VIEWED_RESOURCE_BY_KB_KEY)[KB_A.id], label).toBe('a1');

      await browser.dispose();
    }
  });

  it('leaves the registry entry exactly as the user wrote it (D4)', async () => {
    // Adopting the observed did would erase the only evidence a substitution
    // happened, and sign the user in to a KB they never chose under the name
    // of one they did. Re-registering is a deliberate act.
    seedKbScopedState();
    mockSystemStatus = async () => ({ did: 'did:web:someone-else.github.io:other-kb' });

    const browser = await makeConnectedBrowser();
    await settled();

    const entry = (JSON.parse(storage.get(STORAGE_KEY)!) as typeof KB_A[])
      .find((k) => k.id === KB_A.id)!;
    expect(entry.did).toBe(KB_A.did);
    expect(entry.label).toBe(KB_A.label);

    await browser.dispose();
  });

  it('raises a conflict signal carrying both dids, and does not decide what to do', async () => {
    seedKbScopedState();
    const observed = 'did:web:someone-else.github.io:other-kb';
    mockSystemStatus = async () => ({ did: observed });

    const browser = await makeConnectedBrowser();
    await settled();

    const signals = browser.activeSignals$.getValue()!;
    expect(signals.kbIdentityConflictAt$.getValue()).toEqual(expect.any(Number));
    expect(signals.kbIdentityConflict$.getValue()).toEqual({
      expectedDid: KB_A.did,
      observedDid: observed,
    });

    await browser.dispose();
  });

  it('a mismatch stops the per-resource pass — those answers would be about the wrong KB (D5)', async () => {
    seedKbScopedState();
    mockSystemStatus = async () => ({ did: 'did:web:someone-else.github.io:other-kb' });

    const browser = await makeConnectedBrowser();
    await settled();

    expect(mockResourceFresh).not.toHaveBeenCalled();

    await browser.dispose();
  });

  /**
   * A transport-level 401 routes through REFRESH, never straight to the modal
   * (found live 2026-09-14: an undismissable "Session Expired — HTTP 401"
   * that survived hard reloads).
   *
   * The old wire fired `notifySessionExpired(err.message)` on any single
   * `unauthorized` transport error. Two failure modes, both traps: a request
   * losing the refresh race 401s while the session heals a beat later —
   * modal over a healthy session, on every load; and a truly dead session
   * hit the modal WITHOUT `clearStoredSession`, so every reload restored the
   * corpse and re-armed it — and both modal buttons navigate, into the same
   * loop. Routing into `session.refresh()` covers both: success is silence;
   * exhaustion runs the session's own teardown — storage cleared, the modal
   * fired once with the session's own message.
   */
  describe('transport 401s route through refresh, not straight to the modal', () => {
    const pushError = (browser: SemiontBrowser, e: unknown) => {
      const session = browser.activeSession$.getValue()!;
      (session.client.transport as unknown as { errorsSubject: { next: (v: unknown) => void } })
        .errorsSubject.next(e);
    };

    it('a working refresh keeps the modal silent and the stored session intact', async () => {
      const browser = await makeConnectedBrowser();
      const signals = browser.activeSignals$.getValue()!;
      tokenEndpointAnswers(issuerReply({ access_token: freshJwt() }));

      pushError(browser, { code: 'unauthorized', message: 'HTTP 401: Unauthorized' });
      await settled();

      expect(callsTo(TEST_TOKEN_ENDPOINT)).toHaveLength(1);
      expect(signals.sessionExpiredAt$.getValue()).toBeNull();
      expect(storage.get(storageKey(KB_A.id))).not.toBeNull();

      await browser.dispose();
    });

    it('refresh exhausted: the modal fires with the session teardown message, and the stored session is CLEARED', async () => {
      const browser = await makeConnectedBrowser();
      const signals = browser.activeSignals$.getValue()!;
      fetchMock.mockResolvedValue(issuerReply({ error: 'invalid_grant', error_description: 'Token is not active' }, 400));

      pushError(browser, { code: 'unauthorized', message: 'HTTP 401: Unauthorized' });
      await settled();

      expect(signals.sessionExpiredAt$.getValue()).toEqual(expect.any(Number));
      // The session's own words — never the raw transport line.
      expect(signals.sessionExpiredMessage$.getValue()).toMatch(/session has expired/i);
      // The loop-breaker: a dead session must not survive a reload.
      expect(storage.get(storageKey(KB_A.id))).toBeNull();

      await browser.dispose();
    });

    it('a 401 with NO stored credentials is not an expiry: no modal, no teardown theater', async () => {
      // The field loop of 2026-09-14, second act: activeKnowledgeBaseId
      // persists forever, so every load activates the KB signed-out; the
      // actor connects with a null token, 401s, and refresh() -- with
      // NOTHING to refresh -- declared "session expired" anyway. You cannot
      // expire a session that never existed: the signed-out shell is the
      // correct and sufficient UX, and the modal must stay silent.
      storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
      storage.set(ACTIVE_KEY, KB_A.id);
      // Deliberately NO seedStoredSession: registered + active, signed out.
      const browser = makeBrowser();
      const session = await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
      const signals = browser.activeSignals$.getValue()!;

      (session!.client.transport as unknown as { errorsSubject: { next: (v: unknown) => void } })
        .errorsSubject.next({ code: 'unauthorized', message: 'HTTP 401: Unauthorized' });
      await settled();

      expect(signals.sessionExpiredAt$.getValue()).toBeNull();
      expect(signals.sessionExpiredMessage$.getValue()).toBeNull();

      await browser.dispose();
    });

    it('forbidden still routes to permission-denied, untouched', async () => {
      const browser = await makeConnectedBrowser();
      const signals = browser.activeSignals$.getValue()!;

      pushError(browser, { code: 'forbidden', message: 'HTTP 403: Forbidden' });
      await settled();

      expect(signals.permissionDeniedAt$.getValue()).toEqual(expect.any(Number));

      await browser.dispose();
    });
  });


  it('is inert with no live session: nothing visible, nothing persisted', async () => {
    const browser = makeBrowser();
    browser.addOpenResource('r1', 'One');
    expect(browser.openResources$.getValue()).toEqual([]);
    expect(storage.get(OPEN_RESOURCES_BY_KB_KEY)).toBeNull();
    await browser.dispose();
  });

  it('switching KBs switches the visible list; each KB keeps its own', async () => {
    const browser = await makeConnectedBrowser();
    browser.addOpenResource('r1', 'One');

    await browser.setActiveKb(KB_B.id);
    await liveSession(browser);
    expect(browser.openResources$.getValue()).toEqual([]);
    browser.addOpenResource('r2', 'Two');
    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['r2']);

    await browser.setActiveKb(KB_A.id);
    await liveSession(browser);
    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['r1']);

    await browser.dispose();
  });

  it('signOut hides the tabs; storage retains them; signIn restores', async () => {
    const browser = await makeConnectedBrowser();
    browser.addOpenResource('r1', 'One');

    await browser.signOut(KB_A.id);
    expect(browser.openResources$.getValue()).toEqual([]);
    const stored = JSON.parse(storage.get(OPEN_RESOURCES_BY_KB_KEY)!) as Record<string, Array<{ id: string }>>;
    expect(stored[KB_A.id]!.map((r) => r.id)).toEqual(['r1']);

    await browser.signIn(KB_A.id, testSession(freshJwt(), 'r'));
    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['r1']);

    await browser.dispose();
  });

  it('removeKb reaps the stored tabs for that KB', async () => {
    const browser = await makeConnectedBrowser();
    browser.addOpenResource('r1', 'One');

    browser.removeKb(KB_A.id);
    const stored = JSON.parse(storage.get(OPEN_RESOURCES_BY_KB_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored[KB_A.id]).toBeUndefined();

    await browser.dispose();
  });

  it('cross-tab writes to the per-KB key update the projection', async () => {
    const browser = await makeConnectedBrowser();
    const payload = JSON.stringify({ [KB_A.id]: [{ id: 'rX', name: 'X', openedAt: 1, order: 0 }] });
    storage.set(OPEN_RESOURCES_BY_KB_KEY, payload);
    storage.dispatch(OPEN_RESOURCES_BY_KB_KEY, payload);
    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['rX']);
    await browser.dispose();
  });

  it('ignores the legacy flat openDocuments key entirely', async () => {
    storage.set('openDocuments', JSON.stringify([{ id: 'old', name: 'Old', openedAt: 1 }]));
    const browser = await makeConnectedBrowser();
    expect(browser.openResources$.getValue()).toEqual([]);
    await browser.dispose();
  });
});

describe('SemiontBrowser — last viewed resource (KB-scoped)', () => {
  // "Which resource was I last looking at" is per-KB state, exactly like the
  // tabs it sits beside. Held globally it sends the /know landing redirect
  // into the PREVIOUS KB's resource after a switch — a guaranteed 404.
  // See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md

  async function makeConnectedBrowser() {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    seedStoredSession(storage, KB_B.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A, KB_B]));
    storage.set(ACTIVE_KEY, KB_A.id);
    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(filter((s) => s !== null), take(1)));
    return browser;
  }

  const liveSession = (browser: SemiontBrowser) =>
    firstValueFrom(browser.activeSession$.pipe(filter((s) => s !== null), take(1)));

  it('records against the active KB and never leaks across a switch', async () => {
    const browser = await makeConnectedBrowser();

    browser.setLastViewedResource('res-in-a');
    expect(browser.lastViewedResource$.getValue()).toBe('res-in-a');

    await browser.setActiveKb(KB_B.id);
    await liveSession(browser);
    // KB_B has never been viewed — it must NOT inherit KB_A's resource.
    expect(browser.lastViewedResource$.getValue()).toBeNull();

    browser.setLastViewedResource('res-in-b');
    expect(browser.lastViewedResource$.getValue()).toBe('res-in-b');

    await browser.setActiveKb(KB_A.id);
    await liveSession(browser);
    expect(browser.lastViewedResource$.getValue()).toBe('res-in-a');

    await browser.dispose();
  });

  it('persists per KB under the dedicated key', async () => {
    const browser = await makeConnectedBrowser();
    browser.setLastViewedResource('res-in-a');

    const stored = JSON.parse(storage.get(LAST_VIEWED_RESOURCE_BY_KB_KEY)!) as Record<string, string>;
    expect(stored[KB_A.id]).toBe('res-in-a');
    expect(stored[KB_B.id]).toBeUndefined();

    await browser.dispose();
  });

  it('is null while no KB is connected, and does not record', async () => {
    const browser = await makeConnectedBrowser();
    await browser.signOut(KB_A.id);

    expect(browser.lastViewedResource$.getValue()).toBeNull();
    browser.setLastViewedResource('res-while-signed-out');
    expect(storage.get(LAST_VIEWED_RESOURCE_BY_KB_KEY)).toBeNull();

    await browser.dispose();
  });

  it('removeKb reaps the stored last-viewed resource for that KB', async () => {
    const browser = await makeConnectedBrowser();
    browser.setLastViewedResource('res-in-a');

    browser.removeKb(KB_A.id);
    const stored = JSON.parse(storage.get(LAST_VIEWED_RESOURCE_BY_KB_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored[KB_A.id]).toBeUndefined();

    await browser.dispose();
  });

  it('cross-tab writes to the per-KB key update the projection', async () => {
    const browser = await makeConnectedBrowser();
    const payload = JSON.stringify({ [KB_A.id]: 'res-from-other-tab' });
    storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, payload);
    storage.dispatch(LAST_VIEWED_RESOURCE_BY_KB_KEY, payload);

    expect(browser.lastViewedResource$.getValue()).toBe('res-from-other-tab');
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
// Auth callbacks: the session factory owns the refresh + user-validate
// logic and passes them to each SemiontSession it constructs. Refresh is
// the refresh grant against the issuer the stored session names; the
// tests below trigger it by activating a KB whose stored token is expired.
// ──────────────────────────────────────────────────────────────────────

describe('SemiontBrowser — performRefresh (the refresh grant at the issuer)', () => {
  it('renews at the issuer the stored session names when the stored token is expired', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(-3600), 'old-refresh');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);
    tokenEndpointAnswers(issuerReply({ access_token: freshJwt() }));

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    const renewals = callsTo(TEST_TOKEN_ENDPOINT);
    expect(renewals).toHaveLength(1);
    expect(Object.fromEntries(renewals[0]![1].body.entries())).toEqual({
      grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: 'semiont-browser',
    });

    await browser.dispose();
  });

  it('persists the new access token to storage on successful refresh', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(-3600), 'old-refresh');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);
    const newJwt = freshJwt();
    tokenEndpointAnswers(issuerReply({ access_token: newJwt }));

    const browser = makeBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    const stored = JSON.parse(storage.get(storageKey(KB_A.id))!);
    expect(stored.access).toBe(newJwt);
    // The issuer returned no rotated refresh token, so the held one stays current.
    expect(stored.refresh).toBe('old-refresh');

    await browser.dispose();
  });

  it('returns null when the issuer is unreachable, and clears the stored session', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(-3600), 'bad-refresh');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);
    tokenEndpointAnswers(new Error('issuer down'));

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
    fetchMock.mockClear();

    // Hold the issuer's answer open so both session.refresh() calls see
    // an in-flight entry in the Map.
    let resolveRefresh!: (value: Response) => void;
    fetchMock.mockImplementation(async (url: string) =>
      url === TEST_TOKEN_ENDPOINT
        ? new Promise<Response>((r) => { resolveRefresh = r; })
        : issuerReply({ error: 'invalid_grant' }, 400));

    const r1 = session!.refresh();
    const r2 = session!.refresh();
    resolveRefresh(issuerReply({ access_token: freshJwt() }));
    await Promise.all([r1, r2]);

    expect(callsTo(TEST_TOKEN_ENDPOINT)).toHaveLength(1);

    await browser.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Sign-in through the issuer a KB trusts (EXTERNAL-IDENTITY P4): the
// browser discovers the issuer, hands the host a URL, and on return
// exchanges the code, asks the KB who it is and who the user is, and
// registers or re-authenticates. The issuer is a fetch stub; the KB is the
// mocked client.
// ──────────────────────────────────────────────────────────────────────

describe('SemiontBrowser — sign-in through the issuer', () => {
  const ISSUER = 'https://issuer.test/realms/semiont';
  const REDIRECT = 'http://localhost:3000/en/auth/callback';
  const TARGET = { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const };

  beforeEach(() => {
    vi.spyOn(HttpTransport.prototype, 'getProtectedResourceMetadata').mockResolvedValue({
      resource: 'http://localhost:4000', authorization_servers: [ISSUER], bearer_methods_supported: ['header'],
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return issuerReply({
          issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`,
          revocation_endpoint: `${ISSUER}/revoke`,
        });
      }
      return issuerReply({ access_token: freshJwt(), refresh_token: 'issued-refresh' });
    });
    mockSystemStatus = async () => ({ did: KB_A.did, projectName: 'KB A', gitBranch: 'main' });
    mockGetMe.mockResolvedValue({ id: 'u', email: 'alice@example.com', name: 'Alice', isAdmin: false, isModerator: false });
  });

  async function begin(browser: SemiontBrowser, extra: { kbId?: string; expectedDid?: string; expectedName?: string } = {}) {
    const url = await browser.beginSignIn({ target: TARGET, redirectUri: REDIRECT, ...extra });
    const { state } = JSON.parse(storage.get(PENDING_AUTHORIZATION_KEY)!) as { state: string };
    return { url, callback: `${REDIRECT}?code=the-code&state=${state}` };
  }

  it("beginSignIn returns the issuer's authorization URL for the host to navigate to", async () => {
    const browser = makeBrowser();

    const { url } = await begin(browser);

    expect(url.startsWith(`${ISSUER}/auth?`)).toBe(true);
    expect(new URL(url).searchParams.get('client_id')).toBe('semiont-browser');
    await browser.dispose();
  });

  it('completeSignIn registers the KB with the identity it reports and the email the issuer vouched for', async () => {
    const browser = makeBrowser();
    const { callback } = await begin(browser);

    const outcome = await browser.completeSignIn(callback);

    expect(outcome.kb).toMatchObject({ did: KB_A.did, label: 'KB A', email: 'alice@example.com', gitBranch: 'main', endpoint: TARGET });
    expect(outcome.expected).toBeUndefined();
    expect(browser.kbs$.getValue()).toHaveLength(1);
    expect(browser.activeKbId$.getValue()).toBe(outcome.kb.id);
    expect(JSON.parse(storage.get(storageKey(outcome.kb.id))!)).toMatchObject({
      refresh: 'issued-refresh', clientId: 'semiont-browser',
      tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke`,
    });
    expect(storage.get(PENDING_AUTHORIZATION_KEY)).toBeNull();
    await browser.dispose();
  });

  it('reports what the user believed they clicked, so the host can verify it against who answered', async () => {
    const browser = makeBrowser();
    const { callback } = await begin(browser, { expectedDid: 'did:web:someone-else', expectedName: 'Other KB' });

    const outcome = await browser.completeSignIn(callback);

    expect(outcome.expected).toEqual({ did: 'did:web:someone-else', name: 'Other KB' });
    // Registered anyway: verification reports, it never blocks.
    expect(outcome.kb.did).toBe(KB_A.did);
    await browser.dispose();
  });

  it('re-authenticates a registered KB by id, taking what the KB and the issuer now say', async () => {
    storage.set(STORAGE_KEY, JSON.stringify([{ ...KB_A, label: 'Old name', email: 'old@example.com' }]));
    const browser = makeBrowser();
    const { callback } = await begin(browser, { kbId: KB_A.id });

    const outcome = await browser.completeSignIn(callback);

    expect(outcome.kb.id).toBe(KB_A.id);
    expect(outcome.kb).toMatchObject({ label: 'KB A', email: 'alice@example.com' });
    expect(outcome.expected).toEqual({ did: KB_A.did, name: 'Old name' });
    expect(browser.kbs$.getValue()).toHaveLength(1);
    expect(storage.get(storageKey(KB_A.id))).not.toBeNull();
    await browser.dispose();
  });

  it('re-authenticates by address when a registered KB already lives there', async () => {
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    const browser = makeBrowser();
    const { callback } = await begin(browser);

    const outcome = await browser.completeSignIn(callback);

    expect(outcome.kb.id).toBe(KB_A.id);
    expect(browser.kbs$.getValue()).toHaveLength(1);
    await browser.dispose();
  });

  it('refuses to register a KB that cannot say who it is, and stores nothing', async () => {
    mockSystemStatus = async () => ({ projectName: 'Nameless' });
    const browser = makeBrowser();
    const { callback } = await begin(browser);

    await expect(browser.completeSignIn(callback)).rejects.toBeInstanceOf(IdentityUnverifiableError);

    expect(browser.kbs$.getValue()).toHaveLength(0);
    expect(storage.get(PENDING_AUTHORIZATION_KEY)).toBeNull();
    await browser.dispose();
  });

  it('refuses a callback that does not belong to the pending sign-in', async () => {
    const browser = makeBrowser();
    await begin(browser);

    await expect(browser.completeSignIn(`${REDIRECT}?code=c&state=forged`)).rejects.toMatchObject({ code: 'state' });

    expect(browser.kbs$.getValue()).toHaveLength(0);
    await browser.dispose();
  });

  it('signOut revokes the refresh token at the issuer, then forgets it', async () => {
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    const browser = makeBrowser();
    fetchMock.mockResolvedValue(issuerReply(undefined, 200));

    await browser.signOut(KB_A.id);

    expect(storage.get(storageKey(KB_A.id))).toBeNull();
    const revocations = callsTo(TEST_REVOCATION_ENDPOINT);
    expect(revocations).toHaveLength(1);
    expect(Object.fromEntries(revocations[0]![1].body.entries())).toEqual({
      token: 'r', token_type_hint: 'refresh_token', client_id: 'semiont-browser',
    });
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
    await browser.signIn(KB_A.id, testSession(freshJwt(), 'new-refresh'));
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
    tokenEndpointAnswers(new Error('down'));

    const browser = makeBrowser();
    const session = await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    const signals = browser.activeSignals$.getValue()!;
    expect(signals.sessionExpiredAt$.getValue()).toBeNull();

    // Manually trigger session.refresh() to simulate a proactive-refresh miss.
    await session!.refresh();
    expect(signals.sessionExpiredAt$.getValue()).toBeGreaterThan(0);

    await browser.dispose();
  });

  it('routes 401 from transport.errors$ through refresh; exhaustion tears the session down properly', async () => {
    // Re-sourced 2026-09-14: this pinned the old direct wire (401 → modal,
    // raw message, storage intact) — the exact behavior that produced an
    // undismissable reload-surviving modal in the field. The APIError-shaped
    // push stays; the contract it pins is now refresh-then-teardown.
    const { APIError } = await import('@semiont/http-transport');
    seedStoredSession(storage, KB_A.id, freshJwt(), 'r');
    storage.set(STORAGE_KEY, JSON.stringify([KB_A]));
    storage.set(ACTIVE_KEY, KB_A.id);

    const browser = makeBrowser();
    const session = await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    const signals = browser.activeSignals$.getValue()!;
    expect(signals.sessionExpiredAt$.getValue()).toBeNull();

    // Push directly through the transport's errors Subject — this is the
    // same path HttpTransport hits in its `beforeError` ky hook. No refresh
    // is stubbed, so recovery exhausts.
    const subj = (session!.client.transport as any).errorsSubject;
    subj.next(new APIError('token expired', 401, 'Unauthorized'));
    await new Promise((r) => setTimeout(r, 0));

    expect(callsTo(TEST_TOKEN_ENDPOINT)).toHaveLength(1);
    expect(signals.sessionExpiredAt$.getValue()).toBeGreaterThan(0);
    // The session's own teardown message — never the raw transport line.
    expect(signals.sessionExpiredMessage$.getValue()).toMatch(/session has expired/i);
    // And the corpse cannot survive a reload.
    expect(storage.get(storageKey(KB_A.id))).toBeNull();
    await browser.dispose();
  });

  it('routes 403 from transport.errors$ to signals.permissionDeniedAt$', async () => {
    const { APIError } = await import('@semiont/http-transport');
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
    const { APIError } = await import('@semiont/http-transport');
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
