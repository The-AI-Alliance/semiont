/**
 * SemiontBrowser — unit tests for the registry, D2 setActiveKb contract,
 * and open-resources CRUD. Mocks SemiontApiClient so no HTTP/SSE is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, skip, take } from 'rxjs';

const mockGetMe = vi.fn();
const mockDispose = vi.fn();
const mockRefreshToken = vi.fn();

vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual<typeof import('@semiont/api-client')>('@semiont/api-client');
  class MockSemiontApiClient {
    getMe = mockGetMe;
    dispose = mockDispose;
    refreshToken = mockRefreshToken;
    actor = { state$: { subscribe: () => ({ unsubscribe: () => {} }) } };
  }
  return {
    ...actual,
    SemiontApiClient: MockSemiontApiClient,
  };
});

import { SemiontBrowser } from '../semiont-browser';
import { getBrowser } from '../registry';
import { __resetForTests } from '../testing';
import { seedStoredSession } from './test-storage-helpers';

const KB_A = {
  id: 'kb-a',
  label: 'KB A',
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'a@example.com',
};
const KB_B = {
  id: 'kb-b',
  label: 'KB B',
  host: 'example.com',
  port: 443,
  protocol: 'https' as const,
  email: 'b@example.com',
};

function freshJwt(expSecondsFromNow = 3600): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `${header}.${payload}.sig`;
}

beforeEach(() => {
  localStorage.clear();
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
    const a = getBrowser();
    const b = getBrowser();
    expect(a).toBe(b);
  });

  it('__resetForTests clears the singleton so a subsequent getBrowser() returns a new instance', async () => {
    const a = getBrowser();
    await __resetForTests();
    const b = getBrowser();
    expect(a).not.toBe(b);
  });
});

describe('SemiontBrowser — identity token (D1)', () => {
  it('setIdentityToken updates identityToken$', async () => {
    const browser = new SemiontBrowser();
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
    const browser = new SemiontBrowser();
    const kb = browser.addKb(
      { label: KB_A.label, host: KB_A.host, port: KB_A.port, protocol: KB_A.protocol, email: KB_A.email },
      freshJwt(),
      'refresh',
    );

    expect(kb.id).toBeDefined();
    expect(browser.kbs$.getValue().map((k) => k.id)).toContain(kb.id);
    expect(browser.activeKbId$.getValue()).toBe(kb.id);

    await browser.dispose();
  });

  it('removeKb clears the KB and, if active, activates a fallback (or null)', async () => {
    const browser = new SemiontBrowser();
    const a = browser.addKb(
      { label: KB_A.label, host: KB_A.host, port: KB_A.port, protocol: KB_A.protocol, email: KB_A.email },
      freshJwt(),
      'r',
    );
    const b = browser.addKb(
      { label: KB_B.label, host: KB_B.host, port: KB_B.port, protocol: KB_B.protocol, email: KB_B.email },
      freshJwt(),
      'r',
    );
    // b is active now.
    expect(browser.activeKbId$.getValue()).toBe(b.id);

    browser.removeKb(b.id);
    // Fallback activates.
    await new Promise((r) => setTimeout(r, 0));
    expect(browser.kbs$.getValue().map((k) => k.id)).not.toContain(b.id);
    expect(browser.activeKbId$.getValue()).toBe(a.id);

    await browser.dispose();
  });

  it('updateKb edits the record in kbs$', async () => {
    const browser = new SemiontBrowser();
    const kb = browser.addKb(
      { label: KB_A.label, host: KB_A.host, port: KB_A.port, protocol: KB_A.protocol, email: KB_A.email },
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
    // Seed storage so the browser constructs a session for KB_A on init.
    seedStoredSession(KB_A.id, freshJwt(), 'r');
    localStorage.setItem(
      'semiont.knowledgeBases',
      JSON.stringify([KB_A]),
    );
    localStorage.setItem('semiont.activeKnowledgeBaseId', KB_A.id);

    seedStoredSession(KB_B.id, freshJwt(), 'r');
    // Add KB_B to the list via direct storage poke (simulating an existing record).
    localStorage.setItem(
      'semiont.knowledgeBases',
      JSON.stringify([KB_A, KB_B]),
    );

    const browser = new SemiontBrowser();
    // Wait for initial active session to construct.
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    const emissions: Array<string | null> = [];
    const sub = browser.activeSession$.subscribe((s) => {
      emissions.push(s?.kb.id ?? null);
    });

    await browser.setActiveKb(KB_B.id);
    sub.unsubscribe();

    // Expect: [initialA, null, KB_B]. Importantly, a `null` must appear before KB_B.
    const nullIdx = emissions.indexOf(null);
    const bIdx = emissions.lastIndexOf(KB_B.id);
    expect(nullIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(nullIdx);

    await browser.dispose();
  });

  it('disposes the prior session before activating the next', async () => {
    seedStoredSession(KB_A.id, freshJwt(), 'r');
    seedStoredSession(KB_B.id, freshJwt(), 'r');
    localStorage.setItem(
      'semiont.knowledgeBases',
      JSON.stringify([KB_A, KB_B]),
    );
    localStorage.setItem('semiont.activeKnowledgeBaseId', KB_A.id);

    const browser = new SemiontBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    const disposeCountBefore = mockDispose.mock.calls.length;
    await browser.setActiveKb(KB_B.id);
    expect(mockDispose.mock.calls.length).toBeGreaterThan(disposeCountBefore);

    await browser.dispose();
  });

  it('setActiveKb(null) disposes the prior session and emits null', async () => {
    seedStoredSession(KB_A.id, freshJwt(), 'r');
    localStorage.setItem(
      'semiont.knowledgeBases',
      JSON.stringify([KB_A]),
    );
    localStorage.setItem('semiont.activeKnowledgeBaseId', KB_A.id);

    const browser = new SemiontBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));
    expect(browser.activeSession$.getValue()).not.toBeNull();

    await browser.setActiveKb(null);
    expect(browser.activeSession$.getValue()).toBeNull();

    await browser.dispose();
  });
});

describe('SemiontBrowser — open resources', () => {
  it('addOpenResource, removeOpenResource, updateName, reorder', async () => {
    const browser = new SemiontBrowser();

    browser.addOpenResource('r1', 'One');
    browser.addOpenResource('r2', 'Two', 'text/markdown', 'file://two.md');
    expect(browser.openResources$.getValue().map((r) => r.id)).toEqual(['r1', 'r2']);

    // Re-adding updates metadata in place.
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
    const browser = new SemiontBrowser();
    browser.addOpenResource('r1', 'One');
    const before = browser.openResources$.getValue();
    browser.reorderOpenResources(0, 5);
    expect(browser.openResources$.getValue()).toEqual(before);
    await browser.dispose();
  });
});

describe('SemiontBrowser — signOut', () => {
  it('clears stored tokens and emits null on activeSession$', async () => {
    seedStoredSession(KB_A.id, freshJwt(), 'r');
    localStorage.setItem(
      'semiont.knowledgeBases',
      JSON.stringify([KB_A]),
    );
    localStorage.setItem('semiont.activeKnowledgeBaseId', KB_A.id);

    const browser = new SemiontBrowser();
    await firstValueFrom(browser.activeSession$.pipe(skip(1), take(1)));

    await browser.signOut(KB_A.id);
    expect(browser.activeSession$.getValue()).toBeNull();
    expect(localStorage.getItem(`semiont.session.${KB_A.id}`)).toBeNull();

    await browser.dispose();
  });
});
